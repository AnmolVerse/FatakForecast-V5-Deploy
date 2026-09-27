const axios = require("axios");
require("dotenv").config();

const API_KEY = process.env.RAILRADAR_API_KEY;

const TRAIN_NUMBER = "18310";

async function testRouteSegments() {

    try {

        console.log("\n==========================================");
        console.log("       ROUTE SEGMENT / TIMETABLE TEST");
        console.log("==========================================\n");

        const response = await axios.get(
            `https://api.railradar.in/v1/trains/${TRAIN_NUMBER}/live`,
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

        const currentSequence =
            train.currentLocation.sequence;

        console.log("Train:", train.trainNumber);
        console.log("Name:", train.trainName);
        console.log(
            "Current station:",
            train.currentLocation.stationName
        );
        console.log(
            "Current sequence:",
            currentSequence
        );
        console.log(
            "Current delay:",
            train.delayMinutes,
            "minutes"
        );

        console.log(
            "\n=========================================="
        );

        console.log(
            "       UPCOMING ROUTE STATIONS"
        );

        console.log(
            "==========================================\n"
        );


        /*
            Print stations from current location
            until Jandiala / nearby section.
        */

        const upcomingStations = train.route
            .filter(stop =>
                stop.sequence >= currentSequence &&
                stop.sequence <= currentSequence + 15
            )
            .sort(
                (a, b) =>
                    a.sequence - b.sequence
            );


        for (const station of upcomingStations) {

            console.log("------------------------------------------");

            console.log(
                "Sequence:",
                station.sequence
            );

            console.log(
                "Station:",
                station.stationName
            );

            console.log(
                "Code:",
                station.stationCode
            );

            console.log(
                "Distance:",
                station.distance,
                "km"
            );

            console.log(
                "Scheduled arrival:",
                station.scheduledArrival
            );

            console.log(
                "Scheduled departure:",
                station.scheduledDeparture
            );

            console.log(
                "Actual arrival:",
                station.actualArrival ??
                "Not available"
            );

            console.log(
                "Actual departure:",
                station.actualDeparture ??
                "Not available"
            );

            console.log(
                "Arrival delay:",
                station.delayArrival ??
                "Not available"
            );

            console.log(
                "Departure delay:",
                station.delayDeparture ??
                "Not available"
            );

            console.log(
                "Speed to next station:",
                station.speedToNextStationKmph ??
                "Not available",
                "km/h"
            );
        }


        console.log(
            "\n=========================================="
        );

        console.log(
            "       TARGET CROSSING SECTION"
        );

        console.log(
            "==========================================\n"
        );


        /*
            Find Mananwala and Jandiala.
        */

        const importantStations = train.route.filter(
            stop =>
                stop.stationCode === "MOW" ||
                stop.stationCode === "JNL"
        );


        for (const station of importantStations) {

            console.log("------------------------------------------");

            console.log(
                "Station:",
                station.stationName
            );

            console.log(
                "Code:",
                station.stationCode
            );

            console.log(
                "Sequence:",
                station.sequence
            );

            console.log(
                "Distance:",
                station.distance,
                "km"
            );

            console.log(
                "Scheduled arrival:",
                station.scheduledArrival
            );

            console.log(
                "Scheduled departure:",
                station.scheduledDeparture
            );

            console.log(
                "Actual arrival:",
                station.actualArrival ??
                "Not available"
            );

            console.log(
                "Actual departure:",
                station.actualDeparture ??
                "Not available"
            );

            console.log(
                "Arrival delay:",
                station.delayArrival ??
                "Not available"
            );

            console.log(
                "Departure delay:",
                station.delayDeparture ??
                "Not available"
            );

        }


        console.log(
            "\n==========================================\n"
        );

        console.log(
            "Last updated:",
            train.lastUpdatedAt
        );

        console.log(
            "\n==========================================\n"
        );


    } catch (error) {

        console.error(
            "\n❌ ROUTE SEGMENT TEST FAILED\n"
        );

        if (error.response) {

            console.error(
                "HTTP Status:",
                error.response.status
            );

            console.error(
                "API Response:",
                error.response.data
            );

        } else {

            console.error(
                error.message
            );
        }
    }
}


testRouteSegments();