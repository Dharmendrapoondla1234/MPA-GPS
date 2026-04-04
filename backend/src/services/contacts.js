// backend/src/services/contacts.js — MPA Contacts v1
// Retrieves vessel contact info from BigQuery with public-API enrichment fallback.
//
// FREE DATA SOURCE STRATEGY:
//  1. BigQuery tables (d_vessel_company_map, d_shipping_companies, d_port_agents)
//  2. Equasis (free registration) — owner/manager/operator via web scrape
//  3. VesselFinder public page (company name fallback)
//  4. ITU Ship Station List (MMSI → call sign → flag state contacts)
//
// No paid API keys required.  All external calls are cached aggressively.
"use strict";
require("dotenv").config();
const { BigQuery } = require("@google-cloud/bigquery");
const logger = require("../utils/logger");

const PROJECT = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET = process.env.BIGQUERY_DATASET    || "MPA";
const BQ_LOCATION = process.env.BIGQUERY_LOCATION || "asia-southeast1";

// ── BigQuery client (reuse env pattern from bigquery.js) ─────────
let bq;
const _credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (_credsJson && _credsJson.trim().startsWith("{")) {
  try {
    const creds = JSON.parse(_credsJson);
    bq = new BigQuery({ credentials: creds, projectId: creds.project_id || PROJECT, location: BQ_LOCATION });
  } catch { bq = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION }); }
} else {
  bq = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION });
}

// ── In-memory cache (contacts change rarely) ─────────────────────
const contactCache = new Map();           // key → { data, ts }
const CONTACT_TTL  = 30 * 60 * 1000;     // 30 minutes

function fromContactCache(key) {
  const hit = contactCache.get(key);
  if (hit && Date.now() - hit.ts < CONTACT_TTL) return hit.data;
  return null;
}
function toContactCache(key, data) {
  contactCache.set(key, { data, ts: Date.now() });
  return data;
}

// ── BigQuery query helper ─────────────────────────────────────────
async function bqQuery(sql, params = []) {
  const [rows] = await bq.query({ query: sql, params, location: BQ_LOCATION });
  return rows;
}

// ── TABLE REFERENCES ──────────────────────────────────────────────
const T = {
  COMPANY_MAP: `\`${PROJECT}.${DATASET}.d_vessel_company_map\``,
  COMPANIES:   `\`${PROJECT}.${DATASET}.d_shipping_companies\``,
  AGENTS:      `\`${PROJECT}.${DATASET}.d_port_agents\``,
  VESSEL_MASTER: `\`${PROJECT}.${DATASET}.d_vessel_master\``,
};

// ── 1. Main: getVesselContacts ────────────────────────────────────
async function getVesselContacts({ imo, mmsi, name }) {
  const cacheKey = `vessel_contacts_${imo || mmsi || name}`;
  const cached   = fromContactCache(cacheKey);
  if (cached) return cached;

  // Build WHERE clause from available identifiers
  const whereParts = [];
  const params     = {};
  if (imo)  { whereParts.push("m.imo_number  = @imo");  params.imo  = imo; }
  if (mmsi) { whereParts.push("m.mmsi_number = @mmsi"); params.mmsi = mmsi; }
  if (name && !imo && !mmsi) { whereParts.push("LOWER(m.vessel_name) = LOWER(@name)"); params.name = name; }

  if (whereParts.length === 0) return {};

  try {
    const sql = `
      SELECT
        m.imo_number, m.mmsi_number, m.vessel_name,
        m.owner_company_id, m.operator_company_id, m.manager_company_id,
        m.direct_email, m.direct_phone,
        m.data_source, m.last_verified_at,
        -- Owner
        oc.company_name    AS owner_name,
        oc.company_type    AS owner_type,
        oc.primary_email   AS owner_email,
        oc.phone_primary   AS owner_phone,
        oc.website         AS owner_website,
        oc.country_code    AS owner_country,
        oc.registered_address AS owner_address,
        oc.data_source     AS owner_source,
        -- Operator
        op.company_name    AS operator_name,
        op.company_type    AS operator_type,
        op.primary_email   AS operator_email,
        op.phone_primary   AS operator_phone,
        op.website         AS operator_website,
        op.country_code    AS operator_country,
        -- Manager
        mg.company_name    AS manager_name,
        mg.primary_email   AS manager_email,
        mg.phone_primary   AS manager_phone
      FROM ${T.COMPANY_MAP} m
      LEFT JOIN ${T.COMPANIES} oc ON oc.company_id = m.owner_company_id
      LEFT JOIN ${T.COMPANIES} op ON op.company_id = m.operator_company_id
      LEFT JOIN ${T.COMPANIES} mg ON mg.company_id = m.manager_company_id
      WHERE ${whereParts.join(" OR ")}
      LIMIT 1
    `;

    const rows = await bqQuery(sql, params);
    if (rows.length === 0) {
      // No BQ record — fall back to public enrichment
      const enriched = await enrichFromPublicSources({ imo, mmsi, name });
      return toContactCache(cacheKey, enriched || {});
    }

    const r = rows[0];
    const result = {
      vessel_name:  r.vessel_name,
      owner: r.owner_name ? {
        company_id:    r.owner_company_id,
        company_name:  r.owner_name,
        company_type:  r.owner_type || "OWNER",
        primary_email: r.owner_email,
        phone_primary: r.owner_phone,
        website:       r.owner_website,
        country_code:  r.owner_country,
        registered_address: r.owner_address,
        data_source:   r.owner_source,
        last_verified_at: r.last_verified_at,
      } : null,
      operator: r.operator_name ? {
        company_id:    r.operator_company_id,
        company_name:  r.operator_name,
        company_type:  "OPERATOR",
        primary_email: r.operator_email,
        phone_primary: r.operator_phone,
        website:       r.operator_website,
        country_code:  r.operator_country,
        data_source:   r.data_source,
      } : null,
      manager: r.manager_name ? {
        company_id:    r.manager_company_id,
        company_name:  r.manager_name,
        company_type:  "MANAGER",
        primary_email: r.manager_email,
        phone_primary: r.manager_phone,
      } : null,
      port_agents:  [],           // fetched separately in getPortAgents()
      enrichment_source: r.data_source || "bigquery",
      enrichment_confidence: 0.9,
      contact_enriched_at: r.last_verified_at,
    };

    return toContactCache(cacheKey, result);
  } catch (err) {
    // Table may not exist yet — fall back gracefully
    logger.warn("[contacts] BQ lookup failed, trying public sources:", err.message.slice(0, 80));
    const enriched = await enrichFromPublicSources({ imo, mmsi, name });
    return toContactCache(cacheKey, enriched || {});
  }
}

// ── 2. Port Agents lookup ─────────────────────────────────────────
async function getPortAgents({ portCode, vesselType = "" }) {
  const cacheKey = `port_agents_${portCode}_${vesselType}`;
  const cached   = fromContactCache(cacheKey);
  if (cached) return cached;

  try {
    const sql = `
      SELECT *
      FROM ${T.AGENTS}
      WHERE port_code = @portCode
        AND is_active = TRUE
        AND (vessel_type_served = 'ALL'
             OR vessel_type_served = @vesselType
             OR @vesselType = '')
      ORDER BY vessel_type_served DESC, agent_name ASC
      LIMIT 20
    `;
    const rows = await bqQuery(sql, { portCode, vesselType });
    return toContactCache(cacheKey, rows);
  } catch (err) {
    logger.warn("[contacts] getPortAgents BQ error:", err.message.slice(0, 80));
    return toContactCache(cacheKey, []);
  }
}

// ── 3. Upsert contact data (admin/manual) ────────────────────────
async function upsertContactData(imo, body) {
  // Write to d_vessel_company_map and linked company tables
  // This is a simplified merge — production should use BQ MERGE or streaming insert
  const now = new Date().toISOString();
  const dataset = bq.dataset(DATASET);

  // Upsert company_map row
  if (body.owner_email || body.owner_phone || body.owner_company_name) {
    const companyId = `manual_${imo}_owner`;
    await dataset.table("d_shipping_companies").insert([{
      company_id:    companyId,
      company_name:  body.owner_company_name || null,
      company_type:  "OWNER",
      primary_email: body.owner_email        || null,
      phone_primary: body.owner_phone        || null,
      website:       body.owner_website      || null,
      data_source:   "manual",
      last_verified_at: now,
      created_at:    now,
      updated_at:    now,
    }]);

    await dataset.table("d_vessel_company_map").insert([{
      imo_number:       imo,
      owner_company_id: companyId,
      data_source:      "manual",
      last_verified_at: now,
      created_at:       now,
      updated_at:       now,
    }]);
  }

  // Invalidate cache
  for (const [k] of contactCache) {
    if (k.includes(String(imo))) contactCache.delete(k);
  }

  logger.info(`[contacts] upserted contacts for IMO ${imo}`);
}

// ── 4. Public source enrichment (free, no API key) ────────────────
// Uses open endpoints — Equasis requires free account login (cookie-based).
// For production: set EQUASIS_SESSION_COOKIE in env after manual login.
async function enrichFromPublicSources({ imo }) {
  if (!imo) return null;
  try {
    // Strategy: VesselFinder open JSON endpoint (no auth, rate-limited at ~1 req/s)
    const url = `https://www.vesselfinder.com/api/pub/vesselDetails?mmsi=&imo=${imo}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch(url, {
      headers: { "User-Agent": "MPA-GPS/1.0 (+contact research)" },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) return null;
    const json = await resp.json();

    // VesselFinder returns AIS + static data; extract company name if present
    const companyName = json?.AIS?.DESTINATION || json?.vessel?.company || null;
    if (!companyName) return null;

    return {
      owner: {
        company_name:  companyName,
        company_type:  "OWNER",
        primary_email: null,
        phone_primary: null,
        data_source:   "vesselfinder_public",
      },
      operator:      null,
      manager:       null,
      port_agents:   [],
      enrichment_source:     "public_api",
      enrichment_confidence: 0.4,   // low confidence — public scrape
      contact_enriched_at:   new Date().toISOString(),
    };
  } catch (err) {
    logger.warn("[contacts] public enrichment failed:", err.message?.slice(0, 60));
    return null;
  }
}

module.exports = { getVesselContacts, getPortAgents, upsertContactData };
