// ============================================================
// FATAKFORECAST — EVENT RECORDER
// ============================================================
//
// Responsibilities:
//
// 1. Validate train/crossing analysis
// 2. Generate closure prediction
// 3. Store every forecast version
// 4. Preserve forecast history
// 5. Preserve ETA and position-quality information
// 6. Keep prediction separate from actual gate observations
//
// IMPORTANT:
//
// Every monitoring cycle creates a NEW forecast snapshot.
//
// event_group_id:
//     identifies the same train + crossing + day
//
// forecast_version:
//     identifies the individual forecast snapshot
//
// event_id:
//     uniquely identifies that forecast snapshot
//
// Example:
//
// 14632-jandiala-2026-09-11-v1
// 14632-jandiala-2026-09-11-v2
// 14632-jandiala-2026-09-11-v3
//
// This prevents later forecasts from destroying earlier
// predictions and allows proper model evaluation.
//
// ============================================================

const fs =
    require("fs");

const path =
    require("path");


const {
    predictClosure
} =
    require("./closure-predictor");


// ============================================================
// CONFIG
// ============================================================

const EVENTS_FILE =
    path.join(
        __dirname,
        "..",
        "data",
        "crossing-events.json"
    );


// ============================================================
// FILE HELPERS
// ============================================================

function ensureEventsFile() {

    const directory =
        path.dirname(
            EVENTS_FILE
        );


    if (
        !fs.existsSync(
            directory
        )
    ) {

        fs.mkdirSync(
            directory,
            {
                recursive:
                    true
            }
        );
    }


    if (
        !fs.existsSync(
            EVENTS_FILE
        )
    ) {

        fs.writeFileSync(
            EVENTS_FILE,
            "[]",
            "utf8"
        );
    }
}


// ============================================================
// READ EVENTS
// ============================================================

function readEvents() {

    ensureEventsFile();


    try {

        const raw =
            fs.readFileSync(
                EVENTS_FILE,
                "utf8"
            );


        if (!raw.trim()) {
            return [];
        }


        const parsed =
            JSON.parse(
                raw
            );


        return Array.isArray(
            parsed
        )
            ? parsed
            : [];

    }
    catch (error) {

        console.error(
            "❌ Could not read crossing events:",
            error.message
        );


        return [];
    }
}


// ============================================================
// WRITE EVENTS
// ============================================================

function writeEvents(
    events
) {

    ensureEventsFile();


    fs.writeFileSync(
        EVENTS_FILE,
        JSON.stringify(
            events,
            null,
            2
        ),
        "utf8"
    );
}


// ============================================================
// BASE EVENT GROUP ID
// ============================================================
//
// Same train + crossing + day.
//
// This remains constant across all forecast versions.
// ============================================================

function createEventGroupId(
    trainNumber,
    crossingId,
    date = new Date()
) {

    const day =
        date
            .toISOString()
            .slice(
                0,
                10
            );


    return (
        `${trainNumber}-${crossingId}-${day}`
    );
}


// ============================================================
// FORECAST VERSION
// ============================================================

function getNextForecastVersion(
    events,
    eventGroupId
) {

    const versions =
        events
            .filter(
                event =>
                    event.event_group_id ===
                    eventGroupId
            )
            .map(
                event =>
                    Number(
                        event.forecast_version
                    )
            )
            .filter(
                Number.isFinite
            );


    if (
        versions.length === 0
    ) {

        return 1;
    }


    return (
        Math.max(
            ...versions
        ) + 1
    );
}


// ============================================================
// UNIQUE FORECAST EVENT ID
// ============================================================

function createForecastEventId(
    eventGroupId,
    version
) {

    return (
        `${eventGroupId}-v${version}`
    );
}


// ============================================================
// RECORD FORECAST
// ============================================================
//
// IMPORTANT:
//
// This function NEVER overwrites a previous forecast.
//
// Every call creates a new immutable forecast snapshot.
// ============================================================

function recordEvent(
    event
) {

    const events =
        readEvents();


    const eventGroupId =
        event.event_group_id ||
        event.event_id;


    const version =
        Number.isFinite(
            Number(
                event.forecast_version
            )
        )

            ? Number(
                event.forecast_version
            )

            : getNextForecastVersion(
                events,
                eventGroupId
            );


    const eventId =
        event.event_id &&
        event.forecast_version
            ? event.event_id
            : createForecastEventId(
                eventGroupId,
                version
            );


    const now =
        new Date().toISOString();


    const newEvent = {

        ...event,

        event_id:
            eventId,

        event_group_id:
            eventGroupId,

        forecast_version:
            version,

        forecast_recorded_at:
            event.forecast_recorded_at ??
            now,

        created_at:
            event.created_at ??
            now,

        updated_at:
            now
    };


    events.push(
        newEvent
    );


    writeEvents(
        events
    );


    console.log(
        `🆕 Forecast event CREATED: ${eventId}`
    );


    console.log(
        `   Forecast version: ${version}`
    );


    return {

        action:
            "created",

        event:
            newEvent
    };
}


// ============================================================
// RECORD ONE ANALYSIS RESULT
// ============================================================

function recordAnalysisResult(
    analysis
) {

    // --------------------------------------------------------
    // Basic validation
    // --------------------------------------------------------

    if (
        !analysis
    ) {

        console.log(
            "⚠️ Event recorder skipped: analysis missing."
        );


        return null;
    }
    // ========================================================
// V1 IMMEDIATE FORECAST SAFETY LIMIT
// ========================================================
//
// The recorder itself must never create a V1 event more
// than 60 minutes into the future.
//
// This is the final defense even if another code path
// calls recordAnalysisResult() directly.
// ========================================================

const V1_FORECAST_WINDOW_MINUTES = 60;

const recorderPassageRaw =
    analysis.estimatedPassageTime ??
    analysis.estimated_passage_time ??
    analysis.predictedPassageTime ??
    analysis.predicted_passage_time ??
    analysis.expectedPassageTime ??
    analysis.expected_passage_time ??
    analysis.passageTime ??
    analysis.passage_time ??
    null;

const recorderPassageMs =
    Date.parse(
        recorderPassageRaw
    );

if (
    Number.isFinite(
        recorderPassageMs
    )
) {

    const recorderEtaMinutes =
        (
            recorderPassageMs -
            Date.now()
        ) / 60000;

    if (
        recorderEtaMinutes > V1_FORECAST_WINDOW_MINUTES
    ) {

        console.log(
            `   ⏭️ Event recorder rejected ${
                analysis.crossingName ||
                analysis.crossingId ||
                "crossing"
            }: ETA ${
                recorderEtaMinutes.toFixed(1)
            } min exceeds V1 60-minute window`
        );

        return null;
    }

}


    // ========================================================
    // TRAIN INFORMATION
    // ========================================================

    const trainNumber =
        analysis.trainNumber ??
        analysis.train_number ??
        null;


    const trainName =
        analysis.trainName ??
        analysis.train_name ??
        "Unknown Train";


    const direction =
        analysis.direction ??
        null;


    const trainPositionKm =
        Number.isFinite(
            Number(
                analysis.trainPositionKm
            )
        )

            ? Number(
                analysis.trainPositionKm
            )

            : Number.isFinite(
                Number(
                    analysis.train_position_km
                )
            )

                ? Number(
                    analysis.train_position_km
                )

                : null;


    const speedKmh =
        Number.isFinite(
            Number(
                analysis.speedKmh
            )
        )

            ? Number(
                analysis.speedKmh
            )

            : Number.isFinite(
                Number(
                    analysis.speed_kmh
                )
            )

                ? Number(
                    analysis.speed_kmh
                )

                : null;


    // ========================================================
    // POSITION QUALITY
    // ========================================================

    const livePositionStale =
        analysis.livePositionStale === true ||
        analysis.live_position_stale === true ||
        analysis.positionFresh === false ||
        analysis.position_fresh === false;


    const positionFresh =
        !livePositionStale;


    const positionRepeatCount =
        Number.isFinite(
            Number(
                analysis.positionRepeatCount
            )
        )

            ? Number(
                analysis.positionRepeatCount
            )

            : Number.isFinite(
                Number(
                    analysis.position_repeat_count
                )
            )

                ? Number(
                    analysis.position_repeat_count
                )

                : 0;


    // ========================================================
    // CROSSING INFORMATION
    // ========================================================

    const crossingId =
        analysis.crossingId ??
        analysis.crossing_id ??
        analysis.id ??
        null;


    const crossingName =
        analysis.crossingName ??
        analysis.crossing_name ??
        analysis.name ??
        null;


    const crossingPositionKm =
        Number.isFinite(
            Number(
                analysis.crossingPositionKm
            )
        )

            ? Number(
                analysis.crossingPositionKm
            )

            : Number.isFinite(
                Number(
                    analysis.crossing_position_km
                )
            )

                ? Number(
                    analysis.crossing_position_km
                )

                : Number.isFinite(
                    Number(
                        analysis.routeDistanceKm
                    )
                )

                    ? Number(
                        analysis.routeDistanceKm
                    )

                    : Number.isFinite(
                        Number(
                            analysis.railwayPositionKm
                        )
                    )

                        ? Number(
                            analysis.railwayPositionKm
                        )

                        : null;


    // ========================================================
    // PASSAGE TIME
    // ========================================================

    const trainPassageTime =
        analysis.estimatedPassageTime ??
        analysis.estimated_passage_time ??
        analysis.passageTime ??
        analysis.passage_time ??
        analysis.estimatedTrainPassage ??
        null;


    // ========================================================
    // ETA INFORMATION
    // ========================================================

    const etaMinutes =
        Number.isFinite(
            Number(
                analysis.etaMinutes
            )
        )

            ? Number(
                analysis.etaMinutes
            )

            : Number.isFinite(
                Number(
                    analysis.eta_minutes
                )
            )

                ? Number(
                    analysis.eta_minutes
                )

                : null;


    const etaMethod =
        analysis.etaMethod ??
        analysis.eta_method ??
        null;


    const etaConfidence =
        analysis.etaConfidence ??
        analysis.eta_confidence ??
        null;


    const etaSource =
        analysis.etaSource ??
        analysis.eta_source ??
        null;


    const etaMessage =
        analysis.etaMessage ??
        analysis.eta_message ??
        null;


    const etaAnchorStation =
        analysis.etaAnchorStation ??
        analysis.eta_anchor_station ??
        null;


    const etaAnchorStationCode =
        analysis.etaAnchorStationCode ??
        analysis.eta_anchor_station_code ??
        null;


    const etaAnchorTime =
        analysis.etaAnchorTime ??
        analysis.eta_anchor_time ??
        null;


    // ========================================================
    // VALIDATION
    // ========================================================

    if (
        !trainNumber
    ) {

        console.log(
            "⚠️ Event recorder skipped: train number missing."
        );


        return null;
    }


    if (
        !crossingId
    ) {

        console.log(
            `⚠️ Event recorder skipped: crossing ID missing for train ${trainNumber}.`
        );


        return null;
    }


    if (
        !direction
    ) {

        console.log(
            `⚠️ Event recorder skipped: direction missing for ${trainNumber} at ${crossingName}.`
        );


        return null;
    }


    if (
        !trainPassageTime
    ) {

        console.log(
            `⚠️ Event recorder skipped: passage time missing for ${trainNumber} at ${crossingName}.`
        );


        return null;
    }


    // ========================================================
    // PASSAGE TIME VALIDATION
    // ========================================================

    const passageDate =
        new Date(
            trainPassageTime
        );


    const passageTimestamp =
        passageDate.getTime();


    if (
        !Number.isFinite(
            passageTimestamp
        )
    ) {

        console.log(
            `⚠️ Event recorder skipped: invalid passage time for ${trainNumber} at ${crossingName}.`
        );


        return null;
    }


    // ========================================================
    // DO NOT RECORD PAST PASSAGES
    // ========================================================

    if (
        passageTimestamp <
        Date.now()
    ) {

        console.log(
            `⚠️ Event recorder skipped: passage time already passed for ${trainNumber} at ${crossingName}.`
        );


        return null;
    }


    // ========================================================
    // PREDICT CLOSURE
    // ========================================================

    const closurePrediction =
        predictClosure({

            crossingId,

            crossingName,

            direction,

            trainPassageTime,

            speedKmph,

            delayMinutes
        });


    // ========================================================
    // EVENT GROUP
    // ========================================================

    const eventGroupId =
        createEventGroupId(
            trainNumber,
            crossingId
        );


    // ========================================================
    // READ EXISTING EVENTS
    // ========================================================

    const existingEvents =
        readEvents();


    const forecastVersion =
        getNextForecastVersion(
            existingEvents,
            eventGroupId
        );


    const eventId =
        createForecastEventId(
            eventGroupId,
            forecastVersion
        );


    // ========================================================
    // PREDICTED WINDOW
    // ========================================================

    const predictedCloseEarliest =
        closurePrediction
            .closure
            ?.earliest ??
        null;


    const predictedCloseLatest =
        closurePrediction
            .closure
            ?.latest ??
        null;


    const predictedOpenEarliest =
        closurePrediction
            .reopening
            ?.earliest ??
        null;


    const predictedOpenLatest =
        closurePrediction
            .reopening
            ?.latest ??
        null;


    // --------------------------------------------------------
    // Prediction midpoint
    //
    // The range is preserved.
    // Midpoint is used only as a numerical reference
    // for error calculation.
    // --------------------------------------------------------

    function midpoint(
        earliest,
        latest
    ) {

        if (
            !earliest ||
            !latest
        ) {

            return null;
        }


        const a =
            new Date(
                earliest
            ).getTime();


        const b =
            new Date(
                latest
            ).getTime();


        if (
            !Number.isFinite(a) ||
            !Number.isFinite(b)
        ) {

            return null;
        }


        return new Date(
            (
                a +
                b
            ) / 2
        ).toISOString();
    }


    const predictedGateCloseTime =
        midpoint(
            predictedCloseEarliest,
            predictedCloseLatest
        );


    const predictedGateOpenTime =
        midpoint(
            predictedOpenEarliest,
            predictedOpenLatest
        );


    // ========================================================
    // EVENT OBJECT
    // ========================================================

    const event = {

        // ----------------------------------------------------
        // Forecast identity
        // ----------------------------------------------------

        event_id:
            eventId,


        event_group_id:
            eventGroupId,


        forecast_version:
            forecastVersion,


        forecast_recorded_at:
            new Date().toISOString(),


        train_number:
            String(
                trainNumber
            ),


        train_name:
            trainName,


        crossing_id:
            crossingId,


        crossing_name:
            crossingName,


        direction:
            direction,


        // ----------------------------------------------------
        // Railway geometry / live state
        // ----------------------------------------------------

        train_position_km:
            trainPositionKm,


        crossing_position_km:
            crossingPositionKm,


        speed_kmh:
            speedKmh,


        // ----------------------------------------------------
        // Position quality
        // ----------------------------------------------------

        position_fresh:
            positionFresh,


        live_position_stale:
            livePositionStale,


        position_repeat_count:
            positionRepeatCount,


        // ----------------------------------------------------
        // Passage / ETA
        // ----------------------------------------------------

        estimated_passage_time:
            trainPassageTime,


        eta_minutes:
            etaMinutes,


        eta_method:
            etaMethod,


        eta_confidence:
            etaConfidence,


        eta_source:
            etaSource,


        eta_message:
            etaMessage,


        eta_anchor_station:
            etaAnchorStation,


        eta_anchor_station_code:
            etaAnchorStationCode,


        eta_anchor_time:
            etaAnchorTime,


        // ----------------------------------------------------
        // Predicted gate behaviour
        // ----------------------------------------------------

        predicted_gate_close_earliest:
            predictedCloseEarliest,


        predicted_gate_close_latest:
            predictedCloseLatest,


        predicted_gate_open_earliest:
            predictedOpenEarliest,


        predicted_gate_open_latest:
            predictedOpenLatest,


        // Numerical reference for evaluation.
        //
        // IMPORTANT:
        // The ranges above remain the actual forecast shown
        // to the user.
        //

        predicted_gate_close_time:
            predictedGateCloseTime,


        predicted_gate_open_time:
            predictedGateOpenTime,


        // ----------------------------------------------------
        // Prediction metadata
        // ----------------------------------------------------

        prediction_available:
            closurePrediction.ready === true,


        prediction_mode:
            closurePrediction.mode ??
            null,


        prediction_source:
            closurePrediction.source ??
            null,


        confidence:
            closurePrediction.confidence ??
            null,


        sample_count:
            closurePrediction.sampleCount ??
            0,


        recommendation:
            closurePrediction.recommendation ??
            null,


        predictor_message:
            closurePrediction.message ??
            null,


        forecast_timing_state:
            closurePrediction
                .forecastTiming
                ?.state ??
            null,


        late_detection:
            closurePrediction
                .forecastTiming
                ?.lateDetection ??
            false,


        late_by_minutes:
            closurePrediction
                .forecastTiming
                ?.lateByMinutes ??
            0,


        // ----------------------------------------------------
        // Actual gate observations
        // ----------------------------------------------------

        actual_gate_close_time:
            null,


        actual_gate_open_time:
            null,


        actual_status:
            null,


        gate_status_source:
            null,


        // ----------------------------------------------------
        // Evaluation lifecycle
        // ----------------------------------------------------

        prediction_result:
            "pending",


        matched:
            false,


        matched_event_id:
            null,


        matched_at:
            null
    };


    // ========================================================
    // SAVE
    // ========================================================

    return recordEvent(
        event
    );
}


// ============================================================
// RECORD ALL CROSSING EVENTS FOR ONE TRAIN ANALYSIS
// ============================================================

function recordTrainCrossingEvents(
    analysisResult
) {

    if (
        !analysisResult
    ) {

        console.log(
            "⚠️ Event recorder skipped: analysis missing."
        );


        return [];
    }


    const trainNumber =
        analysisResult.trainNumber ??
        analysisResult.train_number ??
        null;


    const trainName =
        analysisResult.trainName ??
        analysisResult.train_name ??
        "Unknown Train";


    const direction =
        analysisResult.direction ??
        null;


    const trainPositionKm =
        analysisResult.trainPositionKm ??
        analysisResult.train_position_km ??
        null;


    const speedKmh =
        analysisResult.speedKmh ??
        analysisResult.speed_kmh ??
        null;


    const livePositionStale =
        analysisResult.livePositionStale === true ||
        analysisResult.live_position_stale === true ||
        analysisResult.positionFresh === false ||
        analysisResult.position_fresh === false;


    const positionFresh =
        !livePositionStale;


    const positionRepeatCount =
        analysisResult.positionRepeatCount ??
        analysisResult.position_repeat_count ??
        0;


   // ========================================================
// CROSSING FORECAST INPUT
// ========================================================
//
// `crossings` contains all approaching crossings with
// valid ETAs, regardless of the 60-minute horizon.
//
// `nextExpectedCrossing` is the earliest reliable event.
//
// The recorder should therefore NEVER depend on the
// 60-minute `nextCrossing` field.
//
// ========================================================

const allCrossings =
    Array.isArray(
        analysisResult.crossings
    )
        ? analysisResult.crossings
        : [];


// --------------------------------------------------------
// Keep only approaching crossings with valid ETA.
// --------------------------------------------------------

let crossings =
    allCrossings.filter(
        crossing => {

            if (
                !crossing
            ) {

                return false;
            }


            const distance =
                Number(
                    crossing.distanceKm ??
                    crossing.distance ??
                    crossing.distanceFromTrainKm ??
                    crossing.distance_from_train_km
                );


            const eta =
                Number(
                    crossing.etaMinutes ??
                    crossing.eta_minutes
                );


            return (
                Number.isFinite(
                    distance
                ) &&
                distance > 0 &&
                Number.isFinite(
                    eta
                ) &&
                eta >= 0
            );
        }
    );


// --------------------------------------------------------
// SAFETY FALLBACK:
//
// If `crossings` is unexpectedly empty but the monitor
// supplied `nextExpectedCrossing`, record that event.
//
// This prevents the long-range forecast from disappearing
// simply because another layer still supplies only the
// singular next-event field.
// --------------------------------------------------------

if (
    crossings.length === 0 &&
    analysisResult.nextExpectedCrossing
) {

    const nextExpected =
        analysisResult.nextExpectedCrossing;


    const distance =
        Number(
            nextExpected.distanceKm ??
            nextExpected.distance ??
            nextExpected.distanceFromTrainKm ??
            nextExpected.distance_from_train_km
        );


    const eta =
        Number(
            nextExpected.etaMinutes ??
            nextExpected.eta_minutes
        );


    if (
        Number.isFinite(distance) &&
        distance > 0 &&
        Number.isFinite(eta) &&
        eta >= 0
    ) {

        crossings = [
            nextExpected
        ];
    }
}

    if (
        crossings.length === 0
    ) {

        return [];
    }


    if (
        !trainNumber
    ) {

        console.log(
            "⚠️ Event recorder skipped: train number missing."
        );


        return [];
    }


    if (
        !direction
    ) {

        console.log(
            `⚠️ Event recorder skipped: direction missing for train ${trainNumber}.`
        );


        return [];
    }


    const savedEvents =
        [];


    for (
        const crossing of crossings
    ) {

        if (
            !crossing
        ) {

            continue;
        }


        const combinedAnalysis = {

            ...crossing,


            trainNumber,

            trainName,

            direction,


            trainPositionKm,

            speedKmh,


            livePositionStale,

            positionFresh,

            positionRepeatCount,


            estimatedPassageTime:
                crossing.estimatedPassageTime ??
                crossing.estimated_passage_time ??
                crossing.passageTime ??
                crossing.passage_time ??
                null,


            etaMinutes:
                crossing.etaMinutes ??
                crossing.eta_minutes ??
                null,


            crossingId:
                crossing.crossingId ??
                crossing.crossing_id ??
                crossing.id ??
                null,


            crossingName:
                crossing.crossingName ??
                crossing.crossing_name ??
                crossing.name ??
                null,


            crossingPositionKm:
                crossing.crossingPositionKm ??
                crossing.crossing_position_km ??
                crossing.railwayPositionKm ??
                crossing.routeDistanceKm ??
                crossing.railwayDistanceKm ??
                null,


            etaMethod:
                crossing.etaMethod ??
                crossing.eta_method ??
                null,


            etaConfidence:
                crossing.etaConfidence ??
                crossing.eta_confidence ??
                null,


            etaSource:
                crossing.etaSource ??
                crossing.eta_source ??
                null,


            etaMessage:
                crossing.etaMessage ??
                crossing.eta_message ??
                null,


            etaAnchorStation:
                crossing.etaAnchorStation ??
                crossing.eta_anchor_station ??
                null,


            etaAnchorStationCode:
                crossing.etaAnchorStationCode ??
                crossing.eta_anchor_station_code ??
                null,


            etaAnchorTime:
                crossing.etaAnchorTime ??
                crossing.eta_anchor_time ??
                null
        };


        console.log(
            `\n   📍 Recording crossing: ${
                combinedAnalysis.crossingName ??
                "Unknown crossing"
            }`
        );


        console.log(
            `      ID: ${
                combinedAnalysis.crossingId ??
                "missing"
            }`
        );


        console.log(
            `      Train: ${
                trainNumber
            }`
        );


        console.log(
            `      Direction: ${
                direction
            }`
        );


        console.log(
            `      Position quality: ${
                livePositionStale
                    ? "STALE"
                    : "FRESH"
            }`
        );


        console.log(
            `      ETA method: ${
                combinedAnalysis.etaMethod ??
                "unknown"
            }`
        );


        console.log(
            `      Passage: ${
                combinedAnalysis.estimatedPassageTime ??
                "missing"
            }`
        );


        const result =
            recordAnalysisResult(
                combinedAnalysis
            );


        if (
            result
        ) {

            savedEvents.push(
                result
            );
        }
    }


    return savedEvents;
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

    recordEvent,

    recordAnalysisResult,

    recordTrainCrossingEvents,

    readEvents

};