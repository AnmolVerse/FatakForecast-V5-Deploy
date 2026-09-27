/**
 * FATAKFORECAST — DELAYED TRAIN SCHEDULE TEST SUITE
 * 
 * Verifies that delayed trains that have not started or are running behind schedule
 * calculate their crossing passage, ETA, and gate closure timeline based on the
 * delayed schedule rather than original timetable departure.
 */

const assert = require("assert");

// Import modules under test
const {
    getDepartureTime,
    getArrivalTime,
    getDelayMinutes,
    derivePassageFromDistance
} = require("./services/corridor-engine");

const {
    getTrainSpeed
} = require("./services/corridor-monitor");

const {
    determineCrossingStatus,
    buildUnifiedSnapshot
} = require("./services/forecast-snapshot");

console.log("\n============================================================");
console.log("   FATAKFORECAST — DELAYED TRAIN TEST SUITE (10 TESTS)");
console.log("============================================================\n");

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✅ [${String(passed).padStart(2, '0')}] ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ❌ [${String(passed + failed).padStart(2, '0')}] ${name}`);
        console.error(`     Error: ${err.message}\n`);
    }
}

// ------------------------------------------------------------
// Test 1: getDelayMinutes extracts delay from various live payload formats
// ------------------------------------------------------------
test("Delay extraction from live payload, currentLocation, route, and stop", () => {
    assert.strictEqual(getDelayMinutes({ delayMinutes: 25 }), 25);
    assert.strictEqual(getDelayMinutes({ live: { delayMinutes: 30 } }), 30);
    assert.strictEqual(getDelayMinutes({ currentLocation: { delayMinutes: 15 } }), 15);
    assert.strictEqual(getDelayMinutes({ route: [{ delayDeparture: 40 }] }), 40);
    assert.strictEqual(getDelayMinutes({ stop: { delayMinutes: 35 } }), 35);
    assert.strictEqual(getDelayMinutes({}), null);
});

// ------------------------------------------------------------
// Test 2: getDepartureTime applies delay to scheduled departure
// ------------------------------------------------------------
test("getDepartureTime shifts scheduled departure by delayMinutes", () => {
    const scheduled = "2026-09-13T22:00:00.000Z";
    const train = {
        scheduledDeparture: scheduled,
        delayMinutes: 30
    };
    const departure = getDepartureTime(train);
    const expected = "2026-09-13T22:30:00.000Z";
    assert.strictEqual(departure, expected, `Expected ${expected} but got ${departure}`);
});

// ------------------------------------------------------------
// Test 3: getDepartureTime respects explicit expectedDepartureTime if provided
// ------------------------------------------------------------
test("getDepartureTime prioritizes explicit expectedDepartureTime", () => {
    const explicit = "2026-09-13T22:45:00.000Z";
    const train = {
        expectedDepartureTime: explicit,
        scheduledDeparture: "2026-09-13T22:00:00.000Z",
        delayMinutes: 30
    };
    const departure = getDepartureTime(train);
    assert.strictEqual(departure, explicit);
});

// ------------------------------------------------------------
// Test 4: getArrivalTime shifts scheduled arrival by delayMinutes
// ------------------------------------------------------------
test("getArrivalTime shifts scheduled arrival by delayMinutes", () => {
    const scheduled = "2026-09-13T22:16:00.000Z";
    const train = {
        scheduledArrival: scheduled,
        delayMinutes: 20
    };
    const arrival = getArrivalTime(train);
    const expected = "2026-09-13T22:36:00.000Z";
    assert.strictEqual(arrival, expected);
});

// ------------------------------------------------------------
// Test 5: Not-started train with 30m delay evaluated at original scheduled time
// ------------------------------------------------------------
test("derivePassageFromDistance anchors passage to delayed departure", () => {
    // Current simulated time: 10:00 PM
    const now = Date.now();
    const scheduledDeparture = new Date(now).toISOString(); // Scheduled right now
    const delayMin = 30; // But delayed 30 minutes!
    const distanceKm = 15; // 15 km to crossing
    const speedKmh = 60; // 60 km/h -> 15 minutes transit

    const crossing = { id: "manawala", distanceKm };
    const analysis = {
        trainStatus: "not-started",
        scheduledDepartureTime: scheduledDeparture,
        delayMinutes: delayMin,
        speedKmph: speedKmh,
        routeSpeedKmph: speedKmh
    };

    const derived = derivePassageFromDistance(crossing, analysis);
    assert.ok(derived, "Derived passage should not be null");

    // Passage should be scheduled (now) + delay (30m) + transit (15m) = now + 45m
    const passageTime = new Date(derived.estimatedPassageTime).getTime();
    const expectedPassage = now + (delayMin * 60000) + (15 * 60000);
    const diffMs = Math.abs(passageTime - expectedPassage);
    assert.ok(diffMs < 2000, `Passage time ${derived.estimatedPassageTime} should be ~45m from now (diff: ${diffMs}ms)`);
    assert.ok(derived.etaMinutes >= 44 && derived.etaMinutes <= 46, `ETA should be ~45m, got ${derived.etaMinutes}`);
});

// ------------------------------------------------------------
// Test 6: User's Exact Scenario: Train scheduled at 10:00 PM, evaluated at 10:16 PM with 30m delay
// ------------------------------------------------------------
test("User scenario: at 10:16 PM, train delayed to 10:30 PM keeps gate OPEN at Manawala", () => {
    // Reference time: 10:16 PM
    const evalTime = new Date("2026-09-13T22:16:00.000Z");
    const scheduledDepTime = new Date("2026-09-13T22:00:00.000Z").getTime(); // 16 min in the past
    const delayMin = 30; // Delayed to 10:30 PM

    const effectiveDepTime = scheduledDepTime + (delayMin * 60000); // 10:30 PM (14 min in the future!)
    assert.strictEqual(effectiveDepTime, new Date("2026-09-13T22:30:00.000Z").getTime());

    // Distance to Manawala: 14.8 km at 60 km/h = 14.8 min transit
    const transitMs = 14.8 * 60000;
    const passageTimeMs = effectiveDepTime + transitMs; // 10:44:48 PM
    const etaMinAtEval = (passageTimeMs - evalTime.getTime()) / 60000; // 28.8 minutes

    assert.ok(etaMinAtEval > 15, `At 10:16 PM, ETA must be > 15 min (got ${etaMinAtEval.toFixed(1)} min)`);

    // Crossing status at 10:16 PM must be OPEN (NOT closed!)
    const event = {
        train_number: "18310",
        estimated_passage_time: new Date(passageTimeMs).toISOString()
    };
    const statusResult = determineCrossingStatus(event, "LIVE_FRESH", evalTime);
    assert.strictEqual(statusResult.status, "OPEN", `Gate state must be OPEN when ETA is 28.8 min, got ${statusResult.status}`);
});

// ------------------------------------------------------------
// Test 7: Gate correctly transitions for delayed train at delayed times
// ------------------------------------------------------------
test("Gate transitions at delayed closure and reopen windows", () => {
    const delayedPassageMs = new Date("2026-09-13T22:44:48.000Z").getTime();
    const event = {
        train_number: "18310",
        estimated_passage_time: new Date(delayedPassageMs).toISOString()
    };

    // 10:16 PM (28.8 min before passage): OPEN
    assert.strictEqual(
        determineCrossingStatus(event, "LIVE_FRESH", new Date("2026-09-13T22:16:00.000Z")).status,
        "OPEN"
    );

    // 10:32 PM (12.8 min before passage): TRAIN APPROACHING (between 15 and 8 min)
    assert.strictEqual(
        determineCrossingStatus(event, "LIVE_FRESH", new Date("2026-09-13T22:32:00.000Z")).status,
        "TRAIN APPROACHING"
    );

    // 10:38 PM (6.8 min before passage): FATAK CLOSED (inside 11 min baseline)
    assert.strictEqual(
        determineCrossingStatus(event, "LIVE_FRESH", new Date("2026-09-13T22:38:00.000Z")).status,
        "FATAK CLOSED"
    );

    // 10:44:48 PM (0 min, passage): FATAK CLOSED
    assert.strictEqual(
        determineCrossingStatus(event, "LIVE_FRESH", new Date(delayedPassageMs)).status,
        "FATAK CLOSED"
    );

    // 10:45:48 PM (1 min after passage): OPEN (1-minute reopening baseline)
    assert.strictEqual(
        determineCrossingStatus(event, "LIVE_FRESH", new Date(delayedPassageMs + 60000)).status,
        "OPEN"
    );

    // 10:46:20 PM (1m20s after passage): OPEN
    assert.strictEqual(
        determineCrossingStatus(event, "LIVE_FRESH", new Date(delayedPassageMs + 80000)).status,
        "OPEN"
    );
});

// ------------------------------------------------------------
// Test 8: Not-started train with past scheduled departure and 0 recorded delay
// ------------------------------------------------------------
test("Not-started train with past departure clamps departure to at least Date.now()", () => {
    const now = Date.now();
    const pastScheduled = new Date(now - 20 * 60000).toISOString(); // 20 min ago
    const crossing = { id: "manawala", distanceKm: 15 };
    const analysis = {
        trainStatus: "scheduled",
        scheduledDepartureTime: pastScheduled,
        delayMinutes: 0,
        speedKmph: 60,
        routeSpeedKmph: 60
    };

    const derived = derivePassageFromDistance(crossing, analysis);
    assert.ok(derived, "Should derive passage clamped to now");

    // Passage time should be >= now + transit (15m)
    const passageMs = new Date(derived.estimatedPassageTime).getTime();
    assert.ok(passageMs >= now + 14 * 60000, "Passage must not be in the past or immediately expiring");
});

// ------------------------------------------------------------
// Test 9: Complete closure timeline reflects delayed timestamps
// ------------------------------------------------------------
test("buildUnifiedSnapshot derives likely closure and reopen from delayed passage", () => {
    const delayedPassage = new Date("2026-09-13T22:45:00.000Z");
    const snap = buildUnifiedSnapshot({
        cycleTimestamp: "2026-09-13T22:30:00.000Z",
        eventsByCrossing: {
            "talwandi-dogran": [{
                train_number: "18310",
                train_name: "Nagavali Express",
                direction: "forward",
                estimated_passage_time: delayedPassage.toISOString()
            }]
        }
    });

    const tCrossing = snap.crossings["talwandi-dogran"];
    assert.strictEqual(tCrossing.timingMetrics.passageTime, "2026-09-13T22:45:00.000Z");
    // Likely closure = passage - 11 min = 22:34:00
    assert.strictEqual(tCrossing.timingMetrics.likelyClosure, "2026-09-13T22:34:00.000Z");
    // Likely reopen = passage + 1 min = 22:46:00
    assert.strictEqual(tCrossing.timingMetrics.likelyReopen, "2026-09-13T22:46:00.000Z");
    assert.strictEqual(tCrossing.timingMetrics.leadBuffer, "11 min baseline");
});

// ------------------------------------------------------------
// Test 10: Speed for stationary delayed train at origin is null (not phantom movement)
// ------------------------------------------------------------
test("Stationary delayed train at origin does not produce phantom live speed", () => {
    const speed = getTrainSpeed({
        status: "scheduled",
        currentLocation: { sequence: 1, speedKmh: 40 }
    });
    assert.strictEqual(speed, null, "Scheduled train speed must not be used as live movement speed");
});

console.log(`\n============================================================`);
console.log(`DELAYED TRAIN TEST SUITE: ${passed} PASSED, ${failed} FAILED`);
console.log(`============================================================\n`);

if (failed > 0) {
    process.exit(1);
}
