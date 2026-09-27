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

function interpolateTime(
    startTime,
    endTime,
    fraction
) {

    const start =
        new Date(startTime).getTime();

    const end =
        new Date(endTime).getTime();

    const result =
        start +
        (end - start) * fraction;

    return new Date(result);
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

async function testCrossingInterpolation() {

    try {

        console.log(
            "\n=============================================="
        );

        console.log(
            "     FATAKFORECAST TIME INTERPOLATION"
        );

        console.log(
            "==============================================\n"
        );


        // ==================================================
        // 1. GET LIVE TRAIN DATA
        // ==================================================

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
        // 3. FIND MOW AND JNL
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


        if (
            !mananwala ||
            !jandiala
        ) {

            console.log(
                "\n❌ MOW or JNL not found."
            );

            return;
        }


        // ==================================================
        // 4. ACTUAL STATION TIMES
        // ==================================================

        const mowDeparture =
            mananwala.actualDeparture;

        const jnlArrival =
            jandiala.actualArrival;


        if (
            !mowDeparture ||
            !jnlArrival
        ) {

            console.log(
                "\n❌ Actual MOW departure or JNL arrival unavailable."
            );

            return;
        }


        console.log(
            "\n========== ACTUAL ANCHOR TIMES ==========\n"
        );

        console.log(
            "MOW departure:",
            formatTime(
                new Date(mowDeparture)
            )
        );

        console.log(
            "JNL arrival:",
            formatTime(
                new Date(jnlArrival)
            )
        );


        const totalSegmentTime =
            (
                new Date(jnlArrival).getTime() -
                new Date(mowDeparture).getTime()
            ) / 60000;


        console.log(
            "Actual MOW → JNL travel time:",
            totalSegmentTime.toFixed(2),
            "minutes"
        );


        // ==================================================
        // 5. STATION DISTANCE
        // ==================================================

        const mowPosition =
            mananwala.distance;

        const jnlPosition =
            jandiala.distance;


        const totalDistance =
            jnlPosition -
            mowPosition;


        console.log(
            "MOW railway position:",
            mowPosition,
            "km"
        );

        console.log(
            "JNL railway position:",
            jnlPosition,
            "km"
        );

        console.log(
            "MOW → JNL distance:",
            totalDistance.toFixed(3),
            "km"
        );


        // ==================================================
        // 6. CROSSING INTERPOLATION
        // ==================================================

        console.log(
            "\n=============================================="
        );

        console.log(
            "       CROSSING PASSAGE ESTIMATES"
        );

        console.log(
            "==============================================\n"
        );


        for (
            const crossing of crossings
        ) {


            // ----------------------------------------------
            // Crossing GPS
            // ----------------------------------------------

            const crossingPoint =
                turf.point([
                    crossing.lng,
                    crossing.lat
                ]);


            // ----------------------------------------------
            // Project crossing onto railway
            // ----------------------------------------------

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


            // ----------------------------------------------
            // Distance from MOW
            // ----------------------------------------------

            const distanceFromMOW =
                crossingPosition -
                mowPosition;


            // ----------------------------------------------
            // Fraction of MOW → JNL
            // ----------------------------------------------

            const fraction =
                distanceFromMOW /
                totalDistance;


            // ----------------------------------------------
            // Interpolated passage time
            // ----------------------------------------------

            const passageTime =
                interpolateTime(
                    mowDeparture,
                    jnlArrival,
                    fraction
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
                "Distance from MOW:",
                distanceFromMOW.toFixed(3),
                "km"
            );

            console.log(
                "Fraction:",
                fraction.toFixed(4)
            );

            console.log(
                "Estimated passage:",
                formatTime(passageTime)
            );

            console.log(
                "----------------------------------------------"
            );
        }


        // ==================================================
        // 7. SPECIAL JANDIALA CHECK
        // ==================================================

        const jandialaCrossing =
            crossings.find(
                crossing =>
                    crossing.id === "jandiala"
            );


        const jandialaPoint =
            turf.point([
                jandialaCrossing.lng,
                jandialaCrossing.lat
            ]);


        const jandialaNearest =
            turf.nearestPointOnLine(
                railwayLine,
                jandialaPoint,
                {
                    units: "kilometers"
                }
            );


        const jandialaCrossingPosition =
            jandialaNearest.properties.location;


        const jandialaFraction =
            (
                jandialaCrossingPosition -
                mowPosition
            ) /
            totalDistance;


        const jandialaPassage =
            interpolateTime(
                mowDeparture,
                jnlArrival,
                jandialaFraction
            );


        console.log(
            "\n=============================================="
        );

        console.log(
            "       JANDIALA SPECIAL CHECK"
        );

        console.log(
            "==============================================\n"
        );

        console.log(
            "JNL arrival:",
            formatTime(
                new Date(jnlArrival)
            )
        );

        console.log(
            "JNL crossing:",
            jandialaCrossingPosition.toFixed(3),
            "km"
        );

        console.log(
            "Crossing → JNL:",
            (
                jnlPosition -
                jandialaCrossingPosition
            ).toFixed(3),
            "km"
        );

        console.log(
            "Interpolated crossing:",
            formatTime(
                jandialaPassage
            )
        );


        console.log(
            "\n==============================================\n"
        );


    } catch (error) {

        console.error(
            "\n❌ TIME INTERPOLATION TEST FAILED\n"
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


testCrossingInterpolation();