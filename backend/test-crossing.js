const crossings = require("./config/crossing");

console.log("\n========== FATAKFORECAST CROSSINGS ==========\n");

crossings.forEach((crossing, index) => {
    console.log(`${index + 1}. ${crossing.name}`);
    console.log(`   ID: ${crossing.id}`);
    console.log(`   Latitude: ${crossing.coordinates.lat}`);
    console.log(`   Longitude: ${crossing.coordinates.lng}`);
    console.log("");
});