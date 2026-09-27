/**
 * FatakForecast V5 — Bidirectional Route + Cancelled Trains + Extended Forecast Test Suite
 *
 * Verifies all 12 core requirements:
 * 1. Cancelled train detection (mocking 74641 / 12411 live payload) -> skipped, no error thrown
 * 2. Active running train telemetry -> valid ETA, position, and direction
 * 3. Non-cancelled train with missing currentLocation -> throws "Live train position unavailable."
 * 4. Not-started train with departure anchor -> valid direction and origin anchor
 * 5. Forward direction crossing order (Amritsar -> Jandiala) -> Talwandi -> Manawala -> Rakh Devi -> Jandiala
 * 6. Reverse direction crossing order (Jandiala -> Amritsar) -> Jandiala -> Rakh Devi -> Manawala -> Talwandi
 * 7. Reverse train between crossings (e.g. x=19.5km) -> past crossing (Jandiala) excluded
 * 8. Forward train between crossings (e.g. x=17.5km) -> past crossings (Talwandi, Manawala) excluded
 * 9. Direction uncertain handling -> direction: "unknown", confident predictions suppressed
 * 10. 60-min primary vs 120-min extended outlook (0-60m primary, 60-120m extended, >120m excluded)
 * 11. 11-min gate close & +1-min gate open baseline invariants preserved
 * 12. Zero test persistence in production observation files (data/gate-observations.json, matched-events.json)
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");

const {
    isTrainCancelled,
    inferDirectionFromRoute,
    analyzeTrain
} = require("./services/corridor-monitor");

const {
    processTrain
} = require("./services/corridor-engine");

const {
    getDistanceToCrossing,
    isCrossingAhead,
    calculateETA
} = require("./services/eta");

const {
    buildUnifiedSnapshot
} = require("./services/forecast-snapshot");

const {
    BASELINE,
    predictClosure
} = require("./services/closure-predictor");

const {
    V1_CROSSINGS,
    TIMING_CONFIG,
    FORECAST_HORIZON_PRIMARY_MINUTES,
    FORECAST_HORIZON_EXTENDED_MINUTES
} = require("./config/corridor");

console.log("\n" + "=".repeat(75));
console.log("   FATAKFORECAST V5 — BIDIRECTIONAL ROUTE & CANCELLED TRAINS TEST SUITE");
console.log("=".repeat(75) + "\n");

let passed = 0;
let failed = 0;

async function runTest(id, name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ [${String(id).padStart(2, '0')}] ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ❌ [${String(id).padStart(2, '0')}] ${name}`);
        console.error(`     Error: ${err.message}\n${err.stack}`);
    }
}

// Check observations files stats before tests
const observationsPath = path.join(__dirname, "data", "gate-observations.json");
const matchedEventsPath = path.join(__dirname, "data", "matched-events.json");
const obsBeforeSize = fs.existsSync(observationsPath) ? fs.statSync(observationsPath).size : 0;
const matchedBeforeSize = fs.existsSync(matchedEventsPath) ? fs.statSync(matchedEventsPath).size : 0;

// Corridor crossings with physical route kilometre markers along the 12.8km line
const corridorCrossingsWithKm = [
    { id: "talwandi-dogran", name: "Talwandi Dogran Fatak", positionKm: 14.2 },
    { id: "manawala-road", name: "Manawala Road Fatak", positionKm: 16.8 },
    { id: "rakh-devi-dasspura", name: "Rakh Devi Dasspura Fatak", positionKm: 18.3 },
    { id: "jandiala", name: "Jandiala Railway Crossing", positionKm: 20.5 }
];

async function main() {
    // ============================================================
    // 1. CANCELLED TRAIN DETECTION
    // ============================================================
    await runTest(1, "Cancelled train detection: status cancelled or exceptions -> skips forecast without error", async () => {
        // 74641 payload reproduction
        const cancelledPayload1 = {
            trainNumber: "74641",
            trainName: "Jalandhar City - Amritsar DEMU",
            status: "cancelled",
            trackingMode: "none",
            currentLocation: null,
            route: [],
            exceptions: [{ type: "CANCELLED", station: "JUC" }]
        };

        assert.strictEqual(isTrainCancelled(cancelledPayload1), true, "Should detect cancelled status");

        const analysis1 = await analyzeTrain(cancelledPayload1);
        assert.strictEqual(analysis1.isCancelled, true, "Analysis must flag train as cancelled");
        assert.strictEqual(analysis1.crossings.length, 0, "No crossings for cancelled train");

        const engineResult1 = await processTrain(cancelledPayload1);
        assert.strictEqual(engineResult1.isCancelled, true, "Engine must flag train as cancelled");
        assert.strictEqual(engineResult1.success, false, "Must not succeed on cancelled train");
        assert.strictEqual(engineResult1.crossings, 0, "Must create 0 crossing events");

        // 12411 payload reproduction
        const cancelledPayload2 = {
            trainNumber: "12411",
            trainName: "Chandigarh - Amritsar Intercity",
            status: "cancelled",
            trackingMode: "none",
            currentLocation: null,
            route: []
        };

        assert.strictEqual(isTrainCancelled(cancelledPayload2), true, "Should detect status: 'cancelled'");
        const analysis2 = await analyzeTrain(cancelledPayload2);
        assert.strictEqual(analysis2.isCancelled, true);
        assert.strictEqual(analysis2.crossings.length, 0);
    });

    // ============================================================
    // 2. ACTIVE RUNNING TRAIN TELEMETRY
    // ============================================================
    await runTest(2, "Active running train: valid position & route -> resolves direction & calculates ETA", async () => {
        const runningPayload = {
            trainNumber: "12013",
            trainName: "Amritsar Shatabdi Express",
            status: "running",
            trackingMode: "live",
            currentLocation: {
                latitude: 31.61,
                longitude: 74.98,
                speed: 65,
                timestamp: new Date().toISOString()
            },
            route: [
                { stationCode: "ASR", stationName: "Amritsar Jn", hasDeparted: true },
                { stationCode: "MOW", stationName: "Mananwala", hasDeparted: false },
                { stationCode: "JNL", stationName: "Jandiala", hasDeparted: false },
                { stationCode: "BEAS", stationName: "Beas", hasDeparted: false }
            ]
        };

        assert.strictEqual(isTrainCancelled(runningPayload), false, "Running train is not cancelled");
        const dir = inferDirectionFromRoute(runningPayload);
        assert.strictEqual(dir.direction || String(dir), "forward", "Amritsar -> Jandiala route should infer forward direction");

        // Calculate ETA to Talwandi Dogran (km 14.2) from train at km 12.0
        const eta = calculateETA(
            { km: 12.0 },
            { positionKm: 14.2 },
            "forward",
            { status: "running", currentLocation: { speedKmh: 65 } }
        );
        assert.strictEqual(eta.available, true, "ETA must be available for active running train");
        assert.ok(eta.etaMinutes > 0, "ETA minutes must be positive");
    });

    // ============================================================
    // 3. NON-CANCELLED TRAIN WITH MISSING POSITION
    // ============================================================
    await runTest(3, "Non-cancelled train with missing currentLocation -> throws Live train position unavailable", async () => {
        const missingPosPayload = {
            trainNumber: "12345",
            trainName: "Test Express",
            status: "running",
            trackingMode: "live",
            currentLocation: null,
            route: []
        };

        assert.strictEqual(isTrainCancelled(missingPosPayload), false, "Train is not cancelled");
        await assert.rejects(async () => {
            await analyzeTrain(missingPosPayload);
        }, /Live train position unavailable\./, "Must reject with specific missing position error for non-cancelled train");
    });

    // ============================================================
    // 4. NOT-STARTED TRAIN WITH DEPARTURE ANCHOR
    // ============================================================
    await runTest(4, "Not-started train: departure anchor -> resolves direction and station anchor", async () => {
        const notStartedPayload = {
            trainNumber: "14681",
            trainName: "New Delhi - Jalandhar Intercity",
            status: "scheduled",
            trackingMode: "scheduled",
            currentLocation: null,
            route: [
                { stationCode: "ASR", stationName: "Amritsar Jn", scheduledDeparture: "12:00", hasDeparted: false },
                { stationCode: "MOW", stationName: "Mananwala", hasDeparted: false },
                { stationCode: "JNL", stationName: "Jandiala", hasDeparted: false }
            ]
        };

        assert.strictEqual(isTrainCancelled(notStartedPayload), false);
        const dir = inferDirectionFromRoute(notStartedPayload);
        assert.strictEqual(dir.direction || String(dir), "forward", "Origin ASR -> JNL indicates forward direction");
    });

    // ============================================================
    // 5. FORWARD DIRECTION CROSSING ORDER (Amritsar -> Jandiala)
    // ============================================================
    await runTest(5, "Forward direction: crossings ordered Talwandi -> Manawala -> Rakh Devi -> Jandiala", () => {
        // Train at km 12.0 (west of Talwandi Dogran at km 14.2)
        const trainKm = 12.0;
        const dir = "forward";

        const aheadCrossings = corridorCrossingsWithKm.filter(c => isCrossingAhead(trainKm, c, dir));
        assert.strictEqual(aheadCrossings.length, 4, "All 4 crossings must be ahead");

        // Sort ascending by distance
        aheadCrossings.sort((a, b) => getDistanceToCrossing(trainKm, a, dir) - getDistanceToCrossing(trainKm, b, dir));

        const order = aheadCrossings.map(c => c.id);
        assert.deepStrictEqual(order, [
            "talwandi-dogran",
            "manawala-road",
            "rakh-devi-dasspura",
            "jandiala"
        ], "Forward order must be Talwandi -> Manawala -> Rakh Devi -> Jandiala");

        // Verify distance increases monotonically
        const distances = aheadCrossings.map(c => getDistanceToCrossing(trainKm, c, dir));
        for (let i = 0; i < distances.length - 1; i++) {
            assert.ok(distances[i] < distances[i + 1], `Distance ${distances[i]} must be less than next distance ${distances[i + 1]}`);
        }
    });

    // ============================================================
    // 6. REVERSE DIRECTION CROSSING ORDER (Jandiala -> Amritsar)
    // ============================================================
    await runTest(6, "Reverse direction: crossings ordered Jandiala -> Rakh Devi -> Manawala -> Talwandi", () => {
        // Train at km 22.0 (east of Jandiala Crossing at km 20.5, heading backward toward Amritsar)
        const trainKm = 22.0;
        const dir = "backward";

        const aheadCrossings = corridorCrossingsWithKm.filter(c => isCrossingAhead(trainKm, c, dir));
        assert.strictEqual(aheadCrossings.length, 4, "All 4 crossings must be ahead in reverse");

        // Sort by distance to train in reverse direction
        aheadCrossings.sort((a, b) => {
            return getDistanceToCrossing(trainKm, a, dir) - getDistanceToCrossing(trainKm, b, dir);
        });

        const order = aheadCrossings.map(c => c.id);
        assert.deepStrictEqual(order, [
            "jandiala",
            "rakh-devi-dasspura",
            "manawala-road",
            "talwandi-dogran"
        ], "Reverse order must be Jandiala -> Rakh Devi -> Manawala -> Talwandi");

        // Distances must be positive and monotonically increasing
        const distances = aheadCrossings.map(c => getDistanceToCrossing(trainKm, c, dir));
        assert.ok(distances[0] > 0, "First distance must be positive");
        for (let i = 0; i < distances.length - 1; i++) {
            assert.ok(distances[i] < distances[i + 1], `Reverse distance ${distances[i]} must be less than next ${distances[i + 1]}`);
        }
    });

    // ============================================================
    // 7. REVERSE TRAIN BETWEEN CROSSINGS (Past Crossing Excluded)
    // ============================================================
    await runTest(7, "Reverse train between crossings (x=19.5km): Jandiala is behind and excluded", () => {
        // Train at km 19.5 moving backward (Amritsar bound).
        // Jandiala Crossing is at km 20.5 (behind train!)
        // Rakh Devi is at km 18.3 (ahead)
        // Manawala is at km 16.8 (ahead)
        // Talwandi is at km 14.2 (ahead)
        const trainKm = 19.5;
        const dir = "backward";

        // Test getDistanceToCrossing for Jandiala: trainKm (19.5) - crossingKm (20.5) = -1.0 km
        const jandialaCrossing = corridorCrossingsWithKm.find(c => c.id === "jandiala");
        const distJandiala = getDistanceToCrossing(trainKm, jandialaCrossing, dir);
        assert.strictEqual(distJandiala <= 0, true, `Jandiala distance should be <= 0 (got ${distJandiala})`);

        const isJandialaAhead = isCrossingAhead(trainKm, jandialaCrossing, dir);
        assert.strictEqual(isJandialaAhead, false, "Jandiala must NOT be ahead");

        // Ahead crossings must strictly be Rakh Devi, Manawala, Talwandi
        const aheadCrossings = corridorCrossingsWithKm
            .filter(c => isCrossingAhead(trainKm, c, dir))
            .sort((a, b) => getDistanceToCrossing(trainKm, a, dir) - getDistanceToCrossing(trainKm, b, dir));

        const order = aheadCrossings.map(c => c.id);
        assert.deepStrictEqual(order, [
            "rakh-devi-dasspura",
            "manawala-road",
            "talwandi-dogran"
        ], "Past crossing 'jandiala' must be excluded; remaining in correct order");
    });

    // ============================================================
    // 8. FORWARD TRAIN BETWEEN CROSSINGS (Past Crossings Excluded)
    // ============================================================
    await runTest(8, "Forward train between crossings (x=17.5km): Talwandi & Manawala behind and excluded", () => {
        // Train at km 17.5 moving forward (Jandiala bound).
        // Talwandi (14.2) and Manawala (16.8) are behind train.
        // Rakh Devi (18.3) and Jandiala (20.5) are ahead.
        const trainKm = 17.5;
        const dir = "forward";

        const talwandiCrossing = corridorCrossingsWithKm.find(c => c.id === "talwandi-dogran");
        const manawalaCrossing = corridorCrossingsWithKm.find(c => c.id === "manawala-road");

        const distTalwandi = getDistanceToCrossing(trainKm, talwandiCrossing, dir);
        const distManawala = getDistanceToCrossing(trainKm, manawalaCrossing, dir);

        assert.strictEqual(distTalwandi <= 0, true, "Talwandi should have negative distance");
        assert.strictEqual(distManawala <= 0, true, "Manawala should have negative distance");

        const aheadCrossings = corridorCrossingsWithKm
            .filter(c => isCrossingAhead(trainKm, c, dir))
            .sort((a, b) => getDistanceToCrossing(trainKm, a, dir) - getDistanceToCrossing(trainKm, b, dir));

        const order = aheadCrossings.map(c => c.id);
        assert.deepStrictEqual(order, [
            "rakh-devi-dasspura",
            "jandiala"
        ], "Past crossings 'talwandi-dogran' and 'manawala-road' must be excluded");
    });

    // ============================================================
    // 9. DIRECTION UNCERTAIN HANDLING
    // ============================================================
    await runTest(9, "Direction uncertain: handles unknown direction cleanly and suppresses predictions", () => {
        const uncertainPayload = {
            trainNumber: "99999",
            trainName: "Uncertain Express",
            status: "running",
            trackingMode: "live",
            currentLocation: {
                latitude: 31.63,
                longitude: 74.98,
                speed: 0
            },
            route: [] // No station indicators
        };

        const dir = inferDirectionFromRoute(uncertainPayload);
        assert.strictEqual(dir.direction || String(dir), "unknown", "Direction should be unknown");

        // Verify ETA engine refuses unknown direction
        const eta = calculateETA({ km: 15 }, { positionKm: 18 }, "unknown", { status: "running" });
        assert.strictEqual(eta.available, false, "Unknown direction must suppress ETA calculations");
    });

    // ============================================================
    // 10. 60-MIN PRIMARY VS 120-MIN EXTENDED OUTLOOK
    // ============================================================
    await runTest(10, "Extended forecast: 0-60m primary vs 60-120m extended outlook vs >120m excluded", () => {
        assert.strictEqual(FORECAST_HORIZON_PRIMARY_MINUTES, 60);
        assert.strictEqual(FORECAST_HORIZON_EXTENDED_MINUTES, 120);

        const now = Date.now();
        const eventPrimary = {
            crossingId: "talwandi-dogran",
            trainNumber: "12013",
            trainName: "Shatabdi Express",
            direction: "forward",
            estimatedPassageTime: new Date(now + 25 * 60000).toISOString(),
            predictedGateCloseTime: new Date(now + 14 * 60000).toISOString(),
            predictedGateOpenTime: new Date(now + 26 * 60000).toISOString(),
            etaMinutes: 25
        };

        const eventExtended = {
            crossingId: "talwandi-dogran",
            trainNumber: "12459",
            trainName: "New Delhi Intercity",
            direction: "forward",
            estimatedPassageTime: new Date(now + 75 * 60000).toISOString(),
            predictedGateCloseTime: new Date(now + 64 * 60000).toISOString(),
            predictedGateOpenTime: new Date(now + 76 * 60000).toISOString(),
            etaMinutes: 75
        };

        const eventTooFar = {
            crossingId: "talwandi-dogran",
            trainNumber: "14681",
            trainName: "Far Out Train",
            direction: "forward",
            estimatedPassageTime: new Date(now + 140 * 60000).toISOString(),
            predictedGateCloseTime: new Date(now + 129 * 60000).toISOString(),
            predictedGateOpenTime: new Date(now + 141 * 60000).toISOString(),
            etaMinutes: 140
        };

        const snapshot = buildUnifiedSnapshot({
            eventsByCrossing: {
                "talwandi-dogran": [eventPrimary, eventExtended, eventTooFar]
            }
        });
        assert.strictEqual(snapshot.extendedHorizonMinutes, 120);

        const talwandi = snapshot.crossings["talwandi-dogran"];
        assert.ok(talwandi, "Talwandi crossing must exist in snapshot");

        // Primary train is eventPrimary (within 60m)
        assert.strictEqual(talwandi.primaryTrain?.trainNumber, "12013");

        // Extended outlook contains eventExtended (60-120m)
        assert.strictEqual(talwandi.hasExtendedOutlook, true);
        assert.strictEqual(talwandi.extendedOutlook.length, 1);
        assert.strictEqual(talwandi.extendedOutlook[0].trainNumber, "12459");

        // eventTooFar (> 120m) must not be anywhere
        const allNums = [
            talwandi.primaryTrain?.trainNumber,
            ...(talwandi.subsequentTrains || []).map(t => t.trainNumber),
            ...(talwandi.extendedOutlook || []).map(t => t.trainNumber)
        ];
        assert.strictEqual(allNums.includes("14681"), false, "Train > 120m must be excluded");
    });

    // ============================================================
    // 11. 11-MIN GATE CLOSE & +1-MIN GATE OPEN BASELINE INVARIANTS
    // ============================================================
    await runTest(11, "Baseline invariants: gateClose = Tp - 11m, gateOpen = Tp + 1m", () => {
        assert.strictEqual(BASELINE.closureLeadMinutes, 11, "Baseline close lead must be 11 min");
        assert.strictEqual(BASELINE.reopenDelayMinutes, 1, "Baseline open lag must be 1 min");

        const passageTime = new Date(Date.now() + 30 * 60000).toISOString();
        const passageMs = new Date(passageTime).getTime();

        const pred = predictClosure({
            crossingId: "talwandi-dogran",
            direction: "forward",
            trainPassageTime: passageTime,
            etaMinutes: 30
        });

        const closeMs = new Date(pred.closure.earliest).getTime();
        const openMs = new Date(pred.reopening.latest).getTime();

        const leadMin = (passageMs - closeMs) / 60000;
        const lagMin = (openMs - passageMs) / 60000;

        assert.strictEqual(leadMin, 11, "Predicted close must be exactly 11 minutes prior to passage");
        assert.strictEqual(lagMin, 1, "Predicted open must be exactly 1 minute after passage");
        assert.strictEqual((openMs - closeMs) / 60000, 12, "Total gate closure window must be 12 minutes");
    });

    // ============================================================
    // 12. DETERMINISTIC FIXTURES & ZERO INFILTRATION
    // ============================================================
    await runTest(12, "Zero infiltration: in-memory simulation fixtures never mutate production data files", () => {
        const obsAfterSize = fs.existsSync(observationsPath) ? fs.statSync(observationsPath).size : 0;
        const matchedAfterSize = fs.existsSync(matchedEventsPath) ? fs.statSync(matchedEventsPath).size : 0;

        assert.strictEqual(obsBeforeSize, obsAfterSize, "gate-observations.json size must not change during tests");
        assert.strictEqual(matchedBeforeSize, matchedAfterSize, "matched-events.json size must not change during tests");
    });

    console.log("\n" + "-".repeat(75));
    console.log(`  Tests run: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
    console.log("-".repeat(75) + "\n");

    if (failed > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
