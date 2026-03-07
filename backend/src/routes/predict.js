// backend/src/routes/predict.js — AI Route Prediction v6
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");

const {
  bigquery,
  BQ_LOCATION,
  FULL_TABLE,
  SNAPSHOT_TABLE,
  getVesselHistory,
} = require("../services/bigquery");

const cache = new Map();
function getCached(k) { const c = cache.get(k); return c && Date.now()-c.ts < 300000 ? c.data : null; }
function setCache(k,d) { cache.set(k, { data:d, ts:Date.now() }); }

const PORTS = [
  { name:"Singapore",        lat: 1.264, lng:103.820, code:"SGSIN" },
  { name:"Port Klang",       lat: 3.000, lng:101.390, code:"MYPKG" },
  { name:"Johor Port",       lat: 1.764, lng:103.920, code:"MYJHB" },
  { name:"Tanjung Pelepas",  lat: 1.363, lng:103.553, code:"MYPTP" },
  { name:"Batam",            lat: 1.107, lng:104.030, code:"IDBTH" },
  { name:"Karimun",          lat: 1.040, lng:103.440, code:"IDKRM" },
  { name:"Dumai",            lat: 1.670, lng:101.450, code:"IDDUM" },
  { name:"Belawan",          lat: 3.794, lng: 98.682, code:"IDBLW" },
  { name:"Tanjung Priok",    lat:-6.100, lng:106.880, code:"IDTPP" },
  { name:"Palembang",        lat:-2.916, lng:104.745, code:"IDPLM" },
  { name:"Penang",           lat: 5.414, lng:100.329, code:"MYPNG" },
  { name:"Pasir Gudang",     lat: 1.467, lng:103.886, code:"MYPGU" },
  { name:"Bangkok",          lat:13.759, lng:100.502, code:"THBKK" },
  { name:"Laem Chabang",     lat:13.086, lng:100.880, code:"THLCH" },
  { name:"Ho Chi Minh City", lat:10.782, lng:106.700, code:"VNSGN" },
  { name:"Hai Phong",        lat:20.870, lng:106.688, code:"VNHPH" },
  { name:"Hong Kong",        lat:22.302, lng:114.177, code:"HKHKG" },
  { name:"Colombo",          lat: 6.930, lng: 79.858, code:"LKCMB" },
  { name:"Port Dickson",     lat: 2.527, lng:101.795, code:"MYPDK" },
  { name:"Kota Kinabalu",    lat: 5.976, lng:116.073, code:"MYBKI" },
];

function distNM(la1,lo1,la2,lo2){const R=3440.065,r=Math.PI/180,dLa=(la2-la1)*r,dLo=(lo2-lo1)*r,a=Math.sin(dLa/2)**2+Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dLo/2)**2;return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
function calcBrng(la1,lo1,la2,lo2){const r=Math.PI/180,dLo=(lo2-lo1)*r,y=Math.sin(dLo)*Math.cos(la2*r),x=Math.cos(la1*r)*Math.sin(la2*r)-Math.sin(la1*r)*Math.cos(la2*r)*Math.cos(dLo);return(Math.atan2(y,x)*180/Math.PI+360)%360;}
function fmtETA(h){if(!h||h<0)return"Unknown";if(h<1)return`~${Math.round(h*60)} min`;if(h<24)return`~${h.toFixed(1)} hrs`;const d=Math.floor(h/24),r=Math.round(h%24);return r>0?`~${d}d ${r}h`:`~${d} days`;}
function bqv(v){if(v==null)return null;if(typeof v==="object"&&"value"in v)return String(v.value).trim()||null;return String(v).trim()||null;}

// Diagnostic ping
router.get("/ping", (_req, res) => res.json({ ok:true, bq: !!bigquery }));

// Main prediction
router.get("/:imo", async (req, res) => {
  const imo = parseInt(req.params.imo);
  if (!imo || isNaN(imo)) return res.status(400).json({ success:false, error:"Invalid IMO" });

  const ck = `pred_${imo}`;
  const hit = getCached(ck);
  if (hit) return res.json({ success:true, cached:true, ...hit });

  if (!bigquery) return res.status(500).json({ success:false, error:"BigQuery client not initialised" });

  try {
    logger.info(`[PREDICT] start IMO=${imo}`);

    // 1. Vessel current state
    const [vesselRows] = await bigquery.query({
      query: `
        SELECT vessel_name, latitude_degrees, longitude_degrees,
               speed, heading, course, flag,
               last_port_departed, next_port_destination
        FROM ${FULL_TABLE}
        WHERE CAST(imo_number AS INT64) = ${imo}
        LIMIT 1
      `,
      location: BQ_LOCATION,
    });

    if (!vesselRows || vesselRows.length === 0) {
      return res.status(404).json({ success:false, error:`Vessel IMO ${imo} not found in database` });
    }

    const v      = vesselRows[0];
    const curLat = Number(v.latitude_degrees  || 0);
    const curLng = Number(v.longitude_degrees || 0);

    if (!curLat && !curLng) {
      return res.status(422).json({ success:false, error:"Vessel has no position data" });
    }

    // 2. AIS history — use proven getVesselHistory from bigquery service
    let hist = [];
    try {
      hist = await getVesselHistory(imo, 72);
    } catch(e) {
      logger.warn(`[PREDICT] history failed (non-fatal): ${e.message}`);
    }
    logger.info(`[PREDICT] IMO=${imo} hist=${hist.length} pos=(${curLat},${curLng})`);

    // 3. Avg speed/heading from last 10 points
    const recent = hist.slice(-10);
    let avgHdg = Number(v.heading || v.course || 0);
    let avgSpd = Number(v.speed   || 0);
    if (recent.length >= 2) {
      const hdgs = recent.map(p => Number(p.heading||p.course||0)).filter(h => h > 0);
      const spds = recent.map(p => Number(p.speed  ||0          )).filter(s => s > 0.3);
      if (hdgs.length) avgHdg = hdgs.reduce((a,b)=>a+b) / hdgs.length;
      if (spds.length) avgSpd = spds.reduce((a,b)=>a+b) / spds.length;
    }
    const declaredDest = bqv(v.next_port_destination);

    // 4. Score all ports
    const scored = PORTS.map(port => {
      const d    = distNM(curLat, curLng, port.lat, port.lng);
      const b    = calcBrng(curLat, curLng, port.lat, port.lng);
      let diff   = Math.abs(b - avgHdg);
      if (diff > 180) diff = 360 - diff;
      const hdgS = Math.max(0, 1 - diff/90);
      const dstS = d<5?0 : d<50?0.2 : d<800?1.0 : d<2000?0.5 : 0.1;
      const isD  = declaredDest && (
        declaredDest.toLowerCase().includes(port.name.toLowerCase().slice(0,6)) ||
        port.name.toLowerCase().includes(declaredDest.toLowerCase().slice(0,6)) ||
        declaredDest.toUpperCase().includes(port.code)
      );
      const total = hdgS*1.8 + dstS + (isD ? 3.0 : 0);
      const etaH  = avgSpd > 0.3 ? d/avgSpd : null;
      return {
        port: port.name, code: port.code, lat: port.lat, lng: port.lng,
        distance_nm:       Math.round(d),
        bearing_deg:       Math.round(b),
        heading_alignment: Math.round(hdgS*100),
        score:             total,
        eta_hours:         etaH ? Math.round(etaH*10)/10 : null,
        eta_iso:           etaH ? new Date(Date.now()+etaH*3600000).toISOString() : null,
        eta_label:         etaH ? fmtETA(etaH) : "Unknown",
        is_declared:       !!isD,
        confidence:        Math.min(Math.round(total*20), 97),
      };
    }).filter(p => p.distance_nm > 3).sort((a,b) => b.score - a.score);

    const top  = scored[0];
    const alts = scored.slice(1, 4);

    // 5. Route waypoints
    const wps = [];
    if (top) {
      wps.push({ lat:curLat, lng:curLng, label:"Current Position", type:"current" });
      const steps = Math.min(Math.ceil(top.distance_nm/100), 10);
      for (let i=1; i<steps; i++) {
        const t = i/steps;
        wps.push({
          lat: curLat + (top.lat-curLat)*t,
          lng: curLng + (top.lng-curLng)*t,
          label: `Waypoint ${i}`, type:"waypoint",
          eta_hours_from_now: top.eta_hours ? Math.round(top.eta_hours*t*10)/10 : null,
        });
      }
      wps.push({ lat:top.lat, lng:top.lng, label:top.port, type:"destination", eta_label:top.eta_label });
    }

    const result = {
      vessel: {
        name:          bqv(v.vessel_name) || "Unknown",
        imo,
        flag:          bqv(v.flag),
        lat:           curLat,
        lng:           curLng,
        speed_kn:      Math.round(avgSpd*10)/10,
        speed_kmh:     Math.round(avgSpd*1.852*10)/10,
        heading:       Math.round(avgHdg),
        last_port:     bqv(v.last_port_departed),
        declared_dest: declaredDest,
      },
      prediction: top ? {
        destination:      top.port,
        destination_code: top.code,
        destination_lat:  top.lat,
        destination_lng:  top.lng,
        eta_hours:        top.eta_hours,
        eta_label:        top.eta_label,
        eta_iso:          top.eta_iso,
        distance_nm:      top.distance_nm,
        bearing_deg:      top.bearing_deg,
        confidence:       top.confidence,
        is_declared:      top.is_declared,
        method: top.is_declared  ? "Declared destination confirmed"
              : hist.length > 20 ? "AIS trajectory extrapolation"
              :                    "Heading & proximity analysis",
      } : null,
      alternatives:    alts,
      route_waypoints: wps,
      analysis: {
        history_points: hist.length,
        avg_speed_kn:   Math.round(avgSpd*10)/10,
        avg_heading:    Math.round(avgHdg),
        ports_scored:   PORTS.length,
      },
    };

    setCache(ck, result);
    logger.info(`[PREDICT] IMO ${imo} → ${top?.port} (${top?.confidence}%)`);
    return res.json({ success:true, cached:false, ...result });

  } catch(err) {
    const msg  = err?.message || err?.toString() || "Unknown error";
    const code = err?.code    || "";
    logger.error(`[PREDICT] FAILED IMO=${imo} code=${code} msg=${msg}`);
    logger.error(err?.stack || "(no stack)");
    return res.status(500).json({ success:false, error:msg, code });
  }
});

module.exports = router;