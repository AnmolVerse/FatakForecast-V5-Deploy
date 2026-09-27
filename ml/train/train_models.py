"""
FatakForecast V5 — Model Training Engine
Chronologically trains Ridge, Random Forest, and HistGradientBoosting models
Strictly compares against the 11-minute baseline and requires >= 5% MAE improvement before saving.
"""

import os
import sys
import json
import argparse
from pathlib import Path
from typing import Dict, Any, Optional

import joblib
import numpy as np
from sklearn.linear_model import Ridge
from sklearn.ensemble import RandomForestRegressor, HistGradientBoostingRegressor

# Add parent directory to sys.path to allow importing from ml
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from ml.preprocessing.features import prepare_feature_matrix, FEATURE_NAMES
from ml.evaluate.evaluate_models import compute_metrics, format_comparison_table, BASELINE_LEAD_MINUTES

DEFAULT_DATA_PATH = Path(__file__).resolve().parent.parent.parent / "backend" / "data" / "matched-events.json"
ARTIFACTS_DIR = Path(__file__).resolve().parent.parent / "artifacts"
MIN_SAMPLES_REQUIRED = 20


def train_and_evaluate(
    data_path: Path = DEFAULT_DATA_PATH,
    artifacts_dir: Path = ARTIFACTS_DIR,
    force_save: bool = False
) -> Dict[str, Any]:
    """Train models, evaluate against baseline, and promote best if guard passes."""
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    if not data_path.exists():
        msg = f"Data file does not exist: {data_path}"
        print(f"[ML-TRAIN] {msg}")
        return {"status": "NO_DATA", "reason": msg, "promoted": False}

    with open(data_path, "r", encoding="utf-8") as f:
        try:
            records = json.load(f)
        except Exception as e:
            msg = f"Failed to parse JSON from {data_path}: {e}"
            print(f"[ML-TRAIN] {msg}")
            return {"status": "PARSE_ERROR", "reason": msg, "promoted": False}

    if not isinstance(records, list):
        records = []

    X, y, sorted_records = prepare_feature_matrix(records)
    n_samples = len(X)
    print(f"[ML-TRAIN] Found {n_samples} valid chronological observations in dataset.")

    if n_samples < MIN_SAMPLES_REQUIRED:
        reason = f"Insufficient verified samples ({n_samples} < {MIN_SAMPLES_REQUIRED}). Prior dynamic baseline remains active."
        print(f"[ML-TRAIN] [NOTICE] {reason}")
        report = {
            "status": "INSUFFICIENT_SAMPLES",
            "samples": n_samples,
            "min_required": MIN_SAMPLES_REQUIRED,
            "reason": reason,
            "promoted": False,
            "baseline_active": True
        }
        with open(artifacts_dir / "training_report.json", "w", encoding="utf-8") as rf:
            json.dump(report, rf, indent=2)
        return report

    # Chronological 70% Train, 15% Validation, 15% Test
    n_train = int(n_samples * 0.70)
    n_val = int(n_samples * 0.15)
    n_test = n_samples - n_train - n_val

    if n_test < 3 or n_train < 10:
        reason = f"Not enough samples to form stable test split (Train={n_train}, Val={n_val}, Test={n_test})."
        print(f"[ML-TRAIN] [WARN] {reason}")
        return {"status": "SPLIT_TOO_SMALL", "reason": reason, "promoted": False}

    X_train = X[:n_train]
    y_train = y[:n_train]

    X_val = X[n_train:n_train + n_val]
    y_val = y[n_train:n_train + n_val]

    X_test = X[n_train + n_val:]
    y_test = y[n_train + n_val:]

    print(f"[ML-TRAIN] Chronological Split: Train={len(X_train)}, Val={len(X_val)}, Test={len(X_test)}")

    # Candidate models
    candidates = {
        "Ridge_Regression": Ridge(alpha=1.0),
        "Random_Forest": RandomForestRegressor(n_estimators=50, max_depth=5, random_state=42),
        "Hist_Gradient_Boosting": HistGradientBoostingRegressor(max_iter=50, max_depth=4, random_state=42)
    }

    # Step 1: Train candidate models ONLY on TRAIN set
    val_results = {}
    train_models = {}

    for name, model in candidates.items():
        model.fit(X_train, y_train)
        train_models[name] = model

        # Step 2: Evaluate candidates on VALIDATION set
        val_pred = np.clip(model.predict(X_val), 0.0, 30.0)
        val_results[name] = compute_metrics(y_val, val_pred)

    print("\n" + "=" * 60)
    print("CANDIDATE MODEL EVALUATION ON VALIDATION SET (SELECTION)")
    print("=" * 60)
    print(format_comparison_table(val_results))
    print("=" * 60 + "\n")

    # Step 3: Select best model strictly using VALIDATION set MAE
    best_name = min(val_results.keys(), key=lambda k: val_results[k]["mae"])
    best_val_metrics = val_results[best_name]
    print(f"[ML-TRAIN] Best model selected on Validation set: '{best_name}' (Val MAE={best_val_metrics['mae']})")

    # Step 4: Fit selected model on Train + Validation for final testing
    if best_name == "Ridge_Regression":
        final_model = Ridge(alpha=1.0)
    elif best_name == "Random_Forest":
        final_model = RandomForestRegressor(n_estimators=50, max_depth=5, random_state=42)
    else:
        final_model = HistGradientBoostingRegressor(max_iter=50, max_depth=4, random_state=42)

    X_train_val = np.vstack([X_train, X_val])
    y_train_val = np.concatenate([y_train, y_val])
    final_model.fit(X_train_val, y_train_val)

    # Step 5: Evaluate chosen model on TEST set strictly ONCE
    test_pred = np.clip(final_model.predict(X_test), 0.0, 30.0)
    test_metrics = compute_metrics(y_test, test_pred)

    test_results = {best_name: test_metrics}

    print("\n" + "=" * 60)
    print(f"CHOSEN MODEL ('{best_name}') EVALUATION ON HELD-OUT TEST SET (EVALUATED ONCE)")
    print("=" * 60)
    print(format_comparison_table(test_results))
    print("=" * 60 + "\n")

    can_promote = (test_metrics.get("beats_baseline_5pct", False) and n_samples >= MIN_SAMPLES_REQUIRED) or force_save

    report = {
        "status": "COMPLETED",
        "sample_count": n_samples,
        "splits": {"train": len(X_train), "val": len(X_val), "test": len(X_test)},
        "baseline_lead_minutes": BASELINE_LEAD_MINUTES,
        "validation_results": val_results,
        "best_model_name": best_name,
        "best_val_metrics": best_val_metrics,
        "test_results": test_results,
        "test_metrics": test_metrics,
        "promoted": bool(can_promote),
        "promotion_reason": (
            f"Beats 11-min baseline MAE by >= 5% on Test set ({test_metrics.get('improvement_pct', 0.0):+.1f}%)"
            if can_promote else
            "Model does not beat 11-min baseline by 5% on held-out test set or insufficient samples. Dynamic statistical baseline remains active."
        )
    }

    with open(artifacts_dir / "training_report.json", "w", encoding="utf-8") as rf:
        json.dump(report, rf, indent=2)

    if can_promote:
        print(f"[ML-TRAIN] [PROMOTED] Gating Passed! Best model '{best_name}' achieves Test MAE={test_metrics['mae']} vs Baseline={test_metrics['baseline_mae']} ({test_metrics['improvement_pct']:+.1f}%).")
        model_path = artifacts_dir / "best_closure_model.joblib"
        meta_path = artifacts_dir / "model_metadata.json"

        joblib.dump(final_model, model_path)
        metadata = {
            "model_name": best_name,
            "feature_names": FEATURE_NAMES,
            "test_mae": test_metrics["mae"],
            "test_rmse": test_metrics["rmse"],
            "baseline_mae": test_metrics["baseline_mae"],
            "improvement_pct": test_metrics["improvement_pct"],
            "trained_on_samples": n_samples,
            "promoted": True,
            "version": "5.0.0"
        }
        with open(meta_path, "w", encoding="utf-8") as mf:
            json.dump(metadata, mf, indent=2)
        print(f"[ML-TRAIN] Saved model to {model_path} and metadata to {meta_path}")
    else:
        print(f"[ML-TRAIN] [GATE-HOLD] Gating Rule: Model '{best_name}' failed 5% improvement threshold. Safe fallback to Phase 2 dynamic statistical baseline.")

    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train FatakForecast closure lead time models")
    parser.add_argument("--data", type=str, default=str(DEFAULT_DATA_PATH), help="Path to matched-events.json")
    parser.add_argument("--artifacts", type=str, default=str(ARTIFACTS_DIR), help="Path to artifacts directory")
    parser.add_argument("--force", action="store_true", help="Force save model regardless of gating rule")
    args = parser.parse_args()

    train_and_evaluate(
        data_path=Path(args.data),
        artifacts_dir=Path(args.artifacts),
        force_save=args.force
    )
