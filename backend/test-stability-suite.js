/* ============================================================
   FATAKFORECAST — LIVE-FORECAST STABILITY TEST SUITE
   Verifies:
   1. In-flight train retention across cycles (no 32m jump)
   2. Telemetry failure resilience (429 rate limit retention)
   3. Stable deterministic event IDs across refreshes
   4. Primary train hysteresis (< 3m advantage does not flap)
   5. Meaningful earlier train switch (>= 3m advantage switches)
   6. Natural train passage completion (clean PREVIOUS_TRAIN_PASSED)
   7. Diagnostic metadata completeness (Requirement 7)
   8. Strict single central passage reference derivation
============================================================ */

process.env.NODE_ENV = "test";

const assert = require("assert");
const {
    buildUnifiedSnapshot,
    determineCrossingStatus,
    getActiveSnapshot,
    saveSnapshot
} = require("./services/forecast-snapshot");
const {
    activeCorridorRegistry,
    buildTrainEventQueue
} = require("./services/corridor-engine");

console.log("");
console.log("============================================================");
console.log("   FATAKFORECAST — FORECAST STABILITY TEST SUITE            ");
console.log("============================================================");

let passed = 0;
let failed = 0;

function runTest(name, fn) {
    try {
        fn();
        console.log(`  ✅ [PASS] ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${name}`);
        console.error(`     Error: ${err.message}`);
        failed++;
    }
}

// ------------------------------------------------------------
// TEST 1: In-Flight Corridor Train Retention on Board Omission
// ------------------------------------------------------------
runTest("1. In-Flight Train Retention: Prevents 32m jump when station board omits train", () => {
    // Clear registry
    activeCorridorRegistry.clear();

    const now = new Date("2026-09-13T12:00:00.000Z");
    const passage12412 = new Date(now.getTime() + 12 * 60000).toISOString(); // 12 min away
    const passage19614 = new Date(now.getTime() + 36 * 60000).toISOString(); // 36 min away

    // Register Train 12412 as active in registry from previous cycle
    const mock12412Result = {
        trainNumber: "12412",
        success: true,
        timeline: [
            {
                crossingId: "manawala-road",
                name: "Manawala Road Fatak",
                railwayPositionKm: 14.779,
                distanceKm: 8.322,
                estimatedPassageTime: passage12412,
                etaMethod: "forward-route-segment-speed"
            }
        ],
        analysis: {
            trainNumber: "12412",
            trainName: "Chandigarh Intercity Express",
            direction: "forward",
            speedKmph: 90.6,
            trainRailwayPositionKm: 6.457,
            timestamp: now.toISOString()
        }
    };
    activeCorridorRegistry.set("12412", {
        trainNumber: "12412",
        trainName: "Chandigarh Intercity Express",
        direction: "forward",
        lastObservedAt: now.getTime(),
        result: mock12412Result,
        timeline: mock12412Result.timeline,
        analysis: mock12412Result.analysis
    });

    // In current cycle, discovery returns ONLY Train 19614 (Train 12412 omitted from board)
    const mock19614Result = {
        trainNumber: "19614",
        success: true,
        timeline: [
            {
                crossingId: "manawala-road",
                name: "Manawala Road Fatak",
                railwayPositionKm: 14.779,
                distanceKm: 14.779,
                estimatedPassageTime: passage19614,
                etaMethod: "departure-anchor"
            }
        ],
        analysis: {
            trainNumber: "19614",
            trainName: "Amritsar - Ajmer Express",
            direction: "forward",
            speedKmph: 90.6,
            trainRailwayPositionKm: 0.000,
            timestamp: now.toISOString()
        }
    };

    const cycleResults = [mock19614Result];

    // Retention logic:
    for (const [regTrainNum, regData] of activeCorridorRegistry.entries()) {
        const inCurrent = cycleResults.some(r => String(r.trainNumber) === String(regTrainNum) && r.success);
        if (!inCurrent && regData.result) {
            const remaining = (regData.timeline || []).filter(c => {
                const pMs = new Date(c.estimatedPassageTime).getTime();
                return (pMs + 1 * 60000) >= now.getTime();
            });
            if (remaining.length > 0) {
                cycleResults.push({
                    ...regData.result,
                    timeline: remaining,
                    isRetainedTrajectory: true
                });
            }
        }
    }

    const events = buildTrainEventQueue(cycleResults, now.getTime());
    const eventsByCrossing = { "manawala-road": events.filter(e => e.crossingId === "manawala-road") };

    const snap = buildUnifiedSnapshot({
        cycleTimestamp: now.toISOString(),
        eventsByCrossing
    });

    const mw = snap.crossings["manawala-road"];
    assert.strictEqual(mw.primaryTrain.trainNumber, "12412", "Train 12412 MUST remain primary despite omission from board");
    assert.strictEqual(mw.status, "TRAIN APPROACHING", "Status should be TRAIN APPROACHING (12 min away)");
    assert.strictEqual(mw.upcomingTrains.length, 1, "Train 19614 must be queued as upcoming behind 12412");
    assert.strictEqual(mw.upcomingTrains[0].trainNumber, "19614");
});

// ------------------------------------------------------------
// TEST 2: In-Flight Train Retention on 429 Rate Limit
// ------------------------------------------------------------
runTest("2. In-Flight Train Retention: Prevents amnesia when query hits 429 rate limit", () => {
    activeCorridorRegistry.clear();

    const now = new Date("2026-09-13T12:00:00.000Z");
    const passage12412 = new Date(now.getTime() + 6 * 60000).toISOString();

    const cachedResult = {
        trainNumber: "12412",
        success: true,
        timeline: [
            {
                crossingId: "manawala-road",
                name: "Manawala Road Fatak",
                railwayPositionKm: 14.779,
                distanceKm: 8.322,
                estimatedPassageTime: passage12412,
                etaMethod: "forward-route-segment-speed"
            }
        ],
        analysis: {
            trainNumber: "12412",
            trainName: "Chandigarh Intercity Express",
            direction: "forward",
            speedKmph: 90.6,
            trainRailwayPositionKm: 6.457,
            timestamp: now.toISOString()
        }
    };
    activeCorridorRegistry.set("12412", {
        trainNumber: "12412",
        lastObservedAt: now.getTime(),
        result: cachedResult,
        timeline: cachedResult.timeline
    });

    // Cycle query for 12412 returns 429 failure
    const failedCycleResult = {
        trainNumber: "12412",
        success: false,
        reason: "Request failed with status code 429"
    };

    const cycleResults = [failedCycleResult];

    // Trajectory retention on failure
    for (const [regTrainNum, regData] of activeCorridorRegistry.entries()) {
        const inCurrent = cycleResults.some(r => String(r.trainNumber) === String(regTrainNum) && r.success);
        if (!inCurrent && regData.result) {
            const remaining = (regData.timeline || []).filter(c => {
                const pMs = new Date(c.estimatedPassageTime).getTime();
                return (pMs + 1 * 60000) >= now.getTime();
            });
            if (remaining.length > 0) {
                cycleResults.push({
                    ...regData.result,
                    timeline: remaining,
                    isRetainedTrajectory: true
                });
            }
        }
    }

    const events = buildTrainEventQueue(cycleResults, now.getTime());
    const eventsByCrossing = { "manawala-road": events.filter(e => e.crossingId === "manawala-road") };

    const snap = buildUnifiedSnapshot({
        cycleTimestamp: now.toISOString(),
        eventsByCrossing
    });

    const mw = snap.crossings["manawala-road"];
    assert.strictEqual(mw.primaryTrain.trainNumber, "12412", "Train 12412 trajectory must be retained despite 429 rate limit");
    assert.strictEqual(mw.status, "FATAK CLOSED", "ETA 6m -> status must be FATAK CLOSED");
});

// ------------------------------------------------------------
// TEST 3: Stable Deterministic Event ID
// ------------------------------------------------------------
runTest("3. Event Identity: Stable ID across refreshes and telemetry updates", () => {
    const t1 = new Date("2026-09-13T12:00:00.000Z");
    const passage1 = new Date(t1.getTime() + 10 * 60000).toISOString();

    const snap1 = buildUnifiedSnapshot({
        cycleTimestamp: t1.toISOString(),
        eventsByCrossing: {
            "manawala-road": [{
                trainNumber: "12412",
                estimatedPassageTime: passage1,
                crossingId: "manawala-road"
            }]
        }
    });

    saveSnapshot(snap1);

    const eventId1 = snap1.crossings["manawala-road"].primaryTrain.eventId;
    assert.strictEqual(eventId1, "12412-manawala-road-2026-09-13");

    // 2 minutes later, train has moved, passage updated slightly to 9 min
    const t2 = new Date("2026-09-13T12:02:00.000Z");
    const passage2 = new Date(t2.getTime() + 9 * 60000).toISOString();

    const snap2 = buildUnifiedSnapshot({
        cycleTimestamp: t2.toISOString(),
        eventsByCrossing: {
            "manawala-road": [{
                trainNumber: "12412",
                estimatedPassageTime: passage2,
                crossingId: "manawala-road"
            }]
        }
    });

    const eventId2 = snap2.crossings["manawala-road"].primaryTrain.eventId;
    assert.strictEqual(eventId2, eventId1, "Event ID must remain deterministic and stable across telemetry updates");
    assert.strictEqual(snap2.crossings["manawala-road"].switchDiagnostics.reason, "TELEMETRY_UPDATED");
});

// ------------------------------------------------------------
// TEST 4: Primary Train Hysteresis (< 3m advantage does not flap)
// ------------------------------------------------------------
runTest("4. Primary Hysteresis: < 3 minute difference prevents flip-flopping", () => {
    const t1 = new Date("2026-09-13T12:00:00.000Z");
    const passageA = new Date(t1.getTime() + 15 * 60000).toISOString(); // 15 min away

    const snap1 = buildUnifiedSnapshot({
        cycleTimestamp: t1.toISOString(),
        eventsByCrossing: {
            "jandiala": [{
                trainNumber: "12412",
                estimatedPassageTime: passageA,
                crossingId: "jandiala"
            }]
        }
    });
    saveSnapshot(snap1);

    assert.strictEqual(snap1.crossings["jandiala"].primaryTrain.trainNumber, "12412");

    // New train B arrives only 1.2 minutes earlier (13.8 min vs 15.0 min)
    const passageB = new Date(t1.getTime() + 13.8 * 60000).toISOString();

    const snap2 = buildUnifiedSnapshot({
        cycleTimestamp: t1.toISOString(),
        eventsByCrossing: {
            "jandiala": [
                {
                    trainNumber: "19614",
                    estimatedPassageTime: passageB,
                    crossingId: "jandiala"
                },
                {
                    trainNumber: "12412",
                    estimatedPassageTime: passageA,
                    crossingId: "jandiala"
                }
            ]
        }
    });

    const jnl = snap2.crossings["jandiala"];
    assert.strictEqual(jnl.primaryTrain.trainNumber, "12412", "Must retain Train 12412 as primary because advantage (1.2m) is < 3m");
    assert.strictEqual(jnl.switchDiagnostics.reason, "TELEMETRY_UPDATED");
    assert.strictEqual(jnl.upcomingTrains[0].trainNumber, "19614");
});

// ------------------------------------------------------------
// TEST 5: Meaningfully Earlier Train Switch (>= 3m advantage)
// ------------------------------------------------------------
runTest("5. Earlier Train Discovery: >= 3 minute advantage switches primary with diagnostic", () => {
    const t1 = new Date("2026-09-13T12:00:00.000Z");
    const passageA = new Date(t1.getTime() + 25 * 60000).toISOString(); // 25 min away

    const snap1 = buildUnifiedSnapshot({
        cycleTimestamp: t1.toISOString(),
        eventsByCrossing: {
            "jandiala": [{
                trainNumber: "12412",
                estimatedPassageTime: passageA,
                crossingId: "jandiala"
            }]
        }
    });
    saveSnapshot(snap1);

    // New train B arrives 12 minutes earlier (13 min away vs 25 min away)
    const passageB = new Date(t1.getTime() + 13 * 60000).toISOString();

    const snap2 = buildUnifiedSnapshot({
        cycleTimestamp: t1.toISOString(),
        eventsByCrossing: {
            "jandiala": [
                {
                    trainNumber: "19614",
                    estimatedPassageTime: passageB,
                    crossingId: "jandiala"
                },
                {
                    trainNumber: "12412",
                    estimatedPassageTime: passageA,
                    crossingId: "jandiala"
                }
            ]
        }
    });

    const jnl = snap2.crossings["jandiala"];
    assert.strictEqual(jnl.primaryTrain.trainNumber, "19614", "Must switch to Train 19614 because advantage (12m) is >= 3m");
    assert.strictEqual(jnl.switchDiagnostics.reason, "EARLIER_TRAIN_DISCOVERED");
    assert.strictEqual(jnl.switchDiagnostics.previousTrainNumber, "12412");
    assert.strictEqual(jnl.switchDiagnostics.currentTrainNumber, "19614");
});

// ------------------------------------------------------------
// TEST 6: Natural Train Passage Completion Switch
// ------------------------------------------------------------
runTest("6. Passage Completion: Switches to next train after previous train clears (+1m buffer)", () => {
    const t1 = new Date("2026-09-13T12:00:00.000Z");
    const passageA = new Date("2026-09-13T12:05:00.000Z").toISOString(); // 5 min from t1
    const passageB = new Date("2026-09-13T12:25:00.000Z").toISOString(); // 25 min from t1

    const snap1 = buildUnifiedSnapshot({
        cycleTimestamp: t1.toISOString(),
        eventsByCrossing: {
            "talwandi-dogran": [
                { trainNumber: "12412", estimatedPassageTime: passageA, crossingId: "talwandi-dogran" },
                { trainNumber: "19614", estimatedPassageTime: passageB, crossingId: "talwandi-dogran" }
            ]
        }
    });
    saveSnapshot(snap1);

    assert.strictEqual(snap1.crossings["talwandi-dogran"].primaryTrain.trainNumber, "12412");

    // Advance clock to 12:07:00 (2 minutes after Train A passage, which is > 1m reopen buffer)
    const t2 = new Date("2026-09-13T12:07:00.000Z");

    const snap2 = buildUnifiedSnapshot({
        cycleTimestamp: t2.toISOString(),
        eventsByCrossing: {
            "talwandi-dogran": [
                { trainNumber: "12412", estimatedPassageTime: passageA, crossingId: "talwandi-dogran" },
                { trainNumber: "19614", estimatedPassageTime: passageB, crossingId: "talwandi-dogran" }
            ]
        }
    });

    const td = snap2.crossings["talwandi-dogran"];
    assert.strictEqual(td.primaryTrain.trainNumber, "19614", "Must cleanly switch to Train 19614 after Train A has completed passage");
    assert.strictEqual(td.switchDiagnostics.reason, "PREVIOUS_TRAIN_PASSED");
    assert.strictEqual(td.switchDiagnostics.previousTrainNumber, "12412");
});

// ------------------------------------------------------------
// TEST 7: Diagnostic Metadata Completeness (Requirement 7)
// ------------------------------------------------------------
runTest("7. Diagnostic Metadata: Contains all 12 required telemetry fields", () => {
    const t = new Date("2026-09-13T12:00:00.000Z");
    const passage = new Date(t.getTime() + 10 * 60000).toISOString();

    const snap = buildUnifiedSnapshot({
        cycleTimestamp: t.toISOString(),
        eventsByCrossing: {
            "manawala-road": [{
                trainNumber: "12412",
                trainName: "Chandigarh Intercity Express",
                direction: "forward",
                speedKmph: 90.6,
                trainPositionKm: 6.457,
                crossingPositionKm: 14.779,
                estimatedPassageTime: passage,
                etaCalculationMethod: "forward-route-segment-speed",
                crossingId: "manawala-road"
            }]
        }
    });

    const mw = snap.crossings["manawala-road"];
    const meta = mw.diagnosticMetadata;

    assert.ok(meta, "diagnosticMetadata must exist on crossing");
    assert.ok(meta.forecastGeneratedAt, "forecastGeneratedAt required");
    assert.ok(meta.liveDataUpdatedAt, "liveDataUpdatedAt required");
    assert.strictEqual(meta.trainNumber, "12412", "trainNumber required");
    assert.strictEqual(meta.trainName, "Chandigarh Intercity Express", "trainName required");
    assert.ok(meta.eventId.startsWith("12412-manawala-road"), "eventId required");
    assert.strictEqual(meta.trainPosition, 6.457, "trainPosition required");
    assert.strictEqual(meta.crossingPosition, 14.779, "crossingPosition required");
    assert.strictEqual(meta.direction, "forward", "direction required");
    assert.strictEqual(meta.speed, 90.6, "speed required");
    assert.strictEqual(meta.ETA, 10.0, "ETA required");
    assert.strictEqual(meta.passageTimestamp, passage, "passageTimestamp required");
    assert.strictEqual(meta.etaCalculationMethod, "forward-route-segment-speed", "etaCalculationMethod required");
    assert.strictEqual(meta.dataFreshness, "LIVE_FRESH", "dataFreshness required");
});

// ------------------------------------------------------------
// TEST 8: Strict Central Passage Reference Derivation
// ------------------------------------------------------------
runTest("8. Central Passage Timeline: Strict derivation of all metrics from single passage time", () => {
    const passageTime = new Date("2026-09-13T17:08:00.000Z"); // 5:08 PM UTC
    const passageIso = passageTime.toISOString();

    const snap = buildUnifiedSnapshot({
        cycleTimestamp: new Date(passageTime.getTime() - 20 * 60000).toISOString(), // 20m before
        eventsByCrossing: {
            "rakh-devi-dasspura": [{
                trainNumber: "12412",
                estimatedPassageTime: passageIso,
                crossingId: "rakh-devi-dasspura"
            }]
        }
    });

    const rk = snap.crossings["rakh-devi-dasspura"];
    assert.strictEqual(rk.timingMetrics.passageTime, passageIso);
    assert.strictEqual(rk.timingMetrics.likelyClosure, new Date(passageTime.getTime() - 11 * 60000).toISOString());
    assert.strictEqual(rk.timingMetrics.likelyReopen, new Date(passageTime.getTime() + 1 * 60000).toISOString());
    assert.strictEqual(rk.timingMetrics.leadBuffer, "11 min baseline");

    // Status progression checks with determineCrossingStatus
    const st20 = determineCrossingStatus(rk.primaryTrain, "LIVE_FRESH", new Date(passageTime.getTime() - 20 * 60000));
    assert.strictEqual(st20.status, "OPEN");

    const st10 = determineCrossingStatus(rk.primaryTrain, "LIVE_FRESH", new Date(passageTime.getTime() - 10 * 60000));
    assert.strictEqual(st10.status, "FATAK CLOSED");

    const st5 = determineCrossingStatus(rk.primaryTrain, "LIVE_FRESH", new Date(passageTime.getTime() - 5 * 60000));
    assert.strictEqual(st5.status, "FATAK CLOSED");

    const st0 = determineCrossingStatus(rk.primaryTrain, "LIVE_FRESH", passageTime);
    assert.strictEqual(st0.status, "FATAK CLOSED");

    const stPlus1 = determineCrossingStatus(rk.primaryTrain, "LIVE_FRESH", new Date(passageTime.getTime() + 1 * 60000));
    assert.strictEqual(stPlus1.status, "OPEN");

    const stPlus2 = determineCrossingStatus(rk.primaryTrain, "LIVE_FRESH", new Date(passageTime.getTime() + 2 * 60000));
    assert.strictEqual(stPlus2.status, "OPEN");
});

console.log("");
console.log("============================================================");
console.log(`STABILITY TEST SUITE: ${passed} PASSED, ${failed} FAILED`);
console.log("============================================================");

if (failed > 0) {
    process.exit(1);
}
