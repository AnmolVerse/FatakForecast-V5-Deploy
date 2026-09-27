const axios = require("axios");
const turf = require("@turf/turf");
require("dotenv").config();

const {
    determineDirection,
    calculateCrossingPassageTime
} = require("./services/crossing-event");

const API_KEY =
    process.env.RAILRADAR_API_KEY;

const TRAIN_NUMBER = "18310";


// ==========================================
// JANDIALA CROSSING
// ==========================================

const crossing = {
    name: "Jandiala Railway Crossing",
    lat: 31.590162,
    lng: 75.053973
};


// ==========================================
// MAIN
// ==========================================

async function testJandialaEvent() {

    try {

        console.log(
            "\n=========================================="
        );

        console.log(
            "      JANDIALA CROSSING EVENT TEST"
        );

        console.log(
            "==========================================\n"
        );


        // ======================================
        // 1. LIVE TRAIN
        // ======================================

        const liveResponse =
            await axios.get(
                `https://api.railradar.in/v1/trains/${TRAIN_NUMBER}/live`,
                {
                    headers: {
                        Authorization:
                            `Bearer ${API_KEY}`
                    },
                    params: {
                        authoritative: true
                    }
                }
            );


        const train =
            liveResponse.data.data;


        console.log(
            "Train:",
            train.trainNumber
        );

        console.log(
            "Name:",
            train.trainName
        );

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


        // ======================================
        // 2. RAILWAY GEOMETRY
        // ======================================

        const routeResponse =
            await axios.get(
                `https://api.railradar.in/v1/trains/${TRAIN_NUMBER}/route`,
                {
                    headers: {
                        Authorization:
                            `Bearer ${API_KEY}`
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


        // ======================================
        // 3. TRAIN POSITION
        // ======================================

        const trainPoint =
            turf.point([
                train.currentLocation.coordinates.lng,
                train.currentLocation.coordinates.lat
            ]);


        const nearestTrainPoint =
            turf.nearestPointOnLine(
                railwayLine,
                trainPoint,
                {
                    units: "kilometers"
                }
            );


        const trainRailwayPosition =
            nearestTrainPoint.properties.location;


        console.log(
            "\nTrain railway position:",
            trainRailwayPosition.toFixed(3),
            "km"
        );


        // ======================================
        // 4. CROSSING POSITION
        // ======================================

        const crossingPoint =
            turf.point([
                crossing.lng,
                crossing.lat
            ]);


        const nearestCrossingPoint =
            turf.nearestPointOnLine(
                railwayLine,
                crossingPoint,
                {
                    units: "kilometers"
                }
            );


        const crossingRailwayPosition =
            nearestCrossingPoint.properties.location;


        console.log(
            "Crossing railway position:",
            crossingRailwayPosition.toFixed(3),
            "km"
        );


        // ======================================
        // 5. DIRECTION
        // ======================================

        const direction =
            determineDirection(
                trainRailwayPosition,
                crossingRailwayPosition
            );


        console.log(
            "Direction:",
            direction
        );


        // ======================================
        // 6. FIND JANDIALA STATION
        // ======================================

        const jandiala =
            train.route.find(
                stop =>
                    stop.stationCode === "JNL"
            );


        if (!jandiala) {

            console.log(
                "\nJandiala station not found."
            );

            return;
        }


        console.log(
            "\n========== JANDIALA STATION ==========\n"
        );


        console.log(
            "Station:",
            jandiala.stationName
        );

        console.log(
            "Code:",
            jandiala.stationCode
        );

        console.log(
            "Route distance:",
            jandiala.distance,
            "km"
        );

        console.log(
            "Scheduled arrival:",
            jandiala.scheduledArrival
        );

        console.log(
            "Scheduled departure:",
            jandiala.scheduledDeparture
        );

        console.log(
            "Actual arrival:",
            jandiala.actualArrival ??
            "Not available"
        );

        console.log(
            "Actual departure:",
            jandiala.actualDeparture ??
            "Not available"
        );


        // ======================================
        // 7. CROSSING ↔ STATION DISTANCE
        // ======================================

        const crossingToStationKm =
            Math.abs(
                jandiala.distance -
                crossingRailwayPosition
            );


        console.log(
            "\nCrossing → Jandiala station:",
            crossingToStationKm.toFixed(3),
            "km"
        );


        // ======================================
        // 8. SPEED
        // ======================================

        const previousRouteEntry =
            train.route.find(
                stop =>
                    stop.sequence ===
                    jandiala.sequence - 1
            );


        const speedKmph =
            previousRouteEntry
                ?.speedToNextStationKmph;


        console.log(
            "Approach speed:",
            speedKmph ??
            "Not available",
            "km/h"
        );


        // ======================================
        // 9. PREDICT CROSSING PASSAGE
        // ======================================

        /*
            For a train approaching JNL:

                JNL arrival
                    -
                crossing travel time
                    =
                crossing passage
        */

        if (direction === "approaching") {

            const crossingPassage =
                calculateCrossingPassageTime({

                    stationArrival:
                        jandiala.actualArrival ??
                        jandiala.scheduledArrival,

                    stationDeparture:
                        jandiala.actualDeparture ??
                        jandiala.scheduledDeparture,

                    crossingDistanceFromStationKm:
                        crossingToStationKm,

                    speedKmph,

                    direction: "approaching"

                });


            console.log(
                "\n========== CROSSING EVENT ==========\n"
            );


            if (crossingPassage) {

                console.log(
                    "Expected crossing passage:",
                    crossingPassage.toLocaleString(
                        "en-IN",
                        {
                            timeZone: "Asia/Kolkata",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit"
                        }
                    )
                );

            } else {

                console.log(
                    "Crossing passage: Not available"
                );

            }

        }


        console.log(
            "\nLast updated:",
            train.lastUpdatedAt
        );


        console.log(
            "\n==========================================\n"
        );


    } catch (error) {

        console.error(
            "\n❌ JANDIALA EVENT TEST FAILED\n"
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


testJandialaEvent();