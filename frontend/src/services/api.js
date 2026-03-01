// src/services/api.js
const BASE =
  process.env.REACT_APP_API_URL || "https://vessel-backendsl.onrender.com/api";

console.log("🔌 API connecting to:", BASE);

async function call(path, opts = {}) {
  const url = `${BASE}${path}`;
  try {
    const token = getCurrentUser()?.token;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...opts,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} — ${txt.slice(0, 200)}`);
    }
    const json = await res.json();
    if (json?.success === false)
      throw new Error(json.error || json.message || "API error");
    if (json?.data !== undefined) return json.data;
    return json;
  } catch (err) {
    if (
      err.message.includes("Failed to fetch") ||
      err.message.includes("NetworkError")
    ) {
      throw new Error(
        `Cannot reach backend at ${BASE} — backend may be sleeping (wait 30s and retry)`,
      );
    }
    throw err;
  }
}

export async function fetchVessels({
  search = "",
  vesselType = "",
  speedMin = null,
  speedMax = null,
  limit = 500,
} = {}) {
  const p = new URLSearchParams();
  if (search) p.set("search", search);
  if (vesselType) p.set("vesselType", vesselType);
  if (speedMin != null) p.set("speedMin", speedMin);
  if (speedMax != null) p.set("speedMax", speedMax);
  if (limit) p.set("limit", limit);
  return call(`/vessels?${p}`);
}

export async function fetchVesselHistory(imo, hours = 24) {
  return call(`/vessels/${encodeURIComponent(imo)}/history?hours=${hours}`);
}

export async function fetchVesselTypes() {
  return call("/vessel-types");
}
export async function fetchFleetStats() {
  return call("/stats");
}

// ── Auth — Real backend ──────────────────────────────────────
export async function checkEmailExists(email) {
  try {
    const res = await fetch(
      `${BASE}/auth/check-email?email=${encodeURIComponent(email)}`,
    );
    const json = await res.json();
    return json.exists === true;
  } catch {
    return false;
  }
}

export async function loginUser(email, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json.success)
    throw new Error(json.error || json.message || "Login failed");
  localStorage.setItem("mt_user", JSON.stringify(json.data));
  return json.data;
}

export async function signupUser(name, email, password) {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  const json = await res.json();
  if (!json.success) {
    if (json.error === "already_registered") {
      const err = new Error(
        json.message || "Email already registered. Please sign in.",
      );
      err.code = "already_registered";
      throw err;
    }
    throw new Error(json.error || "Registration failed");
  }
  localStorage.setItem("mt_user", JSON.stringify(json.data));
  return json.data;
}

export function logoutUser() {
  localStorage.removeItem("mt_user");
}

export function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem("mt_user"));
  } catch {
    return null;
  }
}
