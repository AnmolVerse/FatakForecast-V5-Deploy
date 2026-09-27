require("dotenv").config();
const axios = require("axios");

const API_KEY = process.env.RAILRADAR_API_KEY;

if (!API_KEY) {
    console.warn(
        "⚠️ RAILRADAR_API_KEY is not configured. Live railway requests will fail until it is set."
    );
}

const railRadar = axios.create({
    baseURL: "https://api.railradar.in",
    timeout: 15000,
    headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json"
    }
});

/*
|--------------------------------------------------------------------------
| CACHE CONFIGURATION
|--------------------------------------------------------------------------
|
| Route geometry is effectively static during a monitoring session.
| Live train/station data is dynamic, so it gets only a short cache.
|
| IMPORTANT:
| These caches are NOT intended to make railway data stale for minutes.
| They primarily prevent duplicate API calls within the same cycle.
|
*/

const routeCache = new Map();
const trainLiveCache = new Map();
const stationLiveCache = new Map();

const ROUTE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Short TTL for dynamic data.
// This prevents duplicate requests if several parts of the backend
// ask for the same train/station within a short period.
const TRAIN_LIVE_CACHE_TTL_MS = 20 * 1000; // 20 seconds
const STATION_LIVE_CACHE_TTL_MS = 20 * 1000; // 20 seconds

/*
|--------------------------------------------------------------------------
| IN-FLIGHT REQUEST DEDUPLICATION
|--------------------------------------------------------------------------
|
| If two functions request the same resource at almost the same time,
| only ONE actual RailRadar request is made.
|
*/

const inFlightRequests = new Map();

/*
|--------------------------------------------------------------------------
| REQUEST STATS
|--------------------------------------------------------------------------
|
| Useful while developing. These counters are local only and do not
| consume API requests.
|
*/

const requestStats = {
    total: 0,
    successful: 0,
    rateLimited: 0,
    serverErrors: 0,
    otherErrors: 0,
    cacheHits: 0,
    deduplicated: 0
};

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getCacheValue(cache, key, ttl) {
    const cached = cache.get(key);

    if (!cached) {
        return null;
    }

    if (Date.now() - cached.timestamp >= ttl) {
        cache.delete(key);
        return null;
    }

    requestStats.cacheHits++;

    return cached.data;
}

function setCacheValue(cache, key, data) {
    cache.set(key, {
        data,
        timestamp: Date.now()
    });
}

function getErrorStatus(error) {
    return error?.response?.status;
}

/*
|--------------------------------------------------------------------------
| CORE REQUEST FUNCTION
|--------------------------------------------------------------------------
|
| IMPORTANT:
|
| 429 = DO NOT RETRY.
|
| A 429 from RailRadar can indicate that the plan quota/rate limit has
| been reached. Retrying repeatedly only creates unnecessary traffic and
| makes development harder.
|
| We only retry transient 5xx server errors.
|
*/

async function request(path, config = {}, options = {}) {
    const maxRetries = options.maxRetries ?? 1;

    /*
     * Build a deterministic request key so identical simultaneous
     * requests can share the same Promise.
     */
    const params = config?.params || {};

    let requestKey;

    try {
        requestKey =
            `${path}?` +
            new URLSearchParams(
                Object.entries(params).map(([key, value]) => [
                    key,
                    String(value)
                ])
            ).toString();
    } catch {
        requestKey = path;
    }

    /*
     * If this exact request is already being made, reuse it.
     */
    if (inFlightRequests.has(requestKey)) {
        requestStats.deduplicated++;

        return inFlightRequests.get(requestKey);
    }

    const executeRequest = (async () => {
        for (let attempt = 0; ; attempt++) {
            try {
                requestStats.total++;

                const response = await railRadar.get(path, config);

                requestStats.successful++;

                return response;
            } catch (error) {
                const status = getErrorStatus(error);

                /*
                 * NEVER retry 429.
                 */
                if (status === 429) {
                    requestStats.rateLimited++;

                    console.error(
                        "❌ RailRadar returned HTTP 429. " +
                        "The API request is currently rate-limited/quota-limited. " +
                        "No retry will be attempted."
                    );

                    throw error;
                }

                /*
                 * Retry only temporary server-side failures.
                 */
                if (
                    status >= 500 &&
                    status <= 599 &&
                    attempt < maxRetries
                ) {
                    requestStats.serverErrors++;

                    const delay = Math.min(
                        2000 * Math.pow(2, attempt),
                        10000
                    );

                    console.warn(
                        `⚠️ RailRadar server error (${status}). ` +
                        `Retrying in ${Math.round(delay / 1000)}s...`
                    );

                    await sleep(delay);
                    continue;
                }

                /*
                 * Non-retryable error.
                 */
                requestStats.otherErrors++;

                throw error;
            }
        }
    })();

    inFlightRequests.set(requestKey, executeRequest);

    try {
        return await executeRequest;
    } finally {
        inFlightRequests.delete(requestKey);
    }
}

/*
|--------------------------------------------------------------------------
| GET TRAIN ROUTE
|--------------------------------------------------------------------------
|
| Route geometry is static enough to cache aggressively.
|
*/

async function getTrainRoute(trainNumber) {
    const key = String(trainNumber).trim();

    if (!key) {
        throw new Error("Train number is required.");
    }

    const cached = getCacheValue(
        routeCache,
        key,
        ROUTE_CACHE_TTL_MS
    );

    if (cached) {
        return cached;
    }

    const response = await request(
        `/v1/trains/${encodeURIComponent(key)}/route`,
        {
            params: {
                format: "geojson",
                stops: true
            }
        },
        {
            maxRetries: 1
        }
    );

    const data = response?.data?.data;

    if (!data) {
        throw new Error(
            `RailRadar returned no route data for train ${key}.`
        );
    }

    setCacheValue(routeCache, key, data);

    return data;
}

/*
|--------------------------------------------------------------------------
| GET TRAIN LIVE
|--------------------------------------------------------------------------
|
| Dynamic data.
|
| Short cache prevents the same train being requested repeatedly during
| one monitoring cycle.
|
*/

async function getTrainLive(trainNumber) {
    const key = String(trainNumber).trim();

    if (!key) {
        throw new Error("Train number is required.");
    }

    const cached = getCacheValue(
        trainLiveCache,
        key,
        TRAIN_LIVE_CACHE_TTL_MS
    );

    if (cached) {
        return cached;
    }

    const response = await request(
        `/v1/trains/${encodeURIComponent(key)}/live`,
        {},
        {
            maxRetries: 1
        }
    );

    const data = response?.data?.data;

    if (!data) {
        throw new Error(
            `RailRadar returned no live data for train ${key}.`
        );
    }

    setCacheValue(trainLiveCache, key, data);

    return data;
}

/*
|--------------------------------------------------------------------------
| GET STATION LIVE
|--------------------------------------------------------------------------
|
| Used primarily for discovering relevant trains around the reference
| station.
|
*/

async function getStationLive(stationCode, options = {}) {
    const key = String(stationCode).trim().toUpperCase();

    if (!key) {
        throw new Error("Station code is required.");
    }

    const hours = Number.isFinite(Number(options.hours))
        ? Number(options.hours)
        : 4;

    const includeIntermediate =
        options.includeIntermediate !== false;

    /*
     * Include the relevant options in the cache key.
     *
     * Example:
     * JNL|2|true
     */
    const cacheKey =
        `${key}|${hours}|${includeIntermediate}`;

    const cached = getCacheValue(
        stationLiveCache,
        cacheKey,
        STATION_LIVE_CACHE_TTL_MS
    );

    if (cached) {
        return cached;
    }

    const response = await request(
        `/v1/stations/${encodeURIComponent(key)}/live`,
        {
            params: {
                hours,
                includeIntermediate
            }
        },
        {
            maxRetries: 1
        }
    );

    const data = response?.data?.data;

    if (!data) {
        throw new Error(
            `RailRadar returned no live station data for ${key}.`
        );
    }

    setCacheValue(
        stationLiveCache,
        cacheKey,
        data
    );

    return data;
}

/*
|--------------------------------------------------------------------------
| CACHE MANAGEMENT
|--------------------------------------------------------------------------
*/

function clearRouteCache() {
    routeCache.clear();
}

function clearTrainLiveCache() {
    trainLiveCache.clear();
}

function clearStationLiveCache() {
    stationLiveCache.clear();
}

function clearAllCaches() {
    routeCache.clear();
    trainLiveCache.clear();
    stationLiveCache.clear();
}

/*
|--------------------------------------------------------------------------
| REQUEST STATISTICS
|--------------------------------------------------------------------------
|
| This does NOT make an API request.
|
*/

function getRequestStats() {
    return {
        ...requestStats,
        cacheSizes: {
            routes: routeCache.size,
            trainLive: trainLiveCache.size,
            stationLive: stationLiveCache.size,
            inFlight: inFlightRequests.size
        }
    };
}

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/

module.exports = {
    getTrainRoute,
    getTrainLive,
    getStationLive,

    clearRouteCache,
    clearTrainLiveCache,
    clearStationLiveCache,
    clearAllCaches,

    getRequestStats
};