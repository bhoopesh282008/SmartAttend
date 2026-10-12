"""Train, benchmark and save the at-risk attendance model.

    python train_atrisk.py

Question asked: given a student's attendance so far, will they finish the term below 75% of the
planned lectures? The answer is a probability that orders students for a lecturer to talk to; it
is not a verdict about anyone.

Part of the signal is plain arithmetic (a student who cannot reach 75% even by attending everything
that is left will finish below it). So the model is compared with two arithmetic baselines, and also
scored on the students who CAN still reach 75%, where arithmetic alone cannot decide.

The data is synthetic (see synth_terms.py). Splits are by student: nobody is in two sets.
"""
from __future__ import annotations

import hashlib
import json
import platform
from datetime import date

import joblib
import numpy as np
import sklearn
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

import config
import synth_terms as synth
from features import ATRISK_FEATURES, atrisk_vector

N_TRAIN, N_VAL, N_TEST = 6_000, 2_000, 4_000
SEEDS = {"train": config.SEED + 21, "val": config.SEED + 22, "test": config.SEED + 23}
TOP_SHARE = 0.15


def load_split(name: str, n: int):
    students = synth.generate_students(n, SEEDS[name])
    X = np.vstack([atrisk_vector(s.snapshot["attended"], s.snapshot["late"], s.snapshot["flags"], s.snapshot["planned"]) for s in students])
    y = np.array([s.label for s in students], dtype=np.int64)
    progress = np.array([s.held / s.planned for s in students])
    return students, X, y, progress


def build_models() -> dict[str, object]:
    return {
        "logistic_regression": Pipeline([("scaler", StandardScaler()), ("clf", LogisticRegression(max_iter=2000, C=1.0))]),
        "gradient_boosting": HistGradientBoostingClassifier(max_iter=200, learning_rate=0.1, random_state=config.SEED),
    }


def top_share_metrics(scores: np.ndarray, y: np.ndarray, share: float = TOP_SHARE) -> dict:
    k = max(1, int(round(share * len(y))))
    top = np.argsort(-scores)[:k]
    caught = int(y[top].sum())
    return {
        "precision": round(caught / k, 4),
        "recall": round(caught / max(1, int(y.sum())), 4),
    }


def auc_or_none(y: np.ndarray, scores: np.ndarray):
    return round(float(roc_auc_score(y, scores)), 4) if len(set(y.tolist())) == 2 else None


def evaluate(scores: np.ndarray, y: np.ndarray, X: np.ndarray, progress: np.ndarray) -> dict:
    slack = X[:, ATRISK_FEATURES.index("slack_fraction")]
    reachable = slack >= 0
    bins = np.quantile(scores, np.linspace(0, 1, 6))
    calibration = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        mask = (scores >= lo) & (scores <= hi)
        calibration.append({"predicted": round(float(scores[mask].mean()), 3), "actual": round(float(y[mask].mean()), 3), "n": int(mask.sum())})
    bands = {}
    for name, lo, hi in (("low", 0.0, config.ATRISK_WATCH), ("watch", config.ATRISK_WATCH, config.ATRISK_HIGH), ("high", config.ATRISK_HIGH, 1.01)):
        mask = (scores >= lo) & (scores < hi)
        bands[name] = {"share_of_students": round(float(mask.mean()), 4), "finished_below_75": round(float(y[mask].mean()), 4) if mask.any() else None}
    by_progress = []
    for lo, hi, label in ((0.0, 0.30, "early (under 30% of term)"), (0.30, 0.45, "middle (30% to 45%)"), (0.45, 1.0, "later (over 45%)")):
        mask = (progress >= lo) & (progress < hi)
        by_progress.append({"snapshot": label, "n": int(mask.sum()), "roc_auc": auc_or_none(y[mask], scores[mask])})
    return {
        "roc_auc": round(float(roc_auc_score(y, scores)), 4),
        "pr_auc": round(float(average_precision_score(y, scores)), 4),
        "brier": round(float(brier_score_loss(y, scores)), 4),
        "top15": top_share_metrics(scores, y),
        "roc_auc_still_reachable": auc_or_none(y[reachable], scores[reachable]),
        "share_still_reachable": round(float(reachable.mean()), 4),
        "calibration": calibration,
        "bands": bands,
        "by_progress": by_progress,
    }


def model_version(pipeline: Pipeline) -> str:
    scaler, clf = pipeline.named_steps["scaler"], pipeline.named_steps["clf"]
    payload = {
        "coef": [round(float(c), 8) for c in clf.coef_[0]],
        "intercept": round(float(clf.intercept_[0]), 8),
        "mean": [round(float(m), 8) for m in scaler.mean_],
        "scale": [round(float(s), 8) for s in scaler.scale_],
    }
    return "atrisk-lr-" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:8]


def main() -> dict:
    config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    _, X_train, y_train, _ = load_split("train", N_TRAIN)
    _, X_test, y_test, progress_test = load_split("test", N_TEST)

    models = build_models()
    for model in models.values():
        model.fit(X_train, y_train)

    lr = models["logistic_regression"]
    scores = lr.predict_proba(X_test)[:, 1]
    headline = evaluate(scores, y_test, X_test, progress_test)

    pct = X_test[:, ATRISK_FEATURES.index("pct_so_far")]
    slack = X_test[:, ATRISK_FEATURES.index("slack_fraction")]
    reachable = slack >= 0
    gb_scores = models["gradient_boosting"].predict_proba(X_test)[:, 1]
    comparison = [
        {"method": "logistic regression (ships)", "roc_auc": headline["roc_auc"], "roc_auc_still_reachable": headline["roc_auc_still_reachable"], "top15": headline["top15"]},
        {"method": "gradient boosting", "roc_auc": auc_or_none(y_test, gb_scores), "roc_auc_still_reachable": auc_or_none(y_test[reachable], gb_scores[reachable]), "top15": top_share_metrics(gb_scores, y_test)},
        {"method": "rule: attendance so far below 75%", "roc_auc": auc_or_none(y_test, 1.0 - pct), "roc_auc_still_reachable": auc_or_none(y_test[reachable], (1.0 - pct)[reachable]), "top15": top_share_metrics(1.0 - pct, y_test)},
        {"method": "arithmetic: classes still missable", "roc_auc": auc_or_none(y_test, -slack), "roc_auc_still_reachable": auc_or_none(y_test[reachable], (-slack)[reachable]), "top15": top_share_metrics(-slack, y_test)},
    ]

    version = model_version(lr)
    clf, scaler = lr.named_steps["clf"], lr.named_steps["scaler"]
    metrics = {
        "version": version,
        "trained_on": str(date.today()),
        "libraries": {"python": platform.python_version(), "scikit_learn": sklearn.__version__, "numpy": np.__version__},
        "data": {
            "synthetic": True,
            "statement": "Trained and tested on SYNTHETIC student terms generated from written-down assumptions. No real attendance records were used. These numbers describe the method in an invented world, not accuracy on real classes.",
            "seeds": SEEDS,
            "sizes": {"train": N_TRAIN, "test": N_TEST},
            "split": "by student: each student appears in exactly one set",
            "leakage_control": "features use only lectures already held; the label (finishes below 75%) comes from the full term",
            "prevalence_test": round(float(y_test.mean()), 4),
            "assumptions": synth.ASSUMPTIONS,
        },
        "features": ATRISK_FEATURES,
        "bands": {"high_from": config.ATRISK_HIGH, "watch_from": config.ATRISK_WATCH},
        "test": headline,
        "comparison": comparison,
        "coefficients": [
            {"feature": name, "coefficient": round(float(c), 4), "training_mean": round(float(m), 4), "training_spread": round(float(s), 4)}
            for name, c, m, s in zip(ATRISK_FEATURES, clf.coef_[0], scaler.mean_, scaler.scale_)
        ],
        "intercept": round(float(clf.intercept_[0]), 4),
        "limits": [
            "Part of the signal is arithmetic: a student who cannot reach 75% will finish below it. The model's added value is on students who still can.",
            "The synthetic world has no illness, exams or timetable clashes beyond 'absences stick'; real terms are messier.",
            "The probability is calibrated only against the synthetic terms. Use it to order students for a conversation, never as a verdict.",
            "Fewer than 4 closed lectures is not enough to say anything, and no estimate is made.",
        ],
    }
    joblib.dump({"pipeline": lr, "features": ATRISK_FEATURES, "version": version}, config.ATRISK_MODEL)
    config.ATRISK_METRICS.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    return metrics


def evaluate_saved() -> dict:
    saved = joblib.load(config.ATRISK_MODEL)
    _, X_test, y_test, progress_test = load_split("test", N_TEST)
    return evaluate(saved["pipeline"].predict_proba(X_test)[:, 1], y_test, X_test, progress_test)


if __name__ == "__main__":
    result = main()
    t = result["test"]
    print(f"Saved {config.ATRISK_MODEL.name} ({result['version']}) and {config.ATRISK_METRICS.name}")
    print(f"Test prevalence (finish below 75%): {result['data']['prevalence_test']:.1%}\n")
    print(f"{'method':<40}{'ROC-AUC':>9}{'AUC reachable':>15}{'top15 prec':>12}{'top15 recall':>14}")
    for row in result["comparison"]:
        print(f"{row['method']:<40}{row['roc_auc']:>9.3f}{row['roc_auc_still_reachable']:>15.3f}{row['top15']['precision']:>12.3f}{row['top15']['recall']:>14.3f}")
    print(f"\nBrier {t['brier']}  |  students still able to reach 75%: {t['share_still_reachable']:.1%}")
    print("Bands:", {k: v for k, v in t["bands"].items()})
    print("By snapshot:", [(r["snapshot"], r["roc_auc"]) for r in t["by_progress"]])
