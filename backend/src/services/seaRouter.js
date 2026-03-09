// services/seaRouter.js — Maritime Graph Router v3
// Dense verified open-water graph SE Asia / Indian Ocean.
"use strict";

function deg2rad(d) { return d * Math.PI / 180; }
function distNM(la1, lo1, la2, lo2) {
  const R = 3440.065, r = deg2rad;
  const dLa = r(la2-la1), dLo = r(lo2-lo1);
  const a = Math.sin(dLa/2)**2 + Math.cos(r(la1))*Math.cos(r(la2))*Math.sin(dLo/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

const NODES = {
  // Andaman Sea
  AND_NW:   [ 9.50, 92.00], AND_MID:  [ 8.00, 95.00], AND_E:    [10.00, 98.50],
  AND_SE:   [ 7.50, 98.20], AND_S:    [ 6.00, 98.50],
  // North Malacca Strait - dense spine (NO nodes over land)
  MAL_N0:   [ 6.50, 99.00], MAL_N1:   [ 6.10, 99.30], MAL_N2:   [ 5.75, 99.65],
  MAL_N3:   [ 5.40,100.00], MAL_N4:   [ 5.15,100.20], MAL_N5:   [ 5.00,100.40],
  MAL_N6:   [ 4.70,100.65],
  // Mid Malacca Strait - tight centre-channel spine
  MAL_M1:   [ 4.40,100.85], MAL_M2:   [ 4.00,101.10], MAL_M3:   [ 3.60,101.25],
  MAL_M4:   [ 3.20,101.30], MAL_M5:   [ 2.90,101.55], MAL_M6:   [ 2.60,101.85],
  MAL_M7:   [ 2.30,102.20], MAL_M8:   [ 2.00,102.55], MAL_M9:   [ 1.80,102.85],
  // South Malacca → Singapore
  MAL_S1:   [ 1.55,103.15], MAL_S2:   [ 1.35,103.50], MAL_S3:   [ 1.22,103.68],
  SG_MAIN:  [ 1.18,103.78], SG_E1:    [ 1.17,104.00], SG_EAST:  [ 1.16,104.20],
  SG_SE:    [ 1.05,104.40],
  // Riau / Batam
  RIAU_W:   [ 0.90,103.85], RIAU_N:   [ 1.00,104.10], BATAM_S:  [ 0.75,104.35],
  RIAU_S:   [ 0.45,104.10],
  // Riau East Corridor
  RIAU_E1:  [ 1.10,105.10], RIAU_E2:  [ 0.55,105.20], RIAU_E3:  [ 0.00,105.25],
  RIAU_E4:  [-0.45,105.35], RIAU_E5:  [-0.85,105.50],
  // Durian Strait
  DUR_N:    [ 0.85,103.72], DUR_M:    [ 0.35,103.95], DUR_S:    [-0.15,104.20],
  DUR_E:    [-0.75,104.60],
  // Dumai
  DUMAI_W:  [ 1.72,101.55], DUMAI_A:  [ 1.68,101.45],
  // Port approach nodes
  P_SING:   [ 1.20,103.82], P_TPP:    [ 1.34,103.54], P_JOHOR:  [ 1.40,104.04],
  P_PGUD:   [ 1.44,103.93], P_BATAM:  [ 1.07,104.12], P_KARIN:  [ 1.02,103.44],
  P_KLANG:  [ 2.97,101.22], P_PDICK:  [ 2.55,101.78], P_PENANG: [ 5.32,100.28],
  P_BELAWAN:[ 3.76, 98.66], P_DUMAI:  [ 1.68,101.45], KARIMUN:  [ 1.08,103.44],
  // Gulf of Thailand
  GT_S1:    [ 4.50,103.80], GT_S2:    [ 5.50,103.30], GT_S3:    [ 7.00,102.60],
  GT_MID:   [ 9.50,101.60], GT_N:     [11.50,101.20], GT_BKKT:  [13.20,100.80],
  P_BKKT:   [13.10,100.65],
  // South China Sea
  SCS_SW1:  [ 1.55,104.60], SCS_SW2:  [ 2.10,105.00], SCS_SW3:  [ 3.00,105.60],
  SCS_W1:   [ 4.50,106.10], SCS_W2:   [ 6.00,107.20], SCS_W3:   [ 8.00,108.30],
  SCS_W4:   [10.00,109.20], SCS_MID:  [12.00,112.00], SCS_N1:   [16.00,113.50],
  SCS_N2:   [19.00,115.00], SCS_NE:   [21.50,116.50],
  // Vietnam
  VUNG_TAU: [ 9.60,107.60], DA_NANG:  [15.80,109.40], HA_LONG:  [20.50,107.90],
  P_HCMC:   [10.25,107.10], P_HPHONG: [20.55,106.82], P_HK:     [22.25,114.10],
  // Bangka-Belitung / Java Sea
  BANGKA_N: [-0.90,105.60], BANGKA_S: [-2.40,106.30], BELI:     [-2.75,107.60],
  KARIM_N:  [-0.40,108.60], KARIM_S:  [-1.70,108.90],
  JAVA_W1:  [-4.50,106.10], JAVA_W2:  [-5.50,106.60], JAVA_W3:  [-5.80,107.60],
  JAVA_MID: [-5.50,110.10], JAVA_E:   [-5.00,114.10],
  SUNDA_N:  [-5.40,105.75], SUNDA_S:  [-6.20,105.50],
  // East / Makassar
  MAKAS_N:  [ 1.50,118.10], MAKAS_S:  [-3.00,117.60], LOMBOK:   [-8.50,115.90],
  FLORES:   [-7.50,119.10], CELIB_W:  [ 3.00,121.10], PHIL_W:   [10.00,120.10],
  LUZON:    [18.00,121.50], P_KK:     [ 5.92,116.12],
  // Indian Ocean
  IO_E1:    [ 4.00, 88.00], IO_E2:    [ 6.00, 85.00], IO_NE:    [ 7.60, 80.60],
  IO_BAY1:  [ 8.00, 86.00], IO_BAY2:  [10.00, 88.00], IO_BAY3:  [13.00, 82.00],
  P_COLOM:  [ 6.88, 79.92],
  // Tanjung Priok / Palembang
  P_TPRIOK: [-5.88,106.98], P_PALM:   [-2.75,104.75],
};

const EDGES = [
  // Andaman
  ["AND_NW","AND_MID"],["AND_MID","AND_E"],["AND_E","AND_SE"],["AND_SE","AND_S"],
  ["AND_S","MAL_N0"],["AND_NW","MAL_N0"],["AND_MID","IO_BAY1"],["AND_NW","IO_BAY2"],
  // N Malacca spine
  ["MAL_N0","MAL_N1"],["MAL_N1","MAL_N2"],["MAL_N2","MAL_N3"],["MAL_N3","MAL_N4"],
  ["MAL_N4","P_PENANG"],["MAL_N4","MAL_N5"],["P_PENANG","MAL_N5"],["MAL_N5","MAL_N6"],
  ["MAL_N0","P_BELAWAN"],["MAL_N1","P_BELAWAN"],["MAL_N2","P_BELAWAN"],
  // Mid Malacca spine
  ["MAL_N6","MAL_M1"],["MAL_M1","MAL_M2"],["MAL_M2","MAL_M3"],["MAL_M3","MAL_M4"],
  ["MAL_M4","MAL_M5"],["MAL_M5","MAL_M6"],["MAL_M6","MAL_M7"],["MAL_M7","MAL_M8"],
  ["MAL_M8","MAL_M9"],
  ["MAL_M3","P_KLANG"],["MAL_M4","P_KLANG"],["MAL_M4","P_PDICK"],["P_PDICK","MAL_M5"],
  ["MAL_M8","DUMAI_W"],["MAL_M9","DUMAI_W"],["DUMAI_W","DUMAI_A"],["DUMAI_W","P_DUMAI"],
  // S Malacca → Singapore
  ["MAL_M9","MAL_S1"],["MAL_S1","MAL_S2"],["MAL_S2","MAL_S3"],["MAL_S3","SG_MAIN"],
  ["MAL_S2","KARIMUN"],["KARIMUN","P_KARIN"],["KARIMUN","SG_MAIN"],
  ["SG_MAIN","P_SING"],["SG_MAIN","P_TPP"],["SG_MAIN","SG_E1"],
  ["SG_E1","SG_EAST"],["SG_EAST","P_JOHOR"],["SG_EAST","P_PGUD"],["SG_EAST","SG_SE"],
  // Riau / Batam
  ["SG_MAIN","RIAU_W"],["SG_E1","RIAU_N"],["RIAU_N","RIAU_E1"],["RIAU_N","BATAM_S"],
  ["RIAU_W","RIAU_S"],["RIAU_S","DUR_N"],["P_BATAM","RIAU_N"],["SG_EAST","P_BATAM"],
  // Riau East Corridor
  ["RIAU_E1","RIAU_E2"],["RIAU_E2","RIAU_E3"],["RIAU_E3","RIAU_E4"],["RIAU_E4","RIAU_E5"],
  ["RIAU_E5","BANGKA_N"],["SCS_SW1","RIAU_E1"],["SG_SE","RIAU_E1"],
  // Durian Strait
  ["DUR_N","DUR_M"],["DUR_M","DUR_S"],["DUR_S","DUR_E"],["DUR_E","BANGKA_N"],
  // SG → SCS
  ["SG_EAST","SCS_SW1"],["SG_SE","SCS_SW1"],["SCS_SW1","SCS_SW2"],["SCS_SW2","SCS_SW3"],
  ["SCS_SW3","SCS_W1"],["SCS_W1","SCS_W2"],["SCS_W2","SCS_W3"],["SCS_W3","SCS_W4"],
  ["SCS_W4","SCS_MID"],["SCS_MID","SCS_N1"],["SCS_N1","SCS_N2"],["SCS_N2","SCS_NE"],
  ["SCS_NE","P_HK"],["SCS_N1","P_HK"],
  ["SCS_W4","VUNG_TAU"],["VUNG_TAU","P_HCMC"],["SCS_W3","VUNG_TAU"],
  ["SCS_W4","DA_NANG"],["DA_NANG","SCS_N1"],["SCS_N2","HA_LONG"],["HA_LONG","P_HPHONG"],
  ["SCS_N1","P_HPHONG"],
  // Gulf of Thailand
  ["SCS_SW3","GT_S1"],["GT_S1","GT_S2"],["GT_S2","GT_S3"],["GT_S3","GT_MID"],
  ["GT_MID","GT_N"],["GT_N","GT_BKKT"],["GT_BKKT","P_BKKT"],["SCS_W1","GT_S1"],
  // Bangka / Java Sea
  ["BANGKA_N","BANGKA_S"],["BANGKA_S","BELI"],["BELI","KARIM_N"],["KARIM_N","KARIM_S"],
  ["KARIM_N","JAVA_MID"],["BANGKA_S","JAVA_W1"],["JAVA_W1","JAVA_W2"],["JAVA_W2","JAVA_W3"],
  ["JAVA_W3","JAVA_MID"],["JAVA_MID","JAVA_E"],["JAVA_E","MAKAS_S"],
  ["RIAU_E5","BANGKA_N"],["JAVA_W3","P_TPRIOK"],["JAVA_W2","P_TPRIOK"],
  ["BANGKA_S","P_PALM"],
  // Sunda Strait
  ["SUNDA_N","JAVA_W2"],["SUNDA_N","SUNDA_S"],["SUNDA_S","IO_E1"],["JAVA_W1","SUNDA_N"],
  // East
  ["JAVA_E","LOMBOK"],["LOMBOK","FLORES"],["FLORES","MAKAS_S"],["MAKAS_S","MAKAS_N"],
  ["MAKAS_N","CELIB_W"],["CELIB_W","PHIL_W"],["PHIL_W","LUZON"],["LUZON","P_HK"],
  ["MAKAS_N","P_KK"],["P_KK","PHIL_W"],["JAVA_E","KARIM_S"],["P_KK","SCS_MID"],
  // Indian Ocean
  ["IO_NE","P_COLOM"],["IO_NE","IO_E2"],["IO_E2","IO_E1"],["IO_E1","SUNDA_S"],
  ["IO_BAY1","IO_E1"],["IO_BAY1","IO_BAY2"],["IO_BAY2","IO_BAY3"],["IO_BAY3","IO_NE"],
  ["AND_NW","IO_NE"],["AND_NW","IO_E1"],
];

// Build adjacency graph
const graph = {};
for (const [a,b] of EDGES) {
  if (!NODES[a]||!NODES[b]) { console.warn(`[seaRouter] Bad edge: ${a}-${b}`); continue; }
  const d = distNM(NODES[a][0],NODES[a][1],NODES[b][0],NODES[b][1]);
  if (!graph[a]) graph[a]=[];
  if (!graph[b]) graph[b]=[];
  graph[a].push({id:b,dist:d});
  graph[b].push({id:a,dist:d});
}

// Dijkstra
function dijkstra(startId, endId) {
  if (!NODES[startId]||!NODES[endId]) return null;
  const dist={}, prev={}, visited=new Set();
  for (const k of Object.keys(NODES)) dist[k]=Infinity;
  dist[startId]=0;
  const queue=[{id:startId,d:0}];
  while (queue.length) {
    queue.sort((a,b)=>a.d-b.d);
    const {id:cur}=queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    if (cur===endId) break;
    for (const {id:nb,dist:w} of (graph[cur]||[])) {
      if (visited.has(nb)) continue;
      const nd=dist[cur]+w;
      if (nd<dist[nb]) { dist[nb]=nd; prev[nb]=cur; queue.push({id:nb,d:nd}); }
    }
  }
  if (dist[endId]===Infinity) return null;
  const path=[]; let cur=endId;
  while (cur) { path.unshift(cur); cur=prev[cur]; }
  if (path[0]!==startId) return null;
  return path.map(id=>({id,lat:NODES[id][0],lng:NODES[id][1]}));
}

// Find nearest node, bias toward heading direction
function nearestNode(lat, lng, headingDeg=null) {
  let best=null, bestScore=Infinity;
  for (const [id,[la,lo]] of Object.entries(NODES)) {
    const d=distNM(lat,lng,la,lo);
    let score=d;
    if (headingDeg!=null && d>0) {
      const bearing=(Math.atan2(lo-lng,la-lat)*180/Math.PI+360)%360;
      const diff=Math.abs(((bearing-headingDeg)+540)%360-180);
      if (diff>120) score*=1.5; // penalise nodes behind vessel
    }
    if (score<bestScore) { bestScore=score; best=id; }
  }
  return best;
}

function route(srcLat, srcLng, dstLat, dstLng, preferredDstNode=null, headingDeg=null) {
  if (distNM(srcLat,srcLng,dstLat,dstLng)<10)
    return [{lat:srcLat,lng:srcLng},{lat:dstLat,lng:dstLng}];

  const srcNode=nearestNode(srcLat,srcLng,headingDeg);
  const dstNode=preferredDstNode||nearestNode(dstLat,dstLng);

  if (srcNode===dstNode)
    return [{lat:srcLat,lng:srcLng},{lat:dstLat,lng:dstLng}];

  const graphPath=dijkstra(srcNode,dstNode);
  if (!graphPath) {
    console.warn(`[seaRouter] No path ${srcNode}→${dstNode}`);
    return [{lat:srcLat,lng:srcLng},{lat:dstLat,lng:dstLng}];
  }

  const MIN=8; // nm — don't add nodes too close to src/dst
  const wps=[{lat:srcLat,lng:srcLng}];
  for (const node of graphPath) {
    if (distNM(srcLat,srcLng,node.lat,node.lng)<MIN) continue;
    if (distNM(dstLat,dstLng,node.lat,node.lng)<MIN) continue;
    wps.push({lat:node.lat,lng:node.lng,nodeId:node.id});
  }
  wps.push({lat:dstLat,lng:dstLng});
  return wps;
}

function routeWithMeta(srcLat,srcLng,dstLat,dstLng,preferredDstNode=null,headingDeg=null) {
  const wps=route(srcLat,srcLng,dstLat,dstLng,preferredDstNode,headingDeg);
  let totalNM=0;
  const segments=[];
  for (let i=1;i<wps.length;i++) {
    const d=distNM(wps[i-1].lat,wps[i-1].lng,wps[i].lat,wps[i].lng);
    totalNM+=d;
    segments.push({from:wps[i-1],to:wps[i],distNM:Math.round(d)});
  }
  return {waypoints:wps,totalNM:Math.round(totalNM),segments};
}

module.exports = { route, routeWithMeta, nearestNode, distNM, NODES };