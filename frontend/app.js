/* =========================================================
   FATAKFORECAST — CLIENT APPLICATION ENGINE
   Mobility Intelligence • Mobile-First • Decision Support
========================================================= */

/* =========================================================
   CONFIGURATION & DYNAMIC ORIGIN
========================================================= */

const API_BASE_URL = window.FATAK_API_BASE_URL || window.location.origin;

const REFRESH_INTERVAL_MS = 30 * 1000; // 30 seconds API poll
const TICK_INTERVAL_MS = 1000;         // 1 second smooth countdown tick

// Corridor layout definition (MOW -> JNL)
const CORRIDOR_CROSSINGS = [
    { id: "talwandi-dogran", name: "Talwandi Dogran", pct: 20 },
    { id: "manawala-road", name: "Manawala Road", pct: 42 },
    { id: "rakh-devi-dasspura", name: "Rakh Devi Dasspura", pct: 68 },
    { id: "jandiala", name: "Jandiala Crossing", pct: 88 }
];

/* =========================================================
   APPLICATION STATE
========================================================= */

let forecasts = [];
let selectedCrossingId = null;
let lastFetchTimestamp = null;
let isFetching = false;
let refreshTimer = null;
let liveRenderTimer = null;
let dataSource = "NONE"; // "NONE" | "CACHE" | "LIVE"
const MAX_CACHE_AGE_MS = 5 * 60 * 1000; // 5 minutes cache TTL
let activeAbortController = null;
let latestRequestId = 0;
let retryTimer = null;

// Preserve observation form state across live forecast re-renders.
let observationDraft = {
    key: null,
    open: false,
    feedback: null,
    close: "",
    passage: "",
    gateOpen: "",
    notes: "",
    result: "",
    editing:false
};
/* =========================================================
   DOM ELEMENTS
========================================================= */

const crossingSelector = document.getElementById("crossing-selector");
const mainForecast = document.getElementById("main-forecast");
const crossingsGrid = document.getElementById("crossings-grid");
const updatedTime = document.getElementById("updated-time");
const systemStatus = document.getElementById("system-status");
const systemStatusText = document.getElementById("system-status-text");
const manualRefresh = document.getElementById("manual-refresh");
const toast = document.getElementById("toast");
const toastMessage = document.getElementById("toast-message");
const upcomingQueueContainer = document.getElementById("upcoming-queue-container");
const upcomingQueueGrid = document.getElementById("upcoming-queue-grid");
const crossingNodesContainer = document.getElementById("crossing-nodes");
const liveTrainMarker = document.getElementById("live-train-marker");
const trainPinLabel = document.getElementById("train-pin-label");
const trackDirectionText = document.getElementById("track-direction-text");
const trackDistanceText = document.getElementById("track-distance-text");
const splashScreen = document.getElementById("splash-screen");
const coldStartBanner = document.getElementById("cold-start-banner");
const coldStartText = document.getElementById("cold-start-text");
const lastTrainPassedContainer = document.getElementById("last-train-passed-container");
const extendedOutlookContainer = document.getElementById("extended-outlook-section");

/* =========================================================
   OPENING SPLASH ANIMATION CONTROLLER
========================================================= */

function initSplashScreen() {
    if (!splashScreen) return;

    const prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
        splashScreen.style.display = "none";
        return;
    }

    const dismissSplash = () => {
        splashScreen.classList.add("fade-out");
        setTimeout(() => {
            splashScreen.style.display = "none";
        }, 500);
    };

    splashScreen.addEventListener("click", dismissSplash);

    // Auto-dismiss after 1.8 seconds
    setTimeout(dismissSplash, 1800);
}

/* =========================================================
   COLD START & SNAPSHOT CACHE
========================================================= */

function loadCachedSnapshot() {
    try {
        const cachedRaw = localStorage.getItem("fatakforecast_cached_snapshot");
        if (!cachedRaw) {
            dataSource = "NONE";
            return false;
        }
        const cached = JSON.parse(cachedRaw);
        if (!cached || !Array.isArray(cached.forecasts) || !cached.savedAt) {
            dataSource = "NONE";
            return false;
        }

        const ageMs = Date.now() - cached.savedAt;
        // Requirement 4 & 5: If cached snapshot is older than 5 minutes, discard it
        if (ageMs > MAX_CACHE_AGE_MS) {
            try { localStorage.removeItem("fatakforecast_cached_snapshot"); } catch (e) {}
            dataSource = "NONE";
            return false;
        }

        dataSource = "CACHE";
        forecasts = cached.forecasts;
        lastFetchTimestamp = cached.savedAt;

        if (!selectedCrossingId || !forecasts.some(f => f.crossing?.id === selectedCrossingId)) {
            selectedCrossingId = forecasts[0]?.crossing?.id || "talwandi-dogran";
        }

        renderCrossingSelector();
        renderMainForecast();
        renderAllCrossings();
        updateTrackVisualizer();

        // Requirement 6: Visibly show "CONNECTING TO LIVE RAIL DATA" and "LAST VALID UPDATE — Xm AGO"
        if (coldStartBanner && coldStartText) {
            const ageMin = Math.max(1, Math.round(ageMs / 60000));
            coldStartText.textContent = `CONNECTING TO LIVE RAIL DATA — LAST VALID UPDATE ${ageMin}m AGO`;
            coldStartBanner.style.display = "flex";
        }
        // Requirement 3: Cached data must NEVER be labelled LIVE RAIL DATA
        setSystemStatus("CONNECTING...", "stale");
        return true;
    } catch (e) {
        dataSource = "NONE";
        return false;
    }
}

/* =========================================================
   INITIALIZATION
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
    initSplashScreen();
    loadCachedSnapshot();
    buildTrackNodes();
    fetchForecast();

    // Regular polling for fresh train positions
    refreshTimer = setInterval(() => fetchForecast(), REFRESH_INTERVAL_MS);

    // 1-second interval for smooth countdowns and live telemetry age
    liveRenderTimer = setInterval(() => {
    updateTelemetryAge();

    if (forecasts.length && selectedCrossingId) {

        // Do not rebuild the forecast DOM while the
        // observation form is being edited.
        if (!observationDraft.open) {
            renderMainForecast();
        }

        updateTrackVisualizer();
    }
}, TICK_INTERVAL_MS);
});

if (manualRefresh) {
    manualRefresh.addEventListener("click", async () => {
        if (isFetching) return;
        manualRefresh.classList.add("loading");
        await fetchForecast(true);
        setTimeout(() => manualRefresh.classList.remove("loading"), 600);
    });
}

/* =========================================================
   DATA FETCHING
========================================================= */

async function fetchForecast(showToast = false, isRetry = false) {
    if (activeAbortController) {
        activeAbortController.abort();
    }
    activeAbortController = new AbortController();
    const requestId = ++latestRequestId;
    isFetching = true;

    setSystemStatus(dataSource === "LIVE" ? "UPDATING..." : "CONNECTING...", "active");

    try {
        const response = await fetch(`${API_BASE_URL}/api/forecast`, {
            method: "GET",
            headers: { "Accept": "application/json" },
            cache: "no-store",
            signal: activeAbortController.signal
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        // Stale response race protection
        if (requestId !== latestRequestId) {
            return;
        }

        if (!data || !Array.isArray(data.forecasts)) {
            throw new Error("Malformed API response");
        }

        // Handle backend cold start / cycle in progress
        if (data.engineStatus === "CYCLE_IN_PROGRESS" || data.freshness === "CONNECTING") {
            if (coldStartBanner && coldStartText) {
                coldStartText.textContent = "CONNECTING TO LIVE RAIL DATA — FIRST CYCLE IN PROGRESS";
                coldStartBanner.style.display = "flex";
            }
            setSystemStatus("CONNECTING...", "stale");
            if (!isRetry) {
                if (retryTimer) clearTimeout(retryTimer);
                retryTimer = setTimeout(() => fetchForecast(false, true), 3000);
            }
            return;
        }

        // Requirement 7: When live API succeeds: dataSource = LIVE, replace cache completely with fresh forecasts
        dataSource = "LIVE";
        forecasts = data.forecasts;
        lastFetchTimestamp = Date.now();

        const isFresh = data.freshness !== "UNAVAILABLE";
        if (isFresh) {
            try {
                localStorage.setItem("fatakforecast_cached_snapshot", JSON.stringify({
                    forecasts: data.forecasts,
                    savedAt: Date.now(),
                    freshness: data.freshness
                }));
            } catch (e) {}
        }

        if (coldStartBanner) {
            coldStartBanner.style.display = "none";
        }

        // If no selection yet, select the crossing with the most imminent train, or default to first
        if (!selectedCrossingId || !forecasts.some(f => f.crossing?.id === selectedCrossingId)) {
            const approaching = forecasts.filter(f => f.predictionAvailable && f.trainPassage?.estimatedTime)
                .sort((a, b) => new Date(a.trainPassage.estimatedTime) - new Date(b.trainPassage.estimatedTime));
            
            selectedCrossingId = approaching[0]?.crossing?.id || forecasts[0]?.crossing?.id || "rakh-devi-dasspura";
        }

        renderCrossingSelector();
        renderMainForecast();
        renderAllCrossings();
        updateTrackVisualizer();

        if (data.freshness === "UNAVAILABLE") {
            setSystemStatus("DATA UNAVAILABLE", "error");
        } else {
            setSystemStatus("LIVE RAIL DATA", "live");
        }
        updateTelemetryAge();

        if (showToast) {
            showToastPopup(data.freshness === "UNAVAILABLE" ? "Live railway telemetry unavailable" : "Forecast updated successfully");
        }
    } catch (err) {
        if (err.name === "AbortError") {
            return; // Superseded by a newer request
        }
        console.error("FatakForecast fetch error:", err);

        // Stale response race protection
        if (requestId !== latestRequestId) {
            return;
        }

        // Controlled auto-retry for cold starts
        if (!isRetry) {
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = setTimeout(() => fetchForecast(false, true), 3000);
        }

        // Requirement 8: When live API fails:
        // Check if cached data exists and is <= 5 minutes old
        const cacheAge = lastFetchTimestamp ? (Date.now() - lastFetchTimestamp) : Infinity;
        if (cacheAge <= MAX_CACHE_AGE_MS && forecasts.length > 0) {
            dataSource = "CACHE";
            setSystemStatus("CACHED SNAPSHOT", "stale");
            if (coldStartBanner && coldStartText) {
                const ageMin = Math.max(1, Math.round(cacheAge / 60000));
                coldStartText.textContent = `CONNECTING TO LIVE RAIL DATA — LAST VALID UPDATE ${ageMin}m AGO`;
                coldStartBanner.style.display = "flex";
            }
            renderCrossingSelector();
            renderMainForecast();
            renderAllCrossings();
            updateTrackVisualizer();
            showToastPopup("Live connection delayed — using cached snapshot");
        } else {
            // Requirement 8 & 9: Discard stale cache, never claim crossing is OPEN merely because old forecast expired
            dataSource = "NONE";
            forecasts = [];
            try { localStorage.removeItem("fatakforecast_cached_snapshot"); } catch (e) {}
            setSystemStatus("DATA UNAVAILABLE", "error");
            renderMainForecast();
            renderCrossingSelector();
            renderAllCrossings();
            updateTrackVisualizer();
        }
    } finally {
        isFetching = false;
    }
}

/* =========================================================
   STATUS TAXONOMY & CLASSIFICATION
   (Never fabricate gate status — strictly model-driven)
========================================================= */

function parseTime(val) {
    if (!val) return null;
    const t = new Date(val).getTime();
    return Number.isNaN(t) ? null : t;
}

function getLiveStatus(forecast) {
    if (!forecast || dataSource === "NONE") return "LIVE_DATA_UNAVAILABLE";
    if (forecast.status === "LIVE_DATA_UNAVAILABLE" || forecast.freshness === "UNAVAILABLE") {
        return "LIVE_DATA_UNAVAILABLE";
    }
    if (forecast.status === "PREDICTION_UNAVAILABLE") {
        return "PREDICTION_UNAVAILABLE";
    }

    const now = Date.now();
    const passage = parseTime(forecast.trainPassage?.estimatedTime || forecast.primaryTrain?.estimatedPassageTime);

    // If dataSource is CACHE:
    // If cached train has already passed (> 1 min ago or diffMinutes <= -1), we CANNOT assume crossing is OPEN!
    if (dataSource === "CACHE") {
        if (!passage) {
            return "LIVE_DATA_UNAVAILABLE";
        }
        const diff = (passage - now) / 60000;
        if (diff < -1) {
            return "LIVE_DATA_UNAVAILABLE";
        }
    }

    if (forecast.predictionAvailable === false && !passage) {
        return dataSource === "LIVE" ? "OPEN" : "LIVE_DATA_UNAVAILABLE";
    }

    // Check multi-train continuous closure first
    const combined = forecast.combinedClosure || forecast.overlappingClosure;
    if (combined && (combined.isContinuous || combined.isOverlapping || combined.trainCount > 1)) {
        const closureStart = parseTime(combined.closureStart || combined.start);
        const closureEnd = parseTime(combined.closureEnd || combined.end);
        const firstPassage = parseTime(combined.firstTrainPassage) || passage;

        if (closureStart && closureEnd) {
            // Within continuous closure interval: strictly FATAK CLOSED
            if (now >= closureStart && now <= closureEnd) {
                return "FATAK CLOSED";
            }
            // Before closure interval: evaluate first train approach
            if (now < closureStart && firstPassage) {
                const diffFirst = (firstPassage - now) / 60000;
                if (diffFirst > 15) return "OPEN";
                return "TRAIN APPROACHING";
            }
            // After continuous closure has completely passed:
            if (now > closureEnd) {
                if (Array.isArray(forecast.upcomingTrains) && forecast.upcomingTrains.length > 0) {
                    const nextTrain = forecast.upcomingTrains.find(t => parseTime(t.estimatedPassageTime) > closureEnd);
                    if (nextTrain) {
                        const nextPassage = parseTime(nextTrain.estimatedPassageTime);
                        if (nextPassage) {
                            const nextDiff = (nextPassage - now) / 60000;
                            if (nextDiff > 15) return "OPEN";
                            if (nextDiff > 8) return "TRAIN APPROACHING";
                            if (nextDiff > -1) return "FATAK CLOSED";
                        }
                    }
                }
                return dataSource === "LIVE" ? "OPEN" : "LIVE_DATA_UNAVAILABLE";
            }
        }
    }

    if (!passage) {
        return dataSource === "LIVE" ? "OPEN" : "LIVE_DATA_UNAVAILABLE";
    }

    const diffMinutes = (passage - now) / 60000;

    // 1. More than 15 minutes before passage: OPEN
    if (diffMinutes > 15) {
        return "OPEN";
    }

    // 2. Between 15 minutes and 8 minutes before passage: TRAIN APPROACHING
    if (diffMinutes > 8) {
        return "TRAIN APPROACHING";
    }

    // 3. From 8 minutes before passage until the train passes: FATAK CLOSED
    // 4. After the train passage: Keep crossing in PREDICTED CLOSED state for 1 minute: FATAK CLOSED
    if (diffMinutes > -1) {
        return "FATAK CLOSED";
    }

    // 5. After the 1-minute reopening baseline: OPEN (or evaluate next train)
    if (Array.isArray(forecast.upcomingTrains) && forecast.upcomingTrains.length > 0) {
        const nextPassage = parseTime(forecast.upcomingTrains[0].estimatedPassageTime);
        if (nextPassage) {
            const nextDiff = (nextPassage - now) / 60000;
            if (nextDiff > 15) return "OPEN";
            if (nextDiff > 8) return "TRAIN APPROACHING";
            if (nextDiff > -1) return "FATAK CLOSED";
        }
    }

    return dataSource === "LIVE" ? "OPEN" : "LIVE_DATA_UNAVAILABLE";
}

function getStatusDetails(status, hasPrediction = true) {
    switch (status) {
        case "OPEN":
        case "EXPECTED_OPEN":
            return {
                label: "EXPECTED OPEN",
                chipText: "OPEN",
                className: "status-open",
                stateClass: "state-expected-open",
                countdownAccent: "accent-open",
                action: "SAFE TO CROSS — EXPECTED OPEN",
                actionClass: "safe",
                actionIcon: "✓"
            };

        case "TRAIN APPROACHING":
        case "CLOSURE_IMMINENT":
            return {
                label: "TRAIN APPROACHING",
                chipText: "TRAIN APPROACHING",
                className: "status-closing",
                stateClass: "state-approaching",
                countdownAccent: "accent-closing",
                action: "PLAN TO STOP — TRAIN APPROACHING",
                actionClass: "warning",
                actionIcon: "⚠️"
            };

        case "FATAK CLOSED":
        case "CLOSED_EXPECTED":
        case "REOPENING":
            return {
                label: "FATAK CLOSED",
                chipText: "FATAK CLOSED",
                className: "status-closed",
                stateClass: "state-closed",
                countdownAccent: "accent-closed",
                action: "DO NOT CROSS — FATAK CLOSED",
                actionClass: "danger",
                actionIcon: "🛑"
            };

        case "LIVE_DATA_UNAVAILABLE":
        case "PREDICTION_UNAVAILABLE":
        case "DATA UNAVAILABLE":
            return {
                label: "DATA UNAVAILABLE",
                chipText: "UNAVAILABLE",
                className: "status-unknown",
                stateClass: "state-unknown",
                countdownAccent: "",
                action: "Live railway data is unavailable. Gates operate on manual authority.",
                actionClass: "warning",
                actionIcon: "⚠️"
            };

        default:
            return {
                label: "OPEN",
                chipText: "OPEN",
                className: "status-open",
                stateClass: "state-expected-open",
                countdownAccent: "accent-open",
                action: "SAFE TO CROSS — OPEN",
                actionClass: "safe",
                actionIcon: "✓"
            };
    }
}


/* =========================================================
   COUNTDOWN ENGINE (No negative or NaN countdowns)
========================================================= */

function formatCountdownSeconds(targetIso) {
    if (!targetIso) return { display: "--:--", subtext: "", isImminent: false };

    const target = parseTime(targetIso);
    if (!target) return { display: "--:--", subtext: "", isImminent: false };

    const diffMs = target - Date.now();

    if (diffMs <= 0) {
        return { display: "00:00", subtext: "Happening now", isImminent: true };
    }

    const totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        const hStr = String(hours).padStart(2, "0");
        const mStr = String(minutes).padStart(2, "0");
        const sStr = String(seconds).padStart(2, "0");
        return {
            display: `${hStr}:${mStr}:${sStr}`,
            subtext: `in approx ${hours} hr ${minutes} min`,
            isImminent: false
        };
    }

    const mStr = String(minutes).padStart(2, "0");
    const sStr = String(seconds).padStart(2, "0");
    return {
        display: `${mStr}:${sStr}`,
        subtext: minutes > 0 ? `in approx ${minutes}m ${seconds}s` : `in ${seconds}s`,
        isImminent: minutes < 3
    };
}

function formatClockTime(iso) {
    if (!iso) return "--:--";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "--:--";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
}

function formatConfidenceText(confidence) {
    const c = String(confidence || "").toLowerCase();
    if (c === "high") return { text: "HIGH CONFIDENCE", class: "high", desc: "Verified live GPS movement" };
    if (c === "medium") return { text: "MEDIUM CONFIDENCE", class: "medium", desc: "Track progress verified" };
    if (c === "low") return { text: "LOW CONFIDENCE", class: "low", desc: "Limited telemetry" };
    if (c === "degraded") return { text: "DEGRADED CONFIDENCE", class: "degraded", desc: "Unexpected halt or stationary telemetry" };
    return { text: "INITIAL ESTIMATE", class: "medium", desc: "Conservative baseline model" };
}

function formatTelemetryBadge(freshnessState, ageMinutes) {
    const s = String(freshnessState || "").toUpperCase();
    if (s === "FRESH") return { text: "LIVE POSITION", class: "fresh", icon: "🟢" };
    if (s === "AGING") return { text: `ESTIMATED POSITION (${ageMinutes != null ? ageMinutes + 'm' : '<5m'})`, class: "aging", icon: "🟡" };
    if (s === "STALE") return { text: `STALE TELEMETRY (${ageMinutes != null ? ageMinutes + 'm' : '>5m'})`, class: "stale", icon: "🟠" };
    return { text: "POSITION UNAVAILABLE", class: "unavailable", icon: "🔴" };
}

function formatMovementBadge(movementState, stopType) {
    const m = String(movementState || "").toUpperCase();
    if (m === "LIVE_STATIONARY") {
        if (stopType === "UNEXPECTED_INTERMEDIATE_STOP") {
            return { text: "UNEXPECTED HALT (SIDING/SIGNAL)", class: "halt-unexpected", icon: "🛑" };
        }
        return { text: "STATIONARY (STATION HALT)", class: "halt-station", icon: "🚉" };
    }
    if (m === "STATION_STOP") {
        return { text: "STATION STOP", class: "halt-station", icon: "🚉" };
    }
    if (m === "RUNNING" || m === "LIVE_MOVING") {
        return { text: "RUNNING", class: "running", icon: "⚡" };
    }
    return { text: "ESTIMATED", class: "estimated", icon: "⏱️" };
}

/* =========================================================
   RENDER: CROSSING SWITCHER (PILLS)
========================================================= */

function renderCrossingSelector() {
    if (!crossingSelector) return;
    crossingSelector.innerHTML = "";

    forecasts.forEach((f, idx) => {
        const crossing = f.crossing || {};
        const isSelected = crossing.id === selectedCrossingId;
        const status = getLiveStatus(f);
        const details = getStatusDetails(status, f.predictionAvailable);

        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = `crossing-tab ${isSelected ? "active" : ""}`;
        tab.setAttribute("aria-selected", isSelected ? "true" : "false");
        tab.setAttribute("role", "tab");

        tab.innerHTML = `
            <div class="tab-header">
                <span class="tab-number">#0${idx + 1}</span>
                <span class="tab-status-chip ${details.className}">${details.chipText}</span>
            </div>
            <span class="tab-name">${escapeHtml(crossing.name || "Crossing")}</span>
        `;

        tab.addEventListener("click", () => {
            selectedCrossingId = crossing.id;
            renderCrossingSelector();
            renderMainForecast();
            renderAllCrossings();
            updateTrackVisualizer();
        });

        crossingSelector.appendChild(tab);
    });
}

/* =========================================================
   RENDER: HERO PRIMARY FORECAST CARD
========================================================= */

function renderMainForecast() {
    if (!mainForecast) return;

const forecast = forecasts.find(f => f.crossing?.id === selectedCrossingId) || forecasts[0];

const observationKey = forecast ? getObservationKey(forecast) : null;
captureObservationDraft(observationKey);

    if (!forecast) {
        renderErrorState();
        return;
    }

    const crossing = forecast.crossing || {};
    const train = forecast.primaryTrain || forecast.train || null;
    const passage = forecast.trainPassage || {};
    const passageMs = parseTime(passage.estimatedTime || train?.estimatedPassageTime);
    const now = Date.now();
    const diffMin = passageMs ? (passageMs - now) / 60000 : null;

    // Strict validity: primary train must exist, must not be passed (> -1m), and must be within the 60-minute window
    const hasPrediction = Boolean(train && passageMs && diffMin != null && diffMin > -1 && diffMin <= 60);
    const status = getLiveStatus(forecast);
    const details = getStatusDetails(status, hasPrediction);

    // Render dedicated Last Train Passed component
    renderLastTrainPassed(forecast);
    // Render dedicated Extended 2-Hour Outlook component
    renderExtendedOutlook(forecast);

    // If live data is unavailable or data source is NONE/CACHE without active prediction:
    if (status === "LIVE_DATA_UNAVAILABLE" || status === "PREDICTION_UNAVAILABLE" || status === "DATA UNAVAILABLE" || dataSource === "NONE" || forecast.freshness === "UNAVAILABLE") {
        mainForecast.innerHTML = `
            <div class="forecast-card state-unknown">
                <div class="card-top-row">
                    <div class="crossing-meta-group">
                        <span class="sub-kicker">SELECTED FATAK</span>
                        <h3>${escapeHtml(crossing.name || "Railway Crossing")}</h3>
                        <span class="crossing-coords-pill">Corridor ID: <code>${escapeHtml(crossing.id || "v1")}</code></span>
                    </div>
                    <div class="status-pill-badge status-unknown">
                        <span class="status-indicator-dot"></span>
                        <span>UNAVAILABLE</span>
                    </div>
                </div>

                <div class="action-guidance-banner warning">
                    <span class="action-icon">⚠️</span>
                    <span>Live railway data is unavailable. Crossing operates on manual authority.</span>
                </div>

                <div class="empty-forecast-hero">
                    <div class="empty-icon-wrap" style="color: #f59e0b;" aria-hidden="true">⚠️</div>
                    <div class="empty-headline">Live Telemetry Unavailable</div>
                    <p class="empty-description">
                        Unable to verify current railway movements for ${escapeHtml(crossing.name || "this crossing")}. Gate opening and closure times cannot be guaranteed without live telemetry.
                    </p>
                    <button class="action-guidance-banner neutral" style="margin: 16px auto 0; cursor: pointer; display: inline-flex;" onclick="fetchForecast(true)">
                        <span>↻ Check Live Status</span>
                    </button>
                </div>
            </div>
        `;

        if (upcomingQueueContainer) {
            upcomingQueueContainer.style.display = "none";
        }
        return;
    }

    // If NO prediction exists for this crossing in the 60m window (ONLY reached when dataSource === LIVE):
    if (!hasPrediction) {
        mainForecast.innerHTML = `
            <div class="forecast-card state-expected-open">
                <div class="card-top-row">
                    <div class="crossing-meta-group">
                        <span class="sub-kicker">SELECTED FATAK</span>
                        <h3>${escapeHtml(crossing.name || "Railway Crossing")}</h3>
                        <span class="crossing-coords-pill">Corridor ID: <code>${escapeHtml(crossing.id || "v1")}</code></span>
                    </div>
                    <div class="status-pill-badge status-open">
                        <span class="status-indicator-dot"></span>
                        <span>OPEN</span>
                    </div>
                </div>

                <div class="action-guidance-banner safe">
                    <span class="action-icon">✓</span>
                    <span>No train expected within the next 1 hour — corridor is clear</span>
                </div>

                <div class="empty-forecast-hero">
                    <div class="empty-icon-wrap" aria-hidden="true">🚂</div>
                    <div class="empty-headline">Fatak is OPEN</div>
                    <p class="empty-description">
                        No scheduled or live train movements are approaching ${escapeHtml(crossing.name || "this crossing")} within the next 60 minutes.
                    </p>
                    ${forecast.lastTrainPassed ? `
                    <div style="margin-top: 14px; padding: 10px 14px; background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.2); border-radius: 8px; font-size: 0.8rem; color: #94a3b8; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
                        <span>🏁 Train #${escapeHtml(forecast.lastTrainPassed.trainNumber || '')} passed recently.</span>
                        <a href="#last-train-obs-section" style="color: #38bdf8; font-weight: 700; text-decoration: underline; cursor: pointer;">Record actual gate close & passage ↓</a>
                    </div>
                    ` : ''}
                </div>
            </div>
        `;

        if (upcomingQueueContainer) {
            upcomingQueueContainer.style.display = "none";
        }
        return;
    }

    // ---------------------------------------------------------
    // CENTRAL PASSAGE REFERENCE & CONTINUOUS CLOSURE
    // ---------------------------------------------------------
    const combined = forecast.combinedClosure || forecast.overlappingClosure;
    const isContinuous = Boolean(combined && (combined.isContinuous || combined.isOverlapping || combined.trainCount > 1));

    const passageTimeStr = formatClockTime(passageMs);
    const closureMs = passageMs - 11 * 60000;
    const reopenMs = passageMs + 1 * 60000;

    const likelyClosureMs = (isContinuous && parseTime(combined.closureStart || combined.start))
        ? parseTime(combined.closureStart || combined.start)
        : closureMs;
    const likelyReopenMs = (isContinuous && parseTime(combined.closureEnd || combined.end))
        ? parseTime(combined.closureEnd || combined.end)
        : reopenMs;

    const likelyClosureStr = formatClockTime(likelyClosureMs);
    const likelyReopenStr = formatClockTime(likelyReopenMs);
    const leadBufferStr = isContinuous
        ? `Continuous (~${Math.round(combined.durationMinutes || combined.combinedDurationMinutes || 10)} min)`
        : "11 min baseline";

    // Countdown target selection based on status phase
    let countdownTarget = passage.estimatedTime || train.estimatedPassageTime;
    let countdownTitle = "TRAIN PASSAGE IN";
    let countdownSubtext = `Passage at ${passageTimeStr}`;

    if (status === "OPEN") {
        countdownTarget = (isContinuous && combined.firstTrainPassage) ? combined.firstTrainPassage : (passage.estimatedTime || train.estimatedPassageTime);
        countdownTitle = isContinuous ? "FIRST TRAIN PASSAGE IN" : "TRAIN PASSAGE IN";
        countdownSubtext = isContinuous
            ? `${combined.trainCount} trains expected • Likely closure at ${likelyClosureStr}`
            : `Passage at ${passageTimeStr} • Likely closure at ${likelyClosureStr}`;
    } else if (status === "TRAIN APPROACHING") {
        countdownTarget = new Date(likelyClosureMs).toISOString();
        countdownTitle = "FATAK CLOSURE IN";
        countdownSubtext = isContinuous
            ? `First passage at ${passageTimeStr} • Multi-train closure until ~${likelyReopenStr}`
            : `Passage at ${passageTimeStr} • Likely reopen at ${likelyReopenStr}`;
    } else if (status === "FATAK CLOSED") {
        countdownTarget = new Date(likelyReopenMs).toISOString();
        countdownTitle = isContinuous ? "FINAL REOPENING IN" : "EXPECTED REOPENING IN";
        countdownSubtext = isContinuous
            ? `Continuous closure (${combined.trainCount} trains) • Final reopen at ${likelyReopenStr}`
            : `Train passage at ${passageTimeStr} • Stay clear of tracks`;
    }

    const countdown = formatCountdownSeconds(countdownTarget);
    if (countdownSubtext && countdown.display !== "--:--") {
        countdown.subtext = countdownSubtext;
    }

    const etaConfidence = forecast.dataQuality?.confidence || forecast.confidence || forecast.etaConfidence || train.confidence || "High";
    const etaConfidenceInfo = formatConfidenceText(etaConfidence);

    const telemetryFreshness = forecast.dataQuality?.telemetryFreshness || forecast.telemetryFreshness || train.telemetryFreshness || (forecast.freshness === "LIVE_FRESH" ? "FRESH" : "UNAVAILABLE");
    const telemetryAge = forecast.dataQuality?.telemetryAgeMinutes ?? forecast.telemetryAgeMinutes ?? train.telemetryAgeMinutes ?? null;
    const telemetryBadge = formatTelemetryBadge(telemetryFreshness, telemetryAge);

    const movementState = forecast.dataQuality?.movementState || forecast.movementState || train.movementState || "RUNNING";
    const stopType = forecast.dataQuality?.stopType || forecast.stopType || train.stopType || null;
    const movementBadge = formatMovementBadge(movementState, stopType);

    const gateModelMethod = forecast.gateModelMethod || "Baseline (11m prior)";
    const etaMethod = forecast.etaMethod || forecast.diagnosticMetadata?.etaCalculationMethod || "GPS Route Telemetry";
    const delayMinutes = forecast.delayMinutes != null
        ? forecast.delayMinutes
        : (train.delayMinutes != null ? train.delayMinutes : null);

    const rawDir = train.direction || forecast.direction;
    const isUncertain = train.directionUncertain || forecast.directionUncertain || rawDir === "unknown";
    const dirFormatted = isUncertain
        ? "⚠️ Direction uncertain"
        : (rawDir === "forward"
            ? "Direction: AMRITSAR → JANDIALA"
            : (rawDir === "backward" || rawDir === "reverse"
                ? "Direction: JANDIALA → AMRITSAR"
                : "⚠️ Direction uncertain"));

    // Non-destructive update: If user has observation form open, preserve form DOM & focus
    const activeForm = document.getElementById("observation-form");
    const activeCard = mainForecast.querySelector(".forecast-card");
    if (activeForm && !activeForm.hidden && activeCard && activeCard.dataset.crossingId === crossing.id) {
        const cdDigits = activeCard.querySelector(".countdown-digits");
        if (cdDigits) {
            cdDigits.textContent = countdown.display;
            cdDigits.className = `countdown-digits ${details.countdownAccent}`;
        }
        const cdLabel = activeCard.querySelector(".countdown-label");
        if (cdLabel) cdLabel.textContent = countdownTitle;
        const cdSub = activeCard.querySelector(".countdown-subtext");
        if (cdSub) cdSub.textContent = countdown.subtext;

        const metricVals = activeCard.querySelectorAll(".metric-box .metric-value");
        if (metricVals.length >= 4) {
            metricVals[0].textContent = passageTimeStr;
            metricVals[1].textContent = likelyClosureStr;
            metricVals[2].textContent = likelyReopenStr;
            metricVals[3].textContent = leadBufferStr;
        }
        return;
    }

    mainForecast.innerHTML = `
        <div class="forecast-card ${details.stateClass}" data-crossing-id="${escapeHtml(crossing.id || '')}">
            <div class="card-top-row">
                <div class="crossing-meta-group">
                    <span class="sub-kicker">SELECTED FATAK</span>
                    <h3>${escapeHtml(crossing.name || "Railway Crossing")}</h3>
                    <span class="crossing-coords-pill">Corridor ID: <code>${escapeHtml(crossing.id || "v1")}</code>${train.eventId ? ` • Event: <code>${escapeHtml(train.eventId)}</code>` : ""}</span>
                </div>
                <div class="status-pill-badge ${details.className}">
                    <span class="status-indicator-dot"></span>
                    <span>${details.label}</span>
                </div>
            </div>

            <!-- Decision Action Guidance -->
            <div class="action-guidance-banner ${details.actionClass}">
                <span class="action-icon">${details.actionIcon}</span>
                <span>${details.action}</span>
            </div>

            ${isContinuous ? `
            <!-- Multi-Train Continuous Closure Hero Banner -->
            <div class="continuous-closure-hero-alert">
                <span class="action-icon">⚠️</span>
                <div>
                    <strong>Continuous Gate Closure in Effect (${combined.trainCount} Trains Approaching)</strong>
                    <div class="continuous-closure-train-list">
                        ${(combined.trains || []).map(t => `#${escapeHtml(t.trainNumber || t.number || '')} (${escapeHtml(t.trainName || t.name || 'Train')})`).join(' • ')}
                    </div>
                </div>
            </div>
            ` : ''}

            <!-- Digital Countdown Readout -->
            <div class="countdown-hero-display">
                <span class="countdown-label">${countdownTitle}</span>
                <div class="countdown-digits ${details.countdownAccent}">${countdown.display}</div>
                <span class="countdown-subtext">${countdown.subtext}</span>
            </div>

            <!-- Approaching Train Banner -->
            <div class="train-details-banner">
                <div class="train-title-wrap">
                    <div class="train-icon-badge">🚆</div>
                    <div>
                        <div class="train-name-tag">
                            ${escapeHtml(train.trainName || train.name || "Approaching Train")}
                            <strong style="color:#38bdf8;">#${escapeHtml(train.trainNumber || train.number || "LIVE")}</strong>
                            ${delayMinutes != null ? (
                                delayMinutes > 0
                                    ? `<span class="train-delay-pill delayed">Delayed ~${Math.round(delayMinutes)}m</span>`
                                    : `<span class="train-delay-pill ontime">On Time</span>`
                            ) : ''}
                        </div>
                        <div class="train-direction-tag">${dirFormatted}</div>
                    </div>
                </div>
                <div class="confidence-badge-group">
                    <div class="confidence-chip ${telemetryBadge.class}" title="Telemetry Freshness">
                        ${telemetryBadge.icon} ${escapeHtml(telemetryBadge.text)}
                    </div>
                    <div class="confidence-chip ${movementBadge.class}" title="Movement State">
                        ${movementBadge.icon} ${escapeHtml(movementBadge.text)}
                    </div>
                    <div class="confidence-chip ${etaConfidenceInfo.class}" title="Train Arrival Confidence: ${etaConfidenceInfo.desc}">
                        ● ETA: ${etaConfidenceInfo.text}
                    </div>
                    <div class="confidence-chip gate-chip" title="Gate Closure Model">
                        ● Gate: ${escapeHtml(gateModelMethod)}
                    </div>
                </div>
            </div>

            <!-- Metric Timing Windows (Calculated with Central Passage Reference) -->
            <div class="forecast-metrics-grid">
                <div class="metric-box">
                    <span class="metric-label">Passage Time</span>
                    <span class="metric-value highlight">${passageTimeStr}</span>
                </div>
                <div class="metric-box">
                    <span class="metric-label">Likely Closure</span>
                    <span class="metric-value">${likelyClosureStr}</span>
                </div>
                <div class="metric-box">
                    <span class="metric-label">Likely Reopen</span>
                    <span class="metric-value">${likelyReopenStr}</span>
                </div>
                <div class="metric-box">
                    <span class="metric-label">Lead Buffer</span>
                    <span class="metric-value">${leadBufferStr}</span>
                </div>
            </div>

            ${forecast.diagnosticMetadata ? `
            <div class="telemetry-bar-row" style="display:flex; justify-content:space-between; align-items:center; font-size:0.75rem; color:#94a3b8; border-top:1px solid rgba(255,255,255,0.06); padding-top:8px; margin-top:10px;">
                <span>Speed: <strong style="color:#e2e8f0;">${forecast.diagnosticMetadata.speed != null && Number(forecast.diagnosticMetadata.speed) > 0 ? `${Number(forecast.diagnosticMetadata.speed).toFixed(1)} km/h` : 'Stationary (ASR)'}</strong></span>
                <span>Train Pos: <strong style="color:#e2e8f0;">${forecast.diagnosticMetadata.trainPosition != null ? `${Number(forecast.diagnosticMetadata.trainPosition).toFixed(1)} km` : '0.0 km (ASR)'}</strong></span>
                <span>Method: <code style="color:#38bdf8;">${escapeHtml(forecast.diagnosticMetadata.etaCalculationMethod || 'route-telemetry')}</code></span>
                <span>Telemetry: <span style="color:${(forecast.freshness === 'LIVE_FRESH' || forecast.diagnosticMetadata.dataFreshness === 'LIVE_FRESH') ? '#10b981' : '#f59e0b'};">● ${escapeHtml(forecast.freshness || forecast.diagnosticMetadata.dataFreshness || 'FRESH')}</span></span>
            </div>
            ` : ''}

            <!-- Why This Prediction Explainability Section -->
            <details class="why-prediction-details">
                <summary class="why-prediction-summary">
                    <span>ℹ️ Why this prediction?</span>
                </summary>
                <div class="why-prediction-body">
                    <div class="why-item">
                        <span class="why-label">Train Tracking:</span>
                        <span class="why-val">${escapeHtml(etaMethod)} • Speed: ${train.speed != null ? `${Number(train.speed).toFixed(1)} km/h` : 'Tracking speed'} • Approx ${train.distanceKm != null ? `${Number(train.distanceKm).toFixed(1)} km to crossing` : 'in corridor'}</span>
                    </div>
                    <div class="why-item">
                        <span class="why-label">Gate Model:</span>
                        <span class="why-val">${escapeHtml(gateModelMethod)} (Baseline prior: 11-min warning. Dynamic correction applied as ground truth is verified).</span>
                    </div>
                    <div class="why-item">
                        <span class="why-label">Punctuality:</span>
                        <span class="why-val">${delayMinutes != null && delayMinutes > 0 ? `Train running ~${Math.round(delayMinutes)} min behind schedule.` : 'Train running on schedule.'}</span>
                    </div>
                    ${isContinuous ? `
                    <div class="why-item warning">
                        <span class="why-label">Continuous Closure:</span>
                        <span class="why-val">${combined.trainCount} trains approaching with overlapping closure windows. Gates remain closed across train sequence to maintain corridor safety.</span>
                    </div>
                    ` : ''}
                </div>
            </details>

            <div class="observation-card">
                <div class="observation-title">REPORT ACTUAL FATAK TIMING</div>
                <div class="observation-subtitle">Your real timestamps help correct the crossing-specific model.</div>
                <div class="observation-actions">
                    <button type="button" class="observation-action" data-feedback="correct">Prediction looked correct</button>
                    <button type="button" class="observation-action secondary" data-feedback="incorrect">Prediction was wrong</button>
                </div>
                <div class="observation-form" id="observation-form" hidden>
                    <div class="observation-grid">
                        <label>Actual gate close<input id="actual-gate-close" type="datetime-local" required></label>
                        <label>Actual train passage<input id="actual-train-passage" type="datetime-local" required></label>
                        <label>Actual gate open <span>(optional)</span><input id="actual-gate-open" type="datetime-local"></label>
                    </div>
                    <textarea id="observation-notes" rows="2" placeholder="Optional observation note"></textarea>
                    <div class="observation-btn-row">
                        <button type="button" class="submit-observation" id="submit-observation">Submit observation</button>
                        <button type="button" class="cancel-observation" id="cancel-observation">Cancel</button>
                    </div>
                    <div class="observation-result" id="observation-result" aria-live="polite"></div>
                </div>
            </div>
        </div>
    `;

    renderUpcomingQueue(forecast);
    bindObservationForm(forecast);
}

function getObservationKey(forecast) {
    const crossingId =
        forecast?.crossing?.id || "unknown-crossing";

    const trainNumber =
        forecast?.primaryTrain?.trainNumber ||
        forecast?.primaryTrain?.number ||
        forecast?.train?.trainNumber ||
        forecast?.train?.number ||
        "unknown-train";

    const passage =
        forecast?.trainPassage?.estimatedTime ||
        forecast?.primaryTrain?.estimatedPassageTime ||
        forecast?.train?.estimatedPassageTime;

    const dateStr = passage
        ? new Date(passage).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);

    return `${crossingId}|${trainNumber}|${dateStr}`;
}

function captureObservationDraft(currentKey) {
    const form = document.getElementById("observation-form");

    if (
        !form ||
        !currentKey ||
        form.dataset.observationKey !== currentKey
    ) {
        return;
    }

    const close = document.getElementById("actual-gate-close");
    const passage = document.getElementById("actual-train-passage");
    const gateOpen = document.getElementById("actual-gate-open");
    const notes = document.getElementById("observation-notes");
    const result = document.getElementById("observation-result");

    observationDraft = {
        ...observationDraft,
        key: currentKey,
        open: !form.hidden,
        close: close?.value || "",
        passage: passage?.value || "",
        gateOpen: gateOpen?.value || "",
        notes: notes?.value || "",
        result: result?.textContent || ""
    };
}

function restoreObservationDraft(form, currentKey) {
    if (
        !form ||
        observationDraft.key !== currentKey ||
        !observationDraft.open
    ) {
        return;
    }

    form.hidden = false;

    const close = document.getElementById("actual-gate-close");
    const passage = document.getElementById("actual-train-passage");
    const gateOpen = document.getElementById("actual-gate-open");
    const notes = document.getElementById("observation-notes");
    const result = document.getElementById("observation-result");

    if (close) close.value = observationDraft.close;
    if (passage) passage.value = observationDraft.passage;
    if (gateOpen) gateOpen.value = observationDraft.gateOpen;
    if (notes) notes.value = observationDraft.notes;
    if (result) result.textContent = observationDraft.result;
}

function resetObservationDraft() {
    observationDraft = {
        key: null,
        open: false,
        feedback: null,
        close: "",
        passage: "",
        gateOpen: "",
        notes: "",
        result: "",
        editing: false
    };
}

function toDatetimeLocalString(dateInput) {
    if (!dateInput) return "";
    const d = new Date(dateInput);
    if (Number.isNaN(d.getTime())) return "";
    const pad = n => String(n).padStart(2, "0");
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function bindObservationForm(forecast) {
    const form = document.getElementById("observation-form");

    if (!form) return;

    const observationKey = getObservationKey(forecast);

    form.dataset.observationKey = observationKey;

    restoreObservationDraft(form, observationKey);

    // Cancel observation button
    document.getElementById("cancel-observation")?.addEventListener("click", () => {
        resetObservationDraft();
        form.hidden = true;
        const res = document.getElementById("observation-result");
        if (res) res.textContent = "";
    });

    form.parentElement
        .querySelectorAll("[data-feedback]")
        .forEach(button => {

            button.addEventListener("click", () => {

                observationDraft = {
                    ...observationDraft,
                    key: observationKey,
                    open: true,
                    editing: true,
                    feedback: button.dataset.feedback,
                    result:
                        "Enter the actual timestamps. The Correct/Wrong buttons capture your qualitative feedback, but only verified timestamps train the ML model."
                };

                form.hidden = false;

                const closeEl = document.getElementById("actual-gate-close");
                const passageEl = document.getElementById("actual-train-passage");
                const openEl = document.getElementById("actual-gate-open");
                const trainPassage = forecast?.trainPassage?.estimatedTime || forecast?.primaryTrain?.estimatedPassageTime || forecast?.train?.estimatedPassageTime;
                const passageMs = trainPassage ? parseTime(trainPassage) : null;

                if (passageEl && !passageEl.value && passageMs) {
                    passageEl.value = toDatetimeLocalString(passageMs);
                    observationDraft.passage = passageEl.value;
                }
                if (closeEl && !closeEl.value && passageMs) {
                    closeEl.value = toDatetimeLocalString(new Date(passageMs - 11 * 60000));
                    observationDraft.close = closeEl.value;
                }
                if (openEl && !openEl.value && passageMs) {
                    openEl.value = toDatetimeLocalString(new Date(passageMs + 1 * 60000));
                    observationDraft.gateOpen = openEl.value;
                }

                document.getElementById(
                    "observation-result"
                ).textContent = observationDraft.result;
            });
        });

    [
        ["actual-gate-close", "close"],
        ["actual-train-passage", "passage"],
        ["actual-gate-open", "gateOpen"],
        ["observation-notes", "notes"]
    ].forEach(([id, field]) => {

        document.getElementById(id)?.addEventListener(
            "input",
            event => {

                observationDraft = {
                    ...observationDraft,
                    key: observationKey,
                    open: true,
                    [field]: event.target.value
                };
            }
        );
    });

    document
        .getElementById("submit-observation")
        ?.addEventListener("click", async () => {

            const close =
                document.getElementById("actual-gate-close").value;

            const passage =
                document.getElementById("actual-train-passage").value;

            const open =
                document.getElementById("actual-gate-open").value;

            const result =
                document.getElementById("observation-result");

            if (!close || !passage) {

                result.textContent =
                    "Actual gate close and train passage are required.";

                observationDraft.result = result.textContent;

                return;
            }

            const submit =
                document.getElementById("submit-observation");

            submit.disabled = true;

            result.textContent = "Saving observation…";

            observationDraft.result = result.textContent;

            try {

                const response = await fetch(
                    `${API_BASE_URL}/api/observations`,
                    {
                        method: "POST",

                        headers: {
                            "Content-Type": "application/json"
                        },

                        body: JSON.stringify({

                            crossingId:
                                forecast.crossing?.id,

                            trainNumber:
                                forecast.primaryTrain?.trainNumber ||
                                forecast.primaryTrain?.number ||
                                forecast.train?.trainNumber ||
                                null,

                            direction:
                                forecast.primaryTrain?.direction ||
                                forecast.direction ||
                                null,

                            gateCloseTime:
                                new Date(close).toISOString(),

                            trainPassageTime:
                                new Date(passage).toISOString(),

                            gateOpenTime:
                                open
                                    ? new Date(open).toISOString()
                                    : null,

                            feedback:
                                observationDraft.feedback,

                            notes:
                                document
                                    .getElementById(
                                        "observation-notes"
                                    )
                                    .value
                                    .trim() || null
                        })
                    }
                );

                const data = await response.json();

                if (!response.ok || !data.success) {
                    throw new Error(
                        data.error || "Submission failed"
                    );
                }

                result.textContent =
                    `Saved. ${
                        data.dataset?.totalValidEvents ?? 0
                    } verified observations are now available to the predictor.`;

                observationDraft.result =
                    result.textContent;
                    observationDraft.editing=false;

                form
                    .querySelectorAll(
                        "input, textarea, button"
                    )
                    .forEach(el => {
                        el.disabled = true;
                    });

            } catch (error) {

                result.textContent = error.message;

                observationDraft.result =
                    result.textContent;

                submit.disabled = false;
            }
        });
}

/* =========================================================
   RENDER: LAST TRAIN PASSED (HISTORICAL MODULE & OBSERVATIONS)
========================================================= */

let passedObservationDraft = {
    key: null,
    open: false,
    feedback: null,
    close: "",
    passage: "",
    gateOpen: "",
    notes: "",
    result: "",
    editing: false
};

function getPassedObservationKey(forecast) {
    const crossingId = forecast?.crossing?.id || "unknown-crossing";
    const trainNumber = forecast?.lastTrainPassed?.trainNumber || "unknown-train";
    const passage = forecast?.lastTrainPassed?.passageTime || forecast?.lastTrainPassed?.passedAt;
    const dateStr = passage ? new Date(passage).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    return `passed|${crossingId}|${trainNumber}|${dateStr}`;
}

function capturePassedObservationDraft(currentKey) {
    const form = document.getElementById("observation-form-passed");
    if (!form || !currentKey || form.dataset.observationKey !== currentKey) {
        return;
    }

    const close = document.getElementById("actual-gate-close-passed");
    const passage = document.getElementById("actual-train-passage-passed");
    const gateOpen = document.getElementById("actual-gate-open-passed");
    const notes = document.getElementById("observation-notes-passed");
    const result = document.getElementById("observation-result-passed");

    passedObservationDraft = {
        ...passedObservationDraft,
        key: currentKey,
        open: !form.hidden,
        close: close?.value || "",
        passage: passage?.value || "",
        gateOpen: gateOpen?.value || "",
        notes: notes?.value || "",
        result: result?.textContent || ""
    };
}

function restorePassedObservationDraft(form, currentKey) {
    if (!form || passedObservationDraft.key !== currentKey || !passedObservationDraft.open) {
        return;
    }

    form.hidden = false;

    const close = document.getElementById("actual-gate-close-passed");
    const passage = document.getElementById("actual-train-passage-passed");
    const gateOpen = document.getElementById("actual-gate-open-passed");
    const notes = document.getElementById("observation-notes-passed");
    const result = document.getElementById("observation-result-passed");

    if (close) close.value = passedObservationDraft.close;
    if (passage) passage.value = passedObservationDraft.passage;
    if (gateOpen) gateOpen.value = passedObservationDraft.gateOpen;
    if (notes) notes.value = passedObservationDraft.notes;
    if (result) result.textContent = passedObservationDraft.result;
}

function resetPassedObservationDraft() {
    passedObservationDraft = {
        key: null,
        open: false,
        feedback: null,
        close: "",
        passage: "",
        gateOpen: "",
        notes: "",
        result: "",
        editing: false
    };
}

function bindPassedTrainObservationForm(forecast) {
    const form = document.getElementById("observation-form-passed");
    if (!form) return;

    const observationKey = getPassedObservationKey(forecast);
    form.dataset.observationKey = observationKey;

    restorePassedObservationDraft(form, observationKey);

    const cancelBtn = document.getElementById("cancel-observation-passed");
    if (cancelBtn) {
        cancelBtn.addEventListener("click", () => {
            resetPassedObservationDraft();
            form.hidden = true;
            const res = document.getElementById("observation-result-passed");
            if (res) res.textContent = "";
        });
    }

    const lastTrain = forecast?.lastTrainPassed;
    const passageMs = parseTime(lastTrain?.passageTime || lastTrain?.passedAt);

    form.parentElement?.querySelectorAll("[data-obs-target='passed']").forEach(button => {
        button.addEventListener("click", () => {
            const feedbackVal = button.dataset.feedback;
            passedObservationDraft = {
                ...passedObservationDraft,
                key: observationKey,
                open: true,
                editing: true,
                feedback: feedbackVal,
                result: "Enter actual timestamps. The Correct/Wrong buttons capture your qualitative feedback, but only verified timestamps train the ML model."
            };

            form.hidden = false;

            const closeEl = document.getElementById("actual-gate-close-passed");
            const passageEl = document.getElementById("actual-train-passage-passed");
            const openEl = document.getElementById("actual-gate-open-passed");

            if (passageEl && !passageEl.value && passageMs) {
                passageEl.value = toDatetimeLocalString(passageMs);
                passedObservationDraft.passage = passageEl.value;
            }
            if (closeEl && !closeEl.value && passageMs) {
                closeEl.value = toDatetimeLocalString(lastTrain.likelyClosure || new Date(passageMs - 11 * 60000));
                passedObservationDraft.close = closeEl.value;
            }
            if (openEl && !openEl.value && passageMs) {
                openEl.value = toDatetimeLocalString(lastTrain.likelyReopen || new Date(passageMs + 1 * 60000));
                passedObservationDraft.gateOpen = openEl.value;
            }

            const res = document.getElementById("observation-result-passed");
            if (res) res.textContent = passedObservationDraft.result;
        });
    });

    [
        ["actual-gate-close-passed", "close"],
        ["actual-train-passage-passed", "passage"],
        ["actual-gate-open-passed", "gateOpen"],
        ["observation-notes-passed", "notes"]
    ].forEach(([id, field]) => {
        document.getElementById(id)?.addEventListener("input", event => {
            passedObservationDraft = {
                ...passedObservationDraft,
                key: observationKey,
                open: true,
                [field]: event.target.value
            };
        });
    });

    const submitBtn = document.getElementById("submit-observation-passed");
    if (submitBtn) {
        submitBtn.addEventListener("click", async () => {
            const close = document.getElementById("actual-gate-close-passed")?.value;
            const passage = document.getElementById("actual-train-passage-passed")?.value;
            const open = document.getElementById("actual-gate-open-passed")?.value;
            const notes = document.getElementById("observation-notes-passed")?.value;
            const result = document.getElementById("observation-result-passed");

            if (!close || !passage) {
                if (result) result.textContent = "Actual gate close and train passage are required.";
                passedObservationDraft.result = result?.textContent || "";
                return;
            }

            submitBtn.disabled = true;
            if (result) result.textContent = "Saving observation…";
            passedObservationDraft.result = result?.textContent || "";

            try {
                const response = await fetch(`${API_BASE_URL}/api/observations`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        crossingId: forecast.crossing?.id,
                        trainNumber: lastTrain?.trainNumber || null,
                        direction: lastTrain?.direction || null,
                        gateCloseTime: new Date(close).toISOString(),
                        trainPassageTime: new Date(passage).toISOString(),
                        gateOpenTime: open ? new Date(open).toISOString() : null,
                        feedback: passedObservationDraft.feedback,
                        notes: notes ? notes.trim() : null
                    })
                });

                const data = await response.json();
                if (!response.ok || !data.success) {
                    throw new Error(data.error || "Submission failed");
                }

                if (result) {
                    result.textContent = `Saved. ${data.dataset?.totalValidEvents ?? 0} verified observations are now available to the predictor.`;
                    passedObservationDraft.result = result.textContent;
                }
                passedObservationDraft.editing = false;

                form.querySelectorAll("input, textarea, button").forEach(el => {
                    el.disabled = true;
                });
            } catch (error) {
                if (result) {
                    result.textContent = error.message;
                    passedObservationDraft.result = result.textContent;
                }
                submitBtn.disabled = false;
            }
        });
    }
}

function renderLastTrainPassed(forecast) {
    if (!lastTrainPassedContainer) return;

    const lastTrain = forecast?.lastTrainPassed;
    const passageMs = parseTime(lastTrain?.passageTime || lastTrain?.passedAt);
    const now = Date.now();
    const elapsedMinutes = passageMs ? Math.floor((now - passageMs) / 60000) : null;

    capturePassedObservationDraft(getPassedObservationKey(forecast));

    // Strict 60-minute limit and valid session check:
    // If no last train, or passage > 60m ago, or from yesterday (elapsed > 60m), suppress it
    if (!lastTrain || !passageMs || elapsedMinutes == null || elapsedMinutes > 60 || elapsedMinutes < 0) {
        lastTrainPassedContainer.innerHTML = `
            <div class="last-train-card">
                <div class="last-train-header">
                    <div class="last-train-title-group">
                        <span style="font-size: 1.1rem;">🏁</span>
                        <strong style="color: #e2e8f0; font-size: 0.8rem; letter-spacing: 0.05em;">LAST TRAIN PASSED</strong>
                        <span class="last-train-badge">HISTORICAL</span>
                    </div>
                    <span>Corridor Record</span>
                </div>
                <div class="last-train-empty">No recent train passage recorded for this crossing.</div>
            </div>
        `;
        return;
    }

    const elapsedBadgeText = elapsedMinutes === 0 ? "Passed just now" : `Passed ${elapsedMinutes}m ago`;
    const passageStr = formatClockTime(passageMs);
    const closureStr = formatClockTime(lastTrain.likelyClosure);
    const reopenStr = formatClockTime(lastTrain.likelyReopen);
    const lastDir = lastTrain.direction;
    const isLastUncertain = lastTrain.directionUncertain || lastDir === "unknown";
    const dirStr = isLastUncertain
        ? "⚠️ Direction uncertain"
        : (lastDir === "backward" || lastDir === "reverse"
            ? "Direction: JANDIALA → AMRITSAR"
            : (lastDir === "forward"
                ? "Direction: AMRITSAR → JANDIALA"
                : "⚠️ Direction uncertain"));

    lastTrainPassedContainer.innerHTML = `
        <div class="last-train-card">
            <div class="last-train-header">
                <div class="last-train-title-group">
                    <span style="font-size: 1.1rem;">🏁</span>
                    <strong style="color: #e2e8f0; font-size: 0.8rem; letter-spacing: 0.05em;">LAST TRAIN PASSED</strong>
                    <span class="last-train-badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3);">${escapeHtml(elapsedBadgeText)}</span>
                </div>
                <span style="font-size: 0.76rem; color: #94a3b8; font-family: var(--font-mono);">${dirStr}</span>
            </div>
            <div class="last-train-details">
                <div class="last-train-name">
                    ${escapeHtml(lastTrain.trainName || "Express Train")} 
                    <strong style="color: #38bdf8;">#${escapeHtml(lastTrain.trainNumber || "")}</strong>
                </div>
            </div>
            <div class="last-train-times-grid">
                <div class="last-train-time-item">
                    <span class="last-train-time-label">Passed At</span>
                    <span class="last-train-time-val">${passageStr}</span>
                </div>
                <div class="last-train-time-item">
                    <span class="last-train-time-label">Likely Closure</span>
                    <span class="last-train-time-val">${closureStr}</span>
                </div>
                <div class="last-train-time-item">
                    <span class="last-train-time-label">Likely Reopen</span>
                    <span class="last-train-time-val">${reopenStr}</span>
                </div>
            </div>

            <!-- Ground Truth Observation for Completed Train -->
            <div class="observation-card last-train-obs-card" id="last-train-obs-section">
                <div class="observation-title">REPORT ACTUAL FATAK TIMING FOR PASSED TRAIN</div>
                <div class="observation-subtitle">Help improve model accuracy. Enter verified timestamps for this completed train passage. Only verified observations become ML training data.</div>
                <div class="observation-actions">
                    <button type="button" class="observation-action" data-feedback="correct" data-obs-target="passed">Prediction looked correct</button>
                    <button type="button" class="observation-action secondary" data-feedback="incorrect" data-obs-target="passed">Prediction was wrong</button>
                </div>
                <div class="observation-form" id="observation-form-passed" hidden>
                    <div class="observation-grid">
                        <label>Actual gate close<input id="actual-gate-close-passed" type="datetime-local" required></label>
                        <label>Actual train passage<input id="actual-train-passage-passed" type="datetime-local" required></label>
                        <label>Actual gate open <span>(optional)</span><input id="actual-gate-open-passed" type="datetime-local"></label>
                    </div>
                    <textarea id="observation-notes-passed" rows="2" placeholder="Optional observation note"></textarea>
                    <div class="observation-btn-row">
                        <button type="button" class="submit-observation" id="submit-observation-passed">Submit observation</button>
                        <button type="button" class="cancel-observation" id="cancel-observation-passed">Cancel</button>
                    </div>
                    <div class="observation-result" id="observation-result-passed" aria-live="polite"></div>
                </div>
            </div>
        </div>
    `;

    bindPassedTrainObservationForm(forecast);
}

/* =========================================================
   RENDER: EXTENDED 2-HOUR OUTLOOK (60–120 MIN)
========================================================= */

function renderExtendedOutlook(forecast) {
    if (!extendedOutlookContainer) return;

    if (!forecast) {
        extendedOutlookContainer.innerHTML = "";
        return;
    }

    const isUnavailable = forecast.status === "LIVE_DATA_UNAVAILABLE" || 
                          forecast.status === "PREDICTION_UNAVAILABLE" || 
                          forecast.freshness === "UNAVAILABLE" || 
                          dataSource === "NONE";

    if (isUnavailable) {
        extendedOutlookContainer.innerHTML = `
            <div class="extended-outlook-container">
                <div class="extended-outlook-header">
                    <div class="extended-outlook-title-group">
                        <span class="extended-kicker">EXTENDED 2-HOUR OUTLOOK</span>
                        <h3 class="extended-outlook-title">Extended Crossing Outlook</h3>
                        <span class="extended-outlook-subtitle">60–120 minute horizon</span>
                    </div>
                    <span class="extended-badge" style="border-color: rgba(245, 158, 11, 0.3); color: #fbbf24; background: rgba(245, 158, 11, 0.1);">UNAVAILABLE</span>
                </div>
                <div class="extended-empty-card">
                    <span class="extended-empty-icon">⚠️</span>
                    <div class="extended-empty-text">Extended outlook is unavailable while railway live telemetry is offline.</div>
                </div>
            </div>
        `;
        return;
    }

    const items = Array.isArray(forecast.extendedOutlook) ? forecast.extendedOutlook : [];

    if (items.length === 0) {
        extendedOutlookContainer.innerHTML = `
            <div class="extended-outlook-container">
                <div class="extended-outlook-header">
                    <div class="extended-outlook-title-group">
                        <span class="extended-kicker">EXTENDED 2-HOUR OUTLOOK</span>
                        <h3 class="extended-outlook-title">Extended Crossing Outlook</h3>
                        <span class="extended-outlook-subtitle">60–120 minute horizon</span>
                    </div>
                    <span class="extended-badge">HORIZON: 60–120 MIN</span>
                </div>
                <div class="extended-empty-card">
                    <span class="extended-empty-icon">✓</span>
                    <div class="extended-empty-text">No additional crossing events are currently predicted between 60 and 120 minutes.</div>
                </div>
            </div>
        `;
        return;
    }

    const cardsHtml = items.map(item => {
        const trainNum = item.trainNumber || "Unknown";
        const trainName = item.trainName || "Express Train";
        const etaMin = item.etaMinutes != null ? Math.round(item.etaMinutes) : "--";
        const passageClock = formatClockTime(item.estimatedPassageTime);
        const closeClock = formatClockTime(item.predictedGateCloseTime);
        const openClock = formatClockTime(item.predictedGateOpenTime);
        const isReverse = item.direction === "reverse" || item.direction === "backward";
        const dirLabel = isReverse ? "JANDIALA → AMRITSAR (DN)" : "AMRITSAR → JANDIALA (UP)";
        const crossingTitle = item.crossingName || forecast.crossing?.name || "Railway Crossing";
        const confidenceText = item.confidence || (item.telemetryFreshness === "STALE" ? "DEGRADED" : "SCHEDULE_ESTIMATE");

        return `
            <div class="extended-event-card">
                <div class="extended-event-top">
                    <div class="extended-train-info">
                        <div class="extended-train-name-row">
                            <span class="extended-train-number">#${escapeHtml(trainNum)}</span>
                            <span class="extended-train-name">${escapeHtml(trainName)}</span>
                            <span class="extended-confidence-pill">${escapeHtml(confidenceText)}</span>
                        </div>
                        <div class="extended-direction-pill">
                            <span>🧭</span>
                            <span>${escapeHtml(dirLabel)}</span>
                            <span style="margin: 0 4px;">•</span>
                            <span style="color: #cbd5e1;">Next: <strong>${escapeHtml(crossingTitle)}</strong></span>
                        </div>
                    </div>
                    <div class="extended-eta-box">
                        <div class="extended-eta-val">~${etaMin} min</div>
                        <div class="extended-eta-sub">Passage at ${passageClock}</div>
                    </div>
                </div>
                <div class="extended-timings-grid">
                    <div class="extended-timing-item">
                        <span class="extended-timing-label">Predicted Close (-11m)</span>
                        <span class="extended-timing-value close-time">${closeClock}</span>
                    </div>
                    <div class="extended-timing-item">
                        <span class="extended-timing-label">Expected Passage</span>
                        <span class="extended-timing-value">${passageClock}</span>
                    </div>
                    <div class="extended-timing-item">
                        <span class="extended-timing-label">Predicted Open (+1m)</span>
                        <span class="extended-timing-value open-time">${openClock}</span>
                    </div>
                    <div class="extended-timing-item">
                        <span class="extended-timing-label">Status</span>
                        <span class="extended-timing-value" style="color: #38bdf8;">EXTENDED OUTLOOK</span>
                    </div>
                </div>
            </div>
        `;
    }).join("");

    extendedOutlookContainer.innerHTML = `
        <div class="extended-outlook-container">
            <div class="extended-outlook-header">
                <div class="extended-outlook-title-group">
                    <span class="extended-kicker">EXTENDED 2-HOUR OUTLOOK</span>
                    <h3 class="extended-outlook-title">Extended Crossing Outlook</h3>
                    <span class="extended-outlook-subtitle">60–120 minute horizon • ${items.length} upcoming train${items.length > 1 ? "s" : ""}</span>
                </div>
                <span class="extended-badge">${items.length} PREDICTED</span>
            </div>
            <div class="extended-grid">
                ${cardsHtml}
            </div>
        </div>
    `;
}

/* =========================================================
   RENDER: SUBSEQUENT TRAINS (60 MIN) QUEUE
========================================================= */

function renderUpcomingQueue(forecast) {
    if (!upcomingQueueContainer || !upcomingQueueGrid) return;

    const rawUpcoming = forecast.subsequentTrains || forecast.upcomingTrains || [];
    const now = Date.now();

    // Strictly filter to upcoming trains within 60 minutes that have not passed
    const upcoming = rawUpcoming.filter(ut => {
        const pt = parseTime(ut.estimatedPassageTime);
        if (!pt) return false;
        const diff = (pt - now) / 60000;
        return diff > 0 && diff <= 60;
    }).sort((a, b) => parseTime(a.estimatedPassageTime) - parseTime(b.estimatedPassageTime));

    const overlap = forecast.combinedClosure || forecast.overlappingClosure;
    const hasValidOverlap = overlap && (overlap.isContinuous || overlap.isOverlapping || overlap.trainCount > 1);

    // If no subsequent trains and no multi-train continuous closure
    if (upcoming.length === 0) {
        if (!hasValidOverlap) {
            upcomingQueueContainer.style.display = "block";
            upcomingQueueGrid.innerHTML = `
                <div class="subsequent-empty-card">
                    <div class="subsequent-empty-icon">✓</div>
                    <div class="subsequent-empty-content">
                        <strong>No additional trains scheduled within the next 60 minutes</strong>
                        <p>Only the current approaching train is on the corridor in the current 1-hour horizon.</p>
                    </div>
                </div>
            `;
            return;
        }
    }

    upcomingQueueContainer.style.display = "block";
    upcomingQueueGrid.innerHTML = "";

    // If continuous/overlapping closure detected between multiple trains
    if (hasValidOverlap) {
        const duration = Math.round(overlap.durationMinutes || overlap.combinedDurationMinutes || 10);
        const trainNums = (overlap.trains || []).map(t => `#${t.trainNumber || t.number}`).join(" and ");
        const overlapDiv = document.createElement("div");
        overlapDiv.className = "continuous-closure-banner";
        overlapDiv.innerHTML = `
            <span style="font-size: 1.3rem;">⚠️</span>
            <div>
                <strong>Continuous Gate Closure Anticipated (~${duration} min)</strong><br>
                <span>Trains ${trainNums} pass in close succession. Gate will remain closed between them.</span>
            </div>
        `;
        upcomingQueueGrid.appendChild(overlapDiv);
    }

    upcoming.forEach(ut => {
        const passageMs = parseTime(ut.estimatedPassageTime);
        const passageStr = formatClockTime(passageMs);

        // Approximate Gate Closes: effective or standard (Tp - 11m)
        const closeMs = parseTime(ut.effectiveGateCloseTime || ut.predictedGateCloseTime) || (passageMs - 11 * 60000);
        const closeStr = formatClockTime(closeMs);

        // Approximate Gate Reopens: effective or standard (Tp + 1m)
        const openMs = parseTime(ut.effectiveGateOpenTime || ut.predictedGateOpenTime) || (passageMs + 1 * 60000);
        const openStr = formatClockTime(openMs);

        const diffMinutes = Math.max(0, (passageMs - now) / 60000);
        const etaDisplay = `in ~${Math.round(diffMinutes)} min`;

        const rawDir = ut.direction;
        const isUncertain = ut.directionUncertain || rawDir === "unknown";
        const dirStr = isUncertain
            ? "⚠️ Direction uncertain"
            : (rawDir === "forward"
                ? "Direction: AMRITSAR → JANDIALA"
                : (rawDir === "backward" || rawDir === "reverse"
                    ? "Direction: JANDIALA → AMRITSAR"
                    : "⚠️ Direction uncertain"));

        const isContinuous = Boolean(ut.isContinuousClosure || (hasValidOverlap && ut.continuousTrainNumbers?.length > 1));

        const card = document.createElement("div");
        card.className = "subsequent-train-card";
        card.innerHTML = `
            <div class="subsequent-card-top">
                <div class="subsequent-train-ident">
                    <div class="subsequent-train-icon">🚆</div>
                    <div class="subsequent-train-title">
                        <div class="subsequent-train-name">
                            ${escapeHtml(ut.trainName || "Express Train")} 
                            <strong style="color: #38bdf8;">#${escapeHtml(ut.trainNumber || "")}</strong>
                        </div>
                        <div class="subsequent-train-meta">
                            <span class="subsequent-direction-chip">${dirStr}</span>
                        </div>
                    </div>
                </div>
                <div class="subsequent-eta-pill">${etaDisplay}</div>
            </div>

            ${isContinuous ? `
            <div class="subsequent-continuous-pill">
                <span>⚠️</span> Continuous Closure Anticipated
            </div>
            ` : ''}

            <div class="subsequent-times-grid">
                <div class="subsequent-time-box">
                    <span class="subsequent-time-label">Gate Closes (Approx)</span>
                    <span class="subsequent-time-val closure-time">${closeStr}</span>
                    <span class="subsequent-time-sub">${isContinuous ? 'Continuous start' : '~11 min before'}</span>
                </div>
                <div class="subsequent-time-box highlight">
                    <span class="subsequent-time-label">Train Passage</span>
                    <span class="subsequent-time-val passage-time">${passageStr}</span>
                    <span class="subsequent-time-sub">Crossing passage</span>
                </div>
                <div class="subsequent-time-box">
                    <span class="subsequent-time-label">Gate Reopens (Approx)</span>
                    <span class="subsequent-time-val reopen-time">${openStr}</span>
                    <span class="subsequent-time-sub">${isContinuous ? 'Continuous reopen' : '~1 min after'}</span>
                </div>
            </div>
        `;
        upcomingQueueGrid.appendChild(card);
    });
}

/* =========================================================
   RENDER: CORRIDOR OVERVIEW GRID (ALL 4 CROSSINGS)
========================================================= */

function renderAllCrossings() {
    if (!crossingsGrid) return;
    crossingsGrid.innerHTML = "";

    forecasts.forEach(f => {
        const crossing = f.crossing || {};
        const isSelected = crossing.id === selectedCrossingId;
        const status = getLiveStatus(f);
        const details = getStatusDetails(status, f.predictionAvailable);
        const passage = f.trainPassage || {};
        const tr = f.primaryTrain || f.train || {};

        const card = document.createElement("div");
        card.className = `crossing-summary-card ${isSelected ? "active" : ""}`;
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");

        const isUnavailable = status === "LIVE_DATA_UNAVAILABLE" || status === "PREDICTION_UNAVAILABLE" || status === "DATA UNAVAILABLE" || dataSource === "NONE" || f.freshness === "UNAVAILABLE";
        const etaText = isUnavailable ? "--:--" : (passage.estimatedTime ? formatClockTime(passage.estimatedTime) : "Clear");
        const trainBadge = isUnavailable ? "Unavailable" : ((tr.trainNumber || tr.number) ? `#${tr.trainNumber || tr.number}` : "No train");

        card.innerHTML = `
            <div class="card-upper">
                <span class="card-crossing-title">${escapeHtml(crossing.name)}</span>
                <span class="tab-status-chip ${details.className}">${details.chipText}</span>
            </div>
            <div class="card-lower">
                <span>${escapeHtml(trainBadge)}</span>
                <span class="card-passage-eta">${etaText}</span>
            </div>
        `;

        const selectCrossing = () => {
            selectedCrossingId = crossing.id;
            renderCrossingSelector();
            renderMainForecast();
            renderAllCrossings();
            updateTrackVisualizer();
            window.scrollTo({ top: 0, behavior: "smooth" });
        };

        card.addEventListener("click", selectCrossing);
        card.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                selectCrossing();
            }
        });

        crossingsGrid.appendChild(card);
    });
}

/* =========================================================
   TRACK SCHEMATICS & TRAIN POSITION
   (Driven entirely by existing forecast event data)
========================================================= */

function buildTrackNodes() {
    // Initial placeholder setup; reactive rendering is handled in updateTrackVisualizer
    updateTrackVisualizer();
}

function updateTrackVisualizer() {
    const visualizerEl = document.getElementById("track-visualizer");
    if (!visualizerEl) return;

    const now = Date.now();

    // 1. Identify primary active train movement across the corridor
    let activeDirection = "forward";
    let activeTrain = null;
    let mostImminentCrossingId = null;
    let minPassageDiff = Infinity;

    // Check selected forecast first
    const selectedF = forecasts.find(f => f.crossing?.id === selectedCrossingId);
    if (selectedF?.primaryTrain?.direction) {
        activeDirection = selectedF.primaryTrain.direction;
        activeTrain = selectedF.primaryTrain;
    }

    // Search across all crossings for the nearest upcoming train passage
    for (const f of forecasts) {
        const tr = f.primaryTrain || f.train;
        const pt = parseTime(f.trainPassage?.estimatedTime || tr?.estimatedPassageTime);
        if (pt && (pt - now) > -1 * 60000) {
            const diff = pt - now;
            if (diff < minPassageDiff) {
                minPassageDiff = diff;
                mostImminentCrossingId = f.crossing?.id;
                if (!activeTrain && tr) {
                    activeTrain = tr;
                    activeDirection = tr.direction || activeDirection;
                }
            }
        }
    }

    const isTrainApproaching = Boolean(activeTrain && minPassageDiff <= 60 * 60000);

    // 2. Define Corridor Node Sequences
    // Forward (West to East): MOW → Talwandi → Manawala → Rakh Devi → JNL
    // Backward (East to West): JNL → Rakh Devi → Manawala → Talwandi → MOW
    const forwardChain = [
        { type: "station", code: "MOW", name: "Mananwala" },
        { type: "crossing", id: "talwandi-dogran", name: "Talwandi", fullName: "Talwandi Dogran" },
        { type: "crossing", id: "manawala-road", name: "Manawala", fullName: "Manawala Road" },
        { type: "crossing", id: "rakh-devi-dasspura", name: "Rakh Devi", fullName: "Rakh Devi Dasspura" },
        { type: "crossing", id: "jandiala", name: "Jandiala", fullName: "Jandiala Crossing" },
        { type: "station", code: "JNL", name: "Jandiala" }
    ];

    const backwardChain = [
        { type: "station", code: "JNL", name: "Jandiala" },
        { type: "crossing", id: "jandiala", name: "Jandiala", fullName: "Jandiala Crossing" },
        { type: "crossing", id: "rakh-devi-dasspura", name: "Rakh Devi", fullName: "Rakh Devi Dasspura" },
        { type: "crossing", id: "manawala-road", name: "Manawala", fullName: "Manawala Road" },
        { type: "crossing", id: "talwandi-dogran", name: "Talwandi", fullName: "Talwandi Dogran" },
        { type: "station", code: "MOW", name: "Mananwala" }
    ];

    const isReverse = activeDirection === "backward" || activeDirection === "reverse";
    const chain = isReverse ? backwardChain : forwardChain;
    const arrowSymbol = isTrainApproaching ? "➔" : "⇄";

    const directionLabelText = isTrainApproaching
        ? (isReverse
            ? "JNL → Rakh Devi → Manawala → Talwandi → MOW"
            : "MOW → Talwandi → Manawala → Rakh Devi → JNL")
        : "MOW ⇄ Talwandi ⇄ Manawala ⇄ Rakh Devi ⇄ JNL";

    const isUnavailable = dataSource === "NONE" || forecasts.length === 0 || forecasts.every(f => f.freshness === "UNAVAILABLE" || f.status === "LIVE_DATA_UNAVAILABLE");
    const trainStatusText = isUnavailable
        ? "Live telemetry unavailable — track movements unverified"
        : (isTrainApproaching
            ? `Train #${activeTrain.trainNumber || activeTrain.number || ""} approaching ${escapeHtml(chain.find(c => c.id === mostImminentCrossingId)?.name || "Crossing")}`
            : "Corridor clear — no train expected");

    // 3. Render Schematic Nodes
    let chainHtml = "";
    chain.forEach((item, idx) => {
        if (item.type === "station") {
            chainHtml += `
                <div class="schematic-station-card">
                    <div class="station-code-badge">🚉 ${escapeHtml(item.code)}</div>
                    <span class="station-subname">${escapeHtml(item.name)}</span>
                </div>
            `;
        } else if (item.type === "crossing") {
            const f = forecasts.find(entry => entry.crossing?.id === item.id);
            const status = f ? getLiveStatus(f) : "OPEN";
            const details = getStatusDetails(status, f?.predictionAvailable);
            const isSelected = item.id === selectedCrossingId;
            const isTarget = item.id === mostImminentCrossingId && isTrainApproaching;

            chainHtml += `
                <button type="button" class="schematic-crossing-card ${isSelected ? "selected" : ""} ${isTarget ? "train-target" : ""}" data-crossing-id="${item.id}">
                    <div class="card-header-row">
                        <span class="crossing-icon">🚧</span>
                        ${isSelected ? `<span class="selected-pill">SELECTED</span>` : ""}
                    </div>
                    <div class="crossing-schematic-name">${escapeHtml(item.name)}</div>
                    <span class="schematic-status-chip ${details.className}">${details.chipText}</span>
                </button>
            `;
        }

        if (idx < chain.length - 1) {
            chainHtml += `<div class="schematic-arrow-segment"><span class="arrow-glyph">${arrowSymbol}</span></div>`;
        }
    });

    let trainBannerHtml = "";
    if (isTrainApproaching) {
        const trainNum = activeTrain.trainNumber || activeTrain.number || "";
        const trainName = activeTrain.trainName || activeTrain.name || "Express";
        const isUncertain = activeTrain.directionUncertain || activeDirection === "unknown";
        const dirDesc = isUncertain
            ? "⚠️ Direction uncertain"
            : (isReverse ? "JANDIALA → AMRITSAR" : "AMRITSAR → JANDIALA");
        trainBannerHtml = `
            <div class="schematic-active-train-banner">
                <span class="train-lead-icon">🚆</span>
                <span class="train-banner-text">
                    <strong>Train #${escapeHtml(trainNum)} ${escapeHtml(trainName)}</strong> &bull; Direction: <code>${dirDesc}</code>
                </span>
                <span class="train-banner-tag">● LIVE POSITION</span>
            </div>
        `;
    }

    visualizerEl.innerHTML = `
        <div class="track-header-info">
            <div class="track-schematic-title-row">
                <span class="track-direction-label" id="track-direction-text">${directionLabelText}</span>
                <span class="track-distance-label" id="track-distance-text">${trainStatusText}</span>
            </div>
            ${trainBannerHtml}
        </div>
        <div class="schematic-flow-container">
            ${chainHtml}
        </div>
        <div class="track-legend">
            <span class="legend-item"><span class="legend-dot active-dot"></span> Selected Fatak</span>
            <span class="legend-item"><span class="legend-dot open-dot"></span> OPEN</span>
            <span class="legend-item"><span class="legend-dot closing-dot"></span> TRAIN APPROACHING</span>
            <span class="legend-item"><span class="legend-dot closed-dot"></span> FATAK CLOSED</span>
        </div>
    `;

    // Attach click listeners to select crossings
    visualizerEl.querySelectorAll(".schematic-crossing-card").forEach(btn => {
        btn.addEventListener("click", () => {
            const cid = btn.getAttribute("data-crossing-id");
            if (cid) {
                selectedCrossingId = cid;
                renderCrossingSelector();
                renderMainForecast();
                renderAllCrossings();
                updateTrackVisualizer();
            }
        });
    });
}

/* =========================================================
   TELEMETRY AGE & SYSTEM STATUS
========================================================= */

function setSystemStatus(text, mode = "live") {
    if (systemStatusText) systemStatusText.textContent = text;
    if (systemStatus) {
        systemStatus.classList.remove("stale", "error");
        if (mode === "stale") systemStatus.classList.add("stale");
        if (mode === "error") systemStatus.classList.add("error");
    }
}

function updateTelemetryAge() {
    if (!updatedTime) return;

    if (dataSource === "NONE" || !lastFetchTimestamp) {
        updatedTime.textContent = "Live telemetry unavailable";
        setSystemStatus("DATA UNAVAILABLE", "error");
        return;
    }

    const elapsedSec = Math.floor((Date.now() - lastFetchTimestamp) / 1000);

    if (dataSource === "CACHE") {
        if (elapsedSec > 300) {
            // Cache older than 5 minutes: discard
            dataSource = "NONE";
            forecasts = [];
            try { localStorage.removeItem("fatakforecast_cached_snapshot"); } catch (e) {}
            setSystemStatus("DATA UNAVAILABLE", "error");
            renderMainForecast();
            renderCrossingSelector();
            renderAllCrossings();
            updateTrackVisualizer();
            return;
        }
        const mins = Math.max(1, Math.floor(elapsedSec / 60));
        updatedTime.textContent = `Cached snapshot (${mins}m ago)`;
        setSystemStatus("CACHED SNAPSHOT", "stale");
        return;
    }

    if (elapsedSec < 5) {
        updatedTime.textContent = "Just updated";
        setSystemStatus("LIVE RAIL DATA", "live");
    } else if (elapsedSec < 60) {
        updatedTime.textContent = `Updated ${elapsedSec}s ago`;
        setSystemStatus("LIVE RAIL DATA", "live");
    } else {
        const mins = Math.floor(elapsedSec / 60);
        updatedTime.textContent = `Updated ${mins}m ago`;
        if (mins >= 5) {
            setSystemStatus("STALE TELEMETRY", "stale");
        } else {
            setSystemStatus("LIVE RAIL DATA", "live");
        }
    }
}

/* =========================================================
   ERROR & TOAST UTILITIES
========================================================= */

function renderErrorState() {
    if (mainForecast) {
        mainForecast.innerHTML = `
            <div class="forecast-card state-unknown">
                <div class="empty-forecast-hero">
                    <div class="empty-icon-wrap" style="color: #ef4444;" aria-hidden="true">⚠️</div>
                    <div class="empty-headline">Forecast Service Unavailable</div>
                    <p class="empty-description">
                        Could not reach the FatakForecast backend service. Make sure <code>server.js</code> is running on port 3000.
                    </p>
                    <button class="action-guidance-banner neutral" style="margin: 20px auto 0; cursor: pointer;" onclick="fetchForecast(true)">
                        <span>↻ Tap here to retry</span>
                    </button>
                </div>
            </div>
        `;
    }
}

function showToastPopup(msg) {
    if (!toast || !toastMessage) return;
    toastMessage.textContent = msg;
    toast.classList.add("visible");
    setTimeout(() => toast.classList.remove("visible"), 2500);
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
