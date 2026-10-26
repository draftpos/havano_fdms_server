import { DatabaseSync } from "node:sqlite";
import type { Pool as PgPool } from "pg";
import pgPkg from "pg";
import * as crypto from "node:crypto";
import { join } from "node:path";
import { encryptPrivateKey, decryptPrivateKey, hashApiKey } from "./crypto.js";

const Pool = (pgPkg as any).Pool || (pgPkg as any).default?.Pool || pgPkg;

export interface Tenant {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  salt: string;
  api_key_hash: string;
  api_key_prefix: string;
  created_at: string;
}

export interface StoredDevice {
  id: number;
  tenant_id: string;
  device_id: number;
  serial_number: string;
  model_name: string;
  model_version: string;
  environment: string;
  certificate_pem: string;
  private_key_pem: string; // decrypted in-memory
  is_active: number;
  created_at: string;
}

export interface StoredReceipt {
  id: number;
  tenant_id: string;
  device_id: number;
  receipt_counter: number;
  receipt_global_no: number;
  receipt_type: string;
  invoice_no: string;
  currency: string;
  total_amount: number;
  qr_data: string;
  raw_response_json: string;
  submitted_at: string;
}

const DATABASE_URL = process.env.DATABASE_URL;
let pgPool: PgPool | null = null;
let sqliteDb: DatabaseSync | null = null;

if (DATABASE_URL) {
  console.log("Using PostgreSQL database:", DATABASE_URL.replace(/:[^:@]+@/, ":****@"));
  pgPool = new Pool({ connectionString: DATABASE_URL });
} else {
  const DB_PATH = join(process.cwd(), "fdms-multi-tenant.db");
  sqliteDb = new DatabaseSync(DB_PATH);
}

// ---------------------------------------------------------------------------
// Schema Setup
// ---------------------------------------------------------------------------

export async function initDatabase() {
  if (pgPool) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt VARCHAR(64) NOT NULL,
        api_key_hash VARCHAR(128) UNIQUE NOT NULL,
        api_key_prefix VARCHAR(32) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id SERIAL PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id),
        device_id INTEGER NOT NULL,
        serial_number VARCHAR(128) NOT NULL,
        model_name VARCHAR(128) NOT NULL,
        model_version VARCHAR(64) NOT NULL,
        environment VARCHAR(32) NOT NULL,
        certificate_pem TEXT NOT NULL,
        private_key_pem TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(tenant_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS day_states (
        tenant_id VARCHAR(64) NOT NULL,
        device_id INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY(tenant_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS receipts (
        id SERIAL PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id),
        device_id INTEGER NOT NULL,
        receipt_counter INTEGER NOT NULL,
        receipt_global_no INTEGER NOT NULL,
        receipt_type VARCHAR(64) NOT NULL,
        invoice_no VARCHAR(128) NOT NULL,
        currency VARCHAR(8) NOT NULL,
        total_amount NUMERIC(15, 2) NOT NULL,
        qr_data TEXT NOT NULL,
        raw_response_json TEXT NOT NULL,
        submitted_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token VARCHAR(128) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id),
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queued_receipts (
        id SERIAL PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id),
        device_id INTEGER NOT NULL,
        receipt_json TEXT NOT NULL,
        prepared_json TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(32) DEFAULT 'pending'
      );

      CREATE TABLE IF NOT EXISTS fiscal_days (
        id SERIAL PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id),
        device_id INTEGER NOT NULL,
        fiscal_day_no INTEGER NOT NULL,
        status VARCHAR(32) NOT NULL,
        opened_at TIMESTAMPTZ NOT NULL,
        closed_at TIMESTAMPTZ,
        receipts_count INTEGER DEFAULT 0,
        total_amount NUMERIC(15, 2) DEFAULT 0,
        currency VARCHAR(8) DEFAULT 'USD',
        operation_id VARCHAR(128),
        signature TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(tenant_id, device_id, fiscal_day_no)
      );
    `);
  } else if (sqliteDb) {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        api_key_hash TEXT UNIQUE NOT NULL,
        api_key_prefix TEXT NOT NULL,
        api_key_encrypted TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        device_id INTEGER NOT NULL,
        serial_number TEXT NOT NULL,
        model_name TEXT NOT NULL,
        model_version TEXT NOT NULL,
        environment TEXT NOT NULL,
        certificate_pem TEXT NOT NULL,
        private_key_pem TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, device_id),
        FOREIGN KEY(tenant_id) REFERENCES tenants(id)
      );

      CREATE TABLE IF NOT EXISTS day_states (
        tenant_id TEXT NOT NULL,
        device_id INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        device_id INTEGER NOT NULL,
        receipt_counter INTEGER NOT NULL,
        receipt_global_no INTEGER NOT NULL,
        receipt_type TEXT NOT NULL,
        invoice_no TEXT NOT NULL,
        currency TEXT NOT NULL,
        total_amount REAL NOT NULL,
        qr_data TEXT NOT NULL,
        raw_response_json TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        FOREIGN KEY(tenant_id) REFERENCES tenants(id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY(tenant_id) REFERENCES tenants(id)
      );

      CREATE TABLE IF NOT EXISTS queued_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        device_id INTEGER NOT NULL,
        receipt_json TEXT NOT NULL,
        prepared_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        FOREIGN KEY(tenant_id) REFERENCES tenants(id)
      );

      CREATE TABLE IF NOT EXISTS fiscal_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        device_id INTEGER NOT NULL,
        fiscal_day_no INTEGER NOT NULL,
        status TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        receipts_count INTEGER DEFAULT 0,
        total_amount REAL DEFAULT 0,
        currency TEXT DEFAULT 'USD',
        operation_id TEXT,
        signature TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, device_id, fiscal_day_no),
        FOREIGN KEY(tenant_id) REFERENCES tenants(id)
      );
    `);
  }

  // Column migration for api_key_encrypted
  if (pgPool) {
    try {
      await pgPool.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT;");
    } catch {}
  } else if (sqliteDb) {
    try {
      sqliteDb.exec("ALTER TABLE tenants ADD COLUMN api_key_encrypted TEXT;");
    } catch {}
  }
}

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
}

// ---------------------------------------------------------------------------
// Tenant Operations
// ---------------------------------------------------------------------------

export async function registerTenant(
  name: string,
  email: string,
  password: string,
  explicitApiKey?: string
): Promise<{ tenant: { id: string; name: string; email: string; api_key_prefix: string; created_at: string }; apiKey: string }> {
  const normEmail = email.toLowerCase().trim();

  if (pgPool) {
    const existing = await pgPool.query("SELECT id FROM tenants WHERE email = $1", [normEmail]);
    if (existing.rows.length > 0) throw new Error("A tenant with this email address already exists.");
  } else if (sqliteDb) {
    const existing = sqliteDb.prepare("SELECT id FROM tenants WHERE email = ?").get(normEmail);
    if (existing) throw new Error("A tenant with this email address already exists.");
  }

  const id = "tnt_" + crypto.randomBytes(8).toString("hex");
  const salt = crypto.randomBytes(16).toString("hex");
  const password_hash = hashPassword(password, salt);
  const rawApiKey = explicitApiKey || ("zf_live_" + crypto.randomBytes(24).toString("hex"));
  const api_key_hash = hashApiKey(rawApiKey);
  const api_key_prefix = rawApiKey.slice(0, 12) + "...";
  const api_key_encrypted = encryptPrivateKey(rawApiKey);
  const created_at = new Date().toISOString();

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO tenants (id, name, email, password_hash, salt, api_key_hash, api_key_prefix, api_key_encrypted, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, name.trim(), normEmail, password_hash, salt, api_key_hash, api_key_prefix, api_key_encrypted, created_at]
    );
  } else if (sqliteDb) {
    sqliteDb.prepare(
      `INSERT INTO tenants (id, name, email, password_hash, salt, api_key_hash, api_key_prefix, api_key_encrypted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, name.trim(), normEmail, password_hash, salt, api_key_hash, api_key_prefix, api_key_encrypted, created_at);
  }

  return {
    tenant: { id, name: name.trim(), email: normEmail, api_key_prefix, created_at },
    apiKey: rawApiKey,
  };
}

export async function setTenantApiKey(email: string, rawApiKey: string) {
  const normEmail = (email.includes("@") ? email : email + "@zimra-fdms.local").toLowerCase().trim();
  const api_key_hash = hashApiKey(rawApiKey);
  const api_key_prefix = rawApiKey.slice(0, 12) + "...";
  const api_key_encrypted = encryptPrivateKey(rawApiKey);
  if (pgPool) {
    await pgPool.query("UPDATE tenants SET api_key_hash = $1, api_key_prefix = $2, api_key_encrypted = $3 WHERE email = $4", [api_key_hash, api_key_prefix, api_key_encrypted, normEmail]);
  } else if (sqliteDb) {
    sqliteDb.prepare("UPDATE tenants SET api_key_hash = ?, api_key_prefix = ?, api_key_encrypted = ? WHERE email = ?").run(api_key_hash, api_key_prefix, api_key_encrypted, normEmail);
  }
}

export async function updateTenantPassword(email: string, newPassword: string) {
  const normEmail = (email.includes("@") ? email : email + "@zimra-fdms.local").toLowerCase().trim();
  const salt = crypto.randomBytes(16).toString("hex");
  const password_hash = hashPassword(newPassword, salt);
  if (pgPool) {
    await pgPool.query("UPDATE tenants SET password_hash = $1, salt = $2 WHERE email = $3", [password_hash, salt, normEmail]);
  } else if (sqliteDb) {
    sqliteDb.prepare("UPDATE tenants SET password_hash = ?, salt = ? WHERE email = ?").run(password_hash, salt, normEmail);
  }
}

export async function regenerateApiKey(tenantId: string): Promise<string> {
  const rawApiKey = "zf_live_" + crypto.randomBytes(24).toString("hex");
  const api_key_hash = hashApiKey(rawApiKey);
  const api_key_prefix = rawApiKey.slice(0, 12) + "...";
  const api_key_encrypted = encryptPrivateKey(rawApiKey);

  if (pgPool) {
    await pgPool.query("UPDATE tenants SET api_key_hash = $1, api_key_prefix = $2, api_key_encrypted = $3 WHERE id = $4", [api_key_hash, api_key_prefix, api_key_encrypted, tenantId]);
  } else if (sqliteDb) {
    sqliteDb.prepare("UPDATE tenants SET api_key_hash = ?, api_key_prefix = ?, api_key_encrypted = ? WHERE id = ?").run(api_key_hash, api_key_prefix, api_key_encrypted, tenantId);
  }
  return rawApiKey;
}

export interface TenantSummary {
  id: string;
  name: string;
  email: string;
  apiKey: string;
  apiKeyPrefix: string;
  createdAt: string;
  devices: Array<{
    deviceId: number;
    serialNumber: string;
    modelName: string;
    environment: string;
    isActive: boolean;
    certificatePem: string;
    createdAt: string;
  }>;
  receiptCount: number;
  queueCount: number;
}

export async function listAllTenantsWithDetails(): Promise<TenantSummary[]> {
  if (pgPool) {
    const tenantsRes = await pgPool.query("SELECT * FROM tenants ORDER BY created_at ASC");
    const devicesRes = await pgPool.query("SELECT id, tenant_id, device_id, serial_number, model_name, environment, certificate_pem, is_active, created_at FROM devices");
    const receiptsRes = await pgPool.query("SELECT tenant_id, COUNT(*) as cnt FROM receipts GROUP BY tenant_id");
    const queuesRes = await pgPool.query("SELECT tenant_id, COUNT(*) as cnt FROM queued_receipts WHERE status = 'pending' GROUP BY tenant_id");

    const receiptMap = new Map<string, number>();
    for (const r of receiptsRes.rows) receiptMap.set(r.tenant_id, Number(r.cnt));

    const queueMap = new Map<string, number>();
    for (const q of queuesRes.rows) queueMap.set(q.tenant_id, Number(q.cnt));

    const deviceMap = new Map<string, any[]>();
    for (const d of devicesRes.rows) {
      if (!deviceMap.has(d.tenant_id)) deviceMap.set(d.tenant_id, []);
      deviceMap.get(d.tenant_id)!.push({
        deviceId: d.device_id,
        serialNumber: d.serial_number,
        modelName: d.model_name,
        environment: d.environment,
        isActive: Boolean(d.is_active),
        certificatePem: d.certificate_pem,
        createdAt: d.created_at,
      });
    }

    return tenantsRes.rows.map((t: any) => {
      let rawKey = t.api_key_prefix;
      if (t.api_key_encrypted) {
        try {
          rawKey = decryptPrivateKey(t.api_key_encrypted);
        } catch {}
      }
      return {
        id: t.id,
        name: t.name,
        email: t.email,
        apiKey: rawKey,
        apiKeyPrefix: t.api_key_prefix,
        createdAt: t.created_at,
        devices: deviceMap.get(t.id) || [],
        receiptCount: receiptMap.get(t.id) || 0,
        queueCount: queueMap.get(t.id) || 0,
      };
    });
  } else if (sqliteDb) {
    const tenants = sqliteDb.prepare("SELECT * FROM tenants ORDER BY created_at ASC").all() as any[];
    const devices = sqliteDb.prepare("SELECT id, tenant_id, device_id, serial_number, model_name, environment, certificate_pem, is_active, created_at FROM devices").all() as any[];
    const receipts = sqliteDb.prepare("SELECT tenant_id, COUNT(*) as cnt FROM receipts GROUP BY tenant_id").all() as any[];
    const queues = sqliteDb.prepare("SELECT tenant_id, COUNT(*) as cnt FROM queued_receipts WHERE status = 'pending' GROUP BY tenant_id").all() as any[];

    const receiptMap = new Map<string, number>();
    for (const r of receipts) receiptMap.set(r.tenant_id, Number(r.cnt));

    const queueMap = new Map<string, number>();
    for (const q of queues) queueMap.set(q.tenant_id, Number(q.cnt));

    const deviceMap = new Map<string, any[]>();
    for (const d of devices) {
      if (!deviceMap.has(d.tenant_id)) deviceMap.set(d.tenant_id, []);
      deviceMap.get(d.tenant_id)!.push({
        deviceId: d.device_id,
        serialNumber: d.serial_number,
        modelName: d.model_name,
        environment: d.environment,
        isActive: Boolean(d.is_active),
        certificatePem: d.certificate_pem,
        createdAt: d.created_at,
      });
    }

    return tenants.map((t: any) => {
      let rawKey = t.api_key_prefix;
      if (t.api_key_encrypted) {
        try {
          rawKey = decryptPrivateKey(t.api_key_encrypted);
        } catch {}
      }
      return {
        id: t.id,
        name: t.name,
        email: t.email,
        apiKey: rawKey,
        apiKeyPrefix: t.api_key_prefix,
        createdAt: t.created_at,
        devices: deviceMap.get(t.id) || [],
        receiptCount: receiptMap.get(t.id) || 0,
        queueCount: queueMap.get(t.id) || 0,
      };
    });
  }
  return [];
}

export async function deleteTenantCascade(tenantId: string): Promise<void> {
  if (pgPool) {
    await pgPool.query("DELETE FROM day_states WHERE tenant_id = $1", [tenantId]);
    await pgPool.query("DELETE FROM queued_receipts WHERE tenant_id = $1", [tenantId]);
    await pgPool.query("DELETE FROM receipts WHERE tenant_id = $1", [tenantId]);
    await pgPool.query("DELETE FROM devices WHERE tenant_id = $1", [tenantId]);
    await pgPool.query("DELETE FROM sessions WHERE tenant_id = $1", [tenantId]);
    await pgPool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  } else if (sqliteDb) {
    sqliteDb.prepare("DELETE FROM day_states WHERE tenant_id = ?").run(tenantId);
    sqliteDb.prepare("DELETE FROM queued_receipts WHERE tenant_id = ?").run(tenantId);
    sqliteDb.prepare("DELETE FROM receipts WHERE tenant_id = ?").run(tenantId);
    sqliteDb.prepare("DELETE FROM devices WHERE tenant_id = ?").run(tenantId);
    sqliteDb.prepare("DELETE FROM sessions WHERE tenant_id = ?").run(tenantId);
    sqliteDb.prepare("DELETE FROM tenants WHERE id = ?").run(tenantId);
  }
}

export async function createSessionForTenant(tenantId: string): Promise<string> {
  const sessionToken = "sess_" + crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO sessions (token, tenant_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
      [sessionToken, tenantId, now.toISOString(), expires]
    );
  } else if (sqliteDb) {
    sqliteDb.prepare(
      `INSERT INTO sessions (token, tenant_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
    ).run(sessionToken, tenantId, now.toISOString(), expires);
  }
  return sessionToken;
}

export async function loginTenant(
  email: string,
  password: string
): Promise<{ tenant: { id: string; name: string; email: string; api_key_prefix: string }; sessionToken: string; apiKeyPrefix: string }> {
  const normEmail = (email.includes("@") ? email : email + "@zimra-fdms.local").toLowerCase().trim();
  let row: Tenant | null = null;

  if (pgPool) {
    const res = await pgPool.query("SELECT * FROM tenants WHERE email = $1", [normEmail]);
    row = res.rows[0] || null;
  } else if (sqliteDb) {
    row = (sqliteDb.prepare("SELECT * FROM tenants WHERE email = ?").get(normEmail) as unknown as Tenant) || null;
  }

  if (!row) throw new Error("Invalid email or password.");

  const computed = hashPassword(password, row.salt);
  if (computed !== row.password_hash) throw new Error("Invalid email or password.");

  const sessionToken = await createSessionForTenant(row.id);
  return {
    tenant: { id: row.id, name: row.name, email: row.email, api_key_prefix: row.api_key_prefix },
    sessionToken,
    apiKeyPrefix: row.api_key_prefix,
  };
}

export async function authenticateSession(token: string): Promise<{ id: string; name: string; email: string; api_key_prefix: string } | null> {
  const now = new Date().toISOString();
  if (pgPool) {
    const res = await pgPool.query(
      `SELECT t.id, t.name, t.email, t.api_key_prefix FROM sessions s
       JOIN tenants t ON s.tenant_id = t.id
       WHERE s.token = $1 AND s.expires_at > $2`,
      [token, now]
    );
    return res.rows[0] || null;
  } else if (sqliteDb) {
    const row = sqliteDb.prepare(
      `SELECT t.id, t.name, t.email, t.api_key_prefix FROM sessions s
       JOIN tenants t ON s.tenant_id = t.id
       WHERE s.token = ? AND s.expires_at > ?`
    ).get(token, now) as { id: string; name: string; email: string; api_key_prefix: string } | undefined;
    return row || null;
  }
  return null;
}

export async function authenticateApiKey(rawApiKey: string): Promise<{ id: string; name: string; email: string; api_key_prefix: string } | null> {
  const hash = hashApiKey(rawApiKey);

  if (pgPool) {
    const res = await pgPool.query(
      "SELECT id, name, email, api_key_prefix FROM tenants WHERE api_key_hash = $1",
      [hash]
    );
    return res.rows[0] || null;
  } else if (sqliteDb) {
    const row = sqliteDb.prepare(
      "SELECT id, name, email, api_key_prefix FROM tenants WHERE api_key_hash = ?"
    ).get(hash) as { id: string; name: string; email: string; api_key_prefix: string } | undefined;
    return row || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Device Operations (with AES-256-GCM Private Key Encryption & Serial Lookup)
// ---------------------------------------------------------------------------

export async function saveTenantDevice(
  tenantId: string,
  device: {
    deviceId: number;
    serialNumber: string;
    modelName: string;
    modelVersion: string;
    environment: string;
    certificatePem: string;
    privateKeyPem: string;
  }
) {
  // Encrypt the sensitive private key with AES-256-GCM before writing to database
  const encryptedKey = encryptPrivateKey(device.privateKeyPem);
  const now = new Date().toISOString();

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO devices (tenant_id, device_id, serial_number, model_name, model_version, environment, certificate_pem, private_key_pem, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)
       ON CONFLICT(tenant_id, device_id) DO UPDATE SET
         certificate_pem = EXCLUDED.certificate_pem,
         private_key_pem = EXCLUDED.private_key_pem,
         serial_number = EXCLUDED.serial_number,
         environment = EXCLUDED.environment,
         created_at = EXCLUDED.created_at`,
      [
        tenantId,
        device.deviceId,
        device.serialNumber,
        device.modelName,
        device.modelVersion,
        device.environment,
        device.certificatePem,
        encryptedKey,
        now,
      ]
    );
  } else if (sqliteDb) {
    sqliteDb.prepare(
      `INSERT INTO devices (tenant_id, device_id, serial_number, model_name, model_version, environment, certificate_pem, private_key_pem, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(tenant_id, device_id) DO UPDATE SET
         certificate_pem = excluded.certificate_pem,
         private_key_pem = excluded.private_key_pem,
         serial_number = excluded.serial_number,
         environment = excluded.environment,
         created_at = excluded.created_at`
    ).run(
      tenantId,
      device.deviceId,
      device.serialNumber,
      device.modelName,
      device.modelVersion,
      device.environment,
      device.certificatePem,
      encryptedKey,
      now
    );
  }
}

/**
 * Look up a device by Device ID OR by Device Serial Number.
 * Decrypts the private key using AES-256-GCM on-the-fly.
 */
export async function getTenantDevice(
  tenantId: string,
  identifier?: { deviceId?: number; serialNumber?: string }
): Promise<StoredDevice | null> {
  let row: any = null;

  if (identifier?.serialNumber) {
    const s = identifier.serialNumber.trim();
    if (pgPool) {
      const res = await pgPool.query("SELECT * FROM devices WHERE tenant_id = $1 AND serial_number = $2", [tenantId, s]);
      row = res.rows[0];
    } else if (sqliteDb) {
      row = sqliteDb.prepare("SELECT * FROM devices WHERE tenant_id = ? AND serial_number = ?").get(tenantId, s);
    }
  } else if (identifier?.deviceId) {
    const id = identifier.deviceId;
    if (pgPool) {
      const res = await pgPool.query("SELECT * FROM devices WHERE tenant_id = $1 AND device_id = $2", [tenantId, id]);
      row = res.rows[0];
    } else if (sqliteDb) {
      row = sqliteDb.prepare("SELECT * FROM devices WHERE tenant_id = ? AND device_id = ?").get(tenantId, id);
    }
  } else {
    // Default to the tenant's most recent active device
    if (pgPool) {
      const res = await pgPool.query("SELECT * FROM devices WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1", [tenantId]);
      row = res.rows[0];
    } else if (sqliteDb) {
      row = sqliteDb.prepare("SELECT * FROM devices WHERE tenant_id = ? ORDER BY id DESC LIMIT 1").get(tenantId);
    }
  }

  if (!row) return null;

  // Decrypt AES-256-GCM private key into memory
  return {
    ...row,
    private_key_pem: decryptPrivateKey(row.private_key_pem),
  };
}

export async function getTenantDevices(tenantId: string): Promise<Omit<StoredDevice, "private_key_pem">[]> {
  let rows: any[] = [];
  if (pgPool) {
    const res = await pgPool.query("SELECT id, tenant_id, device_id, serial_number, model_name, model_version, environment, is_active, created_at FROM devices WHERE tenant_id = $1 ORDER BY id DESC", [tenantId]);
    rows = res.rows;
  } else if (sqliteDb) {
    rows = sqliteDb.prepare("SELECT id, tenant_id, device_id, serial_number, model_name, model_version, environment, is_active, created_at FROM devices WHERE tenant_id = ? ORDER BY id DESC").all(tenantId);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Fiscal Day States
// ---------------------------------------------------------------------------

export async function saveDayStateDb(tenantId: string, deviceId: number, state: any) {
  const now = new Date().toISOString();
  const stateJson = JSON.stringify(state);

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO day_states (tenant_id, device_id, state_json, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(tenant_id, device_id) DO UPDATE SET
         state_json = EXCLUDED.state_json,
         updated_at = EXCLUDED.updated_at`,
      [tenantId, deviceId, stateJson, now]
    );
  } else if (sqliteDb) {
    sqliteDb.prepare(
      `INSERT INTO day_states (tenant_id, device_id, state_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, device_id) DO UPDATE SET
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`
    ).run(tenantId, deviceId, stateJson, now);
  }
}

export async function loadDayStateDb(tenantId: string, deviceId: number): Promise<any | null> {
  let stateJson: string | null = null;
  if (pgPool) {
    const res = await pgPool.query("SELECT state_json FROM day_states WHERE tenant_id = $1 AND device_id = $2", [tenantId, deviceId]);
    stateJson = res.rows[0]?.state_json || null;
  } else if (sqliteDb) {
    const row = sqliteDb.prepare("SELECT state_json FROM day_states WHERE tenant_id = ? AND device_id = ?").get(tenantId, deviceId) as { state_json: string } | undefined;
    stateJson = row?.state_json || null;
  }

  if (!stateJson) return null;
  try {
    return JSON.parse(stateJson);
  } catch {
    return null;
  }
}

export async function clearDayStateDb(tenantId: string, deviceId: number) {
  if (pgPool) {
    await pgPool.query("DELETE FROM day_states WHERE tenant_id = $1 AND device_id = $2", [tenantId, deviceId]);
  } else if (sqliteDb) {
    sqliteDb.prepare("DELETE FROM day_states WHERE tenant_id = ? AND device_id = ?").run(tenantId, deviceId);
  }
}

// ---------------------------------------------------------------------------
// Receipts Ledger
// ---------------------------------------------------------------------------

export async function recordReceiptDb(
  tenantId: string,
  deviceId: number,
  receiptCounter: number,
  receiptGlobalNo: number,
  receiptType: string,
  invoiceNo: string,
  currency: string,
  totalAmount: number,
  qrData: string,
  rawResponse: any
) {
  const now = new Date().toISOString();
  const rawJson = JSON.stringify(rawResponse);

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO receipts (tenant_id, device_id, receipt_counter, receipt_global_no, receipt_type, invoice_no, currency, total_amount, qr_data, raw_response_json, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [tenantId, deviceId, receiptCounter, receiptGlobalNo, receiptType, invoiceNo, currency, totalAmount, qrData, rawJson, now]
    );
  } else if (sqliteDb) {
    sqliteDb.prepare(
      `INSERT INTO receipts (tenant_id, device_id, receipt_counter, receipt_global_no, receipt_type, invoice_no, currency, total_amount, qr_data, raw_response_json, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(tenantId, deviceId, receiptCounter, receiptGlobalNo, receiptType, invoiceNo, currency, totalAmount, qrData, rawJson, now);
  }
}

export async function getTenantReceipts(tenantId?: string, limit = 100): Promise<(StoredReceipt & { store_name?: string })[]> {
  if (pgPool) {
    if (tenantId) {
      const res = await pgPool.query(
        `SELECT r.*, t.name as store_name FROM receipts r
         JOIN tenants t ON r.tenant_id = t.id
         WHERE r.tenant_id = $1 ORDER BY r.id DESC LIMIT $2`,
        [tenantId, limit]
      );
      return res.rows;
    } else {
      const res = await pgPool.query(
        `SELECT r.*, t.name as store_name FROM receipts r
         JOIN tenants t ON r.tenant_id = t.id
         ORDER BY r.id DESC LIMIT $1`,
        [limit]
      );
      return res.rows;
    }
  } else if (sqliteDb) {
    if (tenantId) {
      return sqliteDb.prepare(
        `SELECT r.*, t.name as store_name FROM receipts r
         JOIN tenants t ON r.tenant_id = t.id
         WHERE r.tenant_id = ? ORDER BY r.id DESC LIMIT ?`
      ).all(tenantId, limit) as unknown as (StoredReceipt & { store_name?: string })[];
    } else {
      return sqliteDb.prepare(
        `SELECT r.*, t.name as store_name FROM receipts r
         JOIN tenants t ON r.tenant_id = t.id
         ORDER BY r.id DESC LIMIT ?`
      ).all(limit) as unknown as (StoredReceipt & { store_name?: string })[];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Offline Receipts Queue
// ---------------------------------------------------------------------------

export async function enqueueOfflineReceipt(
  tenantId: string,
  deviceId: number,
  receiptJson: any,
  preparedJson: any
): Promise<number> {
  const now = new Date().toISOString();
  const rJson = JSON.stringify(receiptJson);
  const pJson = JSON.stringify(preparedJson);

  if (pgPool) {
    const res = await pgPool.query(
      `INSERT INTO queued_receipts (tenant_id, device_id, receipt_json, prepared_json, created_at, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
      [tenantId, deviceId, rJson, pJson, now]
    );
    return res.rows[0].id;
  } else if (sqliteDb) {
    const res = sqliteDb.prepare(
      `INSERT INTO queued_receipts (tenant_id, device_id, receipt_json, prepared_json, created_at, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(tenantId, deviceId, rJson, pJson, now);
    return Number(res.lastInsertRowid);
  }
  return 0;
}

export async function getQueuedReceipts(tenantId: string, deviceId?: number): Promise<any[]> {
  if (pgPool) {
    const query = deviceId
      ? "SELECT * FROM queued_receipts WHERE tenant_id = $1 AND device_id = $2 AND status = 'pending' ORDER BY id ASC"
      : "SELECT * FROM queued_receipts WHERE tenant_id = $1 AND status = 'pending' ORDER BY id ASC";
    const params = deviceId ? [tenantId, deviceId] : [tenantId];
    const res = await pgPool.query(query, params);
    return res.rows;
  } else if (sqliteDb) {
    const query = deviceId
      ? "SELECT * FROM queued_receipts WHERE tenant_id = ? AND device_id = ? AND status = 'pending' ORDER BY id ASC"
      : "SELECT * FROM queued_receipts WHERE tenant_id = ? AND status = 'pending' ORDER BY id ASC";
    const params = deviceId ? [tenantId, deviceId] : [tenantId];
    return sqliteDb.prepare(query).all(...params);
  }
  return [];
}

export async function markQueuedReceiptSubmitted(id: number) {
  if (pgPool) {
    await pgPool.query("UPDATE queued_receipts SET status = 'submitted' WHERE id = $1", [id]);
  } else if (sqliteDb) {
    sqliteDb.prepare("UPDATE queued_receipts SET status = 'submitted' WHERE id = ?").run(id);
  }
}

export async function getQueuedCount(tenantId: string, deviceId?: number): Promise<number> {
  if (pgPool) {
    const query = deviceId
      ? "SELECT COUNT(*) as c FROM queued_receipts WHERE tenant_id = $1 AND device_id = $2 AND status = 'pending'"
      : "SELECT COUNT(*) as c FROM queued_receipts WHERE tenant_id = $1 AND status = 'pending'";
    const params = deviceId ? [tenantId, deviceId] : [tenantId];
    const res = await pgPool.query(query, params);
    return Number(res.rows[0]?.c || 0);
  } else if (sqliteDb) {
    const query = deviceId
      ? "SELECT COUNT(*) as c FROM queued_receipts WHERE tenant_id = ? AND device_id = ? AND status = 'pending'"
      : "SELECT COUNT(*) as c FROM queued_receipts WHERE tenant_id = ? AND status = 'pending'";
    const params = deviceId ? [tenantId, deviceId] : [tenantId];
    const row = sqliteDb.prepare(query).get(...params) as { c: number } | undefined;
    return Number(row?.c || 0);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Fiscal Days History
// ---------------------------------------------------------------------------

export interface FiscalDayRecord {
  id: string | number;
  tenantId: string;
  storeName: string;
  deviceId: number;
  serialNumber: string;
  fiscalDayNo: number;
  status: 'Open' | 'Closed';
  openedAt: string;
  closedAt: string | null;
  receiptsCount: number;
  totalAmount: number;
  currency: string;
  operationId?: string | null;
  signature?: string | null;
  isToday: boolean;
}

export async function recordFiscalDayOpenDb(
  tenantId: string,
  deviceId: number,
  fiscalDayNo: number,
  openedAt?: string
) {
  const now = openedAt || new Date().toISOString();
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO fiscal_days (tenant_id, device_id, fiscal_day_no, status, opened_at, closed_at, created_at)
       VALUES ($1, $2, $3, 'Open', $4, NULL, $4)
       ON CONFLICT (tenant_id, device_id, fiscal_day_no) DO UPDATE SET
         status = 'Open',
         opened_at = EXCLUDED.opened_at,
         closed_at = NULL`,
      [tenantId, deviceId, fiscalDayNo, now]
    );
  } else if (sqliteDb) {
    sqliteDb.prepare(
      `INSERT INTO fiscal_days (tenant_id, device_id, fiscal_day_no, status, opened_at, closed_at, created_at)
       VALUES (?, ?, ?, 'Open', ?, NULL, ?)
       ON CONFLICT (tenant_id, device_id, fiscal_day_no) DO UPDATE SET
         status = 'Open',
         opened_at = excluded.opened_at,
         closed_at = NULL`
    ).run(tenantId, deviceId, fiscalDayNo, now, now);
  }
}

export async function recordFiscalDayCloseDb(
  tenantId: string,
  deviceId: number,
  fiscalDayNo: number,
  closedAt?: string,
  operationId?: string,
  signature?: string,
  receiptsCount?: number,
  totalAmount?: number,
  currency?: string
) {
  const now = closedAt || new Date().toISOString();
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO fiscal_days (tenant_id, device_id, fiscal_day_no, status, opened_at, closed_at, operation_id, signature, receipts_count, total_amount, currency, created_at)
       VALUES ($1, $2, $3, 'Closed', $4, $4, $5, $6, $7, $8, $9, $4)
       ON CONFLICT (tenant_id, device_id, fiscal_day_no) DO UPDATE SET
         status = 'Closed',
         closed_at = EXCLUDED.closed_at,
         operation_id = COALESCE(EXCLUDED.operation_id, fiscal_days.operation_id),
         signature = COALESCE(EXCLUDED.signature, fiscal_days.signature),
         receipts_count = COALESCE(EXCLUDED.receipts_count, fiscal_days.receipts_count),
         total_amount = COALESCE(EXCLUDED.total_amount, fiscal_days.total_amount),
         currency = COALESCE(EXCLUDED.currency, fiscal_days.currency)`,
      [tenantId, deviceId, fiscalDayNo, now, operationId || null, signature || null, receiptsCount || 0, totalAmount || 0, currency || 'USD']
    );
  } else if (sqliteDb) {
    sqliteDb.prepare(
      `INSERT INTO fiscal_days (tenant_id, device_id, fiscal_day_no, status, opened_at, closed_at, operation_id, signature, receipts_count, total_amount, currency, created_at)
       VALUES (?, ?, ?, 'Closed', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, device_id, fiscal_day_no) DO UPDATE SET
         status = 'Closed',
         closed_at = excluded.closed_at,
         operation_id = COALESCE(excluded.operation_id, fiscal_days.operation_id),
         signature = COALESCE(excluded.signature, fiscal_days.signature),
         receipts_count = COALESCE(excluded.receipts_count, fiscal_days.receipts_count),
         total_amount = COALESCE(excluded.total_amount, fiscal_days.total_amount),
         currency = COALESCE(excluded.currency, fiscal_days.currency)`
    ).run(tenantId, deviceId, fiscalDayNo, now, now, operationId || null, signature || null, receiptsCount || 0, totalAmount || 0, currency || 'USD', now);
  }
}

export async function listAllFiscalDaysFromDb(targetTenantId?: string): Promise<FiscalDayRecord[]> {
  let historical: any[] = [];
  if (pgPool) {
    const q = targetTenantId
      ? `SELECT fd.*, t.name as store_name, d.serial_number FROM fiscal_days fd
         JOIN tenants t ON fd.tenant_id = t.id
         JOIN devices d ON fd.tenant_id = d.tenant_id AND fd.device_id = d.device_id
         WHERE fd.tenant_id = $1 ORDER BY fd.id DESC`
      : `SELECT fd.*, t.name as store_name, d.serial_number FROM fiscal_days fd
         JOIN tenants t ON fd.tenant_id = t.id
         JOIN devices d ON fd.tenant_id = d.tenant_id AND fd.device_id = d.device_id
         ORDER BY fd.id DESC`;
    const res = await pgPool.query(q, targetTenantId ? [targetTenantId] : []);
    historical = res.rows;
  } else if (sqliteDb) {
    const q = targetTenantId
      ? `SELECT fd.*, t.name as store_name, d.serial_number FROM fiscal_days fd
         JOIN tenants t ON fd.tenant_id = t.id
         JOIN devices d ON fd.tenant_id = d.tenant_id AND fd.device_id = d.device_id
         WHERE fd.tenant_id = ? ORDER BY fd.id DESC`
      : `SELECT fd.*, t.name as store_name, d.serial_number FROM fiscal_days fd
         JOIN tenants t ON fd.tenant_id = t.id
         JOIN devices d ON fd.tenant_id = d.tenant_id AND fd.device_id = d.device_id
         ORDER BY fd.id DESC`;
    historical = sqliteDb.prepare(q).all(...(targetTenantId ? [targetTenantId] : []));
  }

  let activeStates: any[] = [];
  if (pgPool) {
    const q = targetTenantId
      ? `SELECT ds.*, t.name as store_name, d.tenant_id as dev_tenant_id, d.device_id as dev_device_id, d.serial_number, d.created_at as dev_created FROM devices d
         JOIN tenants t ON d.tenant_id = t.id
         LEFT JOIN day_states ds ON d.tenant_id = ds.tenant_id AND d.device_id = ds.device_id
         WHERE d.tenant_id = $1`
      : `SELECT ds.*, t.name as store_name, d.tenant_id as dev_tenant_id, d.device_id as dev_device_id, d.serial_number, d.created_at as dev_created FROM devices d
         JOIN tenants t ON d.tenant_id = t.id
         LEFT JOIN day_states ds ON d.tenant_id = ds.tenant_id AND d.device_id = ds.device_id`;
    const res = await pgPool.query(q, targetTenantId ? [targetTenantId] : []);
    activeStates = res.rows;
  } else if (sqliteDb) {
    const q = targetTenantId
      ? `SELECT ds.state_json, ds.updated_at, t.name as store_name, d.tenant_id as dev_tenant_id, d.device_id as dev_device_id, d.serial_number, d.created_at as dev_created FROM devices d
         JOIN tenants t ON d.tenant_id = t.id
         LEFT JOIN day_states ds ON d.tenant_id = ds.tenant_id AND d.device_id = ds.device_id
         WHERE d.tenant_id = ?`
      : `SELECT ds.state_json, ds.updated_at, t.name as store_name, d.tenant_id as dev_tenant_id, d.device_id as dev_device_id, d.serial_number, d.created_at as dev_created FROM devices d
         JOIN tenants t ON d.tenant_id = t.id
         LEFT JOIN day_states ds ON d.tenant_id = ds.tenant_id AND d.device_id = ds.device_id`;
    activeStates = sqliteDb.prepare(q).all(...(targetTenantId ? [targetTenantId] : []));
  }

  const results: FiscalDayRecord[] = [];
  const handledKey = new Set<string>();

  for (const s of activeStates) {
    const tId = s.tenant_id || s.dev_tenant_id;
    const dId = Number(s.device_id || s.dev_device_id);
    let stateObj: any = null;
    if (s.state_json) {
      try { stateObj = JSON.parse(s.state_json); } catch {}
    }

    if (stateObj && stateObj.status !== 'FiscalDayClosed') {
      const dayNo = stateObj.fiscalDayNo || 1;
      const key = `${tId}_${dId}_${dayNo}`;
      handledKey.add(key);
      const isToday = stateObj.fiscalDayDate === new Date().toISOString().slice(0, 10);
      let totalAmount = 0;
      let currency = 'USD';
      if (Array.isArray(stateObj.counters)) {
        for (const c of stateObj.counters) {
          if (c.fiscalCounterType === 'SaleByTax') {
            totalAmount += Number(c.fiscalCounterValue || 0);
            if (c.fiscalCounterCurrency) currency = c.fiscalCounterCurrency;
          }
        }
      }
      results.push({
        id: `open_${tId}_${dId}_${dayNo}`,
        tenantId: tId,
        storeName: s.store_name,
        deviceId: dId,
        serialNumber: s.serial_number,
        fiscalDayNo: dayNo,
        status: 'Open',
        openedAt: stateObj.fiscalDayDate || s.updated_at || new Date().toISOString(),
        closedAt: null,
        receiptsCount: Number(stateObj.receiptCounter || 0),
        totalAmount,
        currency,
        isToday
      });
    } else {
      const dayNo = 1;
      const key = `${tId}_${dId}_${dayNo}`;
      if (!historical.some(h => h.tenant_id === tId && h.device_id === dId)) {
        handledKey.add(key);
        results.push({
          id: `closed_${tId}_${dId}_${dayNo}`,
          tenantId: tId,
          storeName: s.store_name,
          deviceId: dId,
          serialNumber: s.serial_number,
          fiscalDayNo: dayNo,
          status: 'Closed',
          openedAt: s.dev_created || new Date().toISOString(),
          closedAt: s.updated_at || s.dev_created || new Date().toISOString(),
          receiptsCount: 0,
          totalAmount: 0,
          currency: 'USD',
          isToday: false
        });
      }
    }
  }

  for (const h of historical) {
    const key = `${h.tenant_id}_${h.device_id}_${h.fiscal_day_no}`;
    if (!handledKey.has(key)) {
      handledKey.add(key);
      const openedDate = h.opened_at ? h.opened_at.slice(0, 10) : '';
      const isToday = openedDate === new Date().toISOString().slice(0, 10);
      results.push({
        id: `hist_${h.id}`,
        tenantId: h.tenant_id,
        storeName: h.store_name,
        deviceId: h.device_id,
        serialNumber: h.serial_number,
        fiscalDayNo: h.fiscal_day_no,
        status: h.status,
        openedAt: h.opened_at,
        closedAt: h.closed_at,
        receiptsCount: Number(h.receipts_count || 0),
        totalAmount: Number(h.total_amount || 0),
        currency: h.currency || 'USD',
        operationId: h.operation_id,
        signature: h.signature,
        isToday
      });
    }
  }

  return results;
}

