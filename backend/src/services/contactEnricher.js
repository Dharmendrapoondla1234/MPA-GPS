// backend/src/services/contactEnricher.js — MPA AI Contact Enricher v3
//
// ═══════════════════════════════════════════════════════════════════════
// CONTACT ENRICHMENT PIPELINE
//
// STEP 1 ─ Equasis  (free — IMO-verified owner/manager/ISM manager)
// STEP 2 ─ AI Web Search via Claude (Anthropic API + web_search tool)
// STEP 3 ─ Company Website Scrape
// STEP 4 ─ Google Custom Search (100 free calls/day)
// STEP 5 ─ VesselFinder fallback
// STEP 6 ─ AI Port Agent Intelligence (finds agents for current/next port)
// STEP 7 ─ Save to BigQuery
//
// Confidence scoring:
//   0.90–0.95  Equasis (IMO-verified, official)
//   0.80–0.85  Company's own website (direct scrape)
//   0.70–0.75  AI web search (Claude-verified live web)
//   0.60–0.65  Google CSE (indirect)
//   0.35–0.45  VesselFinder public (low reliability)
// ═══════════════════════════════════════════════════════════════════════

"use strict";
require("dotenv").config();
const { BigQuery }  = require("@google-cloud/bigquery");
const Anthropic     = require("@anthropic-ai/sdk");
const logger        = require("../utils/logger");

const PROJECT    = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET    = process.env.BIGQUERY_DATASET    || "MPA";
const BQ_LOCATION= process.env.BIGQUERY_LOCATION   || "asia-southeast1";

// ── BigQuery client ────────────────────────────────────────────────
let bq;
const _creds = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (_creds?.trim().startsWith("{")) {
  try {
    const c = JSON.parse(_creds);
    bq = new BigQuery({ credentials: c, projectId: c.project_id || PROJECT, location: BQ_LOCATION });
  } catch { bq = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION }); }
} else {
  bq = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION });
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── In-memory caches ───────────────────────────────────────────────
const enrichCache    = new Map();
const portAgentCache = new Map();
const ENRICH_TTL     = 30 * 24 * 60 * 60 * 1000; // 30 days
const PORT_AGENT_TTL = 7  * 24 * 60 * 60 * 1000;  // 7 days

function cacheGet(map, k, ttl) {
  const h = map.get(k);
  return h && Date.now() - h.ts < ttl ? h.data : null;
}
function cacheSet(map, k, d) { map.set(k, { data: d, ts: Date.now() }); return d; }

// ── Extraction helpers ─────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?[\d\s\-().]{7,20})/g;

function extractEmails(text) {
  return [...new Set((text || "").match(EMAIL_RE) || [])].filter(e =>
    !e.includes("example") && !e.includes("yourdomain") && e.length < 80
  );
}
function extractPhones(text) {
  return [...new Set((text || "").match(PHONE_RE) || [])]
    .map(p => p.trim())
    .filter(p => p.replace(/\D/g, "").length >= 7);
}

// ═════════════════════════════════════════════════════════════════
// STEP 1: EQUASIS
// ═════════════════════════════════════════════════════════════════
let _equasisCookies  = null;
let _equasisCookieTs = 0;
const EQUASIS_COOKIE_TTL = 4 * 60 * 60 * 1000;

async function equasisLogin() {
  if (_equasisCookies && Date.now() - _equasisCookieTs < EQUASIS_COOKIE_TTL) {
    return _equasisCookies;
  }
  const email    = process.env.EQUASIS_EMAIL;
  const password = process.env.EQUASIS_PASSWORD;
  if (!email || !password) {
    logger.warn("[equasis] EQUASIS_EMAIL or EQUASIS_PASSWORD not set — skipping");
    return null;
  }
  try {
    const loginPageRes = await fetch("https://www.equasis.org/EquasisWeb/public/HomePage", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/3.0)" },
    });
    const cookies = loginPageRes.headers.get("set-cookie") || "";

    const loginRes = await fetch("https://www.equasis.org/EquasisWeb/authen/HomePage?fs=Search", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookies,
        "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/3.0)",
        "Referer": "https://www.equasis.org/EquasisWeb/public/HomePage",
      },
      body: new URLSearchParams({ j_email: email, j_password: password, submit: "Login" }),
      redirect: "manual",
    });

    const sessionCookie = loginRes.headers.get("set-cookie") || cookies;
    if (sessionCookie && (loginRes.status === 302 || loginRes.status === 200)) {
      _equasisCookies  = sessionCookie;
      _equasisCookieTs = Date.now();
      logger.info("[equasis] ✅ Login successful");
      return sessionCookie;
    }
    logger.warn("[equasis] Login unexpected status:", loginRes.status);
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
          "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/3.0)",
          "Referer": "https://www.equasis.org/EquasisWeb/authen/HomePage?fs=Search",
        },
      }
    );
    if (!res.ok) return null;
    const html = await res.text();

    const ownerMatch   = html.match(/Registered owner[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,100})</i);
    const managerMatch = html.match(/ISM[^<]*[Mm]anager[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,100})</i);
    const shipMgrMatch = html.match(/Ship manager[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,100})</i);
    const operatorMatch= html.match(/Operator[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,100})</i);
    const addressMatch = html.match(/Address[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{5,200})</i);
    const flagMatch    = html.match(/Flag[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,60})</i);

    const owner    = ownerMatch?.[1]?.trim();
    const manager  = managerMatch?.[1]?.trim();
    const shipMgr  = shipMgrMatch?.[1]?.trim();
    const operator = operatorMatch?.[1]?.trim();
    const address  = addressMatch?.[1]?.replace(/<[^>]+>/g, "").trim();
    const flag     = flagMatch?.[1]?.trim();

    if (!owner && !manager) return null;

    logger.info(`[equasis] ✅ IMO ${imo}: owner="${owner}" manager="${manager}"`);
    return {
      owner_name:   owner    || null,
      manager_name: manager  || null,
      ship_manager: shipMgr  || null,
      operator_name:operator || null,
      address:      address  || null,
      flag:         flag     || null,
      source:       "equasis",
      confidence:   0.92,
    };
  } catch (err) {
    logger.warn("[equasis] fetch error:", err.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 2: AI WEB SEARCH via Claude
// ═════════════════════════════════════════════════════════════════
async function aiSearchCompanyContacts(companyName, country) {
  if (!companyName) return null;
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn("[ai-search] ANTHROPIC_API_KEY not set — skipping");
    return null;
  }
  try {
    const prompt = `You are a maritime data researcher. Find official contact information for this shipping company:

Company: "${companyName}"${country ? `\nCountry/Flag: ${country}` : ""}

Search the web and return ONLY a valid JSON object (no explanation, no markdown) with:
{
  "website": "https://... or null",
  "email": "primary contact email or null",
  "email_ops": "operations email or null",
  "phone": "+international format or null",
  "phone_alt": "alternative number or null",
  "address": "registered address or null",
  "linkedin": "LinkedIn URL or null",
  "confidence": 0.0 to 1.0
}

Rules:
- Only return VERIFIED data from official website or maritime directories (equasis, Lloyd's, IHS Markit)
- Prefer ops@, operations@, info@, contact@ emails
- confidence: 0.9=official site, 0.7=maritime directory, 0.5=uncertain
- Return null for anything unverified — do NOT invent data`;

    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 600,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find(b => b.type === "text");
    if (!textBlock?.text) return null;
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const data = JSON.parse(jsonMatch[0]);
    logger.info(`[ai-search] ✅ "${companyName}": email=${data.email} conf=${data.confidence}`);
    return { ...data, source: "ai_web_search" };
  } catch (err) {
    logger.warn("[ai-search] error:", err.message?.slice(0, 80));
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 3: Scrape company website
// ═════════════════════════════════════════════════════════════════
async function scrapeContactPage(websiteUrl) {
  if (!websiteUrl) return null;
  try {
    const base    = new URL(websiteUrl).origin;
    const tryUrls = [
      `${base}/contact`, `${base}/contact-us`, `${base}/about/contact`,
      `${base}/en/contact`, `${base}/contacts`, websiteUrl,
    ];
    for (const url of tryUrls) {
      try {
        const ctrl    = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 5000);
        const res     = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/3.0)" },
          signal: ctrl.signal,
        }).finally(() => clearTimeout(timeout));
        if (!res.ok) continue;
        const html   = await res.text();
        const text   = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        const emails = extractEmails(text);
        const phones = extractPhones(text);
        if (emails.length || phones.length) {
          logger.info(`[scrape] ✅ ${url}: emails=${emails.slice(0,2)}`);
          return {
            email:      emails[0] || null,
            email_ops:  emails[1] || null,
            phone:      phones[0] || null,
            source:     "website_scrape",
            confidence: 0.85,
          };
        }
      } catch { /* try next */ }
    }
    return null;
  } catch (err) {
    logger.warn("[scrape] error:", err.message?.slice(0, 60));
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 4: Google Custom Search API
// ═════════════════════════════════════════════════════════════════
async function googleSearchContacts(companyName) {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx  = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) return null;
  try {
    const q   = encodeURIComponent(`"${companyName}" shipping maritime contact email`);
    const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${q}&num=5`;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const res  = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const allText = (json.items || [])
      .map(i => `${i.title} ${i.snippet} ${i.link}`).join(" ");
    const emails = extractEmails(allText);
    const phones = extractPhones(allText);
    if (!emails.length) return null;
    logger.info(`[google-cse] ✅ "${companyName}": email=${emails[0]}`);
    return { email: emails[0], phone: phones[0] || null, source: "google_cse", confidence: 0.65 };
  } catch (err) {
    logger.warn("[google-cse] error:", err.message?.slice(0, 60));
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 5: VesselFinder fallback
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
// STEP 6: AI PORT AGENT INTELLIGENCE
// Uses Claude to find shipping agents at current and next port
// ═════════════════════════════════════════════════════════════════
async function aiSearchPortAgents({ portName, portCode, vesselType, ownerName }) {
  if (!portName && !portCode) return [];
  if (!process.env.ANTHROPIC_API_KEY) return [];

  const cacheKey = `port_agents_${portCode || portName}_${vesselType || ""}`;
  const cached   = cacheGet(portAgentCache, cacheKey, PORT_AGENT_TTL);
  if (cached) { logger.debug(`[port-agents] cache hit for ${portCode}`); return cached; }

  try {
    const prompt = `You are a maritime port operations expert. Find shipping/port agents at this port:

Port: "${portName || portCode}"${portCode ? ` (UN/LOCODE: ${portCode})` : ""}
${vesselType ? `Vessel Type: ${vesselType}` : ""}
${ownerName ? `Ship Owner/Operator: ${ownerName}` : ""}

Search for port agents, shipping agents, and husbanding agents at this port.
Return ONLY a valid JSON array (no explanation, no markdown) of up to 5 agents:
[
  {
    "agent_name": "John Smith or null",
    "agency_company": "Company Name Ltd",
    "port_code": "${portCode || ""}",
    "port_name": "${portName || ""}",
    "email": "agent@company.com or null",
    "email_ops": "ops email or null",
    "phone": "+international format or null",
    "phone_24h": "24h emergency line or null",
    "vhf_channel": "VHF 16 or null",
    "website": "https://... or null",
    "vessel_types_served": "ALL or TANKER or BULK or CONTAINER",
    "services": ["husbanding", "cargo", "crew", "customs"],
    "confidence": 0.0 to 1.0,
    "source": "official website / port authority / maritime directory"
  }
]

Only return VERIFIED agents from official port authority lists, company websites, or reputable maritime directories.
Return [] if no verified agents found.`;

    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 1200,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find(b => b.type === "text");
    if (!textBlock?.text) return [];
    const jsonMatch = textBlock.text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const agents = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(agents)) return [];
    logger.info(`[port-agents] ✅ Found ${agents.length} agents for ${portName || portCode}`);
    return cacheSet(portAgentCache, cacheKey, agents);
  } catch (err) {
    logger.warn("[port-agents] error:", err.message?.slice(0, 80));
    return [];
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 7: Save to BigQuery
// ═════════════════════════════════════════════════════════════════
async function saveToFirestore(imo, data) {
  try {
    const now = new Date().toISOString();
    const ds  = bq.dataset(DATASET);

    try { await ds.table("d_shipping_companies").getMetadata(); }
    catch { logger.warn(`[bq-save] d_shipping_companies not found — skipping save IMO ${imo}`); return; }

    if (data.owner_name || data.email) {
      const companyId = `enriched_${imo}_owner`;
      await ds.table("d_shipping_companies").insert([{
        company_id:         companyId,
        company_name:       data.owner_name  || null,
        company_type:       "OWNER",
        primary_email:      data.email       || null,
        secondary_email:    data.email_ops   || null,
        phone_primary:      data.phone       || null,
        website:            data.website     || null,
        registered_address: data.address     || null,
        data_source:        data.source      || "enriched",
        last_verified_at:   now,
        created_at:         now,
        updated_at:         now,
      }], { skipInvalidRows: true });

      await ds.table("d_vessel_company_map").insert([{
        imo_number:       imo,
        owner_company_id: companyId,
        data_source:      data.source || "enriched",
        last_verified_at: now,
        created_at:       now,
        updated_at:       now,
      }], { skipInvalidRows: true });
    }

    if (data.manager_name) {
      const mgrId = `enriched_${imo}_manager`;
      await ds.table("d_shipping_companies").insert([{
        company_id:      mgrId,
        company_name:    data.manager_name,
        company_type:    "MANAGER",
        data_source:     "equasis",
        last_verified_at: now,
        created_at:      now,
        updated_at:      now,
      }], { skipInvalidRows: true });
    }

    // Save port agents if found
    if (data.port_agents?.length) {
      try { await ds.table("d_port_agents").getMetadata(); }
      catch { logger.warn("[bq-save] d_port_agents not found — skipping agent save"); }

      for (const agent of data.port_agents) {
        try {
          await ds.table("d_port_agents").insert([{
            agent_id:           `ai_${agent.port_code}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
            agent_name:         agent.agent_name     || null,
            agency_company:     agent.agency_company || null,
            port_code:          agent.port_code      || null,
            port_name:          agent.port_name      || null,
            email_primary:      agent.email          || null,
            email_ops:          agent.email_ops      || null,
            phone_main:         agent.phone          || null,
            phone_24h:          agent.phone_24h      || null,
            vhf_channel:        agent.vhf_channel    || null,
            vessel_type_served: agent.vessel_types_served || "ALL",
            is_active:          true,
            data_source:        `ai_enriched`,
            last_verified_at:   now,
            created_at:         now,
            updated_at:         now,
          }], { skipInvalidRows: true });
        } catch { /* non-fatal */ }
      }
    }

    await ds.table("d_contact_audit_log").insert([{
      log_id:        `log_${imo}_${Date.now()}`,
      imo_number:    imo,
      field_changed: "full_enrichment",
      new_value:     JSON.stringify({ email: data.email, phone: data.phone, source: data.source }),
      changed_by:    "contact_enricher_v3",
      change_source: data.source,
      changed_at:    now,
    }], { skipInvalidRows: true });

    logger.info(`[bq-save] ✅ IMO ${imo} saved (source: ${data.source})`);
  } catch (err) {
    logger.warn("[bq-save] write error (non-fatal):", err.message?.slice(0, 80));
  }
}

// ═════════════════════════════════════════════════════════════════
// MAIN: enrichVesselContact
// ═════════════════════════════════════════════════════════════════
async function enrichVesselContact(imo, { vesselName, flag, currentPort, nextPort, vesselType } = {}) {
  if (!imo) return null;
  const cacheKey = `enrich_${imo}`;
  const cached   = cacheGet(enrichCache, cacheKey, ENRICH_TTL);
  if (cached) { logger.debug(`[enricher] cache hit IMO ${imo}`); return cached; }

  logger.info(`[enricher] Starting pipeline IMO ${imo} (${vesselName || "unknown"})`);
  const result = { imo_number: imo, vessel_name: vesselName, flag };

  // ── STEP 1: Equasis ───────────────────────────────────────────
  const eq = await fetchFromEquasis(imo);
  if (eq) {
    result.owner_name    = eq.owner_name;
    result.manager_name  = eq.manager_name;
    result.ship_manager  = eq.ship_manager;
    result.operator_name = eq.operator_name;
    result.address       = eq.address;
    result.flag          = result.flag || eq.flag;
    result.source        = "equasis";
    result.confidence    = eq.confidence;
  }

  // ── STEP 2: AI search for email/phone ─────────────────────────
  const companyName = result.owner_name || result.manager_name || vesselName;
  if (companyName) {
    const ai = await aiSearchCompanyContacts(companyName, result.flag || flag);
    if (ai) {
      result.website   = result.website   || ai.website;
      result.email     = result.email     || ai.email;
      result.email_ops = result.email_ops || ai.email_ops;
      result.phone     = result.phone     || ai.phone;
      result.phone_alt = result.phone_alt || ai.phone_alt;
      result.address   = result.address   || ai.address;
      result.linkedin  = result.linkedin  || ai.linkedin;
      result.confidence= Math.max(result.confidence || 0, (ai.confidence || 0) * 0.9);
      result.source    = result.source ? `${result.source}+ai_search` : "ai_search";
    }
  }

  // ── STEP 3: Scrape website ────────────────────────────────────
  if (result.website && (!result.email || !result.phone)) {
    const sc = await scrapeContactPage(result.website);
    if (sc) {
      result.email     = result.email     || sc.email;
      result.email_ops = result.email_ops || sc.email_ops;
      result.phone     = result.phone     || sc.phone;
      result.source    = `${result.source || ""}+scrape`.replace(/^\+/, "");
    }
  }

  // ── STEP 4: Google CSE ────────────────────────────────────────
  if (companyName && !result.email) {
    const gc = await googleSearchContacts(companyName);
    if (gc) {
      result.email      = gc.email;
      result.phone      = result.phone || gc.phone;
      result.confidence = result.confidence || gc.confidence;
      result.source     = `${result.source || ""}+google_cse`.replace(/^\+/, "");
    }
  }

  // ── STEP 5: VesselFinder fallback ────────────────────────────
  if (!result.owner_name && !result.manager_name) {
    const vf = await vesselFinderFallback(imo);
    if (vf) {
      result.owner_name  = vf.owner_name;
      result.confidence  = vf.confidence;
      result.source      = "vesselfinder";
    }
  }

  // ── STEP 6: AI Port Agent Intelligence ───────────────────────
  const portAgents = [];
  const portsToSearch = [
    currentPort && { portName: currentPort, label: "current" },
    nextPort    && { portName: nextPort,    label: "next" },
  ].filter(Boolean);

  for (const { portName, label } of portsToSearch) {
    logger.info(`[enricher] Searching port agents for ${label} port: ${portName}`);
    const agents = await aiSearchPortAgents({
      portName,
      portCode:   portName,
      vesselType: vesselType || null,
      ownerName:  result.owner_name || null,
    });
    agents.forEach(a => {
      a.port_context = label; // "current" or "next"
      portAgents.push(a);
    });
  }

  // ── STEP 7: Save to BigQuery ──────────────────────────────────
  if (result.owner_name || result.email) {
    saveToFirestore(imo, { ...result, port_agents: portAgents }); // fire-and-forget
  }

  const final = {
    imo_number:  imo,
    vessel_name: vesselName,
    owner: {
      company_name:       result.owner_name    || null,
      company_type:       "OWNER",
      primary_email:      result.email         || null,
      secondary_email:    result.email_ops     || null,
      phone_primary:      result.phone         || null,
      phone_secondary:    result.phone_alt     || null,
      website:            result.website       || null,
      registered_address: result.address       || null,
      linkedin:           result.linkedin      || null,
      data_source:        result.source        || null,
    },
    operator: result.operator_name ? {
      company_name: result.operator_name,
      company_type: "OPERATOR",
      data_source:  "equasis",
    } : null,
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
    port_agents: portAgents,
    enrichment: {
      source:      result.source     || "none",
      confidence:  result.confidence || (result.owner_name || result.email ? 0.4 : 0),
      enriched_at: new Date().toISOString(),
    },
  };

  return cacheSet(enrichCache, cacheKey, final);
}

// ═════════════════════════════════════════════════════════════════
// Batch enrichment
// ═════════════════════════════════════════════════════════════════
async function batchEnrichArrivals(limit = 20) {
  logger.info(`[batch] Starting batch enrichment (limit=${limit})`);
  try {
    const [rows] = await bq.query({
      query: `
        SELECT DISTINCT a.imo_number, a.vessel_name, v.flag,
          a.port_name AS current_port, a.next_port_destination AS next_port,
          v.vessel_type
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
      await new Promise(r => setTimeout(r, 3000)); // throttle
      const data = await enrichVesselContact(imo, {
        vesselName:  row.vessel_name,
        flag:        row.flag,
        currentPort: row.current_port,
        nextPort:    row.next_port,
        vesselType:  row.vessel_type,
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

// ── Standalone port agent search (for route /api/contacts/agents) ──
async function enrichPortAgents({ portName, portCode, vesselType }) {
  return aiSearchPortAgents({ portName, portCode, vesselType });
}

module.exports = { enrichVesselContact, batchEnrichArrivals, enrichPortAgents };