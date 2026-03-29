// routes/intelligence.js  v2
// GET /api/vessel/:imo/contact     — full contact intelligence pipeline
// POST /api/vessel/:imo/contact    — same with JSON body
// GET /api/vessels/low-efficiency  — efficiency scoring + opportunity detection
// GET /api/intelligence/company    — single company pipeline
// GET /api/intelligence/stats      — DB stats
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");
const { runPipeline, runCompanyPipeline } = require("../services/intelligence/pipeline");
const { scoreVesselEfficiency }           = require("../services/intelligence/efficiencyScorer");
const db = require("../services/intelligence/db");

function withTimeout(p, ms, label = "op") {
  let t;
  return Promise.race([p, new Promise((_, r) => { t = setTimeout(() => r(new Error(`${label} timed out`)), ms); })])
    .finally(() => clearTimeout(t));
}

// ── GET /api/vessel/:imo/contact ──────────────────────────────────
router.get("/vessel/:imo/contact", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo, 10);
    if (!imo || imo <= 0) return res.status(400).json({ success: false, error: "Invalid IMO" });

    const { owner, manager, operator, ship_manager, address, forceRefresh } = req.query;

    if (!owner && !manager && !operator && !ship_manager) {
      const stored = db.getIntelligenceByImo(imo);
      if (stored.length > 0) return res.json({ success: true, imo_number: imo, source: "stored", data: stored });
      return res.status(400).json({ success: false, error: "Provide owner/manager/operator/ship_manager" });
    }

    const result = await withTimeout(
      runPipeline({ imo, owner, manager, operator, ship_manager, address, forceRefresh: forceRefresh === "true" }),
      130_000, `pipeline IMO ${imo}`
    );
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// ── POST /api/vessel/:imo/contact ─────────────────────────────────
router.post("/vessel/:imo/contact", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo, 10);
    if (!imo || imo <= 0) return res.status(400).json({ success: false, error: "Invalid IMO" });
    const { owner, manager, operator, ship_manager, address } = req.body || {};
    if (!owner && !manager && !operator && !ship_manager) {
      return res.status(400).json({ success: false, error: "Provide owner/manager/operator in body" });
    }
    const result = await withTimeout(
      runPipeline({ imo, owner, manager, operator, ship_manager, address, forceRefresh: true }),
      130_000, `pipeline IMO ${imo}`
    );
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// ── GET /api/vessels/low-efficiency ──────────────────────────────
router.get("/vessels/low-efficiency", async (req, res, next) => {
  try {
    const destination = (req.query.destination || "").toUpperCase();
    const threshold   = parseInt(req.query.threshold) || 40;
    const limit       = Math.min(parseInt(req.query.limit) || 50, 200);

    let vessels = [];
    try {
      const { getLatestVessels } = require("../services/bigquery");
      vessels = await withTimeout(getLatestVessels({ limit: 600 }), 30_000, "BQ") || [];
    } catch (err) {
      logger.warn(`[intelligence] BQ unavailable: ${err.message}`);
      return res.json({ success: true, count: 0, opportunities: [], note: "BigQuery unavailable" });
    }

    const opportunities = vessels
      .map(v => {
        const eff = scoreVesselEfficiency(v);
        if (!eff || eff.score >= threshold) return null;
        const dest = (v.next_port_destination || v.destination || v.location_to || "").toUpperCase();
        if (destination && !dest.includes(destination)) return null;
        const intel = v.imo_number ? db.getIntelligenceByImo(v.imo_number) : [];
        return {
          imo_number:   v.imo_number,
          vessel_name:  v.vessel_name,
          flag:         v.flag,
          vessel_type:  v.vessel_type,
          speed:        v.speed,
          destination:  v.next_port_destination || null,
          port_hours:   v.port_time_hours || 0,
          efficiency:   eff,
          contact_intel: intel.length > 0 ? intel : null,
          contact_url:  `/api/vessel/${v.imo_number}/contact`,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.efficiency.score - b.efficiency.score)
      .slice(0, limit);

    res.json({ success: true, count: opportunities.length, total_scanned: vessels.length, threshold, destination_filter: destination || null, opportunities });
  } catch (err) { next(err); }
});

// ── GET /api/intelligence/company ─────────────────────────────────
router.get("/intelligence/company", async (req, res, next) => {
  try {
    const { name, address } = req.query;
    if (!name || name.trim().length < 3) return res.status(400).json({ success: false, error: "?name= required" });
    const result = await withTimeout(runCompanyPipeline(name.trim(), address), 70_000, `company "${name}"`);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ── GET /api/intelligence/stats ───────────────────────────────────
router.get("/intelligence/stats", (_req, res) => {
  res.json({ success: true, data: db.getStats() });
});

module.exports = router;