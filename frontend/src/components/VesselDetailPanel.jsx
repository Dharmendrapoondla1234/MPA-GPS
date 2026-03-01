// src/components/VesselDetailPanel.jsx
// FIXED: reads EXACT backend field names:
// mmsi_number, vessel_length, vessel_breadth, call_sign

import React, { useState, useEffect, useCallback } from "react";
import {
  getVesselStatus,
  getSpeedColor,
  formatTimestamp,
  getFlagEmoji,
  getVesselTypeLabel,
  getCountryName,
  calcDistanceNM,
} from "../utils/vesselUtils";
import { fetchVesselHistory } from "../services/api";
import "./VesselDetailPanel.css";

const TABS = ["VESSEL", "VOYAGE", "MISSION", "TRAIL"];

export default function VesselDetailPanel({ vessel, onClose, onShowTrail }) {
  // ── ALL HOOKS FIRST (Rules of Hooks — never after early return) ──
  const [tab, setTab] = useState("VESSEL");
  const [hours, setHours] = useState(24);
  const [trailOn, setTrailOn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    setTab("VESSEL");
    setTrailOn(false);
    setStats(null);
    onShowTrail?.(null);
  }, [vessel?.imo_number]); // eslint-disable-line

  const loadTrail = useCallback(
    async (h) => {
      const imo = vessel?.imo_number;
      if (!imo) return;
      setLoading(true);
      try {
        const hist = await fetchVesselHistory(imo, h);
        setTrailOn(true);
        onShowTrail?.(hist);
        if (hist?.length > 1) {
          let dist = 0;
          const spds = [];
          hist.forEach((p) => {
            const s = parseFloat(p.speed ?? 0);
            if (s > 0) spds.push(s);
          });
          for (let i = 1; i < hist.length; i++) {
            const la1 = Number(hist[i - 1].latitude_degrees ?? 0);
            const lo1 = Number(hist[i - 1].longitude_degrees ?? 0);
            const la2 = Number(hist[i].latitude_degrees ?? 0);
            const lo2 = Number(hist[i].longitude_degrees ?? 0);
            if (la1 && lo1 && la2 && lo2)
              dist += calcDistanceNM(la1, lo1, la2, lo2);
          }
          setStats({
            pts: hist.length,
            dist: dist.toFixed(1),
            avg: spds.length
              ? (spds.reduce((a, b) => a + b, 0) / spds.length).toFixed(1)
              : "—",
            max: spds.length ? Math.max(...spds).toFixed(1) : "—",
            from: formatTimestamp(hist[0]?.effective_timestamp),
            to: formatTimestamp(hist[hist.length - 1]?.effective_timestamp),
          });
        }
      } catch (e) {
        console.error("Trail error:", e);
      } finally {
        setLoading(false);
      }
    },
    [vessel?.imo_number, onShowTrail] // eslint-disable-line
  );

  // ── Safe early return AFTER all hooks ──
  if (!vessel) return null;

  // ── EXACT field names from backend vessels.js ──────────────
  const name = vessel.vessel_name || "Unknown Vessel";
  const imoNum = vessel.imo_number;
  const mmsi = vessel.mmsi_number;          // ← mmsi_NUMBER (not mmsi)
  const callSign = vessel.call_sign;         // ← call_SIGN
  const vtype = vessel.vessel_type;
  const flag = vessel.flag;
  const speed = parseFloat(vessel.speed || 0);
  const heading = parseFloat(vessel.heading || 0);
  const course = parseFloat(vessel.course || 0) || null;
  const lat = parseFloat(vessel.latitude_degrees || 0);
  const lng = parseFloat(vessel.longitude_degrees || 0);
  const ts = vessel.effective_timestamp;
  const lenOA = vessel.vessel_length ? Number(vessel.vessel_length) : null;   // ← vessel_LENGTH
  const beam = vessel.vessel_breadth ? Number(vessel.vessel_breadth) : null;  // ← vessel_BREADTH
  const grossT = vessel.gross_tonnage ? Number(vessel.gross_tonnage) : null;
  const dw = vessel.deadweight ? Number(vessel.deadweight) : null;
  const built = vessel.year_built && Number(vessel.year_built) > 0 ? String(vessel.year_built) : null;

  const status = getVesselStatus(speed);
  const color = getSpeedColor(speed);
  const pct = Math.min((speed / 25) * 100, 100);
  const flagE = getFlagEmoji(flag);

  function hideTrail() { setTrailOn(false); setStats(null); onShowTrail?.(null); }
  function handleHoursChange(h) { setHours(h); if (trailOn) loadTrail(h); }
  function toggleTrail() { trailOn ? hideTrail() : loadTrail(hours); }

  return (
    <div className="dp-root">
      {/* HEADER */}
      <div className="dp-head">
        <span className="dp-flag">{flagE}</span>
        <div className="dp-head-info">
          <div className="dp-name">{name}</div>
          <div className="dp-sub mono">
            IMO {imoNum || "—"} · MMSI {mmsi || "—"}
          </div>
          {vtype && <span className="dp-badge">{getVesselTypeLabel(vtype)}</span>}
        </div>
        <button className="dp-close" onClick={onClose}>✕</button>
      </div>

      {/* STATUS BAR */}
      <div className="dp-status-bar" style={{ background: `${color}14`, borderColor: `${color}30` }}>
        <span className="dp-sdot" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
        <span className="dp-slabel" style={{ color }}>{status.icon} {status.label}</span>
      </div>

      {/* SPEED HERO */}
      <div className="dp-hero">
        <div>
          <div className="dp-speed-num" style={{ color }}>{speed.toFixed(1)}</div>
          <div className="dp-speed-unit">knots</div>
          <div className="dp-speed-km" style={{ color: `${color}cc` }}>{(speed * 1.852).toFixed(1)} km/h</div>
        </div>
        <svg width="84" height="84" viewBox="0 0 84 84">
          <circle cx="42" cy="42" r="34" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="6" />
          <circle cx="42" cy="42" r="34" fill="none" stroke={color} strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * 34}`}
            strokeDashoffset={`${2 * Math.PI * 34 * (1 - pct / 100)}`}
            transform="rotate(-90 42 42)"
            style={{ filter: `drop-shadow(0 0 5px ${color})`, transition: "stroke-dashoffset 1s ease" }}
          />
          <text x="42" y="46" textAnchor="middle" fill={color} fontSize="10"
            fontFamily="'JetBrains Mono',monospace" fontWeight="700">{pct.toFixed(0)}%</text>
        </svg>
        <div className="dp-metrics">
          <M label="HEADING" v={`${heading}°`} />
          <M label="LAT" v={lat ? `${lat.toFixed(4)}°` : "—"} mono />
          <M label="LON" v={lng ? `${lng.toFixed(4)}°` : "—"} mono />
        </div>
      </div>

      {/* TRAIL QUICK BAR */}
      <div className="dp-trailbar">
        <span className="dp-tl">TRAIL</span>
        <div className="dp-th-btns">
          {[6, 12, 24, 48, 72].map((h) => (
            <button key={h} className={`dp-th ${hours === h ? "active" : ""}`}
              onClick={() => handleHoursChange(h)}>{h}h</button>
          ))}
        </div>
        <button className={`dp-ts-btn ${trailOn ? "on" : ""}`} onClick={toggleTrail} disabled={loading}>
          {loading ? <><span className="dp-spin" />…</> : trailOn ? "✕ HIDE" : "▶ SHOW"}
        </button>
      </div>

      {stats && (
        <div className="dp-trail-strip">
          <span>📍 {stats.pts} pts</span>
          <span>⛵ {stats.dist} NM</span>
          <span>avg {stats.avg} kn</span>
          <span>max {stats.max} kn</span>
        </div>
      )}

      {/* TABS */}
      <div className="dp-tabs">
        {TABS.map((t) => (
          <button key={t} className={`dp-tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {/* TAB BODY */}
      <div className="dp-body">
        {tab === "VESSEL" && (
          <div className="dp-section">
            <SH>IDENTIFICATION</SH>
            <R k="Vessel Name" v={name} />
            <R k="IMO Number" v={imoNum} mono />
            <R k="MMSI" v={mmsi} mono />
            <R k="Call Sign" v={callSign} mono />
            <R k="Vessel Type" v={getVesselTypeLabel(vtype)} />
            <R k="Flag / Country" v={flag ? `${flagE} ${getCountryName(flag)} (${flag})` : null} />

            <SH>DIMENSIONS</SH>
            <R k="Length Overall" v={lenOA ? `${lenOA} m` : null} />
            <R k="Beam / Breadth" v={beam ? `${beam} m` : null} />
            <R k="Gross Tonnage" v={grossT ? `${grossT.toLocaleString()} GT` : null} />
            <R k="Dead Weight" v={dw ? `${dw.toLocaleString()} DWT` : null} hi />
            <R k="Year Built" v={built} />

            <SH>POSITION</SH>
            <R k="Latitude" v={lat ? `${lat.toFixed(6)}°` : null} mono />
            <R k="Longitude" v={lng ? `${lng.toFixed(6)}°` : null} mono />
            <R k="Heading" v={`${heading}°`} />
            <R k="Course (COG)" v={course ? `${course.toFixed(1)}°` : null} />
            <R k="Last Update" v={formatTimestamp(ts)} />
          </div>
        )}

        {tab === "VOYAGE" && (
          <div className="dp-section">
            <SH>CURRENT POSITION</SH>
            <R k="Latitude" v={lat ? `${lat.toFixed(6)}°` : null} mono />
            <R k="Longitude" v={lng ? `${lng.toFixed(6)}°` : null} mono />
            <R k="Heading" v={`${heading}°`} />
            <R k="Course (COG)" v={course ? `${course.toFixed(1)}°` : null} />
            <R k="Speed (SOG)" v={`${speed.toFixed(2)} kn`} />
            <R k="Last Update" v={formatTimestamp(ts)} />

            {stats && (
              <>
                <SH>ROUTE STATISTICS</SH>
                <R k="Total Distance" v={`${stats.dist} NM`} hi />
                <R k="Avg Speed" v={`${stats.avg} kn`} />
                <R k="Max Speed" v={`${stats.max} kn`} />
                <R k="Track Points" v={stats.pts} />
                <R k="Track Start" v={stats.from} mono />
                <R k="Track End" v={stats.to} mono />
              </>
            )}
          </div>
        )}

        {tab === "MISSION" && (
          <div className="dp-section">
            <SH>OPERATIONAL STATUS</SH>
            <div className="dp-op-card" style={{ borderColor: `${color}35`, background: `${color}0a` }}>
              <span className="dp-op-icon">{status.icon}</span>
              <div>
                <div className="dp-op-title" style={{ color }}>{status.label}</div>
                <div className="dp-op-sub">
                  {speed.toFixed(2)} kn · {(speed * 1.852).toFixed(2)} km/h
                  {heading ? ` · HDG ${heading}°` : ""}
                </div>
              </div>
            </div>

            <SH>CAPACITY</SH>
            <div className="dp-cap-grid">
              {[
                ["DWT", dw ? dw.toLocaleString() : "N/A", "Dead Weight Tons"],
                ["GT", grossT ? grossT.toLocaleString() : "N/A", "Gross Tonnage"],
                ["LOA", lenOA ? `${lenOA}m` : "N/A", "Length Overall"],
                ["BM", beam ? `${beam}m` : "N/A", "Beam/Breadth"],
              ].map(([code, val, desc]) => (
                <div key={code} className="dp-cap-card">
                  <div className="dp-cap-code">{code}</div>
                  <div className="dp-cap-val mono">{val}</div>
                  <div className="dp-cap-desc">{desc}</div>
                </div>
              ))}
            </div>

            <SH>VESSEL DATA</SH>
            <R k="Dead Weight" v={dw ? `${dw.toLocaleString()} DWT` : null} hi />
            <R k="Gross Tonnage" v={grossT ? `${grossT.toLocaleString()} GT` : null} />
            <R k="Vessel Type" v={getVesselTypeLabel(vtype)} />
            <R k="Year Built" v={built} />
            <R k="Flag / Country" v={flag ? `${flagE} ${getCountryName(flag)}` : null} />
          </div>
        )}

        {tab === "TRAIL" && (
          <div className="dp-section">
            <SH>TRACK CONTROLS</SH>
            <div className="dp-tr-ctrl">
              <div className="dp-tr-hours">
                {[6, 12, 24, 48, 72].map((h) => (
                  <button key={h} className={`dp-tr-h ${hours === h ? "on" : ""}`}
                    onClick={() => handleHoursChange(h)}>{h}h</button>
                ))}
              </div>
              <button className={`dp-tr-btn ${trailOn ? "hide" : ""}`} onClick={toggleTrail} disabled={loading}>
                {loading ? <><span className="dp-spin" />Loading {hours}h trail…</>
                  : trailOn ? <>📍 Hide Trail</>
                  : <>📍 Show {hours}h Trail on Map</>}
              </button>
            </div>

            {stats && (
              <>
                <SH>JOURNEY STATS</SH>
                <div className="dp-stat-grid">
                  {[
                    ["📍", "Track Points", `${stats.pts}`],
                    ["🌊", "Distance", `${stats.dist} NM`],
                    ["⚡", "Avg Speed", `${stats.avg} kn`],
                    ["🚀", "Max Speed", `${stats.max} kn`],
                  ].map(([icon, k, val]) => (
                    <div key={k} className="dp-stat-card">
                      <div className="dp-stat-icon">{icon}</div>
                      <div className="dp-stat-val mono">{val}</div>
                      <div className="dp-stat-key">{k}</div>
                    </div>
                  ))}
                </div>
                {stats.from && <R k="Track Start" v={stats.from} mono />}
                {stats.to && <R k="Track End" v={stats.to} mono />}
              </>
            )}

            <SH>CURRENT POSITION</SH>
            <R k="Latitude" v={lat ? `${lat.toFixed(6)}°` : null} mono />
            <R k="Longitude" v={lng ? `${lng.toFixed(6)}°` : null} mono />
            <R k="Last Update" v={formatTimestamp(ts)} />
          </div>
        )}
      </div>
    </div>
  );
}

function SH({ children }) {
  return (
    <div className="dp-sh">
      <div className="dp-sh-line" /><span>{children}</span><div className="dp-sh-line" />
    </div>
  );
}

function R({ k, v, mono, hi }) {
  const display = v !== null && v !== undefined && String(v).trim() !== "" ? String(v) : null;
  return (
    <div className={`dp-row ${hi ? "dp-hi" : ""}`}>
      <span className="dp-rk">{k}</span>
      <span className={`dp-rv ${mono ? "mono" : ""} ${hi ? "dp-rv-hi" : ""} ${!display ? "dp-rv-null" : ""}`}>
        {display || "—"}
      </span>
    </div>
  );
}

function M({ label, v, mono }) {
  return (
    <div className="dp-metric">
      <div className={`dp-mv ${mono ? "mono" : ""}`}>{v}</div>
      <div className="dp-ml">{label}</div>
    </div>
  );
}
