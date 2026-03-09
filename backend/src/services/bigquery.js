// backend/src/services/bigquery.js — MPA v6 (auto-detect dbt + legacy fallback)
"use strict";
require("dotenv").config();
const { BigQuery } = require("@google-cloud/bigquery");
const logger = require("../utils/logger");

const PROJECT    = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const BQ_LOCATION = process.env.BIGQUERY_LOCATION  || "asia-southeast1";

// ── DATASET NORMALISATION ─────────────────────────────────────────
// Render env var may still be set to "MPA" (old value).
// The dbt models live in "Photons_MPA" — remap automatically.
const DATASET_ENV = process.env.BIGQUERY_DATASET || "Photons_MPA";
const DATASET     = (DATASET_ENV === "MPA") ? "Photons_MPA" : DATASET_ENV;

// ── TABLE REFERENCES ──────────────────────────────────────────────
const T = {
  // dbt fact/staging tables (Photons_MPA)
  VESSELS:          `\`${PROJECT}.${DATASET}.fct_vessel_live_tracking\``,
  MASTER:           `\`${PROJECT}.${DATASET}.fct_vessel_master\``,
  ARRIVALS:         `\`${PROJECT}.${DATASET}.fct_vessel_arrivals\``,
  DEPARTURES:       `\`${PROJECT}.${DATASET}.fct_vessel_departures\``,
  POSITIONS_HIST:   `\`${PROJECT}.${DATASET}.stg_vessel_positions\``,
  USERS:            `\`${PROJECT}.${DATASET}.MPA_Users\``,
  // Legacy raw tables (original MPA dataset — always available)
  LEGACY_VESSELS:   `\`${PROJECT}.MPA.MPA_Master_Vessels\``,
  LEGACY_SNAPSHOT:  `\`${PROJECT}.MPA.View_MPA_VesselPositionsSnapshot\``,
  LEGACY_ARRIVALS:  `\`${PROJECT}.MPA.MPA_VesselArrivalsbyDate\``,
  LEGACY_DEPARTURES:`\`${PROJECT}.MPA.MPA_VesselDeparturesbyDate\``,
};

// ── CACHE ─────────────────────────────────────────────────────────
const cache = {
  vessels:     { data: null, ts: 0, ttl: 60_000  },  // 60s — data ready before 90s frontend refresh
  stats:       { data: null, ts: 0, ttl: 180_000 },  // 3 min
  vesselTypes: { data: null, ts: 0, ttl: 900_000 },  // 15 min — almost never changes
  portActivity:{ data: null, ts: 0, ttl: 300_000 },  // 5 min
  arrivals:    { data: null, ts: 0, ttl: 300_000 },  // 5 min
  departures:  { data: null, ts: 0, ttl: 300_000 },  // 5 min
  dbtExists:   { checked: false, value: false },
};
function fromCache(k) {
  const c = cache[k];
  return (c && c.data && Date.now() - c.ts < c.ttl) ? c.data : null;
}
function toCache(k, d) {
  if (cache[k] && "ttl" in cache[k]) { cache[k].data = d; cache[k].ts = Date.now(); }
  return d;
}

// ── BIGQUERY CLIENT ───────────────────────────────────────────────
let bigquery;
const _credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (_credsJson && _credsJson.trim().startsWith("{")) {
  try {
    const credentials = JSON.parse(_credsJson);
    bigquery = new BigQuery({ credentials, projectId: credentials.project_id || PROJECT, location: BQ_LOCATION });
    logger.info("✅ BigQuery: JSON credentials");
  } catch (e) {
    logger.error("❌ Bad JSON credentials, falling back to ADC:", e.message);
    bigquery = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION });
  }
} else {
  bigquery = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION });
  logger.info("✅ BigQuery: Application Default Credentials");
}
if (!bigquery) {
  // Last-resort guard — should never reach here
  bigquery = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION });
  logger.warn("⚠️ BigQuery client created via last-resort fallback");
}

logger.info(`[BQ] project=${PROJECT}  dataset=${DATASET}  location=${BQ_LOCATION}`);

function sanitize(str) {
  if (!str) return "";
  return String(str).replace(/['\"\\;`]/g, "").substring(0, 200);
}

// ── AUTO-DETECT: do dbt tables exist? ────────────────────────────
// Runs once at startup, result cached forever.
let dbtCheckPromise = null;
async function useDbt() {
  if (cache.dbtExists.checked) return cache.dbtExists.value;
  if (!dbtCheckPromise) {
    dbtCheckPromise = bigquery
      .query({ query: `SELECT 1 FROM ${T.VESSELS} LIMIT 1`, location: BQ_LOCATION })
      .then(() => {
        cache.dbtExists = { checked: true, value: true };
        logger.info("✅ dbt tables found — Photons_MPA.fct_vessel_live_tracking");
        return true;
      })
      .catch((e) => {
        cache.dbtExists = { checked: true, value: false };
        logger.warn(`⚠️  dbt tables not ready (${e.message.slice(0, 100)}) — using legacy MPA tables`);
        return false;
      });
  }
  return dbtCheckPromise;
}

// ════════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════════
async function getUserByEmail(email) {
  const em = sanitize(email.toLowerCase().trim());
  const [rows] = await bigquery.query({
    query: `SELECT id, name, email, password_hash, role, avatar, created_at, last_login
            FROM ${T.USERS} WHERE LOWER(email)='${em}' AND is_active=TRUE LIMIT 1`,
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
      query: `UPDATE ${T.USERS} SET last_login=CURRENT_TIMESTAMP()
              WHERE LOWER(email)='${sanitize(email.toLowerCase())}'`,
      location: BQ_LOCATION,
    });
  } catch (e) { logger.warn("[BQ] updateLastLogin:", e.message); }
}

// ════════════════════════════════════════════════════════════════
//  VESSELS
// ════════════════════════════════════════════════════════════════
async function getLatestVessels({ search = "", vesselType = "", speedMin = null, speedMax = null, limit = 5000 } = {}) {
  const dbt = await useDbt();
  const isFiltered = search || vesselType || speedMin != null || speedMax != null;
  if (!isFiltered) {
    const hit = fromCache("vessels");
    if (hit) { logger.info(`[CACHE] vessels → ${hit.length}`); return hit; }
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
  if (speedMin != null && !isNaN(speedMin)) cond.push(`speed>=${parseFloat(speedMin)}`);
  if (speedMax != null && !isNaN(speedMax)) cond.push(`speed<=${parseFloat(speedMax)}`);

  let query;
  const lim = Math.min(parseInt(limit) || 5000, 10000);

  if (dbt) {
    // Filter out vessels with no position update in last 32 hours
    cond.push(`last_position_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 48 HOUR)`);
    const where = `WHERE ${cond.join(" AND ")}`;
    query = `
      SELECT * EXCEPT (rn)
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY imo_number ORDER BY last_position_at DESC) AS rn
        FROM ${T.VESSELS}
        ${where}
      )
      WHERE rn = 1
      ORDER BY last_position_at DESC
      LIMIT ${lim}`;
  } else {
    // Legacy MPA_Master_Vessels — add staleness filter + null-pad missing columns
    cond.push(`last_position_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 48 HOUR)`);
    const where = `WHERE ${cond.join(" AND ")}`;
    query = `
      SELECT
        imo_number, vessel_name, mmsi_number, flag, vessel_type, call_sign,
        latitude_degrees, longitude_degrees, speed, heading, course,
        vessel_length, vessel_breadth, gross_tonnage, deadweight, year_built,
        last_position_time AS effective_timestamp,
        last_port_departed, next_port_destination,
        berth_location, voyage_purpose, shipping_agent,
        has_arrival_data, has_departure_data, has_declaration_data,
        NULL AS vessel_status,    NULL AS status_label,
        NULL AS berth_grid,       NULL AS declared_arrival_time,
        NULL AS crew_count,       NULL AS passenger_count,
        NULL AS net_tonnage,      NULL AS vessel_depth,
        NULL AS data_quality_score, NULL AS port_time_hours,
        NULL AS hours_in_port_so_far, NULL AS speed_category,
        NULL AS speed_colour_class,   NULL AS minutes_since_last_ping,
        FALSE AS is_stale,        NULL AS last_updated_at,
        NULL AS last_arrived_time, NULL AS last_departed_time
      FROM ${T.LEGACY_VESSELS}
      ${where}
      ORDER BY last_position_time DESC
      LIMIT ${lim}`;
  }

  const t0 = Date.now();
  const [rows] = await bigquery.query({ query, location: BQ_LOCATION });
  logger.info(`[BQ] getLatestVessels (${dbt ? "dbt" : "legacy"}) → ${rows.length} rows in ${Date.now() - t0}ms`);
  if (!isFiltered) toCache("vessels", rows);
  return rows;
}

async function getVesselHistory(imoNumber, hours = 24) {
  if (!imoNumber || isNaN(imoNumber)) throw new Error("Invalid IMO");
  const h   = Math.min(parseInt(hours) || 24, 168);
  const dbt = await useDbt();
  const RAD = 180 / Math.PI;

  if (dbt) {
    // stg_vessel_positions uses latitude/longitude (radians) + effective_timestamp
    try {
      const [rows] = await bigquery.query({
        query: `
          SELECT
            imo_number,
            latitude  * ${RAD} AS latitude_degrees,
            longitude * ${RAD} AS longitude_degrees,
            speed_kn  AS speed,
            heading_deg AS heading,
            course_deg  AS course,
            effective_timestamp
          FROM ${T.POSITIONS_HIST}
          WHERE CAST(imo_number AS STRING) = '${parseInt(imoNumber)}'
            AND effective_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${h} HOUR)
            AND latitude IS NOT NULL AND longitude IS NOT NULL
          ORDER BY effective_timestamp ASC
          LIMIT 2000`,
        location: BQ_LOCATION,
      });
      if (rows.length) return rows;
    } catch(e) {
      logger.warn(`[BQ] stg_vessel_positions history failed: ${e.message.slice(0,100)}`);
    }
  }

  // Legacy fallback
  const [rows] = await bigquery.query({
    query: `
      SELECT imo_number,
             latitude_degrees, longitude_degrees,
             speed, heading, course, effective_timestamp
      FROM ${T.LEGACY_SNAPSHOT}
      WHERE imo_number = '${parseInt(imoNumber)}'
        AND effective_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${h} HOUR)
        AND latitude_degrees IS NOT NULL AND longitude_degrees IS NOT NULL
      ORDER BY effective_timestamp ASC
      LIMIT 2000`,
    location: BQ_LOCATION,
  });
  return rows;
}

async function getVesselDetail(imoNumber) {
  if (!imoNumber || isNaN(imoNumber)) throw new Error("Invalid IMO");
  const imo = parseInt(imoNumber);
  const dbt = await useDbt();
  if (!dbt) {
    const [rows] = await bigquery.query({
      query: `SELECT * FROM ${T.LEGACY_VESSELS} WHERE CAST(imo_number AS INT64)=${imo} LIMIT 1`,
      location: BQ_LOCATION,
    });
    return rows[0] || null;
  }
  // fct_vessel_master already has latest arrival/departure joined in
  // columns: latitude/longitude (radians), speed_kn, heading_deg, course_deg
  const [rows] = await bigquery.query({
    query: `
      SELECT
        m.imo_number, m.mmsi_number, m.vessel_name, m.call_sign, m.flag, m.vessel_type,
        m.gross_tonnage, m.net_tonnage, m.deadweight,
        m.vessel_length, m.vessel_breadth, m.vessel_depth, m.year_built,
        m.latitude  AS latitude_degrees,
        m.longitude AS longitude_degrees,
        m.speed_kn  AS speed,
        m.heading_deg AS heading,
        m.course_deg  AS course,
        m.last_position_at,
        m.speed_category, m.position_is_stale AS is_stale,
        m.minutes_since_last_ping,
        m.vessel_status, m.port_time_hours, m.hours_in_port_so_far,
        m.data_quality_score,
        m.has_live_position   AS has_arrival_data,
        m.has_arrival_record  AS has_arrival_record,
        m.has_departure_record AS has_departure_record,
        -- arrival info already joined in master
        m.latest_arrival_time, m.latest_arrival_date,
        m.arrived_from    AS location_from,
        m.arrived_at_berth AS berth_location,
        m.berth_grid, m.voyage_purpose,
        m.arrival_agent   AS shipping_agent,
        m.crew_count, m.passenger_count,
        -- departure info
        m.latest_departure_time, m.latest_departure_date,
        m.next_port       AS next_port_destination,
        m.departure_agent,
        m.last_updated_at
      FROM ${T.MASTER} m
      WHERE CAST(m.imo_number AS STRING) = '${imo}'
      LIMIT 1`,
    location: BQ_LOCATION,
  });
  return rows[0] || null;
}

// ════════════════════════════════════════════════════════════════
//  ARRIVALS
// ════════════════════════════════════════════════════════════════
async function getRecentArrivals(limit = 50) {
  const hit = fromCache("arrivals");
  if (hit) return hit;
  const dbt = await useDbt();
  const lim = Math.min(parseInt(limit) || 50, 200);

  if (dbt) {
    try {
      const [rows] = await bigquery.query({
        query: `SELECT * FROM ${T.ARRIVALS}
                WHERE arrival_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY)
                ORDER BY arrival_time DESC LIMIT ${lim}`,
        location: BQ_LOCATION,
      });
      return toCache("arrivals", rows);
    } catch (e) {
      logger.warn(`[BQ] fct_vessel_arrivals not ready, falling back: ${e.message.slice(0,80)}`);
    }
  }
  // Legacy: SELECT * and normalise in normalizeArrival
  const [rows] = await bigquery.query({
    query: `SELECT * FROM ${T.LEGACY_ARRIVALS}
            WHERE TIMESTAMP(COALESCE(arrivedTime, arrived_time, arrival_time))
              >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY)
            ORDER BY 1 DESC LIMIT ${lim}`,
    location: BQ_LOCATION,
  });
  return toCache("arrivals", rows);
}

// ════════════════════════════════════════════════════════════════
//  DEPARTURES
// ════════════════════════════════════════════════════════════════
async function getRecentDepartures(limit = 50) {
  const hit = fromCache("departures");
  if (hit) return hit;
  const dbt = await useDbt();
  const lim = Math.min(parseInt(limit) || 50, 200);

  if (dbt) {
    try {
      const [rows] = await bigquery.query({
        query: `SELECT * FROM ${T.DEPARTURES}
                WHERE departure_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY)
                ORDER BY departure_time DESC LIMIT ${lim}`,
        location: BQ_LOCATION,
      });
      return toCache("departures", rows);
    } catch (e) {
      logger.warn(`[BQ] fct_vessel_departures not ready, falling back: ${e.message.slice(0,80)}`);
    }
  }
  // Legacy: SELECT * and normalise known column name variants in normalizeDeparture
  const [rows] = await bigquery.query({
    query: `SELECT * FROM ${T.LEGACY_DEPARTURES}
            WHERE TIMESTAMP(COALESCE(departedTime, departed_time, departure_time))
              >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY)
            ORDER BY 1 DESC LIMIT ${lim}`,
    location: BQ_LOCATION,
  });
  return toCache("departures", rows);
}

// ════════════════════════════════════════════════════════════════
//  STATS
// ════════════════════════════════════════════════════════════════
async function getFleetStats() {
  const hit = fromCache("stats");
  if (hit) return hit;
  const dbt   = await useDbt();
  const table = dbt ? T.VESSELS : T.LEGACY_VESSELS;

  const [rows] = await bigquery.query({
    query: `
      SELECT
        COUNT(*)                               AS total_vessels,
        COUNT(DISTINCT imo_number)             AS unique_imo,
        COUNTIF(speed > 0.5)                   AS moving_vessels,
        COUNTIF(speed <= 0.5 OR speed IS NULL) AS stationary_vessels,
        ROUND(AVG(speed),2)                    AS avg_speed,
        ROUND(MAX(speed),2)                    AS max_speed,
        COUNT(DISTINCT vessel_type)            AS vessel_type_count,
        COUNT(DISTINCT flag)                   AS flag_count,
        -- flag columns may not exist in all table versions — default to 0
        0 AS with_arrival_data,
        0 AS with_departure_data,
        0 AS with_declaration_data,
        COUNTIF(speed > 0.5)                   AS underway,
        COUNTIF(speed <= 0.5 OR speed IS NULL) AS in_port,
        0 AS departed,
        0 AS expected,
        0 AS avg_data_quality,
        0 AS live_positions
      FROM ${table}
      WHERE imo_number IS NOT NULL`,
    location: BQ_LOCATION,
  });
  return toCache("stats", rows[0] || {});
}

// ════════════════════════════════════════════════════════════════
//  PORT ACTIVITY
// ════════════════════════════════════════════════════════════════
async function getPortActivity() {
  const hit = fromCache("portActivity");
  if (hit) return hit;
  const dbt = await useDbt();

  let query;
  const legacyPortQuery = `
    SELECT locationTo AS port, 'AIS_CONFIRMED' AS arrival_source,
           COUNT(*) AS arrivals,
           MIN(arrivedTime) AS first_arrival, MAX(arrivedTime) AS last_arrival
    FROM ${T.LEGACY_ARRIVALS}
    WHERE arrivedTime >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
      AND locationTo IS NOT NULL
    GROUP BY locationTo ORDER BY arrivals DESC LIMIT 30`;

  if (dbt) {
    try {
      const [rows] = await bigquery.query({
        query: `
          SELECT location_to AS port, arrival_source,
                 COUNT(*) AS arrivals,
                 MIN(arrival_time) AS first_arrival, MAX(arrival_time) AS last_arrival
          FROM ${T.ARRIVALS}
          WHERE arrival_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
            AND location_to IS NOT NULL
          GROUP BY location_to, arrival_source
          ORDER BY arrivals DESC LIMIT 30`,
        location: BQ_LOCATION,
      });
      return toCache("portActivity", rows);
    } catch (e) {
      logger.warn(`[BQ] fct_vessel_arrivals not ready for port-activity, falling back: ${e.message.slice(0,80)}`);
    }
  }
  const [rows] = await bigquery.query({ query: legacyPortQuery, location: BQ_LOCATION });
  return toCache("portActivity", rows);
}

// ════════════════════════════════════════════════════════════════
//  VESSEL TYPES
// ════════════════════════════════════════════════════════════════
async function getVesselTypes() {
  const hit = fromCache("vesselTypes");
  if (hit) return hit;
  const dbt   = await useDbt();
  const table = dbt ? T.VESSELS : T.LEGACY_VESSELS;
  const [rows] = await bigquery.query({
    query: `SELECT DISTINCT vessel_type FROM ${table} WHERE vessel_type IS NOT NULL ORDER BY vessel_type LIMIT 100`,
    location: BQ_LOCATION,
  });
  return toCache("vesselTypes", rows.map(r => r.vessel_type).filter(Boolean));
}

// ════════════════════════════════════════════════════════════════
//  HEALTH & CACHE WARM
// ════════════════════════════════════════════════════════════════
async function warmCache() {
  logger.info("🔥 Warming cache…");
  const dbt = await useDbt();
  // Run each independently so one failure doesn't block the others
  const jobs = [
    ["vessels",      getLatestVessels],
    ["stats",        getFleetStats],
    ["vesselTypes",  getVesselTypes],
    ["arrivals",     getRecentArrivals],
    ["departures",   getRecentDepartures],
    ["portActivity", getPortActivity],
  ];
  let ok = 0;
  for (const [name, fn] of jobs) {
    try {
      await fn();
      logger.info(`  ✅ warmed: ${name}`);
      ok++;
    } catch (e) {
      logger.warn(`  ⚠️ warm failed [${name}]: ${e.message}`);
    }
  }
  logger.info(`🔥 Cache warm done: ${ok}/${jobs.length} (${dbt ? "Photons_MPA" : "legacy MPA"})`);
}

async function healthCheck() {
  try {
    const [rows] = await bigquery.query({ query: "SELECT 1 AS ok", location: BQ_LOCATION });
    return rows[0]?.ok === 1;
  } catch (e) { return false; }
}

module.exports = {
  bigquery, BQ_LOCATION, T,
  getUserByEmail, createUser, updateLastLogin,
  getLatestVessels, getVesselHistory, getVesselDetail,
  getRecentArrivals, getRecentDepartures,
  getVesselTypes, getFleetStats, getPortActivity,
  healthCheck, warmCache,
};