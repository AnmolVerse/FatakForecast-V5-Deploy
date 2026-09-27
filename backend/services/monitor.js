const {
    runMonitoringCycle
} = require("./corridor-engine");


// ======================================================
// CONFIGURATION
// ======================================================

// Wait this long AFTER a cycle finishes before starting
// the next cycle.
//
// This prevents overlapping API calls and skipped cycles.
const POLL_INTERVAL_MS = 2 * 60 * 1000;


// ======================================================
// STATE
// ======================================================

let cycleNumber = 0;


// ======================================================
// SLEEP
// ======================================================

function sleep(ms) {
    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}


// ======================================================
// RUN ONE CYCLE
// ======================================================

async function runCycle() {

    cycleNumber++;

    console.log("");
    console.log("");
    console.log("########################################");

    console.log(
        `       FATAKFORECAST CYCLE #${cycleNumber}`
    );

    console.log("########################################");

    const cycleStartedAt =
        Date.now();

    try {

        await runMonitoringCycle();

        console.log("");

        console.log(
            `⏱ Cycle runtime: ${
                (
                    (Date.now() - cycleStartedAt) /
                    1000
                ).toFixed(1)
            } sec`
        );

    } catch (error) {

        console.error("");

        console.error(
            "❌ Monitoring cycle crashed:"
        );

        console.error(
            error?.stack ||
            error?.message ||
            error
        );

    }

    console.log("");

    console.log(
        `⏳ Waiting ${
            POLL_INTERVAL_MS / 60000
        } minutes before next cycle...`
    );

    console.log(
        "########################################"
    );
}


// ======================================================
// START CONTINUOUS MONITOR
// ======================================================
//
// IMPORTANT:
//
// DO NOT use setInterval() here.
//
// A cycle can take longer than two minutes because it
// processes several trains sequentially.
//
// Instead:
//
//     cycle
//       ↓
//     wait 2 minutes
//       ↓
//     cycle
//       ↓
//     wait 2 minutes
//
// Therefore there can never be two cycles running
// simultaneously.
// ======================================================

async function startMonitor() {

    console.log("");

    console.log(
        "========================================"
    );

    console.log(
        "       FATAKFORECAST LIVE MONITOR"
    );

    console.log(
        "========================================"
    );

    console.log(
        "Monitoring station: JNL"
    );

    console.log(
        "V1 crossings: 4"
    );

    console.log(
        "Immediate forecast window: 60 minutes"
    );

    console.log(
        `Polling interval after completion: ${
            POLL_INTERVAL_MS / 60000
        } minutes`
    );

    console.log("");

    console.log(
        "Press CTRL + C to stop."
    );

    console.log(
        "========================================"
    );


    // --------------------------------------------------
    // Continuous sequential monitoring
    // --------------------------------------------------

    while (true) {

        await runCycle();

        await sleep(
            POLL_INTERVAL_MS
        );
    }
}


// ======================================================
// START
// ======================================================

startMonitor()
    .catch(
        error => {

            console.error("");

            console.error(
                "❌ Fatal monitor error:"
            );

            console.error(
                error?.stack ||
                error?.message ||
                error
            );

            process.exit(1);
        }
    );