// Client for the Python model service (ml/app.py). The service is optional: every call can
// fail or time out, and the server then falls back to its rules and records that it did.

export const DEFAULT_ML_URL = 'http://127.0.0.1:8001';

export function createMlClient({ url = DEFAULT_ML_URL, timeoutMs = 1500, fetchImpl = fetch } = {}) {
  async function request(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(url + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`The model service answered ${res.status}.`);
    return res.json();
  }

  // The faculty page polls often; do not ask the service every time.
  let cached = { at: 0, value: { available: false, models: {} } };

  return {
    url,
    proxyScore: (features) => request('/v1/proxy-score', { method: 'POST', body: features }),
    atRisk: (payload) => request('/v1/at-risk', { method: 'POST', body: payload }),
    modelInfo: () => request('/v1/model-info'),
    async health(ttlMs = 4000) {
      if (Date.now() - cached.at < ttlMs) return cached.value;
      let value;
      try {
        const { models } = await request('/health');
        value = { available: true, models };
      } catch {
        value = { available: false, models: {} };
      }
      cached = { at: Date.now(), value };
      return value;
    },
  };
}

/**
 * Builds the `score` hook that processScan calls. It turns what the scan pipeline already knows
 * into the model's inputs. A missing position is passed as 'missing', and a lecture with the
 * location check off as 'not_checked', so the model never reads either as distance zero.
 */
export function createRiskScorer(ml) {
  return async function score({ place, base, sharedDevices, newDevice, burst, faceDistance = null }) {
    const features = {
      token_age_s: base.token_age_s,
      location_status: place.action === 'skipped' ? 'not_checked' : place.distanceM == null ? 'missing' : 'ok',
      distance_m: place.distanceM,
      accuracy_m: place.accuracyM,
      device_shared_count: sharedDevices,
      new_device_for_student: newDevice,
      scan_burst_count: burst,
      face_distance: faceDistance, // null when the lecture has no face check, or it was not completed
    };
    try {
      const result = await ml.proxyScore(features);
      return {
        risk: result.risk,
        review: result.flag,
        reasons: result.reasons.map(({ code, text }) => ({ code, text })),
        scoredBy: result.model_version,
      };
    } catch {
      return { risk: null, review: false, reasons: [], scoredBy: 'rules' };
    }
  };
}
