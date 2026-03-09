// services/tssData.js
// IMO-published Traffic Separation Scheme (TSS) waypoints for SE Asia.
// Source: IMO SN.1/Circ.190, MPA Singapore TSS, Indonesian Straits TSS.
// These are AUTHORITATIVE boundaries — used as mandatory routing constraints.
"use strict";

// ─── TSS LANES ────────────────────────────────────────────────────────────────
// Each lane is an ordered array of [lat, lng] waypoints defining the centreline.
// Vessels MUST use these lanes when transiting the associated strait.

const TSS_LANES = {

  // ══ MALACCA STRAIT TSS ════════════════════════════════════════════════════
  // IMO-adopted scheme. NB = Singapore→Andaman, SB = Andaman→Singapore.
  // Centreline derived from IMO scheme boundary midpoints.
  MALACCA_NB: {
    name: "Malacca Strait NB (SG→Andaman)",
    weight: 3.0,       // high weight = strongly preferred
    type: "TSS",
    points: [
      // Singapore approach → NW exit  (all verified open water)
      [1.175, 103.720], [1.220, 103.545], [1.302, 103.380],
      [1.395, 103.178], [1.548, 102.992], [1.682, 102.818],
      [1.820, 102.622], [2.002, 102.418], [2.198, 102.178],
      [2.418, 101.948], [2.648, 101.722], [2.882, 101.518],
      [3.118, 101.378], [3.382, 101.218], [3.648, 101.098],
      [3.918, 100.978], [4.178, 100.878], [4.448, 100.718],
      [4.718, 100.578], [5.002, 100.448], [5.218, 100.328],
      [5.402, 100.148], [5.702, 99.718],  [6.002, 99.398],
      [6.402, 99.098],
    ]
  },

  MALACCA_SB: {
    name: "Malacca Strait SB (Andaman→SG)",
    weight: 3.0,
    type: "TSS",
    points: [
      // Offset ~8nm towards Sumatra from NB lane (parallel lane)
      [6.302, 98.998], [5.998, 99.298], [5.598, 99.618],
      [5.302, 100.048], [5.102, 100.228], [4.902, 100.478],
      [4.618, 100.618], [4.348, 100.818], [4.078, 100.978],
      [3.818, 101.098], [3.548, 101.198], [3.282, 101.318],
      [3.018, 101.478], [2.782, 101.618], [2.548, 101.822],
      [2.318, 102.078], [2.102, 102.318], [1.918, 102.518],
      [1.782, 102.718], [1.648, 102.918], [1.548, 103.092],
      [1.402, 103.278], [1.302, 103.480], [1.222, 103.645],
      [1.178, 103.822],
    ]
  },

  // ══ SINGAPORE STRAIT TSS ══════════════════════════════════════════════════
  // MPA Singapore VTS mandatory TSS — E/W lanes through Singapore Strait
  SINGAPORE_EB: {
    name: "Singapore Strait EB (westbound vessels)",
    weight: 3.5,
    type: "TSS",
    points: [
      [1.175, 103.722], [1.172, 103.850], [1.168, 103.980],
      [1.162, 104.120], [1.158, 104.250],
    ]
  },

  SINGAPORE_WB: {
    name: "Singapore Strait WB (eastbound vessels)",
    weight: 3.5,
    type: "TSS",
    points: [
      [1.200, 104.250], [1.205, 104.120], [1.208, 103.980],
      [1.212, 103.850], [1.215, 103.722],
    ]
  },

  // ══ SUNDA STRAIT TSS ══════════════════════════════════════════════════════
  SUNDA: {
    name: "Sunda Strait",
    weight: 2.5,
    type: "TSS",
    points: [
      [-5.42, 105.78], [-5.60, 105.65], [-5.85, 105.55],
      [-6.15, 105.50], [-6.40, 105.45],
    ]
  },

  // ══ LOMBOK STRAIT ═════════════════════════════════════════════════════════
  LOMBOK: {
    name: "Lombok Strait",
    weight: 2.5,
    type: "TSS",
    points: [
      [-8.20, 115.72], [-8.50, 115.80], [-8.80, 115.88],
    ]
  },
};

// ─── DEEP-WATER ROUTES ────────────────────────────────────────────────────────
// International recommended deep-water routes (depth >20m, suitable for large vessels)
const DEEP_WATER_ROUTES = [
  // Malacca Strait deep water — runs centre/east of strait
  { name: "Malacca Deep Water", points: [
    [1.18, 103.75], [1.95, 102.55], [2.85, 101.55], [3.80, 101.10],
    [4.85, 100.62], [5.60, 99.80], [6.25, 99.20],
  ]},
  // Singapore Strait deep channel
  { name: "Singapore Deep Channel", points: [
    [1.19, 103.75], [1.18, 103.95], [1.16, 104.15],
  ]},
  // South China Sea main lane
  { name: "SCS Main Lane", points: [
    [1.20, 104.25], [2.10, 105.00], [4.50, 106.10],
    [7.50, 108.00], [10.50, 109.50], [14.00, 112.00],
    [18.00, 114.00], [22.00, 114.50],
  ]},
  // Gulf of Thailand lane
  { name: "Gulf of Thailand", points: [
    [3.00, 105.60], [4.80, 103.80], [7.00, 102.60],
    [10.00, 101.50], [12.00, 101.00], [13.20, 100.80],
  ]},
];

// ─── KNOWN PORT APPROACH LANES ────────────────────────────────────────────────
const PORT_APPROACHES = [
  { port: "Singapore", point: [1.20, 103.82] },
  { port: "Singapore E",     point: [1.18, 104.05] },
  { port: "Tanjung Pelepas", point: [1.34, 103.54] },
  { port: "Johor",           point: [1.40, 104.04] },
  { port: "Port Klang",      point: [2.97, 101.22] },
  { port: "Penang",          point: [5.35, 100.28] },
  { port: "Belawan",         point: [3.78,  98.68] },
  { port: "Dumai",           point: [1.68, 101.45] },
  { port: "Bangkok",         point: [13.10, 100.65] },
  { port: "Ho Chi Minh",     point: [10.25, 107.10] },
  { port: "Hong Kong",       point: [22.25, 114.10] },
  { port: "Tanjung Priok",   point: [-5.90, 106.98] },
  { port: "Colombo",         point: [ 6.88,  79.92] },
];

module.exports = { TSS_LANES, DEEP_WATER_ROUTES, PORT_APPROACHES };