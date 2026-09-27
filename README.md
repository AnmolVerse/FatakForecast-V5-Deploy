# FatakForecast V5 — Railway-Crossing Prediction System

> **Mobility Intelligence • Machine Learning • Real-Time Safety Decision Support**  
> Serving the 12.8 km Jandiala (JNL) – Mananwala (MOW) railway corridor, Punjab, India.

---

## 1. Project Purpose

FatakForecast is a specialized railway-crossing prediction system.

Given live and scheduled train movements, FatakForecast predicts when a train will reach one of four specific railway level crossings ("fataks") and estimates:

1. **Train Passage Time ($T_{\text{passage}}$)**
2. **Gate Closure Time ($T_{\text{closure}}$)**
3. **Gate Opening Time ($T_{\text{reopen}}$)**
4. **Multi-Train Continuous Closure Warnings** (whether consecutive trains will keep the crossing down continuously)
5. **Dual Confidence & Reliability Levels** (Live ETA confidence and Gate Model confidence)
6. **Dynamic Delays & Schedule Recalibration**

### The Jandiala – Mananwala Corridor (Strictly 4 Crossings)

```
[Mananwala MOW (0.0 km)]
      │
      ├── (2.56 km) Talwandi Dogran Fatak (talwandi-dogran)
      │
      ├── (5.38 km) Manawala Road Fatak (manawala-road)
      │
      ├── (8.70 km) Rakh Devi Dasspura Fatak (rakh-devi-dasspura)
      │
      └── (11.26 km) Jandiala Railway Crossing (jandiala)
      │
[Jandiala JNL (12.8 km)]
```

---

## 2. Predictive Hierarchy & Evolutionary ML Architecture

FatakForecast adheres to a strict zero-hallucination, ground-truth invariant policy. Heuristic predictions are never used as training labels.

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 0: Initial Product Baseline Prior                     │
│ 11-minute closure lead (Tp - 11m) • 1-minute reopen (Tp + 1m)│
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Ground-Truth Physical Observation Engine           │
│ User/Operator reports timestamps with automated verification│
│ (REPORTED → VERIFIED → REJECTED sanity filtering)           │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: Crossing-Specific Dynamic Baseline                 │
│ Bayesian prior strength (K=3) weighted blend                │
│ Uses conservative P75 lead time + safety buffer             │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 3: Supervised Machine Learning Pipeline (ml/)         │
│ Chronological 70/15/15 train/val/test split                 │
│ Ridge, Random Forest, HistGradientBoosting models           │
│ Strict Gating: >= 20 verified samples AND >= 5% MAE beating │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 4: Continuous Evaluation & Retraining                 │
│ Production model monitored continually against 11m benchmark│
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Core Engineering & Safety Invariants

### 3.1 11-Minute Baseline Prior (Benchmark)
The 11-minute baseline ($T_{\text{close}} = T_{\text{passage}} - 11\text{m}$) is the prior benchmark against which statistical corrections and machine learning models are evaluated. It provides immediate conservative warning while verified data is gathered.

### 3.2 Telemetry Anomaly Suppression
- **0.000 km Reset Glitch:** Telemetry drops from valid corridor positions (e.g. 809 km) to 0.000 km are suppressed to prevent false direction reversals.
- **Velocity Sanity Bounding:** Instantaneous position deltas $> 25\text{ km}$ or speeds $> 180\text{ km/h}$ are rejected as noise and marked stationary.
- **Direction Inference:** Evaluates scheduled stop sequences across West anchor stations (`ASR`, `MOW`) and East anchor stations (`JNL`, `BEAS`) alongside next/previous halts.

### 3.3 4-Tier Data Freshness State Machine
Every train and snapshot is classified by data age:
- **LIVE_FRESH:** $< 2\text{ minutes}$ (Normal live operations)
- **AGING:** $2 - 5\text{ minutes}$ (Warning indicator displayed)
- **STALE:** $5 - 10\text{ minutes}$ (Conservative fallbacks applied)
- **UNAVAILABLE:** $> 10\text{ minutes}$ (Safe failover: "Live data unavailable — manual authority")

### 3.4 Multi-Train Continuous Closure
When two or more trains have crossing passage times within $\le 5$ minutes of each other, FatakForecast merges their safety intervals into a single continuous closure alert to prevent mid-sequence vehicle entrapment.

### 3.5 Ground-Truth Verification Engine
Every reported observation must satisfy physical sanity invariants:
- $T_{\text{close}} < T_{\text{passage}} \le T_{\text{open}}$
- Lead time ($T_{\text{passage}} - T_{\text{close}}$) between $0.0$ and $30.0$ minutes
- Closure duration ($T_{\text{open}} - T_{\text{close}}$) between $0.5$ and $35.0$ minutes
- Timestamps $\le \text{Now} + 5\text{ minutes}$

### 3.6 Non-Destructive In-Place UI
- **DOM Focus Retention:** Live 30-second polling and 1-second countdown ticks update metrics in-place without destroying the active observation form.
- **Stable Observation Key:** Form state is keyed by `${crossingId}|${trainNumber}|${date}` rather than fluctuating train arrival timestamps.
- **Explainability Accordion:** Interactive "Why this prediction?" panel breaks down train tracking, gate model, delay, and multi-train overlaps.

---

## 4. Repository Structure

```
FatakForecast-V5/
├── backend/
│   ├── config/
│   │   └── corridor.js                # Corridor layout, crossings, thresholds
│   ├── data/
│   │   ├── gate-observations.json     # Ground truth observations
│   │   ├── matched-events.json        # Verified matched training samples
│   │   └── legacy-v1-v3/             # Quarantined legacy data
│   ├── services/
│   │   ├── closure-predictor.js       # Dynamic Bayesian baseline & stats
│   │   ├── ml-closure-model.js        # Node.js Ridge regression & gating
│   │   ├── simulation.js              # Deterministic corridor scenario engine
│   │   ├── train-observer.js          # Anomaly & movement detection
│   │   ├── corridor-monitor.js        # Direction inference & live monitor
│   │   ├── gate-observer.js           # Verification engine
│   │   └── forecast-snapshot.js       # Unified 4-crossing snapshot
│   ├── simulate.js                    # Simulation CLI runner
│   ├── test-v5-comprehensive-suite.js # 24-test V5 master verification suite
│   ├── test-master-suite.js           # 50-test master automated suite
│   ├── test-delayed-train-suite.js    # Delayed train test suite
│   ├── test-stale-lifecycle-suite.js  # Stale data & lifecycle test suite
│   └── server.js                      # Express backend server
├── frontend/
│   ├── app.js                         # In-place reactive client application
│   ├── style.css                      # Premium dark mode design system
│   └── index.html                     # Mobile-first responsive UI
├── ml/
│   ├── data/
│   │   └── dataset_schema.json        # Formal training schema definition
│   ├── preprocessing/
│   │   └── features.py                # Preprocessing & cyclical feature engineering
│   ├── train/
│   │   └── train_models.py            # Chronological 70/15/15 model trainer
│   ├── evaluate/
│   │   └── evaluate_models.py         # Evaluation metrics vs 11m baseline
│   ├── inference/
│   │   └── predict.py                 # Standalone ML inference engine
│   └── artifacts/                     # Model weights & training reports
└── docs/
    ├── MODEL-CARD.md                  # Machine learning model card
    ├── DATA-COLLECTION.md             # Ground truth verification specification
    └── AI-ML-AUDIT.md                 # Complete engineering audit
```

---

## 5. Verification & Testing

### Run Comprehensive V5 Suite (24 Tests)
```bash
node backend/test-v5-comprehensive-suite.js
```

### Run Master 50-Test Suite
```bash
node backend/test-master-suite.js
```

### Run All Corridor Simulation Scenarios
```bash
node backend/simulate.js --all
```

### Run Python ML Pipeline
```bash
# Model Training (strictly gated against 11-min baseline)
python ml/train/train_models.py

# Standalone ML Inference
python ml/inference/predict.py --crossing jandiala --direction forward --speed 65.0
```

---

## 6. License & Safety Disclaimer

FatakForecast is designed for informational and situational awareness purposes. Gate predictions assist local road users in planning travel and avoiding blocked level crossings. It does not replace physical railway signaling, boom barrier interlocking, or on-site gateman authority.
