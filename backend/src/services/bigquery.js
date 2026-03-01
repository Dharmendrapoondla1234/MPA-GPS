// backend/src/services/bigquery.js
// Production-ready: ADC locally, JSON credentials on Render

require("dotenv").config();
const { BigQuery } = require("@google-cloud/bigquery");
const logger = require("../utils/logger");

// Environment variables
const PROJECT = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET = process.env.BIGQUERY_DATASET || "MPA";
const TABLE = process.env.BIGQUERY_TABLE || "MPA_VesselPositionsSnapshot";
const FULL_TABLE = `\`${PROJECT}.${DATASET}.${TABLE}\``;

let bigquery;

// ===== Authentication Mode =====
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  // Production (Render / Cloud)
  try {
    const credentials = JSON.parse(
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    );

    bigquery = new BigQuery({
      credentials,
      projectId: credentials.project_id,
    });

    logger.info("✅ BigQuery using JSON credentials (Render/cloud mode)");
  } catch (error) {
    logger.error(
      "❌ Invalid GOOGLE_APPLICATION_CREDENTIALS_JSON:",
      error.message,
    );
    process.exit(1);
  }
} else {
  // Local development (ADC)
  bigquery = new BigQuery({
    projectId: PROJECT,
  });

  logger.info("✅ BigQuery using Application Default Credentials (local mode)");
}

// ===== Utility =====
function sanitize(str) {
  if (!str) return "";
  return String(str)
    .replace(/['"\\;`]/g, "")
    .substring(0, 100);
}

// ===== Get Latest Vessels =====
async function getLatestVessels({
  search = "",
  vesselType = "",
  speedMin = null,
  speedMax = null,
  limit = 5000,
} = {}) {
  const conditions = [];

  if (search) {
    const s = sanitize(search);
    conditions.push(
      `(LOWER(vessel_name) LIKE '%${s.toLowerCase()}%' 
        OR CAST(imo_number AS STRING) LIKE '%${s}%')`,
    );
  }

  if (vesselType) {
    conditions.push(`vessel_type = '${sanitize(vesselType)}'`);
  }

  if (speedMin !== null && !isNaN(speedMin)) {
    conditions.push(`speed >= ${parseFloat(speedMin)}`);
  }

  if (speedMax !== null && !isNaN(speedMax)) {
    conditions.push(`speed <= ${parseFloat(speedMax)}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const query = `
    SELECT
      vessel_name, imo_number, mmsi_number, flag, vessel_type, call_sign,
      latitude_degrees, longitude_degrees, speed, heading, course,
      vessel_length, vessel_breadth, gross_tonnage, deadweight,
      year_built, effective_timestamp
    FROM ${FULL_TABLE}
    ${where}
    ORDER BY effective_timestamp DESC
    LIMIT ${Math.min(parseInt(limit) || 5000, 10000)}
  `;

  const start = Date.now();
  const [rows] = await bigquery.query({ query });

  logger.info(
    `[BQ] getLatestVessels → ${rows.length} rows in ${Date.now() - start}ms`,
  );

  return rows;
}

// ===== Vessel History =====
async function getVesselHistory(imoNumber) {
  if (!imoNumber || isNaN(imoNumber)) {
    throw new Error("Invalid IMO number");
  }

  const query = `
    SELECT
      vessel_name, imo_number,
      latitude_degrees, longitude_degrees,
      speed, heading, effective_timestamp
    FROM ${FULL_TABLE}
    WHERE imo_number = ${parseInt(imoNumber)}
    ORDER BY effective_timestamp DESC
    LIMIT 500
  `;

  const [rows] = await bigquery.query({ query });
  return rows;
}

// ===== Vessel Types =====
async function getVesselTypes() {
  const query = `
    SELECT DISTINCT vessel_type
    FROM ${FULL_TABLE}
    WHERE vessel_type IS NOT NULL
    ORDER BY vessel_type
    LIMIT 100
  `;

  const [rows] = await bigquery.query({ query });

  return rows.map((r) => r.vessel_type).filter(Boolean);
}

// ===== Fleet Statistics =====
async function getFleetStats() {
  const query = `
    SELECT
      COUNT(*) AS total_vessels,
      COUNTIF(speed > 0.5) AS moving_vessels,
      COUNTIF(speed <= 0.5 OR speed IS NULL) AS stationary_vessels,
      ROUND(AVG(speed), 2) AS avg_speed,
      ROUND(MAX(speed), 2) AS max_speed,
      COUNT(DISTINCT vessel_type) AS vessel_type_count
    FROM ${FULL_TABLE}
  `;

  const [rows] = await bigquery.query({ query });

  return rows[0] || {};
}

// ===== Health Check =====
async function healthCheck() {
  try {
    const [rows] = await bigquery.query({ query: "SELECT 1 AS ok" });
    return rows[0]?.ok === 1;
  } catch (error) {
    logger.error("❌ BigQuery health check failed:", error.message);
    return false;
  }
}

module.exports = {
  getLatestVessels,
  getVesselHistory,
  getVesselTypes,
  getFleetStats,
  healthCheck,
};
