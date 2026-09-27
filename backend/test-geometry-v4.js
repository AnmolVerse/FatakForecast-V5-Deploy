const assert = require("assert");
const {
    resolveTrainGeometryPosition,
    buildGeometryRoute,
    getCrossingRouteDistance
} = require("./services/geometry");

// Synthetic straight railway: 0 -> 10 km.
// Coordinates are deliberately simple; Turf measures the line in km.
const routeData = {
    geojson: {
        type: "Feature",
        properties: {},
        geometry: {
            type: "LineString",
            coordinates: [
                [0, 0],
                [0.09, 0]
            ]
        }
    },
    stops: [
        { sequence: 1, code: "A", name: "A", lat: 0, lng: 0 },
        { sequence: 2, code: "B", name: "B", lat: 0, lng: 0.045 },
        { sequence: 3, code: "C", name: "C", lat: 0, lng: 0.09 }
    ]
};

const live = {
    currentLocation: {
        sequence: 2,
        stationCode: "B",
        segmentProgress: 0.5
    }
};

const train = resolveTrainGeometryPosition(live, routeData);
assert(train.positionKm > 7 && train.positionKm < 8, `Unexpected train position: ${train.positionKm}`);
assert.strictEqual(train.source, "live-route-geometry-segment-progress");

const liveRoute = [
    { sequence: 1, stationCode: "A", distance: 0, speedToNextStationKmph: 60 },
    { sequence: 2, stationCode: "B", distance: 5, speedToNextStationKmph: 60 },
    { sequence: 3, stationCode: "C", distance: 10, speedToNextStationKmph: 60 }
];

const geometryRoute = buildGeometryRoute(liveRoute, routeData);
assert.strictEqual(geometryRoute.length, 3);
assert(geometryRoute[1].distance > 4 && geometryRoute[1].distance < 6);

const crossing = {
    id: "test",
    name: "Test Crossing",
    coordinates: { lat: 0, lng: 0.0675 }
};

const mapped = getCrossingRouteDistance(
    crossing,
    routeData.geojson,
    liveRoute,
    routeData.stops,
    "A",
    "C"
);

assert(mapped);
assert(mapped.routeDistanceKm > 7 && mapped.routeDistanceKm < 8);
assert(
    Math.abs(
        mapped.routeDistanceKm -
        train.positionKm
    ) < 0.1,
    `Train/crossing route positions should be consistent: train=${train.positionKm}, crossing=${mapped.routeDistanceKm}`
);
console.log("✅ V4 geometry coordinate-system test passed");
