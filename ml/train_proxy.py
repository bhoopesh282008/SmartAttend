"""Train, benchmark and save the proxy-marking risk model.

    python train_proxy.py

Logistic regression is the model that ships, on purpose: its score is a sum, so each scan can be
explained in plain words, and a human has to act on every flag. Random forest and gradient boosting
are trained alongside as benchmarks; if they were much better, the table would say so.

Method, in the order it was fixed (nothing below was tuned on the test split):
  1. three independent synthetic datasets from three seeds: train, validation, test
  2. the alert threshold is chosen on VALIDATION as the score that sends at most 3% of honest
     scans to review
  3. the test split is touched once, to report numbers

The data is synthetic (see synth_scans.py). These numbers describe the method in an invented world.
"""
from __future__ import annotations

import hashlib
import json
import platform
from datetime import date

import joblib
import numpy as np
import sklearn
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

import config
import synth_scans as synth
from features import PROXY_FEATURES, proxy_matrix

N_TRAIN, N_VAL, N_TEST = 40_000, 15_000, 15_000
SEEDS = {"train": config.SEED + 11, "val": config.SEED + 12, "test": config.SEED + 13}
RULE_RADIUS_M = 150.0  # the radius the server's rules use by default


def rules_flag(raw: dict) -> bool:
    """What the server's rules alone would send to review (for comparison with the model)."""
    status = raw["location_status"]
    if status == "missing":
        return True
    if status == "ok":
        accuracy = raw["accuracy_m"] if raw["accuracy_m"] is not None else float("inf")
        if accuracy > 100 or (raw["distance_m"] - accuracy) > RULE_RADIUS_M:
            return True
    return raw["device_shared_count"] > 0


def build_models() -> dict[str, object]:
    return {
        "logistic_regression": Pipeline(
            [("scaler", StandardScaler()), ("clf", LogisticRegression(max_iter=2000, C=1.0))]
        ),
        "random_forest": RandomForestClassifier(
            n_estimators=200, min_samples_leaf=5, n_jobs=-1, random_state=config.SEED
        ),
        "gradient_boosting": HistGradientBoostingClassifier(
            max_iter=200, learning_rate=0.1, random_state=config.SEED
        ),
    }


def load_split(name: str, n: int):
    data = synth.generate_scans(n, SEEDS[name])
    return data, proxy_matrix(data.rows)


def score(model, X: np.ndarray) -> np.ndarray:
    return model.predict_proba(X)[:, 1]


def pick_threshold(val_scores: np.ndarray, val_y: np.ndarray) -> float:
    """Lowest score that still keeps honest validation scans flagged at no more than the cap."""
    honest = val_scores[val_y == 0]
    return float(np.quantile(honest, 1.0 - config.HONEST_FALSE_REVIEW_CAP))


def summarize(scores: np.ndarray, y: np.ndarray, threshold: float) -> dict:
    flagged = scores >= threshold
    proxies, honest = y == 1, y == 0
    tp = int((flagged & proxies).sum())
    fp = int((flagged & honest).sum())
    return {
        "roc_auc": round(float(roc_auc_score(y, scores)), 4),
        "pr_auc": round(float(average_precision_score(y, scores)), 4),
        "threshold": round(threshold, 4),
        "false_review_rate": round(fp / max(1, int(honest.sum())), 4),
        "recall": round(tp / max(1, int(proxies.sum())), 4),
        "precision": round(tp / max(1, tp + fp), 4),
        "flagged_share": round(float(flagged.mean()), 4),
    }


def scenario_table(scores: np.ndarray, data: synth.ScanSet, threshold: float) -> list[dict]:
    rows = []
    for name in list(synth.HONEST_SCENARIOS) + list(synth.PROXY_SCENARIOS):
        mask = data.scenario == name
        if not mask.any():
            continue
        proxy = name in synth.PROXY_SCENARIOS
        rows.append(
            {
                "scenario": name,
                "kind": "proxy" if proxy else "honest",
                "n": int(mask.sum()),
                # for proxies this is recall (share caught); for honest scans a false-review rate
                "flagged_rate": round(float((scores[mask] >= threshold).mean()), 4),
            }
        )
    return rows


def model_version(pipeline: Pipeline) -> str:
    scaler, clf = pipeline.named_steps["scaler"], pipeline.named_steps["clf"]
    payload = {
        "coef": [round(float(c), 8) for c in clf.coef_[0]],
        "intercept": round(float(clf.intercept_[0]), 8),
        "mean": [round(float(m), 8) for m in scaler.mean_],
        "scale": [round(float(s), 8) for s in scaler.scale_],
    }
    return "proxy-lr-" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:8]


def coefficient_table(pipeline: Pipeline) -> list[dict]:
    scaler, clf = pipeline.named_steps["scaler"], pipeline.named_steps["clf"]
    return [
        {"feature": name, "coefficient": round(float(c), 4), "training_mean": round(float(m), 4), "training_spread": round(float(s), 4)}
        for name, c, m, s in zip(PROXY_FEATURES, clf.coef_[0], scaler.mean_, scaler.scale_)
    ]


def main() -> dict:
    config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    train, X_train = load_split("train", N_TRAIN)
    val, X_val = load_split("val", N_VAL)
    test, X_test = load_split("test", N_TEST)

    models = build_models()
    benchmark = []
    chosen = {}
    for name, model in models.items():
        model.fit(X_train, train.y)
        threshold = pick_threshold(score(model, X_val), val.y)
        test_scores = score(model, X_test)
        benchmark.append({"model": name, **summarize(test_scores, test.y, threshold)})
        chosen[name] = (threshold, test_scores)

    lr = models["logistic_regression"]
    lr_threshold, lr_scores = chosen["logistic_regression"]
    version = model_version(lr)

    rules = np.array([rules_flag(row) for row in test.rows])
    rules_baseline = {
        "false_review_rate": round(float(rules[test.y == 0].mean()), 4),
        "recall": round(float(rules[test.y == 1].mean()), 4),
        "flagged_share": round(float(rules.mean()), 4),
    }

    # Fair comparison with the rules: give the model the same false-review budget the rules use
    # (budget and threshold both taken from the validation split, then applied to test once).
    val_rules = np.array([rules_flag(row) for row in val.rows])
    budget = float(val_rules[val.y == 0].mean())
    matched_threshold = float(np.quantile(score(lr, X_val)[val.y == 0], 1.0 - budget))
    matched = summarize(lr_scores, test.y, matched_threshold)

    # What the SERVER actually does: the rules and the model both run, and a scan goes to review if
    # either flags it. So its honest false-review rate is higher than the model's own 3% cap.
    together = rules | (lr_scores >= lr_threshold)
    combined = {
        "false_review_rate": round(float(together[test.y == 0].mean()), 4),
        "recall": round(float(together[test.y == 1].mean()), 4),
        "flagged_share": round(float(together.mean()), 4),
        "note": "The server sends a scan to review if the rules OR the model flag it. Most honest scans reviewed here come from the rules (a missing or imprecise location, a phone used by another student).",
    }

    metrics = {
        "version": version,
        "trained_on": str(date.today()),
        "libraries": {"python": platform.python_version(), "scikit_learn": sklearn.__version__, "numpy": np.__version__},
        "data": {
            "synthetic": True,
            "statement": "Trained and tested on SYNTHETIC scans generated from written-down assumptions. No real attendance or proxy-marking data was used. These numbers describe the method in an invented world, not accuracy on real classes.",
            "seeds": SEEDS,
            "sizes": {"train": N_TRAIN, "validation": N_VAL, "test": N_TEST},
            "proxy_prior": synth.PROXY_PRIOR,
            "assumptions": synth.ASSUMPTIONS,
        },
        "features": PROXY_FEATURES,
        "honest_false_review_cap": config.HONEST_FALSE_REVIEW_CAP,
        "threshold": round(lr_threshold, 6),
        "test": next(row for row in benchmark if row["model"] == "logistic_regression"),
        "benchmark": benchmark,
        "rules_only_baseline": {**rules_baseline, "note": f"The server's rules alone (location grey zone beyond {RULE_RADIUS_M:.0f} m, imprecise or missing location, a device used by another student), on the same test scans."},
        "rules_and_model_together": combined,
        "matched_budget": {
            "false_review_budget": round(budget, 4),
            "model_recall": matched["recall"],
            "model_false_review_rate": matched["false_review_rate"],
            "rules_recall": rules_baseline["recall"],
            "rules_false_review_rate": rules_baseline["false_review_rate"],
            "note": "The model given the same share of honest scans sent to review as the rules use. Budget and threshold come from validation data.",
        },
        "development_notes": [
            "Logistic regression ships for its readable reasons. Gradient boosting scores higher in this synthetic world (see the benchmark); the gap is the price of explanations.",
            "Extra features (a lecture-start burst indicator, new device x shared device, late-scan curvature, a face distance above 0.55) were tried on the validation split. The best combination gained about 5 points of recall at the 3% cap and none closed the gap, so they were not adopted: gains that small on invented data are as likely to fit the generator as the problem.",
            "Honest students with a new phone or a phone shared with a flatmate are flagged far more often than other honest students (see scenarios). They go to a review queue, never to rejection.",
        ],
        "scenarios": scenario_table(lr_scores, test, lr_threshold),
        "coefficients": coefficient_table(lr),
        "intercept": round(float(lr.named_steps["clf"].intercept_[0]), 4),
        "limits": [
            "A proxy who is physically in the room and uses a second phone is caught mainly through device history; recall for that scenario is low.",
            "Timing is a weak signal: honest students scan at any moment while a code is on screen.",
            "GPS can be spoofed and a web page cannot detect it; the model only sees what the browser reports.",
            "Face distance has no liveness check, so a photo of a face can pass.",
            "The score is a risk score under the synthetic prior, not the probability that a real student cheated. It only orders scans for a human to review.",
        ],
    }

    joblib.dump({"pipeline": lr, "features": PROXY_FEATURES, "threshold": lr_threshold, "version": version}, config.PROXY_MODEL)
    config.PROXY_METRICS.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    return metrics


def evaluate_saved() -> dict:
    """Recompute the headline test numbers from the saved model and a regenerated test set."""
    saved = joblib.load(config.PROXY_MODEL)
    test, X_test = load_split("test", N_TEST)
    return summarize(score(saved["pipeline"], X_test), test.y, saved["threshold"])


if __name__ == "__main__":
    result = main()
    print(f"Saved {config.PROXY_MODEL.name} ({result['version']}) and {config.PROXY_METRICS.name}\n")
    print(f"{'model':<22}{'ROC-AUC':>9}{'PR-AUC':>9}{'false-review':>14}{'recall':>9}{'precision':>11}")
    for row in result["benchmark"]:
        print(f"{row['model']:<22}{row['roc_auc']:>9.3f}{row['pr_auc']:>9.3f}{row['false_review_rate']:>14.3f}{row['recall']:>9.3f}{row['precision']:>11.3f}")
    rb = result["rules_only_baseline"]
    print(f"{'rules only (server)':<22}{'':>9}{'':>9}{rb['false_review_rate']:>14.3f}{rb['recall']:>9.3f}")
    mb = result["matched_budget"]
    print(f"{'model, same budget':<22}{'':>9}{'':>9}{mb['model_false_review_rate']:>14.3f}{mb['model_recall']:>9.3f}")
    rt = result["rules_and_model_together"]
    print(f"{'rules + model (server)':<22}{'':>9}{'':>9}{rt['false_review_rate']:>14.3f}{rt['recall']:>9.3f}")
    print("\nBy scenario (flagged rate; recall for proxy scenarios, false-review rate for honest):")
    for row in result["scenarios"]:
        print(f"  {row['kind']:<7}{row['scenario']:<24}n={row['n']:<6}{row['flagged_rate']:.3f}")
