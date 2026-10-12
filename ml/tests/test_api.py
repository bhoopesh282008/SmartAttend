import pytest
from fastapi.testclient import TestClient

import config
from app import app

pytestmark = pytest.mark.skipif(not config.PROXY_MODEL.exists(), reason="models not trained")

HONEST = {
    "token_age_s": 14.0, "location_status": "ok", "distance_m": 30.0, "accuracy_m": 10.0,
    "device_shared_count": 0, "new_device_for_student": False, "scan_burst_count": 0,
}
RELAY = {
    "token_age_s": 49.0, "location_status": "ok", "distance_m": 2200.0, "accuracy_m": 15.0,
    "device_shared_count": 1, "new_device_for_student": True, "scan_burst_count": 0,
}


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def test_health_reports_model_versions(client):
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["models"]["proxy"].startswith("proxy-lr-")
    assert body["models"]["atrisk"].startswith("atrisk-lr-")


def test_model_info_carries_the_synthetic_data_statement(client):
    info = client.get("/v1/model-info").json()
    assert info["proxy"]["data"]["synthetic"] is True
    assert info["atrisk"]["data"]["synthetic"] is True
    assert info["proxy"]["benchmark"]


def test_honest_scan_is_not_flagged_and_relay_is_with_reasons(client):
    honest = client.post("/v1/proxy-score", json=HONEST).json()
    assert honest["flag"] is False and honest["reasons"] == []
    relay = client.post("/v1/proxy-score", json=RELAY).json()
    assert relay["flag"] is True and relay["risk"] > relay["threshold"]
    assert 1 <= len(relay["reasons"]) <= 3
    assert {"code", "text", "weight"} <= set(relay["reasons"][0])


def test_service_score_equals_scoring_the_training_features(client):
    """Serving and training share one feature function, so the numbers agree exactly."""
    import joblib
    import numpy as np
    from features import proxy_matrix

    saved = joblib.load(config.PROXY_MODEL)
    expected = saved["pipeline"].predict_proba(proxy_matrix([RELAY]))[0, 1]
    assert client.post("/v1/proxy-score", json=RELAY).json()["risk"] == pytest.approx(float(np.round(expected, 4)))


def test_bad_input_is_a_422(client):
    assert client.post("/v1/proxy-score", json={**HONEST, "location_status": "gps"}).status_code == 422
    assert client.post("/v1/proxy-score", json={**HONEST, "distance_m": -5}).status_code == 422
    assert client.post("/v1/at-risk", json={"planned_lectures": 40, "students": [{"id": 1, "attended": [1, 0], "late": [0]}]}).status_code == 422
    assert client.post("/v1/at-risk", json={"planned_lectures": 40, "students": [{"id": 1, "attended": [2], "late": [0]}]}).status_code == 422


def test_at_risk_needs_enough_lectures_and_orders_students(client):
    body = {
        "planned_lectures": 40,
        "students": [
            {"id": "few", "attended": [1, 0, 1], "late": [0, 0, 0], "flags": 0},
            {"id": "steady", "attended": [1] * 10, "late": [0] * 10, "flags": 0},
            {"id": "slipping", "attended": [1, 1, 1, 0, 1, 0, 0, 0, 0, 0], "late": [0, 1, 0, 0, 1, 0, 0, 0, 0, 0], "flags": 2},
        ],
    }
    results = {r["id"]: r for r in client.post("/v1/at-risk", json=body).json()["results"]}
    assert results["few"]["insufficient"] is True and results["few"]["risk"] is None
    assert results["steady"]["band"] == "low"
    assert results["slipping"]["band"] in ("watch", "high")
    assert results["slipping"]["risk"] > results["steady"]["risk"]
    assert results["slipping"]["reasons"], "a flagged student comes with reasons"
    assert results["steady"]["can_still_miss"] == 10 + 30 - 30
    assert results["slipping"]["can_still_miss"] == 4 + 30 - 30


def test_untrained_model_is_a_clear_503(client):
    saved = app.state.models["proxy"]
    app.state.models["proxy"] = None
    try:
        response = client.post("/v1/proxy-score", json=HONEST)
        assert response.status_code == 503
        assert "train_proxy.py" in response.json()["detail"]
    finally:
        app.state.models["proxy"] = saved
