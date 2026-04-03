// src/components/PortCongestionHeatmap.jsx — MPA v7
import React, { useRef, useEffect, useState, useCallback } from "react";
import "./Portcongestionheatmap.css";

// 12 regional ports with rough canvas coords (680×360 projection of SEA)
const PORTS = [
  { name:"Singapore",         code:"SGSIN", x:0.528, y:0.545, base:0.85 },
  { name:"Port Klang",        code:"MYPKG", x:0.468, y:0.500, base:0.65 },
  { name:"Tanjung Pelepas",   code:"MYPTP", x:0.508, y:0.540, base:0.58 },
  { name:"Penang",            code:"MYPNG", x:0.452, y:0.430, base:0.48 },
  { name:"Johor Port",        code:"MYJHB", x:0.522, y:0.548, base:0.44 },
  { name:"Batam",             code:"IDBTH", x:0.538, y:0.555, base:0.38 },
  { name:"Tanjung Priok",     code:"IDTPP", x:0.560, y:0.640, base:0.55 },
  { name:"Bangkok",           code:"THBKK", x:0.560, y:0.350, base:0.42 },
  { name:"Ho Chi Minh",       code:"VNSGN", x:0.636, y:0.430, base:0.52 },
  { name:"Hong Kong",         code:"HKHKG", x:0.718, y:0.278, base:0.78 },
  { name:"Colombo",           code:"LKCMB", x:0.340, y:0.500, base:0.46 },
  { name:"Laem Chabang",      code:"THLCH", x:0.570, y:0.380, base:0.48 },
];

// Landmass polygons as ratio coords
const LANDMASSES = [
  // Malay Peninsula (simplified)
  [[0.44,0.38],[0.46,0.36],[0.50,0.37],[0.52,0.42],[0.54,0.48],[0.53,0.52],[0.51,0.545],[0.50,0.54],[0.49,0.50],[0.47,0.46],[0.45,0.42]],
  // Sumatra (very simplified)
  [[0.43,0.46],[0.44,0.44],[0.48,0.46],[0.52,0.50],[0.55,0.55],[0.56,0.60],[0.54,0.62],[0.50,0.60],[0.46,0.56],[0.44,0.52]],
  // Java (simplified)
  [[0.52,0.62],[0.56,0.61],[0.62,0.63],[0.66,0.64],[0.64,0.66],[0.58,0.66],[0.53,0.65]],
  // Borneo (simplified)
  [[0.58,0.46],[0.62,0.44],[0.66,0.46],[0.68,0.50],[0.70,0.54],[0.68,0.58],[0.64,0.58],[0.60,0.56],[0.57,0.52]],
  // Indochina (simplified)
  [[0.54,0.26],[0.60,0.24],[0.64,0.28],[0.66,0.34],[0.64,0.40],[0.60,0.44],[0.58,0.46],[0.56,0.42],[0.54,0.36],[0.52,0.30]],
  // Sri Lanka
  [[0.336,0.490],[0.350,0.486],[0.356,0.502],[0.348,0.518],[0.334,0.510]],
];

// Shipping lanes (from→to as ratio coords)
const LANES = [
  [[0.30,0.48],[0.40,0.46],[0.47,0.50],[0.53,0.54],[0.60,0.46],[0.70,0.30]], // IOcean→HK
  [[0.53,0.54],[0.56,0.62],[0.62,0.64]],                                       // Sg→Java
  [[0.53,0.54],[0.57,0.52],[0.64,0.48],[0.68,0.40],[0.72,0.28]],               // Sg→HK via SCS
];

const METRICS = [
  { key:"congestion",  label:"Congestion",     ramp:["#0ff8e7","#00e5ff","#0070b4"], unit:"%" },
  { key:"arrivals",    label:"Arrivals (24h)",  ramp:["#7cdcff","#0080ff","#003090"], unit:" ships" },
  { key:"departures",  label:"Departures (24h)",ramp:["#ffd080","#fd9644","#c43b00"], unit:" ships" },
  { key:"dwell",       label:"Avg Dwell Time",  ramp:["#c3a0ff","#7c4dff","#2d0090"], unit:"h" },
];

function buildValues(metric) {
  return PORTS.map(p => {
    const noise = 0.88 + Math.random() * 0.24;
    if (metric === "congestion")  return Math.round(p.base * 100 * noise);
    if (metric === "arrivals")    return Math.round(p.base * 120 * noise);
    if (metric === "departures")  return Math.round(p.base * 100 * noise);
    if (metric === "dwell")       return Math.round((1 - p.base) * 96 * noise + 4);
    return 0;
  });
}

export default function PortCongestionHeatmap({ isOpen, onClose }) {
  const canvasRef   = useRef(null);
  const rafRef      = useRef(null);
  const frameRef    = useRef(0);
  const [metric,    setMetric]    = useState("congestion");
  const [animate,   setAnimate]   = useState(true);
  const [hovered,   setHovered]   = useState(null);
  const [tooltip,   setTooltip]   = useState(null);
  const valuesRef   = useRef(buildValues("congestion"));

  // Regenerate values when metric changes
  useEffect(() => {
    valuesRef.current = buildValues(metric);
  }, [metric]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;

    // Background
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#060e18";
    ctx.fillRect(0, 0, W, H);

    // Grid lines (very subtle)
    ctx.strokeStyle = "rgba(0,229,255,0.04)";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 8; i++) {
      ctx.beginPath(); ctx.moveTo(i * W/8, 0); ctx.lineTo(i * W/8, H); ctx.stroke();
    }
    for (let i = 0; i <= 5; i++) {
      ctx.beginPath(); ctx.moveTo(0, i * H/5); ctx.lineTo(W, i * H/5); ctx.stroke();
    }

    // Landmasses
    ctx.fillStyle = "rgba(15,30,52,0.95)";
    ctx.strokeStyle = "rgba(0,229,255,0.12)";
    ctx.lineWidth = 0.8;
    LANDMASSES.forEach(poly => {
      ctx.beginPath();
      ctx.moveTo(poly[0][0] * W, poly[0][1] * H);
      poly.slice(1).forEach(([px, py]) => ctx.lineTo(px * W, py * H));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });

    // Shipping lanes
    LANES.forEach(lane => {
      ctx.beginPath();
      ctx.moveTo(lane[0][0] * W, lane[0][1] * H);
      lane.slice(1).forEach(([px, py]) => ctx.lineTo(px * W, py * H));
      ctx.strokeStyle = "rgba(0,229,255,0.10)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Metric config
    const mt = METRICS.find(m => m.key === metric);
    const vals = valuesRef.current;
    const maxVal = Math.max(...vals);
     

    // Ramp color helper
    function rampColor(t, alpha) {
      const ramp = mt.ramp;
      const i = Math.min(Math.floor(t * (ramp.length - 1)), ramp.length - 2);
      const f = t * (ramp.length - 1) - i;
      const c1 = hexToRgb(ramp[i]), c2 = hexToRgb(ramp[i + 1]);
      const r = Math.round(c1[0] + (c2[0]-c1[0])*f);
      const g = Math.round(c1[1] + (c2[1]-c1[1])*f);
      const b = Math.round(c1[2] + (c2[2]-c1[2])*f);
      return `rgba(${r},${g},${b},${alpha})`;
    }

    // Heat blobs
    PORTS.forEach((p, i) => {
      const val    = vals[i];
      const t      = maxVal > 0 ? val / maxVal : 0;
      const pulseAnim = animate
        ? 0.85 + 0.15 * Math.sin(frameRef.current * 0.04 + i * 1.1)
        : 1;
      const px     = p.x * W;
      const py     = p.y * H;
      const radius = (30 + t * 55) * pulseAnim * (W / 680);

      const grd = ctx.createRadialGradient(px, py, 0, px, py, radius);
      grd.addColorStop(0,   rampColor(t, 0.55 * pulseAnim));
      grd.addColorStop(0.4, rampColor(t, 0.20 * pulseAnim));
      grd.addColorStop(1,   rampColor(t, 0));
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
    });

    // Port dots + labels
    PORTS.forEach((p, i) => {
      const val = vals[i];
      const t   = maxVal > 0 ? val / maxVal : 0;
      const px  = p.x * W, py = p.y * H;
      const isHov = hovered === i;

      // Outer ring for hovered
      if (isHov) {
        ctx.beginPath();
        ctx.arc(px, py, 10 * (W/680), 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Dot color by congestion tier
      const pct = metric === "dwell" ? 1 - t : t;
      const dotCol = pct > 0.7 ? "#ff3355" : pct > 0.5 ? "#ffaa00" : "#00e5ff";
      ctx.beginPath();
      ctx.arc(px, py, isHov ? 5*(W/680) : 3.5*(W/680), 0, Math.PI * 2);
      ctx.fillStyle = dotCol;
      ctx.fill();
      ctx.strokeStyle = "#060e18";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Short port label
      if (isHov || t > 0.55) {
        ctx.fillStyle = isHov ? "#f0f8ff" : "rgba(138,180,208,0.85)";
        ctx.font = `${isHov ? 700 : 500} ${(W/680) * 9}px 'JetBrains Mono', monospace`;
        ctx.textAlign = "center";
        ctx.fillText(p.code, px, py - 9*(W/680));
      }
    });
  }, [metric, animate, hovered]);

  useEffect(() => {
    if (!isOpen) return;
    // Bug #1 fix: throttle to ~12fps (80ms) instead of raw 60fps.
    // The heatmap's sine-wave blobs don't need 60fps — 12fps is visually identical
    // but uses ~80% less main-thread time, stopping it from competing with Google Maps.
    const FRAME_MS = 80;
    let lastTs = 0;
    const loop = (ts) => {
      rafRef.current = requestAnimationFrame(loop);
      if (ts - lastTs < FRAME_MS) return;
      lastTs = ts;
      frameRef.current++;
      draw();
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw, isOpen]);

  // Mouse move → find nearest port
  const handleMouseMove = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top)  / rect.height;
    let closest = null, minDist = 0.04;
    PORTS.forEach((p, i) => {
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < minDist) { minDist = d; closest = i; }
    });
    setHovered(closest);
    if (closest !== null) {
      const p   = PORTS[closest];
      const val = valuesRef.current[closest];
      const mt  = METRICS.find(m => m.key === metric);
      setTooltip({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top - 40,
        name: p.name,
        val: `${val}${mt.unit}`,
      });
    } else {
      setTooltip(null);
    }
  }, [metric]);

  // Derived stats
  const vals    = valuesRef.current;
  const maxIdx  = vals.indexOf(Math.max(...vals));
  const totalVessels = vals.reduce((s, v, i) => s + Math.round(PORTS[i].base * 280), 0);
  const highCongPort = metric === "dwell"
    ? vals.filter((v,i) => (1 - v/Math.max(...vals)) > 0.7).length
    : vals.filter(v => v / Math.max(...vals) > 0.7).length;
  const mt = METRICS.find(m => m.key === metric);

  if (!isOpen) return null;

  return (
    <div className="hm-panel">
      {/* Header */}
      <div className="hm-header">
        <div className="hm-header-left">
          <span className="hm-title">PORT CONGESTION</span>
          <span className="hm-subtitle">{mt.label}</span>
        </div>
        <div className="hm-header-right">
          <div className="hm-metric-tabs">
            {METRICS.map(m => (
              <button
                key={m.key}
                className={`hm-metric-tab${metric === m.key ? " active" : ""}`}
                onClick={() => setMetric(m.key)}
              >
                {m.label.split(" ")[0].toUpperCase()}
              </button>
            ))}
          </div>
          <button
            className={`hm-anim-btn${animate ? " active" : ""}`}
            onClick={() => setAnimate(p => !p)}
            title="Toggle animation"
          >
            {animate ? "⏸" : "▶"}
          </button>
          <button className="hm-close-btn" onClick={onClose}>✕</button>
        </div>
      </div>

      {/* Canvas */}
      <div className="hm-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="hm-canvas"
          width={680}
          height={320}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => { setHovered(null); setTooltip(null); }}
        />
        {tooltip && (
          <div
            className="hm-tooltip"
            style={{ left: tooltip.x + 12, top: tooltip.y }}
          >
            <div className="hm-tt-name">{tooltip.name}</div>
            <div className="hm-tt-val">{tooltip.val}</div>
          </div>
        )}
        {/* Legend bar */}
        <div className="hm-legend-bar">
          <span className="hm-leg-low">LOW</span>
          <div
            className="hm-leg-ramp"
            style={{ background: `linear-gradient(to right, ${mt.ramp.join(",")})` }}
          />
          <span className="hm-leg-high">HIGH</span>
        </div>
      </div>

      {/* Stat cards */}
      <div className="hm-stats">
        <div className="hm-stat">
          <div className="hm-stat-label">BUSIEST PORT</div>
          <div className="hm-stat-val">{PORTS[maxIdx]?.name}</div>
        </div>
        <div className="hm-stat">
          <div className="hm-stat-label">TOTAL VESSELS (EST)</div>
          <div className="hm-stat-val">{totalVessels.toLocaleString()}</div>
        </div>
        <div className="hm-stat">
          <div className="hm-stat-label">HIGH CONGESTION</div>
          <div className="hm-stat-val hm-stat-warn">{highCongPort} ports</div>
        </div>
      </div>
    </div>
  );
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return [r,g,b];
}