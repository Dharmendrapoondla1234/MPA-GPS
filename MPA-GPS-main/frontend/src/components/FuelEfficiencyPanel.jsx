// src/components/FuelEfficiencyPanel.jsx — v2 "Fuel Intelligence"
// Fuel efficiency + 28-day history chart + 14-day ML prediction.
// Uses project design tokens, dp-info-card / dp-section / dp-row patterns.
// Chart.js is injected lazily — zero cost until this tab is opened.
import React, { useState, useEffect, useRef, useCallback } from "react";
import { fetchVesselFuelEfficiency } from "../services/api";
import "./FuelEfficiencyPanel.css";

// ── Physics model (mirrors backend fuelEfficiency.js) ─────────────
const PROFILES = {
  CONTAINER:       { ds: 20, df: 175, exp: 3.2 },
  TANKER:          { ds: 14, df: 60,  exp: 3.0 },
  CRUDE:           { ds: 14, df: 80,  exp: 3.0 },
  "BULK CARRIER":  { ds: 13, df: 35,  exp: 3.1 },
  BULK:            { ds: 13, df: 35,  exp: 3.1 },
  LNG:             { ds: 19, df: 145, exp: 3.0 },
  "GENERAL CARGO": { ds: 13, df: 28,  exp: 3.0 },
  FERRY:           { ds: 20, df: 45,  exp: 2.8 },
  DEFAULT:         { ds: 13, df: 40,  exp: 3.0 },
};
const CO2_HFO = 3.114;

function getProfile(vtype) {
  const k = (vtype || "DEFAULT").toUpperCase().replace(/^BULK$/, "BULK CARRIER");
  return PROFILES[k] || PROFILES.DEFAULT;
}

// ── Generate 28-day simulated history ────────────────────────────
function buildHistory(live) {
  if (!live) return [];
  const baseSpeed = live.current_speed_kn || 0;
  const p = getProfile(live.vessel_type);
  return Array.from({ length: 28 }, (_, idx) => {
    const d     = 27 - idx;
    const noise = (Math.random() - 0.5) * 3.2 + Math.sin(d * 0.42) * 1.6;
    const speed = Math.max(0, +(baseSpeed + noise).toFixed(1));
    const sr    = speed > 0 ? speed / p.ds : 0;
    const fuel  = speed > 0.5
      ? +(p.df * Math.pow(sr, p.exp)).toFixed(1)
      : +((live.fuel_consumption_mt_day || 0) * 0.06).toFixed(1);
    const co2   = +(fuel * CO2_HFO).toFixed(2);
    const base  = live.fuel_consumption_mt_day || fuel;
    const eff   = Math.min(100, Math.max(10, Math.round(100 - ((fuel / Math.max(base, 1)) - 1) * 80)));
    const date  = new Date(Date.now() - d * 86_400_000);
    return {
      d, speed, fuel, co2, eff, cost: Math.round(fuel * 400),
      label:  date.toLocaleDateString("en-SG", { month: "short", day: "numeric" }),
      labelS: date.toLocaleDateString("en-SG", { month: "numeric", day: "numeric" }),
    };
  });
}

// ── Linear regression + 14-day prediction ────────────────────────
function buildPrediction(hist, live) {
  if (!hist.length) return { rows: [], r2: 0, conf: 0, slope: 0 };
  const n   = hist.length;
  const ys  = hist.map(h => h.fuel);
  const mx  = (n - 1) / 2;
  const my  = ys.reduce((a, b) => a + b, 0) / n;
  const num = ys.reduce((s, y, i) => s + (i - mx) * (y - my), 0);
  const den = ys.reduce((s, _, i) => s + (i - mx) ** 2, 0);
  const m   = den ? num / den : 0;
  const b   = my - m * mx;
  const ssR = ys.reduce((s, y, i) => s + (y - (b + m * i)) ** 2, 0);
  const ssT = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  const r2  = ssT ? Math.max(0, 1 - ssR / ssT) : 0;

  const rows = Array.from({ length: 14 }, (_, i) => {
    const xi   = n + i;
    const fuel = Math.max(0, +(b + m * xi).toFixed(1));
    const date = new Date(Date.now() + (i + 1) * 86_400_000);
    return {
      i, fuel,
      co2:  +(fuel * CO2_HFO).toFixed(2),
      cost: Math.round(fuel * 400),
      conf: Math.max(35, Math.round(r2 * 100) - i * 2),
      label:  date.toLocaleDateString("en-SG", { month: "short", day: "numeric" }),
      labelS: date.toLocaleDateString("en-SG", { month: "numeric", day: "numeric" }),
    };
  });
  return { rows, r2: +r2.toFixed(3), conf: Math.round(r2 * 100), slope: m };
}

// ── Design tokens ─────────────────────────────────────────────────
const CII_COLOR = { A: "#00ff9d", B: "#a3e635", C: "#ffaa00", D: "#fd7272", E: "#ff2244" };
const CII_DESC  = { A: "Major improvement", B: "Minor improvement", C: "Moderate — IMO target", D: "Below standard", E: "Significantly below" };
const SPD_COLOR = { berthed: "#546e7a", slow: "#fd7272", "below-optimal": "#ffaa00", optimal: "#00ff9d", high: "#ffaa00", excessive: "#ff2244" };
const effColor  = s => s >= 80 ? "#00ff9d" : s >= 60 ? "#a3e635" : s >= 40 ? "#ffaa00" : "#fd7272";

// ── Chart.js lazy loader ──────────────────────────────────────────
let _cjsReady = false, _cjsLoading = false;
const _cjsCbs = [];
function loadCJS(cb) {
  if (_cjsReady) { cb(); return; }
  _cjsCbs.push(cb);
  if (_cjsLoading) return;
  _cjsLoading = true;
  const s   = document.createElement("script");
  s.src     = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";
  s.onload  = () => { _cjsReady = true; _cjsCbs.forEach(f => f()); _cjsCbs.length = 0; };
  document.head.appendChild(s);
}

const CTABS = [
  { id: "fuel", lbl: "Fuel",  hKey: "fuel",  pKey: "fuel",  unit: "MT/d",  hC: "#ffaa00", pC: "rgba(255,170,0,0.4)" },
  { id: "co2",  lbl: "CO₂",  hKey: "co2",   pKey: "co2",   unit: "MT/d",  hC: "#ff5577", pC: "rgba(255,85,119,0.35)" },
  { id: "eff",  lbl: "Score", hKey: "eff",   pKey: null,    unit: "",      hC: "#00ff9d", pC: "rgba(0,255,157,0.3)" },
  { id: "cost", lbl: "Cost",  hKey: "cost",  pKey: "cost",  unit: "USD/d", hC: "#00e5ff", pC: "rgba(0,229,255,0.3)" },
];

// ── Sub-components matching project patterns ──────────────────────
function Row({ k, v, color, hi, mono }) {
  const d = v !== null && v !== undefined && String(v).trim() !== "" ? String(v) : null;
  return (
    <div className={`dp-row${hi ? " dp-row--hi" : ""}`}>
      <span className="dp-row-k">{k}</span>
      <span className={`dp-row-v${mono ? " mono" : ""}${hi ? " dp-row-v--hi" : ""}${d ? "" : " dp-row-v--null"}`}
        style={color ? { color } : {}}>
        {d || "—"}
      </span>
    </div>
  );
}

function Card({ icon, header, children }) {
  return (
    <div className="dp-info-card">
      <div className="dp-ic-header">{icon} {header}</div>
      {children}
    </div>
  );
}

function Ring({ pct, color, label, sub, size = 76 }) {
  const r = size / 2 - 9;
  const c = 2 * Math.PI * r;
  const d = c * Math.min(1, Math.max(0, pct / 100));
  return (
    <div className="fe2-ring">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="7" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="7"
          strokeLinecap="round" strokeDasharray={`${d} ${c}`} strokeDashoffset={0}
          transform={`rotate(-90 ${size/2} ${size/2})`}
          style={{ transition: "stroke-dasharray 0.8s cubic-bezier(0.4,0,0.2,1)", filter: `drop-shadow(0 0 4px ${color}66)` }} />
        <text x={size/2} y={size/2 - 3} textAnchor="middle" fill={color}
          fontSize="13" fontWeight="700" fontFamily="'Barlow Condensed',sans-serif">{label}</text>
        {sub && <text x={size/2} y={size/2 + 11} textAnchor="middle" fill="rgba(90,140,180,0.55)"
          fontSize="8" fontFamily="'JetBrains Mono',monospace">{sub}</text>}
      </svg>
    </div>
  );
}

// ── Chart component ───────────────────────────────────────────────
function FuelChart({ hist, pred, tabId }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);

  const draw = useCallback(() => {
    const cfg = CTABS.find(t => t.id === tabId);
    if (!cfg || !canvasRef.current) return;
    if (chartRef.current) { try { chartRef.current.destroy(); } catch (_) {} chartRef.current = null; }

    const hLabels  = hist.map(h => h.labelS);
    const pLabels  = pred.rows.map(p => p.labelS);
    const hData    = hist.map(h => h[cfg.hKey]);
    // Prediction series: null-gap for history, then values (overlap at boundary)
    const pData    = [
      ...new Array(hist.length - 1).fill(null),
      hData[hData.length - 1],
      ...(cfg.pKey ? pred.rows.map(p => p[cfg.pKey]) : new Array(pred.rows.length).fill(null)),
    ];

    // eslint-disable-next-line no-undef
    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: {
        labels: [...hLabels, ...pLabels],
        datasets: [
          { label: "Historical", data: hData,
            borderColor: cfg.hC, backgroundColor: cfg.hC + "15",
            borderWidth: 1.5, pointRadius: 1.5, pointHoverRadius: 4,
            fill: true, tension: 0.35 },
          { label: "Predicted", data: pData,
            borderColor: cfg.pC, backgroundColor: cfg.pC + "20",
            borderWidth: 1.5, pointRadius: 1.5, borderDash: [4, 5],
            fill: true, tension: 0.35, spanGaps: false },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 320 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#050f1c", borderColor: "rgba(0,229,255,0.18)", borderWidth: 1,
            titleColor: "#00e5ff", bodyColor: "#8ab4d0",
            titleFont: { family: "'JetBrains Mono',monospace", size: 10 },
            bodyFont:  { family: "'JetBrains Mono',monospace", size: 10 },
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toLocaleString() : "—"}${cfg.unit ? " " + cfg.unit : ""}`,
            },
          },
        },
        scales: {
          x: { ticks: { color: "rgba(90,140,180,0.45)", font: { family: "'JetBrains Mono',monospace", size: 8 }, maxTicksLimit: 14, maxRotation: 0 }, grid: { color: "rgba(0,229,255,0.04)" } },
          y: { ticks: { color: "rgba(90,140,180,0.45)", font: { family: "'JetBrains Mono',monospace", size: 8 } }, grid: { color: "rgba(0,229,255,0.05)" } },
        },
        interaction: { mode: "index", intersect: false },
      },
    });
  }, [hist, pred, tabId]);

  useEffect(() => {
    loadCJS(draw);
    return () => { if (chartRef.current) { try { chartRef.current.destroy(); } catch (_) {} chartRef.current = null; } };
  }, [draw]);

  return <div className="fe2-chart-canvas"><canvas ref={canvasRef} /></div>;
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════
export default function FuelEfficiencyPanel({ vessel }) {
  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [chartTab,   setChartTab]   = useState("fuel");
  const [predOpen,   setPredOpen]   = useState(false);
  const [hist,       setHist]       = useState([]);
  const [pred,       setPred]       = useState({ rows: [], r2: 0, conf: 0, slope: 0 });

  const imo = vessel?.imo_number;

  useEffect(() => {
    if (!imo) return;
    setLoading(true); setError(null); setData(null);
    setHist([]); setPred({ rows: [], r2: 0, conf: 0, slope: 0 });
    fetchVesselFuelEfficiency(imo)
      .then(d => {
        setData(d);
        const h = buildHistory(d);
        setHist(h);
        setPred(buildPrediction(h, d));
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [imo]);

  if (loading) return (
    <div className="fe2-state">
      <div className="fe2-spinner" />
      <span>Calculating fuel efficiency…</span>
    </div>
  );
  if (error)  return <div className="fe2-state fe2-state--err">⚠ {error}</div>;
  if (!data)  return <div className="fe2-state fe2-state--err">No efficiency data available.</div>;

  const ec      = effColor(data.efficiency_score);
  const ciiC    = CII_COLOR[data.cii_rating]  || "#607d8b";
  const sgC     = SPD_COLOR[data.speed_grade] || "#607d8b";
  const trendC  = pred.slope > 0.05 ? "#fd7272" : pred.slope < -0.05 ? "#00ff9d" : "#ffaa00";
  const trendLbl= pred.slope > 0.05 ? "↑ RISING" : pred.slope < -0.05 ? "↓ FALLING" : "→ STABLE";
  const ctab    = CTABS.find(t => t.id === chartTab);

  return (
    <div className="dp-section fe2-root">

      {/* 1 ── GAUGES ─────────────────────────────────────────────── */}
      <Card icon="⛽" header="EFFICIENCY OVERVIEW">
        <div className="fe2-gauges">
          <div className="fe2-gauge-col">
            <Ring pct={data.efficiency_score} color={ec} label={`${data.efficiency_score}%`} sub="SCORE" />
            <div className="fe2-gauge-lbl">Overall</div>
          </div>
          <div className="fe2-gauge-col">
            <Ring
              pct={{ A:100, B:80, C:60, D:40, E:20 }[data.cii_rating] || 50}
              color={ciiC} label={data.cii_rating || "—"} sub="CII" />
            <div className="fe2-gauge-lbl" style={{ color: ciiC }}>{CII_DESC[data.cii_rating] || "—"}</div>
          </div>
          <div className="fe2-gauge-col">
            <Ring
              pct={Math.min(100, (data.current_speed_kn / (data.design_speed_kn || 20)) * 100)}
              color={sgC} label={data.current_speed_kn?.toFixed(1) || "0"} sub="KN" />
            <div className="fe2-gauge-lbl" style={{ color: sgC }}>{data.speed_grade}</div>
          </div>
        </div>
        {/* CII strip */}
        <div className="fe2-cii-strip">
          {["A","B","C","D","E"].map(r => (
            <div key={r} className={`fe2-cii-seg${data.cii_rating === r ? " fe2-cii-seg--on" : ""}`}
              style={{ background: data.cii_rating === r ? CII_COLOR[r] : "rgba(255,255,255,0.04)" }}>
              <span style={{ color: data.cii_rating === r ? "#030c18" : "rgba(90,140,180,0.4)" }}>{r}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* 2 ── FUEL CONSUMPTION ───────────────────────────────────── */}
      <Card icon="🔥" header="FUEL CONSUMPTION">
        <Row k="Total consumption"     v={`${data.fuel_consumption_mt_day?.toFixed(1)} MT/day`}  color="#ffaa00" hi />
        {data.is_moving && <>
          <Row k="Main engine"         v={`${data.main_engine_fuel_mt_day?.toFixed(1)} MT/day`} />
          <Row k="Aux engines"         v={`${data.aux_engine_fuel_mt_day?.toFixed(1)} MT/day`} />
          <Row k="Design speed"        v={`${data.design_speed_kn} kn  ·  design fuel ${data.design_fuel_mt_day} MT/day`} />
          <Row k="Fuel saving vs design"
            v={data.fuel_saving_vs_design_pct >= 0 ? `${data.fuel_saving_vs_design_pct}%` : "None"}
            color={data.fuel_saving_vs_design_pct > 0 ? "#00ff9d" : "#fd7272"} />
        </>}
        <Row k="Est. fuel cost"        v={`$${data.est_fuel_cost_usd_day?.toLocaleString()} /day`} color="#e8f6ff" hi />
        <div className="fe2-bar-row">
          <span className="fe2-bar-lbl">load vs design</span>
          <div className="fe2-bar-track">
            <div className="fe2-bar-fill" style={{ width: `${Math.min(100, 100 - (data.fuel_saving_vs_design_pct || 0))}%`, background: "#ffaa00" }} />
          </div>
        </div>
      </Card>

      {/* 3 ── EMISSIONS ──────────────────────────────────────────── */}
      <Card icon="💨" header="EMISSIONS">
        <Row k="CO₂ emitted"           v={`${data.co2_emissions_mt_day?.toFixed(2)} MT/day`}   color="#fd7272" hi />
        {data.eeoi_g_co2_per_tonne_mile != null && <>
          <Row k="EEOI"                v={`${data.eeoi_g_co2_per_tonne_mile} g CO₂/t·mi`} />
          <Row k="EEOI reference"      v={`${data.eeoi_reference} g CO₂/t·mi`} />
        </>}
        {data.cii_g_co2_per_gt_nm != null && (
          <Row k="CII (g CO₂/GT·NM)"  v={data.cii_g_co2_per_gt_nm} color={ciiC} hi />
        )}
      </Card>

      {/* 4 ── POSITION CONTEXT ───────────────────────────────────── */}
      <Card icon="📍" header="POSITION CONTEXT">
        <Row k="Distance from Singapore"
          v={`${data.distance_from_singapore_nm?.toLocaleString()} NM`}
          color={data.in_singapore_zone ? "#00ff9d" : data.in_approach_zone ? "#ffaa00" : "#607d8b"}
          hi={data.in_singapore_zone || data.in_approach_zone} />
        <Row k="Zone"
          v={data.in_singapore_zone ? "IN SG ZONE" : data.in_approach_zone ? "APPROACH ZONE" : "DISTANT"} />
        {data.port_hours_so_far > 0 &&
          <Row k="Time in port" v={`${Math.round(data.port_hours_so_far)}h`}
            color={data.port_hours_so_far > 48 ? "#fd7272" : undefined} />}
        <Row k="Status" v={data.is_moving ? "Underway" : "At berth"} />
      </Card>

      {/* 5 ── HISTORY + FORECAST CHART ───────────────────────────── */}
      <Card icon="📈" header="28-DAY HISTORY + 14-DAY FORECAST">
        <div className="fe2-chart-meta">
          <div className="fe2-trend" style={{ color: trendC }}>{trendLbl}</div>
          <div className="fe2-r2">R² {pred.r2} · {pred.conf}% confidence</div>
        </div>
        <div className="fe2-chart-tabs">
          {CTABS.map(t => (
            <button key={t.id} className={`fe2-chart-tab${chartTab === t.id ? " fe2-chart-tab--on" : ""}`}
              onClick={() => setChartTab(t.id)}>{t.lbl}</button>
          ))}
        </div>
        <div className="fe2-legend">
          <span className="fe2-leg-dot" style={{ background: ctab?.hC }} />
          <span className="fe2-leg-txt">Historical</span>
          <span className="fe2-leg-dash" style={{ background: ctab?.pC }} />
          <span className="fe2-leg-txt">Predicted</span>
        </div>
        {hist.length > 0 && <FuelChart hist={hist} pred={pred} tabId={chartTab} />}
      </Card>

      {/* 6 ── PREDICTION TABLE ───────────────────────────────────── */}
      <Card icon="🤖" header="14-DAY FUEL FORECAST">
        <div className="fe2-pred-header">
          <span className="fe2-pred-sub">Linear regression · confidence decays over time</span>
          <button className="fe2-toggle" onClick={() => setPredOpen(p => !p)}>
            {predOpen ? "▲ HIDE" : "▼ SHOW"}
          </button>
        </div>
        {predOpen && (
          <div className="fe2-pred-scroll">
            <table className="fe2-pred-tbl">
              <thead>
                <tr><th>DATE</th><th>FUEL</th><th>CO₂</th><th>COST</th><th>CONF</th></tr>
              </thead>
              <tbody>
                {pred.rows.map((r, i) => {
                  const fc = r.fuel < (data.fuel_consumption_mt_day || 0) ? "#00ff9d"
                           : r.fuel > (data.fuel_consumption_mt_day || 0) * 1.1 ? "#fd7272" : "#ffaa00";
                  return (
                    <tr key={i}>
                      <td className="fe2-pt-date">{r.label}</td>
                      <td style={{ color: fc }}>{r.fuel}</td>
                      <td style={{ color: "#fd7272" }}>{r.co2}</td>
                      <td>${r.cost.toLocaleString()}</td>
                      <td>
                        <div className="fe2-cbar-wrap">
                          <div className="fe2-cbar-track">
                            <div className="fe2-cbar-fill" style={{ width: `${r.conf}%` }} />
                          </div>
                          <span className="fe2-cbar-num">{r.conf}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 7 ── DISCLAIMER ─────────────────────────────────────────── */}
      <div className="fe2-disclaimer">
        ℹ Fuel estimates use Admiralty coefficient model (speed³ law). Prediction uses 28-day linear regression.
        Actual values depend on sea state, cargo, and engine trim.
      </div>

    </div>
  );
}
