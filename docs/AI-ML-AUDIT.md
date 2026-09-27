# FatakForecast V5 — Comprehensive AI/ML & System Architecture Audit

**Author:** Antigravity AI Engineering Team  
**Date:** September 2026  
**Status:** Audit Complete — Pre-Implementation Phase  
**Target Corridor:** Northern Railway Jandiala (JNL) — Mananwala (MOW)  
**Supported Crossings (V1):** Exactly 4:
1. `talwandi-dogran` (Talwandi Dogran Fatak: 31.605083, 74.996645)
2. `manawala-road` (Manawala Road Fatak: 31.599745, 75.017127)
3. `rakh-devi-dasspura` (Rakh Devi Dasspura Fatak: 31.595879, 75.031856)
4. `jandiala` (Jandiala Railway Crossing: 31.590162, 75.053973)

---

## 1. Executive Summary

FatakForecast is a specialized railway-crossing decision-support system designed to predict train passage, gate closure, and gate reopening times across four level crossings on the Jandiala–Mananwala corridor. 

This technical audit investigates the existing codebase across frontend, backend, telemetry ingestion, route geometry, ETA calculation, gate prediction, observation recording, and machine learning components. It establishes the current state, identifies critical bugs (notably the disappearing observation form UI bug and anomalous direction reversals), evaluates data readiness, and details a phased evolution plan from the initial 11-minute baseline to dynamic statistical adaptation and machine-learning models.

---

## 2. System Architecture Audit

### 2.1 Backend Architecture
The backend is implemented as a lightweight Node.js HTTP server (`backend/server.js`) with zero heavy framework bloat. It provides:
- **Autonomous Background Loop:** Orchestrated by `services/corridor-engine.js` with polling interval `TIMING_CONFIG.POLL_INTERVAL_MS = 60s`. Overlapping cycles are prevented via an in-flight cycle lock `isCycleRunning`.
- **In-Flight Train Registry:** `activeCorridorRegistry` preserves tracking across cycles even during intermittent 429 rate limits or station board omissions.
- **REST Endpoints:**
  - `GET /api/forecast`: Full corridor snapshot for all four crossings, unified status, continuous closure intervals, and corridor queue.
  - `GET /api/crossings`: Metadata of the four V1 level crossings.
  - `GET /api/crossings/:id`: Single-crossing detailed prediction.
  - `POST /api/observations`: Manual gate ground-truth feedback with timestamp validation and rate-limiting.
  - `GET /api/health`: Uptime, snapshot age, freshness state, engine diagnostics.
  - `GET /api/events`: Raw historical crossing event log for calibration.
  - `GET /api/diagnostics`: Sanitized telemetry diagnostics without secret leakage.
- **Static Assets:** Serves `frontend/` files with path traversal protection and MIME type resolution.

### 2.2 Frontend Architecture
Implemented in `frontend/index.html`, `frontend/app.js`, and `frontend/style.css`:
- **Single Page Application:** Mobile-first, responsive, accessible dark UI.
- **Polling Loop:** Fetches `/api/forecast` every 30 seconds, backed by a 1-second interval ticker for countdowns and telemetry age calculation.
- **Client Snapshot Caching:** Uses `localStorage` (`fatakforecast_cached_snapshot`) with a 5-minute TTL to provide instant rendering on page reload while the background cycle finishes connecting.
- **Interactive Schematics:** Visual track schematic depicting the 4 level crossings between MOW and JNL with dynamic train marker positioning.
- **Subsequent Trains Queue:** Displays chronological upcoming train events within the 60-minute forecast horizon.

### 2.3 RailRadar Integration
Implemented in `backend/services/railradar.js`:
- Ingests live train movements and station boards (`/station/live`, `/trains/live`, `/trains/route`).
- Features request caching (`liveTrainCache` 20s TTL, `routeCache` 6h TTL).
- Implements in-flight request deduplication to prevent duplicate concurrent queries.
- Retries transient 5xx errors with exponential backoff.
- **Strict 429 handling:** Never retries HTTP 429 responses, preventing quota exhaustion storms.

---

## 3. End-to-End Prediction & Data Flows

### 3.1 Prediction Flow Pipeline
```
RailRadar API (Station Board & Live Train Status)
                     │
                     ▼
          Corridor Engine Discovery
                     │
                     ▼
       Geometry Projection (Turf.js)
 (Train & Crossings mapped to identical GeoJSON LineString)
                     │
                     ▼
         Direction Validation Engine
  (Sequence check + Station orders + Plausible velocity)
                     │
                     ▼
                 ETA Engine
 (Live Speed > Segment Speed > Sequence Anchor > Fallback)
                     │
                     ▼
          Predicted Train Passage Time
                     │
                     ▼
          Gate Closure Predictor
 (Phase 0: 11-min baseline / Phase 2: Dynamic / Phase 3: ML)
                     │
                     ▼
         Predicted Gate Close & Open Times
                     │
                     ▼
      Continuous Closure Interval Merging
 (Merges overlapping, touching, or closely spaced <=10m trains)
                     │
                     ▼
       Single Synchronized Forecast Snapshot
                     │
                     ▼
        Frontend UI & Notification Engine
```

### 3.2 Observation & Learning Data Flow
```
User at Crossing observes physical gate
                     │
                     ▼
Frontend Observation Form (datetime-local inputs)
                     │
                     ▼
          POST /api/observations
                     │
                     ▼
      Validation & Verification Engine
 (Crossing check, train check, close < pass <= open, duplicate filter)
                     │
                     ▼
         gate-observations.json
                     │
                     ▼
               Event Matcher
 (Correlates verified gate observations with predicted crossing events)
                     │
                     ▼
          matched-events.json
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
  Phase 2 Dynamic         Phase 3 & 4 ML
Statistical Prior      Supervised Regression
  (Per Crossing)        (Chronological Split)
```

---

## 4. Current ML / Data-Readiness Assessment

1. **Current Ground-Truth Dataset:**
   - `gate-observations.json`: 0 verified observations.
   - `matched-events.json`: 0 matched events.
   - Initial system state: **100% Phase 0 Baseline (11 minutes lead, +1 minute reopen)**.
2. **Data Integrity & Ground Truth Invariant:**
   - The initial 11-minute rule is strictly a product prior and benchmark, **NOT** verified ground truth.
   - **Hard Rule:** Under no circumstances should predicted 11-minute values be used as ground truth training labels.
   - **Hard Rule:** Synthetic or fabricated user observations must never be written to `gate-observations.json`.
3. **Environment Readiness:**
   - Python 3.14.3 is installed with `scikit-learn 1.8.0`, `numpy 2.4.4`, `pandas 3.0.2`, `scipy 1.17.1`, and `joblib 1.5.3`.
   - Node.js runtime has an initial Ridge implementation with cyclical sine/cosine time features.
   - System is ready for an end-to-end Python-based supervised ML pipeline with strict chronological splitting.

---

## 5. Audit Findings & Critical Issues Identified

### Issue 1: Observation UI Disappearing / Destruction Bug (Critical UX Failure)
- **Symptom:** When the user clicks "Prediction looked correct" or "Prediction was wrong", the form appears temporarily but vanishes after a few seconds or when opening the native date/time picker.
- **Root Causes:**
  1. `frontend/app.js` runs `fetchForecast()` every 30 seconds. On every successful API response, `renderMainForecast()` was called unconditionally, completely re-writing `mainForecast.innerHTML` and destroying active DOM elements, active focus, and native browser picker popups.
  2. `getObservationKey(forecast)` incorporated `trainPassage.estimatedTime`. Because live telemetry updates passage times by seconds or minutes on each poll, `observationDraft.key` mismatched `currentKey`, causing `restoreObservationDraft` to bail out and leaving `form.hidden = true`.
- **Solution:**
  - Decouple the observation form DOM from the live forecast card re-rendering.
  - When the observation form is open or being edited, preserve form DOM nodes in-place.
  - Anchor `observationKey` to stable attributes: `crossingId` and `trainNumber` (date-scoped), independent of fluctuating sub-minute passage timestamps.
  - Use `datetime-local` inputs (Date + Hour + Minute) and add an explicit `Cancel` button.
  - Maintain draft input values, notes, and validation messages across background refreshes until explicit submission or cancellation.

### Issue 2: Anomalous Position Jumps & Direction Inversion
- **Symptom:** Logs reported: `Current position: 0.000 km, Previous position: 809 km, Movement: BACKWARD`.
- **Root Causes:**
  1. `determineMovement` in `train-observer.js` evaluated `difference = current - previous`. A 0.000 km GPS fallback or API reset produced a massive negative difference, erroneously classified as `backward`.
  2. Jumps were not evaluated against physical train speed limits (max 140 km/h = ~2.33 km/min). An 800 km jump in 30 seconds is physically impossible and represents telemetry noise.
  3. Direction inference in `corridor-monitor.js` fell back to `observedMovement` without cross-checking station sequences or filtering 0.000 km glitches.
- **Solution:**
  - Filter out 0.000 km reset anomalies.
  - Enforce physical velocity bounds: if `|current - previous| / delta_time > MAX_PHYSICAL_SPEED`, mark position jump as an anomaly and do not alter established travel direction.
  - Establish direction primarily from timetable station sequence (MOW vs JNL) and corridor geometry; require multiple coherent observations before declaring a direction reversal.

### Issue 3: Dynamic Delayed Train Handling
- **Symptom:** Timetable scheduled times must not be used blindly when a train is running late.
- **Requirement:**
  - If a train is scheduled for 10:00 passage but live movement indicates 10:17 passage, the passage ETA must dynamically track 10:17.
  - Gate closure must dynamically move to 10:06 (10:17 - 11m), and opening to 10:18 (10:17 + 1m).
  - Calculate `delayMinutes = predictedLivePassage - scheduledPassage` and expose `delayMinutes` to the frontend with clean human-readable tags (e.g. `+17 min delay`), only when supported by verified data.

### Issue 4: Data Freshness State Machine
- **Requirement:** Formalize telemetry freshness state transitions:
  - `LIVE`: Telemetry age < 2 minutes.
  - `AGING`: Telemetry age 2–5 minutes.
  - `STALE`: Telemetry age 5–10 minutes.
  - `UNAVAILABLE`: Telemetry age > 10 minutes or API offline.
- Every prediction must provide metadata: `dataTimestamp`, `predictionGeneratedAt`, `dataAge`, `dataFreshness`, `etaConfidence`, `gateConfidence`, `predictionMethod`.
- Provide a collapsible "Why this prediction?" explanation in the frontend.

### Issue 5: Observation Verification & Validation Engine
- Submissions via `/api/observations` must undergo strict server-side validation:
  1. Crossing ID belongs to the 4 V1 crossings.
  2. Timestamps are valid ISO dates.
  3. `actualGateClose < actualTrainPassage`.
  4. `actualGateOpen >= actualTrainPassage`.
  5. Plausible closure lead time (0 to 30 minutes).
  6. Plausible total closure duration (0.5 to 30 minutes).
  7. Duplicate submission detection (matching crossing, train, passage within 2 minutes).
  8. Observations categorized as `REPORTED`, `VERIFIED`, or `REJECTED`. Only `VERIFIED` observations enter the ML dataset.

### Issue 6: Dynamic Statistical Prior (Phase 2)
- When verified observations exist for a crossing, compute:
  - Mean, Median, P25, P75, Standard Deviation, Sample Count.
  - Apply Bayesian shrinkage: `prior = 11.0`, `prior_strength = 3`.
  - As sample count grows, the crossing-specific empirical distribution smoothly supersedes the prior.
  - Separate distributions per crossing and per direction.

### Issue 7: Multi-Model Machine Learning Pipeline (Phase 3 & 4)
- Create a dedicated Python ML pipeline under `ml/`:
  - `ml/data/`: Dataset schemas and exports.
  - `ml/preprocessing/`: Temporal feature extraction (crossing one-hot, direction, hour cyclical sin/cos, day of week, train delay, speed, route distance).
  - `ml/train/`: Model training scripts with chronological train/validation/test split (70/15/15) to prevent temporal leakage.
  - `ml/evaluate/`: Comparative metrics (MAE, RMSE, R², Median Absolute Error, P25/P75) against the 11-minute baseline benchmark.
  - `ml/models/`: Serialized model artifacts with versioning and audit trails.
  - `ml/inference/`: Production scoring module with safe fallback to dynamic baseline.
- Models to train & evaluate:
  1. Baseline (11-min constant)
  2. Historical Median / Weighted Statistical Model
  3. Ridge Regression
  4. Random Forest Regressor
  5. HistGradientBoosting Regressor
- **Deployment Criteria:** ML model is activated ONLY if:
  1. At least 20 verified observations exist.
  2. Test set size >= 5 observations.
  3. Model MAE beats 11-minute baseline MAE on the held-out test set by a statistically meaningful margin (>= 5% improvement).
  4. Predictions pass sanity bounding (clamped between 2 and 30 minutes).

### Issue 8: Simulation Test Harness
- Implement `backend/services/simulation.js` and CLI runner `backend/simulate.js`:
  - Simulate: On-time train, delayed train (+5m, +15m, +30m), speed change, train stop, anomalous position jump, two trains approaching same crossing (continuous closure), stale RailRadar data, and API failure.

---

## 6. Phased Implementation Roadmap

- **Phase A (Complete):** System Audit (`docs/AI-ML-AUDIT.md`), architecture inspection, root cause discovery.
- **Phase B:** Fix Direction/Position Anomaly Filter, Delay-aware ETA calculations, Freshness State Machine, and Continuous Closure engine hardening.
- **Phase C:** Fix Observation UI Bug in `frontend/app.js`, datetime-local inputs, draft persistence, cancel button, and server-side observation validation pipeline.
- **Phase D:** Crossing-specific Dynamic Statistical Baseline with Bayesian shrinkage.
- **Phase E:** Supervised Python ML Pipeline (`ml/`), models (Ridge, Random Forest, HistGradientBoosting), chronological evaluation against baseline.
- **Phase F:** ML Inference Integration in Node.js backend with automated fallback logic and prediction uncertainty estimation.
- **Phase G:** Comprehensive Test Suite covering all 24 specific conditions and simulation test harness.
- **Phase H:** Documentation (`docs/MODEL-CARD.md`, `docs/DATA-COLLECTION.md`, updated `README.md`).
