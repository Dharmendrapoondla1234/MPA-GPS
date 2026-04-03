// src/services/intelligence/engines/confidenceScorer.js — v2 (enhanced accuracy)
// Multi-signal confidence scoring with tighter calibration
"use strict";

const { CONFIDENCE_WEIGHTS, MIN_CONFIDENCE, MARITIME_ROLE_PREFIXES } = require("../../../config");
const logger = require("../../../utils/logger");

// ── Penalty patterns — reduce confidence for likely-wrong emails ──────────────
const PENALTY_PATTERNS = [
  { re: /^(test|demo|sample|example|placeholder)/i, penalty: 30, reason: "test prefix" },
  { re: /@(gmail|yahoo|hotmail|outlook|proton)\./i, penalty: 20, reason: "generic webmail" },
  { re: /\.(png|jpg|gif|svg|webp|pdf)$/i,           penalty: 40, reason: "image extension in domain" },
  { re: /^[a-z]{1,2}@/i,                            penalty: 15, reason: "very short prefix" },
];

// ── Bonus patterns — increase confidence for clearly professional emails ──────
const BONUS_PATTERNS = [
  { re: /^(ceo|cfo|coo|md|director|president|vp|gm)@/i,        bonus: 12, reason: "C-suite prefix" },
  { re: /^(chartering|charter|ops|operations|fleet)@/i,         bonus:  8, reason: "maritime ops prefix" },
  { re: /^(dpa|vetting|hse|sire|safety|compliance)@/i,          bonus: 10, reason: "maritime compliance prefix" },
  { re: /^[a-z]{2,15}\.[a-z]{2,15}@/i,                          bonus:  5, reason: "firstname.lastname pattern" },
];

/**
 * Score a single email item using all available signals.
 */
function scoreEmail(item, domain, scrapedList = [], domainConf = 0) {
  let   score  = item.confidence ?? 50;
  const email  = (item.email || "").toLowerCase();
  const source = item.source  || "";
  const prefix = email.split("@")[0] || "";
  const scrapedSet = new Set((scrapedList || []).map(e => e.email?.toLowerCase()));

  // Signal 1: found on official website (boosted)
  if (["website_mailto", "website_scraped", "pdf_extracted"].includes(source)) {
    const boost = source === "website_mailto" ? CONFIDENCE_WEIGHTS.officialWebsite + 5
                : source === "pdf_extracted"  ? CONFIDENCE_WEIGHTS.pdfExtracted
                : CONFIDENCE_WEIGHTS.officialWebsite;
    score += boost;
  }

  // Signal 2: SMTP validated (definitive signal)
  if (item.smtp_valid === true) {
    score += CONFIDENCE_WEIGHTS.smtpValidated;
  }

  // Signal 3: domain match (weighted by domain confidence)
  if (domain && email.endsWith(`@${domain}`)) {
    score += Math.round(domainConf * CONFIDENCE_WEIGHTS.domainMatch / 100);
  }

  // Signal 4: found in multiple sources
  if (scrapedSet.has(email) && source === "smtp_validated") {
    score += CONFIDENCE_WEIGHTS.multiSource;
  }

  // Signal 5: maritime role prefix
  if (MARITIME_ROLE_PREFIXES.has(prefix)) {
    score += CONFIDENCE_WEIGHTS.maritimeRole;
  }

  // Signal 6: name-inferred (firstname.lastname) pattern
  if (source === "name_inferred") {
    score += CONFIDENCE_WEIGHTS.nameInferred ?? 12;
  }

  // Signal 7: linkedin-sourced
  if (source === "linkedin") {
    score += CONFIDENCE_WEIGHTS.linkedinMatch ?? 10;
  }

  // ── Apply penalties ────────────────────────────────────────────────────────
  for (const { re, penalty, reason } of PENALTY_PATTERNS) {
    if (re.test(email)) {
      logger.debug(`[scorer] penalty -${penalty} (${reason}) on ${email}`);
      score -= penalty;
    }
  }

  // ── Apply bonuses ──────────────────────────────────────────────────────────
  for (const { re, bonus, reason } of BONUS_PATTERNS) {
    if (re.test(email)) {
      logger.debug(`[scorer] bonus +${bonus} (${reason}) on ${email}`);
      score += bonus;
    }
  }

  // ── Domain TLD quality signal ──────────────────────────────────────────────
  // Emails from country-code TLDs that match known maritime hubs get a small boost
  const emailDomain = email.split("@")[1] || "";
  const maritimeTLDs = [".gr",".no",".dk",".cy",".hk",".sg",".bm",".mt",".im"];
  if (maritimeTLDs.some(tld => emailDomain.endsWith(tld))) {
    score += 3;
  }

  return { ...item, confidence: Math.min(Math.max(Math.round(score), 0), 99) };
}

/**
 * Score all emails, filter by MIN_CONFIDENCE, return sorted list.
 * Enhancement: removes exact duplicate emails even with different sources.
 */
function applyConfidenceScoring(emails, domain, scrapedEmails = [], domainConf = 0) {
  const scored   = emails.map(e => scoreEmail(e, domain, scrapedEmails, domainConf));
  const filtered = scored.filter(e => e.confidence >= MIN_CONFIDENCE);

  // Deduplicate: keep highest confidence version of each email
  const byEmail = new Map();
  for (const e of filtered) {
    const key = (e.email || "").toLowerCase();
    const existing = byEmail.get(key);
    if (!existing || e.confidence > existing.confidence) {
      byEmail.set(key, e);
    }
  }

  const sorted = [...byEmail.values()].sort((a, b) => b.confidence - a.confidence);
  logger.debug(`[scorer] ${domain}: ${emails.length} in → ${sorted.length} passed threshold ${MIN_CONFIDENCE}`);
  return sorted;
}

/** Map domain discovery method to a base confidence value. */
function methodConfidence(method) {
  const map = {
    "known_table"                 : 98,
    "search+content_validated"    : 90,
    "ssl_cert+validated"          : 78,
    "whois+validated"             : 80,
    "heuristic+content_validated" : 75,
    "search+dns"                  : 65,
    "heuristic+dns"               : 45,
    "gemini_ai"                   : 70,  // NEW: calibrated Gemini confidence
    "unresolved"                  :  0,
  };
  return map[method] ?? 50;
}

module.exports = { scoreEmail, applyConfidenceScoring, methodConfidence };
