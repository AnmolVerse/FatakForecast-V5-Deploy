const assert = require("assert");
const { trainModel, MIN_SAMPLES } = require("./services/ml-closure-model");

const crossings = [
    "jandiala",
    "rakh-devi-dasspura",
    "manawala-road",
    "talwandi-dogran"
];

const rows = [];
for (let i = 0; i < 40; i++) {
    const passage = new Date(Date.UTC(2026, 0, 1 + i));
    passage.setUTCHours((i * 3) % 24, 0, 0, 0);
    const hourWave = Math.sin((passage.getUTCHours() / 24) * Math.PI * 2) * 0.8;
    const target = 10.5 + (i % 4) * 0.2 + hourWave;

    rows.push({
        crossing_id: crossings[i % crossings.length],
        direction: i % 2 ? "forward" : "backward",
        actual_train_passage_time: passage.toISOString(),
        closure_lead_time_minutes: Number(target.toFixed(2)),
        closure_duration_minutes: 1
    });
}

const result = trainModel(rows);

assert.strictEqual(rows.length >= MIN_SAMPLES, true);
assert.strictEqual(result.candidateReady, true);
assert.strictEqual(result.ready, true);
assert.strictEqual(result.accepted, true);
assert.strictEqual(result.evaluation.beatsBaseline, true);
assert.ok(result.evaluation.mae < result.evaluation.baselineMae);

console.log("ML closure model test passed:");
console.log(JSON.stringify(result.evaluation, null, 2));
