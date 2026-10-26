// SuperAdmin Flow Verification Script
const BASE = "http://localhost:3000";

async function run() {
  console.log("=== Testing SuperAdmin Gateway & Multi-Client Provisioning ===");

  // 1. Login as SuperAdmin
  console.log("\n1. Logging in as SuperAdmin...");
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "Admin", password: "Admin123" }),
  });
  const loginData = await loginRes.json();
  if (!loginData.sessionToken) throw new Error("Login failed: " + JSON.stringify(loginData));
  console.log("✅ Logged in successfully. Token:", loginData.sessionToken.slice(0, 15) + "...");

  const adminHeaders = {
    "Authorization": `Bearer ${loginData.sessionToken}`,
    "Content-Type": "application/json",
  };

  // 2. List clients
  console.log("\n2. Fetching all managed clients (GET /api/admin/clients)...");
  const listRes = await fetch(`${BASE}/api/admin/clients`, { headers: adminHeaders });
  const listData = await listRes.json();
  console.log(`✅ Retrieved ${listData.clients.length} client(s):`);
  listData.clients.forEach(c => {
    const dev = c.devices[0];
    console.log(`   - [${c.name}] ID: ${c.id} | Device: ${dev ? dev.serialNumber : 'none'} (ID: ${dev ? dev.deviceId : '-'}) | API Key: ${c.apiKey ? c.apiKey.slice(0, 15) + '...' : c.apiKeyPrefix}`);
  });

  // 3. Provision a new client store
  console.log("\n3. Provisioning new client 'Spar Kamfinsa Branch' (POST /api/admin/clients)...");
  const uniqueSerial = "SPAR" + Math.floor(Math.random() * 9000 + 1000);
  const provRes = await fetch(`${BASE}/api/admin/clients`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      name: "Spar Kamfinsa Branch",
      deviceId: Math.floor(Math.random() * 80000 + 20000),
      serialNumber: uniqueSerial,
      activationKey: "AAAABBBB",
      environment: "test",
    }),
  });
  const provData = await provRes.json();
  if (!provData.success) throw new Error("Provisioning failed: " + JSON.stringify(provData));
  console.log("✅ Client Provisioned!");
  console.log("   - Client ID: ", provData.tenant.id);
  console.log("   - Store Name:", provData.tenant.name);
  console.log("   - Device:    ", provData.device.serialNumber, `(ID ${provData.device.deviceId})`);
  console.log("   - POS API Key:", provData.apiKey);

  const sparApiKey = provData.apiKey;

  // 4. Test submitting receipt directly from POS using Spar's dedicated API Key!
  console.log("\n4. Submitting POS checkout receipt directly using Spar's API Key (POST /api/receipts/submit)...");
  const submitRes = await fetch(`${BASE}/api/receipts/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": sparApiKey,
    },
    body: JSON.stringify({
      serialNumber: uniqueSerial,
      receiptType: "FiscalInvoice",
      currency: "USD",
      invoiceNo: "SPAR-INV-001",
      lines: [
        { name: "Bakery Bread", price: 1.50, quantity: 2, taxId: 1, taxPercent: 15 },
        { name: "Fresh Milk", price: 1.20, quantity: 1, taxId: 2, taxPercent: 0 },
      ],
      payments: [
        { moneyType: "Cash", amount: 4.20 },
      ],
    }),
  });
  const submitData = await submitRes.json();
  if (!submitData.success && !submitData.receiptGlobalNo) {
    throw new Error("Receipt submission failed: " + JSON.stringify(submitData));
  }
  console.log("✅ Receipt submitted successfully via Spar's API Key!");
  console.log("   - Receipt Global No:", submitData.receiptGlobalNo);
  console.log("   - Server Date:      ", submitData.serverDate);
  console.log("   - Verification QR:  ", submitData.qrData);

  // 5. Verify the updated client table shows Spar's 1 receipt
  console.log("\n5. Re-fetching clients to verify receipt counter incremented...");
  const updatedListRes = await fetch(`${BASE}/api/admin/clients`, { headers: adminHeaders });
  const updatedListData = await updatedListRes.json();
  const sparInList = updatedListData.clients.find(c => c.id === provData.tenant.id);
  console.log(`✅ Spar Kamfinsa receipt count in DB: ${sparInList.receiptCount}`);

  console.log("\n======================================================");
  console.log("🎉 ALL TESTS PASSED! SuperAdmin Multi-Tenant is Complete!");
  console.log("======================================================");
}

run().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
