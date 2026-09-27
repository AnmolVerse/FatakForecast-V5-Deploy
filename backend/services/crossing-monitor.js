const crossings = require("../config/crossing");

const {
    getTrainLive,
    getTrainRoute
} = require("./railradar");

const {
    findNearestPointOnRailway
} = require("./geometry");


// ======================================================
// Find all V1 crossings relative to a train
// ======================================================

async function monitorTrain(trainNumber) {

    console.log("");
    console.log("========================================");
    console.log("       FATAKFORECAST CROSSING MONITOR");
    console.log("========================================");

    console.log(`Train: ${trainNumber}`);


    // --------------------------------------------------
    // 1. Live train
    // --------------------------------------------------

    const live =
        await getTrainLive(trainNumber);

    if (!live || !live.currentLocation) {
        throw new Error(
            "Live train position unavailable."
        );
    }


    const currentLocation =
        live.currentLocation;


    const trainPosition =
        Number(
            currentLocation.distanceFromOriginKm
        );


    if (!Number.isFinite(trainPosition)) {
        throw new Error(
            "Train railway position unavailable."
        );
    }


    console.log(
        `Train railway position: ${trainPosition.toFixed(3)} km`
    );


    // --------------------------------------------------
    // 2. Railway route
    // --------------------------------------------------

    const route =
        await getTrainRoute(trainNumber);

    if (
        !route ||
        !route.geojson
    ) {
        throw new Error(
            "Railway route unavailable."
        );
    }


    // --------------------------------------------------
    // 3. Locate all crossings
    // --------------------------------------------------

    const results = [];


    for (const crossing of crossings) {

        const result =
            findNearestPointOnRailway(
                crossing,
                route.geojson
            );


        if (!result) {
            continue;
        }


        const crossingPosition =
            Number(
                result.locationAlongRailwayKm
            );


        const distanceKm =
            crossingPosition -
            trainPosition;


        results.push({

            id: crossing.id,

            name: crossing.name,

            railwayPositionKm:
                crossingPosition,

            distanceKm,

            status:
                distanceKm > 0
                    ? "approaching"
                    : "passed"
        });
    }


    // --------------------------------------------------
    // Sort by railway distance
    // --------------------------------------------------

    results.sort(
        (a, b) =>
            a.distanceKm -
            b.distanceKm
    );


    // --------------------------------------------------
    // Display
    // --------------------------------------------------

    console.log("");
    console.log("========================================");
    console.log("              V1 CROSSINGS");
    console.log("========================================");


    for (const crossing of results) {

        console.log("");
        console.log(
            crossing.name
        );

        console.log(
            `Railway position: ${crossing.railwayPositionKm.toFixed(3)} km`
        );

        console.log(
            `Distance: ${crossing.distanceKm.toFixed(3)} km`
        );

        console.log(
            `Status: ${crossing.status.toUpperCase()}`
        );
    }


    // --------------------------------------------------
    // Find next crossing
    // --------------------------------------------------

    const nextCrossing =
        results.find(
            crossing =>
                crossing.distanceKm > 0
        );


    console.log("");
    console.log("========================================");
    console.log("             NEXT CROSSING");
    console.log("========================================");


    if (!nextCrossing) {

        console.log(
            "No V1 crossing ahead."
        );

    } else {

        console.log(
            `🚂 ${nextCrossing.name}`
        );

        console.log(
            `Distance: ${nextCrossing.distanceKm.toFixed(3)} km`
        );
    }


    console.log("");
    console.log("========================================");
    console.log("                DONE");
    console.log("========================================");


    return {

        trainNumber:
            String(trainNumber),

        trainPositionKm:
            trainPosition,

        crossings:
            results,

        nextCrossing:
            nextCrossing || null
    };
}


module.exports = {
    monitorTrain
};