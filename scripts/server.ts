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
  listAllStores,
  getStoreById,
  createStore,
  updateStore,
  deleteStore,
  getReceiptByInvoiceNo,
  getTenantByDeviceSerial,
  getDefaultAdminTenant,
} from "../src/server/db.js";
import { registerDevice } from "../src/node/registration.js";
import { FiscalDevice } from "../src/node/device.js";
import { NodeTransport } from "../src/node/transport.js";
import { receiptInputFromJson } from "../src/core/money.js";
import { FdmsApiError } from "../src/core/types.js";
import { endpointOverrides, writeProfile } from "../src/node/profile.js";
import { FdmsSimulator } from "../src/simulator/server.js";
import { getOpenApiSpec, getSwaggerUiHtml } from "../src/server/swagger.js";

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
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      if (!raw || !raw.trim()) return resolve({});
      const contentType = req.headers["content-type"] || "";
      if (contentType.includes("application/x-www-form-urlencoded")) {
        try {
          const params = new URLSearchParams(raw);
          const result: Record<string, any> = {};
          for (const [key, val] of params.entries()) {
            result[key] = val;
          }
          return resolve(result);
        } catch (e: any) {
          return reject(new Error("Failed to parse form urlencoded body: " + e.message));
        }
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        // Fallback: check if it parses as URLSearchParams
        try {
          const params = new URLSearchParams(raw);
          const result: Record<string, any> = {};
          let count = 0;
          for (const [key, val] of params.entries()) {
            result[key] = val;
            count++;
          }
          if (count > 0 && !raw.startsWith("{") && !raw.startsWith("[")) {
            return resolve(result);
          }
        } catch {}
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function parseHavanoItemsXml(xml: string) {
  const items: Array<{
    name: string;
    price: number;
    quantity: number;
    taxId: number;
    taxPercent: number | null;
    taxCode: string;
    hsCode: string;
    total: number;
  }> = [];

  if (!xml || typeof xml !== "string") return items;

  const itemMatches = xml.match(/<ITEM>[\s\S]*?<\/ITEM>/gi) || [];
  for (const block of itemMatches) {
    const getTag = (tag: string) => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
      return m ? m[1].trim() : "";
    };

    const name = getTag("ITEMNAME") || getTag("ITEMNAME2") || "General Item";
    const hsCode = getTag("ITEMCODE") || "99999999";
    const qty = Math.abs(parseFloat(getTag("QTY"))) || 1;
    const price = Math.abs(parseFloat(getTag("PRICE"))) || 0;
    const total = Math.abs(parseFloat(getTag("TOTAL"))) || (price * qty);
    const vatrStr = getTag("VATR");
    let vatRate = Math.abs(parseFloat(vatrStr)) || 0;
    if (vatRate > 0 && vatRate < 1) {
      vatRate = Math.round(vatRate * 100);
    }
    const vname = (getTag("VNAME") || "").toUpperCase();

    let taxId = 1;
    let taxPercent: number | null = 15;
    let taxCode = "VAT";

    if (vname.includes("EXEMPT") || (vatRate === 0 && !vname.includes("ZERO"))) {
      taxId = 3;
      taxPercent = null;
      taxCode = "EXEMPT";
    } else if (vname.includes("ZERO") || vatRate === 0) {
      taxId = 2;
      taxPercent = 0;
      taxCode = "ZERO";
    } else {
      taxId = 1;
      taxPercent = vatRate || 15;
      taxCode = "VAT";
    }

    items.push({
      name,
      price,
      quantity: qty,
      taxId,
      taxPercent,
      taxCode,
      hsCode,
      total,
    });
  }
  return items;
}

function sendJson(res: http.ServerResponse, statusCode: number, data: any, headers: Record<string, string> = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Frappe-CSRF-Token",
    ...headers,
  });
  res.end(JSON.stringify(data, null, 2));
}

async function getAuthTenant(req: http.IncomingMessage, deviceSerialFallback?: string) {
  const authHeader = req.headers.authorization;

  // 1. Check Frappe Token Header ("Authorization: token <api_key>:<api_secret>")
  if (authHeader && authHeader.toLowerCase().startsWith("token ")) {
    const raw = authHeader.slice(6).trim();
    const [keyPart] = raw.split(":");
    if (keyPart) {
      const tenant = await authenticateApiKey(keyPart.trim());
      if (tenant) return tenant;
    }
  }

  // 2. Check API Key header or Bearer zf_live_
  const apiKey = (req.headers["x-api-key"] as string) || (authHeader?.startsWith("Bearer zf_live_") ? authHeader.slice(7) : null);
  if (apiKey) {
    const tenant = await authenticateApiKey(apiKey.trim());
    if (tenant) return tenant;
  }

  // 3. Check Session Token in Authorization header or Cookie
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

  // 4. Fallback lookup by device serial if provided
  if (deviceSerialFallback) {
    const tenant = await getTenantByDeviceSerial(deviceSerialFallback.trim());
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

  // Static Assets / Favicon
  if (req.method === "GET" && (url.pathname === "/favicon.ico" || url.pathname.startsWith("/public/") || url.pathname.startsWith("/assets/"))) {
    const relPath = url.pathname === "/favicon.ico" ? "public/favicon.ico" : url.pathname.replace(/^\/(public|assets)\//, "public/");
    const filePath = join(process.cwd(), relPath);
    if (existsSync(filePath)) {
      const ext = filePath.split(".").pop()?.toLowerCase();
      const mimeTypes: Record<string, string> = {
        ico: "image/x-icon",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        svg: "image/svg+xml",
      };
      res.writeHead(200, {
        "Content-Type": mimeTypes[ext || ""] || "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
      });
      return res.end(readFileSync(filePath));
    }
  }

  // Frontend Dashboard
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(getPortalHtml());
  }

  // Swagger API Documentation (UI)
  if (req.method === "GET" && (url.pathname === "/api/docs" || url.pathname === "/docs" || url.pathname === "/swagger" || url.pathname === "/swagger-ui")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(getSwaggerUiHtml("/api/docs.json"));
  }

  // OpenAPI 3.0 Specification (JSON)
  if (req.method === "GET" && (url.pathname === "/api/docs.json" || url.pathname === "/api/docs/swagger.json" || url.pathname === "/swagger.json" || url.pathname === "/openapi.json")) {
    const proto = (req.headers["x-forwarded-proto"] as string) || "http";
    const host = req.headers.host || `localhost:${PORT}`;
    const serverUrl = `${proto}://${host}`;
    return sendJson(res, 200, getOpenApiSpec(serverUrl));
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

  // =========================================================================
  // HAVANO POS COMPATIBILITY LAYER (Zero POS Code Changes)
  // =========================================================================

  // A. POST /api/method/havanozimracloud.api.token (CSRF Token & Connection Ping)
  if (req.method === "POST" && (
    url.pathname === "/api/method/havanozimracloud.api.token" ||
    url.pathname.endsWith("/havanozimracloud.api.token")
  )) {
    return sendJson(res, 200, {
      token: "zf_live_csrf_token_ok",
      message: "zf_live_csrf_token_ok",
    });
  }

  // B. POST /api/method/havanozimracloud.api.sendinvoice (Fiscal Invoice & Credit Note)
  if (req.method === "POST" && (
    url.pathname === "/api/method/havanozimracloud.api.sendinvoice" ||
    url.pathname.endsWith("/havanozimracloud.api.sendinvoice")
  )) {
    try {
      const body = await parseBody(req);
      const deviceSn = body.device_sn ? String(body.device_sn).trim() : undefined;

      // 1. Resolve tenant (API key header, or device serial fallback, or default Admin)
      let tenant = await getAuthTenant(req, deviceSn);
      if (!tenant && deviceSn) {
        tenant = await getTenantByDeviceSerial(deviceSn);
      }
      if (!tenant) {
        tenant = await getDefaultAdminTenant();
      }
      if (!tenant) {
        return sendJson(res, 200, {
          message: {
            Message: "No registered tenant or store found on fiscal server. Please provision a store first."
          }
        });
      }

      // 2. Identify Device
      const identifier = deviceSn ? { serialNumber: deviceSn } : undefined;
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(tenant.id, identifier);

      // 3. Determine Sale vs Credit Note
      const invoiceFlag = Number(body.invoice_flag || 0);
      const isCreditNote = invoiceFlag === 1 || invoiceFlag === 3;
      const receiptType = isCreditNote ? "CreditNote" : "FiscalInvoice";
      const currency = String(body.currency || "USD").toUpperCase();
      const invoiceNumber = String(body.invoice_number || `INV-${Date.now()}`);

      // 4. Parse Items XML
      let parsedItems = parseHavanoItemsXml(body.items_xml || "");
      if (parsedItems.length === 0) {
        const tenderedVal = Math.abs(parseFloat(body.tendered || "0")) || 1.0;
        parsedItems.push({
          name: "General Sale",
          price: tenderedVal,
          quantity: 1,
          taxId: 1,
          taxPercent: 15,
          taxCode: "VAT",
          hsCode: "99999999",
          total: tenderedVal,
        });
      }

      // Dynamically align taxId with device config if available
      try {
        const cfg = await fd.getConfig();
        if (cfg.applicableTaxes && cfg.applicableTaxes.length > 0) {
          for (const item of parsedItems) {
            if (item.taxCode === "EXEMPT") {
              const matched = cfg.applicableTaxes.find(t => t.taxPercent === null || (t.taxName && t.taxName.toLowerCase().includes("exempt")));
              if (matched) item.taxId = matched.taxID;
            } else if (item.taxCode === "ZERO") {
              const matched = cfg.applicableTaxes.find(t => t.taxPercent === 0 || (t.taxName && t.taxName.toLowerCase().includes("zero")));
              if (matched) item.taxId = matched.taxID;
            } else {
              const matched = cfg.applicableTaxes.find(t => t.taxPercent === item.taxPercent || (t.taxName && t.taxName.toLowerCase().includes("vat")));
              if (matched) item.taxId = matched.taxID;
            }
          }
        }
      } catch {}

      // Calculate total in cents to prevent fractional drift
      const receiptTotalCents = parsedItems.reduce((acc, it) => acc + Math.round(it.price * 100 * it.quantity), 0);
      const receiptTotal = receiptTotalCents / 100;

      const lines = parsedItems.map(it => ({
        name: it.name,
        price: it.price,
        quantity: it.quantity,
        taxId: it.taxId,
        taxPercent: it.taxPercent,
        taxCode: it.taxCode,
        hsCode: it.hsCode || "99999999",
      }));

      // Payments in ZIMRA must strictly match receiptTotal
      const payments = [
        {
          moneyType: "Cash" as const,
          amount: receiptTotal,
        }
      ];

      // 5. Buyer Info
      let buyer: any = null;
      const custName = String(body.customer_name || "").trim();
      const isWalkIn = !custName || ["walk-in", "walk in customer", "default customer", "cash customer"].includes(custName.toLowerCase());
      if (!isWalkIn || (body.customer_tin && body.customer_tin !== "111111111")) {
        buyer = {
          buyerRegisterName: custName || "Valued Customer",
          buyerTradeName: String(body.trade_name || custName || "Valued Customer"),
          buyerTIN: (body.customer_tin && body.customer_tin !== "111111111") ? String(body.customer_tin) : undefined,
          vatNumber: (body.customer_vat_number && body.customer_vat_number !== "000000000") ? String(body.customer_vat_number) : undefined,
          buyerContacts: (body.customer_telephone_number || body.customer_email) ? {
            phoneNo: body.customer_telephone_number ? String(body.customer_telephone_number) : undefined,
            email: body.customer_email ? String(body.customer_email) : undefined,
          } : undefined,
          buyerAddress: (body.customer_city || body.customer_street || body.customer_province) ? {
            city: body.customer_city ? String(body.customer_city) : "Harare",
            street: body.customer_street ? String(body.customer_street) : "",
            province: body.customer_province ? String(body.customer_province) : "Harare",
            houseNo: body.customer_houseNo ? String(body.customer_houseNo) : "",
          } : undefined,
        };
      }

      // 6. Ensure open fiscal day
      await fd.reconcile();
      const status = await fd.getStatus();
      if (status.fiscalDayStatus === "FiscalDayClosed" || !fd.getState()) {
        try {
          const resOpen = await fd.openDay();
          await saveDayStateDb(tenant.id, deviceRecord.device_id, fd.getState()!);
          await recordFiscalDayOpenDb(tenant.id, deviceRecord.device_id, resOpen.fiscalDayNo, new Date().toISOString());
        } catch (openErr: any) {
          console.warn("[Havano Compat] auto openDay:", openErr.message);
        }
      }

      // 7. Credit Note Reference
      let creditDebitNote: any = null;
      if (isCreditNote) {
        let origGlobalNo = body.global_invoice_no ? parseInt(body.global_invoice_no, 10) : 0;
        let origDevId = deviceRecord.device_id;
        let origDayNo = fd.getState()?.fiscalDayNo || 1;

        if (!origGlobalNo && body.original_invoice_no) {
          const origReceipt = await getReceiptByInvoiceNo(tenant.id, String(body.original_invoice_no).trim());
          if (origReceipt) {
            origGlobalNo = origReceipt.receipt_global_no;
            origDevId = origReceipt.device_id;
          }
        }

        creditDebitNote = {
          receiptID: null,
          deviceID: origDevId,
          receiptGlobalNo: origGlobalNo || 1,
          fiscalDayNo: origDayNo,
        };
      }

      // 8. Sign and Submit Receipt
      const input = receiptInputFromJson({
        receiptType,
        currency,
        invoiceNo: invoiceNumber,
        lines,
        payments,
        linesTaxInclusive: true,
        buyer: buyer || undefined,
        creditDebitNote: creditDebitNote || undefined,
      });

      const sale = await fd.submitReceipt(input);
      await saveDayStateDb(tenant.id, deviceRecord.device_id, fd.getState()!);

      // Save to database ledger
      await recordReceiptDb(
        tenant.id,
        deviceRecord.device_id,
        sale.receipt.receiptCounter,
        sale.receipt.receiptGlobalNo,
        receiptType,
        invoiceNumber,
        currency,
        receiptTotal,
        sale.qrData || "",
        sale.response
      );

      // Return exact payload structure expected by Havano POS
      return sendJson(res, 200, {
        message: {
          Message: `${receiptType === "CreditNote" ? "Credit note" : "Receipt"} fiscalized successfully`,
          QRcode: sale.qrData || "",
          VerificationCode: sale.receipt.receiptDeviceSignature?.signature || "",
          DeviceID: String(deviceRecord.device_id),
          FiscalDay: String(fd.getState()?.fiscalDayNo || 1),
          receiptType: receiptType,
          receiptCurrency: currency,
          receiptCounter: sale.receipt.receiptCounter,
          receiptGlobalNo: sale.receipt.receiptGlobalNo,
          EFDSERIAL: deviceRecord.serial_number,
        }
      });
    } catch (err: any) {
      console.error("[Havano Compat] Error fiscalizing invoice:", err);
      return sendJson(res, 200, {
        message: {
          Message: `Fiscalization failed: ${err.message || String(err)}`
        }
      });
    }
  }

  // C. Open Fiscal Day (Havano, Axis, Revmax compatibility)
  if ((req.method === "POST" || req.method === "GET") && (
    url.pathname === "/api/method/havanozimracloud.api.openday" ||
    url.pathname.endsWith("/havanozimracloud.api.openday") ||
    url.pathname.toLowerCase() === "/api/virtualdevice/openfiscalday"
  )) {
    try {
      const body = await parseBody(req);
      const deviceSn = body.device_sn || url.searchParams.get("device_sn") || url.searchParams.get("serialNumber");
      let tenant = await getAuthTenant(req, deviceSn ? String(deviceSn) : undefined);
      if (!tenant && deviceSn) tenant = await getTenantByDeviceSerial(String(deviceSn).trim());
      if (!tenant) tenant = await getDefaultAdminTenant();
      if (!tenant) return sendJson(res, 400, { error: "No registered tenant found" });

      const identifier = deviceSn ? { serialNumber: String(deviceSn).trim() } : undefined;
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(tenant.id, identifier);

      await fd.reconcile();
      const status = await fd.getStatus();
      let fiscalDayNo = status.lastFiscalDayNo ? status.lastFiscalDayNo + 1 : 1;

      if (status.fiscalDayStatus === "FiscalDayOpened") {
        const savedState = fd.getState();
        fiscalDayNo = savedState?.fiscalDayNo || status.lastFiscalDayNo || 1;
        return sendJson(res, 200, {
          Code: 1,
          message: {
            Message: `Fiscal Day is already open (Day ${fiscalDayNo})`,
            FiscalDayNo: fiscalDayNo,
            FiscalDayStatus: "FiscalDayOpened",
            DeviceID: String(deviceRecord.device_id),
            EFDSERIAL: deviceRecord.serial_number,
          },
          Data: {
            FiscalDayNo: fiscalDayNo,
            FiscalDayStatus: "FiscalDayOpened",
            DeviceID: String(deviceRecord.device_id),
            SerialNo: deviceRecord.serial_number,
          }
        });
      }

      const resOpen = await fd.openDay();
      await saveDayStateDb(tenant.id, deviceRecord.device_id, fd.getState()!);
      await recordFiscalDayOpenDb(tenant.id, deviceRecord.device_id, resOpen.fiscalDayNo, new Date().toISOString());

      return sendJson(res, 200, {
        Code: 1,
        message: {
          Message: `Fiscal Day ${resOpen.fiscalDayNo} opened successfully`,
          FiscalDayNo: resOpen.fiscalDayNo,
          FiscalDayStatus: "FiscalDayOpened",
          DeviceID: String(deviceRecord.device_id),
          EFDSERIAL: deviceRecord.serial_number,
        },
        Data: {
          FiscalDayNo: resOpen.fiscalDayNo,
          FiscalDayStatus: "FiscalDayOpened",
          DeviceID: String(deviceRecord.device_id),
          SerialNo: deviceRecord.serial_number,
        }
      });
    } catch (err: any) {
      console.error("[OpenDay Compat] error:", err);
      return sendJson(res, 200, {
        Code: 0,
        message: {
          Message: `Failed to open Fiscal Day: ${err.message || String(err)}`
        },
        error: err.message || String(err)
      });
    }
  }

  // D. Close Fiscal Day / Z-Report (Havano, Axis, Revmax compatibility)
  if ((req.method === "POST" || req.method === "GET") && (
    url.pathname === "/api/method/havanozimracloud.api.closeday" ||
    url.pathname.endsWith("/havanozimracloud.api.closeday") ||
    url.pathname.toLowerCase() === "/api/virtualdevice/closefiscalday" ||
    url.pathname.toLowerCase() === "/api/revmaxapi/zreport"
  )) {
    try {
      const body = await parseBody(req);
      const deviceSn = body.device_sn || url.searchParams.get("device_sn") || url.searchParams.get("serialNumber");
      let tenant = await getAuthTenant(req, deviceSn ? String(deviceSn) : undefined);
      if (!tenant && deviceSn) tenant = await getTenantByDeviceSerial(String(deviceSn).trim());
      if (!tenant) tenant = await getDefaultAdminTenant();
      if (!tenant) return sendJson(res, 400, { error: "No registered tenant found" });

      const identifier = deviceSn ? { serialNumber: String(deviceSn).trim() } : undefined;
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(tenant.id, identifier);

      await fd.reconcile();
      const status = await fd.getStatus();
      if (status.fiscalDayStatus === "FiscalDayClosed") {
        return sendJson(res, 200, {
          Code: 1,
          message: {
            Message: "Fiscal Day is already closed",
            FiscalDayStatus: "FiscalDayClosed",
            DeviceID: String(deviceRecord.device_id),
            EFDSERIAL: deviceRecord.serial_number,
          },
          Data: {
            FiscalDayStatus: "FiscalDayClosed",
            DeviceID: String(deviceRecord.device_id),
            SerialNo: deviceRecord.serial_number,
          }
        });
      }

      const savedState = (fd.getState() || {}) as any;
      const dayNo = savedState.fiscalDayNo || status.lastFiscalDayNo || 1;
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
        tenant.id,
        deviceRecord.device_id,
        dayNo,
        new Date().toISOString(),
        resClose.operationID,
        undefined,
        Number(savedState.receiptCounter || 0),
        totalAmount,
        currency
      );
      await clearDayStateDb(tenant.id, deviceRecord.device_id);

      return sendJson(res, 200, {
        Code: 1,
        message: {
          Message: `Fiscal Day ${dayNo} closed successfully`,
          FiscalDayNo: dayNo,
          FiscalDayStatus: "FiscalDayClosed",
          OperationID: resClose.operationID,
          DeviceID: String(deviceRecord.device_id),
          EFDSERIAL: deviceRecord.serial_number,
        },
        Data: {
          FiscalDayNo: dayNo,
          FiscalDayStatus: "FiscalDayClosed",
          OperationID: resClose.operationID,
          DeviceID: String(deviceRecord.device_id),
          SerialNo: deviceRecord.serial_number,
        }
      });
    } catch (err: any) {
      console.error("[CloseDay Compat] error:", err);
      return sendJson(res, 200, {
        Code: 0,
        message: {
          Message: `Failed to close Fiscal Day: ${err.message || String(err)}`
        },
        error: err.message || String(err)
      });
    }
  }

  // E. Device / Day Status (Havano, Axis, Revmax compatibility)
  if ((req.method === "POST" || req.method === "GET") && (
    url.pathname === "/api/method/havanozimracloud.api.getdaystatus" ||
    url.pathname.endsWith("/havanozimracloud.api.getdaystatus") ||
    url.pathname.toLowerCase() === "/api/virtualdevice/getstatus" ||
    url.pathname.toLowerCase() === "/api/revmaxapi/getdaystatus"
  )) {
    try {
      const body = await parseBody(req);
      const deviceSn = body.device_sn || url.searchParams.get("device_sn") || url.searchParams.get("serialNumber");
      let tenant = await getAuthTenant(req, deviceSn ? String(deviceSn) : undefined);
      if (!tenant && deviceSn) tenant = await getTenantByDeviceSerial(String(deviceSn).trim());
      if (!tenant) tenant = await getDefaultAdminTenant();
      if (!tenant) return sendJson(res, 400, { error: "No registered tenant found" });

      const identifier = deviceSn ? { serialNumber: String(deviceSn).trim() } : undefined;
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(tenant.id, identifier);

      await fd.reconcile();
      const status = await fd.getStatus();
      const savedState = (fd.getState() || {}) as any;
      const dayNo = savedState.fiscalDayNo || status.lastFiscalDayNo || 1;

      return sendJson(res, 200, {
        Code: 1,
        message: {
          Message: `Device Online. Fiscal Day: ${dayNo} (${status.fiscalDayStatus})`,
          FiscalDayNo: dayNo,
          FiscalDayStatus: status.fiscalDayStatus,
          DeviceID: String(deviceRecord.device_id),
          EFDSERIAL: deviceRecord.serial_number,
        },
        Data: {
          FiscalDayNo: dayNo,
          FiscalDayStatus: status.fiscalDayStatus,
          DeviceID: String(deviceRecord.device_id),
          SerialNo: deviceRecord.serial_number,
        }
      });
    } catch (err: any) {
      return sendJson(res, 200, {
        Code: 0,
        message: { Message: `Error checking status: ${err.message || String(err)}` },
        error: err.message || String(err)
      });
    }
  }

  // F. VirtualDevice GetConfig compatibility
  if ((req.method === "POST" || req.method === "GET") && url.pathname.toLowerCase() === "/api/virtualdevice/getconfig") {
    try {
      const tenant = (await getAuthTenant(req)) || (await getDefaultAdminTenant());
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(tenant!.id);
      const config = await fd.getConfig();
      return sendJson(res, 200, {
        Code: 1,
        Data: {
          Config: config,
          DeviceID: deviceRecord.device_id,
          SerialNo: deviceRecord.serial_number,
        }
      });
    } catch (err: any) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 1. POST /api/auth/register
  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    try {
      const body = await parseBody(req);
      const { tenant, apiKey } = await registerTenant(body.name, body.email, body.password, undefined, {
        phone: body.phone,
        city: body.city,
        address: body.address,
        province: body.province,
        postalCode: body.postalCode || body.postal_code,
        country: body.country,
        tin: body.tin,
        vatNumber: body.vatNumber || body.vat_number,
        currency: body.currency,
        branchName: body.branchName || body.branch_name,
        contactPerson: body.contactPerson || body.contact_person,
        businessType: body.businessType || body.business_type,
        status: body.status,
      });
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

      const clientEmail = (body.email && String(body.email).trim())
        ? String(body.email).trim().toLowerCase()
        : "client_" + Date.now() + "_" + Math.floor(Math.random() * 1000) + "@vfd.local";
      const rawApiKey = "zf_live_" + crypto.randomBytes(24).toString("hex");
      const randomPassword = crypto.randomBytes(16).toString("hex");

      const orgDetails = {
        phone: body.phone,
        city: body.city || "Harare",
        address: body.address,
        province: body.province,
        postalCode: body.postalCode || body.postal_code,
        country: body.country || "Zimbabwe",
        tin: body.tin,
        vatNumber: body.vatNumber || body.vat_number,
        currency: body.currency || "USD",
        branchName: body.branchName || body.branch_name || "Main Branch",
        contactPerson: body.contactPerson || body.contact_person,
        businessType: body.businessType || body.business_type || "Retail",
        status: body.status || "active",
      };

      const { tenant: newTenant } = await registerTenant(name, clientEmail, randomPassword, rawApiKey, orgDetails);

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
        tenant: newTenant,
        apiKey: rawApiKey,
        device: { deviceId: identity.deviceId, serialNumber: identity.serialNumber },
      });
    }

    // SuperAdmin: PUT /api/admin/clients or POST /api/admin/clients/update
    if ((req.method === "PUT" || req.method === "POST") && (url.pathname === "/api/admin/clients/update" || (req.method === "PUT" && url.pathname === "/api/admin/clients"))) {
      const body = await parseBody(req);
      const targetId = body.id || body.tenantId || url.searchParams.get("id");
      if (!targetId) return sendJson(res, 400, { error: "Client / tenant ID is required" });
      const updated = await updateStore(targetId, body);
      return sendJson(res, 200, { success: true, store: updated });
    }

    // Stores: GET /api/stores
    if (req.method === "GET" && url.pathname === "/api/stores") {
      const isSuper = currentTenant.name === "Admin" || currentTenant.email === "admin@zimra-fdms.local";
      const filterTenantId = url.searchParams.get("tenantId") || (isSuper ? undefined : currentTenant.id);
      const stores = await listAllStores(filterTenantId);
      return sendJson(res, 200, { success: true, stores });
    }

    // Stores: POST /api/stores
    if (req.method === "POST" && url.pathname === "/api/stores") {
      const body = await parseBody(req);
      const isSuper = currentTenant.name === "Admin" || currentTenant.email === "admin@zimra-fdms.local";
      const targetTenantId = (isSuper && body.tenantId) ? body.tenantId : currentTenant.id;
      const newStore = await createStore(targetTenantId, body);
      return sendJson(res, 201, { success: true, store: newStore });
    }

    // Stores: GET /api/stores/:id
    const storeGetMatch = url.pathname.match(/^\/api\/stores\/([^\/]+)$/);
    if (req.method === "GET" && (storeGetMatch || (url.pathname === "/api/stores" && url.searchParams.has("id")))) {
      const targetStoreId = storeGetMatch ? storeGetMatch[1] : url.searchParams.get("id")!;
      const store = await getStoreById(targetStoreId);
      if (!store) return sendJson(res, 404, { error: "Store not found" });
      return sendJson(res, 200, { success: true, store });
    }

    // Stores: PUT /api/stores/:id or POST /api/stores/update
    const storePutMatch = url.pathname.match(/^\/api\/stores\/([^\/]+)$/);
    if ((req.method === "PUT" || req.method === "POST") && (storePutMatch || url.pathname === "/api/stores/update")) {
      const body = await parseBody(req);
      const targetStoreId = storePutMatch ? storePutMatch[1] : (body.id || body.storeId || url.searchParams.get("id"));
      if (!targetStoreId) return sendJson(res, 400, { error: "Store ID is required" });
      const updated = await updateStore(targetStoreId, body);
      if (!updated) return sendJson(res, 404, { error: "Store not found" });
      return sendJson(res, 200, { success: true, store: updated });
    }

    // Stores: DELETE /api/stores/:id or DELETE /api/stores?id=...
    const storeDelMatch = url.pathname.match(/^\/api\/stores\/([^\/]+)$/);
    if (req.method === "DELETE" && (storeDelMatch || (url.pathname === "/api/stores" && url.searchParams.has("id")))) {
      const delStoreId = storeDelMatch ? storeDelMatch[1] : url.searchParams.get("id")!;
      const success = await deleteStore(delStoreId);
      return sendJson(res, 200, { success });
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
            try {
              const savedState = await loadDayStateDb(c.id, devId);
              if (savedState) {
                (savedState as any).closeError = err.message;
                (savedState as any).closeFailedAt = new Date().toISOString();
                await saveDayStateDb(c.id, devId, savedState);
              }
            } catch {}
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
      try {
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
      } catch (err: any) {
        try {
          const st = (await loadDayStateDb(targetTenantId, deviceRecord.device_id)) || {};
          st.closeError = err.message;
          st.closeFailedAt = new Date().toISOString();
          await saveDayStateDb(targetTenantId, deviceRecord.device_id, st);
        } catch {}
        return sendJson(res, 400, {
          error: `Failed to close fiscal day for device ${deviceRecord.serial_number}: ${err.message}`,
          hint: "Check if device has un-flushed offline receipts or receipts with validation errors."
        });
      }
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
      try {
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
      } catch (err: any) {
        try {
          const st = (await loadDayStateDb(currentTenant.id, deviceRecord.device_id)) || {};
          st.closeError = err.message;
          st.closeFailedAt = new Date().toISOString();
          await saveDayStateDb(currentTenant.id, deviceRecord.device_id, st);
        } catch {}
        return sendJson(res, 400, {
          error: `Failed to close fiscal day: ${err.message}`,
          hint: "Device day close failed. Inspect validation errors or offline queue."
        });
      }
    }

    // 12. POST /api/receipt, /api/receipts/submit, /api/receipts/fiscal-invoice, /api/receipts/credit-note, /api/receipts/debit-note, /api/receipts/advance-payment
    if (req.method === "POST" && (
      url.pathname === "/api/receipt" ||
      url.pathname === "/api/receipts/submit" ||
      url.pathname === "/api/receipts/fiscal-invoice" ||
      url.pathname === "/api/receipts/credit-note" ||
      url.pathname === "/api/receipts/debit-note" ||
      url.pathname === "/api/receipts/advance-payment"
    )) {
      const body = await parseBody(req);
      if (url.pathname === "/api/receipts/credit-note") {
        body.receiptType = "CreditNote";
      } else if (url.pathname === "/api/receipts/debit-note") {
        body.receiptType = "DebitNote";
      } else if (url.pathname === "/api/receipts/fiscal-invoice") {
        body.receiptType = "FiscalInvoice";
      } else if (url.pathname === "/api/receipts/advance-payment") {
        body.receiptType = "FiscalInvoice";
        if (!body.notes) body.notes = "Advance Deposit Payment";
      }

      if (body.buyerData && !body.buyer) {
        body.buyer = body.buyerData;
      }

      if ((body.receiptType === "CreditNote" || body.receiptType === "DebitNote") && !body.creditDebitNote) {
        return sendJson(res, 400, {
          error: `${body.receiptType} requires a "creditDebitNote" object referencing the original invoice ({ receiptID, deviceID, receiptGlobalNo, fiscalDayNo }).`,
          hint: "Provide the reference to the original fiscal invoice that is being reversed or adjusted."
        });
      }

      const identifier = {
        deviceId: body.deviceId ? Number(body.deviceId) : undefined,
        serialNumber: body.serialNumber ? String(body.serialNumber).trim() : undefined,
      };
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(currentTenant.id, identifier);

      await fd.reconcile();
      const status = await fd.getStatus();
      if (status.fiscalDayStatus === "FiscalDayClosed" || !fd.getState()) {
        try {
          const resOpen = await fd.openDay();
          await saveDayStateDb(currentTenant.id, deviceRecord.device_id, fd.getState()!);
          await recordFiscalDayOpenDb(currentTenant.id, deviceRecord.device_id, resOpen.fiscalDayNo, new Date().toISOString());
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
