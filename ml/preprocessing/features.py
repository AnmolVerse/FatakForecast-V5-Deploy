"""
FatakForecast V5 — Feature Engineering Pipeline
Extracts structured features for gate-closure lead time and duration prediction.
All features are strictly known BEFORE the gate closure / passage event.
"""

import math
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple
import numpy as np
import pandas as pd

CROSSINGS = [
    "talwandi-dogran",
    "manawala-road",
    "rakh-devi-dasspura",
    "jandiala"
]

FEATURE_NAMES = [
    # Crossing One-Hot (4 features)
    "crossing_talwandi_dogran",
    "crossing_manawala_road",
    "crossing_rakh_devi_dasspura",
    "crossing_jandiala",
    # Direction One-Hot (2 features)
    "direction_forward",
    "direction_backward",
    # Cyclical Time of Day (2 features)
    "hour_sin",
    "hour_cos",
    # Cyclical Day of Week (2 features)
    "dow_sin",
    "dow_cos",
    # Cyclical Month (2 features)
    "month_sin",
    "month_cos",
    # Telemetry Features (2 features)
    "speed_kmh",
    "delay_minutes"
]

DEFAULT_SPEED_KMH = 60.0
DEFAULT_DELAY_MINUTES = 0.0


def parse_datetime(dt_val: Any) -> Optional[datetime]:
    """Parse various datetime representations into a datetime object."""
    if dt_val is None:
        return None
    if isinstance(dt_val, datetime):
        return dt_val
    if isinstance(dt_val, (int, float)):
        # Assume ms timestamp if large, else seconds
        ts = dt_val / 1000.0 if dt_val > 1e11 else dt_val
        return datetime.fromtimestamp(ts)
    if isinstance(dt_val, str):
        # Clean ISO format
        clean = dt_val.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(clean)
        except Exception:
            for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
                try:
                    return datetime.strptime(clean[:19], fmt)
                except Exception:
                    pass
    return None


def extract_features_dict(
    crossing_id: str,
    direction: str,
    passage_time: Any,
    speed_kmh: Optional[float] = None,
    delay_minutes: Optional[float] = None
) -> Optional[Dict[str, float]]:
    """Extract a named dictionary of features from a single event."""
    dt = parse_datetime(passage_time)
    if not dt:
        return None

    hour_fraction = dt.hour + (dt.minute / 60.0) + (dt.second / 3600.0)
    day_of_week = dt.weekday()  # 0 = Monday, 6 = Sunday
    month = dt.month - 1         # 0 = January, 11 = December

    speed = float(speed_kmh) if (speed_kmh is not None and not math.isnan(speed_kmh) and speed_kmh > 0) else DEFAULT_SPEED_KMH
    delay = float(delay_minutes) if (delay_minutes is not None and not math.isnan(delay_minutes)) else DEFAULT_DELAY_MINUTES

    # Clamp realistic ranges
    speed = max(5.0, min(160.0, speed))
    delay = max(-30.0, min(720.0, delay))

    features = {
        "crossing_talwandi_dogran": 1.0 if crossing_id == "talwandi-dogran" else 0.0,
        "crossing_manawala_road": 1.0 if crossing_id == "manawala-road" else 0.0,
        "crossing_rakh_devi_dasspura": 1.0 if crossing_id == "rakh-devi-dasspura" else 0.0,
        "crossing_jandiala": 1.0 if crossing_id == "jandiala" else 0.0,
        "direction_forward": 1.0 if direction == "forward" else 0.0,
        "direction_backward": 1.0 if direction == "backward" else 0.0,
        "hour_sin": math.sin(2.0 * math.pi * hour_fraction / 24.0),
        "hour_cos": math.cos(2.0 * math.pi * hour_fraction / 24.0),
        "dow_sin": math.sin(2.0 * math.pi * day_of_week / 7.0),
        "dow_cos": math.cos(2.0 * math.pi * day_of_week / 7.0),
        "month_sin": math.sin(2.0 * math.pi * month / 12.0),
        "month_cos": math.cos(2.0 * math.pi * month / 12.0),
        "speed_kmh": speed,
        "delay_minutes": delay
    }

    return features


def extract_features_vector(
    crossing_id: str,
    direction: str,
    passage_time: Any,
    speed_kmh: Optional[float] = None,
    delay_minutes: Optional[float] = None
) -> Optional[np.ndarray]:
    """Extract an ordered numpy array of features matching FEATURE_NAMES."""
    feat_dict = extract_features_dict(
        crossing_id=crossing_id,
        direction=direction,
        passage_time=passage_time,
        speed_kmh=speed_kmh,
        delay_minutes=delay_minutes
    )
    if not feat_dict:
        return None
    return np.array([feat_dict[name] for name in FEATURE_NAMES], dtype=np.float64)


def prepare_feature_matrix(records: List[Dict[str, Any]]) -> Tuple[np.ndarray, np.ndarray, List[Dict[str, Any]]]:
    """
    Given a list of matched observation records, extract:
    - X: 2D numpy array of shape (N, len(FEATURE_NAMES))
    - y: 1D numpy array of shape (N,) containing closure_lead_time_minutes
    - valid_records: sorted chronological records used
    """
    rows = []
    targets = []
    valid_records = []

    for r in records:
        # Require verified status or valid target
        lead = r.get("closure_lead_time_minutes")
        if lead is None:
            continue
        try:
            lead_val = float(lead)
        except (ValueError, TypeError):
            continue

        # Sanity bounds check: Lead time must be between 0 and 30 minutes
        if not (0.0 <= lead_val <= 30.0):
            continue

        # Passage time reference
        passage = r.get("actual_train_passage_time") or r.get("predicted_passage_time")
        dt = parse_datetime(passage)
        if not dt:
            continue

        vec = extract_features_vector(
            crossing_id=r.get("crossing_id", ""),
            direction=r.get("direction", ""),
            passage_time=dt,
            speed_kmh=r.get("speed_kmh"),
            delay_minutes=r.get("delay_minutes")
        )
        if vec is None:
            continue

        rows.append(vec)
        targets.append(lead_val)
        rec_copy = dict(r)
        rec_copy["_timestamp"] = dt.timestamp()
        valid_records.append(rec_copy)

    if not rows:
        return np.empty((0, len(FEATURE_NAMES))), np.empty((0,)), []

    # Sort chronologically by timestamp
    order = np.argsort([r["_timestamp"] for r in valid_records])
    X = np.array(rows)[order]
    y = np.array(targets)[order]
    sorted_records = [valid_records[i] for i in order]

    return X, y, sorted_records
