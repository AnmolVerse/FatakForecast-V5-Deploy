const turf = require("@turf/turf");

const { getTrainRoute } = require("./services/railradar");
const { findNearestPointOnRailway } = require("./services/geometry");
const crossings = require("./config/crossing");

async function testNearbyStops() {
    try {
        console.log("\n========== NEARBY RAILWAY STOPS ==========\n");

        const route = await getTrainRoute("18310");

        const geojson = route.geojson;

        if (!geojson) {
            console.log("No railway geometry returned.");
            return;
        }

        const stops = route.stops || [];

        // Find railway position of every stop
        const stopsWithPosition = stops.map(stop => {

            const stopPoint = turf.point([
                stop.lng,
                stop.lat
            ]);

            const nearest = turf.nearestPointOnLine(
                geojson,
                stopPoint,
                {
                    units: "kilometers"
                }
            );

            return {
                ...stop,
                railwayPositionKm: nearest.properties.location
            };
        });

        // Check every crossing
        crossings.forEach((crossing, index) => {

            const crossingResult = findNearestPointOnRailway(
                crossing,
                geojson
            );

            const crossingPosition =
                crossingResult.locationAlongRailwayKm;

            const previousStops = stopsWithPosition
                .filter(stop =>
                    stop.railwayPositionKm < crossingPosition
                )
                .sort((a, b) =>
                    b.railwayPositionKm - a.railwayPositionKm
                );

            const nextStops = stopsWithPosition
                .filter(stop =>
                    stop.railwayPositionKm > crossingPosition
                )
                .sort((a, b) =>
                    a.railwayPositionKm - b.railwayPositionKm
                );

            const previousStop = previousStops[0];
            const nextStop = nextStops[0];

            console.log(`\n${index + 1}. ${crossing.name}`);

            console.log(
                "   Crossing railway position:",
                crossingPosition.toFixed(3),
                "km"
            );

            if (previousStop) {
                console.log(
                    "   Previous stop:",
                    previousStop.name,
                    `(${previousStop.code})`
                );

                console.log(
                    "   Distance before crossing:",
                    (
                        crossingPosition -
                        previousStop.railwayPositionKm
                    ).toFixed(3),
                    "km"
                );
            }

            if (nextStop) {
                console.log(
                    "   Next stop:",
                    nextStop.name,
                    `(${nextStop.code})`
                );

                console.log(
                    "   Distance after crossing:",
                    (
                        nextStop.railwayPositionKm -
                        crossingPosition
                    ).toFixed(3),
                    "km"
                );
            }
        });

    } catch (error) {

        console.error("\nNearby-stops test failed.");

        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Response:", error.response.data);
        } else {
            console.error(error.message);
        }
    }
}

testNearbyStops();