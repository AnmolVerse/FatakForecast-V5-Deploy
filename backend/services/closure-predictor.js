// ============================================================
// FATAKFORECAST — CONSERVATIVE CLOSURE PREDICTOR
// ============================================================
//
// Converts:
//
//     TRAIN PASSAGE TIME
//             ↓
//     EXPECTED GATE CLOSURE WINDOW
//             ↓
//     EXPECTED REOPENING WINDOW
//
// IMPORTANT:
//
// This module PREDICTS gate behaviour.
// It does NOT confirm the physical gate status.
//
// No live gate-status source is assumed here.
//
// Prediction hierarchy:
//
//     sufficient historical data
//             ↓
//     learned crossing/direction model
//
//     insufficient historical data
//             ↓
//     conservative baseline estimate
//
// The frontend MUST distinguish:
//
//     "Predicted closure"
//     from
//     "Confirmed gate closed"
//
// ============================================================


const fs = require("fs");
const path = require("path");


const MATCHED_EVENTS_FILE =
    path.join(
        __dirname,
        "../data/matched-events.json"
    );

const {
    predict: predictMlClosure,
    getModel: getMlModel
} = require("./ml-closure-model");


// ============================================================
// INITIAL BASELINE
// ============================================================
//
// Used only when there is not enough historical data.
//
// These are NOT confirmed gate timings.
//
// They are conservative initial estimates that allow
// FatakForecast to provide an early warning while the
// dataset is being built.
//
// ============================================================

const BASELINE = {

    // Initial product baseline. This is a prior, not ground truth.
    closureLeadMinutes:
        11,

    reopenDelayMinutes:
        1
};


// ============================================================
// LEARNING SETTINGS
// ============================================================

const MIN_CROSSING_SAMPLES =
    1;

const MIN_DIRECTION_SAMPLES =
    1;

const SAFETY_BUFFER_MINUTES =
    0.5;

// The first few real observations should correct the baseline gradually,
// not replace it completely. This prevents one unusual observation from
// becoming the entire model.
const PRIOR_STRENGTH = 3;
const MIN_ML_SAMPLES = 20;
const MIN_LEAD_MINUTES = 0;
const MAX_LEAD_MINUTES = 30;
const MIN_REOPEN_MINUTES = 0.25;
const MAX_REOPEN_MINUTES = 10;



// ============================================================
// FILE HELPERS
// ============================================================

function loadMatchedEvents() {

    try {

        if (
            !fs.existsSync(
                MATCHED_EVENTS_FILE
            )
        ) {

            return [];
        }


        const raw =
            fs.readFileSync(
                MATCHED_EVENTS_FILE,
                "utf8"
            );


        if (
            !raw.trim()
        ) {

            return [];
        }


        const data =
            JSON.parse(
                raw
            );


        return Array.isArray(data)
            ? data
            : [];

    }
    catch (error) {

        console.error(
            "Failed to read matched-events.json:",
            error.message
        );


        return [];
    }
}


// ============================================================
// UTILITY — MEDIAN
// ============================================================

function median(
    values
) {

    if (
        !Array.isArray(values) ||
        values.length === 0
    ) {

        return null;
    }


    const sorted =
        [...values]
            .map(Number)
            .filter(
                Number.isFinite
            )
            .sort(
                (a, b) =>
                    a - b
            );


    if (
        sorted.length === 0
    ) {

        return null;
    }


    const middle =
        Math.floor(
            sorted.length / 2
        );


    if (
        sorted.length % 2 === 0
    ) {

        return (
            sorted[middle - 1] +
            sorted[middle]
        ) / 2;
    }


    return sorted[middle];
}


// ============================================================
// UTILITY — PERCENTILE
// ============================================================

function percentile(
    values,
    percentileValue
) {

    if (
        !Array.isArray(values) ||
        values.length === 0
    ) {

        return null;
    }


    const sorted =
        [...values]
            .map(Number)
            .filter(
                Number.isFinite
            )
            .sort(
                (a, b) =>
                    a - b
            );


    if (
        sorted.length === 0
    ) {

        return null;
    }


    const index =
        (
            percentileValue / 100
        ) *
        (
            sorted.length - 1
        );


    const lower =
        Math.floor(
            index
        );


    const upper =
        Math.ceil(
            index
        );


    if (
        lower === upper
    ) {

        return sorted[lower];
    }


    const weight =
        index - lower;


    return (
        sorted[lower] +
        (
            sorted[upper] -
            sorted[lower]
        ) *
        weight
    );
}


// ============================================================
// ADD MINUTES TO DATE
// ============================================================

function addMinutes(
    date,
    minutes
) {

    return new Date(
        date.getTime() +
        minutes *
        60 *
        1000
    );
}


// ============================================================
// VALID TRAINING DATA
// ============================================================

function getValidEvents() {

    const events =
        loadMatchedEvents();


    return events.filter(
        event => {

            const crossingId =
                event.crossing_id;


            const direction =
                event.direction;


            const lead =
                Number(
                    event.closure_lead_time_minutes
                );


            return (

                crossingId &&

                direction &&

                Number.isFinite(lead) &&

                lead >= MIN_LEAD_MINUTES &&

                lead <= MAX_LEAD_MINUTES

            );
        }
    );
}


function calculateMean(
    values
) {
    if (
        !Array.isArray(values) ||
        values.length === 0
    ) {
        return null;
    }

    const valid = values.map(Number).filter(Number.isFinite);
    if (valid.length === 0) return null;

    const sum = valid.reduce((acc, val) => acc + val, 0);
    return sum / valid.length;
}

function calculateStdDev(
    values,
    meanValue
) {
    if (
        !Array.isArray(values) ||
        values.length <= 1
    ) {
        return 0;
    }

    const valid = values.map(Number).filter(Number.isFinite);
    if (valid.length <= 1) return 0;

    const m = (meanValue !== null && meanValue !== undefined)
        ? meanValue
        : calculateMean(valid);

    const sumSquares = valid.reduce((acc, val) => acc + Math.pow(val - m, 2), 0);
    return Math.sqrt(sumSquares / (valid.length - 1));
}


// ============================================================
// DATASET STATISTICS
// ============================================================

function getStatistics(
    events
) {

    const leadTimes =
        events
            .map(
                event =>
                    Number(
                        event.closure_lead_time_minutes
                    )
            )
            .filter(
                Number.isFinite
            );


    const durations =
        events
            .map(
                event =>
                    Number(
                        event.closure_duration_minutes
                    )
            )
            .filter(
                Number.isFinite
            );

    const leadMean = calculateMean(leadTimes);
    const durMean = calculateMean(durations);

    return {

        sampleCount:
            events.length,


        leadTime: {

            mean:
                leadMean !== null
                    ? Number(leadMean.toFixed(2))
                    : null,

            stdDev:
                leadMean !== null
                    ? Number(calculateStdDev(leadTimes, leadMean).toFixed(2))
                    : null,

            median:
                median(
                    leadTimes
                ),

            p25:
                percentile(
                    leadTimes,
                    25
                ),

            p75:
                percentile(
                    leadTimes,
                    75
                ),

            p90:
                percentile(
                    leadTimes,
                    90
                )
        },


        duration: {

            mean:
                durMean !== null
                    ? Number(durMean.toFixed(2))
                    : null,

            stdDev:
                durMean !== null
                    ? Number(calculateStdDev(durations, durMean).toFixed(2))
                    : null,

            median:
                median(
                    durations
                ),

            p25:
                percentile(
                    durations,
                    25
                ),

            p75:
                percentile(
                    durations,
                    75
                ),

            p90:
                percentile(
                    durations,
                    90
                )
        }
    };
}


// ============================================================
// CROSSING-SPECIFIC EVENTS
// ============================================================

function getCrossingEvents(
    events,
    crossingId
) {

    return events.filter(
        event =>
            event.crossing_id ===
            crossingId
    );
}


// ============================================================
// DIRECTION-SPECIFIC EVENTS
// ============================================================

function getDirectionalEvents(
    events,
    crossingId,
    direction
) {

    return events.filter(
        event =>
            event.crossing_id ===
            crossingId &&

            event.direction ===
            direction
    );
}


// ============================================================
// CONSERVATIVE LEAD TIME
// ============================================================
//
// We use P75 rather than the median because the product
// should favour earlier warning over late warning.
//
// Safety buffer is added on top.
//
// ============================================================

function calculateAdaptiveLead(events) {

    if (!Array.isArray(events) || events.length === 0) {
        return null;
    }

    const leadTimes = events
        .map(event => Number(event.closure_lead_time_minutes))
        .filter(value => Number.isFinite(value) && value >= MIN_LEAD_MINUTES && value <= MAX_LEAD_MINUTES);

    if (!leadTimes.length) {
        return null;
    }

    const sumLeadTimes = leadTimes.reduce((sum, val) => sum + val, 0);

    // Bayesian prior-weighted statistical correction (K = 3):
    // adjustedLeadTime = (11 * 3 + sum(observedLeadTimes)) / (3 + N)
    const blended = (
        BASELINE.closureLeadMinutes * PRIOR_STRENGTH +
        sumLeadTimes
    ) / (PRIOR_STRENGTH + leadTimes.length);

    return Number(
        Math.max(MIN_LEAD_MINUTES, Math.min(MAX_LEAD_MINUTES, blended)).toFixed(2)
    );
}


// ============================================================
// LEARNED MODEL
// ============================================================

function getLearnedModel(
    crossingId,
    direction
) {

    const events = getValidEvents();
    const crossingEvents = getCrossingEvents(events, crossingId);
    const directionalEvents = getDirectionalEvents(events, crossingId, direction);

    // Direction-specific observations are preferred as soon as we have one.
    const sourceEvents = directionalEvents.length ? directionalEvents : crossingEvents;

    if (!sourceEvents.length) {
        return null;
    }

    const stats = getStatistics(sourceEvents);
    const lead = calculateAdaptiveLead(sourceEvents);

    if (!Number.isFinite(lead)) {
        return null;
    }

    const durationValues = sourceEvents
        .map(event => Number(event.closure_duration_minutes))
        .filter(value => Number.isFinite(value) && value >= 0 && value <= MAX_REOPEN_MINUTES);

    const observedDuration = durationValues.length
        ? median(durationValues)
        : null;

    const reopenDelay = observedDuration == null
        ? BASELINE.reopenDelayMinutes
        : (
            BASELINE.reopenDelayMinutes * PRIOR_STRENGTH +
            observedDuration * durationValues.length
        ) / (PRIOR_STRENGTH + durationValues.length);

    const source = directionalEvents.length
        ? "crossing-direction-adaptive-history"
        : "crossing-adaptive-history";

    return {
        source,
        sampleCount: sourceEvents.length,
        conservativeLeadMinutes: lead,
        medianLeadMinutes: stats.leadTime.median,
        p75LeadMinutes: stats.leadTime.p75,
        medianDurationMinutes: Number.isFinite(reopenDelay)
            ? Math.max(MIN_REOPEN_MINUTES, Math.min(MAX_REOPEN_MINUTES, reopenDelay))
            : BASELINE.reopenDelayMinutes,
        p75DurationMinutes: stats.duration.p75,
        modelStage: sourceEvents.length >= MIN_ML_SAMPLES ? "ml-eligible" : "adaptive-statistical"
    };
}


// ============================================================
// FORECAST TIMING
// ============================================================
//
// States:
//
// UPCOMING
//     Entire predicted closure window is still ahead.
//
// CLOSURE_WINDOW
//     Current time is inside predicted closure window.
//
// LATE_DETECTION
//     Predicted closure window has passed but train has
//     not yet reached the crossing.
//
// PASSED
//     Train passage itself is already in the past.
//
// ============================================================

function determineForecastTiming(
    closureEarliest,
    closureLatest,
    passageTime
) {

    const now =
        Date.now();


    const closureStart =
        closureEarliest.getTime();


    const closureEnd =
        closureLatest.getTime();


    const passage =
        passageTime.getTime();


    // --------------------------------------------------------
    // Passage already happened
    // --------------------------------------------------------

    if (
        passage <= now
    ) {

        return {

            state:
                "PASSED",

            lateDetection:
                false,

            lateByMinutes:
                0
        };
    }


    // --------------------------------------------------------
    // Entire closure window is ahead
    // --------------------------------------------------------

    if (
        now < closureStart
    ) {

        return {

            state:
                "UPCOMING",

            lateDetection:
                false,

            lateByMinutes:
                0
        };
    }


    // --------------------------------------------------------
    // Currently inside predicted closure window
    // --------------------------------------------------------

    if (
        now >= closureStart &&
        now <= closureEnd
    ) {

        return {

            state:
                "CLOSURE_WINDOW",

            lateDetection:
                false,

            lateByMinutes:
                0
        };
    }


    // --------------------------------------------------------
    // Closure prediction has already passed
    // --------------------------------------------------------

    const lateByMinutes =
        (
            now -
            closureEnd
        ) /
        (
            60 *
            1000
        );


    return {

        state:
            "LATE_DETECTION",

        lateDetection:
            true,

        lateByMinutes:
            Number(
                lateByMinutes.toFixed(2)
            )
    };
}


// ============================================================
// BUILD TIMING METADATA
// ============================================================

function buildTimingMetadata(
    closureEarliest,
    closureLatest,
    passageTime
) {

    return determineForecastTiming(
        closureEarliest,
        closureLatest,
        passageTime
    );
}


// ============================================================
// CONFIDENCE
// ============================================================
//
// IMPORTANT:
//
// This is MODEL confidence.
//
// It is NOT:
//
//     probability that the gate is closed.
//
// No fake probability is generated.
//
// ============================================================

function calculateConfidence(
    sampleCount
) {

    if (
        sampleCount >= 20
    ) {

        return "high";
    }


    if (
        sampleCount >= 10
    ) {

        return "medium";
    }


    return "low";
}


// ============================================================
// MAIN PREDICTION
// ============================================================

function predictClosure({
    crossingId,
    crossingName,
    direction,
    trainPassageTime,
    speedKmph = null,
    delayMinutes = null
}) {

    // --------------------------------------------------------
    // Validate passage time
    // --------------------------------------------------------

    if (
        !trainPassageTime
    ) {

        throw new Error(
            "trainPassageTime is required."
        );
    }


    const passageTime =
        new Date(
            trainPassageTime
        );


    if (
        Number.isNaN(
            passageTime.getTime()
        )
    ) {

        throw new Error(
            "Invalid trainPassageTime."
        );
    }


    // ========================================================
    // TRY LEARNED MODEL
    // ========================================================

    const learnedModel =
        crossingId &&
        direction

            ? getLearnedModel(
                crossingId,
                direction
            )

            : null;

    const mlPrediction =
        crossingId && direction
            ? predictMlClosure({
                crossingId,
                direction,
                passageTime,
                speedKmph,
                delayMinutes
            })
            : null;


    // ========================================================
    // BASELINE MODEL
    // ========================================================
    //
    // Used while we are still collecting enough actual
    // gate observations.
    //
    // This remains explicitly labelled as an estimate.
    //
    // ========================================================

    if (
        !learnedModel
    ) {

        const closureEarliest =
            addMinutes(
                passageTime,
                -BASELINE.closureLeadMinutes
            );


        const closureLatest =
            addMinutes(
                passageTime,
                -BASELINE.closureLeadMinutes
            );


        const reopenEarliest =
            addMinutes(
                passageTime,
                BASELINE.reopenDelayMinutes
            );


        const reopenLatest =
            addMinutes(
                passageTime,
                BASELINE.reopenDelayMinutes
            );


        const timing =
            buildTimingMetadata(
                closureEarliest,
                closureLatest,
                passageTime
            );


        return {

            ready:
                true,


            mode:
                "baseline",


            confidence:
                "initial-estimate",


            crossingId,

            crossingName,

            direction,


            trainPassageTime:
                passageTime.toISOString(),


            forecastTiming:
                timing,


            closure: {

                earliest:
                    closureEarliest.toISOString(),

                latest:
                    closureLatest.toISOString(),

                recommendedCrossBy:
                    addMinutes(
                        passageTime,
                        -(
                            BASELINE.closureLeadMinutes +
                            1
                        )
                    ).toISOString()
            },


            reopening: {

                earliest:
                    reopenEarliest.toISOString(),

                latest:
                    reopenLatest.toISOString()
            },


            leadTime: {

                predicted:
                    BASELINE.closureLeadMinutes,

                minimum:
                    BASELINE.closureLeadMinutes,

                maximum:
                    BASELINE.closureLeadMinutes
            },


            sampleCount:
                0,

            modelStage:
                "baseline",

            source:
                "11-minute-baseline",

            safetyBias:
                "early",

            mlActive:
                false,

            baselineActive:
                true,

            mlStatus:
                `INSUFFICIENT DATA (0/${MIN_ML_SAMPLES} observations)`,

            verifiedObservationsCount:
                0,

            recommendation:
                timing.state ===
                "UPCOMING"

                    ? "Plan to cross before the predicted closure window."

                    : timing.state ===
                      "CLOSURE_WINDOW"

                        ? "Predicted closure window is active; gate status is not confirmed."

                        : timing.state ===
                          "LATE_DETECTION"

                            ? "Predicted closure window has passed; gate status is not confirmed."

                            : "Train passage has already occurred.",


            message:
                "Initial 11-minute baseline. No verified gate observations are available yet. " +
                "This is NOT live gate-status confirmation."
        };
    }


    // ========================================================
    // LEARNED MODEL
    // ========================================================

    const lead =
        mlPrediction?.leadMinutes ??
        learnedModel.conservativeLeadMinutes;

    const modelIsMl =
        Boolean(mlPrediction);


    // --------------------------------------------------------
    // Reopening delay
    //
    // Prefer learned median duration.
    // Fall back to conservative baseline.
    // --------------------------------------------------------

    let reopenDelay =
        learnedModel.medianDurationMinutes;


    if (
        !Number.isFinite(
            reopenDelay
        )
    ) {

        reopenDelay =
            BASELINE.reopenDelayMinutes;
    }


    // --------------------------------------------------------
    // Keep reopening estimate bounded.
    //
    // This avoids one anomalous historical observation
    // creating an absurd reopening forecast.
    // --------------------------------------------------------

    reopenDelay =
        Math.max(
            MIN_REOPEN_MINUTES,
            Math.min(
                reopenDelay,
                MAX_REOPEN_MINUTES
            )
        );


    // ========================================================
    // CLOSURE WINDOW
    // ========================================================

    const closureCenter =
        addMinutes(
            passageTime,
            -lead
        );


    const closureEarliest =
        addMinutes(
            closureCenter,
            -1
        );


    const closureLatest =
        closureCenter;


    // ========================================================
    // SAFE CROSS-BY TIME
    // ========================================================

    const recommendedCrossBy =
        addMinutes(
            passageTime,
            -(
                lead +
                1
            )
        );


    // ========================================================
    // REOPENING WINDOW
    // ========================================================

    const reopenEarliest =
        addMinutes(
            passageTime,
            reopenDelay
        );


    const reopenLatest =
        addMinutes(
            passageTime,
            reopenDelay + 1
        );


    // ========================================================
    // TIMING
    // ========================================================

    const timing =
        buildTimingMetadata(
            closureEarliest,
            closureLatest,
            passageTime
        );


    // ========================================================
    // MODEL CONFIDENCE
    // ========================================================

    const confidence =
        calculateConfidence(
            learnedModel.sampleCount
        );


    // ========================================================
    // RECOMMENDATION
    // ========================================================

    let recommendation;


    if (
        timing.state ===
        "UPCOMING"
    ) {

        recommendation =
            "Plan to cross before the predicted closure window.";

    }
    else if (
        timing.state ===
        "CLOSURE_WINDOW"
    ) {

        recommendation =
            "Predicted closure window is active; gate status is not confirmed.";

    }
    else if (
        timing.state ===
        "LATE_DETECTION"
    ) {

        recommendation =
            "Predicted closure window has passed; gate status is not confirmed.";

    }
    else {

        recommendation =
            "Train passage has already occurred.";
    }


    // ========================================================
    // RETURN LEARNED PREDICTION
    // ========================================================

    return {

        ready:
            true,


        mode:
            modelIsMl
                ? "ml-ridge-regression"
                : "adaptive-statistical",


        confidence,


        crossingId,

        crossingName,

        direction,


        trainPassageTime:
            passageTime.toISOString(),


        forecastTiming:
            timing,


        closure: {

            earliest:
                closureEarliest.toISOString(),

            latest:
                closureLatest.toISOString(),

            recommendedCrossBy:
                recommendedCrossBy.toISOString()
        },


        reopening: {

            earliest:
                reopenEarliest.toISOString(),

            latest:
                reopenLatest.toISOString()
        },


        leadTime: {

            predicted:
                Number(
                    lead.toFixed(2)
                ),

            median:
                learnedModel.medianLeadMinutes,

            p75:
                learnedModel.p75LeadMinutes
        },


        reopeningDelayMinutes:
            Number(
                reopenDelay.toFixed(2)
            ),


        sampleCount:
            learnedModel.sampleCount,

        mlEvaluation:
            mlPrediction?.evaluation || null,

        modelStage:
            modelIsMl ? "ml" : learnedModel.modelStage,

        source:
            modelIsMl ? "ml-promoted-model" : learnedModel.source,

        safetyBias:
            "early",

        mlActive:
            modelIsMl,

        baselineActive:
            !modelIsMl,

        mlStatus:
            modelIsMl
                ? "ACTIVE"
                : (learnedModel.sampleCount < MIN_ML_SAMPLES
                    ? `INSUFFICIENT DATA (${learnedModel.sampleCount}/${MIN_ML_SAMPLES} observations)`
                    : "FALLBACK / BASELINE PREFERRED"),

        verifiedObservationsCount:
            learnedModel.sampleCount,


        recommendation,


        message:
            modelIsMl
                ? "ML prediction is active because the held-out model test beats the 11-minute baseline. Gate status is not directly confirmed."
                : "Prediction uses verified crossing observations with a gradual correction toward the 11-minute baseline. Gate status is not directly confirmed."
    };
}


// ============================================================
// DATASET SUMMARY
// ============================================================

function getDatasetSummary() {

    const events =
        getValidEvents();


    const crossings = {};


    for (
        const event of events
    ) {

        const id =
            event.crossing_id;


        if (
            !crossings[id]
        ) {

            crossings[id] = {

                total:
                    0,

                directions:
                    {}
            };
        }


        crossings[id].total++;


        const direction =
            event.direction;


        crossings[id]
            .directions[direction] =
                (
                    crossings[id]
                        .directions[direction] ||
                    0
                ) + 1;
    }


    const mlModel = getMlModel();

    return {

        totalValidEvents:
            events.length,

        mlReady:
            Boolean(mlModel.ready),

        mlMinimumSamples:
            MIN_ML_SAMPLES,

        mlModelReason:
            mlModel.reason || null,

        mlEvaluation:
            mlModel.evaluation || null,

        crossings
    };
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

    predictClosure,

    getLearnedModel,

    getDatasetSummary,

    getValidEvents,

    getStatistics,

    BASELINE,

    PRIOR_STRENGTH,

    MIN_ML_SAMPLES
};