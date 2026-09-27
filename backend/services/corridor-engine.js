const {
    getStationLive
} = require("./railradar");

const {
    TIMING_CONFIG
} = require("../config/corridor");

const {
    analyzeTrain
} = require("./corridor-monitor");

const {
    recordAnalysisResult
} = require("./event-recorder");

const {
    buildUnifiedSnapshot,
    saveSnapshot
} = require("./forecast-snapshot");



// ============================================================
// CONFIGURATION
// ============================================================

const REFERENCE_STATION = "JNL";
const STATION_CODE = "JNL";

const DISCOVERY_HOURS = 8;

// Trains arriving within this window are considered close.
const UPCOMING_WINDOW_MINUTES = 20;

// Recently departed station window.
const RECENT_DEPARTURE_WINDOW_MINUTES = 20;

// Broader window for scheduled/arrival candidates (up to 120 min for extended outlook).
const ARRIVAL_WINDOW_MINUTES = 120;
const PRIMARY_FORECAST_WINDOW_MINUTES = 60;

// Never process too many trains in one cycle.
// This protects the RailRadar quota.
const MAX_TRAINS_PER_CYCLE = 3;

// Delay between train analysis requests.
const DELAY_BETWEEN_TRAINS_MS = 2000;

// Backward-compatible names used internally.
const TRAIN_PROCESS_DELAY_MS = DELAY_BETWEEN_TRAINS_MS;

// Continuous polling interval.
const POLL_INTERVAL_MS = 2 * 60 * 1000;


// ============================================================
// TIMELINE VALIDATION
// ============================================================

const MIN_PASSAGE_INCREMENT_MINUTES = 0;

const PASSAGE_TIME_TOLERANCE_SECONDS = 30;


// ============================================================
// V1 CROSSINGS — EXACTLY FOUR
// ============================================================

const V1_CROSSING_IDS = {
    jandiala: "jandiala",
    rakh: "rakh-devi-dasspura",
    manawala: "manawala-road",
    talwandi: "talwandi-dogran"
};

const V1_CROSSING_ID_SET =
    new Set(Object.values(V1_CROSSING_IDS));


// ============================================================
// CROSSING DISPLAY ORDER
// ============================================================
//
// Physical corridor order toward JNL:
//
// FORWARD:
// Jandiala → Rakh → Manawala → Talwandi
//
// BACKWARD:
// Talwandi → Manawala → Rakh → Jandiala
//
// Railway-position sorting remains the source of truth.
// These arrays are useful as a deterministic fallback.
//

const FORWARD_CROSSING_ORDER = [
    V1_CROSSING_IDS.talwandi,
    V1_CROSSING_IDS.manawala,
    V1_CROSSING_IDS.rakh,
    V1_CROSSING_IDS.jandiala
];

const BACKWARD_CROSSING_ORDER = [
    V1_CROSSING_IDS.jandiala,
    V1_CROSSING_IDS.rakh,
    V1_CROSSING_IDS.manawala,
    V1_CROSSING_IDS.talwandi
];



// ============================================================
// IN-MEMORY POSITION HISTORY
// ============================================================
//
// Used only to detect repeated/stale positions during the
// current backend process.
//
// It is NOT ground truth.
// It does NOT block otherwise valid future forecasts.
//

const positionHistory = new Map();

// ============================================================
// STABLE TRAIN FOCUS / EVENT QUEUE
// ============================================================
//
// Keeps one stable primary train event between polling cycles.
//
// The system can see multiple trains at once, but the primary
// focus should not randomly jump between them on every refresh.
//
// Focus identity:
//     trainNumber + direction + crossingId
//
// A new event only takes focus when:
// 1. There is no current focus.
// 2. The current focus has passed/disappeared.
// 3. Another event is substantially earlier.
//
// ============================================================

const FOCUS_SWITCH_ADVANTAGE_MINUTES = 5;

const FOCUS_EXPIRY_TOLERANCE_MS =
    30 * 1000;

let activeFocus = null;

// ============================================================
// IN-FLIGHT CORRIDOR TRAIN REGISTRY
// ============================================================
//
// Tracks trains actively approaching or traversing the V1 corridor.
// Guarantees in-flight trains are prioritized in discovery and
// NEVER dropped from forecast snapshots due to discovery slicing
// or temporary transient API rate-limits.
//
const activeCorridorRegistry = new Map();
// ============================================================
// BASIC HELPERS
// ============================================================

function sleep(milliseconds) {
    return new Promise(resolve =>
        setTimeout(resolve, milliseconds)
    );
}


// ------------------------------------------------------------
// Parse date safely
// ------------------------------------------------------------

function parseDate(value) {

    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    if (value instanceof Date) {
        return Number.isNaN(value.getTime())
            ? null
            : value;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date;
}


// ------------------------------------------------------------
// Numeric date parser
//
// This is the helper that was missing in V7.
// ------------------------------------------------------------

function parseDateMs(value) {

    const date = parseDate(value);

    return date
        ? date.getTime()
        : null;
}


// ------------------------------------------------------------
// Numeric helper
// ------------------------------------------------------------

function toFiniteNumber(value) {

    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : null;
}


// ------------------------------------------------------------
// First usable value
// ------------------------------------------------------------

function firstDefined(...values) {

    for (const value of values) {

        if (
            value !== undefined &&
            value !== null &&
            value !== ""
        ) {
            return value;
        }
    }

    return null;
}

// ============================================================
// TRAIN EVENT IDENTITY / TIMING HELPERS
// ============================================================

function buildEventIdentity(event = {}) {

    return [
        String(event.trainNumber || ""),
        normalizeDirection(event.direction) || "unknown",
        String(event.crossingId || "")
    ].join(":");
}


function getEventPassageMs(event = {}) {

    const value =
        firstDefined(
            event.estimatedPassageTime,
            event.passageTime,
            event.expectedPassageTime
        );

    return parseDateMs(value);
}


function getEventEtaMinutes(event = {}) {

    const passageMs =
        getEventPassageMs(event);

    if (!Number.isFinite(passageMs)) {
        return null;
    }

    return Math.max(
        0,
        (passageMs - Date.now()) / 60000
    );
}
// ------------------------------------------------------------
// Safe ISO conversion
// ------------------------------------------------------------

function toISOStringSafe(value) {

    const date = parseDate(value);

    return date
        ? date.toISOString()
        : null;
}


// ============================================================
// ANALYSIS SPEED
// ============================================================

function getAnalysisSpeedKmh(analysis = {}) {

    return toFiniteNumber(
        firstDefined(

            analysis?.speedKmph,

            analysis?.speedKmh,

            analysis?.speed,

            analysis?.currentSpeedKmph,

            analysis?.currentSpeedKmh,

            analysis?.liveSpeedKmph,

            analysis?.liveSpeedKmh,

            analysis?.live?.speedKmph,

            analysis?.live?.speedKmh,

            analysis?.live?.speed,

            analysis?.live?.currentSpeedKmph,

            analysis?.currentLocation?.speedKmph,

            analysis?.currentLocation?.speedKmh,

            analysis?.currentLocation?.speed
        )
    );
}


// ============================================================
// ANALYSIS POSITION
// ============================================================

function getAnalysisPositionKm(analysis = {}) {

    return toFiniteNumber(
        firstDefined(

            analysis?.trainPositionKm,

            analysis?.positionKm,

            analysis?.currentPositionKm,

            analysis?.railwayPositionKm,

            analysis?.currentRailwayPositionKm,

            analysis?.routePositionKm,

            analysis?.railway_position_km,

            analysis?.live?.trainPositionKm,

            analysis?.live?.positionKm,

            analysis?.live?.railwayPositionKm,

            analysis?.currentLocation?.positionKm,

            analysis?.currentLocation?.railwayPositionKm
        )
    );
}


// ============================================================
// DIRECTION NORMALIZATION
// ============================================================

function normalizeDirection(value) {

    if (!value) {
        return null;
    }

    const direction =
        String(value)
            .trim()
            .toLowerCase();

    if (
        direction === "forward" ||
        direction === "fwd" ||
        direction === "up" ||
        direction.includes("forward")
    ) {
        return "forward";
    }

    if (
        direction === "backward" ||
        direction === "back" ||
        direction === "reverse" ||
        direction === "rev" ||
        direction === "down" ||
        direction.includes("backward") ||
        direction.includes("reverse")
    ) {
        return "backward";
    }

    return null;
}


function getAnalysisDirection(analysis = {}) {

    const candidates = [

        analysis?.direction,

        analysis?.directionUsed,

        analysis?.forecastDirection,

        analysis?.movementDirection,

        analysis?.observedDirection,

        analysis?.inferredDirection,

        analysis?.trainDirection,

        analysis?.travelDirection,

        analysis?.directionSource?.direction,

        analysis?.live?.direction,

        analysis?.live?.movementDirection
    ];

    for (const value of candidates) {

        const direction =
            normalizeDirection(value);

        if (direction) {
            return direction;
        }
    }

    return null;
}


// ============================================================
// TRAIN HELPERS
// ============================================================

function getTrainNumber(train = {}) {

    return firstDefined(

        train?.trainNumber,

        train?.number,

        train?.trainNo,

        train?.train_number,

        train?.live?.trainNumber,

        train?.live?.number,

        train?.train?.number,

        train?.train?.trainNumber,

        train?.id,

        null
    );
}


function getTrainName(train = {}) {

    return firstDefined(

        train?.trainName,

        train?.name,

        train?.train_name,

        train?.live?.trainName,

        train?.live?.name,

        train?.train?.name,

        train?.train?.trainName,

        null
    );
}


function getLiveType(train = {}) {

    return String(

        firstDefined(

            train?.live?.type,

            train?.live?.status,

            train?.type,

            train?.status,

            train?.state,

            ""

        )

    ).trim().toLowerCase();
}


function getDelayMinutes(train = {}) {

    const values = [

        train?.delayMinutes,

        train?.delay_minutes,

        train?.delay,

        train?.live?.delayMinutes,

        train?.live?.delay_minutes,

        train?.live?.delay,

        train?.train?.delayMinutes,

        train?.currentLocation?.delayMinutes,

        train?.live?.currentLocation?.delayMinutes,

        train?.route?.[0]?.delayMinutes,

        train?.route?.[0]?.delayDeparture,

        train?.route?.[0]?.delayArrival,

        train?.live?.route?.[0]?.delayMinutes,

        train?.live?.route?.[0]?.delayDeparture,

        train?.live?.route?.[0]?.delayArrival,

        train?.stop?.delayMinutes

    ];

    for (const value of values) {

        const number =
            Number(value);

        if (Number.isFinite(number)) {
            return number;
        }
    }

    return null;
}


function getArrivalTime(train = {}) {

    const explicit = firstDefined(

        train?.expectedArrivalTime,

        train?.estimatedArrivalTime,

        train?.expected_arrival_time,

        train?.estimated_arrival_time,

        train?.live?.expectedArrivalTime,

        train?.live?.estimatedArrivalTime,

        train?.expectedAt,

        train?.expected_at

    );

    if (explicit) {
        return explicit;
    }

    const scheduled = firstDefined(

        train?.arrivalTime,

        train?.arrival_time,

        train?.scheduledArrival,

        train?.scheduled_arrival,

        train?.live?.arrivalTime,

        train?.live?.scheduledArrival,

        train?.eta

    );

    const delay = getDelayMinutes(train);

    if (scheduled && delay != null && delay !== 0) {
        const scheduledMs = parseDateMs(scheduled);
        if (Number.isFinite(scheduledMs)) {
            return new Date(scheduledMs + delay * 60000).toISOString();
        }
    }

    return scheduled;
}


function getDepartureTime(train = {}) {

    const explicit = firstDefined(

        train?.expectedDepartureTime,

        train?.estimatedDepartureTime,

        train?.expected_departure_time,

        train?.estimated_departure_time,

        train?.live?.expectedDepartureTime,

        train?.live?.estimatedDepartureTime,

        train?.expectedDepartureAt,

        train?.expected_departure_at

    );

    if (explicit) {
        return explicit;
    }

    const scheduled = firstDefined(

        train?.departureTime,

        train?.departure_time,

        train?.scheduledDeparture,

        train?.scheduled_departure,

        train?.live?.departureTime,

        train?.live?.scheduledDeparture,

        train?.etd

    );

    const delay = getDelayMinutes(train);

    if (scheduled && delay != null && delay !== 0) {
        const scheduledMs = parseDateMs(scheduled);
        if (Number.isFinite(scheduledMs)) {
            return new Date(scheduledMs + delay * 60000).toISOString();
        }
    }

    return scheduled;
}


function getCurrentStation(train = {}) {

    return firstDefined(

        train?.currentStation,

        train?.current_station,

        train?.station,

        train?.stationName,

        train?.station_name,

        train?.live?.currentStation,

        train?.live?.station,

        train?.live?.stationName,

        train?.live?.station_name,

        train?.currentLocation?.station,

        null
    );
}


function getStationCode(train = {}) {

    return String(

        firstDefined(

            train?.stationCode,

            train?.station_code,

            train?.currentStationCode,

            train?.current_station_code,

            train?.live?.stationCode,

            train?.live?.station_code,

            train?.live?.currentStationCode,

            ""

        )

    ).trim().toUpperCase();
}


// ============================================================
// TRAIN CLASSIFICATION
// ============================================================

function classifyTrain(train = {}) {

    const liveType =
        getLiveType(train);

    const now =
        Date.now();

    const arrival =
        parseDate(
            getArrivalTime(train)
        );

    const departure =
        parseDate(
            getDepartureTime(train)
        );

    // --------------------------------------------------------
    // Explicit RailRadar live types
    // --------------------------------------------------------

    if (
        liveType === "upcoming"
    ) {
        return "upcoming";
    }

    if (
        liveType === "at-station" ||
        liveType === "at_station" ||
        liveType === "at station"
    ) {
        return "at-station";
    }

    if (
        liveType === "recent-departure" ||
        liveType === "recent_departure"
    ) {
        return "recent-departure";
    }

    if (
        liveType === "departed"
    ) {

        if (departure) {

            const minutesAgo =
                (
                    now -
                    departure.getTime()
                ) / 60000;

            if (
                minutesAgo >= 0 &&
                minutesAgo <=
                RECENT_DEPARTURE_WINDOW_MINUTES
            ) {
                return "recent-departure";
            }
        }

        return "departed";
    }

    if (
        liveType === "scheduled"
    ) {
        return "scheduled";
    }

    // --------------------------------------------------------
    // Infer from station + arrival/departure
    // --------------------------------------------------------

    const stationCode =
        getStationCode(train);

    const currentStation =
        String(
            getCurrentStation(train) || ""
        ).toUpperCase();

    if (
        stationCode === STATION_CODE ||
        currentStation === "JANDIALA" ||
        currentStation.includes("JANDIALA")
    ) {

        // If a departure exists in the future or is very recent,
        // the train is still station-relevant.
        if (!departure || departure.getTime() >= now) {
            return "at-station";
        }

        const minutesAgo =
            (now - departure.getTime()) / 60000;

        if (
            minutesAgo >= 0 &&
            minutesAgo <=
            RECENT_DEPARTURE_WINDOW_MINUTES
        ) {
            return "recent-departure";
        }
    }

    // --------------------------------------------------------
    // Arrival within immediate window
    // --------------------------------------------------------

    if (arrival) {

        const minutesUntilArrival =
            (
                arrival.getTime() -
                now
            ) / 60000;

        if (
            minutesUntilArrival >= 0 &&
            minutesUntilArrival <=
            UPCOMING_WINDOW_MINUTES
        ) {
            return "upcoming";
        }

        if (
            minutesUntilArrival >
            UPCOMING_WINDOW_MINUTES &&
            minutesUntilArrival <=
            ARRIVAL_WINDOW_MINUTES
        ) {
            return "arrival-window";
        }

        if (
            minutesUntilArrival >
            ARRIVAL_WINDOW_MINUTES
        ) {
            return "scheduled";
        }
    }

    // --------------------------------------------------------
    // Status fallback
    // --------------------------------------------------------

    if (
        liveType.includes("approach") ||
        liveType.includes("arriv") ||
        liveType.includes("running") ||
        liveType.includes("enroute") ||
        liveType.includes("en-route")
    ) {
        return "upcoming";
    }

    return "unknown";
}


function classifyTrainForCorridor(train = {}) {

    return classifyTrain(train);
}


function shouldProcessTrain(train) {

    return [

        "upcoming",

        "at-station",

        "recent-departure",

        "scheduled",

        "arrival-window"

    ].includes(
        classifyTrain(train)
    );
}


function getPriorityScore(train) {

    switch (
        classifyTrain(train)
    ) {

        case "at-station":
            return 1;

        case "recent-departure":
            return 2;

        case "upcoming":
            return 3;

        case "arrival-window":
            return 4;

        case "scheduled":
            return 5;

        default:
            return 99;
    }
}


function getEarliestBoardTime(train) {

    const arrivalMs =
        parseDateMs(
            getArrivalTime(train)
        );

    const departureMs =
        parseDateMs(
            getDepartureTime(train)
        );

    const times = [

        arrivalMs,

        departureMs

    ].filter(
        Number.isFinite
    );

    if (!times.length) {
        return Number.MAX_SAFE_INTEGER;
    }

    return Math.min(
        ...times
    );
}


// ============================================================
// DISCOVER TRAINS — PRIMARY DISCOVERY FUNCTION
// ============================================================

async function discoverTrains() {

    console.log("");

    console.log(
        `📡 Fetching live trains at ${REFERENCE_STATION}...`
    );

    const board =
        await getStationLive(

            REFERENCE_STATION,

            {
                hours:
                    DISCOVERY_HOURS,

                includeIntermediate:
                    true
            }
        );

    if (!board) {

        throw new Error(
            "JNL live board unavailable."
        );
    }

    let trains = [];

    // --------------------------------------------------------
    // Support all known response shapes
    // --------------------------------------------------------

    const possibleCollections = [

        board,

        board.trains,

        board.data,

        board.results,

        board.data?.trains,

        board.result?.trains,

        board.station?.trains,

        board.live?.trains,

        board.board?.trains,

        board.data?.board?.trains,

        board.result?.data,

        board.data?.results

    ];

    for (
        const collection of possibleCollections
    ) {

        if (
            Array.isArray(collection)
        ) {
            trains.push(
                ...collection
            );
        }
    }

    // --------------------------------------------------------
    // Remove invalid records
    // --------------------------------------------------------

    trains =
        trains.filter(
            train =>
                Boolean(
                    getTrainNumber(train)
                )
        );

    // --------------------------------------------------------
    // Deduplicate by train number
    // --------------------------------------------------------

    const seen =
        new Set();

    trains =
        trains.filter(
            train => {

                const number =
                    String(
                        getTrainNumber(train)
                    ).trim();

                if (
                    seen.has(number)
                ) {
                    return false;
                }

                seen.add(number);

                return true;
            }
        );

    // --------------------------------------------------------
    // Keep relevant trains
    // --------------------------------------------------------

    trains =
        trains.filter(
            shouldProcessTrain
        );

    // --------------------------------------------------------
    // Stable priority
    // --------------------------------------------------------

    trains.sort(
        (a, b) => {

            const priorityDifference =
                getPriorityScore(a) -
                getPriorityScore(b);

            if (
                priorityDifference !== 0
            ) {
                return priorityDifference;
            }

            return (
                getEarliestBoardTime(a) -
                getEarliestBoardTime(b)
            );
        }
    );

    // --------------------------------------------------------
    // Protect API quota
    // --------------------------------------------------------

    trains =
        trains.slice(
            0,
            MAX_TRAINS_PER_CYCLE
        );

    console.log(
        `📋 Relevant trains this cycle: ${trains.length}`
    );

    trains.forEach(
        (train, index) => {

            console.log(

                `   ${index + 1}. ${
                    getTrainNumber(train)
                } — ${
                    getTrainName(train) ||
                    "Unknown train"
                } — ${
                    classifyTrain(train)
                }`

            );
        }
    );

    return trains;
}


// ============================================================
// DISCOVER RELEVANT TRAINS
// ============================================================
//
// Kept as a separate function because older versions of the
// engine used discoverRelevantTrains(stationData).
//
// ============================================================

function discoverRelevantTrains(stationData) {

    if (
        !stationData ||
        typeof stationData !== "object"
    ) {
        return [];
    }

    let trains = [];

    const possibleCollections = [

        stationData,

        stationData.trains,

        stationData.data,

        stationData.results,

        stationData.data?.trains,

        stationData.result?.trains,

        stationData.station?.trains,

        stationData.live?.trains,

        stationData.board?.trains,

        stationData.data?.board?.trains,

        stationData.result?.data,

        stationData.data?.results

    ];

    for (
        const collection of possibleCollections
    ) {

        if (
            Array.isArray(collection)
        ) {
            trains.push(
                ...collection
            );
        }
    }

    // --------------------------------------------------------
    // Deduplicate
    // --------------------------------------------------------

    const unique =
        new Map();

    for (
        const train of trains
    ) {

        if (
            !train ||
            typeof train !== "object"
        ) {
            continue;
        }

        const number =
            String(
                getTrainNumber(train) || ""
            ).trim();

        if (!number) {
            continue;
        }

        if (
            !unique.has(number)
        ) {
            unique.set(
                number,
                train
            );
        }
    }

    const result =
        Array.from(
            unique.values()
        );

    // --------------------------------------------------------
    // Filter + enrich
    // --------------------------------------------------------

    const relevant = [];

    for (
        const train of result
    ) {

        const number =
            String(
                getTrainNumber(train)
            ).trim();

        if (!number) {
            continue;
        }

        const classification =
            classifyTrain(train);

        if (
            ![
                "at-station",
                "upcoming",
                "recent-departure",
                "scheduled",
                "arrival-window"
            ].includes(
                classification
            )
        ) {
            continue;
        }

        relevant.push({

            ...train,

            trainNumber:
                number,

            trainName:
                getTrainName(train) || "",

            classification

        });
    }

    // --------------------------------------------------------
    // Stable sorting
    // --------------------------------------------------------

    // --------------------------------------------------------
// Urgency-based sorting
// --------------------------------------------------------
//
// Prioritize trains that can affect the V1 corridor soon.
// Do not let a distant scheduled train occupy one of the
// five live-analysis slots just because of its classification.
// --------------------------------------------------------

const now =
    Date.now();

const forecastLimitMs =
    now +
    ARRIVAL_WINDOW_MINUTES *
    60 *
    1000;

relevant.sort(
    (a, b) => {

        const getNextRelevantTime =
            (train) => {

                const classification =
                    train.classification;

                const arrivalMs =
                    parseDateMs(
                        getArrivalTime(train)
                    );

                const departureMs =
                    parseDateMs(
                        getDepartureTime(train)
                    );

                // A train currently at JNL matters when it
                // departs JNL toward the corridor.
                if (
                    classification ===
                    "at-station"
                ) {

                    if (
                        Number.isFinite(
                            departureMs
                        )
                    ) {
                        return departureMs;
                    }

                    return now;
                }

                // A recently departed train is already moving.
                if (
                    classification ===
                    "recent-departure"
                ) {

                    return now;
                }

                // For approaching/scheduled trains, use the
                // earliest known future board time.
                const futureTimes = [
                    arrivalMs,
                    departureMs
                ].filter(
                    time =>
                        Number.isFinite(time) &&
                        time >= now
                );

                if (
                    futureTimes.length
                ) {

                    return Math.min(
                        ...futureTimes
                    );
                }

                return Number.MAX_SAFE_INTEGER;
            };

        const aTime =
            getNextRelevantTime(a);

        const bTime =
            getNextRelevantTime(b);

        // First: trains inside the 60-minute forecast window.
        const aInside =
            aTime <=
            forecastLimitMs;

        const bInside =
            bTime <=
            forecastLimitMs;

        if (
            aInside !==
            bInside
        ) {

            return aInside
                ? -1
                : 1;
        }

        // Second: earliest relevant train first.
        if (
            aTime !==
            bTime
        ) {

            return (
                aTime -
                bTime
            );
        }

        // Final deterministic tie-breaker.
        return (
            String(a.trainNumber)
                .localeCompare(
                    String(b.trainNumber)
                )
        );
    }
);

    return relevant.slice(
        0,
        MAX_TRAINS_PER_CYCLE
    );
}


// ============================================================
// CROSSING NAME → V1 ID
// ============================================================

function inferCrossingIdFromName(name) {

    if (!name) {
        return null;
    }

    const normalized =
        String(name)
            .trim()
            .toLowerCase();

    // Jandiala
    if (
        normalized.includes("jandiala")
    ) {
        return V1_CROSSING_IDS.jandiala;
    }

    // Rakh Devi Dasspura
    if (
        normalized.includes("rakh") &&
        (
            normalized.includes("dass") ||
            normalized.includes("devi")
        )
    ) {
        return V1_CROSSING_IDS.rakh;
    }

    // Manawala
    if (
        normalized.includes("manawala")
    ) {
        return V1_CROSSING_IDS.manawala;
    }

    // Talwandi Dogran
    if (
        normalized.includes("talwandi") &&
        (
            normalized.includes("dogran") ||
            normalized.includes("dogra")
        )
    ) {
        return V1_CROSSING_IDS.talwandi;
    }

    return null;
}


// ============================================================
// CROSSING COORDINATE → V1 ID FALLBACK
// ============================================================

function inferCrossingIdFromCoordinates(
    latitude,
    longitude
) {

    const lat =
        toFiniteNumber(latitude);

    const lng =
        toFiniteNumber(longitude);

    if (
        lat === null ||
        lng === null
    ) {
        return null;
    }
    const known = [

        {
            id:
                V1_CROSSING_IDS.rakh,

            lat:
                31.595879,

            lng:
                75.031856
        },

        {
            id:
                V1_CROSSING_IDS.jandiala,

            lat:
                31.590162,

            lng:
                75.053973
        },

        {
            id:
                V1_CROSSING_IDS.manawala,

            lat:
                31.599745,

            lng:
                75.017127
        },

        {
            id:
                V1_CROSSING_IDS.talwandi,

            lat:
                31.605083,

            lng:
                74.996645
        }

    ];

    let nearest =
        null;

    let nearestDistance =
        Infinity;

    for (
        const item of known
    ) {

        const dLat =
            lat -
            item.lat;

        const dLng =
            lng -
            item.lng;

        const distance =
            Math.sqrt(
                dLat * dLat +
                dLng * dLng
            );

        if (
            distance <
            nearestDistance
        ) {

            nearestDistance =
                distance;

            nearest =
                item;
        }
    }

    // Roughly <= 150 metres.
    // Used only as a fallback when API gives coordinates.
    if (
        nearest &&
        nearestDistance <= 0.0015
    ) {
        return nearest.id;
    }

    return null;
}


// ============================================================
// DERIVE PASSAGE FROM DISTANCE + SPEED
// ============================================================
//
// ETA minutes = distance / speed × 60
//
// This is a calculated live-speed estimate.
// It is NOT a claimed railway timetable timestamp.
//
// ============================================================

function derivePassageFromDistance(
    crossing,
    analysis = {}
) {

    if (
        !crossing ||
        !analysis
    ) {
        return null;
    }

    const distanceKm =
        toFiniteNumber(
            firstDefined(

                crossing.distanceKm,

                crossing.distance,

                crossing.distanceFromTrainKm,

                crossing.distance_from_train_km,

                crossing.distanceAheadKm,

                crossing.distance_ahead_km,

                crossing.distanceAhead,

                crossing.distance_ahead,

                crossing.remainingDistanceKm,

                crossing.remaining_distance_km,

                crossing.remainingKm,

                crossing.remaining_km,

                crossing.distanceToCrossingKm,

                crossing.distance_to_crossing_km,

                crossing.distanceToGateKm,

                crossing.distance_to_gate_km,

                crossing.source?.distanceAheadKm,

                crossing.source?.distance_ahead_km,

                crossing.source?.distanceKm,

                crossing.source?.distance_km
            )
        );

    const speedKmh =
        getAnalysisSpeedKmh(
            analysis
        );

        // --------------------------------------------------------
// NOT-STARTED TRAIN SAFETY
// --------------------------------------------------------
//
// A train that has not started should NOT use the live
// route speed as if it is already travelling.
//
// If a future scheduled departure is available, use it
// as the anchor. Otherwise no ETA is generated.
// --------------------------------------------------------

const trainStatus = String(
    firstDefined(
        analysis.trainStatus,
        analysis.status,
        analysis.trainState,
        analysis.live?.status,
        ""
    )
).toLowerCase();

const isNotStarted =
    trainStatus.includes("not-started") ||
    trainStatus.includes("not started") ||
    trainStatus.includes("scheduled") ||
    trainStatus.includes("not_started") ||
    analysis.trainNotStarted === true ||
    analysis.hasDeparted === false ||
    analysis.live?.hasDeparted === false;

if (isNotStarted) {

    const delayMinutes = getDelayMinutes(analysis) || 0;

    const explicitDepartureRaw =
        firstDefined(
            analysis.expectedDepartureTime,
            analysis.expected_departure_time,
            analysis.live?.expectedDepartureTime,
            analysis.live?.expected_departure_time,
            analysis.stop?.expectedDepartureTime,
            analysis.stop?.expected_departure_time
        );

    const departureRaw =
        explicitDepartureRaw ||
        firstDefined(
            analysis.departureTime,
            analysis.departure_time,
            analysis.scheduledDepartureTime,
            analysis.scheduled_departure_time,
            analysis.live?.departureTime,
            analysis.live?.departure_time,
            analysis.stop?.departureTime,
            analysis.stop?.departure_time
        );

    const rawMs =
        parseDateMs(
            departureRaw
        );

    if (
        !Number.isFinite(
            rawMs
        )
    ) {

        console.log(
            `   ⏭️ Not-started train ${
                analysis.trainNumber ||
                ""
            }: no valid departure anchor timestamp`
        );

        return null;
    }

    let delayedDepartureMs = rawMs;
    if (!explicitDepartureRaw && Number.isFinite(delayMinutes) && delayMinutes !== 0) {
        delayedDepartureMs += delayMinutes * 60000;
    }

    const departureMs = Math.max(Date.now(), delayedDepartureMs);

    if (
        distanceKm === null ||
        distanceKm < 0 ||
        speedKmh === null ||
        speedKmh <= 0
    ) {

        return null;
    }

    const travelMinutes =
        (
            distanceKm /
            speedKmh
        ) * 60;

    const passage =
        new Date(
            departureMs +
            travelMinutes * 60000
        );

    const etaMinutes =
        (
            passage.getTime() -
            Date.now()
        ) / 60000;

    if (
        !Number.isFinite(
            etaMinutes
        ) ||
        etaMinutes < 0
    ) {

        return null;
    }

    const scheduledPassageMs = rawMs + (travelMinutes * 60000);
    const scheduledPassageTime = new Date(scheduledPassageMs).toISOString();
    const diffMinutes = (passage.getTime() - scheduledPassageMs) / 60000;
    let earlyLateStatus = "ON_TIME";
    if (diffMinutes < -1.5) earlyLateStatus = "EARLY";
    else if (diffMinutes > 1.5) earlyLateStatus = "DELAYED";

    return {

        etaMinutes,

        estimatedPassageTime:
            passage.toISOString(),

        scheduledPassageTime,

        earlyLateStatus,

        earlyLateMinutes:
            Math.round(diffMinutes * 10) / 10,

        distanceKm,

        speedKmh,

        method:
            "scheduled-departure-plus-live-speed"

    };
}

    if (
        distanceKm === null ||
        distanceKm < 0
    ) {
        return null;
    }

    if (
        speedKmh === null ||
        speedKmh <= 0
    ) {
        return null;
    }

    const etaMinutes =
        (
            distanceKm /
            speedKmh
        ) * 60;

    if (
        !Number.isFinite(
            etaMinutes
        ) ||
        etaMinutes < 0
    ) {
        return null;
    }

    const passage =
        new Date(
            Date.now() +
            etaMinutes * 60000
        );

    return {

        etaMinutes,

        estimatedPassageTime:
            passage.toISOString(),

        distanceKm,

        speedKmh,

        method:
            "corridor-distance-live-speed"

    };
}


// ============================================================
// NORMALIZE CROSSING
// ============================================================

function normalizeCrossing(
    rawCrossing,
    analysis = {}
) {

    if (
        !rawCrossing ||
        typeof rawCrossing !== "object"
    ) {
        return null;
    }

    // --------------------------------------------------------
    // Handle nested API structures
    // --------------------------------------------------------

    const source =
        firstDefined(

            rawCrossing.crossing,

            rawCrossing.gate,

            rawCrossing.fatak,

            rawCrossing.levelCrossing,

            rawCrossing.level_crossing,

            rawCrossing

        );

    if (
        !source ||
        typeof source !== "object"
    ) {
        return null;
    }

    // --------------------------------------------------------
    // Crossing ID
    // --------------------------------------------------------

    let crossingId =
        firstDefined(

            source.crossingId,

            source.crossingID,

            source.crossing_id,

            source.id,

            source.gateId,

            source.gateID,

            source.gate_id,

            source.fatakId,

            source.fatak_id,

            source.crossing?.id,

            rawCrossing.crossingId,

            rawCrossing.crossingID,

            rawCrossing.crossing_id,

            rawCrossing.gateId,

            rawCrossing.gateID,

            rawCrossing.gate_id,

            rawCrossing.fatakId,

            rawCrossing.fatak_id

        );

    // --------------------------------------------------------
    // Name
    // --------------------------------------------------------

    const crossingName =
        firstDefined(

            source.name,

            source.crossingName,

            source.crossing_name,

            source.gateName,

            source.gate_name,

            source.fatakName,

            source.fatak_name,

            source.title,

            source.description,

            rawCrossing.name,

            rawCrossing.crossingName,

            rawCrossing.crossing_name,

            rawCrossing.gateName,

            rawCrossing.gate_name,

            rawCrossing.fatakName,

            rawCrossing.fatak_name,

            rawCrossing.title,

            rawCrossing.description,

            ""

        );

    // --------------------------------------------------------
    // Infer ID from name
    // --------------------------------------------------------

    if (
        !crossingId
    ) {
        crossingId =
            inferCrossingIdFromName(
                crossingName
            );
    }

    // --------------------------------------------------------
    // Coordinate fallback
    // --------------------------------------------------------

    if (
        !crossingId
    ) {

        const latitude =
            firstDefined(

                source.latitude,

                source.lat,

                source.location?.latitude,

                source.location?.lat,

                source.coordinates?.[1],

                rawCrossing.latitude,

                rawCrossing.lat

            );

        const longitude =
            firstDefined(

                source.longitude,

                source.lng,

                source.lon,

                source.location?.longitude,

                source.location?.lng,

                source.location?.lon,

                source.coordinates?.[0],

                rawCrossing.longitude,

                rawCrossing.lng,

                rawCrossing.lon

            );

        crossingId =
            inferCrossingIdFromCoordinates(
                latitude,
                longitude
            );
    }

    if (
        crossingId
    ) {
        crossingId =
            String(
                crossingId
            ).trim();
    }

    // --------------------------------------------------------
    // Normalize aliases
    // --------------------------------------------------------

    const normalizedId =
        crossingId
            ? inferCrossingIdFromName(
                crossingId
            ) || crossingId
            : null;

    if (
        normalizedId &&
        V1_CROSSING_ID_SET.has(
            normalizedId
        )
    ) {
        crossingId =
            normalizedId;
    }

    // --------------------------------------------------------
    // Final ID validation
    // --------------------------------------------------------

    if (
        !crossingId ||
        !V1_CROSSING_ID_SET.has(
            crossingId
        )
    ) {

        const inferred =
            inferCrossingIdFromName(
                crossingName
            );

        if (
            inferred
        ) {
            crossingId =
                inferred;
        }
    }

    if (
        !crossingId ||
        !V1_CROSSING_ID_SET.has(
            crossingId
        )
    ) {
        return null;
    }

    // --------------------------------------------------------
    // Railway position
    // --------------------------------------------------------

    const railwayPositionKm =
        toFiniteNumber(
            firstDefined(

                source.railwayPositionKm,

                source.railway_position_km,

                source.routePositionKm,

                source.route_position_km,

                source.positionKm,

                source.position_km,

                source.distanceAlongRouteKm,

                source.distance_along_route_km,

                source.routeKm,

                source.route_km,

                source.routeDistanceKm,

                source.route_distance_km,

                rawCrossing.railwayPositionKm,

                rawCrossing.railway_position_km,

                rawCrossing.routePositionKm,

                rawCrossing.route_position_km,

                rawCrossing.positionKm,

                rawCrossing.position_km

            )
        );

    // --------------------------------------------------------
    // Distance from current train
    // --------------------------------------------------------

    const distanceKm =
        toFiniteNumber(
            firstDefined(

                source.distanceAheadKm,

                source.distance_ahead_km,

                source.distanceAhead,

                source.distance_ahead,

                source.distanceToCrossingKm,

                source.distance_to_crossing_km,

                source.distanceToGateKm,

                source.distance_to_gate_km,

                source.distanceFromTrainKm,

                source.distance_from_train_km,

                source.remainingDistanceKm,

                source.remaining_distance_km,

                source.remainingKm,

                source.remaining_km,

                source.distanceKm,

                source.distance_km,

                source.distance,

                rawCrossing.distanceAheadKm,

                rawCrossing.distance_ahead_km,

                rawCrossing.distanceAhead,

                rawCrossing.distance_ahead,

                rawCrossing.distanceToCrossingKm,

                rawCrossing.distance_to_crossing_km,

                rawCrossing.distanceToGateKm,

                rawCrossing.distance_to_gate_km,

                rawCrossing.distanceFromTrainKm,

                rawCrossing.distance_from_train_km,

                rawCrossing.remainingDistanceKm,

                rawCrossing.remaining_distance_km,

                rawCrossing.remainingKm,

                rawCrossing.remaining_km,

                rawCrossing.distanceKm,

                rawCrossing.distance_km,

                rawCrossing.distance

            )
        );

    // --------------------------------------------------------
    // Passage timestamp
    // --------------------------------------------------------

    const rawPassageTime =
        firstDefined(

            source.estimatedPassageTime,

            source.estimated_passage_time,

            source.predictedPassageTime,

            source.predicted_passage_time,

            source.expectedPassageTime,

            source.expected_passage_time,

            source.passageTime,

            source.passage_time,

            source.crossingTime,

            source.crossing_time,

            source.eta,

            rawCrossing.estimatedPassageTime,

            rawCrossing.estimated_passage_time,

            rawCrossing.predictedPassageTime,

            rawCrossing.predicted_passage_time,

            rawCrossing.expectedPassageTime,

            rawCrossing.expected_passage_time,

            rawCrossing.passageTime,

            rawCrossing.passage_time,

            rawCrossing.crossingTime,

            rawCrossing.crossing_time,

            rawCrossing.eta

        );

    const estimatedPassageTime =
        toISOStringSafe(
            rawPassageTime
        );

    // --------------------------------------------------------
    // Explicit ETA minutes
    // --------------------------------------------------------

    const etaMinutes =
        toFiniteNumber(
            firstDefined(

                source.etaMinutes,

                source.eta_minutes,

                source.minutesToCrossing,

                source.minutes_to_crossing,

                source.minutesAway,

                source.minutes_away,

                source.minutesUntilCrossing,

                source.minutes_until_crossing,

                rawCrossing.etaMinutes,

                rawCrossing.eta_minutes,

                rawCrossing.minutesToCrossing,

                rawCrossing.minutes_to_crossing,

                rawCrossing.minutesAway,

                rawCrossing.minutes_away,

                rawCrossing.minutesUntilCrossing,

                rawCrossing.minutes_until_crossing

            )
        );

    return {

        crossingId,

        name:
            crossingName ||
            crossingId,

        railwayPositionKm,

        distanceKm,

        estimatedPassageTime,

        etaMinutes,

        source:
            rawCrossing

    };
}


// ============================================================
// EXTRACT RAW CROSSINGS
// ============================================================

function extractRawCrossings(
    analysis = {}
) {

    const candidates = [];

    // --------------------------------------------------------
    // Direct analysis collections
    // --------------------------------------------------------

    const possibleCollections = [

        analysis.crossings,

        analysis.crossingsAhead,

        analysis.crossings_ahead,

        analysis.futureCrossings,

        analysis.futureCrossingsAhead,

        analysis.future_crossings,

        analysis.future_crossings_ahead,

        analysis.upcomingCrossings,

        analysis.upcomingCrossingsAhead,

        analysis.upcoming_crossings,

        analysis.upcoming_crossings_ahead,

        analysis.expectedCrossings,

        analysis.expectedCrossingsAhead,

        analysis.expected_crossings,

        analysis.expected_crossings_ahead,

        analysis.predictedCrossings,

        analysis.predictedCrossingsAhead,

        analysis.predicted_crossings,

        analysis.predicted_crossings_ahead

    ];

    for (
        const collection of possibleCollections
    ) {

        if (
            Array.isArray(collection)
        ) {
            candidates.push(
                ...collection
            );
        }
    }

    // --------------------------------------------------------
    // Single crossing fields
    // --------------------------------------------------------

    const singleCandidates = [

        analysis.nextExpectedCrossing,

        analysis.nextCrossing,

        analysis.next_crossing,

        analysis.expectedCrossing,

        analysis.expected_crossing,

        analysis.upcomingCrossing,

        analysis.upcoming_crossing,

        analysis.nextGate,

        analysis.nextFatak

    ];

    for (
        const candidate of singleCandidates
    ) {

        if (
            candidate &&
            typeof candidate === "object"
        ) {

            candidates.push(
                candidate
            );
        }
    }

    // --------------------------------------------------------
    // Nested containers
    // --------------------------------------------------------

    const nestedContainers = [

        analysis.route,

        analysis.live,

        analysis.data,

        analysis.result,

        analysis.forecast,

        analysis.corridor,

        analysis.train

    ];

    for (
        const container of nestedContainers
    ) {

        if (
            !container ||
            typeof container !== "object"
        ) {
            continue;
        }

        const nestedCollections = [

            container.crossings,

            container.crossingsAhead,

            container.crossings_ahead,

            container.futureCrossings,

            container.futureCrossingsAhead,

            container.future_crossings,

            container.future_crossings_ahead,

            container.upcomingCrossings,

            container.upcomingCrossingsAhead,

            container.upcoming_crossings,

            container.upcoming_crossings_ahead,

            container.expectedCrossings,

            container.expectedCrossingsAhead,

            container.expected_crossings,

            container.predictedCrossings,

            container.predictedCrossingsAhead

        ];

        for (
            const collection of nestedCollections
        ) {

            if (
                Array.isArray(collection)
            ) {

                candidates.push(
                    ...collection
                );
            }
        }
    }

    return candidates;
}


// ============================================================
// GET ALL EXPECTED CROSSINGS
// ============================================================

function getAllExpectedCrossings(
    analysis = {}
) {

    const rawCrossings =
        extractRawCrossings(
            analysis
        );

    console.log(
        `   Raw crossing candidates: ${rawCrossings.length}`
    );

    const normalized = [];

    for (
        const rawCrossing of rawCrossings
    ) {

        const crossing =
            normalizeCrossing(
                rawCrossing,
                analysis
            );

        if (
            !crossing
        ) {
            continue;
        }

        // ----------------------------------------------------
        // Derive passage from live distance + speed
        // ----------------------------------------------------

        if (
            !crossing.estimatedPassageTime
        ) {

            const derived =
                derivePassageFromDistance(
                    crossing,
                    analysis
                );

            if (
                derived
            ) {

                crossing.estimatedPassageTime =
                    derived.estimatedPassageTime;

                crossing.etaMinutes =
                    derived.etaMinutes;

                // Preserve actual distance/speed derivation.
                crossing.distanceKm =
                    derived.distanceKm;

                crossing.etaMethod =
                    derived.method;

                console.log(

                    `   🧮 Derived ETA: ${
                        crossing.name
                    } | ${
                        derived.etaMinutes.toFixed(1)
                    } min | ${
                        derived.distanceKm.toFixed(3)
                    } km @ ${
                        derived.speedKmh.toFixed(1)
                    } km/h`

                );
            }
        }

        // ----------------------------------------------------
        // ETA minutes → timestamp fallback
        // ----------------------------------------------------

        if (
            !crossing.estimatedPassageTime &&
            crossing.etaMinutes != null
        ) {

            const eta =
                Number(
                    crossing.etaMinutes
                );

            if (
                Number.isFinite(eta) &&
                eta >= 0
            ) {

                crossing.estimatedPassageTime =
                    new Date(
                        Date.now() +
                        eta * 60000
                    ).toISOString();

                crossing.etaMethod =
                    "explicit-eta-minutes";
            }
        }

        // ----------------------------------------------------
        // No timestamp = unusable forecast
        // ----------------------------------------------------

        if (
            !crossing.estimatedPassageTime
        ) {

            console.log(

                `   ⚠ Skipping ${
                    crossing.name
                }: no usable passage ETA`

            );

            continue;
        }

        const passageMs =
            parseDateMs(
                crossing.estimatedPassageTime
            );

        if (
            !Number.isFinite(
                passageMs
            )
        ) {
            continue;
        }

        // ----------------------------------------------------
        // Future-only filter.
        //
        // A 60-second tolerance allows a crossing whose train
        // is currently passing to survive one refresh.
        // ----------------------------------------------------

        const staleToleranceMs =
            60 * 1000;

        if (
            passageMs <
            Date.now() -
            staleToleranceMs
        ) {
            continue;

        }

        normalized.push(
            crossing
        );
    }

    // --------------------------------------------------------
    // Deduplicate by V1 crossing ID
    // --------------------------------------------------------

    const deduped =
        new Map();

    for (
        const crossing of normalized
    ) {

        const existing =
            deduped.get(
                crossing.crossingId
            );

        if (
            !existing
        ) {

            deduped.set(
                crossing.crossingId,
                crossing
            );

            continue;
        }

        const currentTime =
            parseDateMs(
                crossing.estimatedPassageTime
            );

        const existingTime =
            parseDateMs(
                existing.estimatedPassageTime
            );

        // Keep earlier valid forecast.
        if (
            Number.isFinite(currentTime) &&
            (
                !Number.isFinite(existingTime) ||
                currentTime < existingTime
            )
        ) {

            deduped.set(
                crossing.crossingId,
                crossing
            );
        }
    }

    const result =
        Array.from(
            deduped.values()
        );

    // --------------------------------------------------------
    // Sort chronologically first
    // --------------------------------------------------------

    result.sort(
        (a, b) => {

            return (
                parseDateMs(
                    a.estimatedPassageTime
                ) -
                parseDateMs(
                    b.estimatedPassageTime
                )
            );
        }
    );

    console.log(
        `   Usable V1 crossings: ${result.length}`
    );

    for (
        const crossing of result
    ) {

        console.log(

            `   ✓ ${
                crossing.name
            } | distance=${
                crossing.distanceKm != null
                    ? crossing.distanceKm.toFixed(3)
                    : "n/a"
            } km | passage=${
                crossing.estimatedPassageTime
            }`

        );
    }

    return result;
}

// ============================================================
// BUILD GLOBAL TRAIN EVENT QUEUE
// ============================================================
//
// Combines every processed train's future crossings into one
// chronological stream.
//
// Primary sorting key = actual predicted passage timestamp.
//
// This means the system thinks in terms of:
//
//     TRAIN → CROSSING EVENT → TIME
//
// rather than:
//
//     CROSSING → whichever train happened to be processed first
//
// ============================================================

function buildTrainEventQueue(results = [], nowMs = Date.now()) {

    const events = [];

    for (const result of results) {

        if (
            !result ||
            !result.success ||
            !Array.isArray(result.timeline)
        ) {
            continue;
        }

        const analysis =
            result.analysis || {};

        const trainNumber =
            String(
                firstDefined(
                    result.trainNumber,
                    analysis.trainNumber,
                    ""
                )
            ).trim();

        if (!trainNumber) {
            continue;
        }

        const direction =
            getAnalysisDirection(
                analysis
            );

        for (
            let index = 0;
            index < result.timeline.length;
            index++
        ) {

            const crossing =
                result.timeline[index];

            if (!crossing) {
                continue;
            }

            const passageMs =
                getEventPassageMs(
                    crossing
                );

            if (
                !Number.isFinite(
                    passageMs
                )
            ) {
                continue;
            }

            // Ignore events that have already passed.
            if (
                passageMs <
                nowMs -
                FOCUS_EXPIRY_TOLERANCE_MS
            ) {
                continue;
            }
            const etaMinutes = (passageMs - nowMs) / 60000;

if (etaMinutes > ARRIVAL_WINDOW_MINUTES) continue;

            events.push({

                eventId:
                    buildEventIdentity({
                        trainNumber,
                        direction,
                        crossingId:
                            crossing.crossingId
                    }),

                trainNumber,

                trainName:
                    firstDefined(
                        analysis.trainName,
                        analysis.name,
                        ""
                    ),

                direction,

                crossingId:
                    crossing.crossingId,

                crossingName:
                    crossing.name,

                railwayPositionKm:
                    crossing.railwayPositionKm,

                distanceKm:
                    crossing.distanceKm,

                estimatedPassageTime:
                    crossing.estimatedPassageTime,

                passageMs,

                etaMinutes:
                    Math.max(
                        0,
                        (
                            passageMs -
                            nowMs
                        ) / 60000
                    ),

                timelineIndex:
                    index,

                totalCrossings:
                    result.timeline.length,

                trainPositionKm: analysis.trainRailwayPositionKm != null 
                    ? analysis.trainRailwayPositionKm 
                    : (analysis.positionKm != null ? analysis.positionKm : null),

                crossingPositionKm: crossing.railwayPositionKm,

                speedKmph: analysis.speedKmph != null 
                    ? analysis.speedKmph 
                    : (crossing.speedKmph != null ? crossing.speedKmph : null),

                etaCalculationMethod: crossing.etaMethod 
                    || analysis.etaMethod 
                    || "forward-route-segment-speed",

                liveDataUpdatedAt: analysis.timestamp || new Date().toISOString(),

                analysis,

                result

            });
        }
    }

    // Earliest actual crossing event first.
    events.sort(
        (a, b) =>
            a.passageMs -
            b.passageMs
    );

    return events;
}

// ============================================================
// SELECT STABLE PRIMARY FOCUS
// ============================================================
//
// Prevents the primary train from jumping around every cycle.
//
// Example:
//
// Current focus:
//     Train A → Jandiala → 20 min
//
// New cycle:
//     Train A → Jandiala → 18 min
//     Train B → Talwandi → 17 min
//
// Difference = only 1 minute.
//
// Keep Train A.
//
//
//
// But:
//
// Current focus:
//     Train A → Jandiala → 20 min
//
// New cycle:
//     Train B → Talwandi → 4 min
//
// Difference = 16 minutes.
//
// Switch to Train B.
//
// ============================================================

function selectStableFocus(
    events = []
) {

    if (!events.length) {

        activeFocus = null;

        return null;
    }

    // --------------------------------------------------------
    // Check whether existing focus still exists.
    // --------------------------------------------------------

    if (activeFocus) {

        const current =
            events.find(
                event =>
                    event.eventId ===
                    activeFocus.eventId
            );

        if (!current) {

            activeFocus = null;
        }
    }

    // --------------------------------------------------------
    // Keep current focus whenever possible.
    // --------------------------------------------------------

    if (activeFocus) {

        const current =
            events.find(
                event =>
                    event.eventId ===
                    activeFocus.eventId
            );

        if (current) {

            const earliest =
                events[0];

            const currentEta =
                current.etaMinutes;

            const earliestEta =
                earliest.etaMinutes;

            const advantage =
                currentEta -
                earliestEta;

            // ------------------------------------------------
            // Switch only when another event is meaningfully
            // earlier.
            // ------------------------------------------------

            if (
                earliest.eventId !==
                current.eventId &&
                advantage >=
                FOCUS_SWITCH_ADVANTAGE_MINUTES
            ) {

                activeFocus = {

                    eventId:
                        earliest.eventId,

                    trainNumber:
                        earliest.trainNumber,

                    crossingId:
                        earliest.crossingId,

                    direction:
                        earliest.direction,

                    selectedAt:
                        new Date().toISOString(),

                    reason:
                        "substantially-earlier-event"

                };

                return earliest;
            }

            return current;
        }
    }

    // --------------------------------------------------------
    // No current focus → choose earliest event.
    // --------------------------------------------------------

    const selected =
        events[0];

    activeFocus = {

        eventId:
            selected.eventId,

        trainNumber:
            selected.trainNumber,

        crossingId:
            selected.crossingId,

        direction:
            selected.direction,

        selectedAt:
            new Date().toISOString(),

        reason:
            "initial-selection"

    };

    return selected;
}

// ============================================================
// BUILD UPCOMING QUEUE
// ============================================================
//
// Everything after the primary event remains available as the
// upcoming train/event queue.
//
// ============================================================

function buildUpcomingTrainQueue(
    events = [],
    primaryFocus = null
) {

    if (!events.length) {
        return [];
    }

    return events
        .filter(
            event =>
                !primaryFocus ||
                event.eventId !==
                primaryFocus.eventId
        )
        .map(
            event => ({

                eventId:
                    event.eventId,

                trainNumber:
                    event.trainNumber,

                trainName:
                    event.trainName,

                direction:
                    event.direction,

                crossingId:
                    event.crossingId,

                crossingName:
                    event.crossingName,

                distanceKm:
                    event.distanceKm,

                estimatedPassageTime:
                    event.estimatedPassageTime,

                etaMinutes:
                    event.etaMinutes,

                timelineIndex:
                    event.timelineIndex,

                totalCrossings:
                    event.totalCrossings

            })
        );
}

// ============================================================
// BUILD GLOBAL FOCUS SNAPSHOT
// ============================================================
//
// This is the clean object that the API/frontend can consume.
//
// ============================================================

function buildFocusSnapshot(
    events = []
) {

    const primary =
        selectStableFocus(
            events
        );

    const queue =
        buildUpcomingTrainQueue(
            events,
            primary
        );

    if (!primary) {

        return {

            hasFocus: false,

            primary: null,

            queue: [],

            totalEvents: 0,

            generatedAt:
                new Date().toISOString()

        };
    }

    return {

        hasFocus: true,

        primary: {

            eventId:
                primary.eventId,

            trainNumber:
                primary.trainNumber,

            trainName:
                primary.trainName,

            direction:
                primary.direction,

            crossingId:
                primary.crossingId,

            crossingName:
                primary.crossingName,

            distanceKm:
                primary.distanceKm,

            estimatedPassageTime:
                primary.estimatedPassageTime,

            etaMinutes:
                getEventEtaMinutes(
                    primary
                ),

            timelineIndex:
                primary.timelineIndex,

            totalCrossings:
                primary.totalCrossings,

            focusReason:
                activeFocus?.reason ||
                "existing-focus"

        },

        queue,

        totalEvents:
            events.length,

        generatedAt:
            new Date().toISOString()

    };
}


// ============================================================
// NEXT EXPECTED CROSSING
// ============================================================

function getNextExpectedCrossing(
    analysis = {}
) {

    const crossings =
        getAllExpectedCrossings(
            analysis
        );

    if (
        !crossings.length
    ) {
        return null;
    }

    return crossings[0];
}


// ============================================================
// VALIDATE TRAIN TIMELINE
// ============================================================

function validateTrainTimeline(
    crossings,
    direction = null
) {

    if (
        !Array.isArray(crossings) ||
        crossings.length <= 1
    ) {

        return {

            valid: true,

            reason:
                "single-or-zero-crossings"

        };
    }

    const normalizedDirection =
        normalizeDirection(
            direction
        );

    const sorted =
        [...crossings].sort(
            (a, b) => {

                return (
                    parseDateMs(
                        a.estimatedPassageTime
                    ) -
                    parseDateMs(
                        b.estimatedPassageTime
                    )
                );
            }
        );

    // --------------------------------------------------------
    // Passage time must never go backwards.
    // --------------------------------------------------------

    for (
        let i = 1;
        i < sorted.length;
        i++
    ) {

        const previousTime =
            parseDateMs(
                sorted[i - 1]
                    .estimatedPassageTime
            );

        const currentTime =
            parseDateMs(
                sorted[i]
                    .estimatedPassageTime
            );

        if (
            !Number.isFinite(previousTime) ||
            !Number.isFinite(currentTime)
        ) {

            return {

                valid: false,

                reason:
                    "invalid-passage-time",

                crossing:
                    sorted[i]

            };
        }

        const differenceMinutes =
            (
                currentTime -
                previousTime
            ) / 60000;

        if (
            differenceMinutes <
            MIN_PASSAGE_INCREMENT_MINUTES
        ) {

            return {

                valid: false,

                reason:
                    "non-monotonic-passage-time",

                crossing:
                    sorted[i]

            };
        }
    }

    // --------------------------------------------------------
    // Physical railway-position validation.
    //
    // Only validate if every crossing has a railway position.
    // --------------------------------------------------------

    const withPositions =
        sorted.filter(
            crossing =>
                Number.isFinite(
                    crossing.railwayPositionKm
                )
        );

    if (
        withPositions.length >= 2 &&
        normalizedDirection
    ) {

        for (
            let i = 1;
            i < withPositions.length;
            i++
        ) {

            const previous =
                withPositions[
                    i - 1
                ].railwayPositionKm;

            const current =
                withPositions[
                    i
                ].railwayPositionKm;

            // Forward = increasing route position
            if (
                normalizedDirection ===
                "forward"
            ) {

                if (
                    current + 0.001 <
                    previous
                ) {

                    return {

                        valid: false,

                        reason:
                            "railway-position-order-conflict",

                        crossing:
                            withPositions[i]

                    };
                }
            }

            // Backward = decreasing route position
            if (
                normalizedDirection ===
                "backward"
            ) {

                if (
                    current - 0.001 >
                    previous
                ) {

                    return {

                        valid: false,

                        reason:
                            "railway-position-order-conflict",

                        crossing:
                            withPositions[i]

                    };
                }
            }
        }
    }

    return {

        valid: true,

        reason:
            "timeline-consistent"

    };
}


// ============================================================
// BUILD PHYSICALLY COHERENT TRAIN TIMELINE
// ============================================================

function buildTrainTimeline(
    crossings,
    analysis = {}
) {

    if (
        !Array.isArray(crossings) ||
        !crossings.length
    ) {
        return [];
    }

    const direction =
        getAnalysisDirection(
            analysis
        );

    const timeline =
        [...crossings];

    const hasAllPositions =
        timeline.every(
            crossing =>
                Number.isFinite(
                    crossing.railwayPositionKm
                )
        );

    // --------------------------------------------------------
    // BEST CASE:
    // Sort by actual railway position.
    // --------------------------------------------------------

    if (
        hasAllPositions &&
        direction
    ) {

        timeline.sort(
            (a, b) => {

                if (
                    direction ===
                    "backward"
                ) {

                    return (
                        b.railwayPositionKm -
                        a.railwayPositionKm
                    );
                }

                return (
                    a.railwayPositionKm -
                    b.railwayPositionKm
                );
            }
        );

    } else {

        // ----------------------------------------------------
        // FALLBACK:
        // Sort by predicted passage time.
        // ----------------------------------------------------

        timeline.sort(
            (a, b) => {

                return (
                    parseDateMs(
                        a.estimatedPassageTime
                    ) -
                    parseDateMs(
                        b.estimatedPassageTime
                    )
                );
            }
        );
    }

    // --------------------------------------------------------
    // Recalculate ETA from final timestamp.
    // --------------------------------------------------------

    const now =
        Date.now();

    for (
        const crossing of timeline
    ) {

        const passageMs =
            parseDateMs(
                crossing.estimatedPassageTime
            );

        if (
            Number.isFinite(
                passageMs
            )
        ) {

            crossing.etaMinutes =
                Math.max(

                    0,

                    (
                        passageMs -
                        now
                    ) / 60000

                );
        }
    }

    // --------------------------------------------------------
    // Validate physical timeline.
    // --------------------------------------------------------

    const validation =
        validateTrainTimeline(
            timeline,
            direction
        );

    if (
        !validation.valid
    ) {

        console.warn(

            `   ⚠ Timeline rejected: ${
                validation.reason
            }`

        );

        return [];
    }

    return timeline;
}


// ============================================================
// POSITION FRESHNESS
// ============================================================

function getConsecutiveSamePositionCount(
    trainNumber,
    trainPosition
) {

    if (
        !trainNumber ||
        !Number.isFinite(
            trainPosition
        )
    ) {
        return 0;
    }

    const key =
        String(trainNumber);

    const existing =
        positionHistory.get(
            key
        );

    if (
        !existing
    ) {

        positionHistory.set(
            key,
            {
                positionKm:
                    trainPosition,

                repeatedCount:
                    1,

                updatedAt:
                    Date.now()
            }
        );

        return 1;
    }

    const difference =
        Math.abs(
            existing.positionKm -
            trainPosition
        );

    // 10 metres tolerance.
    if (
        difference <= 0.01
    ) {

        existing.repeatedCount += 1;

    } else {

        existing.positionKm =
            trainPosition;

        existing.repeatedCount =
            1;
    }

    existing.updatedAt =
        Date.now();

    return existing.repeatedCount;
}


function isPositionStale(
    trainNumber,
    trainPosition,
    live
) {

    // --------------------------------------------------------
    // Respect explicit stale indicators from analysis/API.
    // --------------------------------------------------------

    if (
        live?.stale === true ||
        live?.positionStale === true ||
        live?.isStale === true
    ) {
        return true;
    }

    const repeatedCount =
        getConsecutiveSamePositionCount(
            trainNumber,
            trainPosition
        );

    // Do not reject the first couple of identical readings.
    // The monitor can still produce a valid future forecast.
    return repeatedCount >= 4;
}


function getPositionFreshness(
    trainNumber,
    trainPosition,
    live
) {

    const repeatedCount =
        getConsecutiveSamePositionCount(
            trainNumber,
            trainPosition
        );

    const stale =
        Boolean(
            live?.stale ||
            live?.positionStale ||
            live?.isStale ||
            repeatedCount >= 4
        );

    return {

        stale,

        repeatedCount

    };
}


// ============================================================
// VALID STALE FORECAST CHECK
// ============================================================
//
// IMPORTANT:
// A stale position does NOT automatically destroy a forecast.
// The crossing timestamp still has to be future and valid.
//
// ============================================================

function hasValidStaleForecast(
    trainNumber,
    trainPosition,
    live
) {

    const freshness =
        getPositionFreshness(
            trainNumber,
            trainPosition,
            live
        );

    return {

        stale:
            freshness.stale,

        repeatedCount:
            freshness.repeatedCount,

        usable:
            true

    };
}


// ============================================================
// BUILD EVENT ANALYSIS
// ============================================================

function buildEventAnalysis(
    analysis,
    crossing,
    timelineIndex = 0,
    timeline = []
) {

    const passageMs =
        parseDateMs(
            crossing.estimatedPassageTime
        );

    const passageTime =
        Number.isFinite(
            passageMs
        )
            ? new Date(
                passageMs
            ).toISOString()
            : null;

    const etaMinutes =
        Number.isFinite(
            passageMs
        )
            ? Math.max(

                0,

                (
                    passageMs -
                    Date.now()
                ) / 60000

            )
            : crossing.etaMinutes;

    const trainNumber =
        String(

            firstDefined(

                analysis?.trainNumber,

                analysis?.number,

                analysis?.trainNo,

                analysis?.train_number,

                ""

            )

        );

    const direction =
        getAnalysisDirection(
            analysis
        );

    return {

        // ----------------------------------------------------
        // Train identity
        // ----------------------------------------------------

        trainNumber,

        trainName:
            firstDefined(

                analysis?.trainName,

                analysis?.name,

                ""

            ),

        direction,

        movementSource:
            firstDefined(

                analysis?.directionSource,

                analysis?.movementSource,

                analysis?.directionSource?.source,

                null

            ),

        // ----------------------------------------------------
        // Station anchor
        // ----------------------------------------------------

        currentStation:
            firstDefined(

                analysis?.currentStation,

                analysis?.station,

                analysis?.stationName,

                analysis?.live?.currentStation,

                analysis?.live?.station,

                null

            ),

        stationCode:
            firstDefined(

                analysis?.stationCode,

                analysis?.currentStationCode,

                analysis?.live?.stationCode,

                null

            ),

        // ----------------------------------------------------
        // Current train state
        // ----------------------------------------------------

        trainPositionKm:
            getAnalysisPositionKm(
                analysis
            ),

        speedKmph:
            getAnalysisSpeedKmh(
                analysis
            ),

        delayMinutes:
            toFiniteNumber(
                firstDefined(

                    analysis?.delayMinutes,

                    analysis?.delay_minutes,

                    analysis?.delay,

                    analysis?.live?.delayMinutes,

                    analysis?.live?.delay

                )
            ),

        positionSource:
            firstDefined(

                analysis?.positionSource,

                analysis?.trainPositionSource,

                analysis?.live?.positionSource,

                null

            ),

        // ----------------------------------------------------
        // Crossing identity
        // ----------------------------------------------------

        crossingId:
            crossing.crossingId ||
            crossing.id,

        id:
            crossing.id ||
            crossing.crossingId,

        crossingName:
            crossing.name,

        crossingPositionKm:
            crossing.crossingPositionKm ??
            crossing.railwayPositionKm ??
            crossing.routeDistanceKm,

        crossingRailwayPositionKm:
            crossing.railwayPositionKm ??
            crossing.crossingPositionKm ??
            crossing.routeDistanceKm,

        routeDistanceKm:
            crossing.routeDistanceKm ??
            crossing.crossingPositionKm ??
            crossing.railwayPositionKm,

        crossingDistanceKm:
            crossing.distanceKm,


        // ----------------------------------------------------
        // Forecast
        // ----------------------------------------------------

        estimatedPassageTime:
            passageTime,

        etaMinutes,

        etaMethod:
            crossing.etaMethod ||
            "analysis",

        // ----------------------------------------------------
        // Timeline metadata
        // ----------------------------------------------------

        timelineIndex,

        totalCrossingsInTimeline:
            timeline.length,

        timeline:
            timeline.map(
                (item, index) => ({

                    crossingId:
                        item.crossingId,

                    crossingName:
                        item.name,

                    railwayPositionKm:
                        item.railwayPositionKm,

                    distanceKm:
                        item.distanceKm,

                    estimatedPassageTime:
                        item.estimatedPassageTime,

                    etaMinutes:
                        item.etaMinutes,

                    timelineIndex:
                        index

                })
            ),

        // ----------------------------------------------------
        // Freshness & Data Quality
        // ----------------------------------------------------

        stale:
            Boolean(

                analysis?.stale ||

                analysis?.positionStale ||

                analysis?.live?.stale ||

                analysis?.live?.positionStale

            ),

        source:
            crossing.source ||
            crossing.etaSource ||
            analysis?.source ||
            "RECENT_TELEMETRY",

        confidence:
            crossing.confidence ||
            crossing.etaConfidence ||
            analysis?.confidence ||
            "MEDIUM",

        movementState:
            crossing.movementState ||
            analysis?.movementState ||
            "RUNNING",

        stopType:
            crossing.stopType ||
            analysis?.stopType ||
            null,

        telemetryFreshness:
            crossing.telemetryFreshness ||
            analysis?.telemetryFreshness ||
            (crossing.stalePosition || analysis?.stale ? "STALE" : "FRESH"),

        telemetryAgeMinutes:
            crossing.telemetryAgeMinutes ??
            analysis?.telemetryAgeMinutes ??
            0,

        degradedConfidence:
            Boolean(crossing.degradedConfidence || crossing.confidence === "DEGRADED"),

        unexpectedHalt:
            Boolean(crossing.unexpectedHalt || crossing.stopType === "UNEXPECTED_INTERMEDIATE_STOP"),

        // ----------------------------------------------------
        // Metadata
        // ----------------------------------------------------

        generatedAt:
            new Date().toISOString()

    };
}


// ============================================================
// PROCESS ONE TRAIN
// ============================================================

async function processTrain(
    trainNumberOrLive
) {
    const isLiveObject = typeof trainNumberOrLive === "object" && trainNumberOrLive !== null;
    const trainNumber = isLiveObject
        ? (trainNumberOrLive.trainNumber || trainNumberOrLive.number || "00000")
        : trainNumberOrLive;

    console.log("");

    console.log(
        `🚆 Processing train ${trainNumber}...`
    );

    try {

        // ----------------------------------------------------
        // Analyze train through existing corridor-monitor.
        // ----------------------------------------------------

        const analysis =
            await analyzeTrain(
                trainNumberOrLive
            );

        if (
            !analysis
        ) {

            console.log(

                `   ⚠ No analysis returned for ${
                    trainNumber
                }`

            );

            return {

                trainNumber,

                success: false,

                crossings: 0,

                reason:
                    "no-analysis"

            };
        }

        // ----------------------------------------------------
        // Ensure identity survives even if analyzer does not
        // explicitly return trainNumber.
        // ----------------------------------------------------

        if (
            !analysis.trainNumber
        ) {
            analysis.trainNumber =
                String(
                    trainNumber
                );
        }

        if (analysis.isCancelled || analysis.status === "cancelled" || analysis.reason === "cancelled") {
            return {
                trainNumber: String(trainNumber),
                trainName: analysis.trainName || "",
                success: false,
                isCancelled: true,
                crossings: 0,
                reason: "cancelled"
            };
        }

        if (analysis.directionUncertain || analysis.direction === "unknown") {
            console.log(
                `   ⚠️ Direction uncertain for ${trainNumber}; skipping crossing forecast.`
            );
            return {
                trainNumber: String(trainNumber),
                trainName: analysis.trainName || "",
                success: false,
                directionUncertain: true,
                crossings: 0,
                reason: "direction-uncertain"
            };
        }

        const speedKmph =
            getAnalysisSpeedKmh(
                analysis
            );

        const positionKm =
            getAnalysisPositionKm(
                analysis
            );

        const direction =
            getAnalysisDirection(
                analysis
            );

        console.log(

            `   Position: ${
                positionKm != null
                    ? positionKm.toFixed(3)
                    : "unknown"
            } km`

        );

        console.log(

            `   Speed: ${
                speedKmph != null
                    ? speedKmph.toFixed(1)
                    : "unknown"
            } km/h`

        );

        console.log(

            `   Direction: ${
                direction ||
                analysis.direction ||
                "UNKNOWN"
            }`

        );

        console.log(

            `   Station: ${
                firstDefined(

                    analysis.currentStation,

                    analysis.station,

                    analysis.stationName,

                    "unknown"

                )
            }`

        );

        // ----------------------------------------------------
        // Extract ALL future V1 crossings.
        // ----------------------------------------------------

        const crossings =
            getAllExpectedCrossings(
                analysis
            );

        console.log(

            `   Crossings extracted by engine: ${
                crossings.length
            }`

        );

        if (
            !crossings.length
        ) {

            console.log(

                `   No future V1 crossing events for ${
                    trainNumber
                }`

            );

            return {

                trainNumber,

                success: true,

                crossings: 0,

                reason:
                    "no-future-crossings",

                analysis

            };
        }

        // ----------------------------------------------------
        // Build physically coherent timeline.
        // ----------------------------------------------------

        const timeline =
            buildTrainTimeline(
                crossings,
                analysis
            );

        if (
            !timeline.length
        ) {

            console.log(

                `   ⚠ Timeline invalid for ${
                    trainNumber
                }`

            );

            return {

                trainNumber,

                success: false,

                crossings: 0,

                reason:
                    "invalid-timeline",

                analysis

            };
        }

        // ----------------------------------------------------
        // Log timeline
        // ----------------------------------------------------

        console.log("");

        console.log(

            `   📍 ${trainNumber} crossing timeline:`

        );

        timeline.forEach(
            (crossing, index) => {

                const eta =
                    Number.isFinite(
                        crossing.etaMinutes
                    )

                        ? crossing
                            .etaMinutes
                            .toFixed(1)

                        : "n/a";

                console.log(

                    `      ${
                        index + 1
                    }. ${
                        crossing.name
                    } → ${
                        eta
                    } min`

                );
            }
        );

        // ----------------------------------------------------
        // Freshness
        // ----------------------------------------------------

        const freshness =
            hasValidStaleForecast(

                trainNumber,

                positionKm,

                analysis.live ||
                analysis

            );

        if (
            freshness.stale
        ) {

            console.log(

                `   ⚠ Position appears stale ` +
                `(repeated=${
                    freshness.repeatedCount
                })`

            );
        }

        // ----------------------------------------------------
        // Record EVERY crossing.
        // ----------------------------------------------------

       // ----------------------------------------------------
// Record only crossings inside the V1 immediate window.
//
// The complete timeline is preserved internally, but
// V1 forecast events are recorded only when they are
// expected within the next 60 minutes.
// ----------------------------------------------------

let recorded = 0;

for (
    let index = 0;
    index < timeline.length;
    index++
) {

    const crossing =
        timeline[index];

    const passageMs =
        parseDateMs(
            crossing.estimatedPassageTime
        );

    if (
        !Number.isFinite(passageMs)
    ) {

        console.log(
            `   ⏭️ Skipping ${
                crossing.name
            }: invalid passage time`
        );

        continue;
    }

    const etaMinutes =
        (
            passageMs -
            Date.now()
        ) / 60000;

    // Already passed.
    if (
        etaMinutes < -1
    ) {

        console.log(
            `   ⏭️ Skipping ${
                crossing.name
            }: passage already passed`
        );

        continue;
    }

    // Outside the V1 immediate forecast window.
    if (
        etaMinutes > ARRIVAL_WINDOW_MINUTES
    ) {

        console.log(

            `   ⏭️ Skipping ${
                crossing.name
            } outside ${
                ARRIVAL_WINDOW_MINUTES
            }-minute V1 window | ETA ${
                etaMinutes.toFixed(1)
            } min`

        );

        continue;
    }

    const eventAnalysis =
        buildEventAnalysis(

            analysis,

            crossing,

            index,

            timeline

        );

    try {

        const recordedEvent =
    await recordAnalysisResult(
        eventAnalysis
    );

if (recordedEvent) {
    recorded++;
}

        console.log(

            `   💾 Recorded: ${
                crossing.name
            } | ETA ${
                Math.max(
                    0,
                    etaMinutes
                ).toFixed(1)
            } min | ${
                crossing.estimatedPassageTime
            }`

        );

    } catch (
        recordError
    ) {

        console.error(

            `   ❌ Failed recording ${
                crossing.name
            }:`,
            recordError.message

        );
    }
}

        return {

            trainNumber,

            success: true,

            crossings:
                recorded,

            timeline,

            analysis

        };

    } catch (
        error
    ) {

        console.error(

            `   ❌ Train ${
                trainNumber
            } failed:`,
            error.message

        );

        return {

            trainNumber,

            success: false,

            crossings: 0,

            reason:
                error.message

        };
    }
}


// ============================================================
// RUN ONE COMPLETE CORRIDOR CYCLE
// ============================================================

let isCycleRunning = false;

async function runCorridorCycle() {

    if (isCycleRunning) {
        console.warn("⚠️ Corridor cycle already in progress; skipping overlapping cycle execution.");
        return {
            success: false,
            skipped: true,
            reason: "cycle-already-running"
        };
    }

    isCycleRunning = true;

    const cycleStartedAt =
        Date.now();

    console.log("");

    console.log(
        "=================================================="
    );

    console.log(
        "🚦 FATAKFORECAST CORRIDOR CYCLE"
    );

    console.log(
        new Date().toLocaleString(
            "en-IN"
        )
    );

    console.log(
        "=================================================="
    );

    try {

        // ----------------------------------------------------
        // Fetch live JNL board
        // ----------------------------------------------------

        console.log(

            `📡 Fetching live station board: ${
                STATION_CODE
            }`

        );

        const stationData =
            await getStationLive(
                STATION_CODE,
                {
                    hours:
                        DISCOVERY_HOURS,

                    includeIntermediate:
                        true
                }
            );

        if (
            !stationData
        ) {

            throw new Error(
                "JNL live station data unavailable."
            );
        }

        // ----------------------------------------------------
        // 1. Evaluate & maintain In-Flight Corridor Registry
        // ----------------------------------------------------
        const nowMs = Date.now();
        for (const [regTrainNum, regData] of activeCorridorRegistry.entries()) {
            const timeline = regData.timeline || [];
            const passageTimes = timeline.map(c => new Date(c.estimatedPassageTime).getTime()).filter(t => Number.isFinite(t));
            const lastPassageMs = passageTimes.length ? Math.max(...passageTimes) : 0;

            // If train has completed passage at all crossings (> 1.5 min after last passage)
            // or if telemetry is older than 30 minutes:
            if (lastPassageMs > 0 && nowMs > lastPassageMs + TIMING_CONFIG.GATE_REOPEN_BUFFER_MINUTES.earliest * 60000) {
                console.log(`   🏁 Train ${regTrainNum} completed corridor passage; retiring from active registry.`);
                activeCorridorRegistry.delete(regTrainNum);
            } else if (nowMs - regData.lastObservedAt > 30 * 60 * 1000) {
                console.log(`   ⏱️ Train ${regTrainNum} registry entry expired (>30m); retiring.`);
                activeCorridorRegistry.delete(regTrainNum);
            }
        }

        // ----------------------------------------------------
        // 2. Discover relevant trains from station board
        // ----------------------------------------------------
        const discoveredTrains = discoverRelevantTrains(stationData);

        // ----------------------------------------------------
        // 3. Prioritize In-Flight Active Corridor Trains
        // Active in-flight trains are placed at the HEAD of the queue.
        // ----------------------------------------------------
        const combinedTrains = [];
        const seenNumbers = new Set();

        // Active in-flight trains get top priority:
        for (const [regTrainNum, regData] of activeCorridorRegistry.entries()) {
            combinedTrains.push({
                number: regTrainNum,
                trainNumber: regTrainNum,
                name: regData.trainName || "",
                classification: "in-flight-active"
            });
            seenNumbers.add(String(regTrainNum).trim());
        }

        // Newly discovered station trains follow:
        for (const train of discoveredTrains) {
            const num = String(getTrainNumber(train) || "").trim();
            if (num && !seenNumbers.has(num)) {
                combinedTrains.push(train);
                seenNumbers.add(num);
            }
        }

        const trains = combinedTrains.slice(0, Math.min(MAX_TRAINS_PER_CYCLE, combinedTrains.length));

        console.log("");
        console.log(
            `🚆 Total trains queued for cycle: ${
                trains.length
            } (${activeCorridorRegistry.size} active in-flight, ${discoveredTrains.length} discovered)`
        );

        if (!trains.length) {
            console.log(
                "   No relevant trains found in discovery window."
            );

            return {
                success: true,
                trains: 0,
                successfulTrains: 0,
                events: 0,
                results: [],
                durationMs: Date.now() - cycleStartedAt
            };
        }

        trains.forEach((train, index) => {
            console.log(
                `   ${index + 1}. ${getTrainNumber(train)} — ${getTrainName(train) || ""} — ${train.classification || classifyTrain(train)}`
            );
        });

        const results = [];

        for (let i = 0; i < trains.length; i++) {
            const train = trains[i];
            const trainNumber = String(firstDefined(train.number, train.trainNumber, train.trainNo, train.train_number, "")).trim();
            if (!trainNumber) continue;

            const result = await processTrain(trainNumber);
            results.push(result);

            if (result && result.success && Array.isArray(result.timeline) && result.timeline.length > 0) {
                activeCorridorRegistry.set(trainNumber, {
                    trainNumber,
                    trainName: result.analysis?.trainName || result.analysis?.name || train.name || "",
                    direction: result.analysis?.direction || "forward",
                    lastObservedAt: Date.now(),
                    result,
                    timeline: result.timeline,
                    analysis: result.analysis
                });
            }

            if (i < trains.length - 1) {
                await sleep(TRAIN_PROCESS_DELAY_MS);
            }
        }

        // ----------------------------------------------------
        // 4. Retain active in-flight trajectories for trains
        //    not successfully refreshed in this cycle (e.g. 429 rate limits or board omissions)
        // ----------------------------------------------------
        for (const [regTrainNum, regData] of activeCorridorRegistry.entries()) {
            const inCurrentResults = results.some(r => String(r.trainNumber) === String(regTrainNum) && r.success);
            if (!inCurrentResults && regData.result) {
                const remainingCrossings = (regData.timeline || []).filter(c => {
                    const pMs = new Date(c.estimatedPassageTime).getTime();
                    return (pMs + TIMING_CONFIG.GATE_REOPEN_BUFFER_MINUTES.earliest * 60000) >= Date.now();
                });

                if (remainingCrossings.length > 0) {
                    console.log(`   🛡️ Retaining active in-flight trajectory for Train ${regTrainNum} (${remainingCrossings.length} crossings remaining)`);
                    results.push({
                        ...regData.result,
                        timeline: remainingCrossings,
                        isRetainedTrajectory: true
                    });
                }
            }
        }

        // ========================================================
// GLOBAL TRAIN-FIRST EVENT QUEUE
// ========================================================
//
// Every processed train now has a physically coherent
// crossing timeline.
//
// Combine them into one chronological stream and select
// a stable primary event.
//

const allTrainEvents =
    buildTrainEventQueue(
        results
    );

const focusSnapshot =
    buildFocusSnapshot(
        allTrainEvents
    );

console.log("");

console.log(
    "🎯 GLOBAL TRAIN FOCUS"
);

if (
    focusSnapshot.hasFocus
) {

    console.log(

        `   PRIMARY → Train ${
            focusSnapshot.primary.trainNumber
        } | ${
            focusSnapshot.primary.crossingName
        } | ${
            focusSnapshot.primary.etaMinutes != null
                ? focusSnapshot.primary.etaMinutes.toFixed(1)
                : "n/a"
        } min`

    );

    console.log(

        `   Direction: ${
            focusSnapshot.primary.direction ||
            "unknown"
        }`

    );

    console.log("");

    console.log(
        "   UPCOMING QUEUE:"
    );

    focusSnapshot.queue
        .slice(0, 10)
        .forEach(
            (event, index) => {

                console.log(

                    `      ${
                        index + 1
                    }. Train ${
                        event.trainNumber
                    } → ${
                        event.crossingName
                    } | ${
                        Number.isFinite(
                            event.etaMinutes
                        )
                            ? event.etaMinutes.toFixed(1)
                            : "n/a"
                    } min`

                );
            }
        );

} else {

    console.log(
        "   No future V1 train events."
    );
}
        // ----------------------------------------------------
        // Totals
        // ----------------------------------------------------

        const totalEvents =
            results.reduce(

                (
                    sum,
                    result
                ) =>

                    sum +
                    Number(
                        result.crossings ||
                        0
                    ),

                0

            );

        const successfulTrains =
            results.filter(
                result =>
                    result.success
            ).length;

        console.log("");

        console.log(
            "--------------------------------------------------"
        );

        console.log(
            "✅ Cycle complete"
        );

        console.log(

            `   Trains processed: ${
                results.length
            }`

        );

        console.log(

            `   Successful: ${
                successfulTrains
            }`

        );

        console.log(

            `   Crossing events recorded: ${
                totalEvents
            }`

        );

        console.log(

            `   Duration: ${
                (
                    (
                        Date.now() -
                        cycleStartedAt
                    ) / 1000
                ).toFixed(1)
            } sec`

        );

        console.log(
            "--------------------------------------------------"
        );

        // Build and persist unified current truth snapshot
        const eventsByCrossing = {};
        for (const ev of (allTrainEvents || [])) {
            const crossingId = ev.crossingId || ev.crossing_id || ev.id;
            if (crossingId) {
                if (!eventsByCrossing[crossingId]) {
                    eventsByCrossing[crossingId] = [];
                }
                eventsByCrossing[crossingId].push(ev);
            }
        }

        // Also supply recent results timeline events so recently passed trains can be archived to lastTrainPassed
        for (const res of (results || [])) {
            if (!res || !res.success || !Array.isArray(res.timeline)) continue;
            for (const cr of res.timeline) {
                const cId = cr.crossingId || cr.crossing_id || cr.id;
                if (!cId) continue;
                if (!eventsByCrossing[cId]) {
                    eventsByCrossing[cId] = [];
                }
                const already = eventsByCrossing[cId].some(e => String(e.train_number || e.trainNumber) === String(res.trainNumber));
                if (!already) {
                    eventsByCrossing[cId].push({
                        ...cr,
                        train_number: res.trainNumber,
                        trainNumber: res.trainNumber,
                        train_name: res.analysis?.trainName || res.analysis?.name || "",
                        trainName: res.analysis?.trainName || res.analysis?.name || "",
                        direction: res.analysis?.direction || "forward"
                    });
                }
            }
        }

        const snapshot = buildUnifiedSnapshot({
            cycleId: `cycle-${cycleStartedAt}`,
            cycleTimestamp: new Date(cycleStartedAt).toISOString(),
            liveDataTimestamp: new Date().toISOString(),
            eventsByCrossing,
            diagnostics: {
                discoveredTrains: results.length,
                selectedTrains: results.length,
                successfulAnalyses: successfulTrains,
                failedAnalyses: results.length - successfulTrains,
                eventsIn60Min: totalEvents,
                durationMs: Date.now() - cycleStartedAt
            },
            engineStatus: "OK"
        });
        saveSnapshot(snapshot);

        return {
            success: true,
            trains: results.length,
            successfulTrains,
            events: totalEvents,
            focus: focusSnapshot,
            primaryEvent: focusSnapshot.primary,
            upcomingQueue: focusSnapshot.queue,
            allTrainEvents,
            snapshot,
            results,
            durationMs: Date.now() - cycleStartedAt
        };


    } catch (
        error
    ) {

        console.error("");

        console.error(

            "❌ Corridor cycle failed:",
            error.message

        );

        return {

            success: false,

            trains: 0,

            successfulTrains: 0,

            events: 0,

            results: [],

            error:
                error.message,

            durationMs:
                Date.now() -
                cycleStartedAt

        };
    } finally {
        isCycleRunning = false;
    }
}


// ============================================================
// CONTINUOUS MONITOR
// ============================================================

async function startCorridorMonitor() {

    console.log("");

    console.log(
        "🚦 FatakForecast Live Monitor"
    );

    console.log(
        `📍 Monitoring station: ${
            STATION_CODE
        }`
    );

    console.log(
        `🚧 V1 crossings: ${
            V1_CROSSING_ID_SET.size
        }`
    );

    console.log(
        `⏱ Polling interval: ${
            POLL_INTERVAL_MS / 60000
        } minutes`
    );

    console.log("");

    console.log(
        "Press CTRL + C to stop."
    );

    console.log("");

    // --------------------------------------------------------
    // First cycle immediately
    // --------------------------------------------------------

    await runCorridorCycle();

    // --------------------------------------------------------
    // Continuous polling
    // --------------------------------------------------------

    setInterval(
        async () => {

            try {

                await runCorridorCycle();

            } catch (
                error
            ) {

                console.error(

                    "❌ Monitor cycle error:",
                    error.message

                );
            }

        },

        POLL_INTERVAL_MS
    );
}


// ============================================================
// BACKWARD-COMPATIBILITY ALIAS
// ============================================================
//
// Older monitor.js may call runMonitoringCycle().
//
// Keep this alias so existing pipeline does not break.
//

const runMonitoringCycle =
    runCorridorCycle;


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

    // Main cycle
    runCorridorCycle,

    runMonitoringCycle,

    startCorridorMonitor,

    // Train processing
    processTrain,

    discoverTrains,

    discoverRelevantTrains,

    classifyTrain,

    classifyTrainForCorridor,

    // Crossing extraction
    getAllExpectedCrossings,

    getNextExpectedCrossing,

    normalizeCrossing,

    extractRawCrossings,

    inferCrossingIdFromName,

    inferCrossingIdFromCoordinates,

    // Timeline
    buildTrainTimeline,

    validateTrainTimeline,

    buildEventAnalysis,

    // Analysis helpers
    getAnalysisSpeedKmh,

    getAnalysisPositionKm,

    getAnalysisDirection,

    derivePassageFromDistance,

    getDelayMinutes,
    getDepartureTime,
    getArrivalTime,

    // Freshness
    getPositionFreshness,

    hasValidStaleForecast,
    // Stable train focus / queue
    buildTrainEventQueue,

    selectStableFocus,

    buildUpcomingTrainQueue,

    buildFocusSnapshot,
    activeCorridorRegistry
};


// ============================================================
// DIRECT EXECUTION
// ============================================================

if (
    require.main === module
) {

    startCorridorMonitor()
        .catch(
            error => {

                console.error(

                    "❌ Fatal monitor error:",
                    error

                );

                process.exit(1);
            }
        );
}