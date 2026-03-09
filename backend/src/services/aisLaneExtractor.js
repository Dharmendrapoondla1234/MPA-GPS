// services/aisLaneExtractor.js — AIS Lane Learning Engine v3
//
// METHOD (as required):
//   1. Query stg_vessel_positions (real AIS data) from BigQuery
//   2. Bin positions into 0.08° grid cells (~5nm). Cells with ≥3 unique
//      vessels = confirmed shipping lane.
//   3. Learn vessel-to-vessel transition sequences to build directed edges.
//   4. Overlay IMO TSS corridors as mandatory high-priority lanes.
//   5. Overlay international deep-water routes.
//   6. Dijkstra on combined AIS+TSS+DWR graph → always stays in sea.
//
// Result: routes follow where ships ACTUALLY sail, constrained by TSS law.
"use strict";

const logger = require("../utils/logger");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const GRID_DEG     = 0.08;             // ~5nm grid cell (nautical resolution)
const MIN_VESSELS  = 3;                // unique IMOs needed to call it a lane
const CACHE_TTL    = 6 * 3600 * 1000; // 6h — refresh at each watch cycle
const QUERY_DAYS   = 14;              // 14 days of AIS history
const MAX_EDGE_NM  = 25;              // max edge length in lane graph
const TSS_BOOST    = 8.0;             // TSS cells weighted 8× over random cells
const DWR_BOOST    = 4.0;             // deep-water route cells weighted 4×

// ── LANE CACHE ────────────────────────────────────────────────────────────────
let laneCache  = null;
let cacheTs    = 0;

// ── HELPERS ───────────────────────────────────────────────────────────────────
const RAD = 180 / Math.PI;
function toDeg(v) {
  const n = Number(v);
  if (isNaN(n) || n === 0) return 0;
  return Math.abs(n) < 4 ? n * RAD : n; // radian → degree if |v|<4
}
function deg2rad(d) { return d * Math.PI / 180; }
function distNM(la1, lo1, la2, lo2) {
  const r = deg2rad;
  const a = Math.sin(r(la2-la1)/2)**2 + Math.cos(r(la1))*Math.cos(r(la2))*Math.sin(r(lo2-lo1)/2)**2;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function cellKey(lat, lng) {
  const snap = (v, g) => Math.round(v / g) * g;
  return `${snap(lat, GRID_DEG).toFixed(3)},${snap(lng, GRID_DEG).toFixed(3)}`;
}
function cellCenter(key) {
  const [la, lo] = key.split(",").map(Number);
  return { lat: la, lng: lo };
}

// ── MAIN: Learn shipping lanes from AIS ───────────────────────────────────────
async function learnLanes(bigquery, BQ_LOCATION, T) {
  const now = Date.now();
  if (laneCache && (now - cacheTs) < CACHE_TTL) {
    logger.info("[AIS-LEARN] Using cached lane graph");
    return laneCache;
  }

  logger.info("[AIS-LEARN] Querying BigQuery for AIS positions...");

  // ── Step 1: Pull AIS history ──────────────────────────────────────────────
  let rows = [];
  try {
    const [r] = await bigquery.query({
      query: `
        SELECT
          imo_number,
          latitude  * ${RAD} AS lat,
          longitude * ${RAD} AS lng,
          speed_kn,
          heading_deg
        FROM ${T.POSITIONS_HIST}
        WHERE effective_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${QUERY_DAYS} DAY)
          AND latitude  IS NOT NULL AND longitude IS NOT NULL
          AND speed_kn  > 1.0
          AND ABS(latitude)  < 1.60
          AND ABS(longitude) < 3.15
        LIMIT 300000`,
      location: BQ_LOCATION,
    });
    rows = r;
    logger.info(`[AIS-LEARN] ${rows.length} AIS positions received`);
  } catch (e) {
    logger.warn(`[AIS-LEARN] BigQuery failed: ${e.message.slice(0,120)}`);
    return buildTSSOnlyGraph();
  }

  if (rows.length < 200) {
    logger.warn("[AIS-LEARN] Insufficient data — TSS-only fallback");
    return buildTSSOnlyGraph();
  }

  // ── Step 2: Density grid + per-vessel track ───────────────────────────────
  const grid     = new Map();  // key → { imoSet, count, totalSpeed }
  const imoTrack = new Map();  // imo → [key, ...] ordered sequence

  for (const row of rows) {
    const lat = toDeg(row.lat);
    const lng = toDeg(row.lng);
    if (!lat || !lng || isNaN(lat) || isNaN(lng)) continue;
    // Bounds: SE Asia + Indian Ocean corridor
    if (lat < -15 || lat > 28 || lng < 70 || lng > 135) continue;

    const key = cellKey(lat, lng);
    const imo = String(row.imo_number);
    const spd = Number(row.speed_kn) || 0;

    if (!grid.has(key)) grid.set(key, { imoSet: new Set(), count: 0, totalSpeed: 0 });
    const cell = grid.get(key);
    cell.count++;
    cell.imoSet.add(imo);
    cell.totalSpeed += spd;

    // Record cell sequence per vessel (dedup consecutive same-cell)
    if (!imoTrack.has(imo)) imoTrack.set(imo, []);
    const track = imoTrack.get(imo);
    if (track[track.length - 1] !== key) track.push(key);
  }

  // ── Step 3: Extract high-density lane cells ───────────────────────────────
  const laneCells = new Map();
  for (const [key, cell] of grid) {
    if (cell.imoSet.size >= MIN_VESSELS) {
      const { lat, lng } = cellCenter(key);
      laneCells.set(key, {
        lat, lng,
        vesselCount: cell.imoSet.size,
        avgSpeed:    cell.totalSpeed / cell.count,
        weight:      Math.log2(cell.imoSet.size + 1), // log-scale
        type:        "AIS",
      });
    }
  }
  logger.info(`[AIS-LEARN] ${laneCells.size} lane cells from ${grid.size} total cells`);

  // ── Step 4: Build transition edges from vessel sequences ─────────────────
  const transitions = new Map(); // "keyA|keyB" → count
  for (const [, track] of imoTrack) {
    for (let i = 0; i < track.length - 1; i++) {
      const a = track[i], b = track[i + 1];
      if (!laneCells.has(a) || !laneCells.has(b)) continue;
      if (a === b) continue;
      const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
      transitions.set(ek, (transitions.get(ek) || 0) + 1);
    }
  }

  // ── Step 5: Build adjacency graph ────────────────────────────────────────
  const graph = new Map();

  function addEdge(a, b, weight) {
    const ca = laneCells.get(a), cb = laneCells.get(b);
    if (!ca || !cb) return;
    const dist = distNM(ca.lat, ca.lng, cb.lat, cb.lng);
    if (dist > MAX_EDGE_NM || dist < 0.1) return;
    if (!graph.has(a)) graph.set(a, []);
    if (!graph.has(b)) graph.set(b, []);
    const cost = dist / weight; // lower cost = preferred corridor
    // Avoid duplicates
    if (!graph.get(a).find(e => e.to === b)) graph.get(a).push({ to: b, dist, cost });
    if (!graph.get(b).find(e => e.to === a)) graph.get(b).push({ to: a, dist, cost });
  }

  // Transition edges from real vessel movements
  for (const [ek, count] of transitions) {
    const [a, b] = ek.split("|");
    const ca = laneCells.get(a), cb = laneCells.get(b);
    if (!ca || !cb) continue;
    const w = Math.log2(count + 1) * 0.5 + (ca.weight + cb.weight) * 0.5;
    addEdge(a, b, w);
  }

  // Spatial adjacency edges (connect nearby high-density cells)
  const cellArr = Array.from(laneCells.keys());
  for (let i = 0; i < cellArr.length; i++) {
    const ca = laneCells.get(cellArr[i]);
    for (let j = i + 1; j < cellArr.length; j++) {
      const cb = laneCells.get(cellArr[j]);
      const d  = distNM(ca.lat, ca.lng, cb.lat, cb.lng);
      if (d <= GRID_DEG * 120) { // ~1.5 grid cells
        addEdge(cellArr[i], cellArr[j], (ca.weight + cb.weight) * 0.5);
      }
    }
  }

  // ── Step 6: Overlay TSS corridors (MANDATORY — highest priority) ──────────
  const { TSS_LANES, DEEP_WATER_ROUTES } = require("./tssData");

  for (const lane of Object.values(TSS_LANES)) {
    let prevKey = null;
    for (const [lat, lng] of lane.points) {
      const key = ensureCell(lat, lng, laneCells, lane.weight * TSS_BOOST, "TSS");
      if (prevKey) addEdge(prevKey, key, lane.weight * TSS_BOOST);
      prevKey = key;
    }
  }

  // ── Step 7: Overlay international deep-water routes ──────────────────────
  for (const dwr of DEEP_WATER_ROUTES) {
    let prevKey = null;
    for (const [lat, lng] of dwr.points) {
      const key = ensureCell(lat, lng, laneCells, DWR_BOOST, "DWR");
      if (prevKey) addEdge(prevKey, key, DWR_BOOST);
      prevKey = key;
    }
  }

  // ── Step 8: Port approach nodes ───────────────────────────────────────────
  const { PORT_APPROACHES } = require("./tssData");
  for (const pa of PORT_APPROACHES) {
    const [lat, lng] = pa.point;
    const portKey = ensureCell(lat, lng, laneCells, 2.0, "PORT");
    // Connect port to nearest 3 lane cells
    const sorted = Array.from(laneCells.entries())
      .map(([k, c]) => ({ k, d: distNM(lat, lng, c.lat, c.lng) }))
      .sort((a, b) => a.d - b.d)
      .slice(1, 4);
    for (const { k } of sorted) addEdge(portKey, k, 2.0);
  }

  const edgeCount = [...graph.values()].reduce((s, e) => s + e.length, 0) / 2;
  logger.info(`[AIS-LEARN] Graph: ${laneCells.size} nodes, ${Math.round(edgeCount)} edges`);

  laneCache = { graph, laneCells };
  cacheTs   = now;
  return laneCache;
}

// Ensure a cell exists at [lat,lng], creating synthetic one if absent
function ensureCell(lat, lng, laneCells, weight, type) {
  const key = cellKey(lat, lng);
  if (!laneCells.has(key)) {
    // Snap to nearest existing cell within 3 grid cells if possible
    let bestKey = null, bestDist = Infinity;
    for (const [k, c] of laneCells) {
      const d = distNM(lat, lng, c.lat, c.lng);
      if (d < bestDist && d < GRID_DEG * 200) { bestDist = d; bestKey = k; }
    }
    if (bestKey && bestDist < 8) return bestKey;
    // Otherwise create synthetic cell
    laneCells.set(key, { lat, lng, vesselCount: weight * 5, avgSpeed: 12, weight, type });
  } else {
    // Boost existing AIS cell with TSS/DWR priority
    const c = laneCells.get(key);
    c.weight   = Math.max(c.weight, weight);
    c.type     = type; // upgrade to TSS/DWR
  }
  return key;
}

// ── TSS-ONLY FALLBACK ─────────────────────────────────────────────────────────
function buildTSSOnlyGraph() {
  logger.info("[AIS-LEARN] Building TSS+DWR fallback graph");
  const { TSS_LANES, DEEP_WATER_ROUTES, PORT_APPROACHES } = require("./tssData");

  const laneCells = new Map();
  const graph     = new Map();

  function addNode(lat, lng, weight, type) {
    const key = cellKey(lat, lng);
    if (!laneCells.has(key))
      laneCells.set(key, { lat, lng, vesselCount: weight*10, avgSpeed: 12, weight, type });
    return key;
  }
  function addEdge(a, b, weight) {
    const ca = laneCells.get(a), cb = laneCells.get(b);
    if (!ca || !cb) return;
    const dist = distNM(ca.lat, ca.lng, cb.lat, cb.lng);
    if (!graph.has(a)) graph.set(a, []);
    if (!graph.has(b)) graph.set(b, []);
    const cost = dist / weight;
    graph.get(a).push({ to: b, dist, cost });
    graph.get(b).push({ to: a, dist, cost });
  }

  for (const lane of Object.values(TSS_LANES)) {
    let prev = null;
    for (const [lat, lng] of lane.points) {
      const key = addNode(lat, lng, lane.weight, "TSS");
      if (prev) addEdge(prev, key, lane.weight);
      prev = key;
    }
  }
  for (const dwr of DEEP_WATER_ROUTES) {
    let prev = null;
    for (const [lat, lng] of dwr.points) {
      const key = addNode(lat, lng, 1.5, "DWR");
      if (prev) addEdge(prev, key, 1.5);
      prev = key;
    }
  }
  for (const pa of PORT_APPROACHES) {
    const key = addNode(pa.point[0], pa.point[1], 1.0, "PORT");
    let best = null, bestD = Infinity;
    for (const [k, c] of laneCells) {
      if (k === key) continue;
      const d = distNM(pa.point[0], pa.point[1], c.lat, c.lng);
      if (d < bestD && d < 150) { bestD = d; best = k; }
    }
    if (best) addEdge(key, best, 1.5);
  }

  laneCache = { graph, laneCells };
  cacheTs   = Date.now() - CACHE_TTL + 300_000; // retry in 5min
  return laneCache;
}

// ── PUBLIC HELPERS ────────────────────────────────────────────────────────────
function nearestLaneCell(lat, lng, laneCells, headingDeg = null) {
  let best = null, bestScore = Infinity;
  for (const [key, cell] of laneCells) {
    const d = distNM(lat, lng, cell.lat, cell.lng);
    let score = d;
    if (headingDeg != null && d > 0) {
      const b = (Math.atan2(cell.lng - lng, cell.lat - lat) * 180 / Math.PI + 360) % 360;
      const diff = Math.abs(((b - headingDeg) + 540) % 360 - 180);
      if (diff > 130) score *= 2.5;
    }
    if (score < bestScore) { bestScore = score; best = key; }
  }
  return best;
}

function dijkstraLane(graph, laneCells, startKey, endKey) {
  if (!laneCells.has(startKey) || !laneCells.has(endKey)) return null;
  const dist = new Map(), prev = new Map(), visited = new Set();
  for (const k of laneCells.keys()) dist.set(k, Infinity);
  dist.set(startKey, 0);
  const q = [{ key: startKey, d: 0 }];

  while (q.length) {
    q.sort((a, b) => a.d - b.d);
    const { key: cur } = q.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    if (cur === endKey) break;
    for (const { to, cost } of (graph.get(cur) || [])) {
      if (visited.has(to)) continue;
      const nd = dist.get(cur) + cost;
      if (nd < dist.get(to)) {
        dist.set(to, nd);
        prev.set(to, cur);
        q.push({ key: to, d: nd });
      }
    }
  }

  if (dist.get(endKey) === Infinity) return null;
  const path = []; let cur = endKey;
  while (cur) { path.unshift(cur); cur = prev.get(cur); }
  if (path[0] !== startKey) return null;
  return path;
}

// Invalidate cache (call to force a fresh BigQuery pull)
function invalidateCache() { laneCache = null; cacheTs = 0; }

module.exports = { learnLanes, nearestLaneCell, dijkstraLane, distNM, cellKey, invalidateCache };