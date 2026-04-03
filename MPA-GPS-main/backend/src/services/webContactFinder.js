// backend/src/services/webContactFinder.js
// Finds shipping company contacts WITHOUT using Claude API.
// Uses: direct website scraping, WHOIS-like patterns, maritime directories.
"use strict";

const logger = require("../utils/logger");

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?\d[\d\s\-()\/.]{6,20}\d)/g;

// Known maritime company domain patterns
const KNOWN_COMPANY_DOMAINS = {
  "WILHELMSEN": "wilhelmsen.com",
  "GAC": "gac.com",
  "INCHCAPE": "iss-shipping.com",
  "PACIFIC BASIN": "pacificbasin.com",
  "MARAN": "maran.gr",
  "TSAKOS": "tng.gr",
  "THENAMARIS": "thenamaris.com",
  "DIANA SHIPPING": "dianashipping.gr",
  "NAVIOS": "navios-maritime.com",
  "COSTAMARE": "costamare.com",
  "SEASPAN": "seaspancorp.com",
  "EVERGREEN": "evergreen-marine.com",
  "COSCO": "cosco.com",
  "YANG MING": "yangming.com",
  "HMM": "hmm21.com",
  "HAPAG-LLOYD": "hapag-lloyd.com",
  "CMA CGM": "cmacgm.com",
  "MSC": "msc.com",
  "MAERSK": "maersk.com",
  "PIL": "pilship.com",
  "PACIFIC INTERNATIONAL LINES": "pilship.com",
  "BW GROUP": "bwgroup.com",
  "TEEKAY": "teekay.com",
  "FRONTLINE": "frontline.bm",
  "DHT": "dhtankers.com",
  "EURONAV": "euronav.com",
  "NORDIC AMERICAN": "nat.bm",
};

// Maritime directory base URLs for scraping
const MARITIME_DIRECTORIES = [
  "https://www.equasis.org",
  "https://www.marinetraffic.com",
  "https://www.vesselfinder.com",
  "https://www.fleetmon.com",
];

async function safeFetch(url, opts = {}, timeoutMs = 8000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (compatible; MaritimeResearch/1.0)",
      Accept: "text/html,application/json,*/*",
      ...opts.headers,
    };
    return await fetch(url, { ...opts, headers, signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Timeout: ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function extractEmails(text) {
  return [...new Set((text || "").match(EMAIL_RE) || [])].filter(e =>
    !e.includes("example") && !e.includes("yourdomain") &&
    !e.includes("@2x") && !e.includes(".png") && e.length < 80 &&
    !e.includes("sentry") && !e.includes("wix") && !e.includes("cdn")
  );
}
function extractPhones(text) {
  return [...new Set((text || "").match(PHONE_RE) || [])]
    .map(p => p.trim()).filter(p => p.replace(/\D/g, "").length >= 7 && p.replace(/\D/g, "").length <= 15);
}

/**
 * Try to find company domain based on known mappings or name heuristics.
 */
function guessCompanyDomain(companyName) {
  if (!companyName) return null;
  const upper = companyName.toUpperCase();
  for (const [key, domain] of Object.entries(KNOWN_COMPANY_DOMAINS)) {
    if (upper.includes(key)) return domain;
  }
  // Heuristic: clean company name → domain guess
  const cleaned = companyName
    .toLowerCase()
    .replace(/\b(ltd|plc|co|inc|corp|shipping|maritime|marine|group|holdings|management|services|line|lines|pte|bv|sa|ag|as|ab|oy)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
  if (cleaned.length >= 3) return `${cleaned}.com`;
  return null;
}

/**
 * Scrape a company's contact page for email/phone.
 */
async function scrapeCompanyWebsite(domain) {
  if (!domain) return null;
  const urls = [
    `https://${domain}/contact`,
    `https://${domain}/contact-us`,
    `https://www.${domain}/contact`,
    `https://${domain}`,
  ];
  for (const url of urls) {
    try {
      const res = await safeFetch(url, {}, 6000);
      if (!res.ok) continue;
      const html  = await res.text();
      const text  = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const emails  = extractEmails(text);
      const phones  = extractPhones(text);
      if (emails.length || phones.length) {
        logger.info(`[web-contact] ${domain}: email=${emails[0]||"—"} phone=${phones[0]||"—"}`);
        return {
          email:   emails[0] || null,
          email_secondary: emails[1] || null,
          phone:   phones[0] || null,
          website: `https://${domain}`,
          confidence: 0.75,
          source: "website_scrape",
        };
      }
    } catch (e) {
      logger.debug(`[web-contact] ${url}: ${e.message?.slice(0, 60)}`);
    }
  }
  return null;
}

/**
 * Search Google (no API key) using search result scraping.
 * Returns contact info for a shipping company.
 */
async function searchCompanyContacts(companyName, flag) {
  if (!companyName) return null;
  const country = flag ? ` ${flag}` : "";
  const query   = encodeURIComponent(`"${companyName}"${country} shipping contact email site`);

  try {
    const res = await safeFetch(
      `https://www.google.com/search?q=${query}&num=5`,
      { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } },
      8000
    );
    if (!res.ok) return null;
    const html   = await res.text();
    const text   = html.replace(/<[^>]+>/g, " ");
    const emails = extractEmails(text);
    const phones = extractPhones(text);

    // Extract domain from search results
    const domainMatch = html.match(/https?:\/\/([a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})\/[^"]*contact/);
    const domain      = domainMatch ? domainMatch[1].replace(/^www\./, "") : null;

    if (emails.length || domain) {
      logger.info(`[search] "${companyName}": email=${emails[0]||"—"} domain=${domain||"—"}`);
      return {
        email:    emails[0] || null,
        phone:    phones[0] || null,
        website:  domain ? `https://${domain}` : null,
        confidence: 0.60,
        source:   "web_search",
      };
    }
  } catch (e) {
    logger.debug(`[search] error: ${e.message?.slice(0, 60)}`);
  }
  return null;
}

/**
 * Main function: find company contacts without Claude API.
 * Strategy: known domains → website scrape → web search → domain guess + scrape
 */
async function findCompanyContactsWeb(companyName, flag) {
  if (!companyName) return null;
  logger.info(`[web-contact-finder] Searching for: "${companyName}"`);

  // 1. Check known company domains
  const knownDomain = guessCompanyDomain(companyName);
  if (knownDomain && !knownDomain.includes("com") === false) {
    // Only try if it's a real-looking domain (not a guess)
    const upper = companyName.toUpperCase();
    const isKnown = Object.keys(KNOWN_COMPANY_DOMAINS).some(k => upper.includes(k));
    if (isKnown) {
      const scraped = await scrapeCompanyWebsite(knownDomain);
      if (scraped) return scraped;
    }
  }

  // 2. Google search for contacts
  const searched = await searchCompanyContacts(companyName, flag);
  if (searched?.email) return searched;

  // 3. Try to scrape the website found
  if (searched?.website) {
    const domain = searched.website.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
    const scraped = await scrapeCompanyWebsite(domain);
    if (scraped) return { ...scraped, ...searched, ...scraped }; // merge
  }

  // 4. Fallback: try guessed domain
  if (knownDomain) {
    const scraped = await scrapeCompanyWebsite(knownDomain);
    if (scraped) return scraped;
  }

  return searched || null;
}

/**
 * Search MarineTraffic for vessel company info by IMO.
 */
async function searchMaritimeDBsForIMO(imo, vesselName) {
  const urls = [
    `https://www.marinetraffic.com/en/ais/details/ships/shipid:${imo}`,
    `https://www.vesselfinder.com/vessels/details/${imo}`,
    `https://www.fleetmon.com/vessels/vessel/${imo}/`,
  ];

  for (const url of urls) {
    try {
      const res = await safeFetch(url, {}, 7000);
      if (!res.ok) continue;
      const html = await res.text();
      const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

      // Extract owner patterns
      const ownerMatch = text.match(/(?:Owner|Registered Owner|Ship Owner)[:\s]+([A-Z][A-Za-z\s&.,'-]{3,60}?)(?:\s{2,}|<|\||,|\n)/);
      const managerMatch = text.match(/(?:Manager|Ship Manager|ISM Manager)[:\s]+([A-Z][A-Za-z\s&.,'-]{3,60}?)(?:\s{2,}|<|\||,|\n)/);
      const flagMatch = text.match(/(?:Flag|Flag State)[:\s]+([A-Z][A-Za-z\s]{2,30}?)(?:\s{2,}|<|\||,|\n)/);

      const ownerName = ownerMatch?.[1]?.trim();
      const managerName = managerMatch?.[1]?.trim();
      const flagState = flagMatch?.[1]?.trim();

      if (ownerName && ownerName.length > 3 && ownerName.length < 80) {
        logger.info(`[maritime-db] IMO ${imo}: owner="${ownerName}" from ${url}`);
        return {
          owner_name: ownerName,
          manager_name: managerName || null,
          flag: flagState || null,
          confidence: 0.70,
          source: url.includes("marinetraffic") ? "marinetraffic" :
                  url.includes("vesselfinder")  ? "vesselfinder"  : "fleetmon",
        };
      }
    } catch (e) {
      logger.debug(`[maritime-db] ${url}: ${e.message?.slice(0, 60)}`);
    }
  }
  return null;
}

module.exports = { findCompanyContactsWeb, searchMaritimeDBsForIMO, scrapeCompanyWebsite };
