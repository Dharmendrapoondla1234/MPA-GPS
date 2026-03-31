// src/services/intelligence/engines/websiteScraper.js
// Web Crawling Engine — crawl contact/about/offices pages + mine PDFs
// No Playwright needed — fetch + regex handles most shipping co sites
"use strict";

const logger = require("../../../utils/logger");
const { CRAWL_PATHS, HTTP_TIMEOUT_MS, USER_AGENT, EMAIL_BLACKLIST_RE } = require("../../../config");

const EMAIL_RE  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE  = /(?:\+?[\d()\-.\s]{7,20})/g;
const MAILTO_RE = /href=["']mailto:([^"'?\s]+)/gi;
const PDF_RE    = /href=["']([^"']+\.pdf[^"']*)/gi;

function cleanEmail(e) {
  e = e.toLowerCase().trim().split("?")[0];
  if (!e.includes("@") || e.length > 80) return null;
  if (!e.split("@")[1]?.includes(".")) return null;
  if (EMAIL_BLACKLIST_RE.test(e)) return null;
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
    .replace(/<[^>]+>/g, " ");
  const out = [];
  let m; EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(text)) !== null) {
    const e = cleanEmail(m[0]);
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
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

function extractAddresses(html) {
  const addrs = [];
  const re = /(?:address|location|office)[^<]{0,100}<[^>]+>([^<]{10,200})/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const addr = m[1].replace(/\s+/g, " ").trim();
    if (addr.length > 10 && /\d/.test(addr)) addrs.push(addr);
  }
  return addrs.slice(0, 3);
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

async function fetchPage(url, ms = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, "Accept": "text/html,*/*", "Accept-Language": "en-US,en;q=0.9" },
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
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { clearTimeout(t); return null; }
}

/**
 * Mine a PDF buffer for emails and phones using regex only.
 * (No pdfminer/PyMuPDF — we use pdfjs-dist or simple byte-level text extraction.)
 */
function minePdfBuffer(buf) {
  if (!buf) return { emails: [], phones: [] };
  // Convert buffer to string — PDFs store plain text in streams
  // We do a safe ASCII/UTF-8 extraction of stream text
  const raw    = buf.toString("latin1");
  // Extract text between "BT" and "ET" PDF text blocks, plus plain strings
  const chunks = [];
  const streamRe = /stream([\s\S]{0,50000}?)endstream/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) chunks.push(m[1]);
  const text = chunks.join(" ") + raw; // include full raw for inline text
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
 */
async function scrapeWebsite(domain) {
  if (!domain) return null;

  const emailMap  = new Map(); // email → { confidence, source }
  const phoneSet  = new Set();
  const addrList  = [];
  const pdfEmails = [];
  const pdfLinks  = [];
  let   pagesChecked = 0;

  for (const path of CRAWL_PATHS) {
    for (const scheme of ["https", "http"]) {
      const url  = `${scheme}://${domain}${path}`;
      const html = await fetchPage(url);
      if (!html) continue;
      pagesChecked++;

      const isContactPage = /contact|office|location/i.test(path);

      // Mailto: highest confidence
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
    if (emailMap.size >= 6) break;
  }

  // Mine PDFs found during crawl
  for (const pdfUrl of [...new Set(pdfLinks)].slice(0, 3)) {
    const buf = await fetchBinary(pdfUrl);
    if (!buf) continue;
    const mined = minePdfBuffer(buf);
    for (const e of mined.emails) {
      if (!emailMap.has(e)) {
        emailMap.set(e, { confidence: 68, source: "pdf_extracted" });
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
    .slice(0, 12);

  return {
    domain,
    emails,
    phones    : [...phoneSet].slice(0, 6),
    addresses : [...new Set(addrList)].slice(0, 3),
    pdfEmails,
    pagesChecked,
  };
}

module.exports = { scrapeWebsite };