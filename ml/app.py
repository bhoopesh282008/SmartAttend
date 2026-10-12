"""SmartAttend model service.

    uvicorn app:app --host 127.0.0.1 --port 8001      (run from inside ml/)

Stateless: every request carries everything the model needs, nothing is stored. The Node server
asks it to score each scan and to rank students by attendance risk.

NO AUTHENTICATION. It listens on localhost only and must never be exposed to a network; the Node
server is its only client. If it is down, the Node server falls back to rules and says so.
"""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Literal, Optional, Union

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, model_validator

import config
from explain import atrisk_reasons, contributions, proxy_reasons
from features import atrisk_vector, can_still_miss, proxy_vector


def _load(model_path, metrics_path):
    if not model_path.exists():
        return None
    saved = joblib.load(model_path)
    saved["metrics"] = json.loads(metrics_path.read_text(encoding="utf-8")) if metrics_path.exists() else None
    return saved


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.models = {
        "proxy": _load(config.PROXY_MODEL, config.PROXY_METRICS),
        "atrisk": _load(config.ATRISK_MODEL, config.ATRISK_METRICS),
    }
    yield


app = FastAPI(title="SmartAttend models", version="1.0.0", lifespan=lifespan)


def _model(name: str):
    saved = getattr(app.state, "models", {}).get(name)
    if saved is None:
        script = "train_proxy.py" if name == "proxy" else "train_atrisk.py"
        raise HTTPException(status_code=503, detail=f"The {name} model has not been trained. Run `python {script}`.")
    return saved


# ----------------------------------------------------------------------------------- schemas
class Reason(BaseModel):
    code: str
    text: str
    weight: float


class ProxyScoreRequest(BaseModel):
    token_age_s: Optional[float] = Field(None, ge=0, le=3600)
    location_status: Literal["ok", "missing", "not_checked"] = "not_checked"
    distance_m: Optional[float] = Field(None, ge=0, le=2e7)
    accuracy_m: Optional[float] = Field(None, ge=0, le=1e7)
    device_shared_count: int = Field(0, ge=0, le=100_000)
    new_device_for_student: bool = False
    scan_burst_count: int = Field(0, ge=0, le=100_000)
    face_distance: Optional[float] = Field(None, ge=0, le=5)


class ProxyScoreResponse(BaseModel):
    risk: float
    flag: bool
    threshold: float
    reasons: list[Reason]
    model_version: str


class StudentRecord(BaseModel):
    id: Union[int, str]
    attended: list[int] = Field(max_length=400)
    late: list[int] = Field(max_length=400)
    flags: int = Field(0, ge=0, le=100_000)

    @model_validator(mode="after")
    def _check(self):
        if len(self.attended) != len(self.late):
            raise ValueError("attended and late must have the same length")
        if any(v not in (0, 1) for v in self.attended) or any(v not in (0, 1) for v in self.late):
            raise ValueError("attended and late must contain only 0 or 1")
        return self


class AtRiskRequest(BaseModel):
    planned_lectures: int = Field(ge=1, le=400)
    students: list[StudentRecord] = Field(max_length=2000)


class AtRiskResult(BaseModel):
    id: Union[int, str]
    held: int
    attended: int
    insufficient: bool
    risk: Optional[float] = None
    band: Optional[Literal["high", "watch", "low"]] = None
    can_still_miss: int
    reasons: list[Reason]


class AtRiskResponse(BaseModel):
    model_version: str
    results: list[AtRiskResult]


# ----------------------------------------------------------------------------------- routes
@app.get("/health")
def health():
    models = getattr(app.state, "models", {})
    return {"ok": True, "models": {name: (saved["version"] if saved else None) for name, saved in models.items()}}


@app.get("/v1/model-info")
def model_info():
    models = getattr(app.state, "models", {})
    return {name: (saved["metrics"] if saved else None) for name, saved in models.items()}


@app.post("/v1/proxy-score", response_model=ProxyScoreResponse)
def proxy_score(request: ProxyScoreRequest) -> ProxyScoreResponse:
    saved = _model("proxy")
    raw = request.model_dump()
    x = proxy_vector(raw)
    pipeline = saved["pipeline"]
    risk = float(pipeline.predict_proba(x.reshape(1, -1))[0, 1])
    flag = risk >= saved["threshold"]
    reasons = proxy_reasons(raw, contributions(pipeline, x)) if flag else []
    return ProxyScoreResponse(risk=round(risk, 4), flag=flag, threshold=round(saved["threshold"], 4), reasons=reasons, model_version=saved["version"])


@app.post("/v1/at-risk", response_model=AtRiskResponse)
def at_risk(request: AtRiskRequest) -> AtRiskResponse:
    saved = _model("atrisk")
    pipeline = saved["pipeline"]
    results: list[AtRiskResult] = []
    for student in request.students:
        held = len(student.attended)
        attended = sum(student.attended)
        slack = can_still_miss(attended, held, max(request.planned_lectures, held)) if held else 0
        if held < config.MIN_LECTURES_FOR_RISK:
            results.append(AtRiskResult(id=student.id, held=held, attended=attended, insufficient=True, can_still_miss=slack, reasons=[]))
            continue
        x = atrisk_vector(student.attended, student.late, student.flags, request.planned_lectures)
        risk = float(pipeline.predict_proba(x.reshape(1, -1))[0, 1])
        band = "high" if risk >= config.ATRISK_HIGH else "watch" if risk >= config.ATRISK_WATCH else "low"
        reasons = (
            atrisk_reasons(x, student.flags, request.planned_lectures, held, contributions(pipeline, x))
            if band != "low"
            else []
        )
        results.append(AtRiskResult(id=student.id, held=held, attended=attended, insufficient=False, risk=round(risk, 4), band=band, can_still_miss=slack, reasons=reasons))
    return AtRiskResponse(model_version=saved["version"], results=results)
