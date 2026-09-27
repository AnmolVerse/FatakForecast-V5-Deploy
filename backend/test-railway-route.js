const { getTrainRoute } = require("./services/railradar");

async function testRoute() {
    try {
        const route = await getTrainRoute("18310");

        console.log("\n========== RAILWAY ROUTE ==========\n");

        console.log("Train:", route.trainNumber);
        console.log("Format:", route.format);

        console.log("\n========== GEOJSON ==========\n");

        console.log("Type:", route.geojson?.type);

        const geometry = route.geojson?.geometry;
        const coordinates = geometry?.coordinates;

        if (coordinates) {
            console.log("Geometry type:", geometry.type);
            console.log("Total geometry points:", coordinates.length);

            console.log("\nFirst point:");
            console.log(coordinates[0]);

            console.log("\nLast point:");
            console.log(coordinates[coordinates.length - 1]);
        } else {
            console.log("No geometry returned.");
        }

        console.log("\n========== STOPS ==========\n");

        if (route.stops) {
            console.log("Total stops:", route.stops.length);

            console.log("\nFirst stop:");
            console.log(route.stops[0]);

            console.log("\nLast stop:");
            console.log(route.stops[route.stops.length - 1]);
        }

    } catch (error) {
        console.error("\nAPI request failed.");

        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Response:", error.response.data);
        } else {
            console.error(error.message);
        }
    }
}

testRoute();