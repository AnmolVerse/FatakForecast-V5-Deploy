/**
 * FatakForecast V5 — Corridor Simulation Harness
 *
 * Generates deterministic train movement scenarios to test and verify
 * corridor prediction logic, anomaly suppression, direction detection,
 * continuous multi-train closures, and freshness state transitions.
 */

const { CORRIDOR, CROSSINGS } = require("../config/corridor");
const { determineMovement } = require("./train-observer");
const { predictClosure } = require("./closure-predictor");
const { buildForecastSnapshot } = require("./forecast-snapshot");

// Corridor geometry constants
const CORRIDOR_START_KM = 0.0;    // Mananwala (MOW)
const CORRIDOR_END_KM = 12.8;     // Jandiala (JNL)

// Crossing positions along corridor
const CROSSING_LOCATIONS = {
    "talwandi-dogran": 2.56,
    "manawala-road": 5.38,
    "rakh-devi-dasspura": 8.70,
    "jandiala": 11.26
};

const SCENARIOS = {
    ON_TIME_NORMAL: {
        id: "ON_TIME_NORMAL",
        name: "On-Time Normal Transit",
        description: "Single train moving at constant 60 km/h from MOW to JNL (forward).",
        trains: [
            {
                trainNumber: "12006",
                trainName: "Shatabdi Express",
                direction: "forward",
                initialKm: 0.0,
                speedKmh: 60.0,
                delayMinutes: 0
            }
        ],
        durationMinutes: 15,
        tickSeconds: 30
    },

    DELAYED_TRAIN: {
        id: "DELAYED_TRAIN",
        name: "Progressively Delayed Train",
        description: "Train delayed +5m, +15m, and +30m. Predictor must update ETAs and retain delay flags.",
        trains: [
            {
                trainNumber: "12460",
                trainName: "Amritsar Intercity",
                direction: "forward",
                initialKm: 1.0,
                speedKmh: 45.0,
                delayProfile: [
                    { atMinute: 0, delayMinutes: 5 },
                    { atMinute: 5, delayMinutes: 15 },
                    { atMinute: 10, delayMinutes: 30 }
                ]
            }
        ],
        durationMinutes: 15,
        tickSeconds: 30
    },

    SPEED_CHANGE: {
        id: "SPEED_CHANGE",
        name: "Dynamic Speed Variation",
        description: "Train accelerates from 30 km/h to 80 km/h mid-corridor.",
        trains: [
            {
                trainNumber: "12014",
                trainName: "Shatabdi Express",
                direction: "forward",
                initialKm: 0.5,
                speedProfile: [
                    { atMinute: 0, speedKmh: 30.0 },
                    { atMinute: 4, speedKmh: 55.0 },
                    { atMinute: 8, speedKmh: 80.0 }
                ],
                delayMinutes: 0
            }
        ],
        durationMinutes: 14,
        tickSeconds: 30
    },

    STOPPED_TRAIN: {
        id: "STOPPED_TRAIN",
        name: "Stationary Train in Corridor",
        description: "Train stops for 10 minutes at km 4.0; system flags stationary state without freezing UI.",
        trains: [
            {
                trainNumber: "18238",
                trainName: "Chhattisgarh Express",
                direction: "forward",
                initialKm: 2.0,
                speedProfile: [
                    { atMinute: 0, speedKmh: 45.0 },
                    { atMinute: 3, speedKmh: 0.0 },  // Stopped
                    { atMinute: 13, speedKmh: 50.0 } // Resumes
                ],
                delayMinutes: 10
            }
        ],
        durationMinutes: 16,
        tickSeconds: 30
    },

    DIRECTION_DETECTION: {
        id: "DIRECTION_DETECTION",
        name: "Bi-Directional Corridor Movement",
        description: "Tests forward (MOW -> JNL) and backward (JNL -> MOW) direction classification.",
        trains: [
            {
                trainNumber: "12497",
                trainName: "Shane Punjab",
                direction: "forward",
                initialKm: 0.5,
                speedKmh: 65.0,
                delayMinutes: 0
            },
            {
                trainNumber: "12498",
                trainName: "Shane Punjab Return",
                direction: "backward",
                initialKm: 12.0,
                speedKmh: 65.0,
                delayMinutes: 2
            }
        ],
        durationMinutes: 12,
        tickSeconds: 30
    },

    ANOMALOUS_JUMP: {
        id: "ANOMALOUS_JUMP",
        name: "Telemetry Glitch & GPS Teleportation",
        description: "Simulates an anomalous >25km jump or 0.000km reset; system must suppress anomaly.",
        trains: [
            {
                trainNumber: "14674",
                trainName: "Shaheed Express",
                direction: "forward",
                initialKm: 3.0,
                speedKmh: 50.0,
                anomalies: [
                    { atMinute: 2, glitchType: "GPS_RESET_ZERO" }, // 0.000 km glitch
                    { atMinute: 4, glitchType: "TELEPORT_JUMP", jumpKm: 45.0 } // 45km jump
                ]
            }
        ],
        durationMinutes: 8,
        tickSeconds: 30
    },

    CONTINUOUS_CLOSURE: {
        id: "CONTINUOUS_CLOSURE",
        name: "Multi-Train Overlapping Closure",
        description: "Two trains spaced 3.5 minutes apart causing overlapping gate closure windows.",
        trains: [
            {
                trainNumber: "12030",
                trainName: "Swarna Shatabdi",
                direction: "forward",
                initialKm: 1.0,
                speedKmh: 60.0,
                delayMinutes: 0
            },
            {
                trainNumber: "14682",
                trainName: "Jalandhar Express",
                direction: "forward",
                initialKm: -2.5, // 3.5 km behind Train 1
                speedKmh: 60.0,
                delayMinutes: 3
            }
        ],
        durationMinutes: 15,
        tickSeconds: 30
    },

    STALE_DATA: {
        id: "STALE_DATA",
        name: "Telemetry Aging & Freshness Degradation",
        description: "Updates cease; state transitions from LIVE_FRESH -> AGING -> STALE -> UNAVAILABLE.",
        trains: [
            {
                trainNumber: "11058",
                trainName: "Amritsar Express",
                direction: "forward",
                initialKm: 4.0,
                speedKmh: 55.0,
                freezeTelemetryAtMinute: 2
            }
        ],
        durationMinutes: 12,
        tickSeconds: 30
    },

    API_OUTAGE: {
        id: "API_OUTAGE",
        name: "Network Outage & Service Disruption",
        description: "Upstream API returns 503/timeout; corridor gracefully switches to DATA UNAVAILABLE.",
        simulateApiError: true,
        durationMinutes: 5,
        tickSeconds: 30
    }
};

/**
 * Execute a simulation scenario and return chronological step snapshots.
 */
function runSimulation(scenarioId, options = {}) {
    const config = SCENARIOS[scenarioId];
    if (!config) {
        throw new Error(`Unknown scenario: ${scenarioId}`);
    }

    const tickMs = (config.tickSeconds || 30) * 1000;
    const totalTicks = Math.floor(((config.durationMinutes || 10) * 60) / (config.tickSeconds || 30));
    const baseTime = options.startTime ? new Date(options.startTime).getTime() : Date.now();

    const timeline = [];
    const trainsState = (config.trains || []).map(t => ({
        ...t,
        currentKm: t.initialKm,
        currentSpeed: t.speedKmh || 50.0,
        currentDelay: t.delayMinutes || 0,
        lastValidKm: t.initialKm,
        lastObservationTime: baseTime
    }));

    for (let tick = 0; tick <= totalTicks; tick++) {
        const currentTime = baseTime + tick * tickMs;
        const minute = (tick * (config.tickSeconds || 30)) / 60;

        // Process API outage scenario
        if (config.simulateApiError) {
            timeline.push({
                tick,
                minute,
                timestamp: new Date(currentTime).toISOString(),
                status: "UNAVAILABLE",
                error: "Remote rail API returned HTTP 503 (Service Unavailable)",
                activeForecasts: []
            });
            continue;
        }

        // Update train positions and speeds
        const activeTrains = [];
        for (const train of trainsState) {
            // Check if telemetry is frozen (for STALE_DATA scenario)
            const isFrozen = train.freezeTelemetryAtMinute != null && minute >= train.freezeTelemetryAtMinute;
            if (!isFrozen) {
                train.lastObservationTime = currentTime;

                // Speed profile check
                if (train.speedProfile) {
                    for (const sp of train.speedProfile) {
                        if (minute >= sp.atMinute) {
                            train.currentSpeed = sp.speedKmh;
                        }
                    }
                }

                // Delay profile check
                if (train.delayProfile) {
                    for (const dp of train.delayProfile) {
                        if (minute >= dp.atMinute) {
                            train.currentDelay = dp.delayMinutes;
                        }
                    }
                }

                // Anomaly injection
                let kmDelta = (train.currentSpeed * (config.tickSeconds / 3600.0));
                let injectedAnomaly = null;

                if (train.anomalies) {
                    for (const anom of train.anomalies) {
                        if (Math.abs(minute - anom.atMinute) < 0.25) {
                            injectedAnomaly = anom.glitchType;
                            if (anom.glitchType === "GPS_RESET_ZERO") {
                                train.currentKm = 0.000;
                            } else if (anom.glitchType === "TELEPORT_JUMP") {
                                train.currentKm += anom.jumpKm;
                            }
                        }
                    }
                }

                if (!injectedAnomaly) {
                    if (train.direction === "forward") {
                        train.currentKm += kmDelta;
                    } else {
                        train.currentKm -= kmDelta;
                    }
                }

                // Anomaly filter using determineMovement logic
                const movementCheck = determineMovement(
                    { trainPosition: train.lastValidKm, speed: train.currentSpeed, recordedAt: currentTime - tickMs },
                    { trainPosition: train.currentKm, speed: train.currentSpeed, recordedAt: currentTime }
                );

                if (movementCheck.direction === "stationary" && injectedAnomaly) {
                    // Suppressed anomaly! Revert to last valid km
                    train.currentKm = train.lastValidKm;
                } else {
                    train.lastValidKm = train.currentKm;
                }
            }

            const dataAgeMs = currentTime - train.lastObservationTime;
            const freshnessState = dataAgeMs < 120000 ? "LIVE_FRESH"
                : dataAgeMs < 300000 ? "AGING"
                : dataAgeMs < 600000 ? "STALE"
                : "UNAVAILABLE";

            activeTrains.push({
                trainNumber: train.trainNumber,
                trainName: train.trainName,
                direction: train.direction,
                km: Number(train.currentKm.toFixed(3)),
                speed: train.currentSpeed,
                delayMinutes: train.currentDelay,
                dataAgeSeconds: Math.floor(dataAgeMs / 1000),
                freshness: freshnessState,
                isStationary: train.currentSpeed === 0
            });
        }

        // Calculate crossing passage windows
        const crossingPredictions = {};
        for (const [crossingId, crossingKm] of Object.entries(CROSSING_LOCATIONS)) {
            const arrivingTrains = [];

            for (const t of activeTrains) {
                let distKm = 0;
                let isApproaching = false;

                if (t.direction === "forward") {
                    distKm = crossingKm - t.km;
                    isApproaching = distKm > -0.5 && distKm < 20.0;
                } else {
                    distKm = t.km - crossingKm;
                    isApproaching = distKm > -0.5 && distKm < 20.0;
                }

                if (isApproaching && t.speed > 0) {
                    const timeToPassHours = distKm / t.speed;
                    const passageMs = currentTime + timeToPassHours * 3600000;
                    arrivingTrains.push({
                        trainNumber: t.trainNumber,
                        trainName: t.trainName,
                        distanceKm: Number(distKm.toFixed(2)),
                        passageTime: new Date(passageMs).toISOString(),
                        passageMs,
                        speed: t.speed,
                        delayMinutes: t.delayMinutes
                    });
                }
            }

            // Check continuous closure overlap (threshold <= 5 min gap)
            let isContinuousClosure = false;
            if (arrivingTrains.length >= 2) {
                const sorted = [...arrivingTrains].sort((a, b) => a.passageMs - b.passageMs);
                const gapMinutes = (sorted[1].passageMs - sorted[0].passageMs) / 60000;
                if (gapMinutes <= 5.0) {
                    isContinuousClosure = true;
                }
            }

            crossingPredictions[crossingId] = {
                crossingId,
                crossingKm,
                trainCount: arrivingTrains.length,
                isContinuousClosure,
                primaryTrain: arrivingTrains[0] || null
            };
        }

        timeline.push({
            tick,
            minute: Number(minute.toFixed(1)),
            timestamp: new Date(currentTime).toISOString(),
            trains: activeTrains,
            crossings: crossingPredictions
        });
    }

    return {
        scenarioId,
        config,
        timeline,
        totalTicks: timeline.length
    };
}

module.exports = {
    SCENARIOS,
    CROSSING_LOCATIONS,
    runSimulation
};
