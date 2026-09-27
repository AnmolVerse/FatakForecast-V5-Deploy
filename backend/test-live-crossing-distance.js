const turf = require("@turf/turf");
const axios = require("axios");
require("dotenv").config();

const { getTrainRoute } = require("./services/railradar");
const crossings = require("./config/crossing");

const API_KEY = process.env.RAILRADAR_API_KEY;

async function getLiveTrain(trainNumber) {
    const response = await axios.get(
        `https://api.railradar.in/v1/trains/${trainNumber}/live`,
        {
            headers: {
                Authorization: `Bearer ${API_KEY}`
            },
            params: {
                authoritative: true
            }
        }
    );

    return response.data.data;
}

async function main() {

    try {

        const trainNumber = "18310";

        console.log("\n========== FATAKFORECAST LIVE DISTANCE ==========\n");

        // 1. Get live train data
        const train = await getLiveTrain(trainNumber);

        console.log("Train:", train.trainNumber);
        console.log("Name:", train.trainName);
        console.log("Status:", train.status);

        // 2. Get railway route
        const route = await getTrainRoute(trainNumber);

        const geojson = route.geojson;

        if (!geojson) {
            console.log("No railway geometry returned.");
            return;
        }

        // 3. Project live train onto railway
        const trainPoint = turf.point([
            train.currentLocation.coordinates.lng,
            train.currentLocation.coordinates.lat
        ]);

        const trainOnRailway = turf.nearestPointOnLine(
            geojson,
            trainPoint,
            {
                units: "kilometers"
            }
        );

        const trainPositionKm =
            trainOnRailway.properties.location;

        console.log(
            "\nLive train railway position:",
            trainPositionKm.toFixed(3),
            "km"
        );

        console.log(
            "\n========== DISTANCE TO CROSSINGS ==========\n"
        );

        // 4. Calculate every crossing dynamically
        crossings.forEach((crossing, index) => {

            const crossingPoint = turf.point([
                crossing.coordinates.lng,
                crossing.coordinates.lat
            ]);

            const crossingOnRailway =
                turf.nearestPointOnLine(
                    geojson,
                    crossingPoint,
                    {
                        units: "kilometers"
                    }
                );

            const crossingPositionKm =
                crossingOnRailway.properties.location;

            const distanceKm =
                crossingPositionKm - trainPositionKm;

            console.log(`${index + 1}. ${crossing.name}`);

            console.log(
                "   Crossing railway position:",
                crossingPositionKm.toFixed(3),
                "km"
            );

            console.log(
                "   Train → crossing:",
                distanceKm.toFixed(3),
                "km"
            );

            console.log("");
        });

    } catch (error) {

        console.error("\nLive crossing distance test failed.");

        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Response:", error.response.data);
        } else {
            console.error(error.message);
        }
    }
}

main();