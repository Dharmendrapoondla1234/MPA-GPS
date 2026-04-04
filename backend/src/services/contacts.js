// backend/src/services/contacts.js — MPA Contacts v6  (FIXED)
//
// ROOT-CAUSE FIX: previous version queried d_vessel_company_map /
// d_shipping_companies (dbt tables that don't exist), fell back to a
// VesselFinder call that returns no company data, and showed nothing.
//
// NEW STRATEGY — reads tables that actually exist in the MPA dataset:
//  1. MPA_Company_Contacts  – upserted by the intelligence pipeline
//  2. MPA_Equasis_Data      – upserted by enricher after Equasis login
// Falls through gracefully when BQ is unconfigured / tables are empty.
"use strict";
require("dotenv").config();
const { BigQuery } = require("@google-cloud/bigquery");
const logger = require("../utils/logger");

const PROJECT     = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET     = process.env.BIGQUERY_DATASET    || "MPA";
const BQ_LOCATION = process.env.BIGQUERY_LOCATION   || "asia-southeast1";

let bq;
try {
  const _c = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (_c && _c.trim().startsWith("{")) {
    const creds = JSON.parse(_c);
    bq = new BigQuery({ credentials: creds, projectId: creds.project_id || PROJECT, location: BQ_LOCATION });
  } else {
    bq = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION });
  }
} catch { bq = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION }); }

const T_CONTACTS    = `\`${PROJECT}.${DATASET}.MPA_Company_Contacts\``;
const T_EQUASIS     = `\`${PROJECT}.${DATASET}.MPA_Equasis_Data\``;
const T_PORT_AGENTS = `\`${PROJECT}.${DATASET}.MPA_Port_Agent_Contacts\``;

const _cache = new Map();
const TTL    = 30 * 60 * 1000;

function cacheGet(k)    { const h = _cache.get(k); return (h && Date.now()-h.ts < TTL) ? h.v : null; }
function cacheSet(k, v) { _cache.set(k, { v, ts: Date.now() }); return v; }
function cacheInvalidate(imo) { for (const k of _cache.keys()) { if (k.includes(String(imo))) _cache.delete(k); } }

async function bqQuery(sql, params = {}) {
  try {
    const opts = { query: sql, location: BQ_LOCATION };
    if (Object.keys(params).length) opts.params = params;
    const [rows] = await bq.query(opts);
    return rows || [];
  } catch (err) {
    logger.debug(`[contacts] BQ: ${err.message?.slice(0, 100)}`);
    return [];
  }
}

function shapeCompany(r, type) {
  if (!r) return null;
  return {
    company_name:       r.company_name       || null,
    company_type:       r.company_type       || type || "OWNER",
    primary_email:      r.email              || null,
    secondary_email:    r.email_secondary    || null,
    phone_primary:      r.phone              || null,
    phone_secondary:    r.phone_secondary    || null,
    website:            r.website            || null,
    registered_address: r.registered_address || null,
    linkedin:           r.linkedin           || null,
    data_source:        r.data_source        || "bigquery",
    last_verified_at:   r.last_verified_at   || null,
    confidence:         r.confidence         || null,
  };
}

async function getVesselContacts({ imo, mmsi, name }) {
  if (!imo && !mmsi && !name) return {};
  const key    = `vc_${imo||mmsi||name}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const imoStr = imo ? String(imo) : null;
  let owner = null, operator = null, manager = null, ship_manager = null;

  // 1. MPA_Company_Contacts (populated by the intelligence pipeline)
  if (imoStr) {
    const rows = await bqQuery(
      `SELECT * FROM ${T_CONTACTS} WHERE imo_number = @imo ORDER BY upserted_at DESC LIMIT 30`,
      { imo: imoStr }
    );
    for (const r of rows) {
      const t = (r.company_type || "").toUpperCase();
      if (!owner        && (t==="OWNER"||t==="REGISTERED_OWNER")) owner        = shapeCompany(r,"OWNER");
      if (!operator     && t==="OPERATOR")                         operator     = shapeCompany(r,"OPERATOR");
      if (!manager      && (t==="ISM_MANAGER"||t==="MANAGER"))     manager      = shapeCompany(r,"MANAGER");
      if (!ship_manager && t==="SHIP_MANAGER")                     ship_manager = shapeCompany(r,"SHIP_MANAGER");
    }
  }

  // 2. MPA_Equasis_Data fallback (company names without email/phone)
  if (!owner && imoStr) {
    const rows = await bqQuery(
      `SELECT * FROM ${T_EQUASIS} WHERE imo_number = @imo ORDER BY fetched_at DESC LIMIT 1`,
      { imo: imoStr }
    );
    if (rows.length) {
      const r = rows[0];
      if (r.owner_name || r.registered_owner) {
        owner = {
          company_name:    r.registered_owner || r.owner_name || null,
          company_type:    "OWNER",
          primary_email:   null, phone_primary: null,
          website: null, registered_address: null,
          data_source: "equasis", last_verified_at: r.fetched_at || null, confidence: 0.85,
        };
      }
      if (!operator    && r.operator_name) operator     = { company_name: r.operator_name, company_type:"OPERATOR",     data_source:"equasis" };
      if (!manager     && r.ism_manager)   manager      = { company_name: r.ism_manager,   company_type:"MANAGER",      data_source:"equasis" };
      if (!ship_manager&& r.ship_manager)  ship_manager = { company_name: r.ship_manager,  company_type:"SHIP_MANAGER", data_source:"equasis" };
    }
  }

  const result = {
    vessel_name: name || null,
    owner, operator, manager, ship_manager,
    port_agents: [],
    enrichment_source:     owner ? (owner.data_source || "bigquery") : "none",
    enrichment_confidence: owner?.confidence || null,
    contact_enriched_at:   owner?.last_verified_at || null,
  };
  return cacheSet(key, result);
}

async function getPortAgents({ portCode, vesselType = "" }) {
  if (!portCode) return [];
  const key    = `pa_${portCode}_${vesselType}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  const rows = await bqQuery(
    `SELECT * FROM ${T_PORT_AGENTS}
     WHERE port_code = @portCode
       AND (@vesselType = '' OR vessel_type_served = 'ALL' OR vessel_type_served = @vesselType)
     ORDER BY confidence DESC LIMIT 20`,
    { portCode: portCode.toUpperCase(), vesselType: vesselType || "" }
  );
  return cacheSet(key, rows);
}

async function upsertContactData(imo, body) {
  if (!imo) return;
  cacheInvalidate(imo);
  const now    = new Date().toISOString();
  const imoStr = String(imo);
  const rows   = [];

  const push = (type, name, email, phone, website, address) => {
    if (!name && !email) return;
    rows.push({
      imo_number: imoStr, company_name: name||null, company_type: type,
      email: email||null, email_secondary: null, phone: phone||null,
      phone_secondary: null, website: website||null, registered_address: address||null,
      linkedin: null, confidence: 0.95, data_source: "manual",
      last_verified_at: now, upserted_at: now,
    });
  };

  push("OWNER",        body.owner_company_name,        body.owner_email,    body.owner_phone,    body.owner_website,    body.owner_address);
  push("OPERATOR",     body.operator_company_name,     body.operator_email, body.operator_phone, body.operator_website, null);
  push("ISM_MANAGER",  body.manager_company_name,      body.manager_email,  body.manager_phone,  null,                  null);
  push("SHIP_MANAGER", body.ship_manager_company_name, null,                null,                null,                  null);

  if (rows.length) {
    try {
      await bq.query({ query: `DELETE FROM ${T_CONTACTS} WHERE imo_number='${imoStr}' AND data_source='manual'`, location: BQ_LOCATION });
      await bq.dataset(DATASET).table("MPA_Company_Contacts").insert(rows);
      logger.info(`[contacts] upserted ${rows.length} rows IMO ${imoStr}`);
    } catch (err) { logger.warn("[contacts] upsert error:", err.message?.slice(0,100)); }
  }
}

module.exports = { getVesselContacts, getPortAgents, upsertContactData };
