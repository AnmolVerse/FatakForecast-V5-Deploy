const axios = require("axios");
const turf = require("@turf/turf");
require("dotenv").config();

const API_KEY = process.env.RAILRADAR_API_KEY;

const TRAIN_NUMBER = "18310";


// ==================================================
// OUR 4 V1 CROSSINGS
// ==================================================

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


// ==================================================
// HELPERS
// ==================================================

function calculateTravelMinutes(
    distanceKm,
    speedKmph
) {

    if (
        distanceKm == null ||
        speedKmph == null ||
        distanceKm < 0 ||
        speedKmph <= 0
    ) {
        return null;
    }

    return (
        distanceKm / speedKmph
    ) * 60;
}


function calculatePassageFromArrival(
    stationArrival,
    distanceKm,
    speedKmph
) {

    if (
        !stationArrival ||
        distanceKm == null ||
        speedKmph == null ||
        speedKmph <= 0
    ) {
        return null;
    }

    const travelMinutes =
        calculateTravelMinutes(
            distanceKm,
            speedKmph
        );

    if (travelMinutes == null) {
        return null;
    }

    const stationTime =
        new Date(stationArrival);

    return new Date(
        stationTime.getTime() -
        travelMinutes * 60 * 1000
    );
}


function calculatePassageFromDeparture(
    stationDeparture,
    distanceKm,
    speedKmph
) {

    if (
        !stationDeparture ||
        distanceKm == null ||
        speedKmph == null ||
        speedKmph <= 0
    ) {
        return null;
    }

    const travelMinutes =
        calculateTravelMinutes(
            distanceKm,
            speedKmph
        );

    if (travelMinutes == null) {
        return null;
    }

    const stationTime =
        new Date(stationDeparture);

    return new Date(
        stationTime.getTime() +
        travelMinutes * 60 * 1000
    );
}


function formatTime(date) {

    if (!date) {
        return "Not available";
    }

    return date.toLocaleString(
        "en-IN",
        {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        }
    );
}


// ==================================================
// MAIN
// ==================================================

async function testCrossingEvents() {

    try {

        console.log(
            "\n=============================================="
        );

        console.log(
            "       FATAKFORECAST CROSSING EVENTS"
        );

        console.log(
            "==============================================\n"
        );


        // ==================================================
        // 1. LIVE TRAIN DATA
        // ==================================================

        console.log(
            "Fetching live train data...\n"
        );

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
            "Status:",
            train.status
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


        // ==================================================
        // 2. RAILWAY GEOMETRY
        // ==================================================

        console.log(
            "\nFetching railway geometry..."
        );

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


        // ==================================================
        // 3. TRAIN POSITION
        // ==================================================

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
            "Train railway position:",
            trainRailwayPosition.toFixed(3),
            "km"
        );


        // ==================================================
        // 4. FIND STATIONS AROUND EACH CROSSING
        // ==================================================

        console.log(
            "\n=============================================="
        );

        console.log(
            "       CROSSING / STATION RELATIONSHIPS"
        );

        console.log(
            "==============================================\n"
        );


        for (const crossing of crossings) {

            console.log(
                "🚧",
                crossing.name
            );


            // ----------------------------------------------
            // Crossing point
            // ----------------------------------------------

            const crossingPoint =
                turf.point([
                    crossing.lng,
                    crossing.lat
                ]);


            // ----------------------------------------------
            // Project crossing onto railway
            // ----------------------------------------------

            const nearestCrossingPoint =
                turf.nearestPointOnLine(
                    railwayLine,
                    crossingPoint,
                    {
                        units: "kilometers"
                    }
                );


            const crossingPosition =
                nearestCrossingPoint.properties.location;


            console.log(
                "Crossing railway position:",
                crossingPosition.toFixed(3),
                "km"
            );


            // ----------------------------------------------
            // Find stations before and after crossing
            // ----------------------------------------------

            const stations =
                train.route
                    .filter(
                        station =>
                            station.distance != null
                    )
                    .sort(
                        (a, b) =>
                            a.distance - b.distance
                    );


            const previousStation =
                [...stations]
                    .reverse()
                    .find(
                        station =>
                            station.distance <
                            crossingPosition
                    );


            const nextStation =
                stations.find(
                    station =>
                        station.distance >
                        crossingPosition
                );


            // ----------------------------------------------
            // Previous station
            // ----------------------------------------------

            if (previousStation) {

                console.log(
                    "\nPrevious station:",
                    previousStation.stationName
                );

                console.log(
                    "Code:",
                    previousStation.stationCode
                );

                console.log(
                    "Distance:",
                    previousStation.distance,
                    "km"
                );

                console.log(
                    "Crossing → previous station:",
                    (
                        crossingPosition -
                        previousStation.distance
                    ).toFixed(3),
                    "km"
                );
            }


            // ----------------------------------------------
            // Next station
            // ----------------------------------------------

            if (nextStation) {

                console.log(
                    "\nNext station:",
                    nextStation.stationName
                );

                console.log(
                    "Code:",
                    nextStation.stationCode
                );

                console.log(
                    "Distance:",
                    nextStation.distance,
                    "km"
                );

                console.log(
                    "Crossing → next station:",
                    (
                        nextStation.distance -
                        crossingPosition
                    ).toFixed(3),
                    "km"
                );
            }


            // ----------------------------------------------
            // Train relationship
            // ----------------------------------------------

            let direction;

            if (
                trainRailwayPosition <
                crossingPosition
            ) {

                direction = "APPROACHING";

            } else if (
                trainRailwayPosition >
                crossingPosition
            ) {

                direction = "PASSED";

            } else {

                direction = "AT CROSSING";
            }


            console.log(
                "\nTrain status:",
                direction
            );


            // ----------------------------------------------
            // If train has passed
            // ----------------------------------------------

            if (direction === "PASSED") {

                console.log(
                    "Event prediction:",
                    "TRAIN ALREADY PASSED"
                );

                console.log(
                    "==============================================\n"
                );

                continue;
            }


            // ----------------------------------------------
            // If crossing is ahead
            // ----------------------------------------------

            if (
                direction === "APPROACHING" &&
                nextStation
            ) {

                /*
                    Train is moving toward the next
                    station in this route direction.

                    Therefore:

                    station arrival
                         -
                    crossing → station travel time
                         =
                    crossing passage
                */


                const speed =
                    previousStation
                        ?.speedToNextStationKmph
                    ??
                    train.currentLocation.speedKmh;


                const distanceToStation =
                    Math.abs(
                        nextStation.distance -
                        crossingPosition
                    );


                console.log(
                    "\nAnchor station:",
                    nextStation.stationName
                );

                console.log(
                    "Anchor type:",
                    "ARRIVAL"
                );

                console.log(
                    "Speed used:",
                    speed ??
                    "Not available",
                    "km/h"
                );


                const passageTime =
                    calculatePassageFromArrival(
                        nextStation.actualArrival ??
                        nextStation.scheduledArrival,

                        distanceToStation,

                        speed
                    );


                console.log(
                    "Estimated crossing passage:",
                    formatTime(passageTime)
                );
            }


            console.log(
                "==============================================\n"
            );
        }


        // ==================================================
        // 5. SPECIFIC JANDIALA VALIDATION
        // ==================================================

        const jandiala =
            train.route.find(
                station =>
                    station.stationCode === "JNL"
            );


        const jandialaCrossing =
            crossings.find(
                crossing =>
                    crossing.id === "jandiala"
            );


        if (
            jandiala &&
            jandialaCrossing
        ) {

            const crossingPoint =
                turf.point([
                    jandialaCrossing.lng,
                    jandialaCrossing.lat
                ]);


            const nearestPoint =
                turf.nearestPointOnLine(
                    railwayLine,
                    crossingPoint,
                    {
                        units: "kilometers"
                    }
                );


            const crossingPosition =
                nearestPoint.properties.location;


            const distance =
                Math.abs(
                    jandiala.distance -
                    crossingPosition
                );


            console.log(
                "\n=============================================="
            );

            console.log(
                "       JANDIALA VALIDATION"
            );

            console.log(
                "==============================================\n"
            );

            console.log(
                "Jandiala station:",
                jandiala.distance,
                "km"
            );

            console.log(
                "Jandiala crossing:",
                crossingPosition.toFixed(3),
                "km"
            );

            console.log(
                "Difference:",
                distance.toFixed(3),
                "km"
            );

            console.log(
                "Station arrival:",
                jandiala.actualArrival ??
                jandiala.scheduledArrival
            );

            console.log(
                "Station departure:",
                jandiala.actualDeparture ??
                jandiala.scheduledDeparture
            );

            console.log(
                "\nThis confirms the crossing is",
                crossingPosition <
                jandiala.distance
                    ? "BEFORE"
                    : "AFTER",
                "Jandiala station in this route direction."
            );
        }


        console.log(
            "\nLast updated:",
            train.lastUpdatedAt
        );


        console.log(
            "\n==============================================\n"
        );


    } catch (error) {

        console.error(
            "\n❌ CROSSING EVENT TEST FAILED\n"
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


testCrossingEvents();