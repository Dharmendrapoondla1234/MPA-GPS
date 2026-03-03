// src/components/TopBar.jsx
import React, { useState } from "react";
import { useCountdown } from "../hooks/useCountdown";
import { logoutUser } from "../services/api";
import "./TopBar.css";

export default function TopBar({
  filters,
  onFiltersChange,
  vesselTypes,
  stats,
  nextRefresh,
  loading,
  onRefresh,
  panelOpen,
  onTogglePanel,
  user,
  onLogout,
  onSearchEnter,
}) {
  const countdown = useCountdown(nextRefresh);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  function handleLogout() {
    logoutUser();
    onLogout();
  }

  return (
    <header className="topbar">
      {/* Logo */}
      <div className="tb-logo">
        <div className="tb-sonar">
          <div className="tb-sonar-ring" />
          <div className="tb-sonar-ring" style={{ animationDelay: "0.6s" }} />
          <span className="tb-sonar-dot" />
        </div>
        <div>
          <div className="tb-logo-text">
            MARINE<span>TRACK</span>
          </div>
          <div className="tb-logo-sub">LIVE AIS · BIGQUERY</div>
        </div>
      </div>

      {/* Search */}
      <div className="tb-search-wrap">
        <svg
          className="tb-search-icon"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          className="tb-search"
          type="text"
          placeholder="Search vessel name, IMO, MMSI…"
          value={filters.search}
          onChange={(e) =>
            onFiltersChange({ ...filters, search: e.target.value })
          }
          onKeyDown={(e) => e.key === "Enter" && onSearchEnter?.()}
          autoComplete="off"
          spellCheck={false}
        />
        {filters.search && (
          <button
            className="tb-clear"
            onClick={() => onFiltersChange({ ...filters, search: "" })}
          >
            ✕
          </button>
        )}
      </div>

      {/* Type filter */}
      <div className="tb-filter-group">
        <label className="tb-filter-label">TYPE</label>
        <select
          className="tb-select"
          value={filters.vesselType}
          onChange={(e) =>
            onFiltersChange({ ...filters, vesselType: e.target.value })
          }
        >
          <option value="">All Types</option>
          {vesselTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {/* Speed filter */}
      <div className="tb-filter-group">
        <label className="tb-filter-label">SPEED</label>
        <select
          className="tb-select"
          value={filters.speedRange}
          onChange={(e) => {
            const v = e.target.value;
            const m = {
              "": { speedMin: null, speedMax: null },
              stopped: { speedMin: null, speedMax: 0.5 },
              slow: { speedMin: 0.5, speedMax: 5 },
              medium: { speedMin: 5, speedMax: 12 },
              fast: { speedMin: 12, speedMax: null },
            };
            onFiltersChange({ ...filters, speedRange: v, ...m[v] });
          }}
        >
          <option value="">All Speeds</option>
          <option value="stopped">⚓ Stopped</option>
          <option value="slow">🐢 Slow 0.5–5 kn</option>
          <option value="medium">⚡ Medium 5–12 kn</option>
          <option value="fast">🚀 Fast ≥12 kn</option>
        </select>
      </div>

      {/* Stats */}
      <div className="tb-stats">
        <StatPill
          v={stats ? Number(stats.total_vessels || 0).toLocaleString() : "—"}
          l="VESSELS"
          c="cyan"
        />
        <div className="tb-divider" />
        <StatPill
          v={stats ? Number(stats.moving_vessels || 0).toLocaleString() : "—"}
          l="MOVING"
          c="green"
        />
        <div className="tb-divider" />
        <StatPill
          v={stats ? `${parseFloat(stats.avg_speed || 0).toFixed(1)}` : "—"}
          l="AVG KN"
          c="amber"
        />
        <div className="tb-divider" />
        <StatPill
          v={stats ? `${parseFloat(stats.max_speed || 0).toFixed(1)}` : "—"}
          l="MAX KN"
          c="red"
        />
      </div>

      {/* Right controls */}
      <div className="tb-right">
        <div className={`tb-live ${loading ? "loading" : ""}`}>
          <span className="tb-live-dot" />
          {loading ? "SYNC" : "LIVE"}
        </div>
        <div className="tb-timer">
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span className="mono">{countdown}</span>
        </div>
        <button
          className={`tb-btn ${loading ? "spin" : ""}`}
          onClick={onRefresh}
          disabled={loading}
          title="Refresh"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
        <button
          className={`tb-btn ${panelOpen ? "active" : ""}`}
          onClick={onTogglePanel}
          title="Toggle panel"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>

        {/* User avatar */}
        <div className="tb-user-wrap">
          <button
            className="tb-avatar"
            onClick={() => setUserMenuOpen((o) => !o)}
            title={user?.email}
          >
            {user?.avatar || "?"}
          </button>
          {userMenuOpen && (
            <div className="tb-user-menu">
              <div className="tb-user-name">{user?.name}</div>
              <div className="tb-user-email">{user?.email}</div>
              <div className="tb-user-role">{user?.role?.toUpperCase()}</div>
              <hr className="tb-user-hr" />
              <button className="tb-user-logout" onClick={handleLogout}>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Sign Out
              </button>
            </div>
          )}
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