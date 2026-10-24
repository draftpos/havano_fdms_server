import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import crypto from "node:crypto";
import { join } from "node:path";
import { encryptPrivateKey, decryptPrivateKey, hashApiKey } from "./crypto.js";

const { Pool } = pg;

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
let pgPool: pg.Pool | null = null;
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
    `);
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
  password: string
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
  const rawApiKey = "zf_live_" + crypto.randomBytes(24).toString("hex");
  const api_key_hash = hashApiKey(rawApiKey);
  const api_key_prefix = rawApiKey.slice(0, 12) + "...";
  const created_at = new Date().toISOString();

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO tenants (id, name, email, password_hash, salt, api_key_hash, api_key_prefix, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, name.trim(), normEmail, password_hash, salt, api_key_hash, api_key_prefix, created_at]
    );
  } else if (sqliteDb) {
    sqliteDb.prepare(
      `INSERT INTO tenants (id, name, email, password_hash, salt, api_key_hash, api_key_prefix, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, name.trim(), normEmail, password_hash, salt, api_key_hash, api_key_prefix, created_at);
  }

  return {
    tenant: { id, name: name.trim(), email: normEmail, api_key_prefix, created_at },
    apiKey: rawApiKey,
  };
}

export async function loginTenant(
  email: string,
  password: string
): Promise<{ tenant: { id: string; name: string; email: string; api_key_prefix: string }; sessionToken: string; apiKeyPrefix: string }> {
  const normEmail = email.toLowerCase().trim();
  let row: Tenant | null = null;

  if (pgPool) {
    const res = await pgPool.query("SELECT * FROM tenants WHERE email = $1", [normEmail]);
    row = res.rows[0] || null;
  } else if (sqliteDb) {
    row = (sqliteDb.prepare("SELECT * FROM tenants WHERE email = ?").get(normEmail) as Tenant) || null;
  }

  if (!row) throw new Error("Invalid email or password.");

  const computed = hashPassword(password, row.salt);
  if (computed !== row.password_hash) throw new Error("Invalid email or password.");

  const sessionToken = "sess_" + crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO sessions (token, tenant_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
      [sessionToken, row.id, now.toISOString(), expires]
    );
  } else if (sqliteDb) {
    sqliteDb.prepare(
      `INSERT INTO sessions (token, tenant_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
    ).run(sessionToken, row.id, now.toISOString(), expires);
  }

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

export async function getTenantReceipts(tenantId: string, limit = 50): Promise<StoredReceipt[]> {
  if (pgPool) {
    const res = await pgPool.query("SELECT * FROM receipts WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2", [tenantId, limit]);
    return res.rows;
  } else if (sqliteDb) {
    return sqliteDb.prepare("SELECT * FROM receipts WHERE tenant_id = ? ORDER BY id DESC LIMIT ?").all(tenantId, limit) as StoredReceipt[];
  }
  return [];
}
