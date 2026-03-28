// src/services/api.js — MPA Advanced v7
// Single source of truth for the API base URL.
export const BASE_URL = process.env.REACT_APP_API_URL || "https://maritime-connect.onrender.com/api";
const BASE = BASE_URL;

// ── REQUEST DEDUPLICATION + BROWSER CACHE ────────────────────────
const inFlight  = new Map();
const respCache = new Map();
const CACHE_TTL = { vessels: 58_000, stats: 120_000, contacts: 5 * 60_000, default: 55_000 };

export function __clearCache() { inFlight.clear(); respCache.clear(); }

function cacheTTL(url) {
  if (url.includes("/vessels"))  return CACHE_TTL.vessels;
  if (url.includes("/stats"))    return CACHE_TTL.stats;
  if (url.includes("/contacts") || url.includes("/vessel-contact")) return CACHE_TTL.contacts;
  return CACHE_TTL.default;
}

// Timeout constants (ms)
const TIMEOUT_DEFAULT  = 25_000;
const TIMEOUT_CONTACTS = 90_000; // enrichment pipeline can take up to ~60s

function timeoutForPath(path) {
  if (path.includes("/vessel-contact") || path.includes("/contacts")) return TIMEOUT_CONTACTS;
  return TIMEOUT_DEFAULT;
}

async function call(path, { bustCache = false, method = "GET", body } = {}) {
  const url = `${BASE}${path}`;

  if (bustCache) respCache.delete(url);
  if (method === "GET" && inFlight.has(url)) return inFlight.get(url);

  const cached = respCache.get(url);
  const isTest  = typeof process !== "undefined" && process.env.NODE_ENV === "test";
  if (method === "GET" && !isTest && !bustCache && cached && Date.now() - cached.ts < cacheTTL(url)) {
    return cached.data;
  }

  const promise = (async () => {
    const ctrl    = new AbortController();
    const timer   = setTimeout(() => ctrl.abort(), timeoutForPath(path));
    try {
      const token   = getCurrentUser()?.token;
      const headers = {
        Accept:            "application/json",
        "Accept-Encoding": "gzip, deflate, br",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      };
      const res = await fetch(url, {
        method,
        headers,
        signal: ctrl.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

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
      // For contact endpoints, return the full json (has success + data)
      if (path.includes("/contacts") || path.includes("/vessel-contact")) {
        if (json?.success === false) throw new Error(json.error || "API error");
        const data = json?.data !== undefined ? json.data : json;
        if (method === "GET") respCache.set(url, { data, ts: Date.now(), etag: res.headers.get("etag") || null });
        return data;
      }

      if (json?.success === false) throw new Error(json.error || "API error");
      const data = json?.data !== undefined ? json.data : json;
      if (method === "GET") respCache.set(url, { data, ts: Date.now(), etag: res.headers.get("etag") || null });
      return data;
    } catch (err) {
      if (err.name === "AbortError")
        throw new Error("Request timed out — the enrichment pipeline took too long. Please try again.");
      if (err.message.includes("Failed to fetch") || err.message.includes("NetworkError"))
        throw new Error("Connecting to server… will retry automatically");
      throw err;
    } finally {
      clearTimeout(timer);
      if (method === "GET") inFlight.delete(url);
    }
  })();

  if (method === "GET") inFlight.set(url, promise);
  return promise;
}

// ── KEEP-ALIVE ────────────────────────────────────────────────────
(function startKeepAlive() {
  const PING_URL = `${BASE}/health`.replace("/api/health", "/health");
  let _pingTimer = null;
  function ping() {
    fetch(PING_URL, { method: "GET", cache: "no-store" })
      .then(r => { if (r.ok) console.debug("[keep-alive] backend awake ✓"); })
      .catch(() => {});
  }
  function schedule() {
    if (_pingTimer) clearInterval(_pingTimer);
    setTimeout(ping, 2000);
    _pingTimer = setInterval(ping, 4 * 60 * 1000);
  }
  if (typeof document !== "undefined") {
    schedule();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { ping(); schedule(); }
    });
  }
})();

// ── VESSELS ───────────────────────────────────────────────────────
export async function fetchVessels(
  { search = "", vesselType = "", speedMin = null, speedMax = null, limit = 3000 } = {},
  { bustCache = false } = {}
) {
  const p = new URLSearchParams();
  if (search)         p.set("search",    search);
  if (vesselType)     p.set("vesselType", vesselType);
  if (speedMin != null) p.set("speedMin", speedMin);
  if (speedMax != null) p.set("speedMax", speedMax);
  p.set("limit", limit);
  return call(`/vessels?${p}`, { bustCache });
}

export async function fetchVesselDetail(imo) {
  return call(`/vessels/${encodeURIComponent(imo)}`);
}

export async function fetchVesselHistory(imo, hours = 24) {
  return call(`/vessels/${encodeURIComponent(imo)}/history?hours=${hours}`);
}

// ── ARRIVALS & DEPARTURES ─────────────────────────────────────────
export async function fetchArrivals(limit = 50)   { return call(`/arrivals?limit=${limit}`); }
export async function fetchDepartures(limit = 50) { return call(`/departures?limit=${limit}`); }
export async function fetchPortActivity()         { return call("/port-activity"); }

// ── CONTACT ENRICHMENT ────────────────────────────────────────────
/**
 * Fetch vessel contacts — owner, operator, manager + port agents.
 * Passes port context so backend can do targeted agent lookups.
 *
 * @param {number} imo
 * @param {Object} opts
 * @param {number}  [opts.mmsi]
 * @param {string}  [opts.name]
 * @param {string}  [opts.currentPort]  — LOCODE or port name
 * @param {string}  [opts.nextPort]     — LOCODE or port name
 * @param {string}  [opts.vesselType]   — e.g. "CONTAINER"
 * @param {boolean} [opts.bustCache]    — force fresh fetch
 */
export async function fetchVesselContacts(imo, {
  mmsi, name, currentPort, nextPort, vesselType, bustCache = false,
} = {}) {
  const p = new URLSearchParams();
  if (mmsi)        p.set("mmsi",        String(mmsi));
  if (name)        p.set("name",        name);
  if (currentPort) p.set("currentPort", currentPort);
  if (nextPort)    p.set("nextPort",    nextPort);
  if (vesselType)  p.set("vesselType",  vesselType);
  // Use spec endpoint instead — richer response, same data
  return call(`/vessel-contact?imo=${encodeURIComponent(imo)}&${p}`, { bustCache });
}

/**
 * Fetch port agents by LOCODE or port name.
 * Checks BQ first, then static DB, then AI.
 */
export async function fetchPortAgents(portCode, vesselType = "", bustCache = false) {
  const p = new URLSearchParams({ port: portCode });
  if (vesselType) p.set("vesselType", vesselType);
  return call(`/contacts/agents?${p}`, { bustCache });
}

/**
 * Trigger force re-run of the full enrichment pipeline for an IMO.
 * Returns enriched contact data immediately.
 */
export async function triggerVesselEnrichment(imo, {
  vessel_name, current_port, next_port, vessel_type,
} = {}) {
  return call(`/contacts/enrich/${encodeURIComponent(imo)}`, {
    method: "POST",
    body: { vessel_name, current_port, next_port, vessel_type },
    bustCache: true,
  });
}

/**
 * Spec endpoint: GET /api/vessel-contact?imo=XXXX
 * Returns the standardized format from the requirements doc.
 */
export async function fetchVesselContactSpec(imo, {
  mmsi, name, currentPort, nextPort, vesselType, enrich, bustCache = false,
} = {}) {
  const p = new URLSearchParams();
  if (imo)             p.set("imo",         String(imo));
  if (mmsi)            p.set("mmsi",        String(mmsi));
  if (name)            p.set("name",        name);
  if (currentPort)     p.set("currentPort", currentPort);
  if (nextPort)        p.set("nextPort",    nextPort);
  if (vesselType)      p.set("vesselType",  vesselType);
  if (enrich === false) p.set("enrich",     "false");
  return call(`/vessel-contact?${p}`, { bustCache });
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
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch { throw new Error("Cannot reach server — backend may be sleeping, wait 30s and retry"); }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error(`Server error (HTTP ${res.status})`);
  return res.json();
}

export async function checkEmailExists(email) {
  try {
    const res  = await fetch(`${BASE}/auth/check-email?email=${encodeURIComponent(email)}`);
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
      const e = new Error(json.message || "Email already registered.");
      e.code = "already_registered"; throw e;
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