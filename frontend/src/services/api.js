// src/services/api.js
// FIXED: Uses Render backend URL, never falls back to localhost

const BASE =
  process.env.REACT_APP_API_URL ||
  "https://vessel-backendsl.onrender.com/api"; // ← Render URL hardcoded as fallback

console.log("🔌 API connecting to:", BASE);

async function call(path) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} — ${txt.slice(0, 200)}`);
    }
    const json = await res.json();
    if (json?.success === false) throw new Error(json.error || "API error");
    if (json?.data !== undefined) return json.data;
    return json;
  } catch (err) {
    if (
      err.message.includes("Failed to fetch") ||
      err.message.includes("NetworkError")
    ) {
      throw new Error(
        `Cannot reach backend at ${BASE} — backend may be sleeping (wait 30s and retry)`
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

// ── Auth (client-side only) ──────────────────────────────
export function loginUser(email, password) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (email && password && password.length >= 6) {
        const user = {
          email,
          name: email.split("@")[0],
          role: "Operator",
          avatar: email[0].toUpperCase(),
        };
        localStorage.setItem("mt_user", JSON.stringify(user));
        resolve(user);
      } else {
        reject(new Error("Password must be 6+ characters"));
      }
    }, 600);
  });
}

export function signupUser(name, email, password) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (name && email && password && password.length >= 6) {
        const user = {
          email,
          name,
          role: "Operator",
          avatar: name[0].toUpperCase(),
        };
        localStorage.setItem("mt_user", JSON.stringify(user));
        resolve(user);
      } else {
        reject(new Error("All fields required, password 6+ chars"));
      }
    }, 700);
  });
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
