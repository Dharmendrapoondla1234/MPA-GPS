// backend/src/services/contactEnricher.js — MPA AI Contact Enricher v6
//
// FULL MULTI-SOURCE PIPELINE:
// STEP 1  Equasis           — IMO-verified owner/manager/ISM (conf 0.92)
// STEP 2  MarineTraffic     — Vessel details + company name (conf 0.80)
// STEP 3  VesselFinder      — Owner/operator name fallback  (conf 0.75)
// STEP 4  AI IMO Lookup     — Claude searches all maritime DBs by IMO (conf 0.70)
// STEP 5  AI Company Search — Claude finds email/phone/website for company (conf 0.75)
// STEP 6  Website Scrape    — Direct scrape of company contact page (conf 0.85)
// STEP 7  Google CSE        — Email/phone from search snippets (conf 0.65)
// STEP 8  LinkedIn Search   — Company LinkedIn profile via AI (conf 0.60)
// STEP 9  Port Agent DB     — Static seed lookup by LOCODE/name
// STEP 10 AI Port Agents    — Claude searches for agents not in DB
// STEP 11 Agent Org         — Husbandry/ship agent organisation
// STEP 12 Master Contact    — Captain contact channel info
// STEP 13 BigQuery Save     — Persist enriched data
"use strict";
require("dotenv").config();
const { BigQuery }  = require("@google-cloud/bigquery");
const Anthropic     = require("@anthropic-ai/sdk");
const logger        = require("../utils/logger");
const { lookupPortAgents, rankAgents } = require("./portAgentDB");

const PROJECT     = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET     = process.env.BIGQUERY_DATASET    || "MPA";
const BQ_LOCATION = process.env.BIGQUERY_LOCATION   || "asia-southeast1";
const MODEL       = "claude-haiku-4-5-20251001"; // corrected model ID

// ── BigQuery client ────────────────────────────────────────────────
let bq;
const _creds = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (_creds && _creds.trim().startsWith("{")) {
  try {
    const c = JSON.parse(_creds);
    bq = new BigQuery({ credentials: c, projectId: c.project_id || PROJECT, location: BQ_LOCATION });
  } catch { bq = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION }); }
} else {
  bq = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION });
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
if (!process.env.ANTHROPIC_API_KEY) {
  logger.warn("[contactEnricher] ⚠️  ANTHROPIC_API_KEY is not set — all AI enrichment steps will be skipped");
}

// ── Caches ─────────────────────────────────────────────────────────
const enrichCache    = new Map();
const portAgentCache = new Map();
const ENRICH_TTL     = 30 * 24 * 60 * 60 * 1000;
const PORT_AGENT_TTL =  7 * 24 * 60 * 60 * 1000;

function cacheGet(map, k, ttl) {
  const h = map.get(k);
  return h && Date.now() - h.ts < ttl ? h.data : null;
}
function cacheSet(map, k, d) { map.set(k, { data: d, ts: Date.now() }); return d; }

// ── Shared utilities ───────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?[\d\s\-().]{7,20})/g;

function extractEmails(text) {
  return [...new Set((text || "").match(EMAIL_RE) || [])].filter(e =>
    !e.includes("example") && !e.includes("yourdomain") &&
    !e.includes("@2x") && !e.includes(".png") && e.length < 80
  );
}
function extractPhones(text) {
  return [...new Set((text || "").match(PHONE_RE) || [])]
    .map(p => p.trim()).filter(p => p.replace(/\D/g, "").length >= 7);
}

function safeJson(text) {
  if (!text) return null;
  try {
    // Match the LAST {...} block — avoids grabbing the prompt template if echoed back
    const matches = [...text.matchAll(/\{[\s\S]*?\}/g)];
    // Find the largest match (most likely the real answer, not a snippet)
    const best = matches.reduce((a, b) => b[0].length > a[0].length ? b : a, { 0: "{}" });
    return JSON.parse(best[0]);
  } catch { return null; }
}

// Reject company names that look like field-label echo or template garbage
function isValidCompanyName(name) {
  if (!name || typeof name !== "string") return false;
  if (name.length < 3 || name.length > 120) return false;
  // Reject if it contains 3+ JSON field keywords — means the AI returned the schema
  const fieldKeywords = ["Website", "Email", "Address", "Manager", "Phone", "ISM", "Operator", "Owner"];
  const hits = fieldKeywords.filter(k => name.includes(k)).length;
  if (hits >= 3) return false;
  // Reject pure lowercase (field names) or all-punctuation
  if (/^[a-z_]+$/.test(name)) return false;
  // Reject if it looks like a JSON key list
  if (name.includes(":null") || name.includes('":"')) return false;
  return true;
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error("step timeout")), ms); }),
  ]).finally(() => clearTimeout(t));
}

async function safeFetch(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/json,*/*",
        ...opts.headers,
      },
      ...opts,
    });
  } finally { clearTimeout(t); }
}

// ── Cookie helpers ────────────────────────────────────────────────
// Parse ALL Set-Cookie headers from a response into a name→value map,
// so duplicate names (e.g. two JSESSIONID) keep only the LATEST value.
function parseCookieHeaders(res) {
  let raw = [];
  if (typeof res.headers.getSetCookie === "function") {
    raw = res.headers.getSetCookie();
  } else {
    const h = res.headers.get("set-cookie") || "";
    // Split on commas that precede a new cookie name (not inside expires dates)
    raw = h.split(/,(?=\s*[A-Za-z0-9_-]+=)/).map(s => s.trim());
  }
  const map = new Map();
  for (const cookie of raw) {
    const [pair] = cookie.split(";");
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name  = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    map.set(name, value); // later cookies overwrite earlier ones (correct)
  }
  return map;
}

function mapToCookieHeader(map) {
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function mergeCookieMaps(...maps) {
  const merged = new Map();
  for (const m of maps) for (const [k, v] of m) merged.set(k, v);
  return merged;
}

// ═════════════════════════════════════════════════════════════════
// STEP 1: EQUASIS (IMO-verified owner/manager/ISM)
// ═════════════════════════════════════════════════════════════════
const EQ_BASE = "https://www.equasis.org/EquasisWeb";

// Session state — module-level, persists across requests
let _eqCookieMap  = null;   // Map of name→value for current session
let _eqCookieTs   = 0;
let _eqLoginLock  = false;  // prevent concurrent login races
// Real Equasis server-side sessions time out after ~30 min of inactivity.
// We use 20 min so we always re-login before the server kills our session.
const EQ_SESSION_TTL = 20 * 60 * 1000;

function isSessionExpiredHtml(html) {
  // When session expires, Equasis returns the login page which contains these markers
  const lower = (html || "").toLowerCase();
  return lower.includes("j_password") || lower.includes("j_email") ||
         lower.includes("please login") || lower.includes("please log in") ||
         (lower.includes("login") && lower.includes("password") && !lower.includes("logout"));
}

function invalidateSession(reason) {
  logger.warn(`[equasis] session invalidated: ${reason}`);
  _eqCookieMap = null;
  _eqCookieTs  = 0;
}

async function equasisLogin(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _eqCookieMap && (now - _eqCookieTs) < EQ_SESSION_TTL) {
    return mapToCookieHeader(_eqCookieMap);
  }

  // Prevent concurrent login storms
  if (_eqLoginLock) {
    await new Promise(r => setTimeout(r, 3000));
    if (_eqCookieMap) return mapToCookieHeader(_eqCookieMap);
  }
  _eqLoginLock = true;

  const email = process.env.EQUASIS_EMAIL;
  const pass  = process.env.EQUASIS_PASSWORD;
  if (!email || !pass) {
    _eqLoginLock = false;
    logger.warn("[equasis] EQUASIS_EMAIL/PASSWORD not set");
    return null;
  }

  try {
    // Step 1: GET public home — captures initial JSESSIONID (pre-auth)
    const pageRes      = await safeFetch(`${EQ_BASE}/public/HomePage`, {
      headers: { "Accept": "text/html,application/xhtml+xml,*/*" },
    }, 12000);
    const pageCookies  = parseCookieHeaders(pageRes);
    logger.info(`[equasis] pre-login cookies: ${mapToCookieHeader(pageCookies).slice(0, 80)}`);

    // Step 2: POST credentials — Equasis sets a new authenticated JSESSIONID here
    // Using redirect:"manual" so we capture Set-Cookie on the 302 response itself,
    // not the final redirected page (where Set-Cookie is absent).
    const loginRes = await safeFetch(`${EQ_BASE}/authen/HomePage?fs=HomePage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie":       mapToCookieHeader(pageCookies),
        "Referer":      `${EQ_BASE}/public/HomePage`,
        "Accept":       "text/html,application/xhtml+xml,*/*",
        "Origin":       "https://www.equasis.org",
      },
      body: new URLSearchParams({ j_email: email, j_password: pass, submit: "Login" }),
      redirect: "manual",   // ← KEY FIX: capture 302 Set-Cookie before following
    }, 15000);

    // Merge: pre-login cookies + login-response cookies (login JSESSIONID wins)
    const loginCookies   = parseCookieHeaders(loginRes);
    const mergedCookies  = mergeCookieMaps(pageCookies, loginCookies);
    logger.info(`[equasis] login status=${loginRes.status} cookies: ${mapToCookieHeader(mergedCookies).slice(0, 120)}`);

    // If 302 redirect, follow it manually to verify we land on the authenticated page
    let finalBody = "";
    if (loginRes.status === 302 || loginRes.status === 301) {
      const location = loginRes.headers.get("location") || "";
      const redirectUrl = new URL(location, EQ_BASE).href;
      logger.info(`[equasis] following login redirect → ${redirectUrl}`);
      const finalRes = await safeFetch(redirectUrl, {
        headers: {
          "Cookie":  mapToCookieHeader(mergedCookies),
          "Referer": `${EQ_BASE}/authen/HomePage?fs=HomePage`,
          "Accept":  "text/html,application/xhtml+xml,*/*",
        },
        redirect: "follow",
      }, 12000);
      // Merge any further cookies from the final page
      const finalCookies = parseCookieHeaders(finalRes);
      finalCookies.forEach((v, k) => mergedCookies.set(k, v));
      finalBody = await finalRes.text();
    } else {
      finalBody = await loginRes.text();
    }

    const bodyLower = finalBody.toLowerCase();
    const failed = bodyLower.includes("invalid") || bodyLower.includes("incorrect") ||
                   bodyLower.includes("j_password") || bodyLower.includes("authentication failed") ||
                   bodyLower.includes("access denied");
    const ok = !failed && (bodyLower.includes("logout") || bodyLower.includes("welcome") ||
                            bodyLower.includes("kaizentric") || bodyLower.includes("my equasis"));

    logger.info(`[equasis] login ok=${ok} jsessionid=${mergedCookies.get("JSESSIONID")?.slice(0, 12)}…`);
    if (!ok) {
      _eqLoginLock = false;
      logger.warn("[equasis] Login FAILED — check EQUASIS_EMAIL/PASSWORD env vars");
      return null;
    }

    _eqCookieMap = mergedCookies;
    _eqCookieTs  = Date.now();
    _eqLoginLock = false;
    logger.info(`[equasis] Login OK — session valid for ${EQ_SESSION_TTL/60000} min`);
    return mapToCookieHeader(_eqCookieMap);
  } catch (err) {
    _eqLoginLock = false;
    logger.warn(`[equasis] Login error: ${err?.message || String(err)}`);
    return null;
  }
}

function parseEquasisHtml(html) {
  const strip = s => (s || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&")
                               .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

  // Equasis ShipInfo page renders company data in table rows like:
  // <tr><td class="...">Registered owner</td><td class="..."><a href="...">COMPANY NAME</a></td></tr>
  // We extract the text content of the <td> that follows each label <td>

  function extractAfterLabel(labelPattern) {
    // Match: <td>LABEL</td> ... <td>VALUE</td> within the same <tr>
    const patterns = [
      // Standard <td> adjacency (classic Equasis layout)
      new RegExp(`<td[^>]*>[^<]*${labelPattern}[^<]*<\/td>\\s*<td[^>]*>([\\s\\S]{2,200}?)<\/td>`, "i"),
      // Equasis v2 — label in <div> then sibling <div> with value
      new RegExp(`<div[^>]*>[^<]*${labelPattern}[^<]*<\/div>\\s*<div[^>]*>([\\s\\S]{2,200}?)<\/div>`, "i"),
      // Equasis v2 — label in <span> then value in next <span> or <td>
      new RegExp(`<span[^>]*>[^<]*${labelPattern}[^<]*<\/span>[^<]*<(?:span|td)[^>]*>([\\s\\S]{2,200}?)<\/(?:span|td)>`, "i"),
      // Wide fallback — label text then next td with info class
      new RegExp(`${labelPattern}[\\s\\S]{0,600}?<td[^>]*class="[^"]*info[^"]*"[^>]*>([\\s\\S]{2,200}?)<\/td>`, "i"),
      // Widest fallback — label text followed by any block element
      new RegExp(`${labelPattern}[\\s\\S]{0,400}?<(?:td|div|span)[^>]*>([\\s\\S]{2,200}?)<\/(?:td|div|span)>`, "i"),
    ];
    for (const re of patterns) {
      const m = re.exec(html);
      if (!m) continue;
      const val = strip(m[1]);
      if (!val || val.length < 2 || /^[-–]$/.test(val)) continue;
      if (/^(n\/a|none|unknown|not available|-)$/i.test(val)) continue;
      if (/^(search|login|logout|home|back|next|previous|submit)$/i.test(val)) continue;
      return val;
    }
    return null;
  }

  // Extract linked company names — Equasis links them as <a href="...Compan...">NAME</a>
  function extractLinkedName(labelPattern) {
    // Match company links (href contains "Compan" or "company")
    const re = new RegExp(`${labelPattern}[\\s\\S]{0,500}?<a[^>]+href="[^"]*[Cc]ompan[^"]*"[^>]*>([^<]{3,100})<\/a>`, "i");
    const m = re.exec(html);
    if (!m) return null;
    const val = strip(m[1]);
    return (val && val.length > 2) ? val : null;
  }

  // Try JSON-LD structured data (some Equasis pages embed it)
  function extractFromJsonLd(key) {
    const ldM = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (!ldM) return null;
    try { const ld = JSON.parse(ldM[1]); return ld[key] || null; } catch { return null; }
  }

  const owner   = extractLinkedName("Registered owner")   || extractAfterLabel("Registered owner")   || extractFromJsonLd("owner");
  const manager = extractLinkedName("ISM Manager")        || extractAfterLabel("ISM Manager") || extractAfterLabel("ISM manager");
  const shipMgr = extractLinkedName("Ship manager")       || extractAfterLabel("Ship manager");
  const operator= extractLinkedName("Operator")           || extractAfterLabel("(?<!ISM )[Oo]perator");
  const flag    = extractAfterLabel("Flag");
  const address = extractAfterLabel("Address");

  return { owner, manager, shipMgr, operator, flag, address };
}

// ── Detect if Equasis has expired/invalidated our session ────────
// Returns true if the HTML response is actually the login page
function responseIsLoginPage(html, url) {
  if (!html) return false;
  if ((url || "").includes("/public/") && (url || "").includes("HomePage")) return true;
  return isSessionExpiredHtml(html);
}

// ── Detect Equasis quota/rate-limit responses ─────────────────────
function responseIsQuotaError(html) {
  const lower = (html || "").toLowerCase();
  return lower.includes("quota") || lower.includes("too many") ||
         lower.includes("rate limit") || lower.includes("exceeded") ||
         lower.includes("temporarily unavailable") || lower.includes("try again later");
}

async function fetchFromEquasis(imo, retryCount = 0) {
  let cookies = await equasisLogin();
  if (!cookies) return null;
  const hdrs = {
    "Cookie":     cookies,
    "Accept":     "text/html,application/xhtml+xml,*/*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Origin":     "https://www.equasis.org",
    "Accept-Language": "en-US,en;q=0.9",
  };

  // Helper: run a fetch and check if the response is a login redirect
  // Returns { html, sessionExpired, quotaError }
  async function checkedFetch(url, opts, timeoutMs) {
    const res = await safeFetch(url, opts, timeoutMs);
    if (!res?.ok) return { html: null, sessionExpired: false, quotaError: false };
    const html  = await res.text();
    const sessionExpired = responseIsLoginPage(html, res.url);
    const quotaError     = responseIsQuotaError(html);
    if (sessionExpired) logger.warn(`[equasis] session expired detected on ${res.url}`);
    if (quotaError)     logger.warn(`[equasis] quota/rate-limit detected on ${res.url}`);
    return { html, sessionExpired, quotaError, url: res.url };
  }

  let html = "";
  let sessionExpiredDetected = false;

  try {
    // ── STRATEGY A ──────────────────────────────────────────────
    const refA = `${EQ_BASE}/authen/HomePage?fs=HomePage`;
    const A1 = await checkedFetch(`${EQ_BASE}/restricted/Search?fs=HomePage`, {
      method: "POST",
      headers: { ...hdrs, "Content-Type": "application/x-www-form-urlencoded", "Referer": refA },
      body: new URLSearchParams({ P_ENTREE_HOME: String(imo), checkbox_ship: "on", P_PAGE_SHIP: "1" }),
      redirect: "follow",
    }, 15000);
    logger.info(`[equasis] A1 search url=${A1.url}`);

    if (A1.sessionExpired) { sessionExpiredDetected = true; }
    else if (A1.quotaError) { logger.warn("[equasis] quota hit on A1"); return null; }
    const searchRes = { ok: !!A1.html, url: A1.url, text: () => A1.html };
    const searchHtml = A1.html || "";

    if (searchHtml) {
      const searchText = searchHtml.replace(/<[^>]+>/g," ").replace(/\s+/g," ");
      logger.info(`[equasis] A1 search text (0-400): ${searchText.slice(0, 400)}`);

      // Case 1: Search returned ship detail page directly
      if (searchHtml.includes("Registered owner") || searchHtml.includes("ISM Manager")) {
        html = searchHtml;
        logger.info(`[equasis] A1 returned ship detail directly`);
      }

      // Case 2: The search page returned is the BLANK search form (not results yet).
      // Equasis's search form has action="../restricted/ShipInfo?fs=Search" (relative URL).
      // We must resolve the relative URL correctly and inject the IMO into P_ENTREE_HOME_HIDDEN.
      if (!html) {
        // Resolve the form action URL relative to the current page URL
        const resolveUrl = (base, rel) => {
          try { return new URL(rel, base).href; } catch { return null; }
        };

        // Find the search/ship form action
        const formActionM = /action="([^"]*ShipInfo[^"]*)"/.exec(searchHtml) ||
                            /action="([^"]*Search[^"]*)"/.exec(searchHtml) ||
                            /action="([^"]*restricted[^"]*)"/.exec(searchHtml);

        if (formActionM) {
          // Resolve relative URL (handles "../restricted/ShipInfo?fs=Search" correctly)
          const formAction = resolveUrl(searchRes.url, formActionM[1]);
          if (!formAction) { logger.warn("[equasis] Could not resolve form URL"); }
          else {
            // Collect all hidden input fields
            const hiddenInputs = {};
            let m;
            // Try all attribute orderings
            for (const re of [
              /<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"[^>]*>/gi,
              /<input[^>]+name="([^"]+)"[^>]+type="hidden"[^>]+value="([^"]*)"[^>]*>/gi,
              /<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"[^>]*type="hidden"[^>]*>/gi,
            ]) {
              const reCopy = new RegExp(re.source, re.flags);
              while ((m = reCopy.exec(searchHtml)) !== null) {
                if (!hiddenInputs[m[1]]) hiddenInputs[m[1]] = m[2];
              }
            }

            // Inject the IMO into the right fields — override empty ones
            hiddenInputs["P_ENTREE_HOME_HIDDEN"] = String(imo);
            hiddenInputs["P_IMO"]                = String(imo);
            hiddenInputs["ongletActifSC"]         = "ship";
            hiddenInputs["checkbox_ship"]         = "on";
            // Remove the Submit button field — we add it separately
            delete hiddenInputs["Submit"];

            logger.info(`[equasis] A2 form POST to: ${formAction} fields: ${JSON.stringify(hiddenInputs)}`);
            const A2 = await checkedFetch(formAction, {
              method: "POST",
              headers: { ...hdrs, "Content-Type": "application/x-www-form-urlencoded",
                "Referer": A1.url || `${EQ_BASE}/restricted/Search?fs=HomePage` },
              body: new URLSearchParams({ ...hiddenInputs, Submit: "Search" }),
              redirect: "follow",
            }, 15000);
            logger.info(`[equasis] A2 result: url=${A2.url}`);
            if (A2.sessionExpired) { sessionExpiredDetected = true; }
            else if (A2.html) {
              const a2html = A2.html;
              const a2text = a2html.replace(/<[^>]+>/g," ").replace(/\s+/g," ");
              logger.info(`[equasis] A2 text (0-500): ${a2text.slice(0, 500)}`);

              if (a2html.includes("Registered owner") || a2html.includes("ISM Manager")) {
                html = a2html;
              } else {
                const shipLinkM = /href="([^"]*ShipInfo[^"]*)"/.exec(a2html) ||
                                  /action="([^"]*ShipInfo[^"]*)"/.exec(a2html);
                if (shipLinkM) {
                  const shipUrl = resolveUrl(A2.url, shipLinkM[1]);
                  logger.info(`[equasis] A3 following ship link: ${shipUrl}`);
                  if (shipUrl) {
                    const A3 = await checkedFetch(shipUrl, {
                      headers: { ...hdrs, "Referer": A2.url }, redirect: "follow",
                    }, 12000);
                    if (!A3.sessionExpired && A3.html) html = A3.html;
                    else if (A3.sessionExpired) sessionExpiredDetected = true;
                  }
                }
                const shipIdM = /P_SHIP_ID[^>]+value="([^"]+)"/.exec(a2html) ||
                                /name="P_SHIP_ID"[^>]+value="([^"]+)"/.exec(a2html);
                if (shipIdM && (!html || !html.includes("Registered owner"))) {
                  logger.info(`[equasis] A4 P_SHIP_ID=${shipIdM[1]}`);
                  const a4url = resolveUrl(A2.url, "../restricted/ShipInfo?fs=Search");
                  if (a4url) {
                    const A4 = await checkedFetch(a4url, {
                      method: "POST",
                      headers: { ...hdrs, "Content-Type": "application/x-www-form-urlencoded", "Referer": A2.url },
                      body: new URLSearchParams({ P_SHIP_ID: shipIdM[1], fs: "Search" }),
                      redirect: "follow",
                    }, 12000);
                    if (!A4.sessionExpired && A4.html) html = A4.html;
                    else if (A4.sessionExpired) sessionExpiredDetected = true;
                  }
                }
              }
            }
          }
        }
      }
    }

    const hasData = h => h && (h.includes("Registered owner") || h.includes("ISM Manager"));
    const resolveUrl = (base, rel) => { try { return new URL(rel, base).href; } catch { return null; } };
    const textOf = h => (h||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ");

    // ── STRATEGY B: POST to restricted/ShipInfo with P_IMO directly ──
    if (!hasData(html) && !sessionExpiredDetected) {
      logger.info(`[equasis] Strategy B: POST restricted/ShipInfo`);
      const B = await checkedFetch(`${EQ_BASE}/restricted/ShipInfo?fs=Search`, {
        method: "POST",
        headers: { ...hdrs, "Content-Type": "application/x-www-form-urlencoded",
          "Referer": `${EQ_BASE}/restricted/Search?fs=HomePage` },
        body: new URLSearchParams({
          P_IMO: String(imo), P_ENTREE_HOME_HIDDEN: String(imo),
          ongletActifSC: "ship", checkbox_ship: "on", P_PAGE_SHIP: "1",
        }),
        redirect: "follow",
      }, 12000);
      if (B.sessionExpired) { sessionExpiredDetected = true; }
      else if (B.html) {
        logger.info(`[equasis] B text (0-500): ${textOf(B.html).slice(0, 500)}`);
        if (hasData(B.html)) html = B.html;
        else {
          const lm = /href="([^"]*ShipInfo[^"]*)"/.exec(B.html) || /action="([^"]*ShipInfo[^"]*)"/.exec(B.html);
          if (lm) {
            const lu = resolveUrl(B.url, lm[1]);
            if (lu) {
              const BL = await checkedFetch(lu, { headers: { ...hdrs, "Referer": B.url }, redirect: "follow" }, 12000);
              if (!BL.sessionExpired && BL.html && hasData(BL.html)) html = BL.html;
              else if (BL.sessionExpired) sessionExpiredDetected = true;
            }
          }
        }
      }
    }

    // ── STRATEGY C: POST to restricted/Search?fs=ByShip with P_IMO ───
    if (!hasData(html) && !sessionExpiredDetected) {
      logger.info(`[equasis] Strategy C: POST restricted/Search?fs=ByShip`);
      const C = await checkedFetch(`${EQ_BASE}/restricted/Search?fs=ByShip`, {
        method: "POST",
        headers: { ...hdrs, "Content-Type": "application/x-www-form-urlencoded",
          "Referer": `${EQ_BASE}/authen/HomePage?fs=HomePage` },
        body: new URLSearchParams({
          P_IMO: String(imo), P_ENTREE_HOME_HIDDEN: String(imo),
          ongletActifSC: "ship", checkbox_ship: "on",
        }),
        redirect: "follow",
      }, 12000);
      if (C.sessionExpired) { sessionExpiredDetected = true; }
      else if (C.html) {
        logger.info(`[equasis] C text (0-500): ${textOf(C.html).slice(0, 500)}`);
        if (hasData(C.html)) html = C.html;
        else {
          const lm = /href="([^"]*ShipInfo[^"]*)"/.exec(C.html) || /action="([^"]*ShipInfo[^"]*)"/.exec(C.html);
          if (lm) {
            const lu = resolveUrl(C.url, lm[1]);
            if (lu) {
              const CL = await checkedFetch(lu, { headers: { ...hdrs, "Referer": C.url }, redirect: "follow" }, 12000);
              if (!CL.sessionExpired && CL.html && hasData(CL.html)) html = CL.html;
              else if (CL.sessionExpired) sessionExpiredDetected = true;
            }
          }
        }
      }
    }

    // ── STRATEGY D: legacy authen/ShipInfo POST ───────────────────────
    if (!hasData(html) && !sessionExpiredDetected) {
      logger.info(`[equasis] Strategy D: POST authen/ShipInfo`);
      const D = await checkedFetch(`${EQ_BASE}/authen/ShipInfo`, {
        method: "POST",
        headers: { ...hdrs, "Content-Type": "application/x-www-form-urlencoded",
          "Referer": `${EQ_BASE}/authen/HomePage?fs=HomePage` },
        body: new URLSearchParams({ P_IMO: String(imo) }),
        redirect: "follow",
      }, 12000);
      if (D.sessionExpired) { sessionExpiredDetected = true; }
      else if (D.html) {
        logger.info(`[equasis] D text (0-500): ${textOf(D.html).slice(0, 500)}`);
        if (hasData(D.html)) html = D.html;
      }
    }

    // ── SESSION EXPIRED: invalidate + retry once ──────────────────────
    if (sessionExpiredDetected) {
      logger.warn(`[equasis] session expired mid-fetch for IMO ${imo} — invalidating and retrying`);
      invalidateSession("detected during IMO fetch strategies");
      if (retryCount < 1) {
        logger.info(`[equasis] re-login and retry for IMO ${imo}`);
        await new Promise(r => setTimeout(r, 1500)); // brief pause before re-login
        return fetchFromEquasis(imo, retryCount + 1);
      }
      logger.warn(`[equasis] retry exhausted for IMO ${imo}`);
      return null;
    }

    // Log a snippet so we can debug what Equasis actually returned
    if (html) {
      const snippet = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300);
      logger.info(`[equasis] HTML snippet for IMO ${imo}: ${snippet}`);
    }

    if (!html.includes("Registered owner") && !html.includes("ISM")) {
      logger.warn(`[equasis] All strategies failed for IMO ${imo} — no ship data in any response`);
      return null;
    }

    const p = parseEquasisHtml(html);
    if (!p.owner && !p.manager) {
      logger.warn(`[equasis] HTML found but could not extract company for IMO ${imo}`);
      // Log 1000 chars of stripped text + a snippet of raw HTML around known label keywords
      const dbg = html.replace(/<[^>]+>/g," ").replace(/\s+/g," ").slice(0,500);
      logger.info(`[equasis] debug text: ${dbg}`);
      // Also log 200 chars of raw HTML around "owner" keyword if present
      const ownerIdx = html.toLowerCase().indexOf("owner");
      if (ownerIdx > -1) {
        logger.info(`[equasis] raw HTML around 'owner' (±200): ${html.slice(Math.max(0, ownerIdx-50), ownerIdx+200)}`);
      }
      return null;
    }
    logger.info(`[equasis] ✅ IMO ${imo}: owner="${p.owner}" manager="${p.manager}" flag="${p.flag}"`);
    return {
      owner_name: p.owner, manager_name: p.manager, ship_manager: p.shipMgr,
      operator_name: p.operator, address: p.address, flag: p.flag,
      source: "equasis", confidence: 0.92,
    };
  } catch (err) {
    logger.warn(`[equasis] fetch error: ${err?.message || String(err)}`);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 2: MARINETRAFFIC (vessel details + owner name)
// ═════════════════════════════════════════════════════════════════
async function fetchFromMarineTraffic(imo) {
  try {
    const res = await safeFetch(
      `https://www.marinetraffic.com/en/ais/details/ships/imo:${imo}`,
      { headers: { "Referer": "https://www.marinetraffic.com/" } }, 12000
    );
    if (!res.ok) return null;
    const html = await res.text();

    // Try JSON-LD structured data first
    const ldMatch = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i.exec(html);
    if (ldMatch) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        if (ld.name || ld.owner) {
          return { vessel_name: ld.name || null, owner_name: ld.owner || null,
                   flag: ld.flag || null, source: "marinetraffic", confidence: 0.80 };
        }
      } catch { /* continue */ }
    }

    // Try meta description (often has vessel name and basic info)
    const metaM = /<meta[^>]+(?:name="description"|property="og:description")[^>]+content="([^"]{10,300})"/i.exec(html);
    if (metaM) {
      const desc = metaM[1];
      const nameInMeta = /^([A-Z][A-Z0-9\s\-]{2,35})\s*[-–,]/i.exec(desc);
      if (nameInMeta) {
        logger.info(`[marinetraffic] meta IMO ${imo}: vessel="${nameInMeta[1].trim()}"`);
        return { vessel_name: nameInMeta[1].trim() || null, owner_name: null,
                 source: "marinetraffic", confidence: 0.60 };
      }
    }

    // Look for owner in specific MT data rows (they render as: <td>Registered Owner</td><td>NAME</td>)
    const ownerRowM = /Registered Owner[\s\S]{0,300}?<td[^>]*>([^<]{4,80})<\/td>/i.exec(html);
    const mgrRowM   = /ISM Manager[\s\S]{0,300}?<td[^>]*>([^<]{4,80})<\/td>/i.exec(html);
    const flagRowM  = /Flag[\s\S]{0,200}?<td[^>]*>([^<]{2,40})<\/td>/i.exec(html);

    const ownerVal   = ownerRowM?.[1]?.trim().replace(/<[^>]+>/g,"").trim();
    const mgrVal     = mgrRowM?.[1]?.trim().replace(/<[^>]+>/g,"").trim();
    const flagVal    = flagRowM?.[1]?.trim().replace(/<[^>]+>/g,"").trim();

    if (!isValidCompanyName(ownerVal) && !isValidCompanyName(mgrVal)) return null;
    logger.info(`[marinetraffic] IMO ${imo}: owner="${ownerVal}" mgr="${mgrVal}"`);
    return {
      vessel_name:  null,
      owner_name:   isValidCompanyName(ownerVal) ? ownerVal : null,
      manager_name: isValidCompanyName(mgrVal)   ? mgrVal   : null,
      flag:         flagVal || null,
      source: "marinetraffic", confidence: 0.78,
    };
  } catch (err) { logger.warn(`[marinetraffic] error: ${err?.message?.slice(0,120) || String(err).slice(0,120)}`); return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEP 3: VESSELFINDER (owner/operator fallback)
// ═════════════════════════════════════════════════════════════════
async function fetchFromVesselFinder(imo) {
  try {
    // Public API endpoint
    const apiRes = await safeFetch(
      `https://www.vesselfinder.com/api/pub/vesselDetails?mmsi=&imo=${imo}`,
      { headers: { "Referer": "https://www.vesselfinder.com/" } }, 8000
    );
    if (apiRes.ok) {
      const json = await apiRes.json().catch(() => null);
      if (json) {
        const name  = json?.AIS?.NAME || json?.vessel?.name || null;
        const owner = json?.vessel?.company || null;
        const flag  = json?.AIS?.FLAG || json?.vessel?.flag || null;
        if (name || owner) {
          logger.info(`[vesselfinder] IMO ${imo}: name="${name}" owner="${owner}"`);
          return { vessel_name: name, owner_name: owner, flag, source: "vesselfinder", confidence: 0.70 };
        }
      }
    }

    // Vessel detail page scrape — use structured data, not naive regex on stripped text
    const pageRes = await safeFetch(
      `https://www.vesselfinder.com/vessels/details/${imo}`,
      { headers: { "Referer": "https://www.vesselfinder.com/" } }, 10000
    );
    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    // Try JSON-LD first
    const ldM = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i.exec(html);
    if (ldM) {
      try {
        const ld = JSON.parse(ldM[1]);
        const ownerRaw = ld?.owner || ld?.manufacturer || null;
        const nameRaw  = ld?.name || null;
        if (isValidCompanyName(ownerRaw) || nameRaw) {
          return { vessel_name: nameRaw || null, owner_name: isValidCompanyName(ownerRaw) ? ownerRaw : null,
                   source: "vesselfinder", confidence: 0.68 };
        }
      } catch { /* fall through */ }
    }

    // Try meta tags (og:description often has vessel + owner info)
    const metaDesc = /<meta[^>]+(?:name="description"|property="og:description")[^>]+content="([^"]{10,200})"/i.exec(html);
    if (metaDesc) {
      const desc = metaDesc[1];
      // VesselFinder descriptions look like: "EONIA - Container Ship - built 2008, flag Singapore, owner XYZ Shipping"
      const ownerInMeta = /(?:owner|operated by)[:\s]+([A-Z][A-Za-z0-9\s&.,'-]{4,60})/i.exec(desc);
      const nameInMeta  = /^([A-Z][A-Z0-9\s-]{2,35})\s*[-–]/i.exec(desc);
      if (ownerInMeta && isValidCompanyName(ownerInMeta[1].trim())) {
        logger.info(`[vesselfinder] meta IMO ${imo}: owner="${ownerInMeta[1].trim()}"`);
        return { vessel_name: nameInMeta?.[1]?.trim() || null, owner_name: ownerInMeta[1].trim(),
                 source: "vesselfinder", confidence: 0.65 };
      }
    }

    // Last resort: look for owner in specific data table cells, not stripped full-page text
    // VesselFinder renders owner in: <td class="v2">COMPANY NAME</td> after an "Owner" label
    const ownerCellM = /Owner[\s\S]{0,200}?<td[^>]*class="v2"[^>]*>([^<]{3,80})<\/td>/i.exec(html);
    if (ownerCellM && isValidCompanyName(ownerCellM[1].trim())) {
      logger.info(`[vesselfinder] cell IMO ${imo}: owner="${ownerCellM[1].trim()}"`);
      return { vessel_name: null, owner_name: ownerCellM[1].trim(), source: "vesselfinder", confidence: 0.62 };
    }

    return null;
  } catch (err) { logger.warn(`[vesselfinder] error: ${err?.message?.slice(0,120) || String(err).slice(0,120)}`); return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEP 4: AI IMO LOOKUP — Claude searches all maritime sources
// ═════════════════════════════════════════════════════════════════
async function aiLookupByIMO(imo, vesselName) {
  if (!process.env.ANTHROPIC_API_KEY) { logger.warn("[ai-imo] ANTHROPIC_API_KEY not set — skipping"); return null; }
  try {
    const resp = await withTimeout(anthropic.messages.create({
      model: MODEL, max_tokens: 1000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content:
        `Search for IMO number ${imo}${vesselName ? ` vessel "${vesselName}"` : ""} across maritime databases.
Check: MarineTraffic, VesselFinder, FleetMon, Equasis, VesselTracker, ShipSpotting, Lloyd's List.
Find: registered owner company name, ISM manager, ship manager, operator, flag state, and contact details.

Return ONLY valid JSON (no markdown, no text before or after):
{"vessel_name":null,"owner_name":null,"manager_name":null,"ship_manager":null,"operator_name":null,"flag":null,"website":null,"email":null,"phone":null,"address":null,"confidence":0.65,"sources_checked":[]}` }],
    }), 45000);
    const text = resp.content.find(b => b.type === "text")?.text;
    const data = safeJson(text);
    if (!data) return null;
    // Validate — reject if company name looks like echoed field labels
    if (data.owner_name && !isValidCompanyName(data.owner_name)) data.owner_name = null;
    if (data.manager_name && !isValidCompanyName(data.manager_name)) data.manager_name = null;
    if (!data.vessel_name && !data.owner_name) return null;
    logger.info(`[ai-imo] IMO ${imo}: vessel="${data.vessel_name}" owner="${data.owner_name}"`);
    return { ...data, source: "ai_imo_search" };
  } catch (err) { logger.warn(`[ai-imo] error: ${err?.status ?? ""} ${err?.message || String(err)}`); return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEP 5: AI COMPANY CONTACT SEARCH (email, phone, website)
// ═════════════════════════════════════════════════════════════════
async function aiSearchCompanyContacts(companyName, country) {
  if (!process.env.ANTHROPIC_API_KEY) { logger.warn("[ai-company] ANTHROPIC_API_KEY not set — skipping"); return null; }
  if (!companyName) return null;
  try {
    const resp = await withTimeout(anthropic.messages.create({
      model: MODEL, max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content:
        `Find official contact information for shipping company: "${companyName}"${country ? ` (${country})` : ""}.
Search: official website, maritime directories (BIMCO, Intercargo, Intertanko), company registries, Google.
Look for: official email, operations email, phone number, website URL, registered office address, LinkedIn page.

Return ONLY valid JSON (no markdown):
{"website":null,"email":null,"email_ops":null,"phone":null,"phone_alt":null,"address":null,"linkedin":null,"confidence":0.7}
Rules: verified only, null for uncertain. confidence: 0.9=official site, 0.75=directory, 0.6=uncertain.` }],
    }), 40000);
    const text = resp.content.find(b => b.type === "text")?.text;
    const data = safeJson(text);
    if (!data) return null;
    // Sanity check: reject obviously bad emails/phones
    if (data.email && !data.email.includes("@")) data.email = null;
    if (data.email && data.email.includes("example")) data.email = null;
    logger.info(`[ai-company] "${companyName}": email=${data.email} web=${data.website}`);
    return { ...data, source: "ai_web_search" };
  } catch (err) { logger.warn(`[ai-company] error: ${err?.status ?? ""} ${err?.message || String(err)}`); return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEP 6: WEBSITE SCRAPE (direct contact page scraping)
// ═════════════════════════════════════════════════════════════════
async function scrapeContactPage(websiteUrl) {
  if (!websiteUrl) return null;
  try {
    const base = new URL(websiteUrl).origin;
    const urls = [`${base}/contact`, `${base}/contact-us`, `${base}/contacts`,
                  `${base}/en/contact`, `${base}/about/contact`, websiteUrl];
    for (const url of urls) {
      try {
        const res = await safeFetch(url, {}, 6000);
        if (!res.ok) continue;
        const text = (await res.text()).replace(/<[^>]+>/g, " ");
        const emails = extractEmails(text);
        const phones = extractPhones(text);
        if (emails.length || phones.length) {
          logger.info(`[scrape] ${url}: email=${emails[0]} phone=${phones[0]}`);
          return { email: emails[0] || null, email_ops: emails[1] || null, phone: phones[0] || null };
        }
      } catch { /* try next url */ }
    }
    return null;
  } catch (err) { logger.warn(`[scrape] error: ${err?.message?.slice(0,120) || String(err).slice(0,120)}`); return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEP 7: GOOGLE CSE (search snippet extraction)
// ═════════════════════════════════════════════════════════════════
async function googleSearchContacts(companyName) {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx     = process.env.GOOGLE_CSE_ID;
  if (!apiKey || !cx) return null;
  try {
    const q = encodeURIComponent(`"${companyName}" shipping contact email phone`);
    const res = await safeFetch(
      `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${q}&num=5`, {}, 8000);
    if (!res.ok) return null;
    const json = await res.json();
    const snippets = (json.items || []).map(i => `${i.title} ${i.snippet}`).join(" ");
    const emails = extractEmails(snippets);
    const phones = extractPhones(snippets);
    if (!emails.length && !phones.length) return null;
    logger.info(`[google-cse] "${companyName}": email=${emails[0]}`);
    return { email: emails[0] || null, phone: phones[0] || null, confidence: 0.65 };
  } catch (err) { logger.warn(`[google-cse] error: ${err?.message?.slice(0,120) || String(err).slice(0,120)}`); return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEP 8: LINKEDIN SEARCH (via Claude AI web search)
// ═════════════════════════════════════════════════════════════════
async function linkedinSearch(companyName, country) {
  if (!companyName || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const resp = await withTimeout(anthropic.messages.create({
      model: MODEL, max_tokens: 400,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content:
        `Find the LinkedIn company page URL for shipping company "${companyName}"${country ? ` (${country})` : ""}.
Also note their official website if found during search.
Return ONLY valid JSON: {"linkedin_url":null,"website":null,"found":false}` }],
    }), 20000);
    const text = resp.content.find(b => b.type === "text")?.text;
    const data = safeJson(text);
    if (!data?.linkedin_url && !data?.website) return null;
    logger.info(`[linkedin] "${companyName}": ${data.linkedin_url}`);
    return data;
  } catch (err) { logger.warn(`[linkedin] error: ${err?.status ?? ""} ${err?.message || String(err)}`); return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEPS 9+10: PORT AGENTS (static DB + AI fallback)
// ═════════════════════════════════════════════════════════════════
async function resolvePortAgents({ portName, portCode, vesselType, ownerName, portContext }) {
  const cacheKey = `pa_${portCode || portName}_${vesselType || "any"}`;
  const cached   = cacheGet(portAgentCache, cacheKey, PORT_AGENT_TTL);
  if (cached) return cached;

  try {
    // STEP 9: Static DB
    let agents = lookupPortAgents({ portCode, portName, vesselType });
    if (agents && agents.length) {
      const ranked = rankAgents(agents, { vesselType, ownerName });
      ranked.forEach(a => { a.port_context = portContext; a.data_source = a.data_source || "port_agent_db"; });
      return cacheSet(portAgentCache, cacheKey, ranked);
    }

    // STEP 10: AI port agent search
    if (!process.env.ANTHROPIC_API_KEY) return cacheSet(portAgentCache, cacheKey, []);
    const resp = await withTimeout(anthropic.messages.create({
      model: MODEL, max_tokens: 1400,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content:
        `Find port agents / ship agents at port "${portName || portCode}"${vesselType ? ` for ${vesselType} vessels` : ""}.
Search shipping directories, port authority websites, FONASBA agent lists, and agent company websites.
Include major international agents (GAC, Inchcape, Wilhelmsen, Gulf Agency, Mariner Logistics) and local agents.

Return ONLY a valid JSON array (no markdown, no text outside the array):
[{"agent_name":null,"agency_company":null,"port_code":"${portCode || ""}","port_name":"${portName || ""}","email_primary":null,"email_ops":null,"phone_main":null,"phone_24h":null,"vhf_channel":null,"vessel_types_served":"ALL","services":[],"website":null,"port_context":"${portContext || "current"}","confidence":0.65,"data_source":"ai_web_search"}]` }],
    }), 45000);
    const text = resp.content.find(b => b.type === "text")?.text;
    let arr = null;
    try { const m = text && text.match(/\[[\s\S]*\]/); arr = m ? JSON.parse(m[0]) : null; } catch { arr = null; }
    const result = Array.isArray(arr) ? arr.filter(a => a.agency_company || a.agent_name) : [];
    result.forEach(a => { a.port_context = portContext; });
    logger.info(`[ai-agents] ${portName}: ${result.length} agents found`);
    return cacheSet(portAgentCache, cacheKey, result);
  } catch (err) {
    logger.warn(`[port-agents] error: ${err?.message?.slice(0,120) || String(err).slice(0,120)}`);
    return cacheSet(portAgentCache, cacheKey, []);
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 11: AGENT ORGANISATION ENRICHMENT
// ═════════════════════════════════════════════════════════════════
async function enrichAgentOrganisation({ ownerName, managerName, vesselName, vesselType, flag, imo }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const company = ownerName || managerName;
  if (!company && !vesselName) return null;
  try {
    const resp = await withTimeout(anthropic.messages.create({
      model: MODEL, max_tokens: 1200,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content:
        `Find the ship husbandry agent or ship management organisation for:
Vessel: ${vesselName || "Unknown"} (IMO ${imo})  Owner/Manager: ${company || "Unknown"}
Vessel Type: ${vesselType || "General"}  Flag: ${flag || "Unknown"}

Search for appointed ship agents, husbandry agents, ship chandlers (GAC, Inchcape, Wilhelmsen, Gulf Agency, etc.)
Return ONLY valid JSON (no markdown):
{"agent_org_name":null,"agent_org_type":null,"appointment_basis":null,"agent_org_email":null,"agent_org_email_ops":null,"agent_org_phone":null,"agent_org_phone_24h":null,"agent_org_website":null,"agent_org_address":null,"services":[],"regions_covered":[],"confidence":0.6,"source":"ai_web_search"}` }],
    }), 40000);
    const text = resp.content.find(b => b.type === "text")?.text;
    return safeJson(text);
  } catch (err) { logger.warn(`[agent-org] error: ${err?.status ?? ""} ${err?.message || String(err)}`); return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEP 12: VESSEL MASTER / CAPTAIN CONTACT CHANNEL
// ═════════════════════════════════════════════════════════════════
async function enrichMasterContact({ ownerName, managerName, shipManager, flag, imo, vesselName }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const resp = await withTimeout(anthropic.messages.create({
      model: MODEL, max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content:
        `For vessel IMO ${imo} (${vesselName || "Unknown"}) flagged in ${flag || "Unknown"}, find captain/crew contact channels.
Owner/ISM Manager: ${ownerName || managerName || shipManager || "Unknown"}
Find: crew management company contact, MRCC for this flag state, satellite phone access info.
Return ONLY valid JSON (no markdown):
{"master_contact_note":null,"preferred_channel":null,"contact_protocol":null,"crew_dept_company":null,"crew_dept_email":null,"crew_dept_phone":null,"mrcc_name":null,"mrcc_country":null,"mrcc_email":null,"mrcc_phone":null,"sat_phone_public":null,"radio_call_sign":null,"inmarsat_number":null,"confidence":0.5,"source":"ai_web_search"}` }],
    }), 35000);
    const text = resp.content.find(b => b.type === "text")?.text;
    return safeJson(text);
  } catch (err) { logger.warn(`[master-contact] error: ${err?.status ?? ""} ${err?.message || String(err)}`); return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEP 13: SAVE TO BIGQUERY (fire-and-forget)
// ═════════════════════════════════════════════════════════════════
async function saveToBigQuery(imo, data) {
  try {
    const ds  = bq.dataset(DATASET);
    const now = new Date().toISOString();
    const tableExists = async name => { try { await ds.table(name).getMetadata(); return true; } catch { return false; } };

    if (await tableExists("d_shipping_companies") && (data.owner_name || data.email)) {
      const companyId = `enriched_${imo}_owner`;
      await ds.table("d_shipping_companies").insert([{
        company_id: companyId, company_name: data.owner_name || null, company_type: "OWNER",
        primary_email: data.email || null, secondary_email: data.email_ops || null,
        phone_primary: data.phone || null, phone_secondary: data.phone_alt || null,
        website: data.website || null, linkedin: data.linkedin || null,
        registered_address: data.address || null, data_source: data.source || "enriched",
        last_verified_at: now, created_at: now, updated_at: now,
      }]).catch(() => {});
      if (await tableExists("d_vessel_company_map")) {
        await ds.table("d_vessel_company_map").insert([{
          imo_number: imo, vessel_name: data.vessel_name || null,
          owner_company_id: companyId, data_source: data.source || "enriched",
          last_verified_at: now, created_at: now, updated_at: now,
        }]).catch(() => {});
      }
    }
    if (await tableExists("d_port_agents") && data.port_agents?.length) {
      const rows = data.port_agents.map(a => ({
        agent_id: `ai_${a.port_code || "xx"}_${Date.now()}`,
        agent_name: a.agent_name || null, agency_company: a.agency_company || null,
        port_code: a.port_code || null, port_name: a.port_name || null,
        email_primary: a.email_primary || null, phone_main: a.phone_main || null,
        vessel_type_served: a.vessel_types_served || "ALL", is_active: true,
        data_source: "ai_web_search", created_at: now, updated_at: now,
      }));
      await ds.table("d_port_agents").insert(rows).catch(() => {});
    }
  } catch (err) { logger.warn("[bq-save] non-fatal:", err.message?.slice(0, 80)); }
}

// ═════════════════════════════════════════════════════════════════
// MAIN: enrichVesselContact
// ═════════════════════════════════════════════════════════════════
async function enrichVesselContact(imo, {
  vesselName, flag, currentPort, nextPort, vesselType,
  forceRefresh = false,
} = {}) {
  if (!imo || imo <= 0) return null; // guard: imo=0/null would collide in cache

  const cacheKey = `enrich_${imo}`;
  if (!forceRefresh) {
    const cached = cacheGet(enrichCache, cacheKey, ENRICH_TTL);
    if (cached) { logger.debug(`[enricher] cache hit IMO ${imo}`); return cached; }
  } else { enrichCache.delete(cacheKey); }

  logger.info(`[enricher] ══ START IMO ${imo} (${vesselName || "?"}) ══`);
  const r = { imo_number: imo, vessel_name: vesselName || null, flag: flag || null };

  // STEP 1: Equasis
  const eq = await fetchFromEquasis(imo).catch(() => null);
  if (eq) {
    Object.assign(r, { owner_name: eq.owner_name, manager_name: eq.manager_name,
      ship_manager: eq.ship_manager, operator_name: eq.operator_name,
      address: eq.address, flag: r.flag || eq.flag, source: "equasis", confidence: eq.confidence });
  }

  // STEP 2: MarineTraffic (if still no owner)
  if (!r.owner_name) {
    const mt = await fetchFromMarineTraffic(imo).catch(() => null);
    if (mt) {
      r.owner_name   = r.owner_name   || (isValidCompanyName(mt.owner_name)   ? mt.owner_name   : null);
      r.manager_name = r.manager_name || (isValidCompanyName(mt.manager_name) ? mt.manager_name : null);
      r.vessel_name  = r.vessel_name  || mt.vessel_name || vesselName;
      r.flag         = r.flag         || mt.flag;
      r.confidence   = Math.max(r.confidence || 0, mt.confidence || 0);
      r.source       = r.source ? `${r.source}+marinetraffic` : "marinetraffic";
    }
  }

  // STEP 3: VesselFinder (if still no owner)
  if (!r.owner_name) {
    const vf = await fetchFromVesselFinder(imo).catch(() => null);
    if (vf) {
      r.owner_name  = r.owner_name  || (isValidCompanyName(vf.owner_name) ? vf.owner_name : null);
      r.vessel_name = r.vessel_name || vf.vessel_name || vesselName;
      r.flag        = r.flag        || vf.flag;
      r.confidence  = Math.max(r.confidence || 0, vf.confidence || 0);
      r.source      = r.source ? `${r.source}+vesselfinder` : "vesselfinder";
    }
  }

  // STEP 4: AI IMO lookup (always fills remaining gaps)
  if (!r.owner_name || !r.vessel_name) {
    const aiImo = await aiLookupByIMO(imo, r.vessel_name || vesselName).catch(() => null);
    if (aiImo) {
      r.owner_name    = r.owner_name    || (isValidCompanyName(aiImo.owner_name)    ? aiImo.owner_name    : null);
      r.manager_name  = r.manager_name  || (isValidCompanyName(aiImo.manager_name)  ? aiImo.manager_name  : null);
      r.ship_manager  = r.ship_manager  || (isValidCompanyName(aiImo.ship_manager)  ? aiImo.ship_manager  : null);
      r.operator_name = r.operator_name || (isValidCompanyName(aiImo.operator_name) ? aiImo.operator_name : null);
      r.vessel_name   = r.vessel_name   || aiImo.vessel_name || vesselName;
      r.flag          = r.flag          || aiImo.flag;
      r.website       = r.website       || aiImo.website;
      r.email         = r.email         || aiImo.email;
      r.phone         = r.phone         || aiImo.phone;
      r.address       = r.address       || aiImo.address;
      r.confidence    = Math.max(r.confidence || 0, aiImo.confidence || 0);
      r.source        = r.source ? `${r.source}+ai_imo` : "ai_imo";
    }
  }

  // STEP 5: AI company contact search
  const company = r.owner_name || r.manager_name || r.vessel_name || vesselName;
  if (company && (!r.email || !r.website)) {
    const aiCo = await aiSearchCompanyContacts(company, r.flag || flag).catch(() => null);
    if (aiCo) {
      r.website   = r.website   || aiCo.website;
      r.email     = r.email     || aiCo.email;
      r.email_ops = r.email_ops || aiCo.email_ops;
      r.phone     = r.phone     || aiCo.phone;
      r.phone_alt = r.phone_alt || aiCo.phone_alt;
      r.address   = r.address   || aiCo.address;
      r.linkedin  = r.linkedin  || aiCo.linkedin;
      r.confidence= Math.max(r.confidence || 0, (aiCo.confidence || 0) * 0.9);
      r.source    = r.source ? `${r.source}+ai_search` : "ai_search";
    }
  }

  // STEP 6: Website scrape
  if (r.website && (!r.email || !r.phone)) {
    const sc = await scrapeContactPage(r.website).catch(() => null);
    if (sc) {
      r.email     = r.email     || sc.email;
      r.email_ops = r.email_ops || sc.email_ops;
      r.phone     = r.phone     || sc.phone;
      r.source    = `${r.source || ""}+scrape`.replace(/^\+/, "");
    }
  }

  // STEP 7: Google CSE
  if (company && !r.email) {
    const gc = await googleSearchContacts(company).catch(() => null);
    if (gc) {
      r.email      = gc.email;
      r.phone      = r.phone || gc.phone;
      r.confidence = r.confidence || gc.confidence;
      r.source     = `${r.source || ""}+google_cse`.replace(/^\+/, "");
    }
  }

  // STEP 8: LinkedIn
  if (company && !r.linkedin) {
    const li = await linkedinSearch(company, r.flag || flag).catch(() => null);
    if (li) {
      r.linkedin = r.linkedin || li.linkedin_url;
      r.website  = r.website  || li.website;
      r.source   = `${r.source || ""}+linkedin`.replace(/^\+/, "");
    }
  }

  // STEPS 9+10: Port Agents
  const portAgents = [];
  for (const [portKey, context] of [[currentPort, "current"], [nextPort, "next"]]) {
    if (!portKey) continue;
    const agents = await resolvePortAgents({
      portName: portKey, portCode: portKey,
      vesselType: vesselType || null, ownerName: r.owner_name || null, portContext: context,
    }).catch(() => []);
    portAgents.push(...agents);
  }

  // STEP 11: Agent Organisation
  const agentOrg = await enrichAgentOrganisation({
    ownerName: r.owner_name || null, managerName: r.manager_name || null,
    vesselName: r.vessel_name || vesselName, vesselType: vesselType || null,
    flag: r.flag || flag || null, imo,
  }).catch(() => null);

  // STEP 12: Master Contact
  const masterContact = await enrichMasterContact({
    ownerName: r.owner_name || null, managerName: r.manager_name || null,
    shipManager: r.ship_manager || null, flag: r.flag || flag || null,
    imo, vesselName: r.vessel_name || vesselName,
  }).catch(() => null);

  // STEP 13: Save
  if (r.owner_name || r.email) saveToBigQuery(imo, { ...r, port_agents: portAgents });

  logger.info(`[enricher] ══ DONE IMO ${imo} — owner="${r.owner_name}" source="${r.source}" ══`);

  const final = {
    imo_number:  imo,
    vessel_name: r.vessel_name || vesselName || null,
    owner: {
      company_name:       r.owner_name    || null,
      company_type:       "OWNER",
      primary_email:      r.email         || null,
      secondary_email:    r.email_ops     || null,
      phone_primary:      r.phone         || null,
      phone_secondary:    r.phone_alt     || null,
      website:            r.website       || null,
      registered_address: r.address       || null,
      linkedin:           r.linkedin      || null,
      data_source:        r.source        || null,
    },
    operator:     r.operator_name ? { company_name: r.operator_name, company_type: "OPERATOR", data_source: r.source } : null,
    manager:      r.manager_name  ? { company_name: r.manager_name,  company_type: "MANAGER",  data_source: r.source } : null,
    ship_manager: r.ship_manager  ? { company_name: r.ship_manager,  company_type: "SHIP_MANAGER", data_source: r.source } : null,
    port_agents:  portAgents,
    agent_org: agentOrg ? {
      company_name: agentOrg.agent_org_name || null, company_type: agentOrg.agent_org_type || "HUSBANDRY_AGENT",
      appointment_basis: agentOrg.appointment_basis || null,
      primary_email: agentOrg.agent_org_email || null, ops_email: agentOrg.agent_org_email_ops || null,
      phone: agentOrg.agent_org_phone || null, phone_24h: agentOrg.agent_org_phone_24h || null,
      website: agentOrg.agent_org_website || null, registered_address: agentOrg.agent_org_address || null,
      services: agentOrg.services || [], regions_covered: agentOrg.regions_covered || [],
      confidence: agentOrg.confidence || null, data_source: agentOrg.source || "ai_web_search",
    } : null,
    master_contact: masterContact ? {
      contact_note: masterContact.master_contact_note || null,
      preferred_channel: masterContact.preferred_channel || null,
      contact_protocol: masterContact.contact_protocol || null,
      crew_dept: masterContact.crew_dept_company ? {
        company: masterContact.crew_dept_company || null,
        email:   masterContact.crew_dept_email   || null,
        phone:   masterContact.crew_dept_phone   || null,
      } : null,
      mrcc: masterContact.mrcc_name ? {
        name: masterContact.mrcc_name || null, country: masterContact.mrcc_country || null,
        email: masterContact.mrcc_email || null, phone: masterContact.mrcc_phone || null,
      } : null,
      sat_phone_public: masterContact.sat_phone_public || null,
      radio_call_sign:  masterContact.radio_call_sign  || null,
      inmarsat_number:  masterContact.inmarsat_number  || null,
      privacy_note: "Direct personal contact of vessel master not provided. Use the channels above.",
      confidence: masterContact.confidence || null, data_source: masterContact.source || "ai_web_search",
    } : null,
    enrichment: {
      source:      r.source     || "none",
      confidence:  r.confidence || (r.owner_name ? 0.4 : 0),
      enriched_at: new Date().toISOString(),
    },
  };

  return cacheSet(enrichCache, cacheKey, final);
}

// ═════════════════════════════════════════════════════════════════
// STANDALONE: enrichPortAgents  /  BATCH
// ═════════════════════════════════════════════════════════════════
async function enrichPortAgents({ portName, portCode, vesselType }) {
  return resolvePortAgents({ portName, portCode, vesselType, portContext: "current" });
}

async function batchEnrichArrivals(limit = 20) {
  logger.info(`[batch] Starting (limit=${limit})`);
  try {
    const [rows] = await bq.query({
      query: `
        SELECT DISTINCT a.imo_number, a.vessel_name, v.flag,
          a.location_to AS current_port, a.next_port_destination AS next_port, v.vessel_type
        FROM \`${PROJECT}.${DATASET}.f_vessel_arrivals\` a
        LEFT JOIN \`${PROJECT}.${DATASET}.d_vessel_company_map\` m ON m.imo_number = a.imo_number
        LEFT JOIN \`${PROJECT}.${DATASET}.d_vessel_master\` v ON v.imo_number = a.imo_number
        WHERE m.imo_number IS NULL AND a.imo_number IS NOT NULL
          AND a.arrival_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
        ORDER BY a.arrival_time DESC LIMIT @limit`,
      params: { limit }, location: BQ_LOCATION,
    });
    logger.info(`[batch] ${rows.length} vessels to enrich`);
    const results = [];
    for (const row of rows) {
      const imo = Number(row.imo_number);
      if (!imo) continue;
      await new Promise(r => setTimeout(r, 3000));
      const data = await enrichVesselContact(imo, {
        vesselName: row.vessel_name, flag: row.flag,
        currentPort: row.current_port, nextPort: row.next_port, vesselType: row.vessel_type,
      });
      results.push({ imo, found: !!(data?.owner?.primary_email || data?.owner?.company_name) });
    }
    logger.info(`[batch] Done: ${results.filter(r => r.found).length}/${results.length}`);
    return results;
  } catch (err) { logger.error("[batch] error:", err.message); return []; }
}


// ── Proactive Equasis session keep-alive ──────────────────────────
// Ping authenticated page every 15 min to prevent server-side session timeout
// (Equasis times out sessions after ~30 min of inactivity)
const EQ_KEEPALIVE_INTERVAL = 15 * 60 * 1000;
let _eqKeepaliveTimer = null;

async function equasisKeepalive() {
  if (!_eqCookieMap) return; // not logged in yet — nothing to keep alive
  const cookies = mapToCookieHeader(_eqCookieMap);
  try {
    const res = await safeFetch(`${EQ_BASE}/authen/HomePage?fs=HomePage`, {
      method: "GET",
      headers: {
        "Cookie":     cookies,
        "Accept":     "text/html,application/xhtml+xml,*/*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      redirect: "follow",
    }, 10000);
    const html  = await res.text();
    const alive = !isSessionExpiredHtml(html);
    if (alive) {
      _eqCookieTs = Date.now(); // extend TTL
      logger.info("[equasis] keep-alive ping — session still valid ✓");
    } else {
      logger.warn("[equasis] keep-alive detected session expired — will re-login on next request");
      invalidateSession("keep-alive ping found login page");
    }
  } catch (err) {
    logger.warn(`[equasis] keep-alive error: ${err?.message?.slice(0, 60)}`);
  }
}

function startEquasisKeepalive() {
  if (_eqKeepaliveTimer) return;
  _eqKeepaliveTimer = setInterval(equasisKeepalive, EQ_KEEPALIVE_INTERVAL);
  logger.info(`[equasis] keep-alive started (every ${EQ_KEEPALIVE_INTERVAL/60000} min)`);
}

// Start keep-alive when module loads (first login will be triggered on first actual use)
// We delay 2s to allow server startup to complete
setTimeout(startEquasisKeepalive, 2000);

module.exports = { enrichVesselContact, batchEnrichArrivals, enrichPortAgents };