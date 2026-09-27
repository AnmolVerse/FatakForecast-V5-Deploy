const {
    getStationLive
} = require("./services/railradar");

const {
    analyzeTrain
} = require("./services/corridor-monitor");


// ======================================================
// CONFIGURATION
// ======================================================

// Maximum number of trains to analyze in one scan.
// Keep this low while using the free API quota.
const MAX_TRAINS_TO_ANALYZE = 3;

// Delay between train analyses.
// Helps avoid API rate limits.
const DELAY_BETWEEN_TRAINS_MS = 5000;


// ======================================================
// DELAY HELPER
// ======================================================

function sleep(ms) {

    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}


// ======================================================
// GET TRAIN NUMBER
// ======================================================

function getTrainNumber(item) {

    if (
        item &&
        item.train &&
        item.train.number
    ) {

        return String(
            item.train.number
        );
    }

    return null;
}


// ======================================================
// GET TRAIN NAME
// ======================================================

function getTrainName(item) {

    if (
        item &&
        item.train &&
        item.train.name
    ) {

        return item.train.name;
    }

    return "";
}


// ======================================================
// MAIN
// ======================================================

async function main() {

    console.log("");
    console.log("========================================");
    console.log("     FATAKFORECAST CORRIDOR SCAN");
    console.log("========================================");


    try {

        // ==================================================
        // 1. DISCOVER TRAINS AT JANDIALA
        // ==================================================

        console.log("");
        console.log("📡 Checking JNL live board...");


        const data =
            await getStationLive("JNL");


        const trains =
            Array.isArray(data.trains)
                ? data.trains
                : [];


        console.log(
            `Candidate trains found: ${trains.length}`
        );


        if (trains.length === 0) {

            console.log("");
            console.log(
                "ℹ️ No candidate trains found."
            );

            console.log("");
            console.log(
                "No corridor analysis required."
            );

            return;
        }


        // ==================================================
        // 2. EXTRACT VALID TRAINS
        // ==================================================

        const candidates = [];


        for (const item of trains) {

            const trainNumber =
                getTrainNumber(item);


            if (!trainNumber) {
                continue;
            }


            candidates.push({

                trainNumber,

                trainName:
                    getTrainName(item),

                raw:
                    item
            });
        }


        console.log(
            `Valid train candidates: ${candidates.length}`
        );


        // ==================================================
        // 3. LIMIT API USAGE
        // ==================================================

        const selected =
            candidates.slice(
                0,
                MAX_TRAINS_TO_ANALYZE
            );


        console.log("");
        console.log(
            `Analyzing maximum ${selected.length} train(s) in this scan.`
        );


        // ==================================================
        // 4. ANALYZE TRAINS ONE BY ONE
        // ==================================================

        for (
            let i = 0;
            i < selected.length;
            i++
        ) {

            const item =
                selected[i];


            const trainNumber =
                item.trainNumber;


            const trainName =
                item.trainName;


            console.log("");
            console.log("----------------------------------------");

            console.log(
                `🔎 Checking ${trainNumber} — ${trainName}`
            );

            console.log(
                `Progress: ${i + 1}/${selected.length}`
            );

            console.log(
                "----------------------------------------");


            try {

                const result =
                    await analyzeTrain(
                        trainNumber
                    );


                // ==================================================
                // 5. APPROACHING CROSSING
                // ==================================================

                if (
                    result &&
                    result.nextCrossing
                ) {

                    const crossing =
                        result.nextCrossing;


                    console.log("");
                    console.log(
                        "🚨 APPROACHING V1 CROSSING"
                    );


                    console.log(
                        `Train: ${trainNumber}`
                    );


                    console.log(
                        `Name: ${
                            result.trainName ||
                            trainName ||
                            "Unknown"
                        }`
                    );


                    console.log(
                        `Direction: ${
                            result.direction
                        }`
                    );


                    console.log(
                        `Crossing: ${
                            crossing.name
                        }`
                    );


                    console.log(
                        `Distance: ${
                            crossing.distanceKm
                        } km`
                    );


                    if (
                        crossing.etaMinutes != null
                    ) {

                        console.log(
                            `ETA: ${
                                crossing.etaMinutes
                            } min`
                        );
                    }


                    if (
                        crossing.estimatedPassageTime
                    ) {

                        console.log(
                            `Estimated passage: ${
                                crossing.estimatedPassageTime
                            }`
                        );
                    }

                }


                // ==================================================
                // 6. DIRECTION UNKNOWN
                // ==================================================

                else if (
                    result &&
                    (
                        result.direction ===
                        "unknown" ||

                        result.direction ===
                        "stationary"
                    )
                ) {

                    console.log("");

                    console.log(
                        "⏳ Direction not established yet."
                    );

                    console.log(
                        "Another observation is required."
                    );
                }


                // ==================================================
                // 7. NO APPROACHING CROSSING
                // ==================================================

                else {

                    console.log("");

                    console.log(
                        "✅ No V1 crossing currently within approach range."
                    );
                }


            } catch (error) {

                console.log("");

                console.log(
                    `⚠️ Could not analyze ${trainNumber}`
                );


                if (error.response) {

                    console.log(
                        `HTTP ${error.response.status}`
                    );


                    if (
                        error.response.data
                    ) {

                        console.log(
                            error.response.data
                        );
                    }

                } else {

                    console.log(
                        error.message
                    );
                }
            }


            // ==================================================
            // 8. RATE-LIMIT PROTECTION
            // ==================================================

            if (
                i <
                selected.length - 1
            ) {

                console.log("");

                console.log(
                    `⏱️ Waiting ${
                        DELAY_BETWEEN_TRAINS_MS / 1000
                    } seconds before next train...`
                );


                await sleep(
                    DELAY_BETWEEN_TRAINS_MS
                );
            }
        }


        // ==================================================
        // 9. COMPLETE
        // ==================================================

        console.log("");
        console.log("========================================");
        console.log("          CORRIDOR SCAN COMPLETE");
        console.log("========================================");


    } catch (error) {

        console.error("");
        console.error(
            "❌ DISCOVERY ERROR:"
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


// ======================================================
// START
// ======================================================

main();