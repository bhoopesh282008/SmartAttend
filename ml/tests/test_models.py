"""The saved models, their reported numbers, and the explanations built from them."""
import json
import math

import joblib
import numpy as np
import pytest

import config
import synth_scans
import synth_terms
import train_atrisk
import train_proxy
from explain import contributions, proxy_reasons
from features import atrisk_vector, proxy_vector

pytestmark = pytest.mark.skipif(not config.PROXY_MODEL.exists(), reason="models not trained: run train_proxy.py and train_atrisk.py")

HONEST = {
    "token_age_s": 14.0, "location_status": "ok", "distance_m": 30.0, "accuracy_m": 10.0,
    "device_shared_count": 0, "new_device_for_student": False, "scan_burst_count": 0, "face_distance": None,
}
RELAY = {
    "token_age_s": 49.0, "location_status": "ok", "distance_m": 2200.0, "accuracy_m": 15.0,
    "device_shared_count": 1, "new_device_for_student": True, "scan_burst_count": 0, "face_distance": None,
}


@pytest.fixture(scope="module")
def proxy():
    return joblib.load(config.PROXY_MODEL)


@pytest.fixture(scope="module")
def proxy_metrics():
    return json.loads(config.PROXY_METRICS.read_text(encoding="utf-8"))


def risk_of(saved, raw):
    return float(saved["pipeline"].predict_proba(proxy_vector(raw).reshape(1, -1))[0, 1])


def test_honest_scan_scores_below_the_threshold_and_a_relay_above(proxy):
    assert risk_of(proxy, HONEST) < proxy["threshold"]
    assert risk_of(proxy, RELAY) >= proxy["threshold"]


def test_missing_location_scores_higher_than_a_good_in_room_fix(proxy):
    missing = {**HONEST, "location_status": "missing", "distance_m": None, "accuracy_m": None}
    assert risk_of(proxy, missing) > risk_of(proxy, HONEST)


def test_reasons_are_the_arithmetic_of_the_score(proxy):
    """intercept + sum of contributions equals the model's log-odds exactly, so the reasons add up."""
    pipeline = proxy["pipeline"]
    x = proxy_vector(RELAY)
    contrib = contributions(pipeline, x)
    p = risk_of(proxy, RELAY)
    assert pipeline.named_steps["clf"].intercept_[0] + contrib.sum() == pytest.approx(math.log(p / (1 - p)), abs=1e-9)


def test_the_relay_is_explained_in_words(proxy):
    x = proxy_vector(RELAY)
    reasons = proxy_reasons(RELAY, contributions(proxy["pipeline"], x))
    codes = [r["code"] for r in reasons]
    assert 1 <= len(reasons) <= 3
    assert "outside_room" in codes
    assert all(r["text"] and r["weight"] >= 0.1 for r in reasons)
    assert reasons == sorted(reasons, key=lambda r: -r["weight"])


def test_reported_proxy_numbers_can_be_recomputed(proxy_metrics):
    again = train_proxy.evaluate_saved()
    for key in ("roc_auc", "pr_auc", "false_review_rate", "recall", "precision"):
        assert again[key] == pytest.approx(proxy_metrics["test"][key], abs=1e-3), key
    assert proxy_metrics["version"] == joblib.load(config.PROXY_MODEL)["version"]


def test_the_false_review_cap_held_on_the_test_split(proxy_metrics):
    cap = proxy_metrics["honest_false_review_cap"]
    assert proxy_metrics["test"]["false_review_rate"] <= cap + 0.01


def test_model_says_its_data_is_synthetic(proxy_metrics):
    assert proxy_metrics["data"]["synthetic"] is True
    assert "SYNTHETIC" in proxy_metrics["data"]["statement"]


def test_reported_at_risk_numbers_can_be_recomputed():
    metrics = json.loads(config.ATRISK_METRICS.read_text(encoding="utf-8"))
    again = train_atrisk.evaluate_saved()
    assert again["roc_auc"] == pytest.approx(metrics["test"]["roc_auc"], abs=1e-3)
    assert again["brier"] == pytest.approx(metrics["test"]["brier"], abs=1e-3)
    assert metrics["data"]["synthetic"] is True


def test_atrisk_bands_are_ordered():
    """Higher bands really are riskier, on the held-out students."""
    bands = json.loads(config.ATRISK_METRICS.read_text(encoding="utf-8"))["test"]["bands"]
    assert bands["low"]["finished_below_75"] < bands["watch"]["finished_below_75"] < bands["high"]["finished_below_75"]


def test_atrisk_splits_hold_different_students_and_use_only_the_past():
    train = synth_terms.generate_students(50, train_atrisk.SEEDS["train"])
    test = synth_terms.generate_students(50, train_atrisk.SEEDS["test"])
    assert [s.attended for s in train] != [s.attended for s in test]
    s = train[0]
    # features are built from the first `held` lectures only
    assert len(s.snapshot["attended"]) == s.held < s.planned
    shuffled_future = s.attended[:s.held] + [1 - a for a in s.attended[s.held:]]
    assert np.array_equal(
        atrisk_vector(s.snapshot["attended"], s.snapshot["late"], s.snapshot["flags"], s.planned),
        atrisk_vector(shuffled_future[:s.held], s.late[:s.held], s.snapshot["flags"], s.planned),
    )


def test_scan_generator_is_reproducible_and_has_hard_negatives():
    a = synth_scans.generate_scans(3000, 7)
    b = synth_scans.generate_scans(3000, 7)
    c = synth_scans.generate_scans(3000, 8)
    assert a.rows == b.rows and (a.y == b.y).all()
    assert a.rows != c.rows
    assert 0.05 < a.y.mean() < 0.11
    names = set(a.scenario.tolist())
    assert {"honest_poor_gps", "honest_burst", "honest_shared_phone"} <= names


def test_lateness_is_not_a_reason_over_one_or_two_lectures():
    """'Late at 100%' after a single attended lecture is noise, so it is never given as a reason."""
    from explain import atrisk_reasons
    from features import ATRISK_FEATURES

    contrib = np.zeros(len(ATRISK_FEATURES))
    contrib[ATRISK_FEATURES.index("late_share")] = 5.0
    once = atrisk_vector([0, 0, 0, 0, 0, 0, 1, 0], [0, 0, 0, 0, 0, 0, 1, 0], 0, 40)
    assert atrisk_reasons(once, 0, 40, 8, contrib) == []
    often = atrisk_vector([1, 1, 1, 0, 0, 0, 0, 0], [1, 1, 1, 0, 0, 0, 0, 0], 0, 40)
    reasons = atrisk_reasons(often, 0, 40, 8, contrib)
    assert [r["code"] for r in reasons] == ["often_late"]
    assert "3 lectures attended" in reasons[0]["text"]


def test_a_reason_is_only_offered_when_the_raw_value_is_notable(proxy):
    """A second phone, scanning late, 30 m from the room: the distance is NOT a reason (limit is 150 m)."""
    raw = {
        "token_age_s": 52.0, "location_status": "ok", "distance_m": 30.0, "accuracy_m": 10.0,
        "device_shared_count": 0, "new_device_for_student": True, "scan_burst_count": 0, "face_distance": None,
    }
    x = proxy_vector(raw)
    reasons = proxy_reasons(raw, contributions(proxy["pipeline"], x))
    codes = [r["code"] for r in reasons]
    assert "new_device" in codes and "late_scan" in codes
    assert "outside_room" not in codes and "location_imprecise" not in codes


def test_unremarkable_values_give_no_reasons_even_with_a_big_contribution(proxy):
    raw = {
        "token_age_s": 10.0, "location_status": "ok", "distance_m": 20.0, "accuracy_m": 10.0,
        "device_shared_count": 0, "new_device_for_student": False, "scan_burst_count": 1, "face_distance": 0.4,
    }
    huge = np.full(len(proxy["features"]), 5.0)
    assert proxy_reasons(raw, huge) == []
