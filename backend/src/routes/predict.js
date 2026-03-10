// backend/src/routes/predict.js — v11 (AIS-learned + TSS + DWR routing)
"use strict";
const express        = require("express");
const router         = express.Router();
const logger         = require("../utils/logger");
const maritimeRouter = require("../services/maritimeRouter");
const { bigquery, BQ_LOCATION, getVesselHistory, T } = require("../services/bigquery");

// ── Initialise maritimeRouter with BigQuery deps on first import ──────────────
maritimeRouter.init(bigquery, BQ_LOCATION, T);

const cache = new Map();
function getCached(k) { const c = cache.get(k); return c && Date.now() - c.ts < 300_000 ? c.data : null; }
function setCache(k, d) { cache.set(k, { data: d, ts: Date.now() }); }

// Auto-detect master table
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
  { name:"Singapore",       lat: 1.264, lng:103.820, code:"SGSIN" },
  { name:"Port Klang",      lat: 3.000, lng:101.390, code:"MYPKG" },
  { name:"Tanjung Pelepas", lat: 1.363, lng:103.553, code:"MYPTP" },
  { name:"Johor Port",      lat: 1.764, lng:103.920, code:"MYJHB" },
  { name:"Penang",          lat: 5.414, lng:100.329, code:"MYPNG" },
  { name:"Batam",           lat: 1.107, lng:104.030, code:"IDBTH" },
  { name:"Dumai",           lat: 1.670, lng:101.450, code:"IDDUM" },
  { name:"Belawan",         lat: 3.794, lng: 98.682, code:"IDBLW" },
  { name:"Tanjung Priok",   lat:-6.100, lng:106.880, code:"IDTPP" },
  { name:"Palembang",       lat:-2.916, lng:104.745, code:"IDPLM" },
  { name:"Bangkok",         lat:13.759, lng:100.502, code:"THBKK" },
  { name:"Ho Chi Minh City",lat:10.782, lng:106.700, code:"VNSGN" },
  { name:"Hai Phong",       lat:20.870, lng:106.688, code:"VNHPH" },
  { name:"Hong Kong",       lat:22.302, lng:114.177, code:"HKHKG" },
  { name:"Colombo",         lat: 6.930, lng: 79.858, code:"LKCMB" },
  { name:"Kota Kinabalu",   lat: 5.976, lng:116.073, code:"MYBKI" },
  { name:"Port Dickson",    lat: 2.527, lng:101.795, code:"MYPDK" },
  { name:"Karimun",         lat: 1.040, lng:103.440, code:"IDKRM" },
  { name:"Pasir Gudang",    lat: 1.467, lng:103.886, code:"MYPGU" },
  { name:"Laem Chabang",    lat:13.086, lng:100.880, code:"THLCH" },
];

const distNM    = maritimeRouter.distNM;
function calcBrng(la1,lo1,la2,lo2){const r=Math.PI/180,dL=(lo2-lo1)*r,y=Math.sin(dL)*Math.cos(la2*r),x=Math.cos(la1*r)*Math.sin(la2*r)-Math.sin(la1*r)*Math.cos(la2*r)*Math.cos(dL);return(Math.atan2(y,x)*180/Math.PI+360)%360;}
function fmtETA(h){if(!h||h<0)return"Unknown";if(h<1)return`~${Math.round(h*60)}min`;if(h<24)return`~${h.toFixed(1)}h`;const d=Math.floor(h/24),rm=Math.round(h%24);return rm>0?`~${d}d ${rm}h`:`~${d}d`;}
function bqv(v){if(v==null)return null;if(typeof v==="object"&&"value"in v)return String(v.value).trim()||null;return String(v).trim()||null;}

router.get("/ping", (_req, res) => res.json({ ok: true, router: "AIS+TSS-v11" }));

router.get("/:imo", async (req, res) => {
  const imo = parseInt(req.params.imo);
  if (!imo || isNaN(imo)) return res.status(400).json({ success: false, error: "Invalid IMO" });

  const hit = getCached(`pred_${imo}`);
  if (hit) return res.json({ success: true, cached: true, ...hit });

  try {
    logger.info(`[PREDICT v11] IMO=${imo}`);
    const { table: masterTable, isDbt } = await getMasterTable();
    const RAD = 180 / Math.PI;

    // ── Fetch vessel position + metadata ──────────────────────────────────
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
    function toDeg(x){ const n=Number(x||0); return Math.abs(n)<4?n*RAD:n; }
    const curLat = toDeg(v.lat_raw);
    const curLng = toDeg(v.lng_raw);
    if (!curLat && !curLng) return res.status(422).json({ success: false, error: "No position data" });

    // ── Fetch AIS history (last 72h) ──────────────────────────────────────
    let hist = [];
    try { hist = await getVesselHistory(imo, 72); } catch (e) { logger.warn(`[PREDICT] hist: ${e.message}`); }

    const recent = hist.slice(-15);
    let avgHdg = Number(v.heading || v.course || 0);
    let avgSpd = Number(v.speed || 0);
    if (recent.length >= 2) {
      const hdgs = recent.map(p => Number(p.heading||0)).filter(h=>h>0);
      const spds = recent.map(p => Number(p.speed||0)).filter(s=>s>0.3);
      if (hdgs.length) avgHdg = hdgs.reduce((a,b)=>a+b) / hdgs.length;
      if (spds.length) avgSpd = spds.reduce((a,b)=>a+b) / spds.length;
    }

    // Movement vector from trajectory
    let vecBrng = avgHdg;
    if (hist.length >= 3) {
      const o = hist[0], n = hist[hist.length-1];
      const hrs = (new Date(n.effective_timestamp||0) - new Date(o.effective_timestamp||0)) / 3600000;
      if (hrs > 0.5) {
        const la1 = toDeg(o.latitude_degrees||o.lat_raw||0);
        const lo1 = toDeg(o.longitude_degrees||o.lng_raw||0);
        const la2 = toDeg(n.latitude_degrees||n.lat_raw||0);
        const lo2 = toDeg(n.longitude_degrees||n.lng_raw||0);
        if (la1 && lo1 && la2 && lo2)
          vecBrng = (Math.atan2(lo2-lo1, la2-la1) * 180/Math.PI + 360) % 360;
      }
    }

    // ── Score candidate ports ─────────────────────────────────────────────
    const declaredDest = bqv(v.next_port_destination);

    const scored = PORTS.map(port => {
      const dist = distNM(curLat, curLng, port.lat, port.lng);
      const brng = calcBrng(curLat, curLng, port.lat, port.lng);
      let hdgDiff = Math.abs(brng - avgHdg); if (hdgDiff>180) hdgDiff=360-hdgDiff;
      let vecDiff = Math.abs(brng - vecBrng); if (vecDiff>180) vecDiff=360-vecDiff;
      const hdgScore = Math.max(0, 1 - hdgDiff/90) * 1.8;
      const vecScore = Math.max(0, 1 - vecDiff/90) * 1.5;
      const dstScore = dist<5?0:dist<50?0.3:dist<200?1.2:dist<800?1.0:dist<2000?0.6:0.2;
      const isDecl   = !!(declaredDest && (
        declaredDest.toLowerCase().includes(port.name.toLowerCase().slice(0,5)) ||
        port.name.toLowerCase().includes(declaredDest.toLowerCase().slice(0,5)) ||
        declaredDest.toUpperCase().includes(port.code)
      ));
      const total  = hdgScore + vecScore + dstScore + (isDecl ? 3.5 : 0);
      const etaH   = avgSpd > 0.3 ? dist / avgSpd : null;
      return {
        port: port.name, code: port.code, lat: port.lat, lng: port.lng,
        distance_nm: Math.round(dist), bearing_deg: Math.round(brng),
        score: total,
        eta_hours:   etaH ? Math.round(etaH*10)/10 : null,
        eta_iso:     etaH ? new Date(Date.now()+etaH*3600000).toISOString() : null,
        eta_label:   etaH ? fmtETA(etaH) : "Unknown",
        is_declared: isDecl,
        confidence:  Math.min(Math.round(total*16), 97),
        heading_alignment: Math.round(Math.max(0, 1 - Math.min(Math.abs(brng - avgHdg) > 180 ? 360 - Math.abs(brng - avgHdg) : Math.abs(brng - avgHdg), 90) / 90) * 100),
      };
    }).filter(p => p.distance_nm > 3).sort((a,b) => b.score - a.score);

    const top  = scored[0];
    const alts = scored.slice(1, 4);

    // ── Compute sea route via AIS+TSS+DWR engine ──────────────────────────
    let wps = [];
    let routeMeta = { method: "none", routingEngine: "none", laneHits: 0 };

    if (top) {
      try {
        const result = await maritimeRouter.route(curLat, curLng, top.lat, top.lng, avgHdg);
        routeMeta    = result;

        // Annotate waypoints with cumulative ETA
        let totalNM = 0;
        const cumNM = [0];
        const rWps  = result.waypoints;
        for (let i=1; i<rWps.length; i++) {
          totalNM += distNM(rWps[i-1].lat, rWps[i-1].lng, rWps[i].lat, rWps[i].lng);
          cumNM.push(totalNM);
        }

        wps = rWps.map((pt, i) => ({
          lat: pt.lat, lng: pt.lng,
          type:  pt.type || (i===0?"current": i===rWps.length-1?"destination":"waypoint"),
          label: i===0 ? "Current Position"
               : i===rWps.length-1 ? top.port
               : pt.type === "TSS"  ? "TSS Waypoint"
               : pt.type === "DWR"  ? "Deep Water Route"
               : pt.vesselCount     ? `Lane (${pt.vesselCount} vessels)`
               : `Waypoint ${i}`,
          eta_hours_from_now: top.eta_hours && totalNM > 0
            ? Math.round(top.eta_hours * (cumNM[i]/totalNM) * 10) / 10 : null,
          lane_type: pt.type,
          vessel_count: pt.vesselCount || null,
        }));
      } catch (routeErr) {
        logger.error(`[PREDICT] Route error: ${routeErr.message}`);
        // Fallback: direct line
        wps = [
          { lat: curLat, lng: curLng, type: "current", label: "Current Position" },
          { lat: top.lat, lng: top.lng, type: "destination", label: top.port },
        ];
      }
    }

    const result = {
      vessel: {
        name:          bqv(v.vessel_name) || "Unknown", imo, flag: bqv(v.flag),
        lat: curLat,   lng: curLng,
        speed_kn:      Math.round(avgSpd * 10) / 10,
        heading:       Math.round(avgHdg),
        last_port:     bqv(v.last_port_departed),
        declared_dest: declaredDest,
        vessel_status: bqv(v.vessel_status),
        shipping_agent:bqv(v.shipping_agent),
        crew_count:    v.crew_count ? Number(v.crew_count) : null,
        data_quality:  v.data_quality_score ? Number(v.data_quality_score) : null,
        data_source:   isDbt ? "Photons_MPA dbt" : "MPA legacy",
      },
      prediction: top ? {
        destination: top.port, destination_code: top.code,
        destination_lat: top.lat, destination_lng: top.lng,
        eta_hours: top.eta_hours, eta_label: top.eta_label, eta_iso: top.eta_iso,
        distance_nm: top.distance_nm, bearing_deg: top.bearing_deg,
        confidence: top.confidence, is_declared: top.is_declared,
        method: routeMeta.method,
        routing_engine: routeMeta.routingEngine,
        waypoints_count: wps.length,
        sea_route: true,
        tss_waypoints: wps.filter(w=>w.lane_type==="TSS").length,
        ais_waypoints: wps.filter(w=>w.lane_type==="AIS").length,
        dwr_waypoints: wps.filter(w=>w.lane_type==="DWR").length,
      } : null,
      alternatives: alts,
      route_waypoints: wps,
      analysis: {
        history_points:    hist.length,
        avg_speed_kn:      Math.round(avgSpd * 10) / 10,
        avg_heading:       Math.round(avgHdg),
        routing_method:    routeMeta.method,
        routing_engine:    routeMeta.routingEngine,
        lane_hits:         routeMeta.laneHits,
        data_source:       isDbt ? "Photons_MPA dbt tables" : "MPA legacy tables",
      },
    };

    setCache(`pred_${imo}`, result);
    logger.info(`[PREDICT v11] IMO=${imo} → ${top?.port} via ${routeMeta.method}`);
    return res.json({ success: true, cached: false, ...result });

  } catch (err) {
    logger.error(`[PREDICT] FAIL IMO=${imo}: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;