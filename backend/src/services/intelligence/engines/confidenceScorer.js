// src/services/intelligence/engines/confidenceScorer.js
// Confidence Scoring + Cross-Validation Engine
// Applies multi-signal scoring and filters contacts below MIN_CONFIDENCE
"use strict";

const { CONFIDENCE_WEIGHTS, MIN_CONFIDENCE, MARITIME_ROLE_PREFIXES } = require("../../../config");
const logger = require("../../../utils/logger");

/**
 * Score a single email item using all available signals.
 *
 * @param {object} item          - { email, confidence, source, smtp_valid, ... }
 * @param {string} domain        - official company domain
 * @param {object[]} scrapedList - emails found directly on the website
 * @param {number} domainConf    - domain discovery confidence (0–100)
 */
function scoreEmail(item, domain, scrapedList = [], domainConf = 0) {
  let   score  = item.confidence ?? 50;
  const email  = (item.email || "").toLowerCase();
  const source = item.source  || "";
  const scrapedSet = new Set((scrapedList || []).map(e => e.email?.toLowerCase()));

  // Signal 1: found on official website
  if (["website_mailto", "website_scraped", "pdf_extracted"].includes(source)) {
    score += CONFIDENCE_WEIGHTS.officialWebsite;
  }
  // Signal 2: SMTP validated
  if (item.smtp_valid === true) {
    score += CONFIDENCE_WEIGHTS.smtpValidated;
  }
  // Signal 3: domain match
  if (domain && email.endsWith(`@${domain}`)) {
    score += Math.round(domainConf * CONFIDENCE_WEIGHTS.domainMatch / 100);
  }
  // Signal 4: found in multiple sources
  if (scrapedSet.has(email) && source === "smtp_validated") {
    score += CONFIDENCE_WEIGHTS.multiSource;
  }
  // Signal 5: maritime role prefix
  const prefix = email.split("@")[0] || "";
  if (MARITIME_ROLE_PREFIXES.has(prefix)) {
    score += CONFIDENCE_WEIGHTS.maritimeRole;
  }

  return { ...item, confidence: Math.min(Math.round(score), 99) };
}

/**
 * Score all emails, filter by MIN_CONFIDENCE, return sorted list.
 */
function applyConfidenceScoring(emails, domain, scrapedEmails = [], domainConf = 0) {
  const scored   = emails.map(e => scoreEmail(e, domain, scrapedEmails, domainConf));
  const filtered = scored.filter(e => e.confidence >= MIN_CONFIDENCE);
  const sorted   = filtered.sort((a, b) => b.confidence - a.confidence);
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
    "unresolved"                  :  0,
  };
  return map[method] ?? 50;
}

module.exports = { scoreEmail, applyConfidenceScoring, methodConfidence };