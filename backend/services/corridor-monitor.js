// ======================================================
// FATAKFORECAST — CORRIDOR MONITOR
// ======================================================
//
// Purpose:
//
// 1. Fetch live train data
// 2. Record railway-position observations
// 3. Detect stale/frozen RailRadar positions
// 4. Infer train direction
// 5. Map V1 crossings onto the actual railway route
// 6. Find ALL approaching V1 crossings
// 7. Calculate ETA for each approaching crossing
// 8. Build a 60-minute V1 forecast horizon
// 9. Select the earliest valid V1 crossing as nextCrossing
//
// IMPORTANT:
//
// V1 USER-FACING FORECAST = NEXT 60 MINUTES.
//
// Long-range train information may still be calculated
// internally for diagnostics, but it must NOT become the
// V1 nextCrossing or detailed imminent forecast.
//
// STALE / NOT-STARTED POSITION RULE:
//
// A stale or genuinely not-started RailRadar position must
// NEVER be used as a continuous live-position ETA.
//
// Priority:
//
//     fresh live position
//            ↓
//     live-position ETA
//
//     stale / not-started position
//            ↓
//     station-anchor ETA if available
//            ↓
//     otherwise ETA unavailable
//
// ======================================================

const crossings =
    require("../config/crossing");


const {
    getTrainLive,
    getTrainRoute
} = require("./railradar");


const {
    mapCrossingsToTrainRoute,
    resolveTrainGeometryPosition,
    buildGeometryRoute
} = require("./geometry");


const {
    estimateTrainPassage
} = require("./eta");


const {
    readObservations,
    saveObservations,
    getLatestObservation,
    determineMovement,
    isPositionStale,
    isObservationRecent,
    getConsecutiveSamePositionCount
} = require("./train-observer");


// ======================================================
// CONFIGURATION
// ======================================================
//
// V1 immediate forecast horizon.
//
// IMPORTANT:
// Keep this at 60.
// Do not change this to 90 or 120 for V1.
//

const FORECAST_HORIZON_MINUTES = 60;


// ======================================================
// TRAIN STATUS HELPERS
// ======================================================
//
// Some RailRadar responses can expose:
//
//     not-started
//     scheduled
//     running
//     at-station
//     departed
//
// A not-started/scheduled train may expose a nominal speed
// or a zero railway position. That must NOT be treated as
// a trustworthy live-position ETA.
//

function getTrainStatus(
    live
) {

    return String(
        live?.status ??
        live?.currentLocation?.status ??
        live?.train?.status ??
        ""
    )
        .trim()
        .toLowerCase();
}


function isTrainNotStarted(
    live
) {

    const status =
        getTrainStatus(
            live
        );

    if (
        status === "not-started" ||
        status === "not_started" ||
        status === "scheduled" ||
        status === "notstarted"
    ) {
        return true;
    }

    if (
        live?.hasDeparted === false ||
        live?.currentLocation?.hasDeparted === false
    ) {
        return true;
    }

    const seq = Number(live?.currentLocation?.sequence);
    const speed = live?.currentLocation?.speedKmh;
    if (
        seq === 1 &&
        (speed === 0 || speed == null) &&
        !live?.route?.[0]?.actualDeparture
    ) {
        return true;
    }

    return false;
}


function isTrainCancelled(live) {
    if (!live) return false;

    const status = getTrainStatus(live);
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
// GET TRAIN SPEED
// ======================================================
//
// Priority:
//
// 1. RailRadar live speed
// 2. Current route segment speed
// 3. null
//
// IMPORTANT:
//
// A speed from a not-started/scheduled train is NOT treated
// as a live movement speed.
//

function getTrainSpeed(
    live
) {

    if (
        isTrainNotStarted(
            live
        )
    ) {

        return null;
    }


    const currentLocation =
        live?.currentLocation;


    // --------------------------------------------------
    // 1. Direct RailRadar live speed
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
            speed > 0
        ) {

            return speed;
        }
    }


    // --------------------------------------------------
    // 2. Route segment speed
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
                speed > 0
            ) {

                return speed;
            }
        }
    }


    return null;
}


// ======================================================
// RESOLVE TRAIN POSITION
// ======================================================
//
// Uses the SAME GeoJSON railway geometry used for
// crossing mapping.
//
// ======================================================

function resolveTrainPosition(
    live,
    routeData
) {

    return resolveTrainGeometryPosition(
        live,
        routeData
    );
}


// ======================================================
// GET POSITION FRESHNESS
// ======================================================
function getPositionFreshness(trainNumber, trainPosition, live) {
    const repeatedCount =
        getConsecutiveSamePositionCount(
            trainNumber,
            trainPosition
        );

    const stale =
        isPositionStale(
            trainNumber,
            trainPosition,
            live,
            repeatedCount
        );

    return {
        stale,
        repeatedCount
    };
}


// ======================================================
// RECORD OBSERVATION USING EXISTING LIVE DATA
// ======================================================
//
// analyzeTrain() already has the live response.
//
// Therefore this function does NOT call getTrainLive()
// again.
//
// ======================================================

function recordObservationFromLive(
    trainNumber,
    live,
    resolvedPosition = null
) {

    if (isTrainCancelled(live)) {
        return null;
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


    const positionInfo =
        resolvedPosition ||
        resolveTrainPosition(
            live
        );


    const currentPosition =
        Number(
            positionInfo.positionKm
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
    // Previous observation (with recency verification)
    // --------------------------------------------------

    const previous =
        getLatestObservation(
            trainNumber
        );

    const usablePrevious =
        previous && isObservationRecent(previous)
            ? previous
            : null;

    const previousPosition =
        usablePrevious
            ? Number(
                usablePrevious.railway_position_km
            )
            : null;

    const previousTs =
        usablePrevious && usablePrevious.timestamp
            ? new Date(usablePrevious.timestamp).getTime()
            : null;

    const elapsedMs =
        previousTs && Number.isFinite(previousTs)
            ? (Date.now() - previousTs)
            : null;

    // --------------------------------------------------
    // Determine movement (anomaly & velocity guarded)
    // --------------------------------------------------

    const movement =
        determineMovement(
            previousPosition,
            currentPosition,
            elapsedMs
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

        position_source:
            positionInfo.source,

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

        segment_progress:
            currentLocation.segmentProgress ??
            null,

        movement,

        previous_position_km:
            previousPosition

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


    // --------------------------------------------------
    // Console output
    // --------------------------------------------------

    console.log("");


    console.log(
        `Current position: ${currentPosition.toFixed(3)} km`
    );


    console.log(
        `Position source: ${positionInfo.source}`
    );


    console.log(
        `Previous position: ${
            previousPosition != null
                ? previousPosition.toFixed(3) + " km"
                : "none"
        }`
    );


    console.log(
        `Movement: ${movement.toUpperCase()}`
    );


    console.log(
        `Sequence: ${
            currentLocation.sequence ??
            "unknown"
        }`
    );


    console.log(
        `Station: ${
            currentLocation.stationName ??
            "unknown"
        }`
    );


    console.log("");


    console.log(
        "✅ Observation recorded"
    );


    return observation;
}


// ======================================================
// INFER TRAIN DIRECTION
// ======================================================
//
// Priority:
//
// 1. Reliable observed movement
// 2. Route sequence inference
// 3. Unknown
//
// ======================================================

function makeDirectionResult(dir, source, exited = false) {
    const s = new String(dir);
    s.direction = dir;
    s.source = source;
    s.exitedCorridor = exited;
    return s;
}

function inferDirectionFromRoute(input) {
    const live = Array.isArray(input) ? { route: input } : (input?.live || input);
    const trainPositionKm = input?.trainPositionKm;
    const previousPositionKm = input?.previousPositionKm;
    const observedMovement = input?.observedMovement;

    const route =
        Array.isArray(live?.route)
            ? live.route
            : (Array.isArray(input) ? input : []);

    const currentSequence =
        Number(
            live?.currentLocation?.sequence
        );

    // 1. Establish corridor travel orientation based on scheduled stop sequences in route
    const findStation = codes => {
        const idx = route.findIndex(station => {
            const code = String(station?.stationCode ?? station?.code ?? "").toUpperCase();
            return codes.includes(code);
        });
        if (idx === -1) return null;
        const station = route[idx];
        const seq = station?.sequence != null ? Number(station.sequence) : (idx + 1);
        return { ...station, sequence: seq };
    };

    const westStation = findStation(["MOW", "ASR"]);
    const eastStation = findStation(["JNL", "BEAS", "TRA"]);

    const westSeq = Number(westStation?.sequence);
    const eastSeq = Number(eastStation?.sequence);

    if (Number.isFinite(westSeq) && Number.isFinite(eastSeq)) {
        if (westSeq < eastSeq) {
            // Train travels West to East (Amritsar -> Jandiala)
            const exited =
                Number.isFinite(currentSequence) &&
                currentSequence > eastSeq;

            return makeDirectionResult("forward", "route-sequence-west-to-east", exited);
        } else if (eastSeq < westSeq) {
            // Train travels East to West (Jandiala -> Amritsar)
            const exited =
                Number.isFinite(currentSequence) &&
                currentSequence > westSeq;

            return makeDirectionResult("backward", "route-sequence-east-to-west", exited);
        }
    }

    // 2. Physical movement between consecutive observations (if available)
    if (Number.isFinite(trainPositionKm) && Number.isFinite(previousPositionKm)) {
        const delta = trainPositionKm - previousPositionKm;
        if (delta > 0.05) {
            return makeDirectionResult("forward", "observed-movement-eastbound", false);
        }
        if (delta < -0.05) {
            return makeDirectionResult("backward", "observed-movement-westbound", false);
        }
        if (Math.abs(delta) <= 0.05 && input?.speedKmph === 0) {
            return makeDirectionResult("stationary", "observed-movement-stationary", false);
        }
    }

    if (
        observedMovement === "forward" ||
        observedMovement === "backward" ||
        observedMovement === "reverse"
    ) {
        const normDir = (observedMovement === "reverse") ? "backward" : observedMovement;
        return makeDirectionResult(normDir, "observed-movement-fallback", false);
    }

    if (observedMovement === "stationary") {
        return makeDirectionResult("stationary", "observed-movement-stationary", false);
    }

    // 3. Next halt / previous halt checks
    const nextHalt =
        live?.nextHalt ||
        live?.next_halt ||
        null;

    const previousHalt =
        live?.previousHalt ||
        live?.previous_halt ||
        null;

    const nextCode =
        String(
            nextHalt?.stationCode ??
            nextHalt?.code ??
            ""
        ).toUpperCase();

    const prevCode =
        String(
            previousHalt?.stationCode ??
            previousHalt?.code ??
            ""
        ).toUpperCase();

    if (nextCode === "JNL" || nextCode === "BEAS" || nextCode === "TRA") {
        return makeDirectionResult("forward", "next-halt-eastbound", false);
    }

    if (nextCode === "MOW" || nextCode === "ASR") {
        return makeDirectionResult("backward", "next-halt-westbound", false);
    }

    if (prevCode === "JNL" && Number.isFinite(eastSeq) && Number.isFinite(currentSequence) && currentSequence > eastSeq) {
        return makeDirectionResult("forward", "previous-halt-jandiala-departed", true);
    }

    // 4. Scheduled origin and destination stations fallback
    const originCode = String(
        live?.train?.source?.code ||
        live?.train?.source ||
        live?.source ||
        live?.fromStation ||
        ""
    ).toUpperCase().trim();

    const destCode = String(
        live?.train?.destination?.code ||
        live?.train?.destination ||
        live?.destination ||
        live?.toStation ||
        ""
    ).toUpperCase().trim();

    if (originCode === "ASR" || originCode === "MOW") {
        return makeDirectionResult("forward", "origin-amritsar-eastbound", false);
    }

    if (destCode === "ASR" || destCode === "MOW") {
        return makeDirectionResult("backward", "destination-amritsar-westbound", false);
    }

    // 5. Truly unknown / direction uncertain
    return makeDirectionResult("unknown", "direction-uncertain", false);
}



// ======================================================
// APPLY INFERRED DIRECTION TO OBSERVATION
// ======================================================

function applyInferredDirection(
    trainNumber,
    observation,
    direction,
    directionSource
) {

    const observations =
        readObservations();


    const latestIndex =
        observations.length - 1;


    if (
        latestIndex < 0
    ) {

        return observation;
    }


    const latest =
        observations[
            latestIndex
        ];


    if (
        String(
            latest.train_number
        ) !==
        String(trainNumber)
    ) {

        return observation;
    }


    latest.movement =
        direction;


    latest.direction_source =
        directionSource;


    observations[
        latestIndex
    ] =
        latest;


    saveObservations(
        observations
    );


    return latest;
}


// ======================================================
// BUILD CROSSING RESULT
// ======================================================

function buildCrossingResult(
    mapped,
    crossing,
    trainPosition,
    direction,
    exitedCorridor = false,
    observedMovement = null
) {
    if (exitedCorridor) {
        return null;
    }

    const crossingPosition =
        Number(
            mapped.routeDistanceKm
        );

    if (
        !Number.isFinite(
            crossingPosition
        )
    ) {
        return null;
    }

    const isReverse = direction === "backward" || direction === "reverse" || observedMovement === "backward" || observedMovement === "reverse";
    let distanceKm;

    if (isReverse) {
        // Reverse (Jandiala -> Amritsar): crossing is ahead if crossingPosition < trainPosition
        distanceKm =
            trainPosition -
            crossingPosition;
    } else {
        // Forward (Amritsar -> Jandiala): crossing is ahead if crossingPosition > trainPosition
        distanceKm =
            crossingPosition -
            trainPosition;
    }

    return {
        id:
            crossing.id,

        crossingId:
            crossing.id,

        name:
            crossing.name,

        railwayPositionKm:
            Number(
                crossingPosition.toFixed(3)
            ),

        crossingPositionKm:
            Number(
                crossingPosition.toFixed(3)
            ),

        distanceKm:
            Number(
                distanceKm.toFixed(3)
            ),

        direction:
            isReverse ? "reverse" : "forward",

        status:
            distanceKm > 0
                ? "approaching"
                : "passed",


        routeMapping: {

            anchorStart:
                mapped.anchorStart,

            anchorEnd:
                mapped.anchorEnd,

            geometry:
                mapped.geometry,

            railwayDistanceKm:
                mapped.railwayDistanceKm

        }

    };
}


// ======================================================
// ADD ETA TO CROSSING
// ======================================================
//
// Uses central ETA engine.
//
// IMPORTANT:
//
// If the train is genuinely not-started/scheduled,
// live speed is NOT supplied to the ETA engine.
//
// This prevents:
//
//     position = 0 km
//     speed = nominal API speed
//
// from being interpreted as a real moving train.
//
// The ETA engine may still use a station-anchor ETA if
// that information is available.
//

function addCrossingETA({
    crossing,
    etaRoute,
    trainPosition,
    direction,
    live,
    speedKmph,
    positionFresh,
    livePositionStale
}) {

    const trainNotStarted =
        isTrainNotStarted(
            live
        );


    const usableLivePosition =
        positionFresh &&
        !livePositionStale &&
        !trainNotStarted;

        // A not-started train cannot receive a "now + distance/speed" ETA.
// Its crossing ETA must be anchored to a valid future departure/arrival
// time. If no such anchor exists, leave the ETA unavailable.
if (trainNotStarted) {
    const delayMinutes = Number(
        live?.delayMinutes ??
        live?.delay_minutes ??
        live?.delay ??
        live?.currentLocation?.delayMinutes ??
        live?.route?.[0]?.delayMinutes ??
        live?.route?.[0]?.delayDeparture ??
        live?.stop?.delayMinutes ??
        0
    );

    const explicitDeparture =
        live?.expectedDepartureTime ??
        live?.estimatedDepartureTime ??
        live?.route?.[0]?.expectedDeparture ??
        live?.stop?.expectedDepartureTime ??
        live?.currentLocation?.expectedDepartureTime ??
        null;

    const scheduledDeparture =
        explicitDeparture ??
        live?.route?.[0]?.actualDeparture ??
        live?.route?.[0]?.scheduledDeparture ??
        live?.stop?.actualDeparture ??
        live?.stop?.scheduledDeparture ??
        live?.currentLocation?.actualDeparture ??
        live?.currentLocation?.scheduledDeparture ??
        live?.scheduledDepartureTime ??
        live?.departureTime ??
        null;

    const departureDate =
        scheduledDeparture
            ? new Date(scheduledDeparture)
            : null;

    if (
        !departureDate ||
        Number.isNaN(departureDate.getTime())
    ) {
        crossing.etaMinutes = null;
        crossing.estimatedPassageTime = null;
        crossing.etaMethod = "unavailable";
        crossing.etaConfidence = "not-started-no-departure";
        crossing.etaSource =
            "Train has not started and no valid departure anchor is available";
        crossing.etaAnchorStation = null;
        crossing.etaAnchorStationCode = null;
        crossing.etaAnchorTime = null;
        crossing.etaSpeedKmph = null;
        crossing.positionFresh = false;
        crossing.livePositionStale = false;
        crossing.trainNotStarted = true;

        return crossing;
    }

    let delayedDepartureMs = departureDate.getTime();
    if (!explicitDeparture && Number.isFinite(delayMinutes) && delayMinutes !== 0) {
        delayedDepartureMs += delayMinutes * 60000;
    }

    const departureMs = Math.max(Date.now(), delayedDepartureMs);
    const transitSpeedKmph = speedKmph || live?.route?.[0]?.speedToNextStationKmph || 60;
    const transitMinutes = (crossing.distanceKm / transitSpeedKmph) * 60;
    const passageTimeMs = departureMs + (transitMinutes * 60000);
    const etaMinutes = Math.max(0, (passageTimeMs - Date.now()) / 60000);

    const scheduledPassageMs = departureDate.getTime() + (transitMinutes * 60000);
    const scheduledPassageTime = new Date(scheduledPassageMs).toISOString();

    const diffMinutes = (passageTimeMs - scheduledPassageMs) / 60000;
    let earlyLateStatus = "ON_TIME";
    if (diffMinutes < -1.5) earlyLateStatus = "EARLY";
    else if (diffMinutes > 1.5) earlyLateStatus = "DELAYED";

    crossing.etaMinutes = Number(etaMinutes.toFixed(1));
    crossing.estimatedPassageTime = new Date(passageTimeMs).toISOString();
    crossing.scheduledPassageTime = scheduledPassageTime;
    crossing.earlyLateStatus = earlyLateStatus;
    crossing.earlyLateMinutes = Math.round(diffMinutes * 10) / 10;
    crossing.etaMethod = "departure-anchor";
    crossing.etaConfidence = delayMinutes < 0 ? "early-departure-anchor" : (delayMinutes > 0 ? "delayed-departure-anchor" : "scheduled-departure");
    crossing.etaSource = delayMinutes < 0
        ? `Station early departure anchor (${delayMinutes}m early, ${new Date(departureMs).toLocaleTimeString()})`
        : (delayMinutes > 0
            ? `Station delayed departure anchor (+${delayMinutes}m delay, ${new Date(departureMs).toLocaleTimeString()})`
            : `Station departure anchor (${new Date(departureMs).toLocaleTimeString()})`);
    crossing.etaSpeedKmph = transitSpeedKmph;
    crossing.positionFresh = true;
    crossing.livePositionStale = false;
    crossing.trainNotStarted = true;
    crossing.delayMinutes = Number.isFinite(delayMinutes) ? delayMinutes : 0;
    crossing.source = explicitDeparture || live?.route?.[0]?.actualDeparture ? "ACTUAL_DEPARTURE" : "SCHEDULE_ESTIMATE";
    crossing.confidence = delayMinutes !== 0 ? "MEDIUM" : "HIGH";
    crossing.movementState = "STATION_STOP";
    crossing.stopType = "KNOWN_STATION_STOP";
    crossing.telemetryFreshness = "FRESH";
    crossing.telemetryAgeMinutes = 0;

    if (earlyLateStatus === "EARLY") {
        const gateClose = new Date(passageTimeMs - 11 * 60000);
        const gateOpen = new Date(passageTimeMs + 1 * 60000);
        const trainNum = live?.trainNumber || live?.train_number || live?.trainNo || "UNKNOWN";
        console.log(`[EARLY-TRAIN] Train ${trainNum}: Live ETA ${new Date(passageTimeMs).toLocaleTimeString()} (${Math.abs(Math.round(diffMinutes))} min early vs scheduled ${new Date(scheduledPassageMs).toLocaleTimeString()}). Crossing ${crossing.name || crossing.id}: Passage=${new Date(passageTimeMs).toLocaleTimeString()} GateClose=${gateClose.toLocaleTimeString()} GateOpen=${gateOpen.toLocaleTimeString()} (Confidence: ${crossing.confidence})`);
    }

    return crossing;
}
        

    const etaResult =
        estimateTrainPassage({

            route:
                etaRoute,

            crossingPositionKm:
                crossing.railwayPositionKm,

            trainPositionKm:
                trainPosition,

            direction,

            live,

            fallbackSpeedKmph:
                usableLivePosition
                    ? speedKmph
                    : null,

            // ------------------------------------------------
            // CRITICAL:
            //
            // Stale OR not-started positions cannot drive
            // live-position ETA.
            // ------------------------------------------------

            livePositionFresh:
                usableLivePosition

        });


    // ==================================================
    // ETA AVAILABLE
    // ==================================================

    if (
        etaResult.ready &&
        etaResult.passageTime
    ) {

        const passageTime =
            new Date(
                etaResult.passageTime
            );


        const etaMinutes =
            (
                passageTime.getTime() -
                Date.now()
            ) / 60000;


        if (
            Number.isFinite(
                etaMinutes
            ) &&
            etaMinutes >= 0
        ) {

            crossing.etaMinutes =
                Number(
                    etaMinutes.toFixed(1)
                );


            crossing.estimatedPassageTime =
                etaResult.passageTime;


            crossing.etaMethod =
                etaResult.method;


            crossing.etaConfidence =
                etaResult.confidence;


            crossing.etaSource =
                etaResult.source;

            crossing.source =
                etaResult.source;

            crossing.confidence =
                etaResult.confidence;

            crossing.telemetryFreshness =
                etaResult.telemetryFreshness || (usableLivePosition ? "FRESH" : "UNAVAILABLE");

            crossing.telemetryAgeMinutes =
                etaResult.telemetryAgeMinutes ?? 0;

            crossing.movementState =
                etaResult.movementState || "RUNNING";

            crossing.stopType =
                etaResult.stopType || null;

            crossing.degradedConfidence =
                Boolean(etaResult.degradedConfidence || etaResult.confidence === "DEGRADED");

            crossing.unexpectedHalt =
                Boolean(etaResult.unexpectedHalt);


            crossing.etaAnchorStation =
                etaResult.anchorStationName ||
                null;


            crossing.etaAnchorStationCode =
                etaResult.anchorStationCode ||
                null;


            crossing.etaAnchorTime =
                etaResult.anchorTime ||
                null;


            crossing.etaSpeedKmph =
                etaResult.speedKmph ||
                null;


            crossing.positionFresh =
                usableLivePosition;


            crossing.livePositionStale =
                livePositionStale;


            crossing.trainNotStarted =
                trainNotStarted;

            const delayMinutes = Number(
                live?.delayMinutes ??
                live?.delay_minutes ??
                live?.delay ??
                live?.currentLocation?.delayMinutes ??
                0
            );
            const passageTimeMs = passageTime.getTime();
            let scheduledPassageMs = null;
            if (Number.isFinite(delayMinutes) && delayMinutes !== 0) {
                scheduledPassageMs = passageTimeMs - delayMinutes * 60000;
            }
            const scheduledPassageTime = scheduledPassageMs ? new Date(scheduledPassageMs).toISOString() : null;
            let earlyLateStatus = "ON_TIME";
            let diffMinutes = 0;
            if (scheduledPassageMs) {
                diffMinutes = (passageTimeMs - scheduledPassageMs) / 60000;
                if (diffMinutes < -1.5) earlyLateStatus = "EARLY";
                else if (diffMinutes > 1.5) earlyLateStatus = "DELAYED";
            }

            crossing.scheduledPassageTime = scheduledPassageTime;
            crossing.earlyLateStatus = earlyLateStatus;
            crossing.earlyLateMinutes = Math.round(diffMinutes * 10) / 10;
            crossing.delayMinutes = Number.isFinite(delayMinutes) ? delayMinutes : 0;

            if (earlyLateStatus === "EARLY") {
                const gateClose = new Date(passageTimeMs - 11 * 60000);
                const gateOpen = new Date(passageTimeMs + 1 * 60000);
                const trainNum = live?.trainNumber || live?.train_number || live?.trainNo || "UNKNOWN";
                console.log(`[EARLY-TRAIN] Train ${trainNum}: Live ETA ${new Date(passageTimeMs).toLocaleTimeString()} (${Math.abs(Math.round(diffMinutes))} min early vs scheduled ${new Date(scheduledPassageMs).toLocaleTimeString()}). Crossing ${crossing.name || crossing.id}: Passage=${new Date(passageTimeMs).toLocaleTimeString()} GateClose=${gateClose.toLocaleTimeString()} GateOpen=${gateOpen.toLocaleTimeString()} (Confidence: ${crossing.confidence})`);
            }

            return crossing;
        }
    }


    // ==================================================
    // ETA UNAVAILABLE
    // ==================================================

    crossing.etaMinutes =
        null;


    crossing.estimatedPassageTime =
        null;


    crossing.etaMethod =
        "unavailable";


    crossing.etaConfidence =
        livePositionStale
            ? "stale-position"
            : trainNotStarted
                ? "not-started"
                : "unavailable";


    crossing.etaSource =
        livePositionStale
            ? "RailRadar railway position stale"
            : trainNotStarted
                ? "Train has not started; no live-position ETA available"
                : null;


    crossing.etaAnchorStation =
        null;


    crossing.etaAnchorStationCode =
        null;


    crossing.etaAnchorTime =
        null;


    crossing.etaSpeedKmph =
        null;


    crossing.positionFresh =
        usableLivePosition;


    crossing.livePositionStale =
        livePositionStale;


    crossing.trainNotStarted =
        trainNotStarted;

    crossing.source =
        etaResult?.source || "unavailable";

    crossing.confidence =
        etaResult?.confidence || "LOW";

    crossing.telemetryFreshness =
        etaResult?.telemetryFreshness || (livePositionStale ? "STALE" : "UNAVAILABLE");

    crossing.telemetryAgeMinutes =
        etaResult?.telemetryAgeMinutes ?? null;

    crossing.movementState =
        etaResult?.movementState || "UNKNOWN";

    crossing.stopType =
        etaResult?.stopType || null;

    crossing.degradedConfidence = true;

    crossing.etaMessage =
        livePositionStale
            ? "Live train position has not updated; ETA temporarily uncertain."
            : trainNotStarted
                ? "Train has not started; crossing ETA is not currently reliable."
                : "Train passage ETA currently unavailable.";


    return crossing;
}


// ======================================================
// ANALYZE ONE TRAIN
// ======================================================

async function analyzeTrain(
    trainNumberOrLive
) {
    const isLiveObject = typeof trainNumberOrLive === "object" && trainNumberOrLive !== null;
    const trainNumber = isLiveObject
        ? (trainNumberOrLive.trainNumber || trainNumberOrLive.number || "00000")
        : trainNumberOrLive;

    console.log("");

    console.log(
        "========================================"
    );

    console.log(
        `ANALYZING TRAIN ${trainNumber}`
    );

    console.log(
        "========================================"
    );


    // ==================================================
    // 1. GET LIVE DATA — ONLY ONCE
    // ==================================================

    const live = isLiveObject
        ? trainNumberOrLive
        : await getTrainLive(trainNumber);


    if (isTrainCancelled(live)) {
        console.log(`🚫 Train ${trainNumber} — CANCELLED`);
        console.log(`   Skipping crossing forecast.`);
        return {
            trainNumber: String(trainNumber),
            trainName: live.name || live.trainName || live.train?.name || null,
            isCancelled: true,
            status: "cancelled",
            success: false,
            crossings: [],
            forecastCrossings: [],
            nextCrossing: null,
            reason: "cancelled"
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


    const trainNotStarted =
        isTrainNotStarted(
            live
        );


    // ==================================================
    // 2. GET TRAIN ROUTE GEOMETRY
    // ==================================================

    const route =
        live.routeGeometry ||
        live.routeData ||
        await getTrainRoute(
            trainNumber
        );


    if (
        !route ||
        !route.geojson
    ) {

        throw new Error(
            "RailRadar train route geometry unavailable."
        );
    }


    // ==================================================
    // 3. RESOLVE TRAIN POSITION
    // ==================================================

    const positionInfo =
        resolveTrainPosition(
            live,
            route
        );


    const trainPosition =
        Number(
            positionInfo.positionKm
        );


    if (
        !Number.isFinite(
            trainPosition
        )
    ) {

        throw new Error(
            "Train railway position unavailable."
        );
    }


    // --------------------------------------------------
    // Reject impossible route projection.
    // --------------------------------------------------

    if (
        positionInfo.distanceFromTrackKm != null &&
        positionInfo.distanceFromTrackKm > 0.5
    ) {

        throw new Error(
            `Resolved train position is ${positionInfo.distanceFromTrackKm.toFixed(3)} km from the route.`
        );
    }


    // ==================================================
    // 4. RECORD OBSERVATION
    // ==================================================

    const observation =
        recordObservationFromLive(
            trainNumber,
            live,
            positionInfo
        );


    const observedMovement =
        observation.movement;


    console.log("");


    console.log(
        `Direction from observations: ${
            observedMovement.toUpperCase()
        }`
    );


    console.log(
        `Train railway position: ${
            trainPosition.toFixed(3)
        } km`
    );


    console.log(
        `Train sequence: ${
            currentLocation.sequence ??
            "unknown"
        }`
    );


    console.log(
        `Train status: ${
            live.status ??
            currentLocation.status ??
            "unknown"
        }`
    );


    if (
        trainNotStarted
    ) {

        console.log(
            "ℹ️ Train has not started/scheduled yet."
        );

        console.log(
            "   Live speed will NOT be used for crossing ETA."
        );
    }


    // ==================================================
    // 5. CHECK POSITION FRESHNESS
    // ==================================================

    const freshness =
        getPositionFreshness(
            trainNumber,
            trainPosition,
            live
        );


    const livePositionStale =
        freshness.stale;


    const positionFresh =
        !livePositionStale &&
        !trainNotStarted;


    console.log("");


    console.log(
        `Position repetitions: ${
            freshness.repeatedCount
        }`
    );


    if (
        livePositionStale
    ) {

        console.log(
            "🚨 LIVE POSITION: STALE / UNRELIABLE"
        );


        console.log(
            "⚠️ Live-position ETA will NOT be used."
        );

    } else if (
        trainNotStarted
    ) {

        console.log(
            "ℹ️ LIVE POSITION: NOT USABLE FOR ETA — TRAIN NOT STARTED"
        );

    } else {

        console.log(
            "✅ LIVE POSITION: FRESH"
        );
    }


    // ==================================================
    // 6. SPEED
    // ==================================================

    const speedKmph =
        getTrainSpeed(
            live
        );


    console.log(
        `Speed: ${
            speedKmph != null
                ? speedKmph.toFixed(1) +
                  " km/h"
                : "unavailable"
        }`
    );


    // ==================================================
    // 7. INFER DIRECTION
    // ==================================================

    const directionResult =
        inferDirectionFromRoute({

            live,

            trainPositionKm:
                trainPosition,

            observedMovement

        });


    let direction =
        directionResult.direction;

    const exitedCorridor =
        directionResult.exitedCorridor === true;

    if (exitedCorridor) {
        console.log("ℹ️ Train has passed through and exited the corridor.");
    }

    const updatedObservation =
        applyInferredDirection(
            trainNumber,
            observation,
            direction,
            directionResult.source
        );

    direction =
        updatedObservation.movement;

    console.log("");

    console.log(
        `Direction used for forecast: ${
            direction.toUpperCase()
        }`
    );

    console.log(
        `Direction source: ${
            directionResult.source
        }`
    );



    // ==================================================
    // 8. LIVE ROUTE + GEOMETRY ROUTE
    // ==================================================

    const routeStations =
        Array.isArray(
            live?.route
        )
            ? live.route
            : [];


    const coordinateStations =
        Array.isArray(
            route?.stops
        )
            ? route.stops
            : [];


    const etaRoute =
        buildGeometryRoute(
            routeStations,
            route
        );


    if (
        routeStations.length === 0 ||
        etaRoute.length === 0
    ) {

        throw new Error(
            "RailRadar live route station data unavailable."
        );
    }


    // ==================================================
    // 9. UNKNOWN DIRECTION
    // ==================================================

    if (
        direction !== "forward" &&
        direction !== "backward" &&
        direction !== "reverse"
    ) {

        console.log("");

        console.log(
            "⚠️ Direction uncertain after route inference."
        );


        console.log(
            "No crossing will be classified as approaching."
        );


        return {

            trainNumber:
                String(trainNumber),

            trainName:
                live.name ||
                live.trainName ||
                live.train?.name ||
                null,

            direction:
                "unknown",

            directionUncertain:
                true,

            message:
                "Direction uncertain",

            status:
                live.status ??
                currentLocation.status ??
                null,

            trainPositionKm:
                trainPosition,

            trainPositionSource:
                positionInfo.source,

            sequence:
                currentLocation.sequence ??
                null,

            stationCode:
                currentLocation.stationCode ??
                null,

            stationName:
                currentLocation.stationName ??
                null,

            speedKmph,

            direction,

            directionSource:
                directionResult.source,

            positionFresh,

            livePositionStale,

            trainNotStarted,

            positionRepeatCount:
                freshness.repeatedCount,

            crossings: [],

            forecastCrossings: [],

            nextCrossing:
                null,

            nextExpectedCrossing:
                null,

            nextLongRangeCrossing:
                null,

            forecastHorizonMinutes:
                FORECAST_HORIZON_MINUTES

        };
    }


    // ==================================================
    // 10. MAP ALL V1 CROSSINGS TO TRAIN ROUTE
    // ==================================================

    const mappedCrossings =
        mapCrossingsToTrainRoute(
            crossings,
            route.geojson,
            routeStations,
            coordinateStations,
            "JNL",
            "MOW"
        );


    // ==================================================
    // 11. DISPLAY ROUTE MAPPING
    // ==================================================

    console.log("");

    console.log(
        "Route mapping:"
    );


    for (
        const mapped of mappedCrossings
    ) {

        console.log(
            `  ${mapped.crossingName} -> ` +
            `${mapped.routeDistanceKm.toFixed(3)} km (GeoJSON)`
        );


        console.log(
            `    Railway distance from route: ` +
            `${mapped.railwayDistanceKm.toFixed(3)} km`
        );
    }


    // ==================================================
    // 12. BUILD ALL CROSSING RESULTS
    // ==================================================
    //
    // NO arbitrary distance cutoff.
    //
    // ETA determines immediate relevance.
    //
    // ==================================================

    const allCrossingResults =
        mappedCrossings
            .map(
                mapped => {

                    const crossing =
                        crossings.find(
                            item =>
                                item.id ===
                                mapped.crossingId
                        );


                    if (!crossing) {

                        return null;
                    }


                    return buildCrossingResult(
                        mapped,
                        crossing,
                        trainPosition,
                        direction,
                        exitedCorridor,
                        observedMovement
                    );

                }
            )
            .filter(Boolean);


    // ==================================================
    // 13. FIND CROSSINGS AHEAD
    // ==================================================

    const approachingCrossings =
        allCrossingResults
            .filter(
                crossing =>
                    crossing.distanceKm > 0
            )
            .sort(
                (a, b) =>
                    a.distanceKm -
                    b.distanceKm
            );


    console.log("");

    console.log(
        `Crossings ahead: ${
            approachingCrossings.length
        }`
    );


    for (
        const crossing of approachingCrossings
    ) {

        console.log(
            `  → ${crossing.name}: ` +
            `${crossing.distanceKm.toFixed(3)} km ahead`
        );
    }


    // ==================================================
    // 14. CALCULATE ETA FOR EVERY CROSSING
    // ==================================================
    //
    // There is NO arbitrary distance restriction.
    //
    // However:
    //
    // - fresh trains may produce live-position ETA
    // - stale/not-started trains cannot use live-position ETA
    // - V1 display is restricted to 60 minutes below
    //
    // ==================================================

    const allEtaCrossings =
        approachingCrossings
            .map(
                crossing => {

                    return addCrossingETA({

                        crossing,

                        etaRoute,

                        trainPosition,

                        direction,

                        live,

                        speedKmph,

                        positionFresh,

                        livePositionStale

                    });
                }
            )
            .filter(
                crossing =>
                    crossing.etaMinutes != null
            )
            .filter(
                crossing =>
                    Number.isFinite(
                        crossing.etaMinutes
                    ) &&
                    crossing.etaMinutes >= 0
            )
            .sort(
                (a, b) =>
                    a.etaMinutes -
                    b.etaMinutes
            );


    // ==================================================
    // 15. 60-MINUTE V1 FORECAST
    // ==================================================
    //
    // THIS is the user-facing imminent forecast.
    //
    // Anything beyond 60 minutes is NOT a V1 imminent
    // crossing.
    //
    // ==================================================

    const forecastCrossings =
        allEtaCrossings
            .filter(
                crossing =>
                    crossing.etaMinutes <=
                    FORECAST_HORIZON_MINUTES
            );


    // ==================================================
    // 16. NEXT V1 CROSSING
    // ==================================================
    //
    // IMPORTANT:
    //
    // nextCrossing now means:
    //
    //     earliest valid crossing within 60 minutes
    //
    // This prevents a 141-minute event from being shown
    // as the V1 "next expected crossing".
    //
    // ==================================================

    const nextCrossing =
        forecastCrossings.length > 0
            ? forecastCrossings[0]
            : null;


    // --------------------------------------------------
    // Keep long-range information separately.
    //
    // This is NOT used as V1 nextCrossing.
    // --------------------------------------------------

    const nextLongRangeCrossing =
        allEtaCrossings.length > 0
            ? allEtaCrossings[0]
            : null;


    // ==================================================
    // 17. DISPLAY FORECAST
    // ==================================================

    console.log("");

    console.log(
        "========================================"
    );

    console.log(
        "FATAKFORECAST — FORECAST"
    );

    console.log(
        "========================================"
    );


    // ==================================================
    // NEXT V1 EVENT
    // ==================================================

    if (
        nextCrossing
    ) {

        console.log("");

        console.log(
            "🔮 NEXT EXPECTED CROSSING"
        );


        console.log(
            `→ ${nextCrossing.name}`
        );


        console.log(
            `ETA: ${
                nextCrossing.etaMinutes
            } minutes`
        );


        console.log(
            `Expected passage: ${
                nextCrossing.estimatedPassageTime
            }`
        );


        console.log(
            `ETA method: ${
                nextCrossing.etaMethod
            }`
        );


        console.log(
            `ETA confidence: ${
                nextCrossing.etaConfidence
            }`
        );


        if (
            nextCrossing.etaAnchorStation
        ) {

            console.log(
                `ETA anchor: ${
                    nextCrossing.etaAnchorStation
                }`
            );
        }

    } else {

        console.log("");

        console.log(
            "🔮 NEXT EXPECTED CROSSING"
        );

        console.log(
            "No crossing is expected within the next 60 minutes."
        );


        if (
            nextLongRangeCrossing
        ) {

            console.log(
                `ℹ️ Long-range candidate exists at ${
                    nextLongRangeCrossing.etaMinutes
                } minutes, but it is outside the V1 60-minute window.`
            );

        } else {

            console.log(
                "ℹ️ No reliable future crossing ETA is currently available."
            );
        }
    }


    // ==================================================
    // DETAILED 60-MINUTE FORECAST
    // ==================================================

    console.log("");

    console.log(
        "----------------------------------------"
    );

    console.log(
        `DETAILED ${FORECAST_HORIZON_MINUTES}-MINUTE FORECAST`
    );


    if (
        forecastCrossings.length > 0
    ) {

        console.log("");

        console.log(
            `🚂 ${forecastCrossings.length} crossing(s) inside detailed forecast`
        );


        for (
            const crossing of forecastCrossings
        ) {

            console.log("");

            console.log(
                `→ ${crossing.name}`
            );


            console.log(
                `  Distance: ${
                    crossing.distanceKm
                } km`
            );


            console.log(
                `  Train passage ETA: ${
                    crossing.etaMinutes
                } minutes`
            );


            console.log(
                `  Estimated passage: ${
                    crossing.estimatedPassageTime
                }`
            );


            console.log(
                `  ETA method: ${
                    crossing.etaMethod
                }`
            );


            console.log(
                `  ETA confidence: ${
                    crossing.etaConfidence
                }`
            );


            if (
                crossing.etaAnchorStation
            ) {

                console.log(
                    `  ETA anchor: ${
                        crossing.etaAnchorStation
                    }`
                );
            }


            if (
                crossing.etaSpeedKmph != null
            ) {

                console.log(
                    `  ETA speed: ${
                        Number(
                            crossing.etaSpeedKmph
                        ).toFixed(1)
                    } km/h`
                );
            }


            if (
                crossing.livePositionStale
            ) {

                console.log(
                    "  ⚠️ Live railway position is stale."
                );
            }


            if (
                crossing.trainNotStarted
            ) {

                console.log(
                    "  ℹ️ Train has not started; live-position ETA was not used."
                );
            }
        }

    } else {

        console.log("");

        console.log(
            "No crossing is currently inside the detailed 60-minute forecast."
        );
    }


    // ==================================================
    // 18. RETURN RESULT
    // ==================================================

    return {

        trainNumber:
            String(trainNumber),

        trainName:
            live.name ||
            live.trainName ||
            live.train?.name ||
            null,

        status:
            live.status ??
            currentLocation.status ??
            null,

        trainPositionKm:
            trainPosition,

        trainPositionSource:
            positionInfo.source,

        sequence:
            currentLocation.sequence ??
            null,

        stationCode:
            currentLocation.stationCode ??
            null,

        stationName:
            currentLocation.stationName ??
            null,

        speedKmph,

        direction,

        directionSource:
            directionResult.source,

        positionFresh,

        livePositionStale,

        trainNotStarted,

        positionRepeatCount:
            freshness.repeatedCount,

        // ------------------------------------------------
        // V1 forecast horizon
        // ------------------------------------------------

        forecastHorizonMinutes:
            FORECAST_HORIZON_MINUTES,

        // ------------------------------------------------
        // All reliable ETA calculations.
        //
        // Kept for diagnostics/internal intelligence.
        // ------------------------------------------------

        crossings:
            allEtaCrossings,

        // ------------------------------------------------
        // ONLY crossings inside V1 60-minute horizon.
        // ------------------------------------------------

        forecastCrossings,

        // ------------------------------------------------
        // PRIMARY V1 crossing.
        //
        // Always null when nothing is inside 60 minutes.
        // ------------------------------------------------

        nextCrossing:
            nextCrossing,

        // ------------------------------------------------
        // Compatibility:
        //
        // nextExpectedCrossing now follows V1 semantics.
        // ------------------------------------------------

        nextExpectedCrossing:
            nextCrossing,

        // ------------------------------------------------
        // Internal long-range candidate.
        //
        // NOT used as V1 nextCrossing.
        // ------------------------------------------------

        nextLongRangeCrossing:
            nextLongRangeCrossing

    };
}


// ======================================================
// EXPORTS
// ======================================================

module.exports = {

    analyzeTrain,

    resolveTrainPosition,

    getTrainSpeed,

    inferDirectionFromRoute,

    isTrainCancelled,

    addCrossingETA

};