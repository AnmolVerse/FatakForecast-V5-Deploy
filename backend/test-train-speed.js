const axios = require("axios");
require("dotenv").config();

const API_KEY = process.env.RAILRADAR_API_KEY;

async function testTrainSpeed() {

    try {

        const response = await axios.get(
            "https://api.railradar.in/v1/trains/18310/live",
            {
                headers: {
                    Authorization: `Bearer ${API_KEY}`
                },
                params: {
                    authoritative: true
                }
            }
        );

        const train = response.data.data;

        console.log("\n========== TRAIN SPEED / ROUTE DATA ==========\n");

        console.log("Train:", train.trainNumber);
        console.log("Name:", train.trainName);
        console.log("Status:", train.status);

        const currentSequence =
            train.currentLocation.sequence;

        console.log(
            "Current sequence:",
            currentSequence
        );

        console.log(
            "Current station:",
            train.currentLocation.stationName
        );

        console.log(
            "Delay:",
            train.delayMinutes,
            "minutes"
        );

        console.log("\n========== CURRENT LOCATION TELEMETRY ==========\n");

        console.log(
            "Speed:",
            train.currentLocation.speedKmh ?? "Not available"
        );

        console.log(
            "Segment progress:",
            train.currentLocation.segmentProgress ?? "Not available"
        );

        console.log("\n========== ROUTE SPEED ==========\n");

        const currentRouteEntry = train.route.find(
            stop => stop.sequence === currentSequence
        );

        if (currentRouteEntry) {

            console.log(
                "Current route station:",
                currentRouteEntry.stationName
            );

            console.log(
                "Speed to next station:",
                currentRouteEntry.speedToNextStationKmph ?? "Not available",
                "km/h"
            );

            console.log(
                "Next station according to route:"
            );

            const nextRouteEntry = train.route.find(
                stop => stop.sequence === currentSequence + 1
            );

            if (nextRouteEntry) {

                console.log(
                    "Name:",
                    nextRouteEntry.stationName
                );

                console.log(
                    "Code:",
                    nextRouteEntry.stationCode
                );

                console.log(
                    "Distance:",
                    nextRouteEntry.distance,
                    "km"
                );

            }

        } else {

            console.log(
                "Current sequence not found in route."
            );
        }

        console.log(
            "\nLast updated:",
            train.lastUpdatedAt
        );

    } catch (error) {

        console.error("\nTrain speed test failed.");

        if (error.response) {

            console.error(
                "Status:",
                error.response.status
            );

            console.error(
                "Response:",
                error.response.data
            );

        } else {

            console.error(error.message);

        }
    }
}

testTrainSpeed();