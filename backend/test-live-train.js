require("dotenv").config();
const axios = require("axios");

const API_KEY = process.env.RAILRADAR_API_KEY;

async function testLiveTrain() {
    try {
        const response = await axios.get(
            "https://api.railradar.in/v1/trains/18310/live",
            {
                headers: {
                    Authorization: `Bearer ${API_KEY}`
                },
                params: {
                    authoritative: true
                }
            }
        );

        const data = response.data.data;

        console.log("\n========== TRAIN ==========");
        console.log("Number:", data.trainNumber);
        console.log("Name:", data.trainName);
        console.log("Status:", data.status);
        console.log("Delay:", data.delayMinutes, "minutes");
        console.log("Is Live:", data.isLive);

        console.log("\n========== CURRENT LOCATION ==========");
        console.log(data.currentLocation);

        console.log("\n========== PREVIOUS HALT ==========");
        console.log(data.previousHalt);

        console.log("\n========== NEXT HALT ==========");
        console.log(data.nextHalt);

        console.log("\n========== LAST UPDATED ==========");
        console.log(data.lastUpdatedAt);

    } catch (error) {
        console.error("API request failed.");

        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Response:", error.response.data);
        } else {
            console.error(error.message);
        }
    }
}

testLiveTrain();