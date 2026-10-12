"""Feature definitions, written once and used by BOTH training and serving.

If training and serving ever computed a feature differently, the model would be scored on
inputs it never saw. So there is exactly one function per model (`proxy_vector`,
`atrisk_vector`); the training scripts and the web service both call it, and a test checks
that the matrix used for training equals what the service builds for the same raw input.

Missing is not zero: a value that was not measured is replaced by a fixed, documented
neutral constant AND flagged with its own indicator feature, so the model never reads
"no location" as "distance 0" or "no face check" as "perfect match".
"""
from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

import numpy as np

from config import ATTENDANCE_TARGET

# --- neutral values for things that were not measured --------------------------------------
NEUTRAL_TOKEN_AGE_S = 30.0       # age of the code when the scan arrived (always known in practice)
NEUTRAL_GPS_ERROR_M = 20.0       # typical good phone fix; used when location was not checked/shared
NEUTRAL_FACE_DISTANCE = 0.45     # typical same-person distance; used when no face check was done
GPS_UNKNOWN_ERROR_M = 1000.0     # a position arrived but no accuracy: treat it as unusable
CODE_LIFE_S = 60.0

# ================================================================================================
# 1. Proxy-marking risk (one feature row per scan)
# ================================================================================================
PROXY_FEATURES = [
    "token_age",            # how late in the code's 60 s life the scan came (0..1+)
    "excess_distance",      # log(1 + metres from the room beyond the GPS error)
    "gps_error",            # log(1 + reported GPS accuracy in metres)
    "location_missing",     # location was required but not shared
    "device_shared",        # other students this device marked in the last 7 days (capped at 5)
    "new_device",           # first time this student used this device
    "scan_burst",           # log(1 + other scans from the same network in the previous 5 s)
    "face_distance",        # distance to the enrolled face (neutral constant if no check)
    "face_missing",         # no face check was done
]

LOCATION_STATUSES = ("ok", "missing", "not_checked")


def _num(value: Any, default: float | None = None) -> float | None:
    if value is None:
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def proxy_vector(raw: Mapping[str, Any]) -> np.ndarray:
    """Raw scan facts -> the model's 9 numbers.

    raw keys: token_age_s, location_status ('ok' | 'missing' | 'not_checked'), distance_m,
    accuracy_m, device_shared_count, new_device_for_student, scan_burst_count, face_distance.
    """
    status = raw.get("location_status", "not_checked")
    if status not in LOCATION_STATUSES:
        raise ValueError(f"location_status must be one of {LOCATION_STATUSES}, got {status!r}")

    age = min(2.0, max(0.0, (_num(raw.get("token_age_s"), NEUTRAL_TOKEN_AGE_S)) / CODE_LIFE_S))

    if status == "ok":
        accuracy = _num(raw.get("accuracy_m"), GPS_UNKNOWN_ERROR_M)
        accuracy = min(GPS_UNKNOWN_ERROR_M, max(0.0, accuracy))
        distance = max(0.0, _num(raw.get("distance_m"), 0.0))
        excess = math.log1p(max(0.0, distance - accuracy))
        gps_error = math.log1p(accuracy)
    else:
        excess = 0.0
        gps_error = math.log1p(NEUTRAL_GPS_ERROR_M)

    shared = min(5, max(0, int(_num(raw.get("device_shared_count"), 0))))
    burst = math.log1p(min(50, max(0, int(_num(raw.get("scan_burst_count"), 0)))))

    face = _num(raw.get("face_distance"))
    face_missing = 1.0 if face is None else 0.0
    face_value = NEUTRAL_FACE_DISTANCE if face is None else min(1.5, max(0.0, face))

    return np.array(
        [
            age,
            excess,
            gps_error,
            1.0 if status == "missing" else 0.0,
            float(shared),
            1.0 if raw.get("new_device_for_student") else 0.0,
            burst,
            face_value,
            face_missing,
        ],
        dtype=np.float64,
    )


def proxy_matrix(rows: Sequence[Mapping[str, Any]]) -> np.ndarray:
    return np.vstack([proxy_vector(row) for row in rows]) if rows else np.empty((0, len(PROXY_FEATURES)))


# ================================================================================================
# 2. At-risk attendance (one feature row per student, from the lectures held so far)
# ================================================================================================
ATRISK_FEATURES = [
    "pct_so_far",             # share of lectures held so far that the student attended
    "pct_last3",              # the same over the last 3 lectures
    "trend",                  # last third minus first third (negative = slipping)
    "longest_absence_streak", # longest run of missed lectures
    "current_absence_streak", # missed lectures in a row, ending now
    "late_share",             # share of attended lectures where the scan came late
    "flags_per_10",           # scans held for review or blocked, per 10 lectures
    "progress",               # lectures held / lectures planned
    "slack_fraction",         # (classes still missable) / planned: plain arithmetic, can be negative
]


def can_still_miss(attended: int, held: int, planned: int) -> int:
    """Classes the student can still miss and finish on 75% of the planned lectures (exact arithmetic)."""
    remaining = max(0, planned - held)
    needed = math.ceil(ATTENDANCE_TARGET * planned)
    return attended + remaining - needed


def _longest_run(values: Sequence[int], target: int) -> int:
    best = run = 0
    for v in values:
        run = run + 1 if v == target else 0
        best = max(best, run)
    return best


def atrisk_vector(
    attended: Sequence[int], late: Sequence[int], flags: int, planned: int
) -> np.ndarray:
    """One student's lecture-by-lecture record -> the model's 9 numbers.

    attended[i] is 1 if the student was marked present at the i-th closed lecture, else 0;
    late[i] is 1 if their scan came late (0 when absent). `planned` is the lectures in the term.
    Only lectures already held are used, so nothing about the future leaks in.
    """
    held = len(attended)
    if held == 0:
        raise ValueError("at least one lecture is needed")
    if planned < held:
        planned = held
    a = [1 if x else 0 for x in attended]
    total = sum(a)

    pct = total / held
    last3 = a[-3:]
    pct_last3 = sum(last3) / len(last3)
    k = max(1, held // 3)
    trend = (sum(a[-k:]) / k) - (sum(a[:k]) / k) if held >= 6 else 0.0
    late_attended = sum(1 for x, l in zip(a, late) if x and l)
    late_share = late_attended / total if total else 0.0
    current = 0
    for x in reversed(a):
        if x:
            break
        current += 1

    slack = can_still_miss(total, held, planned)
    return np.array(
        [
            pct,
            pct_last3,
            trend,
            float(_longest_run(a, 0)),
            float(current),
            late_share,
            max(0, int(flags)) / held * 10.0,
            held / planned,
            max(-1.0, min(1.0, slack / planned)),
        ],
        dtype=np.float64,
    )
