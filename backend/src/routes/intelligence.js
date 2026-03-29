// routes/intelligence.js
// GET /api/vessel/:imo/contact         → enriched company contact intelligence
// GET /api/vessels/low-efficiency      → low-efficiency vessels + contact details
// GET /api/intelligence/company        → run pipeline for a company name
// GET /api/intelligence/stats          → pipeline DB stats
"use strict";

const express   = require("express");
const router    = express.Router();
const logger    = require("../utils/logger");
const { runPipeline, runCompanyPipeline } = require("../services/intelligence/pipeline");
const { scoreVesselEfficiency }           = require("../services/intelligence/efficiencyScorer");
const db        = require("../services/intelligence/db");

// ── helpers ──────────────────────────────────────────────────────
function withTimeout(promise, ms, label = "operation") {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

// ═══════════════════════════════════════════════════════════════════
// GET /api/vessel/:imo/contact
// Accepts Equasis company data from query/body, runs full pipeline
// ─────────────────────────────────────────────────────────────────
// Query params:
//   owner        - registered owner name
//   manager      - ISM manager name
//   operator     - operator name
//   ship_manager - ship manager name
//   forceRefresh - "true" to bypass cache
//
// Also works with JSON body (POST): { owner, manager, operator, ship_manager }
// ═══════════════════════════════════════════════════════════════════
router.get("/vessel/:imo/contact", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo, 10);
    if (!imo || imo <= 0) {
      return res.status(400).json({ success: false, error: "Invalid IMO number" });
    }

    const owner        = req.query.owner        || null;
    const manager      = req.query.manager      || null;
    const operator     = req.query.operator     || null;
    const ship_manager = req.query.ship_manager || null;
    const forceRefresh = req.query.forceRefresh === "true";

    // If no company names provided, check what we already have stored
    const stored = db.getIntelligenceByImo(imo);
    const hasStored = stored.length > 0;

    if (!owner && !manager && !operator && !ship_manager) {
      if (hasStored) {
        return res.json({
          success:    true,
          imo_number: imo,
          source:     "stored",
          data:       stored,
        });
      }
      return res.status(400).json({
        success: false,
        error:   "Provide at least one of: owner, manager, operator, ship_manager",
      });
    }

    logger.info(`[intelligence-route] GET /vessel/${imo}/contact owner="${owner}" mgr="${manager}"`);

    const result = await withTimeout(
      runPipeline({ imo, owner, manager, operator, ship_manager, forceRefresh }),
      120_000,
      `pipeline IMO ${imo}`
    );

    res.json({ success: true, ...result });
  } catch (err) {
    logger.warn(`[intelligence-route] /vessel/:imo/contact error: ${err.message}`);
    next(err);
  }
});

// POST variant — accept Equasis payload as JSON body
router.post("/vessel/:imo/contact", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo, 10);
    if (!imo || imo <= 0) return res.status(400).json({ success: false, error: "Invalid IMO" });

    const { owner, manager, operator, ship_manager } = req.body || {};
    if (!owner && !manager && !operator && !ship_manager) {
      return res.status(400).json({ success: false, error: "Provide owner/manager/operator in request body" });
    }

    logger.info(`[intelligence-route] POST /vessel/${imo}/contact`);
    const result = await withTimeout(
      runPipeline({ imo, owner, manager, operator, ship_manager, forceRefresh: true }),
      120_000, `pipeline IMO ${imo}`
    );
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/vessels/low-efficiency?destination=SGSIN
// Returns vessels with efficiency < 40 (and optionally filtered by dest)
// Pulls live vessel data, scores each, returns opportunities
// ═══════════════════════════════════════════════════════════════════
router.get("/vessels/low-efficiency", async (req, res, next) => {
  try {
    const destination = (req.query.destination || "").toUpperCase();
    const threshold   = parseInt(req.query.threshold) || 40;
    const limit       = Math.min(parseInt(req.query.limit) || 50, 200);

    // Pull latest vessels from BigQuery via the existing bigquery service
    let vessels = [];
    try {
      const { getLatestVessels } = require("../services/bigquery");
      const raw = await withTimeout(getLatestVessels({ limit: 500 }), 30_000, "BQ vessels");
      vessels = Array.isArray(raw) ? raw : [];
    } catch (err) {
      logger.warn(`[intelligence-route] BQ error: ${err.message}`);
      // If BigQuery unavailable, return empty with explanation
      return res.json({
        success:   true,
        count:     0,
        threshold,
        destination_filter: destination || null,
        opportunities: [],
        note: "BigQuery unavailable — cannot score vessels without live tracking data",
      });
    }

    // Score each vessel
    const opportunities = [];
    for (const v of vessels) {
      const efficiency = scoreVesselEfficiency(v);
      if (!efficiency) continue;

      const destMatch = !destination
        || (v.next_port_destination || v.destination || v.location_to || "")
            .toUpperCase().includes(destination);

      if (efficiency.score < threshold && destMatch) {
        // Attach stored contact intelligence if we have it
        const intel = v.imo_number ? db.getIntelligenceByImo(v.imo_number) : [];

        opportunities.push({
          imo_number:       v.imo_number,
          vessel_name:      v.vessel_name,
          flag:             v.flag,
          vessel_type:      v.vessel_type,
          speed:            v.speed,
          destination:      v.next_port_destination || v.destination || null,
          port_time_hours:  v.port_time_hours || v.hours_in_port_so_far || 0,
          efficiency,
          contact_intel:    intel.length > 0 ? intel : null,
          contact_url:      `/api/vessel/${v.imo_number}/contact`,
        });
      }
    }

    // Sort by efficiency score ascending (least efficient first)
    opportunities.sort((a, b) => a.efficiency.score - b.efficiency.score);
    const paged = opportunities.slice(0, limit);

    logger.info(`[intelligence-route] low-efficiency: ${opportunities.length} found, returning ${paged.length}`);

    res.json({
      success:    true,
      count:      paged.length,
      total_scanned: vessels.length,
      threshold,
      destination_filter: destination || null,
      opportunities: paged,
    });
  } catch (err) {
    logger.warn(`[intelligence-route] /vessels/low-efficiency error: ${err.message}`);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/intelligence/company?name=ABC+Shipping
// Run pipeline for a company name alone
// ═══════════════════════════════════════════════════════════════════
router.get("/intelligence/company", async (req, res, next) => {
  try {
    const name = req.query.name || "";
    if (!name || name.trim().length < 3) {
      return res.status(400).json({ success: false, error: "Provide ?name=Company+Name" });
    }
    logger.info(`[intelligence-route] company lookup: "${name}"`);
    const result = await withTimeout(
      runCompanyPipeline(name.trim()),
      60_000, `company pipeline "${name}"`
    );
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/intelligence/stats
// ═══════════════════════════════════════════════════════════════════
router.get("/intelligence/stats", (_req, res) => {
  res.json({ success: true, data: db.getStats() });
});

module.exports = router;