// backend/src/routes/ai_contact.js
// POST /api/ai-contact/enrich
//
// Server-side proxy for the contact enrichment pipeline.
// Fixes the two errors shown in the screenshots:
//   1. "Failed to fetch"  — old frontend called api.anthropic.com directly (CORS block).
//      Frontend now calls THIS backend route instead.
//   2. "Request timed out" — pipeline ran serially with no per-step timeout.
//      Steps now run in parallel with individual time-boxes. ~20s vs ~70s.
//
// NO Claude / Anthropic API used anywhere in this file.
// Sources: Equasis · MarineTraffic · VesselFinder · website scraping · port agent DB
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");
const { enrichVesselContact }  = require("../services/contactEnricher");
const { lookupPortAgents, rankAgents } = require("../services/portAgentDB");
const { findCompanyContactsWeb, searchMaritimeDBsForIMO, scrapeCompanyWebsite } = require("../services/webContactFinder");

const T_EQUASIS     = 25_000;
const T_MT_VF       = 10_000;
const T_WEB_CONTACT =  8_000;
const T_PORT_AGENTS =  5_000;
const T_TOTAL       = 55_000;

function withTimeout(promise, ms, label) {
  let timer;
  const race = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, race]).finally(() => clearTimeout(timer));
}

async function safe(label, ms, fn) {
  try { return await withTimeout(fn(), ms, label); }
  catch (err) { logger.warn(`[ai-contact] step "${label}": ${err.message}`); return null; }
}

function first(...values) { return values.find(v => v != null && v !== "") ?? null; }

function addSource(current, next) {
  if (!next) return current;
  const parts = current ? current.split("+") : [];
  next.split("+").forEach(p => { if (p && !parts.includes(p)) parts.push(p); });
  return parts.join("+");
}

function buildResult(r, portAgents) {
  return {
    vessel_name:  r.vessel_name  || null,
    imo:          r.imo ? String(r.imo) : null,
    flag:         r.flag         || null,
    vessel_type:  r.vessel_type  || null,
    built_year:   null,
    owner: r.owner_name ? {
      company_name: r.owner_name,
      address:      r.address   || null,
      phone:        r.phone     || null,
      phone_alt:    r.phone_alt || null,
      email:        r.email     || null,
      email_ops:    r.email_ops || null,
      website:      r.website   || null,
      linkedin:     r.linkedin  || null,
      data_source:  r.source    || null,
    } : null,
    ism_manager:  r.manager_name  ? { company_name: r.manager_name,  data_source: r.source } : null,
    ship_manager: r.ship_manager  ? { company_name: r.ship_manager,  data_source: r.source } : null,
    operator:     r.operator_name ? { company_name: r.operator_name, data_source: r.source } : null,
    key_personnel: [],
    port_agents: (portAgents || []).map(a => ({
      agency_name: a.agent_name || a.agency_company || null,
      port:        a.port_name  || a.port_code      || null,
      email:       a.email_primary || a.email       || null,
      phone:       a.phone_main   || a.phone        || null,
      phone_24h:   a.phone_24h    || null,
      website:     a.website      || null,
    })).filter(a => a.agency_name),
    master_contact: null,
    sources_used: r.source ? r.source.split("+").filter(Boolean) : [],
    confidence:   r.confidence || (r.owner_name ? 0.5 : 0.2),
    notes: null,
  };
}

async function runEnrichment({ imoInt, name, curPort, nextPort, vtype }) {
  const r = {
    imo: imoInt, vessel_name: name || null, flag: null, vessel_type: vtype || null,
    owner_name: null, manager_name: null, ship_manager: null, operator_name: null,
    address: null, email: null, email_ops: null, phone: null, phone_alt: null,
    website: null, linkedin: null, source: "", confidence: 0,
  };

  // PHASE 1 — Equasis + MarineTraffic/VesselFinder in parallel
  const [eqResult, webResult] = await Promise.all([
    imoInt
      ? safe("equasis", T_EQUASIS, () =>
          enrichVesselContact(imoInt, {
            vesselName: name || null, currentPort: curPort || null,
            nextPort: nextPort || null, vesselType: vtype || null,
          })
        )
      : Promise.resolve(null),

    imoInt
      ? safe("marinetraffic+vesselfinder", T_MT_VF, () =>
          searchMaritimeDBsForIMO(imoInt, name)
        )
      : Promise.resolve(null),
  ]);

  if (eqResult) {
    const owner = eqResult.owner || {};
    r.vessel_name   = first(r.vessel_name,   eqResult.vessel_name);
    r.flag          = first(r.flag,          eqResult.flag);
    r.owner_name    = first(r.owner_name,    owner.company_name,    eqResult.owner_name);
    r.manager_name  = first(r.manager_name,  eqResult.manager?.company_name,     eqResult.manager_name);
    r.ship_manager  = first(r.ship_manager,  eqResult.ship_manager?.company_name, eqResult.ship_manager);
    r.operator_name = first(r.operator_name, eqResult.operator?.company_name,     eqResult.operator_name);
    r.address       = first(r.address,       owner.registered_address, eqResult.address);
    r.email         = first(r.email,         owner.primary_email,      eqResult.email);
    r.email_ops     = first(r.email_ops,     owner.secondary_email,    eqResult.email_ops);
    r.phone         = first(r.phone,         owner.phone_primary,      eqResult.phone);
    r.website       = first(r.website,       owner.website,            eqResult.website);
    r.confidence    = Math.max(r.confidence, eqResult.enrichment?.confidence || 0.5);
    r.source        = addSource(r.source, eqResult.enrichment?.source || "equasis");
  }

  if (webResult) {
    r.owner_name   = first(r.owner_name,   webResult.owner_name);
    r.manager_name = first(r.manager_name, webResult.manager_name);
    r.vessel_name  = first(r.vessel_name,  webResult.vessel_name);
    r.flag         = first(r.flag,         webResult.flag);
    r.confidence   = Math.max(r.confidence, webResult.confidence || 0.4);
    r.source       = addSource(r.source, webResult.source || "marinetraffic");
  }

  // PHASE 2 — Company contact scrape (only if we have a name and missing contact info)
  const companyName = r.owner_name || r.manager_name;
  if (companyName && (!r.email || !r.phone || !r.website)) {
    const webContact = await safe("web-contact", T_WEB_CONTACT, () =>
      findCompanyContactsWeb(companyName, r.flag)
    );
    if (webContact) {
      r.email      = first(r.email,     webContact.email);
      r.email_ops  = first(r.email_ops, webContact.email_secondary);
      r.phone      = first(r.phone,     webContact.phone);
      r.website    = first(r.website,   webContact.website);
      r.confidence = Math.max(r.confidence, webContact.confidence || 0);
      r.source     = addSource(r.source, webContact.source || "scrape");
    }

    // If we have a website but still no email, scrape contact page directly
    if (r.website && !r.email) {
      const domain  = r.website.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
      const scraped = await safe("website-scrape", T_WEB_CONTACT, () =>
        scrapeCompanyWebsite(domain)
      );
      if (scraped) {
        r.email     = first(r.email,     scraped.email);
        r.email_ops = first(r.email_ops, scraped.email_secondary);
        r.phone     = first(r.phone,     scraped.phone);
        r.source    = addSource(r.source, "scrape");
      }
    }
  }

  // PHASE 3 — Port agents from static DB (fast, no network)
  const seen       = new Set();
  const portAgents = [];

  for (const portKey of [curPort, nextPort].filter(Boolean)) {
    const agents = await safe("port-agents", T_PORT_AGENTS, () => {
      const found = lookupPortAgents({ portCode: portKey, portName: portKey, vesselType: vtype || null });
      return Promise.resolve(
        found?.length ? rankAgents(found, { vesselType: vtype, ownerName: r.owner_name }) : []
      );
    });
    if (agents?.length) {
      for (const a of agents) {
        const k = (a.agent_name || a.agency_company || "").toLowerCase();
        if (k && !seen.has(k)) { seen.add(k); portAgents.push(a); }
      }
    }
  }

  // Merge port agents from enricher result (already fetched above)
  for (const a of eqResult?.port_agents || []) {
    const k = (a.agent_name || a.agency_company || "").toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); portAgents.push(a); }
  }

  if (!r.owner_name && !r.vessel_name && !r.manager_name && !portAgents.length) {
    return null;
  }

  return buildResult(r, portAgents);
}

// POST /api/ai-contact/enrich
router.post("/enrich", async (req, res) => {
  const { imo, mmsi, name, curPort, nextPort, vtype } = req.body || {};

  if (!imo && !mmsi && !name) {
    return res.status(400).json({ success: false, error: "Provide imo, mmsi, or name" });
  }

  const imoInt = imo ? parseInt(imo, 10) || null : null;
  logger.info(`[ai-contact] enrich IMO=${imoInt} name="${name || ""}" port="${curPort || ""}"`);

  try {
    const result = await withTimeout(
      runEnrichment({ imoInt, name, curPort, nextPort, vtype }),
      T_TOTAL,
      "full enrichment"
    );

    if (!result) {
      return res.status(502).json({
        success: false,
        error: "No data returned from any source. Please check the IMO number is valid.",
      });
    }

    logger.info(
      `[ai-contact] done IMO=${imoInt} owner="${result.owner?.company_name || "—"}" ` +
      `conf=${result.confidence} sources=${result.sources_used?.join("+") || "none"}`
    );

    return res.json({ success: true, data: result });

  } catch (err) {
    logger.warn(`[ai-contact] pipeline error: ${err.message}`);
    const isTimeout = err.message.includes("timed out");
    return res.status(isTimeout ? 504 : 502).json({
      success: false,
      error: isTimeout
        ? "Request timed out — the enrichment pipeline took too long. Please try again."
        : `Enrichment failed: ${err.message}`,
    });
  }
});

module.exports = router;