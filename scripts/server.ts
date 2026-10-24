import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  initDatabase,
  registerTenant,
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
} from "../src/server/db.js";
import { registerDevice } from "../src/node/registration.js";
import { FiscalDevice } from "../src/node/device.js";
import { NodeTransport } from "../src/node/transport.js";
import { receiptInputFromJson } from "../src/core/money.js";
import { FdmsApiError } from "../src/core/types.js";
import { endpointOverrides } from "../src/node/profile.js";

const PORT = Number(process.env.PORT || 3000);

async function bootstrap() {
  await initDatabase();

  // Pre-seed default demo tenant with existing device if fresh
  try {
    const defaultTenant = await registerTenant("Demo Enterprise", "demo@zimra-fdms.local", "password123");
    if (existsSync(".zimra/device.json") && existsSync(".zimra/device-certificate.pem") && existsSync(".zimra/device-private-key.pem")) {
      const devInfo = JSON.parse(readFileSync(".zimra/device.json", "utf-8"));
      const certPem = readFileSync(".zimra/device-certificate.pem", "utf-8");
      const keyPem = readFileSync(".zimra/device-private-key.pem", "utf-8");
      await saveTenantDevice(defaultTenant.tenant.id, {
        deviceId: devInfo.deviceId,
        serialNumber: devInfo.serialNumber,
        modelName: devInfo.modelName || "Server",
        modelVersion: devInfo.modelVersion || "v1",
        environment: devInfo.environment || "test",
        certificatePem: certPem,
        privateKeyPem: keyPem,
      });
      console.log("Seeded default tenant: demo@zimra-fdms.local / password123 with device", devInfo.serialNumber);
    }
  } catch {
    // Already seeded
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

const HTML_SERVER_PORTAL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZIMRA FDMS - Production Multi-Tenant Server</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #ffffff;
      --surface: #f8fafc;
      --card-bg: #ffffff;
      --border: #e2e8f0;
      --border-dark: #cbd5e1;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --primary-light: #eff6ff;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --success: #16a34a;
      --danger: #dc2626;
      --mono: 'JetBrains Mono', monospace;
      --sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text-main);
      font-family: var(--sans);
      min-height: 100vh;
      line-height: 1.5;
    }

    header {
      background: #ffffff;
      border-bottom: 1px solid var(--border);
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .brand-title {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--text-main);
      letter-spacing: -0.3px;
    }
    .brand-subtitle {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .container {
      max-width: 1200px;
      margin: 1.5rem auto;
      padding: 0 1.5rem;
    }

    .card {
      background: #ffffff;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem;
      margin-bottom: 1.25rem;
    }
    .card-title {
      font-size: 0.95rem;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 0.85rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .data-row {
      display: flex;
      justify-content: space-between;
      padding: 0.45rem 0;
      border-bottom: 1px solid #f1f5f9;
      font-size: 0.88rem;
    }
    .data-row:last-child { border-bottom: none; }
    .data-label { color: var(--text-muted); font-weight: 500; }
    .data-val { font-weight: 600; font-family: var(--mono); color: var(--text-main); }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.25rem;
      margin-bottom: 1.25rem;
    }
    @media (max-width: 860px) {
      .grid-2 { grid-template-columns: 1fr; }
    }

    .btn-group {
      display: flex;
      gap: 0.6rem;
      flex-wrap: wrap;
      margin-top: 1rem;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.55rem 1rem;
      font-size: 0.85rem;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 0.15s ease, border-color 0.15s ease;
      font-family: var(--sans);
      text-decoration: none;
    }
    .btn-blue { background: var(--primary); color: #ffffff; }
    .btn-blue:hover { background: var(--primary-hover); }
    .btn-secondary { background: #ffffff; border-color: var(--border-dark); color: var(--text-main); }
    .btn-secondary:hover { background: #f8fafc; }
    .btn-danger { background: #ffffff; border-color: #fecaca; color: var(--danger); }
    .btn-danger:hover { background: #fef2f2; }

    .template-bar {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
      margin-bottom: 0.75rem;
    }
    .template-btn {
      background: #f8fafc;
      border: 1px solid var(--border);
      padding: 0.35rem 0.7rem;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
      cursor: pointer;
    }
    .template-btn:hover { background: #f1f5f9; color: var(--text-main); }
    .template-btn.active { background: var(--primary-light); border-color: #bfdbfe; color: var(--primary); }

    .payload-area {
      width: 100%;
      height: 250px;
      padding: 0.75rem;
      background: #f8fafc;
      border: 1px solid var(--border);
      color: var(--text-main);
      border-radius: 6px;
      font-family: var(--mono);
      font-size: 0.85rem;
      line-height: 1.45;
      resize: vertical;
    }
    .payload-area:focus { outline: none; border-color: var(--primary); background: #ffffff; }

    .response-area {
      width: 100%;
      height: 250px;
      padding: 0.75rem;
      background: #f8fafc;
      border: 1px solid var(--border);
      color: var(--text-main);
      border-radius: 6px;
      font-family: var(--mono);
      font-size: 0.82rem;
      line-height: 1.45;
      overflow: auto;
      white-space: pre-wrap;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
      margin-top: 0.5rem;
    }
    th, td {
      padding: 0.65rem 0.85rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th {
      background: #f8fafc;
      color: var(--text-muted);
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .status-tag {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .tag-open { background: #dcfce7; color: #166534; }
    .tag-closed { background: #f1f5f9; color: #475569; }
    .tag-invoice { background: #dbeafe; color: #1e40af; }
    .tag-credit { background: #fee2e2; color: #991b1b; }
    .tag-debit { background: #fef3c7; color: #92400e; }

    /* Auth modal/card */
    .auth-box {
      max-width: 420px;
      margin: 4rem auto;
      background: #ffffff;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 2rem;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
    }
    .auth-box h2 {
      font-size: 1.25rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
    }
    .auth-box p {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-bottom: 1.5rem;
    }
    .form-label {
      display: block;
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--text-main);
      margin-bottom: 0.35rem;
    }
    .form-input {
      width: 100%;
      padding: 0.6rem 0.85rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 0.9rem;
      margin-bottom: 1rem;
    }
    .form-input:focus {
      outline: none;
      border-color: var(--primary);
    }

    .api-key-box {
      background: #f1f5f9;
      padding: 0.5rem 0.85rem;
      border-radius: 6px;
      font-family: var(--mono);
      font-size: 0.85rem;
      color: var(--primary);
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 0.4rem;
    }
    .sec-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1d4ed8;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.72rem;
      font-weight: 600;
    }
  </style>
</head>
<body>

  <!-- Auth Screen (Shown when logged out) -->
  <div id="auth-view" style="display: none;">
    <div class="auth-box">
      <div style="font-weight: 800; color: var(--primary); font-size: 1.4rem; margin-bottom: 0.5rem;">ZIMRA FDMS Gateway</div>
      <h2 id="auth-title">Tenant Sign In</h2>
      <p id="auth-desc">Authenticate to manage your ZIMRA devices, fiscal keys & receipts.</p>

      <div id="auth-name-group" style="display: none;">
        <label class="form-label">Company / Tenant Name</label>
        <input type="text" id="auth-name" class="form-input" placeholder="e.g. Acme Retail Ltd">
      </div>

      <label class="form-label">Email Address</label>
      <input type="email" id="auth-email" class="form-input" placeholder="name@company.com" value="demo@zimra-fdms.local">

      <label class="form-label">Password</label>
      <input type="password" id="auth-password" class="form-input" placeholder="••••••••" value="password123">

      <button class="btn btn-blue" id="auth-submit-btn" onclick="submitAuth()" style="width: 100%; padding: 0.75rem; margin-top: 0.5rem;">
        Sign In to Portal
      </button>

      <div style="text-align: center; margin-top: 1.25rem; font-size: 0.85rem;">
        <a href="#" id="auth-toggle-link" onclick="toggleAuthMode(event)" style="color: var(--primary); text-decoration: none;">
          Need a new tenant account? Register here
        </a>
      </div>
    </div>
  </div>

  <!-- Main Tenant Dashboard View -->
  <div id="app-view" style="display: none;">
    <header>
      <div>
        <div class="brand-title">ZIMRA Multi-Tenant Fiscal Gateway</div>
        <div class="brand-subtitle">
          Tenant: <strong id="header-tenant-name" style="color: var(--text-main);">Loading...</strong>
          (<span id="header-tenant-id"></span>)
          <span class="sec-badge" style="margin-left: 0.5rem;">AES-256-GCM Encrypted Keys</span>
        </div>
      </div>
      <div style="display: flex; gap: 0.75rem; align-items: center;">
        <span class="status-tag tag-open" id="header-device-badge">Active</span>
        <button class="btn btn-secondary" onclick="logout()" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;">Logout</button>
      </div>
    </header>

    <div class="container">
      <!-- Tenant API Key & Device Card -->
      <div class="card" style="border-left: 4px solid var(--primary);">
        <div class="card-title">Tenant API Integration Key</div>
        <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.5rem;">
          Authenticate external POS systems by sending your API Key in the <code>X-API-Key</code> HTTP header:
        </div>
        <div class="api-key-box">
          <span id="tenant-api-key">Loading...</span>
          <button class="btn btn-secondary" onclick="copyApiKey()" style="padding: 0.25rem 0.6rem; font-size: 0.75rem;">Copy Key</button>
        </div>
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.4rem; font-family: var(--mono);">
          Endpoint: POST http://localhost:3000/api/receipt (Supports optional <code>serialNumber: "MYPOS01"</code>)
        </div>
      </div>

      <!-- Top Row: Device Status and Taxpayer Config -->
      <div class="grid-2">
        <!-- Device & Day State -->
        <div class="card">
          <div class="card-title">
            <span>Fiscal Device & Day Status</span>
            <button class="btn btn-secondary" onclick="showRegisterDeviceModal()" style="padding: 0.2rem 0.6rem; font-size: 0.75rem;">+ Register Device</button>
          </div>
          <div class="data-row">
            <span class="data-label">Selected Device Serial</span>
            <span class="data-val" id="disp-device-serial">-</span>
          </div>
          <div class="data-row">
            <span class="data-label">Device ID</span>
            <span class="data-val" id="disp-device-id">-</span>
          </div>
          <div class="data-row">
            <span class="data-label">Target Server</span>
            <span class="data-val" id="disp-env">Simulator (Port 8443)</span>
          </div>
          <div class="data-row">
            <span class="data-label">Fiscal Day State</span>
            <span class="data-val" id="disp-day-state"><span class="status-tag tag-closed">FiscalDayClosed</span></span>
          </div>
          <div class="data-row">
            <span class="data-label">Last Receipt Global No</span>
            <span class="data-val" id="disp-last-global">-</span>
          </div>

          <div class="btn-group">
            <button class="btn btn-blue" onclick="openFiscalDay()">Open Fiscal Day</button>
            <button class="btn btn-danger" onclick="closeFiscalDay()">Close Fiscal Day</button>
            <button class="btn btn-secondary" onclick="loadAll()">Refresh</button>
          </div>
        </div>

        <!-- Taxpayer Info -->
        <div class="card">
          <div class="card-title">Tenant Taxpayer Profile</div>
          <div class="data-row">
            <span class="data-label">Taxpayer Name</span>
            <span class="data-val" id="disp-taxpayer">Simulated Taxpayer</span>
          </div>
          <div class="data-row">
            <span class="data-label">TIN Number</span>
            <span class="data-val" id="disp-tin">2000000000</span>
          </div>
          <div class="data-row">
            <span class="data-label">VAT Number</span>
            <span class="data-val" id="disp-vat">220000000</span>
          </div>
          <div class="data-row">
            <span class="data-label">Configured Taxes</span>
            <span class="data-val" id="disp-taxes">Standard 15%, Zero rated 0%, Exempt</span>
          </div>
          <div class="data-row">
            <span class="data-label">Operating Mode</span>
            <span class="data-val" id="disp-mode">Online</span>
          </div>
        </div>
      </div>

      <!-- Middle Row: Request Payload & Server Response Payload Side by Side -->
      <div class="grid-2">
        <!-- Request Payload Column -->
        <div class="card">
          <div class="card-title">Document Request Payload</div>
          
          <div class="template-bar">
            <button class="template-btn active" onclick="setTemplate('invoice_usd', this)">Fiscal Invoice (USD)</button>
            <button class="template-btn" onclick="setTemplate('credit_note', this)">Credit Note</button>
            <button class="template-btn" onclick="setTemplate('debit_note', this)">Debit Note</button>
            <button class="template-btn" onclick="setTemplate('b2b', this)">B2B Tax Invoice</button>
            <button class="template-btn" onclick="setTemplate('invoice_zig', this)">ZiG (ZWG) Sale</button>
            <button class="template-btn" onclick="setTemplate('split_payment', this)">Multi-Tender</button>
          </div>

          <textarea id="payload-input" class="payload-area" spellcheck="false">{
  "serialNumber": "MYPOS01",
  "receiptType": "FiscalInvoice",
  "currency": "USD",
  "invoiceNo": "INV-1001",
  "linesTaxInclusive": true,
  "lines": [
    {
      "name": "Consulting Services",
      "price": 115.00,
      "quantity": 1,
      "taxId": 1,
      "taxPercent": 15
    }
  ],
  "payments": [
    {
      "moneyType": "Cash",
      "amount": 115.00
    }
  ]
}</textarea>

          <div class="btn-group" style="margin-top: 0.85rem;">
            <button class="btn btn-blue" id="btn-submit" onclick="submitReceipt()">Sign & Submit Receipt</button>
            <button class="btn btn-secondary" onclick="resetTemplate()">Reset to Default</button>
          </div>
        </div>

        <!-- Response Payload Column -->
        <div class="card">
          <div class="card-title">Server Response Payload</div>
          
          <pre id="response-output" class="response-area">// Server response will appear here upon submission.</pre>

          <div id="qr-result-box" style="display: none; margin-top: 1rem; padding: 1rem; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px;">
            <div style="font-weight: 700; color: #166534; font-size: 0.85rem; margin-bottom: 0.5rem;">ZIMRA Verification QR Code & URL:</div>
            <div style="display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
              <img id="qr-code-img" src="" alt="ZIMRA QR" style="width: 120px; height: 120px; border: 1px solid #bbf7d0; background: #ffffff; padding: 4px; border-radius: 4px;">
              <div style="flex: 1; min-width: 200px;">
                <div style="font-size: 0.78rem; color: #15803d; font-weight: 600; margin-bottom: 0.25rem;">Verification URL:</div>
                <a id="qr-link" href="#" target="_blank" style="font-family: var(--mono); font-size: 0.8rem; color: var(--primary); word-break: break-all; text-decoration: underline;">-</a>
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.4rem;">
                  Official QR generated per ZIMRA SI 56 specification.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Bottom Row: Session Transactions Register -->
      <div class="card">
        <div class="card-title">Persistent Database Receipts Ledger</div>
        <table>
          <thead>
            <tr>
              <th>Receipt #</th>
              <th>Type</th>
              <th>Invoice Number</th>
              <th>Amount</th>
              <th>Submitted Time</th>
              <th>ZIMRA Verification URL</th>
            </tr>
          </thead>
          <tbody id="history-rows">
            <tr>
              <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">
                No receipts recorded in database yet for this tenant.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let isRegisterMode = false;
    let currentTenant = null;
    let activeTemplate = 'invoice_usd';
    let lastGlobalNum = 1;
    let activeSerial = "MYPOS01";

    function toggleAuthMode(e) {
      if (e) e.preventDefault();
      isRegisterMode = !isRegisterMode;
      document.getElementById('auth-title').textContent = isRegisterMode ? 'Register New Tenant' : 'Tenant Sign In';
      document.getElementById('auth-desc').textContent = isRegisterMode ? 'Create a multi-tenant workspace with your dedicated API key.' : 'Authenticate to manage your ZIMRA devices, fiscal keys & receipts.';
      document.getElementById('auth-name-group').style.display = isRegisterMode ? 'block' : 'none';
      document.getElementById('auth-submit-btn').textContent = isRegisterMode ? 'Create Tenant Account' : 'Sign In to Portal';
      document.getElementById('auth-toggle-link').textContent = isRegisterMode ? 'Already have an account? Sign in' : 'Need a new tenant account? Register here';
    }

    async function submitAuth() {
      const email = document.getElementById('auth-email').value;
      const password = document.getElementById('auth-password').value;
      const name = document.getElementById('auth-name').value;

      const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
      const payload = isRegisterMode ? { name, email, password } : { email, password };

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.error) {
          alert('Auth error: ' + data.error);
          return;
        }

        if (data.apiKey) {
          localStorage.setItem('tenant_raw_api_key', data.apiKey);
        }
        if (data.sessionToken) {
          localStorage.setItem('zimra_session', data.sessionToken);
        }
        checkSession();
      } catch (err) {
        alert('Authentication failed: ' + err.message);
      }
    }

    async function checkSession() {
      const token = localStorage.getItem('zimra_session');
      try {
        const res = await fetch('/api/me', {
          headers: token ? { 'Authorization': 'Bearer ' + token } : {}
        });
        const data = await res.json();
        if (data.tenant) {
          currentTenant = data.tenant;
          document.getElementById('auth-view').style.display = 'none';
          document.getElementById('app-view').style.display = 'block';

          document.getElementById('header-tenant-name').textContent = currentTenant.name;
          document.getElementById('header-tenant-id').textContent = currentTenant.id;
          
          const storedKey = localStorage.getItem('tenant_raw_api_key');
          document.getElementById('tenant-api-key').textContent = storedKey || (currentTenant.api_key_prefix + ' (Secured)');

          loadAll();
        } else {
          document.getElementById('auth-view').style.display = 'block';
          document.getElementById('app-view').style.display = 'none';
        }
      } catch {
        document.getElementById('auth-view').style.display = 'block';
        document.getElementById('app-view').style.display = 'none';
      }
    }

    async function logout() {
      localStorage.removeItem('zimra_session');
      localStorage.removeItem('tenant_raw_api_key');
      await fetch('/api/auth/logout', { method: 'POST' });
      checkSession();
    }

    function copyApiKey() {
      const key = document.getElementById('tenant-api-key').textContent;
      navigator.clipboard.writeText(key).then(() => alert('API Key copied to clipboard!'));
    }

    const TEMPLATES = {
      invoice_usd: {
        serialNumber: "MYPOS01",
        receiptType: "FiscalInvoice",
        currency: "USD",
        invoiceNo: "INV-" + Math.floor(Math.random() * 9000 + 1000),
        linesTaxInclusive: true,
        lines: [
          { name: "Consulting Services", price: 115.00, quantity: 1, taxId: 1, taxPercent: 15 }
        ],
        payments: [
          { moneyType: "Cash", amount: 115.00 }
        ]
      },
      credit_note: {
        serialNumber: "MYPOS01",
        receiptType: "CreditNote",
        currency: "USD",
        invoiceNo: "CN-" + Math.floor(Math.random() * 9000 + 1000),
        creditDebitNote: {
          receiptID: 1,
          deviceID: 12345,
          receiptGlobalNo: 1,
          fiscalDayNo: 1
        },
        notes: "Full return and refund for original invoice",
        linesTaxInclusive: true,
        lines: [
          { name: "Consulting Services Refund", price: 115.00, quantity: 1, taxId: 1, taxPercent: 15 }
        ],
        payments: [
          { moneyType: "Cash", amount: 115.00 }
        ]
      },
      debit_note: {
        serialNumber: "MYPOS01",
        receiptType: "DebitNote",
        currency: "USD",
        invoiceNo: "DN-" + Math.floor(Math.random() * 9000 + 1000),
        creditDebitNote: {
          receiptID: 1,
          deviceID: 12345,
          receiptGlobalNo: 1,
          fiscalDayNo: 1
        },
        notes: "Supplementary charge for out-of-scope work",
        linesTaxInclusive: true,
        lines: [
          { name: "Additional Engineering Hours", price: 40.00, quantity: 1, taxId: 1, taxPercent: 15 }
        ],
        payments: [
          { moneyType: "BankTransfer", amount: 40.00 }
        ]
      },
      b2b: {
        serialNumber: "MYPOS01",
        receiptType: "FiscalInvoice",
        currency: "USD",
        invoiceNo: "B2B-" + Math.floor(Math.random() * 9000 + 1000),
        linesTaxInclusive: true,
        buyer: {
          buyerRegisterName: "Delta Logistics Zimbabwe Ltd",
          buyerTradeName: "Delta Cargo",
          buyerTIN: "2000123456",
          vatNumber: "10023456",
          buyerContacts: { phoneNo: "+263772123456", email: "accounts@deltacargo.co.zw" },
          buyerAddress: { province: "Harare", city: "Harare", street: "Samora Machel Ave", houseNo: "45" }
        },
        lines: [
          { name: "Enterprise IT Support", price: 500.00, quantity: 1, taxId: 1, taxPercent: 15 }
        ],
        payments: [
          { moneyType: "BankTransfer", amount: 500.00 }
        ]
      },
      invoice_zig: {
        serialNumber: "MYPOS01",
        receiptType: "FiscalInvoice",
        currency: "ZWG",
        invoiceNo: "INV-ZIG-" + Math.floor(Math.random() * 9000 + 1000),
        linesTaxInclusive: true,
        lines: [
          { name: "Supermarket Groceries (15%)", price: 250.00, quantity: 1, taxId: 1, taxPercent: 15 },
          { name: "Fresh Milk (0% Exempt)", price: 45.00, quantity: 2, taxId: 2, taxPercent: 0 }
        ],
        payments: [
          { moneyType: "MobileWallet", amount: 340.00 }
        ]
      },
      split_payment: {
        serialNumber: "MYPOS01",
        receiptType: "FiscalInvoice",
        currency: "USD",
        invoiceNo: "SPLIT-" + Math.floor(Math.random() * 9000 + 1000),
        linesTaxInclusive: true,
        lines: [
          { name: "Office Hardware", price: 150.00, quantity: 1, taxId: 1, taxPercent: 15 }
        ],
        payments: [
          { moneyType: "Cash", amount: 50.00 },
          { moneyType: "MobileWallet", amount: 100.00 }
        ]
      }
    };

    function setTemplate(key, btn) {
      activeTemplate = key;
      document.querySelectorAll('.template-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');

      const tpl = JSON.parse(JSON.stringify(TEMPLATES[key]));
      tpl.serialNumber = activeSerial;
      tpl.invoiceNo = tpl.invoiceNo.replace(/\d+$/, Math.floor(Math.random() * 9000 + 1000));
      
      if (tpl.creditDebitNote && lastGlobalNum) {
        tpl.creditDebitNote.receiptGlobalNo = lastGlobalNum;
      }
      document.getElementById('payload-input').value = JSON.stringify(tpl, null, 2);
    }

    function resetTemplate() {
      setTemplate(activeTemplate);
    }

    async function loadAll() {
      await Promise.all([loadStatus(), loadConfig(), loadHistory()]);
    }

    function authHeaders() {
      const token = localStorage.getItem('zimra_session');
      return token ? { 'Authorization': 'Bearer ' + token } : {};
    }

    async function loadStatus() {
      try {
        const res = await fetch('/api/status', { headers: authHeaders() });
        const data = await res.json();
        if (data.error) {
          document.getElementById('disp-device-serial').textContent = 'No Device Assigned';
          return;
        }

        activeSerial = data.device.serialNumber;
        document.getElementById('disp-device-serial').textContent = data.device.serialNumber;
        document.getElementById('disp-device-id').textContent = data.device.deviceId;
        document.getElementById('disp-env').textContent = data.device.environment + ' (' + (data.baseUrl || 'Simulator') + ')';

        const isClosed = data.status.fiscalDayStatus === 'FiscalDayClosed';
        const tag = isClosed ? '<span class="status-tag tag-closed">FiscalDayClosed</span>' : '<span class="status-tag tag-open">FiscalDayOpened</span>';
        document.getElementById('disp-day-state').innerHTML = tag;

        lastGlobalNum = data.status.lastReceiptGlobalNo || 1;
        document.getElementById('disp-last-global').textContent = lastGlobalNum;
      } catch (err) {
        console.error(err);
      }
    }

    async function loadConfig() {
      try {
        const res = await fetch('/api/config', { headers: authHeaders() });
        const data = await res.json();
        if (data.config) {
          document.getElementById('disp-taxpayer').textContent = data.config.taxPayerName;
          document.getElementById('disp-tin').textContent = data.config.taxPayerTIN;
          document.getElementById('disp-vat').textContent = data.config.vatNumber || '220000000';
          document.getElementById('disp-taxes').textContent = data.config.applicableTaxes.map(t => t.taxName + ' (' + (t.taxPercent ?? 0) + '%)').join(', ');
          document.getElementById('disp-mode').textContent = data.config.deviceOperatingMode;
        }
      } catch (err) {
        console.error(err);
      }
    }

    async function loadHistory() {
      try {
        const res = await fetch('/api/receipts/history', { headers: authHeaders() });
        const list = await res.json();
        const tbody = document.getElementById('history-rows');
        if (!list || list.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No receipts recorded in database yet for this tenant.</td></tr>';
          return;
        }
        tbody.innerHTML = list.map(item => {
          let tagClass = 'tag-invoice';
          if (item.receipt_type === 'CreditNote') tagClass = 'tag-credit';
          if (item.receipt_type === 'DebitNote') tagClass = 'tag-debit';
          return '<tr>' +
            '<td style="font-family: var(--mono); font-weight: 700;">#' + item.receipt_counter + ' (G:' + item.receipt_global_no + ')</td>' +
            '<td><span class="status-tag ' + tagClass + '">' + item.receipt_type + '</span></td>' +
            '<td>' + item.invoice_no + '</td>' +
            '<td style="font-family: var(--mono); font-weight: 600;">' + Number(item.total_amount).toFixed(2) + ' ' + item.currency + '</td>' +
            '<td style="color: var(--text-muted); font-size: 0.8rem;">' + new Date(item.submitted_at).toLocaleTimeString() + '</td>' +
            '<td>' + (item.qr_data ? '<a href="' + item.qr_data + '" target="_blank" style="color: var(--primary); font-family: var(--mono); font-size: 0.8rem; text-decoration: none;">' + item.qr_data + '</a>' : '-') + '</td>' +
            '</tr>';
        }).join('');
      } catch (err) {
        console.error(err);
      }
    }

    async function openFiscalDay() {
      try {
        const res = await fetch('/api/day/open', { method: 'POST', headers: authHeaders() });
        const data = await res.json();
        alert(data.message || (data.error ? "Error: " + data.error : JSON.stringify(data)));
        loadAll();
      } catch (err) {
        alert("Failed to open day: " + err.message);
      }
    }

    async function closeFiscalDay() {
      if (!confirm("Close the fiscal day? This computes and signs all day counters.")) return;
      try {
        const res = await fetch('/api/day/close', { method: 'POST', headers: authHeaders() });
        const data = await res.json();
        alert(data.message || (data.error ? "Error: " + data.error : JSON.stringify(data)));
        loadAll();
      } catch (err) {
        alert("Failed to close day: " + err.message);
      }
    }

    async function submitReceipt() {
      const btn = document.getElementById('btn-submit');
      btn.disabled = true;
      btn.textContent = 'Submitting...';
      try {
        const payload = JSON.parse(document.getElementById('payload-input').value);
        const res = await fetch('/api/receipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        document.getElementById('response-output').textContent = JSON.stringify(data, null, 2);

        const qrBox = document.getElementById('qr-result-box');
        if (data.qrData) {
          qrBox.style.display = 'block';
          const link = document.getElementById('qr-link');
          link.href = data.qrData;
          link.textContent = data.qrData;
          document.getElementById('qr-code-img').src = 'https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=' + encodeURIComponent(data.qrData);
        } else {
          qrBox.style.display = 'none';
        }

        loadAll();
      } catch (err) {
        document.getElementById('response-output').textContent = "Error: " + err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sign & Submit Receipt';
      }
    }

    function showRegisterDeviceModal() {
      const deviceId = prompt("Enter Device ID:", "12345");
      if (!deviceId) return;
      const serialNumber = prompt("Enter Serial Number:", "MYPOS01");
      if (!serialNumber) return;
      const activationKey = prompt("Enter 8-digit Activation Key:", "AAAABBBB");
      if (!activationKey) return;

      fetch('/api/device/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ deviceId: Number(deviceId), serialNumber, activationKey, environment: 'test' })
      })
      .then(r => r.json())
      .then(d => {
        alert(d.message || (d.error ? "Error: " + d.error : JSON.stringify(d)));
        loadAll();
      });
    }

    checkSession();
  </script>
</body>
</html>
`;

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
    return res.end(HTML_SERVER_PORTAL);
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
    // 5. POST /api/device/register
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

    // 6. GET /api/status
    if (req.method === "GET" && url.pathname === "/api/status") {
      const serialQuery = url.searchParams.get("serialNumber") || undefined;
      const deviceIdQuery = url.searchParams.get("deviceId") ? Number(url.searchParams.get("deviceId")) : undefined;
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(currentTenant.id, { serialNumber: serialQuery, deviceId: deviceIdQuery });
      const status = await fd.getStatus();
      const overrides = endpointOverrides();
      return sendJson(res, 200, {
        device: {
          deviceId: deviceRecord.device_id,
          serialNumber: deviceRecord.serial_number,
          environment: deviceRecord.environment,
        },
        status,
        baseUrl: overrides.baseUrl || "ZIMRA Test Portal",
      });
    }

    // 7. GET /api/config
    if (req.method === "GET" && url.pathname === "/api/config") {
      const serialQuery = url.searchParams.get("serialNumber") || undefined;
      const { fd } = await getDeviceInstanceForTenant(currentTenant.id, { serialNumber: serialQuery });
      const config = await fd.getConfig();
      return sendJson(res, 200, { config });
    }

    // 8. GET /api/receipts/history
    if (req.method === "GET" && url.pathname === "/api/receipts/history") {
      const receipts = await getTenantReceipts(currentTenant.id, 50);
      return sendJson(res, 200, receipts);
    }

    // 9. POST /api/day/open
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
      return sendJson(res, 200, { message: `Fiscal day ${resOpen.fiscalDayNo} opened successfully on device ${deviceRecord.serial_number}.`, result: resOpen });
    }

    // 10. POST /api/day/close
    if (req.method === "POST" && url.pathname === "/api/day/close") {
      const body = await parseBody(req);
      const identifier = {
        deviceId: body.deviceId ? Number(body.deviceId) : undefined,
        serialNumber: body.serialNumber ? String(body.serialNumber).trim() : undefined,
      };
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(currentTenant.id, identifier);
      await fd.reconcile();
      const resClose = await fd.closeDay();
      await clearDayStateDb(currentTenant.id, deviceRecord.device_id);
      return sendJson(res, 200, { message: `Fiscal day close submitted for device ${deviceRecord.serial_number}.`, operationId: resClose.operationID });
    }

    // 11. POST /api/receipt (Core Fiscal Endpoint with Serial Routing & Encryption)
    if (req.method === "POST" && url.pathname === "/api/receipt") {
      const body = await parseBody(req);
      const identifier = {
        deviceId: body.deviceId ? Number(body.deviceId) : undefined,
        serialNumber: body.serialNumber ? String(body.serialNumber).trim() : undefined,
      };
      const { fd, deviceRecord } = await getDeviceInstanceForTenant(currentTenant.id, identifier);

      let savedState = await loadDayStateDb(currentTenant.id, deviceRecord.device_id);
      if (!savedState && existsSync(".zimra/day-state.json")) {
        try {
          const fileContent = JSON.parse(readFileSync(".zimra/day-state.json", "utf-8"));
          if (fileContent.deviceId === deviceRecord.device_id && fileContent.state) {
            savedState = fileContent.state;
            await saveDayStateDb(currentTenant.id, deviceRecord.device_id, savedState);
          }
        } catch { /* ignore */ }
      }
      if (savedState) fd.restoreState(savedState);

      await fd.reconcile();
      await fd.getConfig(); // ensures qrUrl is populated for QR code computation

      const input = receiptInputFromJson(body);
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
        verificationUrl: sale.qrData,
        qrData: sale.qrData,
        qrCodeImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(sale.qrData || "")}`,
        validationErrors: sale.response.validationErrors,
        response: sale.response,
      });
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
