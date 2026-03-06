// backend/src/services/bigquery.js
require("dotenv").config();
const { BigQuery } = require("@google-cloud/bigquery");
const logger = require("../utils/logger");

const PROJECT = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET = process.env.BIGQUERY_DATASET || "MPA";
const TABLE = process.env.BIGQUERY_TABLE || "MPA_Master_Vessels";
const FULL_TABLE = `\`${PROJECT}.${DATASET}.${TABLE}\``;
const USERS_TABLE = `\`${PROJECT}.${DATASET}.MPA_Users\``;
const SNAPSHOT_TABLE = `\`${PROJECT}.${DATASET}.View_MPA_VesselPositionsSnapshot\``;
const BQ_LOCATION = process.env.BIGQUERY_LOCATION || "asia-southeast1";

// ── IN-MEMORY CACHE ───────────────────────────────────────────
// Vessels: 60s TTL   → fresh enough for real-time feel, saves BigQuery cost
// Stats:   120s TTL  → dashboard numbers don't need sub-minute accuracy
// Types:   600s TTL  → vessel type list almost never changes
const cache = {
  vessels: { data: null, ts: 0, ttl: 60_000 },
  stats: { data: null, ts: 0, ttl: 120_000 },
  vesselTypes: { data: null, ts: 0, ttl: 600_000 },
};

function fromCache(key) {
  const c = cache[key];
  if (c.data && Date.now() - c.ts < c.ttl) return c.data;
  return null;
}
function toCache(key, data) {
  cache[key].data = data;
  cache[key].ts = Date.now();
  return data;
}

// ── BIGQUERY CLIENT ───────────────────────────────────────────
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
//  USER AUTH
// ════════════════════════════════════════════

async function getUserByEmail(email) {
  const em = sanitize(email.toLowerCase().trim());
  const [rows] = await bigquery.query({
    query: `SELECT id, name, email, password_hash, role, avatar, created_at, last_login
            FROM ${USERS_TABLE}
            WHERE LOWER(email) = '${em}' AND is_active = TRUE LIMIT 1`,
    location: BQ_LOCATION,
  });
  return rows[0] || null;
}

async function createUser({ id, name, email, passwordHash, role, avatar }) {
  await bigquery.query({
    query: `INSERT INTO ${USERS_TABLE}
      (id, name, email, password_hash, role, avatar, created_at, last_login, is_active)
      VALUES ('${sanitize(id)}','${sanitize(name)}','${sanitize(email.toLowerCase().trim())}',
              '${sanitize(passwordHash)}','${sanitize(role)}','${sanitize(avatar)}',
              CURRENT_TIMESTAMP(),CURRENT_TIMESTAMP(),TRUE)`,
    location: BQ_LOCATION,
  });
  logger.info(`[BQ] User created: ${email}`);
}

async function updateLastLogin(email) {
  const em = sanitize(email.toLowerCase().trim());
  try {
    await bigquery.query({
      query: `UPDATE ${USERS_TABLE} SET last_login=CURRENT_TIMESTAMP() WHERE LOWER(email)='${em}'`,
      location: BQ_LOCATION,
    });
  } catch (e) {
    logger.warn(`[BQ] updateLastLogin failed: ${e.message}`);
  }
}

// ════════════════════════════════════════════
//  VESSELS
// ════════════════════════════════════════════

async function getLatestVessels({
  search = "",
  vesselType = "",
  speedMin = null,
  speedMax = null,
  limit = 5000,
} = {}) {
  // Serve from cache when no filters — covers 90% of requests
  const isFiltered =
    search || vesselType || speedMin !== null || speedMax !== null;
  if (!isFiltered) {
    const cached = fromCache("vessels");
    if (cached) {
      logger.info(`[CACHE] vessels hit → ${cached.length} rows (instant)`);
      return cached;
    }
  }

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

  const staleness = `last_position_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)`;
  const where = conditions.length
    ? `WHERE ${conditions.join(" AND ")} AND ${staleness}`
    : `WHERE ${staleness}`;

  // Removed unused columns (vessel_depth, net_tonnage, vessel_breadth, declared_arrival_time,
  // crew_count, passenger_count, last_departed_time, berth_grid) — cuts payload ~40%
  const query = `
    SELECT
      vessel_name, imo_number, mmsi_number, flag, vessel_type, call_sign,
      latitude_degrees, longitude_degrees, speed, heading, course,
      vessel_length, gross_tonnage, deadweight, year_built,
      last_position_time        AS effective_timestamp,
      last_port_departed, next_port_destination,
      berth_location, voyage_purpose, shipping_agent,
      has_arrival_data, has_departure_data, has_declaration_data
    FROM ${FULL_TABLE}
    ${where}
    ORDER BY last_position_time DESC
    LIMIT ${Math.min(parseInt(limit) || 5000, 10000)}
  `;

  const start = Date.now();
  const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
  logger.info(
    `[BQ] getLatestVessels → ${rows.length} rows in ${Date.now() - start}ms`,
  );

  if (!isFiltered) toCache("vessels", rows);
  return rows;
}

async function getVesselHistory(imoNumber, hours = 24) {
  if (!imoNumber || isNaN(imoNumber)) throw new Error("Invalid IMO number");
  const h = Math.min(parseInt(hours) || 24, 168);
  const query = `
    SELECT vessel_name, imo_number, mmsi_number,
           latitude_degrees, longitude_degrees, speed, heading, course, effective_timestamp
    FROM ${SNAPSHOT_TABLE}
    WHERE imo_number = ${parseInt(imoNumber)}
      AND effective_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${h} HOUR)
      AND latitude_degrees IS NOT NULL AND longitude_degrees IS NOT NULL
    ORDER BY effective_timestamp ASC
    LIMIT 2000
  `;
  const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
  return rows;
}

async function getVesselTypes() {
  const cached = fromCache("vesselTypes");
  if (cached) {
    logger.info("[CACHE] vesselTypes hit");
    return cached;
  }
  const [rows] = await bigquery.query({
    query: `SELECT DISTINCT vessel_type FROM ${FULL_TABLE}
            WHERE vessel_type IS NOT NULL ORDER BY vessel_type LIMIT 100`,
    location: BQ_LOCATION,
  });
  return toCache("vesselTypes", rows.map((r) => r.vessel_type).filter(Boolean));
}

async function getFleetStats() {
  const cached = fromCache("stats");
  if (cached) {
    logger.info("[CACHE] stats hit");
    return cached;
  }
  const [rows] = await bigquery.query({
    query: `SELECT
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
    FROM ${FULL_TABLE} WHERE imo_number IS NOT NULL`,
    location: BQ_LOCATION,
  });
  return toCache("stats", rows[0] || {});
}

// ── WARM CACHE ON STARTUP ─────────────────────────────────────
// Runs in background after server starts — first user request is instant
async function warmCache() {
  logger.info("🔥 Warming cache...");
  try {
    await Promise.all([getLatestVessels(), getFleetStats(), getVesselTypes()]);
    logger.info("✅ Cache warmed — responses will be instant");
  } catch (e) {
    logger.warn("⚠️  Cache warm failed (non-fatal):", e.message);
  }
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
  warmCache,
};
