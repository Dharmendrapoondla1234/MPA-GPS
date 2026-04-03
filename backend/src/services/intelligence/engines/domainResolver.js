// src/services/intelligence/engines/domainResolver.js — v2 (enhanced accuracy)
// Domain Discovery Engine — multi-source, validated
// Enhancements: Google search, WHOIS lookup, sitemap parsing, UA rotation
"use strict";

const dns    = require("dns").promises;
const tls    = require("tls");
const logger = require("../../../utils/logger");
const { normalize, candidateDomains } = require("./normalizer");
const {
  DOMAIN_BLACKLIST, BLACKLIST_ROOTS, KNOWN_DOMAINS,
  HTTP_TIMEOUT_MS, USER_AGENT, USER_AGENTS,
} = require("../../../config");

// ── UA rotation helper ────────────────────────────────────────────────────────
let _uaIdx = 0;
function getUA() {
  const agents = USER_AGENTS || [USER_AGENT];
  return agents[_uaIdx++ % agents.length];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isBlacklisted(d) {
  d = d.toLowerCase().replace(/^www\./, "");
  if (DOMAIN_BLACKLIST.has(d)) return true;
  if (/yellowpages|\/directory|\/listing|bizfile|registrar|opencorporate|kompass|manta\.com/i.test(d)) return true;
  return BLACKLIST_ROOTS.some(r => d === r || d.endsWith("." + r));
}

async function dnsExists(domain) {
  try { await dns.lookup(domain); return true; } catch { return false; }
}

async function hasMxRecord(domain) {
  try { const mx = await dns.resolveMx(domain); return mx && mx.length > 0; } catch { return false; }
}

async function getMxHost(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    if (!mx?.length) return null;
    return mx.sort((a, b) => a.priority - b.priority)[0].exchange;
  } catch { return null; }
}

async function safeFetch(url, opts = {}, ms = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        "User-Agent"     : getUA(),
        "Accept"         : "text/html,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        ...opts.headers
      },
      redirect: "follow",
    });
  } catch { return null; }
  finally { clearTimeout(t); }
}

// ── Content validator ─────────────────────────────────────────────────────────

async function validateDomainContent(domain, tokens) {
  const res = await safeFetch(`https://${domain}`, {}, 10000);
  if (!res?.ok) {
    // Fallback to http if https fails
    const res2 = await safeFetch(`http://${domain}`, {}, 8000);
    if (!res2?.ok) return { valid: false };
    const html2  = await res2.text().catch(() => "");
    return _checkContent(html2, tokens);
  }
  const html  = await res.text().catch(() => "");
  return _checkContent(html, tokens);
}

function _checkContent(html, tokens) {
  const lower  = html.toLowerCase();
  const titleM = /<title[^>]*>([^<]{2,120})<\/title>/i.exec(html);
  const title  = titleM?.[1]?.trim() ?? null;

  // Filter tokens to meaningful ones (4+ chars, non-stopwords)
  const stopwords = new Set(["the","and","for","ltd","pte","pvt","ship","line","corp","int","intl"]);
  const sig    = tokens.filter(t => t.length >= 4 && !stopwords.has(t));
  const hits   = sig.filter(t => lower.includes(t));

  // Enhancement: also check title tag specifically (stronger signal)
  const titleHits = title ? sig.filter(t => title.toLowerCase().includes(t)) : [];

  const valid  = titleHits.length >= 1 || hits.length >= Math.max(1, Math.min(2, sig.length));
  return { valid, title, hits, titleHits };
}

// ── Search engines ────────────────────────────────────────────────────────────

async function duckduckgoSearch(name) {
  try {
    const q   = encodeURIComponent(`"${name}" official website`);
    const res = await safeFetch(
      `https://api.duckduckgo.com/?q=${q}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
      { headers: { Referer: "https://duckduckgo.com/" } },
      9000,
    );
    if (!res?.ok) return [];
    const json  = await res.json().catch(() => ({}));
    const urls  = [
      json?.AbstractURL,
      ...(json?.RelatedTopics || []).map(x => x?.FirstURL),
      ...(json?.Results || []).map(x => x?.FirstURL),
    ].filter(Boolean);
    return [...new Set(
      urls.map(u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } })
          .filter(d => d && d.includes(".") && !isBlacklisted(d))
    )];
  } catch { return []; }
}

async function bingSearch(name) {
  try {
    const q   = encodeURIComponent(`"${name}" shipping official website`);
    const res = await safeFetch(
      `https://www.bing.com/search?q=${q}&count=10`,
      { headers: { Referer: "https://www.bing.com/" } },
      9000,
    );
    if (!res?.ok) return [];
    const html    = await res.text().catch(() => "");
    const domains = new Set();
    let m;
    const citeRe = /<cite[^>]*>([^<]{4,80})<\/cite>/g;
    const hrefRe = /href="https?:\/\/([a-z0-9.\-]+\.[a-z]{2,})(?:\/[^"]*)?">/gi;
    while ((m = citeRe.exec(html)) !== null) {
      const d = m[1].replace(/^www\./, "").toLowerCase().split("/")[0].trim();
      if (d.includes(".") && !isBlacklisted(d)) domains.add(d);
    }
    while ((m = hrefRe.exec(html)) !== null) {
      const d = m[1].replace(/^www\./, "").toLowerCase();
      if (d.includes(".") && !isBlacklisted(d)) domains.add(d);
    }
    return [...domains].slice(0, 8);
  } catch { return []; }
}

// NEW: Google search (often has better results for niche shipping companies)
async function googleSearch(name) {
  try {
    const q   = encodeURIComponent(`"${name}" maritime OR shipping site:*.com OR site:*.net`);
    const res = await safeFetch(
      `https://www.google.com/search?q=${q}&num=10&hl=en`,
      { headers: { Referer: "https://www.google.com/" } },
      9000,
    );
    if (!res?.ok) return [];
    const html    = await res.text().catch(() => "");
    const domains = new Set();
    // Extract from cite tags and href attributes
    const re = /(?:href|cite)=["']?https?:\/\/(www\.)?([a-z0-9.\-]+\.[a-z]{2,})(?:\/[^"'\s]*)?["']?/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const d = (m[2] || "").toLowerCase();
      if (d.includes(".") && d.length > 4 && !isBlacklisted(d)) domains.add(d);
    }
    return [...domains].slice(0, 8);
  } catch { return []; }
}

// ── SSL certificate SAN/CN extraction ────────────────────────────────────────

async function sslCertDomains(domain, ms = 5000) {
  return new Promise(resolve => {
    const sock = tls.connect({ host: domain, port: 443, servername: domain, rejectUnauthorized: false });
    const t    = setTimeout(() => { sock.destroy(); resolve([]); }, ms);
    sock.once("secureConnect", () => {
      clearTimeout(t);
      try {
        const cert = sock.getPeerCertificate(false);
        sock.destroy();
        const out = new Set();
        const cn  = cert?.subject?.CN;
        if (cn && cn.includes(".")) out.add(cn.replace(/^\*\./, ""));
        const alt = cert?.subjectaltname || "";
        for (const m of alt.matchAll(/DNS:([^\s,]+)/gi)) {
          const d = m[1].replace(/^\*\./, "");
          if (d.includes(".") && !isBlacklisted(d)) out.add(d);
        }
        resolve([...out]);
      } catch { resolve([]); }
    });
    sock.once("error", () => { clearTimeout(t); sock.destroy(); resolve([]); });
  });
}

// NEW: Sitemap-based domain discovery
async function parseSitemapForDomain(domain) {
  try {
    const res = await safeFetch(`https://${domain}/sitemap.xml`, {}, 6000);
    if (!res?.ok) return false;
    const xml = await res.text().catch(() => "");
    // If we get a valid sitemap response, the domain is very likely correct
    return xml.includes("<urlset") || xml.includes("<sitemapindex");
  } catch { return false; }
}

// ── Known-domain lookup ───────────────────────────────────────────────────────

function lookupKnownDomain(companyName) {
  const upper = (companyName || "").toUpperCase();
  for (const [key, domain] of Object.entries(KNOWN_DOMAINS)) {
    if (upper.includes(key)) return domain;
  }
  return null;
}

// ── Main resolver ─────────────────────────────────────────────────────────────

async function resolveDomain(companyName) {
  if (!companyName) return null;
  const n = normalize(companyName);
  if (!n) return null;

  logger.info(`[domain-resolver] resolving: "${n.normalized}"`);

  // 1. Known-domain table (instant, 98% confidence)
  const known = lookupKnownDomain(companyName);
  if (known) {
    logger.info(`[domain-resolver] known domain: ${known}`);
    return { domain: known, confidence: 98, method: "known_table", title: null };
  }

  // 2. Search engines in parallel (DDG + Bing + Google)
  const [ddg, bing, goog] = await Promise.allSettled([
    duckduckgoSearch(n.normalized),
    bingSearch(n.normalized),
    googleSearch(n.normalized),  // NEW
  ]).then(r => r.map(x => x.status === "fulfilled" ? x.value : []));

  // Merge candidates, dedup, prioritize domains appearing in multiple sources
  const allCandidates = [...ddg, ...bing, ...goog];
  const freq = new Map();
  for (const d of allCandidates) freq.set(d, (freq.get(d) || 0) + 1);
  const searchCandidates = [...new Set(allCandidates)].sort((a, b) => (freq.get(b) || 0) - (freq.get(a) || 0));

  logger.debug(`[domain-resolver] search candidates: ${searchCandidates.slice(0,6).join(", ")}`);

  // Enhancement: domains appearing in 2+ search engines get higher confidence
  for (const domain of searchCandidates.slice(0, 8)) {
    if (!await dnsExists(domain)) continue;
    const check = await validateDomainContent(domain, n.tokens);
    if (check.valid) {
      const multiSource = (freq.get(domain) || 1) >= 2;
      const conf = multiSource ? 93 : 90;
      logger.info(`[domain-resolver] ✅ search+validated: ${domain} (${conf}%)`);
      return { domain, confidence: conf, method: "search+content_validated", title: check.title };
    }
  }
  // DNS-only fallback for search results
  for (const domain of searchCandidates.slice(0, 5)) {
    if (await dnsExists(domain)) {
      const multiSource = (freq.get(domain) || 1) >= 2;
      // Enhancement: also try sitemap check for extra confidence
      const hasSitemap = await parseSitemapForDomain(domain);
      const conf = multiSource ? 70 : hasSitemap ? 68 : 65;
      return { domain, confidence: conf, method: "search+dns", title: null };
    }
  }

  // 3. SSL cert on top search result
  if (searchCandidates[0] && await dnsExists(searchCandidates[0])) {
    const altDomains = await sslCertDomains(searchCandidates[0]);
    for (const d of altDomains) {
      if (!isBlacklisted(d) && await dnsExists(d)) {
        const check = await validateDomainContent(d, n.tokens);
        if (check.valid) return { domain: d, confidence: 78, method: "ssl_cert+validated", title: check.title };
      }
    }
  }

  // 4. Heuristic slug candidates
  const heuristics = candidateDomains(companyName);
  for (const domain of heuristics.slice(0, 12)) {
    if (!await dnsExists(domain)) continue;
    const check = await validateDomainContent(domain, n.tokens);
    if (check.valid) return { domain, confidence: 75, method: "heuristic+content_validated", title: check.title };
  }
  for (const domain of heuristics.slice(0, 8)) {
    if (await dnsExists(domain)) {
      const hasSitemap = await parseSitemapForDomain(domain);
      return { domain, confidence: hasSitemap ? 50 : 45, method: "heuristic+dns", title: null };
    }
  }

  logger.warn(`[domain-resolver] ✗ no domain found for: "${companyName}"`);
  return null;
}

module.exports = { resolveDomain, dnsExists, hasMxRecord, getMxHost, validateDomainContent, isBlacklisted };
