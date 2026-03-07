// backend/src/routes/ai_trajectory.js
// AI Trajectory Reconstruction & Prediction endpoint
// Serves gap analysis + metadata for frontend Catmull-Rom spline visualization

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");
const { BigQuery } = require("@google-cloud/bigquery");

const PROJECT        = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET        = process.env.BIGQUERY_DATASET    || "MPA";
const SNAPSHOT_TABLE = `\`${PROJECT}.${DATASET}.View_MPA_VesselPositionsSnapshot\``;
const BQ_LOCATION    = process.env.BIGQUERY_LOCATION   || "asia-southeast1";

let bigquery;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    bigquery = new BigQuery({ credentials: creds, projectId: creds.project_id, location: BQ_LOCATION });
  } catch(e) { logger.error("BQ credentials error:", e.message); }
} else {
  bigquery = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION });
}

// ── GET /api/ai/trajectory/:imo?hours=48 ─────────────────────
// Returns raw trail data + gap analysis metadata for AI reconstruction
router.get("/trajectory/:imo", async (req, res, next) => {
  try {
    const { imo } = req.params;
    if (!imo || isNaN(imo)) return res.status(400).json({ success: false, error: "Invalid IMO" });
    const hours = Math.min(parseInt(req.query.hours) || 48, 168);

    const query = `
      SELECT
        imo_number, vessel_name,
        latitude_degrees, longitude_degrees,
        speed, heading, course,
        effective_timestamp,
        TIMESTAMP_DIFF(
          effective_timestamp,
          LAG(effective_timestamp) OVER (PARTITION BY imo_number ORDER BY effective_timestamp),
          MINUTE
        ) AS gap_minutes_from_prev
      FROM ${SNAPSHOT_TABLE}
      WHERE imo_number = ${parseInt(imo)}
        AND effective_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${hours} HOUR)
        AND latitude_degrees IS NOT NULL
        AND longitude_degrees IS NOT NULL
      ORDER BY effective_timestamp ASC
      LIMIT 2000
    `;

    const [rows] = await bigquery.query({ query, location: BQ_LOCATION });

    // Analyze gaps for AI reconstruction
    const gaps = [];
    let totalGapMinutes = 0;
    let gapsOver30min = 0;

    rows.forEach((row, i) => {
      const gapMin = row.gap_minutes_from_prev ? Number(row.gap_minutes_from_prev) : 0;
      if (gapMin > 30 && gapMin < 360) {
        gaps.push({
          index: i,
          gap_minutes: Math.round(gapMin),
          from_lat: rows[i-1]?.latitude_degrees  ? Number(rows[i-1].latitude_degrees)  : null,
          from_lng: rows[i-1]?.longitude_degrees ? Number(rows[i-1].longitude_degrees) : null,
          to_lat:   Number(row.latitude_degrees),
          to_lng:   Number(row.longitude_degrees),
          confidence: Math.max(0.25, 1 - gapMin / 360),
        });
        totalGapMinutes += gapMin;
        gapsOver30min++;
      }
    });

    const data = rows.map(r => ({
      imo_number:         Number(r.imo_number),
      vessel_name:        r.vessel_name,
      latitude_degrees:   Number(r.latitude_degrees),
      longitude_degrees:  Number(r.longitude_degrees),
      speed:              Number(r.speed  || 0),
      heading:            Number(r.heading || 0),
      course:             Number(r.course  || 0),
      effective_timestamp: r.effective_timestamp?.value || String(r.effective_timestamp),
      gap_minutes_from_prev: r.gap_minutes_from_prev ? Math.round(Number(r.gap_minutes_from_prev)) : 0,
    }));

    res.json({
      success: true,
      count: data.length,
      hours,
      ai_analysis: {
        gaps_detected: gapsOver30min,
        total_gap_minutes: Math.round(totalGapMinutes),
        coverage_pct: rows.length > 0 ? Math.round((1 - totalGapMinutes / (hours * 60)) * 100) : 100,
        gaps,
        algorithm: "Catmull-Rom Cubic Spline Interpolation",
        description: "AIS gaps >30min are filled using vessel heading, speed, and trajectory curvature",
      },
      data,
    });
  } catch(err) {
    logger.error("[AI Trajectory]", err.message);
    next(err);
  }
});

// ── GET /api/ai/fleet-gaps — fleet-wide gap analysis ─────────
router.get("/fleet-gaps", async (req, res, next) => {
  try {
    const query = `
      SELECT
        vessel_name,
        imo_number,
        COUNT(*) as total_points,
        COUNTIF(gap_min > 30 AND gap_min < 360) as gaps_over_30min,
        MAX(CASE WHEN gap_min > 30 AND gap_min < 360 THEN gap_min END) as max_gap_min,
        AVG(CASE WHEN gap_min > 0 THEN gap_min END) as avg_interval_min
      FROM (
        SELECT
          vessel_name, imo_number,
          TIMESTAMP_DIFF(
            effective_timestamp,
            LAG(effective_timestamp) OVER (PARTITION BY imo_number ORDER BY effective_timestamp),
            MINUTE
          ) AS gap_min
        FROM ${SNAPSHOT_TABLE}
        WHERE effective_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
      )
      GROUP BY vessel_name, imo_number
      HAVING gaps_over_30min > 0
      ORDER BY gaps_over_30min DESC
      LIMIT 50
    `;
    const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
    res.json({ success: true, count: rows.length, data: rows.map(r => ({ vessel_name: r.vessel_name, imo_number: Number(r.imo_number), total_points: Number(r.total_points), gaps_over_30min: Number(r.gaps_over_30min), max_gap_min: r.max_gap_min ? Math.round(Number(r.max_gap_min)) : null, avg_interval_min: r.avg_interval_min ? Math.round(Number(r.avg_interval_min)) : null })) });
  } catch(err) { next(err); }
});

module.exports = router;
