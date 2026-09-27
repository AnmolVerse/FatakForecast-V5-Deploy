const {
    getStationLive
} = require("./services/railradar");


async function main() {

    console.log("");
    console.log("========================================");
    console.log("       RAW JNL LIVE BOARD");
    console.log("========================================");


    try {

        const data =
            await getStationLive("JNL");


        console.log("");

        console.log(
            JSON.stringify(
                data,
                null,
                2
            )
        );


        console.log("");
        console.log("========================================");
        console.log("       JNL BOARD TEST COMPLETE");
        console.log("========================================");


    } catch (error) {

        console.error("");
        console.error("❌ ERROR");


        if (error.response) {

            console.error(
                `HTTP ${error.response.status}`
            );


            console.error(
                JSON.stringify(
                    error.response.data,
                    null,
                    2
                )
            );

        } else {

            console.error(
                error.message
            );
        }
    }
}


main();















