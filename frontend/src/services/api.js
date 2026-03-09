// src/services/api.js — MPA Advanced v6
const BASE = process.env.REACT_APP_API_URL || "https://vessel-backends.onrender.com/api";

// ── REQUEST DEDUPLICATION + BROWSER CACHE ────────────────────────
const inFlight  = new Map();
const respCache = new Map(); // url → { data, ts, etag }
const CACHE_TTL = { vessels: 55_000, stats: 115_000, default: 30_000 };

// Test helper — call this in afterEach to prevent cache bleed between tests
export function __clearCache() { inFlight.clear(); respCache.clear(); }

function cacheTTL(url) {
  if (url.includes("/vessels"))     return CACHE_TTL.vessels;
  if (url.includes("/stats"))       return CACHE_TTL.stats;
  return CACHE_TTL.default;
}

async function call(path) {
  const url = `${BASE}${path}`;

  // Return in-flight promise immediately (dedup parallel calls)
  if (inFlight.has(url)) return inFlight.get(url);

  // Return browser cache if still fresh (skip in test env so mocks always run)
  const cached = respCache.get(url);
  const isTest = typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
  if (!isTest && cached && Date.now() - cached.ts < cacheTTL(url)) return cached.data;

  const promise = (async () => {
    try {
      const token   = getCurrentUser()?.token;
      const headers = {
        Accept:            "application/json",
        "Accept-Encoding": "gzip, deflate, br",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
      };
      const res = await fetch(url, { headers });

      // 304 Not Modified — serve from cache
      if (res.status === 304 && cached) {
        respCache.set(url, { ...cached, ts: Date.now() });
        return cached.data;
      }

      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch (_) {}
        throw new Error(msg);
      }

      const json = await res.json();
      if (json?.success === false) throw new Error(json.error || "API error");
      const data = json?.data !== undefined ? json.data : json;

      // Store in browser cache with ETag if provided
      respCache.set(url, { data, ts: Date.now(), etag: res.headers.get("etag") || null });
      return data;
    } catch (err) {
      if (err.message.includes("Failed to fetch") || err.message.includes("NetworkError"))
        throw new Error("Connecting to server… will retry automatically");
      throw err;
    } finally { inFlight.delete(url); }
  })();

  inFlight.set(url, promise);
  return promise;
}

// ── VESSELS ───────────────────────────────────────────────────────
// -- KEEP-ALIVE ---------------------------------------------------
(function startKeepAlive() {
  const PING_URL = `${BASE}/health`.replace("/api/health", "/health");
  let _pingTimer = null;

  function ping() {
    fetch(PING_URL, { method: "GET", cache: "no-store" })
      .then(r => { if (r.ok) console.debug("[keep-alive] backend awake ✓"); })
      .catch(() => { /* backend was sleeping — next ping will wake it */ });
  }

  function schedule() {
    if (_pingTimer) clearInterval(_pingTimer);
    setTimeout(ping, 2000);
    _pingTimer = setInterval(ping, 4 * 60 * 1000);
  }

  if (typeof document !== "undefined") {
    schedule();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        ping();
        schedule();
      }
    });
  }
})();

// FIX: Accept { bustCache } option — when true (background refresh), delete the
// cached response so the next call always hits the network for fresh vessel data.
// Previously bustCache was passed by useVessels.js but silently ignored here.
export async function fetchVessels(
  { search="", vesselType="", speedMin=null, speedMax=null, limit=5000 } = {},
  { bustCache=false } = {}
) {
  const p = new URLSearchParams();
  if (search)           p.set("search",    search);
  if (vesselType)       p.set("vesselType",vesselType);
  if (speedMin!=null)   p.set("speedMin",  speedMin);
  if (speedMax!=null)   p.set("speedMax",  speedMax);
  p.set("limit", limit);
  const path = `/vessels?${p}`;
  // FIX: bust the browser cache on background refresh so stale data is never returned
  if (bustCache) respCache.delete(`${BASE}${path}`);
  return call(path);
}

export async function fetchVesselDetail(imo) {
  return call(`/vessels/${encodeURIComponent(imo)}`);
}

export async function fetchVesselHistory(imo, hours=24) {
  return call(`/vessels/${encodeURIComponent(imo)}/history?hours=${hours}`);
}

// ── ARRIVALS & DEPARTURES ─────────────────────────────────────────
export async function fetchArrivals(limit=50) {
  return call(`/arrivals?limit=${limit}`);
}

export async function fetchDepartures(limit=50) {
  return call(`/departures?limit=${limit}`);
}

export async function fetchPortActivity() {
  return call("/port-activity");
}

// ── AI PREDICTION ─────────────────────────────────────────────────
export async function fetchRoutePrediction(imo) {
  return call(`/predict/${encodeURIComponent(imo)}`);
}

// ── FLEET META ────────────────────────────────────────────────────
export async function fetchVesselTypes() { return call("/vessel-types"); }
export async function fetchFleetStats()  { return call("/stats"); }

// ── AUTH ──────────────────────────────────────────────────────────
async function authPost(endpoint, body) {
  let res;
  try {
    res = await fetch(`${BASE}/auth/${endpoint}`, {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body),
    });
  } catch { throw new Error("Cannot reach server — backend may be sleeping, wait 30s and retry"); }

  const ct = res.headers.get("content-type")||"";
  if (!ct.includes("application/json")) throw new Error(`Server error (HTTP ${res.status})`);
  return res.json();
}

export async function checkEmailExists(email) {
  try {
    const res  = await fetch(`${BASE}/auth/check-email?email=${encodeURIComponent(email)}`);
    const json = await res.json();
    return json.exists===true;
  } catch { return false; }
}

export async function loginUser(email, password) {
  const json = await authPost("login",{email,password});
  if (!json.success) throw new Error(json.error||"Login failed");
  localStorage.setItem("mt_user", JSON.stringify(json.data));
  return json.data;
}

export async function signupUser(name, email, password) {
  const json = await authPost("register",{name,email,password});
  if (!json.success) {
    if (json.error==="already_registered") {
      const e=new Error(json.message||"Email already registered.");
      e.code="already_registered"; throw e;
    }
    throw new Error(json.error||"Registration failed");
  }
  localStorage.setItem("mt_user", JSON.stringify(json.data));
  return json.data;
}

export function logoutUser()    { localStorage.removeItem("mt_user"); }
export function getCurrentUser() {
  try { return JSON.parse(localStorage.getItem("mt_user")); }
  catch { return null; }
}