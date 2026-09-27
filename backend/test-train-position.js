const axios = require("axios");
require("dotenv").config();

const turf = require("@turf/turf");

const { getTrainRoute } = require("./services/railradar");

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

async function testTrainPosition() {

    try {

        console.log("\n========== LIVE TRAIN POSITION ==========\n");

        const train = await getLiveTrain("18310");

        console.log("Train:", train.trainNumber);
        console.log("Name:", train.trainName);
        console.log("Status:", train.status);

        console.log("\nCurrent location:");
        console.log(train.currentLocation);

        console.log("\n========== GETTING RAILWAY GEOMETRY ==========\n");

        const route = await getTrainRoute("18310");

        const geojson = route.geojson;

        if (!geojson) {
            console.log("No railway geometry returned.");
            return;
        }

        console.log(
            "Railway geometry points:",
            geojson.geometry.coordinates.length
        );

        console.log("\n========== PROJECTING TRAIN ONTO RAILWAY ==========\n");

        const trainCoordinates = [
            train.currentLocation.coordinates.lng,
            train.currentLocation.coordinates.lat
        ];

        const trainPoint = turf.point(trainCoordinates);

        const nearestRailwayPoint = turf.nearestPointOnLine(
            geojson,
            trainPoint,
            {
                units: "kilometers"
            }
        );

        console.log(
            "Train GPS:",
            trainCoordinates
        );

        console.log(
            "Nearest railway point:",
            nearestRailwayPoint.geometry.coordinates
        );

        console.log(
            "Distance from railway:",
            nearestRailwayPoint.properties.dist.toFixed(3),
            "km"
        );

        console.log(
            "Train position along railway:",
            nearestRailwayPoint.properties.location.toFixed(3),
            "km"
        );

    } catch (error) {

        console.error("\nTrain position test failed.");

        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Response:", error.response.data);
        } else {
            console.error(error.message);
        }
    }
}

testTrainPosition();