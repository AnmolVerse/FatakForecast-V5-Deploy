const axios = require("axios");
const turf = require("@turf/turf");
require("dotenv").config();

const API_KEY = process.env.RAILRADAR_API_KEY;
const TRAIN_NUMBER = "18310";


// ==================================================
// FOUR V1 CROSSINGS
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

function travelMinutes(distanceKm, speedKmph) {

    if (
        distanceKm == null ||
        speedKmph == null ||
        speedKmph <= 0
    ) {
        return null;
    }

    return (
        distanceKm / speedKmph
    ) * 60;
}


function subtractMinutes(date, minutes) {

    return new Date(
        new Date(date).getTime() -
        minutes * 60 * 1000
    );
}


function addMinutes(date, minutes) {

    return new Date(
        new Date(date).getTime() +
        minutes * 60 * 1000
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

async function testCrossingPassage() {

    try {

        console.log(
            "\n=============================================="
        );

        console.log(
            "       FATAKFORECAST CROSSING PASSAGE"
        );

        console.log(
            "==============================================\n"
        );


        // ==================================================
        // 1. GET LIVE ROUTE
        // ==================================================

        const response = await axios.get(
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
            response.data.data;


        console.log(
            "Train:",
            train.trainNumber
        );

        console.log(
            "Name:",
            train.trainName
        );

        console.log(
            "Current position:",
            train.currentLocation.stationName
        );

        console.log(
            "Last updated:",
            train.lastUpdatedAt
        );


        // ==================================================
        // 2. GET RAILWAY GEOMETRY
        // ==================================================

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
        // 3. GET MOW + JNL
        // ==================================================

        const mananwala =
            train.route.find(
                station =>
                    station.stationCode === "MOW"
            );


        const jandiala =
            train.route.find(
                station =>
                    station.stationCode === "JNL"
            );


        if (!mananwala || !jandiala) {

            console.log(
                "\nMOW or JNL not found."
            );

            return;
        }


        console.log(
            "\n========== ANCHOR STATIONS ==========\n"
        );


        console.log(
            "Mananwala:",
            mananwala.distance,
            "km"
        );

        console.log(
            "Jandiala:",
            jandiala.distance,
            "km"
        );


        // ==================================================
        // 4. SEGMENT SPEED
        // ==================================================

        const segmentSpeed =
            mananwala.speedToNextStationKmph;


        console.log(
            "MOW → JNL segment speed:",
            segmentSpeed,
            "km/h"
        );


        // ==================================================
        // 5. CALCULATE PASSAGE TIMES
        // ==================================================

        console.log(
            "\n=============================================="
        );

        console.log(
            "       MOW → JNL CROSSING PASSAGE"
        );

        console.log(
            "==============================================\n"
        );


        for (const crossing of crossings) {

            const crossingPoint =
                turf.point([
                    crossing.lng,
                    crossing.lat
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


            const distanceToJNL =
                jandiala.distance -
                crossingPosition;


            const minutesToJNL =
                travelMinutes(
                    distanceToJNL,
                    segmentSpeed
                );


            const passageTime =
                subtractMinutes(
                    jandiala.actualArrival ??
                    jandiala.scheduledArrival,
                    minutesToJNL
                );


            console.log(
                "🚧",
                crossing.name
            );

            console.log(
                "Crossing position:",
                crossingPosition.toFixed(3),
                "km"
            );

            console.log(
                "Distance → JNL:",
                distanceToJNL.toFixed(3),
                "km"
            );

            console.log(
                "Travel time → JNL:",
                minutesToJNL.toFixed(2),
                "minutes"
            );

            console.log(
                "JNL arrival:",
                formatTime(
                    new Date(
                        jandiala.actualArrival ??
                        jandiala.scheduledArrival
                    )
                )
            );

            console.log(
                "Estimated crossing passage:",
                formatTime(passageTime)
            );

            console.log(
                "----------------------------------------------"
            );
        }


        // ==================================================
        // 6. JANDIALA SPECIAL VALIDATION
        // ==================================================

        console.log(
            "\n=============================================="
        );

        console.log(
            "       JANDIALA SPECIAL CHECK"
        );

        console.log(
            "==============================================\n"
        );


        const jandialaCrossing =
            crossings.find(
                crossing =>
                    crossing.id === "jandiala"
            );


        const jnlCrossingPoint =
            turf.point([
                jandialaCrossing.lng,
                jandialaCrossing.lat
            ]);


        const jnlNearest =
            turf.nearestPointOnLine(
                railwayLine,
                jnlCrossingPoint,
                {
                    units: "kilometers"
                }
            );


        const jnlCrossingPosition =
            jnlNearest.properties.location;


        const jnlDifference =
            jandiala.distance -
            jnlCrossingPosition;


        console.log(
            "JNL station:",
            jandiala.distance,
            "km"
        );

        console.log(
            "JNL crossing:",
            jnlCrossingPosition.toFixed(3),
            "km"
        );

        console.log(
            "Crossing → station:",
            jnlDifference.toFixed(3),
            "km"
        );

        console.log(
            "Actual JNL arrival:",
            jandiala.actualArrival
        );

        console.log(
            "Calculated crossing passage:",
            formatTime(
                subtractMinutes(
                    jandiala.actualArrival,
                    travelMinutes(
                        jnlDifference,
                        segmentSpeed
                    )
                )
            )
        );


        console.log(
            "\n==============================================\n"
        );


    } catch (error) {

        console.error(
            "\n❌ CROSSING PASSAGE TEST FAILED\n"
        );

        if (error.response) {

            console.error(
                "HTTP Status:",
                error.response.status
            );

            console.error(
                "API Status:",
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


testCrossingPassage();