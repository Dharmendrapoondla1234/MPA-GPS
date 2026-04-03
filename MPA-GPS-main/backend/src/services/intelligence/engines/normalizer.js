// src/services/intelligence/engines/normalizer.js
// Entity Normalization Engine — strips legal suffixes, builds domain slugs
"use strict";

const { LEGAL_SUFFIXES, DOMAIN_STRIP } = require("../../../config");

// Words that are part of the company identity — do NOT strip for domain slugs
const KEEP_WORDS = new Set([
  "sea","ocean","pacific","atlantic","aegean","arctic","nordic",
  "global","world","universal","national","eastern","western",
  "northern","southern","central","united","premier","first",
  "star","anchor","vessel","fleet","port",
]);

// Build suffix regexes once at startup.
// For dotted suffixes like "pte. ltd." we allow optional dots.
function _buildSuffixRe(suffix) {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\./g, "\\.?");
  return new RegExp(`[,.]?\\s*${escaped}\\.?\\s*$`, "i");
}

const SUFFIX_PATTERNS = LEGAL_SUFFIXES
  .slice()
  .sort((a, b) => b.length - a.length)   // longest first prevents partial strips
  .map(s => ({ re: _buildSuffixRe(s), suffix: s }));

/**
 * Normalize a company name.
 * Returns { original, normalized, tokens, slug, slugHyphen, slugFull, slugFullHyphen }
 * or null for empty input.
 */
function normalize(companyName) {
  if (!companyName || typeof companyName !== "string") return null;
  let name = companyName.toLowerCase().trim();
  if (name.length < 2) return null;

  // Strip legal suffixes (longest-first order)
  for (const { re } of SUFFIX_PATTERNS) {
    name = name.replace(re, "").trim();
  }

  // Remove structural punctuation
  name = name.replace(/[()[\]{}<>]/g, " ").replace(/[,;:!?@#$%^&*+=|~`"']/g, "").trim();
  name = name.replace(/\s+/g, " ");
  if (!name) return null;

  const tokens = name.split(/\s+/).filter(Boolean);

  // Domain slug: strip generic industry words unless in KEEP_WORDS
  const domainTokens = tokens.filter(t => !DOMAIN_STRIP.includes(t) || KEEP_WORDS.has(t));
  const slug            = domainTokens.join("").replace(/[^a-z0-9]/g, "");
  const slugHyphen      = domainTokens.join("-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const slugFull        = tokens.join("").replace(/[^a-z0-9]/g, "");
  const slugFullHyphen  = tokens.join("-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");

  return { original: companyName.trim(), normalized: name, tokens, slug, slugHyphen, slugFull, slugFullHyphen };
}

/** Generate all plausible domain candidates for a company name. */
function candidateDomains(companyName) {
  const n = normalize(companyName);
  if (!n) return [];

  const tlds   = ["com","net","org","co"];
  const cctlds = ["com.sg","co.uk","com.hk","com.cy","com.gr","com.no"];
  const all    = [...tlds, ...cctlds];

  const slugs = [...new Set([n.slug, n.slugHyphen, n.slugFull, n.slugFullHyphen].filter(s => s && s.length > 2))];
  const seen  = new Set();
  const out   = [];
  for (const s of slugs) {
    for (const tld of all) {
      const d = `${s}.${tld}`;
      if (d.length > 5 && d.length < 64 && !seen.has(d)) { seen.add(d); out.push(d); }
    }
  }
  return out;
}

/** Remove duplicate companies by normalized name (keeps first occurrence). */
function deduplicateCompanies(list) {
  const seen = new Set();
  return list.filter(c => {
    const n = normalize(c.name);
    if (!n) return false;
    if (seen.has(n.normalized)) return false;
    seen.add(n.normalized);
    return true;
  });
}

module.exports = { normalize, candidateDomains, deduplicateCompanies };