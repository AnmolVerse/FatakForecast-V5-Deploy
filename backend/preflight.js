const fs = require("fs");
const path = require("path");
require("dotenv").config();

const crossings = require("./config/crossing");

const REQUIRED_FILES = [
    "package.json",
    "server.js",
    "services/monitor.js",
    "services/corridor-engine.js",
    "services/corridor-monitor.js",
    "services/geometry.js",
    "services/eta.js",
    "services/railradar.js",
    "data/crossing-events.json",
    "data/matched-events.json",
    "data/gate-observations.json",
    "data/train-observations.json"
];

const EXPECTED = new Set([
    "rakh-devi-dasspura",
    "jandiala",
    "manawala-road",
    "talwandi-dogran"
]);

let failed = false;

function fail(message) {
    failed = true;
    console.error(`❌ ${message}`);
}

console.log("========================================");
console.log("   FATAKFORECAST V4 PREFLIGHT CHECK");
console.log("========================================");

if (!process.env.RAILRADAR_API_KEY) {
    fail("RAILRADAR_API_KEY is missing from backend/.env");
} else {
    console.log("✅ RailRadar API key is configured");
}

for (const file of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(__dirname, file))) {
        fail(`Missing required file: ${file}`);
    }
}

if (crossings.length !== 4) {
    fail(`Expected exactly 4 V1 crossings, found ${crossings.length}`);
} else if (crossings.every(c => EXPECTED.has(c.id))) {
    console.log("✅ Exactly the four V1 crossings are configured");
} else {
    fail("V1 crossing IDs do not match the required four crossings");
}

for (const name of [
    "crossing-events.json",
    "matched-events.json",
    "gate-observations.json",
    "train-observations.json"
]) {
    try {
        const value = JSON.parse(fs.readFileSync(path.join(__dirname, "data", name), "utf8"));
        if (!Array.isArray(value)) fail(`${name} must contain a JSON array`);
    } catch (error) {
        fail(`${name} is not valid JSON: ${error.message}`);
    }
}

if (failed) {
    console.error("\nPreflight FAILED.");
    process.exit(1);
}

console.log("\n✅ Preflight passed. The project structure is ready.");
