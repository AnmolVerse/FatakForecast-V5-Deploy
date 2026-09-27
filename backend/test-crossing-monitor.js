const {
    monitorTrain
} = require("./services/crossing-monitor");

async function main() {

    try {

        await monitorTrain("12013");

    } catch (error) {

        console.error("");
        console.error("❌ ERROR:");
        console.error(error.message);
    }
}

main();