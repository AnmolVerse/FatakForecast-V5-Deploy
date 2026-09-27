const {
    observeTrain
} = require("./services/train-observer");


async function main() {

    try {

        const result =
            await observeTrain("18310");

        console.log("");

        console.log(
            "RESULT:"
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
            "❌ ERROR:"
        );

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