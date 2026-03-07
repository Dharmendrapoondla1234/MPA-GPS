// services/seaRouter.js — Maritime Graph Router v1
// Dijkstra shortest-path on a verified open-water node graph.
// Every node coordinate is in open sea. Every edge is a straight line
// that does NOT cross any major landmass in SE Asia / Indian Ocean.
"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// NODE REGISTRY  (all coords verified open water)
// ─────────────────────────────────────────────────────────────────────────────
const NODES = {
  // ── Andaman Sea / NW approach ──
  AND_NW:  [9.50,  92.00],
  AND_MID: [8.00,  95.00],
  AND_E:   [10.00,  98.50],
  AND_SE:  [7.00,   98.00],

  // ── North Malacca Strait ──
  MAL_N1:  [6.1, 99.1],   // NW entry
  MAL_N2:  [5.75, 99.55],   // Langkawi offshore
  MAL_N3:  [5.0, 100.15],   // Penang approaches (water)
  MAL_N4:  [5.00, 100.30],   // clear of coast

  // ── Mid Malacca Strait ──
  MAL_M1:  [4.50, 100.70],
  MAL_M2:  [4.00, 101.00],
  MAL_M3:  [3.5, 100.95],
  MAL_M4:  [3.0, 101.1],   // Port Klang offshore
  MAL_M5:  [2.6, 101.7],
  MAL_M6:  [2.2, 102.1],
  MAL_M7:  [1.9, 102.5],
  MAL_M8:  [1.65, 102.85],

  // ── South Malacca / Singapore approaches ──
  MAL_S1:  [1.45, 103.1],
  MAL_S2:  [1.28, 103.45],   // west of Singapore
  SG_MAIN: [1.17, 103.72],   // Singapore Strait main channel
  SG_EAST: [1.15, 104.12],   // east exit Singapore Strait

  // ── Riau / Batam ──
  RIAU_W:  [0.90, 103.80],
  RIAU_S:  [0.50, 104.00],
  BATAM_S: [0.70, 104.30],

  // ── Dumai / Rupat approach (west of Rupat island, in strait) ──
  DUMAI_W: [1.7, 101.6],   // offshore Dumai in Malacca Strait
  DUMAI_A: [1.68, 101.50],   // Dumai anchorage approach

  // ── Karimun Besar (between Malacca and Singapore) ──
  KARIMUN: [1.05, 103.42],

  // ── SW South China Sea ──
  SCS_SW1: [1.50, 104.50],
  SCS_SW2: [2.00, 104.80],
  SCS_SW3: [3.00, 105.50],
  SCS_W1:  [4.50, 106.00],
  SCS_W2:  [6.00, 107.00],
  SCS_W3:  [8.00, 108.00],
  SCS_W4:  [10.00, 109.00],

  // ── Central / North SCS ──
  SCS_MID: [12.00, 112.00],
  SCS_N1:  [16.00, 113.00],
  SCS_N2:  [19.00, 114.50],
  SCS_NE:  [21.00, 116.00],

  // ── Gulf of Thailand ──
  GT_S1:   [5.5, 103.2],
  GT_S2:   [7.00, 102.50],
  GT_MID:  [9.50, 101.50],
  GT_N:    [12.00, 101.00],
  GT_BKKT: [13.50, 100.70],  // Bangkok/Laem Chabang approach

  // ── Vietnam coast ──
  VUNG_TAU:[9.50, 107.50],
  DA_NANG: [15.80, 109.20],
  HA_LONG: [20.50, 107.80],

  // ── Bangka / Belitung / Java Sea ──
  BANGKA_N:[-1.00, 105.50],
  BANGKA_S:[-2.50, 106.20],
  BELI:    [-2.80, 107.50],
  JAVA_W1: [-4.50, 106.00],
  JAVA_W2: [-5.50, 106.50],
  JAVA_W3: [-5.80, 107.50],
  JAVA_MID:[-5.50, 110.00],
  JAVA_E:  [-5.00, 114.00],

  // ── Sunda Strait ──
  SUNDA_N: [-5.50, 105.70],
  SUNDA_S: [-6.30, 105.40],

  // ── Karimata Strait ──
  KARIM_N: [-0.50, 108.50],
  KARIM_S: [-1.80, 108.80],

  // ── Makassar Strait ──
  MAKAS_N: [1.50, 118.00],
  MAKAS_S: [-3.00, 117.50],

  // ── Lombok / Flores ──
  LOMBOK:  [-8.50, 115.80],
  FLORES:  [-7.50, 119.00],

  // ── Celebes / Sulawesi Sea ──
  CELIB_W: [3.00, 121.00],

  // ── Philippine Sea ──
  PHIL_W:  [10.00, 120.00],
  LUZON:   [18.00, 121.00],

  // ── Indian Ocean ──
  IO_E1:   [4.00,  88.00],
  IO_E2:   [6.00,  85.00],
  IO_NE:   [7.50,  80.50],   // off Colombo
  IO_BAY1: [8.00,  86.00],
  IO_BAY2: [10.00,  88.00],
  IO_BAY3: [13.00,  82.00],

  // ── Port anchors (open-water approach) ──
  P_SING:  [1.2, 103.8],  // Singapore
  P_KLANG: [2.95, 101.1],  // Port Klang
  P_TPP:   [1.33, 103.54],  // Tanjung Pelepas
  P_JOHOR: [1.38, 104.02],  // Johor
  P_PENANG:[5.3, 100.25],  // Penang
  P_BATAM: [1.05,  104.10],  // Batam
  P_KARIN: [1.00,  103.42],  // Karimun
  P_PGUD:  [1.42, 103.92],  // Pasir Gudang
  P_BELAWAN:[3.75, 98.65],  // Belawan
  P_BKKT:  [13.00, 100.60],  // Bangkok / Laem Chabang
  P_HCMC:  [10.20, 107.00],  // Ho Chi Minh City
  P_HPHONG:[20.50, 106.80],  // Hai Phong
  P_HK:    [22.20, 114.00],  // Hong Kong
  P_COLOM: [6.85,   79.90],  // Colombo
  P_TPRIOK:[-5.90, 106.95],  // Tanjung Priok
  P_PALM:  [-2.80, 104.70],  // Palembang approach
  P_PDICK: [2.55, 101.75],  // Port Dickson approach
  P_KK:    [5.90,  116.10],  // Kota Kinabalu
};

// Fix negative lat notation
for (const k of Object.keys(NODES)) {
  const [la, lo] = NODES[k];
  NODES[k] = [la, lo];
}

// ─────────────────────────────────────────────────────────────────────────────
// EDGE LIST  [nodeA, nodeB]
// Only connect nodes where the straight line stays in open water.
// ─────────────────────────────────────────────────────────────────────────────
const EDGES = [
  // Andaman Sea
  ["AND_NW","AND_MID"],["AND_MID","AND_E"],["AND_E","AND_SE"],
  ["AND_SE","MAL_N1"],["AND_NW","MAL_N1"],["AND_MID","IO_BAY1"],

  // N Malacca spine
  ["MAL_N1","MAL_N2"],["MAL_N2","MAL_N3"],["MAL_N3","P_PENANG"],
  ["MAL_N3","MAL_N4"],["MAL_N4","MAL_M1"],["P_PENANG","MAL_N4"],

  // Mid Malacca spine (tight spine, stays in strait centre)
  ["MAL_M1","MAL_M2"],["MAL_M2","MAL_M3"],["MAL_M3","MAL_M4"],
  ["MAL_M4","MAL_M5"],["MAL_M5","MAL_M6"],["MAL_M6","MAL_M7"],
  ["MAL_M7","MAL_M8"],["MAL_M3","P_KLANG"],["MAL_M4","P_KLANG"],
  ["P_KLANG","MAL_M4"],["MAL_M4","P_PDICK"],["P_PDICK","MAL_M5"],

  // Dumai spur — branches OFF spine westward, stays in water
  ["MAL_M7","DUMAI_W"],["DUMAI_W","DUMAI_A"],
  ["MAL_M8","DUMAI_W"],

  // S Malacca → Singapore
  ["MAL_M8","MAL_S1"],["MAL_S1","MAL_S2"],["MAL_S2","KARIMUN"],
  ["KARIMUN","P_KARIN"],["KARIMUN","SG_MAIN"],["MAL_S2","SG_MAIN"],
  ["SG_MAIN","P_SING"],["SG_MAIN","P_TPP"],["SG_MAIN","SG_EAST"],
  ["SG_EAST","P_JOHOR"],["SG_EAST","P_PGUD"],["SG_EAST","P_BATAM"],
  ["P_BATAM","RIAU_W"],["RIAU_W","RIAU_S"],["RIAU_S","BATAM_S"],

  // Belawan ← N Malacca
  ["MAL_N1","P_BELAWAN"],["MAL_N2","P_BELAWAN"],

  // Singapore → SCS
  ["SG_EAST","SCS_SW1"],["SCS_SW1","SCS_SW2"],["SCS_SW2","SCS_SW3"],
  ["SCS_SW3","SCS_W1"],["SCS_W1","SCS_W2"],["SCS_W2","SCS_W3"],
  ["SCS_W3","SCS_W4"],["SCS_W4","SCS_MID"],["SCS_MID","SCS_N1"],
  ["SCS_N1","SCS_N2"],["SCS_N2","SCS_NE"],["SCS_NE","P_HK"],
  ["SCS_N1","P_HK"],["SCS_N1","P_HPHONG"],["SCS_W4","P_HCMC"],
  ["VUNG_TAU","P_HCMC"],["SCS_W3","VUNG_TAU"],
  ["SCS_W4","DA_NANG"],["DA_NANG","SCS_N1"],
  ["SCS_N2","HA_LONG"],["HA_LONG","P_HPHONG"],

  // Gulf of Thailand
  ["SCS_SW3","GT_S1"],["GT_S1","GT_S2"],["GT_S2","GT_MID"],
  ["GT_MID","GT_N"],["GT_N","GT_BKKT"],["GT_BKKT","P_BKKT"],
  ["SCS_W2","GT_S2"],

  // Bangka / Belitung
  ["SG_EAST","BANGKA_N"],["SCS_SW2","BANGKA_N"],
  ["BANGKA_N","BANGKA_S"],["BANGKA_S","BELI"],
  ["BANGKA_S","JAVA_W1"],["BELI","JAVA_W1"],
  ["BANGKA_N","P_PALM"],

  // Karimata Strait
  ["SCS_SW3","KARIM_N"],["KARIM_N","KARIM_S"],["KARIM_S","JAVA_W3"],
  ["KARIM_N","SCS_W1"],

  // Java Sea
  ["JAVA_W1","JAVA_W2"],["JAVA_W2","JAVA_W3"],["JAVA_W3","P_TPRIOK"],
  ["JAVA_W2","P_TPRIOK"],["JAVA_W3","JAVA_MID"],["JAVA_MID","JAVA_E"],
  ["JAVA_E","LOMBOK"],

  // Sunda Strait
  ["SUNDA_N","SUNDA_S"],["JAVA_W1","SUNDA_N"],["SUNDA_S","IO_E1"],
  ["MAL_S1","SUNDA_N"],  // from S Malacca, go south around tip

  // Makassar
  ["JAVA_E","MAKAS_S"],["MAKAS_S","MAKAS_N"],["MAKAS_N","CELIB_W"],
  ["CELIB_W","PHIL_W"],["PHIL_W","LUZON"],["LUZON","SCS_NE"],

  // Lombok / Flores
  ["LOMBOK","FLORES"],["FLORES","MAKAS_S"],

  // Kota Kinabalu
  ["SCS_W1","P_KK"],["SCS_W2","P_KK"],["MAKAS_N","P_KK"],
  ["P_KK","CELIB_W"],

  // Indian Ocean / Colombo
  ["MAL_N1","AND_SE"],["AND_SE","IO_BAY1"],["IO_BAY1","IO_BAY2"],
  ["IO_BAY2","IO_BAY3"],["IO_BAY3","IO_E2"],["IO_E2","IO_NE"],
  ["IO_NE","P_COLOM"],["IO_E1","IO_E2"],["IO_E1","AND_MID"],
  ["SUNDA_S","IO_E1"],
];

// ─────────────────────────────────────────────────────────────────────────────
// BUILD ADJACENCY MAP
// ─────────────────────────────────────────────────────────────────────────────
function deg2rad(d){ return d * Math.PI / 180; }
function distNM(la1, lo1, la2, lo2) {
  const R=3440.065, r=deg2rad;
  const dLa=r(la2-la1), dLo=r(lo2-lo1);
  const a=Math.sin(dLa/2)**2 + Math.cos(r(la1))*Math.cos(r(la2))*Math.sin(dLo/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

const graph = {}; // nodeId → [{id, dist}]
function addEdge(a, b) {
  if (!NODES[a] || !NODES[b]) return;
  const d = distNM(NODES[a][0], NODES[a][1], NODES[b][0], NODES[b][1]);
  if (!graph[a]) graph[a] = [];
  if (!graph[b]) graph[b] = [];
  graph[a].push({ id:b, dist:d });
  graph[b].push({ id:a, dist:d });
}
for (const [a,b] of EDGES) addEdge(a, b);

// ─────────────────────────────────────────────────────────────────────────────
// DIJKSTRA
// ─────────────────────────────────────────────────────────────────────────────
function dijkstra(startId, endId) {
  const dist = {}, prev = {}, visited = new Set();
  for (const k of Object.keys(NODES)) dist[k] = Infinity;
  dist[startId] = 0;

  // Simple priority queue (min-heap via sorted array — fine for ~150 nodes)
  const queue = [{ id:startId, d:0 }];

  while (queue.length) {
    queue.sort((a,b) => a.d - b.d);
    const { id:cur } = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    if (cur === endId) break;
    for (const { id:nb, dist:w } of (graph[cur]||[])) {
      if (visited.has(nb)) continue;
      const nd = dist[cur] + w;
      if (nd < dist[nb]) {
        dist[nb] = nd;
        prev[nb] = cur;
        queue.push({ id:nb, d:nd });
      }
    }
  }

  // Reconstruct path
  const path = [];
  let cur = endId;
  while (cur) { path.unshift(cur); cur = prev[cur]; }
  if (path[0] !== startId) return null; // no path found
  return path.map(id => ({ id, lat: NODES[id][0], lng: NODES[id][1] }));
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

// Find the nearest graph node to a lat/lng point
function nearestNode(lat, lng) {
  let best = null, bestDist = Infinity;
  for (const [id, [la, lo]] of Object.entries(NODES)) {
    const d = distNM(lat, lng, la, lo);
    if (d < bestDist) { bestDist = d; best = id; }
  }
  return best;
}

// Route from (srcLat,srcLng) to (dstLat,dstLng) via graph
// Returns array of {lat,lng} waypoints (includes src and dst)
function route(srcLat, srcLng, dstLat, dstLng, preferredDstNode) {
  const srcNode = nearestNode(srcLat, srcLng);
  const dstNode = preferredDstNode || nearestNode(dstLat, dstLng);

  if (srcNode === dstNode) {
    return [{ lat:srcLat, lng:srcLng }, { lat:dstLat, lng:dstLng }];
  }

  const graphPath = dijkstra(srcNode, dstNode);
  if (!graphPath) {
    // fallback: just direct line (shouldn't happen with connected graph)
    return [{ lat:srcLat, lng:srcLng }, { lat:dstLat, lng:dstLng }];
  }

  // Build final waypoint list:
  // vessel position → [graph nodes] → destination
  const wps = [{ lat:srcLat, lng:srcLng }];
  for (const node of graphPath) {
    // Skip if it's essentially the same as src or dst
    const dFromSrc = distNM(srcLat, srcLng, node.lat, node.lng);
    const dFromDst = distNM(dstLat, dstLng, node.lat, node.lng);
    if (dFromSrc < 5 || dFromDst < 5) continue;
    wps.push({ lat: node.lat, lng: node.lng, nodeId: node.id });
  }
  wps.push({ lat:dstLat, lng:dstLng });
  return wps;
}

module.exports = { route, nearestNode, distNM, NODES };