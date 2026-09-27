const { resolveTrainPosition } = require("./services/corridor-monitor");

const live = {
  currentLocation: { sequence: 2, segmentProgress: 0.5, distanceFromOriginKm: 999 },
  route: [
    { sequence: 1, distance: 0 },
    { sequence: 2, distance: 55 },
    { sequence: 3, distance: 96 }
  ]
};

const result = resolveTrainPosition(live);
console.log(result);
if (Math.abs(result.positionKm - 75.5) > 0.001) process.exit(1);
console.log("PASS: route-compatible position resolution");
