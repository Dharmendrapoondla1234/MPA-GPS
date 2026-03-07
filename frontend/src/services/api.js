// src/services/api.js
const BASE = process.env.REACT_APP_API_URL || "https://vessel-backends.onrender.com/api";

// ── REQUEST DEDUPLICATION ─────────────────────────────────────
const inFlight = new Map();

async function call(path) {
  const url = `${BASE}${path}`;

  if (inFlight.has(url)) {
    return inFlight.get(url);
  }

  const promise = (async () => {
    try {
      const token = getCurrentUser()?.token;
      const res = await fetch(url, {
        headers: {
          Accept:            "application/json",
          "Accept-Encoding": "gzip, deflate, br",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const errJson = await res.json();
          if (errJson?.error) errMsg = errJson.error;
        } catch(_) {}
        throw new Error(errMsg);
      }
      const json = await res.json();
      if (json?.success === false) throw new Error(json.error || "API error");
      return json?.data !== undefined ? json.data : json;
    } catch (err) {
      if (err.message.includes("Failed to fetch") || err.message.includes("NetworkError"))
        throw new Error("Backend sleeping — wait 30 seconds and retry");
      throw err;
    } finally {
      inFlight.delete(url);
    }
  })();

  inFlight.set(url, promise);
  return promise;
}

export async function fetchVessels({
  search = "", vesselType = "", speedMin = null, speedMax = null, limit = 5000,
} = {}) {
  const p = new URLSearchParams();
  if (search)           p.set("search",    search);
  if (vesselType)       p.set("vesselType", vesselType);
  if (speedMin != null) p.set("speedMin",  speedMin);
  if (speedMax != null) p.set("speedMax",  speedMax);
  p.set("limit", limit);
  return call(`/vessels?${p}`);
}

export async function fetchVesselHistory(imo, hours = 24) {
  return call(`/vessels/${encodeURIComponent(imo)}/history?hours=${hours}`);
}

// ── AI ROUTE PREDICTION ──────────────────────────────────────
export async function fetchRoutePrediction(imo) {
  return call(`/predict/${encodeURIComponent(imo)}`);
}

export async function fetchAITrajectory(imo, hours = 48) {
  try {
    const data = await call(`/ai/trajectory/${encodeURIComponent(imo)}?hours=${hours}`);
    return Array.isArray(data) ? data : (data?.data || data);
  } catch(e) {
    console.warn("[AI Trajectory] falling back to regular history:", e.message);
    return call(`/vessels/${encodeURIComponent(imo)}/history?hours=${hours}`);
  }
}

export async function fetchVesselTypes() { return call("/vessel-types"); }
export async function fetchFleetStats()  { return call("/stats"); }

// ── AUTH ──────────────────────────────────────────────────────
async function authPost(endpoint, body) {
  let res;
  try {
    res = await fetch(`${BASE}/auth/${endpoint}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
  } catch (networkErr) {
    throw new Error("Cannot reach server — backend may be sleeping, wait 30s and retry");
  }

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const raw = await res.text().catch(() => "");
    console.error("Non-JSON response:", raw.slice(0, 300));
    throw new Error(`Server error (HTTP ${res.status}) — check Render logs`);
  }
  return res.json();
}

export async function checkEmailExists(email) {
  try {
    const res  = await fetch(`${BASE}/auth/check-email?email=${encodeURIComponent(email)}`);
    const ct   = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return false;
    const json = await res.json();
    return json.exists === true;
  } catch { return false; }
}

export async function loginUser(email, password) {
  const json = await authPost("login", { email, password });
  if (!json.success) throw new Error(json.error || "Login failed");
  localStorage.setItem("mt_user", JSON.stringify(json.data));
  return json.data;
}

export async function signupUser(name, email, password) {
  const json = await authPost("register", { name, email, password });
  if (!json.success) {
    if (json.error === "already_registered") {
      const err = new Error(json.message || "Email already registered. Please sign in.");
      err.code = "already_registered";
      throw err;
    }
    throw new Error(json.error || "Registration failed");
  }
  localStorage.setItem("mt_user", JSON.stringify(json.data));
  return json.data;
}

export function logoutUser()     { localStorage.removeItem("mt_user"); }
export function getCurrentUser() {
  try { return JSON.parse(localStorage.getItem("mt_user")); }
  catch { return null; }
}