"""
FatakForecast V5 — ML Inference Engine
Performs gate closure lead time prediction with fallback guard and uncertainty range.
"""

import sys
import json
import argparse
from pathlib import Path
from typing import Dict, Any, Optional

import joblib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from ml.preprocessing.features import extract_features_vector, FEATURE_NAMES

ARTIFACTS_DIR = Path(__file__).resolve().parent.parent / "artifacts"
MODEL_PATH = ARTIFACTS_DIR / "best_closure_model.joblib"
METADATA_PATH = ARTIFACTS_DIR / "model_metadata.json"
FALLBACK_LEAD_MINUTES = 11.0


class ClosurePredictor:
    def __init__(self, model_path: Path = MODEL_PATH, metadata_path: Path = METADATA_PATH):
        self.model = None
        self.metadata = {}
        self.is_loaded = False
        self._load_model(model_path, metadata_path)

    def _load_model(self, model_path: Path, metadata_path: Path):
        if model_path.exists() and metadata_path.exists():
            try:
                self.model = joblib.load(model_path)
                with open(metadata_path, "r", encoding="utf-8") as f:
                    self.metadata = json.load(f)
                self.is_loaded = True
            except Exception as e:
                self.is_loaded = False
                self.model = None
                self.metadata = {"load_error": str(e)}

    def predict(
        self,
        crossing_id: str,
        direction: str,
        passage_time: Any,
        speed_kmh: Optional[float] = None,
        delay_minutes: Optional[float] = None
    ) -> Dict[str, Any]:
        """Predict closure lead time with uncertainty interval and fallback guard."""
        if not self.is_loaded or self.model is None:
            return {
                "lead_minutes": FALLBACK_LEAD_MINUTES,
                "uncertainty_range": [FALLBACK_LEAD_MINUTES - 2.0, FALLBACK_LEAD_MINUTES + 2.0],
                "is_fallback": True,
                "fallback_reason": "No deployed ML model meets >=5% improvement gate over 11-min baseline.",
                "model_name": "Dynamic_Statistical_Baseline",
                "model_version": "baseline-11m"
            }

        vec = extract_features_vector(
            crossing_id=crossing_id,
            direction=direction,
            passage_time=passage_time,
            speed_kmh=speed_kmh,
            delay_minutes=delay_minutes
        )

        if vec is None:
            return {
                "lead_minutes": FALLBACK_LEAD_MINUTES,
                "uncertainty_range": [FALLBACK_LEAD_MINUTES - 2.0, FALLBACK_LEAD_MINUTES + 2.0],
                "is_fallback": True,
                "fallback_reason": "Invalid or missing features for passage time.",
                "model_name": "Dynamic_Statistical_Baseline",
                "model_version": "baseline-11m"
            }

        raw_pred = float(self.model.predict([vec])[0])
        # Safety bounds: Lead time clamped between 2 and 25 minutes
        lead_pred = round(max(2.0, min(25.0, raw_pred)), 2)

        test_mae = float(self.metadata.get("test_mae", 1.5))
        margin = max(1.0, round(test_mae, 1))

        return {
            "lead_minutes": lead_pred,
            "uncertainty_range": [round(max(1.0, lead_pred - margin), 2), round(min(30.0, lead_pred + margin), 2)],
            "is_fallback": False,
            "fallback_reason": None,
            "model_name": self.metadata.get("model_name", "Trained_ML_Model"),
            "model_version": self.metadata.get("version", "5.0.0"),
            "test_mae": test_mae
        }


_global_predictor = None


def get_predictor() -> ClosurePredictor:
    global _global_predictor
    if _global_predictor is None:
        _global_predictor = ClosurePredictor()
    return _global_predictor


def predict_lead(
    crossing_id: str,
    direction: str,
    passage_time: Any,
    speed_kmh: Optional[float] = None,
    delay_minutes: Optional[float] = None
) -> Dict[str, Any]:
    """Top-level convenience prediction function."""
    return get_predictor().predict(
        crossing_id=crossing_id,
        direction=direction,
        passage_time=passage_time,
        speed_kmh=speed_kmh,
        delay_minutes=delay_minutes
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run FatakForecast ML closure inference")
    parser.add_argument("--crossing", type=str, default="rakh-devi-dasspura", help="Crossing ID")
    parser.add_argument("--direction", type=str, default="forward", help="Direction: forward or backward")
    parser.add_argument("--passage", type=str, default=None, help="Passage ISO timestamp")
    parser.add_argument("--speed", type=float, default=65.0, help="Speed in km/h")
    parser.add_argument("--delay", type=float, default=0.0, help="Delay in minutes")
    args = parser.parse_args()

    import datetime
    passage_val = args.passage or datetime.datetime.now().isoformat()
    result = predict_lead(
        crossing_id=args.crossing,
        direction=args.direction,
        passage_time=passage_val,
        speed_kmh=args.speed,
        delay_minutes=args.delay
    )
    print(json.dumps(result, indent=2))
