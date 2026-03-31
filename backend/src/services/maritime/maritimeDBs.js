// src/services/maritime/maritimeDBs.js
// Multi-source maritime database scrapers — parallel fallback sources
// MarineTraffic (0.80), VesselFinder (0.75), FleetMon (0.62)
"use strict";

const logger = require("../../utils/logger");
const { HTTP_TIMEOUT_MS, USER_AGENT } = require("../../config");

function stripTags(html) {
  return (html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function isValidCompany(name) {
  if (!name || typeof name !== "string" || name.length < 3 || name.length > 120) return false;
  const junkWords = ["Website","Email","Address","Manager","Phone","ISM","Operator","Owner"];
  if (junkWords.filter(k => name.includes(k)).length >= 3) return false;
  if (/^[a-z_]+$/.test(name)) return false;
  return true;
}

async function safeFetch(url, extraHeaders = {}, ms = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, "Accept": "text/html,*/*", ...extraHeaders },
      redirect: "follow",
    });
    clearTimeout(t);
    return res.ok ? res : null;
  } catch { clearTimeout(t); return null; }
}

// ── MarineTraffic ─────────────────────────────────────────────────────────────

async function fetchMarineTraffic(imo) {
  const res = await safeFetch(
    `https://www.marinetraffic.com/en/ais/details/ships/imo:${imo}`,
    { Referer: "https://www.marinetraffic.com/" },
  );
  if (!res) return null;
  const html = await res.text().catch(() => "");

  // Try JSON-LD structured data first
  const ldM = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (ldM) {
    try {
      const ld = JSON.parse(ldM[1]);
      const name  = ld?.name;
      const owner = ld?.owner || ld?.managedBy;
      if (name || owner) return { vessel_name: name, owner_name: owner, flag: ld?.flag, source: "marinetraffic", confidence: 0.80 };
    } catch { /* fall through */ }
  }

  // Table scrape
  const text  = stripTags(html);
  const ownerM= /Registered Owner\s*[:\s]+([A-Z][A-Za-z0-9\s&.',\-]{3,70}?)(?:\s{2,}|\||<)/i.exec(text);
  const mgrM  = /ISM Manager\s*[:\s]+([A-Z][A-Za-z0-9\s&.',\-]{3,70}?)(?:\s{2,}|\||<)/i.exec(text);
  const flagM = /Flag\s*[:\s]+([A-Z][A-Za-z\s]{2,40}?)(?:\s{2,}|\||<)/i.exec(text);
  const owner = ownerM?.[1]?.trim();
  const mgr   = mgrM?.[1]?.trim();
  if (!isValidCompany(owner) && !isValidCompany(mgr)) return null;
  logger.info(`[marinetraffic] IMO ${imo}: owner="${owner}"`);
  return { owner_name: isValidCompany(owner)?owner:null, manager_name: isValidCompany(mgr)?mgr:null, flag: flagM?.[1]?.trim()||null, source: "marinetraffic", confidence: 0.75 };
}

// ── VesselFinder ──────────────────────────────────────────────────────────────

async function fetchVesselFinder(imo) {
  // Try public API endpoint first
  const apiRes = await safeFetch(
    `https://www.vesselfinder.com/api/pub/vesselDetails?imo=${imo}`,
    { Referer: "https://www.vesselfinder.com/" },
    8000,
  );
  if (apiRes) {
    const json = await apiRes.json().catch(() => null);
    if (json) {
      const name  = json?.AIS?.NAME || json?.vessel?.name;
      const owner = json?.vessel?.company;
      const flag  = json?.AIS?.FLAG  || json?.vessel?.flag;
      if (name || owner) return { vessel_name: name, owner_name: owner, flag, source: "vesselfinder", confidence: 0.70 };
    }
  }

  // Page scrape fallback
  const res = await safeFetch(
    `https://www.vesselfinder.com/vessels/details/${imo}`,
    { Referer: "https://www.vesselfinder.com/" },
  );
  if (!res) return null;
  const html = await res.text().catch(() => "");

  // JSON-LD
  const ldM = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (ldM) {
    try {
      const ld    = JSON.parse(ldM[1]);
      const owner = ld?.owner || ld?.manufacturer;
      if (isValidCompany(String(owner))) return { vessel_name: ld?.name, owner_name: String(owner), source: "vesselfinder", confidence: 0.68 };
    } catch { /* fall through */ }
  }

  // Meta description
  const metaM = /<meta[^>]+(?:name="description"|property="og:description")[^>]+content="([^"]{10,200})"/i.exec(html);
  if (metaM) {
    const om = /(?:owner|operated by)[:\s]+([A-Z][A-Za-z0-9\s&.,'-]{4,60})/i.exec(metaM[1]);
    const nm = /^([A-Z][A-Z0-9\s-]{2,35})\s*[-–]/i.exec(metaM[1]);
    if (om && isValidCompany(om[1].trim())) {
      return { vessel_name: nm?.[1]?.trim()||null, owner_name: om[1].trim(), source: "vesselfinder", confidence: 0.65 };
    }
  }

  // v2 cell
  const cellM = /Owner[\s\S]{0,200}?<td[^>]*class="v2"[^>]*>([^<]{3,80})<\/td>/i.exec(html);
  if (cellM && isValidCompany(cellM[1].trim())) {
    return { owner_name: cellM[1].trim(), source: "vesselfinder", confidence: 0.60 };
  }
  return null;
}

// ── FleetMon ──────────────────────────────────────────────────────────────────

async function fetchFleetMon(imo) {
  const res = await safeFetch(
    `https://www.fleetmon.com/vessels/vessel/${imo}/`,
    { Referer: "https://www.fleetmon.com/" },
  );
  if (!res) return null;
  const text = stripTags(await res.text().catch(() => ""));
  const m = /(?:Owner|Ship Owner)\s*[:\s]+([A-Z][A-Za-z0-9\s&.',\-]{3,70})(?:\s{2,}|\||<)/i.exec(text);
  if (m && isValidCompany(m[1].trim())) return { owner_name: m[1].trim(), source: "fleetmon", confidence: 0.62 };
  return null;
}

// ── Parallel fetch + merge ────────────────────────────────────────────────────

async function fetchAllMaritimeDBs(imo) {
  const [mt, vf, fm] = await Promise.allSettled([
    fetchMarineTraffic(imo),
    fetchVesselFinder(imo),
    fetchFleetMon(imo),
  ]).then(r => r.map(x => x.status === "fulfilled" ? x.value : null));

  const merged = {};
  for (const r of [mt, vf, fm].filter(Boolean)) {
    for (const k of ["vessel_name","owner_name","manager_name","flag"]) {
      if (!merged[k] && r[k]) merged[k] = r[k];
    }
    if ((r.confidence || 0) > (merged.confidence || 0)) merged.confidence = r.confidence;
    const src = r.source || "";
    if (src && !((merged.source || "").includes(src))) {
      merged.source = [merged.source, src].filter(Boolean).join("+");
    }
  }
  return merged;
}

module.exports = { fetchEquasisOrFallback: fetchAllMaritimeDBs, fetchMarineTraffic, fetchVesselFinder, fetchFleetMon, fetchAllMaritimeDBs };