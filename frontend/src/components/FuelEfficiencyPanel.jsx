// src/components/FuelEfficiencyPanel.jsx
// Fuel Efficiency + CII + Carbon Intensity panel for vessel detail.
// Fetches from /api/fuel/vessel/:imo — no Claude API needed.
import React, { useState, useEffect } from "react";
import "./FuelEfficiencyPanel.css";

const BASE_URL = process.env.REACT_APP_API_URL || "https://maritime-connect.onrender.com/api";

// ── CII colour map ─────────────────────────────────────────────────
const CII_COLORS = { A: "#26de81", B: "#a3e635", C: "#ffaa00", D: "#fd7272", E: "#ff2244" };
const CII_LABELS = {
  A: "Major improvement",
  B: "Minor improvement",
  C: "Moderate — IMO target",
  D: "Below standard",
  E: "Significantly below",
};
const SPEED_GRADE_COLOR = {
  "berthed": "#546e7a",
  "slow": "#fd7272",
  "below-optimal": "#ffaa00",
  "optimal": "#26de81",
  "high": "#ffaa00",
  "excessive": "#ff2244",
};

function Ring({ pct, color, label, sub, size = 80 }) {
  const r = (size / 2) - 8;
  const circ = 2 * Math.PI * r;
  const dash = circ * (pct / 100);
  return (
    <div className="fe-ring-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="8"/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          strokeDashoffset={0}
          transform={`rotate(-90 ${size/2} ${size/2})`}
          style={{ transition: "stroke-dasharray 0.8s ease", filter: `drop-shadow(0 0 6px ${color}88)` }}
        />
        <text x={size/2} y={size/2 - 4} textAnchor="middle" fill={color} fontSize="14" fontWeight="700">{label}</text>
        {sub && <text x={size/2} y={size/2 + 12} textAnchor="middle" fill="#607d8b" fontSize="9">{sub}</text>}
      </svg>
    </div>
  );
}

function StatRow({ icon, label, value, unit, color, sub }) {
  return (
    <div className="fe-stat-row">
      <span className="fe-stat-icon">{icon}</span>
      <span className="fe-stat-label">{label}</span>
      <span className="fe-stat-value" style={{ color: color || "#e8f6ff" }}>
        {value} {unit && <span className="fe-stat-unit">{unit}</span>}
      </span>
      {sub && <span className="fe-stat-sub">{sub}</span>}
    </div>
  );
}

export default function FuelEfficiencyPanel({ vessel }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const imo = vessel?.imo_number;

  useEffect(() => {
    if (!imo) return;
    setLoading(true); setError(null); setData(null);
    fetch(`${BASE_URL}/fuel/vessel/${imo}`)
      .then(r => r.json())
      .then(j => { setData(j?.data || null); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [imo]);

  if (loading) return (
    <div className="fe-loading">
      <div className="fe-spinner"/>
      <span>Calculating fuel efficiency…</span>
    </div>
  );
  if (error) return <div className="fe-error">⚠ {error}</div>;
  if (!data)  return <div className="fe-error">No efficiency data available.</div>;

  const effColor  = data.efficiency_score >= 80 ? "#26de81" : data.efficiency_score >= 60 ? "#a3e635" : data.efficiency_score >= 40 ? "#ffaa00" : "#fd7272";
  const ciiColor  = CII_COLORS[data.cii_rating] || "#607d8b";
  const speedGradeColor = SPEED_GRADE_COLOR[data.speed_grade] || "#607d8b";

  return (
    <div className="fe-panel">
      {/* Top gauges */}
      <div className="fe-gauges">
        <div className="fe-gauge-card">
          <Ring pct={data.efficiency_score} color={effColor} label={`${data.efficiency_score}%`} sub="Efficiency" />
          <div className="fe-gauge-label">Overall Score</div>
        </div>
        <div className="fe-gauge-card">
          <Ring pct={data.cii_rating === "A" ? 100 : data.cii_rating === "B" ? 80 : data.cii_rating === "C" ? 60 : data.cii_rating === "D" ? 40 : 20}
            color={ciiColor} label={data.cii_rating || "—"} sub="CII" />
          <div className="fe-gauge-label" style={{ color: ciiColor }}>
            {CII_LABELS[data.cii_rating] || "Not available"}
          </div>
        </div>
        <div className="fe-gauge-card">
          <Ring pct={Math.min(100, (data.current_speed_kn / (data.design_speed_kn || 20)) * 100)}
            color={speedGradeColor}
            label={`${data.current_speed_kn?.toFixed(1) || "0"}`}
            sub="kn" />
          <div className="fe-gauge-label" style={{ color: speedGradeColor }}>
            Speed: {data.speed_grade}
          </div>
        </div>
      </div>

      {/* Fuel consumption section */}
      <div className="fe-section">
        <div className="fe-section-title">⛽ Fuel Consumption</div>
        <StatRow icon="🔥" label="Total consumption" value={data.fuel_consumption_mt_day?.toFixed(1)} unit="MT/day" color="#ffaa00"/>
        {data.is_moving && <>
          <StatRow icon="⚙️" label="Main engine"  value={data.main_engine_fuel_mt_day?.toFixed(1)} unit="MT/day"/>
          <StatRow icon="🔌" label="Aux engines"  value={data.aux_engine_fuel_mt_day?.toFixed(1)} unit="MT/day"/>
          <StatRow icon="📐" label="Design speed" value={data.design_speed_kn} unit="kn" sub={`design: ${data.design_fuel_mt_day} MT/day`}/>
          <StatRow icon="💹" label="Fuel saving vs design"
            value={data.fuel_saving_vs_design_pct >= 0 ? `${data.fuel_saving_vs_design_pct}%` : "None"}
            color={data.fuel_saving_vs_design_pct > 0 ? "#26de81" : "#fd7272"}/>
        </>}
        <StatRow icon="💲" label="Est. fuel cost" value={`$${data.est_fuel_cost_usd_day?.toLocaleString()}`} unit="/day" color="#e8f6ff"/>
      </div>

      {/* Emissions section */}
      <div className="fe-section">
        <div className="fe-section-title">💨 Emissions</div>
        <StatRow icon="🌫️" label="CO₂ emitted"   value={data.co2_emissions_mt_day?.toFixed(2)} unit="MT/day" color="#fd7272"/>
        {data.eeoi_g_co2_per_tonne_mile != null && <>
          <StatRow icon="📊" label="EEOI" value={data.eeoi_g_co2_per_tonne_mile} unit="g CO₂/t·mi"
            sub={`reference: ${data.eeoi_reference} g CO₂/t·mi`}/>
          <StatRow icon="🎯" label="CII (g CO₂/GT·NM)" value={data.cii_g_co2_per_gt_nm} unit=""
            color={ciiColor}/>
        </>}
      </div>

      {/* Geo info */}
      <div className="fe-section">
        <div className="fe-section-title">📍 Position Context</div>
        <StatRow icon="🇸🇬" label="Distance from Singapore"
          value={`${data.distance_from_singapore_nm?.toLocaleString()} NM`}
          color={data.in_singapore_zone ? "#26de81" : data.in_approach_zone ? "#ffaa00" : "#607d8b"}
          sub={data.in_singapore_zone ? "In SG zone" : data.in_approach_zone ? "Approach zone" : "Distant"}/>
        {data.port_hours_so_far > 0 && (
          <StatRow icon="⏱️" label="Time in port" value={`${Math.round(data.port_hours_so_far)}h`}
            color={data.port_hours_so_far > 48 ? "#fd7272" : "#607d8b"}/>
        )}
      </div>

      <div className="fe-disclaimer">
        ℹ Fuel estimates use Admiralty coefficient model. Actual consumption depends on sea state, cargo load, and engine trim.
      </div>
    </div>
  );
}
