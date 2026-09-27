const {
    runMonitoringCycle
} = require("./services/corridor-engine");


async function main() {

    try {

        const result =
            await runMonitoringCycle();


        console.log("");
        console.log("FINAL RESULT:");
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
            "❌ ENGINE FAILED:"
        );

        console.error(
            error.message
        );
    }
}


main();