# FatakForecast V5 — Model Card: Gate Closure Lead Time Predictor

## 1. Model Details

- **Model Name:** FatakForecast Gate Closure Lead Predictor (`FatakForecast-Closure-v5`)
- **Version:** `5.0.0`
- **Model Type:** Supervised Regression (Ridge Regression, Random Forest Regressor, HistGradientBoosting Regressor ensemble)
- **Domain:** Northern Railway, Firozpur Division — Jandiala (JNL) to Mananwala (MOW) Corridor, Punjab, India.
- **Crossings Covered (Strictly 4):**
  1. `talwandi-dogran` (Talwandi Dogran Fatak) — 2.56 km
  2. `manawala-road` (Manawala Road Fatak) — 5.38 km
  3. `rakh-devi-dasspura` (Rakh Devi Dasspura Fatak) — 8.70 km
  4. `jandiala` (Jandiala Railway Crossing) — 11.26 km

---

## 2. Intended Use

- **Primary Objective:** Given real-time and scheduled railway train telemetry, estimate the physical gate-closure lead time ($T_{\text{lead}} = T_{\text{passage}} - T_{\text{closure}}$) for approaching trains.
- **Decision Support:** Provides road users and local commuters with reliable early warnings regarding crossing closures, reopening times, and multi-train continuous closures.
- **Safety Criticality:** **High**. The model must always favor early warning over late warning. Predictions are conservative; the system explicitly distinguishes "Predicted closure" from physical interlocking "Confirmed gate closed".

---

## 3. Benchmark & Baseline Benchmark

- **Product Baseline Prior:** Gate closure occurs **11 minutes** prior to train passage ($T_{\text{closure}} = T_{\text{passage}} - 11\text{m}$). Gate reopening occurs **1 minute** post-passage ($T_{\text{reopen}} = T_{\text{passage}} + 1\text{m}$).
- **Role of the 11-Minute Baseline:** This is the benchmark prior against which every statistical correction and ML model is measured.
- **Ground Truth Invariant:** The 11-minute baseline is **never** used as synthetic training labels. Models are trained **strictly on verified physical ground-truth observations** collected via the ground-truth observation pipeline.

---

## 4. Feature Schema

All features are strictly known and extractable **before** the closure event occurs:

| Feature Name | Type | Description | Range / Values |
| :--- | :--- | :--- | :--- |
| `crossing_talwandi_dogran` | Binary (0/1) | One-hot indicator for Talwandi Dogran crossing | $\{0, 1\}$ |
| `crossing_manawala_road` | Binary (0/1) | One-hot indicator for Manawala Road crossing | $\{0, 1\}$ |
| `crossing_rakh_devi_dasspura` | Binary (0/1) | One-hot indicator for Rakh Devi Dasspura crossing | $\{0, 1\}$ |
| `crossing_jandiala` | Binary (0/1) | One-hot indicator for Jandiala crossing | $\{0, 1\}$ |
| `direction_forward` | Binary (0/1) | Train travelling West to East (MOW $\to$ JNL) | $\{0, 1\}$ |
| `direction_backward` | Binary (0/1) | Train travelling East to West (JNL $\to$ MOW) | $\{0, 1\}$ |
| `hour_sin`, `hour_cos` | Continuous | Cyclical time of day ($\sin, \cos(2\pi \cdot h / 24)$) | $[-1.0, 1.0]$ |
| `dow_sin`, `dow_cos` | Continuous | Cyclical day of week ($\sin, \cos(2\pi \cdot d / 7)$) | $[-1.0, 1.0]$ |
| `month_sin`, `month_cos` | Continuous | Cyclical seasonality month ($\sin, \cos(2\pi \cdot m / 12)$) | $[-1.0, 1.0]$ |
| `speed_kmh` | Continuous | Telemetry speed approaching corridor | $[5.0, 160.0]$ |
| `delay_minutes` | Continuous | Operational schedule delay from station boards | $[-30.0, 720.0]$ |

**Target Variable:** `closure_lead_time_minutes` ($T_{\text{passage}} - T_{\text{close}}$), bounded between $0.0$ and $30.0$ minutes.

---

## 5. Deployment & Gating Rules

Before any machine-learning model is promoted to production inference, it must pass strict automated gates:

1. **Sample Quantity Gate:** $\ge 20$ verified, physically matched ground-truth observations (`matched-events.json`).
2. **Chronological Splitting:** 70% Train, 15% Validation, 15% Test chronologically ordered by passage timestamp. **No random k-fold shuffling** to prevent temporal data leakage.
3. **Empirical Improvement Gate:** The model's held-out Test MAE must beat the 11-minute baseline MAE by **at least 5%**:
   $$\text{MAE}_{\text{model}} < 0.95 \times \text{MAE}_{\text{baseline}}$$
4. **Fallback Mechanism:** If any gate fails or insufficient verified data exists, the system automatically falls back to the **Phase 2 Dynamic Statistical Baseline** (Bayesian prior strength $K=3$, using P75 conservative lead time + safety buffer).

---

## 6. Model Evaluation Framework

The evaluation pipeline (`ml/evaluate/evaluate_models.py`) reports:
- **MAE** (Mean Absolute Error)
- **RMSE** (Root Mean Squared Error)
- **$R^2$** (Coefficient of Determination)
- **MedAE** (Median Absolute Error)
- **P25 / P75 Error Percentiles**
- **Improvement over 11-min baseline** (%)

---

## 7. Safety, Uncertainty & Bias Considerations

- **Conservative Bias:** The model adds a safety buffer and clamps predictions within $[2.0, 25.0]$ minutes.
- **Uncertainty Interval:** Inference output returns a calibrated uncertainty range:
  $$[\max(1.0, \hat{y} - \text{MAE}_{\text{test}}), \min(30.0, \hat{y} + \text{MAE}_{\text{test}})]$$
- **Telemetry Anomaly Immunity:** Instantaneous position jumps $>25\text{ km}$ or speeds $>180\text{ km/h}$ are rejected as noise. $0.000\text{ km}$ GPS glitches are suppressed to avoid false direction reversal.
- **Continuous Closure Safety:** When two trains have crossing passages within $\le 5$ minutes, gates are held continuously closed to eliminate vehicle entrapment hazards between trains.
