// src/services/maritime/equasisScraper.js
// Equasis Login + IMO Ship Data Scraper
// Fetches: Registered Owner, ISM Manager, Ship Manager, Operator, flag, address
"use strict";

const logger = require("../../utils/logger");
const { EQUASIS_BASE, EQUASIS_SESSION_TTL, EQUASIS_KEEPALIVE_MS, HTTP_TIMEOUT_MS, USER_AGENT } = require("../../config");

// ── Session state (module-level, shared across all requests) ──────────────────
let _cookieMap  = new Map();   // cookie name → value
let _loginTime  = 0;
let _loginLock  = false;

function _mapToStr(map) { return [...map.entries()].map(([k,v]) => `${k}=${v}`).join("; "); }

function _parseCookies(res) {
  const map = new Map();
  const raw = typeof res.headers?.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [(res.headers?.get("set-cookie") || "")];
  for (const cookie of raw) {
    const pair = cookie.split(";")[0];
    const eq   = pair.indexOf("=");
    if (eq < 1) continue;
    map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return map;
}

function _mergeMaps(...maps) {
  const m = new Map();
  for (const mp of maps) for (const [k,v] of mp) m.set(k,v);
  return m;
}

function _isLoginPage(html) {
  const l = (html || "").toLowerCase();
  return l.includes("j_password") || l.includes("j_email") ||
         l.includes("please login") || l.includes("please log in") ||
         (l.includes("login") && l.includes("password") && !l.includes("logout"));
}

async function _safeFetch(url, opts = {}, ms = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, "Accept": "text/html,*/*", ...(opts.headers || {}) },
    });
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function _login(force = false) {
  const now = Date.now();
  if (!force && _cookieMap.size && (now - _loginTime) < EQUASIS_SESSION_TTL) {
    return _mapToStr(_cookieMap);
  }
  if (_loginLock) {
    await new Promise(r => setTimeout(r, 3000));
    if (_cookieMap.size) return _mapToStr(_cookieMap);
  }
  _loginLock = true;

  const email = process.env.EQUASIS_EMAIL;
  const pass  = process.env.EQUASIS_PASSWORD;
  if (!email || !pass) {
    _loginLock = false;
    logger.warn("[equasis] EQUASIS_EMAIL/PASSWORD not set");
    return null;
  }

  try {
    // Step 1: GET homepage → initial cookies
    const r1 = await _safeFetch(`${EQUASIS_BASE}/public/HomePage`, {}, 12000);
    if (!r1?.ok) { _loginLock = false; return null; }
    const c1 = _parseCookies(r1);

    // Step 2: POST credentials (manual redirect to capture Set-Cookie on 302)
    const r2 = await _safeFetch(
      `${EQUASIS_BASE}/authen/HomePage?fs=HomePage`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie":  _mapToStr(c1),
          "Referer": `${EQUASIS_BASE}/public/HomePage`,
          "Origin":  "https://www.equasis.org",
        },
        body: new URLSearchParams({ j_email: email, j_password: pass, submit: "Login" }),
      },
      15000,
    );
    const c2 = _mergeMaps(c1, _parseCookies(r2 || { headers: new Headers() }));

    // Step 3: follow redirect
    let body = "";
    if (r2?.status === 301 || r2?.status === 302) {
      const loc = r2.headers?.get("location") || "";
      const redirUrl = loc.startsWith("http") ? loc : `https://www.equasis.org${loc}`;
      const r3 = await _safeFetch(redirUrl, {
        headers: { "Cookie": _mapToStr(c2), "Referer": `${EQUASIS_BASE}/authen/HomePage?fs=HomePage` },
        redirect: "follow",
      }, 12000);
      if (r3?.ok) { const c3 = _parseCookies(r3); c3.forEach((v,k) => c2.set(k,v)); body = await r3.text().catch(() => ""); }
    } else if (r2?.ok) { body = await r2.text().catch(() => ""); }

    const lower  = body.toLowerCase();
    const failed = lower.includes("invalid") || lower.includes("incorrect") || lower.includes("j_password");
    const ok     = !failed && (lower.includes("logout") || lower.includes("welcome") || lower.includes("my equasis"));

    if (!ok) { _loginLock = false; logger.warn("[equasis] Login FAILED — check credentials"); return null; }

    _cookieMap  = c2;
    _loginTime  = Date.now();
    _loginLock  = false;
    logger.info(`[equasis] ✅ Login OK — JSESSIONID=${c2.get("JSESSIONID")?.slice(0, 12)}…`);
    return _mapToStr(_cookieMap);
  } catch (e) {
    _loginLock = false;
    logger.warn(`[equasis] Login error: ${e.message}`);
    return null;
  }
}

// ── HTML parser ───────────────────────────────────────────────────────────────

function _parseEquasisHtml(html) {
  const strip = s => (s || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g,"&").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim();

  function extract(labelPattern) {
    const patterns = [
      new RegExp(`<td[^>]*>[^<]*${labelPattern}[^<]*</td>\\s*<td[^>]*>([\\s\\S]{2,200}?)</td>`, "i"),
      new RegExp(`${labelPattern}[\\s\\S]{0,500}?<a[^>]+href="[^"]*[Cc]ompan[^"]*"[^>]*>([^<]{3,100})</a>`, "i"),
      new RegExp(`<div[^>]*>[^<]*${labelPattern}[^<]*</div>\\s*<div[^>]*>([\\s\\S]{2,200}?)</div>`, "i"),
      new RegExp(`${labelPattern}[\\s\\S]{0,600}?<td[^>]*class="[^"]*info[^"]*"[^>]*>([\\s\\S]{2,200}?)</td>`, "i"),
    ];
    for (const re of patterns) {
      const m = re.exec(html);
      if (!m) continue;
      const val = strip(m[1]);
      if (val && val.length > 2 && !/^(n\/a|none|unknown|-|search|login)$/i.test(val)) return val;
    }
    return null;
  }

  return {
    owner       : extract("Registered owner"),
    manager     : extract("ISM Manager") || extract("ISM manager"),
    ship_manager: extract("Ship manager"),
    operator    : extract("(?<!ISM )[Oo]perator"),
    flag        : extract("Flag"),
    address     : extract("Address"),
  };
}

// ── Main fetch function ───────────────────────────────────────────────────────

async function fetchEquasis(imo, retry = 0) {
  const cookies = await _login();
  if (!cookies) return null;

  const hdrs = {
    "Cookie": cookies, "Accept": "text/html,*/*",
    "User-Agent": USER_AGENT, "Origin": "https://www.equasis.org",
  };
  let html = "";
  let sessionExpired = false;

  const hasData = h => h && (h.includes("Registered owner") || h.includes("ISM Manager"));

  async function checkedFetch(url, opts) {
    const res = await _safeFetch(url, opts, 15000);
    if (!res?.ok) return { html: null };
    const body = await res.text().catch(() => "");
    return { html: body, expired: _isLoginPage(body), url: res.url };
  }

  try {
    // Strategy A: POST to Search
    const A1 = await checkedFetch(`${EQUASIS_BASE}/restricted/Search?fs=HomePage`, {
      method: "POST",
      headers: { ...hdrs, "Content-Type": "application/x-www-form-urlencoded", "Referer": `${EQUASIS_BASE}/authen/HomePage?fs=HomePage` },
      body: new URLSearchParams({ P_ENTREE_HOME: String(imo), checkbox_ship: "on", P_PAGE_SHIP: "1" }),
      redirect: "follow",
    });
    if (A1.expired) sessionExpired = true;
    else if (hasData(A1.html)) html = A1.html;
    else if (A1.html) {
      const linkM = /href="([^"]*ShipInfo[^"]*)"/.exec(A1.html);
      if (linkM) {
        const u = linkM[1].startsWith("http") ? linkM[1] : `https://www.equasis.org${linkM[1]}`;
        const A2 = await checkedFetch(u, { headers: hdrs, redirect: "follow" });
        if (!A2.expired && hasData(A2.html)) html = A2.html;
        else if (A2.expired) sessionExpired = true;
      }
    }

    // Strategy B: direct ShipInfo POST
    if (!hasData(html) && !sessionExpired) {
      const B = await checkedFetch(`${EQUASIS_BASE}/restricted/ShipInfo?fs=Search`, {
        method: "POST",
        headers: { ...hdrs, "Content-Type": "application/x-www-form-urlencoded", "Referer": `${EQUASIS_BASE}/restricted/Search?fs=HomePage` },
        body: new URLSearchParams({ P_IMO: String(imo), P_ENTREE_HOME_HIDDEN: String(imo), ongletActifSC: "ship", checkbox_ship: "on" }),
        redirect: "follow",
      });
      if (B.expired) sessionExpired = true;
      else if (hasData(B.html)) html = B.html;
    }

    // Strategy C: ByShip variant
    if (!hasData(html) && !sessionExpired) {
      const C = await checkedFetch(`${EQUASIS_BASE}/restricted/Search?fs=ByShip`, {
        method: "POST",
        headers: { ...hdrs, "Content-Type": "application/x-www-form-urlencoded", "Referer": `${EQUASIS_BASE}/authen/HomePage?fs=HomePage` },
        body: new URLSearchParams({ P_IMO: String(imo), P_ENTREE_HOME_HIDDEN: String(imo), ongletActifSC: "ship", checkbox_ship: "on" }),
        redirect: "follow",
      });
      if (C.expired) sessionExpired = true;
      else if (hasData(C.html)) html = C.html;
    }
  } catch (e) {
    logger.warn(`[equasis] fetch error IMO ${imo}: ${e.message}`);
    return null;
  }

  // Session expired mid-fetch — re-login and retry once
  if (sessionExpired) {
    logger.warn(`[equasis] session expired for IMO ${imo} — re-logging in`);
    _cookieMap = new Map(); _loginTime = 0;
    if (retry < 1) { await new Promise(r => setTimeout(r, 1500)); return fetchEquasis(imo, retry + 1); }
    return null;
  }

  if (!hasData(html)) { logger.warn(`[equasis] no data for IMO ${imo}`); return null; }

  const p = _parseEquasisHtml(html);
  if (!p.owner && !p.manager) { logger.warn(`[equasis] HTML found but parse failed for IMO ${imo}`); return null; }

  logger.info(`[equasis] ✅ IMO ${imo}: owner="${p.owner}" manager="${p.manager}"`);
  return { ...p, source: "equasis", confidence: 0.92 };
}

// ── Keep-alive ping ───────────────────────────────────────────────────────────

async function _keepAlive() {
  if (!_cookieMap.size) return;
  try {
    const r = await _safeFetch(`${EQUASIS_BASE}/authen/HomePage?fs=HomePage`, {
      headers: { "Cookie": _mapToStr(_cookieMap), "User-Agent": USER_AGENT },
      redirect: "follow",
    }, 10000);
    const body = await r?.text().catch(() => "") || "";
    if (!_isLoginPage(body)) { _loginTime = Date.now(); logger.info("[equasis] keep-alive ✓"); }
    else { _cookieMap = new Map(); _loginTime = 0; logger.warn("[equasis] keep-alive: session expired"); }
  } catch (e) { logger.warn(`[equasis] keep-alive error: ${e.message}`); }
}

// Start keep-alive after 2s delay (let server start first)
setTimeout(() => setInterval(_keepAlive, EQUASIS_KEEPALIVE_MS), 2000);

module.exports = { fetchEquasis };