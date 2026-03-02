// backend/src/services/bigquery.js
require("dotenv").config();
const { BigQuery } = require("@google-cloud/bigquery");
const logger = require("../utils/logger");

const PROJECT     = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET     = process.env.BIGQUERY_DATASET    || "MPA";
const TABLE       = process.env.BIGQUERY_TABLE      || "MPA_VesselPositionsSnapshot";
const FULL_TABLE  = `\`${PROJECT}.${DATASET}.${TABLE}\``;
const USERS_TABLE = `\`${PROJECT}.${DATASET}.MPA_Users\``;

// BigQuery location — MUST match where your dataset is created
const BQ_LOCATION = process.env.BIGQUERY_LOCATION || "US";

let bigquery;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    bigquery = new BigQuery({
      credentials,
      projectId: credentials.project_id,
      location:  BQ_LOCATION,
    });
    logger.info("✅ BigQuery using JSON credentials");
  } catch (e) {
    logger.error("❌ Invalid GOOGLE_APPLICATION_CREDENTIALS_JSON:", e.message);
    process.exit(1);
  }
} else {
  bigquery = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION });
  logger.info("✅ BigQuery using Application Default Credentials");
}

function sanitize(str) {
  if (!str) return "";
  return String(str).replace(/['"\\;`]/g, "").substring(0, 200);
}

// ════════════════════════════════════════════
//  USER AUTH — BigQuery MPA_Users table
// ════════════════════════════════════════════

async function getUserByEmail(email) {
  const em = sanitize(email.toLowerCase().trim());
  const query = `
    SELECT id, name, email, password_hash, role, avatar, created_at, last_login
    FROM ${USERS_TABLE}
    WHERE LOWER(email) = '${em}'
      AND is_active = TRUE
    LIMIT 1
  `;
  const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
  return rows[0] || null;
}

async function createUser({ id, name, email, passwordHash, role, avatar }) {
  const query = `
    INSERT INTO ${USERS_TABLE}
      (id, name, email, password_hash, role, avatar, created_at, last_login, is_active)
    VALUES (
      '${sanitize(id)}',
      '${sanitize(name)}',
      '${sanitize(email.toLowerCase().trim())}',
      '${sanitize(passwordHash)}',
      '${sanitize(role)}',
      '${sanitize(avatar)}',
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP(),
      TRUE
    )
  `;
  await bigquery.query({ query, location: BQ_LOCATION });
  logger.info(`[BQ] User created: ${email}`);
}

async function updateLastLogin(email) {
  const em = sanitize(email.toLowerCase().trim());
  const query = `
    UPDATE ${USERS_TABLE}
    SET last_login = CURRENT_TIMESTAMP()
    WHERE LOWER(email) = '${em}'
  `;
  try {
    await bigquery.query({ query, location: BQ_LOCATION });
  } catch (e) {
    logger.warn(`[BQ] updateLastLogin failed: ${e.message}`);
  }
}

// ════════════════════════════════════════════
//  VESSEL QUERIES
// ════════════════════════════════════════════

async function getLatestVessels({
  search="", vesselType="", speedMin=null, speedMax=null, limit=5000
} = {}) {
  const conditions = [];
  if (search) {
    const s = sanitize(search);
    conditions.push(
      `(LOWER(vessel_name) LIKE '%${s.toLowerCase()}%'` +
      ` OR CAST(imo_number AS STRING) LIKE '%${s}%'` +
      ` OR CAST(mmsi_number AS STRING) LIKE '%${s}%')`
    );
  }
  if (vesselType) conditions.push(`vessel_type = '${sanitize(vesselType)}'`);
  if (speedMin !== null && !isNaN(speedMin)) conditions.push(`speed >= ${parseFloat(speedMin)}`);
  if (speedMax !== null && !isNaN(speedMax)) conditions.push(`speed <= ${parseFloat(speedMax)}`);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const query = `
    WITH ranked AS (
      SELECT
        vessel_name, imo_number, mmsi_number, flag, vessel_type, call_sign,
        latitude_degrees, longitude_degrees, speed, heading, course,
        vessel_length, vessel_breadth, gross_tonnage, deadweight,
        year_built, effective_timestamp,
        ROW_NUMBER() OVER (PARTITION BY imo_number ORDER BY effective_timestamp DESC) AS rn
      FROM ${FULL_TABLE}
      ${where}
    )
    SELECT
      vessel_name, imo_number, mmsi_number, flag, vessel_type, call_sign,
      latitude_degrees, longitude_degrees, speed, heading, course,
      vessel_length, vessel_breadth, gross_tonnage, deadweight,
      year_built, effective_timestamp
    FROM ranked
    WHERE rn = 1
      AND imo_number IS NOT NULL
      AND latitude_degrees IS NOT NULL
      AND longitude_degrees IS NOT NULL
    ORDER BY effective_timestamp DESC
    LIMIT ${Math.min(parseInt(limit) || 5000, 10000)}
  `;

  const start = Date.now();
  const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
  logger.info(`[BQ] getLatestVessels → ${rows.length} distinct vessels in ${Date.now()-start}ms`);
  return rows;
}

async function getVesselHistory(imoNumber, hours = 24) {
  if (!imoNumber || isNaN(imoNumber)) throw new Error("Invalid IMO number");
  const h = Math.min(parseInt(hours) || 24, 168);
  const query = `
    SELECT
      vessel_name, imo_number, mmsi_number,
      latitude_degrees, longitude_degrees,
      speed, heading, course, effective_timestamp
    FROM ${FULL_TABLE}
    WHERE imo_number = ${parseInt(imoNumber)}
      AND effective_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${h} HOUR)
      AND latitude_degrees IS NOT NULL
      AND longitude_degrees IS NOT NULL
    ORDER BY effective_timestamp ASC
    LIMIT 2000
  `;
  const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
  return rows;
}

async function getVesselTypes() {
  const query = `
    SELECT DISTINCT vessel_type FROM ${FULL_TABLE}
    WHERE vessel_type IS NOT NULL ORDER BY vessel_type LIMIT 100
  `;
  const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
  return rows.map(r => r.vessel_type).filter(Boolean);
}

async function getFleetStats() {
  const query = `
    WITH latest AS (
      SELECT imo_number, mmsi_number, vessel_name, flag, call_sign, speed, vessel_type,
        ROW_NUMBER() OVER (PARTITION BY imo_number ORDER BY effective_timestamp DESC) AS rn
      FROM ${FULL_TABLE}
      WHERE imo_number IS NOT NULL
    )
    SELECT
      COUNT(DISTINCT imo_number)                         AS total_vessels,
      COUNT(DISTINCT mmsi_number)                        AS total_mmsi,
      COUNT(DISTINCT vessel_name)                        AS total_names,
      COUNTIF(rn=1 AND speed > 0.5)                     AS moving_vessels,
      COUNTIF(rn=1 AND (speed <= 0.5 OR speed IS NULL)) AS stationary_vessels,
      ROUND(AVG(IF(rn=1, speed, NULL)), 2)              AS avg_speed,
      ROUND(MAX(IF(rn=1, speed, NULL)), 2)              AS max_speed,
      COUNT(DISTINCT vessel_type)                        AS vessel_type_count,
      COUNT(DISTINCT flag)                               AS flag_count
    FROM latest
  `;
  const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
  return rows[0] || {};
}

async function healthCheck() {
  try {
    const [rows] = await bigquery.query({ query: "SELECT 1 AS ok", location: BQ_LOCATION });
    return rows[0]?.ok === 1;
  } catch (e) {
    logger.error("❌ BigQuery health check failed:", e.message);
    return false;
  }
}

module.exports = {
  getUserByEmail, createUser, updateLastLogin,
  getLatestVessels, getVesselHistory,
  getVesselTypes, getFleetStats, healthCheck,
};
