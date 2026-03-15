// src/components/TopBar.jsx — MPA Advanced v6
import React, { useState, useEffect, useRef } from "react";
import { useCountdown } from "../hooks/useCountdown";
import { logoutUser } from "../services/api";
import "./TopBar.css";

export default function TopBar({
  filters, onFiltersChange, vesselTypes, stats,
  nextRefresh, loading, onRefresh, panelOpen, onTogglePanel,
  user, onLogout, onSearchEnter, lastUpdated,
  portPanelOpen, onTogglePortPanel,
  compareOpen, onToggleCompare,
  alertsOpen,  onToggleAlerts,  alertCount,
  heatmapOpen, onToggleHeatmap,
  prefsOpen,   onTogglePrefs,
}) {
  const countdown = useCountdown(nextRefresh);
  const [menuOpen, setMenuOpen] = useState(false);

  const [dataAge, setDataAge] = React.useState(null);
  React.useEffect(() => {
    if (!lastUpdated) { setDataAge(null); return; }
    const tick = () => {
      const diffMs = Date.now() - new Date(lastUpdated).getTime();
      const diffMin = Math.floor(diffMs / 60000);
      const diffSec = Math.floor((diffMs % 60000) / 1000);
      if (diffMin === 0) setDataAge(`${diffSec}s`);
      else if (diffMin < 60) setDataAge(`${diffMin}m ${diffSec}s`);
      else setDataAge(`${Math.floor(diffMin/60)}h ${diffMin%60}m`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  const wrapRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    function outside(e) { if (wrapRef.current&&!wrapRef.current.contains(e.target)) setMenuOpen(false); }
    document.addEventListener("mousedown", outside);
    document.addEventListener("touchstart", outside, { passive:true });
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("touchstart", outside); };
  }, [menuOpen]);

  function handleLogout() { logoutUser(); onLogout(); setMenuOpen(false); }
  function handleAvatarClick(e) { e.stopPropagation(); setMenuOpen(o=>!o); }

  return (
    <header className="topbar">

      {/* ── ROW 1: Logo + Stats + Live status ── */}
      <div className="tb-row tb-row-top">
        {/* Logo */}
        <div className="tb-logo">
          <div className="tb-sonar">
            <div className="tb-sonar-ring"/>
            <div className="tb-sonar-ring" style={{animationDelay:"0.6s"}}/>
            <span className="tb-sonar-dot"/>
          </div>
          <div>
            <div className="tb-logo-text">MARINE<span>TRACK</span></div>
            <div className="tb-logo-sub">LIVE AIS · BIGQUERY · DBT</div>
          </div>
        </div>

        {/* Type filter */}
        <div className="tb-filter-group">
          <label className="tb-filter-label">TYPE</label>
          <select className="tb-select" value={filters.vesselType} onChange={e=>onFiltersChange({...filters,vesselType:e.target.value})}>
            <option value="">All Types</option>
            {vesselTypes.map(t=><option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        {/* Speed filter */}
        <div className="tb-filter-group">
          <label className="tb-filter-label">SPEED</label>
          <select className="tb-select" value={filters.speedRange}
            onChange={e=>{
              const v=e.target.value;
              const m={"":{ speedMin:null,speedMax:null},stopped:{speedMin:null,speedMax:0.5},slow:{speedMin:0.5,speedMax:5},medium:{speedMin:5,speedMax:12},fast:{speedMin:12,speedMax:null}};
              onFiltersChange({...filters,speedRange:v,...m[v]});
            }}>
            <option value="">All Speeds</option>
            <option value="stopped">⚓ Stopped</option>
            <option value="slow">🐢 Slow 0.5–5 kn</option>
            <option value="medium">⚡ Medium 5–12 kn</option>
            <option value="fast">🚀 Fast ≥12 kn</option>
          </select>
        </div>

        {/* Stats */}
        <div className="tb-stats">
          <StatPill v={stats?Number(stats.total_vessels||0).toLocaleString():"—"} l="VESSELS" c="cyan"/>
          <div className="tb-divider"/>
          <StatPill v={stats?Number(stats.underway||stats.moving_vessels||0).toLocaleString():"—"} l="UNDERWAY" c="green"/>
          <div className="tb-divider"/>
          <StatPill v={stats?Number(stats.in_port||0).toLocaleString():"—"} l="IN PORT" c="amber"/>
          <div className="tb-divider"/>
          <StatPill v={stats?`${parseFloat(stats.avg_speed||0).toFixed(1)}`:"—"} l="AVG KN" c="blue"/>
          <div className="tb-divider"/>
          <StatPill v={stats?`${parseFloat(stats.avg_data_quality||0).toFixed(0)}%`:"—"} l="DQ SCORE" c="purple"/>
        </div>

        {/* Live + Timer — desktop only, on mobile these move to row 2 */}
        <div className="tb-status-group">
          <div className={`tb-live ${loading?"loading":""}`}>
            <span className="tb-live-dot"/>
            {loading?"SYNC":"LIVE"}
          </div>
          <div className="tb-timer" title="Next auto-refresh">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            <span className="mono">{countdown}</span>
          </div>
          {dataAge && (
            <div className="tb-updated" title="Age of most recent vessel position">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <span className="mono">DATA {dataAge}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── ROW 2: Search + Action buttons ── */}
      <div className="tb-row tb-row-bottom">
        {/* Search */}
        <div className="tb-search-wrap">
          <svg className="tb-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            className="tb-search" type="text" placeholder="Search vessel, IMO, MMSI…"
            value={filters.search}
            onChange={e=>onFiltersChange({...filters,search:e.target.value})}
            onKeyDown={e=>e.key==="Enter"&&onSearchEnter?.()}
            autoComplete="off" spellCheck={false}
          />
          {filters.search&&<button className="tb-clear" onClick={()=>onFiltersChange({...filters,search:""})}>✕</button>}
        </div>

        {/* All action buttons */}
        <div className="tb-right">
          <button className={`tb-btn ${loading?"spin":""}`} onClick={onRefresh} disabled={loading} title="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>

          <button className={`tb-btn tb-btn-port ${portPanelOpen?"active":""}`} onClick={onTogglePortPanel} title="Port Activity">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
          </button>

          <div className="tb-divider-v" />

          <button className={`tb-btn tb-btn-compare ${compareOpen?"active":""}`} onClick={onToggleCompare} title="Vessel Comparison">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="8" height="18" rx="1"/><rect x="14" y="3" width="8" height="18" rx="1"/>
            </svg>
          </button>

          <button className={`tb-btn tb-btn-alerts ${alertsOpen?"active":""}`} onClick={onToggleAlerts} title="Live Alerts" style={{position:"relative"}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            {alertCount > 0 && (
              <span className="tb-alert-badge">{alertCount > 9 ? "9+" : alertCount}</span>
            )}
          </button>

          <button className={`tb-btn tb-btn-heatmap ${heatmapOpen?"active":""}`} onClick={onToggleHeatmap} title="Port Congestion Heatmap">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="10"/>
            </svg>
          </button>

          <button className={`tb-btn tb-btn-prefs ${prefsOpen?"active":""}`} onClick={onTogglePrefs} title="Theme & Preferences">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>

          {/* User menu */}
          <div className="tb-user-wrap" ref={wrapRef}>
            <button className={`tb-avatar ${menuOpen?"active":""}`} onClick={handleAvatarClick} title={user?.email}>
              {user?.avatar||"?"}
            </button>
            {menuOpen&&(
              <div className="tb-user-menu" onClick={e=>e.stopPropagation()} onTouchStart={e=>e.stopPropagation()}>
                <div className="tb-user-name">{user?.name}</div>
                <div className="tb-user-email">{user?.email}</div>
                <div className="tb-user-role">{user?.role?.toUpperCase()}</div>
                <hr className="tb-user-hr"/>
                <div className="tb-dbt-info">
                  <div className="tb-dbt-row">📊 Project: <b>photons-377606</b></div>
                  <div className="tb-dbt-row">🗄 Dataset: <b>Photons_MPA</b></div>
                  <div className="tb-dbt-row">📋 Tables: fct_vessel_live_tracking</div>
                </div>
                <hr className="tb-user-hr"/>
                <button className="tb-user-logout" onClick={handleLogout}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                    <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                  </svg>
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

    </header>
  );
}

function StatPill({ v, l, c }) {
  return (
    <div className={`tb-stat ${c}`}>
      <span className="tb-stat-val mono">{v}</span>
      <span className="tb-stat-lbl">{l}</span>
    </div>
  );
}