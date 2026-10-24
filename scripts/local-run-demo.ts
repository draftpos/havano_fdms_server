import { FdmsSimulator } from "../src/simulator/server.js";
import { FiscalDevice } from "../src/node/device.js";
import { registerDevice } from "../src/node/registration.js";
import { NodeTransport } from "../src/node/transport.js";
import { cents } from "../src/core/money.js";

async function runLocalDemo() {
  console.log("=== ZIMRA FDMS LOCAL ENVIRONMENT DEMO ===");

  // 1. Start local FDMS Simulator with mTLS CA
  console.log("\n[1/6] Starting local FDMS simulator on port 8443...");
  const sim = await FdmsSimulator.create({ port: 8443, closeDelayMs: 50, activationKeys: ["ABCD1234"] });
  const { url, caPem } = await sim.start();
  console.log(`✓ FDMS Simulator listening at: ${url}`);

  // 2. Register Device
  const identity = {
    deviceId: 99001,
    serialNumber: "POS-LOCAL-001",
    modelName: "LocalDevice",
    modelVersion: "1.0",
  };
  console.log(`\n[2/6] Registering device ${identity.serialNumber} (ID: ${identity.deviceId}) with activation key...`);
  const reg = await registerDevice(identity, "ABCD1234", {
    baseUrl: url,
    transport: new NodeTransport(undefined, { ca: caPem }),
  });
  console.log("✓ Device registered successfully! Certificate issued by local CA.");

  // 3. Initialize FiscalDevice
  const pems = {
    certificatePem: reg.certificatePem,
    privateKeyPem: reg.keys.privateKeyPem,
  };
  const fd = new FiscalDevice(identity, pems, { baseUrl: url, ca: caPem });

  // 4. Check Config & Open Fiscal Day
  console.log("\n[3/6] Getting config and opening fiscal day...");
  const config = await fd.getConfig();
  console.log(`✓ Taxpayer: ${config.taxPayerName} (TIN: ${config.taxPayerTIN})`);
  console.log(`✓ Available taxes: ${config.applicableTaxes.map(t => `${t.taxName} (${t.taxPercent ?? 0}%)`).join(", ")}`);

  const day = await fd.openDay();
  console.log(`✓ Fiscal day opened! Fiscal Day No: ${day.fiscalDayNo}`);

  // 5. Submit Receipts (Chained)
  console.log("\n[4/6] Submitting receipt #1 (Sale: $23.00)...");
  const r1 = await fd.submitReceipt({
    currency: "USD",
    invoiceNo: "INV-LOCAL-001",
    lines: [
      { name: "Coffee", price: cents("11.50"), quantity: 2, taxId: 1, taxPercent: 15 },
    ],
    payments: [{ moneyType: "Cash", amount: 23 }],
  });
  console.log(`✓ Receipt #1 submitted! Receipt ID: ${r1.response.receiptID}, Global No: ${r1.response.receiptGlobalNo}`);
  console.log(`✓ QR Code Data: ${r1.qrData}`);

  console.log("\n[5/6] Submitting receipt #2 (Sale: $10.00, hash-chained to #1)...");
  const r2 = await fd.submitReceipt({
    currency: "USD",
    invoiceNo: "INV-LOCAL-002",
    lines: [
      { name: "Pastry", price: cents("10.00"), quantity: 1, taxId: 1, taxPercent: 15 },
    ],
    payments: [{ moneyType: "Cash", amount: 10 }],
  });
  console.log(`✓ Receipt #2 submitted! Receipt ID: ${r2.response.receiptID}, Global No: ${r2.response.receiptGlobalNo}`);
  console.log(`✓ QR Code Data: ${r2.qrData}`);

  // 6. Close Fiscal Day
  console.log("\n[6/6] Closing fiscal day...");
  const close = await fd.closeDay();
  console.log(`✓ Fiscal day close initiated! Operation ID: ${close.operationID}`);

  // Wait for close to settle
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const status = await fd.getStatus();
    if (status.fiscalDayStatus === "FiscalDayClosed") {
      console.log(`✓ Fiscal day successfully settled and closed! Last Receipt: ${status.lastReceiptGlobalNo}`);
      break;
    }
  }

  await sim.stop();
  console.log("\n🎉 Full local fiscal cycle completed successfully!");
}

runLocalDemo().catch((err) => {
  console.error("Error running local demo:", err);
  process.exit(1);
});
