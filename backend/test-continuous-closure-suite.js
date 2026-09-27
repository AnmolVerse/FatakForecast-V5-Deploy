/**
 * ============================================================
 * FATAKFORECAST — CONTINUOUS CLOSURE TEST SUITE
 * ============================================================
 *
 * Verifies all 17 continuous closure scenarios for closely spaced trains:
 *
 *  1. Two trains 5 min apart -> continuous closure
 *  2. Two trains 8 min apart -> continuous closure
 *  3. Two trains 9 min apart -> continuous closure
 *  4. Two trains exactly 10 min apart -> continuous closure
 *  5. Two trains 11 min apart -> closure intervals overlap
 *  6. Two trains 12 min apart -> closure intervals touch
 *  7. Two trains 14 min apart -> allow genuine reopening
 *  8. Two trains with overlapping closure intervals -> merge
 *  9. Two trains with touching closure intervals -> merge
 * 10. Two trains with genuine gap -> preserve OPEN interval
 * 11. Three consecutive trains -> merge all required intervals
 * 12. Four consecutive trains -> merge all required intervals
 * 13. Same-direction trains -> verified
 * 14. Opposite-direction trains -> verified
 * 15. Rapidly changing train ETA -> recomputed without duplicate events
 * 16. Train disappears from live data -> remaining events preserved safely
 * 17. Event expires -> combined state updates correctly
 */

process.env.NODE_ENV = "test";

const assert = require("assert");
const {
    computeCombinedClosureTimeline,
    computeOverlappingClosure,
    determineCrossingStatus,
    buildUnifiedSnapshot
} = require("./services/forecast-snapshot");

console.log("\n============================================================");
console.log("   FATAKFORECAST — CONTINUOUS CLOSURE TEST SUITE (17 TESTS) ");
console.log("============================================================\n");

const baseNow = new Date("2026-09-13T17:00:00.000Z");
let passed = 0;
let failed = 0;

function logPass(num, name) {
    passed++;
    console.log(`  ✅ [${String(num).padStart(2, "0")}/17] ${name}`);
}

function logFail(num, name, err) {
    failed++;
    console.error(`  ❌ [${String(num).padStart(2, "0")}/17] ${name}`);
    console.error(`     Error: ${err.message}`);
}

// ------------------------------------------------------------
// 1. Two trains 5 min apart -> continuous closure
// ------------------------------------------------------------
try {
    const tA = new Date(baseNow.getTime() + 10 * 60000).toISOString();
    const tB = new Date(baseNow.getTime() + 15 * 60000).toISOString();
    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", train_name: "Shane Punjab", estimated_passage_time: tA },
        { train_number: "14804", train_name: "Express", estimated_passage_time: tB }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, true, "5 min gap must trigger continuous closure");
    assert.strictEqual(closure.trainCount, 2, "Must contain 2 trains");
    assert.strictEqual(closure.trains.length, 2);
    logPass(1, "Two trains 5 min apart -> continuous closure");
} catch (e) { logFail(1, "Two trains 5 min apart", e); }

// ------------------------------------------------------------
// 2. Two trains 8 min apart -> continuous closure
// ------------------------------------------------------------
try {
    const tA = new Date(baseNow.getTime() + 10 * 60000).toISOString(); // 5:10
    const tB = new Date(baseNow.getTime() + 18 * 60000).toISOString(); // 5:18
    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", estimated_passage_time: tA },
        { train_number: "14804", estimated_passage_time: tB }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, true, "8 min gap must trigger continuous closure");
    assert.strictEqual(closure.trainCount, 2);

    // Verify status during Train A passage (5:10)
    const atPassageA = new Date(baseNow.getTime() + 10 * 60000);
    const statusAtA = determineCrossingStatus(closure.primaryEvent, "LIVE_FRESH", atPassageA, closure);
    assert.strictEqual(statusAtA.status, "FATAK CLOSED");

    // Verify status at 5:12 (2 min after Train A passage, but before Train B at 5:18)
    const at512 = new Date(baseNow.getTime() + 12 * 60000);
    const statusAt512 = determineCrossingStatus(closure.primaryEvent, "LIVE_FRESH", at512, closure);
    assert.strictEqual(statusAt512.status, "FATAK CLOSED", "Must remain FATAK CLOSED at 5:12 between trains");

    logPass(2, "Two trains 8 min apart -> continuous closure (no false reopen)");
} catch (e) { logFail(2, "Two trains 8 min apart", e); }

// ------------------------------------------------------------
// 3. Two trains 9 min apart -> continuous closure
// ------------------------------------------------------------
try {
    const tA = new Date(baseNow.getTime() + 10 * 60000).toISOString();
    const tB = new Date(baseNow.getTime() + 19 * 60000).toISOString();
    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", estimated_passage_time: tA },
        { train_number: "14804", estimated_passage_time: tB }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, true, "9 min gap must trigger continuous closure");
    assert.strictEqual(closure.trainCount, 2);
    logPass(3, "Two trains 9 min apart -> continuous closure");
} catch (e) { logFail(3, "Two trains 9 min apart", e); }

// ------------------------------------------------------------
// 4. Two trains exactly 10 min apart -> continuous closure
// ------------------------------------------------------------
try {
    const tA = new Date(baseNow.getTime() + 10 * 60000).toISOString();
    const tB = new Date(baseNow.getTime() + 20 * 60000).toISOString();
    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", estimated_passage_time: tA },
        { train_number: "14804", estimated_passage_time: tB }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, true, "Exactly 10 min gap must trigger continuous closure");
    assert.strictEqual(closure.trainCount, 2);
    logPass(4, "Two trains exactly 10 min apart -> continuous closure");
} catch (e) { logFail(4, "Two trains exactly 10 min apart", e); }

// ------------------------------------------------------------
// 5. Two trains 11 min apart -> closure intervals overlap
// ------------------------------------------------------------
try {
    // With the 11-minute closure / 1-minute reopen baseline, B closes at A passage.

    const tA = new Date(baseNow.getTime() + 10 * 60000).toISOString();
    const tB = new Date(baseNow.getTime() + 21 * 60000).toISOString();
    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", estimated_passage_time: tA },
        { train_number: "14804", estimated_passage_time: tB }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, true, "11 min passage gap overlaps the 11m/1m closure intervals");
    assert.strictEqual(closure.trainCount, 2);
    logPass(5, "Two trains 11 min apart -> closure intervals overlap");
} catch (e) { logFail(5, "Two trains 11 min apart", e); }

// ------------------------------------------------------------
// 6. Two trains 12 min apart -> closure intervals touch
// ------------------------------------------------------------
try {
    const tA = new Date(baseNow.getTime() + 10 * 60000).toISOString();
    const tB = new Date(baseNow.getTime() + 22 * 60000).toISOString();
    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", estimated_passage_time: tA },
        { train_number: "14804", estimated_passage_time: tB }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, true);
    assert.strictEqual(closure.trainCount, 2);
    logPass(6, "Two trains 12 min apart -> closure intervals touch");
} catch (e) { logFail(6, "Two trains 12 min apart", e); }

// ------------------------------------------------------------
// 7. Two trains 14 min apart -> allow genuine reopening
// ------------------------------------------------------------
try {
    const tA = new Date(baseNow.getTime() + 10 * 60000).toISOString();
    const tB = new Date(baseNow.getTime() + 24 * 60000).toISOString();
    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", estimated_passage_time: tA },
        { train_number: "14804", estimated_passage_time: tB }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, false);
    assert.strictEqual(closure.trainCount, 1);
    logPass(7, "Two trains 14 min apart -> allow genuine reopening");
} catch (e) { logFail(7, "Two trains 14 min apart", e); }

// ------------------------------------------------------------
// 8. Two trains with overlapping closure intervals -> merge
// ------------------------------------------------------------
try {
    // Train A: 5:10, Train B: 5:22 (12 min gap), but Train B has custom early closure starting at 5:11:00
    // Reopen A = 5:11:30. Since 5:11:00 <= 5:11:30, intervals overlap -> MERGE!
    const tA = new Date(baseNow.getTime() + 10 * 60000).toISOString();
    const tB = new Date(baseNow.getTime() + 22 * 60000).toISOString();
    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", estimated_passage_time: tA },
        {
            train_number: "14804",
            estimated_passage_time: tB,
            predicted_gate_close_earliest: new Date(baseNow.getTime() + 11 * 60000).toISOString()
        }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, true, "Overlapping closure intervals must merge even if passage gap > 10m");
    assert.strictEqual(closure.trainCount, 2);
    logPass(8, "Two trains with overlapping closure intervals -> merge");
} catch (e) { logFail(8, "Two trains with overlapping closure intervals", e); }

// ------------------------------------------------------------
// 9. Two trains with touching closure intervals -> merge
// ------------------------------------------------------------
try {
    // Train A reopen: 5:11:30. Train B closure: 5:11:30 (touching)
    const tA = new Date(baseNow.getTime() + 10 * 60000).toISOString();
    const tB = new Date(baseNow.getTime() + 20 * 60000).toISOString();
    const closure = computeCombinedClosureTimeline([
        {
            train_number: "12498",
            estimated_passage_time: tA,
            predicted_gate_open_latest: new Date(baseNow.getTime() + 11 * 60000).toISOString()
        },
        {
            train_number: "14804",
            estimated_passage_time: tB,
            predicted_gate_close_earliest: new Date(baseNow.getTime() + 11 * 60000).toISOString()
        }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, true, "Touching closure intervals must merge");
    assert.strictEqual(closure.trainCount, 2);
    logPass(9, "Two trains with touching closure intervals -> merge");
} catch (e) { logFail(9, "Two trains with touching closure intervals", e); }

// ------------------------------------------------------------
// 10. Two trains with genuine gap -> preserve OPEN interval
// ------------------------------------------------------------
try {
    const tA = new Date(baseNow.getTime() + 10 * 60000).toISOString();
    const tB = new Date(baseNow.getTime() + 40 * 60000).toISOString();
    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", estimated_passage_time: tA },
        { train_number: "14804", estimated_passage_time: tB }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, false);
    assert.strictEqual(closure.trainCount, 1);
    assert.strictEqual(closure.allBlocks.length, 2);
    logPass(10, "Two trains with genuine gap -> preserve OPEN interval");
} catch (e) { logFail(10, "Two trains with genuine gap", e); }

// ------------------------------------------------------------
// 11. Three consecutive trains -> merge all required intervals
// ------------------------------------------------------------
try {
    const tA = new Date(baseNow.getTime() + 10 * 60000).toISOString(); // 5:10
    const tB = new Date(baseNow.getTime() + 18 * 60000).toISOString(); // 5:18 (8m after A)
    const tC = new Date(baseNow.getTime() + 26 * 60000).toISOString(); // 5:26 (8m after B)

    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", estimated_passage_time: tA },
        { train_number: "14804", estimated_passage_time: tB },
        { train_number: "12030", estimated_passage_time: tC }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, true);
    assert.strictEqual(closure.trainCount, 3, "All 3 trains must merge into single continuous closure");
    assert.strictEqual(closure.trains.length, 3);
    assert.strictEqual(closure.firstTrainPassage, tA);
    assert.strictEqual(closure.lastTrainPassage, tC);
    logPass(11, "Three consecutive trains -> merge all required intervals");
} catch (e) { logFail(11, "Three consecutive trains", e); }

// ------------------------------------------------------------
// 12. Four consecutive trains -> merge all required intervals
// ------------------------------------------------------------
try {
    const tA = new Date(baseNow.getTime() + 10 * 60000).toISOString(); // 5:10
    const tB = new Date(baseNow.getTime() + 17 * 60000).toISOString(); // 5:17 (7m)
    const tC = new Date(baseNow.getTime() + 24 * 60000).toISOString(); // 5:24 (7m)
    const tD = new Date(baseNow.getTime() + 31 * 60000).toISOString(); // 5:31 (7m)

    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", estimated_passage_time: tA },
        { train_number: "14804", estimated_passage_time: tB },
        { train_number: "12030", estimated_passage_time: tC },
        { train_number: "19614", estimated_passage_time: tD }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, true);
    assert.strictEqual(closure.trainCount, 4, "All 4 trains must merge into single continuous closure");
    assert.strictEqual(closure.trains.length, 4);
    logPass(12, "Four consecutive trains -> merge all required intervals");
} catch (e) { logFail(12, "Four consecutive trains", e); }

// ------------------------------------------------------------
// 13. Same-direction trains -> verified
// ------------------------------------------------------------
try {
    const tA = new Date(baseNow.getTime() + 8 * 60000).toISOString();
    const tB = new Date(baseNow.getTime() + 14 * 60000).toISOString();

    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", direction: "forward", estimated_passage_time: tA },
        { train_number: "14804", direction: "forward", estimated_passage_time: tB }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, true);
    assert.strictEqual(closure.trainCount, 2);
    assert.strictEqual(closure.trains[0].direction, "forward");
    assert.strictEqual(closure.trains[1].direction, "forward");
    logPass(13, "Same-direction trains -> verified");
} catch (e) { logFail(13, "Same-direction trains", e); }

// ------------------------------------------------------------
// 14. Opposite-direction trains -> verified
// ------------------------------------------------------------
try {
    const tA = new Date(baseNow.getTime() + 10 * 60000).toISOString();
    const tB = new Date(baseNow.getTime() + 14 * 60000).toISOString();

    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", direction: "forward", estimated_passage_time: tA },
        { train_number: "12013", direction: "backward", estimated_passage_time: tB }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, true);
    assert.strictEqual(closure.trainCount, 2);
    assert.strictEqual(closure.trains[0].direction, "forward");
    assert.strictEqual(closure.trains[1].direction, "backward");
    logPass(14, "Opposite-direction trains -> verified");
} catch (e) { logFail(14, "Opposite-direction trains", e); }

// ------------------------------------------------------------
// 15. Rapidly changing train ETA -> recomputed without duplicate events
// ------------------------------------------------------------
try {
    // Cycle 1 ETAs
    const tA1 = new Date(baseNow.getTime() + 10 * 60000).toISOString();
    const tB1 = new Date(baseNow.getTime() + 17 * 60000).toISOString();
    const snap1 = buildUnifiedSnapshot({
        cycleId: "cycle-1",
        cycleTimestamp: baseNow.toISOString(),
        eventsByCrossing: {
            "manawala-road": [
                { train_number: "12498", train_name: "Shane Punjab", estimated_passage_time: tA1 },
                { train_number: "14804", train_name: "Express", estimated_passage_time: tB1 }
            ]
        }
    });

    const c1 = snap1.crossings["manawala-road"];
    assert.strictEqual(c1.overlappingClosure.isContinuous, true);
    assert.strictEqual(c1.overlappingClosure.trainCount, 2);

    // Cycle 2: updated ETAs with small speed fluctuation
    const tA2 = new Date(baseNow.getTime() + 11 * 60000).toISOString();
    const tB2 = new Date(baseNow.getTime() + 18 * 60000).toISOString();
    const snap2 = buildUnifiedSnapshot({
        cycleId: "cycle-2",
        cycleTimestamp: new Date(baseNow.getTime() + 60000).toISOString(),
        eventsByCrossing: {
            "manawala-road": [
                { train_number: "12498", train_name: "Shane Punjab", estimated_passage_time: tA2 },
                { train_number: "14804", train_name: "Express", estimated_passage_time: tB2 }
            ]
        }
    });

    const c2 = snap2.crossings["manawala-road"];
    assert.strictEqual(c2.overlappingClosure.isContinuous, true);
    assert.strictEqual(c2.overlappingClosure.trainCount, 2);
    assert.strictEqual(c2.primaryTrain.trainNumber, "12498");
    assert.strictEqual(c2.upcomingTrains.length, 1);
    assert.strictEqual(c2.upcomingTrains[0].trainNumber, "14804");
    logPass(15, "Rapidly changing train ETA -> recomputed without duplicate events");
} catch (e) { logFail(15, "Rapidly changing train ETA", e); }

// ------------------------------------------------------------
// 16. Train disappears from live data -> remaining events preserved safely
// ------------------------------------------------------------
try {
    // Cycle 1: 2 trains
    const tA = new Date(baseNow.getTime() + 8 * 60000).toISOString();
    const tB = new Date(baseNow.getTime() + 15 * 60000).toISOString();
    buildUnifiedSnapshot({
        cycleId: "cycle-1",
        cycleTimestamp: baseNow.toISOString(),
        eventsByCrossing: {
            "manawala-road": [
                { train_number: "12498", estimated_passage_time: tA },
                { train_number: "14804", estimated_passage_time: tB }
            ]
        }
    });

    // Cycle 2: train 12498 drops out, only 14804 remains
    const snap2 = buildUnifiedSnapshot({
        cycleId: "cycle-2",
        cycleTimestamp: new Date(baseNow.getTime() + 60000).toISOString(),
        eventsByCrossing: {
            "manawala-road": [
                { train_number: "14804", estimated_passage_time: tB }
            ]
        }
    });

    const c2 = snap2.crossings["manawala-road"];
    assert.strictEqual(c2.primaryTrain.trainNumber, "14804");
    assert.strictEqual(c2.overlappingClosure.isContinuous, false);
    assert.strictEqual(c2.overlappingClosure.trainCount, 1);
    logPass(16, "Train disappears from live data -> remaining events preserved safely");
} catch (e) { logFail(16, "Train disappears from live data", e); }

// ------------------------------------------------------------
// 17. Event expires -> combined state updates correctly
// ------------------------------------------------------------
try {
    // Train A: 5:05 (clears at 5:06:30)
    // Train B: 5:12 (clears at 5:13:30)
    // Continuous closure: 4:56:30 to 5:13:30
    const tA = new Date(baseNow.getTime() + 5 * 60000).toISOString();
    const tB = new Date(baseNow.getTime() + 12 * 60000).toISOString();

    const closure = computeCombinedClosureTimeline([
        { train_number: "12498", estimated_passage_time: tA },
        { train_number: "14804", estimated_passage_time: tB }
    ], baseNow);

    assert.strictEqual(closure.isContinuous, true);

    // At 5:07 (Train A has passed 2 min ago, but within continuous closure until 5:13:30)
    const at507 = new Date(baseNow.getTime() + 7 * 60000);
    const statusAt507 = determineCrossingStatus(closure.primaryEvent, "LIVE_FRESH", at507, closure);
    assert.strictEqual(statusAt507.status, "FATAK CLOSED", "Must remain FATAK CLOSED after Train A passes");

    // At 5:15 (both trains passed, closure ended at 5:13:30)
    const at515 = new Date(baseNow.getTime() + 15 * 60000);
    const statusAt515 = determineCrossingStatus(closure.primaryEvent, "LIVE_FRESH", at515, closure);
    assert.strictEqual(statusAt515.status, "OPEN", "Must be OPEN after continuous closure ends");

    logPass(17, "Event expires -> combined state updates correctly");
} catch (e) { logFail(17, "Event expires", e); }

console.log("\n============================================================");
console.log(`CONTINUOUS CLOSURE TEST SUITE: ${passed} PASSED, ${failed} FAILED`);
console.log("============================================================\n");

if (failed > 0) {
    process.exit(1);
}
