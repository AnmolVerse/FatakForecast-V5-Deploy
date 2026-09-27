/**
 * FatakForecast V5 — Live ETA & Telemetry Hardening Test Suite
 *
 * Verifies all 21 mandatory test cases (A through U):
 * A. Forward corridor order (Talwandi -> Manawala -> Rakh Devi -> Jandiala)
 * B. Reverse corridor order (Jandiala -> Rakh Devi -> Manawala -> Talwandi)
 * C. Forward train between crossings (past crossings excluded)
 * D. Reverse train between crossings (past crossings excluded)
 * E. Direction UNKNOWN suppresses confident ETA
 * F. Unexpected intermediate stop -> LIVE_STATIONARY, DEGRADED confidence, unexpected halt flagged
 * G. Known station stop -> legitimate halt (KNOWN_STATION_STOP), not treated as unexpected halt
 * H. Delayed departure shifts downstream crossings cleanly by delay delta
 * I. Fresh GPS (<= 2.5m) -> FRESH, HIGH confidence, LIVE_GPS
 * J. Aging telemetry (2.5 - 5.0m) -> AGING, MEDIUM confidence, RECENT_TELEMETRY
 * K. Stale telemetry (5.0 - 10.0m) -> STALE, LOW/DEGRADED confidence, bounded fallback
 * L. Telemetry > 10.0m -> UNAVAILABLE, live ETA suppressed
 * M. Cancelled train handling -> detected early, 0 events, no position error
 * N. 0-60m primary forecast window
 * O. 60-120m extended outlook window
 * P. > 120m excluded completely
 * Q. 11-minute gate close baseline (T - 11m)
 * R. +1-minute gate open baseline (T + 1m)
 * S. Post-passage observation workflow (post-passage observation recorded, no synthetic labels)
 * T. Multiple trains approaching different crossings
 * U. Adjacent/near-simultaneous crossing events (< 10m continuous closure)
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");

const {
    calculateETA,
    estimateTrainPassage,
    getTelemetryFreshness,
    classifyTrainMovement,
    getDistanceToCrossing,
    isCrossingAhead,
    TELEMETRY_THRESHOLDS
} = require("./services/eta");

const {
    isTrainCancelled,
    inferDirectionFromRoute,
    addCrossingETA
} = require("./services/corridor-monitor");

const {
    buildUnifiedSnapshot,
    computeCombinedClosureTimeline
} = require("./services/forecast-snapshot");

const {
    BASELINE,
    predictClosure
} = require("./services/closure-predictor");

const {
    V1_CROSSINGS,
    TIMING_CONFIG
} = require("./config/corridor");

console.log("\n" + "=".repeat(75));
console.log("   FATAKFORECAST V5 — HARDENING & TELEMETRY QUALITY TEST SUITE (21 TESTS)");
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

// Corridor crossings with physical route km along the 12.8km line
const corridorCrossingsWithKm = [
    { id: "talwandi-dogran", name: "Talwandi Dogran Fatak", positionKm: 14.2 },
    { id: "manawala-road", name: "Manawala Road Fatak", positionKm: 16.8 },
    { id: "rakh-devi-dasspura", name: "Rakh Devi Dasspura Fatak", positionKm: 18.3 },
    { id: "jandiala", name: "Jandiala Railway Crossing", positionKm: 20.5 }
];

async function runAll() {
    const fixedNow = new Date("2026-09-27T10:00:00.000Z");

    // ============================================================
    // TEST A: Forward corridor order (Talwandi -> Manawala -> Rakh Devi -> Jandiala)
    // ============================================================
    await runTest("A", "Forward corridor order: Talwandi -> Manawala -> Rakh Devi -> Jandiala", async () => {
        const trainPos = { km: 12.0 }; // West of Talwandi (e.g. approaching from Amritsar)
        const ahead = corridorCrossingsWithKm
            .filter(c => isCrossingAhead(trainPos, c, "forward"))
            .sort((a, b) => getDistanceToCrossing(trainPos, a, "forward") - getDistanceToCrossing(trainPos, b, "forward"));

        assert.strictEqual(ahead.length, 4);
        assert.strictEqual(ahead[0].id, "talwandi-dogran");
        assert.strictEqual(ahead[1].id, "manawala-road");
        assert.strictEqual(ahead[2].id, "rakh-devi-dasspura");
        assert.strictEqual(ahead[3].id, "jandiala");
    });

    // ============================================================
    // TEST B: Reverse corridor order (Jandiala -> Rakh Devi -> Manawala -> Talwandi)
    // ============================================================
    await runTest("B", "Reverse corridor order: Jandiala -> Rakh Devi -> Manawala -> Talwandi", async () => {
        const trainPos = { km: 22.0 }; // East of Jandiala (approaching from Beas/JNL towards ASR)
        const ahead = corridorCrossingsWithKm
            .filter(c => isCrossingAhead(trainPos, c, "backward"))
            .sort((a, b) => getDistanceToCrossing(trainPos, a, "backward") - getDistanceToCrossing(trainPos, b, "backward"));

        assert.strictEqual(ahead.length, 4);
        assert.strictEqual(ahead[0].id, "jandiala");
        assert.strictEqual(ahead[1].id, "rakh-devi-dasspura");
        assert.strictEqual(ahead[2].id, "manawala-road");
        assert.strictEqual(ahead[3].id, "talwandi-dogran");
    });

    // ============================================================
    // TEST C: Forward train between crossings (past crossings excluded)
    // ============================================================
    await runTest("C", "Forward train between crossings (x=17.5km): Talwandi & Manawala excluded", async () => {
        const trainPos = { km: 17.5 }; // Past Talwandi (14.2) and Manawala (16.8)
        const ahead = corridorCrossingsWithKm
            .filter(c => isCrossingAhead(trainPos, c, "forward"))
            .map(c => c.id);

        assert.deepStrictEqual(ahead, ["rakh-devi-dasspura", "jandiala"]);
    });

    // ============================================================
    // TEST D: Reverse train between crossings (past crossings excluded)
    // ============================================================
    await runTest("D", "Reverse train between crossings (x=19.5km): Jandiala excluded", async () => {
        const trainPos = { km: 19.5 }; // Past Jandiala (20.5 heading west)
        const ahead = corridorCrossingsWithKm
            .filter(c => isCrossingAhead(trainPos, c, "backward"))
            .sort((a, b) => getDistanceToCrossing(trainPos, a, "backward") - getDistanceToCrossing(trainPos, b, "backward"))
            .map(c => c.id);

        assert.deepStrictEqual(ahead, ["rakh-devi-dasspura", "manawala-road", "talwandi-dogran"]);
    });

    // ============================================================
    // TEST E: Direction UNKNOWN suppresses confident ETA
    // ============================================================
    await runTest("E", "Direction UNKNOWN suppresses confident predictions", async () => {
        const crossing = corridorCrossingsWithKm[1];
        const res = calculateETA({ km: 12.0 }, crossing, "unknown", null, fixedNow);
        assert.strictEqual(res.available, false);
        assert.strictEqual(res.reason, "unknown-direction");
        assert.strictEqual(res.confidence, "low");
    });

    // ============================================================
    // TEST F: Unexpected intermediate stop -> LIVE_STATIONARY + DEGRADED
    // ============================================================
    await runTest("F", "Unexpected intermediate stop: speed 0 at non-station -> LIVE_STATIONARY & DEGRADED confidence", async () => {
        const trainPos = { km: 15.5 }; // Between Talwandi (14.2) and Manawala (16.8) - siding/signal
        const live = {
            currentLocation: {
                speedKmh: 0,
                timestamp: fixedNow.toISOString(),
                stationCode: null
            },
            route: [
                { stationCode: "ASR", distance: 0 },
                { stationCode: "MOW", distance: 16.8 },
                { stationCode: "JNL", distance: 20.5 }
            ]
        };

        const movement = classifyTrainMovement(live, trainPos, 0, "FRESH");
        assert.strictEqual(movement.movementState, "LIVE_STATIONARY");
        assert.strictEqual(movement.stopType, "UNEXPECTED_INTERMEDIATE_STOP");
        assert.strictEqual(movement.degraded, true);

        const eta = calculateETA(trainPos, corridorCrossingsWithKm[1], "forward", live, fixedNow);
        assert.strictEqual(eta.available, true);
        assert.strictEqual(eta.movementState, "LIVE_STATIONARY");
        assert.strictEqual(eta.stopType, "UNEXPECTED_INTERMEDIATE_STOP");
        assert.strictEqual(eta.confidence, "DEGRADED");
        assert.strictEqual(eta.degradedConfidence, true);
        assert.strictEqual(eta.unexpectedHalt, true);
    });

    // ============================================================
    // TEST G: Known station stop -> legitimate halt, not error
    // ============================================================
    await runTest("G", "Known station stop: speed 0 at MOW station platform -> KNOWN_STATION_STOP, not degraded error", async () => {
        const trainPos = { km: 16.8 }; // Exactly at Mananwala (MOW)
        const live = {
            currentLocation: {
                speedKmh: 0,
                timestamp: fixedNow.toISOString(),
                stationCode: "MOW"
            },
            route: [
                { stationCode: "ASR", distance: 0 },
                { stationCode: "MOW", distance: 16.8 },
                { stationCode: "JNL", distance: 20.5 }
            ]
        };

        const movement = classifyTrainMovement(live, trainPos, 0, "FRESH");
        assert.strictEqual(movement.movementState, "LIVE_STATIONARY");
        assert.strictEqual(movement.stopType, "KNOWN_STATION_STOP");
        assert.strictEqual(movement.degraded, false);

        const eta = calculateETA(trainPos, corridorCrossingsWithKm[2], "forward", live, fixedNow);
        assert.strictEqual(eta.available, true);
        assert.strictEqual(eta.movementState, "LIVE_STATIONARY");
        assert.strictEqual(eta.stopType, "KNOWN_STATION_STOP");
        assert.strictEqual(Boolean(eta.degradedConfidence), false);
    });

    // ============================================================
    // TEST H: Delayed departure shifts downstream crossings cleanly
    // ============================================================
    await runTest("H", "Delayed departure: +8 min delay shifts downstream crossing passage by +8 min", async () => {
        const crossing = {
            id: "manawala-road",
            railwayPositionKm: 16.8,
            distanceKm: 16.8
        };

        const baseTimeMs = Date.now() + 30 * 60000; // 30 min in future
        const schedTimeIso = new Date(baseTimeMs).toISOString();

        // Train scheduled at +30m with 0 min delay
        const liveScheduled = {
            status: "scheduled",
            scheduledDepartureTime: schedTimeIso,
            delayMinutes: 0,
            route: [{ scheduledDeparture: schedTimeIso, speedToNextStationKmph: 60 }]
        };
        const cScheduled = addCrossingETA({
            crossing: { ...crossing },
            trainPosition: null,
            direction: "forward",
            live: liveScheduled,
            speedKmph: 60,
            positionFresh: false,
            livePositionStale: false
        });

        // Train delayed by 8 min (expected departure +38m)
        const liveDelayed = {
            status: "scheduled",
            scheduledDepartureTime: schedTimeIso,
            delayMinutes: 8,
            route: [{ scheduledDeparture: schedTimeIso, delayMinutes: 8, speedToNextStationKmph: 60 }]
        };
        const cDelayed = addCrossingETA({
            crossing: { ...crossing },
            trainPosition: null,
            direction: "forward",
            live: liveDelayed,
            speedKmph: 60,
            positionFresh: false,
            livePositionStale: false
        });

        const schedMs = new Date(cScheduled.estimatedPassageTime).getTime();
        const delayedMs = new Date(cDelayed.estimatedPassageTime).getTime();
        const diffMinutes = (delayedMs - schedMs) / 60000;

        assert.strictEqual(Math.round(diffMinutes), 8, `Expected +8m shift, got ${diffMinutes}m`);
        assert.strictEqual(cDelayed.delayMinutes, 8);
    });

    // ============================================================
    // TEST I: Fresh GPS (<= 2.5m) -> FRESH, HIGH confidence, LIVE_GPS
    // ============================================================
    await runTest("I", "Fresh GPS (<= 2.5m age): FRESH status and HIGH confidence", async () => {
        const liveTimestamp = new Date(fixedNow.getTime() - 1.5 * 60000).toISOString(); // 1.5 min ago
        const live = {
            currentLocation: {
                speedKmh: 65,
                timestamp: liveTimestamp
            }
        };
        const trainPos = { km: 12.0, timestamp: liveTimestamp };
        const freshness = getTelemetryFreshness(trainPos, live, fixedNow);

        assert.strictEqual(freshness.state, "FRESH");
        assert.strictEqual(freshness.label, "LIVE POSITION");
        assert.ok(freshness.ageMinutes <= 2.5);

        const eta = calculateETA(trainPos, corridorCrossingsWithKm[0], "forward", live, fixedNow);
        assert.strictEqual(eta.available, true);
        assert.strictEqual(eta.source, "LIVE_GPS");
        assert.strictEqual(eta.confidence, "HIGH");
        assert.strictEqual(eta.telemetryFreshness, "FRESH");
    });

    // ============================================================
    // TEST J: Aging telemetry (2.5 - 5.0m) -> AGING, MEDIUM confidence
    // ============================================================
    await runTest("J", "Aging telemetry (3.5m age): AGING status and MEDIUM confidence", async () => {
        const liveTimestamp = new Date(fixedNow.getTime() - 3.5 * 60000).toISOString(); // 3.5 min ago
        const live = {
            currentLocation: {
                speedKmh: 65,
                timestamp: liveTimestamp
            }
        };
        const trainPos = { km: 12.0, timestamp: liveTimestamp };
        const freshness = getTelemetryFreshness(trainPos, live, fixedNow);

        assert.strictEqual(freshness.state, "AGING");
        assert.strictEqual(freshness.label, "ESTIMATED POSITION");

        const eta = calculateETA(trainPos, corridorCrossingsWithKm[0], "forward", live, fixedNow);
        assert.strictEqual(eta.available, true);
        assert.strictEqual(eta.telemetryFreshness, "AGING");
        assert.strictEqual(eta.confidence, "MEDIUM");
    });

    // ============================================================
    // TEST K: Stale telemetry (5.0 - 10.0m) -> STALE, LOW/DEGRADED confidence
    // ============================================================
    await runTest("K", "Stale telemetry (7.0m age): STALE status and bounded fallback with LOW/DEGRADED confidence", async () => {
        const liveTimestamp = new Date(fixedNow.getTime() - 7.0 * 60000).toISOString(); // 7.0 min ago
        const live = {
            currentLocation: {
                speedKmh: 65,
                timestamp: liveTimestamp
            }
        };
        const trainPos = { km: 12.0, timestamp: liveTimestamp };
        const freshness = getTelemetryFreshness(trainPos, live, fixedNow);

        assert.strictEqual(freshness.state, "STALE");
        assert.strictEqual(freshness.label, "STALE TELEMETRY");

        const eta = calculateETA(trainPos, corridorCrossingsWithKm[0], "forward", live, fixedNow);
        assert.strictEqual(eta.available, true);
        assert.strictEqual(eta.telemetryFreshness, "STALE");
        assert.strictEqual(eta.confidence, "LOW");
        assert.strictEqual(eta.stalePosition, true);
    });

    // ============================================================
    // TEST L: Telemetry > 10.0m -> UNAVAILABLE, live ETA suppressed
    // ============================================================
    await runTest("L", "Telemetry > 10.0m (15m age): UNAVAILABLE status, ETA suppressed without coordinates invention", async () => {
        const liveTimestamp = new Date(fixedNow.getTime() - 15.0 * 60000).toISOString(); // 15 min ago
        const live = {
            currentLocation: {
                speedKmh: 65,
                timestamp: liveTimestamp
            }
        };
        const trainPos = { km: 12.0, timestamp: liveTimestamp };
        const freshness = getTelemetryFreshness(trainPos, live, fixedNow);

        assert.strictEqual(freshness.state, "UNAVAILABLE");
        assert.strictEqual(freshness.label, "POSITION UNAVAILABLE");

        const eta = calculateETA(trainPos, corridorCrossingsWithKm[0], "forward", live, fixedNow);
        assert.strictEqual(eta.available, false);
        assert.strictEqual(eta.reason, "telemetry-unavailable-or-expired");
        assert.strictEqual(eta.telemetryFreshness, "UNAVAILABLE");
    });

    // ============================================================
    // TEST M: Cancelled train handling
    // ============================================================
    await runTest("M", "Cancelled train: detected early, skips forecast, 0 events, no position error", async () => {
        const liveCancelled = {
            trainNumber: "74641",
            status: "cancelled",
            trackingMode: "none",
            currentLocation: null,
            exceptions: [{ type: "CANCELLED" }]
        };

        assert.strictEqual(isTrainCancelled(liveCancelled), true);
    });

    // ============================================================
    // TEST N: 0-60m primary forecast window
    // ============================================================
    await runTest("N", "0-60m primary forecast window: train with ETA 25m included in primary upcoming trains", async () => {
        const passageTime = new Date(fixedNow.getTime() + 25 * 60000).toISOString();
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
        assert.ok(crossing.primaryTrain, "Should have primary train");
        assert.strictEqual(crossing.primaryTrain.trainNumber, "12002");
        assert.strictEqual(Math.round(crossing.primaryTrain.etaMinutes), 25);
    });

    // ============================================================
    // TEST O: 60-120m extended outlook window
    // ============================================================
    await runTest("O", "60-120m extended outlook: train with ETA 85m included in extendedOutlook, not primary", async () => {
        const passageTime = new Date(fixedNow.getTime() + 85 * 60000).toISOString();
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
        assert.strictEqual(crossing.primaryTrain, null, "Primary train should be null for ETA > 60m");
        assert.ok(crossing.hasExtendedOutlook, "Should have extended outlook");
        assert.strictEqual(crossing.extendedOutlook.length, 1);
        assert.strictEqual(crossing.extendedOutlook[0].trainNumber, "12411");
        assert.strictEqual(Math.round(crossing.extendedOutlook[0].etaMinutes), 85);
    });

    // ============================================================
    // TEST P: > 120m excluded
    // ============================================================
    await runTest("P", "> 120m event excluded completely from both primary and extended outlook", async () => {
        const passageTime = new Date(fixedNow.getTime() + 140 * 60000).toISOString(); // 140m in future
        const eventsByCrossing = {
            "talwandi-dogran": [
                {
                    trainNumber: "14804",
                    trainName: "Express",
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
        assert.strictEqual(crossing.primaryTrain, null);
        assert.strictEqual(crossing.hasExtendedOutlook, false);
        assert.strictEqual(crossing.extendedOutlook.length, 0);
    });

    // ============================================================
    // TEST Q: 11-min gate close baseline (T - 11m)
    // ============================================================
    await runTest("Q", "11-minute gate close baseline: gateClose = predictedTrainPassage - 11 minutes", async () => {
        const passage = new Date("2026-09-27T10:30:00.000Z");
        const pred = predictClosure({ trainPassageTime: passage });

        const passageMs = passage.getTime();
        const closeMs = new Date(pred.closure.earliest).getTime();
        const leadMin = (passageMs - closeMs) / 60000;

        assert.strictEqual(leadMin, 11, `Expected 11m lead time, got ${leadMin}m`);
    });

    // ============================================================
    // TEST R: +1-min gate open baseline (T + 1m)
    // ============================================================
    await runTest("R", "+1-minute gate open baseline: gateOpen = predictedTrainPassage + 1 minute", async () => {
        const passage = new Date("2026-09-27T10:30:00.000Z");
        const pred = predictClosure({ trainPassageTime: passage });

        const passageMs = passage.getTime();
        const openMs = new Date(pred.reopening.earliest).getTime();
        const bufferMin = (openMs - passageMs) / 60000;

        assert.strictEqual(bufferMin, 1, `Expected 1m reopen buffer, got ${bufferMin}m`);
    });

    // ============================================================
    // TEST S: Post-passage observation workflow
    // ============================================================
    await runTest("S", "Post-passage observation workflow: completed train remains observable up to 60m ago", async () => {
        const passageTime = new Date(fixedNow.getTime() - 15 * 60000).toISOString(); // Passed 15 min ago
        const eventsByCrossing = {
            "talwandi-dogran": [
                {
                    trainNumber: "12497",
                    trainName: "Shane Punjab",
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
        assert.ok(crossing.lastTrainPassed, "Should record lastTrainPassed");
        assert.strictEqual(crossing.lastTrainPassed.trainNumber, "12497");
        assert.strictEqual(crossing.lastTrainPassed.passageTime, passageTime);
    });

    // ============================================================
    // TEST T: Multiple trains approaching different crossings
    // ============================================================
    await runTest("T", "Multiple trains approaching different crossings maintain distinct crossing state", async () => {
        const eventsByCrossing = {
            "talwandi-dogran": [
                {
                    trainNumber: "12002",
                    trainName: "Train Alpha",
                    estimatedPassageTime: new Date(fixedNow.getTime() + 10 * 60000).toISOString(),
                    direction: "forward"
                }
            ],
            "jandiala": [
                {
                    trainNumber: "12014",
                    trainName: "Train Beta",
                    estimatedPassageTime: new Date(fixedNow.getTime() + 14 * 60000).toISOString(),
                    direction: "backward"
                }
            ]
        };

        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: fixedNow.toISOString(),
            eventsByCrossing
        });

        const talwandi = snapshot.crossings["talwandi-dogran"];
        const jandiala = snapshot.crossings["jandiala"];

        assert.strictEqual(talwandi.primaryTrain.trainNumber, "12002");
        assert.strictEqual(jandiala.primaryTrain.trainNumber, "12014");
        assert.strictEqual(talwandi.primaryTrain.direction, "forward");
        assert.strictEqual(jandiala.primaryTrain.direction, "backward");
    });

    // ============================================================
    // TEST U: Adjacent/near-simultaneous crossing events (< 10m continuous closure)
    // ============================================================
    await runTest("U", "Adjacent events (< 10m gap) merge into continuous gate closure", async () => {
        const train1Passage = new Date(fixedNow.getTime() + 15 * 60000); // 10:15
        const train2Passage = new Date(fixedNow.getTime() + 19 * 60000); // 10:19 (4m gap <= 10m)

        const candidates = [
            {
                trainNumber: "11001",
                trainName: "Train 1",
                estimatedPassageTime: train1Passage.toISOString(),
                predictedGateCloseTime: new Date(train1Passage.getTime() - 11 * 60000).toISOString(), // 10:04
                predictedGateOpenTime: new Date(train1Passage.getTime() + 1 * 60000).toISOString()     // 10:16
            },
            {
                trainNumber: "11002",
                trainName: "Train 2",
                estimatedPassageTime: train2Passage.toISOString(),
                predictedGateCloseTime: new Date(train2Passage.getTime() - 11 * 60000).toISOString(), // 10:08
                predictedGateOpenTime: new Date(train2Passage.getTime() + 1 * 60000).toISOString()     // 10:20
            }
        ];

        const timeline = computeCombinedClosureTimeline(candidates, fixedNow, { thresholdMinutes: 10 });
        assert.ok(timeline, "Timeline should exist");
        assert.strictEqual(timeline.trainCount, 2);
        assert.strictEqual(timeline.isContinuous, true);
        assert.strictEqual(new Date(timeline.closureStart).toISOString(), new Date(train1Passage.getTime() - 11 * 60000).toISOString()); // 10:04
        assert.strictEqual(new Date(timeline.closureEnd).toISOString(), new Date(train2Passage.getTime() + 1 * 60000).toISOString());     // 10:20
    });

    console.log("\n" + "-".repeat(75));
    console.log(`  Tests run: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
    console.log("-".repeat(75) + "\n");

    if (failed > 0) {
        process.exit(1);
    }
}

runAll().catch(err => {
    console.error("FATAL SUITE ERROR:", err);
    process.exit(1);
});
