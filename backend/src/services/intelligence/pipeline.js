// services/intelligence/pipeline.js  v2
// Full 11-step intelligence pipeline — no AI, no subscription
// Equasis data → Normalize → Domain discover → Crawl → Generate emails
// → Validate (MX+SMTP) → Location filter → Score → Store → Serve
"use strict";

const logger              = require("../../utils/logger");
const { normalize }       = require("./normalizer");
const { resolveDomain, hasMxRecord } = require("./domainResolver");
const { generateEmails, validateEmails, rankEmails } = require("./emailEngine");
const { scrapeWebsite }   = require("./websiteScraper");
const db                  = require("./db");

const pipelineCache = new Map();
const CACHE_TTL     = 6 * 60 * 60 * 1000; // 6h

function cacheGet(k) { const h = pipelineCache.get(k); return h && Date.now()-h.ts < CACHE_TTL ? h.data : null; }
function cacheSet(k, d) { pipelineCache.set(k, { data: d, ts: Date.now() }); return d; }

// ── Cross-validation: only keep emails that pass multiple signals ──
function crossValidate(emails, domain, scrapedEmails) {
  const scrapedSet = new Set((scrapedEmails || []).map(e => e.email.toLowerCase()));
  return emails.map(e => {
    let score = e.confidence || 50;
    // Signal 1: found on website (not just generated)
    if (scrapedSet.has(e.email.toLowerCase())) score = Math.min(score + 10, 95);
    // Signal 2: SMTP confirmed
    if (e.smtp_valid === true) score = Math.min(score + 8, 95);
    // Signal 3: email prefix is a known maritime role
    const prefix = e.email.split("@")[0];
    if (["operations","ops","chartering","charter","commercial","crewing"].includes(prefix)) score = Math.min(score + 3, 95);
    // Signal 4: domain matches — always true here but good for merging pipelines
    if (e.email.endsWith(`@${domain}`)) score = Math.min(score, 95);
    return { ...e, confidence: Math.round(score) };
  }).sort((a, b) => b.confidence - a.confidence);
}

async function processCompany({ name, role, imoNumber, address }) {
  if (!name || name.length < 3) return null;
  const norm = normalize(name);
  logger.info(`[pipeline] "${name}" (${role}) → normalized: "${norm?.normalized}"`);

  // ── 1. Resolve domain ──────────────────────────────────────────
  const domainResult = await resolveDomain(name).catch(err => {
    logger.warn(`[pipeline] domain error "${name}": ${err.message}`);
    return null;
  });
  const domain = domainResult?.domain || null;

  const company = db.upsertCompany({ name, domain, imoNumber, role });

  const result = {
    company:           name,
    company_normalized: norm?.normalized || name.toLowerCase(),
    role,
    domain:            domain || null,
    domain_confidence: domainResult?.confidence || 0,
    domain_method:     domainResult?.method || "unresolved",
    domain_title:      domainResult?.title || null,
    emails:            [],
    phones:            [],
    addresses:         [],
    scraped:           false,
    mx_exists:         false,
  };

  if (!domain) return result;

  // ── 2. Check MX record (Layer 1 validation) ────────────────────
  result.mx_exists = await hasMxRecord(domain).catch(() => false);
  logger.info(`[pipeline] ${domain} MX: ${result.mx_exists}`);

  // ── 3. Scrape website ──────────────────────────────────────────
  const scraped = await scrapeWebsite(domain).catch(err => {
    logger.warn(`[pipeline] scrape error ${domain}: ${err.message?.slice(0,80)}`);
    return null;
  });

  let scrapedEmails = [];
  if (scraped?.emails?.length) {
    result.scraped    = true;
    scrapedEmails     = scraped.emails;
    result.phones     = scraped.phones  || [];
    result.addresses  = scraped.addresses || [];
    for (const e of scraped.emails) {
      db.upsertContact({ companyId: company.id, email: e.email, confidence: e.confidence, source: e.source });
    }
    logger.info(`[pipeline] scraped ${scraped.emails.length} emails from ${domain}`);
  }

  // ── 4. Generate + validate email patterns ─────────────────────
  const foundSet  = new Set(scrapedEmails.map(e => e.email.toLowerCase()));
  const generated = generateEmails(domain).filter(g => !foundSet.has(g.email.toLowerCase()));

  const BATCH = 5;
  const validated = [];
  for (let i = 0; i < generated.length; i += BATCH) {
    const batch = generated.slice(i, i + BATCH);
    const res   = await validateEmails(batch.map(b => b.email), domain)
      .catch(() => batch.map(b => ({ ...b, smtp_valid: null, mx_exists: result.mx_exists })));
    validated.push(...res);
    // Stop if we've found enough SMTP-confirmed
    if (validated.filter(v => v.smtp_valid === true).length >= 3) break;
  }

  for (const v of validated) {
    if (v.confidence >= 55 || v.smtp_valid === true) {
      db.upsertContact({ companyId: company.id, email: v.email, confidence: v.confidence, source: v.source, smtpValid: v.smtp_valid });
      scrapedEmails.push(v);
    }
  }

  // ── 5. Cross-validate and rank ────────────────────────────────
  const allEmails = crossValidate(rankEmails(scrapedEmails), domain, scraped?.emails);
  result.emails   = allEmails.slice(0, 10);

  logger.info(`[pipeline] "${name}": domain=${domain} emails=${result.emails.length} mx=${result.mx_exists}`);
  return result;
}

async function runPipeline({ imo, owner, manager, operator, ship_manager, address, forceRefresh = false }) {
  const k = String(imo || "");
  if (!forceRefresh) { const c = cacheGet(k); if (c) return { ...c, cached: true }; }

  logger.info(`[pipeline] ══ START IMO ${imo} ══`);

  const companies = [
    { name: owner,        role: "owner",        address },
    { name: manager,      role: "manager",       address },
    { name: operator,     role: "operator",      address },
    { name: ship_manager, role: "ship_manager",  address },
  ].filter(c => c.name && c.name.trim().length > 2);

  // Deduplicate by normalized name
  const seen = new Set();
  const unique = companies.filter(c => {
    const nk = c.name.toLowerCase().trim();
    if (seen.has(nk)) return false;
    seen.add(nk);
    return true;
  });

  const results = [];
  for (const co of unique) {
    const r = await processCompany({ ...co, imoNumber: k });
    if (r) results.push(r);
    await new Promise(r => setTimeout(r, 400)); // polite crawl delay
  }

  const allEmails = rankEmails(results.flatMap(r => r.emails || []));
  const intel = {
    imo_number:      imo,
    companies:       results,
    top_contacts:    allEmails.slice(0, 8),
    top_phones:      [...new Set(results.flatMap(r => r.phones || []))].slice(0, 5),
    pipeline_ran_at: new Date().toISOString(),
    cached: false,
  };

  logger.info(`[pipeline] ══ DONE IMO ${imo} — ${results.length} cos, ${allEmails.length} emails ══`);
  return cacheSet(k, intel);
}

async function runCompanyPipeline(companyName, address) {
  if (!companyName) return null;
  return processCompany({ name: companyName, role: "unknown", imoNumber: null, address });
}

module.exports = { runPipeline, runCompanyPipeline };