// services/intelligence/normalizer.js
// Step 1: Normalize company names before domain/email discovery
// Removes legal suffixes, standardises spacing, generates slug variants
"use strict";

// Ordered longest → shortest to avoid partial strips
const LEGAL_SUFFIXES = [
  "private limited", "pte. ltd.", "pte ltd", "pvt. ltd.", "pvt ltd",
  "sdn. bhd.", "sdn bhd", "co. ltd.", "co ltd", "l.l.c.", "l.l.c",
  "incorporated", "corporation", "co-operative", "cooperative",
  "limited liability company", "limited partnership",
  "limited", "ltd.", "ltd", "llc", "inc.", "inc", "corp.", "corp",
  "gmbh & co. kg", "gmbh & co kg", "gmbh", "b.v.", "bv", "n.v.", "nv",
  "s.a.s.", "s.a.s", "s.a.", "sa", "s.p.a.", "spa", "s.r.l.", "srl",
  "plc", "pty. ltd.", "pty ltd", "ag", "kg", "oy", "ab", "as", "a/s",
  "a.s.", "s.c.", "k.g.", "o.ö.",
];

// Words that are part of the company identity — do NOT strip
const KEEP_WORDS = new Set([
  "sea", "ocean", "pacific", "atlantic", "aegean", "arctic", "nordic",
  "global", "world", "universal", "national", "eastern", "western",
  "northern", "southern", "central", "united", "premier", "first",
  "star", "anchor", "vessel", "fleet", "port",
]);

// Generic industry words that inflate uniqueness — strip for domain slug only
const DOMAIN_STRIP = [
  "shipping", "maritime", "marine", "navigation", "navigazione",
  "management", "mgmt", "services", "service", "solutions",
  "international", "intl", "group", "holdings", "enterprises",
  "trading", "logistics", "transport", "agency",
];

/**
 * Normalize a company name for matching and slug generation.
 * Returns { normalized, slug, slugHyphen, tokens }
 */
function normalize(companyName) {
  if (!companyName) return null;

  let name = companyName.toLowerCase().trim();

  // Remove legal suffixes
  for (const suffix of LEGAL_SUFFIXES) {
    // Match at end of string or before punctuation
    const re = new RegExp(`[,.]?\\s*\\b${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b\\.?\\s*$`, "i");
    name = name.replace(re, "").trim();
  }

  // Remove punctuation except hyphens and apostrophes in names
  name = name.replace(/[()[\]{}<>]/g, " ").replace(/[,;:!?@#$%^&*+=|~`"]/g, "").trim();
  name = name.replace(/\s+/g, " ");

  const tokens = name.split(/\s+/).filter(t => t.length > 0);

  // Slug for domain: strip generic industry words too
  const domainTokens = tokens.filter(t => !DOMAIN_STRIP.includes(t) || KEEP_WORDS.has(t));
  const slug        = domainTokens.join("").replace(/[^a-z0-9]/g, "");
  const slugHyphen  = domainTokens.join("-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const slugFull    = tokens.join("").replace(/[^a-z0-9]/g, "");

  return {
    normalized: name,
    original:   companyName.trim(),
    tokens,
    slug,           // "bernhardschulte"
    slugHyphen,     // "bernhard-schulte"
    slugFull,       // includes generic words too: "bernhardschulteshipmanagement"
    slugFullHyphen: tokens.join("-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-"),
  };
}

/**
 * Generate all candidate domains from a company name
 */
function candidateDomains(companyName) {
  const n = normalize(companyName);
  if (!n) return [];

  const tlds    = ["com", "net", "org", "co"];
  const cctlds  = ["com.sg", "co.uk", "com.hk", "com.cy"]; // shipping hubs
  const allTlds = [...tlds, ...cctlds];

  const slugs = new Set([n.slug, n.slugHyphen, n.slugFull, n.slugFullHyphen].filter(s => s && s.length > 2));
  const candidates = [];
  for (const s of slugs) {
    for (const tld of allTlds) {
      const d = `${s}.${tld}`;
      if (d.length > 5 && d.length < 64) candidates.push(d);
    }
  }
  return [...new Set(candidates)];
}

module.exports = { normalize, candidateDomains };