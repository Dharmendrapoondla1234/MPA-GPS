// backend/src/routes/predict.js — v12 (High-Accuracy Prediction Engine)
//
// ACCURACY IMPROVEMENTS over v11:
//   1. vecBrng: proper great-circle bearing (not atan2 on raw lat/lng diff)
//   2. Trajectory momentum: weighted recent bearing, catches port approaches
//   3. Speed: median of last 6 readings, resistant to anchoring spikes
//   4. Declared destination: weight 6.0, broad fuzzy LOCODE+alias matching
//   5. Heading window tightened to ±60° (was ±90°)
//   6. Last-port penalty: -2.0 if vessel just left this port
//   7. Trajectory convergence bonus: +0.5 if bearing gap is shrinking
//   8. Confidence normalised properly (declared = 70–97%, undeclared = 10–72%)
//   9. Cache TTL 2 min (was 5 min) for faster refresh after position update
"use strict";
const express        = require("express");
const router         = express.Router();
const logger         = require("../utils/logger");
const maritimeRouter = require("../services/maritimeRouter");
const { bigquery, BQ_LOCATION, getVesselHistory, T } = require("../services/bigquery");

maritimeRouter.init(bigquery, BQ_LOCATION, T);

const cache = new Map();
function getCached(k) { const c = cache.get(k); return c && Date.now() - c.ts < 120_000 ? c.data : null; }
function setCache(k, d) { cache.set(k, { data: d, ts: Date.now() }); }

let _masterTable = null;
async function getMasterTable() {
  if (_masterTable) return _masterTable;
  try {
    await bigquery.query({ query: `SELECT 1 FROM ${T.MASTER} LIMIT 1`, location: BQ_LOCATION });
    _masterTable = { table: T.MASTER, isDbt: true };
  } catch (_) {
    _masterTable = { table: T.LEGACY_VESSELS, isDbt: false };
  }
  return _masterTable;
}

const PORTS = [
  { name:"Singapore",        lat:  1.264, lng:103.820, code:"SGSIN" },
  { name:"Port Klang",       lat:  3.000, lng:101.390, code:"MYPKG" },
  { name:"Tanjung Pelepas",  lat:  1.363, lng:103.553, code:"MYPTP" },
  { name:"Johor Port",       lat:  1.764, lng:103.920, code:"MYJHB" },
  { name:"Pasir Gudang",     lat:  1.467, lng:103.886, code:"MYPGU" },
  { name:"Penang",           lat:  5.414, lng:100.329, code:"MYPNG" },
  { name:"Batam",            lat:  1.107, lng:104.030, code:"IDBTH" },
  { name:"Dumai",            lat:  1.670, lng:101.450, code:"IDDUM" },
  { name:"Belawan",          lat:  3.794, lng: 98.682, code:"IDBLW" },
  { name:"Tanjung Priok",    lat: -6.100, lng:106.880, code:"IDTPP" },
  { name:"Palembang",        lat: -2.916, lng:104.745, code:"IDPLM" },
  { name:"Bangkok",          lat: 13.759, lng:100.502, code:"THBKK" },
  { name:"Laem Chabang",     lat: 13.086, lng:100.880, code:"THLCH" },
  { name:"Ho Chi Minh City", lat: 10.782, lng:106.700, code:"VNSGN" },
  { name:"Hai Phong",        lat: 20.870, lng:106.688, code:"VNHPH" },
  { name:"Hong Kong",        lat: 22.302, lng:114.177, code:"HKHKG" },
  { name:"Colombo",          lat:  6.930, lng: 79.858, code:"LKCMB" },
  { name:"Kota Kinabalu",    lat:  5.976, lng:116.073, code:"MYBKI" },
  { name:"Kuching",          lat:  1.593, lng:110.343, code:"MYKCH" },
  { name:"Port Dickson",     lat:  2.527, lng:101.795, code:"MYPDK" },
  { name:"Karimun",          lat:  1.040, lng:103.440, code:"IDKRM" },
  { name:"Lumut",            lat:  4.230, lng:100.628, code:"MYLMT" },
  { name:"Kuala Terengganu", lat:  5.330, lng:103.140, code:"MYKTR" },
  { name:"Kuantan",          lat:  3.840, lng:103.340, code:"MYKTN" },
  { name:"Tanjung Balai",    lat:  1.000, lng:103.350, code:"IDTBL" },
  { name:"Balikpapan",       lat: -1.238, lng:116.831, code:"IDBPN" },
  { name:"Surabaya",         lat: -7.207, lng:112.737, code:"IDSUB" },
  { name:"Manila",           lat: 14.592, lng:120.978, code:"PHMNL" },
];

const distNM = maritimeRouter.distNM;

function calcBrng(la1, lo1, la2, lo2) {
  const r = Math.PI / 180;
  const dL = (lo2 - lo1) * r;
  const y  = Math.sin(dL) * Math.cos(la2 * r);
  const x  = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos(dL);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function bearingDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fmtETA(h) {
  if (!h || h < 0) return "Unknown";
  if (h < 1)  return `~${Math.round(h * 60)}min`;
  if (h < 24) return `~${h.toFixed(1)}h`;
  const d = Math.floor(h / 24), rm = Math.round(h % 24);
  return rm > 0 ? `~${d}d ${rm}h` : `~${d}d`;
}

function bqv(v) {
  if (v == null) return null;
  if (typeof v === "object" && "value" in v) return String(v.value).trim() || null;
  return String(v).trim() || null;
}

function isDeclaredMatch(declaredDest, port) {
  if (!declaredDest) return false;
  const dd = declaredDest.toLowerCase().trim();
  const pn = port.name.toLowerCase();
  const pc = port.code.toLowerCase();
  if (dd.includes(pc) || dd === pc) return true;
  if (dd.includes(pn.slice(0, 4)) || pn.includes(dd.slice(0, 4))) return true;
  const aliases = {
    "SGSIN": ["sg", "spore", "sing", "singapore"],
    "MYPKG": ["klang", "pkg", "north port", "west port", "northport", "westport"],
    "MYPTP": ["pelepas", "ptp", "tg pelepas", "tanjong pelepas"],
    "IDTPP": ["priok", "tanjung priok", "jakarta"],
    "THBKK": ["bangkok", "bkk"],
    "THLCH": ["laem", "laem chabang"],
    "HKHKG": ["hong kong", "hkg"],
    "LKCMB": ["colombo", "cmb"],
    "VNSGN": ["ho chi minh", "hcm", "saigon"],
    "MYPGU": ["pasir gudang", "pgu"],
  };
  return (aliases[port.code] || []).some(a => dd.includes(a));
}

router.get("/ping", (_req, res) => res.json({ ok: true, router: "high-accuracy-v12" }));

router.get("/:imo", async (req, res) => {
  const imo = parseInt(req.params.imo);
  if (!imo || isNaN(imo)) return res.status(400).json({ success: false, error: "Invalid IMO" });

  const hit = getCached(`pred_${imo}`);
  if (hit) return res.json({ success: true, cached: true, ...hit });

  try {
    logger.info(`[PREDICT v12] IMO=${imo}`);
    const { table: masterTable, isDbt } = await getMasterTable();
    const RAD = 180 / Math.PI;

    const dbtCols    = "vessel_status, arrived_at_berth AS berth_location, arrival_agent AS shipping_agent, crew_count, passenger_count, data_quality_score";
    const legacyCols = "NULL AS vessel_status, NULL AS berth_location, NULL AS shipping_agent, NULL AS crew_count, NULL AS passenger_count, NULL AS data_quality_score";

    const [vesselRows] = await bigquery.query({
      query: isDbt ? `
        SELECT vessel_name,
               latitude  AS lat_raw, longitude AS lng_raw,
               speed_kn AS speed, heading_deg AS heading, course_deg AS course,
               flag, arrived_from AS last_port_departed, next_port AS next_port_destination,
               ${dbtCols}
        FROM ${masterTable}
        WHERE CAST(imo_number AS STRING) = '${imo}' LIMIT 1`
      : `
        SELECT vessel_name,
               latitude_degrees AS lat_raw, longitude_degrees AS lng_raw,
               speed, heading, course, flag,
               last_port_departed, next_port_destination,
               ${legacyCols}
        FROM ${masterTable}
        WHERE CAST(imo_number AS INT64) = ${imo} LIMIT 1`,
      location: BQ_LOCATION,
    });
    if (!vesselRows?.length) return res.status(404).json({ success: false, error: `IMO ${imo} not found` });

    const v = vesselRows[0];
    function toDeg(x) { const n = Number(x || 0); return Math.abs(n) < 4 ? n * RAD : n; }
    const curLat = toDeg(v.lat_raw);
    const curLng = toDeg(v.lng_raw);
    if (!curLat && !curLng) return res.status(422).json({ success: false, error: "No position data" });

    let hist = [];
    try { hist = await getVesselHistory(imo, 72); } catch (e) { logger.warn(`[PREDICT] hist: ${e.message}`); }

    const pts = hist.map(p => ({
      lat: toDeg(p.latitude_degrees ?? p.lat_raw ?? 0),
      lng: toDeg(p.longitude_degrees ?? p.lng_raw ?? 0),
      speed:   parseFloat(p.speed   ?? 0),
      heading: parseFloat(p.heading ?? 0),
      ts: new Date(typeof p.effective_timestamp === "object" && p.effective_timestamp?.value
        ? p.effective_timestamp.value : p.effective_timestamp).getTime(),
    })).filter(p => p.lat && p.lng && !isNaN(p.lat));

    // Median speed from last 6 moving points
    const recentSpds = pts.slice(-6).map(p => p.speed).filter(s => s > 0.5);
    const avgSpd     = recentSpds.length >= 2 ? median(recentSpds) : (parseFloat(v.speed || 0) || 8.0);

    // Weighted-average heading (recent points heavier)
    const recentHdgs = pts.slice(-10).map((p, i, a) => ({ h: p.heading, w: (i + 1) / a.length })).filter(x => x.h > 0);
    let avgHdg = parseFloat(v.heading || v.course || 0);
    if (recentHdgs.length >= 2) {
      const wSum = recentHdgs.reduce((s, x) => s + x.w, 0);
      avgHdg = recentHdgs.reduce((s, x) => s + x.h * x.w, 0) / wSum;
    }

    // Long-range trajectory bearing (great-circle, first→last)
    let vecBrng = avgHdg;
    if (pts.length >= 3) {
      const o = pts[0], n = pts[pts.length - 1];
      if ((n.ts - o.ts) / 3_600_000 > 0.5 && o.lat && n.lat)
        vecBrng = calcBrng(o.lat, o.lng, n.lat, n.lng);
    }

    // Short-range momentum bearing (last 6 pts — catches recent turns)
    let momentumBrng = vecBrng;
    if (pts.length >= 6) {
      const ms = pts[pts.length - 6], me = pts[pts.length - 1];
      if ((me.ts - ms.ts) / 3_600_000 > 0.1)
        momentumBrng = calcBrng(ms.lat, ms.lng, me.lat, me.lng);
    }

    const declaredDest = bqv(v.next_port_destination);
    const lastPort     = bqv(v.last_port_departed);

    const scored = PORTS.map(port => {
      const dist = distNM(curLat, curLng, port.lat, port.lng);
      const brng = calcBrng(curLat, curLng, port.lat, port.lng);

      // Alignment scores — ±60° window (tighter than v11)
      const hdgScore = Math.max(0, 1 - bearingDiff(brng, avgHdg)       / 60) * 1.5;
      const vecScore = Math.max(0, 1 - bearingDiff(brng, vecBrng)      / 60) * 2.0;
      const momScore = Math.max(0, 1 - bearingDiff(brng, momentumBrng) / 60) * 2.5;

      const isDecl    = isDeclaredMatch(declaredDest, port);
      const declScore = isDecl ? 6.0 : 0;

      const isLastPort = lastPort && (
        lastPort.toLowerCase().includes(port.name.toLowerCase().slice(0, 4)) ||
        port.name.toLowerCase().includes(lastPort.toLowerCase().slice(0, 4)) ||
        lastPort.toUpperCase().includes(port.code)
      );
      const lastPortPenalty = (!isDecl && isLastPort) ? -2.0 : 0;

      // Convergence bonus: recent bearing more aligned than long-range?
      let convergenceBonus = 0;
      if (pts.length >= 4) {
        const mid  = pts[Math.floor(pts.length / 2)];
        const bMid = calcBrng(mid.lat, mid.lng, port.lat, port.lng);
        if (bearingDiff(brng, momentumBrng) < bearingDiff(bMid, vecBrng) - 5)
          convergenceBonus = 0.5;
      }

      const total = hdgScore + vecScore + momScore + declScore + lastPortPenalty + convergenceBonus;
      const etaH  = avgSpd > 0.5 ? dist / avgSpd : null;

      return {
        port: port.name, code: port.code, lat: port.lat, lng: port.lng,
        distance_nm:  Math.round(dist),
        bearing_deg:  Math.round(brng),
        score: total,
        eta_hours:    etaH ? Math.round(etaH * 10) / 10 : null,
        eta_iso:      etaH ? new Date(Date.now() + etaH * 3_600_000).toISOString() : null,
        eta_label:    etaH ? fmtETA(etaH) : "Unknown",
        is_declared:  isDecl,
        confidence:   Math.min(Math.max(10, Math.round(
          isDecl
            ? 55 + Math.min((hdgScore + vecScore + momScore) / 6.0, 1) * 42
            : Math.min(total / 6.0, 1) * 72
        )), 97),
        heading_alignment: Math.round(Math.max(0, 1 - bearingDiff(brng, avgHdg) / 180) * 100),
      };
    }).filter(p => p.distance_nm > 3).sort((a, b) => b.score - a.score);

    const top  = scored[0];
    const alts = scored.slice(1, 4);

    let wps = [];
    let routeMeta = { method: "none", routingEngine: "none", laneHits: 0 };

    if (top) {
      try {
        const result = await maritimeRouter.route(curLat, curLng, top.lat, top.lng, avgHdg);
        routeMeta    = result;
        let totalNM  = 0;
        const cumNM  = [0];
        const rWps   = result.waypoints;
        for (let i = 1; i < rWps.length; i++) {
          totalNM += distNM(rWps[i - 1].lat, rWps[i - 1].lng, rWps[i].lat, rWps[i].lng);
          cumNM.push(totalNM);
        }
        wps = rWps.map((pt, i) => ({
          lat: pt.lat, lng: pt.lng,
          type:  pt.type || (i === 0 ? "current" : i === rWps.length - 1 ? "destination" : "waypoint"),
          label: i === 0               ? "Current Position"
               : i === rWps.length - 1 ? top.port
               : pt.type === "TSS"     ? "TSS Waypoint"
               : pt.type === "DWR"     ? "Deep Water Route"
               : pt.vesselCount        ? `AIS Lane (${pt.vesselCount} vessels)`
               : `Waypoint ${i}`,
          eta_hours_from_now: top.eta_hours && totalNM > 0
            ? Math.round(top.eta_hours * (cumNM[i] / totalNM) * 10) / 10 : null,
          lane_type:    pt.type,
          vessel_count: pt.vesselCount || null,
        }));
      } catch (routeErr) {
        logger.error(`[PREDICT] Route error: ${routeErr.message}`);
        wps = [
          { lat: curLat,   lng: curLng,   type: "current",     label: "Current Position" },
          { lat: top.lat,  lng: top.lng,  type: "destination", label: top.port           },
        ];
      }
    }

    const result = {
      vessel: {
        name: bqv(v.vessel_name) || "Unknown", imo, flag: bqv(v.flag),
        lat: curLat, lng: curLng,
        speed_kn:           Math.round(avgSpd * 10) / 10,
        heading:            Math.round(avgHdg),
        trajectory_bearing: Math.round(vecBrng),
        momentum_bearing:   Math.round(momentumBrng),
        last_port:          lastPort,
        declared_dest:      declaredDest,
        vessel_status:      bqv(v.vessel_status),
        data_source:        isDbt ? "MPA dbt" : "MPA legacy",
      },
      prediction: top ? {
        destination:        top.port,
        destination_code:   top.code,
        destination_lat:    top.lat,
        destination_lng:    top.lng,
        eta_hours:          top.eta_hours,
        eta_label:          top.eta_label,
        eta_iso:            top.eta_iso,
        distance_nm:        top.distance_nm,
        bearing_deg:        top.bearing_deg,
        confidence:         top.confidence,
        is_declared:        top.is_declared,
        method:             routeMeta.method,
        routing_engine:     routeMeta.routingEngine,
        waypoints_count:    wps.length,
        sea_route:          true,
        tss_waypoints:      wps.filter(w => w.lane_type === "TSS").length,
        ais_waypoints:      wps.filter(w => w.lane_type === "AIS").length,
        dwr_waypoints:      wps.filter(w => w.lane_type === "DWR").length,
        route_method:       routeMeta.method,
      } : null,
      alternatives: alts,
      route_waypoints: wps,
      analysis: {
        history_points:     hist.length,
        trajectory_bearing: Math.round(vecBrng),
        momentum_bearing:   Math.round(momentumBrng),
        avg_speed_kn:       Math.round(avgSpd * 10) / 10,
        avg_heading:        Math.round(avgHdg),
        declared_dest:      declaredDest,
        routing_method:     routeMeta.method,
        routing_engine:     routeMeta.routingEngine,
        lane_hits:          routeMeta.laneHits,
        data_source:        isDbt ? "MPA dbt tables" : "MPA legacy tables",
        engine_version:     "v12-high-accuracy",
      },
    };

    setCache(`pred_${imo}`, result);
    logger.info(`[PREDICT v12] IMO=${imo} → ${top?.port} (${top?.confidence}% conf) via ${routeMeta.method}`);
    return res.json({ success: true, cached: false, ...result });

  } catch (err) {
    logger.error(`[PREDICT] FAIL IMO=${imo}: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;