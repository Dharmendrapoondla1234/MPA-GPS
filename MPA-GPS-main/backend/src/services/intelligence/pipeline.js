// src/services/intelligence/pipeline.js — v4 (Gemini AI boosted)
// Full Maritime Intelligence Pipeline: standard engines + Gemini AI fallback
"use strict";

const logger  = require("../../utils/logger");
const { normalize, deduplicateCompanies } = require("./engines/normalizer");
const { resolveDomain, hasMxRecord }      = require("./engines/domainResolver");
const { scrapeWebsite }                   = require("./engines/websiteScraper");
const { generateEmails, validateEmails, rankEmails } = require("./engines/emailEngine");
const { applyConfidenceScoring }          = require("./engines/confidenceScorer");
const { fetchEquasis }                    = require("../maritime/equasisScraper");
const { fetchAllMaritimeDBs }             = require("../maritime/maritimeDBs");
const {
  enrichCompanyWithGemini,
  lookupVesselByIMO,
  verifyOrFindDomain,
  geminiBoostPipeline,
} = require("./geminiEnricher");
const db = require("./db");
const { PIPELINE_CACHE_TTL_MS, MAX_EMAILS_PER_CO, CRAWL_DELAY_MS } = require("../../config");

const _cache = new Map();
const _cacheTs = new Map();

function cacheGet(k) {
  const ts = _cacheTs.get(k) || 0;
  return (Date.now() - ts < PIPELINE_CACHE_TTL_MS) ? _cache.get(k) : null;
}
function cacheSet(k, d) { _cache.set(k, d); _cacheTs.set(k, Date.now()); return d; }

async function processCompany({ name, role, imoNumber, address }) {
  if (!name || name.trim().length < 3) return null;
  const norm = normalize(name);
  if (!norm) return null;
  logger.info(`[pipeline] "${name}" (${role}) → "${norm.normalized}"`);

  // Step 1: Domain resolution (search engines + DNS + heuristics)
  const domainResult = await resolveDomain(name).catch(() => null);
  let domain    = domainResult?.domain    ?? null;
  let domConf   = domainResult?.confidence ?? 0;
  let domMethod = domainResult?.method     ?? "unresolved";
  let domTitle  = domainResult?.title      ?? null;

  // Step 1b: Gemini domain verification/fallback if domain not found or low confidence
  if (!domain || domConf < 45) {
    logger.info(`[pipeline] domain ${domain ? `low-conf(${domConf})` : "missing"} for "${name}" — trying Gemini`);
    const gemDomain = await verifyOrFindDomain(name, domain ? [domain] : []).catch(() => null);
    if (gemDomain?.domain && gemDomain.confidence > domConf) {
      domain    = gemDomain.domain;
      domConf   = gemDomain.confidence;
      domMethod = "gemini_ai";
      domTitle  = null;
      logger.info(`[pipeline] Gemini domain: ${domain} (${domConf}%)`);
    }
  }

  const dbCo = db.upsertCompany({ name, domain, imoNumber, role });

  const result = {
    company: name, company_normalized: norm.normalized, role,
    domain, domain_confidence: domConf, domain_method: domMethod, domain_title: domTitle,
    emails: [], phones: [], addresses: [], scraped: false, mx_exists: false,
  };

  // Step 2: MX check + website scrape
  if (domain) {
    result.mx_exists = await hasMxRecord(domain).catch(() => false);

    const scraped = await scrapeWebsite(domain).catch(() => null);
    let scrapedEmails = [];
    if (scraped?.emails?.length) {
      result.scraped   = true;
      scrapedEmails    = scraped.emails;
      result.phones    = scraped.phones    || [];
      result.addresses = scraped.addresses || [];
      for (const e of scrapedEmails)
        db.upsertContact({ companyId: dbCo.id, email: e.email, confidence: e.confidence, source: e.source });
      logger.info(`[pipeline] scraped ${scrapedEmails.length} emails from ${domain}`);
    }

    // Step 3: Email pattern generation + SMTP validation
    const scrapedSet = new Set(scrapedEmails.map(e => e.email.toLowerCase()));
    const generated  = generateEmails(domain).filter(g => !scrapedSet.has(g.email.toLowerCase()));
    const validated  = await validateEmails(generated, domain).catch(() => []);
    for (const v of validated) {
      if (v.confidence >= 55 || v.smtp_valid === true) {
        db.upsertContact({ companyId: dbCo.id, email: v.email, confidence: v.confidence, source: v.source, smtpValid: v.smtp_valid });
        scrapedEmails.push(v);
      }
    }

    // Step 4: Confidence scoring
    const allRaw = rankEmails(scrapedEmails);
    const scored = applyConfidenceScoring(allRaw, domain, scraped?.emails || [], domConf);
    result.emails = scored.slice(0, MAX_EMAILS_PER_CO);
  }

  // Step 5: Gemini AI boost if no emails found
  if (!result.emails.length) {
    logger.info(`[pipeline] no emails for "${name}" — boosting with Gemini`);
    const gemini = await enrichCompanyWithGemini(name, domain).catch(() => null);
    if (gemini) {
      if (!domain && gemini.website) {
        result.domain            = gemini.website;
        result.domain_confidence = gemini.confidence;
        result.domain_method     = "gemini_ai";
        domain = gemini.website;
      }
      if (gemini.emails?.length) {
        const gemEmails = applyConfidenceScoring(gemini.emails, domain, [], domConf);
        result.emails   = [...result.emails, ...gemEmails].slice(0, MAX_EMAILS_PER_CO);
      }
      if (gemini.phones?.length   && !result.phones.length)    result.phones        = gemini.phones;
      if (gemini.address          && !result.addresses.length) result.addresses     = [gemini.address];
      if (gemini.key_personnel?.length)                        result.key_personnel = gemini.key_personnel;
      result.gemini_boosted = true;
    }
  }

  logger.info(`[pipeline] "${name}": domain=${result.domain || "—"} emails=${result.emails.length} mx=${result.mx_exists}`);
  return result;
}

async function runPipeline({ imo, owner, manager, operator, ship_manager, address, forceRefresh = false }) {
  const imoStr = String(imo || "");

  if (!forceRefresh && imoStr) {
    const hot = cacheGet(imoStr);
    if (hot) return { ...hot, cached: true };
    const cold = db.getCachedResult(imoStr);
    if (cold) { cacheSet(imoStr, cold); return { ...cold, cached: true }; }
  }

  logger.info(`[pipeline] ══ START IMO ${imoStr} ══`);

  // Phase 1: Get company names if not provided
  if (imo && !owner && !manager && !operator && !ship_manager) {
    const imoInt = parseInt(imo, 10);
    const [eq, mt] = await Promise.all([
      fetchEquasis(imoInt).catch(() => null),
      fetchAllMaritimeDBs(imoInt).catch(() => null),
    ]);
    const merged = { ...(mt || {}), ...(eq || {}) };
    owner        = merged.owner        || merged.owner_name        || null;
    manager      = merged.manager      || merged.manager_name      || null;
    ship_manager = merged.ship_manager || null;
    operator     = merged.operator     || merged.operator_name     || null;
    address      = address || merged.address || null;

    // Gemini fallback: identify vessel if all standard sources failed
    if (!owner && !manager && process.env.GEMINI_API_KEY) {
      logger.info(`[pipeline] No company names from standard sources — asking Gemini for IMO ${imoInt}`);
      const gemVessel = await lookupVesselByIMO(imoInt).catch(() => null);
      if (gemVessel) {
        owner        = gemVessel.registered_owner || null;
        manager      = gemVessel.ism_manager      || null;
        ship_manager = gemVessel.ship_manager     || null;
        operator     = gemVessel.operator         || null;
        logger.info(`[pipeline] Gemini vessel: owner="${owner || "—"}" manager="${manager || "—"}"`);
      }
    }
  }

  const rawList = [
    { name: owner,        role: "owner"        },
    { name: manager,      role: "manager"      },
    { name: operator,     role: "operator"     },
    { name: ship_manager, role: "ship_manager" },
  ].filter(c => c.name && c.name.trim().length > 2);

  const companies = deduplicateCompanies(rawList);
  if (!companies.length) {
    return {
      imo_number: imoStr, companies: [], top_contacts: [], top_phones: [],
      pipeline_ran_at: new Date().toISOString(), cached: false,
      error: "No company names found. Provide owner/manager or ensure IMO is valid.",
    };
  }

  // Phase 2: Process each company
  const results = [];
  for (const co of companies) {
    const r = await processCompany({ name: co.name, role: co.role, imoNumber: imoStr, address });
    if (r) results.push(r);
    await new Promise(res => setTimeout(res, CRAWL_DELAY_MS));
  }

  // Phase 3: Full Gemini boost if still zero emails across all companies
  const totalEmails = results.reduce((sum, r) => sum + (r.emails?.length || 0), 0);
  if (totalEmails === 0 && process.env.GEMINI_API_KEY) {
    logger.info(`[pipeline] Zero emails found — running full Gemini boost`);
    const boost = await geminiBoostPipeline({ imo: imoStr, owner, manager, operator, ship_manager }).catch(() => null);
    if (boost?.companies?.length) {
      for (const boostCo of boost.companies) {
        const existing = results.find(r =>
          r.company?.toLowerCase().includes((boostCo.company || "").toLowerCase().slice(0, 10)) ||
          (boostCo.company || "").toLowerCase().includes((r.company || "").toLowerCase().slice(0, 10))
        );
        if (existing) {
          if (!existing.domain && boostCo.domain)   { existing.domain = boostCo.domain; existing.domain_method = "gemini_ai"; }
          if (!existing.emails.length)               existing.emails    = boostCo.emails    || [];
          if (!existing.phones.length)               existing.phones    = boostCo.phones    || [];
          if (!existing.addresses.length)            existing.addresses = boostCo.addresses || [];
          existing.gemini_boosted = true;
        } else {
          results.push({ ...boostCo, gemini_boosted: true });
        }
      }
    }
  }

  const allEmails = rankEmails(results.flatMap(r => r.emails || []));
  const allPhones = [...new Set(results.flatMap(r => r.phones || []))];

  const output = {
    imo_number:      imoStr,
    companies:       results,
    top_contacts:    allEmails.slice(0, 8),
    top_phones:      allPhones.slice(0, 5),
    pipeline_ran_at: new Date().toISOString(),
    cached:          false,
    gemini_used:     results.some(r => r.gemini_boosted || r.domain_method === "gemini_ai"),
  };

  cacheSet(imoStr, output);
  if (imoStr) db.cacheResult(imoStr, output);

  logger.info(`[pipeline] ══ DONE IMO ${imoStr} — ${results.length} cos, ${allEmails.length} emails, gemini=${output.gemini_used} ══`);
  return output;
}

async function runCompanyPipeline(companyName, address) {
  if (!companyName) return null;
  return processCompany({ name: companyName, role: "unknown", imoNumber: null, address });
}

module.exports = { runPipeline, runCompanyPipeline };