"""Turns a linear model's arithmetic into reasons a person can read.

For a logistic regression the score is a sum, so each feature's share can be read off directly:
contribution = coefficient x (feature - training mean) / training spread, in log-odds. The
largest positive contributions are the reasons a scan or a student was flagged.

Reasons are for FACULTY. They are never shown to the student being scored, so nobody can tune
a scan to slip under a rule.
"""
from __future__ import annotations

from typing import Any, Callable, Mapping, Sequence

import numpy as np

from features import ATRISK_FEATURES, PROXY_FEATURES

# Below this many log-odds a feature is not worth mentioning.
MIN_CONTRIBUTION = 0.10

# A contribution is measured against an AVERAGE scan, so a perfectly ordinary value can still rank
# as a "reason" (30 m from the room is slightly above average, but it is not suspicious). A reason is
# therefore offered only when the raw value is itself notable.
NOTABLE_EXCESS_DISTANCE_M = 50.0   # metres beyond the GPS error
NOTABLE_LATE_SCAN_S = 30.0         # seconds into the code's 60
NOTABLE_GPS_ERROR_M = 50.0
NOTABLE_BURST = 3                  # other scans from the same network in 5 s
NOTABLE_FACE_DISTANCE = 0.55


def contributions(pipeline, x: np.ndarray) -> np.ndarray:
    """Per-feature log-odds contribution of one feature vector, relative to an average sample."""
    scaler = pipeline.named_steps["scaler"]
    clf = pipeline.named_steps["clf"]
    z = (x - scaler.mean_) / scaler.scale_
    return clf.coef_[0] * z


def _top(names: Sequence[str], contrib: np.ndarray, describe: Callable[[str], dict | None], k: int) -> list[dict]:
    reasons: list[dict] = []
    for index in np.argsort(-contrib):
        if contrib[index] < MIN_CONTRIBUTION or len(reasons) >= k:
            break
        reason = describe(names[index])
        if reason:
            reason["weight"] = round(float(contrib[index]), 3)
            reasons.append(reason)
    return reasons


# ------------------------------------------------------------------------------ proxy scans
def proxy_reasons(raw: Mapping[str, Any], contrib: np.ndarray, k: int = 3) -> list[dict]:
    status = raw.get("location_status", "not_checked")

    def describe(name: str) -> dict | None:
        if name == "token_age":
            age = raw.get("token_age_s")
            if age is None or age < NOTABLE_LATE_SCAN_S:
                return None
            return {"code": "late_scan", "text": f"Scanned {age:.0f} s into the code's 60 s life"}
        if name == "excess_distance" and status == "ok":
            distance, accuracy = raw.get("distance_m") or 0.0, raw.get("accuracy_m")
            if distance - (accuracy or 0.0) < NOTABLE_EXCESS_DISTANCE_M:
                return None
            where = f"About {distance:.0f} m from the classroom"
            return {"code": "outside_room", "text": where + (f" (GPS accurate to about {accuracy:.0f} m)" if accuracy is not None else "")}
        if name == "gps_error" and status == "ok":
            accuracy = raw.get("accuracy_m")
            if accuracy is not None and accuracy < NOTABLE_GPS_ERROR_M:
                return None
            return {"code": "location_imprecise", "text": f"Location was imprecise (accurate only to about {accuracy:.0f} m)" if accuracy is not None else "Location accuracy was not reported"}
        if name == "location_missing":
            if status != "missing":
                return None
            return {"code": "location_missing", "text": "Location was not shared, so the position could not be checked"}
        if name == "device_shared":
            n = int(raw.get("device_shared_count") or 0)
            return {"code": "device_shared", "text": f"This device marked {n} other student{'s' if n != 1 else ''} in the last 7 days"} if n else None
        if name == "new_device":
            return {"code": "new_device", "text": "First time this student has used this device"} if raw.get("new_device_for_student") else None
        if name == "scan_burst":
            n = int(raw.get("scan_burst_count") or 0)
            return {"code": "scan_burst", "text": f"{n} other scans from the same network in the 5 s before"} if n >= NOTABLE_BURST else None
        if name == "face_distance" and raw.get("face_distance") is not None:
            if raw["face_distance"] < NOTABLE_FACE_DISTANCE:
                return None
            return {"code": "face_mismatch", "text": f"The face did not match the enrolled one well (distance {raw['face_distance']:.2f})"}
        return None

    return _top(PROXY_FEATURES, contrib, describe, k)


# ------------------------------------------------------------------------- at-risk students
def atrisk_reasons(vector: np.ndarray, flags: int, planned: int, held: int, contrib: np.ndarray, k: int = 3) -> list[dict]:
    values = dict(zip(ATRISK_FEATURES, vector))

    def describe(name: str) -> dict | None:
        if name == "pct_so_far":
            return {"code": "low_attendance", "text": f"Attendance so far is {values['pct_so_far']:.0%}"}
        if name == "pct_last3":
            attended = round(values["pct_last3"] * min(3, held))
            return {"code": "recent_absences", "text": f"Attended {attended} of the last {min(3, held)} lectures"}
        if name == "trend":
            return {"code": "slipping", "text": f"Attendance is slipping (down {abs(values['trend']):.0%} from the start of term)"} if values["trend"] < 0 else None
        if name == "longest_absence_streak":
            n = int(values["longest_absence_streak"])
            return {"code": "absence_streak", "text": f"Missed {n} lectures in a row at one point"} if n >= 2 else None
        if name == "current_absence_streak":
            n = int(values["current_absence_streak"])
            return {"code": "current_streak", "text": f"Has missed the last {n} lecture{'s' if n != 1 else ''}"} if n >= 1 else None
        if name == "late_share":
            # A percentage over one or two lectures is noise, not a pattern.
            attended = round(values["pct_so_far"] * held)
            return {"code": "often_late", "text": f"Scans late at {values['late_share']:.0%} of the {attended} lectures attended"} if values["late_share"] > 0 and attended >= 3 else None
        if name == "flags_per_10":
            return {"code": "flagged_scans", "text": f"{flags} scan{'s' if flags != 1 else ''} held for review or blocked"} if flags else None
        if name == "slack_fraction":
            slack = round(values["slack_fraction"] * planned)
            if slack < 0:
                return {"code": "cannot_reach", "text": "Can no longer reach 75% even by attending every remaining lecture"}
            return {"code": "little_slack", "text": f"Can only miss {slack} more lecture{'s' if slack != 1 else ''} and still reach 75%"}
        return None

    return _top(ATRISK_FEATURES, contrib, describe, k)
