// src/services/intelligence/pipeline.js — v3
// Full 10-step Maritime Intelligence Pipeline (pure Node.js)
"use strict";

const logger  = require("../../utils/logger");
const { normalize, deduplicateCompanies } = require("./engines/normalizer");
const { resolveDomain, hasMxRecord }      = require("./engines/domainResolver");
const { scrapeWebsite }                   = require("./engines/websiteScraper");
const { generateEmails, validateEmails, rankEmails } = require("./engines/emailEngine");
const { applyConfidenceScoring }          = require("./engines/confidenceScorer");
const { fetchEquasis }                    = require("../maritime/equasisScraper");
const { fetchAllMaritimeDBs }             = require("../maritime/maritimeDBs");
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

  const domainResult = await resolveDomain(name).catch(() => null);
  const domain    = domainResult?.domain    ?? null;
  const domConf   = domainResult?.confidence ?? 0;
  const domMethod = domainResult?.method     ?? "unresolved";
  const domTitle  = domainResult?.title      ?? null;

  const dbCo = db.upsertCompany({ name, domain, imoNumber, role });

  const result = {
    company: name, company_normalized: norm.normalized, role,
    domain, domain_confidence: domConf, domain_method: domMethod, domain_title: domTitle,
    emails: [], phones: [], addresses: [], scraped: false, mx_exists: false,
  };

  if (!domain) return result;

  result.mx_exists = await hasMxRecord(domain).catch(() => false);

  const scraped = await scrapeWebsite(domain).catch(() => null);
  let scrapedEmails = [];
  if (scraped?.emails?.length) {
    result.scraped = true; scrapedEmails = scraped.emails;
    result.phones = scraped.phones || []; result.addresses = scraped.addresses || [];
    for (const e of scrapedEmails)
      db.upsertContact({ companyId: dbCo.id, email: e.email, confidence: e.confidence, source: e.source });
    logger.info(`[pipeline] scraped ${scrapedEmails.length} emails from ${domain}`);
  }

  const scrapedSet = new Set(scrapedEmails.map(e => e.email.toLowerCase()));
  const generated  = generateEmails(domain).filter(g => !scrapedSet.has(g.email.toLowerCase()));
  const validated  = await validateEmails(generated, domain).catch(() => []);
  for (const v of validated) {
    if (v.confidence >= 55 || v.smtp_valid === true) {
      db.upsertContact({ companyId: dbCo.id, email: v.email, confidence: v.confidence, source: v.source, smtpValid: v.smtp_valid });
      scrapedEmails.push(v);
    }
  }

  const allRaw = rankEmails(scrapedEmails);
  const scored = applyConfidenceScoring(allRaw, domain, scraped?.emails || [], domConf);
  result.emails = scored.slice(0, MAX_EMAILS_PER_CO);

  logger.info(`[pipeline] "${name}": domain=${domain} emails=${result.emails.length} mx=${result.mx_exists}`);
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

  const results = [];
  for (const co of companies) {
    const r = await processCompany({ name: co.name, role: co.role, imoNumber: imoStr, address });
    if (r) results.push(r);
    await new Promise(res => setTimeout(res, CRAWL_DELAY_MS));
  }

  const allEmails = rankEmails(results.flatMap(r => r.emails || []));
  const allPhones = [...new Set(results.flatMap(r => r.phones || []))];

  const output = {
    imo_number: imoStr, companies: results,
    top_contacts: allEmails.slice(0, 8), top_phones: allPhones.slice(0, 5),
    pipeline_ran_at: new Date().toISOString(), cached: false,
  };

  cacheSet(imoStr, output);
  if (imoStr) db.cacheResult(imoStr, output);

  logger.info(`[pipeline] ══ DONE IMO ${imoStr} — ${results.length} cos, ${allEmails.length} emails ══`);
  return output;
}

async function runCompanyPipeline(companyName, address) {
  if (!companyName) return null;
  return processCompany({ name: companyName, role: "unknown", imoNumber: null, address });
}

module.exports = { runPipeline, runCompanyPipeline };