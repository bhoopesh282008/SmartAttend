"""Paths, seeds and the few numbers that define the models' behaviour."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODELS_DIR = ROOT / "models"

PROXY_MODEL = MODELS_DIR / "proxy_model.joblib"
PROXY_METRICS = MODELS_DIR / "proxy_metrics.json"
ATRISK_MODEL = MODELS_DIR / "atrisk_model.joblib"
ATRISK_METRICS = MODELS_DIR / "atrisk_metrics.json"

# Every random choice in data generation and training comes from a seed derived from this one,
# so a re-run reproduces the saved models and the numbers in the metrics files exactly.
SEED = 2026

# The proxy-risk threshold is chosen on validation data so that at most this share of HONEST
# scans is sent to faculty review. Set before looking at the test split.
HONEST_FALSE_REVIEW_CAP = 0.03

# At-risk probability bands shown to faculty.
ATRISK_HIGH = 0.60
ATRISK_WATCH = 0.35
ATTENDANCE_TARGET = 0.75
# A scan more than this long after the lecture started counts as "late" (kept in step with the server).
LATE_AFTER_MINUTES = 10
# Fewer closed lectures than this is not enough to say anything.
MIN_LECTURES_FOR_RISK = 4
