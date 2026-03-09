// backend/src/routes/predict.js — v10 (auto-detect dbt + legacy fallback)
"use strict";
const express   = require("express");
const router    = express.Router();
const logger    = require("../utils/logger");
const seaRouter = require("../services/seaRouter");
const { bigquery, BQ_LOCATION, getVesselHistory, T } = require("../services/bigquery");

const cache = new Map();
function getCached(k) { const c = cache.get(k); return c && Date.now() - c.ts < 300000 ? c.data : null; }
function setCache(k, d) { cache.set(k, { data: d, ts: Date.now() }); }

// Auto-detect which master table to query (cached after first check)
let masterTableCache = null;
async function getMasterTable() {
  if (masterTableCache) return masterTableCache;
  try {
    await bigquery.query({ query: `SELECT 1 FROM ${T.MASTER} LIMIT 1`, location: BQ_LOCATION });
    masterTableCache = { table: T.MASTER, isDbt: true };
    logger.info("[PREDICT] Using dbt fct_vessel_master");
  } catch (_) {
    masterTableCache = { table: T.LEGACY_VESSELS, isDbt: false };
    logger.info("[PREDICT] Using legacy MPA_Master_Vessels");
  }
  return masterTableCache;
}

const PORTS = [
  { name:"Singapore",        lat:1.264,  lng:103.820, code:"SGSIN", node:"P_SING"   },
  { name:"Port Klang",       lat:3.000,  lng:101.390, code:"MYPKG", node:"P_KLANG"  },
  { name:"Tanjung Pelepas",  lat:1.363,  lng:103.553, code:"MYPTP", node:"P_TPP"    },
  { name:"Johor Port",       lat:1.764,  lng:103.920, code:"MYJHB", node:"P_JOHOR"  },
  { name:"Penang",           lat:5.414,  lng:100.329, code:"MYPNG", node:"P_PENANG" },
  { name:"Batam",            lat:1.107,  lng:104.030, code:"IDBTH", node:"P_BATAM"  },
  { name:"Dumai",            lat:1.670,  lng:101.450, code:"IDDUM", node:"DUMAI_A"  },
  { name:"Belawan",          lat:3.794,  lng: 98.682, code:"IDBLW", node:"P_BELAWAN"},
  { name:"Tanjung Priok",    lat:-6.100, lng:106.880, code:"IDTPP", node:"P_TPRIOK" },
  { name:"Palembang",        lat:-2.916, lng:104.745, code:"IDPLM", node:"P_PALM"   },
  { name:"Bangkok",          lat:13.759, lng:100.502, code:"THBKK", node:"P_BKKT"   },
  { name:"Ho Chi Minh City", lat:10.782, lng:106.700, code:"VNSGN", node:"P_HCMC"   },
  { name:"Hai Phong",        lat:20.870, lng:106.688, code:"VNHPH", node:"P_HPHONG" },
  { name:"Hong Kong",        lat:22.302, lng:114.177, code:"HKHKG", node:"P_HK"     },
  { name:"Colombo",          lat: 6.930, lng: 79.858, code:"LKCMB", node:"P_COLOM"  },
  { name:"Kota Kinabalu",    lat: 5.976, lng:116.073, code:"MYBKI", node:"P_KK"     },
  { name:"Port Dickson",     lat: 2.527, lng:101.795, code:"MYPDK", node:"P_PDICK"  },
  { name:"Karimun",          lat: 1.040, lng:103.440, code:"IDKRM", node:"P_KARIN"  },
  { name:"Pasir Gudang",     lat: 1.467, lng:103.886, code:"MYPGU", node:"P_PGUD"   },
  { name:"Laem Chabang",     lat:13.086, lng:100.880, code:"THLCH", node:"P_BKKT"   },
];

function distNM(la1, lo1, la2, lo2) { return seaRouter.distNM(la1, lo1, la2, lo2); }
function calcBrng(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, dLo = (lo2 - lo1) * r,
    y = Math.sin(dLo) * Math.cos(la2 * r),
    x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos(dLo);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function fmtETA(h) {
  if (!h || h < 0) return "Unknown";
  if (h < 1) return `~${Math.round(h * 60)}min`;
  if (h < 24) return `~${h.toFixed(1)}h`;
  const d = Math.floor(h / 24), rm = Math.round(h % 24);
  return rm > 0 ? `~${d}d ${rm}h` : `~${d}d`;
}
function bqv(v) {
  if (v == null) return null;
  if (typeof v === "object" && "value" in v) return String(v.value).trim() || null;
  return String(v).trim() || null;
}

router.get("/ping", (_req, res) => res.json({ ok: true, router: "seaGraph-v10" }));

router.get("/:imo", async (req, res) => {
  const imo = parseInt(req.params.imo);
  if (!imo || isNaN(imo)) return res.status(400).json({ success: false, error: "Invalid IMO" });

  const hit = getCached(`pred_${imo}`);
  if (hit) return res.json({ success: true, cached: true, ...hit });

  try {
    logger.info(`[PREDICT v10] IMO=${imo}`);

    // ── Detect which table to use ───────────────────────────────
    const { table: masterTable, isDbt } = await getMasterTable();

    const dbtCols    = "vessel_status, arrived_at_berth AS berth_location, arrival_agent AS shipping_agent, crew_count, passenger_count, data_quality_score";
    const legacyCols = "NULL AS vessel_status, NULL AS berth_location, NULL AS shipping_agent, NULL AS crew_count, NULL AS passenger_count, NULL AS data_quality_score";

    // fct_vessel_master uses: latitude/longitude (radians), speed_kn, heading_deg, course_deg
    // legacy MPA_Master_Vessels uses: latitude_degrees/longitude_degrees (degrees), speed, heading, course
    const [vesselRows] = await bigquery.query({
      query: isDbt ? `
        SELECT vessel_name,
               latitude  AS lat_raw,
               longitude AS lng_raw,
               speed_kn  AS speed,
               heading_deg AS heading,
               course_deg  AS course,
               flag,
               arrived_from     AS last_port_departed,
               next_port        AS next_port_destination,
               ${dbtCols}
        FROM ${masterTable}
        WHERE CAST(imo_number AS STRING) = '${imo}'
        LIMIT 1`
      : `
        SELECT vessel_name,
               latitude_degrees AS lat_raw,
               longitude_degrees AS lng_raw,
               speed, heading, course, flag,
               last_port_departed, next_port_destination,
               ${legacyCols}
        FROM ${masterTable}
        WHERE CAST(imo_number AS INT64) = ${imo}
        LIMIT 1`,
      location: BQ_LOCATION,
    });

    if (!vesselRows?.length) return res.status(404).json({ success: false, error: `IMO ${imo} not found` });

    const v      = vesselRows[0];
    const RAD = 180/Math.PI;
    function toDeg(x){const n=Number(x||0);return Math.abs(n)<4?n*RAD:n;}
    const curLat = toDeg(v.lat_raw || v.latitude_degrees);
    const curLng = toDeg(v.lat_raw !== undefined ? v.lng_raw : v.longitude_degrees);
    if (!curLat && !curLng) return res.status(422).json({ success: false, error: "No position data" });

    let hist = [];
    try { hist = await getVesselHistory(imo, 72); } catch (e) { logger.warn(`[PREDICT] hist: ${e.message}`); }

    const recent = hist.slice(-10);
    let avgHdg = Number(v.heading || v.course || 0);
    let avgSpd = Number(v.speed   || 0);
    if (recent.length >= 2) {
      const hdgs = recent.map(p => Number(p.heading || 0)).filter(h => h > 0);
      const spds = recent.map(p => Number(p.speed   || 0)).filter(s => s > 0.3);
      if (hdgs.length) avgHdg = hdgs.reduce((a, b) => a + b) / hdgs.length;
      if (spds.length) avgSpd = spds.reduce((a, b) => a + b) / spds.length;
    }

    let vecBrng = avgHdg;
    if (hist.length >= 2) {
      const o = hist[0], n = hist[hist.length - 1];
      const hrs = (new Date(n.effective_timestamp || 0) - new Date(o.effective_timestamp || 0)) / 3600000;
      if (hrs > 0.5) {
        const dLa = toDeg(n.lat_raw ?? n.latitude_degrees) - toDeg(o.lat_raw ?? o.latitude_degrees);
        const dLo = toDeg(n.lng_raw ?? n.longitude_degrees) - toDeg(o.lng_raw ?? o.longitude_degrees);
        vecBrng = (Math.atan2(dLo, dLa) * 180 / Math.PI + 360) % 360;
      }
    }

    const declaredDest = bqv(v.next_port_destination);

    const scored = PORTS.map(port => {
      const dist = distNM(curLat, curLng, port.lat, port.lng);
      const brng = calcBrng(curLat, curLng, port.lat, port.lng);
      let hdgDiff = Math.abs(brng - avgHdg); if (hdgDiff > 180) hdgDiff = 360 - hdgDiff;
      let vecDiff = Math.abs(brng - vecBrng); if (vecDiff > 180) vecDiff = 360 - vecDiff;
      const hdgScore = Math.max(0, 1 - hdgDiff / 90) * 1.8;
      const vecScore = Math.max(0, 1 - vecDiff / 90) * 1.5;
      const dstScore = dist < 5 ? 0 : dist < 50 ? 0.3 : dist < 200 ? 1.2 : dist < 800 ? 1.0 : dist < 2000 ? 0.6 : 0.2;
      const isDecl   = declaredDest && (
        declaredDest.toLowerCase().includes(port.name.toLowerCase().slice(0, 5)) ||
        port.name.toLowerCase().includes(declaredDest.toLowerCase().slice(0, 5)) ||
        declaredDest.toUpperCase().includes(port.code)
      );
      const total = hdgScore + vecScore + dstScore + (isDecl ? 3.5 : 0);
      const etaH  = avgSpd > 0.3 ? dist / avgSpd : null;
      return {
        port: port.name, code: port.code, lat: port.lat, lng: port.lng, node: port.node,
        distance_nm: Math.round(dist), bearing_deg: Math.round(brng),
        score: total,
        eta_hours:  etaH ? Math.round(etaH * 10) / 10 : null,
        eta_iso:    etaH ? new Date(Date.now() + etaH * 3600000).toISOString() : null,
        eta_label:  etaH ? fmtETA(etaH) : "Unknown",
        is_declared: !!isDecl,
        confidence:  Math.min(Math.round(total * 16), 97),
        heading_alignment: Math.round(Math.max(0, 1 - Math.abs(brng - avgHdg) / 180) * 100),
      };
    }).filter(p => p.distance_nm > 3).sort((a, b) => b.score - a.score);

    const top  = scored[0];
    const alts = scored.slice(1, 4);

    let wps = [];
    if (top) {
      const raw       = seaRouter.route(curLat, curLng, top.lat, top.lng, top.node);
      let totalDist   = 0;
      const cumDist   = [0];
      for (let i = 1; i < raw.length; i++) {
        totalDist += distNM(raw[i-1].lat, raw[i-1].lng, raw[i].lat, raw[i].lng);
        cumDist.push(totalDist);
      }
      wps = raw.map((pt, i) => ({
        lat: pt.lat, lng: pt.lng,
        label: i === 0 ? "Current Position" : i === raw.length - 1 ? top.port : (pt.nodeId || `Waypoint ${i}`),
        type:  i === 0 ? "current" : i === raw.length - 1 ? "destination" : "waypoint",
        eta_hours_from_now: top.eta_hours && totalDist > 0
          ? Math.round(top.eta_hours * (cumDist[i] / totalDist) * 10) / 10 : null,
      }));
    }

    const result = {
      vessel: {
        name: bqv(v.vessel_name) || "Unknown", imo, flag: bqv(v.flag),
        lat: curLat, lng: curLng,
        speed_kn: Math.round(avgSpd * 10) / 10,
        heading:  Math.round(avgHdg),
        last_port:     bqv(v.last_port_departed),
        declared_dest: declaredDest,
        vessel_status: bqv(v.vessel_status),
        shipping_agent:bqv(v.shipping_agent),
        crew_count:    v.crew_count ? Number(v.crew_count) : null,
        data_quality:  v.data_quality_score ? Number(v.data_quality_score) : null,
        data_source:   isDbt ? "Photons_MPA.fct_vessel_master" : "MPA.MPA_Master_Vessels",
      },
      prediction: top ? {
        destination: top.port, destination_code: top.code,
        destination_lat: top.lat, destination_lng: top.lng,
        eta_hours: top.eta_hours, eta_label: top.eta_label, eta_iso: top.eta_iso,
        distance_nm: top.distance_nm, bearing_deg: top.bearing_deg,
        confidence: top.confidence, is_declared: top.is_declared,
        method: top.is_declared         ? "Declared destination confirmed"
              : hist.length > 20        ? "AIS trajectory + graph sea routing"
              :                           "Heading & maritime graph analysis",
        waypoints_count: wps.length, sea_route: true,
      } : null,
      alternatives: alts,
      route_waypoints: wps,
      analysis: {
        history_points:   hist.length,
        avg_speed_kn:     Math.round(avgSpd * 10) / 10,
        avg_heading:      Math.round(avgHdg),
        ports_scored:     PORTS.length,
        routing_engine:   "dijkstra-sea-graph-v10",
        data_source:      isDbt ? "Photons_MPA dbt tables" : "MPA legacy tables",
      },
    };

    setCache(`pred_${imo}`, result);
    logger.info(`[PREDICT v10] IMO=${imo} → ${top?.port} (${isDbt ? "dbt" : "legacy"})`);
    return res.json({ success: true, cached: false, ...result });

  } catch (err) {
    logger.error(`[PREDICT] FAIL IMO=${imo}:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;