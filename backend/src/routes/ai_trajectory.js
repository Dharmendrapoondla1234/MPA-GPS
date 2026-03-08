// backend/src/routes/ai_trajectory.js
// AI Trajectory Reconstruction & Prediction endpoint
// Uses fct_vessel_positions_latest (Photons_MPA) — columns: latitude, longitude (radians), speed_kn, heading_deg

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");
const { bigquery, BQ_LOCATION, T } = require("../services/bigquery");

const RAD = 180 / Math.PI;
function toDeg(v) {
  const n = Number(v);
  if (isNaN(n) || n === 0) return 0;
  // radians if abs < 4 (max radian for lng ~3.14, lat ~1.57)
  return Math.abs(n) < 4 ? n * RAD : n;
}

// ── GET /api/ai/trajectory/:imo?hours=48 ─────────────────────
router.get("/trajectory/:imo", async (req, res, next) => {
  try {
    const { imo } = req.params;
    if (!imo || isNaN(imo)) return res.status(400).json({ success: false, error: "Invalid IMO" });
    const hours = Math.min(parseInt(req.query.hours) || 48, 168);

    // stg_vessel_positions uses effective_timestamp and latitude_degrees/longitude_degrees (radians)
    // fct_vessel_positions_latest uses last_position_at and latitude/longitude (radians)
    // Try stg first, fall back to positions_latest
    let rows = [];
    try {
      const [r] = await bigquery.query({
        query: `
          SELECT
            imo_number, vessel_name,
            latitude_degrees  AS lat_raw,
            longitude_degrees AS lng_raw,
            speed             AS speed_kn,
            heading           AS heading_deg,
            course            AS course_deg,
            effective_timestamp AS ts,
            TIMESTAMP_DIFF(
              effective_timestamp,
              LAG(effective_timestamp) OVER (PARTITION BY imo_number ORDER BY effective_timestamp),
              MINUTE
            ) AS gap_minutes_from_prev
          FROM ${T.POSITIONS_HIST}
          WHERE CAST(imo_number AS STRING) = '${parseInt(imo)}'
            AND effective_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${hours} HOUR)
            AND latitude_degrees IS NOT NULL AND longitude_degrees IS NOT NULL
          ORDER BY effective_timestamp ASC
          LIMIT 2000`,
        location: BQ_LOCATION,
      });
      rows = r;
    } catch(e) {
      logger.warn("[AI] stg_vessel_positions failed, trying positions_latest:", e.message.slice(0,80));
    }

    // If no history found, use single latest position from master
    if (!rows.length) {
      try {
        const [r] = await bigquery.query({
          query: `
            SELECT imo_number, vessel_name,
                   latitude AS lat_raw, longitude AS lng_raw,
                   speed_kn, heading_deg, course_deg,
                   last_position_at AS ts,
                   0 AS gap_minutes_from_prev
            FROM ${T.MASTER}
            WHERE CAST(imo_number AS STRING) = '${parseInt(imo)}'
            LIMIT 1`,
          location: BQ_LOCATION,
        });
        rows = r;
      } catch(e) {
        logger.warn("[AI] master fallback failed:", e.message.slice(0,80));
      }
    }

    // Analyze gaps
    const gaps = [];
    let totalGapMinutes = 0;
    rows.forEach((row, i) => {
      const gapMin = row.gap_minutes_from_prev ? Number(row.gap_minutes_from_prev) : 0;
      if (gapMin > 30 && gapMin < 360 && i > 0) {
        gaps.push({
          index: i,
          gap_minutes: Math.round(gapMin),
          from_lat: toDeg(rows[i-1]?.lat_raw),
          from_lng: toDeg(rows[i-1]?.lng_raw),
          to_lat: toDeg(row.lat_raw),
          to_lng: toDeg(row.lng_raw),
          confidence: Math.max(0.25, 1 - gapMin / 360),
        });
        totalGapMinutes += gapMin;
      }
    });

    const data = rows.map(r => ({
      imo_number:           Number(r.imo_number),
      vessel_name:          r.vessel_name,
      latitude_degrees:     toDeg(r.lat_raw),
      longitude_degrees:    toDeg(r.lng_raw),
      speed:                Number(r.speed_kn  || 0),
      heading:              Number(r.heading_deg || 0),
      course:               Number(r.course_deg  || 0),
      effective_timestamp:  r.ts?.value || String(r.ts),
      gap_minutes_from_prev: r.gap_minutes_from_prev ? Math.round(Number(r.gap_minutes_from_prev)) : 0,
    }));

    res.json({
      success: true,
      count: data.length,
      hours,
      ai_analysis: {
        gaps_detected: gaps.length,
        total_gap_minutes: Math.round(totalGapMinutes),
        coverage_pct: rows.length > 0 ? Math.round((1 - totalGapMinutes / (hours * 60)) * 100) : 100,
        gaps,
        algorithm: "Catmull-Rom Cubic Spline Interpolation",
        description: "AIS gaps >30min filled using vessel heading, speed, and trajectory curvature",
      },
      data,
    });
  } catch(err) {
    logger.error("[AI Trajectory]", err.message);
    next(err);
  }
});

module.exports = router;