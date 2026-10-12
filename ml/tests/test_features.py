import math

import numpy as np
import pytest

from features import ATRISK_FEATURES, PROXY_FEATURES, atrisk_vector, can_still_miss, proxy_matrix, proxy_vector

OK_SCAN = {
    "token_age_s": 30.0, "location_status": "ok", "distance_m": 100.0, "accuracy_m": 20.0,
    "device_shared_count": 0, "new_device_for_student": False, "scan_burst_count": 0, "face_distance": None,
}
col = {name: i for i, name in enumerate(PROXY_FEATURES)}


def test_golden_vector():
    v = proxy_vector({**OK_SCAN, "device_shared_count": 2, "new_device_for_student": True, "scan_burst_count": 3, "face_distance": 0.5})
    assert v[col["token_age"]] == pytest.approx(0.5)
    assert v[col["excess_distance"]] == pytest.approx(math.log1p(80.0))   # 100 m minus 20 m GPS error
    assert v[col["gps_error"]] == pytest.approx(math.log1p(20.0))
    assert v[col["location_missing"]] == 0
    assert v[col["device_shared"]] == 2
    assert v[col["new_device"]] == 1
    assert v[col["scan_burst"]] == pytest.approx(math.log1p(3))
    assert v[col["face_distance"]] == pytest.approx(0.5)
    assert v[col["face_missing"]] == 0


def test_accuracy_is_subtracted_so_a_vague_fix_cannot_look_far():
    vague = proxy_vector({**OK_SCAN, "distance_m": 100.0, "accuracy_m": 150.0})
    good = proxy_vector({**OK_SCAN, "distance_m": 100.0, "accuracy_m": 10.0})
    assert vague[col["excess_distance"]] == 0
    assert good[col["excess_distance"]] > vague[col["excess_distance"]]


def test_missing_is_not_zero():
    """A missing location must not look like a perfect (distance 0) one, nor like 'not checked'."""
    perfect = proxy_vector({**OK_SCAN, "distance_m": 0.0, "accuracy_m": 5.0})
    missing = proxy_vector({**OK_SCAN, "location_status": "missing", "distance_m": None, "accuracy_m": None})
    skipped = proxy_vector({**OK_SCAN, "location_status": "not_checked", "distance_m": None, "accuracy_m": None})
    assert missing[col["location_missing"]] == 1
    assert skipped[col["location_missing"]] == 0
    assert not np.array_equal(missing, perfect)
    # the neutral stand-ins are the same constant for both, so only the indicator tells them apart
    assert missing[col["gps_error"]] == skipped[col["gps_error"]]


def test_no_face_check_is_flagged_not_a_perfect_match():
    none = proxy_vector({**OK_SCAN, "face_distance": None})
    perfect = proxy_vector({**OK_SCAN, "face_distance": 0.0})
    assert none[col["face_missing"]] == 1 and perfect[col["face_missing"]] == 0
    assert none[col["face_distance"]] != perfect[col["face_distance"]]


def test_unknown_location_status_is_refused():
    with pytest.raises(ValueError):
        proxy_vector({**OK_SCAN, "location_status": "gps"})


def test_odd_values_are_clamped_not_crashing():
    v = proxy_vector({**OK_SCAN, "token_age_s": 9999, "device_shared_count": 400, "scan_burst_count": 10**6, "accuracy_m": 1e9})
    assert v[col["token_age"]] == 2.0
    assert v[col["device_shared"]] == 5
    assert np.isfinite(v).all()


def test_matrix_equals_row_by_row():
    rows = [OK_SCAN, {**OK_SCAN, "location_status": "missing", "distance_m": None}, {**OK_SCAN, "face_distance": 0.9}]
    matrix = proxy_matrix(rows)
    assert matrix.shape == (3, len(PROXY_FEATURES))
    for i, row in enumerate(rows):
        assert np.array_equal(matrix[i], proxy_vector(row))


def test_can_still_miss_matches_the_server_arithmetic():
    # the same cases the Node tests check
    assert can_still_miss(6, 8, 40) == 8
    assert can_still_miss(2, 10, 40) == 2
    assert can_still_miss(0, 20, 40) == -10
    assert can_still_miss(30, 45, 40) == 0


def test_atrisk_golden_vector():
    a = [1, 1, 0, 0, 1, 0, 1, 1, 0]
    late = [0, 1, 0, 0, 0, 0, 0, 1, 0]
    v = dict(zip(ATRISK_FEATURES, atrisk_vector(a, late, flags=2, planned=30)))
    assert v["pct_so_far"] == pytest.approx(5 / 9)
    assert v["pct_last3"] == pytest.approx(2 / 3)
    assert v["longest_absence_streak"] == 2
    assert v["current_absence_streak"] == 1
    assert v["late_share"] == pytest.approx(2 / 5)
    assert v["flags_per_10"] == pytest.approx(2 / 9 * 10)
    assert v["progress"] == pytest.approx(9 / 30)
    assert v["slack_fraction"] == pytest.approx(can_still_miss(5, 9, 30) / 30)
    # trend: last third (1,1,0 -> 2/3) minus first third (1,1,0 -> 2/3) = 0
    assert v["trend"] == pytest.approx(0.0)


def test_atrisk_only_reads_the_lectures_given():
    """Nothing about lectures not yet held can leak in: the vector depends only on its inputs."""
    a, late = [1, 0, 1, 1, 0, 1], [0, 0, 0, 1, 0, 0]
    same = atrisk_vector(a, late, 0, 30)
    assert np.array_equal(same, atrisk_vector(list(a), list(late), 0, 30))


def test_atrisk_needs_at_least_one_lecture():
    with pytest.raises(ValueError):
        atrisk_vector([], [], 0, 30)
