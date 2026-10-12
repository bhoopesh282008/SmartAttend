"""Synthetic scans for the proxy-marking model.

THERE IS NO REAL DATA. No public log of QR-attendance scans with known proxy marking exists, and
this project has not been deployed. Every number below is an ASSUMPTION about how honest and
dishonest scans look, written down so it can be argued with and replaced by measurements. Anything
the model scores on this data says how well the METHOD works in this invented world, not how well
it would catch real proxy marking.

The generator deliberately includes HARD NEGATIVES: honest scans that look suspicious on one
signal (poor indoor GPS, a burst of scans at the start of a lecture on shared Wi-Fi, a phone that
two flatmates really do share). Without them a model learns "far from the room = cheating" and
would flag honest students all day.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

# --- how the world is assumed to look -------------------------------------------------------
PROXY_PRIOR = 0.08               # share of scans that are proxy marks
P_LOCATION_NOT_CHECKED = 0.25    # lectures where the faculty member left the location check off
P_FACE_CHECKED = 0.30            # lectures where the face check is on (it is optional)
P_MOBILE_DATA = 0.35             # students on mobile data, not the campus Wi-Fi
P_DENY_LOCATION = {"honest": 0.06, "proxy": 0.30}

HONEST_SCENARIOS = {
    "honest_good_gps": 0.55,      # in the room, a good fix
    "honest_poor_gps": 0.20,      # in the room, a poor indoor fix: reported distance can be large (HARD NEGATIVE)
    "honest_burst": 0.15,         # lecture start, many students on one Wi-Fi at once (HARD NEGATIVE)
    "honest_new_phone": 0.05,     # new phone or cleared browser data
    "honest_shared_phone": 0.03,  # flatmates or siblings who really share a phone (HARD NEGATIVE)
    "honest_other": 0.02,
}
PROXY_SCENARIOS = {
    "relay_outside": 0.45,         # friend relays the QR photo; student is far away
    "relay_nearby": 0.25,          # relayed to someone in the building but not in the room
    "second_phone_in_room": 0.30,  # a friend in the room uses another phone: location looks fine
}

ASSUMPTIONS = [
    f"{PROXY_PRIOR:.0%} of scans are proxy marks; the rest are honest.",
    f"{P_LOCATION_NOT_CHECKED:.0%} of scans come from lectures with the location check off (location features are then neutral).",
    f"{P_FACE_CHECKED:.0%} of scans have a face distance; the rest have none (a 'missing' flag, which carries no label information).",
    "Honest students are 0 to about 150 m from the room centre (half-normal, sigma 35 m); GPS error is a 2-D normal with sigma = accuracy / 2.",
    "Good phone fixes have accuracy near 12 m (lognormal, 3 to 40 m); poor indoor fixes 40 to 150 m, with a tail to 800 m.",
    "Honest students scan at any moment of the code's 55 to 60 s on-screen life (so timing alone says little); at lecture start they scan within 15 s.",
    "A relayed QR photo arrives late in the code's life (beta-shaped, peaking around 35 s) and the relaying student is often outside or in the corridor.",
    "6% of honest students deny location; 30% of proxies do.",
    "Face distance (128-number descriptors): same person about 0.40 +- 0.08, with 4% of honest scans mismatching (glasses, light); a different person about 0.78 +- 0.09. These values are assumptions to be re-measured with real enrolments.",
    "Hard negatives: poor-GPS honest scans, honest lecture-start bursts on shared Wi-Fi, honest shared phones.",
    "The 'second_phone_in_room' proxy is detectable mainly through device history, because their location looks right.",
]


@dataclass
class ScanSet:
    rows: list[dict[str, Any]]
    y: np.ndarray            # 1 = proxy mark, 0 = honest
    scenario: np.ndarray     # scenario name per row


def _pick(rng: np.random.Generator, table: dict[str, float]) -> str:
    names = list(table)
    weights = np.array([table[n] for n in names], dtype=float)
    return str(rng.choice(names, p=weights / weights.sum()))


def _good_accuracy(rng: np.random.Generator) -> float:
    return float(np.clip(rng.lognormal(math.log(12.0), 0.5), 3.0, 40.0))


def _poor_accuracy(rng: np.random.Generator) -> float:
    return float(rng.uniform(40.0, 150.0) if rng.random() < 0.9 else rng.uniform(150.0, 800.0))


def _reported_distance(rng: np.random.Generator, true_distance: float, accuracy: float) -> float:
    ex, ey = rng.normal(0.0, accuracy / 2.0, size=2)
    return float(math.hypot(true_distance + ex, ey))


def _face(rng: np.random.Generator, same_person_p: float) -> float:
    """same_person_p: chance the face on the phone is the enrolled student's."""
    if rng.random() < same_person_p:
        mismatch = rng.random() < 0.04
        return float(np.clip(rng.normal(0.65, 0.05) if mismatch else rng.normal(0.40, 0.08), 0.1, 1.2))
    return float(np.clip(rng.normal(0.78, 0.09), 0.3, 1.3))


def _honest(rng: np.random.Generator, scenario: str) -> dict[str, Any]:
    true_distance = min(150.0, abs(rng.normal(0.0, 35.0)))
    accuracy = _poor_accuracy(rng) if scenario == "honest_poor_gps" else _good_accuracy(rng)
    in_burst = scenario == "honest_burst"
    mobile = rng.random() < P_MOBILE_DATA
    return {
        "token_age_s": float(rng.uniform(0.0, 15.0) if in_burst else 58.0 * rng.beta(1.0, 1.3)),
        "distance_m": _reported_distance(rng, true_distance, accuracy),
        "accuracy_m": accuracy,
        "device_shared_count": int(rng.integers(1, 3)) if scenario == "honest_shared_phone" else int(rng.random() < 0.01),
        "new_device_for_student": scenario == "honest_new_phone" or rng.random() < 0.02,
        "scan_burst_count": int(rng.poisson(10.0 if in_burst else (0.3 if mobile else 1.5))),
        "_deny": rng.random() < P_DENY_LOCATION["honest"],
        "_face": _face(rng, 1.0),
    }


def _proxy(rng: np.random.Generator, scenario: str) -> dict[str, Any]:
    if scenario == "relay_outside":
        true_distance = math.exp(rng.uniform(math.log(250.0), math.log(6000.0)))
        accuracy = _good_accuracy(rng) if rng.random() < 0.7 else float(rng.uniform(40.0, 400.0))
        age = 60.0 * rng.beta(2.2, 1.6)
        shared = int(rng.integers(1, 4)) if rng.random() < 0.20 else 0
        new_device, burst = rng.random() < 0.12, int(rng.poisson(0.5))
    elif scenario == "relay_nearby":
        true_distance = float(rng.uniform(60.0, 400.0))
        accuracy = _good_accuracy(rng) if rng.random() < 0.8 else _poor_accuracy(rng)
        age = 60.0 * rng.beta(2.0, 1.8)
        shared = int(rng.integers(1, 3)) if rng.random() < 0.15 else 0
        new_device, burst = rng.random() < 0.10, int(rng.poisson(1.0))
    else:  # second_phone_in_room
        true_distance = min(150.0, abs(rng.normal(0.0, 30.0)))
        accuracy = _good_accuracy(rng)
        age = 58.0 * rng.beta(1.0, 1.3)
        shared = int(rng.integers(1, 3)) if rng.random() < 0.55 else 0
        new_device, burst = rng.random() < 0.60, int(rng.poisson(1.5))
    return {
        "token_age_s": float(min(60.0, age)),
        "distance_m": _reported_distance(rng, true_distance, accuracy),
        "accuracy_m": accuracy,
        "device_shared_count": shared,
        "new_device_for_student": bool(new_device),
        "scan_burst_count": burst,
        "_deny": rng.random() < P_DENY_LOCATION["proxy"],
        "_face": _face(rng, 0.10),  # the face at the phone is usually not the enrolled student's
    }


def generate_scans(n: int, seed: int) -> ScanSet:
    """n synthetic scans with their labels and scenario names, fully determined by `seed`."""
    rng = np.random.default_rng(seed)
    rows: list[dict[str, Any]] = []
    labels = np.zeros(n, dtype=np.int64)
    scenarios = np.empty(n, dtype=object)
    for i in range(n):
        is_proxy = rng.random() < PROXY_PRIOR
        scenario = _pick(rng, PROXY_SCENARIOS if is_proxy else HONEST_SCENARIOS)
        raw = (_proxy if is_proxy else _honest)(rng, scenario)

        deny = raw.pop("_deny")
        face = raw.pop("_face")
        if rng.random() < P_LOCATION_NOT_CHECKED:
            status = "not_checked"
        else:
            status = "missing" if deny else "ok"
        if status != "ok":
            raw["distance_m"] = None
            raw["accuracy_m"] = None
        raw["location_status"] = status
        raw["face_distance"] = face if rng.random() < P_FACE_CHECKED else None

        rows.append(raw)
        labels[i] = int(is_proxy)
        scenarios[i] = scenario
    return ScanSet(rows=rows, y=labels, scenario=scenarios)
