// services/intelligence/domainResolver.js
// Converts shipping company names → validated domains
// Strategy: search-based discovery → heuristic fallback → DNS validation
"use strict";

const dns  = require("dns").promises;
const logger = require("../../utils/logger");

// ── Heuristic domain generation ───────────────────────────────────
// Strips legal suffixes, normalises spaces/punctuation → candidate domains
const LEGAL_SUFFIXES = [
  "pte ltd", "pte. ltd.", "private limited", "pvt ltd", "pvt. ltd.",
  "limited", "ltd", "llc", "l.l.c", "inc", "incorporated", "corp",
  "corporation", "co ltd", "co. ltd.", "gmbh", "b.v.", "bv", "nv",
  "s.a.", "sa", "spa", "plc", "pty ltd", "sdn bhd", "sdn. bhd.",
  "ag", "kg", "oy", "ab", "as", "a/s", "shipping", "maritime",
  "marine", "management", "mgmt", "international", "intl",
];

function heuristicDomains(companyName) {
  if (!companyName) return [];
  let name = companyName.toLowerCase().trim();

  // Remove legal suffixes (longest first to avoid partial stripping)
  const sorted = [...LEGAL_SUFFIXES].sort((a, b) => b.length - a.length);
  for (const s of sorted) {
    const re = new RegExp(`\\b${s.replace(/\./g, "\\.")}\\b`, "g");
    name = name.replace(re, "").trim();
  }

  // Clean to alphanumeric + hyphens
  const slug = name
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "")       // no-space version: eternalalphamarine.com
    .replace(/-+/g, "-");

  const slugHyphen = name
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-");     // hyphenated version: eternal-alpha-marine.com

  const tlds = ["com", "net", "org"];
  const candidates = new Set();
  for (const tld of tlds) {
    if (slug)       candidates.add(`${slug}.${tld}`);
    if (slugHyphen) candidates.add(`${slugHyphen}.${tld}`);
  }
  return [...candidates].filter(d => d.length > 5 && d.length < 60);
}

// ── Google search-based discovery ────────────────────────────────
// Uses DuckDuckGo instant answers API (no key needed)
async function searchDomain(companyName) {
  if (!companyName) return null;
  try {
    const q = encodeURIComponent(`"${companyName}" shipping official website`);
    const url = `https://api.duckduckgo.com/?q=${q}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MaritimeBot/1.0)" },
    }).finally(() => clearTimeout(t));

    if (!res.ok) return null;
    const json = await res.json();

    // AbstractURL or RelatedTopics often contain the official site
    const abstractUrl = json?.AbstractURL || json?.Official?.AbstractURL || "";
    const related = (json?.RelatedTopics || [])
      .map(t => t.FirstURL || "")
      .filter(Boolean);

    const allUrls = [abstractUrl, ...related].filter(Boolean);
    for (const u of allUrls) {
      try {
        const hostname = new URL(u).hostname.replace(/^www\./, "");
        if (hostname && !hostname.includes("duckduckgo") && hostname.includes(".")) {
          logger.info(`[domain-resolver] DDG found: ${companyName} → ${hostname}`);
          return hostname;
        }
      } catch { /* skip malformed */ }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      logger.warn(`[domain-resolver] DDG search error: ${err.message?.slice(0, 80)}`);
    }
  }
  return null;
}

// ── DNS validation ────────────────────────────────────────────────
async function validateDomain(domain) {
  if (!domain) return false;
  try {
    await dns.lookup(domain);
    return true;
  } catch {
    return false;
  }
}

// ── HTTP reachability check ────────────────────────────────────────
async function reachable(domain) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://${domain}`, {
      method: "HEAD",
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
    }).finally(() => clearTimeout(t));
    return res.status < 500;
  } catch {
    try {
      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), 6000);
      const res2 = await fetch(`http://${domain}`, {
        method: "HEAD",
        signal: ctrl2.signal,
        headers: { "User-Agent": "Mozilla/5.0" },
        redirect: "follow",
      }).finally(() => clearTimeout(t2));
      return res2.status < 500;
    } catch { return false; }
  }
}

// ── Main export ───────────────────────────────────────────────────
/**
 * Resolve company name → validated domain
 * Returns { domain, confidence, method } or null
 */
async function resolveDomain(companyName) {
  if (!companyName) return null;

  // 1. Search-based discovery
  const searched = await searchDomain(companyName);
  if (searched) {
    const valid = await validateDomain(searched);
    if (valid) {
      return { domain: searched, confidence: 85, method: "search+dns" };
    }
  }

  // 2. Heuristic generation + DNS validation
  const candidates = heuristicDomains(companyName);
  for (const candidate of candidates) {
    const valid = await validateDomain(candidate);
    if (valid) {
      logger.info(`[domain-resolver] heuristic match: ${companyName} → ${candidate}`);
      return { domain: candidate, confidence: 60, method: "heuristic+dns" };
    }
  }

  // 3. Last resort: search result without DNS confirmation
  if (searched) {
    return { domain: searched, confidence: 40, method: "search_unvalidated" };
  }

  logger.warn(`[domain-resolver] could not resolve domain for: ${companyName}`);
  return null;
}

module.exports = { resolveDomain, heuristicDomains, validateDomain, reachable };