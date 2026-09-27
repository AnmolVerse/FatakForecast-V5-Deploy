require("dotenv").config();
const axios = require("axios");

const API_KEY = process.env.RAILRADAR_API_KEY;

async function testRailRadar() {
    try {
        const response = await axios.get(
            "https://api.railradar.in/v1/stations/JNL/live",
            {
                headers: {
                    Authorization: `Bearer ${API_KEY}`
                }
            }
        );

        console.log(JSON.stringify(response.data, null, 2));

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

testRailRadar();