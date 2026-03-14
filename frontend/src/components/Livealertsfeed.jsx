// src/components/LiveAlertsFeed.jsx — MPA v7
import React, { useState, useCallback, useRef, useEffect } from "react";
import "./Livealertsfeed.css";

const ALERT_TEMPLATES = [
  {
    id: () => `a${Date.now()}`,
    severity: "critical",
    category: "silence",
    vessel: "PACIFIC MARINER",
    msg: "AIS signal lost — no position update for 47 minutes. Last seen Malacca Strait.",
    region: "Malacca Strait",
  },
  {
    id: () => `b${Date.now()}`,
    severity: "warning",
    category: "speed",
    vessel: "OCEAN PIONEER",
    msg: "Speed 18.4 kn inside TSS zone — exceeds 10 kn limit. Course 247°T.",
    region: "Singapore TSS",
  },
  {
    id: () => `c${Date.now()}`,
    severity: "critical",
    category: "zone",
    vessel: "SEA EMPRESS",
    msg: "Vessel entered military exclusion zone without clearance. Heading 033°T.",
    region: "South China Sea",
  },
  {
    id: () => `d${Date.now()}`,
    severity: "info",
    category: "zone",
    vessel: "GOLDEN LOTUS",
    msg: "Crossed northern boundary of Port Klang Traffic Separation Scheme.",
    region: "Port Klang",
  },
  {
    id: () => `e${Date.now()}`,
    severity: "warning",
    category: "speed",
    vessel: "BATU KAWAN",
    msg: "Anomalous speed jump — 2.1 kn to 24.7 kn in under 3 minutes. GPS spoofing suspected.",
    region: "Johor Strait",
  },
  {
    id: () => `f${Date.now()}`,
    severity: "info",
    category: "silence",
    vessel: "STAR PACIFIC",
    msg: "AIS signal reacquired after 22-minute gap. Position restored near Batam anchorage.",
    region: "Batam Waters",
  },
];

function nowSGT() {
  return new Date().toLocaleTimeString("en-SG", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Singapore",
  }) + " SGT";
}

let templateIdx = 0;

export default function LiveAlertsFeed({ isOpen, onClose, onSelectVessel, vessels = [], onAlertCountChange }) {
  const [alerts,         setAlerts]         = useState([]);
  const [filterSeverity, setFilterSeverity] = useState(null);
  const [filterCategory, setFilterCategory] = useState(null);
  const listRef = useRef(null);

  // Keep parent badge in sync whenever alerts array changes
  useEffect(() => {
    onAlertCountChange?.(alerts.length);
  }, [alerts.length, onAlertCountChange]);

  const simulate = useCallback(() => {
    const tpl = ALERT_TEMPLATES[templateIdx % ALERT_TEMPLATES.length];
    templateIdx++;
    const alert = {
      ...tpl,
      id: `${Date.now()}_${Math.random()}`,
      ts: nowSGT(),
      entering: true,
    };
    setAlerts(prev => [alert, ...prev.slice(0, 49)]);
    // Remove entering flag after animation
    setTimeout(() => {
      setAlerts(prev => prev.map(a => a.id === alert.id ? { ...a, entering: false } : a));
    }, 500);
  }, []);

  const dismiss = useCallback((id) => {
    setAlerts(prev => prev.filter(a => a.id !== id));
  }, []);

  const clearAll = useCallback(() => setAlerts([]), []);

  const filtered = alerts.filter(a => {
    if (filterSeverity && a.severity !== filterSeverity) return false;
    if (filterCategory && a.category !== filterCategory) return false;
    return true;
  });

  const counts = {
    critical: alerts.filter(a => a.severity === "critical").length,
    warning:  alerts.filter(a => a.severity === "warning").length,
    info:     alerts.filter(a => a.severity === "info").length,
  };

  if (!isOpen) return null;

  return (
    <div className="af-panel">
      {/* Header */}
      <div className="af-header">
        <div className="af-header-left">
          <div className="af-radar-dot">
            {alerts.length > 0 && <div className="af-radar-ping" />}
          </div>
          <span className="af-title">LIVE ALERTS</span>
          {alerts.length > 0 && (
            <span className="af-badge">{alerts.length}</span>
          )}
        </div>
        <div className="af-header-right">
          <button className="af-simulate-btn" onClick={simulate}>
            + SIMULATE
          </button>
          {alerts.length > 0 && (
            <button className="af-clear-btn" onClick={clearAll}>
              CLEAR ALL
            </button>
          )}
          <button className="af-close-btn" onClick={onClose}>✕</button>
        </div>
      </div>

      {/* Severity filter chips */}
      <div className="af-filters">
        <span className="af-filter-label">SEV</span>
        {[["critical","CRIT","#ff3355"],["warning","WARN","#ffaa00"],["info","INFO","#00e5ff"]].map(
          ([sev, label, col]) => (
            <button
              key={sev}
              className={`af-chip af-chip-${sev}${filterSeverity === sev ? " af-chip-active" : ""}`}
              style={filterSeverity === sev ? { background: col + "22", borderColor: col, color: col } : {}}
              onClick={() => setFilterSeverity(p => p === sev ? null : sev)}
            >
              {counts[sev] > 0 && <span className="af-chip-dot" style={{ background: col }} />}
              {label}
              {counts[sev] > 0 && <span className="af-chip-cnt">{counts[sev]}</span>}
            </button>
          )
        )}
        <span className="af-filter-sep" />
        <span className="af-filter-label">CAT</span>
        {[["silence","SILENCE"],["speed","SPEED"],["zone","ZONE"]].map(([cat, label]) => (
          <button
            key={cat}
            className={`af-chip${filterCategory === cat ? " af-chip-active-cat" : ""}`}
            onClick={() => setFilterCategory(p => p === cat ? null : cat)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Feed */}
      <div className="af-feed" ref={listRef}>
        {filtered.length === 0 && (
          <div className="af-empty">
            <div className="af-empty-icon">📡</div>
            <div className="af-empty-msg">
              {alerts.length === 0 ? "No active alerts — monitoring all vessels" : "No alerts match current filter"}
            </div>
            <button className="af-empty-sim" onClick={simulate}>Simulate alert</button>
          </div>
        )}
        {filtered.map(alert => (
          <AlertCard
            key={alert.id}
            alert={alert}
            onDismiss={dismiss}
            onSelectVessel={onSelectVessel}
            vessels={vessels}
          />
        ))}
      </div>
    </div>
  );
}

function AlertCard({ alert, onDismiss, onSelectVessel, vessels }) {
  const SEV_MAP = {
    critical: { col: "#ff3355", bg: "rgba(255,51,85,0.07)", pulse: true,  icon: "🚨" },
    warning:  { col: "#ffaa00", bg: "rgba(255,170,0,0.07)", pulse: false, icon: "⚠️" },
    info:     { col: "#00e5ff", bg: "rgba(0,229,255,0.06)", pulse: false, icon: "ℹ️" },
  };
  const { col, bg, pulse, icon } = SEV_MAP[alert.severity] || SEV_MAP.info;
  const vessel = vessels.find(v => (v.vessel_name||"").toUpperCase() === alert.vessel.toUpperCase());

  return (
    <div
      className={`af-card af-card-${alert.severity}${alert.entering ? " af-card-enter" : ""}`}
      style={{ background: bg, borderLeftColor: col }}
    >
      <div className="af-card-top">
        <div className="af-card-left">
          <div className="af-sev-dot-wrap">
            <span className="af-sev-dot" style={{ background: col }} />
            {pulse && <span className="af-sev-pulse" style={{ background: col }} />}
          </div>
          <span className="af-sev-icon">{icon}</span>
          <span
            className="af-card-vessel"
            style={{ color: vessel ? col : "#8ab4d0" }}
            onClick={() => vessel && onSelectVessel?.(vessel)}
            title={vessel ? "Select on map" : ""}
          >
            {alert.vessel}
          </span>
        </div>
        <div className="af-card-right">
          <span className="af-ts">{alert.ts}</span>
          <button className="af-dismiss" onClick={() => onDismiss(alert.id)}>✕</button>
        </div>
      </div>
      <div className="af-card-msg">{alert.msg}</div>
      <div className="af-card-footer">
        <span className={`af-cat-badge af-cat-${alert.category}`}>
          {alert.category.toUpperCase()}
        </span>
        <span className="af-region">📍 {alert.region}</span>
      </div>
    </div>
  );
}