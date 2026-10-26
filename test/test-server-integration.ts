import { FdmsSimulator } from "../src/simulator/server.js";
import { FiscalDevice } from "../src/node/device.js";
import { registerDevice } from "../src/node/registration.js";
import { NodeTransport } from "../src/node/transport.js";
import { cents, receiptInputFromJson } from "../src/core/money.js";
import { writeFileSync } from "node:fs";

async function testFlow() {
  console.log("1. Starting simulator on port 8443...");
  const sim = await FdmsSimulator.create({ port: 8443, closeDelayMs: 50, activationKeys: ["ABCD1234"] });
  const { url, caPem } = await sim.start();
  writeFileSync("zimra-simulator-ca.pem", caPem);
  console.log("   Simulator ready at:", url);

  console.log("2. Registering demo device 12345 / MYPOS01...");
  const identity = {
    deviceId: 12345,
    serialNumber: "MYPOS01",
    modelName: "Server",
    modelVersion: "v1",
  };
  const reg = await registerDevice(identity, "ABCD1234", {
    baseUrl: url,
    transport: new NodeTransport(undefined, { ca: caPem }),
  });
  console.log("   Device registered successfully.");

  console.log("3. Connecting FiscalDevice with mTLS...");
  const fd = new FiscalDevice(identity, {
    certificatePem: reg.certificatePem,
    privateKeyPem: reg.keys.privateKeyPem,
  }, { baseUrl: url, ca: caPem });

  const status = await fd.getStatus();
  console.log("   Initial status:", status.fiscalDayStatus);

  console.log("4. Opening fiscal day...");
  const openRes = await fd.openDay();
  console.log("   Day opened, fiscalDayNo:", openRes.fiscalDayNo);

  console.log("5. Submitting test receipt...");
  await fd.getConfig();
  const receipt = await fd.submitReceipt(receiptInputFromJson({
    currency: "USD",
    invoiceNo: "INV-TEST-001",
    lines: [
      { name: "Coffee", price: 2.50, quantity: 1, taxId: 1, taxPercent: 15 }
    ],
    payments: [{ moneyType: "Cash", amount: 2.50 }]
  }));
  console.log("   Receipt submitted! ID:", receipt.response.receiptID, "QR:", receipt.qrData);

  console.log("6. Closing fiscal day...");
  const closeRes = await fd.closeDay({ force: true });
  console.log("   Close initiated:", closeRes.operationID);

  await sim.stop();
  console.log("SUCCESS: Flow verified completely!");
}

testFlow().catch(err => {
  console.error("FAIL:", err);
  process.exit(1);
});
