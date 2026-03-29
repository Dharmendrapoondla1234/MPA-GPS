// services/intelligence/domainResolver.js  v2
// Step 2: Intelligent Domain Discovery — multi-source, never guessing
// Sources: DuckDuckGo → Bing scrape → heuristic+DNS → HTTP title verify
"use strict";

const dns    = require("dns").promises;
const logger = require("../../utils/logger");
const { normalize, candidateDomains } = require("./normalizer");

const DOMAIN_BLACKLIST = new Set([
  "duckduckgo.com","bing.com","google.com","yahoo.com","wikipedia.org",
  "linkedin.com","facebook.com","twitter.com","bloomberg.com","reuters.com",
  "dnb.com","kompass.com","zoominfo.com","crunchbase.com",
  "companies-house.gov.uk","opencorporates.com",
  "marinetraffic.com","vesselfinder.com","fleetmon.com","equasis.org",
  "glassdoor.com","indeed.com","yellowpages.com","tradeindia.com",
  "alibaba.com","manta.com","hoovers.com",
]);
const DIRECTORY_RE = /yellowpages|\/directory|\/listing|bizfile|registrar|companieshouse|opencorporate|kompass|manta\.com/;

function isBlacklisted(d) {
  d = d.toLowerCase().replace(/^www\./, "");
  return DOMAIN_BLACKLIST.has(d) || DIRECTORY_RE.test(d);
}

async function dnsExists(domain) {
  try { await dns.lookup(domain); return true; } catch { return false; }
}

async function hasMxRecord(domain) {
  try { const mx = await dns.resolveMx(domain); return mx && mx.length > 0; } catch { return false; }
}

async function validateDomainContent(domain, tokens, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${domain}`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MaritimeBot/1.0)" },
      redirect: "follow",
    });
    clearTimeout(t);
    if (!res.ok) return { valid: false };
    const html  = await res.text();
    const lower = html.toLowerCase();
    const titleM = /<title[^>]*>([^<]{2,120})<\/title>/i.exec(html);
    const title  = titleM ? titleM[1].trim() : null;
    const significant = tokens.filter(tk => tk.length >= 4 && !["the","and","for","ltd","pte","pvt","ship"].includes(tk));
    const matches = significant.filter(tk => lower.includes(tk));
    const valid   = matches.length >= Math.min(2, Math.max(1, significant.length));
    return { valid, title, matches };
  } catch { clearTimeout(t); return { valid: false }; }
}

async function duckduckgoSearch(name, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const q   = encodeURIComponent(`"${name}" official website`);
    const res = await fetch(`https://api.duckduckgo.com/?q=${q}&format=json&no_redirect=1&no_html=1&skip_disambig=1`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MaritimeBot/1.0)" },
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const json = await res.json();
    const urls = [json?.AbstractURL, ...(json?.RelatedTopics||[]).map(x=>x?.FirstURL), ...(json?.Results||[]).map(x=>x?.FirstURL)].filter(Boolean);
    return [...new Set(urls.map(u => { try { return new URL(u).hostname.replace(/^www\./,""); } catch { return null; } }).filter(d => d && d.includes(".") && !isBlacklisted(d)))];
  } catch { clearTimeout(t); return []; }
}

async function bingSearch(name, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const q   = encodeURIComponent(`"${name}" shipping official website`);
    const res = await fetch(`https://www.bing.com/search?q=${q}&count=10`, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const html = await res.text();
    const domains = new Set();
    const citeRe = /<cite[^>]*>([^<]{4,80})<\/cite>/g;
    const hrefRe = /href="https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?:\/[^"]*)?"/gi;
    let m;
    while ((m = citeRe.exec(html)) !== null) {
      const d = m[1].replace(/^www\./,"").toLowerCase().split("/")[0].trim();
      if (d.includes(".") && !isBlacklisted(d)) domains.add(d);
    }
    while ((m = hrefRe.exec(html)) !== null) {
      const d = m[1].replace(/^www\./,"").toLowerCase();
      if (d.includes(".") && !isBlacklisted(d)) domains.add(d);
    }
    return [...domains].slice(0,8);
  } catch { clearTimeout(t); return []; }
}

async function resolveDomain(companyName) {
  if (!companyName) return null;
  const n = normalize(companyName);
  if (!n) return null;
  logger.info(`[domain-resolver] resolving: "${n.normalized}"`);

  // A: search candidates
  const [ddg, bing] = await Promise.allSettled([duckduckgoSearch(n.normalized), bingSearch(n.normalized)])
    .then(r => r.map(x => x.status === "fulfilled" ? x.value : []));
  const searchCandidates = [...new Set([...ddg, ...bing])];
  logger.info(`[domain-resolver] search candidates: ${searchCandidates.slice(0,5).join(", ")}`);

  for (const domain of searchCandidates.slice(0, 6)) {
    if (!await dnsExists(domain)) continue;
    const check = await validateDomainContent(domain, n.tokens);
    if (check.valid) return { domain, confidence: 90, method: "search+content_validated", title: check.title };
  }
  for (const domain of searchCandidates.slice(0, 4)) {
    if (await dnsExists(domain)) return { domain, confidence: 65, method: "search+dns", title: null };
  }

  // B: heuristic
  const heuristics = candidateDomains(companyName);
  logger.info(`[domain-resolver] heuristic candidates: ${heuristics.slice(0,5).join(", ")}`);
  for (const domain of heuristics.slice(0, 12)) {
    if (!await dnsExists(domain)) continue;
    const check = await validateDomainContent(domain, n.tokens);
    if (check.valid) return { domain, confidence: 75, method: "heuristic+content_validated", title: check.title };
  }
  for (const domain of heuristics.slice(0, 8)) {
    if (await dnsExists(domain)) return { domain, confidence: 45, method: "heuristic+dns", title: null };
  }

  logger.warn(`[domain-resolver] ✗ no domain for: "${companyName}"`);
  return null;
}

module.exports = { resolveDomain, dnsExists, hasMxRecord, isBlacklisted, validateDomainContent };