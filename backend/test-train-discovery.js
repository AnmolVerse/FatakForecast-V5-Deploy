const {
    getStationLive
} = require("./services/railradar");

async function main() {

    console.log("");
    console.log("========================================");
    console.log("     FATAKFORECAST TRAIN DISCOVERY");
    console.log("========================================");

    console.log("Station: JNL");
    console.log("Fetching live trains...");

    try {

        const data =
            await getStationLive("JNL");

        console.log("");
        console.log(
            `Station: ${data.station.name} (${data.station.code})`
        );

        console.log(
            `Trains found: ${data.trains.length}`
        );

        console.log("");

        for (const item of data.trains) {

            const train = item.train;
            const stop = item.stop;
            const live = item.live;

            console.log("----------------------------------------");

            console.log(
                `Train: ${train.number}`
            );

            console.log(
                `Name: ${train.name}`
            );

            console.log(
                `Status: ${live?.type || "unknown"}`
            );

            console.log(
                `Delay: ${live?.delayMinutes ?? "N/A"} min`
            );

            console.log(
                `Expected: ${
                    live?.expectedArrivalTime ||
                    live?.expectedDepartureTime ||
                    "N/A"
                }`
            );

            console.log(
                `Sequence: ${stop?.sequence ?? "N/A"}`
            );
        }

        console.log("");
        console.log("========================================");
        console.log("          DISCOVERY COMPLETE");
        console.log("========================================");

    } catch (error) {

        console.error("");
        console.error("❌ ERROR:");

        if (error.response) {
            console.error(
                `HTTP ${error.response.status}`
            );

            console.error(
                error.response.data
            );
        } else {
            console.error(
                error.message
            );
        }
    }
}

main();