/* ============================================================
   FATAKFORECAST — EVENT LIFECYCLE & STALE DATA TEST SUITE
   Verifies complete 20-point requirements matrix + 10:41 -> 12:00 regression
============================================================ */

const assert = require("assert");
const {
    buildUnifiedSnapshot,
    getActiveSnapshot,
    saveSnapshot,
    buildUnavailableSnapshot,
    computeCombinedClosureTimeline,
    determineCrossingStatus
} = require("./services/forecast-snapshot");

const {
    V1_CROSSINGS,
    TIMING_CONFIG
} = require("./config/corridor");

let passed = 0;
let total = 0;

function check(desc, condition) {
    total++;
    if (condition) {
        passed++;
        console.log(`  ✅ [${passed}/${total}] ${desc}`);
    } else {
        console.error(`  ❌ [FAIL] ${desc}`);
        throw new Error(`Assertion failed: ${desc}`);
    }
}

console.log("\n============================================================");
console.log("   FATAKFORECAST — EVENT LIFECYCLE & STALE DATA SUITE       ");
console.log("============================================================\n");

// ------------------------------------------------------------
// TEST 1: No trains within 60 min -> OPEN, primaryTrain null
// ------------------------------------------------------------
console.log("--- 1. Empty Horizon (<60m) State ---");
{
    const now = new Date("2026-09-14T12:00:00.000Z");
    const snapshot = buildUnifiedSnapshot({
        cycleId: "test-empty",
        cycleTimestamp: now.toISOString(),
        eventsByCrossing: {
            "talwandi-dogran": [],
            "manawala-road": [],
            "rakh-devi-dasspura": [],
            "jandiala": []
        }
    });

    const f = snapshot.crossings["manawala-road"];
    check("Empty horizon has status OPEN", f.status === "OPEN");
    check("Empty horizon primaryTrain is null", f.primaryTrain === null);
    check("Empty horizon timingMetrics is null", f.timingMetrics === null);
    check("Empty horizon message indicates corridor clear", f.message.includes("No train expected within the next hour"));
}

// ------------------------------------------------------------
// TEST 2: Single train passage timeline state transitions
// ------------------------------------------------------------
console.log("\n--- 2. Single Train Lifecycle States ---");
{
    const passageMs = new Date("2026-09-14T12:20:00.000Z").getTime();
    const trainEv = {
        train_number: "12460",
        train_name: "Amritsar Intercity",
        direction: "forward",
        estimated_passage_time: new Date(passageMs).toISOString()
    };

    // 20 min before -> OPEN
    const status20 = determineCrossingStatus(trainEv, "LIVE_FRESH", new Date(passageMs - 20 * 60000));
    check("20 min before passage -> OPEN", status20.status === "OPEN");

    // 10 min before -> FATAK CLOSED under the 11-minute baseline
    const status10 = determineCrossingStatus(trainEv, "LIVE_FRESH", new Date(passageMs - 10 * 60000));
    check("10 min before passage -> FATAK CLOSED", status10.status === "FATAK CLOSED");

    // 5 min before -> FATAK CLOSED
    const status5 = determineCrossingStatus(trainEv, "LIVE_FRESH", new Date(passageMs - 5 * 60000));
    check("5 min before passage -> FATAK CLOSED", status5.status === "FATAK CLOSED");

    // 1 min after passage -> OPEN under the 1-minute reopening baseline
    const status1After = determineCrossingStatus(trainEv, "LIVE_FRESH", new Date(passageMs + 1.0 * 60000));
    check("1 min after passage -> OPEN", status1After.status === "OPEN");

    // 2 min after passage -> OPEN
    const status2After = determineCrossingStatus(trainEv, "LIVE_FRESH", new Date(passageMs + 2.0 * 60000));
    check("2 min after passage -> OPEN", status2After.status === "OPEN");
}

// ------------------------------------------------------------
// TEST 3 & 4: Continuous / Overlapping Closures (2 and 3 trains)
// ------------------------------------------------------------
console.log("\n--- 3 & 4. Multi-Train Continuous Closure ---");
{
    const now = new Date("2026-09-14T12:00:00.000Z");
    const t1 = new Date("2026-09-14T12:10:00.000Z");
    const t2 = new Date("2026-09-14T12:17:00.000Z"); // 7 min gap (<= 10m threshold)
    const t3 = new Date("2026-09-14T12:24:00.000Z"); // 7 min gap

    const candidates2 = [
        { train_number: "12014", train_name: "Shatabdi", estimated_passage_time: t1.toISOString() },
        { train_number: "18238", train_name: "Chhattisgarh", estimated_passage_time: t2.toISOString() }
    ];

    const timeline2 = computeCombinedClosureTimeline(candidates2, now);
    check("2 trains with 7m gap merge into continuous closure", timeline2.isContinuous === true);
    check("Continuous closure train count is 2", timeline2.trainCount === 2);
    check("Continuous closure start anchored to train 1 lead buffer", timeline2.closureStart === new Date(t1.getTime() - 11 * 60000).toISOString());
    check("Continuous closure end anchored to train 2 reopen buffer", timeline2.closureEnd === new Date(t2.getTime() + 1 * 60000).toISOString());

    const candidates3 = [...candidates2, { train_number: "14632", train_name: "Dehradun Exp", estimated_passage_time: t3.toISOString() }];
    const timeline3 = computeCombinedClosureTimeline(candidates3, now);
    check("3 trains merge into single continuous closure", timeline3.isContinuous === true && timeline3.trainCount === 3);
    check("3 trains continuous end spans through train 3 reopen", timeline3.closureEnd === new Date(t3.getTime() + 1 * 60000).toISOString());
}

// ------------------------------------------------------------
// TEST 5: Bidirectional simultaneous trains
// ------------------------------------------------------------
console.log("\n--- 5. Bidirectional Simultaneous Trains ---");
{
    const now = new Date("2026-09-14T12:00:00.000Z");
    const snapshot = buildUnifiedSnapshot({
        cycleId: "test-bidi",
        cycleTimestamp: now.toISOString(),
        eventsByCrossing: {
            "manawala-road": [
                { train_number: "12014", direction: "forward", estimated_passage_time: "2026-09-14T12:15:00.000Z" },
                { train_number: "12013", direction: "backward", estimated_passage_time: "2026-09-14T12:18:00.000Z" }
            ]
        }
    });

    const f = snapshot.crossings["manawala-road"];
    check("Bidirectional trains both processed", f.upcomingTrains.length === 1 && f.primaryTrain !== null);
    check("Primary train retains direction forward", f.primaryTrain.direction === "forward");
    check("Subsequent train retains direction backward", f.upcomingTrains[0].direction === "backward");
}

// ------------------------------------------------------------
// TEST 6: Chronological Ordering of Same-Direction Trains
// ------------------------------------------------------------
console.log("\n--- 6. Chronological Train Ordering ---");
{
    const now = new Date("2026-09-14T12:00:00.000Z");
    const snapshot = buildUnifiedSnapshot({
        cycleId: "test-order",
        cycleTimestamp: now.toISOString(),
        eventsByCrossing: {
            "jandiala": [
                { train_number: "99999", estimated_passage_time: "2026-09-14T12:40:00.000Z" },
                { train_number: "11111", estimated_passage_time: "2026-09-14T12:12:00.000Z" },
                { train_number: "55555", estimated_passage_time: "2026-09-14T12:25:00.000Z" }
            ]
        }
    });

    const f = snapshot.crossings["jandiala"];
    check("Earliest train selected as primary", f.primaryTrain.trainNumber === "11111");
    check("Second earliest is first in upcoming", f.upcomingTrains[0].trainNumber === "55555");
    check("Third earliest is second in upcoming", f.upcomingTrains[1].trainNumber === "99999");
}

// ------------------------------------------------------------
// TEST 7: Train Already Passed (> 1m) -> Archived to lastTrainPassed
// ------------------------------------------------------------
console.log("\n--- 7. Completed Train Archival ---");
{
    const now = new Date("2026-09-14T12:00:00.000Z");
    const passedPassage = new Date("2026-09-14T11:55:00.000Z"); // 5m ago (> 1m buffer)
    const snapshot = buildUnifiedSnapshot({
        cycleId: "test-passed",
        cycleTimestamp: now.toISOString(),
        eventsByCrossing: {
            "rakh-devi-dasspura": [
                {
                    train_number: "18238",
                    train_name: "Chhattisgarh Express",
                    direction: "forward",
                    estimated_passage_time: passedPassage.toISOString()
                }
            ]
        }
    });

    const f = snapshot.crossings["rakh-devi-dasspura"];
    check("Passed train is NOT primaryTrain", f.primaryTrain === null);
    check("Passed train is archived to lastTrainPassed", f.lastTrainPassed !== null && f.lastTrainPassed.trainNumber === "18238");
    check("lastTrainPassed preserves passage time", f.lastTrainPassed.passageTime === passedPassage.toISOString());
    check("Crossing status is OPEN", f.status === "OPEN");
}

// ------------------------------------------------------------
// TEST 8: Transition from Primary Event to Next Upcoming Event
// ------------------------------------------------------------
console.log("\n--- 8. Primary Train Transition on Passage ---");
{
    const baseNow = new Date("2026-09-14T12:00:00.000Z");
    const t1 = new Date("2026-09-14T12:01:00.000Z");
    const t2 = new Date("2026-09-14T12:15:00.000Z");

    const snapshot = buildUnifiedSnapshot({
        cycleId: "test-trans",
        cycleTimestamp: baseNow.toISOString(),
        eventsByCrossing: {
            "talwandi-dogran": [
                { train_number: "TRAIN_A", estimated_passage_time: t1.toISOString() },
                { train_number: "TRAIN_B", estimated_passage_time: t2.toISOString() }
            ]
        }
    });

    // Save as active snapshot
    saveSnapshot(snapshot, false);

    // Verify initial active snapshot at 12:00: TRAIN_A is primary
    const active1 = getActiveSnapshot(baseNow);
    check("Initial primary is TRAIN_A", active1.crossings["talwandi-dogran"].primaryTrain.trainNumber === "TRAIN_A");

    // Advance clock to 12:03 (+2m past TRAIN_A passage, which completed at 12:02:30)
    const laterSnapshot = buildUnifiedSnapshot({
        cycleId: "test-trans-2",
        cycleTimestamp: new Date("2026-09-14T12:03:00.000Z").toISOString(),
        eventsByCrossing: {
            "talwandi-dogran": [
                { train_number: "TRAIN_A", estimated_passage_time: t1.toISOString() },
                { train_number: "TRAIN_B", estimated_passage_time: t2.toISOString() }
            ]
        }
    });
    saveSnapshot(laterSnapshot, false);

    const active2 = getActiveSnapshot(new Date("2026-09-14T12:03:00.000Z"));
    const f2 = active2.crossings["talwandi-dogran"];
    check("After TRAIN_A passes, TRAIN_B promoted to primary", f2.primaryTrain.trainNumber === "TRAIN_B");
    check("TRAIN_A moved to lastTrainPassed", f2.lastTrainPassed.trainNumber === "TRAIN_A");
}

// ------------------------------------------------------------
// TEST 9: Unknown Direction Safety
// ------------------------------------------------------------
console.log("\n--- 9. Unknown Direction Safe Handling ---");
{
    const trainUnknown = {
        train_number: "UNKNOWN_TR",
        estimated_passage_time: "2026-09-14T12:20:00.000Z",
        direction: "unknown"
    };
    const status = determineCrossingStatus(trainUnknown, "LIVE_FRESH", new Date("2026-09-14T12:00:00.000Z"));
    check("Unknown direction evaluates safely without error", status.status === "OPEN");
}

// ------------------------------------------------------------
// TEST 10: Unavailable Snapshot Fallback
// ------------------------------------------------------------
console.log("\n--- 10. Backend Unavailable Fallback ---");
{
    const unavail = buildUnavailableSnapshot("Render cold start / network timeout");
    check("Unavailable snapshot freshness is UNAVAILABLE", unavail.freshness === "UNAVAILABLE");
    check("Unavailable crossing status is LIVE_DATA_UNAVAILABLE", unavail.crossings["manawala-road"].status === "LIVE_DATA_UNAVAILABLE");
    check("Unavailable crossing lastTrainPassed is null", unavail.crossings["manawala-road"].lastTrainPassed === null);
    check("Unavailable snapshot corridorQueue is empty", unavail.corridorQueue.length === 0);
}

// ------------------------------------------------------------
// TEST 11: Continuous Closure Threshold Sensitivity (5, 8, 9, 10, 11, 12, 14 min)
// ------------------------------------------------------------
console.log("\n--- 11. Continuous Closure Threshold Gap Sensitivity ---");
{
    const now = new Date("2026-09-14T12:00:00.000Z");
    const gaps = [5, 8, 9, 10, 11, 12, 14];
    const results = {};

    for (const gap of gaps) {
        const candidates = [
            { train_number: "T1", estimated_passage_time: "2026-09-14T12:15:00.000Z" },
            { train_number: "T2", estimated_passage_time: new Date(new Date("2026-09-14T12:15:00.000Z").getTime() + gap * 60000).toISOString() }
        ];
        const timeline = computeCombinedClosureTimeline(candidates, now, { thresholdMinutes: 10 });
        results[gap] = timeline.isContinuous;
    }

    check("5 min gap is continuous", results[5] === true);
    check("8 min gap is continuous", results[8] === true);
    check("9 min gap is continuous", results[9] === true);
    check("10 min gap is continuous", results[10] === true);
    check("11 min gap remains continuous because closure intervals overlap", results[11] === true);
    check("12 min gap remains continuous because closure intervals touch", results[12] === true);
    check("14 min gap is NOT continuous", results[14] === false);
}

// ------------------------------------------------------------
// TEST 12: CRITICAL REGRESSION TEST (10:41 AM -> 12:00 PM)
// ------------------------------------------------------------
console.log("\n--- 12. CRITICAL REGRESSION: 10:41 AM Train Evaluated at 12:00 PM ---");
{
    // Reset active snapshot to isolate 10:41 AM simulation
    saveSnapshot(null, false);

    // Simulate: Train #18238 passed Manawala at 10:41 AM
    const passage1041 = new Date("2026-09-14T10:41:00.000Z");
    const snapshotAt1030 = buildUnifiedSnapshot({
        cycleId: "cycle-1030",
        cycleTimestamp: "2026-09-14T10:30:00.000Z",
        eventsByCrossing: {
            "talwandi-dogran": [],
            "manawala-road": [
                {
                    train_number: "18238",
                    train_name: "Chhattisgarh Express",
                    direction: "forward",
                    estimated_passage_time: passage1041.toISOString()
                }
            ],
            "rakh-devi-dasspura": [],
            "jandiala": []
        }
    });
    saveSnapshot(snapshotAt1030, false);

    // Advance wall clock to 12:00 PM (1 hour and 19 minutes later)
    const now1200 = new Date("2026-09-14T12:00:00.000Z");

    // Engine runs cycle at 12:00 PM with no new trains
    const snapshotAt1200 = buildUnifiedSnapshot({
        cycleId: "cycle-1200",
        cycleTimestamp: now1200.toISOString(),
        eventsByCrossing: {
            "talwandi-dogran": [],
            "manawala-road": [
                // RailRadar or historical logger still holds the old 10:41 record
                {
                    train_number: "18238",
                    train_name: "Chhattisgarh Express",
                    direction: "forward",
                    estimated_passage_time: passage1041.toISOString()
                }
            ],
            "rakh-devi-dasspura": [],
            "jandiala": []
        }
    });
    saveSnapshot(snapshotAt1200, false);

    const liveSnapshot1200 = getActiveSnapshot(now1200);
    const manawala = liveSnapshot1200.crossings["manawala-road"];

    check("12:00 PM status is strictly OPEN", manawala.status === "OPEN");
    check("12:00 PM primaryTrain is strictly NULL (never shows old train as active)", manawala.primaryTrain === null);
    check("12:00 PM timingMetrics is strictly NULL", manawala.timingMetrics === null);
    check("12:00 PM closure is strictly NULL", manawala.closure === null);
    check("12:00 PM reopening is strictly NULL", manawala.reopening === null);
    check("12:00 PM trainPassage is strictly NULL", manawala.trainPassage === null);
    check("12:00 PM upcomingTrains is strictly empty", manawala.upcomingTrains.length === 0);
    check("12:00 PM lastTrainPassed is strictly null (>60m expired)", manawala.lastTrainPassed === null);
    check("12:00 PM root snapshot lastTrainPassed is strictly null (>60m expired)", liveSnapshot1200.lastTrainPassed === null);
}

console.log("\n============================================================");
console.log(`LIFECYCLE & STALE DATA SUITE: ${passed}/${total} PASSED (100%)`);
console.log("============================================================\n");
