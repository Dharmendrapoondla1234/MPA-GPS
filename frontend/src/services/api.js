// src/services/api.js — MPA Advanced v6
const BASE = process.env.REACT_APP_API_URL || "https://vessel-backends.onrender.com/api";

// ── REQUEST DEDUPLICATION + BROWSER CACHE ────────────────────────
const inFlight  = new Map();
const respCache = new Map(); // url → { data, ts, etag }
const CACHE_TTL = { vessels: 0, stats: 115_000, history: 30_000, default: 30_000 };

// Test helper — call this in afterEach to prevent cache bleed between tests
export function __clearCache() { inFlight.clear(); respCache.clear(); }

function cacheTTL(url) {
  // Match /vessels list only — NOT /vessels/imo/history
  if (/\/vessels\?/.test(url) || url.endsWith("/vessels")) return CACHE_TTL.vessels;
  if (url.includes("/history"))  return CACHE_TTL.history;
  if (url.includes("/stats"))    return CACHE_TTL.stats;
  return CACHE_TTL.default;
}

async function call(path, { bustCache = false } = {}) {
  const url = `${BASE}${path}`;

  // Return in-flight promise immediately (dedup parallel calls)
  if (inFlight.has(url)) return inFlight.get(url);

  const cached = respCache.get(url);
  const ttl    = cacheTTL(url);
  const isTest = typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
  // Skip cache when TTL=0 (vessels), bustCache=true, or in test env
  if (!isTest && !bustCache && ttl > 0 && cached && Date.now() - cached.ts < ttl) {
    return cached.data;
  }

  const promise = (async () => {
    try {
      const token   = getCurrentUser()?.token;
      const headers = {
        Accept:            "application/json",
        "Accept-Encoding": "gzip, deflate, br",
        // Force past the browser's HTTP cache — vessel positions must always be fresh
        "Cache-Control":   "no-cache",
        "Pragma":          "no-cache",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // Send ETag so server can return 304 if data hasn't changed (saves bandwidth)
        ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
      };
      const res = await fetch(url, { headers });

      // 304 Not Modified — data unchanged. Return cached data WITHOUT resetting ts.
      // Resetting ts here caused a stale-data loop: the cache would stay "fresh"
      // indefinitely even though BQ had new positions ready.
      if (res.status === 304 && cached) {
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
        throw new Error("Backend sleeping — wait 30 seconds and retry");
      throw err;
    } finally { inFlight.delete(url); }
  })();

  inFlight.set(url, promise);
  return promise;
}

// ── VESSELS ───────────────────────────────────────────────────────
export async function fetchVessels(
  { search="", vesselType="", speedMin=null, speedMax=null, limit=5000 } = {},
  { bustCache = false } = {}
) {
  const p = new URLSearchParams();
  if (search)           p.set("search",    search);
  if (vesselType)       p.set("vesselType",vesselType);
  if (speedMin!=null)   p.set("speedMin",  speedMin);
  if (speedMax!=null)   p.set("speedMax",  speedMax);
  p.set("limit", limit);
  return call(`/vessels?${p}`, { bustCache });
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