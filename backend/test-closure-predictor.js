const {
    predictClosure,
    getDatasetSummary,
    getValidEvents,
    BASELINE
} = require("./services/closure-predictor");

console.log("========================================");
console.log("     FATAKFORECAST CLOSURE PREDICTOR");
console.log("========================================");


// ============================================================
// DATASET STATUS
// ============================================================

const validEvents = getValidEvents();
const summary = getDatasetSummary();

console.log("\nDATASET STATUS");
console.log("----------------------------------------");

console.log(
    "Valid training events:",
    validEvents.length
);

console.log(
    "Total valid events:",
    summary.totalValidEvents
);

console.log(
    "Crossing statistics:"
);

console.log(
    JSON.stringify(
        summary.crossings,
        null,
        2
    )
);


// ============================================================
// BASELINE CONFIGURATION
// ============================================================

console.log("\nBASELINE CONFIGURATION");
console.log("----------------------------------------");

console.log(
    `Closure lead: ${BASELINE.closureLeadMinutes} minutes before train`
);

console.log(
    `Reopening: +${BASELINE.reopenDelayMinutes} minute after train`
);


// ============================================================
// TEST PREDICTION
// ============================================================

console.log("\nTEST PREDICTION");
console.log("----------------------------------------");

const testPrediction = predictClosure({
    crossingId: "jandiala",
    crossingName: "Jandiala Railway Crossing",
    direction: "forward",

    // Example train passage time.
    // This is ONLY a test timestamp.
    trainPassageTime:
        "2026-09-11T14:47:00+05:30"
});

console.log(
    JSON.stringify(
        testPrediction,
        null,
        2
    )
);


// ============================================================
// HUMAN-READABLE RESULT
// ============================================================

console.log("\n========================================");
console.log("           PREDICTION RESULT");
console.log("========================================");

console.log(
    "Mode:",
    testPrediction.mode
);

console.log(
    "Confidence:",
    testPrediction.confidence
);

console.log(
    "Source:",
    testPrediction.source
);

console.log(
    "Safety bias:",
    testPrediction.safetyBias
);

console.log(
    "\nTrain passage:",
    testPrediction.trainPassageTime
);

console.log(
    "\nLikely gate closure:"
);

console.log(
    "  Earliest:",
    testPrediction.closure.earliest
);

console.log(
    "  Latest:",
    testPrediction.closure.latest
);

console.log(
    "  Recommended cross by:",
    testPrediction.closure.recommendedCrossBy
);

console.log(
    "\nLikely reopening:"
);

console.log(
    "  Earliest:",
    testPrediction.reopening.earliest
);

console.log(
    "  Latest:",
    testPrediction.reopening.latest
);

console.log("\n========================================");
console.log("TEST COMPLETED");
console.log("========================================");