// backend/src/services/contactEnricher.js — MPA AI Contact Enricher v5
//
// PIPELINE:
// STEP 1  Equasis           — IMO-verified owner/manager/ISM (conf 0.92)
// STEP 2  AI Web Search     — Claude + web_search for email/phone (conf 0.75)
// STEP 3  Website Scrape    — Company contact page (conf 0.85)
// STEP 4  Google CSE        — Search snippet extraction (conf 0.65)
// STEP 5  VesselFinder      — Company name fallback (conf 0.40)
// STEP 6  Port Agent DB     — Static seed lookup by LOCODE/name
// STEP 7  AI Port Agents    — Claude searches for agents not in DB
// STEP 8  Agent Org         — Enrich appointed ship agent/husbandry org (conf 0.75)
// STEP 9  Master Contact    — Flag state / ISM channel for vessel master (conf 0.60)
// STEP 10 BigQuery Save     — Write enriched data + agents to BQ tables
"use strict";
require("dotenv").config();
const { BigQuery }            = require("@google-cloud/bigquery");
const Anthropic               = require("@anthropic-ai/sdk");
const logger                  = require("../utils/logger");
const { lookupPortAgents, rankAgents } = require("./portAgentDB");

const PROJECT     = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET     = process.env.BIGQUERY_DATASET    || "MPA";
const BQ_LOCATION = process.env.BIGQUERY_LOCATION   || "asia-southeast1";

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

// ── Caches ─────────────────────────────────────────────────────────
const enrichCache    = new Map();
const portAgentCache = new Map();
const ENRICH_TTL     = 30 * 24 * 60 * 60 * 1000;
const PORT_AGENT_TTL =  7 * 24 * 60 * 60 * 1000;

function cacheGet(map, k, ttl) {
  const h = map.get(k);
  return h && Date.now() - h.ts < ttl ? h.data : null;
}
function cacheSet(map, k, d) { map.set(k, { data: d, ts: Date.now() }); return d; }

// ── Extractors ─────────────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?[\d\s\-().]{7,20})/g;

function extractEmails(text) {
  return [...new Set((text || "").match(EMAIL_RE) || [])].filter(e =>
    !e.includes("example") && !e.includes("yourdomain") && e.length < 80
  );
}
function extractPhones(text) {
  return [...new Set((text || "").match(PHONE_RE) || [])]
    .map(p => p.trim()).filter(p => p.replace(/\D/g, "").length >= 7);
}

// ═════════════════════════════════════════════════════════════════
// STEP 1: EQUASIS
// ═════════════════════════════════════════════════════════════════
let _equasisCookies  = null;
let _equasisCookieTs = 0;
const EQUASIS_COOKIE_TTL = 4 * 60 * 60 * 1000;

async function equasisLogin() {
  if (_equasisCookies && Date.now() - _equasisCookieTs < EQUASIS_COOKIE_TTL) return _equasisCookies;
  const email = process.env.EQUASIS_EMAIL, password = process.env.EQUASIS_PASSWORD;
  if (!email || !password) { logger.warn("[equasis] Credentials not set"); return null; }
  try {
    const pageRes = await fetch("https://www.equasis.org/EquasisWeb/public/HomePage", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/4.0)" },
    });
    const cookies = pageRes.headers.get("set-cookie") || "";
    const loginRes = await fetch("https://www.equasis.org/EquasisWeb/authen/HomePage?fs=Search", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookies, "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/4.0)",
        Referer: "https://www.equasis.org/EquasisWeb/public/HomePage",
      },
      body: new URLSearchParams({ j_email: email, j_password: password, submit: "Login" }),
      redirect: "manual",
    });
    const sessionCookie = loginRes.headers.get("set-cookie") || cookies;
    if (sessionCookie && (loginRes.status === 302 || loginRes.status === 200)) {
      _equasisCookies = sessionCookie; _equasisCookieTs = Date.now();
      logger.info("[equasis] ✅ Login OK"); return sessionCookie;
    }
    return null;
  } catch (err) { logger.warn("[equasis] Login failed:", err.message); return null; }
}

async function fetchFromEquasis(imo) {
  const cookies = await equasisLogin();
  if (!cookies) return null;
  try {
    const res = await fetch(
      `https://www.equasis.org/EquasisWeb/authen/ShipInfo?fs=Search&P_IMO=${imo}`,
      { headers: { Cookie: cookies, "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/4.0)",
        Referer: "https://www.equasis.org/EquasisWeb/authen/HomePage?fs=Search" } }
    );
    if (!res.ok) return null;
    const html = await res.text();
    const pick = re => re.exec(html)?.[1]?.trim() || null;
    const owner    = pick(/Registered owner[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,100})</i);
    const manager  = pick(/ISM[^<]*[Mm]anager[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,100})</i);
    const shipMgr  = pick(/Ship manager[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,100})</i);
    const operator = pick(/Operator[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,100})</i);
    const address  = pick(/Address[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{5,200})</i)?.replace(/<[^>]+>/g, "").trim();
    const flag     = pick(/Flag[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,60})</i);
    if (!owner && !manager) return null;
    logger.info(`[equasis] ✅ IMO ${imo}: owner="${owner}"`);
    return { owner_name: owner, manager_name: manager, ship_manager: shipMgr,
             operator_name: operator, address, flag, source: "equasis", confidence: 0.92 };
  } catch (err) { logger.warn("[equasis] error:", err.message); return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEP 2: AI WEB SEARCH
// ═════════════════════════════════════════════════════════════════
async function aiSearchCompanyContacts(companyName, country) {
  if (!companyName || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5", max_tokens: 600,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content:
        `Find official contact information for shipping company: "${companyName}"${country ? ` (${country})` : ""}.
Return ONLY valid JSON, no markdown:
{"website":null,"email":null,"email_ops":null,"phone":null,"phone_alt":null,"address":null,"linkedin":null,"confidence":0.7}
Rules: verified data only, null for unverified. confidence: 0.9=official site, 0.7=directory, 0.5=uncertain.` }],
    });
    const text = response.content.find(b => b.type === "text")?.text;
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const data = JSON.parse(m[0]);
    logger.info(`[ai-search] ✅ "${companyName}": email=${data.email}`);
    return { ...data, source: "ai_web_search" };
  } catch (err) { logger.warn("[ai-search] error:", err.message?.slice(0, 80)); return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEP 2b: AI LOOKUP BY IMO (when Equasis fails and no vessel name)
// ═════════════════════════════════════════════════════════════════
async function aiLookupByIMO(imo) {
  if (!imo || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5", max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content:
        `Search for the vessel with IMO number ${imo}. Find its registered owner company, operator, and any contact information.
Return ONLY valid JSON (no markdown):
{"vessel_name":null,"owner_name":null,"operator_name":null,"flag":null,"website":null,"email":null,"phone":null,"address":null,"confidence":0.6}
Rules: Use verified maritime databases (equasis, marinetraffic, fleetmon, vesseltracker). null for unverified fields.` }],
    });
    const text = response.content.find(b => b.type === "text")?.text;
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const data = JSON.parse(m[0]);
    logger.info(`[ai-imo] ✅ IMO ${imo}: owner="${data.owner_name}" vessel="${data.vessel_name}"`);
    return data;
  } catch (err) { logger.warn("[ai-imo] error:", err.message?.slice(0, 80)); return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEP 3: WEBSITE SCRAPE
// ═════════════════════════════════════════════════════════════════
async function scrapeContactPage(websiteUrl) {
  if (!websiteUrl) return null;
  try {
    const base = new URL(websiteUrl).origin;
    const urls = [`${base}/contact`, `${base}/contact-us`, `${base}/contacts`, `${base}/en/contact`, websiteUrl];
    for (const url of urls) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal }).finally(() => clearTimeout(t));
        if (!res.ok) continue;
        const text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        const emails = extractEmails(text), phones = extractPhones(text);
        if (emails.length || phones.length) {
          return { email: emails[0]||null, email_ops: emails[1]||null, phone: phones[0]||null, source: "website_scrape", confidence: 0.85 };
        }
      } catch { /* next */ }
    }
  } catch (err) { logger.warn("[scrape] error:", err.message?.slice(0, 60)); }
  return null;
}

// ═════════════════════════════════════════════════════════════════
// STEP 4: GOOGLE CSE
// ═════════════════════════════════════════════════════════════════
async function googleSearchContacts(companyName) {
  const key = process.env.GOOGLE_CSE_KEY, cx = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) return null;
  try {
    const q   = encodeURIComponent(`"${companyName}" shipping maritime contact email`);
    const res = await fetch(`https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${q}&num=5`);
    if (!res.ok) return null;
    const json = await res.json();
    const text = (json.items || []).map(i => `${i.title} ${i.snippet} ${i.link}`).join(" ");
    const emails = extractEmails(text), phones = extractPhones(text);
    if (!emails.length) return null;
    return { email: emails[0], phone: phones[0]||null, source: "google_cse", confidence: 0.65 };
  } catch (err) { logger.warn("[google-cse] error:", err.message?.slice(0, 60)); return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEP 5: VESSELFINDER FALLBACK
// ═════════════════════════════════════════════════════════════════
async function vesselFinderFallback(imo) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`https://www.vesselfinder.com/api/pub/vesselDetails?imo=${imo}`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const name = json?.AIS?.DESTINATION || json?.vessel?.manager || null;
    return name ? { owner_name: name, source: "vesselfinder", confidence: 0.40 } : null;
  } catch { return null; }
}

// ═════════════════════════════════════════════════════════════════
// STEPS 6+7: PORT AGENT INTELLIGENCE
// First checks static DB, then AI if no results
// ═════════════════════════════════════════════════════════════════
async function resolvePortAgents({ portName, portCode, vesselType, ownerName, portContext }) {
  const lookupKey = portCode || portName;
  if (!lookupKey) return [];

  const cacheKey = `agents_${lookupKey}_${vesselType || ""}`;
  const cached   = cacheGet(portAgentCache, cacheKey, PORT_AGENT_TTL);
  if (cached) return cached.map(a => ({ ...a, port_context: portContext }));

  // STEP 6: Static DB lookup
  let agents = lookupPortAgents(lookupKey, vesselType);
  if (agents.length) {
    agents = rankAgents(agents, vesselType, 3);
    logger.info(`[port-agents] DB hit for "${lookupKey}": ${agents.length} agents`);
    cacheSet(portAgentCache, cacheKey, agents);
    return agents.map(a => ({ ...a, port_context: portContext }));
  }

  // STEP 7: AI fallback for unknown ports
  if (!process.env.ANTHROPIC_API_KEY) return [];
  try {
    logger.info(`[port-agents] AI search for "${portName || portCode}"`);
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5", max_tokens: 1200,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content:
        `Find shipping/port agents at: "${portName || portCode}"${vesselType ? ` for ${vesselType}` : ""}${ownerName ? ` (ship owner: ${ownerName})` : ""}.
Return ONLY a valid JSON array, no markdown:
[{"agent_name":null,"agency_company":"Name","port_code":"${portCode||""}","port_name":"${portName||""}","email":null,"email_ops":null,"phone":null,"phone_24h":null,"vhf_channel":null,"website":null,"vessel_types_served":"ALL","services":["husbandry"],"confidence":0.7,"source":"directory"}]
Return [] if nothing verified. Maximum 3 agents.` }],
    });
    const text = response.content.find(b => b.type === "text")?.text;
    if (!text) return [];
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const aiAgents = JSON.parse(m[0]);
    if (!Array.isArray(aiAgents) || !aiAgents.length) return [];
    logger.info(`[port-agents] AI found ${aiAgents.length} for "${lookupKey}"`);
    cacheSet(portAgentCache, cacheKey, aiAgents);
    return aiAgents.map(a => ({ ...a, port_context: portContext, data_source: a.source || "ai_enriched" }));
  } catch (err) {
    logger.warn("[port-agents] AI error:", err.message?.slice(0, 80));
    return [];
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 8: BIGQUERY SAVE
// ═════════════════════════════════════════════════════════════════
async function saveToBigQuery(imo, data) {
  try {
    const now = new Date().toISOString();
    const ds  = bq.dataset(DATASET);

    // Check tables exist
    const tableExists = async (name) => {
      try { await ds.table(name).getMetadata(); return true; } catch { return false; }
    };

    if (await tableExists("d_shipping_companies") && (data.owner_name || data.email)) {
      const cid = `enriched_${imo}_owner`;
      await ds.table("d_shipping_companies").insert([{
        company_id: cid, company_name: data.owner_name || null,
        company_type: "OWNER", primary_email: data.email || null,
        secondary_email: data.email_ops || null, phone_primary: data.phone || null,
        website: data.website || null, registered_address: data.address || null,
        data_source: data.source || "enriched", last_verified_at: now,
        created_at: now, updated_at: now,
      }], { skipInvalidRows: true });

      if (await tableExists("d_vessel_company_map")) {
        await ds.table("d_vessel_company_map").insert([{
          imo_number: imo, owner_company_id: cid,
          data_source: data.source || "enriched", last_verified_at: now,
          created_at: now, updated_at: now,
        }], { skipInvalidRows: true });
      }
    }

    if (await tableExists("d_port_agents") && data.port_agents?.length) {
      for (const a of data.port_agents) {
        try {
          await ds.table("d_port_agents").insert([{
            agent_id:           a.agent_id || `ai_${a.port_code}_${Date.now()}`,
            agent_name:         a.agent_name || null,
            agency_company:     a.agency_company || null,
            port_code:          a.port_code || null,
            port_name:          a.port_name || null,
            email_primary:      a.email || a.email_primary || null,
            email_ops:          a.email_ops || null,
            phone_main:         a.phone || a.phone_main || null,
            phone_24h:          a.phone_24h || null,
            vhf_channel:        a.vhf_channel || null,
            vessel_type_served: a.vessel_type_served || a.vessel_types_served || "ALL",
            is_active:          true,
            data_source:        a.data_source || "enriched",
            last_verified_at:   now, created_at: now, updated_at: now,
          }], { skipInvalidRows: true });
        } catch { /* non-fatal */ }
      }
    }

    if (await tableExists("d_contact_audit_log")) {
      await ds.table("d_contact_audit_log").insert([{
        log_id: `log_${imo}_${Date.now()}`, imo_number: imo,
        field_changed: "full_enrichment",
        new_value: JSON.stringify({ email: data.email, phone: data.phone, source: data.source }),
        changed_by: "contact_enricher_v4", change_source: data.source,
        changed_at: now,
      }], { skipInvalidRows: true });
    }

    logger.info(`[bq-save] ✅ IMO ${imo} saved`);
  } catch (err) {
    logger.warn("[bq-save] non-fatal error:", err.message?.slice(0, 80));
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 8: AGENT ORGANISATION ENRICHMENT
// Identifies and enriches the vessel's appointed husbandry/ship agent
// organisation — the company that handles the vessel's port calls,
// crew changes, provisions, and clearance on behalf of the owner.
// Different from ad-hoc port agents; this is the standing appointment.
// ═════════════════════════════════════════════════════════════════
async function enrichAgentOrganisation({ ownerName, managerName, vesselName, vesselType, flag, imo }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const company = managerName || ownerName;
  if (!company && !vesselName) return null;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5", max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content:
        `Find the appointed ship agent or husbandry agent organisation for this vessel:
Vessel: "${vesselName || "unknown"}" (IMO: ${imo || "unknown"})
Owner/Manager: "${company || "unknown"}"
Flag: "${flag || "unknown"}"
Type: "${vesselType || "unknown"}"

A ship agent organisation (also called husbandry agent, port agent, or ship chandler network) is the company formally appointed by the owner/manager to handle port calls, crew, provisions, and customs on their behalf globally or regionally.

Examples: GAC, Wilhelmsen Ship Management, Inchcape Shipping Services, Synergy Marine, Columbia Shipmanagement, V.Ships, Thome Ship Management.

Search for: "${company || vesselName} ship agent" OR "${company || vesselName} husbandry agent" OR "${company || vesselName} port agent appointment"

Return ONLY valid JSON, no markdown:
{
  "agent_org_name": null,
  "agent_org_type": "HUSBANDRY_AGENT or SHIP_MANAGER or PORT_AGENT_NETWORK",
  "agent_org_website": null,
  "agent_org_email": null,
  "agent_org_email_ops": null,
  "agent_org_phone": null,
  "agent_org_phone_24h": null,
  "agent_org_address": null,
  "services": [],
  "regions_covered": [],
  "appointment_basis": "STANDING or AD_HOC or UNKNOWN",
  "confidence": 0.5,
  "source": "web_search"
}
Rules: null for anything unverified. confidence 0.9=official confirmation, 0.7=strong indication, 0.5=likely, 0.3=uncertain.` }],
    });
    const text = response.content.find(b => b.type === "text")?.text;
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const data = JSON.parse(m[0]);
    if (!data.agent_org_name) return null;
    logger.info(`[agent-org] ✅ Found: "${data.agent_org_name}" for "${company || vesselName}"`);
    return { ...data, source: "ai_web_search" };
  } catch (err) {
    logger.warn("[agent-org] error:", err.message?.slice(0, 80));
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// STEP 9: VESSEL MASTER / CAPTAIN CONTACT CHANNEL
// We do NOT expose the captain's personal details (GDPR / maritime
// privacy). Instead we resolve the correct communication channel:
//   • Ship manager's crew department (for operational matters)
//   • Flag state MRCC (for emergencies)
//   • Satellite comms provider contact (Inmarsat/Iridium)
//   • Ship's official SAT-C / GMDSS contact if publicly listed
// ═════════════════════════════════════════════════════════════════
async function enrichMasterContact({ ownerName, managerName, shipManager, flag, imo, vesselName }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const mgr = shipManager || managerName || ownerName;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5", max_tokens: 700,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content:
        `Find the correct communication channel to reach the vessel master / captain of:
Vessel: "${vesselName || "unknown"}" (IMO: ${imo || "unknown"})
Ship Manager / ISM Manager: "${mgr || "unknown"}"
Flag State: "${flag || "unknown"}"

IMPORTANT: Do NOT look for or return personal contact details of the captain.
Return the OFFICIAL CHANNELS only:
1. Ship manager's crew/operations department contact (who relays messages to the master)
2. Flag state MRCC (Maritime Rescue Coordination Centre) for emergencies
3. Any publicly listed ship satellite phone / Inmarsat number (if in public directories)
4. Vessel's official radio call sign if findable

Search: "${mgr || vesselName} crew department contact" AND "MRCC ${flag || ""} emergency contact"

Return ONLY valid JSON, no markdown:
{
  "master_contact_note": "Brief explanation of how to reach the master",
  "crew_dept_company": null,
  "crew_dept_email": null,
  "crew_dept_phone": null,
  "mrcc_name": null,
  "mrcc_email": null,
  "mrcc_phone": null,
  "mrcc_country": null,
  "sat_phone_public": null,
  "radio_call_sign": null,
  "inmarsat_number": null,
  "preferred_channel": "SHIP_MANAGER or PORT_AGENT or MRCC or SATPHONE",
  "contact_protocol": "Standard protocol note, e.g. contact via ship manager ops dept",
  "confidence": 0.5,
  "source": "web_search"
}` }],
    });
    const text = response.content.find(b => b.type === "text")?.text;
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const data = JSON.parse(m[0]);
    logger.info(`[master-contact] ✅ channel="${data.preferred_channel}" for IMO ${imo}`);
    return { ...data, source: "ai_web_search" };
  } catch (err) {
    logger.warn("[master-contact] error:", err.message?.slice(0, 80));
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// MAIN: enrichVesselContact
// ═════════════════════════════════════════════════════════════════
async function enrichVesselContact(imo, {
  vesselName, flag, currentPort, nextPort, vesselType,
  forceRefresh = false,
} = {}) {
  if (!imo) return null;

  const cacheKey = `enrich_${imo}`;
  if (!forceRefresh) {
    const cached = cacheGet(enrichCache, cacheKey, ENRICH_TTL);
    if (cached) { logger.debug(`[enricher] cache hit IMO ${imo}`); return cached; }
  } else {
    enrichCache.delete(cacheKey);
  }

  logger.info(`[enricher] Pipeline START: IMO ${imo} (${vesselName || "unknown"})`);
  const r = { imo_number: imo, vessel_name: vesselName, flag };

  // STEP 1
  const eq = await fetchFromEquasis(imo);
  if (eq) Object.assign(r, { owner_name: eq.owner_name, manager_name: eq.manager_name,
    ship_manager: eq.ship_manager, operator_name: eq.operator_name,
    address: eq.address, flag: r.flag || eq.flag, source: "equasis", confidence: eq.confidence });

  // STEP 2b: If Equasis returned nothing and we have no name, use AI to look up by IMO
  if (!r.owner_name && !r.manager_name) {
    const imoData = await aiLookupByIMO(imo);
    if (imoData) {
      r.owner_name    = r.owner_name    || imoData.owner_name    || null;
      r.operator_name = r.operator_name || imoData.operator_name || null;
      r.vessel_name   = r.vessel_name   || imoData.vessel_name   || vesselName || null;
      r.flag          = r.flag          || imoData.flag           || null;
      r.website       = r.website       || imoData.website        || null;
      r.email         = r.email         || imoData.email          || null;
      r.phone         = r.phone         || imoData.phone          || null;
      r.address       = r.address       || imoData.address        || null;
      r.confidence    = Math.max(r.confidence || 0, imoData.confidence || 0);
      r.source        = r.source ? `${r.source}+ai_imo` : "ai_imo";
    }
  }

  // STEP 2
  const company = r.owner_name || r.manager_name || vesselName;
  if (company) {
    const ai = await aiSearchCompanyContacts(company, r.flag || flag);
    if (ai) {
      r.website   = r.website   || ai.website;
      r.email     = r.email     || ai.email;
      r.email_ops = r.email_ops || ai.email_ops;
      r.phone     = r.phone     || ai.phone;
      r.phone_alt = r.phone_alt || ai.phone_alt;
      r.address   = r.address   || ai.address;
      r.linkedin  = r.linkedin  || ai.linkedin;
      r.confidence= Math.max(r.confidence || 0, (ai.confidence || 0) * 0.9);
      r.source    = r.source ? `${r.source}+ai_search` : "ai_search";
    }
  }

  // STEP 3
  if (r.website && (!r.email || !r.phone)) {
    const sc = await scrapeContactPage(r.website);
    if (sc) {
      r.email     = r.email     || sc.email;
      r.email_ops = r.email_ops || sc.email_ops;
      r.phone     = r.phone     || sc.phone;
      r.source    = `${r.source || ""}+scrape`.replace(/^\+/, "");
    }
  }

  // STEP 4
  if (company && !r.email) {
    const gc = await googleSearchContacts(company);
    if (gc) {
      r.email = gc.email; r.phone = r.phone || gc.phone;
      r.confidence = r.confidence || gc.confidence;
      r.source = `${r.source || ""}+google_cse`.replace(/^\+/, "");
    }
  }

  // STEP 5
  if (!r.owner_name && !r.manager_name) {
    const vf = await vesselFinderFallback(imo);
    if (vf) { r.owner_name = vf.owner_name; r.confidence = vf.confidence; r.source = "vesselfinder"; }
  }

  // STEPS 6+7: Port agents for current and next port
  const portAgents = [];
  for (const [portKey, context] of [
    [currentPort, "current"],
    [nextPort,    "next"],
  ]) {
    if (!portKey) continue;
    const agents = await resolvePortAgents({
      portName: portKey, portCode: portKey,
      vesselType: vesselType || null,
      ownerName: r.owner_name || null,
      portContext: context,
    });
    portAgents.push(...agents);
  }

  // STEP 8: Agent organisation enrichment
  const agentOrg = await enrichAgentOrganisation({
    ownerName:   r.owner_name   || null,
    managerName: r.manager_name || null,
    vesselName,
    vesselType:  vesselType     || null,
    flag:        r.flag || flag || null,
    imo,
  });

  // STEP 9: Vessel master / captain contact channel
  const masterContact = await enrichMasterContact({
    ownerName:   r.owner_name   || null,
    managerName: r.manager_name || null,
    shipManager: r.ship_manager || null,
    flag:        r.flag || flag || null,
    imo,
    vesselName,
  });

  // STEP 10: Save (fire-and-forget)
  if (r.owner_name || r.email) {
    saveToBigQuery(imo, { ...r, port_agents: portAgents });
  }

  const final = {
    imo_number:  imo,
    vessel_name: vesselName,
    owner: {
      company_name:       r.owner_name    || null,
      company_type:       "OWNER",
      primary_email:      r.email         || null,
      secondary_email:    r.email_ops     || null,
      phone_primary:      r.phone         || null,
      phone_secondary:    r.phone_alt     || null,
      website:            r.website       || null,
      registered_address: r.address       || null,
      linkedin:           r.linkedin      || null,
      data_source:        r.source        || null,
    },
    operator:     r.operator_name ? { company_name: r.operator_name, company_type: "OPERATOR", data_source: "equasis" } : null,
    manager:      r.manager_name  ? { company_name: r.manager_name,  company_type: "MANAGER",  data_source: "equasis" } : null,
    ship_manager: r.ship_manager  ? { company_name: r.ship_manager,  company_type: "SHIP_MANAGER", data_source: "equasis" } : null,
    port_agents: portAgents,
    agent_org: agentOrg ? {
      company_name:       agentOrg.agent_org_name        || null,
      company_type:       agentOrg.agent_org_type        || "HUSBANDRY_AGENT",
      appointment_basis:  agentOrg.appointment_basis     || null,
      primary_email:      agentOrg.agent_org_email       || null,
      ops_email:          agentOrg.agent_org_email_ops   || null,
      phone:              agentOrg.agent_org_phone       || null,
      phone_24h:          agentOrg.agent_org_phone_24h   || null,
      website:            agentOrg.agent_org_website     || null,
      registered_address: agentOrg.agent_org_address     || null,
      services:           agentOrg.services              || [],
      regions_covered:    agentOrg.regions_covered       || [],
      confidence:         agentOrg.confidence            || null,
      data_source:        agentOrg.source                || "ai_web_search",
    } : null,
    master_contact: masterContact ? {
      contact_note:       masterContact.master_contact_note  || null,
      preferred_channel:  masterContact.preferred_channel    || null,
      contact_protocol:   masterContact.contact_protocol     || null,
      crew_dept: masterContact.crew_dept_company ? {
        company:          masterContact.crew_dept_company     || null,
        email:            masterContact.crew_dept_email       || null,
        phone:            masterContact.crew_dept_phone       || null,
      } : null,
      mrcc: masterContact.mrcc_name ? {
        name:             masterContact.mrcc_name             || null,
        country:          masterContact.mrcc_country          || null,
        email:            masterContact.mrcc_email            || null,
        phone:            masterContact.mrcc_phone            || null,
      } : null,
      sat_phone_public:   masterContact.sat_phone_public      || null,
      radio_call_sign:    masterContact.radio_call_sign        || null,
      inmarsat_number:    masterContact.inmarsat_number        || null,
      privacy_note:       "Direct personal contact details of the vessel master are not provided. Use the channels above to reach the vessel or its responsible parties.",
      confidence:         masterContact.confidence             || null,
      data_source:        masterContact.source                 || "ai_web_search",
    } : null,
    enrichment: {
      source:      r.source     || "none",
      confidence:  r.confidence || (r.owner_name || r.email ? 0.4 : 0),
      enriched_at: new Date().toISOString(),
    },
  };

  return cacheSet(enrichCache, cacheKey, final);
}

// ═════════════════════════════════════════════════════════════════
// STANDALONE: enrichPortAgents (for /agents endpoint)
// ═════════════════════════════════════════════════════════════════
async function enrichPortAgents({ portName, portCode, vesselType }) {
  return resolvePortAgents({ portName, portCode, vesselType, portContext: "current" });
}

// ═════════════════════════════════════════════════════════════════
// BATCH enrichment
// ═════════════════════════════════════════════════════════════════
async function batchEnrichArrivals(limit = 20) {
  logger.info(`[batch] Starting (limit=${limit})`);
  try {
    const [rows] = await bq.query({
      query: `
        SELECT DISTINCT a.imo_number, a.vessel_name, v.flag,
          a.location_to AS current_port, a.next_port_destination AS next_port, v.vessel_type
        FROM \`${PROJECT}.${DATASET}.f_vessel_arrivals\` a
        LEFT JOIN \`${PROJECT}.${DATASET}.d_vessel_company_map\` m ON m.imo_number = a.imo_number
        LEFT JOIN \`${PROJECT}.${DATASET}.d_vessel_master\` v ON v.imo_number = a.imo_number
        WHERE m.imo_number IS NULL AND a.imo_number IS NOT NULL
          AND a.arrival_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
        ORDER BY a.arrival_time DESC LIMIT @limit`,
      params: { limit }, location: BQ_LOCATION,
    });
    logger.info(`[batch] ${rows.length} vessels to enrich`);
    const results = [];
    for (const row of rows) {
      const imo = Number(row.imo_number);
      if (!imo) continue;
      await new Promise(r => setTimeout(r, 3000));
      const data = await enrichVesselContact(imo, {
        vesselName: row.vessel_name, flag: row.flag,
        currentPort: row.current_port, nextPort: row.next_port, vesselType: row.vessel_type,
      });
      results.push({ imo, found: !!(data?.owner?.primary_email || data?.owner?.company_name) });
    }
    logger.info(`[batch] Done: ${results.filter(r => r.found).length}/${results.length}`);
    return results;
  } catch (err) { logger.error("[batch] error:", err.message); return []; }
}

module.exports = { enrichVesselContact, batchEnrichArrivals, enrichPortAgents };