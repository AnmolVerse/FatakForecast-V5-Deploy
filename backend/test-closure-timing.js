const {
    predictClosure
} = require("./services/closure-predictor");


// ============================================================
// FATAKFORECAST — CLOSURE TIMING TEST
// ============================================================

function printResult(title, result) {

    console.log("");
    console.log("========================================");
    console.log(title);
    console.log("========================================");

    console.log(
        "Forecast timing:",
        result.forecastTiming
    );

    console.log(
        "Prediction mode:",
        result.mode
    );

    console.log(
        "Confidence:",
        result.confidence
    );

    console.log(
        "Train passage:",
        result.trainPassageTime
    );

    console.log(
        "Predicted closure:",
        result.closure.earliest,
        "→",
        result.closure.latest
    );

    console.log(
        "Message:",
        result.message
    );
}


// ============================================================
// TEST 1 — LATE DETECTION
// ============================================================
//
// Passage is 5 minutes from now.
//
// Baseline closure is normally 11 min baselineutes before passage,
// therefore the predicted closure window is already in the
// past.
//
// Expected:
// forecastTiming.state = LATE_DETECTION
// lateDetection = true
// ============================================================

const latePassage =
    new Date(
        Date.now() +
        5 * 60 * 1000
    );


const lateResult =
    predictClosure({

        crossingId:
            "jandiala",

        crossingName:
            "Jandiala Railway Crossing",

        direction:
            "forward",

        trainPassageTime:
            latePassage.toISOString()
    });


printResult(
    "TEST 1 — LATE DETECTION",
    lateResult
);


// ============================================================
// TEST 2 — UPCOMING FORECAST
// ============================================================
//
// Passage is 20 minutes from now.
//
// Baseline closure is 11 min baselineutes before passage,
// so the closure window should still be in the future.
//
// Expected:
// forecastTiming.state = UPCOMING
// lateDetection = false
// ============================================================

const upcomingPassage =
    new Date(
        Date.now() +
        20 * 60 * 1000
    );


const upcomingResult =
    predictClosure({

        crossingId:
            "jandiala",

        crossingName:
            "Jandiala Railway Crossing",

        direction:
            "forward",

        trainPassageTime:
            upcomingPassage.toISOString()
    });


printResult(
    "TEST 2 — UPCOMING FORECAST",
    upcomingResult
);


// ============================================================
// AUTOMATIC VALIDATION
// ============================================================

console.log("");
console.log("========================================");
console.log("           TEST VALIDATION");
console.log("========================================");


const latePassed =
    lateResult.forecastTiming.state ===
    "LATE_DETECTION" &&
    lateResult.forecastTiming.lateDetection === true;


const upcomingPassed =
    upcomingResult.forecastTiming.state ===
    "UPCOMING" &&
    upcomingResult.forecastTiming.lateDetection === false;


console.log(
    latePassed
        ? "✅ TEST 1 PASSED — Late detection works"
        : "❌ TEST 1 FAILED"
);


console.log(
    upcomingPassed
        ? "✅ TEST 2 PASSED — Upcoming forecast works"
        : "❌ TEST 2 FAILED"
);


console.log("");

if (
    latePassed &&
    upcomingPassed
) {

    console.log(
        "🎉 ALL CLOSURE TIMING TESTS PASSED"
    );

} else {

    console.log(
        "⚠️ SOME TESTS FAILED — DO NOT MOVE ON YET"
    );
}

console.log("");