// backend/src/routes/predict.js — AI Route Prediction v9 (Graph Sea Router)
"use strict";

const express    = require("express");
const router     = express.Router();
const logger     = require("../utils/logger");
const seaRouter  = require("../services/seaRouter");

const {
  bigquery, BQ_LOCATION, getVesselHistory,
} = require("../services/bigquery");

const cache = new Map();
function getCached(k) { const c=cache.get(k); return c&&Date.now()-c.ts<300000?c.data:null; }
function setCache(k,d) { cache.set(k,{data:d,ts:Date.now()}); }

// Port definitions — preferred graph node for each port's approach
const PORTS = [
  { name:"Singapore",        lat:1.264,  lng:103.820, code:"SGSIN",  node:"P_SING"  },
  { name:"Port Klang",       lat:3.000,  lng:101.390, code:"MYPKG",  node:"P_KLANG" },
  { name:"Tanjung Pelepas",  lat:1.363,  lng:103.553, code:"MYPTP",  node:"P_TPP"   },
  { name:"Johor Port",       lat:1.764,  lng:103.920, code:"MYJHB",  node:"P_JOHOR" },
  { name:"Penang",           lat:5.414,  lng:100.329, code:"MYPNG",  node:"P_PENANG"},
  { name:"Batam",            lat:1.107,  lng:104.030, code:"IDBTH",  node:"P_BATAM" },
  { name:"Dumai",            lat:1.670,  lng:101.450, code:"IDDUM",  node:"DUMAI_A" },
  { name:"Belawan",          lat:3.794,  lng: 98.682, code:"IDBLW",  node:"P_BELAWAN"},
  { name:"Tanjung Priok",    lat:-6.100, lng:106.880, code:"IDTPP",  node:"P_TPRIOK"},
  { name:"Palembang",        lat:-2.916, lng:104.745, code:"IDPLM",  node:"P_PALM"  },
  { name:"Pasir Gudang",     lat:1.467,  lng:103.886, code:"MYPGU",  node:"P_PGUD"  },
  { name:"Bangkok",          lat:13.759, lng:100.502, code:"THBKK",  node:"P_BKKT"  },
  { name:"Laem Chabang",     lat:13.086, lng:100.880, code:"THLCH",  node:"P_BKKT"  },
  { name:"Ho Chi Minh City", lat:10.782, lng:106.700, code:"VNSGN",  node:"P_HCMC"  },
  { name:"Hai Phong",        lat:20.870, lng:106.688, code:"VNHPH",  node:"P_HPHONG"},
  { name:"Hong Kong",        lat:22.302, lng:114.177, code:"HKHKG",  node:"P_HK"    },
  { name:"Colombo",          lat: 6.930, lng: 79.858, code:"LKCMB",  node:"P_COLOM" },
  { name:"Port Dickson",     lat: 2.527, lng:101.795, code:"MYPDK",  node:"P_PDICK" },
  { name:"Karimun",          lat: 1.040, lng:103.440, code:"IDKRM",  node:"P_KARIN" },
  { name:"Kota Kinabalu",    lat: 5.976, lng:116.073, code:"MYBKI",  node:"P_KK"    },
];

function distNM(la1,lo1,la2,lo2){ return seaRouter.distNM(la1,lo1,la2,lo2); }
function calcBrng(la1,lo1,la2,lo2){
  const r=Math.PI/180,dLo=(lo2-lo1)*r,
        y=Math.sin(dLo)*Math.cos(la2*r),
        x=Math.cos(la1*r)*Math.sin(la2*r)-Math.sin(la1*r)*Math.cos(la2*r)*Math.cos(dLo);
  return(Math.atan2(y,x)*180/Math.PI+360)%360;
}
function fmtETA(h){
  if(!h||h<0)return"Unknown";
  if(h<1)return`~${Math.round(h*60)}min`;
  if(h<24)return`~${h.toFixed(1)}h`;
  const d=Math.floor(h/24),rm=Math.round(h%24);
  return rm>0?`~${d}d ${rm}h`:`~${d}d`;
}
function bqv(v){
  if(v==null)return null;
  if(typeof v==="object"&&"value"in v)return String(v.value).trim()||null;
  return String(v).trim()||null;
}

router.get("/ping", (_req, res) => res.json({ ok:true, bq:!!bigquery, router:"seaGraph-v9" }));

router.get("/:imo", async (req, res) => {
  const imo = parseInt(req.params.imo);
  if (!imo||isNaN(imo)) return res.status(400).json({success:false,error:"Invalid IMO"});

  const ck = `pred_${imo}`;
  const hit = getCached(ck);
  if (hit) return res.json({success:true,cached:true,...hit});
  if (!bigquery) return res.status(500).json({success:false,error:"BigQuery not initialised"});

  try {
    logger.info(`[PREDICT v9] IMO=${imo}`);

    const [vesselRows] = await bigquery.query({
      query:`
        SELECT vessel_name, latitude_degrees, longitude_degrees,
               speed, heading, course, flag,
               last_port_departed, next_port_destination
        FROM \`photons-377606.MPA.MPA_Master_Vessels\`
        WHERE CAST(imo_number AS INT64) = ${imo} LIMIT 1`,
      location: BQ_LOCATION,
    });

    if (!vesselRows?.length)
      return res.status(404).json({success:false,error:`IMO ${imo} not found`});

    const v      = vesselRows[0];
    const curLat = Number(v.latitude_degrees  || 0);
    const curLng = Number(v.longitude_degrees || 0);
    if (!curLat&&!curLng)
      return res.status(422).json({success:false,error:"No position data"});

    let hist = [];
    try { hist = await getVesselHistory(imo, 72); }
    catch(e) { logger.warn(`[PREDICT] hist fail: ${e.message}`); }

    // Speed / heading from recent AIS
    const recent = hist.slice(-10);
    let avgHdg = Number(v.heading||v.course||0);
    let avgSpd = Number(v.speed  ||0);
    if (recent.length >= 2) {
      const hdgs = recent.map(p=>Number(p.heading||p.course||0)).filter(h=>h>0);
      const spds = recent.map(p=>Number(p.speed  ||0         )).filter(s=>s>0.3);
      if (hdgs.length) avgHdg = hdgs.reduce((a,b)=>a+b)/hdgs.length;
      if (spds.length) avgSpd = spds.reduce((a,b)=>a+b)/spds.length;
    }

    // AIS movement vector
    let vecBrng = avgHdg;
    if (hist.length >= 2) {
      const oldest=hist[0], newest=hist[hist.length-1];
      const hrs=(new Date(newest.effective_timestamp||0)-new Date(oldest.effective_timestamp||0))/3600000;
      if (hrs > 0.5) {
        const dLa=Number(newest.latitude_degrees)-Number(oldest.latitude_degrees);
        const dLo=Number(newest.longitude_degrees)-Number(oldest.longitude_degrees);
        vecBrng=(Math.atan2(dLo,dLa)*180/Math.PI+360)%360;
      }
    }

    const declaredDest = bqv(v.next_port_destination);

    // Score ports
    const scored = PORTS.map(port => {
      const dist  = distNM(curLat, curLng, port.lat, port.lng);
      const brng  = calcBrng(curLat, curLng, port.lat, port.lng);

      let hdgDiff = Math.abs(brng-avgHdg); if(hdgDiff>180) hdgDiff=360-hdgDiff;
      const hdgScore = Math.max(0,1-hdgDiff/90)*1.8;

      let vecDiff = Math.abs(brng-vecBrng); if(vecDiff>180) vecDiff=360-vecDiff;
      const vecScore = Math.max(0,1-vecDiff/90)*1.5;

      const dstScore = dist<5?0:dist<50?0.3:dist<200?1.2:dist<800?1.0:dist<2000?0.6:0.2;

      const isDecl = declaredDest && (
        declaredDest.toLowerCase().includes(port.name.toLowerCase().slice(0,5)) ||
        port.name.toLowerCase().includes(declaredDest.toLowerCase().slice(0,5)) ||
        declaredDest.toUpperCase().includes(port.code)
      );

      const total = hdgScore + vecScore + dstScore + (isDecl?3.5:0);
      const etaH  = avgSpd>0.3 ? dist/avgSpd : null;

      return {
        port:port.name, code:port.code, lat:port.lat, lng:port.lng, node:port.node,
        distance_nm: Math.round(dist),
        bearing_deg: Math.round(brng),
        score: total,
        eta_hours:  etaH?Math.round(etaH*10)/10:null,
        eta_iso:    etaH?new Date(Date.now()+etaH*3600000).toISOString():null,
        eta_label:  etaH?fmtETA(etaH):"Unknown",
        is_declared:!!isDecl,
        confidence: Math.min(Math.round(total*16),97),
      };
    }).filter(p=>p.distance_nm>3).sort((a,b)=>b.score-a.score);

    const top  = scored[0];
    const alts = scored.slice(1,4);

    // Build water-only route via graph
    let wps = [];
    if (top) {
      const rawRoute = seaRouter.route(curLat, curLng, top.lat, top.lng, top.node);

      // Compute cumulative distances for ETA interpolation
      let totalDist = 0;
      const cumDist = [0];
      for (let i=1; i<rawRoute.length; i++) {
        totalDist += distNM(rawRoute[i-1].lat,rawRoute[i-1].lng,rawRoute[i].lat,rawRoute[i].lng);
        cumDist.push(totalDist);
      }

      wps = rawRoute.map((pt, i) => ({
        lat: pt.lat, lng: pt.lng,
        label: i===0 ? "Current Position"
             : i===rawRoute.length-1 ? top.port
             : (pt.nodeId || `Waypoint ${i}`),
        type: i===0?"current":i===rawRoute.length-1?"destination":"waypoint",
        eta_hours_from_now: top.eta_hours && totalDist>0
          ? Math.round(top.eta_hours*(cumDist[i]/totalDist)*10)/10
          : null,
      }));
    }

    const result = {
      vessel:{
        name:bqv(v.vessel_name)||"Unknown", imo, flag:bqv(v.flag),
        lat:curLat, lng:curLng,
        speed_kn:Math.round(avgSpd*10)/10,
        heading:Math.round(avgHdg),
        last_port:bqv(v.last_port_departed),
        declared_dest:declaredDest,
      },
      prediction: top?{
        destination:top.port, destination_code:top.code,
        destination_lat:top.lat, destination_lng:top.lng,
        eta_hours:top.eta_hours, eta_label:top.eta_label, eta_iso:top.eta_iso,
        distance_nm:top.distance_nm, bearing_deg:top.bearing_deg,
        confidence:top.confidence, is_declared:top.is_declared,
        method: top.is_declared         ? "Declared destination confirmed"
              : hist.length>20          ? "AIS trajectory + graph sea routing"
              :                           "Heading & maritime graph analysis",
        waypoints_count:wps.length, sea_route:true,
      }:null,
      alternatives:alts,
      route_waypoints:wps,
      analysis:{
        history_points:hist.length,
        avg_speed_kn:Math.round(avgSpd*10)/10,
        avg_heading:Math.round(avgHdg),
        ports_scored:PORTS.length,
        routing_engine:"dijkstra-sea-graph-v9",
      },
    };

    setCache(ck, result);
    logger.info(`[PREDICT v9] IMO=${imo} → ${top?.port} via ${wps.length} sea wps`);
    return res.json({success:true,cached:false,...result});

  } catch(err) {
    const msg=err?.message||err?.toString()||"Unknown";
    logger.error(`[PREDICT] FAIL IMO=${imo}: ${msg}`);
    logger.error(err?.stack||"(no stack)");
    return res.status(500).json({success:false,error:msg});
  }
});

module.exports = router;