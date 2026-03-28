// backend/src/services/contactEnricher.js — MPA AI Contact Enricher v2
//
// ═══════════════════════════════════════════════════════════════════════
// CONTACT ENRICHMENT PIPELINE (runs automatically for any arriving vessel)
//
// STEP 1 ─ Equasis  (free, best source — IMO-verified owner/manager)
//   • Login with your free Equasis account (set EQUASIS_EMAIL + EQUASIS_PASSWORD in .env)
//   • Gets: registered owner, ISM manager, ship manager, registered address
//   • Confidence: 0.90 (official, IMO-backed data)
//
// STEP 2 ─ AI Web Search via Claude (uses Anthropic API)
//   • Takes company name from Step 1 and uses Claude to search the web
//   • Gets: company website, email, phone, LinkedIn, contact page
//   • Confidence: 0.75 (AI-verified from live web)
//
// STEP 3 ─ Company Website Scrape
//   • Scrapes the company's own "Contact Us" page for email/phone
//   • Confidence: 0.85 (direct from source)
//
// STEP 4 ─ Google Custom Search (free tier: 100/day)
//   • Searches "[company name] maritime contact email"
//   • Extracts email from result snippets
//   • Confidence: 0.65
//
// STEP 5 ─ VesselFinder fallback
//   • Gets company name if all above fail
//   • Confidence: 0.40
//
// Results are written to BigQuery and cached for 30 days.
// ═══════════════════════════════════════════════════════════════════════

"use strict";
require("dotenv").config();
const { BigQuery }  = require("@google-cloud/bigquery");
const Anthropic     = require("@anthropic-ai/sdk");
const logger        = require("../utils/logger");

const PROJECT    = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET    = process.env.BIGQUERY_DATASET    || "MPA";
const BQ_LOCATION= process.env.BIGQUERY_LOCATION   || "asia-southeast1";

// ── Clients ───────────────────────────────────────────────────────
let bq;
const _creds = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (_creds?.trim().startsWith("{")) {
  try { const c=JSON.parse(_creds); bq=new BigQuery({credentials:c,projectId:c.project_id||PROJECT,location:BQ_LOCATION}); }
  catch { bq=new BigQuery({projectId:PROJECT,location:BQ_LOCATION}); }
} else {
  bq = new BigQuery({projectId:PROJECT,location:BQ_LOCATION});
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── In-memory cache (30 days — contact data rarely changes) ───────
const enrichCache = new Map();
const CACHE_TTL   = 30 * 24 * 60 * 60 * 1000; // 30 days
function cacheGet(k) { const h=enrichCache.get(k); return h&&Date.now()-h.ts<CACHE_TTL?h.data:null; }
function cacheSet(k,d) { enrichCache.set(k,{data:d,ts:Date.now()}); return d; }

// ── Email regex ───────────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?[\d\s\-().]{7,20})/g;

function extractEmails(text) {
  return [...new Set((text||"").match(EMAIL_RE)||[])].filter(e=>
    !e.includes("example") && !e.includes("yourdomain") && e.length<80
  );
}
function extractPhones(text) {
  return [...new Set((text||"").match(PHONE_RE)||[])]
    .map(p=>p.trim())
    .filter(p=>p.replace(/\D/g,"").length>=7);
}

// ═════════════════════════════════════════════════════════════════
// STEP 1: EQUASIS  (free, most accurate for maritime)
// Register free at https://www.equasis.org
// Set EQUASIS_EMAIL and EQUASIS_PASSWORD in .env
// ═════════════════════════════════════════════════════════════════
let _equasisCookies = null;
let _equasisCookieTs = 0;
const EQUASIS_COOKIE_TTL = 4 * 60 * 60 * 1000; // re-login every 4h

async function equasisLogin() {
  if (_equasisCookies && Date.now() - _equasisCookieTs < EQUASIS_COOKIE_TTL) {
    return _equasisCookies;
  }
  const email    = process.env.EQUASIS_EMAIL;
  const password = process.env.EQUASIS_PASSWORD;
  if (!email || !password) {
    logger.warn("[equasis] EQUASIS_EMAIL or EQUASIS_PASSWORD not set — skipping Equasis enrichment");
    return null;
  }
  try {
    // Step A: get the login page to capture session cookie
    const loginPageRes = await fetch("https://www.equasis.org/EquasisWeb/public/HomePage", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/2.0)" },
    });
    const cookies = loginPageRes.headers.get("set-cookie") || "";

    // Step B: POST login credentials
    const loginRes = await fetch("https://www.equasis.org/EquasisWeb/authen/HomePage?fs=Search", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookies,
        "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/2.0)",
        "Referer": "https://www.equasis.org/EquasisWeb/public/HomePage",
      },
      body: new URLSearchParams({ j_email: email, j_password: password, submit: "Login" }),
      redirect: "manual",
    });

    // Successful login gives a 302 redirect and a session cookie
    const sessionCookie = loginRes.headers.get("set-cookie") || cookies;
    if (sessionCookie && (loginRes.status === 302 || loginRes.status === 200)) {
      _equasisCookies  = sessionCookie;
      _equasisCookieTs = Date.now();
      logger.info("[equasis] ✅ Login successful");
      return sessionCookie;
    }
    logger.warn("[equasis] Login returned unexpected status:", loginRes.status);
    return null;
  } catch (err) {
    logger.warn("[equasis] Login failed:", err.message);
    return null;
  }
}

async function fetchFromEquasis(imo) {
  const cookies = await equasisLogin();
  if (!cookies) return null;
  try {
    const res = await fetch(
      `https://www.equasis.org/EquasisWeb/authen/ShipInfo?fs=Search&P_IMO=${imo}`,
      {
        headers: {
          "Cookie": cookies,
          "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/2.0)",
          "Referer": "https://www.equasis.org/EquasisWeb/authen/HomePage?fs=Search",
        },
      }
    );
    if (!res.ok) return null;
    const html = await res.text();

    // Parse company name + address from Equasis HTML
    // Equasis shows owner in a table row with label "Registered owner"
    const ownerMatch   = html.match(/Registered owner[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,100})</i);
    const managerMatch = html.match(/ISM[^<]*[Mm]anager[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,100})</i);
    const shipMgrMatch = html.match(/Ship manager[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,100})</i);
    const addressMatch = html.match(/Address[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{5,200})</i);

    const owner   = ownerMatch?.[1]?.trim();
    const manager = managerMatch?.[1]?.trim();
    const shipMgr = shipMgrMatch?.[1]?.trim();
    const address = addressMatch?.[1]?.replace(/<[^>]+>/g,"").trim();

    if (!owner && !manager) return null;

    logger.info(`[equasis] ✅ IMO ${imo}: owner="${owner}" manager="${manager}"`);
    return {
      owner_name:   owner   || null,
      manager_name: manager || null,
      ship_manager: shipMgr || null,
      address:      address || null,
      source:       "equasis",
      confidence:   0.90,
    };
  } catch (err) {
    logger.warn("[equasis] fetch error:", err.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 2: AI WEB SEARCH via Claude
// Uses Claude to search the web for company contact details
// ═════════════════════════════════════════════════════════════════
async function aiSearchCompanyContacts(companyName, country) {
  if (!companyName) return null;
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn("[ai-search] ANTHROPIC_API_KEY not set — skipping AI enrichment");
    return null;
  }

  try {
    const prompt = `You are a maritime data researcher. Find the official contact information for this shipping company:

Company: "${companyName}"${country ? `\nCountry: ${country}` : ""}

Search the web and return ONLY a JSON object (no explanation) with these fields:
{
  "website": "https://...",
  "email": "ops@company.com",
  "email_ops": "operations@company.com or null",
  "phone": "+1234567890",
  "phone_alt": "alternative phone or null",
  "address": "full registered address or null",
  "linkedin": "LinkedIn URL or null",
  "confidence": 0.0 to 1.0
}

Rules:
- Only return REAL, verified contact info you find from their official website or reliable directories
- For email: prefer ops@, operations@, info@, or contact@ addresses
- If you cannot find verified email/phone, set those fields to null
- Do NOT invent data. Return null for anything you cannot verify.
- confidence: 0.9 if from official website, 0.7 if from directory, 0.5 if uncertain`;

    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 500,
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
      }],
      messages: [{ role: "user", content: prompt }],
    });

    // Extract the text response (after tool use)
    const textBlock = response.content.find(b => b.type === "text");
    if (!textBlock?.text) return null;

    // Parse JSON from response
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const data = JSON.parse(jsonMatch[0]);
    logger.info(`[ai-search] ✅ "${companyName}": email=${data.email} phone=${data.phone} conf=${data.confidence}`);
    return { ...data, source: "ai_web_search" };
  } catch (err) {
    logger.warn("[ai-search] error:", err.message?.slice(0, 80));
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 3: Scrape company's own Contact page
// ═════════════════════════════════════════════════════════════════
async function scrapeContactPage(websiteUrl) {
  if (!websiteUrl) return null;
  try {
    const base    = new URL(websiteUrl).origin;
    const tryUrls = [
      `${base}/contact`,
      `${base}/contact-us`,
      `${base}/about/contact`,
      `${base}/en/contact`,
      websiteUrl,
    ];

    for (const url of tryUrls) {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/2.0)" },
          signal: ctrl.signal,
        }).finally(() => clearTimeout(timeout));

        if (!res.ok) continue;
        const html  = await res.text();
        // Strip tags for cleaner extraction
        const text  = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        const emails = extractEmails(text);
        const phones = extractPhones(text);

        if (emails.length || phones.length) {
          logger.info(`[scrape] ✅ ${url}: emails=${emails.slice(0,2)} phones=${phones.slice(0,1)}`);
          return {
            email:     emails[0] || null,
            email_ops: emails[1] || null,
            phone:     phones[0] || null,
            source:    "website_scrape",
            confidence:0.85,
          };
        }
      } catch { /* try next URL */ }
    }
    return null;
  } catch (err) {
    logger.warn("[scrape] error:", err.message?.slice(0, 60));
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 4: Google Custom Search API (100 free calls/day)
// Set GOOGLE_CSE_KEY and GOOGLE_CSE_CX in .env
// Get free at: console.cloud.google.com → Custom Search JSON API
// ═════════════════════════════════════════════════════════════════
async function googleSearchContacts(companyName) {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx  = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) return null;
  try {
    const q   = encodeURIComponent(`"${companyName}" shipping contact email`);
    const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${q}&num=5`;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const res  = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();

    const allText = (json.items || [])
      .map(i => `${i.title} ${i.snippet} ${i.link}`)
      .join(" ");

    const emails = extractEmails(allText);
    const phones = extractPhones(allText);

    if (!emails.length) return null;
    logger.info(`[google-cse] ✅ "${companyName}": email=${emails[0]}`);
    return {
      email:      emails[0] || null,
      phone:      phones[0] || null,
      source:     "google_cse",
      confidence: 0.65,
    };
  } catch (err) {
    logger.warn("[google-cse] error:", err.message?.slice(0, 60));
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 5: VesselFinder fallback (company name only)
// ═════════════════════════════════════════════════════════════════
async function vesselFinderFallback(imo) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(
      `https://www.vesselfinder.com/api/pub/vesselDetails?imo=${imo}`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const name = json?.AIS?.DESTINATION || json?.vessel?.manager || null;
    return name ? { owner_name: name, source: "vesselfinder", confidence: 0.40 } : null;
  } catch { return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEP 6: Write enriched data to BigQuery
// ═════════════════════════════════════════════════════════════════
async function saveToFirestore(imo, data) {
  // Non-fatal: skip silently if BQ contact tables don't exist yet
  try {
    const now = new Date().toISOString();
    const ds  = bq.dataset(DATASET);

    // Verify tables exist before inserting
    try { await ds.table("d_shipping_companies").getMetadata(); }
    catch { logger.warn(`[bq-save] d_shipping_companies table not found — skipping save for IMO ${imo}`); return; }

    // Upsert company record
    if (data.owner_name || data.email) {
      const companyId = `enriched_${imo}_owner`;
      await ds.table("d_shipping_companies").insert([{
        company_id:    companyId,
        company_name:  data.owner_name    || null,
        company_type:  "OWNER",
        primary_email: data.email         || null,
        secondary_email: data.email_ops   || null,
        phone_primary: data.phone         || null,
        website:       data.website       || null,
        registered_address: data.address  || null,
        data_source:   data.source        || "enriched",
        last_verified_at: now,
        created_at:    now,
        updated_at:    now,
      }], { skipInvalidRows: true });

      await ds.table("d_vessel_company_map").insert([{
        imo_number:        imo,
        owner_company_id:  companyId,
        data_source:       data.source || "enriched",
        last_verified_at:  now,
        created_at:        now,
        updated_at:        now,
      }], { skipInvalidRows: true });
    }

    // Write manager if found
    if (data.manager_name) {
      const mgrId = `enriched_${imo}_manager`;
      await ds.table("d_shipping_companies").insert([{
        company_id:    mgrId,
        company_name:  data.manager_name,
        company_type:  "MANAGER",
        data_source:   "equasis",
        last_verified_at: now,
        created_at:    now,
        updated_at:    now,
      }], { skipInvalidRows: true });
    }

    // Audit log
    await ds.table("d_contact_audit_log").insert([{
      log_id:       `log_${imo}_${Date.now()}`,
      imo_number:   imo,
      field_changed: "full_enrichment",
      new_value:    JSON.stringify({ email: data.email, phone: data.phone, source: data.source }),
      changed_by:   "contact_enricher_v2",
      change_source: data.source,
      changed_at:   now,
    }], { skipInvalidRows: true });

    logger.info(`[bq-save] ✅ IMO ${imo} saved (source: ${data.source})`);
  } catch (err) {
    logger.warn("[bq-save] write error (non-fatal):", err.message?.slice(0, 80));
  }
}

// ═════════════════════════════════════════════════════════════════
// MAIN: enrichVesselContact
// Call this with any vessel IMO to run the full pipeline
// ═════════════════════════════════════════════════════════════════
async function enrichVesselContact(imo, { vesselName, flag } = {}) {
  if (!imo) return null;
  const cacheKey = `enrich_${imo}`;
  const cached   = cacheGet(cacheKey);
  if (cached) {
    logger.debug(`[enricher] cache hit for IMO ${imo}`);
    return cached;
  }

  logger.info(`[enricher] Starting pipeline for IMO ${imo} (${vesselName || "unknown"})`);
  const result = { imo_number: imo, vessel_name: vesselName, flag };

  // ── STEP 1: Equasis ──────────────────────────────────────────
  const equasisData = await fetchFromEquasis(imo);
  if (equasisData) {
    result.owner_name   = equasisData.owner_name;
    result.manager_name = equasisData.manager_name;
    result.ship_manager = equasisData.ship_manager;
    result.address      = equasisData.address;
    result.source       = "equasis";
    result.confidence   = equasisData.confidence;
  }

  // ── STEP 2: AI search for email/phone ────────────────────────
  // Use vessel name as fallback search term if no company name from Equasis
  const companyName = result.owner_name || result.manager_name || vesselName;
  if (companyName) {
    const aiData = await aiSearchCompanyContacts(companyName, flag);
    if (aiData) {
      result.website    = result.website    || aiData.website;
      result.email      = result.email      || aiData.email;
      result.email_ops  = result.email_ops  || aiData.email_ops;
      result.phone      = result.phone      || aiData.phone;
      result.phone_alt  = result.phone_alt  || aiData.phone_alt;
      result.address    = result.address    || aiData.address;
      result.linkedin   = result.linkedin   || aiData.linkedin;
      // Keep higher confidence
      result.confidence = Math.max(result.confidence || 0, (aiData.confidence || 0) * 0.9);
      result.source     = result.source ? `${result.source}+ai_search` : "ai_search";
    }
  }

  // ── STEP 3: Scrape company website ───────────────────────────
  if (result.website && (!result.email || !result.phone)) {
    const scrapeData = await scrapeContactPage(result.website);
    if (scrapeData) {
      result.email     = result.email     || scrapeData.email;
      result.email_ops = result.email_ops || scrapeData.email_ops;
      result.phone     = result.phone     || scrapeData.phone;
      result.source    = `${result.source || ""}+scrape`.replace(/^\+/, "");
    }
  }

  // ── STEP 4: Google CSE ───────────────────────────────────────
  if (companyName && !result.email) {
    const gData = await googleSearchContacts(companyName);
    if (gData) {
      result.email      = gData.email;
      result.phone      = result.phone || gData.phone;
      result.confidence = result.confidence || gData.confidence;
      result.source     = `${result.source || ""}+google_cse`.replace(/^\+/, "");
    }
  }

  // ── STEP 5: VesselFinder fallback ────────────────────────────
  if (!result.owner_name && !result.manager_name) {
    const vfData = await vesselFinderFallback(imo);
    if (vfData) {
      result.owner_name = vfData.owner_name;
      result.confidence = vfData.confidence;
      result.source     = "vesselfinder";
    }
  }

  // ── STEP 6: Save to BigQuery ─────────────────────────────────
  if (result.owner_name || result.email) {
    saveToFirestore(imo, result); // fire-and-forget
  }

  const final = {
    imo_number:    imo,
    vessel_name:   vesselName,
    owner: {
      company_name:  result.owner_name   || null,
      company_type:  "OWNER",
      primary_email: result.email        || null,
      secondary_email: result.email_ops  || null,
      phone_primary: result.phone        || null,
      phone_secondary: result.phone_alt  || null,
      website:       result.website      || null,
      registered_address: result.address || null,
      linkedin:      result.linkedin     || null,
      data_source:   result.source       || null,
    },
    manager: result.manager_name ? {
      company_name: result.manager_name,
      company_type: "MANAGER",
      data_source:  "equasis",
    } : null,
    ship_manager: result.ship_manager ? {
      company_name: result.ship_manager,
      company_type: "SHIP_MANAGER",
      data_source:  "equasis",
    } : null,
    port_agents: [],
    enrichment: {
      source:      result.source     || "none",
      // FIX: if data was found but confidence is 0, set a minimum of 0.4
      confidence:  result.confidence || (result.owner_name || result.email ? 0.4 : 0),
      enriched_at: new Date().toISOString(),
    },
  };

  return cacheSet(cacheKey, final);
}

// ═════════════════════════════════════════════════════════════════
// BATCH ENRICHMENT — call for all recent arrivals
// Run this as a scheduled job (e.g. every hour via cron/Cloud Scheduler)
// ═════════════════════════════════════════════════════════════════
async function batchEnrichArrivals(limit = 20) {
  logger.info(`[batch] Starting batch enrichment (limit=${limit})`);
  try {
    // Get recent arrivals that don't yet have contact data
    const [rows] = await bq.query({
      query: `
        SELECT DISTINCT a.imo_number, a.vessel_name, v.flag
        FROM \`${PROJECT}.${DATASET}.f_vessel_arrivals\` a
        LEFT JOIN \`${PROJECT}.${DATASET}.d_vessel_company_map\` m
          ON m.imo_number = a.imo_number
        LEFT JOIN \`${PROJECT}.${DATASET}.d_vessel_master\` v
          ON v.imo_number = a.imo_number
        WHERE m.imo_number IS NULL
          AND a.imo_number IS NOT NULL
          AND a.arrival_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
        ORDER BY a.arrival_time DESC
        LIMIT @limit
      `,
      params: { limit },
      location: BQ_LOCATION,
    });

    logger.info(`[batch] Found ${rows.length} vessels to enrich`);
    const results = [];

    for (const row of rows) {
      const imo = Number(row.imo_number);
      if (!imo) continue;
      // Throttle: 1 vessel every 3 seconds to avoid rate limits
      await new Promise(r => setTimeout(r, 3000));
      const data = await enrichVesselContact(imo, {
        vesselName: row.vessel_name,
        flag:       row.flag,
      });
      results.push({ imo, found: !!(data?.owner?.primary_email || data?.owner?.company_name) });
      logger.info(`[batch] IMO ${imo} → email: ${data?.owner?.primary_email || "not found"}`);
    }

    const found = results.filter(r => r.found).length;
    logger.info(`[batch] Complete: ${found}/${results.length} enriched`);
    return results;
  } catch (err) {
    logger.error("[batch] error:", err.message);
    return [];
  }
}

module.exports = { enrichVesselContact, batchEnrichArrivals };