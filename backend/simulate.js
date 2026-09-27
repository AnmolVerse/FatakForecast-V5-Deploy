#!/usr/bin/env node

/**
 * FatakForecast V5 — Simulation CLI Runner
 *
 * Runs deterministic corridor movement scenarios to verify prediction integrity,
 * continuous multi-train handling, anomaly rejection, and freshness transitions.
 *
 * Usage:
 *   node backend/simulate.js --list
 *   node backend/simulate.js --scenario ON_TIME_NORMAL
 *   node backend/simulate.js --all
 */

const { SCENARIOS, runSimulation } = require("./services/simulation");

const args = process.argv.slice(2);

function printHelp() {
    console.log(`
FatakForecast V5 — Simulation Harness
=====================================
Usage:
  node backend/simulate.js --list
  node backend/simulate.js --scenario <SCENARIO_ID>
  node backend/simulate.js --all
  node backend/simulate.js --scenario <SCENARIO_ID> --json

Available Scenarios:
${Object.keys(SCENARIOS).map(k => `  • ${k.padEnd(22)} - ${SCENARIOS[k].name}`).join("\n")}
`);
}

if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printHelp();
    process.exit(0);
}

if (args.includes("--list")) {
    console.log("\nFatakForecast Simulation Scenarios:\n" + "=".repeat(60));
    for (const [id, s] of Object.entries(SCENARIOS)) {
        console.log(`ID:          ${id}`);
        console.log(`Name:        ${s.name}`);
        console.log(`Description: ${s.description}`);
        console.log(`Duration:    ${s.durationMinutes} min (${s.tickSeconds}s ticks)`);
        console.log("-".repeat(60));
    }
    process.exit(0);
}

const isJson = args.includes("--json");

function executeAndReport(scenarioId) {
    const result = runSimulation(scenarioId);

    if (isJson) {
        console.log(JSON.stringify(result, null, 2));
        return true;
    }

    console.log("\n" + "=".repeat(70));
    console.log(`SIMULATION: ${result.config.name} (${scenarioId})`);
    console.log(`Description: ${result.config.description}`);
    console.log(`Ticks Generated: ${result.totalTicks} (at ${result.config.tickSeconds}s interval)`);
    console.log("=".repeat(70));

    console.log("\nSample Milestones across Scenario:");
    const sampleIndices = [
        0,
        Math.floor(result.totalTicks * 0.25),
        Math.floor(result.totalTicks * 0.50),
        Math.floor(result.totalTicks * 0.75),
        result.totalTicks - 1
    ];

    for (const idx of sampleIndices) {
        const step = result.timeline[idx];
        if (!step) continue;

        console.log(`\n[T+${step.minute.toFixed(1)}m | Tick #${step.tick}]`);
        if (step.status === "UNAVAILABLE") {
            console.log(`  State: ⚠️ UNAVAILABLE - ${step.error}`);
            continue;
        }

        for (const t of step.trains) {
            console.log(`  Train #${t.trainNumber} (${t.direction}): pos=${t.km.toFixed(2)} km, speed=${t.speed} km/h, delay=${t.delayMinutes}m, freshness=${t.freshness}`);
        }

        const activeApproaching = Object.values(step.crossings)
            .filter(c => c.primaryTrain)
            .map(c => `${c.crossingId} (~${c.primaryTrain.distanceKm} km, continuous=${c.isContinuousClosure})`);

        if (activeApproaching.length > 0) {
            console.log(`  Crossings with Approaching Trains: ${activeApproaching.join("; ")}`);
        }
    }

    console.log("\n✔ Scenario simulation completed successfully.\n");
    return true;
}

if (args.includes("--all")) {
    console.log("\nExecuting all FatakForecast simulation scenarios...\n");
    let allPassed = true;
    for (const scenarioId of Object.keys(SCENARIOS)) {
        try {
            executeAndReport(scenarioId);
        } catch (err) {
            console.error(`❌ Scenario ${scenarioId} failed:`, err.message);
            allPassed = false;
        }
    }
    process.exit(allPassed ? 0 : 1);
}

const scenarioIdx = args.indexOf("--scenario");
if (scenarioIdx !== -1 && args[scenarioIdx + 1]) {
    const scenarioId = args[scenarioIdx + 1].toUpperCase();
    if (!SCENARIOS[scenarioId]) {
        console.error(`Error: Unknown scenario "${scenarioId}". Use --list to view valid scenarios.`);
        process.exit(1);
    }
    executeAndReport(scenarioId);
    process.exit(0);
}

console.error("Invalid arguments. Use --help for usage instructions.");
process.exit(1);
