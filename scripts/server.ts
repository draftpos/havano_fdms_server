import http from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { X509Certificate } from "@peculiar/x509";
import * as crypto from "node:crypto";
import {
  initDatabase,
  registerTenant,
  setTenantApiKey,
  regenerateApiKey,
  loginTenant,
  authenticateSession,
  authenticateApiKey,
  saveTenantDevice,
  getTenantDevices,
  getTenantDevice,
  saveDayStateDb,
  loadDayStateDb,
  clearDayStateDb,
  recordReceiptDb,
  getTenantReceipts,
  enqueueOfflineReceipt,
  getQueuedReceipts,
  markQueuedReceiptSubmitted,
  getQueuedCount,
  listAllTenantsWithDetails,
  createSessionForTenant,
  deleteTenantCascade,
  updateTenantPassword,
  recordFiscalDayOpenDb,
  recordFiscalDayCloseDb,
  listAllFiscalDaysFromDb,
} from "../src/server/db.js";
import { registerDevice } from "../src/node/registration.js";
import { FiscalDevice } from "../src/node/device.js";
import { NodeTransport } from "../src/node/transport.js";
import { receiptInputFromJson } from "../src/core/money.js";
import { FdmsApiError } from "../src/core/types.js";
import { endpointOverrides, writeProfile } from "../src/node/profile.js";
import { FdmsSimulator } from "../src/simulator/server.js";

const PORT = Number(process.env.PORT || 3000);
const DEMO_API_KEY = "zf_live_demo_1234567890abcdef1234567890abcdef";
let embeddedSimulator: FdmsSimulator | null = null;

async function bootstrap() {
  await initDatabase();

  // 1. Auto-boot local FDMS Simulator if ZIMRA_BASE_URL is not set
  if (!process.env.ZIMRA_BASE_URL) {
    try {
      embeddedSimulator = await FdmsSimulator.create({
        port: 8443,
        closeDelayMs: 50,
      });
      const { url, caPem } = await embeddedSimulator.start();
      writeFileSync("zimra-simulator-ca.pem", caPem);
      process.env.ZIMRA_BASE_URL = url;
      process.env.ZIMRA_CA = "zimra-simulator-ca.pem";
      console.log(`[Simulator] Local ZIMRA FDMS simulator running at: ${url}`);
    } catch (err: any) {
      if (err.code === "EADDRINUSE") {
        console.log(`[Simulator] Port 8443 already running; connecting to existing simulator at https://127.0.0.1:8443`);
        process.env.ZIMRA_BASE_URL = "https://127.0.0.1:8443";
        if (existsSync("zimra-simulator-ca.pem")) {
          process.env.ZIMRA_CA = "zimra-simulator-ca.pem";
        }
      } else {
        console.warn(`[Simulator] Embedded simulator notice: ${err.message}`);
      }
    }
  }

  // 2. Pre-seed default SuperAdmin (Admin / Admin123)
  let adminTenantId = "";
  try {
    // If old demo account exists in SQLite, migrate it to admin@zimra-fdms.local
    if (!process.env.DATABASE_URL && existsSync("fdms-multi-tenant.db")) {
      try {
        const { DatabaseSync } = await import("node:sqlite");
        const sdb = new DatabaseSync("fdms-multi-tenant.db");
        sdb.prepare("UPDATE tenants SET name = 'Admin', email = 'admin@zimra-fdms.local' WHERE email = 'demo@zimra-fdms.local'").run();
        sdb.close();
      } catch {}
    }

    const adminTenant = await registerTenant("Admin", "admin@zimra-fdms.local", "Admin123", DEMO_API_KEY);
    adminTenantId = adminTenant.tenant.id;
    console.log("[Seed] Registered SuperAdmin: Admin / Admin123");
  } catch {
    await updateTenantPassword("admin@zimra-fdms.local", "Admin123");
    await setTenantApiKey("admin@zimra-fdms.local", DEMO_API_KEY);
    const login = await loginTenant("admin@zimra-fdms.local", "Admin123");
    adminTenantId = login.tenant.id;
    console.log("[Seed] Synced SuperAdmin credentials: Admin / Admin123");
  }

  // 3. Register or sync demo device MYPOS01 (ID 12345) to Admin
  try {
    const identity = {
      deviceId: 12345,
      serialNumber: "MYPOS01",
      modelName: "Server",
      modelVersion: "v1",
    };

    if (embeddedSimulator) {
      // Re-register device against active simulator CA to ensure mTLS handshake succeeds
      const overrides = endpointOverrides();
      const reg = await registerDevice(identity, "ABCD1234", {
        baseUrl: overrides.baseUrl,
        transport: new NodeTransport(undefined, { ca: overrides.ca }),
      });
      await saveTenantDevice(adminTenantId, {
        ...identity,
        environment: "test",
        certificatePem: reg.certificatePem,
        privateKeyPem: reg.keys.privateKeyPem,
      });
      writeProfile(".zimra", { ...identity, environment: "test" }, reg.certificatePem, reg.keys.privateKeyPem);
      console.log(`[Seed] Device ${identity.serialNumber} (ID ${identity.deviceId}) registered & mTLS keys saved.`);
    } else if (existsSync(".zimra/device.json") && existsSync(".zimra/device-certificate.pem") && existsSync(".zimra/device-private-key.pem")) {
      const devInfo = JSON.parse(readFileSync(".zimra/device.json", "utf-8"));
      const certPem = readFileSync(".zimra/device-certificate.pem", "utf-8");
      const keyPem = readFileSync(".zimra/device-private-key.pem", "utf-8");
      await saveTenantDevice(adminTenantId, {
        deviceId: devInfo.deviceId,
        serialNumber: devInfo.serialNumber,
        modelName: devInfo.modelName || "Server",
        modelVersion: devInfo.modelVersion || "v1",
        environment: devInfo.environment || "test",
        certificatePem: certPem,
        privateKeyPem: keyPem,
      });
    }
  } catch (err: any) {
    console.warn(`[Seed] Device sync notice: ${err.message}`);
  }
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const list: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return list;
  header.split(";").forEach(cookie => {
    const parts = cookie.split("=");
    list[parts.shift()!.trim()] = decodeURI(parts.join("="));
  });
  return list;
}

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, data: any, headers: Record<string, string> = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    ...headers,
  });
  res.end(JSON.stringify(data, null, 2));
}

async function getAuthTenant(req: http.IncomingMessage) {
  // 1. Check API Key header
  const apiKey = (req.headers["x-api-key"] as string) || (req.headers.authorization?.startsWith("Bearer zf_live_") ? req.headers.authorization.slice(7) : null);
  if (apiKey) {
    const tenant = await authenticateApiKey(apiKey.trim());
    if (tenant) return tenant;
  }

  // 2. Check Session Token in Authorization header or Cookie
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer sess_")) {
    const token = authHeader.slice(7).trim();
    const tenant = await authenticateSession(token);
    if (tenant) return tenant;
  }

  const cookies = parseCookies(req);
  if (cookies.zimra_session) {
    const tenant = await authenticateSession(cookies.zimra_session);
    if (tenant) return tenant;
  }

  return null;
}

function getPortalHtml(): string {
  const portalPath = join(process.cwd(), "scripts", "portal.html");
  if (existsSync(portalPath)) {
    return readFileSync(portalPath, "utf-8");
  }
  return "<!DOCTYPE html><html><body><h1>ZIMRA Portal</h1><p>portal.html not found</p></body></html>";
}

async function getDeviceInstanceForTenant(
  tenantId: string,
  identifier?: { deviceId?: number; serialNumber?: string }
): Promise<{ fd: FiscalDevice; deviceRecord: any }> {
  const dev = await getTenantDevice(tenantId, identifier);
  if (!dev) {
    const hint = identifier?.serialNumber
      ? `serial '${identifier.serialNumber}'`
      : identifier?.deviceId
      ? `ID '${identifier.deviceId}'`
      : "active device";
    throw new Error(`No ZIMRA device found for ${hint}. Please register a device first.`);
  }

  const overrides = endpointOverrides();
  const identity = {
    deviceId: dev.device_id,
    serialNumber: dev.serial_number,
    modelName: dev.model_name,
    modelVersion: dev.model_version,
  };
  const pems = {
    certificatePem: dev.certificate_pem,
    privateKeyPem: dev.private_key_pem, // already decrypted by db module using AES-256-GCM
  };

  const fd = new FiscalDevice(identity, pems, {
    environment: dev.environment as any,
    baseUrl: overrides.baseUrl,
    ca: overrides.ca,
  });

  // Always restore saved day state from DB
  let savedState = await loadDayStateDb(tenantId, dev.device_id);
  if (!savedState && existsSync(".zimra/day-state.json")) {
    try {
      const fileContent = JSON.parse(readFileSync(".zimra/day-state.json", "utf-8"));
      if (fileContent.deviceId === dev.device_id && fileContent.state) {
        savedState = fileContent.state;
        await saveDayStateDb(tenantId, dev.device_id, savedState);
      }
    } catch { /* ignore */ }
  }
  if (savedState) fd.restoreState(savedState);

  return { fd, deviceRecord: dev };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  
  // CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    });
    return res.end();
  }

  // Frontend Dashboard
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(getPortalHtml());
  }

  // Health Smoke Test (Public)
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      status: "ok",
      service: "ZIMRA FDMS Multi-Tenant Gateway Server",
      version: "0.4.1",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  }

  // Public Status Smoke Test (When not authenticated)
  if (req.method === "GET" && url.pathname === "/api/status") {
    const tenant = await getAuthTenant(req);
    if (!tenant) {
      return sendJson(res, 200, {
        status: "online",
        service: "ZIMRA FDMS Multi-Tenant Gateway Server",
        version: "0.4.1",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        authenticated: false,
        message: "Gateway operational. Provide 'X-API-Key' or Bearer token for tenant device status.",
      });
    }
  }

  // 1. POST /api/auth/register
  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    try {
      const body = await parseBody(req);
      const { tenant, apiKey } = await registerTenant(body.name, body.email, body.password);
      const { sessionToken } = await loginTenant(body.email, body.password);
      return sendJson(res, 201, { success: true, tenant, apiKey, sessionToken }, {
        "Set-Cookie": `zimra_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`,
      });
    } catch (err: any) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // 2. POST /api/auth/login
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    try {
      const body = await parseBody(req);
      const { tenant, sessionToken, apiKeyPrefix } = await loginTenant(body.email, body.password);
      return sendJson(res, 200, { success: true, tenant, sessionToken, apiKeyPrefix }, {
        "Set-Cookie": `zimra_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`,
      });
    } catch (err: any) {
      return sendJson(res, 401, { error: err.message });
    }
  }

  // 3. POST /api/auth/logout
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    return sendJson(res, 200, { success: true }, {
      "Set-Cookie": `zimra_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    });
  }

  // 4. GET /api/me
  if (req.method === "GET" && url.pathname === "/api/me") {
    const tenant = await getAuthTenant(req);
    if (!tenant) return sendJson(res, 401, { error: "Unauthenticated" });
    return sendJson(res, 200, { tenant });
  }

  // --- Authenticated Tenant Endpoints ---
  const currentTenant = await getAuthTenant(req);
  if (!currentTenant) {
    return sendJson(res, 401, { error: "Authentication required. Provide X-API-Key or valid session." });
  }

  try {
    // SuperAdmin: GET /api/admin/clients
    if (req.method === "GET" && url.pathname === "/api/admin/clients") {
      const clients = await listAllTenantsWithDetails();
      const enriched = clients.map((c) => {
        const enrichedDevices = c.devices.map((d) => {
          let certValidTo: string | undefined;
          if (d.certificatePem) {
            try {
              const x509 = new X509Certificate(d.certificatePem);
              certValidTo = x509.notAfter.toISOString();
            } catch {}
          }
          return { ...d, certificateValidTo: certValidTo };
        });
        return { ...c, devices: enrichedDevices };
      });
      return sendJson(res, 200, { success: true, clients: enriched });
    }

    // SuperAdmin: POST /api/admin/clients
    if (req.method === "POST" && url.pathname === "/api/admin/clients") {
      const body = await parseBody(req);
      const name = String(body.name || "").trim();
      const deviceId = Number(body.deviceId);
      const serialNumber = String(body.serialNumber || "").trim();
      const activationKey = String(body.activationKey || "").trim();
      const env = body.environment || "test";

      if (!name) return sendJson(res, 400, { error: "Client / business name is required." });
      if (!deviceId || isNaN(deviceId)) return sendJson(res, 400, { error: "Valid numeric ZIMRA Device ID is required." });
      if (!serialNumber) return sendJson(res, 400, { error: "ZIMRA Serial Number is required." });
      if (!activationKey) return sendJson(res, 400, { error: "ZIMRA Activation Key is required." });

      const clientEmail = "client_" + Date.now() + "_" + Math.floor(Math.random() * 1000) + "@vfd.local";
      const rawApiKey = "zf_live_" + crypto.randomBytes(24).toString("hex");
      const randomPassword = crypto.randomBytes(16).toString("hex");

      const { tenant: newTenant } = await registerTenant(name, clientEmail, randomPassword, rawApiKey);

      const identity = {
        deviceId,
        serialNumber,
        modelName: "Server",
        modelVersion: "v1",
      };

      const overrides = endpointOverrides();
      const reg = await registerDevice(identity, activationKey, {
        environment: env,
        baseUrl: overrides.baseUrl,
        transport: overrides.ca ? new NodeTransport(undefined, { ca: overrides.ca }) : undefined,
      });

      await saveTenantDevice(newTenant.id, {
        ...identity,
        environment: env,
        certificatePem: reg.certificatePem,
        privateKeyPem: reg.keys.privateKeyPem,
      });

      // Auto-open fiscal day 1 so the device is immediately ready for sales receipts
      try {
        const { fd: newFd } = await getDeviceInstanceForTenant(newTenant.id, { deviceId: identity.deviceId, serialNumber: identity.serialNumber });
        await newFd.reconcile();
        await newFd.openDay();
        await saveDayStateDb(newTenant.id, identity.deviceId, newFd.getState()!);
      } catch {
        // Can be opened manually later if needed
      }

      return sendJson(res, 201, {
        success: true,
        tenant: { id: newTenant.id, name: newTenant.name, email: newTenant.email },
        apiKey: rawApiKey,
        device: { deviceId: identity.deviceId, serialNumber: identity.serialNumber },
      });
    }

    // SuperAdmin: POST /api/admin/switch-client
    if (req.method === "POST" && url.pathname === "/api/admin/switch-client") {
      const body = await parseBody(req);
      if (!body.tenantId) return sendJson(res, 400, { error: "tenantId is required" });
      const sessionToken = await createSessionForTenant(body.tenantId);
      return sendJson(res, 200, { success: true, sessionToken }, {
        "Set-Cookie": `zimra_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`,
      });
    }

    // SuperAdmin: DELETE /api/admin/clients
    if (req.method === "DELETE" && url.pathname === "/api/admin/clients") {
      const tenantId = url.searchParams.get("id");
      if (!tenantId) return sendJson(res, 400, { error: "Client id parameter is required" });
      await deleteTenantCascade(tenantId);
      return sendJson(res, 200, { success: true });
    }

    // SuperAdmin / Admin: GET /api/admin/fiscal-days
    if (req.method === "GET" && url.pathname === "/api/admin/fiscal-days") {
      const isSuper = currentTenant.name === "Admin" || currentTenant.email === "admin@zimra-fdms.local";
      const days = await listAllFiscalDaysFromDb(isSuper ? undefined : currentTenant.id);
      return sendJson(res, 200, { success: true, days });
    }

    // SuperAdmin / Admin: POST /api/admin/fiscal-days/open-all
    if (req.method === "POST" && url.pathname === "/api/admin/fiscal-days/open-all") {
      const isSuper = currentTenant.name === "Admin" || currentTenant.email === "admin@zimra-fdms.local";
      const clients = isSuper ? await listAllTenantsWithDetails() : [{ id: currentTenant.id, name: currentTenant.name, devices: await getTenantDevices(currentTenant.id) }];
      let openedCount = 0;
      const errors: string[] = [];

      for (const c of clients) {
        for (const d of (c.devices || [])) {
          const devId = Number(d.deviceId || (d as any).device_id);
          try {
            const savedState = await loadDayStateDb(c.id, devId);
            if (!savedState || (savedState as any).status === "FiscalDayClosed") {
              const { fd } = await getDeviceInstanceForTenant(c.id, { deviceId: devId });
              await fd.reconcile();
              const resOpen = await fd.openDay();
              await saveDayStateDb(c.id, devId, fd.getState()!);
              await recordFiscalDayOpenDb(c.id, devId, resOpen.fiscalDayNo, new Date().toISOString());
              openedCount++;
            }
          } catch (err: any) {
            errors.push(`${c.name} (${d.serialNumber || (d as any).serial_number}): ${err.message}`);
          }
        }
      }

      return sendJson(res, 200, {
        success: true,
        openedCount,
        message: openedCount > 0 ? `Successfully opened fiscal days on ${openedCount} device(s).` : "All devices already have open fiscal days.",
        errors: errors.length ? errors : undefined,
      });
    }

    // SuperAdmin / Admin: POST /api/admin/fiscal-days/close-all
    if (req.method === "POST" && url.pathname === "/api/admin/fiscal-days/close-all") {
      const isSuper = currentTenant.name === "Admin" || currentTenant.email === "admin@zimra-fdms.local";
      const clients = isSuper ? await listAllTenantsWithDetails() : [{ id: currentTenant.id, name: currentTenant.name, devices: await getTenantDevices(currentTenant.id) }];
      let closedCount = 0;
      const errors: string[] = [];

      for (const c of clients) {
        for (const d of (c.devices || [])) {
          const devId = Number(d.deviceId || (d as any).device_id);
          try {
            const savedState = await loadDayStateDb(c.id, devId);
            if (savedState && (savedState as any).status !== "FiscalDayClosed") {
              const { fd } = await getDeviceInstanceForTenant(c.id, { deviceId: devId });
              await fd.reconcile();
              const dayNo = (savedState as any).fiscalDayNo || 1;
              let totalAmount = 0;
              let currency = "USD";
              if (Array.isArray((savedState as any).counters)) {
                for (const ctr of (savedState as any).counters) {
                  if (ctr.fiscalCounterType === "SaleByTax") {
                    totalAmount += Number(ctr.fiscalCounterValue || 0);
                    if (ctr.fiscalCounterCurrency) currency = ctr.fiscalCounterCurrency;
                  }
                }
              }
              const resClose = await fd.closeDay({ force: true });
              await recordFiscalDayCloseDb(
                c.id,
                devId,
                dayNo,
                new Date().toISOString(),
                resClose.operationID,
                undefined,
                Number((savedState as any).receiptCounter || 0),
                totalAmount,
                currency
              );
              await clearDayStateDb(c.id, devId);
              closedCount++;
            }
          } catch (err: any) {
            errors.push(`${c.name} (${d.serialNumber || (d as any).serial_number}): ${err.message}`);
          }
        }
      }

      return sendJson(res, 200, {
        success: true,
        closedCount,
        message: closedCount > 0 ? `Successfully closed fiscal days on ${closedCount} device(s).` : "All devices are already closed.",
        errors: errors.length ? errors : undefined,
      });
    }

    // SuperAdmin / Admin: POST /api/admin/fiscal-days/open (specific device)
    if (req.method === "POST" && url.pathname === "/api/admin/fiscal-days/open") {
      const body = await parseBody(req);
      const targetTenantId = body.tenantId || currentTenant.id;
      const devId = Number(body.deviceId);
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(targetTenantId, { deviceId: devId });
      await fd.reconcile();
      const resOpen = await fd.openDay();
      await saveDayStateDb(targetTenantId, deviceRecord.device_id, fd.getState()!);
      await recordFiscalDayOpenDb(targetTenantId, deviceRecord.device_id, resOpen.fiscalDayNo, new Date().toISOString());
      return sendJson(res, 200, {
        success: true,
        fiscalDayNo: resOpen.fiscalDayNo,
        message: `Fiscal day ${resOpen.fiscalDayNo} opened successfully for ${deviceRecord.serial_number}.`
      });
    }

    // SuperAdmin / Admin: POST /api/admin/fiscal-days/close (specific device)
    if (req.method === "POST" && url.pathname === "/api/admin/fiscal-days/close") {
      const body = await parseBody(req);
      const targetTenantId = body.tenantId || currentTenant.id;
      const devId = Number(body.deviceId);
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(targetTenantId, { deviceId: devId });
      await fd.reconcile();
      const savedState = fd.getState() as any;
      const dayNo = savedState?.fiscalDayNo || 1;
      let totalAmount = 0;
      let currency = "USD";
      if (Array.isArray(savedState?.counters)) {
        for (const ctr of savedState.counters) {
          if (ctr.fiscalCounterType === "SaleByTax") {
            totalAmount += Number(ctr.fiscalCounterValue || 0);
            if (ctr.fiscalCounterCurrency) currency = ctr.fiscalCounterCurrency;
          }
        }
      }
      const resClose = await fd.closeDay({ force: true });
      await recordFiscalDayCloseDb(
        targetTenantId,
        deviceRecord.device_id,
        dayNo,
        new Date().toISOString(),
        resClose.operationID,
        undefined,
        Number(savedState?.receiptCounter || 0),
        totalAmount,
        currency
      );
      await clearDayStateDb(targetTenantId, deviceRecord.device_id);
      return sendJson(res, 200, {
        success: true,
        message: `Fiscal day ${dayNo} closed for device ${deviceRecord.serial_number}.`,
        operationId: resClose.operationID
      });
    }

    // 5. POST /api/auth/regenerate-api-key
    if (req.method === "POST" && url.pathname === "/api/auth/regenerate-api-key") {
      const newKey = await regenerateApiKey(currentTenant.id);
      return sendJson(res, 200, { success: true, apiKey: newKey });
    }

    // 6. POST /api/device/register
    if (req.method === "POST" && url.pathname === "/api/device/register") {
      const body = await parseBody(req);
      const identity = {
        deviceId: Number(body.deviceId),
        serialNumber: String(body.serialNumber).trim(),
        modelName: String(body.modelName || "Server"),
        modelVersion: String(body.modelVersion || "v1"),
      };
      const key = String(body.activationKey);
      const env = body.environment || "test";

      const overrides = endpointOverrides();
      const reg = await registerDevice(identity, key, {
        environment: env,
        baseUrl: overrides.baseUrl,
        transport: overrides.ca ? new NodeTransport(undefined, { ca: overrides.ca }) : undefined,
      });

      // Stored with AES-256-GCM encryption
      await saveTenantDevice(currentTenant.id, {
        ...identity,
        environment: env,
        certificatePem: reg.certificatePem,
        privateKeyPem: reg.keys.privateKeyPem,
      });

      return sendJson(res, 200, { success: true, message: `Device ${identity.serialNumber} (ID ${identity.deviceId}) registered with AES-256 encrypted keys.` });
    }

    // 7. GET /api/status (Authenticated)
    if (req.method === "GET" && url.pathname === "/api/status") {
      const serialQuery = url.searchParams.get("serialNumber") || undefined;
      const deviceIdQuery = url.searchParams.get("deviceId") ? Number(url.searchParams.get("deviceId")) : undefined;
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(currentTenant.id, { serialNumber: serialQuery, deviceId: deviceIdQuery });
      const status = await fd.getStatus();
      const overrides = endpointOverrides();

      let certificateValidTo: string | null = null;
      try {
        const cert = new X509Certificate(deviceRecord.certificate_pem);
        certificateValidTo = cert.notAfter.toISOString();
      } catch { /* ignore */ }

      const queueSize = await getQueuedCount(currentTenant.id, deviceRecord.device_id);

      return sendJson(res, 200, {
        status: "online",
        authenticated: true,
        tenant: {
          id: currentTenant.id,
          name: currentTenant.name,
          email: currentTenant.email,
        },
        device: {
          deviceId: deviceRecord.device_id,
          serialNumber: deviceRecord.serial_number,
          environment: deviceRecord.environment,
          certificateValidTo,
        },
        fiscalStatus: status,
        status: status, // for backwards-compatibility
        queueSize,
        baseUrl: overrides.baseUrl || "ZIMRA Test Portal",
        dayState: fd.getState() || null,
      });
    }

    // 8. GET /api/config
    if (req.method === "GET" && url.pathname === "/api/config") {
      const serialQuery = url.searchParams.get("serialNumber") || undefined;
      const { fd } = await getDeviceInstanceForTenant(currentTenant.id, { serialNumber: serialQuery });
      const config = await fd.getConfig();
      return sendJson(res, 200, { config });
    }

    // 9. GET /api/receipts/history
    if (req.method === "GET" && url.pathname === "/api/receipts/history") {
      const isSuper = currentTenant.name === "Admin" || currentTenant.email === "admin@zimra-fdms.local";
      const filterTenantId = url.searchParams.get("tenantId");
      const targetTenantId = filterTenantId || (isSuper ? undefined : currentTenant.id);
      const receipts = await getTenantReceipts(targetTenantId, 100);
      return sendJson(res, 200, receipts);
    }

    // 10. POST /api/day/open
    if (req.method === "POST" && url.pathname === "/api/day/open") {
      const body = await parseBody(req);
      const identifier = {
        deviceId: body.deviceId ? Number(body.deviceId) : undefined,
        serialNumber: body.serialNumber ? String(body.serialNumber).trim() : undefined,
      };
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(currentTenant.id, identifier);
      await fd.reconcile();
      const resOpen = await fd.openDay();
      await saveDayStateDb(currentTenant.id, deviceRecord.device_id, fd.getState()!);
      await recordFiscalDayOpenDb(currentTenant.id, deviceRecord.device_id, resOpen.fiscalDayNo, new Date().toISOString());
      return sendJson(res, 200, {
        success: true,
        fiscalDayNo: resOpen.fiscalDayNo,
        message: `Fiscal day ${resOpen.fiscalDayNo} opened successfully on device ${deviceRecord.serial_number}.`,
        result: resOpen
      });
    }

    // 11. POST /api/day/close
    if (req.method === "POST" && url.pathname === "/api/day/close") {
      const body = await parseBody(req);
      const identifier = {
        deviceId: body.deviceId ? Number(body.deviceId) : undefined,
        serialNumber: body.serialNumber ? String(body.serialNumber).trim() : undefined,
      };
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(currentTenant.id, identifier);
      await fd.reconcile();
      const savedState = fd.getState() as any;
      const dayNo = savedState?.fiscalDayNo || 1;
      let totalAmount = 0;
      let currency = "USD";
      if (Array.isArray(savedState?.counters)) {
        for (const ctr of savedState.counters) {
          if (ctr.fiscalCounterType === "SaleByTax") {
            totalAmount += Number(ctr.fiscalCounterValue || 0);
            if (ctr.fiscalCounterCurrency) currency = ctr.fiscalCounterCurrency;
          }
        }
      }
      const resClose = await fd.closeDay({ force: body.force ?? true });
      await recordFiscalDayCloseDb(
        currentTenant.id,
        deviceRecord.device_id,
        dayNo,
        new Date().toISOString(),
        resClose.operationID,
        undefined,
        Number(savedState?.receiptCounter || 0),
        totalAmount,
        currency
      );
      await clearDayStateDb(currentTenant.id, deviceRecord.device_id);
      return sendJson(res, 200, {
        success: true,
        message: `Fiscal day close submitted for device ${deviceRecord.serial_number}.`,
        operationId: resClose.operationID
      });
    }

    // 12. POST /api/receipt & POST /api/receipts/submit
    if (req.method === "POST" && (url.pathname === "/api/receipt" || url.pathname === "/api/receipts/submit")) {
      const body = await parseBody(req);
      const identifier = {
        deviceId: body.deviceId ? Number(body.deviceId) : undefined,
        serialNumber: body.serialNumber ? String(body.serialNumber).trim() : undefined,
      };
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(currentTenant.id, identifier);

      await fd.reconcile();
      if (!fd.getState() || (fd.getState() as any)?.status === "FiscalDayClosed") {
        try {
          await fd.openDay();
          await saveDayStateDb(currentTenant.id, deviceRecord.device_id, fd.getState()!);
        } catch {}
      }
      await fd.getConfig(); // ensures qrUrl is populated for QR code computation

      const input = receiptInputFromJson(body);
      const isExplicitOffline = body.mode === "offline" || body.operatingMode === "offline";

      if (isExplicitOffline) {
        // Sign and queue locally without submitting to server
        const prepared = await fd.signReceipt(input);
        await fd.applyPrepared(prepared);
        await saveDayStateDb(currentTenant.id, deviceRecord.device_id, fd.getState()!);
        const queueId = await enqueueOfflineReceipt(currentTenant.id, deviceRecord.device_id, body, prepared);
        const qrData = fd.qrData(prepared) || "";

        return sendJson(res, 200, {
          success: true,
          queued: true,
          queueId,
          tenantId: currentTenant.id,
          device: {
            deviceId: deviceRecord.device_id,
            serialNumber: deviceRecord.serial_number,
          },
          receiptCounter: prepared.receipt.receiptCounter,
          receiptGlobalNo: prepared.receipt.receiptGlobalNo,
          fiscalDayNo: fd.getState()?.fiscalDayNo,
          signature: prepared.receipt.receiptDeviceSignature.signature,
          verificationUrl: qrData,
          qrData,
          qrCodeImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrData)}`,
          message: "Receipt cryptographically signed and stored in offline queue.",
        });
      }

      // Online submission path with automated queue fallback
      try {
        const sale = await fd.submitReceipt(input);
        await saveDayStateDb(currentTenant.id, deviceRecord.device_id, fd.getState()!);

        const totalAmount = body.payments
          ? body.payments.reduce((acc: number, p: any) => acc + Number(p.amount || 0), 0)
          : 0;

        // Persist permanently in database ledger
        await recordReceiptDb(
          currentTenant.id,
          deviceRecord.device_id,
          sale.receipt.receiptCounter,
          sale.receipt.receiptGlobalNo,
          body.receiptType || "FiscalInvoice",
          body.invoiceNo || `REC-${sale.response.receiptID}`,
          body.currency || "USD",
          totalAmount,
          sale.qrData || "",
          sale.response
        );

        return sendJson(res, 200, {
          success: true,
          tenantId: currentTenant.id,
          device: {
            deviceId: deviceRecord.device_id,
            serialNumber: deviceRecord.serial_number,
          },
          receiptId: sale.response.receiptID,
          receiptCounter: sale.receipt.receiptCounter,
          receiptGlobalNo: sale.receipt.receiptGlobalNo,
          fiscalDayNo: fd.getState()?.fiscalDayNo,
          signature: sale.receipt.receiptDeviceSignature?.signature,
          verificationUrl: sale.qrData,
          qrData: sale.qrData,
          qrCodeImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(sale.qrData || "")}`,
          validationErrors: sale.response.validationErrors || [],
          response: sale.response,
        });
      } catch (err: any) {
        if (body.operatingMode === "QueueOnFailure") {
          // Fallback to queue on failure
          const prepared = await fd.signReceipt(input);
          await fd.applyPrepared(prepared);
          await saveDayStateDb(currentTenant.id, deviceRecord.device_id, fd.getState()!);
          const queueId = await enqueueOfflineReceipt(currentTenant.id, deviceRecord.device_id, body, prepared);
          const qrData = fd.qrData(prepared) || "";

          return sendJson(res, 200, {
            success: true,
            queued: true,
            queueId,
            tenantId: currentTenant.id,
            device: {
              deviceId: deviceRecord.device_id,
              serialNumber: deviceRecord.serial_number,
            },
            receiptCounter: prepared.receipt.receiptCounter,
            receiptGlobalNo: prepared.receipt.receiptGlobalNo,
            fiscalDayNo: fd.getState()?.fiscalDayNo,
            signature: prepared.receipt.receiptDeviceSignature.signature,
            verificationUrl: qrData,
            qrData,
            qrCodeImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrData)}`,
            message: "Online submission unreachable. Receipt signed and stored in offline queue per QueueOnFailure policy.",
            warning: err.message,
          });
        }
        throw err;
      }
    }

    // 13. GET /api/queue/status
    if (req.method === "GET" && url.pathname === "/api/queue/status") {
      const pending = await getQueuedReceipts(currentTenant.id);
      return sendJson(res, 200, { count: pending.length, pending });
    }

    // 14. POST /api/queue/flush
    if (req.method === "POST" && url.pathname === "/api/queue/flush") {
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(currentTenant.id);
      const pending = await getQueuedReceipts(currentTenant.id, deviceRecord.device_id);
      const flushed: any[] = [];
      for (const item of pending) {
        const prepared = JSON.parse(item.prepared_json);
        const resSubmit = await fd.submitPrepared(prepared);
        await markQueuedReceiptSubmitted(item.id);
        const origBody = JSON.parse(item.receipt_json);
        const totalAmount = origBody.payments
          ? origBody.payments.reduce((acc: number, p: any) => acc + Number(p.amount || 0), 0)
          : 0;
        await recordReceiptDb(
          currentTenant.id,
          deviceRecord.device_id,
          resSubmit.receipt.receiptCounter,
          resSubmit.receipt.receiptGlobalNo,
          origBody.receiptType || "FiscalInvoice",
          origBody.invoiceNo || `REC-${resSubmit.response.receiptID}`,
          origBody.currency || "USD",
          totalAmount,
          resSubmit.qrData || "",
          resSubmit.response
        );
        flushed.push({ queueId: item.id, receiptGlobalNo: resSubmit.receipt.receiptGlobalNo, receiptId: resSubmit.response.receiptID });
      }
      await saveDayStateDb(currentTenant.id, deviceRecord.device_id, fd.getState()!);
      return sendJson(res, 200, { success: true, count: flushed.length, flushed });
    }

    return sendJson(res, 404, { error: "Endpoint not found" });
  } catch (err: any) {
    if (err instanceof FdmsApiError) {
      return sendJson(res, 400, { error: err.message, hint: err.hint, operationId: err.operationId });
    }
    return sendJson(res, 500, { error: err.message || String(err) });
  }
});

bootstrap().then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Production ZIMRA Fiscal Server running at: http://localhost:${PORT}`);
    console.log(`   - Storage Engine: ${process.env.DATABASE_URL ? "PostgreSQL" : "SQLite (fdms-multi-tenant.db)"}`);
    console.log(`   - Private Keys:   AES-256-GCM Encrypted`);
    console.log(`   - API Keys:       SHA-256 Hashed`);
    console.log(`   - Device Routing: Device ID or serialNumber supported`);
    console.log(`======================================================\n`);
  });
}).catch(err => {
  console.error("Failed to start fiscal server:", err);
  process.exit(1);
});
