// services/intelligence/websiteScraper.js  v2
// Step 3: Deep website crawling — contact/about/offices/footer
// Extracts emails (mailto-first), phones, office locations
// No Playwright needed — fetch + regex is sufficient for shipping co sites
"use strict";

const logger = require("../../utils/logger");

const EMAIL_RE  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE  = /(?:\+?[\d()\-.\s]{7,20})/g;

// Crawl priority: contact pages > about > offices > footer via homepage
const CRAWL_PATHS = [
  "/contact", "/contact-us", "/contacts", "/contact.html", "/contact-us.html",
  "/en/contact", "/en/contact-us", "/en/contacts",
  "/about/contact", "/about-us/contact", "/our-offices", "/offices",
  "/global-offices", "/locations", "/office",
  "/about", "/about-us", "/company/contact",
  "/",
];

// Known junk email patterns to filter out
const EMAIL_BLACKLIST = /example|yourdomain|sentry|noreply|no-reply|unsubscribe|webmaster@|postmaster@|abuse@|\.png|\.jpg|\.gif|@2x|@3x/i;

function cleanPhone(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  // Skip sequences that look like dates/years/IPs
  if (/^(19|20)\d{2}$/.test(digits)) return null;
  return raw.trim();
}

function extractMailtoEmails(html) {
  const emails = [];
  const re = /href=["']mailto:([^"'?\s]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const e = m[1].trim().toLowerCase().split("?")[0];
    if (e.includes("@") && e.length < 80 && !EMAIL_BLACKLIST.test(e)) emails.push(e);
  }
  return [...new Set(emails)];
}

function extractBodyEmails(html) {
  const text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
                   .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
                   .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return [...new Set((text.match(EMAIL_RE) || []))]
    .map(e => e.toLowerCase())
    .filter(e => !EMAIL_BLACKLIST.test(e) && e.length < 80 && e.includes("."));
}

function extractPhones(html) {
  const text = html.replace(/<[^>]+>/g, " ");
  return [...new Set((text.match(PHONE_RE) || []).map(cleanPhone).filter(Boolean))];
}

// Extract office addresses from common patterns
function extractAddresses(html) {
  const addresses = [];
  // Look for address-like blocks near "office" or "contact" headings
  const addrRe = /(?:address|location|office)[^<]{0,100}<[^>]+>([^<]{10,200})/gi;
  let m;
  while ((m = addrRe.exec(html)) !== null) {
    const addr = m[1].trim().replace(/\s+/g, " ");
    if (addr.length > 10 && /\d/.test(addr)) addresses.push(addr);
  }
  return addresses.slice(0, 3);
}

async function fetchPage(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
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

/**
 * Scrape a domain across multiple pages.
 * Returns { emails:[{email,confidence,source}], phones:[], addresses:[], domain, pages_checked }
 */
async function scrapeWebsite(domain) {
  if (!domain) return null;

  const emailMap = new Map();  // email → {confidence, source}
  const phoneSet = new Set();
  const addrList = [];
  let pagesChecked = 0;

  for (const path of CRAWL_PATHS) {
    for (const scheme of ["https", "http"]) {
      const url = `${scheme}://${domain}${path}`;
      const html = await fetchPage(url);
      if (!html) continue;
      pagesChecked++;

      // mailto: hrefs — highest confidence (90+)
      for (const e of extractMailtoEmails(html)) {
        if (!emailMap.has(e)) {
          // Boost confidence if on a contact-specific page
          const conf = path.includes("contact") || path.includes("office") ? 92 : 88;
          emailMap.set(e, { confidence: conf, source: "website_mailto" });
        }
      }

      // Body text emails (75–80)
      for (const e of extractBodyEmails(html)) {
        if (!emailMap.has(e)) {
          const conf = path.includes("contact") ? 78 : 72;
          emailMap.set(e, { confidence: conf, source: "website_scraped" });
        }
      }

      for (const p of extractPhones(html)) phoneSet.add(p);
      if (path !== "/") addrList.push(...extractAddresses(html));

      // Stop early once we have enough from contact page
      if (emailMap.size >= 4 && (path.includes("contact") || path.includes("office"))) break;
    }
    if (emailMap.size >= 6) break;
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
    phones: [...phoneSet].slice(0, 6),
    addresses: [...new Set(addrList)].slice(0, 3),
    pages_checked: pagesChecked,
  };
}

module.exports = { scrapeWebsite };