const fs = require("fs");
const path = require("path");


// ======================================================
// FILE CONFIGURATION
// ======================================================

const DATA_DIR =
    path.join(__dirname, "..", "data");

const EVENTS_FILE =
    path.join(
        DATA_DIR,
        "crossing-events.json"
    );

const GATE_FILE =
    path.join(
        DATA_DIR,
        "gate-observations.json"
    );

const MATCHED_FILE =
    path.join(
        DATA_DIR,
        "matched-events.json"
    );


// ======================================================
// INITIALIZE
// ======================================================

if (!fs.existsSync(DATA_DIR)) {

    fs.mkdirSync(
        DATA_DIR,
        { recursive: true }
    );
}


if (!fs.existsSync(MATCHED_FILE)) {

    fs.writeFileSync(
        MATCHED_FILE,
        "[]",
        "utf8"
    );
}


// ======================================================
// GENERIC JSON READER
// ======================================================

function readJsonArray(filePath) {

    try {

        if (!fs.existsSync(filePath)) {
            return [];
        }


        const data =
            fs.readFileSync(
                filePath,
                "utf8"
            );


        if (!data.trim()) {
            return [];
        }


        const parsed =
            JSON.parse(data);


        return Array.isArray(parsed)
            ? parsed
            : [];

    } catch (error) {

        console.error(
            `❌ Could not read ${path.basename(filePath)}`
        );

        return [];
    }
}


// ======================================================
// GENERIC JSON WRITER
// ======================================================

function writeJsonArray(
    filePath,
    data
) {

    fs.writeFileSync(

        filePath,

        JSON.stringify(
            data,
            null,
            2
        ),

        "utf8"
    );
}


// ======================================================
// READ SOURCE DATA
// ======================================================

function readCrossingEvents() {

    return readJsonArray(
        EVENTS_FILE
    );
}


function readGateObservations() {

    return readJsonArray(
        GATE_FILE
    );
}


function readMatchedEvents() {

    return readJsonArray(
        MATCHED_FILE
    );
}


// ======================================================
// PARSE TIME
// ======================================================

function parseTimestamp(value) {

    if (!value) {
        return null;
    }


    const date =
        new Date(value);


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        return null;
    }


    return date;
}


// ======================================================
// SIGNED TIME DIFFERENCE
// ======================================================
//
// actual - predicted
//
// Positive = actual happened later
// Negative = actual happened earlier
// ======================================================

function signedTimeDifferenceMinutes(
    predicted,
    actual
) {

    const predictedDate =
        parseTimestamp(predicted);


    const actualDate =
        parseTimestamp(actual);


    if (
        !predictedDate ||
        !actualDate
    ) {

        return null;
    }


    return Number(
        (
            (
                actualDate.getTime() -
                predictedDate.getTime()
            ) / 60000
        ).toFixed(2)
    );
}


// ======================================================
// ABSOLUTE TIME DIFFERENCE
// ======================================================

function timeDifferenceMinutes(
    timeA,
    timeB
) {

    const difference =
        signedTimeDifferenceMinutes(
            timeA,
            timeB
        );


    if (difference == null) {
        return null;
    }


    return Math.abs(
        difference
    );
}


// ======================================================
// FIND BEST GATE OBSERVATION
// ======================================================
//
// Matching priority:
//
// 1. Same crossing
// 2. Same train number when available
// 3. Closest passage time
//
// An observation can optionally be excluded
// when it has already been matched.
// ======================================================

function findBestGateObservation(
    event,
    gateObservations,
    maxTimeDifferenceMinutes = 15,
    usedObservationIds = new Set()
) {

    if (!event) {
        return null;
    }


    if (
        !event.crossing_id ||
        !event.estimated_passage_time
    ) {

        return null;
    }


    const candidates =
        gateObservations.filter(
            observation => {

                // --------------------------------------
                // Never reuse an observation
                // --------------------------------------

                if (
                    usedObservationIds.has(
                        observation.id
                    )
                ) {

                    return false;
                }


                // --------------------------------------
                // Crossing must match
                // --------------------------------------

                if (
                    observation.crossing_id !==
                    event.crossing_id
                ) {

                    return false;
                }


                // --------------------------------------
                // Need actual passage
                // --------------------------------------

                if (
                    !observation.train_passage_time
                ) {

                    return false;
                }

                // Only verified observations may become ML training labels
                if (
                    observation.verification_status &&
                    observation.verification_status !== "VERIFIED"
                ) {
                    return false;
                }


                // --------------------------------------
                // If both have train numbers,
                // require exact match.
                // --------------------------------------

                if (
                    event.train_number &&
                    observation.train_number
                ) {

                    if (
                        String(
                            observation.train_number
                        ) !==
                        String(
                            event.train_number
                        )
                    ) {

                        return false;
                    }
                }


                // --------------------------------------
                // Direction check when both exist
                // --------------------------------------

                if (
                    event.direction &&
                    observation.direction
                ) {

                    const eventDirection =
                        String(
                            event.direction
                        ).toLowerCase();


                    const observationDirection =
                        String(
                            observation.direction
                        ).toLowerCase();


                    if (
                        eventDirection !==
                        observationDirection
                    ) {

                        return false;
                    }
                }


                // --------------------------------------
                // Temporal constraint
                // --------------------------------------

                const difference =
                    timeDifferenceMinutes(
                        event.estimated_passage_time,
                        observation.train_passage_time
                    );


                if (
                    difference == null
                ) {

                    return false;
                }


                return (
                    difference <=
                    maxTimeDifferenceMinutes
                );
            }
        );


    if (
        candidates.length === 0
    ) {

        return null;
    }


    // ==================================================
    // SORT BY MATCH QUALITY
    // ==================================================

    candidates.sort(
        (a, b) => {

            const aTrainMatch =
                event.train_number &&
                a.train_number &&
                String(a.train_number) ===
                String(event.train_number)
                    ? 0
                    : 1;


            const bTrainMatch =
                event.train_number &&
                b.train_number &&
                String(b.train_number) ===
                String(event.train_number)
                    ? 0
                    : 1;


            if (
                aTrainMatch !==
                bTrainMatch
            ) {

                return (
                    aTrainMatch -
                    bTrainMatch
                );
            }


            const diffA =
                timeDifferenceMinutes(
                    event.estimated_passage_time,
                    a.train_passage_time
                );


            const diffB =
                timeDifferenceMinutes(
                    event.estimated_passage_time,
                    b.train_passage_time
                );


            return (
                diffA -
                diffB
            );
        }
    );


    return candidates[0];
}


// ======================================================
// CALCULATE ACTUAL CLOSURE METRICS
// ======================================================

function calculateClosureMetrics(
    gateObservation
) {

    if (!gateObservation) {

        return {

            closure_lead_time_minutes:
                null,

            closure_duration_minutes:
                null
        };
    }


    let closureLeadTime =
        null;


    let closureDuration =
        null;


    // --------------------------------------------------
    // Passage - close
    // --------------------------------------------------

    if (
        gateObservation.gate_close_time &&
        gateObservation.train_passage_time
    ) {

        closureLeadTime =
            signedTimeDifferenceMinutes(
                gateObservation.gate_close_time,
                gateObservation.train_passage_time
            );
    }


    // --------------------------------------------------
    // Open - close
    // --------------------------------------------------

    if (
        gateObservation.gate_close_time &&
        gateObservation.gate_open_time
    ) {

        closureDuration =
            signedTimeDifferenceMinutes(
                gateObservation.gate_close_time,
                gateObservation.gate_open_time
            );
    }


    return {

        closure_lead_time_minutes:
            closureLeadTime,

        closure_duration_minutes:
            closureDuration
    };
}


// ======================================================
// PREDICTION ERROR
// ======================================================

function calculatePredictionError(
    predicted,
    actual
) {

    return signedTimeDifferenceMinutes(
        predicted,
        actual
    );
}


// ======================================================
// CLOSURE LEAD ERROR
// ======================================================
//
// Predicted lead:
// predicted passage - predicted close
//
// Actual lead:
// actual passage - actual close
//
// Positive = actual lead was larger.
// Negative = actual lead was smaller.
// ======================================================

function calculateClosureLeadError(
    event,
    gateObservation
) {

    if (
        !event ||
        !gateObservation
    ) {

        return null;
    }


    const predictedPassage =
        parseTimestamp(
            event.estimated_passage_time
        );


    const predictedClose =
        parseTimestamp(
            event.predicted_gate_close_time
        );


    const actualPassage =
        parseTimestamp(
            gateObservation.train_passage_time
        );


    const actualClose =
        parseTimestamp(
            gateObservation.gate_close_time
        );


    if (
        !predictedPassage ||
        !predictedClose ||
        !actualPassage ||
        !actualClose
    ) {

        return null;
    }


    const predictedLead =
        (
            predictedPassage.getTime() -
            predictedClose.getTime()
        ) / 60000;


    const actualLead =
        (
            actualPassage.getTime() -
            actualClose.getTime()
        ) / 60000;


    return Number(
        (
            actualLead -
            predictedLead
        ).toFixed(2)
    );
}


// ======================================================
// CLOSURE DURATION ERROR
// ======================================================

function calculateClosureDurationError(
    event,
    gateObservation
) {

    if (
        !event ||
        !gateObservation
    ) {

        return null;
    }


    const predictedOpen =
        parseTimestamp(
            event.predicted_gate_open_time
        );


    const predictedClose =
        parseTimestamp(
            event.predicted_gate_close_time
        );


    const actualOpen =
        parseTimestamp(
            gateObservation.gate_open_time
        );


    const actualClose =
        parseTimestamp(
            gateObservation.gate_close_time
        );


    if (
        !predictedOpen ||
        !predictedClose ||
        !actualOpen ||
        !actualClose
    ) {

        return null;
    }


    const predictedDuration =
        (
            predictedOpen.getTime() -
            predictedClose.getTime()
        ) / 60000;


    const actualDuration =
        (
            actualOpen.getTime() -
            actualClose.getTime()
        ) / 60000;


    return Number(
        (
            actualDuration -
            predictedDuration
        ).toFixed(2)
    );
}


// ======================================================
// DETERMINE PREDICTION RESULT
// ======================================================

function determinePredictionResult(
    event,
    gateObservation,
    maxPassageErrorMinutes = 3
) {

    if (
        !event ||
        !gateObservation
    ) {

        return "unknown";
    }


    // --------------------------------------------------
    // No actual gate close
    // --------------------------------------------------

    if (
        !gateObservation.gate_close_time
    ) {

        return "partial";
    }


    // --------------------------------------------------
    // Passage prediction error
    // --------------------------------------------------

    const passageError =
        calculatePredictionError(
            event.estimated_passage_time,
            gateObservation.train_passage_time
        );


    if (
        passageError == null
    ) {

        return "unknown";
    }


    // --------------------------------------------------
    // Determine timing quality
    // --------------------------------------------------

    if (
        Math.abs(
            passageError
        ) <=
        maxPassageErrorMinutes
    ) {

        return "matched";
    }


    if (
        passageError < 0
    ) {

        return "early";
    }


    return "late";
}


// ======================================================
// CREATE MATCHED EVENT
// ======================================================

function createMatchedEvent(
    event,
    gateObservation
) {

    const metrics =
        calculateClosureMetrics(
            gateObservation
        );


    const passageError =
        calculatePredictionError(
            event.estimated_passage_time,
            gateObservation.train_passage_time
        );


    const closeError =
        calculatePredictionError(
            event.predicted_gate_close_time,
            gateObservation.gate_close_time
        );


    const openError =
        calculatePredictionError(
            event.predicted_gate_open_time,
            gateObservation.gate_open_time
        );


    const closureLeadError =
        calculateClosureLeadError(
            event,
            gateObservation
        );


    const closureDurationError =
        calculateClosureDurationError(
            event,
            gateObservation
        );


    const predictionResult =
        determinePredictionResult(
            event,
            gateObservation
        );


    // ==================================================
    // MATCHED EVENT
    // ==================================================

    return {

        id:
            `matched-${event.id}-${gateObservation.id}`,

        // ------------------------------------------------
        // Event identity
        // ------------------------------------------------

        event_id:
            event.id,

        train_number:
            event.train_number ||
            null,

        train_name:
            event.train_name ||
            null,

        direction:
            event.direction ||
            null,


        // ------------------------------------------------
        // Crossing
        // ------------------------------------------------

        crossing_id:
            event.crossing_id,

        crossing_name:
            event.crossing_name ||
            null,


        // ------------------------------------------------
        // PREDICTION
        // ------------------------------------------------

        predicted_passage_time:
            event.estimated_passage_time ||
            null,

        predicted_passage_eta_minutes:
            event.estimated_passage_eta_minutes ??
            null,

        predicted_gate_close_time:
            event.predicted_gate_close_time ||
            null,

        predicted_gate_open_time:
            event.predicted_gate_open_time ||
            null,

        prediction_mode:
            event.prediction_mode ||
            null,

        prediction_source:
            event.prediction_source ||
            null,

        prediction_confidence:
            event.prediction_confidence ||
            null,

        prediction_available:
            event.prediction_available ??
            true,

        sample_count:
            event.sample_count ??
            null,


        // ------------------------------------------------
        // ACTUAL GROUND TRUTH
        // ------------------------------------------------

        actual_train_passage_time:
            gateObservation.train_passage_time ||
            null,

        actual_gate_close_time:
            gateObservation.gate_close_time ||
            null,

        actual_gate_open_time:
            gateObservation.gate_open_time ||
            null,

        actual_status:
            gateObservation.gate_close_time
                ? (
                    gateObservation.gate_open_time
                        ? "closed-and-reopened"
                        : "closed"
                )
                : "unknown",

        gate_status_source:
            gateObservation.source ||
            "unknown",


        // ------------------------------------------------
        // ACTUAL TARGET VARIABLES
        // ------------------------------------------------

        closure_lead_time_minutes:
            metrics.closure_lead_time_minutes,

        closure_duration_minutes:
            metrics.closure_duration_minutes,


        // ------------------------------------------------
        // ERRORS
        // ------------------------------------------------

        passage_prediction_error_minutes:
            passageError,

        gate_close_prediction_error_minutes:
            closeError,

        gate_open_prediction_error_minutes:
            openError,

        closure_lead_prediction_error_minutes:
            closureLeadError,

        closure_duration_prediction_error_minutes:
            closureDurationError,


        // ------------------------------------------------
        // LIFECYCLE
        // ------------------------------------------------

        prediction_result:
            predictionResult,

        match_status:
            "matched",

        gate_observation_id:
            gateObservation.id,

        gate_observation_source:
            gateObservation.source ||
            "unknown",

        matched_at:
            new Date().toISOString()
    };
}


// ======================================================
// MATCH ALL EVENTS
// ======================================================

function matchEvents(
    maxTimeDifferenceMinutes = 15
) {

    const events =
        readCrossingEvents();


    const gateObservations =
        readGateObservations();


    const existingMatches =
        readMatchedEvents();


    console.log("");
    console.log("========================================");
    console.log("       FATAKFORECAST EVENT MATCHER");
    console.log("========================================");


    console.log(
        `Automatic events: ${events.length}`
    );


    console.log(
        `Gate observations: ${gateObservations.length}`
    );


    console.log(
        `Existing matches: ${existingMatches.length}`
    );


    // ==================================================
    // ALREADY USED OBSERVATIONS
    // ==================================================

    const usedObservationIds =
        new Set(
            existingMatches
                .map(
                    match =>
                        match.gate_observation_id
                )
                .filter(Boolean)
        );


    const matches = [];


    // ==================================================
    // PROCESS EACH EVENT
    // ==================================================

    for (
        const event of events
    ) {

        // ------------------------------------------------
        // Skip events already matched
        // ------------------------------------------------

        const alreadyMatched =
            existingMatches.some(
                match =>
                    match.event_id ===
                    event.id
            );


        if (
            alreadyMatched
        ) {

            continue;
        }


        // ------------------------------------------------
        // Find best observation
        // ------------------------------------------------

        const observation =
            findBestGateObservation(
                event,
                gateObservations,
                maxTimeDifferenceMinutes,
                usedObservationIds
            );


        if (
            !observation
        ) {

            continue;
        }


        // ------------------------------------------------
        // Create match
        // ------------------------------------------------

        const matchedEvent =
            createMatchedEvent(
                event,
                observation
            );


        matches.push(
            matchedEvent
        );


        // ------------------------------------------------
        // Immediately reserve observation
        // ------------------------------------------------

        usedObservationIds.add(
            observation.id
        );
    }

    // ==================================================
    // INCLUDE VERIFIED STANDALONE GATE OBSERVATIONS
    // ==================================================
    // Even if no automated RailRadar telemetry event matched,
    // verified human observations represent ground truth and
    // must be available for dynamic baseline and ML training.

    for (const observation of gateObservations) {
        if (usedObservationIds.has(observation.id)) {
            continue;
        }

        if (observation.verification_status !== "VERIFIED") {
            continue;
        }

        if (
            !observation.crossing_id ||
            !observation.train_passage_time ||
            !observation.gate_close_time
        ) {
            continue;
        }

        const metrics = calculateClosureMetrics(observation);
        if (!Number.isFinite(metrics.closure_lead_time_minutes)) {
            continue;
        }

        const directMatchedEvent = {
            id: `matched-direct-${observation.id}`,
            event_id: null,
            train_number: observation.train_number || null,
            train_name: null,
            direction: observation.direction || "forward",
            crossing_id: observation.crossing_id,
            crossing_name: observation.crossing_name || null,
            predicted_passage_time: observation.train_passage_time,
            predicted_gate_close_time: null,
            predicted_gate_open_time: null,
            actual_train_passage_time: observation.train_passage_time,
            actual_gate_close_time: observation.gate_close_time,
            actual_gate_open_time: observation.gate_open_time,
            actual_status: observation.gate_open_time ? "closed-and-reopened" : "closed",
            gate_status_source: observation.source || "manual-ground-truth",
            closure_lead_time_minutes: metrics.closure_lead_time_minutes,
            closure_duration_minutes: metrics.closure_duration_minutes,
            passage_prediction_error_minutes: null,
            gate_close_prediction_error_minutes: null,
            gate_open_prediction_error_minutes: null,
            closure_lead_prediction_error_minutes: null,
            closure_duration_prediction_error_minutes: null,
            prediction_result: "direct-ground-truth",
            match_status: "verified-direct",
            gate_observation_id: observation.id,
            matched_at: new Date().toISOString()
        };

        matches.push(directMatchedEvent);
        usedObservationIds.add(observation.id);
    }

    // ==================================================
    // SAVE
    // ==================================================

    if (
        matches.length > 0
    ) {

        const updatedMatches = [

            ...existingMatches,

            ...matches
        ];


        writeJsonArray(
            MATCHED_FILE,
            updatedMatches
        );
    }


    // ==================================================
    // SUMMARY
    // ==================================================

    console.log("");

    console.log(
        `New matches: ${matches.length}`
    );


    if (
        matches.length > 0
    ) {

        for (
            const match of matches
        ) {

            console.log("");

            console.log(
                `✅ ${match.train_number || "Unknown train"} → ${
                    match.crossing_name
                }`
            );


            console.log(
                `Prediction result: ${
                    match.prediction_result
                }`
            );


            console.log(
                `Predicted passage: ${
                    match.predicted_passage_time ||
                    "not available"
                }`
            );


            console.log(
                `Actual passage: ${
                    match.actual_train_passage_time ||
                    "not recorded"
                }`
            );


            console.log(
                `Passage error: ${
                    match.passage_prediction_error_minutes ??
                    "not available"
                } min`
            );


            console.log(
                `Predicted close: ${
                    match.predicted_gate_close_time ||
                    "not available"
                }`
            );


            console.log(
                `Actual close: ${
                    match.actual_gate_close_time ||
                    "not recorded"
                }`
            );


            console.log(
                `Close error: ${
                    match.gate_close_prediction_error_minutes ??
                    "not available"
                } min`
            );


            console.log(
                `Predicted open: ${
                    match.predicted_gate_open_time ||
                    "not available"
                }`
            );


            console.log(
                `Actual open: ${
                    match.actual_gate_open_time ||
                    "not recorded"
                }`
            );


            console.log(
                `Open error: ${
                    match.gate_open_prediction_error_minutes ??
                    "not available"
                } min`
            );


            console.log(
                `Actual closure lead: ${
                    match.closure_lead_time_minutes ??
                    "not available"
                } min`
            );


            console.log(
                `Actual closure duration: ${
                    match.closure_duration_minutes ??
                    "not available"
                } min`
            );
        }

    } else {

        console.log(
            "ℹ️ No new automatic events matched."
        );
    }


    console.log("");
    console.log("========================================");
    console.log("          EVENT MATCHING COMPLETE");
    console.log("========================================");


    return {

        automaticEvents:
            events.length,

        gateObservations:
            gateObservations.length,

        existingMatches:
            existingMatches.length,

        newMatches:
            matches.length,

        matches
    };
}


// ======================================================
// EXPORTS
// ======================================================

module.exports = {

    matchEvents,

    findBestGateObservation,

    calculateClosureMetrics,

    calculatePredictionError,

    calculateClosureLeadError,

    calculateClosureDurationError,

    determinePredictionResult,

    createMatchedEvent,

    readCrossingEvents,

    readGateObservations,

    readMatchedEvents
};