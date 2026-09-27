const fs = require("fs");
const path = require("path");

const {
    getTrainLive
} = require("./railradar");


// ======================================================
// FILE CONFIGURATION
// ======================================================

const DATA_DIR =
    path.join(
        __dirname,
        "..",
        "data"
    );

const DATA_FILE =
    path.join(
        DATA_DIR,
        "train-observations.json"
    );


// ======================================================
// POSITION CONFIGURATION
// ======================================================

const POSITION_EPSILON_KM = 0.01;


// ======================================================
// STALE POSITION CONFIGURATION
// ======================================================
//
// A single repeated position is NOT stale.
//
// We require repeated observations at essentially the
// same railway position.
//
// Example:
//
// 206.300
// 206.300
//
// -> NOT stale
//
// 206.300
// 206.300
// 206.300
//
// -> suspicious, BUT only considered stale when the live
// API simultaneously suggests that the train is moving.
//
// This prevents a train genuinely stopped at a station
// from being incorrectly classified as stale.
//
// ======================================================

const STALE_REPEAT_COUNT = 3;


// ======================================================
// MINIMUM SPEED FOR SUSPICIOUS FROZEN POSITION
// ======================================================
//
// If RailRadar repeatedly reports the exact same railway
// position while simultaneously reporting a meaningful
// running speed, the position is considered unreliable.
//
// 20 km/h is intentionally conservative.
//
// ======================================================

const STALE_SPEED_THRESHOLD_KMPH = 20;


// ======================================================
// OBSERVATION AGE
// ======================================================
//
// We should not compare today's first observation with
// an observation from several days ago.
//
// Maximum age allowed when using historical observations
// for movement/stale detection.
//
// ======================================================

const MAX_COMPARISON_AGE_MS =
    30 * 60 * 1000;


// ======================================================
// INITIALIZE DATA FILE
// ======================================================

if (
    !fs.existsSync(DATA_DIR)
) {

    fs.mkdirSync(
        DATA_DIR,
        {
            recursive: true
        }
    );
}


if (
    !fs.existsSync(DATA_FILE)
) {

    fs.writeFileSync(
        DATA_FILE,
        "[]",
        "utf8"
    );
}


// ======================================================
// READ OBSERVATIONS
// ======================================================

function readObservations() {

    try {

        const data =
            fs.readFileSync(
                DATA_FILE,
                "utf8"
            );


        if (
            !data.trim()
        ) {

            return [];
        }


        const observations =
            JSON.parse(data);


        return Array.isArray(
            observations
        )
            ? observations
            : [];

    }
    catch (error) {

        console.error(
            "❌ Could not read train-observations.json:",
            error.message
        );


        return [];
    }
}


// ======================================================
// SAVE OBSERVATIONS
// ======================================================

function saveObservations(
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
// GET LATEST OBSERVATION
// ======================================================

function getLatestObservation(
    trainNumber
) {

    const observations =
        readObservations();


    const trainObservations =
        observations.filter(
            observation =>
                observation.train_number ===
                String(trainNumber)
        );


    if (
        trainObservations.length === 0
    ) {

        return null;
    }


    return trainObservations[
        trainObservations.length - 1
    ];
}


// ======================================================
// GET RECENT OBSERVATIONS
// ======================================================

function getRecentObservations(
    trainNumber,
    count = 5
) {

    const observations =
        readObservations();


    return observations
        .filter(
            observation =>
                observation.train_number ===
                String(trainNumber)
        )
        .slice(
            -count
        );
}


// ======================================================
// CHECK OBSERVATION AGE
// ======================================================

function isObservationRecent(
    observation
) {

    if (
        !observation ||
        !observation.timestamp
    ) {

        return false;
    }


    const timestamp =
        new Date(
            observation.timestamp
        ).getTime();


    if (
        !Number.isFinite(timestamp)
    ) {

        return false;
    }


    const age =
        Date.now() -
        timestamp;


    // Future timestamps are considered usable.

    if (
        age < 0
    ) {

        return true;
    }


    return (
        age <=
        MAX_COMPARISON_AGE_MS
    );
}


// ======================================================
// DETERMINE MOVEMENT (ANOMALY-HARDENED)
// ======================================================

function determineMovement(
    previousPosition,
    currentPosition,
    elapsedMs = null
) {
    let prev = previousPosition;
    let curr = currentPosition;
    let dt = elapsedMs;

    if (prev && typeof prev === "object") {
        if (dt == null && prev.recordedAt && curr && curr.recordedAt) {
            dt = curr.recordedAt - prev.recordedAt;
        }
        prev = prev.trainPosition ?? prev.railway_position_km ?? prev.position;
    }

    if (curr && typeof curr === "object") {
        curr = curr.trainPosition ?? curr.railway_position_km ?? curr.position;
    }

    if (
        prev == null ||
        curr == null
    ) {
        const obj = new String("unknown");
        obj.direction = "unknown";
        obj.speed = 0;
        return obj;
    }

    const previous = Number(prev);
    const current = Number(curr);

    if (!Number.isFinite(previous) || !Number.isFinite(current)) {
        const obj = new String("unknown");
        obj.direction = "unknown";
        obj.speed = 0;
        return obj;
    }

    // 1. Guard against 0.000 km API fallback / GPS loss anomaly
    if (current < 0.05 && previous > 1.0) {
        // Obvious 0 km reset glitch (e.g. from 809 km to 0.000 km)
        const obj = new String("stationary");
        obj.direction = "stationary";
        obj.speed = 0;
        return obj;
    }
    if (previous < 0.05 && current > 1.0) {
        // Recovery from 0 km glitch
        const obj = new String("unknown");
        obj.direction = "unknown";
        obj.speed = 0;
        return obj;
    }

    const difference = current - previous;
    const absDiff = Math.abs(difference);

    // 2. Ignore tiny rounding / GPS jitter
    if (absDiff < POSITION_EPSILON_KM) {
        const obj = new String("stationary");
        obj.direction = "stationary";
        obj.speed = 0;
        return obj;
    }

    // 3. Velocity sanity bounding:
    let calculatedSpeed = 0;
    if (dt != null && Number.isFinite(dt) && dt > 0) {
        const speedKmh = (absDiff / (dt / 3600000));
        calculatedSpeed = Number(speedKmh.toFixed(1));
        if (speedKmh > 180) {
            // Physically impossible jump - telemetry noise / station jump
            const obj = new String("stationary");
            obj.direction = "stationary";
            obj.speed = 0;
            return obj;
        }
    } else if (absDiff > 25.0) {
        // Without elapsed time, any instantaneous delta > 25 km is anomalous
        const obj = new String("stationary");
        obj.direction = "stationary";
        obj.speed = 0;
        return obj;
    }

    let dir = "stationary";
    if (difference > 0) {
        dir = "forward";
    } else if (difference < 0) {
        dir = "backward";
    }

    const obj = new String(dir);
    obj.direction = dir;
    obj.speed = calculatedSpeed;
    return obj;
}


// ======================================================
// GET LIVE SPEED
// ======================================================
//
// Used only to determine whether a repeated position is
// suspicious.
//
// This does NOT determine the train's ETA.
//
// ======================================================

function getLiveSpeed(
    live
) {

    const currentLocation =
        live?.currentLocation;


    // --------------------------------------------------
    // Direct live speed
    // --------------------------------------------------

    if (
        currentLocation &&
        currentLocation.speedKmh != null
    ) {

        const speed =
            Number(
                currentLocation.speedKmh
            );


        if (
            Number.isFinite(speed) &&
            speed >= 0
        ) {

            return speed;
        }
    }


    // --------------------------------------------------
    // Route segment speed
    // --------------------------------------------------

    if (
        Array.isArray(live?.route) &&
        currentLocation &&
        currentLocation.sequence != null
    ) {

        const currentStation =
            live.route.find(
                station =>
                    Number(
                        station.sequence
                    ) ===
                    Number(
                        currentLocation.sequence
                    )
            );


        if (
            currentStation &&
            currentStation.speedToNextStationKmph != null
        ) {

            const speed =
                Number(
                    currentStation.speedToNextStationKmph
                );


            if (
                Number.isFinite(speed) &&
                speed >= 0
            ) {

                return speed;
            }
        }
    }


    return null;
}


// ======================================================
// CHECK WHETHER API SAYS TRAIN IS RUNNING
// ======================================================

function isTrainReportedRunning(
    live
) {

    const status =
        String(
            live?.status ??
            live?.currentLocation?.status ??
            ""
        )
            .trim()
            .toLowerCase();


    // --------------------------------------------------
    // Explicit stopped states
    // --------------------------------------------------

    const stoppedStatuses = [

        "stopped",

        "at-station",

        "at station",

        "stationary",

        "halt",

        "halted",

        "arrived"

    ];


    if (
        stoppedStatuses.includes(
            status
        )
    ) {

        return false;
    }


    // --------------------------------------------------
    // Explicit running states
    // --------------------------------------------------

    const runningStatuses = [

        "running",

        "moving",

        "en-route",

        "enroute",

        "on-route",

        "on route"

    ];


    if (
        runningStatuses.includes(
            status
        )
    ) {

        return true;
    }


    // --------------------------------------------------
    // If status is unknown, speed can still provide
    // evidence that the train is moving.
    // --------------------------------------------------

    const speed =
        getLiveSpeed(
            live
        );


    if (
        speed != null &&
        speed >=
        STALE_SPEED_THRESHOLD_KMPH
    ) {

        return true;
    }


    return false;
}


function isTrainCancelled(live) {
    if (!live) return false;

    const status = String(
        live?.status ??
        live?.currentLocation?.status ??
        live?.train?.status ??
        ""
    ).trim().toLowerCase();

    if (status === "cancelled" || status === "canceled") {
        return true;
    }

    if (live.isCancelled === true) {
        return true;
    }

    if (Array.isArray(live.exceptions)) {
        for (const ex of live.exceptions) {
            const exType = String(ex?.type || "").toUpperCase().trim();
            const exMsg = String(ex?.message || "").toLowerCase();
            if (exType.includes("CANCEL") || exMsg.includes("cancel")) {
                return true;
            }
        }
    }

    return false;
}


// ======================================================
// COUNT CONSECUTIVE SAME POSITIONS
// ======================================================
//
// Returns the number of consecutive recent observations
// that are essentially at the same railway position as
// the current API position.
//
// IMPORTANT:
//
// This function intentionally does NOT decide whether
// the position is stale.
//
// It only measures repetition.
//
// ======================================================

function getConsecutiveSamePositionCount(
    trainNumber,
    currentPosition
) {

    if (
        !Number.isFinite(
            Number(currentPosition)
        )
    ) {

        return 0;
    }


    const observations =
        getRecentObservations(
            trainNumber,
            20
        );


    const now =
        Date.now();


    let count = 0;


    for (
        let i =
            observations.length - 1;
        i >= 0;
        i--
    ) {

        const observation =
            observations[i];


        // ------------------------------------------------
        // Ignore old observations.
        // ------------------------------------------------

        if (
            !isObservationRecent(
                observation
            )
        ) {

            break;
        }


        const timestamp =
            new Date(
                observation.timestamp
            ).getTime();


        if (
            Number.isFinite(timestamp) &&
            now - timestamp >
            MAX_COMPARISON_AGE_MS
        ) {

            break;
        }


        const position =
            Number(
                observation.railway_position_km
            );


        if (
            !Number.isFinite(position)
        ) {

            break;
        }


        if (
            Math.abs(
                position -
                Number(currentPosition)
            ) <
            POSITION_EPSILON_KM
        ) {

            count++;

        } else {

            break;
        }
    }


    return count;
}


// ======================================================
// CHECK WHETHER POSITION IS STALE
// ======================================================
//
// The current API position is considered stale only when:
//
// 1. The same railway position has been repeated enough
//    times,
// 2. The train is reported/indicated to be running,
// 3. The reported speed is meaningful.
//
// Therefore:
//
// Station + 0 km/h
// -> NOT stale
//
// Station + unknown speed
// -> NOT stale
//
// Running + 90 km/h + frozen position
// -> STALE
//
// ======================================================

function isPositionStale(
    trainNumber,
    currentPosition,
    live,
    repeatedCount
) {

    // --------------------------------------------------
    // Invalid position
    // --------------------------------------------------

    if (
        !Number.isFinite(
            Number(currentPosition)
        )
    ) {

        return true;
    }


    // --------------------------------------------------
    // Count repeated positions
    // --------------------------------------------------

   


    // --------------------------------------------------
    // Not enough repetition yet
    // --------------------------------------------------

    if (
        repeatedCount <
        STALE_REPEAT_COUNT
    ) {

        return false;
    }


    // --------------------------------------------------
    // If API does not indicate movement, do not label
    // the position stale.
    // --------------------------------------------------

    if (
        !isTrainReportedRunning(
            live
        )
    ) {

        return false;
    }


    // --------------------------------------------------
    // Check actual reported speed
    // --------------------------------------------------

    const speed =
        getLiveSpeed(
            live
        );


    if (
        speed == null
    ) {

        return false;
    }


    if (
        speed <
        STALE_SPEED_THRESHOLD_KMPH
    ) {

        return false;
    }


    // --------------------------------------------------
    // Frozen position + meaningful movement evidence
    // --------------------------------------------------

    return true;
}


// ======================================================
// RECORD ONE OBSERVATION
// ======================================================

async function observeTrain(
    trainNumber
) {

    console.log("");
    console.log(
        "========================================"
    );
    console.log(
        "       FATAKFORECAST TRAIN OBSERVER"
    );
    console.log(
        "========================================"
    );


    console.log(
        `Train: ${trainNumber}`
    );


    const live =
        await getTrainLive(
            trainNumber
        );


    if (isTrainCancelled(live)) {
        console.log(`🚫 Train ${trainNumber} — CANCELLED`);
        console.log(`   Skipping crossing forecast.`);
        return {
            trainNumber: String(trainNumber),
            trainName: live?.trainName || live?.train?.name || null,
            isCancelled: true,
            status: "cancelled"
        };
    }

    if (
        !live ||
        !live.currentLocation
    ) {

        throw new Error(
            "Live train position unavailable."
        );
    }


    const currentLocation =
        live.currentLocation;


    const currentPosition =
        Number(
            currentLocation
                .distanceFromOriginKm
        );


    if (
        !Number.isFinite(
            currentPosition
        )
    ) {

        throw new Error(
            "Train railway position unavailable."
        );
    }


    // --------------------------------------------------
    // Previous observation
    // --------------------------------------------------

    const previous =
        getLatestObservation(
            trainNumber
        );


    const previousPosition =
        previous
            ? Number(
                previous.railway_position_km
            )
            : null;


    // --------------------------------------------------
    // Only use recent observation for movement.
    // --------------------------------------------------

    const usablePrevious =
        previous &&
        isObservationRecent(
            previous
        )
            ? previous
            : null;


    const usablePreviousPosition =
        usablePrevious
            ? Number(
                usablePrevious.railway_position_km
            )
            : null;


    // --------------------------------------------------
    // Determine movement
    // --------------------------------------------------

    const movement =
        determineMovement(
            usablePreviousPosition,
            currentPosition
        );


    // --------------------------------------------------
    // Build observation
    // --------------------------------------------------

    const observation = {

        train_number:
            String(trainNumber),

        train_name:
            live.name ||
            live.trainName ||
            live.train?.name ||
            null,

        timestamp:
            new Date().toISOString(),

        railway_position_km:
            Number(
                currentPosition.toFixed(3)
            ),

        sequence:
            currentLocation.sequence ??
            null,

        station_code:
            currentLocation.stationCode ??
            null,

        station_name:
            currentLocation.stationName ??
            null,

        status:
            live.status ??
            currentLocation.status ??
            null,

        delay_minutes:
            currentLocation.delayMinutes ??
            live.delayMinutes ??
            null,

        speed_kmph:
            getLiveSpeed(
                live
            ),

        segment_progress:
            currentLocation.segmentProgress ??
            null,

        movement,

        previous_position_km:
            usablePreviousPosition,

        previous_observation_timestamp:
            usablePrevious
                ? usablePrevious.timestamp
                : null
    };


    // --------------------------------------------------
    // Save observation
    // --------------------------------------------------

    const observations =
        readObservations();


    observations.push(
        observation
    );


    saveObservations(
        observations
    );


    return observation;
}


// ======================================================
// EXPORTS
// ======================================================

module.exports = {

    readObservations,

    saveObservations,

    getLatestObservation,

    getRecentObservations,

    determineMovement,

    getLiveSpeed,

    isTrainReportedRunning,

    isPositionStale,

    isObservationRecent,

    getConsecutiveSamePositionCount,

    observeTrain

};