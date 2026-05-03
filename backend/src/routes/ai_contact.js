// backend/src/routes/ai_contact.js — v3 (fixed contact pipeline)
//
// ROOT CAUSE FIXES:
//  1. enrichVesselContact returned nested {owner:{company_name}} but route read
//     eqResult.owner_name → always undefined → no contacts shown.
//     Fixed: flatten the nested result correctly.
//  2. Route was calling enrichVesselContact (all 13 steps) then ALSO calling
//     findCompanyContactsWeb again → duplicate / wasted work.
//     Fixed: one clean linear pipeline with deduplication.
//  3. Google search scraped google.com directly → CAPTCHA/429 → always null.
//     Fixed: DuckDuckGo HTML endpoint (not blocked) + Bing fallback.
//  4. guessCompanyDomain stripped "shipping","maritime" → garbage domains.
//     Fixed: smarter builder preserving meaningful words.
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");
const { lookupPortAgents, rankAgents } = require("../services/portAgentDB");
const { callGeminiWithRetry, parseJSON } = require("../utils/gemini");

// BigQuery client for Vessel_contact_details table
const { bigquery, BQ_LOCATION } = require("../services/bigquery");
const BQ_CONTACT_TABLE = "`photons-377606.MPA_Vercel.Vessel_contact_details`";

const T_STEP  = 15_000;   // per-step timeout
// T_TOTAL raised to 120s: with serial queue a request may wait up to
// 5s × (queued calls ahead) before getting a Gemini slot. At free tier
// with 3 concurrent features this can take 15–30s just waiting, then
// 5–10s for the actual call. 120s gives plenty of headroom.
const T_TOTAL = 120_000;

// ── Gemini prompt templates (used by stepGeminiEnrich below) ─────────────────
function promptCompanyEmail(companyName, imo) {
  return `You are a maritime shipping researcher.
Find the official contact email address for this shipping company.

Company name: ${companyName}
IMO number: ${imo || "unknown"}

Return ONLY a JSON object — no explanation, no markdown:
{
  "email": "info@company.com",
  "phone": "+1234567890",
  "website": "www.company.com",
  "confidence": "high"
}

Rules:
- Use only well-known, publicly verified information
- If not found, return null for that field
- confidence: "high" = official email confirmed, "medium" = likely correct, "low" = guessed`;
}

function promptVesselResearch(vesselName, imo) {
  return `You are a maritime vessel research assistant.
Research this vessel and return current ownership details.

Vessel name: ${vesselName || "unknown"}
IMO: ${imo || "unknown"}

Return ONLY a JSON object — no explanation, no markdown:
{
  "owner": "Company Name",
  "manager": "Manager Name",
  "flag": "Panama",
  "email": "contact@company.com",
  "phone": "+1234567890",
  "website": "www.company.com"
}

Rules:
- Return null for any field you are not confident about
- Only use publicly known maritime registry information`;
}

function promptDraftEmail(vesselName, imo, ownerName, portName) {
  return `Write a professional port services email to the vessel operator.

Vessel: ${vesselName || "unknown"}
IMO: ${imo || "unknown"}
Owner/Operator: ${ownerName || "unknown"}
Port: ${portName || "Singapore"}

Write a short, professional 3-paragraph email offering port services.
Format: Subject line first (prefix with "Subject: "), then blank line, then body.
Keep it under 150 words. Be specific, professional, and concise.`;
}

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?[\d][\d\s\-()\.\/]{5,18}\d)/g;

// FIX: Comprehensive blocklist — prevents search engine / tracker / CDN emails
// from leaking into contact results (e.g. error-lite@duckduckgo.com).
const EMAIL_BLOCKLIST = [
  "example", "yourdomain", "@2x", ".png", ".jpg", ".gif", ".svg",
  "sentry", "wix", "cdn", "noreply", "no-reply", "unsubscribe",
  "duckduckgo", "google", "bing", "yahoo", "baidu", "yandex",
  "w3.org", "schema.org", "cloudflare", "amazonaws", "facebook",
  "twitter", "linkedin", "instagram", "tiktok", "analytics",
  "pixel", "track", "beacon", "localhost", "test@", "user@",
  "admin@admin", "info@info", "webmaster@", "postmaster@",
  "marinetraffic", "wikipedia", "vessel", "equasis",
];

function extractEmails(text) {
  return [...new Set((text || "").match(EMAIL_RE) || [])].filter(e => {
    const lower = e.toLowerCase();
    return e.length < 80 && !EMAIL_BLOCKLIST.some(bad => lower.includes(bad));
  });
}
function extractPhones(text) {
  return [...new Set((text || "").match(PHONE_RE) || [])]
    .map(p => p.trim())
    .filter(p => p.replace(/\D/g, "").length >= 7 && p.replace(/\D/g, "").length <= 15);
}
function first(...vals) { return vals.find(v => v != null && v !== "") ?? null; }

function addSrc(cur, next) {
  if (!next) return cur;
  const parts = (cur ? cur.split("+").filter(Boolean) : []);
  next.split("+").forEach(p => { if (p && !parts.includes(p)) parts.push(p); });
  return parts.join("+");
}

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timeout`)), ms); }),
  ]).finally(() => clearTimeout(t));
}
async function safe(label, fn, ms) {
  try { return await withTimeout(fn(), ms || T_STEP, label); }
  catch (e) { logger.warn(`[ai-contact/${label}] ${e.message && e.message.slice(0, 100)}`); return null; }
}

const KNOWN_DOMAINS = {
  "WILHELMSEN": "wilhelmsen.com", "GAC": "gac.com",
  "INCHCAPE": "iss-shipping.com", "ISS SHIPPING": "iss-shipping.com",
  "PACIFIC BASIN": "pacificbasin.com", "MARAN": "maran.gr",
  "TSAKOS": "tng.gr", "THENAMARIS": "thenamaris.com",
  "DIANA SHIPPING": "dianashipping.gr", "NAVIOS": "navios-maritime.com",
  "COSTAMARE": "costamare.com", "SEASPAN": "seaspancorp.com",
  "EVERGREEN": "evergreen-marine.com", "COSCO": "cosco.com",
  "YANG MING": "yangming.com", "HMM": "hmm21.com",
  "HAPAG-LLOYD": "hapag-lloyd.com", "CMA CGM": "cmacgm.com",
  "MSC": "msc.com", "MAERSK": "maersk.com",
  "PIL": "pilship.com", "PACIFIC INTERNATIONAL": "pilship.com",
  "BW GROUP": "bwgroup.com", "TEEKAY": "teekay.com",
  "FRONTLINE": "frontline.bm", "DHT": "dhtankers.com",
  "EURONAV": "euronav.com", "NORDIC AMERICAN": "nat.bm",
  "STENA": "stena.com", "TORM": "torm.com",
  "NORDEN": "ds-norden.com", "GOLDEN OCEAN": "goldenocean.no",
  "ARDMORE": "ardmoreshipping.com", "SCORPIO": "scorpiotankers.com",
  "GOLAR": "golar.com", "DANAOS": "danaos.com",
  "ZODIAC": "zodiacmaritime.com", "V.GROUP": "vgroup.com",
  "V GROUP": "vgroup.com", "COLUMBIA": "columbia-shipmanagement.com",
  "FLEET MANAGEMENT": "fleetship.com",
  "BERNHARD SCHULTE": "bs-shipmanagement.com",
  "EXECUTIVE SHIP": "executiveship.com",
  "OCEAN TANKERS": "oceantankers.com.sg",
  "HAFNIA": "hafniabw.com", "NAVARONE": "navarone.com.sg",
};

function lookupKnownDomain(companyName) {
  const upper = (companyName || "").toUpperCase();
  for (const [key, domain] of Object.entries(KNOWN_DOMAINS)) {
    if (upper.includes(key)) return domain;
  }
  return null;
}

function buildDomainGuess(companyName) {
  if (!companyName) return null;
  const cleaned = companyName
    .toLowerCase()
    .replace(/\b(pte|pvt|ltd|llc|plc|inc|corp|s\.a\.|b\.v\.|a\.s\.|gmbh|ag|ab|oy|nv|kk)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
  if (cleaned.length < 3) return null;
  return cleaned + ".com";
}

async function safeFetch(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
        ...(opts && opts.headers ? opts.headers : {}),
      },
      ...(opts || {}),
    });
  } finally { clearTimeout(t); }
}

// ── STEP 0: BigQuery Vessel_contact_details (fastest, most accurate) ─────────
// Queries the SCD Type 3 contact table — returns current_* fields only.
// This is checked FIRST before any web scraping to avoid unnecessary API calls.
async function stepBigQueryContacts(imo) {
  if (!imo) return null;
  try {
    const query = `
      SELECT
        current_vessel_name        AS vessel_name,
        current_flag               AS flag,
        current_registered_owner   AS owner_name,
        current_operator_comm_mgr  AS manager_name,
        current_ship_manager_ism   AS ship_manager,
        current_owner_email        AS email,
        current_owner_phone        AS phone,
        current_owner_website      AS website,
        current_manager_email      AS manager_email,
        current_manager_phone      AS manager_phone,
        current_manager_website    AS manager_website
      FROM ${BQ_CONTACT_TABLE}
      WHERE imo_no = @imo
      LIMIT 1`;

    const [rows] = await bigquery.query({
      query,
      location: BQ_LOCATION,
      params: { imo: String(imo) },
    });

    if (!rows || rows.length === 0) return null;
    const row = rows[0];

    // Only return if we actually have meaningful data
    if (!row.owner_name && !row.vessel_name) return null;

    logger.info(`[step/bq-contacts] IMO ${imo}: owner="${row.owner_name || "—"}" email="${row.email || "—"}"`);

    return {
      vessel_name:  row.vessel_name  || null,
      flag:         row.flag         || null,
      owner_name:   row.owner_name   || null,
      manager_name: row.manager_name || null,
      ship_manager: row.ship_manager || null,
      email:        row.email        || null,
      phone:        row.phone        || null,
      website:      row.website      || null,
      manager_email:   row.manager_email   || null,
      manager_phone:   row.manager_phone   || null,
      manager_website: row.manager_website || null,
      confidence: (row.email && row.owner_name) ? 0.95 : (row.owner_name ? 0.75 : 0.50),
      source: "bigquery_contacts",
    };
  } catch (err) {
    // Don't crash the whole pipeline if BQ is unavailable
    logger.warn(`[step/bq-contacts] ${err.message && err.message.slice(0, 100)}`);
    return null;
  }
}

// ── STEP 9b: Gemini AI enrichment (called when web steps find name but no email) ──
async function stepGeminiEnrich(companyName, imo) {
  if (!companyName) return null;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) return null;
  try {
    const prompt = promptCompanyEmail(companyName, imo);
    const raw    = await callGeminiWithRetry(null, prompt, 400, { maxRetries: 2, baseDelayMs: 2000 });
    const data   = parseJSON(raw);
    if (!data || !data.email) return null;
    logger.info(`[step/gemini] "${companyName}": email=${data.email}`);
    return {
      email:   data.email   || null,
      phone:   data.phone   || null,
      website: data.website || null,
      confidence: 0.65,
      source: "gemini_ai",
    };
  } catch (err) {
    logger.warn(`[step/gemini] ${err.message && err.message.slice(0, 80)}`);
    return null;
  }
}

// STEP 1: Equasis enricher (flattened correctly)
async function stepEquasis(imo, name, curPort, nextPort, vtype) {
  try {
    const { enrichVesselContact } = require("../services/contactEnricher");
    const result = await enrichVesselContact(imo, {
      vesselName: name || null,
      currentPort: curPort || null,
      nextPort: nextPort || null,
      vesselType: vtype || null,
    });
    if (!result) return null;
    const owner = result.owner || {};
    return {
      vessel_name: result.vessel_name || null,
      flag: result.flag || null,
      owner_name: owner.company_name || null,
      manager_name:
        result.manager && result.manager.company_name
          ? result.manager.company_name
          : result.ism_manager && result.ism_manager.company_name
          ? result.ism_manager.company_name
          : null,
      ship_manager:
        result.ship_manager && result.ship_manager.company_name
          ? result.ship_manager.company_name
          : null,
      operator_name:
        result.operator && result.operator.company_name
          ? result.operator.company_name
          : null,
      address: owner.registered_address || owner.address || null,
      email: owner.primary_email || owner.email || null,
      email_ops: owner.secondary_email || owner.email_ops || null,
      phone: owner.phone_primary || owner.phone || null,
      phone_alt: owner.phone_secondary || owner.phone_alt || null,
      website: owner.website || null,
      linkedin: owner.linkedin || null,
      port_agents: result.port_agents || [],
      confidence:
        result.enrichment && result.enrichment.confidence
          ? result.enrichment.confidence
          : 0.5,
      source:
        result.enrichment && result.enrichment.source
          ? result.enrichment.source
          : "equasis",
    };
  } catch (e) {
    logger.warn("[step/equasis] " + (e.message || String(e)).slice(0, 120));
    return null;
  }
}

// STEP 2: MarineTraffic
async function stepMarineTraffic(imo) {
  try {
    const res = await safeFetch(
      "https://www.marinetraffic.com/en/ais/details/ships/imo:" + imo,
      { headers: { Referer: "https://www.marinetraffic.com/" } }, 12000
    );
    if (!res.ok) return null;
    const html = await res.text();
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const ownerM = /Registered\s+Owner[\s:]+([A-Z][A-Za-z0-9\s&.,'\-]{3,70}?)(?:\s{2,}|\||<)/i.exec(text);
    const mgrM   = /ISM\s+Manager[\s:]+([A-Z][A-Za-z0-9\s&.,'\-]{3,70}?)(?:\s{2,}|\||<)/i.exec(text);
    const flagM  = /Flag[\s:]+([A-Z][A-Za-z\s]{2,40}?)(?:\s{2,}|\||<)/i.exec(text);
    const ownerVal = ownerM && ownerM[1] ? ownerM[1].trim() : null;
    const mgrVal   = mgrM   && mgrM[1]   ? mgrM[1].trim()   : null;
    if (!ownerVal && !mgrVal) return null;
    logger.info("[step/marinetraffic] IMO " + imo + ": owner=\"" + ownerVal + "\"");
    return { owner_name: ownerVal, manager_name: mgrVal,
             flag: flagM && flagM[1] ? flagM[1].trim() : null,
             confidence: 0.75, source: "marinetraffic" };
  } catch (e) {
    logger.warn("[step/marinetraffic] " + (e.message || "").slice(0, 80));
    return null;
  }
}

// STEP 3: VesselFinder
async function stepVesselFinder(imo) {
  try {
    const res = await safeFetch(
      "https://www.vesselfinder.com/vessels/details/" + imo,
      { headers: { Referer: "https://www.vesselfinder.com/" } }, 10000
    );
    if (!res.ok) return null;
    const text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const ownerM = /(?:Owner|Registered Owner)[\s:]+([A-Z][A-Za-z0-9\s&.,'\-]{3,70}?)(?:\s{2,}|\||<)/i.exec(text);
    const flagM  = /Flag[\s:]+([A-Z][A-Za-z\s]{2,35}?)(?:\s{2,}|\||<)/i.exec(text);
    const ownerVal = ownerM && ownerM[1] ? ownerM[1].trim() : null;
    if (!ownerVal) return null;
    return { owner_name: ownerVal, flag: flagM && flagM[1] ? flagM[1].trim() : null,
             confidence: 0.70, source: "vesselfinder" };
  } catch (e) { logger.warn("[step/vesselfinder] " + (e.message || "").slice(0, 80)); return null; }
}

// STEP 4: FleetMon
async function stepFleetMon(imo) {
  try {
    const res = await safeFetch("https://www.fleetmon.com/vessels/vessel/" + imo + "/",
      { headers: { Referer: "https://www.fleetmon.com/" } }, 10000);
    if (!res.ok) return null;
    const text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const ownerM = /(?:Owner|Ship Owner)[\s:]+([A-Z][A-Za-z0-9\s&.,'\-]{3,70}?)(?:\s{2,}|\||<)/i.exec(text);
    const ownerVal = ownerM && ownerM[1] ? ownerM[1].trim() : null;
    if (!ownerVal) return null;
    return { owner_name: ownerVal, confidence: 0.65, source: "fleetmon" };
  } catch (e) { logger.warn("[step/fleetmon] " + (e.message || "").slice(0, 80)); return null; }
}

// STEP 5: DuckDuckGo HTML search (no API key, rarely blocked)
async function stepDDGSearch(companyName, flag) {
  if (!companyName) return null;
  try {
    const q = encodeURIComponent('"' + companyName + '" shipping contact email');
    const res = await safeFetch("https://html.duckduckgo.com/html/?q=" + q,
      { headers: { Referer: "https://duckduckgo.com/" } }, 10000);
    if (!res.ok) return null;
    const html   = await res.text();
    const text   = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const emails = extractEmails(text);
    const phones = extractPhones(text);
    const urlRe  = /uddg=([^&"]+)/g;
    const domains = new Set();
    let m;
    while ((m = urlRe.exec(html)) !== null) {
      try {
        const u = new URL(decodeURIComponent(m[1]));
        const d = u.hostname.replace(/^www\./, "");
        if (!d.includes("duckduckgo") && !d.includes("google") &&
            !d.includes("facebook") && !d.includes("marinetraffic") &&
            !d.includes("wikipedia") && !d.includes("linkedin")) {
          domains.add(d);
        }
      } catch {}
    }
    const domain = Array.from(domains)[0] || null;
    if (!emails.length && !domain) return null;
    logger.info("[step/ddg] \"" + companyName + "\": email=" + (emails[0] || "—") + " domain=" + (domain || "—"));
    return { email: emails[0] || null, phone: phones[0] || null,
             website: domain ? "https://" + domain : null,
             confidence: 0.60, source: "web_search" };
  } catch (e) { logger.warn("[step/ddg] " + (e.message || "").slice(0, 80)); return null; }
}

// STEP 6: Bing search fallback
async function stepBingSearch(companyName) {
  if (!companyName) return null;
  try {
    const q = encodeURIComponent('"' + companyName + '" maritime contact email');
    const res = await safeFetch("https://www.bing.com/search?q=" + q + "&count=5",
      { headers: { Referer: "https://www.bing.com/" } }, 10000);
    if (!res.ok) return null;
    const text   = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const emails = extractEmails(text);
    const phones = extractPhones(text);
    if (!emails.length && !phones.length) return null;
    logger.info("[step/bing] \"" + companyName + "\": email=" + (emails[0] || "—"));
    return { email: emails[0] || null, phone: phones[0] || null,
             confidence: 0.55, source: "web_search" };
  } catch (e) { logger.warn("[step/bing] " + (e.message || "").slice(0, 80)); return null; }
}

// STEP 7: Direct website scrape
async function stepWebsiteScrape(urlOrDomain) {
  if (!urlOrDomain) return null;
  const hostname = urlOrDomain.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
  const urls = [
    "https://" + hostname + "/contact",
    "https://" + hostname + "/contact-us",
    "https://" + hostname + "/contacts",
    "https://www." + hostname + "/contact",
    "https://" + hostname + "/about",
    "https://" + hostname,
  ];
  for (const url of urls) {
    try {
      const res = await safeFetch(url, {}, 7000);
      if (!res.ok) continue;
      const text   = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const emails = extractEmails(text);
      const phones = extractPhones(text);
      if (emails.length || phones.length) {
        logger.info("[step/scrape] " + url + ": email=" + (emails[0] || "—"));
        return { email: emails[0] || null, email_ops: emails[1] || null,
                 phone: phones[0] || null, website: "https://" + hostname,
                 confidence: 0.80, source: "website_scrape" };
      }
    } catch {}
  }
  return null;
}

// STEP 8: Google CSE (optional)
async function stepGoogleCSE(companyName) {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx     = process.env.GOOGLE_CSE_ID;
  if (!apiKey || !cx) return null;
  try {
    const q   = encodeURIComponent('"' + companyName + '" shipping email contact');
    const res = await safeFetch(
      "https://www.googleapis.com/customsearch/v1?key=" + apiKey + "&cx=" + cx + "&q=" + q + "&num=5",
      {}, 8000);
    if (!res.ok) return null;
    const json     = await res.json();
    const snippets = (json.items || []).map(i => i.title + " " + i.snippet).join(" ");
    const emails   = extractEmails(snippets);
    const phones   = extractPhones(snippets);
    if (!emails.length && !phones.length) return null;
    return { email: emails[0] || null, phone: phones[0] || null,
             confidence: 0.70, source: "google_cse" };
  } catch (e) { logger.warn("[step/google-cse] " + (e.message || "").slice(0, 80)); return null; }
}

// STEP 9: Port agents static DB
async function stepPortAgents(curPort, nextPort, vtype, ownerName) {
  const seen   = new Set();
  const agents = [];
  for (const portKey of [curPort, nextPort].filter(Boolean)) {
    try {
      const found  = lookupPortAgents({ portCode: portKey, portName: portKey, vesselType: vtype || null });
      const ranked = found && found.length ? rankAgents(found, { vesselType: vtype, ownerName: ownerName }) : [];
      for (const a of ranked) {
        const k = (a.agent_name || a.agency_company || "").toLowerCase();
        if (k && !seen.has(k)) { seen.add(k); agents.push(a); }
      }
    } catch (e) {
      logger.warn("[step/port-agents] " + portKey + ": " + (e.message || "").slice(0, 60));
    }
  }
  return agents;
}

// Main pipeline
async function runEnrichment(params) {
  const imoInt  = params.imoInt;
  const name    = params.name;
  const curPort = params.curPort;
  const nextPort= params.nextPort;
  const vtype   = params.vtype;

  const r = {
    imo: imoInt, vessel_name: name || null, flag: null,
    owner_name: null, manager_name: null, ship_manager: null, operator_name: null,
    address: null, email: null, email_ops: null, phone: null, phone_alt: null,
    website: null, linkedin: null, source: "", confidence: 0,
  };

  function merge(src) {
    if (!src) return;
    r.vessel_name   = first(r.vessel_name,   src.vessel_name);
    r.flag          = first(r.flag,          src.flag);
    r.owner_name    = first(r.owner_name,    src.owner_name);
    r.manager_name  = first(r.manager_name,  src.manager_name);
    r.ship_manager  = first(r.ship_manager,  src.ship_manager);
    r.operator_name = first(r.operator_name, src.operator_name);
    r.address       = first(r.address,       src.address);
    r.email         = first(r.email,         src.email);
    r.email_ops     = first(r.email_ops,     src.email_ops);
    r.phone         = first(r.phone,         src.phone);
    r.phone_alt     = first(r.phone_alt,     src.phone_alt);
    r.website       = first(r.website,       src.website);
    r.linkedin      = first(r.linkedin,      src.linkedin);
    r.confidence    = Math.max(r.confidence, src.confidence || 0);
    r.source        = addSrc(r.source, src.source);
  }

  // ── Phase 0: BigQuery contact table (fastest — checked first) ──────────────
  // If BQ has current owner + email, we can skip most web scraping entirely.
  const bqResult = await safe("bq-contacts", function() { return stepBigQueryContacts(imoInt); });
  if (bqResult) {
    merge(bqResult);
    // Also store manager contacts separately for the response
    if (bqResult.manager_email) r.manager_email = bqResult.manager_email;
    if (bqResult.manager_phone) r.manager_phone = bqResult.manager_phone;
    if (bqResult.manager_website) r.manager_website = bqResult.manager_website;
  }

  // If BQ gave us both owner name AND email, skip all web scraping
  const bqComplete = !!(r.owner_name && r.email);

  // ── Phase 1: Identity (parallel) — skip if BQ already complete ─────────────
  let eq = null;
  if (!bqComplete) {
    const [eqR, mt, vf] = await Promise.all([
      imoInt ? safe("equasis",       function() { return stepEquasis(imoInt, name, curPort, nextPort, vtype); }) : null,
      imoInt ? safe("marinetraffic", function() { return stepMarineTraffic(imoInt); }) : null,
      imoInt ? safe("vesselfinder",  function() { return stepVesselFinder(imoInt); })  : null,
    ]);
    eq = eqR;
    [eq, mt, vf].forEach(merge);

    if (!r.owner_name && imoInt) {
      merge(await safe("fleetmon", function() { return stepFleetMon(imoInt); }));
    }
  }

  // ── Phase 2: Contact discovery — only if BQ didn't already provide email ────
  const company = r.owner_name || r.manager_name || name;
  if (!bqComplete && company && (!r.email || !r.website)) {
    // Known domain lookup
    const knownDomain = lookupKnownDomain(company);
    if (knownDomain && !r.website) {
      r.website = "https://" + knownDomain;
      logger.info("[contact] known domain for \"" + company + "\" → " + knownDomain);
    }

    // Scrape known/existing website
    if (r.website && !r.email) {
      merge(await safe("scrape-website", function() { return stepWebsiteScrape(r.website); }));
    }

    // DuckDuckGo search
    if (!r.email) {
      const ddg = await safe("ddg-search", function() { return stepDDGSearch(company, r.flag); });
      if (ddg) {
        merge(ddg);
        // If DDG found a new domain, scrape it too
        if (ddg.website && !r.email) {
          merge(await safe("scrape-ddg", function() { return stepWebsiteScrape(ddg.website); }));
        }
      }
    }

    // Google CSE
    if (!r.email) {
      merge(await safe("google-cse", function() { return stepGoogleCSE(company); }));
    }

    // Bing fallback
    if (!r.email) {
      merge(await safe("bing-search", function() { return stepBingSearch(company); }));
    }

    // Gemini AI as final fallback — only if we have company name but no email
    if (!r.email) {
      merge(await safe("gemini-enrich", function() { return stepGeminiEnrich(company, imoInt); }));
    }
  } // ← closes: if (!bqComplete && company && (!r.email || !r.website))

  // ── Phase 3: Port agents ──────────────────────────────────────────────────
  const portAgents = await stepPortAgents(curPort, nextPort, vtype, r.owner_name);
  // Merge port agents from equasis result
  if (eq && eq.port_agents && eq.port_agents.length) {
    const seen = new Set(portAgents.map(function(a) {
      return (a.agent_name || a.agency_company || "").toLowerCase();
    }));
    for (const a of eq.port_agents) {
      const k = (a.agency_name || a.agent_name || a.agency_company || "").toLowerCase();
      if (k && !seen.has(k)) { seen.add(k); portAgents.push(a); }
    }
  }

  if (!r.owner_name && !r.vessel_name && !r.manager_name && !portAgents.length) {
    return null;
  }

  if (r.email) r.confidence = Math.max(r.confidence, 0.70);
  if (!r.confidence) r.confidence = r.owner_name ? 0.45 : 0.20;

  logger.info("[ai-contact] DONE IMO=" + imoInt +
    " owner=\"" + (r.owner_name || "—") + "\"" +
    " email=\"" + (r.email || "—") + "\"" +
    " src=\"" + r.source + "\"");

  return {
    vessel_name:  r.vessel_name || name || null,
    imo:          imoInt ? String(imoInt) : null,
    flag:         r.flag        || null,
    vessel_type:  vtype         || null,
    built_year:   null,
    owner: r.owner_name ? {
      company_name: r.owner_name,
      address:      r.address   || null,
      phone:        r.phone     || null,
      phone_alt:    r.phone_alt || null,
      email:        r.email     || null,
      email_ops:    r.email_ops || null,
      website:      r.website   || null,
      linkedin:     r.linkedin  || null,
      data_source:  r.source    || null,
    } : null,
    ism_manager:  r.manager_name  ? { company_name: r.manager_name,  data_source: r.source } : null,
    ship_manager: r.ship_manager  ? { company_name: r.ship_manager,  data_source: r.source } : null,
    operator:     r.operator_name ? { company_name: r.operator_name, data_source: r.source } : null,
    key_personnel: [],
    port_agents: portAgents.map(function(a) { return {
      agency_name: a.agency_name || a.agent_name || a.agency_company || null,
      port:        a.port_name   || a.port_code  || null,
      email:       a.email_primary || a.email    || null,
      phone:       a.phone_main    || a.phone    || null,
      phone_24h:   a.phone_24h     || null,
      website:     a.website       || null,
    }; }).filter(function(a) { return !!a.agency_name; }),
    master_contact: null,
    sources_used: r.source ? r.source.split("+").filter(Boolean) : [],
    confidence:   r.confidence,
    notes: r.email ? null : (r.owner_name ? "Owner identified but no public contact email found." : null),
  };
}

router.post("/enrich", async function(req, res) {
  const body = req.body || {};
  const imo = body.imo;
  const mmsi = body.mmsi;
  const name = body.name;
  const curPort = body.curPort;
  const nextPort = body.nextPort;
  const vtype = body.vtype;

  if (!imo && !mmsi && !name) {
    return res.status(400).json({ success: false, error: "Provide imo, mmsi, or name" });
  }
  const imoInt = imo ? (parseInt(imo, 10) || null) : null;
  logger.info("[ai-contact] enrich IMO=" + imoInt + " name=\"" + (name || "") + "\" port=\"" + (curPort || "") + "\"");

  try {
    const result = await withTimeout(
      runEnrichment({ imoInt, name, curPort, nextPort, vtype }),
      T_TOTAL, "full enrichment"
    );
    if (!result) {
      return res.status(502).json({ success: false, error: "No data found. Check the IMO number is valid." });
    }
    return res.json({ success: true, data: result });
  } catch (err) {
    logger.warn("[ai-contact] error: " + err.message);
    const isTimeout = err.message && err.message.includes("timeout");
    return res.status(isTimeout ? 504 : 502).json({
      success: false,
      error: isTimeout ? "Request timed out. Please try again." : ("Enrichment failed: " + err.message),
    });
  }
});

module.exports = router;