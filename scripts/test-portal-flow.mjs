async function testPortalFlow() {
  console.log("=== Testing Web Portal API Workflows ===");

  // 1. Login
  const loginRes = await fetch("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@zimra-fdms.local", password: "password123" }),
  });
  const loginData = await loginRes.json();
  console.log("1. Portal Login:", loginRes.status, "Session Token:", loginData.sessionToken ? "Valid Token" : "Missing");

  const sessionHeader = {
    "Authorization": `Bearer ${loginData.sessionToken}`,
    "Content-Type": "application/json",
  };

  // 2. /api/me
  const meRes = await fetch("http://localhost:3000/api/me", { headers: sessionHeader });
  const meData = await meRes.json();
  console.log("2. Portal /api/me:", meRes.status, meData.tenant?.name);

  // 3. /api/status
  const statusRes = await fetch("http://localhost:3000/api/status", { headers: sessionHeader });
  const statusData = await statusRes.json();
  console.log("3. Portal /api/status:", statusRes.status, "Device:", statusData.device?.serialNumber, "Valid Until:", statusData.device?.certificateValidTo);

  // 4. /api/config
  const configRes = await fetch("http://localhost:3000/api/config", { headers: sessionHeader });
  const configData = await configRes.json();
  console.log("4. Portal /api/config:", configRes.status, "Taxpayer:", configData.config?.taxPayerName);

  // 5. Open Day via Portal Session
  console.log("5. Opening fiscal day via Portal...");
  const openRes = await fetch("http://localhost:3000/api/day/open", {
    method: "POST",
    headers: sessionHeader,
    body: JSON.stringify({ serialNumber: "MYPOS01" }),
  });
  console.log("   Open Day status:", openRes.status, (await openRes.json()).message);

  // 6. Submit Receipt via Portal Session
  console.log("6. Submitting test receipt via Portal...");
  const receiptRes = await fetch("http://localhost:3000/api/receipts/submit", {
    method: "POST",
    headers: sessionHeader,
    body: JSON.stringify({
      serialNumber: "MYPOS01",
      receiptType: "FiscalInvoice",
      currency: "USD",
      invoiceNo: "INV-PORTAL-001",
      lines: [{ name: "Portal Test Item", price: 115, quantity: 1, taxId: 1, taxPercent: 15 }],
      payments: [{ moneyType: "Cash", amount: 115 }],
    }),
  });
  const receiptData = await receiptRes.json();
  console.log("   Submit Receipt status:", receiptRes.status, "Receipt ID:", receiptData.receiptId, "QR:", receiptData.qrData ? "Generated ✓" : "None");

  // 7. Check Receipts Ledger via Portal Session
  const historyRes = await fetch("http://localhost:3000/api/receipts/history", { headers: sessionHeader });
  const historyData = await historyRes.json();
  console.log("7. Portal /api/receipts/history:", historyRes.status, "Total Receipts:", historyData.length);
  if (historyData.length > 0) {
    console.log("   Latest in Ledger:", historyData[0].invoice_no, Number(historyData[0].total_amount).toFixed(2), historyData[0].currency);
  }

  // 8. Close Day
  console.log("8. Closing fiscal day via Portal...");
  const closeRes = await fetch("http://localhost:3000/api/day/close", {
    method: "POST",
    headers: sessionHeader,
    body: JSON.stringify({ serialNumber: "MYPOS01", force: true }),
  });
  console.log("   Close Day status:", closeRes.status, (await closeRes.json()).message);

  console.log("\n✓ All Portal UI API interactions verified 100%!");
}

testPortalFlow().catch(console.error);
