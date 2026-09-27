const {
    recordGateObservation,
    getGateDataset
} = require("./services/gate-observer");


function main() {

    console.log("");
    console.log("========================================");
    console.log("       FATAKFORECAST GATE TEST");
    console.log("========================================");


    const observation =
        recordGateObservation({

            crossingId:
                "rakh-devi-dasspura",

            crossingName:
                "Rakh Devi Dasspura Fatak",

            gateCloseTime:
                "2026-09-11T14:40:00+05:30",

            gateOpenTime:
                "2026-09-11T14:49:00+05:30",

            trainPassageTime:
                "2026-09-11T14:47:00+05:30",

            direction:
                "forward",

            trainNumber:
                "TEST",

            notes:
                "TEST RECORD — DELETE AFTER VERIFICATION"
        });


    console.log("");
    console.log("Raw observation:");
    console.log(
        JSON.stringify(
            observation,
            null,
            2
        )
    );


    const dataset =
        getGateDataset();


    console.log("");
    console.log("Derived metrics:");
    console.log(
        JSON.stringify(
            dataset[dataset.length - 1],
            null,
            2
        )
    );


    console.log("");
    console.log("========================================");
    console.log("          GATE TEST COMPLETE");
    console.log("========================================");
}


main();