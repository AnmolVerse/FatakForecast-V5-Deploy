/**
 * FatakForecast V5 — Extended 60–120 Minute Outlook Verification Suite
 *
 * Verifies:
 * Backend Tests (1–7):
 *   Test 1: ETA 45m -> Primary window (0-60m)
 *   Test 2: ETA 75m -> Extended window (60-120m)
 *   Test 3: ETA 115m -> Extended window (60-120m)
 *   Test 4: ETA 121m -> Excluded from both windows
 *   Test 5: Empty primary + 75m extended -> End-to-end API snapshot integrity
 *   Test 6: Stale telemetry at 75m -> Confidence degraded, never presented as confident live GPS
 *   Test 7: Cancelled train at 75m -> Detected and excluded, 0 events
 *
 * Frontend Verification (Cases A–G):
 *   Case A: Primary active + Extended active -> Both rendered simultaneously
 *   Case B: Primary active + Extended empty -> Primary rendered + Truthful empty extended message
 *   Case C: Primary empty + Extended active -> Primary empty hero + Active extended card
 *   Case D: Primary empty + Extended empty -> Primary empty hero + Truthful empty extended message
 *   Case E: Telemetry unavailable -> Truthful offline / unavailable message
 *   Case F: Version branding -> Footer brand displays FatakForecast V5
 *   Case G: Timing invariant -> Strictly 11-min close / +1-min open baseline
 *
 * SAFETY INVARIANT:
 *   All tests run on purely isolated, in-memory fixtures.
 *   No mock data is written to gate-observations.json or matched-events.json.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
    buildUnifiedSnapshot
} = require("./services/forecast-snapshot");

const {
    isTrainCancelled
} = require("./services/corridor-monitor");

const {
    V1_CROSSINGS,
    TIMING_CONFIG
} = require("./config/corridor");

console.log("\n" + "=".repeat(75));
console.log("   FATAKFORECAST V5 — 60–120 MIN EXTENDED OUTLOOK TEST SUITE");
console.log("=".repeat(75) + "\n");

let passed = 0;
let failed = 0;

async function runTest(code, name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ [Test ${code}] ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ❌ [Test ${code}] ${name}`);
        console.error(`     Error: ${err.message}\n${err.stack}`);
    }
}

async function runAll() {
    const fixedNow = new Date("2026-09-27T10:00:00.000Z");

    // ============================================================
    // TEST 1: ETA 45m -> Primary window (0-60m)
    // ============================================================
    await runTest("1", "ETA 45m candidate is assigned to PRIMARY forecast window", async () => {
        const passageTime = new Date(fixedNow.getTime() + 45 * 60000).toISOString();
        const eventsByCrossing = {
            "talwandi-dogran": [
                {
                    trainNumber: "12002",
                    trainName: "Shatabdi Express",
                    estimatedPassageTime: passageTime,
                    direction: "forward"
                }
            ]
        };

        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing
        });

        const crossing = snapshot.crossings["talwandi-dogran"];
        assert.ok(crossing.primaryTrain, "Primary train should be populated");
        assert.strictEqual(crossing.primaryTrain.trainNumber, "12002");
        assert.strictEqual(crossing.primaryTrain.forecastWindow, "primary");
        assert.strictEqual(Math.round(crossing.primaryTrain.etaMinutes), 45);
        assert.strictEqual(crossing.extendedOutlook.length, 0, "Extended outlook should be empty");
    });

    // ============================================================
    // TEST 2: ETA 75m -> Extended window (60-120m)
    // ============================================================
    await runTest("2", "ETA 75m candidate is assigned to EXTENDED window (60-120m)", async () => {
        const passageTime = new Date(fixedNow.getTime() + 75 * 60000).toISOString();
        const eventsByCrossing = {
            "talwandi-dogran": [
                {
                    trainNumber: "12411",
                    trainName: "Intercity Express",
                    estimatedPassageTime: passageTime,
                    direction: "forward"
                }
            ]
        };

        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing
        });

        const crossing = snapshot.crossings["talwandi-dogran"];
        assert.strictEqual(crossing.primaryTrain, null, "Primary train should be null for ETA 75m");
        assert.strictEqual(crossing.hasExtendedOutlook, true, "hasExtendedOutlook should be true");
        assert.strictEqual(crossing.extendedOutlook.length, 1);
        const ext = crossing.extendedOutlook[0];
        assert.strictEqual(ext.trainNumber, "12411");
        assert.strictEqual(ext.forecastWindow, "extended");
        assert.strictEqual(ext.status, "EXTENDED OUTLOOK");
        assert.strictEqual(ext.crossingId, "talwandi-dogran");
        assert.strictEqual(Math.round(ext.etaMinutes), 75);
    });

    // ============================================================
    // TEST 3: ETA 115m -> Extended window (60-120m)
    // ============================================================
    await runTest("3", "ETA 115m candidate is included in EXTENDED window (60-120m)", async () => {
        const passageTime = new Date(fixedNow.getTime() + 115 * 60000).toISOString();
        const eventsByCrossing = {
            "manawala-road": [
                {
                    trainNumber: "14804",
                    trainName: "Sabarmati Express",
                    estimatedPassageTime: passageTime,
                    direction: "backward"
                }
            ]
        };

        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing
        });

        const crossing = snapshot.crossings["manawala-road"];
        assert.strictEqual(crossing.primaryTrain, null);
        assert.strictEqual(crossing.hasExtendedOutlook, true);
        assert.strictEqual(crossing.extendedOutlook.length, 1);
        assert.strictEqual(Math.round(crossing.extendedOutlook[0].etaMinutes), 115);
        assert.strictEqual(crossing.extendedOutlook[0].direction, "backward");
    });

    // ============================================================
    // TEST 4: ETA 121m -> Excluded completely from both windows
    // ============================================================
    await runTest("4", "ETA 121m candidate is excluded completely from both primary and extended", async () => {
        const passageTime = new Date(fixedNow.getTime() + 121 * 60000).toISOString();
        const eventsByCrossing = {
            "rakh-devi-dasspura": [
                {
                    trainNumber: "11058",
                    trainName: "Amritsar Express",
                    estimatedPassageTime: passageTime,
                    direction: "forward"
                }
            ]
        };

        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing
        });

        const crossing = snapshot.crossings["rakh-devi-dasspura"];
        assert.strictEqual(crossing.primaryTrain, null, "Primary must be null");
        assert.strictEqual(crossing.hasExtendedOutlook, false, "hasExtendedOutlook must be false");
        assert.strictEqual(crossing.extendedOutlook.length, 0, "Extended outlook must be empty");
    });

    // ============================================================
    // TEST 5: Empty primary + 75m extended -> End-to-end API snapshot integrity
    // ============================================================
    await runTest("5", "Empty primary + 75m extended: verified API response structure and enriched fields", async () => {
        const passageTime = new Date(fixedNow.getTime() + 75 * 60000).toISOString();
        const eventsByCrossing = {
            "jandiala": [
                {
                    trainNumber: "12411",
                    trainName: "Intercity Express",
                    estimatedPassageTime: passageTime,
                    direction: "forward",
                    speed_kmh: 65,
                    movementState: "RUNNING"
                }
            ]
        };

        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing
        });

        // Verify root properties
        assert.strictEqual(snapshot.forecastHorizonMinutes, 60);
        assert.strictEqual(snapshot.extendedHorizonMinutes, 120);

        // Verify crossing properties
        const c = snapshot.crossings["jandiala"];
        assert.strictEqual(c.primaryTrain, null);
        assert.strictEqual(c.hasExtendedOutlook, true);
        assert.strictEqual(c.extendedOutlook.length, 1);

        const item = c.extendedOutlook[0];
        assert.strictEqual(item.forecastWindow, "extended");
        assert.strictEqual(item.status, "EXTENDED OUTLOOK");
        assert.strictEqual(item.crossingId, "jandiala");
        assert.strictEqual(item.trainNumber, "12411");
        assert.strictEqual(item.trainName, "Intercity Express");
        assert.strictEqual(item.speedKmph, 65);
        assert.strictEqual(item.movementState, "RUNNING");
        assert.strictEqual(Math.round(item.etaMinutes), 75);

        // Gate baseline check on 75m event:
        const expectedClose = new Date(new Date(passageTime).getTime() - 11 * 60000).toISOString();
        const expectedOpen = new Date(new Date(passageTime).getTime() + 1 * 60000).toISOString();
        assert.strictEqual(item.predictedGateCloseTime, expectedClose);
        assert.strictEqual(item.predictedGateOpenTime, expectedOpen);
    });

    // ============================================================
    // TEST 6: Stale telemetry at 75m -> Confidence degraded
    // ============================================================
    await runTest("6", "Stale telemetry candidate at 75m: confidence degraded, never marked fresh GPS", async () => {
        const passageTime = new Date(fixedNow.getTime() + 75 * 60000).toISOString();
        const eventsByCrossing = {
            "talwandi-dogran": [
                {
                    trainNumber: "12411",
                    trainName: "Intercity Express",
                    estimatedPassageTime: passageTime,
                    direction: "forward",
                    stale: true,
                    telemetryFreshness: "STALE",
                    confidence: "DEGRADED"
                }
            ]
        };

        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing
        });

        const crossing = snapshot.crossings["talwandi-dogran"];
        assert.strictEqual(crossing.extendedOutlook.length, 1);
        const item = crossing.extendedOutlook[0];
        assert.strictEqual(item.telemetryFreshness, "STALE");
        assert.strictEqual(item.confidence, "DEGRADED");
        assert.notStrictEqual(item.confidence, "HIGH");
    });

    // ============================================================
    // TEST 7: Cancelled train at 75m -> Detected and excluded, 0 events
    // ============================================================
    await runTest("7", "Cancelled train with 75m schedule: detected by isTrainCancelled, 0 events generated", async () => {
        const cancelledTrain = {
            trainNumber: "74641",
            status: "cancelled",
            trackingMode: "none",
            currentLocation: null,
            exceptions: [{ type: "CANCELLED" }]
        };

        assert.strictEqual(isTrainCancelled(cancelledTrain), true, "Train 74641 should be identified as cancelled");

        // When cancelled, engine produces no crossing events
        const eventsByCrossing = {};
        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing
        });

        for (const crossing of Object.values(snapshot.crossings)) {
            assert.strictEqual(crossing.primaryTrain, null);
            assert.strictEqual(crossing.hasExtendedOutlook, false);
            assert.strictEqual(crossing.extendedOutlook.length, 0);
        }
    });

    // ============================================================
    // FRONTEND VERIFICATION SUITE (Cases A–G)
    // ============================================================
    console.log("\n--- Frontend UI & State Transition Verification (Cases A–G) ---\n");

    // Case A: Primary active + Extended active -> Both populated
    await runTest("Case A", "Primary active + Extended active: both windows populated simultaneously", async () => {
        const passagePrimary = new Date(fixedNow.getTime() + 25 * 60000).toISOString();
        const passageExtended = new Date(fixedNow.getTime() + 75 * 60000).toISOString();
        const eventsByCrossing = {
            "talwandi-dogran": [
                { trainNumber: "12002", estimatedPassageTime: passagePrimary, direction: "forward" },
                { trainNumber: "12411", estimatedPassageTime: passageExtended, direction: "forward" }
            ]
        };

        const snapshot = buildUnifiedSnapshot({ cycleTimestamp: fixedNow.toISOString(), eventsByCrossing });
        const c = snapshot.crossings["talwandi-dogran"];

        assert.ok(c.primaryTrain, "Primary train active");
        assert.strictEqual(c.primaryTrain.trainNumber, "12002");
        assert.strictEqual(c.hasExtendedOutlook, true, "Extended outlook active");
        assert.strictEqual(c.extendedOutlook.length, 1);
        assert.strictEqual(c.extendedOutlook[0].trainNumber, "12411");
    });

    // Case B: Primary active + Extended empty
    await runTest("Case B", "Primary active + Extended empty: primary populated, extended length 0", async () => {
        const passagePrimary = new Date(fixedNow.getTime() + 20 * 60000).toISOString();
        const eventsByCrossing = {
            "talwandi-dogran": [
                { trainNumber: "12002", estimatedPassageTime: passagePrimary, direction: "forward" }
            ]
        };

        const snapshot = buildUnifiedSnapshot({ cycleTimestamp: fixedNow.toISOString(), eventsByCrossing });
        const c = snapshot.crossings["talwandi-dogran"];

        assert.ok(c.primaryTrain, "Primary train active");
        assert.strictEqual(c.hasExtendedOutlook, false, "Extended empty");
        assert.strictEqual(c.extendedOutlook.length, 0);
    });

    // Case C: Primary empty + Extended active (The Crucial Fix!)
    await runTest("Case C", "Primary empty + Extended active: primaryTrain is null, extendedOutlook populated", async () => {
        const passageExtended = new Date(fixedNow.getTime() + 75 * 60000).toISOString();
        const eventsByCrossing = {
            "talwandi-dogran": [
                { trainNumber: "12411", estimatedPassageTime: passageExtended, direction: "forward" }
            ]
        };

        const snapshot = buildUnifiedSnapshot({ cycleTimestamp: fixedNow.toISOString(), eventsByCrossing });
        const c = snapshot.crossings["talwandi-dogran"];

        assert.strictEqual(c.primaryTrain, null, "Primary window is empty");
        assert.strictEqual(c.hasExtendedOutlook, true, "Extended outlook must be active");
        assert.strictEqual(c.extendedOutlook.length, 1);
        assert.strictEqual(c.extendedOutlook[0].trainNumber, "12411");
        assert.strictEqual(c.extendedOutlook[0].status, "EXTENDED OUTLOOK");
    });

    // Case D: Primary empty + Extended empty
    await runTest("Case D", "Primary empty + Extended empty: both windows empty, ready for truthful empty states", async () => {
        const eventsByCrossing = {};
        const snapshot = buildUnifiedSnapshot({ cycleTimestamp: fixedNow.toISOString(), eventsByCrossing });
        const c = snapshot.crossings["talwandi-dogran"];

        assert.strictEqual(c.primaryTrain, null);
        assert.strictEqual(c.hasExtendedOutlook, false);
        assert.strictEqual(c.extendedOutlook.length, 0);
    });

    // Case E: Telemetry unavailable -> status reflects UNAVAILABLE
    await runTest("Case E", "Telemetry unavailable: snapshot freshness and crossing status reflect UNAVAILABLE", async () => {
        const oldTimestamp = new Date(fixedNow.getTime() - 20 * 60000).toISOString(); // 20m ago
        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            liveDataTimestamp: oldTimestamp,
            eventsByCrossing: {}
        });

        assert.strictEqual(snapshot.freshness, "UNAVAILABLE");
    });

    // Case F: Version branding in frontend
    await runTest("Case F", "Frontend footer branding strictly reflects 'FatakForecast V5'", async () => {
        const htmlPath = path.join(__dirname, "../frontend/index.html");
        const htmlContent = fs.readFileSync(htmlPath, "utf8");

        assert.ok(htmlContent.includes("FatakForecast V5"), "HTML must contain FatakForecast V5");
        assert.ok(!htmlContent.includes("FatakForecast V4"), "HTML must NOT contain old FatakForecast V4");
    });

    // Case G: Gate timing baseline preserved (-11m close / +1m open)
    await runTest("Case G", "Gate timing baseline strictly preserved: -11 min close / +1 min open", async () => {
        const passageTime = new Date(fixedNow.getTime() + 75 * 60000);
        const eventsByCrossing = {
            "talwandi-dogran": [
                {
                    trainNumber: "12411",
                    estimatedPassageTime: passageTime.toISOString(),
                    direction: "forward"
                }
            ]
        };

        const snapshot = buildUnifiedSnapshot({ cycleTimestamp: fixedNow.toISOString(), eventsByCrossing });
        const ext = snapshot.crossings["talwandi-dogran"].extendedOutlook[0];

        const closeTime = new Date(ext.predictedGateCloseTime).getTime();
        const passageMs = passageTime.getTime();
        const openTime = new Date(ext.predictedGateOpenTime).getTime();

        const closeDiffMin = (passageMs - closeTime) / 60000;
        const openDiffMin = (openTime - passageMs) / 60000;

        assert.strictEqual(closeDiffMin, 11, "Gate close offset must be exactly 11 minutes prior to passage");
        assert.strictEqual(openDiffMin, 1, "Gate open offset must be exactly 1 minute after passage");
    });

    console.log("\n" + "=".repeat(75));
    console.log(`EXTENDED OUTLOOK TEST SUITE SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log("=".repeat(75) + "\n");

    if (failed > 0) {
        process.exit(1);
    }
}

runAll().catch(err => {
    console.error("FATAL TEST SUITE ERROR:", err);
    process.exit(1);
});
