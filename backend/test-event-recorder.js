const {
    analyzeTrain
} = require("./services/corridor-monitor");

const {
    recordTrainCrossingEvents
} = require("./services/event-recorder");


async function main() {

    console.log("");
    console.log("========================================");
    console.log("     FATAKFORECAST EVENT TEST");
    console.log("========================================");


    try {

        const analysis =
            await analyzeTrain("18310");


        const result =
            recordTrainCrossingEvents(
                analysis
            );


        console.log("");

        console.log(
            "FINAL EVENT RESULT:"
        );

        console.log(
            JSON.stringify(
                result,
                null,
                2
            )
        );


    } catch (error) {

        console.error("");

        console.error(
            "❌ TEST FAILED:"
        );

        console.error(
            error.message
        );
    }
}


main();