// backend/services/eta.js

/**
 * FatakForecast - ETA Engine
 *
 * Purpose:
 * - Estimate train passage time at a railway crossing.
 * - Prefer live train position + trustworthy speed.
 * - Fall back to route/segment speed when live speed is stale/too low.
 * - Use station timing only when it is physically compatible.
 * - Never return an ETA that violates a basic physical lower bound.
 *
 * IMPORTANT:
 * This module does NOT decide which train the UI should focus on.
 * Stable train/corridor focus belongs to server.js / forecast layer.
 */

const MIN_SPEED_KMPH = 10;
const MAX_SPEED_KMPH = 140;

const DEFAULT_SPEED_KMPH = 60;
const MIN_TRUSTWORTHY_LIVE_SPEED_KMPH = 15;

const STATION_NEAR_TOLERANCE_KM = 0.35;

// Do not trust a station timestamp that is too far into the future (up to 120m for extended outlook).
const MAX_FUTURE_ANCHOR_MINUTES = 120;

// Small tolerance because geometry/projection can differ by a few metres.
const PHYSICAL_SANITY_TOLERANCE = 0.90;

// -----------------------------------------------------------------------------
// Generic helpers
// -----------------------------------------------------------------------------

function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
}

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function minutesBetween(start, end) {
    return (end.getTime() - start.getTime()) / 60000;
}

function addMinutes(date, minutes) {
    return new Date(date.getTime() + minutes * 60000);
}

function normalizeDate(value) {
    if (!value) return null;

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? null : date;
}

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

// -----------------------------------------------------------------------------
// Speed extraction
// -----------------------------------------------------------------------------

function getRawLiveSpeed(live) {
    if (!live) return null;

    const candidates = [
        live?.currentLocation?.speedKmh,
        live?.currentLocation?.speedKmph,
        live?.currentLocation?.speed,
        live?.speedKmh,
        live?.speedKmph,
        live?.speed
    ];

    for (const value of candidates) {
        const speed = toNumber(value);

        if (speed !== null && speed >= 0) {
            return speed;
        }
    }

    return null;
}

function getLiveSpeed(live) {
    const speed = getRawLiveSpeed(live);

    if (
        speed === null ||
        speed < MIN_TRUSTWORTHY_LIVE_SPEED_KMPH ||
        speed > MAX_SPEED_KMPH
    ) {
        return null;
    }

    return speed;
}

/**
 * Extract route/segment speed.
 *
 * RailRadar has used slightly different field names across responses,
 * therefore several compatible fields are checked.
 */
function getSpeedFromStation(station) {
    if (!station) return null;

    const candidates = [
        station.speedToNextStationKmph,
        station.speedToNextStationKmh,
        station.speedKmph,
        station.speedKmh,
        station.averageSpeedKmph,
        station.averageSpeedKmh
    ];

    for (const value of candidates) {
        const speed = toNumber(value);

        if (
            speed !== null &&
            speed >= MIN_SPEED_KMPH &&
            speed <= MAX_SPEED_KMPH
        ) {
            return speed;
        }
    }

    return null;
}

/**
 * Find the route station corresponding to the train's current/nearby
 * route sequence.
 *
 * IMPORTANT:
 * We deliberately DO NOT compare RailRadar station.distance against
 * geometry.trainPositionKm.
 *
 * Those values can represent different route-distance references.
 */
function getCurrentRouteSequence(live, trainPosition) {
    const candidates = [
        live?.currentLocation?.sequence,
        live?.currentLocation?.stationSequence,
        live?.currentLocation?.routeSequence,
        live?.currentLocation?.sequenceNumber,
        trainPosition?.sequence,
        trainPosition?.routeSequence
    ];

    for (const value of candidates) {
        const n = Number(value);

        if (Number.isFinite(n)) {
            return n;
        }
    }

    return null;
}

function getRouteStations(live) {
    const candidates = [
        live?.route?.stations,
        live?.route,
        live?.data?.route?.stations,
        live?.data?.route
    ];

    for (const value of candidates) {
        if (Array.isArray(value)) {
            return value;
        }
    }

    return [];
}

/**
 * Select a station based on route sequence rather than distance.
 */
function findRouteStationBySequence(live, trainPosition, direction = "forward") {
    const stations = getRouteStations(live);

    if (!stations.length) {
        return null;
    }

    const currentSequence = getCurrentRouteSequence(
        live,
        trainPosition
    );

    if (currentSequence === null) {
        return null;
    }

    const normalized = stations
        .map((station, index) => ({
            station,
            index,
            sequence: toNumber(
                firstDefined(
                    station?.sequence,
                    station?.routeSequence,
                    station?.sequenceNumber,
                    index
                )
            )
        }))
        .filter(item => item.sequence !== null)
        .sort((a, b) => a.sequence - b.sequence);

    if (!normalized.length) {
        return null;
    }

    if (direction === "backward") {
        const candidates = normalized.filter(
            item => item.sequence <= currentSequence
        );

        if (candidates.length) {
            return candidates[candidates.length - 1].station;
        }
    } else {
        const candidates = normalized.filter(
            item => item.sequence >= currentSequence
        );

        if (candidates.length) {
            return candidates[0].station;
        }
    }

    return null;
}

/**
 * Get a usable route speed near the current train position.
 *
 * Priority:
 * 1. Current route station segment speed.
 * 2. Nearby route station segment speed.
 * 3. Default speed.
 */
function getRouteSegmentSpeed(live, trainPosition, direction = "forward") {
    const stations = getRouteStations(live);

    if (!stations.length) {
        return {
            speedKmph: DEFAULT_SPEED_KMPH,
            source: "default-speed",
            station: null
        };
    }

    const currentSequence = getCurrentRouteSequence(
        live,
        trainPosition
    );

    if (currentSequence === null) {
        const currentStation = findRouteStationBySequence(
            live,
            trainPosition,
            direction
        );

        const directSpeed = getSpeedFromStation(currentStation);

        if (directSpeed !== null) {
            return {
                speedKmph: directSpeed,
                source: "route-segment-speed",
                station: currentStation
            };
        }

        return {
            speedKmph: DEFAULT_SPEED_KMPH,
            source: "default-speed",
            station: null
        };
    }

    const stationItems = stations
        .map((station, index) => ({
            station,
            sequence: toNumber(
                firstDefined(
                    station?.sequence,
                    station?.routeSequence,
                    station?.sequenceNumber,
                    index
                )
            )
        }))
        .filter(item => item.sequence !== null);

    if (direction === "backward") {
        /*
         * BACKWARD:
         * The train is travelling from a higher sequence
         * toward a lower sequence.
         *
         * Therefore the relevant segment is:
         *
         * previous lower-sequence station
         *              ↓
         *        current station
         *
         * speedToNextStationKmph belongs to the lower-sequence
         * station and represents that segment.
         */
        const previousStation = stationItems
            .filter(item => item.sequence < currentSequence)
            .sort((a, b) => b.sequence - a.sequence)[0];

        if (previousStation) {
            const backwardSpeed =
                getSpeedFromStation(previousStation.station);

            if (backwardSpeed !== null) {
                return {
                    speedKmph: backwardSpeed,
                    source: "backward-route-segment-speed",
                    station: previousStation.station
                };
            }
        }
    } else {
        /*
         * FORWARD:
         * The relevant segment is:
         *
         * current station
         *       ↓
         * next higher-sequence station
         */
        const currentOrNextStation = stationItems
            .filter(item => item.sequence >= currentSequence)
            .sort((a, b) => a.sequence - b.sequence)[0];

        if (currentOrNextStation) {
            const forwardSpeed =
                getSpeedFromStation(currentOrNextStation.station);

            if (forwardSpeed !== null) {
                return {
                    speedKmph: forwardSpeed,
                    source: "forward-route-segment-speed",
                    station: currentOrNextStation.station
                };
            }
        }
    }

    return {
        speedKmph: DEFAULT_SPEED_KMPH,
        source: "default-speed",
        station: null
    };
}
// -----------------------------------------------------------------------------
// Train position helpers
// -----------------------------------------------------------------------------

function getTrainPositionKm(trainPosition) {
    if (trainPosition === null || trainPosition === undefined) {
        return null;
    }

    const candidates = [
        trainPosition?.km,
        trainPosition?.positionKm,
        trainPosition?.routeKm,
        trainPosition?.distanceKm,
        trainPosition?.trainPositionKm,
        trainPosition
    ];

    for (const value of candidates) {
        const n = toNumber(value);

        if (n !== null) {
            return n;
        }
    }

    return null;
}

function getCrossingPositionKm(crossing) {
    if (!crossing) return null;

    const candidates = [
        crossing?.positionKm,
        crossing?.railwayPositionKm,
        crossing?.routePositionKm,
        crossing?.km,
        crossing?.distanceKm
    ];

    for (const value of candidates) {
        const n = toNumber(value);

        if (n !== null) {
            return n;
        }
    }

    return null;
}

function getDirection(direction) {
    if (!direction) {
        return null;
    }

    const value =
        String(direction)
            .trim()
            .toLowerCase();

    if (
        value.includes("back") ||
        value.includes("reverse")
    ) {
        return "backward";
    }

    if (
        value.includes("forward")
    ) {
        return "forward";
    }

    return null;
}

function getDistanceToCrossing(
    trainPosition,
    crossing,
    direction = "forward"
) {
    if (
        crossing &&
        typeof crossing === "object" &&
        typeof crossing.distanceKm === "number" &&
        Number.isFinite(crossing.distanceKm)
    ) {
        return crossing.distanceKm;
    }

    const trainKm = getTrainPositionKm(trainPosition);
    const crossingKm = getCrossingPositionKm(crossing);

    if (trainKm === null || crossingKm === null) {
        return null;
    }

    const dir = getDirection(direction);

    if (dir === null) {
        return null;
    }

    if (dir === "backward" || dir === "reverse") {
        return trainKm - crossingKm;
    }

    return crossingKm - trainKm;
}

/**
 * A crossing behind the train is NOT a future crossing.
 */
function isCrossingAhead(
    trainPosition,
    crossing,
    direction = "forward"
) {
    const distance = getDistanceToCrossing(
        trainPosition,
        crossing,
        direction
    );

    if (distance === null) {
        return false;
    }

    return distance >= -0.05;
}

// -----------------------------------------------------------------------------
// Position freshness
// -----------------------------------------------------------------------------

function getPositionTimestamp(trainPosition, live) {
    const candidates = [
        trainPosition?.timestamp,
        trainPosition?.updatedAt,
        trainPosition?.observedAt,
        trainPosition?.time,
        live?.currentLocation?.lastUpdatedAt,
        live?.currentLocation?.timestamp,
        live?.currentLocation?.updatedAt,
        live?.lastUpdatedAt,
        live?.timestamp,
        live?.updatedAt
    ];

    for (const value of candidates) {
        const date = normalizeDate(value);

        if (date) {
            return date;
        }
    }

    return null;
}

const TELEMETRY_THRESHOLDS = {
    FRESH_MINUTES: 2.5,
    AGING_MINUTES: 5.0,
    STALE_MINUTES: 10.0
};

function getTelemetryFreshness(trainPosition, live, now = new Date()) {
    const timestamp = getPositionTimestamp(trainPosition, live);

    if (!timestamp) {
        if (!trainPosition && !live?.currentLocation) {
            return {
                state: "UNAVAILABLE",
                label: "POSITION UNAVAILABLE",
                ageMinutes: null,
                timestamp: null
            };
        }
        return {
            state: "FRESH",
            label: "LIVE POSITION",
            ageMinutes: 0,
            timestamp: null
        };
    }

    const currentDate = normalizeDate(now) ?? new Date();
    const ageMinutes = minutesBetween(timestamp, currentDate);

    if (ageMinutes < 0) {
        return {
            state: "FRESH",
            label: "LIVE POSITION",
            ageMinutes: 0,
            timestamp
        };
    }

    if (ageMinutes <= TELEMETRY_THRESHOLDS.FRESH_MINUTES) {
        return {
            state: "FRESH",
            label: "LIVE POSITION",
            ageMinutes: Number(ageMinutes.toFixed(1)),
            timestamp
        };
    }

    if (ageMinutes <= TELEMETRY_THRESHOLDS.AGING_MINUTES) {
        return {
            state: "AGING",
            label: "ESTIMATED POSITION",
            ageMinutes: Number(ageMinutes.toFixed(1)),
            timestamp
        };
    }

    if (ageMinutes <= TELEMETRY_THRESHOLDS.STALE_MINUTES) {
        return {
            state: "STALE",
            label: "STALE TELEMETRY",
            ageMinutes: Number(ageMinutes.toFixed(1)),
            timestamp
        };
    }

    return {
        state: "UNAVAILABLE",
        label: "POSITION UNAVAILABLE",
        ageMinutes: Number(ageMinutes.toFixed(1)),
        timestamp
    };
}

function isPositionStale(trainPosition, live, now = new Date()) {
    const freshness = getTelemetryFreshness(trainPosition, live, now);
    return freshness.state === "STALE" || freshness.state === "UNAVAILABLE" || (freshness.ageMinutes != null && freshness.ageMinutes > 2.5);
}

function classifyTrainMovement(live, trainPosition, speedKmph = null, freshnessState = "FRESH") {
    if (freshnessState === "UNAVAILABLE") {
        return {
            movementState: "UNKNOWN",
            stopType: null,
            isStop: false,
            degraded: true,
            reason: "Telemetry unavailable"
        };
    }
    if (freshnessState === "STALE") {
        return {
            movementState: "STALE",
            stopType: null,
            isStop: false,
            degraded: true,
            reason: "Telemetry stale (>5m old)"
        };
    }

    const rawSpeed = getRawLiveSpeed(live);
    const speed = speedKmph != null ? speedKmph : (rawSpeed != null ? rawSpeed : null);
    const movement = String(live?.movement || "").toLowerCase();
    const isStationary = speed === 0 || movement === "stationary";

    if (!isStationary) {
        return {
            movementState: freshnessState === "FRESH" ? "LIVE_MOVING" : "ESTIMATED",
            stopType: null,
            isStop: false,
            degraded: false
        };
    }

    // Train is stationary (speed === 0 or stationary movement).
    // Determine whether stopped at known scheduled station or unexpected intermediate halt:
    const trainKm = getTrainPositionKm(trainPosition);
    const route = Array.isArray(live?.route) ? live.route : [];
    const stationCode = String(live?.currentLocation?.stationCode || "").toUpperCase();

    const isAtStation = route.some(st => {
        const code = String(st.stationCode || st.code || "").toUpperCase();
        if (stationCode && code && code === stationCode) return true;
        const stKm = toNumber(st.distance ?? st.km ?? st.positionKm);
        if (Number.isFinite(trainKm) && Number.isFinite(stKm)) {
            return Math.abs(trainKm - stKm) <= 0.6; // Station platform vicinity
        }
        return false;
    });

    if (isAtStation) {
        return {
            movementState: "LIVE_STATIONARY",
            stopType: "KNOWN_STATION_STOP",
            isStop: true,
            degraded: false,
            stationCode: stationCode || null,
            reason: "Legitimate stop at scheduled station"
        };
    }

    // Otherwise: Unexpected Intermediate Stop (siding, loop, signal between stations)
    return {
        movementState: "LIVE_STATIONARY",
        stopType: "UNEXPECTED_INTERMEDIATE_STOP",
        isStop: true,
        degraded: true,
        reason: "Unexpected stop between stations; timetable ETA degraded"
    };
}

function getConsecutiveSamePositionCount(
    trainNumber,
    trainPosition
) {
    /**
     * This function intentionally remains compatible with the existing
     * observer if it is attached to global/module state.
     *
     * The ETA engine itself does not maintain train history.
     */
    try {
        if (
            typeof global.getConsecutiveSamePositionCount ===
            "function"
        ) {
            return global.getConsecutiveSamePositionCount(
                trainNumber,
                trainPosition
            );
        }
    } catch (_) {
        // Ignore compatibility lookup failures.
    }

    return 0;
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

    const stale = isPositionStale(
        trainPosition,
        live
    );

    return {
        stale,
        repeatedCount
    };
}

// -----------------------------------------------------------------------------
// Station anchor helpers
// -----------------------------------------------------------------------------

/**
 * Station timing can be useful, but only when the station is actually
 * physically relevant to the train's current route sequence.
 *
 * We NEVER use station.distance against trainPositionKm here.
 */
function findStationAnchor(
    live,
    trainPosition,
    crossing,
    direction = "forward"
) {
    const stations = getRouteStations(live);

    if (!stations.length) {
        return null;
    }

    const currentSequence = getCurrentRouteSequence(
        live,
        trainPosition
    );

    if (currentSequence === null) {
        return null;
    }

    const dir = getDirection(direction);

    const sorted = stations
        .map((station, index) => ({
            station,
            index,
            sequence: toNumber(
                firstDefined(
                    station?.sequence,
                    station?.routeSequence,
                    station?.sequenceNumber,
                    index
                )
            )
        }))
        .filter(item => item.sequence !== null)
        .sort((a, b) => a.sequence - b.sequence);

    if (!sorted.length) {
        return null;
    }

    let candidate = null;

    if (dir === "backward") {
        const possible = sorted.filter(
            item => item.sequence <= currentSequence
        );

        if (possible.length) {
            candidate = possible[possible.length - 1];
        }
    } else {
        const possible = sorted.filter(
            item => item.sequence >= currentSequence
        );

        if (possible.length) {
            candidate = possible[0];
        }
    }

    if (!candidate) {
        return null;
    }

    const station = candidate.station;

    const stationTime = getStationAnchorTime(
        station,
        live
    );

    if (!stationTime) {
        return null;
    }

    const now = new Date();

    const ageMinutes = minutesBetween(
        stationTime,
        now
    );

    /**
     * A future station time may be useful.
     * A station time far in the past is not.
     */
    if (
        ageMinutes < -MAX_FUTURE_ANCHOR_MINUTES
    ) {
        return null;
    }

    return {
        station,
        sequence: candidate.sequence,
        stationTime,
        source: "route-sequence-station-anchor"
    };
}

function getStationAnchorTime(station, live = null) {
    if (!station) return null;

    // 1. Actual recorded times
    const actualCandidates = [
        station?.actualArrival,
        station?.actualArrivalTime,
        station?.actualDeparture,
        station?.actualDepartureTime
    ];

    for (const value of actualCandidates) {
        const date = normalizeDate(value);
        if (date) {
            return date;
        }
    }

    // 2. Explicit expected/estimated times
    const expectedCandidates = [
        station?.expectedArrivalTime,
        station?.estimatedArrivalTime,
        station?.expectedDepartureTime,
        station?.estimatedDepartureTime,
        station?.eta
    ];

    for (const value of expectedCandidates) {
        const date = normalizeDate(value);
        if (date) {
            return date;
        }
    }

    // 3. Scheduled timetable with delay added
    const scheduledCandidates = [
        station?.scheduledArrival,
        station?.scheduledArrivalTime,
        station?.arrival,
        station?.arrivalTime,
        station?.scheduledDeparture,
        station?.scheduledDepartureTime,
        station?.departure,
        station?.departureTime
    ];

    const delayMinutes = Number(
        station?.delayMinutes ??
        station?.delayArrival ??
        station?.delayDeparture ??
        live?.delayMinutes ??
        live?.currentLocation?.delayMinutes ??
        0
    );

    for (const value of scheduledCandidates) {
        const date = normalizeDate(value);
        if (date) {
            if (Number.isFinite(delayMinutes) && delayMinutes !== 0) {
                return new Date(date.getTime() + delayMinutes * 60000);
            }
            return date;
        }
    }

    return null;
}

function getStationAnchorTimeType(station) {
    if (!station) return null;

    if (
        station.actualArrival ||
        station.actualArrivalTime ||
        station.actualDeparture ||
        station.actualDepartureTime
    ) {
        return "actual";
    }

    if (
        station.scheduledArrival ||
        station.scheduledArrivalTime ||
        station.scheduledDeparture ||
        station.scheduledDepartureTime
    ) {
        return "scheduled";
    }

    if (station.eta) {
        return "eta";
    }

    return null;
}

function isUsableAnchorTime(
    anchorTime,
    now = new Date()
) {
    if (!anchorTime) {
        return false;
    }

    const date = normalizeDate(anchorTime);

    if (!date) {
        return false;
    }

    const minutesFromNow = minutesBetween(
        now,
        date
    );

    return (
        minutesFromNow >= -2 &&
        minutesFromNow <= MAX_FUTURE_ANCHOR_MINUTES
    );
}

// -----------------------------------------------------------------------------
// Physical sanity checks
// -----------------------------------------------------------------------------

/**
 * Absolute minimum time based on maximum physically allowed speed.
 *
 * Example:
 * 51.236 km / 140 km/h = ~21.96 minutes.
 *
 * Therefore an ETA of 1.8 minutes is impossible and MUST be rejected.
 */
function getMinimumPhysicalMinutes(
    distanceKm
) {
    if (
        !Number.isFinite(distanceKm) ||
        distanceKm <= 0
    ) {
        return 0;
    }

    return (
        (distanceKm / MAX_SPEED_KMPH) *
        60
    );
}

function passesPhysicalSanityCheck(
    distanceKm,
    etaMinutes
) {
    if (
        !Number.isFinite(distanceKm) ||
        !Number.isFinite(etaMinutes)
    ) {
        return false;
    }

    if (distanceKm <= 0) {
        return etaMinutes >= 0;
    }

    const minimumMinutes =
        getMinimumPhysicalMinutes(
            distanceKm
        );

    return (
        etaMinutes >=
        minimumMinutes *
        PHYSICAL_SANITY_TOLERANCE
    );
}

function rejectImpossibleETA(
    distanceKm,
    etaMinutes
) {
    if (
        !passesPhysicalSanityCheck(
            distanceKm,
            etaMinutes
        )
    ) {
        return {
            valid: false,
            reason:
                "physical-sanity-check-failed",
            minimumPhysicalMinutes:
                getMinimumPhysicalMinutes(
                    distanceKm
                ),
            calculatedMinutes: etaMinutes
        };
    }

    return {
        valid: true
    };
}

// -----------------------------------------------------------------------------
// ETA calculations
// -----------------------------------------------------------------------------

/**
 * Primary calculation:
 *
 * current geometry position
 * +
 * trustworthy live speed
 *
 * This is the cleanest calculation when live position is usable.
 */
function calculateFromLivePosition({
    trainPosition,
    crossing,
    direction = "forward",
    live,
    now = new Date()
}) {
    const distanceKm = getDistanceToCrossing(
        trainPosition,
        crossing,
        direction
    );

    if (
        distanceKm === null ||
        distanceKm < 0
    ) {
        return null;
    }

    const liveSpeed = getLiveSpeed(live);

    if (liveSpeed === null) {
        return null;
    }

    const etaMinutes =
        (distanceKm / liveSpeed) * 60;

    const sanity = rejectImpossibleETA(
        distanceKm,
        etaMinutes
    );

    if (!sanity.valid) {
        return null;
    }

    const passageTime = addMinutes(
        now,
        etaMinutes
    );

    return {
        passageTime,
        etaMinutes,
        distanceKm,
        speedKmph: liveSpeed,

        source: "LIVE_GPS",
        method: "live-position-speed",
        confidence: "HIGH",

        stalePosition: false,

        physicalSanityPassed: true,

        minimumPhysicalMinutes:
            getMinimumPhysicalMinutes(
                distanceKm
            )
    };
}

/**
 * Fallback for stale/low-speed live position.
 *
 * IMPORTANT:
 * We calculate from CURRENT observed geometry position and CURRENT time.
 *
 * We do NOT use an old station timestamp to pretend the train is still
 * at that station.
 */
function calculateFromRouteSpeed({
    trainPosition,
    crossing,
    direction = "forward",
    live,
    now = new Date(),
    stalePosition = false
}) {
    const distanceKm = getDistanceToCrossing(
        trainPosition,
        crossing,
        direction
    );

    if (
        distanceKm === null ||
        distanceKm < 0
    ) {
        return null;
    }

    const routeSpeed =
        getRouteSegmentSpeed(
            live,
            trainPosition,
            direction
        );

    let speedKmph =
        routeSpeed?.speedKmph ??
        DEFAULT_SPEED_KMPH;

    speedKmph = clamp(
        speedKmph,
        MIN_SPEED_KMPH,
        MAX_SPEED_KMPH
    );

    const etaMinutes =
        (distanceKm / speedKmph) * 60;

    const sanity = rejectImpossibleETA(
        distanceKm,
        etaMinutes
    );

    if (!sanity.valid) {
        return null;
    }

    const passageTime = addMinutes(
        now,
        etaMinutes
    );

    return {
        passageTime,
        etaMinutes,
        distanceKm,
        speedKmph,

        source:
            stalePosition
                ? "RECENT_TELEMETRY"
                : (routeSpeed.source === "default-speed" ? "ROUTE_INTERPOLATION" : "RECENT_TELEMETRY"),

        method:
            stalePosition
                ? "stale-position-route-speed"
                : routeSpeed.source,

        confidence:
            stalePosition
                ? "LOW"
                : (routeSpeed.source === "default-speed" ? "LOW" : "MEDIUM"),

        stalePosition,

        physicalSanityPassed: true,

        minimumPhysicalMinutes:
            getMinimumPhysicalMinutes(
                distanceKm
            ),

        anchorStation:
            routeSpeed.station
                ? firstDefined(
                    routeSpeed.station.name,
                    routeSpeed.station.stationName,
                    routeSpeed.station.code
                )
                : null
    };
}

/**
 * Station-anchor calculation.
 *
 * This is intentionally a SECONDARY fallback only.
 *
 * The anchor must be:
 * - route-sequence compatible
 * - time-compatible
 * - physically compatible with the train→crossing distance
 */
function calculateFromStationAnchor({
    trainPosition,
    crossing,
    direction = "forward",
    live,
    now = new Date()
}) {
    const distanceKm = getDistanceToCrossing(
        trainPosition,
        crossing,
        direction
    );

    if (
        distanceKm === null ||
        distanceKm < 0
    ) {
        return null;
    }

    const anchor = findStationAnchor(
        live,
        trainPosition,
        crossing,
        direction
    );

    if (!anchor) {
        return null;
    }

    const anchorTime =
        normalizeDate(
            anchor.stationTime
        );

    if (
        !isUsableAnchorTime(
            anchorTime,
            now
        )
    ) {
        return null;
    }

    const routeSpeed =
        getSpeedFromStation(
            anchor.station
        ) ??
        DEFAULT_SPEED_KMPH;

    const speedKmph = clamp(
        routeSpeed,
        MIN_SPEED_KMPH,
        MAX_SPEED_KMPH
    );

    /**
     * We deliberately calculate remaining travel time from NOW.
     *
     * The anchor is used only as contextual validation.
     *
     * This avoids the exact failure where an old station timestamp
     * produces an impossible 1.8-minute ETA.
     */
    const transitMinutes = (distanceKm / speedKmph) * 60;
    const nowMs = now.getTime();
    const anchorMs = anchorTime.getTime();

    let passageTime;
    let etaMinutes;

    if (anchorMs > nowMs) {
        passageTime = addMinutes(anchorTime, transitMinutes);
        etaMinutes = Math.max(0, (passageTime.getTime() - nowMs) / 60000);
    } else {
        passageTime = addMinutes(now, transitMinutes);
        etaMinutes = transitMinutes;
    }

    const sanity = rejectImpossibleETA(
        distanceKm,
        etaMinutes
    );

    if (!sanity.valid) {
        return null;
    }

    const isActual = Boolean(
        anchor.station?.actualDeparture ||
        anchor.station?.actualArrival ||
        anchor.station?.actualDepartureTime ||
        anchor.station?.hasDeparted ||
        live?.route?.[0]?.actualDeparture
    );

    return {
        passageTime,
        etaMinutes,
        distanceKm,
        speedKmph,

        source: isActual ? "ACTUAL_DEPARTURE" : "SCHEDULE_ESTIMATE",
        method: "sequence-station-route-speed",
        confidence: isActual ? "MEDIUM" : "LOW",

        stalePosition:
            isPositionStale(
                trainPosition,
                live,
                now
            ),

        physicalSanityPassed: true,

        minimumPhysicalMinutes:
            getMinimumPhysicalMinutes(
                distanceKm
            ),

        anchorStation:
            firstDefined(
                anchor.station?.name,
                anchor.station?.stationName,
                anchor.station?.code
            ),

        anchorSequence:
            anchor.sequence,

        anchorTime,

        anchorTimeType:
            getStationAnchorTimeType(
                anchor.station
            )
    };
}

// -----------------------------------------------------------------------------
// Main ETA API
// -----------------------------------------------------------------------------

/**
 * Main public ETA function.
 *
 * Compatibility is intentionally broad because the monitor has evolved
 * through several versions.
 */
function calculateETA(
    trainPosition,
    crossing,
    direction = "forward",
    live = null,
    now = new Date()
) {
    // -------------------------------------------------------------------------
    // Normalize alternate calling styles
    // -------------------------------------------------------------------------

    if (
        trainPosition &&
        typeof trainPosition === "object" &&
        !Array.isArray(trainPosition) &&
        (
            trainPosition.trainPosition ||
            trainPosition.crossing ||
            trainPosition.live
        )
    ) {
        const options = trainPosition;

        return estimateTrainPassage({
            trainPosition:
                options.trainPosition ??
                options.position ??
                null,

            crossing:
                options.crossing ??
                null,

            direction:
                options.direction ??
                "forward",

            live:
                options.live ??
                null,

            now:
                normalizeDate(
                    options.now
                ) ?? new Date()
        });
    }

    const normalizedDirection =
        getDirection(direction);

if (normalizedDirection === null) {
    return {
        available: false,
        reason: "unknown-direction",
        distanceKm: null,
        source: "unavailable",
        confidence: "low",
        telemetryFreshness: "UNAVAILABLE",
        movementState: "UNKNOWN"
    };
}

    const currentTime =
        normalizeDate(now) ??
        new Date();

    // -------------------------------------------------------------------------
    // 0. Telemetry Freshness & Availability Check
    // -------------------------------------------------------------------------
    const freshness = getTelemetryFreshness(trainPosition, live, currentTime);

    // If telemetry > 10m old or completely absent: suppress live ETA
    if (freshness.state === "UNAVAILABLE") {
        const rawDistance = getDistanceToCrossing(
            trainPosition,
            crossing,
            normalizedDirection
        );
        return {
            available: false,
            reason: "telemetry-unavailable-or-expired",
            distanceKm: rawDistance,
            source: "unavailable",
            confidence: "low",
            telemetryFreshness: "UNAVAILABLE",
            telemetryAgeMinutes: freshness.ageMinutes,
            movementState: "UNKNOWN"
        };
    }

    const distanceKm =
        getDistanceToCrossing(
            trainPosition,
            crossing,
            normalizedDirection
        );

    if (
        distanceKm === null ||
        distanceKm < -0.05
    ) {
        return {
            available: false,
            reason: "invalid-or-past-crossing",
            distanceKm,
            telemetryFreshness: freshness.state,
            telemetryAgeMinutes: freshness.ageMinutes,
            movementState: "UNKNOWN"
        };
    }

    // -------------------------------------------------------------------------
    // 1. Movement State & Unexpected Intermediate Stop Classification
    // -------------------------------------------------------------------------
    const rawSpeed = getRawLiveSpeed(live);
    const movement = classifyTrainMovement(live, trainPosition, rawSpeed, freshness.state);

    // Unexpected intermediate stop (siding, loop, signal between stations)
    if (movement.stopType === "UNEXPECTED_INTERMEDIATE_STOP") {
        const routeEstimate = calculateFromRouteSpeed({
            trainPosition,
            crossing,
            direction: normalizedDirection,
            live,
            now: currentTime,
            stalePosition: false
        });

        if (routeEstimate) {
            return {
                available: true,
                ...routeEstimate,
                source: freshness.state === "FRESH" ? "LIVE_GPS" : "RECENT_TELEMETRY",
                confidence: "DEGRADED",
                degradedConfidence: true,
                movementState: "LIVE_STATIONARY",
                stopType: "UNEXPECTED_INTERMEDIATE_STOP",
                unexpectedHalt: true,
                telemetryFreshness: freshness.state,
                telemetryAgeMinutes: freshness.ageMinutes
            };
        }
    }

    // -------------------------------------------------------------------------
    // 2. Fresh + trustworthy live speed (FRESH and moving)
    // -------------------------------------------------------------------------
    if (freshness.state === "FRESH" && movement.movementState !== "LIVE_STATIONARY") {
        const liveEstimate =
            calculateFromLivePosition({
                trainPosition,
                crossing,
                direction:
                    normalizedDirection,
                live,
                now: currentTime
            });

        if (liveEstimate) {
            return {
                available: true,
                ...liveEstimate,
                source: "LIVE_GPS",
                confidence: "HIGH",
                telemetryFreshness: freshness.state,
                telemetryAgeMinutes: freshness.ageMinutes,
                movementState: movement.movementState,
                stopType: movement.stopType
            };
        }
    }

    // -------------------------------------------------------------------------
    // 3. Aging telemetry with live speed
    // -------------------------------------------------------------------------
    if (freshness.state === "AGING" && movement.movementState !== "LIVE_STATIONARY") {
        const liveEstimate =
            calculateFromLivePosition({
                trainPosition,
                crossing,
                direction:
                    normalizedDirection,
                live,
                now: currentTime
            });

        if (liveEstimate) {
            return {
                available: true,
                ...liveEstimate,
                source: "RECENT_TELEMETRY",
                confidence: "MEDIUM",
                telemetryFreshness: freshness.state,
                telemetryAgeMinutes: freshness.ageMinutes,
                movementState: movement.movementState,
                stopType: movement.stopType
            };
        }
    }

    // -------------------------------------------------------------------------
    // 4. Route speed fallback (for AGING, STALE, or station stops)
    // -------------------------------------------------------------------------
    if (freshness.state !== "UNAVAILABLE") {
        const isStale = freshness.state === "STALE";
        const routeEstimate =
            calculateFromRouteSpeed({
                trainPosition,
                crossing,
                direction:
                    normalizedDirection,
                live,
                now: currentTime,
                stalePosition: isStale
            });

        if (routeEstimate) {
            let conf = "MEDIUM";
            if (isStale) {
                conf = "LOW";
            } else if (movement.movementState === "LIVE_STATIONARY") {
                conf = movement.stopType === "UNEXPECTED_INTERMEDIATE_STOP" ? "DEGRADED" : "MEDIUM";
            }

            return {
                available: true,
                ...routeEstimate,
                source: isStale ? "RECENT_TELEMETRY" : (routeEstimate.source || "RECENT_TELEMETRY"),
                confidence: conf,
                telemetryFreshness: freshness.state,
                telemetryAgeMinutes: freshness.ageMinutes,
                movementState: movement.movementState,
                stopType: movement.stopType
            };
        }
    }

    // -------------------------------------------------------------------------
    // 5. Sequence-compatible station fallback
    // -------------------------------------------------------------------------
    const stationEstimate =
        calculateFromStationAnchor({
            trainPosition,
            crossing,
            direction:
                normalizedDirection,
            live,
            now: currentTime
        });

    if (stationEstimate) {
        return {
            available: true,
            ...stationEstimate,
            telemetryFreshness: freshness.state,
            telemetryAgeMinutes: freshness.ageMinutes,
            movementState: movement.movementState,
            stopType: movement.stopType
        };
    }

    // -------------------------------------------------------------------------
    // 6. Nothing reliable enough
    // -------------------------------------------------------------------------
    return {
        available: false,
        reason:
            "no-physically-valid-eta",
        distanceKm,
        stalePosition: freshness.state === "STALE",
        telemetryFreshness: freshness.state,
        telemetryAgeMinutes: freshness.ageMinutes,
        movementState: movement.movementState,
        source: "unavailable",
        confidence: "low"
    };
}

/**
 * ETA with optional closure lead-time buffer.
 *
 * Existing project code may call this function.
 */
function calculateETAWithBuffer(
    trainPosition,
    crossing,
    direction = "forward",
    live = null,
    bufferMinutes = 0,
    now = new Date()
) {
    const result = calculateETA(
        trainPosition,
        crossing,
        direction,
        live,
        now
    );

    if (!result?.available) {
        return result;
    }

    const safeBuffer =
        Number.isFinite(Number(bufferMinutes))
            ? Number(bufferMinutes)
            : 0;

    return {
        ...result,

        closureStartTime:
            addMinutes(
                result.passageTime,
                -safeBuffer
            ),

        bufferMinutes: safeBuffer
    };
}

/**
 * Primary named API used by the corridor engine.
 */
function estimateTrainPassage({
    trainPosition,
    crossing,
    direction = "forward",
    live = null,
    now = new Date(),

    // New corridor-engine calling style
    route = null,
    crossingPositionKm = null,
    trainPositionKm = null,
    fallbackSpeedKmph = null,
    livePositionFresh = false
} = {}) {

    // -------------------------------------------------------------------------
    // Normalize the newer corridor-engine calling style
    // -------------------------------------------------------------------------

    let normalizedTrainPosition = trainPosition;
    let normalizedCrossing = crossing;

    if (
        normalizedTrainPosition === null ||
        normalizedTrainPosition === undefined
    ) {
        if (trainPositionKm !== null && trainPositionKm !== undefined) {
            normalizedTrainPosition = {
                km: trainPositionKm,
                positionKm: trainPositionKm,
                routeKm: trainPositionKm
            };
        }
    }

    if (
        normalizedCrossing === null ||
        normalizedCrossing === undefined
    ) {
        if (
            crossingPositionKm !== null &&
            crossingPositionKm !== undefined
        ) {
            normalizedCrossing = {
                railwayPositionKm: crossingPositionKm,
                positionKm: crossingPositionKm,
                routePositionKm: crossingPositionKm
            };
        }
    }

    // Preserve the original crossing ID when available.
    if (
        normalizedCrossing &&
        typeof normalizedCrossing === "object" &&
        crossing?.id
    ) {
        normalizedCrossing = {
            ...normalizedCrossing,
            id: crossing.id
        };
    }

    const result = calculateETA(
        normalizedTrainPosition,
        normalizedCrossing,
        direction,
        live,
        normalizeDate(now) ?? new Date()
    );

    if (!result?.available) {
        return {
            ready: false,
            available: false,

            crossingId:
                normalizedCrossing?.id ??
                normalizedCrossing?.crossingId ??
                null,

            reason:
                result?.reason ??
                "eta-unavailable",

            distanceKm:
                result?.distanceKm ??
                null,

            source:
                result?.source ??
                "unavailable",

            confidence:
                result?.confidence ??
                "low",

            telemetryFreshness:
                result?.telemetryFreshness ??
                "UNAVAILABLE",

            telemetryAgeMinutes:
                result?.telemetryAgeMinutes ??
                null,

            movementState:
                result?.movementState ??
                "UNKNOWN",

            stopType:
                result?.stopType ??
                null
        };
    }

    return {
        ready: true,
        available: true,

        crossingId:
            normalizedCrossing?.id ??
            normalizedCrossing?.crossingId ??
            null,

        passageTime:
            result.passageTime,

        etaMinutes:
            result.etaMinutes,

        distanceKm:
            result.distanceKm,

        speedKmph:
            result.speedKmph ??
            fallbackSpeedKmph ??
            null,

        source:
            result.source,
        method:
            result.source,
        confidence:
            result.confidence,

        telemetryFreshness:
            result.telemetryFreshness ?? "FRESH",

        telemetryAgeMinutes:
            result.telemetryAgeMinutes ?? 0,

        movementState:
            result.movementState ?? "RUNNING",

        stopType:
            result.stopType ?? null,

        degradedConfidence:
            result.degradedConfidence ?? (result.confidence === "DEGRADED"),

        unexpectedHalt:
            Boolean(result.unexpectedHalt),

        stalePosition:
            result.stalePosition,

        physicalSanityPassed:
            result.physicalSanityPassed,

        minimumPhysicalMinutes:
            result.minimumPhysicalMinutes,

        anchorStation:
            result.anchorStation ??
            null,

        anchorSequence:
            result.anchorSequence ??
            null,

        anchorTime:
            result.anchorTime ??
            null,

        anchorTimeType:
            result.anchorTimeType ??
            null
    };
}
// -----------------------------------------------------------------------------
// Multi-crossing coherent timeline
// -----------------------------------------------------------------------------

/**
 * Build ETAs for every future crossing of the same train.
 *
 * IMPORTANT:
 * One speed basis is used for the complete train timeline wherever possible.
 *
 * This prevents:
 *
 * Jandiala 10 min
 * Rakh     34 min
 * Manawala 8 min
 *
 * type nonsense.
 */
function buildTrainTimeline({
    trainPosition,
    crossings = [],
    direction = "forward",
    live = null,
    now = new Date()
} = {}) {
    const dir =
        getDirection(direction);

    const currentPositionKm =
        getTrainPositionKm(
            trainPosition
        );

    if (
        currentPositionKm === null
    ) {
        return [];
    }

    let futureCrossings =
        crossings
            .map((crossing, index) => ({
                crossing,
                index,
                distanceKm:
                    getDistanceToCrossing(
                        trainPosition,
                        crossing,
                        dir
                    )
            }))
            .filter(item =>
                item.distanceKm !== null &&
                item.distanceKm >= -0.05
            );

    /**
     * Physical route order.
     */
    futureCrossings.sort((a, b) => {
        return a.distanceKm -
            b.distanceKm;
    });

    if (!futureCrossings.length) {
        return [];
    }

    /**
     * First calculate ONE coherent speed basis.
     */
    const liveSpeed =
        getLiveSpeed(live);

    const routeSpeedInfo =
        getRouteSegmentSpeed(
            live,
            trainPosition,
            dir
        );

    let timelineSpeed = null;
    let timelineSource = null;
    let timelineConfidence = null;

    if (liveSpeed !== null) {
        timelineSpeed = liveSpeed;
        timelineSource =
            "live-position-speed";
        timelineConfidence =
            "medium";
    } else {
        timelineSpeed =
            routeSpeedInfo.speedKmph ??
            DEFAULT_SPEED_KMPH;

        timelineSource =
            routeSpeedInfo.source;

        timelineConfidence =
            routeSpeedInfo.source ===
            "default-speed"
                ? "low"
                : "medium-low";
    }

    timelineSpeed = clamp(
        timelineSpeed,
        MIN_SPEED_KMPH,
        MAX_SPEED_KMPH
    );

    /**
     * Generate the timeline from the same origin.
     */
    const timeline =
        futureCrossings.map(item => {
            const distanceKm =
                Math.max(
                    0,
                    item.distanceKm
                );

            let etaMinutes =
                (distanceKm /
                    timelineSpeed) *
                60;

            /**
             * Never allow physically impossible time.
             */
            const minimumPhysicalMinutes =
                getMinimumPhysicalMinutes(
                    distanceKm
                );

            if (
                etaMinutes <
                minimumPhysicalMinutes
            ) {
                etaMinutes =
                    minimumPhysicalMinutes;
            }

            const passageTime =
                addMinutes(
                    now,
                    etaMinutes
                );

            return {
                ...item.crossing,

                crossingId:
                    item.crossing?.id ??
                    item.crossing?.crossingId ??
                    null,

                distanceKm,

                etaMinutes,

                passageTime,

                speedKmph:
                    timelineSpeed,

                source:
                    timelineSource,

                confidence:
                    timelineConfidence,

                physicalSanityPassed:
                    true,

                minimumPhysicalMinutes
            };
        });

    /**
     * Final monotonicity guard.
     *
     * If two crossings somehow end up with equal/reversed timestamps
     * because of upstream data, force the timestamp to respect physical
     * route order using the same speed basis.
     */
    for (let i = 1; i < timeline.length; i++) {
        const previous =
            timeline[i - 1];

        const current =
            timeline[i];

        if (
            current.passageTime <
            previous.passageTime
        ) {
            const distanceDelta =
                Math.max(
                    0,
                    current.distanceKm -
                    previous.distanceKm
                );

            const additionalMinutes =
                (distanceDelta /
                    timelineSpeed) *
                60;

            current.etaMinutes =
                previous.etaMinutes +
                additionalMinutes;

            current.passageTime =
                addMinutes(
                    now,
                    current.etaMinutes
                );
        }
    }

    return timeline;
}

/**
 * Validate an already-created timeline.
 */
function validateTrainTimeline(
    timeline = [],
    direction = "forward"
) {
    if (!Array.isArray(timeline)) {
        return {
            valid: false,
            reason: "timeline-not-array"
        };
    }

    if (timeline.length <= 1) {
        return {
            valid: true,
            reason: null
        };
    }

    const dir =
        getDirection(direction);

    for (let i = 1; i < timeline.length; i++) {
        const previous =
            timeline[i - 1];

        const current =
            timeline[i];

        const previousDistance =
            toNumber(
                previous.distanceKm
            );

        const currentDistance =
            toNumber(
                current.distanceKm
            );

        const previousTime =
            normalizeDate(
                previous.passageTime
            );

        const currentTime =
            normalizeDate(
                current.passageTime
            );

        if (
            previousDistance === null ||
            currentDistance === null
        ) {
            return {
                valid: false,
                reason:
                    "missing-distance",
                index: i
            };
        }

        if (
            currentTime &&
            previousTime &&
            currentTime <
            previousTime
        ) {
            return {
                valid: false,
                reason:
                    "non-monotonic-passage-time",
                index: i,
                direction: dir
            };
        }

        if (
            currentDistance <
            previousDistance
        ) {
            return {
                valid: false,
                reason:
                    "non-monotonic-crossing-order",
                index: i,
                direction: dir
            };
        }
    }

    return {
        valid: true,
        reason: null
    };
}

// -----------------------------------------------------------------------------
// Compatibility helpers
// -----------------------------------------------------------------------------

function getETASeconds(
    trainPosition,
    crossing,
    direction = "forward",
    live = null,
    now = new Date()
) {
    const result =
        calculateETA(
            trainPosition,
            crossing,
            direction,
            live,
            now
        );

    if (!result?.available) {
        return null;
    }

    return Math.round(
        result.etaMinutes * 60
    );
}

function getETAMinutes(
    trainPosition,
    crossing,
    direction = "forward",
    live = null,
    now = new Date()
) {
    const result =
        calculateETA(
            trainPosition,
            crossing,
            direction,
            live,
            now
        );

    if (!result?.available) {
        return null;
    }

    return result.etaMinutes;
}

// -----------------------------------------------------------------------------
// Schedule baseline and early/late classification
// -----------------------------------------------------------------------------

function deriveScheduledPassage({
    estimatedPassageTime,
    delayMinutes,
    scheduledStationTime,
    transitMinutes = 0
} = {}) {
    if (estimatedPassageTime && Number.isFinite(Number(delayMinutes))) {
        const estDate = normalizeDate(estimatedPassageTime);
        if (estDate) {
            return new Date(estDate.getTime() - Number(delayMinutes) * 60000);
        }
    }
    if (scheduledStationTime) {
        const schedDate = normalizeDate(scheduledStationTime);
        if (schedDate) {
            return new Date(schedDate.getTime() + Number(transitMinutes || 0) * 60000);
        }
    }
    return null;
}

function classifyEarlyLate(predictedPassageTime, scheduledPassageTime, thresholdMinutes = 1.5) {
    if (!predictedPassageTime || !scheduledPassageTime) {
        return {
            status: "UNKNOWN",
            differenceMinutes: null,
            label: "Unknown"
        };
    }
    const predDate = normalizeDate(predictedPassageTime);
    const schedDate = normalizeDate(scheduledPassageTime);
    if (!predDate || !schedDate) {
        return {
            status: "UNKNOWN",
            differenceMinutes: null,
            label: "Unknown"
        };
    }
    const diffMinutes = (predDate.getTime() - schedDate.getTime()) / 60000;
    const roundedDiff = Math.round(diffMinutes * 10) / 10;
    if (diffMinutes < -thresholdMinutes) {
        return {
            status: "EARLY",
            differenceMinutes: roundedDiff,
            label: `${Math.abs(Math.round(roundedDiff))} min early`
        };
    }
    if (diffMinutes > thresholdMinutes) {
        return {
            status: "DELAYED",
            differenceMinutes: roundedDiff,
            label: `+${Math.round(roundedDiff)} min delay`
        };
    }
    return {
        status: "ON_TIME",
        differenceMinutes: roundedDiff,
        label: "On time"
    };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // Main APIs
    calculateETA,
    calculateETAWithBuffer,
    estimateTrainPassage,

    // Timeline
    buildTrainTimeline,
    validateTrainTimeline,

    // Position / geometry
    getTrainPositionKm,
    getCrossingPositionKm,
    getDistanceToCrossing,
    isCrossingAhead,

    // Speed
    getRawLiveSpeed,
    getLiveSpeed,
    getSpeedFromStation,
    getRouteSegmentSpeed,

    // Freshness & Hardening
    TELEMETRY_THRESHOLDS,
    getTelemetryFreshness,
    classifyTrainMovement,
    isPositionStale,
    getPositionTimestamp,
    getPositionFreshness,

    // Station
    findStationAnchor,
    getStationAnchorTime,
    getStationAnchorTimeType,
    isUsableAnchorTime,

    // Early / Late & Baseline
    deriveScheduledPassage,
    classifyEarlyLate,

    // Physics
    getMinimumPhysicalMinutes,
    passesPhysicalSanityCheck,

    // Compatibility
    getETASeconds,
    getETAMinutes
};