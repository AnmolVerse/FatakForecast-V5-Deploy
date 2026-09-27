const {
    calculateETA,
    calculateETAWithBuffer
} = require("./services/eta");

const assert = require("assert");

console.log("\n========== ETA TEST ==========\n");

const live = {
    status: "running",
    currentLocation: {
        speedKmh: 60
    }
};

// --------------------------------------------------
// TEST 1 — Valid forward ETA
// --------------------------------------------------

const forwardETA = calculateETA(
    {
        km: 10
    },
    {
        positionKm: 15
    },
    "forward",
    live
);

console.log("TEST 1 — Forward ETA:");
console.log(forwardETA);

assert.strictEqual(
    forwardETA.available,
    true,
    "Forward ETA should be available"
);

assert(
    forwardETA.etaMinutes > 0 &&
    forwardETA.etaMinutes < 10,
    `Unexpected forward ETA: ${forwardETA.etaMinutes}`
);

// --------------------------------------------------
// TEST 2 — Valid backward ETA
// --------------------------------------------------

const backwardETA = calculateETA(
    {
        km: 20
    },
    {
        positionKm: 15
    },
    "backward",
    live
);

console.log("\nTEST 2 — Backward ETA:");
console.log(backwardETA);

assert.strictEqual(
    backwardETA.available,
    true,
    "Backward ETA should be available"
);

assert(
    backwardETA.etaMinutes > 0 &&
    backwardETA.etaMinutes < 10,
    `Unexpected backward ETA: ${backwardETA.etaMinutes}`
);

// --------------------------------------------------
// TEST 3 — Unknown direction
// --------------------------------------------------

const unknownDirectionETA = calculateETA(
    {
        km: 10
    },
    {
        positionKm: 15
    },
    null,
    live
);

console.log("\nTEST 3 — Unknown direction:");
console.log(unknownDirectionETA);

assert.strictEqual(
    unknownDirectionETA.available,
    false,
    "Unknown direction must be unavailable"
);

assert.strictEqual(
    unknownDirectionETA.reason,
    "unknown-direction",
    "Unknown direction should return unknown-direction"
);

// --------------------------------------------------
// TEST 4 — Not-started train without departure anchor
// --------------------------------------------------

// --------------------------------------------------
// TEST 4 — Past crossing must be unavailable
// --------------------------------------------------

const pastCrossingETA = calculateETA(
    {
        km: 20
    },
    {
        positionKm: 15
    },
    "forward",
    live
);

console.log("\nTEST 4 — Past crossing:");
console.log(pastCrossingETA);

assert.strictEqual(
    pastCrossingETA.available,
    false,
    "A crossing behind the train must be unavailable"
);

assert.strictEqual(
    pastCrossingETA.reason,
    "invalid-or-past-crossing",
    "Past crossing should return invalid-or-past-crossing"
);

// --------------------------------------------------
// TEST 5 — ETA with buffer
// --------------------------------------------------

const bufferedETA = calculateETAWithBuffer(
    {
        km: 10
    },
    {
        positionKm: 15
    },
    "forward",
    live,
    2
);

console.log("\nTEST 5 — ETA with 2-minute buffer:");
console.log(bufferedETA);

assert.strictEqual(
    bufferedETA.available,
    true,
    "Buffered ETA should be available"
);

assert.strictEqual(
    bufferedETA.bufferMinutes,
    2,
    "Buffer should be 2 minutes"
);

assert(
    bufferedETA.closureStartTime,
    "Buffered ETA should contain closureStartTime"
);

console.log("\n✅ All ETA tests passed.\n");