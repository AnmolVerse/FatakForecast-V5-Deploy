const {
    matchEvents
} = require("./services/event-matcher");


function main() {

    try {

        const result =
            matchEvents(15);


        console.log("");

        console.log(
            "FINAL MATCH RESULT:"
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
            "❌ MATCHER FAILED:"
        );

        console.error(
            error.message
        );
    }
}


main();