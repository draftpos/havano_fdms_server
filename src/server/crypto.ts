import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY_FILE = join(process.cwd(), ".master.key");

let cachedMasterKey: Buffer | null = null;

export function getMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;

  // 1. Check environment variable
  if (process.env.MASTER_KEY) {
    const raw = process.env.MASTER_KEY.trim();
    if (raw.length === 64) {
      cachedMasterKey = Buffer.from(raw, "hex");
    } else {
      cachedMasterKey = crypto.createHash("sha256").update(raw).digest();
    }
    return cachedMasterKey;
  }

  // 2. Check local persistent master key file
  if (existsSync(KEY_FILE)) {
    const raw = readFileSync(KEY_FILE, "utf-8").trim();
    cachedMasterKey = Buffer.from(raw, "hex");
    return cachedMasterKey;
  }

  // 3. Auto-generate secure 256-bit key for local development
  const newKey = crypto.randomBytes(32);
  writeFileSync(KEY_FILE, newKey.toString("hex"), { mode: 0o600 });
  cachedMasterKey = newKey;
  return cachedMasterKey;
}

/**
 * Encrypts sensitive device private keys with AES-256-GCM.
 * Output format: enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
 */
export function encryptPrivateKey(pem: string): string {
  const masterKey = getMasterKey();
  const iv = crypto.randomBytes(12); // Standard 96-bit IV for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);

  let ciphertext = cipher.update(pem, "utf-8", "hex");
  ciphertext += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return `enc:v1:${iv.toString("hex")}:${tag}:${ciphertext}`;
}

/**
 * Decrypts AES-256-GCM encrypted private keys.
 * Handles legacy plaintext PEMs transparently during migration.
 */
export function decryptPrivateKey(encrypted: string): string {
  if (!encrypted.startsWith("enc:v1:")) {
    // If not encrypted (legacy data), return as-is
    return encrypted;
  }

  const parts = encrypted.split(":");
  if (parts.length !== 5) {
    throw new Error("Corrupted encrypted private key format");
  }

  const [, , ivHex, tagHex, cipherHex] = parts;
  const masterKey = getMasterKey();
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(cipherHex, "hex", "utf-8");
  decrypted += decipher.final("utf-8");
  return decrypted;
}

/**
 * Computes a secure SHA-256 hash of an API key for safe database storage.
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey.trim()).digest("hex");
}
