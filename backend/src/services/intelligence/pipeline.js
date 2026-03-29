// services/intelligence/pipeline.js
// Master orchestrator: Equasis data → domain → emails → scrape → store → serve
//
// Pipeline stages:
//  1. Receive {imo, owner, manager, operator} from Equasis (via contactEnricher)
//  2. For each company: resolve domain
//  3. Generate email patterns
//  4. Scrape website for real emails + phones
//  5. SMTP validate generated emails
//  6. Store everything in db.js
//  7. Return enriched intelligence object
"use strict";

const logger          = require("../../utils/logger");
const { resolveDomain }  = require("./domainResolver");
const { generateEmails, validateEmails, rankEmails } = require("./emailEngine");
const { scrapeWebsite }  = require("./websiteScraper");
const db              = require("./db");

// ── In-memory pipeline cache (per IMO, 6h TTL) ───────────────────
const pipelineCache = new Map();
const CACHE_TTL     = 6 * 60 * 60 * 1000;

function cacheGet(imo) {
  const h = pipelineCache.get(String(imo));
  return h && Date.now() - h.ts < CACHE_TTL ? h.data : null;
}
function cacheSet(imo, data) {
  pipelineCache.set(String(imo), { data, ts: Date.now() });
  return data;
}

// ── Process one company ───────────────────────────────────────────
async function processCompany({ name, role, imoNumber }) {
  if (!name || name.length < 3) return null;

  logger.info(`[pipeline] processing company: "${name}" (${role}) IMO ${imoNumber}`);

  // 1. Resolve domain
  const domainResult = await resolveDomain(name).catch(err => {
    logger.warn(`[pipeline] domain resolve error for "${name}": ${err.message}`);
    return null;
  });

  const domain = domainResult?.domain || null;

  // Persist company record
  const company = db.upsertCompany({ name, domain, imoNumber, role });

  const result = {
    company:          name,
    role,
    domain:           domain || null,
    domain_confidence: domainResult?.confidence || 0,
    domain_method:    domainResult?.method || "unresolved",
    emails:           [],
    phones:           [],
    people:           [],
    scraped:          false,
  };

  if (!domain) {
    logger.warn(`[pipeline] no domain found for "${name}" — skipping email steps`);
    return result;
  }

  // 2. Scrape website for real emails/phones (high confidence, do first)
  const scraped = await scrapeWebsite(domain).catch(err => {
    logger.warn(`[pipeline] scrape error for ${domain}: ${err.message?.slice(0, 80)}`);
    return null;
  });

  if (scraped?.emails?.length) {
    result.scraped = true;
    result.phones  = scraped.phones || [];
    for (const e of scraped.emails) {
      db.upsertContact({ companyId: company.id, email: e.email,
                         confidence: e.confidence, source: e.source });
      result.emails.push(e);
    }
    logger.info(`[pipeline] scraped ${scraped.emails.length} emails from ${domain}`);
  }

  // 3. Generate + SMTP-validate standard patterns
  //    Only validate prefixes not already found via scraping
  const foundEmails = new Set(result.emails.map(e => e.email.toLowerCase()));
  const generated   = generateEmails(domain)
    .filter(g => !foundEmails.has(g.email.toLowerCase()));

  // Run SMTP validation concurrently (max 6 at once to avoid timeouts)
  const BATCH = 6;
  const allValidated = [];
  for (let i = 0; i < generated.length; i += BATCH) {
    const batch = generated.slice(i, i + BATCH);
    const emails = batch.map(b => b.email);
    const validated = await validateEmails(emails, domain).catch(() => batch);
    allValidated.push(...validated);
  }

  for (const v of allValidated) {
    if (v.confidence >= 60 || v.smtp_valid) { // only include confirmed or high-conf
      db.upsertContact({ companyId: company.id, email: v.email,
                         confidence: v.confidence, source: v.source,
                         smtpValid: v.smtp_valid });
      result.emails.push({ email: v.email, confidence: v.confidence,
                           source: v.source, smtp_valid: v.smtp_valid });
    }
  }

  // 4. Rank and deduplicate
  result.emails = rankEmails(result.emails).slice(0, 10);

  logger.info(`[pipeline] "${name}": domain=${domain} emails=${result.emails.length}`);
  return result;
}

// ── Main pipeline entry point ─────────────────────────────────────
/**
 * Run the full intelligence pipeline for a vessel.
 *
 * @param {object} input
 *   imo       - IMO number
 *   owner     - registered owner name (from Equasis)
 *   manager   - ISM manager name
 *   operator  - operator name
 *   forceRefresh - bypass cache
 *
 * @returns {object} enriched intelligence
 */
async function runPipeline({ imo, owner, manager, operator, ship_manager, forceRefresh = false }) {
  const imoKey = String(imo || "");
  if (!forceRefresh) {
    const cached = cacheGet(imoKey);
    if (cached) {
      logger.debug(`[pipeline] cache hit IMO ${imo}`);
      return cached;
    }
  }

  logger.info(`[pipeline] ══ START IMO ${imo} ══`);

  const companies = [
    { name: owner,        role: "owner" },
    { name: manager,      role: "manager" },
    { name: operator,     role: "operator" },
    { name: ship_manager, role: "ship_manager" },
  ].filter(c => c.name && c.name.trim().length > 2);

  // Deduplicate — same company may appear in multiple roles
  const seen = new Set();
  const unique = companies.filter(c => {
    const key = c.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Process companies sequentially (avoids hammering same domain)
  const results = [];
  for (const co of unique) {
    const r = await processCompany({ ...co, imoNumber: imoKey });
    if (r) results.push(r);
    // Small delay between companies
    if (unique.indexOf(co) < unique.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Merge all emails across companies (deduplicated, ranked)
  const allEmails = rankEmails(results.flatMap(r => r.emails || []));

  const intelligence = {
    imo_number:  imo,
    companies:   results,
    // Convenience: merged top contacts regardless of which company
    top_contacts: allEmails.slice(0, 8),
    top_phones:  [...new Set(results.flatMap(r => r.phones || []))].slice(0, 5),
    pipeline_ran_at: new Date().toISOString(),
    cached: false,
  };

  logger.info(`[pipeline] ══ DONE IMO ${imo} — ${results.length} companies, ${allEmails.length} emails ══`);

  return cacheSet(imoKey, { ...intelligence, cached: false });
}

// ── Run pipeline for a company name alone (no IMO) ────────────────
async function runCompanyPipeline(companyName) {
  if (!companyName) return null;
  return processCompany({ name: companyName, role: "unknown", imoNumber: null });
}

module.exports = { runPipeline, runCompanyPipeline };