const {
    getTrainLive,
    getTrainRoute
} = require("./services/railradar");

const {
    findNearestPointOnRailway,
    mapCrossingsToTrainRoute
} = require("./services/geometry");

const crossings =
    require("./config/crossing");


// ======================================================
// MAIN
// ======================================================

async function main() {

    const trainNumber = "15211";


    console.log("========================================");
    console.log("GEOMETRY DEBUG — TRAIN 15211");
    console.log("========================================");


    // ==================================================
    // 1. GET LIVE DATA
    // ==================================================

    const live =
        await getTrainLive(trainNumber);


    if (
        !live
    ) {

        throw new Error(
            "Live train data unavailable."
        );
    }


    // ==================================================
    // 2. GET TRAIN ROUTE
    // ==================================================

    const route =
        await getTrainRoute(trainNumber);


    if (
        !route
    ) {

        throw new Error(
            "Train route unavailable."
        );
    }


    console.log("");
    console.log(
        "Route received."
    );


    console.log(
        "Route keys:",
        Object.keys(route)
    );


    // ==================================================
    // 3. CHECK GEOJSON
    // ==================================================

    console.log(
        "GeoJSON type:",
        route?.geojson?.type
    );


    console.log(
        "GeoJSON geometry type:",
        route?.geojson?.geometry?.type
    );


    console.log(
        "GeoJSON coordinate count:",
        route?.geojson?.geometry?.coordinates?.length
    );


    if (
        !route?.geojson?.geometry?.coordinates
    ) {

        throw new Error(
            "Railway GeoJSON coordinates unavailable."
        );
    }


    // ==================================================
    // 4. USE LIVE ROUTE
    // ==================================================
    //
    // IMPORTANT:
    //
    // route.stops from getTrainRoute()
    // contains station coordinates.
    //
    // live.route contains RailRadar's
    // station distance values.
    //
    // Therefore the geometry mapper needs BOTH.
    // ==================================================

    const routeStations =
        Array.isArray(live?.route)
            ? live.route
            : [];


    console.log("");
    console.log(
        "LIVE ROUTE station count:",
        routeStations.length
    );


    if (
        routeStations.length === 0
    ) {

        throw new Error(
            "RailRadar live route station data unavailable."
        );
    }


    // ==================================================
    // 5. CURRENT TRAIN LOCATION
    // ==================================================

    console.log("");
    console.log(
        "========== CURRENT TRAIN =========="
    );


    console.dir(
        live?.currentLocation,
        {
            depth: 10
        }
    );


    // ==================================================
    // 6. FIND JNL
    // ==================================================

    const jnl =
        routeStations.find(
            station =>
                String(
                    station?.stationCode ||
                    ""
                ).toUpperCase() ===
                "JNL"
        );


    // ==================================================
    // 7. FIND MOW
    // ==================================================

    const mow =
        routeStations.find(
            station =>
                String(
                    station?.stationCode ||
                    ""
                ).toUpperCase() ===
                "MOW"
        );


    console.log("");
    console.log(
        "========== LIVE ROUTE ANCHORS =========="
    );


    console.log("");
    console.log("JNL:");

    console.dir(
        jnl,
        {
            depth: 10
        }
    );


    console.log("");
    console.log("MOW:");

    console.dir(
        mow,
        {
            depth: 10
        }
    );


    // ==================================================
    // 8. VALIDATE ANCHORS
    // ==================================================

    if (!jnl) {

        throw new Error(
            "JNL not found in live.route."
        );
    }


    if (!mow) {

        throw new Error(
            "MOW not found in live.route."
        );
    }


    console.log("");
    console.log(
        "Anchor distances:"
    );


    console.log(
        `JNL: ${jnl.distance} km`
    );


    console.log(
        `MOW: ${mow.distance} km`
    );


    // ==================================================
    // 9. SHOW CROSSINGS
    // ==================================================

    console.log("");
    console.log(
        "========== CROSSINGS =========="
    );


    for (
        const crossing of crossings
    ) {

        console.log("");

        console.log(
            crossing.name
        );

        console.log(
            "ID:",
            crossing.id
        );

        console.log(
            "Coordinates:",
            crossing.coordinates
        );
    }


    // ==================================================
    // 10. TEST RAW PHYSICAL GEOMETRY
    // ==================================================

    console.log("");
    console.log(
        "========== TESTING NEAREST POINT =========="
    );


    for (
        const crossing of crossings
    ) {

        try {

            const result =
                findNearestPointOnRailway(
                    crossing,
                    route.geojson
                );


            console.log("");

            console.log(
                `✅ ${crossing.name}`
            );


            console.log(
                `Railway distance: ${
                    result.distanceFromRailwayKm.toFixed(4)
                } km`
            );


            console.log(
                `Geometry position: ${
                    result.locationAlongRailwayKm.toFixed(3)
                } km`
            );


            console.log(
                `Nearest railway point: ` +
                `${result.nearestRailwayPoint.lat}, ` +
                `${result.nearestRailwayPoint.lng}`
            );


        } catch (error) {

            console.log("");

            console.log(
                `❌ ${crossing.name}`
            );


            console.log(
                "ERROR:",
                error.message
            );
        }
    }


    // ==================================================
    // 11. TEST TRAIN-ROUTE MAPPING
    // ==================================================

    console.log("");
    console.log(
        "========== TESTING ROUTE MAPPING =========="
    );


    let mapped;


    try {

        mapped =
            mapCrossingsToTrainRoute(
                crossings,
                route.geojson,
                routeStations,
                route.stops,
                "JNL",
                "MOW"
            );


    } catch (error) {

        console.log("");
        console.log(
            "❌ MAPPING ERROR"
        );

        console.error(
            error
        );

        return;
    }


    // ==================================================
    // 12. RAW MAPPING RESULT
    // ==================================================

    console.log("");

    console.dir(
        mapped,
        {
            depth: 10
        }
    );


    // ==================================================
    // 13. CLEAN MAPPING SUMMARY
    // ==================================================

    console.log("");
    console.log(
        "========== CLEAN MAPPING =========="
    );


    if (
        mapped.length === 0
    ) {

        console.log(
            "❌ No crossings were mapped."
        );

    } else {

        for (
            const item of mapped
        ) {

            console.log("");

            console.log(
                `${item.crossingName}`
            );

            console.log(
                `  RailRadar position: ${
                    item.routeDistanceKm.toFixed(3)
                } km`
            );

            console.log(
                `  Railway offset: ${
                    item.railwayDistanceKm.toFixed(4)
                } km`
            );

            console.log(
                `  JNL anchor: ${
                    item.anchorStart.distanceKm
                } km`
            );

            console.log(
                `  MOW anchor: ${
                    item.anchorEnd.distanceKm
                } km`
            );

            console.log(
                `  Geometry fraction: ${
                    item.geometry.fraction
                }`
            );
        }
    }


    // ==================================================
    // 14. ORDER CHECK
    // ==================================================

    console.log("");
    console.log(
        "========== ORDER CHECK =========="
    );


    const sorted =
        [...mapped]
            .sort(
                (a, b) =>
                    a.routeDistanceKm -
                    b.routeDistanceKm
            );


    if (
        sorted.length > 0
    ) {

        console.log(
            "\nJNL → MOW route order:"
        );


        for (
            const item of sorted
        ) {

            console.log(
                `  ${item.routeDistanceKm.toFixed(3)} km | ${
                    item.crossingName
                }`
            );
        }
    }


    // ==================================================
    // 15. EXPECTED PHYSICAL ORDER
    // ==================================================

    console.log("");
    console.log(
        "Expected physical order:"
    );

    console.log(
        "  JNL"
    );

    console.log(
        "  ↓ Jandiala Railway Crossing"
    );

    console.log(
        "  ↓ Rakh Devi Dasspura Fatak"
    );

    console.log(
        "  ↓ Manawala Road Fatak"
    );

    console.log(
        "  ↓ Talwandi Dogran Fatak"
    );

    console.log(
        "  ↓ MOW"
    );


    // ==================================================
    // 16. FINAL SUMMARY
    // ==================================================

    console.log("");
    console.log(
        "========================================"
    );


    console.log(
        `Mapped crossings: ${
            mapped.length
        }/${crossings.length}`
    );


    if (
        mapped.length ===
        crossings.length
    ) {

        console.log(
            "✅ ALL FOUR CROSSINGS MAPPED"
        );

    } else {

        console.log(
            "⚠️ SOME CROSSINGS COULD NOT BE MAPPED"
        );
    }


    console.log(
        "========================================"
    );
}


// ======================================================
// ERROR HANDLER
// ======================================================

main().catch(
    error => {

        console.error("");
        console.error(
            "========================================"
        );

        console.error(
            "❌ FATAL ERROR"
        );

        console.error(
            error.message
        );

        console.error(
            "========================================"
        );

        console.error(
            error
        );
    }
);