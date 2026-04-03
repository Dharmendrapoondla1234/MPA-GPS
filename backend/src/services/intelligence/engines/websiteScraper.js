// src/services/intelligence/engines/websiteScraper.js — v2 (enhanced accuracy)
// Web Crawling Engine — multi-page crawl with JSON-LD, vCard, sitemap parsing
// Enhancements: JSON-LD extraction, structured data mining, sitemap traversal,
//               encoding-aware HTML parsing, better address extraction
"use strict";

const logger = require("../../../utils/logger");
const { CRAWL_PATHS, HTTP_TIMEOUT_MS, USER_AGENTS, USER_AGENT, EMAIL_BLACKLIST_RE } = require("../../../config");

const EMAIL_RE  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE  = /(?:\+?[\d()\-.\s]{7,20})/g;
const MAILTO_RE = /href=["']mailto:([^"'?\s]+)/gi;
const PDF_RE    = /href=["']([^"']+\.pdf[^"']*)/gi;

// NEW: Schema.org JSON-LD extraction
const JSONLD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// User-agent rotation helper
let _uaIdx = 0;
function getUA() {
  const agents = USER_AGENTS || [USER_AGENT];
  return agents[_uaIdx++ % agents.length];
}

function cleanEmail(e) {
  e = e.toLowerCase().trim().split("?")[0];
  if (!e.includes("@") || e.length > 80) return null;
  if (!e.split("@")[1]?.includes(".")) return null;
  if (EMAIL_BLACKLIST_RE.test(e)) return null;
  // NEW: reject emails that are clearly image filenames or template placeholders
  if (/\.(png|jpg|gif|svg|webp)$/i.test(e)) return null;
  if (/^(your|name|email|user)@/i.test(e)) return null;
  return e;
}

function cleanPhone(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (/^(19|20)\d{2}$/.test(digits)) return null; // skip years
  return raw.trim();
}

function extractMailtoEmails(html) {
  const found = [];
  let m; MAILTO_RE.lastIndex = 0;
  while ((m = MAILTO_RE.exec(html)) !== null) {
    const e = cleanEmail(m[1]);
    if (e && !found.includes(e)) found.push(e);
  }
  return found;
}

function extractBodyEmails(html) {
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  const out = [];
  let m; EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(text)) !== null) {
    const e = cleanEmail(m[0]);
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

// NEW: Extract emails from JSON-LD structured data (most reliable source)
function extractJsonLdEmails(html) {
  const emails = [];
  let m; JSONLD_RE.lastIndex = 0;
  while ((m = JSONLD_RE.exec(html)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      const findEmails = (o) => {
        if (!o || typeof o !== "object") return;
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === "string" && (k === "email" || k === "contactPoint")) {
            const e = cleanEmail(v);
            if (e) emails.push({ email: e, confidence: 93, source: "jsonld_schema" });
          } else if (Array.isArray(v)) {
            v.forEach(findEmails);
          } else if (typeof v === "object") {
            findEmails(v);
          }
        }
      };
      findEmails(obj);
    } catch { /* invalid JSON, skip */ }
  }
  return emails;
}

// NEW: Extract emails from vCard data embedded in pages
function extractVcardEmails(html) {
  const emails = [];
  const emailRe = /EMAIL[^:\n]*:([^\r\n]+)/gi;
  let m;
  while ((m = emailRe.exec(html)) !== null) {
    const e = cleanEmail(m[1].trim());
    if (e) emails.push({ email: e, confidence: 88, source: "vcard" });
  }
  return emails;
}

function extractPhones(html) {
  const text = html.replace(/<[^>]+>/g, " ");
  const out  = new Set();
  let m; PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(text)) !== null) {
    const p = cleanPhone(m[0]);
    if (p) out.add(p);
  }
  return [...out];
}

// ENHANCED: Better address extraction using multiple patterns
function extractAddresses(html) {
  const addrs = [];
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  // Pattern 1: labeled with address keywords
  const re1 = /(?:address|location|office|head(?:quarters|office))[^<]{0,50}:?\s*([A-Z][^<\n]{15,200})/gi;
  let m;
  while ((m = re1.exec(text)) !== null) {
    const addr = m[1].replace(/\s+/g, " ").trim();
    if (addr.length > 15 && /\d/.test(addr)) addrs.push(addr);
  }

  // Pattern 2: JSON-LD address objects
  JSONLD_RE.lastIndex = 0;
  while ((m = JSONLD_RE.exec(html)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      const addr = obj?.address || obj?.location?.address || null;
      if (addr && typeof addr === "string" && addr.length > 5) addrs.push(addr);
      else if (addr && typeof addr === "object") {
        const parts = [addr.streetAddress, addr.addressLocality, addr.addressCountry].filter(Boolean);
        if (parts.length >= 2) addrs.push(parts.join(", "));
      }
    } catch {}
  }

  return [...new Set(addrs)].slice(0, 4);
}

function extractPdfLinks(html, baseUrl) {
  const links = [];
  let m; PDF_RE.lastIndex = 0;
  while ((m = PDF_RE.exec(html)) !== null) {
    try {
      const full = new URL(m[1], baseUrl).href;
      if (!links.includes(full)) links.push(full);
    } catch { /* skip malformed */ }
  }
  return links.slice(0, 5);
}

// NEW: Parse XML sitemap to find relevant contact/about pages
async function parseSitemap(domain) {
  const contactPagePaths = [];
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://${domain}/sitemap.xml`, {
      signal: ctrl.signal,
      headers: { "User-Agent": getUA() },
    });
    if (!res?.ok) return [];
    const xml = await res.text();
    const urlRe = /<loc>([^<]+)<\/loc>/g;
    let m;
    while ((m = urlRe.exec(xml)) !== null) {
      const url = m[1].trim();
      if (/contact|about|office|location|reach/i.test(url)) {
        contactPagePaths.push(url);
      }
    }
  } catch {}
  return contactPagePaths.slice(0, 5);
}

async function fetchPage(url, ms = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent"      : getUA(),
        "Accept"          : "text/html,*/*",
        "Accept-Language" : "en-US,en;q=0.9",
        "Accept-Encoding" : "gzip, deflate",
      },
      redirect: "follow",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("html") && !ct.includes("text")) return null;
    const text = await res.text();
    return text.length > 200 ? text : null;
  } catch { clearTimeout(t); return null; }
}

async function fetchBinary(url, ms = 15_000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": getUA() },
      redirect: "follow",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { clearTimeout(t); return null; }
}

function minePdfBuffer(buf) {
  if (!buf) return { emails: [], phones: [] };
  const raw    = buf.toString("latin1");
  const chunks = [];
  const streamRe = /stream([\s\S]{0,50000}?)endstream/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) chunks.push(m[1]);
  const text = chunks.join(" ") + raw;
  const emails = []; const phones = [];
  let em;
  EMAIL_RE.lastIndex = 0;
  while ((em = EMAIL_RE.exec(text)) !== null) {
    const e = cleanEmail(em[0]);
    if (e && !emails.includes(e)) emails.push(e);
  }
  PHONE_RE.lastIndex = 0;
  while ((em = PHONE_RE.exec(text)) !== null) {
    const p = cleanPhone(em[0]);
    if (p && !phones.includes(p)) phones.push(p);
  }
  return { emails: emails.slice(0, 10), phones: phones.slice(0, 5) };
}

/**
 * Scrape a company domain across multiple pages.
 * Returns { domain, emails:[{email,confidence,source}], phones, addresses, pdfEmails, pagesChecked }
 * or null if nothing found.
 * Enhancement: JSON-LD extraction, sitemap traversal, vCard mining, UA rotation.
 */
async function scrapeWebsite(domain) {
  if (!domain) return null;

  const emailMap  = new Map(); // email → { confidence, source }
  const phoneSet  = new Set();
  const addrList  = [];
  const pdfEmails = [];
  const pdfLinks  = [];
  let   pagesChecked = 0;

  // NEW: First try sitemap to discover contact pages not in our CRAWL_PATHS
  const sitemapPages = await parseSitemap(domain);
  const allPaths = [...CRAWL_PATHS];

  // Inject sitemap-discovered URLs at the front (these are high-value)
  const extraUrls = sitemapPages.filter(u => {
    try { return new URL(u).hostname.replace(/^www\./, "") === domain; } catch { return false; }
  });

  for (const path of allPaths) {
    // Skip sitemap.xml path during normal crawl (already parsed above)
    if (path === "/sitemap.xml") continue;

    for (const scheme of ["https", "http"]) {
      const url  = `${scheme}://${domain}${path}`;
      const html = await fetchPage(url);
      if (!html) continue;
      pagesChecked++;

      const isContactPage = /contact|office|location|reach/i.test(path);

      // NEW: JSON-LD extraction (highest confidence)
      for (const item of extractJsonLdEmails(html)) {
        if (!emailMap.has(item.email)) emailMap.set(item.email, { confidence: item.confidence, source: item.source });
      }

      // NEW: vCard extraction
      for (const item of extractVcardEmails(html)) {
        if (!emailMap.has(item.email)) emailMap.set(item.email, { confidence: item.confidence, source: item.source });
      }

      // Mailto: highest confidence among scraped
      for (const e of extractMailtoEmails(html)) {
        if (!emailMap.has(e)) {
          emailMap.set(e, { confidence: isContactPage ? 92 : 88, source: "website_mailto" });
        }
      }

      // Body emails
      for (const e of extractBodyEmails(html)) {
        if (!emailMap.has(e)) {
          emailMap.set(e, { confidence: isContactPage ? 78 : 72, source: "website_scraped" });
        }
      }

      extractPhones(html).forEach(p => phoneSet.add(p));
      if (path !== "/") addrList.push(...extractAddresses(html));
      pdfLinks.push(...extractPdfLinks(html, url));

      if (emailMap.size >= 4 && isContactPage) break;
    }
    if (emailMap.size >= 8) break; // increased threshold from 6
  }

  // Crawl sitemap-discovered contact pages (extra coverage)
  for (const pageUrl of extraUrls.slice(0, 4)) {
    const html = await fetchPage(pageUrl);
    if (!html) continue;
    pagesChecked++;

    for (const item of extractJsonLdEmails(html)) {
      if (!emailMap.has(item.email)) emailMap.set(item.email, { confidence: item.confidence, source: item.source });
    }
    for (const e of extractMailtoEmails(html)) {
      if (!emailMap.has(e)) emailMap.set(e, { confidence: 90, source: "website_mailto" });
    }
    for (const e of extractBodyEmails(html)) {
      if (!emailMap.has(e)) emailMap.set(e, { confidence: 76, source: "website_scraped" });
    }
  }

  // Mine PDFs found during crawl
  for (const pdfUrl of [...new Set(pdfLinks)].slice(0, 4)) { // increased from 3 to 4
    const buf = await fetchBinary(pdfUrl);
    if (!buf) continue;
    const mined = minePdfBuffer(buf);
    for (const e of mined.emails) {
      if (!emailMap.has(e)) {
        emailMap.set(e, { confidence: 70, source: "pdf_extracted" }); // was 68
        pdfEmails.push(e);
      }
    }
    mined.phones.forEach(p => phoneSet.add(p));
    logger.debug(`[scraper] PDF ${pdfUrl}: ${mined.emails.length} emails`);
  }

  logger.info(`[scraper] ${domain}: ${emailMap.size} emails, ${phoneSet.size} phones, ${pagesChecked} pages`);

  if (emailMap.size === 0 && phoneSet.size === 0) return null;

  const emails = [...emailMap.entries()]
    .map(([email, meta]) => ({ email, ...meta }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 15); // increased from 12

  return {
    domain,
    emails,
    phones    : [...phoneSet].slice(0, 8), // increased from 6
    addresses : [...new Set(addrList)].slice(0, 4), // increased from 3
    pdfEmails,
    pagesChecked,
  };
}

module.exports = { scrapeWebsite };
