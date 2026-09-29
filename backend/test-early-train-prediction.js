/**
 * FatakForecast V5 — Early Train Prediction Accuracy Verification Suite
 *
 * Tests the complete prediction pipeline to ensure fresh live train telemetry
 * is the primary driver of crossing passage predictions, correctly handling
 * early running trains while preserving schedule baselines.
 *
 * 22 Comprehensive Verification Tests:
 *  1. Pure live telemetry early train prediction (22:50 passage vs 23:00 scheduled)
 *  2. Station anchor early train handling (getStationAnchorTime with negative delay)
 *  3. Not-started departure anchor early train (addCrossingETA with negative delay)
 *  4. Positive delayed train regression protection (+15m delay)
 *  5. On-time train classification (within +/- 1.5 min)
 *  6. Early train boundary condition (-1.6 min -> EARLY)
 *  7. Delayed train boundary condition (+1.6 min -> DELAYED)
 *  8. Telemetry freshness ingestion: live.lastUpdatedAt parsed and trusted
 *  9. Telemetry freshness ingestion: live.currentLocation.lastUpdatedAt parsed and trusted
 * 10. Missing telemetry safe fallback to schedule baseline
 * 11. Physical sanity check: impossible speeds rejected
 * 12. Gate timeline close calculation: strictly 11 minutes prior
 * 13. Gate timeline open calculation: strictly 1 minute after
 * 14. Primary horizon classification: 0-60 min
 * 15. Extended horizon classification: 60-120 min
 * 16. Beyond extended horizon filtering: > 120 min excluded
 * 17. Negative delay formatting: -10 min formatted as "-10 min" and delayMinutes = -10
 * 18. Positive delay formatting: +15 min formatted as "+15 min" and delayMinutes = 15
 * 19. Zero delay formatting: delayFormatted = null and delayMinutes = 0
 * 20. MAX_FUTURE_ANCHOR_MINUTES increased to 120 (45m anchor accepted)
 * 21. Four V1 crossings geometry consistency and ordering
 * 22. End-to-end buildUnifiedSnapshot with early running train
 */

const assert = require("assert");

const {
    calculateETA,
    estimateTrainPassage,
    deriveScheduledPassage,
    classifyEarlyLate,
    getStationAnchorTime,
    getPositionTimestamp,
    getTelemetryFreshness,
    isUsableAnchorTime,
    passesPhysicalSanityCheck
} = require("./services/eta");

const {
    addCrossingETA
} = require("./services/corridor-monitor");

const {
    getArrivalTime,
    getDepartureTime,
    derivePassageFromDistance
} = require("./services/corridor-engine");

const {
    buildUnifiedSnapshot
} = require("./services/forecast-snapshot");

const {
    V1_CROSSINGS,
    TIMING_CONFIG
} = require("./config/corridor");

console.log("\n" + "=".repeat(75));
console.log("   FATAKFORECAST V5 — EARLY TRAIN PREDICTION ACCURACY TEST SUITE");
console.log("=".repeat(75) + "\n");

let passed = 0;
let failed = 0;

async function runTest(num, name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ [Test ${num}] ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ❌ [Test ${num}] ${name}`);
        console.error(`     Error: ${err.message}\n${err.stack}`);
    }
}

async function runAll() {
    const fixedNow = new Date("2026-09-27T22:30:00.000Z");

    // ============================================================
    // TEST 1: Pure live telemetry early train prediction
    // Scheduled 23:00, live train reaches crossing at 22:50
    // ============================================================
    await runTest(1, "Pure live telemetry early train: passage predicted ~22:50 vs scheduled 23:00", async () => {
        const trainPos = { km: 10 };
        const crossing = { id: "talwandi-dogran", positionKm: 30, railwayPositionKm: 30 };
        const live = {
            currentLocation: {
                speedKmh: 60,
                lastUpdatedAt: new Date("2026-09-27T22:29:00.000Z").toISOString(),
                delayMinutes: -10
            }
        };

        const result = calculateETA(trainPos, crossing, "forward", live, fixedNow);
        assert.strictEqual(result.available, true, "ETA must be available");
        // 20 km at 60 km/h = 20 minutes -> ETA = 20 min -> passage = 22:50:00
        assert.strictEqual(result.etaMinutes, 20, "ETA must be exactly 20 minutes");
        const expectedPassage = new Date("2026-09-27T22:50:00.000Z");
        assert.strictEqual(result.passageTime.getTime(), expectedPassage.getTime(), "Passage must be 22:50:00");

        // Scheduled passage is 23:00 (10 min later)
        const scheduledPassage = new Date("2026-09-27T23:00:00.000Z");
        const earlyCheck = classifyEarlyLate(result.passageTime, scheduledPassage);
        assert.strictEqual(earlyCheck.status, "EARLY", "Train must be classified as EARLY");
        assert.strictEqual(earlyCheck.differenceMinutes, -10, "Early deviation must be -10 min");

        // Gate close = passage - 11m = 22:39, Gate open = passage + 1m = 22:51
        const gateClose = new Date(result.passageTime.getTime() - 11 * 60000);
        const gateOpen = new Date(result.passageTime.getTime() + 1 * 60000);
        assert.strictEqual(gateClose.toISOString(), "2026-09-27T22:39:00.000Z");
        assert.strictEqual(gateOpen.toISOString(), "2026-09-27T22:51:00.000Z");
    });

    // ============================================================
    // TEST 2: Station anchor early train handling
    // Scheduled arrival 23:00, delayMinutes = -10 -> anchor = 22:50
    // ============================================================
    await runTest(2, "Station anchor negative delay: getStationAnchorTime adjusts time 10m earlier", async () => {
        const station = {
            scheduledArrival: "2026-09-27T23:00:00.000Z",
            delayMinutes: -10
        };
        const anchorTime = getStationAnchorTime(station);
        assert(anchorTime instanceof Date, "Anchor time must be a Date");
        assert.strictEqual(anchorTime.toISOString(), "2026-09-27T22:50:00.000Z", "Anchor time must be 22:50:00");
    });

    // ============================================================
    // TEST 3: Not-started departure anchor early train
    // Scheduled departure 23:00, delayMinutes = -10 -> departure = 22:50
    // ============================================================
    await runTest(3, "Not-started departure anchor with negative delay applies early departure", async () => {
        const crossing = {
            id: "talwandi-dogran",
            name: "Talwandi Dogran",
            railwayPositionKm: 45,
            distanceKm: 10
        };
        const testSchedDep = new Date(Date.now() + 30 * 60000).toISOString();
        const live = {
            status: "not_started",
            trainNumber: "12345",
            delayMinutes: -10,
            scheduledDepartureTime: testSchedDep,
            route: [{ scheduledDeparture: testSchedDep, speedToNextStationKmph: 60 }]
        };

        // fixedNow is 22:30. Delayed departure with -10m is 22:50.
        // Transit 10 km @ 60 km/h = 10m.
        // Passage = 22:50 + 10m = 23:00.
        // ETA from 22:30 is 30m.
        const res = addCrossingETA({
            crossing: { ...crossing },
            etaRoute: null,
            trainPosition: 35,
            direction: "forward",
            live,
            speedKmph: 60,
            positionFresh: true,
            livePositionStale: false
        });

        assert.strictEqual(res.earlyLateStatus, "EARLY", "Status must be EARLY");
        assert.strictEqual(res.delayMinutes, -10, "Delay minutes must be -10");
        assert.strictEqual(res.etaConfidence, "early-departure-anchor", "Confidence must be early-departure-anchor");
    });

    // ============================================================
    // TEST 4: Positive delayed train regression protection
    // ============================================================
    await runTest(4, "Positive delayed train regression protection: +15m delay", async () => {
        const station = {
            scheduledArrival: "2026-09-27T23:00:00.000Z",
            delayMinutes: 15
        };
        const anchorTime = getStationAnchorTime(station);
        assert.strictEqual(anchorTime.toISOString(), "2026-09-27T23:15:00.000Z", "Anchor time must be 23:15:00");

        const status = classifyEarlyLate("2026-09-27T23:15:00.000Z", "2026-09-27T23:00:00.000Z");
        assert.strictEqual(status.status, "DELAYED");
        assert.strictEqual(status.differenceMinutes, 15);
    });

    // ============================================================
    // TEST 5: On-time train classification (+/- 1.5m)
    // ============================================================
    await runTest(5, "On-time train classification within +/- 1.5 min threshold", async () => {
        const status = classifyEarlyLate("2026-09-27T23:00:30.000Z", "2026-09-27T23:00:00.000Z");
        assert.strictEqual(status.status, "ON_TIME");
        assert.strictEqual(status.differenceMinutes, 0.5);

        const status2 = classifyEarlyLate("2026-09-27T22:59:00.000Z", "2026-09-27T23:00:00.000Z");
        assert.strictEqual(status2.status, "ON_TIME");
        assert.strictEqual(status2.differenceMinutes, -1);
    });

    // ============================================================
    // TEST 6: Early train boundary condition (< -1.5m)
    // ============================================================
    await runTest(6, "Early train boundary: difference -1.6m classifies as EARLY", async () => {
        const pred = new Date("2026-09-27T23:00:00.000Z").getTime() - 1.6 * 60000;
        const status = classifyEarlyLate(new Date(pred), "2026-09-27T23:00:00.000Z");
        assert.strictEqual(status.status, "EARLY");
        assert.strictEqual(status.differenceMinutes, -1.6);
    });

    // ============================================================
    // TEST 7: Delayed train boundary condition (> +1.5m)
    // ============================================================
    await runTest(7, "Delayed train boundary: difference +1.6m classifies as DELAYED", async () => {
        const pred = new Date("2026-09-27T23:00:00.000Z").getTime() + 1.6 * 60000;
        const status = classifyEarlyLate(new Date(pred), "2026-09-27T23:00:00.000Z");
        assert.strictEqual(status.status, "DELAYED");
        assert.strictEqual(status.differenceMinutes, 1.6);
    });

    // ============================================================
    // TEST 8: Telemetry freshness: live.lastUpdatedAt parsed
    // ============================================================
    await runTest(8, "Telemetry freshness: live.lastUpdatedAt candidate is extracted and fresh", async () => {
        const live = {
            lastUpdatedAt: new Date("2026-09-27T22:29:00.000Z").toISOString()
        };
        const ts = getPositionTimestamp(null, live);
        assert(ts instanceof Date, "Extracted timestamp must be a Date");
        assert.strictEqual(ts.toISOString(), "2026-09-27T22:29:00.000Z");

        const freshness = getTelemetryFreshness(null, live, fixedNow);
        assert.strictEqual(freshness.state, "FRESH", "1-minute age must be FRESH");
    });

    // ============================================================
    // TEST 9: Telemetry freshness: live.currentLocation.lastUpdatedAt parsed
    // ============================================================
    await runTest(9, "Telemetry freshness: live.currentLocation.lastUpdatedAt candidate is extracted", async () => {
        const live = {
            currentLocation: {
                lastUpdatedAt: "2026-09-27T22:28:30.000Z"
            }
        };
        const ts = getPositionTimestamp(null, live);
        assert(ts instanceof Date, "Extracted timestamp must be a Date");
        assert.strictEqual(ts.toISOString(), "2026-09-27T22:28:30.000Z");
    });

    // ============================================================
    // TEST 10: Missing telemetry safe fallback to schedule baseline
    // ============================================================
    await runTest(10, "Missing telemetry safely derives schedule without throwing", async () => {
        const sched = deriveScheduledPassage({
            scheduledStationTime: "2026-09-27T23:00:00.000Z",
            transitMinutes: 10
        });
        assert(sched instanceof Date, "Schedule must be derived");
        assert.strictEqual(sched.toISOString(), "2026-09-27T23:10:00.000Z");

        const fromEst = deriveScheduledPassage({
            estimatedPassageTime: "2026-09-27T22:50:00.000Z",
            delayMinutes: -10
        });
        assert.strictEqual(fromEst.toISOString(), "2026-09-27T23:00:00.000Z");
    });

    // ============================================================
    // TEST 11: Physical sanity check: impossible speeds rejected
    // ============================================================
    await runTest(11, "Physical sanity check rejects impossible speeds", async () => {
        // 50 km in 1.8 minutes requires >1600 km/h -> impossible!
        const sane = passesPhysicalSanityCheck(50, 1.8);
        assert.strictEqual(sane, false, "Sanity check must reject 50km in 1.8m");

        const realistic = passesPhysicalSanityCheck(50, 45);
        assert.strictEqual(realistic, true, "Sanity check must accept 50km in 45m");
    });

    // ============================================================
    // TEST 12: Gate timeline close calculation (strictly -11m)
    // ============================================================
    await runTest(12, "Gate timeline close is strictly 11 minutes prior to passage", async () => {
        const passage = new Date("2026-09-27T22:50:00.000Z");
        const close = new Date(passage.getTime() - TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_CLOSURE_OFFSET_MINUTES * 60000);
        assert.strictEqual(close.toISOString(), "2026-09-27T22:39:00.000Z");
    });

    // ============================================================
    // TEST 13: Gate timeline open calculation (strictly +1m)
    // ============================================================
    await runTest(13, "Gate timeline open is strictly 1 minute after passage", async () => {
        const passage = new Date("2026-09-27T22:50:00.000Z");
        const open = new Date(passage.getTime() + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000);
        assert.strictEqual(open.toISOString(), "2026-09-27T22:51:00.000Z");
    });

    // ============================================================
    // TEST 14: Primary horizon classification (0-60 min)
    // ============================================================
    await runTest(14, "Candidate with ETA 45m falls into PRIMARY forecast window", async () => {
        const passage = new Date(fixedNow.getTime() + 45 * 60000).toISOString();
        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing: {
                "talwandi-dogran": [{
                    trainNumber: "12425",
                    trainName: "Express",
                    estimatedPassageTime: passage,
                    direction: "forward"
                }]
            }
        });
        const crossing = snapshot.crossings["talwandi-dogran"];
        assert(crossing.primaryTrain, "Primary train should be populated");
        assert.strictEqual(crossing.primaryTrain.trainNumber, "12425");
        assert.strictEqual(crossing.primaryTrain.forecastWindow, "primary");
    });

    // ============================================================
    // TEST 15: Extended horizon classification (60-120 min)
    // ============================================================
    await runTest(15, "Candidate with ETA 75m falls into EXTENDED OUTLOOK (60-120 min)", async () => {
        const passage = new Date(fixedNow.getTime() + 75 * 60000).toISOString();
        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing: {
                "talwandi-dogran": [{
                    trainNumber: "12425",
                    trainName: "Express",
                    estimatedPassageTime: passage,
                    direction: "forward"
                }]
            }
        });
        const crossing = snapshot.crossings["talwandi-dogran"];
        assert.strictEqual(crossing.primaryTrain, null);
        assert.strictEqual(crossing.extendedOutlook.length, 1);
        assert.strictEqual(crossing.extendedOutlook[0].trainNumber, "12425");
        assert.strictEqual(crossing.extendedOutlook[0].forecastWindow, "extended");
    });

    // ============================================================
    // TEST 16: Beyond extended horizon filtering (> 120 min)
    // ============================================================
    await runTest(16, "Candidate with ETA 135m is excluded from both primary and extended", async () => {
        const passage = new Date(fixedNow.getTime() + 135 * 60000).toISOString();
        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing: {
                "talwandi-dogran": [{
                    trainNumber: "12425",
                    trainName: "Express",
                    estimatedPassageTime: passage,
                    direction: "forward"
                }]
            }
        });
        const crossing = snapshot.crossings["talwandi-dogran"];
        assert.strictEqual(crossing.primaryTrain, null);
        assert.strictEqual(crossing.extendedOutlook.length, 0);
    });

    // ============================================================
    // TEST 17: Negative delay formatting: -10 min -> "-10 min" & delayMinutes = -10
    // ============================================================
    await runTest(17, "Negative delay formatting: -10 min formatted as '-10 min' and delayMinutes = -10", async () => {
        const passage = new Date(fixedNow.getTime() + 20 * 60000).toISOString();
        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing: {
                "talwandi-dogran": [{
                    trainNumber: "12425",
                    trainName: "Express",
                    estimatedPassageTime: passage,
                    direction: "forward",
                    delayMinutes: -10
                }]
            }
        });
        const primary = snapshot.crossings["talwandi-dogran"].primaryTrain;
        assert(primary, "Primary train must exist");
        assert.strictEqual(primary.delayMinutes, -10, "delayMinutes must be -10");
        assert.strictEqual(primary.delayFormatted, "-10 min", "delayFormatted must be '-10 min'");
    });

    // ============================================================
    // TEST 18: Positive delay formatting: +15 min -> "+15 min"
    // ============================================================
    await runTest(18, "Positive delay formatting: +15 min formatted as '+15 min' and delayMinutes = 15", async () => {
        const passage = new Date(fixedNow.getTime() + 20 * 60000).toISOString();
        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing: {
                "talwandi-dogran": [{
                    trainNumber: "12425",
                    trainName: "Express",
                    estimatedPassageTime: passage,
                    direction: "forward",
                    delayMinutes: 15
                }]
            }
        });
        const primary = snapshot.crossings["talwandi-dogran"].primaryTrain;
        assert(primary, "Primary train must exist");
        assert.strictEqual(primary.delayMinutes, 15, "delayMinutes must be 15");
        assert.strictEqual(primary.delayFormatted, "+15 min", "delayFormatted must be '+15 min'");
    });

    // ============================================================
    // TEST 19: Zero delay formatting: delayFormatted = null and delayMinutes = 0
    // ============================================================
    await runTest(19, "Zero delay formatting: delayFormatted is null and delayMinutes is 0", async () => {
        const passage = new Date(fixedNow.getTime() + 20 * 60000).toISOString();
        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing: {
                "talwandi-dogran": [{
                    trainNumber: "12425",
                    trainName: "Express",
                    estimatedPassageTime: passage,
                    direction: "forward",
                    delayMinutes: 0
                }]
            }
        });
        const primary = snapshot.crossings["talwandi-dogran"].primaryTrain;
        assert(primary, "Primary train must exist");
        assert.strictEqual(primary.delayMinutes, 0);
        assert.strictEqual(primary.delayFormatted, null);
    });

    // ============================================================
    // TEST 20: MAX_FUTURE_ANCHOR_MINUTES increased to 120
    // ============================================================
    await runTest(20, "Station anchor 45 minutes in the future is usable (up to 120m)", async () => {
        const futureAnchor = new Date(fixedNow.getTime() + 45 * 60000);
        const usable = isUsableAnchorTime(futureAnchor, fixedNow);
        assert.strictEqual(usable, true, "Station anchor at 45m future must be usable");
    });

    // ============================================================
    // TEST 21: Four V1 crossings geometry consistency and naming
    // ============================================================
    await runTest(21, "Four V1 crossings geometry consistency and naming", async () => {
        assert.strictEqual(V1_CROSSINGS.length, 4, "Must have exactly 4 V1 crossings");
        const ids = V1_CROSSINGS.map(c => c.id);
        assert(ids.includes("talwandi-dogran"), "Must include talwandi-dogran");
        assert(ids.includes("manawala-road"), "Must include manawala-road");
        assert(ids.includes("rakh-devi-dasspura"), "Must include rakh-devi-dasspura");
        assert(ids.includes("jandiala"), "Must include jandiala");

        for (const c of V1_CROSSINGS) {
            assert(c.id, `${c.id} must have valid id`);
            assert(c.name, `${c.id} must have valid name`);
            assert(Number.isFinite(c.coordinates.lat) && Number.isFinite(c.coordinates.lng), `${c.id} must have valid lat/lng`);
        }
    });

    // ============================================================
    // TEST 22: Full forecast snapshot pipeline with early running train
    // ============================================================
    await runTest(22, "Full snapshot pipeline surfaces early running status, difference, and gate times", async () => {
        const passage = new Date(fixedNow.getTime() + 20 * 60000).toISOString(); // 22:50:00
        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing: {
                "talwandi-dogran": [{
                    trainNumber: "12425",
                    trainName: "Rajdhani Express",
                    direction: "forward",
                    estimatedPassageTime: passage,
                    delayMinutes: -10,
                    confidence: "HIGH",
                    source: "LIVE_GPS"
                }]
            }
        });

        const c = snapshot.crossings["talwandi-dogran"];
        assert(c, "Crossing must exist in snapshot");
        assert(c.primaryTrain, "Primary train must exist");
        assert.strictEqual(c.primaryTrain.earlyLateStatus, "EARLY", "earlyLateStatus must be EARLY");
        assert.strictEqual(c.primaryTrain.earlyLateMinutes, -10, "earlyLateMinutes must be -10");
        assert.strictEqual(c.primaryTrain.delayMinutes, -10, "delayMinutes must be -10");
        assert.strictEqual(c.primaryTrain.delayFormatted, "-10 min", "delayFormatted must be '-10 min'");

        // Verify diagnostic metadata
        assert(c.diagnosticMetadata, "diagnosticMetadata must exist");
        assert.strictEqual(c.diagnosticMetadata.earlyLateStatus, "EARLY");
        assert.strictEqual(c.diagnosticMetadata.earlyLateMinutes, -10);

        // Verify gate timings
        const gateClose = new Date(c.primaryTrain.predictedGateCloseTime);
        const gateOpen = new Date(c.primaryTrain.predictedGateOpenTime);
        const passageDate = new Date(c.primaryTrain.estimatedPassageTime);
        assert.strictEqual((passageDate.getTime() - gateClose.getTime()) / 60000, 11, "Gate close must be 11m prior");
        assert.strictEqual((gateOpen.getTime() - passageDate.getTime()) / 60000, 1, "Gate open must be 1m after");
    });

    console.log("\n" + "=".repeat(75));
    console.log(`   TOTAL TESTS: 22 | PASSED: ${passed} | FAILED: ${failed}`);
    console.log("=".repeat(75) + "\n");

    if (failed > 0) {
        process.exit(1);
    }
}

runAll().catch(err => {
    console.error("FATAL TEST SUITE ERROR:", err);
    process.exit(1);
});
