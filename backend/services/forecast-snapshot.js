/* ============================================================
   FATAKFORECAST — FORECAST SNAPSHOT SERVICE
   Single Consistent Forecast Snapshot Architecture
   Guarantees API and Frontend consume a synchronized truth.
============================================================ */

const fs = require("fs");
const path = require("path");
const {
    V1_CROSSINGS,
    FORWARD_CROSSING_ORDER,
    BACKWARD_CROSSING_ORDER,
    TIMING_CONFIG
} = require("../config/corridor");

const SNAPSHOT_FILE = path.join(
    __dirname,
    "..",
    "data",
    "forecast-snapshot.json"
);

// In-memory active snapshot cache
let activeSnapshot = null;

// Lock to prevent concurrent snapshot writes
let isWritingSnapshot = false;

/* ============================================================
   OVERLAPPING CLOSURE CALCULATION
============================================================ */

function computeCombinedClosureTimeline(candidates, now = new Date(), options = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return null;
    }

    const defaultLeadMin = TIMING_CONFIG.TIMELINE_CONFIG?.LIKELY_CLOSURE_OFFSET_MINUTES || TIMING_CONFIG.GATE_CLOSURE_LEAD_MINUTES.likely;
    const defaultReopenMin = TIMING_CONFIG.TIMELINE_CONFIG?.LIKELY_REOPEN_OFFSET_MINUTES || TIMING_CONFIG.GATE_REOPEN_BUFFER_MINUTES.earliest;
    const defaultCrossBufferMin = TIMING_CONFIG.GATE_CLOSURE_LEAD_MINUTES?.recommendedCrossBuffer || 11;
    const thresholdMinutes = (options && options.thresholdMinutes != null)
        ? options.thresholdMinutes
        : (TIMING_CONFIG.CONTINUOUS_CLOSURE_THRESHOLD_MINUTES || 10);

    const validIntervals = [];

    for (const c of candidates) {
        if (!c) continue;
        const passageRaw = c.estimated_passage_time || c.estimatedPassageTime;
        if (!passageRaw) continue;
        const passageTime = new Date(passageRaw);
        if (Number.isNaN(passageTime.getTime())) continue;

        const passageMs = passageTime.getTime();

        const closeTime = (c.predicted_gate_close_earliest || c.predictedGateCloseTime)
            ? new Date(c.predicted_gate_close_earliest || c.predictedGateCloseTime)
            : new Date(passageMs - defaultLeadMin * 60000);

        const openTime = (c.predicted_gate_open_latest || c.predictedGateOpenTime)
            ? new Date(c.predicted_gate_open_latest || c.predictedGateOpenTime)
            : new Date(passageMs + defaultReopenMin * 60000);

        const crossBy = (c.recommended_cross_by || c.recommendedCrossBy)
            ? new Date(c.recommended_cross_by || c.recommendedCrossBy)
            : new Date(passageMs - defaultCrossBufferMin * 60000);

        const trainNumber = String(c.train_number || c.trainNumber || c.number || "");
        const trainName = c.train_name || c.trainName || c.name || "Express Train";
        const direction = c.direction || "forward";
        const speedKmph = c.speed_kmh != null ? c.speed_kmh : (c.speedKmph != null ? c.speedKmph : (c.speed != null ? c.speed : null));

        validIntervals.push({
            candidate: c,
            passageTime,
            closeTime,
            openTime,
            crossBy,
            trainNumber,
            trainName,
            direction,
            speedKmph
        });
    }

    if (validIntervals.length === 0) {
        return null;
    }

    // Always sort chronologically by passage time
    validIntervals.sort((a, b) => a.passageTime.getTime() - b.passageTime.getTime());

    // Merge consecutive intervals according to the 5-point decision hierarchy
    const blocks = [];
    let currentBlock = null;

    for (const item of validIntervals) {
        if (!currentBlock) {
            currentBlock = {
                items: [item],
                closureStart: item.closeTime,
                closureEnd: item.openTime,
                recommendedCrossBy: item.crossBy,
                firstTrainPassage: item.passageTime,
                lastTrainPassage: item.passageTime
            };
            continue;
        }

        const prevItem = currentBlock.items[currentBlock.items.length - 1];
        const passageGapMinutes = (item.passageTime.getTime() - prevItem.passageTime.getTime()) / 60000;

        // 1. If closure intervals overlap (next.closeTime <= currentMerged.closureEnd) -> merge
        // 2. If closure intervals touch (next.closeTime === currentMerged.closureEnd) -> merge
        // 3. If next closure begins before previous predicted reopening -> merge
        // 4. If passage gap is <= thresholdMinutes (10 min) -> merge into continuous closure for V1 UX
        const closureOverlapOrTouch = item.closeTime.getTime() <= currentBlock.closureEnd.getTime();
        const withinGapThreshold = passageGapMinutes >= 0 && passageGapMinutes <= thresholdMinutes;
        const shouldMerge = closureOverlapOrTouch || withinGapThreshold;

        if (shouldMerge) {
            currentBlock.items.push(item);
            if (item.closeTime.getTime() < currentBlock.closureStart.getTime()) {
                currentBlock.closureStart = item.closeTime;
            }
            if (item.openTime.getTime() > currentBlock.closureEnd.getTime()) {
                currentBlock.closureEnd = item.openTime;
            }
            if (item.crossBy.getTime() < currentBlock.recommendedCrossBy.getTime()) {
                currentBlock.recommendedCrossBy = item.crossBy;
            }
            if (item.passageTime.getTime() > currentBlock.lastTrainPassage.getTime()) {
                currentBlock.lastTrainPassage = item.passageTime;
            }
        } else {
            // Found a genuine gap (> 10 min AND next closure starts after previous reopening)
            blocks.push(currentBlock);
            currentBlock = {
                items: [item],
                closureStart: item.closeTime,
                closureEnd: item.openTime,
                recommendedCrossBy: item.crossBy,
                firstTrainPassage: item.passageTime,
                lastTrainPassage: item.passageTime
            };
        }
    }
    if (currentBlock) {
        blocks.push(currentBlock);
    }

    const nowMs = new Date(now).getTime();
    // Select the first block that has not fully elapsed (closureEnd >= now - 1.5 min)
    const activeBlock = blocks.find(b => b.closureEnd.getTime() >= nowMs - defaultReopenMin * 60000) || blocks[0];

    const trainList = activeBlock.items.map(item => {
        const pt = item.passageTime.getTime();
        const etaMin = Math.max(0, (pt - nowMs) / 60000);
        return {
            trainNumber: item.trainNumber,
            trainName: item.trainName,
            number: item.trainNumber,
            name: item.trainName,
            direction: item.direction,
            speedKmph: item.speedKmph,
            estimatedPassageTime: item.passageTime.toISOString(),
            etaMinutes: Number(etaMin.toFixed(1)),
            predictedGateCloseTime: item.closeTime.toISOString(),
            predictedGateOpenTime: item.openTime.toISOString()
        };
    });

    const durationMin = Number(((activeBlock.closureEnd.getTime() - activeBlock.closureStart.getTime()) / 60000).toFixed(1));

    // Identify current active train vs next train within this continuous block
    let currentItem = activeBlock.items[0];
    let nextItem = activeBlock.items[1] || null;
    if (activeBlock.items.length > 1) {
        for (let i = 0; i < activeBlock.items.length; i++) {
            const item = activeBlock.items[i];
            if (nowMs <= item.openTime.getTime()) {
                currentItem = item;
                nextItem = activeBlock.items[i + 1] || null;
                break;
            }
        }
    }

    const isContinuous = activeBlock.items.length > 1;

    return {
        isContinuous,
        isOverlapping: isContinuous, // backward compatibility
        trainCount: activeBlock.items.length,
        overlappingTrainCount: activeBlock.items.length, // backward compatibility
        combinedDurationMinutes: durationMin,
        durationMinutes: durationMin,
        closureStart: activeBlock.closureStart.toISOString(),
        closureEnd: activeBlock.closureEnd.toISOString(),
        start: activeBlock.closureStart.toISOString(),
        end: activeBlock.closureEnd.toISOString(),
        recommendedCrossBy: activeBlock.recommendedCrossBy.toISOString(),
        firstTrainPassage: activeBlock.firstTrainPassage.toISOString(),
        lastTrainPassage: activeBlock.lastTrainPassage.toISOString(),
        trains: trainList,
        currentTrain: {
            trainNumber: currentItem.trainNumber,
            trainName: currentItem.trainName,
            number: currentItem.trainNumber,
            name: currentItem.trainName,
            direction: currentItem.direction,
            estimatedPassageTime: currentItem.passageTime.toISOString()
        },
        nextTrain: nextItem ? {
            trainNumber: nextItem.trainNumber,
            trainName: nextItem.trainName,
            number: nextItem.trainNumber,
            name: nextItem.trainName,
            direction: nextItem.direction,
            estimatedPassageTime: nextItem.passageTime.toISOString()
        } : null,
        primaryEvent: activeBlock.items[0].candidate,
        allBlocks: blocks.map(b => ({
            trainCount: b.items.length,
            isContinuous: b.items.length > 1,
            closureStart: b.closureStart.toISOString(),
            closureEnd: b.closureEnd.toISOString(),
            firstTrainPassage: b.firstTrainPassage.toISOString(),
            lastTrainPassage: b.lastTrainPassage.toISOString(),
            trainNumbers: b.items.map(it => String(it.trainNumber))
        }))
    };
}

const computeOverlappingClosure = computeCombinedClosureTimeline;

/* ============================================================
   STATUS DETERMINATION
============================================================ */

function determineCrossingStatus(primaryEvent, snapshotFreshness, now = new Date(), combinedClosure = null) {
    if (!primaryEvent) {
        if (snapshotFreshness === "UNAVAILABLE") {
            return {
                status: "LIVE_DATA_UNAVAILABLE",
                legacyStatus: "LIVE_DATA_UNAVAILABLE",
                predictionAvailable: false,
                message: "Live railway data is currently unavailable. Gates may operate on standard signaling."
            };
        }
        return {
            status: "OPEN",
            legacyStatus: "EXPECTED_OPEN",
            predictionAvailable: true,
            message: "No train expected within the next hour. Corridor is clear."
        };
    }

    const passageTime = new Date(primaryEvent.estimated_passage_time || primaryEvent.estimatedPassageTime);
    if (Number.isNaN(passageTime.getTime())) {
        return {
            status: "PREDICTION_UNAVAILABLE",
            legacyStatus: "PREDICTION_UNAVAILABLE",
            predictionAvailable: false,
            message: "Train detected but precise arrival ETA is unavailable."
        };
    }

    const nowMs = now.getTime();

    // If a multi-train continuous closure is active, evaluate gate status using the unified combined closure interval
    if (combinedClosure && combinedClosure.isContinuous) {
        const closureStartMs = new Date(combinedClosure.closureStart).getTime();
        const closureEndMs = new Date(combinedClosure.closureEnd).getTime();
        const firstPassageMs = new Date(combinedClosure.firstTrainPassage).getTime();
        const diffMinutesFirst = (firstPassageMs - nowMs) / 60000;

        // 1. More than 15 minutes before first passage: OPEN
        if (diffMinutesFirst > 15) {
            return {
                status: "OPEN",
                legacyStatus: "EXPECTED_OPEN",
                predictionAvailable: true,
                message: `Train passage expected in ${Math.round(diffMinutesFirst)} min (${combinedClosure.trainCount} trains expected). Fatak is OPEN.`
            };
        }

        // 2. Between 15 minutes and closure start (or baseline closure lead before first passage): TRAIN APPROACHING
        if (nowMs < closureStartMs && diffMinutesFirst > TIMING_CONFIG.TIMELINE_CONFIG.CLOSURE_MINUTES) {
            const timeToClosure = Math.max(0, Number(((closureStartMs - nowMs) / 60000).toFixed(1)));
            return {
                status: "TRAIN APPROACHING",
                legacyStatus: "PREDICTED_CLOSURE",
                predictionAvailable: true,
                message: `Train approaching in ${Number(diffMinutesFirst.toFixed(1))} min. Multi-train continuous closure expected for ${combinedClosure.trainCount} trains. Gate closes in ~${timeToClosure} min.`
            };
        }

        // 3. Between closureStart and closureEnd: strictly FATAK CLOSED (continuous closure)
        if (nowMs <= closureEndMs) {
            const timeToReopen = Math.max(0, Number(((closureEndMs - nowMs) / 60000).toFixed(1)));
            const currNum = combinedClosure.currentTrain?.trainNumber;
            const nextNum = combinedClosure.nextTrain?.trainNumber;
            const trainDetail = nextNum
                ? `Train #${currNum} active, Train #${nextNum} following`
                : `Train #${currNum} active`;
            return {
                status: "FATAK CLOSED",
                legacyStatus: "PREDICTED_CLOSURE",
                predictionAvailable: true,
                message: `Continuous closure in effect for ${combinedClosure.trainCount} trains (${trainDetail}). Final reopen in ~${timeToReopen} min.`
            };
        }

        // 4. After closureEnd: OPEN
        return {
            status: "OPEN",
            legacyStatus: "EXPECTED_OPEN",
            predictionAvailable: true,
            message: `All ${combinedClosure.trainCount} trains have passed. Fatak is OPEN.`
        };
    }

    // Standard single-train 5-point central passage timeline
    const passageMs = passageTime.getTime();
    const diffMinutes = (passageMs - nowMs) / 60000;

    // 1. More than 15 minutes before passage: OPEN
    if (diffMinutes > 15) {
        return {
            status: "OPEN",
            legacyStatus: "EXPECTED_OPEN",
            predictionAvailable: true,
            message: `Train passage expected in ${Math.round(diffMinutes)} min. Fatak is OPEN.`
        };
    }

    // 2. Between 15 minutes and 8 minutes before passage: TRAIN APPROACHING
    if (diffMinutes > TIMING_CONFIG.TIMELINE_CONFIG.CLOSURE_MINUTES) {
        const timeToClosure = Math.max(0, Number((diffMinutes - TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_CLOSURE_OFFSET_MINUTES).toFixed(1)));
        return {
            status: "TRAIN APPROACHING",
            legacyStatus: "PREDICTED_CLOSURE",
            predictionAvailable: true,
            message: `Train approaching in ${Number(diffMinutes.toFixed(1))} min. Gate closes in ~${timeToClosure} min.`
        };
    }

    // 3. From 8 minutes before passage until the train passes: FATAK CLOSED
    // 4. After the train passage: Keep in PREDICTED CLOSED state for 1 minute: FATAK CLOSED
    if (diffMinutes > -TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES) {
        const isPastPassage = diffMinutes <= 0;
        return {
            status: "FATAK CLOSED",
            legacyStatus: "PREDICTED_CLOSURE",
            predictionAvailable: true,
            message: isPastPassage
                ? "Train is passing crossing. Gate will reopen in ~1 min."
                : `Fatak is closed for approaching train (passage in ${Number(diffMinutes.toFixed(1))} min).`
        };
    }

    // 5. After the 1-minute reopening buffer: OPEN
    return {
        status: "OPEN",
        legacyStatus: "EXPECTED_OPEN",
        predictionAvailable: true,
        message: "Train has passed. Fatak is OPEN."
    };
}

/* ============================================================
   BUILD UNIFIED SNAPSHOT
============================================================ */

function buildUnifiedSnapshot({
    cycleId,
    cycleTimestamp,
    liveDataTimestamp,
    eventsByCrossing = {},
    diagnostics = {},
    engineStatus = "OK"
}) {
    const now = cycleTimestamp ? new Date(cycleTimestamp) : new Date();
    const generatedAt = now.toISOString();
    const liveTs = liveDataTimestamp ? new Date(liveDataTimestamp).toISOString() : generatedAt;
    let snapshotFreshness = "LIVE_FRESH";
    if (liveDataTimestamp) {
        const liveAgeMs = now.getTime() - new Date(liveDataTimestamp).getTime();
        if (liveAgeMs > (TIMING_CONFIG.SNAPSHOT_UNAVAILABLE_THRESHOLD_MS || 10 * 60000)) {
            snapshotFreshness = "UNAVAILABLE";
        } else if (liveAgeMs > (TIMING_CONFIG.SNAPSHOT_STALE_THRESHOLD_MS || 5 * 60000)) {
            snapshotFreshness = "STALE";
        } else if (liveAgeMs > (TIMING_CONFIG.SNAPSHOT_FRESH_THRESHOLD_MS || 2 * 60000)) {
            snapshotFreshness = "LIVE_RECENT";
        } else {
            snapshotFreshness = "LIVE_FRESH";
        }
    }

    const formattedCrossings = {};
    const globalUpcomingQueue = [];

    for (const crossing of V1_CROSSINGS) {
        const rawEvents = eventsByCrossing[crossing.id] || [];

        // Deduplicate raw events for this crossing by train number
        const dedupedMap = new Map();
        for (const ev of rawEvents) {
            const num = String(ev.train_number || ev.trainNumber || "").trim();
            if (!num) continue;
            if (!dedupedMap.has(num)) {
                dedupedMap.set(num, ev);
            }
        }
        const uniqueEvents = Array.from(dedupedMap.values());

        // Filter valid candidates within the extended 120-minute window
        const allUpcomingEvents = uniqueEvents.filter(e => {
            const passageStr = e.estimated_passage_time || e.estimatedPassageTime;
            if (!passageStr) return false;
            const passageTime = new Date(passageStr);
            if (Number.isNaN(passageTime.getTime())) return false;

            const gateOpenTime = e.predicted_gate_open_latest
                ? new Date(e.predicted_gate_open_latest)
                : new Date(passageTime.getTime() + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000);

            // Must not have completed passage + 1m buffer yet and must be within 120 minutes
            const etaMinutes = (passageTime.getTime() - now.getTime()) / 60000;
            return gateOpenTime.getTime() >= now.getTime() && etaMinutes <= (TIMING_CONFIG.FORECAST_HORIZON_EXTENDED_MINUTES || 120);
        }).sort((a, b) => {
            const timeA = new Date(a.estimated_passage_time || a.estimatedPassageTime).getTime();
            const timeB = new Date(b.estimated_passage_time || b.estimatedPassageTime).getTime();
            return timeA - timeB;
        });

        // 1. Primary / Operational candidates: strictly 0–60 minutes
        const activeCandidates = allUpcomingEvents.filter(e => {
            const pt = new Date(e.estimated_passage_time || e.estimatedPassageTime).getTime();
            const etaMinutes = (pt - now.getTime()) / 60000;
            return etaMinutes <= (TIMING_CONFIG.FORECAST_HORIZON_PRIMARY_MINUTES || 60);
        });

        // 2. Extended 2-hour outlook candidates: strictly > 60 and <= 120 minutes
        const extendedCandidates = allUpcomingEvents.filter(e => {
            const pt = new Date(e.estimated_passage_time || e.estimatedPassageTime).getTime();
            const etaMinutes = (pt - now.getTime()) / 60000;
            return etaMinutes > (TIMING_CONFIG.FORECAST_HORIZON_PRIMARY_MINUTES || 60) && etaMinutes <= (TIMING_CONFIG.FORECAST_HORIZON_EXTENDED_MINUTES || 120);
        });

        const extendedOutlook = extendedCandidates.map(cand => {
            const passageTime = new Date(cand.estimated_passage_time || cand.estimatedPassageTime);
            const etaMinutes = Math.max(0, (passageTime.getTime() - now.getTime()) / 60000);
            const trainNum = String(cand.train_number || cand.trainNumber || "");
            const trainName = cand.train_name || cand.trainName || "Express Train";
            const direction = cand.direction || "forward";

            const candDelay = cand.delay_minutes != null
                ? cand.delay_minutes
                : (cand.delayMinutes != null
                    ? cand.delayMinutes
                    : (cand.analysis?.delayMinutes != null
                        ? cand.analysis.delayMinutes
                        : null));
            const delayMinutes = (candDelay != null && Number.isFinite(Number(candDelay))) ? Number(candDelay) : 0;
            const delayFormatted = delayMinutes > 0
                ? `+${Math.round(delayMinutes)} min`
                : (delayMinutes < 0 ? `${Math.round(delayMinutes)} min` : null);

            const scheduledPassageTime = cand.scheduledPassageTime || cand.scheduled_passage_time || (
                (cand.estimated_passage_time || cand.estimatedPassageTime)
                    ? new Date(passageTime.getTime() - delayMinutes * 60000).toISOString()
                    : null
            );
            let earlyLateStatus = cand.earlyLateStatus || "ON_TIME";
            let earlyLateMinutes = cand.earlyLateMinutes;
            if (earlyLateMinutes == null && (cand.estimated_passage_time || cand.estimatedPassageTime) && scheduledPassageTime) {
                const diff = (passageTime.getTime() - new Date(scheduledPassageTime).getTime()) / 60000;
                earlyLateMinutes = Math.round(diff * 10) / 10;
                if (diff < -1.5) earlyLateStatus = "EARLY";
                else if (diff > 1.5) earlyLateStatus = "DELAYED";
                else earlyLateStatus = "ON_TIME";
            }

            return {
                forecastWindow: "extended",
                status: "EXTENDED OUTLOOK",
                crossingId: crossing.id,
                crossingName: crossing.name,
                trainNumber: trainNum,
                trainName,
                direction,
                etaMinutes: Number(etaMinutes.toFixed(1)),
                estimatedPassageTime: passageTime.toISOString(),
                scheduledPassageTime,
                earlyLateStatus,
                earlyLateMinutes,
                delayMinutes: Math.round(delayMinutes),
                delayFormatted,
                predictedGateCloseTime: cand.predicted_gate_close_earliest || new Date(passageTime.getTime() - TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_CLOSURE_OFFSET_MINUTES * 60000).toISOString(),
                predictedGateOpenTime: cand.predicted_gate_open_latest || new Date(passageTime.getTime() + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000).toISOString(),
                confidence: cand.confidence || (cand.stale ? "DEGRADED" : "SCHEDULE_ESTIMATE"),
                telemetryFreshness: cand.telemetryFreshness || (cand.stale ? "STALE" : "FRESH"),
                movementState: cand.movementState || "RUNNING",
                speedKmph: cand.speed_kmh != null ? cand.speed_kmh : (cand.speedKmph != null ? cand.speedKmph : null),
                displayMessage: `${crossing.name} — approximately ${Math.round(etaMinutes)} minutes`
            };
        });

        // Filter events that have completed passage for historical "Last Train Passed" context (max 60m age)
        const MAX_LAST_TRAIN_AGE_MS = 60 * 60 * 1000;
        const passedCandidates = uniqueEvents.filter(e => {
            const passageStr = e.estimated_passage_time || e.estimatedPassageTime;
            if (!passageStr) return false;
            const passageTime = new Date(passageStr);
            if (Number.isNaN(passageTime.getTime())) return false;

            const gateOpenTime = e.predicted_gate_open_latest
                ? new Date(e.predicted_gate_open_latest)
                : new Date(passageTime.getTime() + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000);

            const elapsedMs = now.getTime() - passageTime.getTime();
            // Must have passed, but NOT older than 60 minutes
            return gateOpenTime.getTime() < now.getTime() && elapsedMs <= MAX_LAST_TRAIN_AGE_MS && elapsedMs >= 0;
        }).sort((a, b) => {
            const timeA = new Date(a.estimated_passage_time || a.estimatedPassageTime).getTime();
            const timeB = new Date(b.estimated_passage_time || b.estimatedPassageTime).getTime();
            return timeB - timeA; // Most recently passed first
        });

        // ----------------------------------------------------
        // PRIMARY SELECTION WITH HYSTERESIS & SWITCH DIAGNOSTICS
        // ----------------------------------------------------
        const prevCrossing = activeSnapshot?.crossings?.[crossing.id];
        const prevPrimary = prevCrossing?.primaryTrain;
        let crossingLastTrainPassed = prevCrossing?.lastTrainPassed || null;

        // Invalidate carried-forward lastTrainPassed if older than 60 minutes
        if (crossingLastTrainPassed && crossingLastTrainPassed.passageTime) {
            const prevPassageMs = new Date(crossingLastTrainPassed.passageTime).getTime();
            if (Number.isNaN(prevPassageMs) || (now.getTime() - prevPassageMs) > MAX_LAST_TRAIN_AGE_MS) {
                crossingLastTrainPassed = null;
            }
        }

        if (passedCandidates.length > 0) {
            const mostRecentPassed = passedCandidates[0];
            const pTime = new Date(mostRecentPassed.estimated_passage_time || mostRecentPassed.estimatedPassageTime);
            const pMs = pTime.getTime();
            crossingLastTrainPassed = {
                trainNumber: String(mostRecentPassed.train_number || mostRecentPassed.trainNumber || ""),
                trainName: mostRecentPassed.train_name || mostRecentPassed.trainName || "Express Train",
                direction: mostRecentPassed.direction || "forward",
                passageTime: pTime.toISOString(),
                passedAt: pTime.toISOString(),
                likelyClosure: mostRecentPassed.predicted_gate_close_earliest || new Date(pMs - TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_CLOSURE_OFFSET_MINUTES * 60000).toISOString(),
                likelyReopen: mostRecentPassed.predicted_gate_open_latest || new Date(pMs + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000).toISOString()
            };
        } else if (prevPrimary) {
            const prevPassageMs = new Date(prevPrimary.estimatedPassageTime).getTime();
            if (!Number.isNaN(prevPassageMs) && now.getTime() >= prevPassageMs + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000 && (now.getTime() - prevPassageMs) <= MAX_LAST_TRAIN_AGE_MS) {
                crossingLastTrainPassed = {
                    trainNumber: String(prevPrimary.trainNumber || ""),
                    trainName: prevPrimary.trainName || "Express Train",
                    direction: prevPrimary.direction || "forward",
                    passageTime: new Date(prevPassageMs).toISOString(),
                    passedAt: new Date(prevPassageMs).toISOString(),
                    likelyClosure: prevPrimary.predictedGateCloseTime || new Date(prevPassageMs - TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_CLOSURE_OFFSET_MINUTES * 60000).toISOString(),
                    likelyReopen: prevPrimary.predictedGateOpenTime || new Date(prevPassageMs + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000).toISOString()
                };
            }
        }

        let primaryCandidate = null;
        let switchReason = "NO_TRAIN";

        if (activeCandidates.length === 0) {
            if (prevPrimary) {
                const prevPassageMs = new Date(prevPrimary.estimatedPassageTime).getTime();
                switchReason = (now.getTime() >= prevPassageMs + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000)
                    ? "PREVIOUS_TRAIN_PASSED"
                    : "PREVIOUS_TRAIN_CLEARED";
            } else {
                switchReason = "CORRIDOR_CLEAR";
            }
        } else if (!prevPrimary) {
            primaryCandidate = activeCandidates[0];
            switchReason = "INITIAL_SELECTION";
        } else {
            // Find if previous primary train is still among active candidates
            const existingIndex = activeCandidates.findIndex(c =>
                String(c.train_number || c.trainNumber || "") === String(prevPrimary.trainNumber || "")
            );

            if (existingIndex >= 0) {
                const existingCand = activeCandidates[existingIndex];
                const earliestCand = activeCandidates[0];

                if (String(earliestCand.train_number || earliestCand.trainNumber || "") === String(existingCand.train_number || existingCand.trainNumber || "")) {
                    primaryCandidate = existingCand;
                    switchReason = "TELEMETRY_UPDATED";
                } else {
                    const existingPassageMs = new Date(existingCand.estimated_passage_time || existingCand.estimatedPassageTime).getTime();
                    const earliestPassageMs = new Date(earliestCand.estimated_passage_time || earliestCand.estimatedPassageTime).getTime();
                    const advantageMs = existingPassageMs - earliestPassageMs;

                    // Switch only if earliest train is at least 3 minutes earlier
                    if (advantageMs >= 3.0 * 60000) {
                        primaryCandidate = earliestCand;
                        switchReason = "EARLIER_TRAIN_DISCOVERED";
                    } else {
                        // Stick with existing candidate to prevent flapping
                        primaryCandidate = existingCand;
                        switchReason = "TELEMETRY_UPDATED";
                    }
                }
            } else {
                primaryCandidate = activeCandidates[0];
                const prevPassageMs = new Date(prevPrimary.estimatedPassageTime).getTime();
                if (now.getTime() >= prevPassageMs + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000) {
                    switchReason = "PREVIOUS_TRAIN_PASSED";
                } else {
                    switchReason = "PREVIOUS_TRAIN_CLEARED";
                }
            }
        }

        // Reorder activeCandidates so primaryCandidate is always at index 0
        let orderedCandidates = [];
        if (primaryCandidate) {
            const others = activeCandidates.filter(c => c !== primaryCandidate);
            orderedCandidates = [primaryCandidate, ...others];
        }

        // Compute multi-train overlapping closure
        const closureComputation = computeOverlappingClosure(orderedCandidates, now);

        const statusInfo = determineCrossingStatus(primaryCandidate, snapshotFreshness, now, closureComputation);

        let primaryPassageMs = null;
        let likelyClosureIso = null;
        let likelyReopenIso = null;
        let passageIso = null;

        if (primaryCandidate) {
            const pt = new Date(primaryCandidate.estimated_passage_time || primaryCandidate.estimatedPassageTime);
            if (!Number.isNaN(pt.getTime())) {
                primaryPassageMs = pt.getTime();
                passageIso = pt.toISOString();
                likelyClosureIso = new Date(primaryPassageMs - TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_CLOSURE_OFFSET_MINUTES * 60000).toISOString();
                likelyReopenIso = new Date(primaryPassageMs + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000).toISOString();
            }
        }

        // Format upcoming trains list for this crossing
        const upcomingTrains = orderedCandidates.map((cand, idx) => {
            const passageTime = new Date(cand.estimated_passage_time || cand.estimatedPassageTime);
            const etaMinutes = Math.max(0, (passageTime.getTime() - now.getTime()) / 60000);
            const candPassageMs = passageTime.getTime();
            const trainNum = String(cand.train_number || cand.trainNumber || "");
            const serviceDate = passageTime.toISOString().slice(0, 10);
            const eventId = cand.eventId || `${trainNum}-${crossing.id}-${serviceDate}`;

            // Check if this train is part of a continuous closure block
            let isContinuousClosure = false;
            let continuousClosureStart = null;
            let continuousClosureEnd = null;
            let continuousTrainNumbers = [];
            if (closureComputation && Array.isArray(closureComputation.allBlocks)) {
                const matchedBlock = closureComputation.allBlocks.find(b =>
                    b.isContinuous && Array.isArray(b.trainNumbers) && b.trainNumbers.includes(trainNum)
                );
                if (matchedBlock) {
                    isContinuousClosure = true;
                    continuousClosureStart = matchedBlock.closureStart;
                    continuousClosureEnd = matchedBlock.closureEnd;
                    continuousTrainNumbers = matchedBlock.trainNumbers;
                }
            }

            const standardCloseTime = cand.predicted_gate_close_earliest || new Date(candPassageMs - TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_CLOSURE_OFFSET_MINUTES * 60000).toISOString();
            const standardOpenTime = cand.predicted_gate_open_latest || new Date(candPassageMs + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000).toISOString();

            const candDelay = cand.delay_minutes != null
                ? cand.delay_minutes
                : (cand.delayMinutes != null
                    ? cand.delayMinutes
                    : (cand.analysis?.delayMinutes != null
                        ? cand.analysis.delayMinutes
                        : null));
            const delayMinutes = (candDelay != null && Number.isFinite(Number(candDelay))) ? Number(candDelay) : 0;
            const delayFormatted = delayMinutes > 0
                ? `+${Math.round(delayMinutes)} min`
                : (delayMinutes < 0 ? `${Math.round(delayMinutes)} min` : null);

            const scheduledPassageTime = cand.scheduledPassageTime || cand.scheduled_passage_time || (
                (cand.estimated_passage_time || cand.estimatedPassageTime)
                    ? new Date(passageTime.getTime() - delayMinutes * 60000).toISOString()
                    : null
            );
            let earlyLateStatus = cand.earlyLateStatus || "ON_TIME";
            let earlyLateMinutes = cand.earlyLateMinutes;
            if (earlyLateMinutes == null && (cand.estimated_passage_time || cand.estimatedPassageTime) && scheduledPassageTime) {
                const diff = (passageTime.getTime() - new Date(scheduledPassageTime).getTime()) / 60000;
                earlyLateMinutes = Math.round(diff * 10) / 10;
                if (diff < -1.5) earlyLateStatus = "EARLY";
                else if (diff > 1.5) earlyLateStatus = "DELAYED";
                else earlyLateStatus = "ON_TIME";
            }

            const etaMethod = cand.eta_calculation_method 
                || cand.etaCalculationMethod 
                || cand.analysis?.etaMethod 
                || (cand.speed_kmh != null ? "live-movement" : "route-telemetry");
            const gateModelMethod = cand.modelStage === "ml-eligible" ? "ml-model" : (cand.source || "11-min baseline");
            const etaConfidence = (cand.speed_kmh != null && cand.speed_kmh > 0) ? "high" : "medium";
            const gateConfidence = cand.confidence || "initial-estimate";

            const item = {
                forecastWindow: "primary",
                eventId,
                trainNumber: trainNum,
                trainName: cand.train_name || cand.trainName || "Express Train",
                direction: cand.direction || "forward",
                speedKmph: cand.speed_kmh != null ? cand.speed_kmh : (cand.speedKmph != null ? cand.speedKmph : null),
                etaMinutes: Number(etaMinutes.toFixed(1)),
                estimatedPassageTime: passageTime.toISOString(),
                scheduledPassageTime,
                earlyLateStatus,
                earlyLateMinutes,
                predictedGateCloseTime: standardCloseTime,
                predictedGateOpenTime: standardOpenTime,
                isContinuousClosure,
                effectiveGateCloseTime: isContinuousClosure ? continuousClosureStart : standardCloseTime,
                effectiveGateOpenTime: isContinuousClosure ? continuousClosureEnd : standardOpenTime,
                continuousTrainNumbers,
                confidence: cand.confidence || gateConfidence,
                etaConfidence: cand.confidence || etaConfidence,
                gateConfidence,
                delayMinutes: Math.round(delayMinutes),
                delayFormatted,
                etaMethod,
                gateModelMethod,
                isPrimary: idx === 0,
                source: cand.source || "RECENT_TELEMETRY",
                movementState: cand.movementState || "RUNNING",
                stopType: cand.stopType || null,
                telemetryFreshness: cand.telemetryFreshness || (cand.stale ? "STALE" : "FRESH"),
                telemetryAgeMinutes: cand.telemetryAgeMinutes ?? 0,
                degradedConfidence: Boolean(cand.degradedConfidence || cand.confidence === "DEGRADED"),
                unexpectedHalt: Boolean(cand.unexpectedHalt || cand.stopType === "UNEXPECTED_INTERMEDIATE_STOP")
            };

            globalUpcomingQueue.push({
                ...item,
                crossingId: crossing.id,
                crossingName: crossing.name
            });

            return item;
        });

        // Diagnostic metadata per Requirement 7
        const primaryItem = upcomingTrains[0] || null;
        const diagnosticMetadata = primaryCandidate ? {
            forecastGeneratedAt: generatedAt,
            liveDataUpdatedAt: primaryCandidate.liveDataUpdatedAt || primaryCandidate.analysis?.timestamp || liveTs,
            trainNumber: primaryItem.trainNumber,
            trainName: primaryItem.trainName,
            eventId: primaryItem.eventId,
            trainPosition: primaryCandidate.trainRailwayPositionKm != null
                ? primaryCandidate.trainRailwayPositionKm
                : (primaryCandidate.positionKm != null
                    ? primaryCandidate.positionKm
                    : (primaryCandidate.train_position_km != null 
                        ? primaryCandidate.train_position_km 
                        : (primaryCandidate.trainPositionKm != null 
                            ? primaryCandidate.trainPositionKm 
                            : (primaryCandidate.analysis?.positionKm != null
                                ? primaryCandidate.analysis.positionKm
                                : (primaryCandidate.analysis?.trainRailwayPositionKm != null
                                    ? primaryCandidate.analysis.trainRailwayPositionKm
                                    : (primaryCandidate.distanceKm != null ? primaryCandidate.distanceKm : 0)))))),
            crossingPosition: primaryCandidate.railwayPositionKm != null 
                ? primaryCandidate.railwayPositionKm 
                : (primaryCandidate.crossing_position_km != null 
                    ? primaryCandidate.crossing_position_km 
                    : (primaryCandidate.crossingPositionKm != null 
                        ? primaryCandidate.crossingPositionKm 
                        : null)),
            direction: primaryItem.direction,
            speed: primaryItem.speedKmph,
            ETA: primaryItem.etaMinutes,
            passageTimestamp: passageIso,
            etaCalculationMethod: primaryCandidate.eta_calculation_method 
                || primaryCandidate.etaCalculationMethod 
                || primaryCandidate.analysis?.etaMethod 
                || "route-telemetry",
            dataFreshness: snapshotFreshness,
            scheduledPassageTime: primaryItem?.scheduledPassageTime || null,
            earlyLateStatus: primaryItem?.earlyLateStatus || "ON_TIME",
            earlyLateMinutes: primaryItem?.earlyLateMinutes != null ? primaryItem.earlyLateMinutes : 0,
            confidenceSource: primaryCandidate.source || primaryItem?.source || "RECENT_TELEMETRY"
        } : null;

        // Switch diagnostics per Requirement 9
        const switchDiagnostics = {
            previousTrainNumber: prevPrimary?.trainNumber || null,
            previousEventId: prevPrimary?.eventId || null,
            previousEtaMinutes: prevPrimary?.etaMinutes != null ? prevPrimary.etaMinutes : null,
            currentTrainNumber: primaryItem?.trainNumber || null,
            currentEventId: primaryItem?.eventId || null,
            currentEtaMinutes: primaryItem?.etaMinutes != null ? primaryItem.etaMinutes : null,
            reason: switchReason,
            switchedAt: (switchReason === "TELEMETRY_UPDATED" && prevCrossing?.switchDiagnostics?.switchedAt)
                ? prevCrossing.switchDiagnostics.switchedAt
                : generatedAt
        };

        formattedCrossings[crossing.id] = {
            crossing: {
                id: crossing.id,
                name: crossing.name,
                coordinates: crossing.coordinates
            },
            status: statusInfo.status,
            legacyStatus: statusInfo.legacyStatus,
            crossingStatus: statusInfo.status,
            predictionAvailable: statusInfo.predictionAvailable,
            freshness: snapshotFreshness,
            message: statusInfo.message,
            primaryTrain: primaryItem,
            upcomingTrains: upcomingTrains.slice(1),
            subsequentTrains: upcomingTrains.slice(1),
            totalUpcomingTrains: upcomingTrains.length,
            activeTrainCount: upcomingTrains.length,
            timingMetrics: passageIso ? {
                passageTime: passageIso,
                likelyClosure: (closureComputation && closureComputation.isContinuous) ? closureComputation.closureStart : likelyClosureIso,
                likelyReopen: (closureComputation && closureComputation.isContinuous) ? closureComputation.closureEnd : likelyReopenIso,
                leadBuffer: (closureComputation && closureComputation.isContinuous) ? `Continuous (~${Math.round(closureComputation.durationMinutes)} min)` : TIMING_CONFIG.TIMELINE_CONFIG.LEAD_BUFFER_LABEL
            } : null,
            closure: passageIso ? {
                earliest: (closureComputation && closureComputation.isContinuous) ? closureComputation.closureStart : likelyClosureIso,
                latest: new Date(primaryPassageMs - 8.0 * 60000).toISOString(),
                likelyClosure: (closureComputation && closureComputation.isContinuous) ? closureComputation.closureStart : likelyClosureIso
            } : null,
            reopening: passageIso ? {
                earliest: (closureComputation && closureComputation.isContinuous) ? closureComputation.closureEnd : likelyReopenIso,
                latest: (closureComputation && closureComputation.isContinuous) ? closureComputation.closureEnd : likelyReopenIso,
                likelyReopen: (closureComputation && closureComputation.isContinuous) ? closureComputation.closureEnd : likelyReopenIso
            } : null,
            overlappingClosure: closureComputation ? {
                isOverlapping: closureComputation.isOverlapping,
                isContinuous: closureComputation.isContinuous,
                trainCount: closureComputation.overlappingTrainCount,
                combinedDurationMinutes: closureComputation.combinedDurationMinutes,
                durationMinutes: closureComputation.durationMinutes,
                start: closureComputation.closureStart,
                end: closureComputation.closureEnd,
                closureStart: closureComputation.closureStart,
                closureEnd: closureComputation.closureEnd,
                recommendedCrossBy: closureComputation.recommendedCrossBy,
                firstTrainPassage: closureComputation.firstTrainPassage,
                lastTrainPassage: closureComputation.lastTrainPassage,
                trains: closureComputation.trains,
                currentTrain: closureComputation.currentTrain,
                nextTrain: closureComputation.nextTrain
            } : null,
            combinedClosure: closureComputation,
            closureWindow: closureComputation ? {
                start: closureComputation.closureStart,
                end: closureComputation.closureEnd,
                recommendedCrossBy: closureComputation.recommendedCrossBy,
                isOverlapping: closureComputation.isOverlapping,
                isContinuous: closureComputation.isContinuous,
                trainCount: closureComputation.overlappingTrainCount
            } : (passageIso ? {
                start: likelyClosureIso,
                end: likelyReopenIso,
                recommendedCrossBy: likelyClosureIso,
                isOverlapping: false,
                isContinuous: false,
                trainCount: 1
            } : null),
            trainPassage: primaryCandidate ? {
                estimatedTime: passageIso,
                etaMinutes: primaryItem ? primaryItem.etaMinutes : null
            } : null,
            recommendation: statusInfo.status === "FATAK CLOSED"
                ? "DO NOT CROSS — FATAK CLOSED"
                : statusInfo.status === "TRAIN APPROACHING"
                    ? "PLAN TO STOP — TRAIN APPROACHING"
                    : "SAFE TO CROSS — OPEN",
            diagnosticMetadata,
            switchDiagnostics,
            lastTrainPassed: crossingLastTrainPassed,
            dataTimestamp: liveTs,
            predictionGeneratedAt: generatedAt,
            dataAgeSeconds: Math.max(0, Math.floor((now.getTime() - new Date(liveTs).getTime()) / 1000)),
            dataFreshness: snapshotFreshness,
            etaConfidence: primaryItem ? primaryItem.etaConfidence : "n/a",
            gateConfidence: primaryItem ? primaryItem.gateConfidence : "initial-estimate",
            delayMinutes: primaryItem ? primaryItem.delayMinutes : 0,
            delayFormatted: primaryItem ? primaryItem.delayFormatted : null,
            scheduledPassageTime: primaryItem ? primaryItem.scheduledPassageTime : null,
            earlyLateStatus: primaryItem ? primaryItem.earlyLateStatus : null,
            earlyLateMinutes: primaryItem ? primaryItem.earlyLateMinutes : null,
            predictionMethod: primaryItem ? primaryItem.gateModelMethod : "11-min baseline",
            dataQuality: primaryItem ? {
                source: primaryItem.source || "RECENT_TELEMETRY",
                confidence: primaryItem.confidence || "MEDIUM",
                movementState: primaryItem.movementState || "RUNNING",
                stopType: primaryItem.stopType || null,
                telemetryFreshness: primaryItem.telemetryFreshness || "FRESH",
                telemetryAgeMinutes: primaryItem.telemetryAgeMinutes ?? 0,
                degradedConfidence: Boolean(primaryItem.degradedConfidence),
                unexpectedHalt: Boolean(primaryItem.unexpectedHalt)
            } : null,
            telemetryFreshness: primaryItem ? primaryItem.telemetryFreshness : "UNAVAILABLE",
            movementState: primaryItem ? primaryItem.movementState : "UNKNOWN",
            stopType: primaryItem ? primaryItem.stopType : null,
            degradedConfidence: primaryItem ? Boolean(primaryItem.degradedConfidence) : false,
            extendedOutlook: extendedOutlook || [],
            hasExtendedOutlook: Array.isArray(extendedOutlook) && extendedOutlook.length > 0,
            forecastHorizonMinutes: 60,
            extendedHorizonMinutes: 120
        };

    }

    // Sort global queue chronologically and ensure no passed trains
    globalUpcomingQueue.sort((a, b) => new Date(a.estimatedPassageTime).getTime() - new Date(b.estimatedPassageTime).getTime());
    const activeCorridorQueue = globalUpcomingQueue.filter(item => {
        const pMs = new Date(item.estimatedPassageTime).getTime();
        return (pMs + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000) >= now.getTime();
    });

    let rootLastTrainPassed = null;
    let latestPassedMs = -Infinity;
    for (const c of Object.values(formattedCrossings)) {
        if (c.lastTrainPassed && c.lastTrainPassed.passageTime) {
            const pMs = new Date(c.lastTrainPassed.passageTime).getTime();
            if (pMs > latestPassedMs) {
                latestPassedMs = pMs;
                rootLastTrainPassed = c.lastTrainPassed;
            }
        }
    }

    const snapshot = {
        snapshotId: cycleId || `snapshot-${Date.now()}`,
        generatedAt,
        liveDataTimestamp: liveTs,
        freshness: snapshotFreshness,
        engineStatus,
        forecastHorizonMinutes: TIMING_CONFIG.FORECAST_HORIZON_PRIMARY_MINUTES || 60,
        extendedHorizonMinutes: TIMING_CONFIG.FORECAST_HORIZON_EXTENDED_MINUTES || 120,
        lastTrainPassed: rootLastTrainPassed,
        crossings: formattedCrossings,
        corridorQueue: activeCorridorQueue,
        diagnostics: {
            cycleId,
            timestamp: generatedAt,
            discoveredTrains: diagnostics.discoveredTrains || 0,
            selectedTrains: diagnostics.selectedTrains || 0,
            successfulAnalyses: diagnostics.successfulAnalyses || 0,
            failedAnalyses: diagnostics.failedAnalyses || 0,
            apiErrors: diagnostics.apiErrors || 0,
            rateLimitHits: diagnostics.rateLimitHits || 0,
            eventsIn60Min: activeCorridorQueue.length,
            durationMs: diagnostics.durationMs || 0
        }
    };

    return snapshot;
}

/* ============================================================
   SAVE SNAPSHOT ATOMICALLY
============================================================ */

function saveSnapshot(snapshot, persistToDisk = true) {
    activeSnapshot = snapshot;

    if (process.env.NODE_ENV === "test" || !persistToDisk) {
        return;
    }

    try {
        const dir = path.dirname(SNAPSHOT_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const tempFile = `${SNAPSHOT_FILE}.${Date.now()}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(snapshot, null, 2), "utf8");
        fs.renameSync(tempFile, SNAPSHOT_FILE);
    } catch (err) {
        console.error("⚠️ Failed to write forecast-snapshot.json:", err.message);
    }
}

/* ============================================================
   GET ACTIVE SNAPSHOT (WITH RUNTIME FRESHNESS EVALUATION)
============================================================ */

function getActiveSnapshot(customNow = null) {
    const now = customNow ? (typeof customNow === "number" ? customNow : new Date(customNow).getTime()) : Date.now();
    const MAX_LAST_TRAIN_AGE_MS = 60 * 60 * 1000; // 60 minutes

    // 1. Try in-memory active snapshot first
    if (!activeSnapshot) {
        try {
            if (fs.existsSync(SNAPSHOT_FILE)) {
                const raw = fs.readFileSync(SNAPSHOT_FILE, "utf8");
                if (raw.trim()) {
                    const parsed = JSON.parse(raw);
                    const diskGenMs = parsed?.generatedAt ? new Date(parsed.generatedAt).getTime() : 0;
                    // Invalidate disk snapshot if older than UNAVAILABLE threshold
                    if (diskGenMs > 0 && (now - diskGenMs) <= TIMING_CONFIG.SNAPSHOT_UNAVAILABLE_THRESHOLD_MS) {
                        activeSnapshot = parsed;
                    } else {
                        console.log("ℹ️ Disk snapshot is expired or unavailable; awaiting fresh monitoring cycle.");
                    }
                }
            }
        } catch (err) {
            console.error("⚠️ Failed to read snapshot file:", err.message);
        }
    }

    // 2. If still no snapshot or expired, return UNAVAILABLE structure
    if (!activeSnapshot) {
        return buildUnavailableSnapshot("Awaiting initial live railway monitoring cycle...");
    }

    // 3. Evaluate freshness against current wall-clock
    const generatedMs = new Date(activeSnapshot.generatedAt).getTime();
    const ageMs = now - generatedMs;

    // Strict freshness contract (4-tier state machine: LIVE, AGING, STALE, UNAVAILABLE)
    let freshness = "LIVE_FRESH";
    let dataFreshness = "LIVE";
    if (ageMs > TIMING_CONFIG.SNAPSHOT_UNAVAILABLE_THRESHOLD_MS) {
        return buildUnavailableSnapshot("Live railway telemetry expired. Awaiting fresh cycle.");
    } else if (ageMs > TIMING_CONFIG.SNAPSHOT_STALE_THRESHOLD_MS) {
        freshness = "STALE";
        dataFreshness = "STALE";
    } else if (ageMs > TIMING_CONFIG.SNAPSHOT_FRESH_THRESHOLD_MS) {
        freshness = "LIVE_RECENT";
        dataFreshness = "AGING";
    } else {
        freshness = "LIVE_FRESH";
        dataFreshness = "LIVE";
    }

    const nowDate = new Date(now);
    const updated = {
        ...activeSnapshot,
        freshness,
        dataFreshness,
        liveDataFetchedAt: activeSnapshot.liveDataTimestamp || activeSnapshot.generatedAt,
        telemetryAgeSeconds: Math.max(0, Math.floor(ageMs / 1000)),
        forecastAgeSeconds: Math.max(0, Math.floor((now - generatedMs) / 1000)),
        source: activeSnapshot.source || "LIVE_RADAR"
    };

    for (const id of Object.keys(updated.crossings)) {
        const c = { ...updated.crossings[id] };
        c.freshness = freshness;
        c.dataFreshness = dataFreshness;
        if (c.diagnosticMetadata) {
            c.diagnosticMetadata.dataFreshness = freshness;
        }

        // Check if there is a primary train
        let primaryTrain = c.primaryTrain ? { ...c.primaryTrain } : null;
        let upcomingTrains = Array.isArray(c.upcomingTrains) ? c.upcomingTrains.map(t => ({ ...t })) : [];

        let passageTimeStr = c.trainPassage?.estimatedTime || primaryTrain?.estimatedPassageTime;
        let passageMs = passageTimeStr ? new Date(passageTimeStr).getTime() : NaN;
        let diffMinutes = !Number.isNaN(passageMs) ? (passageMs - now) / 60000 : null;

        // Loop while primary train has completed passage (+1m buffer)
        while (primaryTrain && diffMinutes != null && diffMinutes <= -TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES) {
            // Archive this completed train into c.lastTrainPassed ONLY if within 60 minutes
            const elapsedSincePassage = now - passageMs;
            if (elapsedSincePassage <= MAX_LAST_TRAIN_AGE_MS && elapsedSincePassage >= 0) {
                c.lastTrainPassed = {
                    trainNumber: String(primaryTrain.trainNumber || primaryTrain.number || ""),
                    trainName: primaryTrain.trainName || primaryTrain.name || "Express Train",
                    direction: primaryTrain.direction || "forward",
                    passageTime: new Date(passageMs).toISOString(),
                    passedAt: new Date(passageMs).toISOString(),
                    likelyClosure: primaryTrain.predictedGateCloseTime || new Date(passageMs - TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_CLOSURE_OFFSET_MINUTES * 60000).toISOString(),
                    likelyReopen: primaryTrain.predictedGateOpenTime || new Date(passageMs + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000).toISOString()
                };
            } else {
                c.lastTrainPassed = null;
            }

            // Advance to next upcoming train
            if (upcomingTrains.length > 0) {
                primaryTrain = upcomingTrains.shift();
                const nextPassageMs = new Date(primaryTrain.estimatedPassageTime).getTime();
                passageMs = nextPassageMs;
                diffMinutes = !Number.isNaN(nextPassageMs) ? (nextPassageMs - now) / 60000 : null;
            } else {
                primaryTrain = null;
                diffMinutes = null;
                break;
            }
        }

        // Purge any passed trains sitting in upcomingTrains and archive if more recent
        upcomingTrains = upcomingTrains.filter(t => {
            const tMs = new Date(t.estimatedPassageTime).getTime();
            const tDiff = (tMs - now) / 60000;
            if (tDiff <= -TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES) {
                const elapsedSincePassage = now - tMs;
                if (elapsedSincePassage <= MAX_LAST_TRAIN_AGE_MS && elapsedSincePassage >= 0) {
                    if (!c.lastTrainPassed || tMs > new Date(c.lastTrainPassed.passageTime).getTime()) {
                        c.lastTrainPassed = {
                            trainNumber: String(t.trainNumber || t.number || ""),
                            trainName: t.trainName || t.name || "Express Train",
                            direction: t.direction || "forward",
                            passageTime: new Date(tMs).toISOString(),
                            passedAt: new Date(tMs).toISOString(),
                            likelyClosure: t.predictedGateCloseTime || new Date(tMs - TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_CLOSURE_OFFSET_MINUTES * 60000).toISOString(),
                            likelyReopen: t.predictedGateOpenTime || new Date(tMs + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000).toISOString()
                        };
                    }
                }
                return false;
            }
            return tDiff <= TIMING_CONFIG.FORECAST_HORIZON_MINUTES;
        });

        // Ensure lastTrainPassed is strictly expired if older than 60m
        if (c.lastTrainPassed && c.lastTrainPassed.passageTime) {
            const pMs = new Date(c.lastTrainPassed.passageTime).getTime();
            if (Number.isNaN(pMs) || (now - pMs) > MAX_LAST_TRAIN_AGE_MS) {
                c.lastTrainPassed = null;
            }
        }

        // If primaryTrain is beyond the 60-minute window, it should not be active hero
        if (primaryTrain && diffMinutes != null && diffMinutes > TIMING_CONFIG.FORECAST_HORIZON_MINUTES) {
            upcomingTrains.unshift(primaryTrain);
            primaryTrain = null;
            diffMinutes = null;
        }

        // Recompute combined closure with valid active candidates
        const allCandidates = [primaryTrain, ...upcomingTrains].filter(Boolean);
        const runtimeCombined = computeCombinedClosureTimeline(allCandidates, nowDate);

        // Update live metrics and continuous closure context on upcoming trains
        upcomingTrains = upcomingTrains.map(ut => {
            const pMs = new Date(ut.estimatedPassageTime).getTime();
            const liveEta = Math.max(0, (pMs - now) / 60000);
            const num = String(ut.trainNumber || ut.number || "");

            let isContinuousClosure = false;
            let effectiveGateCloseTime = ut.predictedGateCloseTime || new Date(pMs - TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_CLOSURE_OFFSET_MINUTES * 60000).toISOString();
            let effectiveGateOpenTime = ut.predictedGateOpenTime || new Date(pMs + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000).toISOString();
            let continuousTrainNumbers = [];

            if (runtimeCombined && Array.isArray(runtimeCombined.allBlocks)) {
                const matchedBlock = runtimeCombined.allBlocks.find(b =>
                    b.isContinuous && Array.isArray(b.trainNumbers) && b.trainNumbers.includes(num)
                );
                if (matchedBlock) {
                    isContinuousClosure = true;
                    effectiveGateCloseTime = matchedBlock.closureStart;
                    effectiveGateOpenTime = matchedBlock.closureEnd;
                    continuousTrainNumbers = matchedBlock.trainNumbers;
                }
            }

            return {
                ...ut,
                etaMinutes: Number(liveEta.toFixed(1)),
                predictedGateCloseTime: ut.predictedGateCloseTime || new Date(pMs - TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_CLOSURE_OFFSET_MINUTES * 60000).toISOString(),
                predictedGateOpenTime: ut.predictedGateOpenTime || new Date(pMs + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000).toISOString(),
                isContinuousClosure,
                effectiveGateCloseTime,
                effectiveGateOpenTime,
                continuousTrainNumbers
            };
        });

        c.primaryTrain = primaryTrain;
        c.upcomingTrains = upcomingTrains;
        c.subsequentTrains = upcomingTrains;
        c.totalUpcomingTrains = upcomingTrains.length;
        c.activeTrainCount = primaryTrain ? upcomingTrains.length + 1 : upcomingTrains.length;

        c.combinedClosure = runtimeCombined;
        c.overlappingClosure = runtimeCombined;
        c.closureWindow = runtimeCombined ? {
            start: runtimeCombined.closureStart,
            end: runtimeCombined.closureEnd,
            recommendedCrossBy: runtimeCombined.recommendedCrossBy,
            isOverlapping: runtimeCombined.isContinuous,
            isContinuous: runtimeCombined.isContinuous,
            trainCount: runtimeCombined.trainCount
        } : null;

        if (primaryTrain && diffMinutes != null) {
            const nextPassageMs = new Date(primaryTrain.estimatedPassageTime).getTime();
            const nextPassageIso = primaryTrain.estimatedPassageTime;
            const nextClosureIso = new Date(nextPassageMs - TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_CLOSURE_OFFSET_MINUTES * 60000).toISOString();
            const nextReopenIso = new Date(nextPassageMs + TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES * 60000).toISOString();

            c.timingMetrics = {
                passageTime: nextPassageIso,
                likelyClosure: (runtimeCombined && runtimeCombined.isContinuous) ? runtimeCombined.closureStart : nextClosureIso,
                likelyReopen: (runtimeCombined && runtimeCombined.isContinuous) ? runtimeCombined.closureEnd : nextReopenIso,
                leadBuffer: (runtimeCombined && runtimeCombined.isContinuous) ? `Continuous (~${Math.round(runtimeCombined.durationMinutes)} min)` : TIMING_CONFIG.TIMELINE_CONFIG.LEAD_BUFFER_LABEL
            };
            c.closure = {
                earliest: (runtimeCombined && runtimeCombined.isContinuous) ? runtimeCombined.closureStart : nextClosureIso,
                latest: new Date(nextPassageMs - 8.0 * 60000).toISOString(),
                likelyClosure: (runtimeCombined && runtimeCombined.isContinuous) ? runtimeCombined.closureStart : nextClosureIso
            };
            c.reopening = {
                earliest: (runtimeCombined && runtimeCombined.isContinuous) ? runtimeCombined.closureEnd : nextReopenIso,
                latest: (runtimeCombined && runtimeCombined.isContinuous) ? runtimeCombined.closureEnd : nextReopenIso,
                likelyReopen: (runtimeCombined && runtimeCombined.isContinuous) ? runtimeCombined.closureEnd : nextReopenIso
            };
            c.trainPassage = {
                estimatedTime: nextPassageIso,
                etaMinutes: Number(Math.max(0, diffMinutes).toFixed(1))
            };

            const statusInfo = determineCrossingStatus(primaryTrain, freshness, nowDate, runtimeCombined);
            c.status = statusInfo.status;
            c.crossingStatus = statusInfo.status;
            c.message = statusInfo.message;
            c.predictionAvailable = statusInfo.predictionAvailable;
            c.recommendation = statusInfo.status === "FATAK CLOSED"
                ? "DO NOT CROSS — FATAK CLOSED"
                : statusInfo.status === "TRAIN APPROACHING"
                    ? "PLAN TO STOP — TRAIN APPROACHING"
                    : "SAFE TO CROSS — OPEN";

            c.primaryTrain.etaMinutes = Number(Math.max(0, diffMinutes).toFixed(1));
            if (c.diagnosticMetadata) {
                c.diagnosticMetadata.ETA = Number(Math.max(0, diffMinutes).toFixed(1));
            }
        } else {
            // No active primary train in horizon - corridor clear
            c.primaryTrain = null;
            c.timingMetrics = null;
            c.closure = null;
            c.reopening = null;
            c.trainPassage = null;
            c.totalUpcomingTrains = 0;
            c.activeTrainCount = 0;
            c.combinedClosure = null;
            c.overlappingClosure = null;
            c.closureWindow = null;

            if (freshness === "UNAVAILABLE") {
                c.status = "LIVE_DATA_UNAVAILABLE";
                c.crossingStatus = "LIVE_DATA_UNAVAILABLE";
                c.predictionAvailable = false;
                c.message = "Live railway data is unavailable. Gates may operate on manual/signal authority.";
                c.recommendation = "PROCEED WITH CAUTION";
            } else if (freshness === "STALE") {
                c.status = "LIVE_DATA_UNAVAILABLE";
                c.crossingStatus = "LIVE_DATA_UNAVAILABLE";
                c.predictionAvailable = false;
                c.message = "Telemetry update delayed. Crossing movements unverified.";
                c.recommendation = "PROCEED WITH CAUTION";
            } else {
                c.status = "OPEN";
                c.crossingStatus = "OPEN";
                c.predictionAvailable = true;
                c.message = "No train expected within the next hour. Corridor is clear.";
                c.recommendation = "SAFE TO CROSS — OPEN";
            }
        }

        updated.crossings[id] = c;
    }

    // Refresh root lastTrainPassed and corridorQueue
    let rootLastTrainPassed = null;
    let latestPassedMs = -Infinity;
    for (const c of Object.values(updated.crossings)) {
        if (c.lastTrainPassed && c.lastTrainPassed.passageTime) {
            const pMs = new Date(c.lastTrainPassed.passageTime).getTime();
            if (pMs > latestPassedMs && (now - pMs) <= MAX_LAST_TRAIN_AGE_MS) {
                latestPassedMs = pMs;
                rootLastTrainPassed = c.lastTrainPassed;
            }
        }
    }
    updated.lastTrainPassed = rootLastTrainPassed;

    updated.corridorQueue = (updated.corridorQueue || []).filter(item => {
        const pMs = new Date(item.estimatedPassageTime).getTime();
        const diff = (pMs - now) / 60000;
        return diff > -TIMING_CONFIG.TIMELINE_CONFIG.LIKELY_REOPEN_OFFSET_MINUTES && diff <= TIMING_CONFIG.FORECAST_HORIZON_MINUTES;
    });

    return updated;
}

/* ============================================================
   UNAVAILABLE SNAPSHOT FALLBACK
============================================================ */

function buildUnavailableSnapshot(reason = "Live data unavailable") {
    const now = new Date();
    const crossings = {};

    for (const crossing of V1_CROSSINGS) {
        crossings[crossing.id] = {
            crossing: {
                id: crossing.id,
                name: crossing.name,
                coordinates: crossing.coordinates
            },
            status: "LIVE_DATA_UNAVAILABLE",
            predictionAvailable: false,
            freshness: "UNAVAILABLE",
            message: reason,
            primaryTrain: null,
            upcomingTrains: [],
            totalUpcomingTrains: 0,
            activeTrainCount: 0,
            overlappingClosure: null,
            closureWindow: null,
            trainPassage: null,
            lastTrainPassed: null,
            recommendation: "DATA UNAVAILABLE — CAUTION",
            extendedOutlook: [],
            hasExtendedOutlook: false,
            forecastHorizonMinutes: TIMING_CONFIG.FORECAST_HORIZON_PRIMARY_MINUTES || 60,
            extendedHorizonMinutes: TIMING_CONFIG.FORECAST_HORIZON_EXTENDED_MINUTES || 120
        };

    }

    return {
        snapshotId: `unavailable-${now.getTime()}`,
        generatedAt: now.toISOString(),
        liveDataTimestamp: null,
        freshness: "UNAVAILABLE",
        engineStatus: "UNAVAILABLE",
        forecastHorizonMinutes: TIMING_CONFIG.FORECAST_HORIZON_PRIMARY_MINUTES || 60,
        extendedHorizonMinutes: TIMING_CONFIG.FORECAST_HORIZON_EXTENDED_MINUTES || 120,
        lastTrainPassed: null,
        crossings,
        corridorQueue: [],
        diagnostics: {
            reason,
            timestamp: now.toISOString()
        }
    };
}

module.exports = {
    buildUnifiedSnapshot,
    saveSnapshot,
    getActiveSnapshot,
    buildUnavailableSnapshot,
    computeOverlappingClosure,
    computeCombinedClosureTimeline,
    determineCrossingStatus
};
