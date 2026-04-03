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

const T_STEP  = 12_000;
const T_TOTAL = 60_000;

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?[\d][\d\s\-()\.\/]{5,18}\d)/g;

function extractEmails(text) {
  return [...new Set((text || "").match(EMAIL_RE) || [])].filter(e =>
    !e.includes("example") && !e.includes("yourdomain") &&
    !e.includes("@2x") && !e.includes(".png") && !e.includes("sentry") &&
    !e.includes("wix") && !e.includes("cdn") && !e.includes("noreply") &&
    e.length < 80
  );
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

  // Phase 1: Identity (parallel)
  const [eq, mt, vf] = await Promise.all([
    imoInt ? safe("equasis",      function() { return stepEquasis(imoInt, name, curPort, nextPort, vtype); }) : null,
    imoInt ? safe("marinetraffic",function() { return stepMarineTraffic(imoInt); }) : null,
    imoInt ? safe("vesselfinder", function() { return stepVesselFinder(imoInt); })  : null,
  ]);
  [eq, mt, vf].forEach(merge);

  if (!r.owner_name && imoInt) {
    merge(await safe("fleetmon", function() { return stepFleetMon(imoInt); }));
  }

  // Phase 2: Contact discovery
  const company = r.owner_name || r.manager_name || name;
  if (company && (!r.email || !r.website)) {
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

    // Domain guess + scrape as last resort
    if (!r.email && !r.website) {
      const guessed = buildDomainGuess(company);
      if (guessed) {
        merge(await safe("scrape-guessed", function() { return stepWebsiteScrape(guessed); }));
      }
    }
  }

  // Phase 3: Port agents
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