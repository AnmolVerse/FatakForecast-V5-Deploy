const turf = require("@turf/turf");
function findNearestPointOnRailway(
    crossing,
    geojson
) {
    if (!crossing?.coordinates) {
        throw new Error(
            `Crossing ${
                crossing?.id || "unknown"
            } has no coordinates`
        );
    }

    const railwayLine =
        buildRailwayLine(geojson);

    const crossingCoordinates =
        getCoordinates(
            crossing.coordinates,
            `Crossing ${
                crossing.id || "unknown"
            }`
        );

    const crossingPoint =
        turf.point(
            crossingCoordinates
        );

    const nearest =
        turf.nearestPointOnLine(
            railwayLine,
            crossingPoint,
            {
                units: "kilometers"
            }
        );

    return {
        crossing,

        crossingCoordinates,

        nearestRailwayPoint: {
            lat:
                nearest.geometry.coordinates[1],

            lng:
                nearest.geometry.coordinates[0]
        },

        distanceFromRailwayKm:
            Number(
                nearest.properties.dist
            ),

        locationAlongRailwayKm:
            Number(
                nearest.properties.location
            )
    };
}

// ======================================================
// BASIC HELPERS
// ======================================================

function toNumber(value) {

    const n = Number(value);

    return Number.isFinite(n)
        ? n
        : null;
}


function getCoordinates(point, label = "point") {

    const lat = toNumber(point?.lat);
    const lng = toNumber(point?.lng);

    if (lat === null || lng === null) {
        throw new Error(
            `${label} coordinates must contain numbers`
        );
    }

    return [lng, lat];
}


// ======================================================
// STATION HELPERS
// ======================================================

function getStationCode(station) {

    return String(
        station?.stationCode ??
        station?.code ??
        ""
    )
        .trim()
        .toUpperCase();
}


function getStationName(station) {

    return (
        station?.stationName ??
        station?.name ??
        null
    );
}


function getStationDistance(station) {

    return toNumber(
        station?.distance
    );
}


function getStationSequence(station) {

    return toNumber(
        station?.sequence
    );
}


// ======================================================
// ROUTE / STATION LOOKUPS
// ======================================================

function findRouteStation(
    routeStations,
    stationCode
) {

    if (!Array.isArray(routeStations)) {
        return null;
    }

    const wanted =
        String(stationCode)
            .trim()
            .toUpperCase();

    return routeStations.find(
        station =>
            getStationCode(station) === wanted
    ) || null;
}


function findCoordinateStation(
    coordinateStations,
    liveStation
) {

    if (!Array.isArray(coordinateStations)) {
        return null;
    }

    const sequence =
        getStationSequence(
            liveStation
        );

    if (sequence !== null) {

        const bySequence =
            coordinateStations.find(
                station =>
                    getStationSequence(station) ===
                    sequence
            );

        if (bySequence) {
            return bySequence;
        }
    }

    const wanted =
        getStationCode(
            liveStation
        );

    return coordinateStations.find(
        station =>
            getStationCode(station) === wanted
    ) || null;
}


// ======================================================
// RAILWAY LINE
// ======================================================

function buildRailwayLine(geojson) {

    if (
        !geojson?.geometry?.coordinates ||
        !Array.isArray(
            geojson.geometry.coordinates
        ) ||
        geojson.geometry.coordinates.length < 2
    ) {

        throw new Error(
            "Railway GeoJSON geometry is missing or invalid"
        );
    }

    return turf.lineString(
        geojson.geometry.coordinates
    );
}


// ======================================================
// GLOBAL PROJECTION
// ======================================================

function getGeometryLocation(
    coordinates,
    railwayLine
) {

    const nearest =
        turf.nearestPointOnLine(
            railwayLine,
            turf.point(coordinates),
            {
                units: "kilometers"
            }
        );

    return {

        locationKm:
            Number(
                nearest.properties.location
            ),

        distanceFromLineKm:
            Number(
                nearest.properties.dist
            )
    };
}


// ======================================================
// SEQUENCE-AWARE STATION PROJECTION
// ======================================================
//
// This is the important fix.
//
// We cannot simply do:
//
//     nearestPointOnLine(fullRoute, station)
//
// because a railway can contain geographically repeated
// or overlapping sections.
//
// Instead, route stations are processed in sequence.
//
// Once we know the previous station's position, the next
// station is only allowed to project AFTER that position.
//
// ======================================================

function projectStationAfter(
    station,
    railwayLine,
    minimumLocationKm = 0
) {

    const coordinates =
        getCoordinates(
            station,
            `Route stop ${
                getStationSequence(station) ??
                getStationName(station) ??
                "unknown"
            }`
        );


    const point =
        turf.point(
            coordinates
        );


    const nearest =
        turf.nearestPointOnLine(
            railwayLine,
            point,
            {
                units: "kilometers"
            }
        );


    const location =
        Number(
            nearest.properties.location
        );


    // Normal case.
    if (
        Number.isFinite(location) &&
        location >= minimumLocationKm
    ) {

        return {

            locationKm: location,

            distanceFromLineKm:
                Number(
                    nearest.properties.dist
                ),

            coordinate:
                nearest.geometry.coordinates
        };
    }


    // --------------------------------------------------
    // If global nearest is BEFORE the previous station,
    // search the route progressively after the previous
    // location.
    // --------------------------------------------------

    const totalLength =
        turf.length(
            railwayLine,
            {
                units: "kilometers"
            }
        );


    const searchStart =
        Math.max(
            0,
            minimumLocationKm
        );


    const searchEnd =
        totalLength;


    if (
        searchStart >= searchEnd
    ) {

        return null;
    }


    // Search in progressively smaller windows.
    //
    // This prevents jumping to an earlier occurrence.

    const windowSizes = [
        100,
        50,
        25,
        10,
        5,
        2,
        1,
        0.5
    ];


    for (
        const windowSize
        of windowSizes
    ) {

        const end =
            Math.min(
                searchStart +
                windowSize,
                searchEnd
            );


        if (
            end <= searchStart
        ) {
            continue;
        }


        const sliced =
            turf.lineSliceAlong(
                railwayLine,
                searchStart,
                end,
                {
                    units: "kilometers"
                }
            );


        const candidate =
            turf.nearestPointOnLine(
                sliced,
                point,
                {
                    units: "kilometers"
                }
            );


        const candidateLocal =
            Number(
                candidate.properties.location
            );


        const candidateAbsolute =
            searchStart +
            candidateLocal;


        const candidateDistance =
            Number(
                candidate.properties.dist
            );


        if (
            Number.isFinite(
                candidateAbsolute
            )
        ) {

            return {

                locationKm:
                    candidateAbsolute,

                distanceFromLineKm:
                    candidateDistance,

                coordinate:
                    candidate.geometry.coordinates
            };
        }
    }


    return null;
}


// ======================================================
// BUILD SEQUENCE-AWARE STATION MAP
// ======================================================

function buildSequenceAwareStationMap(
    routeData
) {

    const stops =
        Array.isArray(
            routeData?.stops
        )
            ? routeData.stops
            : [];


    const geojson =
        routeData?.geojson;


    if (
        !geojson?.geometry?.coordinates?.length ||
        stops.length === 0
    ) {

        return new Map();
    }


    const railwayLine =
        buildRailwayLine(
            geojson
        );


    const sortedStops =
        [...stops]
            .filter(
                stop =>
                    Number.isFinite(
                        getStationSequence(
                            stop
                        )
                    )
            )
            .sort(
                (
                    a,
                    b
                ) =>
                    getStationSequence(a) -
                    getStationSequence(b)
            );


    const result =
        new Map();


    let previousLocationKm =
        0;


    for (
        const stop
        of sortedStops
    ) {

        const sequence =
            getStationSequence(
                stop
            );


        const projected =
            projectStationAfter(
                stop,
                railwayLine,
                previousLocationKm
            );


        if (!projected) {
            continue;
        }


        result.set(
            sequence,
            {

                ...projected,

                station:
                    stop,

                sequence
            }
        );


        previousLocationKm =
            projected.locationKm;
    }


    return result;
}


// ======================================================
// TRAIN POSITION
// ======================================================

function resolveTrainGeometryPosition(
    live,
    routeData
) {

    const geojson =
        routeData?.geojson;


    const stops =
        Array.isArray(
            routeData?.stops
        )
            ? routeData.stops
            : [];


    if (
        !geojson?.geometry?.coordinates?.length
    ) {

        return {

            positionKm: null,

            source:
                "unavailable-no-geojson"
        };
    }


    const current =
        live?.currentLocation;


    const sequence =
        Number(
            current?.sequence
        );


    if (
        !Number.isFinite(
            sequence
        )
    ) {

        return {

            positionKm: null,

            source:
                "unavailable-no-sequence"
        };
    }


    const currentStop =
        stops.find(
            stop =>
                Number(
                    stop?.sequence
                ) === sequence
        );


    if (!currentStop) {

        return {

            positionKm: null,

            source:
                "unavailable-current-stop"
        };
    }


    const railwayLine =
        buildRailwayLine(
            geojson
        );


    // --------------------------------------------------
    // Build sequence-aware map.
    // --------------------------------------------------

    const stationMap =
        buildSequenceAwareStationMap(
            routeData
        );


    const currentProjected =
        stationMap.get(
            sequence
        );


    if (!currentProjected) {

        return {

            positionKm: null,

            source:
                "unavailable-current-projection"
        };
    }


    const currentLocationKm =
        currentProjected.locationKm;


    let locationKm =
        currentLocationKm;


    let source =
        "live-route-station-geometry";


    // --------------------------------------------------
    // NEXT STATION
    // --------------------------------------------------

    const nextStop =
        stops.find(
            stop =>
                Number(
                    stop?.sequence
                ) ===
                sequence + 1
        );


    const nextProjected =
        stationMap.get(
            sequence + 1
        );


    const progress =
        Number(
            current?.segmentProgress
        );


    // --------------------------------------------------
    // SEGMENT PROGRESS
    // --------------------------------------------------

    if (
        nextStop &&
        nextProjected &&
        Number.isFinite(progress) &&
        progress >= 0 &&
        progress <= 1 &&
        nextProjected.locationKm >=
            currentLocationKm
    ) {

        locationKm =
            currentLocationKm +
            (
                nextProjected.locationKm -
                currentLocationKm
            ) *
            progress;


        source =
            "live-route-geometry-segment-progress";
    }


    const coordinate =
        turf.along(
            railwayLine,
            locationKm,
            {
                units:
                    "kilometers"
            }
        )
            .geometry
            .coordinates;


    return {

        positionKm:
            locationKm,

        source,

        coordinate: {

            lat:
                coordinate[1],

            lng:
                coordinate[0]
        },

        distanceFromTrackKm:
            currentProjected.distanceFromLineKm
    };
}


// ======================================================
// BUILD GEOJSON ROUTE
// ======================================================
//
// IMPORTANT:
//
// This now uses the sequence-aware station map instead
// of independently projecting every station globally.
// ======================================================

function buildGeometryRoute(
    liveRouteStations,
    routeData
) {

    if (
        !Array.isArray(
            liveRouteStations
        )
    ) {

        return [];
    }


    const stationMap =
        buildSequenceAwareStationMap(
            routeData
        );


    return liveRouteStations
        .map(
            station => {

                const sequence =
                    Number(
                        station?.sequence
                    );


                const projected =
                    stationMap.get(
                        sequence
                    );


                if (!projected) {
                    return null;
                }


                return {

                    ...station,

                    distance:
                        projected.locationKm,

                    geometryDistanceKm:
                        projected.locationKm,

                    railRadarDistanceKm:
                        getStationDistance(
                            station
                        )
                };
            }
        )
        .filter(Boolean);
}


// ======================================================
// CROSSING PROJECTION INSIDE JNL ↔ MOW
// ======================================================
//
// First obtain JNL and MOW from the sequence-aware map.
//
// Then slice EXACTLY between their GeoJSON positions.
//
// Finally project each crossing only inside that slice.
//
// ======================================================

function getCrossingRouteDistance(
    crossing,
    geojson,
    liveRouteStations,
    coordinateStations,
    startStationCode = "JNL",
    endStationCode = "MOW"
) {

    if (!crossing?.coordinates) {

        throw new Error(
            `Crossing ${
                crossing?.id ||
                "unknown"
            } has no coordinates`
        );
    }


    const routeData = {

        geojson,

        stops:
            Array.isArray(
                coordinateStations
            )
                ? coordinateStations
                : []
    };


    const railwayLine =
        buildRailwayLine(
            geojson
        );


    let liveStart =
        findRouteStation(
            liveRouteStations,
            startStationCode
        );

    if (!liveStart && startStationCode === "JNL") {
        liveStart = findRouteStation(liveRouteStations, "BEAS") ||
                    findRouteStation(liveRouteStations, "JUC") ||
                    findRouteStation(liveRouteStations, "ASR");
    }

    let liveEnd =
        findRouteStation(
            liveRouteStations,
            endStationCode
        );

    if (!liveEnd && endStationCode === "MOW") {
        liveEnd = findRouteStation(liveRouteStations, "ASR") ||
                  findRouteStation(liveRouteStations, "JNL");
    }

    if (
        !liveStart ||
        !liveEnd
    ) {

        return null;
    }


    // --------------------------------------------------
    // Sequence-aware station positions
    // --------------------------------------------------

    const stationMap =
        buildSequenceAwareStationMap(
            routeData
        );


    const startSequence =
        getStationSequence(
            liveStart
        );


    const endSequence =
        getStationSequence(
            liveEnd
        );


    let startProjected =
        stationMap.get(
            startSequence
        );


    let endProjected =
        stationMap.get(
            endSequence
        );


    // --------------------------------------------------
    // Fallback if coordinateStations don't contain
    // sequence metadata.
    // --------------------------------------------------

    if (
        !startProjected
    ) {

        const startCoordinate =
            findCoordinateStation(
                coordinateStations,
                liveStart
            );


        if (startCoordinate) {

            const projected =
                getGeometryLocation(
                    getCoordinates(
                        startCoordinate,
                        startStationCode
                    ),
                    railwayLine
                );


            startProjected = {

                locationKm:
                    projected.locationKm,

                distanceFromLineKm:
                    projected.distanceFromLineKm
            };
        }
    }


    if (
        !endProjected
    ) {

        const endCoordinate =
            findCoordinateStation(
                coordinateStations,
                liveEnd
            );


        if (endCoordinate) {

            const projected =
                getGeometryLocation(
                    getCoordinates(
                        endCoordinate,
                        endStationCode
                    ),
                    railwayLine
                );


            endProjected = {

                locationKm:
                    projected.locationKm,

                distanceFromLineKm:
                    projected.distanceFromLineKm
            };
        }
    }


    if (
        !startProjected ||
        !endProjected
    ) {

        return null;
    }


    const geometryStartKm =
        startProjected.locationKm;


    const geometryEndKm =
        endProjected.locationKm;


    // --------------------------------------------------
    // Corridor
    // --------------------------------------------------

    const corridorStartKm =
        Math.min(
            geometryStartKm,
            geometryEndKm
        );


    const corridorEndKm =
        Math.max(
            geometryStartKm,
            geometryEndKm
        );


    if (
        corridorEndKm -
        corridorStartKm <
        0.001
    ) {

        return null;
    }


    const corridorLine =
        turf.lineSliceAlong(
            railwayLine,
            corridorStartKm,
            corridorEndKm,
            {
                units:
                    "kilometers"
            }
        );


    // --------------------------------------------------
    // Crossing
    // --------------------------------------------------

    const crossingCoordinates =
        getCoordinates(
            crossing.coordinates,
            `Crossing ${
                crossing.id
            }`
        );


    const crossingProjection =
        turf.nearestPointOnLine(
            corridorLine,
            turf.point(
                crossingCoordinates
            ),
            {
                units:
                    "kilometers"
            }
        );


    const localLocationKm =
        Number(
            crossingProjection
                .properties
                .location
        );


    const geometryCrossingKm =
        corridorStartKm +
        localLocationKm;


    const railwayDistanceKm =
        Number(
            crossingProjection
                .properties
                .dist
        );


    const geometrySpanKm =
        corridorEndKm -
        corridorStartKm;


    const fraction =
        Math.abs(
            geometryCrossingKm -
            geometryStartKm
        ) /
        geometrySpanKm;


    // --------------------------------------------------
    // SAFETY
    // --------------------------------------------------

    if (
        fraction < -0.05 ||
        fraction > 1.05
    ) {

        return null;
    }


    return {

        crossingId:
            crossing.id,

        id:
            crossing.id,

        crossingName:
            crossing.name,

        routeDistanceKm:
            Number(
                geometryCrossingKm
                    .toFixed(3)
            ),

        crossingPositionKm:
            Number(
                geometryCrossingKm
                    .toFixed(3)
            ),

        crossingRailwayPositionKm:
            Number(
                geometryCrossingKm
                    .toFixed(3)
            ),

        railRadarStartDistanceKm:
            getStationDistance(
                liveStart
            ),

        railRadarEndDistanceKm:
            getStationDistance(
                liveEnd
            ),

        anchorStart: {

            stationCode:
                getStationCode(
                    liveStart
                ),

            stationName:
                getStationName(
                    liveStart
                ),

            distanceKm:
                geometryStartKm
        },

        anchorEnd: {

            stationCode:
                getStationCode(
                    liveEnd
                ),

            stationName:
                getStationName(
                    liveEnd
                ),

            distanceKm:
                geometryEndKm
        },

        geometry: {

            startLocationKm:
                geometryStartKm,

            endLocationKm:
                geometryEndKm,

            crossingLocationKm:
                geometryCrossingKm,

            corridorStartKm,

            corridorEndKm,

            localCrossingLocationKm:
                localLocationKm,

            fraction:
                Number(
                    fraction.toFixed(6)
                )
        },

        railwayDistanceKm:
            Number(
                railwayDistanceKm
                    .toFixed(4)
            )
    };
}


// ======================================================
// ASSERT COORDINATE FRAME CONSISTENCY
// ======================================================

function assertCoordinateFrameConsistency(
    trainPositionKm,
    crossingPositionKm,
    routeLengthKm = null
) {
    if (
        !Number.isFinite(trainPositionKm) ||
        !Number.isFinite(crossingPositionKm)
    ) {
        return false;
    }

    if (trainPositionKm < 0 || crossingPositionKm < 0) {
        return false;
    }

    if (routeLengthKm != null && Number.isFinite(routeLengthKm)) {
        if (
            trainPositionKm > routeLengthKm + 25 ||
            crossingPositionKm > routeLengthKm + 25
        ) {
            return false;
        }
    }

    return true;
}


// ======================================================
// MAP ALL CROSSINGS
// ======================================================

function mapCrossingsToTrainRoute(
    crossings,
    geojson,
    liveRouteStations,
    coordinateStations,
    startStationCode = "JNL",
    endStationCode = "MOW"
) {

    if (
        !Array.isArray(
            crossings
        )
    ) {

        return [];
    }


    return crossings
        .map(
            crossing => {

                try {

                    return getCrossingRouteDistance(
                        crossing,
                        geojson,
                        liveRouteStations,
                        coordinateStations,
                        startStationCode,
                        endStationCode
                    );

                } catch (error) {

                    console.error(
                        `⚠️ Could not map ${
                            crossing?.name ||
                            crossing?.id ||
                            "unknown crossing"
                        }: ${error.message}`
                    );

                    return null;
                }
            }
        )
        .filter(Boolean);
}


// ======================================================
// EXPORTS
// ======================================================

module.exports = {

    findNearestPointOnRailway,

    resolveTrainGeometryPosition,

    buildGeometryRoute,

    getCrossingRouteDistance,

    mapCrossingsToTrainRoute,

    assertCoordinateFrameConsistency

};