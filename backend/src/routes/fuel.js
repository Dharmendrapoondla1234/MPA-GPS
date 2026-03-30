// backend/src/routes/fuel.js
// Fuel efficiency endpoints — no external AI required
"use strict";
const express = require("express");
const router  = express.Router();
const { calculateFuelEfficiency, calculateFleetEfficiency } = require("../services/fuelEfficiency");
const { getLatestVessels, getVesselDetail } = require("../services/bigquery");
const logger  = require("../utils/logger");

// GET /api/fuel/vessel/:imo — single vessel efficiency
router.get("/vessel/:imo", async (req, res, next) => {
  try {
    const { imo } = req.params;
    if (!imo || isNaN(imo)) return res.status(400).json({ success: false, error: "Invalid IMO" });
    const vessel = await getVesselDetail(imo);
    if (!vessel) return res.status(404).json({ success: false, error: "Vessel not found" });
    const result = calculateFuelEfficiency(vessel);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// GET /api/fuel/fleet — fleet-wide efficiency summary
router.get("/fleet", async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const vessels = await getLatestVessels({ limit });
    const summary = calculateFleetEfficiency(vessels);
    // Also send individual scores for top low-efficiency vessels
    const individuals = vessels
      .map(v => calculateFuelEfficiency(v))
      .filter(Boolean)
      .sort((a, b) => a.efficiency_score - b.efficiency_score)
      .slice(0, 20);
    res.json({ success: true, data: { summary, low_efficiency: individuals } });
  } catch (err) { next(err); }
});

// GET /api/fuel/vessels/:imos — batch efficiency (comma-separated IMOs)
router.get("/vessels/:imos", async (req, res, next) => {
  try {
    const imoList = (req.params.imos || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 20);
    if (!imoList.length) return res.status(400).json({ success: false, error: "No IMOs provided" });
    const results = await Promise.all(
      imoList.map(imo => getVesselDetail(imo).then(v => v ? calculateFuelEfficiency(v) : null))
    );
    res.json({ success: true, data: results.filter(Boolean) });
  } catch (err) { next(err); }
});

module.exports = router;
