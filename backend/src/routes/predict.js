// backend/src/routes/predict.js — AI Route Prediction v7 (Sea Routes)
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");

const {
  bigquery,
  BQ_LOCATION,
  FULL_TABLE,
  getVesselHistory,
} = require("../services/bigquery");

const cache = new Map();
function getCached(k) { const c = cache.get(k); return c && Date.now()-c.ts < 300000 ? c.data : null; }
function setCache(k,d) { cache.set(k, { data:d, ts:Date.now() }); }

// ── Maritime Chokepoints & Waypoints ─────────────────────────────────────────
// Named anchor points for building real sea routes
const WP = {
  // Singapore Strait & approaches
  SG_EAST:   { lat: 1.200, lng: 104.100 },   // East of Singapore Strait
  SG_WEST:   { lat: 1.200, lng: 103.600 },   // West of Singapore Strait
  SG_PORT:   { lat: 1.264, lng: 103.820 },   // Singapore anchorage
  PHILLIP_CH:{ lat: 1.150, lng: 103.750 },   // Phillip Channel
  // Malacca Strait axis
  MALACCA_S: { lat: 1.500, lng: 103.200 },   // South Malacca
  MALACCA_M: { lat: 3.500, lng: 100.800 },   // Mid Malacca
  MALACCA_N: { lat: 5.200, lng: 99.600  },   // North Malacca
  ONE_FATHOM:{ lat: 1.900, lng: 102.900 },   // One Fathom Bank
  // South China Sea
  SCS_SW:    { lat: 3.000, lng: 105.500 },   // SW South China Sea
  SCS_MID:   { lat: 8.000, lng: 109.000 },   // Central SCS
  SCS_N:     { lat:16.000, lng: 113.000 },   // North SCS
  // Java Sea
  JAVA_W:    { lat:-5.800, lng: 106.000 },   // W Java Sea
  JAVA_E:    { lat:-5.500, lng: 112.000 },   // E Java Sea
  KARIMATA:  { lat:-1.500, lng: 108.800 },   // Karimata Strait
  // Sumatra / Bangka
  BANGKA_N:  { lat:-1.500, lng: 105.800 },   // Bangka Strait North
  BANGKA_S:  { lat:-2.500, lng: 106.200 },   // Bangka Strait South
  // Gulf of Thailand
  GULF_TH_S: { lat: 8.500, lng: 102.000 },   // South Gulf Thailand
  GULF_TH_N: { lat:11.500, lng: 101.000 },   // North Gulf Thailand
  // Vietnam coast
  VUNG_TAU:  { lat: 9.500, lng: 107.500 },   // Off Vung Tau
  DA_NANG:   { lat:15.800, lng: 109.200 },   // Off Da Nang
  // Indian Ocean / Bay of Bengal
  IO_E:      { lat: 4.000, lng:  88.000 },   // E Indian Ocean
  IO_NE:     { lat: 7.500, lng:  80.500 },   // NE Indian Ocean (off Colombo)
  // Sunda Strait
  SUNDA:     { lat:-6.000, lng: 105.800 },   // Sunda Strait
};

// ── Port definitions with approach waypoints ──────────────────────────────────
const PORTS = [
  {
    name:"Singapore", lat:1.264, lng:103.820, code:"SGSIN",
    approach: [WP.PHILLIP_CH, WP.SG_PORT],
    from_east: [WP.SG_EAST, WP.PHILLIP_CH],
    from_west: [WP.MALACCA_S, WP.SG_WEST, WP.PHILLIP_CH],
  },
  {
    name:"Port Klang", lat:3.000, lng:101.390, code:"MYPKG",
    approach: [WP.ONE_FATHOM],
    from_east: [WP.SG_WEST, WP.MALACCA_S, WP.ONE_FATHOM],
    from_west: [WP.MALACCA_M, WP.ONE_FATHOM],
  },
  {
    name:"Tanjung Pelepas", lat:1.363, lng:103.553, code:"MYPTP",
    approach: [WP.SG_WEST],
    from_east: [WP.SG_EAST, WP.PHILLIP_CH, WP.SG_WEST],
    from_west: [WP.MALACCA_S, WP.SG_WEST],
  },
  {
    name:"Johor Port", lat:1.764, lng:103.920, code:"MYJHB",
    approach: [WP.SG_EAST],
    from_east: [WP.SG_EAST],
    from_west: [WP.MALACCA_S, WP.SG_WEST, WP.PHILLIP_CH, WP.SG_EAST],
  },
  {
    name:"Penang", lat:5.414, lng:100.329, code:"MYPNG",
    approach: [WP.MALACCA_N],
    from_east: [WP.SG_WEST, WP.MALACCA_S, WP.MALACCA_M, WP.MALACCA_N],
    from_west: [WP.IO_NE, WP.MALACCA_N],
  },
  {
    name:"Batam", lat:1.107, lng:104.030, code:"IDBTH",
    approach: [WP.SG_EAST],
    from_east: [WP.SG_EAST],
    from_west: [WP.MALACCA_S, WP.PHILLIP_CH, WP.SG_EAST],
  },
  {
    name:"Dumai", lat:1.670, lng:101.450, code:"IDDUM",
    approach: [WP.MALACCA_S, WP.ONE_FATHOM],
    from_east: [WP.SG_WEST, WP.MALACCA_S],
    from_west: [WP.MALACCA_M, WP.MALACCA_S],
  },
  {
    name:"Belawan", lat:3.794, lng:98.682, code:"IDBLW",
    approach: [WP.MALACCA_M],
    from_east: [WP.SG_WEST, WP.MALACCA_S, WP.MALACCA_M],
    from_west: [WP.IO_NE, WP.MALACCA_N, WP.MALACCA_M],
  },
  {
    name:"Tanjung Priok", lat:-6.100, lng:106.880, code:"IDTPP",
    approach: [WP.JAVA_W],
    from_east: [WP.SG_EAST, WP.BANGKA_N, WP.BANGKA_S, WP.JAVA_W],
    from_west: [WP.SUNDA, WP.JAVA_W],
    from_north: [WP.SG_EAST, WP.BANGKA_N, WP.BANGKA_S, WP.JAVA_W],
  },
  {
    name:"Palembang", lat:-2.916, lng:104.745, code:"IDPLM",
    approach: [WP.BANGKA_N],
    from_east: [WP.SG_EAST, WP.BANGKA_N],
    from_west: [WP.SUNDA, WP.BANGKA_S, WP.BANGKA_N],
  },
  {
    name:"Pasir Gudang", lat:1.467, lng:103.886, code:"MYPGU",
    approach: [WP.SG_EAST],
    from_east: [WP.SG_EAST],
    from_west: [WP.PHILLIP_CH, WP.SG_EAST],
  },
  {
    name:"Bangkok", lat:13.759, lng:100.502, code:"THBKK",
    approach: [WP.GULF_TH_N],
    from_south: [WP.SCS_SW, WP.GULF_TH_S, WP.GULF_TH_N],
    from_east: [WP.SCS_SW, WP.GULF_TH_S, WP.GULF_TH_N],
    from_west: [WP.MALACCA_N, WP.GULF_TH_S, WP.GULF_TH_N],
  },
  {
    name:"Laem Chabang", lat:13.086, lng:100.880, code:"THLCH",
    approach: [WP.GULF_TH_S],
    from_south: [WP.SCS_SW, WP.GULF_TH_S],
    from_east: [WP.SCS_SW, WP.GULF_TH_S],
    from_west: [WP.MALACCA_N, WP.GULF_TH_S],
  },
  {
    name:"Ho Chi Minh City", lat:10.782, lng:106.700, code:"VNSGN",
    approach: [WP.VUNG_TAU],
    from_south: [WP.SCS_SW, WP.VUNG_TAU],
    from_west: [WP.SCS_SW, WP.VUNG_TAU],
    from_north: [WP.SCS_N, WP.SCS_MID, WP.VUNG_TAU],
  },
  {
    name:"Hai Phong", lat:20.870, lng:106.688, code:"VNHPH",
    approach: [WP.SCS_N],
    from_south: [WP.VUNG_TAU, WP.DA_NANG, WP.SCS_N],
    from_east: [WP.SCS_MID, WP.SCS_N],
    from_west: [WP.GULF_TH_S, WP.SCS_MID, WP.SCS_N],
  },
  {
    name:"Hong Kong", lat:22.302, lng:114.177, code:"HKHKG",
    approach: [WP.SCS_N],
    from_south: [WP.SCS_MID, WP.SCS_N],
    from_west: [WP.SCS_SW, WP.SCS_MID, WP.SCS_N],
  },
  {
    name:"Colombo", lat:6.930, lng:79.858, code:"LKCMB",
    approach: [WP.IO_NE],
    from_east: [WP.MALACCA_N, WP.IO_NE],
    from_sg: [WP.SG_WEST, WP.MALACCA_S, WP.MALACCA_N, WP.IO_NE],
  },
  {
    name:"Kota Kinabalu", lat:5.976, lng:116.073, code:"MYBKI",
    approach: [WP.SCS_N],
    from_west: [WP.SG_EAST, WP.SCS_SW, WP.SCS_MID, WP.SCS_N],
    from_south: [WP.JAVA_E, WP.SCS_MID, WP.SCS_N],
  },
  {
    name:"Port Dickson", lat:2.527, lng:101.795, code:"MYPDK",
    approach: [WP.ONE_FATHOM],
    from_east: [WP.SG_WEST, WP.MALACCA_S, WP.ONE_FATHOM],
    from_west: [WP.MALACCA_M, WP.ONE_FATHOM],
  },
  {
    name:"Karimun", lat:1.040, lng:103.440, code:"IDKRM",
    approach: [WP.SG_WEST],
    from_east: [WP.PHILLIP_CH, WP.SG_WEST],
    from_west: [WP.MALACCA_S, WP.SG_WEST],
  },
];

// ── Utility functions ─────────────────────────────────────────────────────────
function distNM(la1,lo1,la2,lo2){
  const R=3440.065,r=Math.PI/180,dLa=(la2-la1)*r,dLo=(lo2-lo1)*r,
        a=Math.sin(dLa/2)**2+Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dLo/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function calcBrng(la1,lo1,la2,lo2){
  const r=Math.PI/180,dLo=(lo2-lo1)*r,
        y=Math.sin(dLo)*Math.cos(la2*r),
        x=Math.cos(la1*r)*Math.sin(la2*r)-Math.sin(la1*r)*Math.cos(la2*r)*Math.cos(dLo);
  return(Math.atan2(y,x)*180/Math.PI+360)%360;
}
function fmtETA(h){
  if(!h||h<0)return"Unknown";
  if(h<1)return`~${Math.round(h*60)} min`;
  if(h<24)return`~${h.toFixed(1)} hrs`;
  const d=Math.floor(h/24),r=Math.round(h%24);
  return r>0?`~${d}d ${r}h`:`~${d} days`;
}
function bqv(v){
  if(v==null)return null;
  if(typeof v==="object"&&"value"in v)return String(v.value).trim()||null;
  return String(v).trim()||null;
}

// Pick the best set of intermediate waypoints for a route based on vessel position
function getSeaRouteWaypoints(curLat, curLng, port) {
  // Determine which direction the vessel is coming from
  const dLng = port.lng - curLng;
  const dLat = port.lat - curLat;

  // Choose the appropriate route corridor
  const routes = [
    port.from_east, port.from_west, port.from_north, port.from_south, port.from_sg, port.approach,
  ].filter(Boolean);

  if (!routes.length) return [];

  // Score each route corridor by how well its first waypoint aligns with vessel heading
  const brng = calcBrng(curLat, curLng, port.lat, port.lng);

  let best = routes[0];
  let bestScore = -Infinity;
  for (const route of routes) {
    if (!route.length) continue;
    const first = route[0];
    const wBrng = calcBrng(curLat, curLng, first.lat, first.lng);
    let diff = Math.abs(wBrng - brng);
    if (diff > 180) diff = 360 - diff;
    // Prefer routes whose first WP is in the direction of the destination
    const score = 180 - diff;
    if (score > bestScore) { bestScore = score; best = route; }
  }

  // Remove redundant waypoints that are already behind the vessel or too close
  return best.filter(wp => {
    const d = distNM(curLat, curLng, wp.lat, wp.lng);
    return d > 5; // skip waypoints within 5 NM of current position
  });
}

// Diagnostic
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
        FROM \`photons-377606.MPA.MPA_Master_Vessels\`
        WHERE CAST(imo_number AS INT64) = ${imo}
        LIMIT 1
      `,
      location: BQ_LOCATION,
    });

    if (!vesselRows || vesselRows.length === 0) {
      return res.status(404).json({ success:false, error:`Vessel IMO ${imo} not found` });
    }

    const v      = vesselRows[0];
    const curLat = Number(v.latitude_degrees  || 0);
    const curLng = Number(v.longitude_degrees || 0);

    if (!curLat && !curLng) {
      return res.status(422).json({ success:false, error:"Vessel has no position data" });
    }

    // 2. AIS history
    let hist = [];
    try { hist = await getVesselHistory(imo, 72); }
    catch(e) { logger.warn(`[PREDICT] history failed: ${e.message}`); }

    logger.info(`[PREDICT] IMO=${imo} hist=${hist.length} pos=(${curLat},${curLng})`);

    // 3. Compute avg speed / heading from recent AIS points
    const recent = hist.slice(-10);
    let avgHdg = Number(v.heading || v.course || 0);
    let avgSpd = Number(v.speed   || 0);
    if (recent.length >= 2) {
      const hdgs = recent.map(p => Number(p.heading||p.course||0)).filter(h => h > 0);
      const spds = recent.map(p => Number(p.speed  ||0          )).filter(s => s > 0.3);
      if (hdgs.length) avgHdg = hdgs.reduce((a,b)=>a+b)/hdgs.length;
      if (spds.length) avgSpd = spds.reduce((a,b)=>a+b)/spds.length;
    }

    // 4. Movement vector from AIS history (more accurate than heading alone)
    let vecLat = 0, vecLng = 0;
    if (hist.length >= 2) {
      const oldest = hist[0], newest = hist[hist.length-1];
      const hrs = (new Date(newest.effective_timestamp||0) - new Date(oldest.effective_timestamp||0)) / 3600000;
      if (hrs > 0.5) {
        vecLat = (Number(newest.latitude_degrees)  - Number(oldest.latitude_degrees))  / hrs;
        vecLng = (Number(newest.longitude_degrees) - Number(oldest.longitude_degrees)) / hrs;
      }
    }

    const declaredDest = bqv(v.next_port_destination);

    // 5. Score all ports — multi-factor
    const scored = PORTS.map(port => {
      const dist  = distNM(curLat, curLng, port.lat, port.lng);
      const brng  = calcBrng(curLat, curLng, port.lat, port.lng);

      // Heading alignment
      let hdgDiff = Math.abs(brng - avgHdg);
      if (hdgDiff > 180) hdgDiff = 360 - hdgDiff;
      const hdgScore = Math.max(0, 1 - hdgDiff/90) * 2.0;

      // Movement vector alignment (from actual AIS track — more reliable)
      let vecScore = 0;
      if (vecLat !== 0 || vecLng !== 0) {
        const vecBrng = (Math.atan2(vecLng, vecLat) * 180/Math.PI + 360) % 360;
        let vDiff = Math.abs(brng - vecBrng);
        if (vDiff > 180) vDiff = 360 - vDiff;
        vecScore = Math.max(0, 1 - vDiff/90) * 1.5;
      }

      // Distance score — favour realistic voyage distances
      const dstScore = dist < 5   ? 0
                     : dist < 50  ? 0.3
                     : dist < 200 ? 1.2
                     : dist < 800 ? 1.0
                     : dist < 2000? 0.6
                     :              0.2;

      // Declared destination bonus
      const isDecl = declaredDest && (
        declaredDest.toLowerCase().includes(port.name.toLowerCase().slice(0,5)) ||
        port.name.toLowerCase().includes(declaredDest.toLowerCase().slice(0,5)) ||
        declaredDest.toUpperCase().includes(port.code)
      );

      // History — did vessel visit this port before?
      const lastPort = bqv(v.last_port_departed)||"";
      const wasHere  = lastPort.toLowerCase().includes(port.name.toLowerCase().slice(0,5));
      const repeatBonus = wasHere ? 0 : 0; // neutral (not penalised)

      const total = hdgScore + vecScore + dstScore + (isDecl ? 3.5 : 0) + repeatBonus;
      const etaH  = avgSpd > 0.3 ? dist/avgSpd : null;

      return {
        port: port.name, code: port.code, lat: port.lat, lng: port.lng,
        distance_nm:       Math.round(dist),
        bearing_deg:       Math.round(brng),
        heading_alignment: Math.round(hdgScore/2*100),
        score:             total,
        eta_hours:         etaH ? Math.round(etaH*10)/10 : null,
        eta_iso:           etaH ? new Date(Date.now()+etaH*3600000).toISOString() : null,
        eta_label:         etaH ? fmtETA(etaH) : "Unknown",
        is_declared:       !!isDecl,
        confidence:        Math.min(Math.round(total*16), 97),
      };
    }).filter(p => p.distance_nm > 3).sort((a,b) => b.score - a.score);

    const top  = scored[0];
    const alts = scored.slice(1, 4);

    // 6. Build SEA ROUTE waypoints via maritime corridors
    const wps = [];
    if (top) {
      wps.push({ lat:curLat, lng:curLng, label:"Current Position", type:"current" });

      // Get real sea-route intermediate waypoints
      const portDef = PORTS.find(p => p.code === top.code);
      const intermediates = portDef ? getSeaRouteWaypoints(curLat, curLng, portDef) : [];

      // Add intermediate sea-route waypoints
      for (let idx = 0; idx < intermediates.length; idx++) {
        const wp = intermediates[idx];
        const frac = (idx+1) / (intermediates.length+1);
        const etaAtWp = top.eta_hours ? Math.round(top.eta_hours * frac * 10)/10 : null;
        wps.push({
          lat: wp.lat,
          lng: wp.lng,
          label: `Via ${Object.keys(WP).find(k => WP[k]===wp) || `Waypoint ${idx+1}`}`,
          type: "waypoint",
          eta_hours_from_now: etaAtWp,
        });
      }

      wps.push({
        lat: top.lat, lng: top.lng,
        label: top.port, type:"destination",
        eta_label: top.eta_label,
      });
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
        method: top.is_declared       ? "Declared destination confirmed"
              : hist.length > 20      ? "AIS trajectory + corridor routing"
              :                         "Heading & maritime corridor analysis",
      } : null,
      alternatives:    alts,
      route_waypoints: wps,
      analysis: {
        history_points:  hist.length,
        avg_speed_kn:    Math.round(avgSpd*10)/10,
        avg_heading:     Math.round(avgHdg),
        ports_scored:    PORTS.length,
        waypoints_count: wps.length,
        sea_route:       true,
      },
    };

    setCache(ck, result);
    logger.info(`[PREDICT] IMO ${imo} → ${top?.port} (${top?.confidence}%) via ${wps.length} waypoints`);
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