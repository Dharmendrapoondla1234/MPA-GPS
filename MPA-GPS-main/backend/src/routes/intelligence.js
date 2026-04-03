// src/routes/intelligence.js — v3
// All intelligence endpoints — pure Node.js pipeline
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");
const { runPipeline, runCompanyPipeline } = require("../services/intelligence/pipeline");
const { scoreVesselEfficiency }           = require("../services/intelligence/efficiencyScorer");
const db = require("../services/intelligence/db");

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([p, new Promise((_, r) => { t = setTimeout(() => r(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(t));
}

router.get("/vessel/:imo/contact", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo, 10);
    if (!imo || imo <= 0) return res.status(400).json({ success: false, error: "Invalid IMO" });
    const { owner, manager, operator, ship_manager, address, forceRefresh } = req.query;
    if (!owner && !manager && !operator && !ship_manager) {
      const stored = db.getIntelligenceByImo(imo);
      if (stored.length) {
        // Re-shape stored db records into the same format the pipeline returns so the
        // frontend's top_contacts / companies checks work correctly.
        const companies = stored.map(({ company, contacts }) => ({
          company:    company.name,
          role:       company.role || "unknown",
          domain:     company.domain || null,
          emails:     (contacts || []).map(c => ({ email: c.email, confidence: c.confidence || 70, source: c.source || "stored" })),
          phones:     [],
          addresses:  [],
          scraped:    false,
          mx_exists:  false,
        }));
        const allEmails = companies
          .flatMap(c => c.emails)
          .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
        return res.json({
          success:         true,
          imo_number:      imo,
          source:          "stored",
          cached:          true,
          companies,
          top_contacts:    allEmails.slice(0, 8),
          top_phones:      [],
          pipeline_ran_at: null,
        });
      }
    }
    const result = await withTimeout(runPipeline({ imo, owner, manager, operator, ship_manager, address, forceRefresh: forceRefresh==="true" }), 140_000, `pipeline IMO ${imo}`);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.post("/vessel/:imo/contact", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo, 10);
    if (!imo || imo <= 0) return res.status(400).json({ success: false, error: "Invalid IMO" });
    const { owner, manager, operator, ship_manager, address } = req.body || {};
    const result = await withTimeout(runPipeline({ imo, owner, manager, operator, ship_manager, address, forceRefresh: true }), 140_000, `pipeline IMO ${imo}`);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.get("/vessel/:imo/deep-research", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo, 10);
    if (!imo || imo <= 0) return res.status(400).json({ success: false, error: "Invalid IMO" });
    const { owner, manager, operator, ship_manager, address, forceRefresh } = req.query;
    const result = await withTimeout(runPipeline({ imo, owner, manager, operator, ship_manager, address, forceRefresh: forceRefresh==="true" }), 140_000, `deep-research IMO ${imo}`);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.get("/vessels/low-efficiency", async (req, res, next) => {
  try {
    const destination = (req.query.destination || "").toUpperCase();
    const threshold   = parseInt(req.query.threshold) || 40;
    const limit       = Math.min(parseInt(req.query.limit) || 50, 200);
    let vessels = [];
    try { const { getLatestVessels } = require("../services/bigquery"); vessels = await withTimeout(getLatestVessels({ limit:600 }), 30_000, "BQ") || []; }
    catch (err) { logger.warn(`[intel] BQ unavailable: ${err.message}`); return res.json({ success:true, count:0, opportunities:[], note:"BigQuery unavailable" }); }
    const opportunities = vessels.map(v => {
      const eff = scoreVesselEfficiency(v);
      if (!eff || eff.score >= threshold) return null;
      const dest = (v.next_port_destination||v.destination||v.location_to||"").toUpperCase();
      if (destination && !dest.includes(destination)) return null;
      const intel = v.imo_number ? db.getIntelligenceByImo(v.imo_number) : [];
      return { imo_number:v.imo_number, vessel_name:v.vessel_name, flag:v.flag, vessel_type:v.vessel_type, speed:v.speed, destination:v.next_port_destination||null, port_hours:v.port_time_hours||0, efficiency:eff, contact_intel:intel.length?intel:null, contact_url:`/api/vessel/${v.imo_number}/contact` };
    }).filter(Boolean).sort((a,b)=>a.efficiency.score-b.efficiency.score).slice(0,limit);
    res.json({ success:true, count:opportunities.length, total_scanned:vessels.length, threshold, destination_filter:destination||null, opportunities });
  } catch (err) { next(err); }
});

router.get("/intelligence/company", async (req, res, next) => {
  try {
    const { name, address } = req.query;
    if (!name || name.trim().length < 3) return res.status(400).json({ success:false, error:"?name= required" });
    const result = await withTimeout(runCompanyPipeline(name.trim(), address), 80_000, `company "${name}"`);
    if (!result) return res.status(404).json({ success:false, error:"No data found" });
    res.json({ success:true, data:result });
  } catch (err) { next(err); }
});

router.get("/intelligence/stats", (_req, res) => { res.json({ success:true, data:db.getStats() }); });

router.delete("/intelligence/cache/:imo", (req, res) => {
  db.clearCachedResult(req.params.imo);
  res.json({ success:true, message:`Cache cleared for IMO ${req.params.imo}` });
});

module.exports = router;