async function testApi() {
  console.log("--- 1. Testing GET /api/health ---");
  const resHealth = await fetch("http://localhost:3000/api/health");
  console.log("Health Status:", resHealth.status, await resHealth.json());

  console.log("\n--- 2. Testing Smoke Test GET /api/status (Unauthenticated) ---");
  const resPublicStatus = await fetch("http://localhost:3000/api/status");
  console.log("Public Status:", resPublicStatus.status, await resPublicStatus.json());

  console.log("\n--- 3. Testing Authenticated GET /api/status with X-API-Key ---");
  const API_KEY = "zf_live_demo_1234567890abcdef1234567890abcdef";
  const resAuthStatus = await fetch("http://localhost:3000/api/status", {
    headers: { "X-API-Key": API_KEY }
  });
  console.log("Auth Status:", resAuthStatus.status, await resAuthStatus.json());
}

testApi().catch(console.error);
