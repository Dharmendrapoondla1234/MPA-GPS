// backend/src/services/bigquery.js
require("dotenv").config();
const { BigQuery } = require("@google-cloud/bigquery");
const logger = require("../utils/logger");

const PROJECT = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET = process.env.BIGQUERY_DATASET || "MPA";
const TABLE = process.env.BIGQUERY_TABLE || "MPA_Master_Vessels";
const FULL_TABLE = `\`${PROJECT}.${DATASET}.${TABLE}\``;
const USERS_TABLE = `\`${PROJECT}.${DATASET}.MPA_Users\``;

// Vessel trail history uses raw snapshot (has all historical timestamps)
const SNAPSHOT_TABLE = `\`${PROJECT}.${DATASET}.View_MPA_VesselPositionsSnapshot\``;

// BigQuery location — dataset is in Singapore
const BQ_LOCATION = process.env.BIGQUERY_LOCATION || "asia-southeast1";

let bigquery;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const credentials = JSON.parse(
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    );
    bigquery = new BigQuery({
      credentials,
      projectId: credentials.project_id,
      location: BQ_LOCATION,
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
  return String(str)
    .replace(/['\"\\;`]/g, "")
    .substring(0, 200);
}

// ════════════════════════════════════════════
//  USER AUTH — MPA_Users table
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
//  VESSEL QUERIES — MPA_Master_Vessels
//  Already deduplicated: 1 row per vessel
//  Includes enriched port data from all source tables
// ════════════════════════════════════════════

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
      `(LOWER(vessel_name) LIKE '%${s.toLowerCase()}%'` +
        ` OR CAST(imo_number AS STRING) LIKE '%${s}%'` +
        ` OR CAST(mmsi_number AS STRING) LIKE '%${s}%')`,
    );
  }
  if (vesselType) conditions.push(`vessel_type = '${sanitize(vesselType)}'`);
  if (speedMin !== null && !isNaN(speedMin))
    conditions.push(`speed >= ${parseFloat(speedMin)}`);
  if (speedMax !== null && !isNaN(speedMax))
    conditions.push(`speed <= ${parseFloat(speedMax)}`);

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // MPA_Master_Vessels is already deduplicated — no ROW_NUMBER needed
  // Only return vessels with a position update in the last 24 hours (eliminates stale data)
  const stalenessClause = `last_position_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)`;
  const where24 = where
    ? `${where} AND ${stalenessClause}`
    : `WHERE ${stalenessClause}`;

  const query = `
    SELECT
      vessel_name,
      imo_number,
      mmsi_number,
      flag,
      vessel_type,
      call_sign,
      latitude_degrees,
      longitude_degrees,
      speed,
      heading,
      course,
      vessel_length,
      vessel_breadth,
      vessel_depth,
      gross_tonnage,
      net_tonnage,
      deadweight,
      year_built,
      last_position_time        AS effective_timestamp,
      last_port_departed,
      next_port_destination,
      last_departed_time,
      berth_location,
      berth_grid,
      voyage_purpose,
      shipping_agent,
      declared_arrival_time,
      crew_count,
      passenger_count,
      has_arrival_data,
      has_departure_data,
      has_declaration_data
    FROM ${FULL_TABLE}
    ${where24}
    ORDER BY last_position_time DESC
    LIMIT ${Math.min(parseInt(limit) || 5000, 10000)}
  `;

  const start = Date.now();
  const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
  logger.info(
    `[BQ] getLatestVessels → ${rows.length} vessels in ${Date.now() - start}ms`,
  );
  return rows;
}

// Trail history — raw snapshot has all historical timestamps per vessel
async function getVesselHistory(imoNumber, hours = 24) {
  if (!imoNumber || isNaN(imoNumber)) throw new Error("Invalid IMO number");
  const h = Math.min(parseInt(hours) || 24, 168);
  const query = `
    SELECT
      vessel_name,
      imo_number,
      mmsi_number,
      latitude_degrees,
      longitude_degrees,
      speed,
      heading,
      course,
      effective_timestamp
    FROM ${SNAPSHOT_TABLE}
    WHERE imo_number = ${parseInt(imoNumber)}
      AND effective_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${h} HOUR)
      AND latitude_degrees  IS NOT NULL
      AND longitude_degrees IS NOT NULL
    ORDER BY effective_timestamp ASC
    LIMIT 2000
  `;
  const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
  return rows;
}

async function getVesselTypes() {
  const query = `
    SELECT DISTINCT vessel_type
    FROM ${FULL_TABLE}
    WHERE vessel_type IS NOT NULL
    ORDER BY vessel_type
    LIMIT 100
  `;
  const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
  return rows.map((r) => r.vessel_type).filter(Boolean);
}

// Stats — table already deduplicated, no CTE/ROW_NUMBER needed
async function getFleetStats() {
  const query = `
    SELECT
      COUNT(*)                                AS total_vessels,
      COUNT(DISTINCT mmsi_number)             AS total_mmsi,
      COUNT(DISTINCT vessel_name)             AS total_names,
      COUNTIF(speed > 0.5)                   AS moving_vessels,
      COUNTIF(speed <= 0.5 OR speed IS NULL) AS stationary_vessels,
      ROUND(AVG(speed), 2)                   AS avg_speed,
      ROUND(MAX(speed), 2)                   AS max_speed,
      COUNT(DISTINCT vessel_type)             AS vessel_type_count,
      COUNT(DISTINCT flag)                    AS flag_count,
      COUNTIF(has_arrival_data    = TRUE)     AS with_arrival_data,
      COUNTIF(has_departure_data  = TRUE)     AS with_departure_data,
      COUNTIF(has_declaration_data = TRUE)    AS with_declaration_data
    FROM ${FULL_TABLE}
    WHERE imo_number IS NOT NULL
  `;
  const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
  return rows[0] || {};
}

async function healthCheck() {
  try {
    const [rows] = await bigquery.query({
      query: "SELECT 1 AS ok",
      location: BQ_LOCATION,
    });
    return rows[0]?.ok === 1;
  } catch (e) {
    logger.error("❌ BigQuery health check failed:", e.message);
    return false;
  }
}

module.exports = {
  getUserByEmail,
  createUser,
  updateLastLogin,
  getLatestVessels,
  getVesselHistory,
  getVesselTypes,
  getFleetStats,
  healthCheck,
};
