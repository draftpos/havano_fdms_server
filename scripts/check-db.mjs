import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("fdms-multi-tenant.db");
console.log("Tables:", db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all());
console.log("Tenants:", db.prepare("SELECT id, name, email FROM tenants").all());
console.log("Devices:", db.prepare("SELECT id, tenant_id, device_id, serial_number, environment FROM devices").all());
console.log("Day States:", db.prepare("SELECT * FROM day_states").all());
console.log("Receipts count:", db.prepare("SELECT COUNT(*) as c FROM receipts").all());
