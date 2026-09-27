/* ============================================================
   FATAKFORECAST — CORRIDOR CONFIGURATION
   Centralized corridor constants, physical crossing order,
   anchor stations, and timing invariants.
============================================================ */

const V1_CROSSINGS = [
    {
        id: "talwandi-dogran",
        name: "Talwandi Dogran Fatak",
        coordinates: {
            lat: 31.605083,
            lng: 74.996645
        }
    },
    {
        id: "manawala-road",
        name: "Manawala Road Fatak",
        coordinates: {
            lat: 31.599745,
            lng: 75.017127
        }
    },
    {
        id: "rakh-devi-dasspura",
        name: "Rakh Devi Dasspura Fatak",
        coordinates: {
            lat: 31.595879,
            lng: 75.031856
        }
    },
    {
        id: "jandiala",
        name: "Jandiala Railway Crossing",
        coordinates: {
            lat: 31.590162,
            lng: 75.053973
        }
    }
];

const V1_CROSSING_MAP = new Map(V1_CROSSINGS.map(c => [c.id, c]));

/*
 * Strict Physical Ordering along track:
 *
 * FORWARD (West to East / Amritsar to Delhi / MOW → JNL):
 *   MOW → Talwandi Dogran → Manawala Road → Rakh Devi Dasspura → Jandiala (JNL)
 *
 * BACKWARD (East to West / Delhi to Amritsar / JNL → MOW):
 *   JNL → Jandiala → Rakh Devi Dasspura → Manawala Road → Talwandi Dogran → MOW
 */
const FORWARD_CROSSING_ORDER = [
    "talwandi-dogran",
    "manawala-road",
    "rakh-devi-dasspura",
    "jandiala"
];

const BACKWARD_CROSSING_ORDER = [
    "jandiala",
    "rakh-devi-dasspura",
    "manawala-road",
    "talwandi-dogran"
];

const ANCHOR_STATIONS = {
    MOW: {
        code: "MOW",
        name: "Mananwala",
        lat: 31.6126164,
        lng: 74.9665763
    },
    JNL: {
        code: "JNL",
        name: "Jandiala",
        lat: 31.5892298,
        lng: 75.0568715
    }
};

const TIMING_CONFIG = {
    // Immediate user-facing forecast horizon: strictly 60 minutes
    FORECAST_HORIZON_MINUTES: 60,
    FORECAST_HORIZON_PRIMARY_MINUTES: 60,
    FORECAST_HORIZON_EXTENDED_MINUTES: 120,

    // Station discovery window: 8 hours
    DISCOVERY_HOURS: 8,

    // Quota protection: max trains analyzed per cycle (top priority corridor trains)
    MAX_TRAINS_PER_CYCLE: 4,

    // Delay between individual train requests in a cycle
    DELAY_BETWEEN_TRAINS_MS: 2000,

    // Polling interval between monitoring cycles
    POLL_INTERVAL_MS: 60 * 1000,

    // Continuous closure practical threshold for closely spaced trains (minutes)
    CONTINUOUS_CLOSURE_THRESHOLD_MINUTES: 10,

    // Central passage reference timing model
    // 1. > 15 min before passage: OPEN
    // 2. 8 min - 15 min before passage: TRAIN APPROACHING
    // 3. 8 min before passage to passage: FATAK CLOSED
    // 4. 0 - 1.5 min after passage: FATAK CLOSED
    // 5. > 1.5 min after passage: OPEN
    TIMELINE_CONFIG: {
        APPROACH_MINUTES: 15,
        CLOSURE_MINUTES: 11,
        LIKELY_CLOSURE_OFFSET_MINUTES: 11,
        LIKELY_REOPEN_OFFSET_MINUTES: 1,
        LEAD_BUFFER_LABEL: "11 min baseline",
        CONTINUOUS_CLOSURE_THRESHOLD_MINUTES: 10
    },

    // Gate closure lead time before train passage (minutes)
    GATE_CLOSURE_LEAD_MINUTES: {
        earliest: 11,
        likely: 11,
        latest: 11,
        recommendedCrossBuffer: 12
    },

    // Gate reopening buffer after train passage (minutes)
    GATE_REOPEN_BUFFER_MINUTES: {
        earliest: 1,
        latest: 1
    },

    // Snapshot freshness thresholds (4-tier state machine)
    SNAPSHOT_FRESH_THRESHOLD_MS: 2 * 60 * 1000,       // < 2 minutes: LIVE
    SNAPSHOT_AGING_THRESHOLD_MS: 5 * 60 * 1000,       // 2–5 minutes: AGING
    SNAPSHOT_STALE_THRESHOLD_MS: 10 * 60 * 1000,      // 5–10 minutes: STALE
    SNAPSHOT_UNAVAILABLE_THRESHOLD_MS: 10 * 60 * 1000,// > 10 minutes: UNAVAILABLE

    // Cache TTLs
    LIVE_TRAIN_CACHE_TTL_MS: 20 * 1000,               // 20 seconds
    ROUTE_CACHE_TTL_MS: 24 * 60 * 60 * 1000           // 24 hours
};

module.exports = {
    V1_CROSSINGS,
    V1_CROSSING_MAP,
    FORWARD_CROSSING_ORDER,
    BACKWARD_CROSSING_ORDER,
    ANCHOR_STATIONS,
    TIMING_CONFIG,
    CORRIDOR: TIMING_CONFIG,
    FORECAST_HORIZON_PRIMARY_MINUTES: TIMING_CONFIG.FORECAST_HORIZON_PRIMARY_MINUTES,
    FORECAST_HORIZON_EXTENDED_MINUTES: TIMING_CONFIG.FORECAST_HORIZON_EXTENDED_MINUTES
};
