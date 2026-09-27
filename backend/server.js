/* ============================================================
   FATAKFORECAST — BACKEND HTTP SERVER & RUNTIME API
   Production-grade HTTP server, unified snapshot provider,
   autonomous monitoring loop, and security-hardened routing.
============================================================ */

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const {
    V1_CROSSINGS,
    V1_CROSSING_MAP,
    TIMING_CONFIG
} = require("./config/corridor");

const {
    getActiveSnapshot,
    saveSnapshot,
    buildUnavailableSnapshot
} = require("./services/forecast-snapshot");

const {
    runCorridorCycle
} = require("./services/corridor-engine");

const {
    getOrFetchForecast
} = require("./services/on-demand-forecast");

const {
    recordGateObservation
} = require("./services/gate-observer");

const {
    matchEvents
} = require("./services/event-matcher");

const {
    getDatasetSummary
} = require("./services/closure-predictor");

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const FRONTEND_DIR = path.resolve(
    path.join(__dirname, "..", "frontend")
);

const EVENTS_FILE = path.resolve(
    path.join(__dirname, "data", "crossing-events.json")
);

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".woff": "font/woff"
};

/* ============================================================
   JSON RESPONSE & CORS HELPER
============================================================ */

function sendJson(res, statusCode, data, extraHeaders = {}) {
    const payload = JSON.stringify(data);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        ...extraHeaders
    });
    res.end(payload);
}

/* ============================================================
   SAFE AUDIT EVENTS READER
============================================================ */

function readHistoricalEvents() {
    try {
        if (!fs.existsSync(EVENTS_FILE)) {
            return [];
        }
        const raw = fs.readFileSync(EVENTS_FILE, "utf8");
        if (!raw.trim()) {
            return [];
        }
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error("⚠️ Failed to read historical crossing events:", err.message);
        return [];
    }
}

/* ============================================================
   REQUEST BODY / RATE-LIMIT HELPERS
============================================================ */

const observationRateLimit = new Map();
const MAX_OBSERVATION_BODY_BYTES = 16 * 1024;
const OBSERVATION_RATE_WINDOW_MS = 60 * 1000;
const OBSERVATION_RATE_MAX = 20;

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        let size = 0;

        req.on("data", chunk => {
            size += chunk.length;
            if (size > MAX_OBSERVATION_BODY_BYTES) {
                reject(new Error("Request body too large."));
                req.destroy();
                return;
            }
            body += chunk.toString("utf8");
        });

        req.on("end", () => {
            if (!body.trim()) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error("Invalid JSON body."));
            }
        });

        req.on("error", reject);
    });
}

function allowObservationSubmission(req) {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
    const now = Date.now();
    const current = observationRateLimit.get(ip) || { start: now, count: 0 };

    if (now - current.start >= OBSERVATION_RATE_WINDOW_MS) {
        current.start = now;
        current.count = 0;
    }

    current.count += 1;
    observationRateLimit.set(ip, current);
    return current.count <= OBSERVATION_RATE_MAX;
}

function parseOptionalTimestamp(value, field) {
    if (value == null || value === "") return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`${field} is invalid.`);
    return date.toISOString();
}

/* ============================================================
   REQUEST HANDLER
============================================================ */

async function handleRequest(req, res) {
    // 1. CORS Preflight
    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Accept"
        });
        res.end();
        return;
    }

    if (!["GET", "HEAD", "POST"].includes(req.method)) {
        return sendJson(res, 405, {
            success: false,
            error: "Method not allowed"
        });
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    // --------------------------------------------------------
    // API: MANUAL GATE GROUND-TRUTH OBSERVATION
    // --------------------------------------------------------
    if (pathname === "/api/observations" && req.method === "POST") {
        if (!allowObservationSubmission(req)) {
            return sendJson(res, 429, { success: false, error: "Too many observation submissions. Try again later." });
        }

        try {
            const body = await parseJsonBody(req);
            const crossing = V1_CROSSING_MAP.get(String(body.crossingId || ""));
            if (!crossing) throw new Error("Unknown crossingId.");

            const gateCloseTime = parseOptionalTimestamp(body.gateCloseTime, "gateCloseTime");
            const gateOpenTime = parseOptionalTimestamp(body.gateOpenTime, "gateOpenTime");
            const trainPassageTime = parseOptionalTimestamp(body.trainPassageTime, "trainPassageTime");

            if (!gateCloseTime || !trainPassageTime) {
                throw new Error("gateCloseTime and trainPassageTime are required for a verified training observation.");
            }

            const closeMs = new Date(gateCloseTime).getTime();
            const passMs = new Date(trainPassageTime).getTime();
            const openMs = gateOpenTime ? new Date(gateOpenTime).getTime() : null;
            const leadMinutes = (passMs - closeMs) / 60000;

            if (leadMinutes < 0 || leadMinutes > 30) {
                throw new Error("Gate close must occur 0–30 minutes before train passage.");
            }
            if (openMs != null && openMs < closeMs) {
                throw new Error("Gate open time cannot be before gate close time.");
            }

            const observation = recordGateObservation({
                crossingId: crossing.id,
                crossingName: crossing.name,
                gateCloseTime,
                gateOpenTime,
                trainPassageTime,
                direction: body.direction || null,
                trainNumber: body.trainNumber || null,
                notes: body.notes || null,
                userFeedback: body.feedback || null
            });

            const matching = matchEvents(15);
            const dataset = getDatasetSummary();

            return sendJson(res, 201, {
                success: true,
                observation,
                matching,
                dataset
            });
        } catch (error) {
            return sendJson(res, 400, { success: false, error: error.message });
        }
    }


    // --------------------------------------------------------
    // API: HEALTH CHECK
    // --------------------------------------------------------
    if (pathname === "/api/health") {
        const snapshot = getActiveSnapshot();
        const generatedTime = new Date(snapshot.generatedAt).getTime();
        const ageMs = Date.now() - generatedTime;

        return sendJson(res, 200, {
            success: true,
            status: "healthy",
            uptimeSeconds: Math.floor(process.uptime()),
            snapshotAgeMs: Number.isFinite(ageMs) ? ageMs : null,
            freshness: snapshot.freshness,
            engineStatus: snapshot.engineStatus
        });
    }

    // --------------------------------------------------------
    // API: V1 CROSSINGS LIST
    // --------------------------------------------------------
    if (pathname === "/api/crossings") {
        return sendJson(res, 200, {
            success: true,
            count: V1_CROSSINGS.length,
            crossings: V1_CROSSINGS
        });
    }

    // --------------------------------------------------------
    // API: COMPLETE UNIFIED FORECAST (On-Demand User Triggered)
    // --------------------------------------------------------
    if (pathname === "/api/forecast") {
        const forceRefresh = parsedUrl.searchParams.get("refresh") === "true";
        const result = await getOrFetchForecast({ forceRefresh });
        const snapshot = result.snapshot;
        const forecasts = V1_CROSSINGS.map(c => snapshot.crossings[c.id]);

        const freshness = snapshot.freshness;
        const dataFreshness = snapshot.dataFreshness || (freshness === "LIVE_FRESH" ? "LIVE" : freshness);
        const engineStatus = snapshot.engineStatus;

        return sendJson(res, 200, {
            success: true,
            snapshotId: snapshot.snapshotId,
            updatedAt: snapshot.generatedAt,
            liveDataTimestamp: snapshot.liveDataTimestamp,
            liveDataFetchedAt: snapshot.liveDataFetchedAt || snapshot.liveDataTimestamp,
            telemetryAgeSeconds: snapshot.telemetryAgeSeconds != null ? snapshot.telemetryAgeSeconds : null,
            forecastAgeSeconds: snapshot.forecastAgeSeconds != null ? snapshot.forecastAgeSeconds : null,
            source: snapshot.source || "LIVE_RADAR",
            freshness,
            dataFreshness,
            engineStatus,
            cacheHit: result.cacheHit,
            deduplicated: result.deduplicated,
            cacheAgeSeconds: result.cacheAgeSeconds,
            cacheTtlSeconds: result.cacheTtlSeconds,
            refreshIntervalMs: result.refreshIntervalMs,
            isTrainApproaching: result.isTrainApproaching,
            requestsMade: result.requestsMade || 0,
            isCycleRunning: false,
            forecastHorizonMinutes: snapshot.forecastHorizonMinutes,
            extendedHorizonMinutes: snapshot.extendedHorizonMinutes || 120,
            lastTrainPassed: snapshot.lastTrainPassed || null,
            forecasts,
            corridorQueue: snapshot.corridorQueue
        });
    }

    // --------------------------------------------------------
    // API: SINGLE CROSSING FORECAST (/api/crossings/:id or /api/crossing/:id)
    // --------------------------------------------------------
    const singleMatch = pathname.match(/^\/api\/crossings?\/([^/]+)$/);
    if (singleMatch) {
        const crossingId = decodeURIComponent(singleMatch[1]);
        const forceRefresh = parsedUrl.searchParams.get("refresh") === "true";
        const result = await getOrFetchForecast({ forceRefresh });
        const snapshot = result.snapshot;
        const crossingForecast = snapshot.crossings[crossingId];

        if (!crossingForecast) {
            return sendJson(res, 404, {
                success: false,
                error: "Crossing not found"
            });
        }

        return sendJson(res, 200, {
            success: true,
            snapshotId: snapshot.snapshotId,
            updatedAt: snapshot.generatedAt,
            freshness: snapshot.freshness,
            cacheHit: result.cacheHit,
            cacheAgeSeconds: result.cacheAgeSeconds,
            refreshIntervalMs: result.refreshIntervalMs,
            isTrainApproaching: result.isTrainApproaching,
            ...crossingForecast
        });
    }

    // --------------------------------------------------------
    // API: RAW HISTORICAL EVENTS (Audit / Calibration)
    // --------------------------------------------------------
    if (pathname === "/api/events") {
        const events = readHistoricalEvents();
        return sendJson(res, 200, {
            success: true,
            count: events.length,
            events
        });
    }

    // --------------------------------------------------------
    // API: SANITIZED DIAGNOSTICS (Zero Secret Leakage)
    // --------------------------------------------------------
    if (pathname === "/api/diagnostics") {
        const snapshot = getActiveSnapshot();
        return sendJson(res, 200, {
            success: true,
            snapshotId: snapshot.snapshotId,
            freshness: snapshot.freshness,
            engineStatus: snapshot.engineStatus,
            diagnostics: snapshot.diagnostics
        });
    }

    // --------------------------------------------------------
    // API 404
    // --------------------------------------------------------
    if (pathname.startsWith("/api/")) {
        return sendJson(res, 404, {
            success: false,
            error: "Endpoint not found"
        });
    }

    // --------------------------------------------------------
    // STATIC FILE SERVING (Path Traversal Protected)
    // --------------------------------------------------------
    let relativePath = pathname === "/" ? "/index.html" : pathname;
    try {
        relativePath = decodeURIComponent(relativePath);
    } catch (e) {
        return sendJson(res, 400, { success: false, error: "Malformed URL" });
    }

    const safePath = path.normalize(path.join(FRONTEND_DIR, relativePath));

    // Path traversal defense
    if (!safePath.startsWith(FRONTEND_DIR)) {
        return sendJson(res, 403, {
            success: false,
            error: "Forbidden"
        });
    }

    fs.stat(safePath, (err, stats) => {
        if (err || !stats.isFile()) {
            // If requesting a file that doesn't exist, check index.html fallback for SPA
            const indexPath = path.join(FRONTEND_DIR, "index.html");
            if (fs.existsSync(indexPath)) {
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-cache"
                });
                return fs.createReadStream(indexPath).pipe(res);
            }

            return sendJson(res, 404, {
                success: false,
                error: "File not found"
            });
        }

        const ext = path.extname(safePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";

        res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": ext === ".html" ? "no-cache, no-store, must-revalidate" : "public, max-age=3600"
        });

        fs.createReadStream(safePath).pipe(res);
    });
}

/* ============================================================
   AUTONOMOUS BACKGROUND MONITORING LOOP
============================================================ */

let monitorInterval = null;
let isCycleRunning = false;

async function runScheduledCycle() {
    if (isCycleRunning) {
        console.log("⏳ Previous cycle still running, skipping overlapping execution.");
        return;
    }

    isCycleRunning = true;
    try {
        console.log(`\n🚦 [Monitor] Starting corridor discovery cycle (${new Date().toLocaleTimeString()})...`);
        await runCorridorCycle();
    } catch (err) {
        console.error("❌ [Monitor] Cycle error:", err.message);
    } finally {
        isCycleRunning = false;
    }
}

function startBackgroundMonitor() {
    console.log("ℹ️ Autonomous background monitoring loop is DISABLED (ON-DEMAND architecture active).");
    console.log("ℹ️ Zero RailRadar requests will be made while the application has no active users.");
    console.log(`⚡ On-demand cache TTL: ${TIMING_CONFIG.FORECAST_CACHE_TTL_MS / 1000}s | Adaptive refresh: ${TIMING_CONFIG.APPROACHING_REFRESH_INTERVAL_MS / 1000}s (active) / ${TIMING_CONFIG.NORMAL_REFRESH_INTERVAL_MS / 1000}s (quiet).`);
}

/* ============================================================
   SERVER INITIALIZATION & SHUTDOWN
============================================================ */

const server = http.createServer(handleRequest);

if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`\n==================================================`);
        console.log(`   FATAKFORECAST PRODUCTION SERVER RUNNING`);
        console.log(`   URL: http://localhost:${PORT}`);
        console.log(`   Frontend: ${FRONTEND_DIR}`);
        console.log(`   Forecast Horizon: ${TIMING_CONFIG.FORECAST_HORIZON_MINUTES} minutes`);
        console.log(`==================================================\n`);

        startBackgroundMonitor();
    });
}

function gracefulShutdown(signal) {
    console.log(`\n🛑 Received ${signal}. Gracefully shutting down FatakForecast server...`);

    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }

    server.close(() => {
        console.log("✅ HTTP server closed. Process terminating cleanly.");
        process.exit(0);
    });

    // Forced exit fallback after 5 seconds
    setTimeout(() => {
        console.warn("⚠️ Forced shutdown after timeout.");
        process.exit(0);
    }, 5000);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

module.exports = server;