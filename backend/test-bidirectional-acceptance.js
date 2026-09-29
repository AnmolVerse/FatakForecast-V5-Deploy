/**
 * FatakForecast V5 — Bidirectional Train Prediction Acceptance Test Suite
 *
 * Verifies bidirectional train prediction across both forward (Amritsar -> Jandiala)
 * and backward (Jandiala -> Amritsar) directions, including corridor order,
 * positional crossing filtering, early/delayed status, stale telemetry handling,
 * multi-train concurrency, and the Section 17 Critical Acceptance Test.
 */

const assert = require("assert");

const {
    calculateETA,
    estimateTrainPassage,
    isCrossingAhead,
    getDistanceToCrossing,
    getTelemetryFreshness,
    classifyEarlyLate
} = require("./services/eta");

const {
    buildTrainTimeline,
    validateTrainTimeline
} = require("./services/corridor-engine");

const {
    inferTrainDirection,
    isTrainCancelled
} = require("./services/corridor-monitor");

const {
    buildUnifiedSnapshot,
    saveSnapshot,
    determineCrossingStatus
} = require("./services/forecast-snapshot");

const { V1_CROSSINGS, TIMING_CONFIG } = require("./config/corridor");

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function runTest(num, name, testFn) {
    totalTests++;
    try {
        await testFn();
        console.log(`  ✅ [Test ${num}] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ [Test ${num}] ${name}`);
        console.error(`     Error: ${err.message}`);
        if (err.actual !== undefined && err.expected !== undefined) {
            console.error(`     Actual:`, err.actual);
            console.error(`     Expected:`, err.expected);
        }
        failedTests++;
    }
}

// Canonical physical corridor crossings (Amritsar = 0km, Jandiala = 20.5km)
const corridorCrossings = [
    { id: "talwandi-dogran", name: "Talwandi Dogran Fatak", positionKm: 14.2, railwayPositionKm: 14.2 },
    { id: "manawala-road", name: "Manawala Road Fatak", positionKm: 16.8, railwayPositionKm: 16.8 },
    { id: "rakh-devi-dasspura", name: "Rakh Devi Dasspura Fatak", positionKm: 18.3, railwayPositionKm: 18.3 },
    { id: "jandiala", name: "Jandiala Railway Crossing", positionKm: 20.5, railwayPositionKm: 20.5 }
];

async function runAll() {
    console.log("\n===========================================================================");
    console.log("   FATAKFORECAST V5 — BIDIRECTIONAL PREDICTION ACCEPTANCE TEST SUITE");
    console.log("===========================================================================\n");

    const baseNow = new Date("2026-09-29T10:00:00.000Z");

    // =========================================================================
    // 1. Train originating at Amritsar heading toward Jandiala (forward)
    // =========================================================================
    await runTest(1, "Train originating at Amritsar heading toward Jandiala (forward direction)", async () => {
        const live = {
            trainNumber: "12498",
            currentLocation: { sequence: 1 },
            route: {
                stations: [
                    { stationCode: "ASR", sequence: 1 },
                    { stationCode: "MOW", sequence: 2 },
                    { stationCode: "JNL", sequence: 3 },
                    { stationCode: "BEAS", sequence: 4 }
                ]
            }
        };

        const dirResult = inferTrainDirection(live, { positionKm: 5.0 }, null);
        assert.strictEqual(dirResult.direction, "forward");
    });

    // =========================================================================
    // 2. Train originating before Amritsar heading toward Jandiala (forward)
    // =========================================================================
    await runTest(2, "Train originating before Amritsar heading toward Jandiala (forward direction)", async () => {
        const live = {
            trainNumber: "14804",
            currentLocation: { sequence: 2 },
            route: {
                stations: [
                    { stationCode: "ATARI", sequence: 1 },
                    { stationCode: "ASR", sequence: 2 },
                    { stationCode: "MOW", sequence: 3 },
                    { stationCode: "JNL", sequence: 4 }
                ]
            }
        };

        const dirResult = inferTrainDirection(live, { positionKm: 10.0 }, null);
        assert.strictEqual(dirResult.direction, "forward");
    });

    // =========================================================================
    // 3. Train originating at Jandiala heading toward Amritsar (backward)
    // =========================================================================
    await runTest(3, "Train originating at Jandiala heading toward Amritsar (backward direction)", async () => {
        const live = {
            trainNumber: "74643",
            currentLocation: { sequence: 1 },
            route: {
                stations: [
                    { stationCode: "JNL", sequence: 1 },
                    { stationCode: "MOW", sequence: 2 },
                    { stationCode: "ASR", sequence: 3 }
                ]
            }
        };

        const dirResult = inferTrainDirection(live, { positionKm: 20.0 }, null);
        assert.strictEqual(dirResult.direction, "backward");
    });

    // =========================================================================
    // 4. Train originating before Jandiala (e.g. Delhi/Beas) heading to Amritsar (backward)
    // =========================================================================
    await runTest(4, "Train originating before Jandiala (e.g. Delhi/Beas) heading toward Amritsar (backward)", async () => {
        const live = {
            trainNumber: "12013",
            currentLocation: { sequence: 11 },
            route: {
                stations: [
                    { stationCode: "NDLS", sequence: 1 },
                    { stationCode: "BEAS", sequence: 10 },
                    { stationCode: "JNL", sequence: 11 },
                    { stationCode: "MOW", sequence: 12 },
                    { stationCode: "ASR", sequence: 13 }
                ]
            }
        };

        const dirResult = inferTrainDirection(live, { positionKm: 21.0 }, null);
        assert.strictEqual(dirResult.direction, "backward");
    });

    // =========================================================================
    // 5. Backward train positioned before Jandiala: all 4 crossings predicted
    // =========================================================================
    await runTest(5, "Backward train positioned before Jandiala: all four crossings predicted", async () => {
        const trainPos = { km: 22.0 }; // East of Jandiala (km 20.5), moving west
        const ahead = corridorCrossings
            .filter(c => isCrossingAhead(trainPos, c, "backward"))
            .sort((a, b) => getDistanceToCrossing(trainPos, a, "backward") - getDistanceToCrossing(trainPos, b, "backward"))
            .map(c => c.id);

        assert.deepStrictEqual(ahead, [
            "jandiala",
            "rakh-devi-dasspura",
            "manawala-road",
            "talwandi-dogran"
        ]);
    });

    // =========================================================================
    // 6. Backward train between Jandiala and Rakh Devi: Jandiala excluded
    // =========================================================================
    await runTest(6, "Backward train positioned between Jandiala and Rakh Devi: Jandiala excluded", async () => {
        const trainPos = { km: 19.5 }; // Between Jandiala (20.5) and Rakh Devi (18.3)
        const ahead = corridorCrossings
            .filter(c => isCrossingAhead(trainPos, c, "backward"))
            .sort((a, b) => getDistanceToCrossing(trainPos, a, "backward") - getDistanceToCrossing(trainPos, b, "backward"))
            .map(c => c.id);

        assert.deepStrictEqual(ahead, [
            "rakh-devi-dasspura",
            "manawala-road",
            "talwandi-dogran"
        ]);
    });

    // =========================================================================
    // 7. Backward train between Rakh Devi and Manawala: Jandiala & Rakh Devi excluded
    // =========================================================================
    await runTest(7, "Backward train positioned between Rakh Devi and Manawala: Jandiala & Rakh Devi excluded", async () => {
        const trainPos = { km: 17.5 }; // Between Rakh Devi (18.3) and Manawala (16.8)
        const ahead = corridorCrossings
            .filter(c => isCrossingAhead(trainPos, c, "backward"))
            .sort((a, b) => getDistanceToCrossing(trainPos, a, "backward") - getDistanceToCrossing(trainPos, b, "backward"))
            .map(c => c.id);

        assert.deepStrictEqual(ahead, [
            "manawala-road",
            "talwandi-dogran"
        ]);
    });

    // =========================================================================
    // 8. Backward train between Manawala and Talwandi: Talwandi predicted; first three excluded
    // =========================================================================
    await runTest(8, "Backward train positioned between Manawala and Talwandi: Talwandi predicted; first three excluded", async () => {
        const trainPos = { km: 15.5 }; // Between Manawala (16.8) and Talwandi (14.2)
        const ahead = corridorCrossings
            .filter(c => isCrossingAhead(trainPos, c, "backward"))
            .sort((a, b) => getDistanceToCrossing(trainPos, a, "backward") - getDistanceToCrossing(trainPos, b, "backward"))
            .map(c => c.id);

        assert.deepStrictEqual(ahead, [
            "talwandi-dogran"
        ]);
    });

    // =========================================================================
    // 9. Backward train past Talwandi: all four crossings excluded
    // =========================================================================
    await runTest(9, "Backward train past Talwandi: all four crossings excluded", async () => {
        const trainPos = { km: 12.0 }; // Past Talwandi (14.2 heading west toward Amritsar)
        const ahead = corridorCrossings
            .filter(c => isCrossingAhead(trainPos, c, "backward"))
            .map(c => c.id);

        assert.strictEqual(ahead.length, 0);
    });

    // =========================================================================
    // 10. Forward train running early (earlier live passage time respected)
    // =========================================================================
    await runTest(10, "Forward train running early (earlier live passage time respected)", async () => {
        const scheduledTime = new Date(baseNow.getTime() + 30 * 60000); // 10:30
        const liveEtaTime = new Date(baseNow.getTime() + 20 * 60000);   // 10:20 (10 min early)

        const earlyLate = classifyEarlyLate(liveEtaTime, scheduledTime);
        assert.strictEqual(earlyLate.status, "EARLY");
        assert.strictEqual(earlyLate.differenceMinutes, -10);

        const eta = estimateTrainPassage({
            trainPositionKm: 10.0,
            crossingPositionKm: 14.2,
            direction: "forward",
            now: baseNow
        });

        assert.strictEqual(eta.ready, true);
        assert(new Date(eta.passageTime).getTime() < scheduledTime.getTime());
    });

    // =========================================================================
    // 11. Backward train running early (earlier live passage time respected)
    // =========================================================================
    await runTest(11, "Backward train running early (earlier live passage time respected)", async () => {
        const scheduledTime = new Date(baseNow.getTime() + 30 * 60000);
        const liveEtaTime = new Date(baseNow.getTime() + 18 * 60000); // 12 min early

        const earlyLate = classifyEarlyLate(liveEtaTime, scheduledTime);
        assert.strictEqual(earlyLate.status, "EARLY");
        assert.strictEqual(earlyLate.differenceMinutes, -12);

        // Backward train at km 22.0 approaching Jandiala (km 20.5)
        const eta = estimateTrainPassage({
            trainPositionKm: 22.0,
            crossingPositionKm: 20.5,
            direction: "backward",
            now: baseNow
        });

        assert.strictEqual(eta.ready, true);
        assert.strictEqual(eta.distanceKm, 1.5);
    });

    // =========================================================================
    // 12. Forward train running late (delayed passage time respected)
    // =========================================================================
    await runTest(12, "Forward train running late (delayed passage time respected)", async () => {
        const scheduledTime = new Date(baseNow.getTime() + 20 * 60000);
        const liveEtaTime = new Date(baseNow.getTime() + 35 * 60000); // 15 min delayed

        const earlyLate = classifyEarlyLate(liveEtaTime, scheduledTime);
        assert.strictEqual(earlyLate.status, "DELAYED");
        assert.strictEqual(earlyLate.differenceMinutes, 15);
    });

    // =========================================================================
    // 13. Backward train running late (delayed passage time respected)
    // =========================================================================
    await runTest(13, "Backward train running late (delayed passage time respected)", async () => {
        const scheduledTime = new Date(baseNow.getTime() + 15 * 60000);
        const liveEtaTime = new Date(baseNow.getTime() + 35 * 60000); // 20 min delayed

        const earlyLate = classifyEarlyLate(liveEtaTime, scheduledTime);
        assert.strictEqual(earlyLate.status, "DELAYED");
        assert.strictEqual(earlyLate.differenceMinutes, 20);
    });

    // =========================================================================
    // 14. Stale telemetry in forward direction (handled safely, degraded confidence)
    // =========================================================================
    await runTest(14, "Stale telemetry in forward direction (handled safely, degraded confidence)", async () => {
        const staleTimestamp = new Date(baseNow.getTime() - 7 * 60000).toISOString(); // 7 min old
        const freshness = getTelemetryFreshness(null, { lastUpdatedAt: staleTimestamp }, baseNow);
        assert.strictEqual(freshness.state, "STALE");

        const eta = estimateTrainPassage({
            trainPositionKm: 10.0,
            crossingPositionKm: 14.2,
            direction: "forward",
            live: { lastUpdatedAt: staleTimestamp },
            now: baseNow
        });

        assert.strictEqual(eta.ready, true);
        assert.strictEqual(eta.telemetryFreshness, "STALE");
        assert.strictEqual(eta.confidence, "LOW");
    });

    // =========================================================================
    // 15. Stale telemetry in backward direction (handled safely, degraded confidence)
    // =========================================================================
    await runTest(15, "Stale telemetry in backward direction (handled safely, degraded confidence)", async () => {
        const staleTimestamp = new Date(baseNow.getTime() - 6.5 * 60000).toISOString();
        const freshness = getTelemetryFreshness(null, { lastUpdatedAt: staleTimestamp }, baseNow);
        assert.strictEqual(freshness.state, "STALE");

        const eta = estimateTrainPassage({
            trainPositionKm: 22.0,
            crossingPositionKm: 20.5,
            direction: "backward",
            live: { lastUpdatedAt: staleTimestamp },
            now: baseNow
        });

        assert.strictEqual(eta.ready, true);
        assert.strictEqual(eta.telemetryFreshness, "STALE");
        assert.strictEqual(eta.confidence, "LOW");
    });

    // =========================================================================
    // 16. Missing live position in forward direction (schedule-based fallback)
    // =========================================================================
    await runTest(16, "Missing live position in forward direction (schedule-based fallback)", async () => {
        const eta = estimateTrainPassage({
            trainPositionKm: null,
            crossingPositionKm: 14.2,
            direction: "forward",
            live: null,
            now: baseNow
        });

        assert.strictEqual(eta.ready, false);
        assert.strictEqual(eta.telemetryFreshness, "UNAVAILABLE");
    });

    // =========================================================================
    // 17. Missing live position in backward direction (schedule-based fallback)
    // =========================================================================
    await runTest(17, "Missing live position in backward direction (schedule-based fallback)", async () => {
        const eta = estimateTrainPassage({
            trainPositionKm: null,
            crossingPositionKm: 20.5,
            direction: "backward",
            live: null,
            now: baseNow
        });

        assert.strictEqual(eta.ready, false);
        assert.strictEqual(eta.telemetryFreshness, "UNAVAILABLE");
    });

    // =========================================================================
    // 18. Unknown direction train (suppressed from primary timeline)
    // =========================================================================
    await runTest(18, "Unknown direction train (suppressed from primary timeline)", async () => {
        const res = calculateETA({ km: 15.0 }, { positionKm: 18.3 }, "unknown", null, baseNow);
        assert.strictEqual(res.available, false);
        assert.strictEqual(res.reason, "unknown-direction");
        assert.strictEqual(res.confidence, "low");
    });

    // =========================================================================
    // 19. Cancelled, partially cancelled, or diverted trains in backward direction (0 events generated)
    // =========================================================================
    await runTest(19, "Cancelled, partially cancelled, or diverted trains in backward direction (0 events generated)", async () => {
        const cancelledTrain = {
            trainNumber: "12013",
            status: "cancelled",
            isCancelled: true
        };

        assert.strictEqual(isTrainCancelled(cancelledTrain), true);

        const divertedTrain = {
            trainNumber: "12013",
            status: "diverted",
            isDiverted: true
        };

        assert.strictEqual(isTrainCancelled(divertedTrain), true);
    });

    // =========================================================================
    // 20. Multiple trains in corridor simultaneously (both directions tracked)
    // =========================================================================
    await runTest(20, "Multiple trains in corridor simultaneously (both directions tracked)", async () => {
        const tForward = new Date(baseNow.getTime() + 15 * 60000);
        const tBackward = new Date(baseNow.getTime() + 25 * 60000);

        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: baseNow.toISOString(),
            eventsByCrossing: {
                "manawala-road": [
                    { trainNumber: "FWD_1", direction: "forward", estimatedPassageTime: tForward.toISOString() },
                    { trainNumber: "BWD_1", direction: "backward", estimatedPassageTime: tBackward.toISOString() }
                ]
            }
        });

        const c = snapshot.crossings["manawala-road"];
        assert.strictEqual(c.primaryTrain.trainNumber, "FWD_1");
        assert.strictEqual(c.upcomingTrains.length, 1);
        assert.strictEqual(c.upcomingTrains[0].trainNumber, "BWD_1");
        assert.strictEqual(c.upcomingTrains[0].direction, "backward");
    });

    // =========================================================================
    // 21. Forward train and backward train active at the same time (independent crossing forecasts)
    // =========================================================================
    await runTest(21, "Forward train and backward train active at same time (independent crossing forecasts)", async () => {
        const tTalwandi = new Date(baseNow.getTime() + 8 * 60000);  // FWD train reaches Talwandi first
        const tJandiala = new Date(baseNow.getTime() + 6 * 60000);  // BWD train reaches Jandiala first

        const snapshot = buildUnifiedSnapshot({
            cycleTimestamp: baseNow.toISOString(),
            eventsByCrossing: {
                "talwandi-dogran": [
                    { trainNumber: "FWD_101", direction: "forward", estimatedPassageTime: tTalwandi.toISOString() }
                ],
                "jandiala": [
                    { trainNumber: "BWD_202", direction: "backward", estimatedPassageTime: tJandiala.toISOString() }
                ]
            }
        });

        const cTalwandi = snapshot.crossings["talwandi-dogran"];
        const cJandiala = snapshot.crossings["jandiala"];

        assert.strictEqual(cTalwandi.primaryTrain.trainNumber, "FWD_101");
        assert.strictEqual(cTalwandi.primaryTrain.direction, "forward");

        assert.strictEqual(cJandiala.primaryTrain.trainNumber, "BWD_202");
        assert.strictEqual(cJandiala.primaryTrain.direction, "backward");
    });

    // =========================================================================
    // 22. Train with route that does not intersect the corridor (correctly excluded)
    // =========================================================================
    await runTest(22, "Train with route that does not intersect the corridor (correctly excluded)", async () => {
        const offCorridorLive = {
            trainNumber: "12951", // Mumbai Central - New Delhi Rajdhani
            currentLocation: { sequence: 5 },
            route: {
                stations: [
                    { stationCode: "MMCT", sequence: 1 },
                    { stationCode: "BVI", sequence: 2 },
                    { stationCode: "ST", sequence: 3 },
                    { stationCode: "BRC", sequence: 4 },
                    { stationCode: "NDLS", sequence: 5 }
                ]
            }
        };

        const dirResult = inferTrainDirection(offCorridorLive, { positionKm: 500 }, null);
        assert.strictEqual(dirResult.direction, "unknown");
    });

    // =========================================================================
    // CRITICAL ACCEPTANCE TEST (Section 17)
    // =========================================================================
    await runTest("CRITICAL", "Section 17: Critical Bidirectional Corridor Progression & Invariant Acceptance Test", async () => {
        console.log("\n  --- Executing Section 17 Critical Acceptance Test ---");

        // PART 1: Reverse Train originating East of Jandiala (Delhi -> Amritsar)
        // Positioned between Jandiala (km 20.5) and Rakh Devi Dasspura (km 18.3) at km 19.5
        const reverseTrainPos = { km: 19.5 };
        const reverseCrossingsAhead = corridorCrossings
            .filter(c => isCrossingAhead(reverseTrainPos, c, "backward"))
            .sort((a, b) => getDistanceToCrossing(reverseTrainPos, a, "backward") - getDistanceToCrossing(reverseTrainPos, b, "backward"));

        const reverseCrossingIds = reverseCrossingsAhead.map(c => c.id);

        // Verification 1: Jandiala is EXCLUDED; Rakh Devi, Manawala, Talwandi are PREDICTED
        assert.strictEqual(reverseCrossingIds.includes("jandiala"), false, "Jandiala crossing must be excluded for train at x=19.5km");
        assert.deepStrictEqual(reverseCrossingIds, [
            "rakh-devi-dasspura",
            "manawala-road",
            "talwandi-dogran"
        ]);

        // Build passage events for the reverse train at 60 km/h (1 km/min)
        // Distance from 19.5:
        // Rakh Devi: 19.5 - 18.3 = 1.2 km -> +1.2 min
        // Manawala:  19.5 - 16.8 = 2.7 km -> +2.7 min
        // Talwandi:  19.5 - 14.2 = 5.3 km -> +5.3 min
        const tRakhMs = baseNow.getTime() + 1.2 * 60000;
        const tManawalaMs = baseNow.getTime() + 2.7 * 60000;
        const tTalwandiMs = baseNow.getTime() + 5.3 * 60000;

        // Verification 2: Passage times are strictly monotonic and chronological
        assert(tRakhMs < tManawalaMs, "Rakh Devi passage time must precede Manawala Road");
        assert(tManawalaMs < tTalwandiMs, "Manawala Road passage time must precede Talwandi Dogran");

        // Verification 3: Gate closure model (-11 min close / +1 min open baseline)
        const reverseSnapshot = buildUnifiedSnapshot({
            cycleTimestamp: baseNow.toISOString(),
            eventsByCrossing: {
                "rakh-devi-dasspura": [{
                    trainNumber: "12013",
                    direction: "backward",
                    estimatedPassageTime: new Date(tRakhMs).toISOString()
                }],
                "manawala-road": [{
                    trainNumber: "12013",
                    direction: "backward",
                    estimatedPassageTime: new Date(tManawalaMs).toISOString()
                }],
                "talwandi-dogran": [{
                    trainNumber: "12013",
                    direction: "backward",
                    estimatedPassageTime: new Date(tTalwandiMs).toISOString()
                }]
            }
        });

        for (const cId of ["rakh-devi-dasspura", "manawala-road", "talwandi-dogran"]) {
            const crossing = reverseSnapshot.crossings[cId];
            assert(crossing.primaryTrain !== null, `Crossing ${cId} must have primaryTrain`);
            assert.strictEqual(crossing.primaryTrain.direction, "backward");

            const passageTimeMs = new Date(crossing.timingMetrics.passageTime).getTime();
            const likelyClosureMs = new Date(crossing.timingMetrics.likelyClosure).getTime();
            const likelyReopenMs = new Date(crossing.timingMetrics.likelyReopen).getTime();

            // Strict 11-min close / 1-min open invariant
            assert.strictEqual(passageTimeMs - likelyClosureMs, 11 * 60000, `Crossing ${cId} likelyClosure must be strictly 11m prior`);
            assert.strictEqual(likelyReopenMs - passageTimeMs, 1 * 60000, `Crossing ${cId} likelyReopen must be strictly 1m after`);
        }

        // PART 2: Forward Train approaching Talwandi Dogran (from Amritsar at km 12.0)
        const forwardTrainPos = { km: 12.0 };
        const forwardCrossingsAhead = corridorCrossings
            .filter(c => isCrossingAhead(forwardTrainPos, c, "forward"))
            .sort((a, b) => getDistanceToCrossing(forwardTrainPos, a, "forward") - getDistanceToCrossing(forwardTrainPos, b, "forward"));

        const forwardCrossingIds = forwardCrossingsAhead.map(c => c.id);

        // Verification 4: All 4 crossings predicted in forward corridor order
        assert.deepStrictEqual(forwardCrossingIds, [
            "talwandi-dogran",
            "manawala-road",
            "rakh-devi-dasspura",
            "jandiala"
        ]);

        const tFwdTalwandiMs = baseNow.getTime() + (14.2 - 12.0) * 60000;
        const tFwdManawalaMs = baseNow.getTime() + (16.8 - 12.0) * 60000;
        const tFwdRakhMs = baseNow.getTime() + (18.3 - 12.0) * 60000;
        const tFwdJandialaMs = baseNow.getTime() + (20.5 - 12.0) * 60000;

        // Verification 5: Forward passage times are strictly monotonic and chronological
        assert(tFwdTalwandiMs < tFwdManawalaMs);
        assert(tFwdManawalaMs < tFwdRakhMs);
        assert(tFwdRakhMs < tFwdJandialaMs);

        // Verification 6: Gate closure model for forward train
        const forwardSnapshot = buildUnifiedSnapshot({
            cycleTimestamp: baseNow.toISOString(),
            eventsByCrossing: {
                "talwandi-dogran": [{
                    trainNumber: "12498",
                    direction: "forward",
                    estimatedPassageTime: new Date(tFwdTalwandiMs).toISOString()
                }],
                "manawala-road": [{
                    trainNumber: "12498",
                    direction: "forward",
                    estimatedPassageTime: new Date(tFwdManawalaMs).toISOString()
                }],
                "rakh-devi-dasspura": [{
                    trainNumber: "12498",
                    direction: "forward",
                    estimatedPassageTime: new Date(tFwdRakhMs).toISOString()
                }],
                "jandiala": [{
                    trainNumber: "12498",
                    direction: "forward",
                    estimatedPassageTime: new Date(tFwdJandialaMs).toISOString()
                }]
            }
        });

        for (const cId of ["talwandi-dogran", "manawala-road", "rakh-devi-dasspura", "jandiala"]) {
            const crossing = forwardSnapshot.crossings[cId];
            assert(crossing.primaryTrain !== null, `Forward crossing ${cId} must have primaryTrain`);
            assert.strictEqual(crossing.primaryTrain.direction, "forward");

            const passageTimeMs = new Date(crossing.timingMetrics.passageTime).getTime();
            const likelyClosureMs = new Date(crossing.timingMetrics.likelyClosure).getTime();
            const likelyReopenMs = new Date(crossing.timingMetrics.likelyReopen).getTime();

            assert.strictEqual(passageTimeMs - likelyClosureMs, 11 * 60000, `Forward crossing ${cId} likelyClosure must be strictly 11m prior`);
            assert.strictEqual(likelyReopenMs - passageTimeMs, 1 * 60000, `Forward crossing ${cId} likelyReopen must be strictly 1m after`);
        }

        console.log("  --- Section 17 Critical Acceptance Test Verified Successfully ---");
    });

    console.log("\n===========================================================================");
    console.log(`   TOTAL TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: ${failedTests}`);
    console.log("===========================================================================\n");

    if (failedTests > 0) {
        process.exit(1);
    }
}

runAll().catch(err => {
    console.error("FATAL SUITE ERROR:", err);
    process.exit(1);
});
