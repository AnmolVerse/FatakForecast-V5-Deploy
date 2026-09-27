const crossings = [
    {
        name: "Talwandi Dogran Fatak",
        railwayPositionKm: 219.102
    },
    {
        name: "Manawala Road Fatak",
        railwayPositionKm: 221.130
    },
    {
        name: "Rakh Devi Dasspura Fatak",
        railwayPositionKm: 222.590
    },
    {
        name: "Jandiala Railway Crossing",
        railwayPositionKm: 224.779
    }
];

const trainPositionKm = 134.875;

console.log("\n========== DISTANCE TO CROSSINGS ==========\n");

crossings.forEach((crossing, index) => {

    const distance =
        crossing.railwayPositionKm - trainPositionKm;

    console.log(`${index + 1}. ${crossing.name}`);

    console.log(
        "   Distance:",
        distance.toFixed(3),
        "km"
    );

    console.log("");
});