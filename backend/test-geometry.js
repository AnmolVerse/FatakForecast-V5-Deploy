const { getTrainRoute } = require("./services/railradar");
const { findNearestPointOnRailway } = require("./services/geometry");
const crossings = require("./config/crossing");

async function testGeometry() {
    try {
        console.log("\n========== FATAKFORECAST GEOMETRY TEST ==========\n");

        const route = await getTrainRoute("18310");

        const geojson = route.geojson;

        if (!geojson) {
            console.log("No GeoJSON route returned.");
            return;
        }

        console.log("Train: 18310");
        console.log("Geometry points:", geojson.geometry.coordinates.length);

        console.log("\n========== CROSSING DISTANCES ==========\n");

        crossings.forEach((crossing, index) => {

            const result = findNearestPointOnRailway(
                crossing,
                geojson
            );

            console.log(`${index + 1}. ${result.crossing}`);

            console.log(
                "   Distance from railway:",
                result.distanceFromRailwayKm.toFixed(3),
                "km"
            );

            console.log(
                "   Location along railway:",
                result.locationAlongRailwayKm.toFixed(3),
                "km"
            );

            console.log(
                "   Nearest railway point:",
                result.nearestRailwayPoint
            );

            console.log("");
        });

    } catch (error) {

        console.error("\nGeometry test failed.");

        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Response:", error.response.data);
        } else {
            console.error(error.message);
        }
    }
}

testGeometry();