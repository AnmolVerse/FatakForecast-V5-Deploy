const fs = require("fs");
const path = require("path");


// ======================================================
// FILE CONFIGURATION
// ======================================================

const DATA_DIR =
    path.join(__dirname, "..", "data");

const DATA_FILE =
    path.join(
        DATA_DIR,
        "gate-observations.json"
    );


// ======================================================
// INITIALIZE FILE
// ======================================================

if (!fs.existsSync(DATA_DIR)) {

    fs.mkdirSync(
        DATA_DIR,
        { recursive: true }
    );
}


if (!fs.existsSync(DATA_FILE)) {

    fs.writeFileSync(
        DATA_FILE,
        "[]",
        "utf8"
    );
}


// ======================================================
// READ
// ======================================================

function readGateObservations() {

    try {

        const data =
            fs.readFileSync(
                DATA_FILE,
                "utf8"
            );


        if (!data.trim()) {
            return [];
        }


        const observations =
            JSON.parse(data);


        return Array.isArray(observations)
            ? observations
            : [];

    } catch (error) {

        console.error(
            "❌ Could not read gate-observations.json"
        );

        return [];
    }
}


// ======================================================
// SAVE
// ======================================================

function saveGateObservations(
    observations
) {

    fs.writeFileSync(

        DATA_FILE,

        JSON.stringify(
            observations,
            null,
            2
        ),

        "utf8"
    );
}


// ======================================================
// CREATE ID
// ======================================================

function createObservationId() {

    return (
        "gate-" +
        Date.now() +
        "-" +
        Math.random()
            .toString(36)
            .slice(2, 8)
    );
}


// ======================================================
// TIMESTAMP VALIDATION
// ======================================================

function validateTimestamp(
    value,
    fieldName
) {

    if (!value) {
        return;
    }


    const date =
        new Date(value);


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        throw new Error(
            `${fieldName} is not a valid timestamp.`
        );
    }
}


// ======================================================
// VERIFICATION ENGINE (REPORTED / VERIFIED / REJECTED)
// ======================================================

function verifyObservationRecord({
    gateCloseTime,
    trainPassageTime,
    gateOpenTime,
    nowMs = Date.now()
}) {
    let verificationStatus = "REPORTED";
    let verificationReason = "Observation recorded awaiting verification";

    const closeMs = gateCloseTime ? new Date(gateCloseTime).getTime() : null;
    const passMs = trainPassageTime ? new Date(trainPassageTime).getTime() : null;
    const openMs = gateOpenTime ? new Date(gateOpenTime).getTime() : null;

    if (closeMs && passMs) {
        const leadMin = (passMs - closeMs) / 60000;
        const durMin = openMs ? (openMs - closeMs) / 60000 : null;

        if (leadMin < 0) {
            verificationStatus = "REJECTED";
            verificationReason = "Gate close occurred after train passage";
        } else if (leadMin > 30) {
            verificationStatus = "REJECTED";
            verificationReason = "Gate closure lead exceeds 30 minutes";
        } else if (openMs != null && openMs < passMs) {
            verificationStatus = "REJECTED";
            verificationReason = "Gate opened before train passage completed";
        } else if (durMin != null && (durMin < 0.5 || durMin > 35)) {
            verificationStatus = "REJECTED";
            verificationReason = `Closure duration (${durMin.toFixed(1)}m) outside plausible range`;
        } else if (closeMs > nowMs + 5 * 60000) {
            verificationStatus = "REJECTED";
            verificationReason = "Timestamp in the future";
        } else {
            verificationStatus = "VERIFIED";
            verificationReason = "Verified physical observation passed all sanity invariants";
        }
    } else {
        verificationStatus = "REPORTED";
        verificationReason = "Partial observation missing required gateCloseTime or trainPassageTime";
    }

    return { verificationStatus, verificationReason };
}

// ======================================================
// RECORD GATE OBSERVATION
// ======================================================
//
// IMPORTANT:
//
// This function stores REAL gate observations.
//
// It does NOT calculate predictions.
// It does NOT overwrite prediction data.
// It does NOT invent gate status.
//
// Raw ground truth remains immutable.
// ======================================================

function recordGateObservation({

    crossingId,

    crossingName,

    gateCloseTime = null,

    gateOpenTime = null,

    trainPassageTime = null,

    direction = null,

    trainNumber = null,

    notes = null,

    userFeedback = null

}) {

    // --------------------------------------------------
    // Required field
    // --------------------------------------------------

    if (!crossingId) {

        throw new Error(
            "crossingId is required."
        );
    }


    // --------------------------------------------------
    // Validate timestamps
    // --------------------------------------------------

    validateTimestamp(
        gateCloseTime,
        "gateCloseTime"
    );


    validateTimestamp(
        gateOpenTime,
        "gateOpenTime"
    );


    validateTimestamp(
        trainPassageTime,
        "trainPassageTime"
    );


    // --------------------------------------------------
    // Logical validation
    // --------------------------------------------------

    if (
        gateCloseTime &&
        gateOpenTime
    ) {

        if (
            new Date(gateOpenTime) <
            new Date(gateCloseTime)
        ) {

            throw new Error(
                "Gate open time cannot be before gate close time."
            );
        }
    }


    // ==================================================
    // DETERMINE OBSERVATION COMPLETENESS
    // ==================================================

    let observationStatus = "partial";

    if (
        gateCloseTime &&
        gateOpenTime &&
        trainPassageTime
    ) {

        observationStatus = "complete";

    } else if (
        gateCloseTime ||
        gateOpenTime ||
        trainPassageTime
    ) {

        observationStatus = "partial";

    } else {

        observationStatus = "empty";
    }

    const { verificationStatus, verificationReason } = verifyObservationRecord({
        gateCloseTime,
        trainPassageTime,
        gateOpenTime
    });

    // ==================================================
    // RAW OBSERVATION
    // ==================================================

    const observation = {

        id:
            createObservationId(),

        crossing_id:
            crossingId,

        crossing_name:
            crossingName ||
            null,

        train_number:
            trainNumber
                ? String(trainNumber)
                : null,

        direction:
            direction ||
            null,

        train_passage_time:
            trainPassageTime,

        gate_close_time:
            gateCloseTime,

        gate_open_time:
            gateOpenTime,

        observation_status:
            observationStatus,

        verification_status:
            verificationStatus,

        verification_reason:
            verificationReason,

        source:
            "manual-ground-truth",

        notes:
            notes || null,

        user_feedback:
            userFeedback || null,

        recorded_at:
            new Date().toISOString()
    };


    // ==================================================
    // SAVE
    // ==================================================

    const observations =
        readGateObservations();

    // Prevent accidental duplicate submissions for the same crossing/train/pass.
    if (trainNumber && trainPassageTime) {
        const incomingPassage = new Date(trainPassageTime).getTime();
        const duplicate = observations.find(existing => {
            if (!existing.train_number || !existing.train_passage_time) return false;
            if (existing.crossing_id !== crossingId) return false;
            if (String(existing.train_number) !== String(trainNumber)) return false;
            const existingPassage = new Date(existing.train_passage_time).getTime();
            return Number.isFinite(existingPassage) &&
                Math.abs(existingPassage - incomingPassage) <= 2 * 60 * 1000;
        });

        if (duplicate) {
            return duplicate;
        }
    }

    observations.push(
        observation
    );


    saveGateObservations(
        observations
    );


    return observation;
}


// ======================================================
// CALCULATE DERIVED FEATURES
// ======================================================
//
// These are derived values.
//
// IMPORTANT:
// The original raw observation is never modified.
// ======================================================

function calculateGateMetrics(
    observation
) {

    if (!observation) {

        return null;
    }


    let closureDurationMinutes =
        null;


    let closureLeadTimeMinutes =
        null;


    // --------------------------------------------------
    // Closure duration
    // --------------------------------------------------

    if (
        observation.gate_close_time &&
        observation.gate_open_time
    ) {

        const close =
            new Date(
                observation.gate_close_time
            );


        const open =
            new Date(
                observation.gate_open_time
            );


        if (
            !Number.isNaN(close.getTime()) &&
            !Number.isNaN(open.getTime())
        ) {

            closureDurationMinutes =
                (
                    open.getTime() -
                    close.getTime()
                ) / 60000;
        }
    }


    // --------------------------------------------------
    // Closure lead time
    // --------------------------------------------------

    if (
        observation.gate_close_time &&
        observation.train_passage_time
    ) {

        const close =
            new Date(
                observation.gate_close_time
            );


        const passage =
            new Date(
                observation.train_passage_time
            );


        if (
            !Number.isNaN(close.getTime()) &&
            !Number.isNaN(passage.getTime())
        ) {

            closureLeadTimeMinutes =
                (
                    passage.getTime() -
                    close.getTime()
                ) / 60000;
        }
    }


    return {

        closure_duration_minutes:
            closureDurationMinutes == null
                ? null
                : Number(
                    closureDurationMinutes.toFixed(2)
                ),

        closure_lead_time_minutes:
            closureLeadTimeMinutes == null
                ? null
                : Number(
                    closureLeadTimeMinutes.toFixed(2)
                )
    };
}


// ======================================================
// GET COMPLETE DATASET
// ======================================================

function getGateDataset(options = {}) {

    const observations =
        readGateObservations();

    const filtered = options.verifiedOnly
        ? observations.filter(o => o.verification_status === "VERIFIED")
        : observations;

    return filtered.map(
        observation => ({

            ...observation,

            ...calculateGateMetrics(
                observation
            )
        })
    );
}


// ======================================================
// EXPORTS
// ======================================================

module.exports = {

    readGateObservations,

    saveGateObservations,

    recordGateObservation,

    calculateGateMetrics,

    getGateDataset,

    verifyObservationRecord
};