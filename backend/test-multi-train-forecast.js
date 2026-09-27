const assert = require("assert");
const http = require("http");

console.log("\n========================================");
console.log("   FATAKFORECAST MULTI-TRAIN TEST");
console.log("========================================");

// Require server so it spins up
require("./server");

setTimeout(async () => {
    try {
        const res = await new Promise((resolve, reject) => {
            http.get("http://localhost:3000/api/health", (resp) => {
                let data = "";
                resp.on("data", chunk => data += chunk);
                resp.on("end", () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            }).on("error", reject);
        });

        assert.strictEqual(res.status, 200, "Health check should return 200");
        assert.strictEqual(res.body.success, true, "Health check should be true");
        console.log("✅ API Health check passed: HTTP 200");

        // Test static file serving
        const staticRes = await new Promise((resolve, reject) => {
            http.get("http://localhost:3000/", (resp) => {
                let data = "";
                resp.on("data", chunk => data += chunk);
                resp.on("end", () => resolve({ status: resp.statusCode, headers: resp.headers, length: data.length }));
            }).on("error", reject);
        });

        assert.strictEqual(staticRes.status, 200, "Static serving / should return 200");
        assert(staticRes.headers["content-type"].includes("text/html"), "Content-Type should be HTML");
        console.log("✅ Static file serving (frontend index.html) passed: HTTP 200");

        // Test forecast endpoint
        const forecastRes = await new Promise((resolve, reject) => {
            http.get("http://localhost:3000/api/forecast", (resp) => {
                let data = "";
                resp.on("data", chunk => data += chunk);
                resp.on("end", () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            }).on("error", reject);
        });

        assert.strictEqual(forecastRes.status, 200, "Forecast endpoint should return 200");
        assert.strictEqual(forecastRes.body.forecasts.length, 4, "Should have 4 crossings in forecast");
        
        for (const f of forecastRes.body.forecasts) {
            assert(Array.isArray(f.upcomingTrains), "Each crossing forecast must have upcomingTrains array");
            assert("overlappingClosure" in f, "Each crossing forecast must have overlappingClosure property");
            assert("activeTrainCount" in f, "Each crossing forecast must have activeTrainCount");
        }
        console.log("✅ Forecast schema structure verified: upcomingTrains, overlappingClosure, activeTrainCount intact");

        console.log("\n🎉 ALL MULTI-TRAIN AND SERVER TESTS PASSED\n");
        process.exit(0);
    } catch (err) {
        console.error("❌ Test failed:", err.message);
        process.exit(1);
    }
}, 800);
