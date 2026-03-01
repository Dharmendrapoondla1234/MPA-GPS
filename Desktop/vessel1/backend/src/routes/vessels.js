// backend/src/routes/vessels.js
const express = require("express");
const router = express.Router();
const { validateVesselQuery } = require("../middleware/validate");
const logger = require("../utils/logger");
const {
  getLatestVessels,
  getVesselHistory,
  getVesselTypes,
  getFleetStats,
} = require("../services/bigquery");

// ── GET /api/vessels ───────────────────────────────────────────────
// Params: search, vesselType, speedMin, speedMax, limit
router.get("/vessels", validateVesselQuery, async (req, res, next) => {
  try {
    const {
      search = "",
      vesselType = "",
      speedMin,
      speedMax,
      limit,
    } = req.query;

    const raw = await getLatestVessels({
      search,
      vesselType,
      speedMin: speedMin !== undefined ? parseFloat(speedMin) : null,
      speedMax: speedMax !== undefined ? parseFloat(speedMax) : null,
      limit: limit ? parseInt(limit) : 5000,
    });

    // Normalise — convert BigQuery types to plain JS, handle BigQueryTimestamp
    const data = raw.map((v) => ({
      vessel_name: v.vessel_name || null,
      imo_number: v.imo_number != null ? Number(v.imo_number) : null,
      mmsi_number: v.mmsi_number != null ? Number(v.mmsi_number) : null,
      flag: v.flag || null,
      vessel_type: v.vessel_type || null,
      call_sign: v.call_sign || null,
      latitude_degrees:
        v.latitude_degrees != null ? Number(v.latitude_degrees) : null,
      longitude_degrees:
        v.longitude_degrees != null ? Number(v.longitude_degrees) : null,
      speed: v.speed != null ? Number(v.speed) : 0,
      heading: v.heading != null ? Number(v.heading) : 0,
      course: v.course != null ? Number(v.course) : 0,
      vessel_length: v.vessel_length != null ? Number(v.vessel_length) : null,
      vessel_breadth:
        v.vessel_breadth != null ? Number(v.vessel_breadth) : null,
      gross_tonnage: v.gross_tonnage != null ? Number(v.gross_tonnage) : null,
      deadweight: v.deadweight != null ? Number(v.deadweight) : null,
      year_built: v.year_built != null ? Number(v.year_built) : null,
      effective_timestamp: v.effective_timestamp
        ? v.effective_timestamp.value || String(v.effective_timestamp)
        : null,
    }));

    logger.info(`GET /api/vessels → ${data.length} vessels`, {
      search,
      vesselType,
    });
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/vessels/:imo/history ──────────────────────────────────
router.get("/vessels/:imo/history", async (req, res, next) => {
  try {
    const { imo } = req.params;
    if (!imo || isNaN(imo)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid IMO number" });
    }
    const hours = parseInt(req.query.hours) || 24;
    const history = await getVesselHistory(imo, hours);
    res.json({ success: true, count: history.length, data: history });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/vessels/types ─────────────────────────────────────────
router.get("/vessel-types", async (req, res, next) => {
  try {
    const types = await getVesselTypes();
    res.json({ success: true, data: types });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/stats ─────────────────────────────────────────────────
router.get("/stats", async (req, res, next) => {
  try {
    const stats = await getFleetStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
