// backend/src/routes/contacts.js — MPA Contacts v5
// Unified vessel-contact API matching the spec + original endpoints
"use strict";
const express  = require("express");
const router   = express.Router();
const { getVesselContacts, getPortAgents, upsertContactData } = require("../services/contacts");
const { enrichVesselContact, batchEnrichArrivals, enrichPortAgents } = require("../services/contactEnricher");
const { getDBStats } = require("../services/portAgentDB");
const logger   = require("../utils/logger");

// ── Timeout helper ────────────────────────────────────────────────
const ENRICH_TIMEOUT_MS = 70_000; // 70s — enrichment pipeline has 10 steps

function withTimeout(promise, ms, label) {
  let timer;
  const race = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, race]).finally(() => clearTimeout(timer));
}

// ── Normalizers ───────────────────────────────────────────────────
function normalizeCompany(c) {
  if (!c) return null;
  return {
    company_name:       c.company_name       || null,
    company_type:       c.company_type       || null,
    email:              c.primary_email      || c.email || null,
    email_secondary:    c.secondary_email    || c.email_ops || null,
    phone:              c.phone_primary      || c.phone || null,
    phone_secondary:    c.phone_secondary    || c.phone_alt || null,
    website:            c.website            || null,
    registered_address: c.registered_address || c.address || null,
    linkedin:           c.linkedin           || null,
    data_source:        c.data_source        || null,
    last_verified_at:   c.last_verified_at   || null,
  };
}

function normalizeAgent(a) {
  if (!a) return null;
  return {
    agent_id:           a.agent_id              || null,
    agent_name:         a.agent_name            || null,
    agency_company:     a.agency_company        || null,
    port_code:          a.port_code             || null,
    port_name:          a.port_name             || null,
    email:              a.email_primary || a.email || null,
    email_ops:          a.email_ops             || null,
    phone:              a.phone_main  || a.phone || null,
    phone_24h:          a.phone_24h             || null,
    vhf_channel:        a.vhf_channel           || null,
    vessel_type_served: a.vessel_type_served || a.vessel_types_served || "ALL",
    services:           a.services              || [],
    website:            a.website               || null,
    port_context:       a.port_context          || null,
    confidence:         a.confidence            || null,
    data_source:        a.data_source || a.source || null,
  };
}

// Format to spec: { agent_name, contact: { email, phone }, confidence_score }
function agentToSpec(a) {
  const n = normalizeAgent(a);
  return {
    agent_name:       n.agency_company || n.agent_name || null,
    contact_person:   n.agent_name !== n.agency_company ? n.agent_name : null,
    contact: { email: n.email, phone: n.phone, phone_24h: n.phone_24h, vhf: n.vhf_channel },
    port_code:        n.port_code,
    port_name:        n.port_name,
    port_context:     n.port_context,
    services:         n.services,
    website:          n.website,
    confidence_score: n.confidence ? `${Math.round(n.confidence * 100)}%` : null,
    data_source:      n.data_source,
  };
}

async function resolveContacts({ imo, mmsi, name, enrich, currentPort, nextPort, vesselType, forceRefresh }) {
  // Normalise identifiers — ensure integers
  const imoInt  = imo  ? parseInt(imo,  10) || null : null;
  const mmsiInt = mmsi ? parseInt(mmsi, 10) || null : null;

  // Try BigQuery first
  let bqData = null;
  try { bqData = await getVesselContacts({ imo: imoInt, mmsi: mmsiInt, name }); } catch {}

  const hasGoodData = bqData?.owner?.company_name || bqData?.owner?.email;
  let enrichedData  = null;

  // Only enrich when we have a real positive IMO — never enrich with null/0
  // (enriching with imo=null/0 would cache-collide for all vessels without an IMO)
  const enrichableImo = imoInt && imoInt > 0 ? imoInt : null;
  if ((!hasGoodData || forceRefresh) && enrich && (enrichableImo || mmsiInt || name)) {
    logger.info(`[contacts] AI enrichment IMO ${enrichableImo || "(name/mmsi)"}...`);
    try {
      enrichedData = await withTimeout(
        enrichVesselContact(enrichableImo, { vesselName: name, currentPort, nextPort, vesselType, forceRefresh }),
        ENRICH_TIMEOUT_MS,
        `enrichment IMO ${enrichableImo}`
      );
    } catch (err) { logger.warn(`[contacts] enrichment error: ${err.message}`); }
  }

  // Port agents: enriched > BQ > standalone AI search
  let portAgents = enrichedData?.port_agents || bqData?.port_agents || [];
  if (!portAgents.length && (currentPort || nextPort) && enrich) {
    try {
      portAgents = await withTimeout(
        enrichPortAgents({ portName: currentPort || nextPort, portCode: currentPort || nextPort, vesselType: vesselType || null }),
        30_000,
        "port agent enrichment"
      );
    } catch (err) { logger.warn("[contacts] port agent error:", err.message); }
  }

  const final = enrichedData || bqData || {};
  const owner = final.owner || bqData?.owner || null;

  return { final, owner, portAgents, enrichedData, bqData };
}

// ═════════════════════════════════════════════════════════════════
// SPEC ENDPOINT: GET /api/vessel-contact?imo=XXXX
// Returns the exact format specified in the requirements doc
// ═════════════════════════════════════════════════════════════════
router.get("/vessel-contact", async (req, res, next) => {
  try {
    const imo         = parseInt(req.query.imo, 10) || null;
    const mmsi        = parseInt(req.query.mmsi, 10) || null;
    const name        = req.query.name || null;
    const enrich      = req.query.enrich !== "false";
    const currentPort = req.query.currentPort || req.query.port || null;
    const nextPort    = req.query.nextPort || null;
    const vesselType  = req.query.vesselType || null;

    if (!imo && !mmsi && !name) {
      return res.status(400).json({ success: false, error: "Provide imo, mmsi, or name" });
    }

    const { final, owner, portAgents, enrichedData } = await resolveContacts({
      imo, mmsi, name, enrich, currentPort, nextPort, vesselType,
    });

    const nc = normalizeCompany(owner);

    res.json({
      success: true,
      vessel: {
        name: final.vessel_name || name || null,
        imo:  String(imo || ""),
        mmsi: String(mmsi || ""),
      },
      operator: nc ? {
        name: nc.company_name,
        type: nc.company_type,
        contact: { email: nc.email, phone: nc.phone, website: nc.website },
        registered_address: nc.registered_address,
        data_source: nc.data_source,
      } : null,
      manager: final.manager ? {
        name: final.manager.company_name,
        type: final.manager.company_type,
        data_source: "equasis",
      } : null,
      ship_manager: final.ship_manager ? {
        name: final.ship_manager.company_name,
        data_source: "equasis",
      } : null,
      port: {
        current: currentPort || null,
        next:    nextPort    || null,
      },
      port_agents: portAgents.map(agentToSpec),
      captain_contact: "Available via port agent or operator only — direct contact not provided.",
      enrichment: {
        source:       final.enrichment?.source      || "bigquery",
        confidence:   final.enrichment?.confidence  ?? null,
        confidence_pct: final.enrichment?.confidence ? `${Math.round(final.enrichment.confidence * 100)}%` : null,
        last_checked: final.enrichment?.enriched_at || null,
        pipeline_ran: !!enrichedData,
      },
    });
  } catch (err) { logger.error("[vessel-contact] error:", err.message); next(err); }
});

// ═════════════════════════════════════════════════════════════════
// ORIGINAL: GET /api/contacts/vessel/:imo
// ═════════════════════════════════════════════════════════════════
router.get("/vessel/:imo", async (req, res, next) => {
  try {
    const imo         = parseInt(req.params.imo, 10);
    const mmsi        = req.query.mmsi   ? parseInt(req.query.mmsi, 10) : null;
    const name        = req.query.name   || null;
    const enrich      = req.query.enrich !== "false";
    const currentPort = req.query.currentPort || null;
    const nextPort    = req.query.nextPort    || null;
    const vesselType  = req.query.vesselType  || null;
    const forceRefresh= req.query.forceRefresh === "true";

    if (!imo && !mmsi && !name) {
      return res.status(400).json({ success: false, error: "Provide imo, mmsi, or name" });
    }

    const { final, owner, portAgents, enrichedData, bqData } = await resolveContacts({
      imo, mmsi, name, enrich, currentPort, nextPort, vesselType, forceRefresh,
    });

    res.json({
      success: true,
      data: {
        imo_number:   imo,
        vessel_name:  final.vessel_name || name || null,
        owner:        normalizeCompany(owner),
        operator:     normalizeCompany(final.operator  || bqData?.operator),
        manager:      normalizeCompany(final.manager   || bqData?.manager),
        ship_manager: normalizeCompany(final.ship_manager),
        port_agents:  portAgents.map(normalizeAgent),
        enrichment: {
          source:       final.enrichment?.source      || bqData?.enrichment_source || "bigquery",
          confidence:   final.enrichment?.confidence  ?? bqData?.enrichment_confidence ?? null,
          last_checked: final.enrichment?.enriched_at || bqData?.contact_enriched_at  || null,
          pipeline_ran: !!enrichedData,
        },
      },
    });
  } catch (err) { logger.error("[contacts] error:", err.message); next(err); }
});

// ═════════════════════════════════════════════════════════════════
// GET /api/contacts/agents?port=SGSIN&portName=Singapore
// ═════════════════════════════════════════════════════════════════
router.get("/agents", async (req, res, next) => {
  try {
    const port       = req.query.port     || "";
    const portName   = req.query.portName || port;
    const vesselType = req.query.vesselType || "";
    const useAI      = req.query.ai !== "false";

    if (!port && !portName) {
      return res.status(400).json({ success: false, error: "port or portName required" });
    }

    // BQ first
    let agents = [];
    try { agents = await getPortAgents({ portCode: port.toUpperCase(), vesselType }); } catch {}

    // Fallback: static DB + AI
    if (!agents.length && useAI) {
      agents = await enrichPortAgents({ portName: portName || port, portCode: port, vesselType });
    }

    res.json({
      success: true,
      count: agents.length,
      source: agents[0]?.data_source?.includes("ai") ? "ai_enriched" : agents[0]?.data_source || "bigquery",
      data: agents.map(normalizeAgent),
    });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════
// POST /api/contacts/enrich/:imo  — force re-run pipeline
// ═════════════════════════════════════════════════════════════════
router.post("/enrich/:imo", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo, 10);
    if (!imo) return res.status(400).json({ success: false, error: "Invalid IMO" });
    const data = await enrichVesselContact(imo, {
      vesselName:  req.body.vessel_name,
      flag:        req.body.flag,
      currentPort: req.body.current_port,
      nextPort:    req.body.next_port,
      vesselType:  req.body.vessel_type,
      forceRefresh: true,
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════
// POST /api/contacts/batch-enrich
// ═════════════════════════════════════════════════════════════════
router.post("/batch-enrich", async (req, res, next) => {
  try {
    const limit = parseInt(req.body.limit || req.query.limit || 20, 10);
    res.json({ success: true, message: `Batch enrichment started for up to ${limit} vessels` });
    batchEnrichArrivals(limit).then(results => {
      logger.info(`[batch] Done: ${results.filter(r => r.found).length}/${results.length}`);
    });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════
// POST /api/contacts/vessel/:imo  — manual override
// ═════════════════════════════════════════════════════════════════
router.post("/vessel/:imo", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo, 10);
    if (!imo) return res.status(400).json({ success: false, error: "Invalid IMO" });
    await upsertContactData(imo, req.body);
    res.json({ success: true, message: "Contact data updated" });
  } catch (err) { next(err); }
});

// ── GET /api/contacts/db-stats ────────────────────────────────────
// Returns stats about the built-in port agent database
router.get("/db-stats", (req, res) => {
  try {
    const stats = getDBStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;