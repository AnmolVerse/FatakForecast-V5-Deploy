const {
    getTrainLive
} = require("./services/railradar");

async function main() {

    const trainNumber = "15211";

    console.log("========================================");
    console.log("LIVE ROUTE DISTANCE DEBUG");
    console.log("========================================");

    const live =
        await getTrainLive(trainNumber);


    console.log("\n========== CURRENT LOCATION ==========");

    console.dir(
        live?.currentLocation,
        {
            depth: 10
        }
    );


    console.log("\n========== ROUTE AROUND JNL/MOW ==========");

    const route =
        Array.isArray(live?.route)
            ? live.route
            : [];


    const relevant =
        route.filter(
            station =>
                Number(station.sequence) >= 228 &&
                Number(station.sequence) <= 236
        );


    console.dir(
        relevant,
        {
            depth: 10
        }
    );


    console.log("\n========== ALL POSSIBLE DISTANCE FIELDS ==========");

    for (
        const station of relevant
    ) {

        console.log(
            `Sequence ${station.sequence} | ` +
            `${station.code} | ` +
            `${station.name}`
        );

        console.log(
            "Keys:",
            Object.keys(station)
        );

        console.log(
            "Values:",
            station
        );

        console.log("");
    }


    console.log("========================================");
}


main().catch(error => {

    console.error(error);

});