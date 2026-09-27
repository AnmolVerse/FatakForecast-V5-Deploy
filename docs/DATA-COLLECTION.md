# FatakForecast V5 — Ground Truth Data Collection & Verification Guide

## 1. Purpose of Data Collection

FatakForecast predicts railway crossing gate closures for local road users. Because Indian Railways does not publish a live digital telemetry API for physical level-crossing boom barriers, FatakForecast operates on a multi-phase evolutionary learning architecture:

- **Phase 0 (Initial Baseline Prior):** Conservative benchmark prior ($T_{\text{close}} = T_{\text{passage}} - 11\text{m}$, $T_{\text{reopen}} = T_{\text{passage}} + 1\text{m}$).
- **Phase 1 (Ground-Truth Observation Engine):** Crowd and field operator submission of actual gate movements with rigorous automated verification.
- **Phase 2 (Crossing-Specific Dynamic Baseline):** Bayesian prior-weighted statistical correction ($K=3$, using P75 conservative percentile + safety buffer).
- **Phase 3 (Supervised Machine Learning):** Chronologically trained regression models guarded by an empirical 5% MAE improvement threshold.
- **Phase 4 (Continuous Retraining):** Automated continuous evaluation against the 11-minute baseline benchmark.

> [!IMPORTANT]
> **Ground Truth Invariant:** FatakForecast NEVER trains machine learning models on synthetic heuristic predictions or fake timestamps. Only physical, human-observed or sensor-verified timestamps are admitted to the training dataset.

---

## 2. Observation Lifecycle & States

Every recorded observation passes through the Verification Engine (`verifyObservationRecord` in `backend/services/gate-observer.js`):

```
       [User / Operator Reports Timestamps]
                        │
                        ▼
            ┌───────────────────────┐
            │  Verification Engine  │
            └───────────────────────┘
             /          │          \
            /           │           \
[Sanity Failed]   [Missing Times]   [All Invariants Pass]
      │                 │                     │
      ▼                 ▼                     ▼
 ❌ REJECTED       ⏳ REPORTED           ✅ VERIFIED
(Discarded from   (Awaiting complete   (Admitted to Matching
   Training)          timestamps)        & ML Training)
```

### Verification Invariants

1. **Chronological Validity:** $T_{\text{close}} < T_{\text{passage}} \le T_{\text{open}}$. Gate closure must strictly precede train passage.
2. **Plausible Lead Window:** Lead time ($T_{\text{passage}} - T_{\text{close}}$) must be between **0.0 minutes and 30.0 minutes**.
3. **Plausible Duration Window:** Total closure duration ($T_{\text{open}} - T_{\text{close}}$) must be between **0.5 minutes (30 seconds) and 35.0 minutes**.
4. **Future Timestamp Rejection:** Observations with timestamps $> 5$ minutes into the future are marked `REJECTED` to prevent time-skew artifacts.
5. **Verified-Only Admittance:** The Event Matcher (`backend/services/event-matcher.js`) and ML preprocessor (`ml/preprocessing/features.py`) strictly filter for `verification_status === "VERIFIED"`.

---

## 3. Data Schema

### 3.1 Raw Observation Schema (`backend/data/gate-observations.json`)

```json
{
  "id": "gate-obs-1727395200000-a1b2c",
  "crossing_id": "manawala-road",
  "crossing_name": "Manawala Road Fatak",
  "train_number": "12006",
  "direction": "forward",
  "gate_close_time": "2026-09-27T10:14:00.000Z",
  "train_passage_time": "2026-09-27T10:24:30.000Z",
  "gate_open_time": "2026-09-27T10:26:00.000Z",
  "observation_status": "complete",
  "verification_status": "VERIFIED",
  "verification_reason": "Verified physical observation passed all sanity invariants",
  "source": "manual-ground-truth",
  "notes": "Clear weather, gate went down smoothly",
  "user_feedback": "correct",
  "created_at": "2026-09-27T10:26:15.000Z"
}
```

### 3.2 Matched Event Training Schema (`backend/data/matched-events.json`)

When an automatic telemetry passage event coincides with a verified gate observation:

```json
{
  "event_id": "matched-1727395200000",
  "crossing_id": "manawala-road",
  "train_number": "12006",
  "direction": "forward",
  "actual_gate_close_time": "2026-09-27T10:14:00.000Z",
  "actual_train_passage_time": "2026-09-27T10:24:30.000Z",
  "actual_gate_open_time": "2026-09-27T10:26:00.000Z",
  "closure_lead_time_minutes": 10.5,
  "closure_duration_minutes": 12.0,
  "speed_kmh": 62.4,
  "delay_minutes": 4.0,
  "match_delta_seconds": 18,
  "verification_status": "VERIFIED"
}
```

---

## 4. Frontend Observation UX Safeguards

To prevent UX friction and data loss:
- **Stable Observation Key:** Keyed by `${crossingId}|${trainNumber}|${date}` rather than fluctuating train arrival timestamps.
- **Non-Destructive In-Place Updates:** 30-second live API background polls and 1-second countdown ticks update metrics in-place without touching the DOM of an active observation form.
- **Input Preservation:** The native browser date-time pickers (`datetime-local`) retain user focus and entered values.
- **Cancel Button:** Users can dismiss or cancel an in-progress draft at any time.

---

## 5. Privacy & Ethics

1. **Zero Personally Identifiable Information (PII):** No names, phone numbers, IP addresses, or device IDs are recorded.
2. **Open Data Principles:** Ground truth datasets are stored as clean JSON files ready for audit and community verification.
3. **No Unrealistic Accuracy Claims:** The system never claims 90–100% accuracy without empirical validation on a held-out chronological test set.
