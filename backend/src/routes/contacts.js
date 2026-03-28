// backend/src/routes/contacts.js — MPA Contacts v2 (AI Enriched)
"use strict";
const express  = require("express");
const router   = express.Router();
const { getVesselContacts, getPortAgents, upsertContactData } = require("../services/contacts");
const { enrichVesselContact, batchEnrichArrivals }            = require("../services/contactEnricher");
const logger   = require("../utils/logger");

function normalizeCompany(c) {
  if (!c) return null;
  return {
    company_name:       c.company_name       || null,
    company_type:       c.company_type       || null,
    email:              c.primary_email      || c.email || null,
    // FIX: frontend reads email_secondary, not email_ops
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
    agent_id:           a.agent_id           || null,
    agent_name:         a.agent_name         || null,
    agency_company:     a.agency_company     || null,
    port_code:          a.port_code          || null,
    port_name:          a.port_name          || null,
    email:              a.email_primary      || null,
    email_ops:          a.email_ops          || null,
    phone:              a.phone_main         || null,
    phone_24h:          a.phone_24h          || null,
    vhf_channel:        a.vhf_channel        || null,
    vessel_type_served: a.vessel_type_served || "ALL",
    data_source:        a.data_source        || null,
  };
}

// GET /api/contacts/vessel/:imo
router.get("/vessel/:imo", async (req, res, next) => {
  try {
    const imo    = parseInt(req.params.imo, 10);
    const mmsi   = req.query.mmsi ? parseInt(req.query.mmsi, 10) : null;
    const name   = req.query.name || null;
    const enrich = req.query.enrich !== "false";

    if (!imo && !mmsi && !name) {
      return res.status(400).json({ success: false, error: "Provide imo, mmsi, or name" });
    }

    let bqData = null;
    try { bqData = await getVesselContacts({ imo, mmsi, name }); } catch {}

    const hasGoodData = bqData?.owner?.email || bqData?.owner?.phone;
    let enrichedData  = null;
    if (!hasGoodData && enrich && imo) {
      logger.info(`[contacts] Running AI enrichment for IMO ${imo}...`);
      enrichedData = await enrichVesselContact(imo, { vesselName: name });
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
        port_agents:  (bqData?.port_agents || []).map(normalizeAgent),
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

// GET /api/contacts/agents?port=SGSIN
router.get("/agents", async (req, res, next) => {
  try {
    const port = req.query.port || "";
    if (!port) return res.status(400).json({ success: false, error: "port required" });
    const agents = await getPortAgents({ portCode: port.toUpperCase(), vesselType: req.query.vesselType || "" });
    res.json({ success: true, count: agents.length, data: agents.map(normalizeAgent) });
  } catch (err) { next(err); }
});

// POST /api/contacts/enrich/:imo  — trigger enrichment manually
router.post("/enrich/:imo", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo, 10);
    if (!imo) return res.status(400).json({ success: false, error: "Invalid IMO" });
    const data = await enrichVesselContact(imo, { vesselName: req.body.vessel_name, flag: req.body.flag });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// POST /api/contacts/batch-enrich  — enrich all recent arrivals (run via Cloud Scheduler)
router.post("/batch-enrich", async (req, res, next) => {
  try {
    const limit = parseInt(req.body.limit || req.query.limit || 20, 10);
    res.json({ success: true, message: `Batch enrichment started for up to ${limit} vessels` });
    batchEnrichArrivals(limit).then(results => {
      logger.info(`[batch] Done: ${results.filter(r=>r.found).length}/${results.length} enriched`);
    });
  } catch (err) { next(err); }
});

// POST /api/contacts/vessel/:imo  — manual override
router.post("/vessel/:imo", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo, 10);
    if (!imo) return res.status(400).json({ success: false, error: "Invalid IMO" });
    await upsertContactData(imo, req.body);
    res.json({ success: true, message: "Contact data updated" });
  } catch (err) { next(err); }
});

module.exports = router;