// backend/src/routes/predict.js — AI Route Prediction v2
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");
const { BigQuery } = require("@google-cloud/bigquery");

const PROJECT        = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET        = process.env.BIGQUERY_DATASET    || "MPA";
const FULL_TABLE     = `\`${PROJECT}.${DATASET}.MPA_Master_Vessels\``;
const SNAPSHOT_TABLE = `\`${PROJECT}.${DATASET}.View_MPA_VesselPositionsSnapshot\``;
const BQ_LOCATION    = process.env.BIGQUERY_LOCATION   || "asia-southeast1";

let bigquery;
try {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    bigquery = new BigQuery({ credentials: creds, projectId: creds.project_id, location: BQ_LOCATION });
  } else {
    bigquery = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION });
  }
} catch(e) { logger.error("BQ init error:", e.message); }

// Cache: 5 min TTL
const cache = new Map();
function getCached(k) { const c = cache.get(k); return c && Date.now()-c.ts < 300000 ? c.data : null; }
function setCache(k, d) { cache.set(k, { data: d, ts: Date.now() }); }

// Major regional ports with coordinates
const PORTS = [
  { name: "Singapore",           lat:  1.264,  lng: 103.820, code: "SGSIN", region: "SG" },
  { name: "Port Klang",          lat:  3.000,  lng: 101.390, code: "MYPKG", region: "MY" },
  { name: "Johor Port",          lat:  1.764,  lng: 103.920, code: "MYJHB", region: "MY" },
  { name: "Tanjung Pelepas",     lat:  1.363,  lng: 103.553, code: "MYPTP", region: "MY" },
  { name: "Batam",               lat:  1.107,  lng: 104.030, code: "IDBTH", region: "ID" },
  { name: "Karimun",             lat:  1.040,  lng: 103.440, code: "IDKRM", region: "ID" },
  { name: "Dumai",               lat:  1.670,  lng: 101.450, code: "IDDUM", region: "ID" },
  { name: "Belawan",             lat:  3.794,  lng:  98.682, code: "IDBLW", region: "ID" },
  { name: "Tanjung Priok",       lat: -6.100,  lng: 106.880, code: "IDTPP", region: "ID" },
  { name: "Palembang",           lat: -2.916,  lng: 104.745, code: "IDPLM", region: "ID" },
  { name: "Penang",              lat:  5.414,  lng: 100.329, code: "MYPNG", region: "MY" },
  { name: "Pasir Gudang",        lat:  1.467,  lng: 103.886, code: "MYPGU", region: "MY" },
  { name: "Bangkok",             lat: 13.759,  lng: 100.502, code: "THBKK", region: "TH" },
  { name: "Laem Chabang",        lat: 13.086,  lng: 100.880, code: "THLCH", region: "TH" },
  { name: "Ho Chi Minh City",    lat: 10.782,  lng: 106.700, code: "VNSGN", region: "VN" },
  { name: "Hai Phong",           lat: 20.870,  lng: 106.688, code: "VNHPH", region: "VN" },
  { name: "Hong Kong",           lat: 22.302,  lng: 114.177, code: "HKHKG", region: "HK" },
  { name: "Colombo",             lat:  6.930,  lng:  79.858, code: "LKCMB", region: "LK" },
  { name: "Port Dickson",        lat:  2.527,  lng: 101.795, code: "MYPDK", region: "MY" },
  { name: "Kota Kinabalu",       lat:  5.976,  lng: 116.073, code: "MYBKI", region: "MY" },
];

function distNM(la1, lo1, la2, lo2) {
  const R=3440.065, r=Math.PI/180;
  const dLa=(la2-la1)*r, dLo=(lo2-lo1)*r;
  const a=Math.sin(dLa/2)**2+Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dLo/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function bearing(la1, lo1, la2, lo2) {
  const r=Math.PI/180, dLo=(lo2-lo1)*r;
  const y=Math.sin(dLo)*Math.cos(la2*r);
  const x=Math.cos(la1*r)*Math.sin(la2*r)-Math.sin(la1*r)*Math.cos(la2*r)*Math.cos(dLo);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}
function formatETA(h) {
  if (!h||h<0) return "Unknown";
  if (h<1) return `~${Math.round(h*60)} min`;
  if (h<24) return `~${h.toFixed(1)} hrs`;
  const d=Math.floor(h/24), rem=Math.round(h%24);
  return rem>0 ? `~${d}d ${rem}h` : `~${d} days`;
}

// GET /api/predict/:imo
router.get("/:imo", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo);
    if (!imo || isNaN(imo)) return res.status(400).json({ success:false, error:"Invalid IMO" });

    const ck = `pred_${imo}`;
    const hit = getCached(ck);
    if (hit) return res.json({ success:true, cached:true, ...hit });

    // 1. Current vessel state
    const [[vessel]] = await bigquery.query({
      query: `SELECT vessel_name, imo_number, mmsi_number, flag, vessel_type,
                     latitude_degrees, longitude_degrees, speed, heading, course,
                     last_port_departed, next_port_destination, declared_arrival_time,
                     last_departed_time, last_arrived_time
              FROM ${FULL_TABLE} WHERE imo_number=${imo} LIMIT 1`,
      location: BQ_LOCATION,
    });
    if (!vessel) return res.status(404).json({ success:false, error:"Vessel not found" });

    // 2. Recent AIS history 72h
    const [hist] = await bigquery.query({
      query: `SELECT latitude_degrees, longitude_degrees, speed, heading, course, effective_timestamp
              FROM ${SNAPSHOT_TABLE}
              WHERE imo_number=${imo}
                AND effective_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 72 HOUR)
                AND latitude_degrees IS NOT NULL AND longitude_degrees IS NOT NULL
              ORDER BY effective_timestamp ASC LIMIT 500`,
      location: BQ_LOCATION,
    });

    const curLat = Number(vessel.latitude_degrees||0);
    const curLng = Number(vessel.longitude_degrees||0);

    // Average heading/speed from last 10 points
    const recent = hist.slice(-10);
    let avgHdg = Number(vessel.heading||vessel.course||0);
    let avgSpd = Number(vessel.speed||0);
    if (recent.length>=2) {
      const hdgs = recent.map(p=>Number(p.heading||p.course||0)).filter(h=>h>0);
      const spds = recent.map(p=>Number(p.speed||0)).filter(s=>s>0.3);
      if (hdgs.length) avgHdg = hdgs.reduce((a,b)=>a+b)/hdgs.length;
      if (spds.length) avgSpd = spds.reduce((a,b)=>a+b)/spds.length;
    }

    // Declared destination string
    const declRaw = vessel.next_port_destination;
    const declaredDest = declRaw ? String(declRaw.value||declRaw).trim() : null;

    // Score each port
    const scored = PORTS.map(port => {
      const d   = distNM(curLat, curLng, port.lat, port.lng);
      const brg = bearing(curLat, curLng, port.lat, port.lng);

      // Heading alignment (0-1)
      let diff = Math.abs(brg - avgHdg);
      if (diff>180) diff=360-diff;
      const hdgScore = Math.max(0, 1 - diff/90);

      // Distance score (sweet spot 50-800 NM)
      const distScore = d<5?0 : d<50?0.2 : d<800?1.0 : d<2000?0.5 : 0.1;

      // Declared match
      const isDecl = declaredDest && (
        declaredDest.toLowerCase().includes(port.name.toLowerCase().slice(0,6)) ||
        port.name.toLowerCase().includes(declaredDest.toLowerCase().slice(0,6)) ||
        (port.code && declaredDest.toUpperCase().includes(port.code))
      );
      const declScore = isDecl ? 3.0 : 0;

      const total = hdgScore*1.8 + distScore + declScore;
      const etaH  = avgSpd>0.3 ? d/avgSpd : null;
      const etaDate= etaH ? new Date(Date.now()+etaH*3600000) : null;

      return {
        port: port.name, code: port.code, region: port.region,
        lat: port.lat, lng: port.lng,
        distance_nm:        Math.round(d),
        bearing_deg:        Math.round(brg),
        heading_alignment:  Math.round(hdgScore*100),
        score:              total,
        eta_hours:          etaH ? Math.round(etaH*10)/10 : null,
        eta_iso:            etaDate ? etaDate.toISOString() : null,
        eta_label:          etaH ? formatETA(etaH) : "Unknown",
        is_declared:        !!isDecl,
        confidence:         Math.min(Math.round(total*20), 97),
      };
    }).filter(p=>p.distance_nm>3).sort((a,b)=>b.score-a.score);

    const top  = scored[0];
    const alts = scored.slice(1,4);

    // Route waypoints (great circle interpolation)
    const waypoints = [];
    if (top) {
      waypoints.push({ lat:curLat, lng:curLng, label:"Current Position", type:"current" });
      const steps = Math.min(Math.ceil(top.distance_nm/100), 10);
      for (let i=1; i<steps; i++) {
        const t=i/steps;
        waypoints.push({
          lat: curLat+(top.lat-curLat)*t,
          lng: curLng+(top.lng-curLng)*t,
          label: `Waypoint ${i}`,
          type: "waypoint",
          eta_hours_from_now: top.eta_hours ? Math.round(top.eta_hours*t*10)/10 : null,
        });
      }
      waypoints.push({ lat:top.lat, lng:top.lng, label:top.port, type:"destination", eta_label:top.eta_label });
    }

    const result = {
      vessel: {
        name: vessel.vessel_name, imo, flag: vessel.flag,
        lat: curLat, lng: curLng,
        speed_kn:  Math.round(avgSpd*10)/10,
        speed_kmh: Math.round(avgSpd*1.852*10)/10,
        heading:   Math.round(avgHdg),
        last_port: vessel.last_port_departed ? String(vessel.last_port_departed.value||vessel.last_port_departed).trim() : null,
        declared_dest: declaredDest,
      },
      prediction: top ? {
        destination:     top.port,
        destination_code:top.code,
        destination_lat: top.lat,
        destination_lng: top.lng,
        eta_hours:       top.eta_hours,
        eta_label:       top.eta_label,
        eta_iso:         top.eta_iso,
        distance_nm:     top.distance_nm,
        bearing_deg:     top.bearing_deg,
        confidence:      top.confidence,
        is_declared:     top.is_declared,
        method: top.is_declared
          ? "Declared destination confirmed"
          : hist.length>20
            ? "AIS trajectory extrapolation"
            : "Heading & proximity analysis",
      } : null,
      alternatives: alts,
      route_waypoints: waypoints,
      analysis: {
        history_points: hist.length,
        avg_speed_kn:   Math.round(avgSpd*10)/10,
        avg_heading:    Math.round(avgHdg),
        ports_scored:   PORTS.length,
      },
    };

    setCache(ck, result);
    logger.info(`[PREDICT] IMO ${imo} → ${top?.port} (${top?.confidence}%)`);
    res.json({ success:true, cached:false, ...result });

  } catch(err) {
    logger.error("[PREDICT]", err.message);
    next(err);
  }
});

module.exports = router;
