/**
 * FatakForecast ML closure model
 *
 * A deliberately conservative first ML layer:
 * - target: actual gate-closure lead time in minutes
 * - features available BEFORE prediction: crossing, direction, time-of-day,
 *   day-of-week and month seasonality
 * - chronological train/test split to avoid temporal leakage
 * - ridge regression with an explicit comparison against the 11-minute baseline
 *
 * The model is NEVER used until it has enough verified observations and
 * demonstrably beats the baseline on a held-out chronological test set.
 */

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "../data/matched-events.json");
const MIN_SAMPLES = 20;
const MIN_TEST_SAMPLES = 5;
const RIDGE_LAMBDA = 1.0;
const BASELINE_LEAD_MINUTES = 11;

const CROSSINGS = [
    "talwandi-dogran",
    "manawala-road",
    "rakh-devi-dasspura",
    "jandiala"
];

function readMatches() {
    try {
        if (!fs.existsSync(DATA_FILE)) return [];
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function finite(value) {
    return Number.isFinite(Number(value));
}

function parseDate(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function targetFromEvent(event) {
    const value = Number(event?.closure_lead_time_minutes);
    return finite(value) && value >= 0 && value <= 30 ? value : null;
}

function buildFeatures({ crossingId, direction, passageTime }) {
    const date = parseDate(passageTime);
    if (!date) return null;

    const hour = date.getHours() + date.getMinutes() / 60;
    const day = date.getDay();
    const month = date.getMonth();

    const features = [1];

    for (const crossing of CROSSINGS) {
        features.push(crossingId === crossing ? 1 : 0);
    }

    features.push(direction === "forward" ? 1 : 0);
    features.push(direction === "backward" ? 1 : 0);

    features.push(Math.sin((2 * Math.PI * hour) / 24));
    features.push(Math.cos((2 * Math.PI * hour) / 24));
    features.push(Math.sin((2 * Math.PI * day) / 7));
    features.push(Math.cos((2 * Math.PI * day) / 7));
    features.push(Math.sin((2 * Math.PI * month) / 12));
    features.push(Math.cos((2 * Math.PI * month) / 12));

    return features;
}

function transpose(matrix) {
    return matrix[0].map((_, column) => matrix.map(row => row[column]));
}

function multiply(A, B) {
    const rows = A.length;
    const cols = B[0].length;
    const inner = B.length;
    const out = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (let i = 0; i < rows; i++) {
        for (let k = 0; k < inner; k++) {
            const a = A[i][k];
            if (a === 0) continue;
            for (let j = 0; j < cols; j++) {
                out[i][j] += a * B[k][j];
            }
        }
    }
    return out;
}

function solveLinearSystem(A, b) {
    const n = A.length;
    const M = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
        }

        if (Math.abs(M[pivot][col]) < 1e-10) return null;
        [M[col], M[pivot]] = [M[pivot], M[col]];

        const pivotValue = M[col][col];
        for (let j = col; j <= n; j++) M[col][j] /= pivotValue;

        for (let row = 0; row < n; row++) {
            if (row === col) continue;
            const factor = M[row][col];
            if (factor === 0) continue;
            for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
        }
    }

    return M.map(row => row[n]);
}

function fitRidge(X, y) {
    const Xt = transpose(X);
    const XtX = multiply(Xt, X);
    const Xty = multiply(Xt, y.map(value => [value]));

    for (let i = 1; i < XtX.length; i++) {
        XtX[i][i] += RIDGE_LAMBDA;
    }

    const coefficients = solveLinearSystem(
        XtX,
        Xty.map(row => row[0])
    );

    return coefficients;
}

function dot(a, b) {
    let total = 0;
    for (let i = 0; i < a.length; i++) total += a[i] * b[i];
    return total;
}

function evaluate(coefficients, rows) {
    if (!coefficients || !rows.length) return null;

    const errors = rows.map(row => dot(coefficients, row.features) - row.target);
    const mae = errors.reduce((sum, e) => sum + Math.abs(e), 0) / errors.length;
    const rmse = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length);
    const mean = rows.reduce((sum, row) => sum + row.target, 0) / rows.length;
    const ssTot = rows.reduce((sum, row) => sum + Math.pow(row.target - mean, 2), 0);
    const ssRes = errors.reduce((sum, e) => sum + e * e, 0);
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;

    const baselineErrors = rows.map(row => BASELINE_LEAD_MINUTES - row.target);
    const baselineMae = baselineErrors.reduce((sum, e) => sum + Math.abs(e), 0) / baselineErrors.length;

    return {
        samples: rows.length,
        mae: Number(mae.toFixed(3)),
        rmse: Number(rmse.toFixed(3)),
        r2: r2 == null ? null : Number(r2.toFixed(3)),
        baselineMae: Number(baselineMae.toFixed(3)),
        beatsBaseline: mae < baselineMae * 0.95
    };
}

function prepareRows(events = null) {
    const sourceEvents = Array.isArray(events) ? events : readMatches();
    return sourceEvents
        .map(event => {
            const target = targetFromEvent(event);
            const passageTime = event.actual_train_passage_time || event.predicted_passage_time;
            const features = target == null ? null : buildFeatures({
                crossingId: event.crossing_id,
                direction: event.direction,
                passageTime
            });
            if (!features) return null;
            return {
                timestamp: parseDate(passageTime).getTime(),
                features,
                target
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.timestamp - b.timestamp);
}

function trainModel(events = null) {
    const rows = prepareRows(events);
    if (rows.length < MIN_SAMPLES) {
        return {
            ready: false,
            reason: "insufficient_verified_observations",
            sampleCount: rows.length,
            minimumSamples: MIN_SAMPLES
        };
    }

    const split = Math.max(MIN_TEST_SAMPLES, Math.floor(rows.length * 0.8));
    if (rows.length - split < MIN_TEST_SAMPLES) {
        return { ready: false, reason: "insufficient_test_samples", sampleCount: rows.length };
    }

    const trainRows = rows.slice(0, split);
    const testRows = rows.slice(split);
    const coefficients = fitRidge(
        trainRows.map(row => row.features),
        trainRows.map(row => row.target)
    );

    if (!coefficients) {
        return { ready: false, reason: "model_fit_failed", sampleCount: rows.length };
    }

    const evaluation = evaluate(coefficients, testRows);
    const accepted = Boolean(evaluation?.beatsBaseline);

    return {
        ready: accepted,
        candidateReady: true,
        accepted,
        sampleCount: rows.length,
        trainSamples: trainRows.length,
        testSamples: testRows.length,
        evaluation,
        coefficients: accepted ? coefficients : null,
        reason: accepted ? "ml_beats_baseline" : "baseline_still_better"
    };
}

const METADATA_FILE = path.resolve(__dirname, "../../ml/artifacts/model_metadata.json");
const PREDICT_PY = path.resolve(__dirname, "../../ml/inference/predict.py");

let cachedModel = null;
let cachedAt = 0;
const MODEL_CACHE_MS = 30 * 1000;
const inferenceCache = new Map();
const INFERENCE_CACHE_TTL_MS = 60 * 1000;

function getModel() {
    if (cachedModel && Date.now() - cachedAt < MODEL_CACHE_MS) return cachedModel;

    const matches = readMatches();
    const sampleCount = matches.length;

    // Check if Python ML pipeline has promoted a model
    let metadata = null;
    try {
        if (fs.existsSync(METADATA_FILE)) {
            metadata = JSON.parse(fs.readFileSync(METADATA_FILE, "utf8"));
        }
    } catch {
        metadata = null;
    }

    if (metadata && metadata.promoted === true && (metadata.trained_on_samples || 0) >= MIN_SAMPLES) {
        cachedModel = {
            ready: true,
            candidateReady: true,
            accepted: true,
            promoted: true,
            sampleCount,
            modelName: metadata.model_name || "Promoted_ML_Model",
            evaluation: metadata,
            reason: "ml_beats_baseline"
        };
    } else {
        // Fall back strictly to baseline (or train in-memory if custom dataset provided)
        const inMemory = sampleCount >= MIN_SAMPLES ? trainModel(matches) : null;
        if (inMemory && inMemory.ready) {
            cachedModel = inMemory;
        } else {
            cachedModel = {
                ready: false,
                candidateReady: sampleCount >= MIN_SAMPLES,
                accepted: false,
                promoted: false,
                sampleCount,
                minimumSamples: MIN_SAMPLES,
                reason: sampleCount < MIN_SAMPLES ? "insufficient_verified_observations" : "baseline_still_better"
            };
        }
    }

    cachedAt = Date.now();
    return cachedModel;
}

function predict({ crossingId, direction, passageTime, speedKmph, delayMinutes }) {
    const model = getModel();
    if (!model.ready) return null;

    const date = parseDate(passageTime);
    if (!date) return null;

    // If promoted Python artifact exists, use Python inference engine with caching
    if (model.promoted) {
        const cacheKey = `${crossingId}|${direction}|${date.toISOString().slice(0, 16)}|${Math.round(speedKmph || 60)}|${Math.round(delayMinutes || 0)}`;
        const cached = inferenceCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < INFERENCE_CACHE_TTL_MS) {
            return cached.result;
        }

        try {
            const { execFileSync } = require("child_process");
            const pyCmd = process.env.PYTHON_CMD || (process.platform === "win32" ? "python" : "python3");
            const stdout = execFileSync(pyCmd, [
                PREDICT_PY,
                "--crossing", crossingId,
                "--direction", direction,
                "--passage", date.toISOString(),
                "--speed", String(speedKmph || 60.0),
                "--delay", String(delayMinutes || 0.0)
            ], {
                timeout: 3000,
                encoding: "utf8",
                windowsHide: true
            });

            const parsed = JSON.parse(stdout);
            if (!parsed || parsed.is_fallback) {
                return null;
            }

            const leadMinutes = Number(parsed.lead_minutes);
            if (!Number.isFinite(leadMinutes) || leadMinutes < 2 || leadMinutes > 30) {
                return null;
            }

            const result = {
                leadMinutes: Math.max(2, Math.min(30, Number(leadMinutes.toFixed(2)))),
                uncertaintyRange: parsed.uncertainty_range,
                modelName: parsed.model_name || model.modelName,
                evaluation: model.evaluation,
                sampleCount: model.sampleCount
            };

            inferenceCache.set(cacheKey, { timestamp: Date.now(), result });
            return result;
        } catch {
            // Safe fallback if python execution fails
            return null;
        }
    }

    // Fallback: in-memory linear solver if coefficients exist
    if (!model.coefficients) return null;

    const features = buildFeatures({ crossingId, direction, passageTime });
    if (!features) return null;

    const predicted = dot(model.coefficients, features);
    if (!Number.isFinite(predicted)) return null;

    return {
        leadMinutes: Math.max(2, Math.min(30, Number(predicted.toFixed(2)))),
        evaluation: model.evaluation,
        sampleCount: model.sampleCount
    };
}

module.exports = {
    trainModel,
    getModel,
    predict,
    prepareRows,
    MIN_SAMPLES
};
