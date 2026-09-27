/**
 * TEST SUITE: 60-Minute Subsequent Trains Schedule & Gate Timings
 * 
 * Verifies:
 * 1. Subsequent trains within the 60-minute window are captured in chronological order.
 * 2. Each subsequent train contains passage time, approximate gate closure time, and approximate gate open time.
 * 3. Timing accuracy: Gate close is Tp - 11m, Gate reopen is Tp + 1m.
 * 4. Continuous closure detection when gap <= 10 minutes between consecutive trains.
 * 5. 60-minute horizon filtering: trains beyond 60 min are excluded.
 * 6. Dynamic time promotion: when primary train passes, next subsequent train becomes primary.
 * 7. All 4 crossings maintain crossing-specific timings.
 * 8. Both upcomingTrains and subsequentTrains properties are populated.
 */

const assert = require("assert");
const { buildUnifiedSnapshot, getActiveSnapshot, saveSnapshot } = require("./services/forecast-snapshot");

process.env.NODE_ENV = "test";

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ ${name}`);
        console.error(`     Error: ${err.message}`);
        failed++;
    }
}

console.log("============================================================");
console.log("   TEST SUITE: 60-MINUTE SUBSEQUENT TRAINS & GATE TIMINGS   ");
console.log("============================================================\n");

const baseTime = new Date("2026-09-15T10:00:00.000Z");

function createEvent(trainNumber, trainName, crossingId, passageDate, dir = "forward") {
    const pMs = passageDate.getTime();
    return {
        train_number: trainNumber,
        trainNumber: trainNumber,
        train_name: trainName,
        trainName: trainName,
        direction: dir,
        crossingId,
        estimated_passage_time: passageDate.toISOString(),
        estimatedPassageTime: passageDate.toISOString(),
        predicted_gate_close_earliest: new Date(pMs - 11 * 60000).toISOString(),
        predicted_gate_open_latest: new Date(pMs + 1 * 60000).toISOString(),
        confidence: "high"
    };
}

// -------------------------------------------------------------
// Test 1: Single Train on Corridor (0 Subsequent Trains)
// -------------------------------------------------------------
test("1. Single train in 60m window -> primaryTrain is populated, subsequentTrains is empty", () => {
    const t1Passage = new Date(baseTime.getTime() + 15 * 60000); // 10:15
    const ev1 = createEvent("12054", "Haridwar Express", "manawala-road", t1Passage);

    const snapshot = buildUnifiedSnapshot({
        cycleTimestamp: baseTime.toISOString(),
        eventsByCrossing: { "manawala-road": [ev1] }
    });

    const c = snapshot.crossings["manawala-road"];
    assert.strictEqual(c.primaryTrain.trainNumber, "12054");
    assert.strictEqual(c.subsequentTrains.length, 0);
    assert.strictEqual(c.upcomingTrains.length, 0);
    assert.strictEqual(c.totalUpcomingTrains, 1);
});

// -------------------------------------------------------------
// Test 2: Multiple Subsequent Trains in 60m Window
// -------------------------------------------------------------
test("2. Three trains in 60m window -> Train 1 is primary, Trains 2 & 3 in subsequentTrains", () => {
    const t1 = new Date(baseTime.getTime() + 10 * 60000); // 10:10
    const t2 = new Date(baseTime.getTime() + 25 * 60000); // 10:25
    const t3 = new Date(baseTime.getTime() + 48 * 60000); // 10:48

    const ev1 = createEvent("12054", "Haridwar Express", "manawala-road", t1);
    const ev2 = createEvent("14632", "Dehradun Express", "manawala-road", t2);
    const ev3 = createEvent("12498", "Shane Punjab", "manawala-road", t3);

    const snapshot = buildUnifiedSnapshot({
        cycleTimestamp: baseTime.toISOString(),
        eventsByCrossing: { "manawala-road": [ev1, ev2, ev3] }
    });

    const c = snapshot.crossings["manawala-road"];
    assert.strictEqual(c.primaryTrain.trainNumber, "12054");
    assert.strictEqual(c.subsequentTrains.length, 2);
    assert.strictEqual(c.subsequentTrains[0].trainNumber, "14632");
    assert.strictEqual(c.subsequentTrains[1].trainNumber, "12498");
});

// -------------------------------------------------------------
// Test 3: Mathematical Accuracy of Timings for Each Subsequent Train
// -------------------------------------------------------------
test("3. Exact passage, closure (Tp - 11m), and reopen (Tp + 1m) for every subsequent train", () => {
    const t1 = new Date(baseTime.getTime() + 10 * 60000); // 10:10
    const t2 = new Date(baseTime.getTime() + 30 * 60000); // 10:30 (passage)
    const t3 = new Date(baseTime.getTime() + 55 * 60000); // 10:55 (passage)

    const ev1 = createEvent("12054", "Haridwar Express", "manawala-road", t1);
    const ev2 = createEvent("14632", "Dehradun Express", "manawala-road", t2);
    const ev3 = createEvent("12498", "Shane Punjab", "manawala-road", t3);

    const snapshot = buildUnifiedSnapshot({
        cycleTimestamp: baseTime.toISOString(),
        eventsByCrossing: { "manawala-road": [ev1, ev2, ev3] }
    });

    const sub = snapshot.crossings["manawala-road"].subsequentTrains;
    
    // Train 2 (14632)
    assert.strictEqual(sub[0].estimatedPassageTime, t2.toISOString());
    const expectedClose2 = new Date(t2.getTime() - 11 * 60000).toISOString();
    const expectedOpen2 = new Date(t2.getTime() + 1 * 60000).toISOString();
    assert.strictEqual(sub[0].predictedGateCloseTime, expectedClose2);
    assert.strictEqual(sub[0].predictedGateOpenTime, expectedOpen2);
    assert.strictEqual(sub[0].etaMinutes, 30);

    // Train 3 (12498)
    assert.strictEqual(sub[1].estimatedPassageTime, t3.toISOString());
    const expectedClose3 = new Date(t3.getTime() - 11 * 60000).toISOString();
    const expectedOpen3 = new Date(t3.getTime() + 1 * 60000).toISOString();
    assert.strictEqual(sub[1].predictedGateCloseTime, expectedClose3);
    assert.strictEqual(sub[1].predictedGateOpenTime, expectedOpen3);
    assert.strictEqual(sub[1].etaMinutes, 55);
});

// -------------------------------------------------------------
// Test 4: 60-Minute Horizon Filtering
// -------------------------------------------------------------
test("4. 60-minute horizon: train at 59m included, train at 62m excluded from subsequentTrains", () => {
    const t1 = new Date(baseTime.getTime() + 10 * 60000); // 10:10
    const tWithin = new Date(baseTime.getTime() + 59 * 60000); // 10:59 (included)
    const tBeyond = new Date(baseTime.getTime() + 62 * 60000); // 11:02 (excluded)

    const ev1 = createEvent("12054", "Train 1", "manawala-road", t1);
    const ev2 = createEvent("14632", "Train Within", "manawala-road", tWithin);
    const ev3 = createEvent("99999", "Train Beyond", "manawala-road", tBeyond);

    const snapshot = buildUnifiedSnapshot({
        cycleTimestamp: baseTime.toISOString(),
        eventsByCrossing: { "manawala-road": [ev1, ev2, ev3] }
    });

    const sub = snapshot.crossings["manawala-road"].subsequentTrains;
    assert.strictEqual(sub.length, 1);
    assert.strictEqual(sub[0].trainNumber, "14632");
    assert.ok(!sub.some(t => t.trainNumber === "99999"));
});

// -------------------------------------------------------------
// Test 5: Continuous Closure Detection Between Subsequent Trains (<= 10m gap)
// -------------------------------------------------------------
test("5. Multi-train continuous closure: gap <= 10 min flags isContinuousClosure on subsequent train", () => {
    const t1 = new Date(baseTime.getTime() + 10 * 60000); // 10:10:00
    const t2 = new Date(baseTime.getTime() + 16 * 60000); // 10:16:00 (6m gap <= 10m)

    const ev1 = createEvent("12054", "Train 1", "manawala-road", t1);
    const ev2 = createEvent("14632", "Train 2", "manawala-road", t2);

    const snapshot = buildUnifiedSnapshot({
        cycleTimestamp: baseTime.toISOString(),
        eventsByCrossing: { "manawala-road": [ev1, ev2] }
    });

    const c = snapshot.crossings["manawala-road"];
    assert.ok(c.combinedClosure.isContinuous, "Combined closure should be continuous");
    assert.strictEqual(c.subsequentTrains[0].isContinuousClosure, true);
    // Effective gate close time should be continuous start (t1 - 11m = 10:01:30)
    assert.strictEqual(c.subsequentTrains[0].effectiveGateCloseTime, new Date(t1.getTime() - 11 * 60000).toISOString());
    // Effective gate reopen time should be continuous end (t2 + 1m = 10:17:30)
    assert.strictEqual(c.subsequentTrains[0].effectiveGateOpenTime, new Date(t2.getTime() + 1 * 60000).toISOString());
});

// -------------------------------------------------------------
// Test 6: Non-Overlapping Subsequent Trains (> 10m gap)
// -------------------------------------------------------------
test("6. Distinct closures: gap > 10 min does not merge continuous closure", () => {
    const t1 = new Date(baseTime.getTime() + 10 * 60000); // 10:10
    const t2 = new Date(baseTime.getTime() + 35 * 60000); // 10:35 (25m gap > 10m)

    const ev1 = createEvent("12054", "Train 1", "manawala-road", t1);
    const ev2 = createEvent("14632", "Train 2", "manawala-road", t2);

    const snapshot = buildUnifiedSnapshot({
        cycleTimestamp: baseTime.toISOString(),
        eventsByCrossing: { "manawala-road": [ev1, ev2] }
    });

    const c = snapshot.crossings["manawala-road"];
    assert.strictEqual(c.combinedClosure.isContinuous, false);
    assert.strictEqual(c.subsequentTrains[0].isContinuousClosure, false);
    // Effective times equal standard times
    assert.strictEqual(c.subsequentTrains[0].effectiveGateCloseTime, c.subsequentTrains[0].predictedGateCloseTime);
    assert.strictEqual(c.subsequentTrains[0].effectiveGateOpenTime, c.subsequentTrains[0].predictedGateOpenTime);
});

// -------------------------------------------------------------
// Test 7: Dynamic Wall-Clock Promotion via getActiveSnapshot
// -------------------------------------------------------------
test("7. Dynamic wall-clock advancement promotes subsequent train to primary and archives completed train", () => {
    const t1 = new Date(baseTime.getTime() + 5 * 60000);  // 10:05 (passage)
    const t2 = new Date(baseTime.getTime() + 25 * 60000); // 10:25 (passage)

    const ev1 = createEvent("12054", "Train 1", "manawala-road", t1);
    const ev2 = createEvent("14632", "Train 2", "manawala-road", t2);

    const initialSnapshot = buildUnifiedSnapshot({
        cycleTimestamp: baseTime.toISOString(),
        eventsByCrossing: { "manawala-road": [ev1, ev2] }
    });
    saveSnapshot(initialSnapshot, false);

    // Fast forward to 10:07:00 (2 minutes after t1 passage -> t1 completed +1m buffer)
    const advanceTime = new Date(baseTime.getTime() + 7 * 60000);
    const updated = getActiveSnapshot(advanceTime.getTime());

    const c = updated.crossings["manawala-road"];
    assert.strictEqual(c.primaryTrain.trainNumber, "14632", "Train 2 promoted to primary");
    assert.strictEqual(c.subsequentTrains.length, 0, "No more subsequent trains remaining");
    assert.strictEqual(c.lastTrainPassed.trainNumber, "12054", "Train 1 archived to lastTrainPassed");
});

// -------------------------------------------------------------
// Test 8: Cross-Crossing Specific Timings
// -------------------------------------------------------------
test("8. Subsequent trains have distinct crossing-specific passage, closure, and reopen times across all 4 crossings", () => {
    const t1Talwandi = new Date(baseTime.getTime() + 10 * 60000);
    const t1Manawala = new Date(baseTime.getTime() + 12 * 60000);
    const t1Rakh = new Date(baseTime.getTime() + 14 * 60000);
    const t1Jandiala = new Date(baseTime.getTime() + 16 * 60000);

    const t2Talwandi = new Date(baseTime.getTime() + 30 * 60000);
    const t2Manawala = new Date(baseTime.getTime() + 32 * 60000);
    const t2Rakh = new Date(baseTime.getTime() + 34 * 60000);
    const t2Jandiala = new Date(baseTime.getTime() + 36 * 60000);

    const snapshot = buildUnifiedSnapshot({
        cycleTimestamp: baseTime.toISOString(),
        eventsByCrossing: {
            "talwandi-dogran": [createEvent("1001", "Tr1", "talwandi-dogran", t1Talwandi), createEvent("1002", "Tr2", "talwandi-dogran", t2Talwandi)],
            "manawala-road": [createEvent("1001", "Tr1", "manawala-road", t1Manawala), createEvent("1002", "Tr2", "manawala-road", t2Manawala)],
            "rakh-devi-dasspura": [createEvent("1001", "Tr1", "rakh-devi-dasspura", t1Rakh), createEvent("1002", "Tr2", "rakh-devi-dasspura", t2Rakh)],
            "jandiala": [createEvent("1001", "Tr1", "jandiala", t1Jandiala), createEvent("1002", "Tr2", "jandiala", t2Jandiala)]
        }
    });

    const subTal = snapshot.crossings["talwandi-dogran"].subsequentTrains[0];
    const subMan = snapshot.crossings["manawala-road"].subsequentTrains[0];
    const subRak = snapshot.crossings["rakh-devi-dasspura"].subsequentTrains[0];
    const subJan = snapshot.crossings["jandiala"].subsequentTrains[0];

    assert.strictEqual(subTal.estimatedPassageTime, t2Talwandi.toISOString());
    assert.strictEqual(subMan.estimatedPassageTime, t2Manawala.toISOString());
    assert.strictEqual(subRak.estimatedPassageTime, t2Rakh.toISOString());
    assert.strictEqual(subJan.estimatedPassageTime, t2Jandiala.toISOString());

    // Verify all 4 gate closures match their respective crossing passage - 11m
    assert.strictEqual(subTal.predictedGateCloseTime, new Date(t2Talwandi.getTime() - 11 * 60000).toISOString());
    assert.strictEqual(subMan.predictedGateCloseTime, new Date(t2Manawala.getTime() - 11 * 60000).toISOString());
    assert.strictEqual(subRak.predictedGateCloseTime, new Date(t2Rakh.getTime() - 11 * 60000).toISOString());
    assert.strictEqual(subJan.predictedGateCloseTime, new Date(t2Jandiala.getTime() - 11 * 60000).toISOString());
});

// -------------------------------------------------------------
// Test 9: Backward Compatibility: upcomingTrains === subsequentTrains
// -------------------------------------------------------------
test("9. c.upcomingTrains and c.subsequentTrains contain identical items for backward compatibility", () => {
    const t1 = new Date(baseTime.getTime() + 10 * 60000);
    const t2 = new Date(baseTime.getTime() + 25 * 60000);

    const snapshot = buildUnifiedSnapshot({
        cycleTimestamp: baseTime.toISOString(),
        eventsByCrossing: {
            "manawala-road": [createEvent("12054", "Tr1", "manawala-road", t1), createEvent("14632", "Tr2", "manawala-road", t2)]
        }
    });

    const c = snapshot.crossings["manawala-road"];
    assert.strictEqual(c.upcomingTrains.length, c.subsequentTrains.length);
    assert.strictEqual(c.upcomingTrains[0].trainNumber, c.subsequentTrains[0].trainNumber);
});

// -------------------------------------------------------------
// Test 10: Complete Field Schema Verification on Subsequent Train Items
// -------------------------------------------------------------
test("10. Subsequent train objects have all required properties populated", () => {
    const t1 = new Date(baseTime.getTime() + 10 * 60000);
    const t2 = new Date(baseTime.getTime() + 30 * 60000);

    const snapshot = buildUnifiedSnapshot({
        cycleTimestamp: baseTime.toISOString(),
        eventsByCrossing: {
            "manawala-road": [createEvent("12054", "Tr1", "manawala-road", t1), createEvent("14632", "Tr2", "manawala-road", t2)]
        }
    });

    const item = snapshot.crossings["manawala-road"].subsequentTrains[0];
    const requiredProps = [
        "trainNumber",
        "trainName",
        "direction",
        "etaMinutes",
        "estimatedPassageTime",
        "predictedGateCloseTime",
        "predictedGateOpenTime",
        "isContinuousClosure",
        "effectiveGateCloseTime",
        "effectiveGateOpenTime"
    ];

    for (const prop of requiredProps) {
        assert.ok(item[prop] !== undefined, `Property ${prop} must be defined on subsequent train`);
    }
});

console.log("\n============================================================");
console.log(`SUBSEQUENT TRAINS SUITE SUMMARY: ${passed} PASSED, ${failed} FAILED`);
console.log("============================================================\n");

if (failed > 0) {
    process.exit(1);
}
