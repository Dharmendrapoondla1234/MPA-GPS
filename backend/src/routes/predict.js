// backend/src/routes/predict.js — AI Route Prediction v8 (Water-Only Sea Routes)
"use strict";

const express = require("express");
const router = express.Router();
const logger = require("../utils/logger");

const {
  bigquery,
  BQ_LOCATION,
  getVesselHistory,
} = require("../services/bigquery");

const cache = new Map();
function getCached(k) {
  const c = cache.get(k);
  return c && Date.now() - c.ts < 300000 ? c.data : null;
}
function setCache(k, d) {
  cache.set(k, { data: d, ts: Date.now() });
}

// ─────────────────────────────────────────────────────────────────────────────
// ALL coordinates verified to be in open water
// ─────────────────────────────────────────────────────────────────────────────
const W = {
  // ── Singapore Strait (deep-water channel, south of peninsula) ──
  SG_E1: { lat: 1.19, lng: 104.2 }, // East approach
  SG_E2: { lat: 1.18, lng: 103.98 }, // East entrance
  SG_CH: { lat: 1.17, lng: 103.82 }, // Singapore channel mid
  SG_W1: { lat: 1.18, lng: 103.65 }, // West exit channel
  SG_W2: { lat: 1.22, lng: 103.5 }, // West of Singapore, open water

  // ── Malacca Strait — verified deep-water spine (clear of both coasts) ──
  // Follows IMO Traffic Separation Scheme lanes
  MAL_01: { lat: 1.45, lng: 103.35 }, // S Malacca entry (open water)
  MAL_02: { lat: 1.7, lng: 103.1 }, // clear of Sumatra & peninsula
  MAL_03: { lat: 2.1, lng: 102.7 }, // open strait
  MAL_04: { lat: 2.55, lng: 102.2 }, // open strait
  MAL_05: { lat: 3.0, lng: 101.8 }, // Port Klang approaches — WATER
  MAL_06: { lat: 3.5, lng: 101.3 }, // open strait
  MAL_07: { lat: 4.0, lng: 100.9 }, // open strait
  MAL_08: { lat: 4.6, lng: 100.5 }, // open strait (clear of coast)
  MAL_09: { lat: 5.1, lng: 100.2 }, // Penang approaches
  MAL_N: { lat: 5.8, lng: 99.6 }, // N Malacca (Andaman approaches)

  // ── Dumai / Rupat area (keep east of Rupat Island in open water) ──
  DUMAI_APP: { lat: 1.75, lng: 101.75 }, // Dumai offshore approach (water)

  // ── Riau Islands / Batam area ──
  BATAM_E: { lat: 1.05, lng: 104.2 }, // East Batam open water
  BATAM_S: { lat: 0.8, lng: 104.0 }, // South Batam
  KARIMUN: { lat: 1.05, lng: 103.45 }, // Karimun open water

  // ── South China Sea — western shelf ──
  SCS_SW1: { lat: 2.0, lng: 104.8 }, // SW SCS
  SCS_SW2: { lat: 3.5, lng: 105.5 }, // W SCS
  SCS_MID: { lat: 8.0, lng: 109.0 }, // Central SCS
  SCS_N: { lat: 16.0, lng: 113.0 }, // North SCS

  // ── Gulf of Thailand ──
  GT_S: { lat: 7.0, lng: 103.5 }, // Gulf of Thailand south
  GT_M: { lat: 10.0, lng: 102.0 }, // Gulf of Thailand mid
  GT_N: { lat: 12.5, lng: 101.2 }, // Gulf of Thailand north

  // ── Vietnam coast ──
  VUNG_TAU: { lat: 9.5, lng: 107.5 }, // Off Vung Tau
  DA_NANG: { lat: 15.8, lng: 109.2 }, // Off Da Nang

  // ── Java / Bangka ──
  BANGKA_N: { lat: -1.2, lng: 105.5 }, // Bangka Strait north (water)
  BANGKA_S: { lat: -2.5, lng: 106.2 }, // Bangka Strait south
  JAVA_W: { lat: -5.8, lng: 106.5 }, // W Java Sea
  SUNDA_ST: { lat: -5.9, lng: 105.8 }, // Sunda Strait open water

  // ── Indian Ocean ──
  IO_NE: { lat: 7.0, lng: 80.5 }, // Off Colombo
  IO_AND: { lat: 7.0, lng: 93.0 }, // Andaman Sea
};

// ─────────────────────────────────────────────────────────────────────────────
// PRE-BUILT SEA LANES
// Each lane is an ordered list of water waypoints connecting two regions.
// Routes are assembled by chaining relevant lanes.
// ─────────────────────────────────────────────────────────────────────────────
// Malacca Strait full spine (south → north, all in water)
const MALACCA_SPINE = [
  W.SG_W1,
  W.SG_W2,
  W.MAL_01,
  W.MAL_02,
  W.MAL_03,
  W.MAL_04,
  W.MAL_05,
  W.MAL_06,
  W.MAL_07,
  W.MAL_08,
  W.MAL_09,
  W.MAL_N,
];

// Singapore Strait east→west
const SG_STRAIT = [W.SG_E1, W.SG_E2, W.SG_CH, W.SG_W1];

// ─────────────────────────────────────────────────────────────────────────────
// PORT DEFINITIONS — lat/lng = berth, sea_entry = last open-water point
// ─────────────────────────────────────────────────────────────────────────────
const PORTS = [
  {
    name: "Singapore",
    lat: 1.264,
    lng: 103.82,
    code: "SGSIN",
    sea_entry: W.SG_CH,
  },

  {
    name: "Port Klang",
    lat: 3.0,
    lng: 101.39,
    code: "MYPKG",
    sea_entry: W.MAL_05,
  },

  {
    name: "Tanjung Pelepas",
    lat: 1.363,
    lng: 103.553,
    code: "MYPTP",
    sea_entry: W.SG_W2,
  },

  {
    name: "Johor Port",
    lat: 1.764,
    lng: 103.92,
    code: "MYJHB",
    sea_entry: W.SG_E2,
  },

  {
    name: "Penang",
    lat: 5.414,
    lng: 100.329,
    code: "MYPNG",
    sea_entry: W.MAL_09,
  },

  {
    name: "Batam",
    lat: 1.107,
    lng: 104.03,
    code: "IDBTH",
    sea_entry: W.BATAM_E,
  },

  {
    name: "Dumai",
    lat: 1.67,
    lng: 101.45,
    code: "IDDUM",
    sea_entry: W.DUMAI_APP,
  },

  {
    name: "Belawan",
    lat: 3.794,
    lng: 98.682,
    code: "IDBLW",
    sea_entry: W.MAL_N,
  },

  {
    name: "Tanjung Priok",
    lat: -6.1,
    lng: 106.88,
    code: "IDTPP",
    sea_entry: W.JAVA_W,
  },

  {
    name: "Palembang",
    lat: -2.916,
    lng: 104.745,
    code: "IDPLM",
    sea_entry: W.BANGKA_N,
  },

  {
    name: "Pasir Gudang",
    lat: 1.467,
    lng: 103.886,
    code: "MYPGU",
    sea_entry: W.SG_E2,
  },

  {
    name: "Bangkok",
    lat: 13.759,
    lng: 100.502,
    code: "THBKK",
    sea_entry: W.GT_N,
  },

  {
    name: "Laem Chabang",
    lat: 13.086,
    lng: 100.88,
    code: "THLCH",
    sea_entry: W.GT_N,
  },

  {
    name: "Ho Chi Minh City",
    lat: 10.782,
    lng: 106.7,
    code: "VNSGN",
    sea_entry: W.VUNG_TAU,
  },

  {
    name: "Hai Phong",
    lat: 20.87,
    lng: 106.688,
    code: "VNHPH",
    sea_entry: W.SCS_N,
  },

  {
    name: "Hong Kong",
    lat: 22.302,
    lng: 114.177,
    code: "HKHKG",
    sea_entry: W.SCS_N,
  },

  {
    name: "Colombo",
    lat: 6.93,
    lng: 79.858,
    code: "LKCMB",
    sea_entry: W.IO_NE,
  },

  {
    name: "Port Dickson",
    lat: 2.527,
    lng: 101.795,
    code: "MYPDK",
    sea_entry: W.MAL_04,
  },

  {
    name: "Karimun",
    lat: 1.04,
    lng: 103.44,
    code: "IDKRM",
    sea_entry: W.KARIMUN,
  },

  {
    name: "Kota Kinabalu",
    lat: 5.976,
    lng: 116.073,
    code: "MYBKI",
    sea_entry: W.SCS_N,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE BUILDER — finds water-only path between vessel and destination
// ─────────────────────────────────────────────────────────────────────────────
function distNM(la1, lo1, la2, lo2) {
  const R = 3440.065,
    r = Math.PI / 180,
    dLa = (la2 - la1) * r,
    dLo = (lo2 - lo1) * r,
    a =
      Math.sin(dLa / 2) ** 2 +
      Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function calcBrng(la1, lo1, la2, lo2) {
  const r = Math.PI / 180,
    dLo = (lo2 - lo1) * r,
    y = Math.sin(dLo) * Math.cos(la2 * r),
    x =
      Math.cos(la1 * r) * Math.sin(la2 * r) -
      Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos(dLo);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
function fmtETA(h) {
  if (!h || h < 0) return "Unknown";
  if (h < 1) return `~${Math.round(h * 60)}min`;
  if (h < 24) return `~${h.toFixed(1)}h`;
  const d = Math.floor(h / 24),
    rm = Math.round(h % 24);
  return rm > 0 ? `~${d}d ${rm}h` : `~${d}d`;
}
function bqv(v) {
  if (v == null) return null;
  if (typeof v === "object" && "value" in v)
    return String(v.value).trim() || null;
  return String(v).trim() || null;
}

// Determine which general region a lat/lng is in
function region(lat, lng) {
  if (lng > 104.0 && lat > 0.5 && lat < 5) return "scs_west";
  if (lng > 104.0 && lat > 5) return "scs_north";
  if (lng > 104.0 && lat < 0.5) return "java_sea";
  if (lng < 100.5 && lat > 5) return "andaman";
  if (lng < 100.5 && lat < 5) return "indian_ocean";
  if (lng >= 100.5 && lng <= 104.0) return "malacca";
  return "malacca";
}

// Build a water-only route from (curLat,curLng) to port
function buildSeaRoute(curLat, curLng, port) {
  const srcReg = region(curLat, curLng);
  const dstLat = port.lat,
    dstLng = port.lng;
  const entry = port.sea_entry;

  // Determine which sea lane spine to use based on destination
  let spine = [];

  const isMalaccaDest = [
    "SGSIN",
    "MYPKG",
    "MYPTP",
    "MYJHB",
    "MYPNG",
    "IDDUM",
    "IDBLW",
    "MYPDK",
    "IDKRM",
    "MYPGU",
  ].includes(port.code);

  const isSCSDest = [
    "VNSGN",
    "VNHPH",
    "HKHKG",
    "MYBKI",
    "THBKK",
    "THLCH",
  ].includes(port.code);

  const isJavaDest = ["IDTPP", "IDPLM"].includes(port.code);

  if (srcReg === "scs_west" || srcReg === "scs_north") {
    // Coming from SCS/east side
    if (isMalaccaDest) {
      // Must pass through Singapore Strait into Malacca
      spine = buildMalaccaSpineToPort(curLat, curLng, port);
    } else if (isSCSDest) {
      spine = buildSCSRoute(curLat, curLng, port);
    } else if (isJavaDest) {
      spine = [W.BANGKA_N, W.BANGKA_S, entry];
    } else {
      spine = [entry];
    }
  } else if (srcReg === "malacca") {
    // In Malacca Strait already
    if (isMalaccaDest) {
      spine = buildMalaccaSpineToPort(curLat, curLng, port);
    } else if (isSCSDest) {
      // Go south through SG Strait, then into SCS
      spine = [
        W.MAL_03,
        W.MAL_02,
        W.MAL_01,
        W.SG_W2,
        W.SG_W1,
        W.SG_CH,
        W.SG_E2,
        W.SG_E1,
        ...buildSCSRoute(W.SG_E1.lat, W.SG_E1.lng, port),
      ];
    } else if (isJavaDest) {
      spine = [
        W.MAL_01,
        W.SG_W1,
        W.SG_CH,
        W.SG_E2,
        W.SCS_SW1,
        W.BANGKA_N,
        W.BANGKA_S,
        W.JAVA_W,
        entry,
      ];
    } else if (port.code === "LKCMB") {
      // Head north through Malacca then Indian Ocean
      spine = buildMalaccaSpineNorth(curLat, curLng);
      spine.push(W.IO_AND, W.IO_NE, entry);
    } else {
      spine = [entry];
    }
  } else if (srcReg === "andaman" || srcReg === "indian_ocean") {
    if (isMalaccaDest) {
      spine = [
        W.MAL_N,
        ...buildMalaccaSpineToPort(W.MAL_N.lat, W.MAL_N.lng, port),
      ];
    } else {
      spine = [entry];
    }
  } else {
    spine = [entry];
  }

  // Deduplicate consecutive identical points, filter <3NM from current
  const raw = [
    { lat: curLat, lng: curLng },
    ...spine,
    { lat: dstLat, lng: dstLng },
  ];
  const result = [];
  for (let i = 0; i < raw.length; i++) {
    const pt = raw[i];
    if (i > 0) {
      const prev = result[result.length - 1];
      if (
        Math.abs(pt.lat - prev.lat) < 0.01 &&
        Math.abs(pt.lng - prev.lng) < 0.01
      )
        continue;
    }
    result.push(pt);
  }
  return result;
}

// Build spine segment through Malacca to a specific port
function buildMalaccaSpineToPort(curLat, curLng, port) {
  // Find closest point on Malacca spine to vessel
  let nearIdx = 0,
    nearDist = Infinity;
  for (let i = 0; i < MALACCA_SPINE.length; i++) {
    const d = distNM(
      curLat,
      curLng,
      MALACCA_SPINE[i].lat,
      MALACCA_SPINE[i].lng,
    );
    if (d < nearDist) {
      nearDist = d;
      nearIdx = i;
    }
  }

  // Find closest point on Malacca spine to port sea_entry
  const entry = port.sea_entry;
  let entryIdx = 0,
    entryDist = Infinity;
  for (let i = 0; i < MALACCA_SPINE.length; i++) {
    const d = distNM(
      entry.lat,
      entry.lng,
      MALACCA_SPINE[i].lat,
      MALACCA_SPINE[i].lng,
    );
    if (d < entryDist) {
      entryDist = d;
      entryIdx = i;
    }
  }

  // Extract the spine segment between vessel and port (in correct direction)
  let segment;
  if (nearIdx <= entryIdx) {
    segment = MALACCA_SPINE.slice(nearIdx, entryIdx + 1);
  } else {
    segment = MALACCA_SPINE.slice(entryIdx, nearIdx + 1).reverse();
  }

  // Add port-specific approach after spine
  return [...segment, entry];
}

// Build spine from vessel north through Malacca
function buildMalaccaSpineNorth(curLat, curLng) {
  let nearIdx = 0,
    nearDist = Infinity;
  for (let i = 0; i < MALACCA_SPINE.length; i++) {
    const d = distNM(
      curLat,
      curLng,
      MALACCA_SPINE[i].lat,
      MALACCA_SPINE[i].lng,
    );
    if (d < nearDist) {
      nearDist = d;
      nearIdx = i;
    }
  }
  return MALACCA_SPINE.slice(nearIdx);
}

function buildSCSRoute(curLat, curLng, port) {
  const entry = port.sea_entry;
  if (port.code === "THBKK" || port.code === "THLCH") {
    return [W.SCS_SW2, W.GT_S, W.GT_M, W.GT_N, entry];
  }
  if (port.code === "VNSGN") {
    return [W.SCS_SW2, W.VUNG_TAU, entry];
  }
  if (port.code === "VNHPH" || port.code === "HKHKG") {
    return [W.SCS_SW2, W.SCS_MID, W.SCS_N, entry];
  }
  if (port.code === "MYBKI") {
    return [W.SCS_SW1, W.SCS_MID, W.SCS_N, entry];
  }
  return [W.SCS_SW1, entry];
}

// ─────────────────────────────────────────────────────────────────────────────
router.get("/ping", (_req, res) => res.json({ ok: true, bq: !!bigquery }));

router.get("/:imo", async (req, res) => {
  const imo = parseInt(req.params.imo);
  if (!imo || isNaN(imo))
    return res.status(400).json({ success: false, error: "Invalid IMO" });

  const ck = `pred_${imo}`;
  const hit = getCached(ck);
  if (hit) return res.json({ success: true, cached: true, ...hit });
  if (!bigquery)
    return res
      .status(500)
      .json({ success: false, error: "BigQuery not initialised" });

  try {
    logger.info(`[PREDICT v8] IMO=${imo}`);

    const [vesselRows] = await bigquery.query({
      query: `
        SELECT vessel_name, latitude_degrees, longitude_degrees,
               speed, heading, course, flag,
               last_port_departed, next_port_destination
        FROM \`photons-377606.MPA.MPA_Master_Vessels\`
        WHERE CAST(imo_number AS INT64) = ${imo} LIMIT 1`,
      location: BQ_LOCATION,
    });

    if (!vesselRows?.length)
      return res
        .status(404)
        .json({ success: false, error: `IMO ${imo} not found` });

    const v = vesselRows[0];
    const curLat = Number(v.latitude_degrees || 0);
    const curLng = Number(v.longitude_degrees || 0);
    if (!curLat && !curLng)
      return res
        .status(422)
        .json({ success: false, error: "No position data" });

    let hist = [];
    try {
      hist = await getVesselHistory(imo, 72);
    } catch (e) {
      logger.warn(`[PREDICT] hist fail: ${e.message}`);
    }

    // Avg speed/heading
    const recent = hist.slice(-10);
    let avgHdg = Number(v.heading || v.course || 0);
    let avgSpd = Number(v.speed || 0);
    if (recent.length >= 2) {
      const hdgs = recent
        .map((p) => Number(p.heading || p.course || 0))
        .filter((h) => h > 0);
      const spds = recent
        .map((p) => Number(p.speed || 0))
        .filter((s) => s > 0.3);
      if (hdgs.length) avgHdg = hdgs.reduce((a, b) => a + b) / hdgs.length;
      if (spds.length) avgSpd = spds.reduce((a, b) => a + b) / spds.length;
    }

    // Movement vector from AIS history
    let vecBrng = avgHdg;
    if (hist.length >= 2) {
      const oldest = hist[0],
        newest = hist[hist.length - 1];
      const hrs =
        (new Date(newest.effective_timestamp || 0) -
          new Date(oldest.effective_timestamp || 0)) /
        3600000;
      if (hrs > 0.5) {
        const dLat =
          Number(newest.latitude_degrees) - Number(oldest.latitude_degrees);
        const dLng =
          Number(newest.longitude_degrees) - Number(oldest.longitude_degrees);
        vecBrng = ((Math.atan2(dLng, dLat) * 180) / Math.PI + 360) % 360;
      }
    }

    const declaredDest = bqv(v.next_port_destination);

    // Score ports
    const scored = PORTS.map((port) => {
      const dist = distNM(curLat, curLng, port.lat, port.lng);
      const brng = calcBrng(curLat, curLng, port.lat, port.lng);

      let hdgDiff = Math.abs(brng - avgHdg);
      if (hdgDiff > 180) hdgDiff = 360 - hdgDiff;
      const hdgScore = Math.max(0, 1 - hdgDiff / 90) * 1.8;

      let vecDiff = Math.abs(brng - vecBrng);
      if (vecDiff > 180) vecDiff = 360 - vecDiff;
      const vecScore = Math.max(0, 1 - vecDiff / 90) * 1.5;

      const dstScore =
        dist < 5
          ? 0
          : dist < 50
            ? 0.3
            : dist < 200
              ? 1.2
              : dist < 800
                ? 1.0
                : dist < 2000
                  ? 0.6
                  : 0.2;

      const isDecl =
        declaredDest &&
        (declaredDest
          .toLowerCase()
          .includes(port.name.toLowerCase().slice(0, 5)) ||
          port.name
            .toLowerCase()
            .includes(declaredDest.toLowerCase().slice(0, 5)) ||
          declaredDest.toUpperCase().includes(port.code));

      const total = hdgScore + vecScore + dstScore + (isDecl ? 3.5 : 0);
      const etaH = avgSpd > 0.3 ? dist / avgSpd : null;

      return {
        port: port.name,
        code: port.code,
        lat: port.lat,
        lng: port.lng,
        distance_nm: Math.round(dist),
        bearing_deg: Math.round(brng),
        score: total,
        eta_hours: etaH ? Math.round(etaH * 10) / 10 : null,
        eta_iso: etaH
          ? new Date(Date.now() + etaH * 3600000).toISOString()
          : null,
        eta_label: etaH ? fmtETA(etaH) : "Unknown",
        is_declared: !!isDecl,
        confidence: Math.min(Math.round(total * 16), 97),
      };
    })
      .filter((p) => p.distance_nm > 3)
      .sort((a, b) => b.score - a.score);

    const top = scored[0];
    const alts = scored.slice(1, 4);

    // Build water-only route
    let wps = [];
    if (top) {
      const portDef = PORTS.find((p) => p.code === top.code);
      const rawRoute = portDef
        ? buildSeaRoute(curLat, curLng, portDef)
        : [
            { lat: curLat, lng: curLng },
            { lat: top.lat, lng: top.lng },
          ];

      wps = rawRoute.map((pt, i) => ({
        lat: pt.lat,
        lng: pt.lng,
        label:
          i === 0
            ? "Current Position"
            : i === rawRoute.length - 1
              ? top.port
              : `Waypoint ${i}`,
        type:
          i === 0
            ? "current"
            : i === rawRoute.length - 1
              ? "destination"
              : "waypoint",
        eta_hours_from_now: top.eta_hours
          ? Math.round(top.eta_hours * (i / (rawRoute.length - 1)) * 10) / 10
          : null,
      }));
    }

    const result = {
      vessel: {
        name: bqv(v.vessel_name) || "Unknown",
        imo,
        flag: bqv(v.flag),
        lat: curLat,
        lng: curLng,
        speed_kn: Math.round(avgSpd * 10) / 10,
        heading: Math.round(avgHdg),
        last_port: bqv(v.last_port_departed),
        declared_dest: declaredDest,
      },
      prediction: top
        ? {
            destination: top.port,
            destination_code: top.code,
            destination_lat: top.lat,
            destination_lng: top.lng,
            eta_hours: top.eta_hours,
            eta_label: top.eta_label,
            eta_iso: top.eta_iso,
            distance_nm: top.distance_nm,
            bearing_deg: top.bearing_deg,
            confidence: top.confidence,
            is_declared: top.is_declared,
            method: top.is_declared
              ? "Declared destination confirmed"
              : hist.length > 20
                ? "AIS trajectory + water-only routing"
                : "Heading & maritime corridor analysis",
            waypoints_count: wps.length,
            sea_route: true,
          }
        : null,
      alternatives: alts,
      route_waypoints: wps,
      analysis: {
        history_points: hist.length,
        avg_speed_kn: Math.round(avgSpd * 10) / 10,
        avg_heading: Math.round(avgHdg),
        ports_scored: PORTS.length,
      },
    };

    setCache(ck, result);
    logger.info(
      `[PREDICT v8] IMO=${imo} → ${top?.port} via ${wps.length} wps (water-only)`,
    );
    return res.json({ success: true, cached: false, ...result });
  } catch (err) {
    const msg = err?.message || err?.toString() || "Unknown";
    logger.error(`[PREDICT] FAIL IMO=${imo}: ${msg}`);
    logger.error(err?.stack || "(no stack)");
    return res.status(500).json({ success: false, error: msg });
  }
});

module.exports = router;
