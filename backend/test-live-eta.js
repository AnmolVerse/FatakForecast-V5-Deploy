const axios = require("axios");
const turf = require("@turf/turf");
require("dotenv").config();

const {
    estimateStationAwareETA
} = require("./services/eta");

const API_KEY = process.env.RAILRADAR_API_KEY;

const TRAIN_NUMBER = "18310";

// ==========================================
// OUR 4 V1 FATAKS
// ==========================================

const crossings = [
    {
        name: "Talwandi Dogran Fatak",
        id: "talwandi-dogran",
        lat: 31.605083,
        lng: 74.996645
    },
    {
        name: "Manawala Road Fatak",
        id: "manawala-road",
        lat: 31.599745,
        lng: 75.017127
    },
    {
        name: "Rakh Devi Dasspura Fatak",
        id: "rakh-devi-dasspura",
        lat: 31.595879,
        lng: 75.031856
    },
    {
        name: "Jandiala Railway Crossing",
        id: "jandiala",
        lat: 31.590162,
        lng: 75.053973
    }
];


// ==========================================
// MAIN
// ==========================================

async function testLiveETA() {

    try {

        console.log("\n==========================================");
        console.log("       LIVE FATAK ETA TEST");
        console.log("==========================================\n");


        // ==========================================
        // 1. GET LIVE TRAIN DATA
        // ==========================================

        console.log("Fetching live train data...\n");

        const liveResponse = await axios.get(
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

        const train = liveResponse.data.data;


        console.log("Train:", train.trainNumber);
        console.log("Name:", train.trainName);
        console.log("Status:", train.status);

        console.log(
            "Current station:",
            train.currentLocation.stationName
        );

        console.log(
            "Current sequence:",
            train.currentLocation.sequence
        );

        console.log(
            "Delay:",
            train.delayMinutes,
            "minutes"
        );


        // ==========================================
        // 2. LIVE TRAIN COORDINATES
        // ==========================================

        const trainLat =
            train.currentLocation.coordinates.lat;

        const trainLng =
            train.currentLocation.coordinates.lng;


        console.log(
            "Live coordinates:",
            trainLat,
            trainLng
        );


        // ==========================================
        // 3. SEGMENT PROGRESS
        // ==========================================

        console.log(
            "Segment progress:",
            train.currentLocation.segmentProgress ??
            "Not available"
        );


        // ==========================================
        // 4. GET RAILWAY ROUTE
        // ==========================================

        console.log(
            "\nFetching railway geometry..."
        );

        const routeResponse = await axios.get(
            `https://api.railradar.in/v1/trains/${TRAIN_NUMBER}/route`,
            {
                headers: {
                    Authorization: `Bearer ${API_KEY}`
                },
                params: {
                    stops: true
                }
            }
        );

        const routeData =
            routeResponse.data.data;


        const railwayLine =
            turf.lineString(
                routeData.geojson.geometry.coordinates
            );


        console.log(
            "Railway geometry points:",
            routeData.geojson.geometry.coordinates.length
        );


        // ==========================================
        // 5. PROJECT TRAIN ONTO RAILWAY
        // ==========================================

        const trainPoint =
            turf.point([
                trainLng,
                trainLat
            ]);


        const nearestTrainPoint =
            turf.nearestPointOnLine(
                railwayLine,
                trainPoint,
                {
                    units: "kilometers"
                }
            );


        // ==========================================
        // 6. TRAIN POSITION ALONG RAILWAY
        // ==========================================

        const trainRailwayPosition =
            nearestTrainPoint.properties.location;


        console.log(
            "Train railway position:",
            trainRailwayPosition.toFixed(3),
            "km"
        );


        // ==========================================
        // 7. GET CURRENT ROUTE ENTRY
        // ==========================================

        const currentSequence =
            train.currentLocation.sequence;


        const currentRouteEntry =
            train.route.find(
                stop =>
                    stop.sequence === currentSequence
            );


        if (!currentRouteEntry) {

            console.log(
                "\nCurrent route entry not found."
            );

            return;
        }


        // ==========================================
        // 8. GET SPEED
        // ==========================================

        const speedKmph =
            currentRouteEntry.speedToNextStationKmph;


        console.log(
            "Speed to next station:",
            speedKmph ?? "Not available",
            "km/h"
        );


        // ==========================================
        // 9. NEXT STATION
        // ==========================================

        const nextRouteEntry =
            train.route.find(
                stop =>
                    stop.sequence ===
                    currentSequence + 1
            );


        if (nextRouteEntry) {

            console.log(
                "Next station:",
                nextRouteEntry.stationName
            );

            console.log(
                "Next station code:",
                nextRouteEntry.stationCode
            );

        }


        // ==========================================
        // 10. CROSSING ETA CALCULATIONS
        // ==========================================

        console.log(
            "\n=========================================="
        );

        console.log(
            "          CROSSING ETAs"
        );

        console.log(
            "==========================================\n"
        );


        for (const crossing of crossings) {


            // --------------------------------------
            // Crossing GPS point
            // --------------------------------------

            const crossingPoint =
                turf.point([
                    crossing.lng,
                    crossing.lat
                ]);


            // --------------------------------------
            // Project crossing onto railway
            // --------------------------------------

            const nearestCrossingPoint =
                turf.nearestPointOnLine(
                    railwayLine,
                    crossingPoint,
                    {
                        units: "kilometers"
                    }
                );


            // --------------------------------------
            // Crossing position on railway
            // --------------------------------------

            const crossingRailwayPosition =
                nearestCrossingPoint.properties.location;


            // --------------------------------------
            // Distance from train
            // --------------------------------------

            const distanceToCrossing =
                crossingRailwayPosition -
                trainRailwayPosition;


            console.log(
                "🚧",
                crossing.name
            );

            console.log(
                "Railway position:",
                crossingRailwayPosition.toFixed(3),
                "km"
            );


            // --------------------------------------
            // Already passed?
            // --------------------------------------

            if (distanceToCrossing <= 0) {

                console.log(
                    "Status: TRAIN HAS PASSED"
                );

                console.log(
                    "ETA: 0 minutes"
                );

                console.log(
                    "------------------------------------------\n"
                );

                continue;
            }


            console.log(
                "Distance:",
                distanceToCrossing.toFixed(3),
                "km"
            );


            // --------------------------------------
            // Station-aware ETA
            // --------------------------------------

            const etaMinutes =
                estimateStationAwareETA({

                    trainPositionKm:
                        trainRailwayPosition,

                    targetPositionKm:
                        crossingRailwayPosition,

                    route:
                        train.route,

                    currentSequence:
                        currentSequence,

                    currentSpeedKmph:
                        speedKmph

                });


            if (etaMinutes == null) {

                console.log(
                    "ETA: Not available"
                );

            } else {

                console.log(
                    "ETA:",
                    etaMinutes,
                    "minutes"
                );

            }


            console.log(
                "------------------------------------------\n"
            );
        }


        // ==========================================
        // 11. LAST UPDATED
        // ==========================================

        console.log(
            "Last updated:",
            train.lastUpdatedAt
        );

        console.log(
            "\n==========================================\n"
        );


    } catch (error) {

        console.error(
            "\n❌ LIVE ETA TEST FAILED\n"
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


testLiveETA();