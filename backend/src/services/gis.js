// backend/src/services/gis.js
// Nautical chart layers from MPA_GIS BigQuery dataset
// Serves static GIS data with caching (refreshes every 30 min)

const { BigQuery } = require("@google-cloud/bigquery");
const logger = require("../utils/logger");

const PROJECT  = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const GIS_DS   = "MPA_GIS";
const LOCATION = process.env.BIGQUERY_LOCATION || "asia-southeast1";

let bigquery;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  bigquery = new BigQuery({ credentials, projectId: credentials.project_id, location: LOCATION });
} else {
  bigquery = new BigQuery({ projectId: PROJECT, location: LOCATION });
}

// ── CACHE (30 min TTL — GIS data is static) ──────────────────
const gisCache = {};
function gTable(name) { return `\`${PROJECT}.${GIS_DS}.${name}\``; }

async function cachedQuery(key, queryFn, ttl = 30 * 60 * 1000) {
  const c = gisCache[key];
  if (c && Date.now() - c.ts < ttl) return c.data;
  const data = await queryFn();
  gisCache[key] = { data, ts: Date.now() };
  return data;
}

// ── GEOMETRY PARSER ──────────────────────────────────────────
// BQ returns WKT strings or Geography objects — normalise to GeoJSON
function wktToCoords(wkt) {
  if (!wkt || typeof wkt !== "string") return null;
  try {
    const str = wkt.trim();
    if (str.startsWith("POINT")) {
      const m = str.match(/POINT\(([^ ]+) ([^ )]+)\)/);
      return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
    }
    if (str.startsWith("LINESTRING")) {
      const inner = str.replace(/LINESTRING\(/, "").replace(/\)$/, "");
      return inner.split(",").map(p => { const [x,y] = p.trim().split(" "); return [parseFloat(x), parseFloat(y)]; });
    }
    if (str.startsWith("POLYGON")) {
      const inner = str.replace(/POLYGON\(\(/, "").replace(/\)\)$/, "");
      return [inner.split(",").map(p => { const [x,y] = p.trim().split(" "); return [parseFloat(x), parseFloat(y)]; })];
    }
  } catch(e) { return null; }
  return null;
}

function geomField(row) {
  // Try geom, then geom_wkt, then Geography object
  const raw = row.geom || row.geom_wkt;
  if (!raw) return null;
  if (typeof raw === "object" && raw.value) return raw.value; // BQ Geography
  return raw;
}

// ── LAYER QUERIES ────────────────────────────────────────────

async function getDangers() {
  return cachedQuery("dangers", async () => {
    const results = [];

    // Points (wrecks, rocks, shoals)
    const [pRows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, OBJNAM AS name, INFORM AS info,
             FCSubtype AS subtype, VALSOU AS depth,
             CATWRK AS wreck_cat, WATLEV AS water_level,
             ST_AsText(geom) AS geom
      FROM ${gTable("tmpa_dangersp")}
      WHERE IS_DELETE = 0 LIMIT 2000
    `});
    pRows.forEach(r => {
      const coords = wktToCoords(geomField(r));
      if (coords) results.push({ type: "danger_point", id: r.feature_id, name: r.name, info: r.info, depth: r.depth, subtype: r.subtype, coords });
    });

    // Areas
    const [aRows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, OBJNAM AS name, INFORM AS info,
             FCSubtype AS subtype, VALSOU AS depth,
             ST_AsText(geom) AS geom
      FROM ${gTable("tmpa_dangersa")}
      WHERE IS_DELETE = 0 LIMIT 500
    `});
    aRows.forEach(r => {
      const coords = wktToCoords(geomField(r));
      if (coords) results.push({ type: "danger_area", id: r.feature_id, name: r.name, info: r.info, depth: r.depth, subtype: r.subtype, coords });
    });

    // Lines
    const [lRows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, OBJNAM AS name, INFORM AS info,
             FCSubtype AS subtype, VALSOU AS depth,
             ST_AsText(geom) AS geom
      FROM ${gTable("tmpa_dangersl")}
      WHERE IS_DELETE = 0 LIMIT 500
    `});
    lRows.forEach(r => {
      const coords = wktToCoords(geomField(r));
      if (coords) results.push({ type: "danger_line", id: r.feature_id, name: r.name, info: r.info, depth: r.depth, subtype: r.subtype, coords });
    });

    logger.info && logger.info(`[GIS] dangers → ${results.length} features`);
    return results;
  });
}

async function getDepths() {
  return cachedQuery("depths", async () => {
    const [rows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, VALDCO AS depth_value, DRVAL1 AS depth1, DRVAL2 AS depth2,
             ST_AsText(geom) AS geom
      FROM ${gTable("tmpa_depthsl")}
      WHERE IS_DELETE = 0 LIMIT 3000
    `});
    return rows.map(r => ({
      type: "depth_contour",
      id: r.feature_id,
      depth: r.depth_value || r.depth1,
      coords: wktToCoords(geomField(r))
    })).filter(r => r.coords);
  });
}

async function getRegulatedAreas() {
  return cachedQuery("regulated", async () => {
    const [rows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, OBJNAM AS name, INFORM AS info, STATUS AS status,
             CATREA AS cat_area, RESTRN AS restriction,
             ST_AsText(geom_wkt) AS geom
      FROM ${gTable("tmpa_regulatedareasandlimitsa")}
      WHERE IS_DELETE = 0 LIMIT 500
    `});
    return rows.map(r => ({
      type: "regulated_area",
      id: r.feature_id,
      name: r.name,
      info: r.info,
      status: r.status,
      category: r.cat_area,
      restriction: r.restriction,
      coords: wktToCoords(geomField(r))
    })).filter(r => r.coords);
  });
}

async function getTracks() {
  return cachedQuery("tracks", async () => {
    const results = [];

    const [aRows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, OBJNAM AS name, INFORM AS info,
             CATTRK AS track_cat, CATTSS AS tss_cat, TRAFIC AS traffic,
             DRVAL1 AS depth, ST_AsText(geom_wkt) AS geom
      FROM ${gTable("tmpa_tracksandroutesa")}
      WHERE IS_DELETE = 0 LIMIT 300
    `});
    aRows.forEach(r => { const c = wktToCoords(geomField(r)); if(c) results.push({ type:"track_area", id:r.feature_id, name:r.name, info:r.info, depth:r.depth, cat:r.track_cat, tss:r.tss_cat, coords:c }); });

    const [lRows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, OBJNAM AS name, ORIENT AS bearing,
             CATTRK AS track_cat, CATTSS AS tss_cat,
             ST_AsText(geom) AS geom
      FROM ${gTable("tmpa_tracksandroutesl")}
      WHERE IS_DELETE = 0 LIMIT 1000
    `});
    lRows.forEach(r => { const c = wktToCoords(geomField(r)); if(c) results.push({ type:"track_line", id:r.feature_id, name:r.name, bearing:r.bearing, cat:r.track_cat, tss:r.tss_cat, coords:c }); });

    logger.info && logger.info(`[GIS] tracks → ${results.length} features`);
    return results;
  });
}

async function getAidsToNavigation() {
  return cachedQuery("aids", async () => {
    const [rows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, Name AS name, Colour AS colour,
             Is_Lighted_Aid AS is_lighted,
             Buoy_Shape_Code AS buoy_shape,
             Beacon_Shape_Code AS beacon_shape,
             Value_Nominal_Range_NM AS range_nm,
             Centroid_Longitude AS lng, Centroid_Latitude AS lat
      FROM ${gTable("aids_to_navigation_p")}
      WHERE Is_Deleted__0_or_1 = 0
        AND Centroid_Latitude IS NOT NULL
      LIMIT 2000
    `});
    return rows.map(r => ({
      type: "aid_nav",
      id: r.feature_id,
      name: r.name,
      colour: r.colour,
      lighted: r.is_lighted === "Lighted",
      buoy: r.buoy_shape > 0,
      range_nm: r.range_nm,
      coords: [parseFloat(r.lng), parseFloat(r.lat)]
    })).filter(r => r.coords[0] && r.coords[1] && !isNaN(r.coords[0]));
  });
}

async function getSeabed() {
  return cachedQuery("seabed", async () => {
    const results = [];

    const [aRows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, OBJNAM AS name, COLOUR AS colour,
             NATSUR AS surface, NATQUA AS quality, WATLEV AS water_level,
             ST_AsText(geom) AS geom
      FROM ${gTable("tmpa_seabeda")}
      WHERE IS_DELETE = 0 LIMIT 500
    `});
    aRows.forEach(r => { const c = wktToCoords(geomField(r)); if(c) results.push({ type:"seabed_area", surface:r.surface, quality:r.quality, coords:c }); });

    const [pRows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, NATSUR AS surface, NATQUA AS quality,
             ST_AsText(geom) AS geom
      FROM ${gTable("tmpa_seabedp")}
      WHERE IS_DELETE = 0 LIMIT 1000
    `});
    pRows.forEach(r => { const c = wktToCoords(geomField(r)); if(c) results.push({ type:"seabed_point", surface:r.surface, quality:r.quality, coords:c }); });

    return results;
  });
}

async function getPortsAndServices() {
  return cachedQuery("ports", async () => {
    const [rows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, OBJNAM AS name, INFORM AS info,
             CATMOR AS mooring_cat, CATHAF AS harbour_cat,
             HORLEN AS length, HORWID AS width, DRVAL1 AS depth,
             ST_AsText(geom_wkt) AS geom
      FROM ${gTable("tmpa_portsandservicesp")}
      WHERE IS_DELETE = 0 LIMIT 1000
    `});
    return rows.map(r => ({
      type: "port_service",
      id: r.feature_id,
      name: r.name,
      info: r.info,
      depth: r.depth,
      coords: wktToCoords(geomField(r))
    })).filter(r => r.coords);
  });
}

async function getTides() {
  return cachedQuery("tides", async () => {
    const [rows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, OBJNAM AS name, CAT_TS AS cat,
             CURVEL AS current_speed, ORIENT AS direction,
             T_TSVL AS tidal_stream,
             ST_AsText(geom) AS geom
      FROM ${gTable("tmpa_tidesandvariationsp")}
      WHERE IS_DELETE = 0 LIMIT 500
    `});
    return rows.map(r => ({
      type: "tide_point",
      id: r.feature_id,
      name: r.name,
      current_speed: r.current_speed,
      direction: r.direction,
      tidal_stream: r.tidal_stream,
      coords: wktToCoords(geomField(r))
    })).filter(r => r.coords);
  });
}

async function getCulturalFeatures() {
  return cachedQuery("cultural", async () => {
    const results = [];
    // Bridges, cables, pipelines — points only for performance
    const [pRows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, OBJNAM AS name, INFORM AS info,
             CATCBL AS cable_cat, CATPIP AS pipe_cat,
             ST_AsText(geom) AS geom
      FROM ${gTable("tmpa_culturalfeaturesp")}
      WHERE IS_DELETE = 0 LIMIT 500
    `});
    pRows.forEach(r => { const c = wktToCoords(geomField(r)); if(c) results.push({ type:"cultural_point", name:r.name, info:r.info, cable:r.cable_cat>0, pipe:r.pipe_cat>0, coords:c }); });

    // Area features (bridges)
    const [aRows] = await bigquery.query({ location: LOCATION, query: `
      SELECT feature_id, OBJNAM AS name, INFORM AS info, CATBRG AS bridge_cat,
             ST_AsText(geom) AS geom
      FROM ${gTable("tmpa_culturalfeaturesa")}
      WHERE IS_DELETE = 0 AND CATBRG IS NOT NULL AND CATBRG != '' LIMIT 200
    `});
    aRows.forEach(r => { const c = wktToCoords(geomField(r)); if(c) results.push({ type:"cultural_bridge", name:r.name, info:r.info, coords:c }); });

    return results;
  });
}

// ── ALL LAYERS IN ONE CALL ────────────────────────────────────
async function getAllGISLayers() {
  const [dangers, depths, regulated, tracks, aids, seabed, ports, tides, cultural] = await Promise.all([
    getDangers(), getDepths(), getRegulatedAreas(), getTracks(),
    getAidsToNavigation(), getSeabed(), getPortsAndServices(),
    getTides(), getCulturalFeatures()
  ]);
  return { dangers, depths, regulated, tracks, aids, seabed, ports, tides, cultural };
}

// Warm GIS cache on startup
async function warmGISCache() {
  try {
    logger.info && logger.info("🗺️  Warming GIS cache...");
    await getAllGISLayers();
    logger.info && logger.info("✅ GIS cache warmed");
  } catch(e) {
    logger.warn && logger.warn("⚠️  GIS cache warm failed:", e.message);
  }
}

module.exports = { getAllGISLayers, getDangers, getDepths, getRegulatedAreas, getTracks, getAidsToNavigation, getSeabed, getPortsAndServices, getTides, getCulturalFeatures, warmGISCache };