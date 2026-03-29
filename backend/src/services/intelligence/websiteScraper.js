// services/intelligence/websiteScraper.js
// Crawls company websites to extract contact info without Playwright dependency
// Uses lightweight fetch + regex — Playwright optional for JS-heavy sites
"use strict";

const logger = require("../../utils/logger");

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?[\d\s\-(). ]{7,20})/g;

// Pages to try on every domain, in priority order
const CONTACT_PATHS = [
  "/contact",
  "/contact-us",
  "/contacts",
  "/contact.html",
  "/contact-us.html",
  "/en/contact",
  "/en/contact-us",
  "/about/contact",
  "/about-us",
  "/",
];

function cleanPhone(raw) {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? raw.trim() : null;
}

function extractFromHtml(html) {
  const text   = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const emails = [...new Set((text.match(EMAIL_RE) || []))]
    .filter(e => !e.includes("example") && !e.includes("yourdomain")
               && !e.includes(".png") && !e.includes(".jpg")
               && !e.includes("@2x") && e.length < 80);
  const phones = [...new Set((text.match(PHONE_RE) || []))]
    .map(cleanPhone)
    .filter(Boolean);
  return { emails, phones };
}

// Also try to find emails in mailto: hrefs (more reliable)
function extractMailtoEmails(html) {
  const results = [];
  const re = /href=["']mailto:([^"'?\s]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const email = m[1].trim().toLowerCase();
    if (email.includes("@") && !email.includes("example") && email.length < 80) {
      results.push(email);
    }
  }
  return [...new Set(results)];
}

async function fetchPage(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal:  ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("html") && !ct.includes("text")) return null;
    return await res.text();
  } catch {
    clearTimeout(t);
    return null;
  }
}

/**
 * Scrape a domain for contact info.
 * Returns { emails: [{email, confidence, source}], phones: string[], domain }
 */
async function scrapeWebsite(domain) {
  if (!domain) return null;

  const allEmails = new Map(); // email → {confidence, source}
  const allPhones = new Set();
  let pagesChecked = 0;

  for (const path of CONTACT_PATHS) {
    for (const scheme of ["https", "http"]) {
      const url = `${scheme}://${domain}${path}`;
      const html = await fetchPage(url);
      if (!html) continue;

      pagesChecked++;

      // Mailto hrefs are most reliable (confidence 90)
      const mailtoEmails = extractMailtoEmails(html);
      for (const e of mailtoEmails) {
        if (!allEmails.has(e)) {
          allEmails.set(e, { confidence: 90, source: "website_mailto" });
        }
      }

      // Body text extraction (confidence 75)
      const { emails: bodyEmails, phones } = extractFromHtml(html);
      for (const e of bodyEmails) {
        if (!allEmails.has(e)) {
          allEmails.set(e, { confidence: 75, source: "website_scraped" });
        }
      }
      for (const p of phones) allPhones.add(p);

      // Stop after finding emails on a contact page
      if (allEmails.size > 0 && path.includes("contact")) break;
    }
    if (allEmails.size >= 5) break; // enough results
  }

  logger.info(`[scraper] ${domain}: ${allEmails.size} emails, ${allPhones.size} phones from ${pagesChecked} pages`);

  if (allEmails.size === 0 && allPhones.size === 0) return null;

  const emails = [...allEmails.entries()]
    .map(([email, meta]) => ({ email, ...meta }))
    .sort((a, b) => b.confidence - a.confidence);

  return {
    domain,
    emails,
    phones: [...allPhones].slice(0, 5),
    pages_checked: pagesChecked,
  };
}

module.exports = { scrapeWebsite };