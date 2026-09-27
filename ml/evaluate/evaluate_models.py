"""
FatakForecast V5 — Model Evaluation Framework
Evaluates regression models on gate closure lead time against the 11-minute baseline benchmark.
"""

from typing import Dict, Any, List
import numpy as np
from sklearn.metrics import mean_absolute_error, root_mean_squared_error, r2_score, median_absolute_error

BASELINE_LEAD_MINUTES = 11.0


def compute_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> Dict[str, Any]:
    """Compute comprehensive regression metrics including error percentiles."""
    if len(y_true) == 0:
        return {}

    errors = np.abs(y_true - y_pred)
    mae = float(mean_absolute_error(y_true, y_pred))
    rmse = float(root_mean_squared_error(y_true, y_pred))
    medae = float(median_absolute_error(y_true, y_pred))
    p25 = float(np.percentile(errors, 25))
    p75 = float(np.percentile(errors, 75))

    try:
        r2 = float(r2_score(y_true, y_pred))
    except Exception:
        r2 = 0.0

    # Baseline comparison (11-min prior)
    y_baseline = np.full_like(y_true, fill_value=BASELINE_LEAD_MINUTES)
    base_errors = np.abs(y_true - y_baseline)
    base_mae = float(mean_absolute_error(y_true, y_baseline))
    base_rmse = float(root_mean_squared_error(y_true, y_baseline))
    base_medae = float(median_absolute_error(y_true, y_baseline))

    improvement_pct = ((base_mae - mae) / base_mae * 100.0) if base_mae > 0 else 0.0
    beats_baseline = mae < (base_mae * 0.95)  # Strict >= 5% better requirement

    return {
        "samples": int(len(y_true)),
        "mae": round(mae, 3),
        "rmse": round(rmse, 3),
        "r2": round(r2, 3),
        "median_ae": round(medae, 3),
        "p25_error": round(p25, 3),
        "p75_error": round(p75, 3),
        "baseline_mae": round(base_mae, 3),
        "baseline_rmse": round(base_rmse, 3),
        "baseline_medae": round(base_medae, 3),
        "improvement_pct": round(improvement_pct, 2),
        "beats_baseline_5pct": bool(beats_baseline)
    }


def format_comparison_table(results: Dict[str, Dict[str, Any]]) -> str:
    """Format markdown comparison table of candidate models against baseline."""
    lines = [
        "| Model | MAE (min) | RMSE (min) | MedAE (min) | R² | vs Baseline MAE | Beats Baseline (>=5%) |",
        "| :--- | :---: | :---: | :---: | :---: | :---: | :---: |"
    ]

    for model_name, metrics in results.items():
        mae_str = f"{metrics.get('mae', 'N/A')}"
        rmse_str = f"{metrics.get('rmse', 'N/A')}"
        med_str = f"{metrics.get('median_ae', 'N/A')}"
        r2_str = f"{metrics.get('r2', 'N/A')}"
        imp_str = f"{metrics.get('improvement_pct', 0.0):+.1f}%"
        beats_str = "YES" if metrics.get("beats_baseline_5pct") else "NO"
        lines.append(f"| {model_name} | {mae_str} | {rmse_str} | {med_str} | {r2_str} | {imp_str} | {beats_str} |")

    return "\n".join(lines)
