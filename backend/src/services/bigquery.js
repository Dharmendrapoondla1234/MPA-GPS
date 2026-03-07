// backend/src/services/bigquery.js — MPA Advanced v6
"use strict";
require("dotenv").config();
const { BigQuery } = require("@google-cloud/bigquery");
const logger = require("../utils/logger");

const PROJECT = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET = process.env.BIGQUERY_DATASET || "Photons_MPA";
const BQ_LOCATION = process.env.BIGQUERY_LOCATION || "asia-southeast1";

// ── TABLE REFERENCES (match dbt model names exactly) ─────────────────────────
const T = {
  VESSELS: `\`${PROJECT}.${DATASET}.fct_vessel_live_tracking\``,
  MASTER: `\`${PROJECT}.${DATASET}.fct_vessel_master\``,
  ARRIVALS: `\`${PROJECT}.${DATASET}.fct_vessel_arrivals\``,
  DEPARTURES: `\`${PROJECT}.${DATASET}.fct_vessel_departures\``,
  POSITIONS_LATEST: `\`${PROJECT}.${DATASET}.fct_vessel_positions_latest\``,
  POSITIONS_HIST: `\`${PROJECT}.${DATASET}.stg_vessel_positions\``,
  USERS: `\`${PROJECT}.${DATASET}.MPA_Users\``,
};

// ── CACHE ─────────────────────────────────────────────────────────────────────
const cache = {
  vessels: { data: null, ts: 0, ttl: 60_000 },
  stats: { data: null, ts: 0, ttl: 120_000 },
  vesselTypes: { data: null, ts: 0, ttl: 600_000 },
  portActivity: { data: null, ts: 0, ttl: 300_000 },
  arrivals: { data: null, ts: 0, ttl: 180_000 },
};
function fromCache(k) {
  const c = cache[k];
  return c.data && Date.now() - c.ts < c.ttl ? c.data : null;
}
function toCache(k, d) {
  if (cache[k]) {
    cache[k].data = d;
    cache[k].ts = Date.now();
  }
  return d;
}

// ── BIGQUERY CLIENT ───────────────────────────────────────────────────────────
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
    logger.info("✅ BigQuery: JSON credentials");
  } catch (e) {
    logger.error("❌ Bad credentials JSON:", e.message);
    process.exit(1);
  }
} else {
  bigquery = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION });
  logger.info("✅ BigQuery: Application Default Credentials");
}

function sanitize(str) {
  if (!str) return "";
  return String(str)
    .replace(/['\"\\;`]/g, "")
    .substring(0, 200);
}

// ════════════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════════════
async function getUserByEmail(email) {
  const em = sanitize(email.toLowerCase().trim());
  const [rows] = await bigquery.query({
    query: `SELECT id, name, email, password_hash, role, avatar, created_at, last_login
            FROM ${T.USERS}
            WHERE LOWER(email)='${em}' AND is_active=TRUE LIMIT 1`,
    location: BQ_LOCATION,
  });
  return rows[0] || null;
}

async function createUser({ id, name, email, passwordHash, role, avatar }) {
  await bigquery.query({
    query: `INSERT INTO ${T.USERS}
      (id,name,email,password_hash,role,avatar,created_at,last_login,is_active)
      VALUES ('${sanitize(id)}','${sanitize(name)}','${sanitize(email.toLowerCase())}',
              '${sanitize(passwordHash)}','${sanitize(role)}','${sanitize(avatar)}',
              CURRENT_TIMESTAMP(),CURRENT_TIMESTAMP(),TRUE)`,
    location: BQ_LOCATION,
  });
}

async function updateLastLogin(email) {
  try {
    await bigquery.query({
      query: `UPDATE ${T.USERS} SET last_login=CURRENT_TIMESTAMP() WHERE LOWER(email)='${sanitize(email.toLowerCase())}'`,
      location: BQ_LOCATION,
    });
  } catch (e) {
    logger.warn("[BQ] updateLastLogin:", e.message);
  }
}

// ════════════════════════════════════════════════════════════════════
//  VESSELS — from fct_vessel_live_tracking (enriched with all dbt data)
// ════════════════════════════════════════════════════════════════════
async function getLatestVessels({
  search = "",
  vesselType = "",
  speedMin = null,
  speedMax = null,
  limit = 5000,
} = {}) {
  const isFiltered =
    search || vesselType || speedMin != null || speedMax != null;
  if (!isFiltered) {
    const hit = fromCache("vessels");
    if (hit) {
      logger.info(`[CACHE] vessels → ${hit.length}`);
      return hit;
    }
  }

  const cond = [];
  if (search) {
    const s = sanitize(search);
    cond.push(`(LOWER(vessel_name) LIKE '%${s.toLowerCase()}%'
                OR CAST(imo_number AS STRING) LIKE '%${s}%'
                OR CAST(mmsi_number AS STRING) LIKE '%${s}%'
                OR LOWER(flag) LIKE '%${s.toLowerCase()}%'
                OR LOWER(call_sign) LIKE '%${s.toLowerCase()}%')`);
  }
  if (vesselType) cond.push(`vessel_type='${sanitize(vesselType)}'`);
  if (speedMin != null && !isNaN(speedMin))
    cond.push(`speed>=${parseFloat(speedMin)}`);
  if (speedMax != null && !isNaN(speedMax))
    cond.push(`speed<=${parseFloat(speedMax)}`);

  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";

  // Pull ALL enriched columns from fct_vessel_live_tracking
  const query = `
    SELECT
      -- identity
      imo_number, vessel_name, mmsi_number, call_sign, flag, vessel_type,
      -- position
      latitude_degrees, longitude_degrees, speed, heading, course,
      last_position_at AS effective_timestamp,
      minutes_since_last_ping, is_stale, speed_category, speed_colour_class,
      -- static
      vessel_length, vessel_breadth, vessel_depth,
      gross_tonnage, net_tonnage, deadweight, year_built,
      -- voyage
      vessel_status, status_label,
      last_port_departed, next_port_destination,
      last_arrived_time, last_departed_time,
      -- declaration enrichment
      berth_location, berth_grid, voyage_purpose, shipping_agent,
      declared_arrival_time, crew_count, passenger_count,
      -- data quality
      has_arrival_data, has_departure_data, has_declaration_data,
      data_quality_score,
      -- port time
      port_time_hours, hours_in_port_so_far,
      last_updated_at
    FROM ${T.VESSELS}
    ${where}
    ORDER BY last_position_at DESC
    LIMIT ${Math.min(parseInt(limit) || 5000, 10000)}
  `;

  const t0 = Date.now();
  const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
  logger.info(
    `[BQ] getLatestVessels → ${rows.length} rows in ${Date.now() - t0}ms`,
  );
  if (!isFiltered) toCache("vessels", rows);
  return rows;
}

async function getVesselHistory(imoNumber, hours = 24) {
  if (!imoNumber || isNaN(imoNumber)) throw new Error("Invalid IMO");
  const h = Math.min(parseInt(hours) || 24, 168);
  const [rows] = await bigquery.query({
    query: `
      SELECT imo_number, latitude_degrees, longitude_degrees,
             speed, heading, course, effective_timestamp
      FROM ${T.POSITIONS_HIST}
      WHERE imo_number = ${parseInt(imoNumber)}
        AND effective_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${h} HOUR)
        AND latitude_degrees IS NOT NULL AND longitude_degrees IS NOT NULL
        AND ABS(latitude_degrees) <= 90 AND ABS(longitude_degrees) <= 180
      ORDER BY effective_timestamp ASC
      LIMIT 2000
    `,
    location: BQ_LOCATION,
  });
  return rows;
}

// ════════════════════════════════════════════════════════════════════
//  ARRIVALS — from fct_vessel_arrivals
// ════════════════════════════════════════════════════════════════════
async function getRecentArrivals(limit = 50) {
  const hit = fromCache("arrivals");
  if (hit) return hit;
  const [rows] = await bigquery.query({
    query: `
      SELECT imo_number, vessel_name, call_sign, flag,
             arrival_time, arrival_date, location_from, location_to,
             arrival_source, berth_grid, voyage_purpose,
             shipping_agent, crew_count, passenger_count
      FROM ${T.ARRIVALS}
      WHERE arrival_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY)
      ORDER BY arrival_time DESC
      LIMIT ${Math.min(parseInt(limit) || 50, 200)}
    `,
    location: BQ_LOCATION,
  });
  return toCache("arrivals", rows);
}

// ════════════════════════════════════════════════════════════════════
//  DEPARTURES — from fct_vessel_departures
// ════════════════════════════════════════════════════════════════════
async function getRecentDepartures(limit = 50) {
  const [rows] = await bigquery.query({
    query: `
      SELECT imo_number, vessel_name, call_sign, flag,
             departure_time, departure_date, departure_source,
             next_port, shipping_agent, crew_count, passenger_count
      FROM ${T.DEPARTURES}
      WHERE departure_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY)
      ORDER BY departure_time DESC
      LIMIT ${Math.min(parseInt(limit) || 50, 200)}
    `,
    location: BQ_LOCATION,
  });
  return rows;
}

// ════════════════════════════════════════════════════════════════════
//  VESSEL DETAIL — full join from master + arrivals + departures
// ════════════════════════════════════════════════════════════════════
async function getVesselDetail(imoNumber) {
  if (!imoNumber || isNaN(imoNumber)) throw new Error("Invalid IMO");
  const imo = parseInt(imoNumber);
  const [rows] = await bigquery.query({
    query: `
      SELECT
        m.*,
        arr.arrival_time   AS latest_arrival_time,
        arr.location_from  AS arrival_from,
        arr.location_to    AS arrival_to,
        arr.berth_grid, arr.voyage_purpose, arr.shipping_agent,
        arr.crew_count, arr.passenger_count,
        dep.departure_time AS latest_departure_time,
        dep.next_port      AS departure_next_port
      FROM ${T.MASTER} m
      LEFT JOIN (
        SELECT * FROM ${T.ARRIVALS}
        WHERE imo_number=${imo}
        ORDER BY arrival_time DESC LIMIT 1
      ) arr ON m.imo_number = arr.imo_number
      LEFT JOIN (
        SELECT * FROM ${T.DEPARTURES}
        WHERE imo_number=${imo}
        ORDER BY departure_time DESC LIMIT 1
      ) dep ON m.imo_number = dep.imo_number
      WHERE m.imo_number=${imo}
      LIMIT 1
    `,
    location: BQ_LOCATION,
  });
  return rows[0] || null;
}

// ════════════════════════════════════════════════════════════════════
//  STATS — fleet + port activity
// ════════════════════════════════════════════════════════════════════
async function getFleetStats() {
  const hit = fromCache("stats");
  if (hit) return hit;
  const [rows] = await bigquery.query({
    query: `
      SELECT
        COUNT(*)                                       AS total_vessels,
        COUNT(DISTINCT imo_number)                     AS unique_imo,
        COUNTIF(vessel_status='UNDERWAY')              AS underway,
        COUNTIF(vessel_status='IN_PORT')               AS in_port,
        COUNTIF(vessel_status='DEPARTED')              AS departed,
        COUNTIF(vessel_status='EXPECTED')              AS expected,
        COUNTIF(vessel_status='UNKNOWN')               AS unknown_status,
        COUNTIF(speed > 0.5)                           AS moving_vessels,
        COUNTIF(speed <= 0.5 OR speed IS NULL)         AS stationary_vessels,
        ROUND(AVG(speed),2)                            AS avg_speed,
        ROUND(MAX(speed),2)                            AS max_speed,
        COUNT(DISTINCT vessel_type)                    AS vessel_type_count,
        COUNT(DISTINCT flag)                           AS flag_count,
        COUNTIF(has_arrival_data=TRUE)                 AS with_arrival_data,
        COUNTIF(has_departure_data=TRUE)               AS with_departure_data,
        COUNTIF(has_declaration_data=TRUE)             AS with_declaration_data,
        ROUND(AVG(data_quality_score),1)               AS avg_data_quality,
        COUNTIF(is_stale=FALSE)                        AS live_positions,
        COUNTIF(is_stale=TRUE)                         AS stale_positions
      FROM ${T.VESSELS}
      WHERE imo_number IS NOT NULL
    `,
    location: BQ_LOCATION,
  });
  return toCache("stats", rows[0] || {});
}

async function getPortActivity() {
  const hit = fromCache("portActivity");
  if (hit) return hit;
  const [rows] = await bigquery.query({
    query: `
      SELECT
        location_to AS port, arrival_source,
        COUNT(*) AS arrivals,
        MIN(arrival_time) AS first_arrival,
        MAX(arrival_time) AS last_arrival
      FROM ${T.ARRIVALS}
      WHERE arrival_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
        AND location_to IS NOT NULL
      GROUP BY location_to, arrival_source
      ORDER BY arrivals DESC
      LIMIT 30
    `,
    location: BQ_LOCATION,
  });
  return toCache("portActivity", rows);
}

async function getVesselTypes() {
  const hit = fromCache("vesselTypes");
  if (hit) return hit;
  const [rows] = await bigquery.query({
    query: `SELECT DISTINCT vessel_type FROM ${T.VESSELS} WHERE vessel_type IS NOT NULL ORDER BY vessel_type LIMIT 100`,
    location: BQ_LOCATION,
  });
  return toCache("vesselTypes", rows.map((r) => r.vessel_type).filter(Boolean));
}

// ════════════════════════════════════════════════════════════════════
//  HEALTH & CACHE WARM
// ════════════════════════════════════════════════════════════════════
async function warmCache() {
  logger.info("🔥 Warming cache…");
  try {
    await Promise.all([
      getLatestVessels(),
      getFleetStats(),
      getVesselTypes(),
      getRecentArrivals(),
      getPortActivity(),
    ]);
    logger.info("✅ Cache warmed");
  } catch (e) {
    logger.warn("⚠️ Cache warm failed:", e.message);
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
    return false;
  }
}

module.exports = {
  bigquery,
  BQ_LOCATION,
  T,
  getUserByEmail,
  createUser,
  updateLastLogin,
  getLatestVessels,
  getVesselHistory,
  getVesselDetail,
  getRecentArrivals,
  getRecentDepartures,
  getVesselTypes,
  getFleetStats,
  getPortActivity,
  healthCheck,
  warmCache,
};
