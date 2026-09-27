/* ============================================================
   FATAKFORECAST — ON-DEMAND USER-TRIGGERED FORECAST SERVICE
   Production Quota Protection & Active-Session Controller
   Guarantees:
   1. ZERO RailRadar calls when application is not in use.
   2. Short server-side cache (TTL: 60s default) for active clients.
   3. Simultaneous request deduplication (1 in-flight cycle).
   4. Adaptive refresh recommendation based on approaching trains.
============================================================ */

const {
    TIMING_CONFIG
} = require("../config/corridor");

const {
    getActiveSnapshot,
    saveSnapshot,
    buildUnavailableSnapshot
} = require("./forecast-snapshot");

const {
    runCorridorCycle
} = require("./corridor-engine");

const {
    getRequestStats
} = require("./railradar");

// State tracking for on-demand caching and in-flight deduplication
let lastCycleCompletedAt = 0;
let inFlightCyclePromise = null;
let lastCycleResult = null;

/**
 * Checks whether any relevant train is approaching any of the corridor crossings
 * or is currently within the active closure/passage window (<= 20 minutes ETA).
 * Used to recommend an adaptive refresh interval to active frontend clients.
 */
function checkIfTrainApproaching(snapshot, customNow = null) {
    if (!snapshot || !snapshot.crossings) {
        return false;
    }

    const now = customNow ? (typeof customNow === "number" ? customNow : new Date(customNow).getTime()) : Date.now();
    const APPROACHING_WINDOW_MS = 20 * 60 * 1000; // 20 minutes

    // 1. Check all 4 crossings
    for (const crossingId of Object.keys(snapshot.crossings)) {
        const crossing = snapshot.crossings[crossingId];
        if (!crossing) continue;

        // Active closure states
        if (
            crossing.status === "TRAIN APPROACHING" ||
            crossing.status === "CLOSING_SOON" ||
            crossing.status === "CLOSED"
        ) {
            return true;
        }

        // ETA check on primary train
        const passageStr = crossing.trainPassage?.estimatedTime || crossing.primaryTrain?.estimatedPassageTime;
        if (passageStr) {
            const passageMs = new Date(passageStr).getTime();
            const diffMs = passageMs - now;
            // From 1 minute after passage up to 20 minutes ahead
            if (diffMs >= -60 * 1000 && diffMs <= APPROACHING_WINDOW_MS) {
                return true;
            }
        }
    }

    // 2. Check corridor queue
    if (Array.isArray(snapshot.corridorQueue)) {
        for (const item of snapshot.corridorQueue) {
            const passageStr = item.estimatedPassageTime || item.estimated_passage_time;
            if (passageStr) {
                const passageMs = new Date(passageStr).getTime();
                const diffMs = passageMs - now;
                if (diffMs >= -60 * 1000 && diffMs <= APPROACHING_WINDOW_MS) {
                    return true;
                }
            }
        }
    }

    return false;
}

/**
 * Executes or retrieves an on-demand forecast.
 * - If cached data exists within FORECAST_CACHE_TTL_MS, returns immediately (Cache HIT, 0 RailRadar calls).
 * - If an in-flight cycle is currently running, deduplicates and awaits the shared Promise.
 * - Otherwise initiates a single RailRadar cycle on demand (Cache MISS).
 */
async function getOrFetchForecast(options = {}) {
    const forceRefresh = Boolean(options.forceRefresh);
    const now = options.now ? (typeof options.now === "number" ? options.now : new Date(options.now).getTime()) : Date.now();
    const cacheTtlMs = TIMING_CONFIG.FORECAST_CACHE_TTL_MS || 60 * 1000;

    // Check if existing snapshot is fresh enough in memory/disk
    const currentSnapshot = getActiveSnapshot(now);
    const hasValidSnapshot = currentSnapshot && currentSnapshot.freshness !== "UNAVAILABLE";
    const snapshotAgeMs = now - (lastCycleCompletedAt || (currentSnapshot?.generatedAt ? new Date(currentSnapshot.generatedAt).getTime() : 0));

    // 1. Cache HIT: Return existing snapshot without touching RailRadar
    if (!forceRefresh && hasValidSnapshot && lastCycleCompletedAt > 0 && snapshotAgeMs < cacheTtlMs) {
        const isTrainApproaching = checkIfTrainApproaching(currentSnapshot, now);
        const refreshIntervalMs = isTrainApproaching
            ? TIMING_CONFIG.APPROACHING_REFRESH_INTERVAL_MS
            : TIMING_CONFIG.NORMAL_REFRESH_INTERVAL_MS;

        console.log(`⚡ [OnDemand] Cache HIT (age: ${Math.round(snapshotAgeMs / 1000)}s, TTL: ${cacheTtlMs / 1000}s) — 0 RailRadar calls.`);

        return {
            snapshot: currentSnapshot,
            cacheHit: true,
            deduplicated: false,
            cacheAgeSeconds: Math.max(0, Math.floor(snapshotAgeMs / 1000)),
            cacheTtlSeconds: Math.floor(cacheTtlMs / 1000),
            isTrainApproaching,
            refreshIntervalMs,
            requestsMade: 0
        };
    }

    // 2. In-Flight Deduplication: Another client already triggered a cycle
    if (inFlightCyclePromise) {
        console.log("⏳ [OnDemand] Request deduplicated — Awaiting active in-flight RailRadar cycle...");
        await inFlightCyclePromise;

        const freshSnapshot = getActiveSnapshot(now);
        const isTrainApproaching = checkIfTrainApproaching(freshSnapshot, now);
        const refreshIntervalMs = isTrainApproaching
            ? TIMING_CONFIG.APPROACHING_REFRESH_INTERVAL_MS
            : TIMING_CONFIG.NORMAL_REFRESH_INTERVAL_MS;

        return {
            snapshot: freshSnapshot,
            cacheHit: true,
            deduplicated: true,
            cacheAgeSeconds: 0,
            cacheTtlSeconds: Math.floor(cacheTtlMs / 1000),
            isTrainApproaching,
            refreshIntervalMs,
            requestsMade: 0
        };
    }

    // 3. Cache MISS: Execute fresh on-demand cycle
    const cycleStart = Date.now();
    const initialStats = typeof getRequestStats === "function" ? getRequestStats() : { total: 0 };
    const initialRequests = initialStats.total || 0;

    console.log(`\n🚦 [OnDemand] Cache MISS (${forceRefresh ? "forced refresh" : "cache expired/initial"}) — Triggering on-demand RailRadar cycle...`);

    let cycleRequestsMade = 0;

    inFlightCyclePromise = runCorridorCycle()
        .then(result => {
            lastCycleResult = result;
            lastCycleCompletedAt = Date.now();
            const durationMs = Date.now() - cycleStart;
            const currentStats = typeof getRequestStats === "function" ? getRequestStats() : { total: initialRequests };
            cycleRequestsMade = Math.max(0, (currentStats.total || 0) - initialRequests);

            console.log(`✅ [OnDemand] RailRadar cycle completed in ${durationMs}ms — ${cycleRequestsMade} RailRadar request(s) made.`);
            return result;
        })
        .catch(err => {
            console.error(`❌ [OnDemand] RailRadar cycle error: ${err.message}`);
            // Return failure object so caller can degrade gracefully
            return {
                success: false,
                error: err.message
            };
        })
        .finally(() => {
            inFlightCyclePromise = null;
        });

    await inFlightCyclePromise;

    const freshSnapshot = getActiveSnapshot(now);
    const isTrainApproaching = checkIfTrainApproaching(freshSnapshot, now);
    const refreshIntervalMs = isTrainApproaching
        ? TIMING_CONFIG.APPROACHING_REFRESH_INTERVAL_MS
        : TIMING_CONFIG.NORMAL_REFRESH_INTERVAL_MS;

    return {
        snapshot: freshSnapshot,
        cacheHit: false,
        deduplicated: false,
        cacheAgeSeconds: 0,
        cacheTtlSeconds: Math.floor(cacheTtlMs / 1000),
        isTrainApproaching,
        refreshIntervalMs,
        requestsMade: cycleRequestsMade
    };
}

/* ============================================================
   TEST & DIAGNOSTIC HELPERS
============================================================ */

function resetCacheForTest() {
    lastCycleCompletedAt = 0;
    inFlightCyclePromise = null;
    lastCycleResult = null;
}

function setLastCycleCompletedAtForTest(timestamp) {
    lastCycleCompletedAt = timestamp;
}

function getLastCycleCompletedAt() {
    return lastCycleCompletedAt;
}

function isInFlight() {
    return inFlightCyclePromise !== null;
}

module.exports = {
    getOrFetchForecast,
    checkIfTrainApproaching,
    resetCacheForTest,
    setLastCycleCompletedAtForTest,
    getLastCycleCompletedAt,
    isInFlight
};
