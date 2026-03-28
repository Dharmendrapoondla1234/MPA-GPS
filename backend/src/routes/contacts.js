// backend/src/routes/contacts.js — MPA Contacts v3 (AI Enriched + Port Agent Intelligence)
"use strict";
const express  = require("express");
const router   = express.Router();
const { getVesselContacts, getPortAgents, upsertContactData } = require("../services/contacts");
const { enrichVesselContact, batchEnrichArrivals, enrichPortAgents } = require("../services/contactEnricher");
const logger   = require("../utils/logger");

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
    agent_id:            a.agent_id           || null,
    agent_name:          a.agent_name         || null,
    agency_company:      a.agency_company     || null,
    port_code:           a.port_code          || null,
    port_name:           a.port_name          || null,
    email:               a.email_primary      || a.email || null,
    email_ops:           a.email_ops          || null,
    phone:               a.phone_main         || a.phone || null,
    phone_24h:           a.phone_24h          || null,
    vhf_channel:         a.vhf_channel        || null,
    vessel_type_served:  a.vessel_type_served || a.vessel_types_served || "ALL",
    services:            a.services           || [],
    website:             a.website            || null,
    port_context:        a.port_context       || null, // "current" | "next"
    confidence:          a.confidence         || null,
    data_source:         a.data_source        || a.source || null,
  };
}

// ── GET /api/contacts/vessel/:imo ─────────────────────────────────
router.get("/vessel/:imo", async (req, res, next) => {
  try {
    const imo         = parseInt(req.params.imo, 10);
    const mmsi        = req.query.mmsi   ? parseInt(req.query.mmsi, 10) : null;
    const name        = req.query.name   || null;
    const enrich      = req.query.enrich !== "false";
    const currentPort = req.query.currentPort || null;
    const nextPort    = req.query.nextPort    || null;
    const vesselType  = req.query.vesselType  || null;

    if (!imo && !mmsi && !name) {
      return res.status(400).json({ success: false, error: "Provide imo, mmsi, or name" });
    }

    // Try BigQuery first
    let bqData = null;
    try { bqData = await getVesselContacts({ imo, mmsi, name }); } catch {}

    // Run AI enrichment if no good data
    const hasGoodData = bqData?.owner?.company_name || bqData?.owner?.email || bqData?.owner?.phone;
    let enrichedData  = null;
    if (!hasGoodData && enrich && imo) {
      logger.info(`[contacts] Running AI enrichment for IMO ${imo}...`);
      try {
        enrichedData = await enrichVesselContact(imo, {
          vesselName: name,
          currentPort,
          nextPort,
          vesselType,
        });
      } catch (err) {
        logger.warn(`[contacts] Enrichment error IMO ${imo}:`, err.message);
      }
    }

    // Port agents: use enriched data, or fall back to BQ, or AI-search separately
    let portAgents = enrichedData?.port_agents || bqData?.port_agents || [];

    // If no agents found yet but we have a port, do a targeted AI search
    if (!portAgents.length && (currentPort || nextPort) && enrich) {
      const searchPort = currentPort || nextPort;
      logger.info(`[contacts] AI port agent search for: ${searchPort}`);
      try {
        const aiAgents = await enrichPortAgents({
          portName:   searchPort,
          portCode:   searchPort,
          vesselType: vesselType || null,
        });
        portAgents = aiAgents;
      } catch (err) {
        logger.warn("[contacts] port agent AI error:", err.message);
      }
    }

    const final = enrichedData || bqData || {};
    const owner = final.owner || bqData?.owner || null;

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
  } catch (err) {
    logger.error("[contacts] error:", err.message);
    next(err);
  }
});

// ── GET /api/contacts/agents?port=SGSIN ───────────────────────────
// First checks BigQuery, then falls back to AI search
router.get("/agents", async (req, res, next) => {
  try {
    const port       = req.query.port || "";
    const portName   = req.query.portName || port;
    const vesselType = req.query.vesselType || "";
    const useAI      = req.query.ai !== "false";

    if (!port && !portName) {
      return res.status(400).json({ success: false, error: "port or portName required" });
    }

    // Try BigQuery first
    let agents = [];
    try {
      agents = await getPortAgents({ portCode: port.toUpperCase(), vesselType });
    } catch {}

    // Fall back to AI search if no BQ results
    if (!agents.length && useAI) {
      logger.info(`[contacts] AI port agent fallback for: ${portName || port}`);
      try {
        agents = await enrichPortAgents({ portName: portName || port, portCode: port, vesselType });
      } catch (err) {
        logger.warn("[contacts] AI agents error:", err.message);
      }
    }

    res.json({
      success: true,
      count: agents.length,
      source: agents.length && !agents[0]?.data_source?.includes("ai") ? "bigquery" : "ai_enriched",
      data: agents.map(normalizeAgent),
    });
  } catch (err) { next(err); }
});

// ── POST /api/contacts/enrich/:imo ────────────────────────────────
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
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ── POST /api/contacts/batch-enrich ──────────────────────────────
router.post("/batch-enrich", async (req, res, next) => {
  try {
    const limit = parseInt(req.body.limit || req.query.limit || 20, 10);
    res.json({ success: true, message: `Batch enrichment started for up to ${limit} vessels` });
    batchEnrichArrivals(limit).then(results => {
      logger.info(`[batch] Done: ${results.filter(r => r.found).length}/${results.length} enriched`);
    });
  } catch (err) { next(err); }
});

// ── POST /api/contacts/vessel/:imo (manual override) ─────────────
router.post("/vessel/:imo", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo, 10);
    if (!imo) return res.status(400).json({ success: false, error: "Invalid IMO" });
    await upsertContactData(imo, req.body);
    res.json({ success: true, message: "Contact data updated" });
  } catch (err) { next(err); }
});

module.exports = router;