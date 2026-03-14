// src/components/VesselComparison.jsx — MPA v7
import React, { useState, useCallback  } from "react";
import { getSpeedColor, getFlagEmoji  } from "../utils/vesselUtils";
import "./Vesselcomparison.css";

const MAX_VESSELS = 4;
const MAX_SPEED   = 25; // kn — bar scale ceiling

function typeShort(raw) {
  const t = (raw || "").toLowerCase();
  if (t.includes("tanker"))    return "TANKER";
  if (t.includes("container")) return "CNTNR";
  if (t.includes("bulk"))      return "BULK";
  if (t.includes("gas"))       return "GAS";
  if (t.includes("cargo"))     return "CARGO";
  if (t.includes("passenger")) return "PASS";
  if (t.includes("tug"))       return "TUG";
  if (t.includes("fishing"))   return "FISH";
  return (raw || "GEN").substring(0, 5).toUpperCase();
}

function speedBand(kn) {
  const s = parseFloat(kn) || 0;
  if (s < 2)  return { label: "ANCHORED", cls: "band-anchor" };
  if (s < 8)  return { label: "SLOW",     cls: "band-slow"   };
  if (s < 15) return { label: "CRUISING", cls: "band-cruise" };
  return              { label: "FAST",     cls: "band-fast"   };
}

export default function VesselComparison({ vessels = [], onSelectVessel, isOpen, onClose }) {
  const [pinned,       setPinned]       = useState([]);   // array of vessel objects
  const [highlightDiff, setHighlightDiff] = useState(false);
  const [sortBySpeed,  setSortBySpeed]  = useState(false);
  const [pickerOpen,   setPickerOpen]   = useState(false);
  const [pickerQuery,  setPickerQuery]  = useState("");

  const add = useCallback((v) => {
    setPinned(prev => {
      if (prev.length >= MAX_VESSELS) return prev;
      if (prev.find(p => p.imo_number === v.imo_number)) return prev;
      return [...prev, v];
    });
    setPickerOpen(false);
    setPickerQuery("");
  }, []);

  const remove = useCallback((imo) => {
    setPinned(prev => prev.filter(p => p.imo_number !== imo));
  }, []);

  if (!isOpen) return null;

  const displayed = sortBySpeed
    ? [...pinned].sort((a, b) => (parseFloat(b.speed) || 0) - (parseFloat(a.speed) || 0))
    : pinned;

  // Compute highlight targets
  const maxSpeedImo   = highlightDiff && pinned.length > 1
    ? pinned.reduce((best, v) => (parseFloat(v.speed)||0) > (parseFloat(best.speed)||0) ? v : best, pinned[0])?.imo_number
    : null;
  const maxDraughtImo = highlightDiff && pinned.length > 1
    ? pinned.reduce((best, v) => (parseFloat(v.draught)||0) > (parseFloat(best.draught)||0) ? v : best, pinned[0])?.imo_number
    : null;

  // Picker filtered list
  const available = vessels
    .filter(v => !pinned.find(p => p.imo_number === v.imo_number))
    .filter(v => {
      if (!pickerQuery) return true;
      const q = pickerQuery.toLowerCase();
      return (v.vessel_name||"").toLowerCase().includes(q)
          || String(v.imo_number||"").includes(q);
    })
    .slice(0, 40);

  return (
    <div className="vc-panel">
      {/* Header */}
      <div className="vc-header">
        <div className="vc-header-left">
          <div className="vc-sonar">
            <div className="vc-sonar-sweep" />
          </div>
          <span className="vc-title">VESSEL COMPARISON</span>
          <span className="vc-count">{pinned.length}/{MAX_VESSELS}</span>
        </div>
        <div className="vc-header-actions">
          <button
            className={`vc-toggle-btn${highlightDiff ? " active" : ""}`}
            onClick={() => setHighlightDiff(p => !p)}
            title="Highlight outliers"
          >
            DIFF
          </button>
          <button
            className={`vc-toggle-btn${sortBySpeed ? " active" : ""}`}
            onClick={() => setSortBySpeed(p => !p)}
            title="Sort by speed"
          >
            ↓ SPD
          </button>
          <button className="vc-close-btn" onClick={onClose}>✕</button>
        </div>
      </div>

      {/* Cards row */}
      <div className="vc-cards">
        {displayed.map(v => {
          const spd      = parseFloat(v.speed) || 0;
          const pct      = Math.min(spd / MAX_SPEED, 1);
          const col      = getSpeedColor(spd);
          const band     = speedBand(spd);
          const isSpd    = v.imo_number === maxSpeedImo;
          const isDrg    = v.imo_number === maxDraughtImo;
          const stale    = (v.minutes_since_last_ping || 0) > 30;
          return (
            <div
              key={v.imo_number}
              className={`vc-card${isSpd || isDrg ? " vc-card-highlight" : ""}`}
            >
              {/* Card top */}
              <div className="vc-card-top">
                <div className="vc-flag">{getFlagEmoji(v.flag)}</div>
                <div className="vc-identity">
                  <div
                    className="vc-name"
                    onClick={() => onSelectVessel?.(v)}
                    title="Select on map"
                  >
                    {v.vessel_name || "UNKNOWN"}
                  </div>
                  <div className="vc-imo">IMO {v.imo_number}</div>
                </div>
                <div className={`vc-type-badge vc-type-${typeShort(v.vessel_type).toLowerCase().replace(/[^a-z]/g,"")}`}>
                  {typeShort(v.vessel_type)}
                </div>
              </div>

              {/* Speed bar */}
              <div className="vc-speed-section">
                <div className="vc-speed-top">
                  <span className="vc-speed-val" style={{ color: col }}>
                    {spd.toFixed(1)}<span className="vc-speed-unit"> kn</span>
                  </span>
                  <span className={`vc-band ${band.cls}`}>{band.label}</span>
                </div>
                <div className="vc-bar-track">
                  <div
                    className={`vc-bar-fill ${band.cls}`}
                    style={{ width: `${pct * 100}%`, background: col }}
                  />
                </div>
              </div>

              {/* Stats */}
              <div className="vc-stats">
                {[
                  ["CRS",  `${v.course  || v.heading || 0}°T`],
                  ["DRT",  v.draught    ? `${v.draught}m`  : "—"],
                  ["LOA",  v.length     ? `${v.length}m`   : "—"],
                  ["PING", stale
                    ? <span className="vc-stale">{v.minutes_since_last_ping}m</span>
                    : `${v.minutes_since_last_ping || 0}m`
                  ],
                  ["DEST", (v.destination || "—").substring(0, 9)],
                  ["ETA",  v.eta ? String(v.eta).substring(0, 8) : "—"],
                ].map(([k, val]) => (
                  <div key={k} className="vc-stat-row">
                    <span className="vc-stat-k">{k}</span>
                    <span className="vc-stat-v">{val}</span>
                  </div>
                ))}
              </div>

              {/* Diff badges */}
              {isSpd && <div className="vc-diff-badge vc-diff-speed">▲ FASTEST</div>}
              {isDrg && !isSpd && <div className="vc-diff-badge vc-diff-draught">▼ DEEPEST</div>}

              {/* Remove row */}
              <button className="vc-remove" onClick={() => remove(v.imo_number)}>
                ✕ REMOVE
              </button>
            </div>
          );
        })}

        {/* Add slot */}
        {pinned.length < MAX_VESSELS && (
          <div className="vc-add-slot">
            {pickerOpen ? (
              <div className="vc-picker">
                <input
                  autoFocus
                  className="vc-picker-input"
                  placeholder="Search vessel…"
                  value={pickerQuery}
                  onChange={e => setPickerQuery(e.target.value)}
                />
                <div className="vc-picker-list">
                  {available.length === 0 && (
                    <div className="vc-picker-empty">No vessels found</div>
                  )}
                  {available.map(v => (
                    <div key={v.imo_number} className="vc-picker-item" onClick={() => add(v)}>
                      <span className="vc-picker-flag">{getFlagEmoji(v.flag)}</span>
                      <div>
                        <div className="vc-picker-name">{v.vessel_name}</div>
                        <div className="vc-picker-meta">
                          IMO {v.imo_number} · {(parseFloat(v.speed)||0).toFixed(1)} kn
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <button className="vc-picker-cancel" onClick={() => { setPickerOpen(false); setPickerQuery(""); }}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="vc-add-btn" onClick={() => setPickerOpen(true)}>
                <span className="vc-add-plus">+</span>
                <span>ADD VESSEL</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="vc-legend">
        {[
          ["ANCHORED", "< 2 kn",  "#90a4ae"],
          ["SLOW",     "2–8 kn",  "#26de81"],
          ["CRUISING", "8–15 kn", "#fd9644"],
          ["FAST",     "> 15 kn", "#fc5c65"],
        ].map(([label, range, col]) => (
          <div key={label} className="vc-legend-item">
            <span className="vc-legend-dot" style={{ background: col }} />
            <span className="vc-legend-label">{label}</span>
            <span className="vc-legend-range">{range}</span>
          </div>
        ))}
      </div>
    </div>
  );
}