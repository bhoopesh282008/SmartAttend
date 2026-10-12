"""Synthetic student terms for the at-risk attendance model.

AGAIN, THERE IS NO REAL DATA. These are invented terms generated from written-down assumptions, so
the model's numbers describe the method in an invented world and nothing more.

How a student's term is generated:
  * each student has a base attendance tendency theta ~ Beta(10, 1.8) (mean about 0.85)
  * a drift gamma ~ Normal(0, 0.6) in log-odds over the term (some slip, some improve)
  * absences stick: after a missed lecture the chance of attending drops (illness, disengagement),
    more so for students with a low tendency
  * students who attend less also scan late more often and have more scans held for review

Leakage control: features are computed ONLY from the first `held` lectures (a random point 15% to
60% of the way through the term); the label ("finishes below 75% of the planned lectures") comes from
the FULL term. Training, validation and test sets hold different students.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from config import ATTENDANCE_TARGET, MIN_LECTURES_FOR_RISK

ASSUMPTIONS = [
    "Terms have 30 to 45 planned lectures; the model is shown a random snapshot 15% to 60% of the way through.",
    "Base attendance tendency theta ~ Beta(10, 1.8) (about a third of students finish below 75%); a drift in log-odds over the term ~ Normal(0, 0.6).",
    "After a missed lecture the chance of attending is cut by 25% to 60%, more for low-tendency students (absences cluster).",
    "Lateness: a student who attends is late with probability 0.04 + 0.35 x (1 - theta).",
    "Scans held for review or blocked: about 0.05 + 0.5 x (1 - theta) per 10 lectures.",
    "Label: finishes the term below 75% of the planned lectures.",
]


@dataclass
class Student:
    planned: int
    attended: list[int]       # the whole term (used only for the label)
    late: list[int]
    flag_events: list[int]
    held: int                 # lectures visible at the snapshot
    label: int                # 1 = finishes below 75%
    snapshot: dict[str, Any]  # what the model sees: attended/late/flags for the first `held` lectures


# Base attendance tendency theta ~ Beta(THETA_A, THETA_B).
#
# Chosen so that about a third of students finish below 75% (mean tendency 0.85, mean finish about 79%).
# A first draft with Beta(8, 2.2) put half of all students below 75%, which is not a believable class
# and made the "top 15%" measure meaningless, so this is an assumption about the world, set before
# looking at any model result on it.
THETA_A, THETA_B = 10.0, 1.8


def _logit(p: float) -> float:
    return math.log(p / (1.0 - p))


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def generate_students(n: int, seed: int) -> list[Student]:
    rng = np.random.default_rng(seed)
    students: list[Student] = []
    for _ in range(n):
        planned = int(rng.integers(30, 46))
        theta = float(np.clip(rng.beta(THETA_A, THETA_B), 0.05, 0.995))
        gamma = float(rng.normal(0.0, 0.6))
        stick = 0.25 + 0.35 * (1.0 - theta)

        attended: list[int] = []
        previous_absent = False
        for t in range(planned):
            p = _sigmoid(_logit(theta) + gamma * (t / planned - 0.5))
            if previous_absent:
                p *= 1.0 - stick
            attends = bool(rng.random() < p)
            attended.append(int(attends))
            previous_absent = not attends

        late_p = 0.04 + 0.35 * (1.0 - theta)
        late = [int(a and rng.random() < late_p) for a in attended]
        flag_p = (0.05 + 0.5 * (1.0 - theta)) / 10.0
        flag_events = [int(rng.random() < flag_p) for _ in attended]

        progress = float(rng.uniform(0.15, 0.60))
        held = max(MIN_LECTURES_FOR_RISK, min(planned - 1, round(progress * planned)))
        final = sum(attended) / planned
        students.append(
            Student(
                planned=planned,
                attended=attended,
                late=late,
                flag_events=flag_events,
                held=held,
                label=int(final < ATTENDANCE_TARGET),
                snapshot={
                    "attended": attended[:held],
                    "late": late[:held],
                    "flags": int(sum(flag_events[:held])),
                    "planned": planned,
                },
            )
        )
    return students
