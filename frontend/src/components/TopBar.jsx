// src/components/TopBar.jsx — MPA v8 "Nexus Command Bar"
// Beautiful icons, grouped controls, tooltip labels, zero collision
import React, { useState, useEffect, useRef, useCallback } from "react";
import { useCountdown } from "../hooks/useCountdown";
import { logoutUser } from "../services/api";
import "./TopBar.css";

// ── SVG Icons ─────────────────────────────────────────────────────
const Ico = {
  Refresh:  () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
  Port:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  Star:     () => <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" fill="currentColor" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
  Eye:      () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  Compare:  () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="8" height="18" rx="1.5"/><rect x="14" y="3" width="8" height="18" rx="1.5"/></svg>,
  Bell:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  Heatmap:  () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="10"/></svg>,
  Gear:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  Anchor:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg>,
  Phone:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.18h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.29a16 16 0 0 0 6.29 6.29l1.17-1.17a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>,
  Chat:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="12" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/></svg>,
  Bolt:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" fillOpacity="0.2"/></svg>,
  User:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  Logout:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  Clock:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Check:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>,
  Search:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
};

function StatPill({ v, l, c }) {
  return (
    <div className={`tb-stat tb-stat--${c}`}>
      <span className="tb-stat-val">{v}</span>
      <span className="tb-stat-lbl">{l}</span>
    </div>
  );
}

// Tooltip-wrapped icon button
function TBtn({ icon: I, label, active, onClick, badge, color, disabled, spin }) {
  return (
    <div className="tbt-wrap">
      <button
        className={["tbt", active && "tbt--on", color && `tbt--${color}`, disabled && "tbt--disabled", spin && "tbt--spin"].filter(Boolean).join(" ")}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
      >
        <span className="tbt-ico"><I /></span>
        {badge > 0 && <span className="tbt-badge">{badge > 9 ? "9+" : badge}</span>}
      </button>
      <span className="tbt-tip">{label}</span>
    </div>
  );
}

// Pill group container
function BtnGroup({ children }) {
  return <div className="tb-btngroup">{children}</div>;
}

export default function TopBar({
  filters, onFiltersChange, vesselTypes, flagOptions = [], stats,
  nextRefresh, loading, onRefresh,
  user, onLogout, onSearchEnter, lastUpdated,
  portPanelOpen, onTogglePortPanel,
  preferredOpen, onTogglePreferred, preferredCount,
  watchlistOpen, onToggleWatchlist, watchlistCount,
  compareOpen, onToggleCompare,
  alertsOpen, onToggleAlerts, alertCount,
  heatmapOpen, onToggleHeatmap,
  prefsOpen, onTogglePrefs,
  agentIntelOpen, onToggleAgentIntel,
  contactIntelOpen, onToggleContactIntel,
  aiChatOpen, onToggleAiChat,
  aiFleetOpen, onToggleAiFleet,
  onOpenProfile,
}) {
  const countdown = useCountdown(nextRefresh);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dataAge, setDataAge] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!lastUpdated) { setDataAge(null); return; }
    const tick = () => {
      const s = Math.floor((Date.now() - new Date(lastUpdated).getTime()) / 1000);
      setDataAge(s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  useEffect(() => {
    if (!menuOpen) return;
    const h = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menuOpen]);

  const handleLogout = useCallback(() => { logoutUser(); onLogout(); setMenuOpen(false); }, [onLogout]);

  return (
    <header className="topbar">
      <div className="topbar-glow" />

      {/* ═══ ROW 1: Brand · Filters · Stats · Live ═══ */}
      <div className="tb-row tb-row1">

        <div className="tb-brand">
          <div className="tb-sonar">
            <div className="tb-sr tb-sr1" /><div className="tb-sr tb-sr2" />
            <div className="tb-sc" />
          </div>
          <div>
            <div className="tb-bname">MARINE<span>TRACK</span></div>
            <div className="tb-bsub">LIVE AIS · MARITIME INTELLIGENCE</div>
          </div>
        </div>

        <div className="tb-filters">
          <div className="tb-fg">
            <label className="tb-fl">TYPE</label>
            <select className="tb-fs" value={filters.vesselType} onChange={e => onFiltersChange({ ...filters, vesselType: e.target.value })}>
              <option value="">All Types</option>
              {vesselTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="tb-fg">
            <label className="tb-fl">SPEED</label>
            <select className="tb-fs" value={filters.speedRange} onChange={e => {
              const v = e.target.value;
              const m = { "": { speedMin: null, speedMax: null }, stopped: { speedMin: null, speedMax: 0.5 }, slow: { speedMin: 0.5, speedMax: 5 }, medium: { speedMin: 5, speedMax: 12 }, fast: { speedMin: 12, speedMax: null } };
              onFiltersChange({ ...filters, speedRange: v, ...m[v] });
            }}>
              <option value="">All Speeds</option>
              <option value="stopped">⚓ Stopped</option>
              <option value="slow">🐢 0–5 kn</option>
              <option value="medium">⚡ 5–12 kn</option>
              <option value="fast">🚀 12+ kn</option>
            </select>
          </div>
          {flagOptions.length > 0 && (
            <div className="tb-fg tb-fg--flag">
              <label className="tb-fl">FLAG</label>
              <select className="tb-fs" value={filters.flag || ""} onChange={e => onFiltersChange({ ...filters, flag: e.target.value })}>
                <option value="">All Flags</option>
                {flagOptions.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="tb-stats">
          <StatPill v={stats ? Number(stats.total_vessels || 0).toLocaleString() : "—"} l="VESSELS" c="cyan" />
          <div className="tb-sdiv" />
          <StatPill v={stats ? Number(stats.underway || stats.moving_vessels || 0).toLocaleString() : "—"} l="UNDERWAY" c="green" />
          <div className="tb-sdiv" />
          <StatPill v={stats ? Number(stats.in_port || 0).toLocaleString() : "—"} l="IN PORT" c="amber" />
          <div className="tb-sdiv tb-sdiv--md" />
          <StatPill v={stats ? parseFloat(stats.avg_speed || 0).toFixed(1) : "—"} l="AVG KN" c="blue" />
          <div className="tb-sdiv tb-sdiv--lg" />
          <StatPill v={stats ? `${parseFloat(stats.avg_data_quality || 0).toFixed(0)}%` : "—"} l="DQ" c="purple" />
        </div>

        <div className="tb-livegroup">
          <div className={`tb-live${loading ? " tb-live--sync" : ""}`}>
            <span className="tb-ldot" />
            <span className="tb-llabel">{loading ? "SYNC" : "LIVE"}</span>
          </div>
          <div className="tb-lsep" />
          <div className="tb-timer">
            <Ico.Clock /><span>{countdown}</span>
          </div>
          {dataAge && (
            <div className="tb-dataage">
              <Ico.Check /><span>DATA {dataAge}</span>
            </div>
          )}
        </div>
      </div>

      {/* ═══ ROW 2: Search · Controls ═══ */}
      <div className="tb-row tb-row2">

        <div className="tb-search">
          <span className="tb-sico"><Ico.Search /></span>
          <input
            className="tb-sinput"
            type="text"
            placeholder="Search vessel, IMO, MMSI…"
            value={filters.search}
            onChange={e => onFiltersChange({ ...filters, search: e.target.value })}
            onKeyDown={e => e.key === "Enter" && onSearchEnter?.()}
            autoComplete="off"
            spellCheck={false}
          />
          {filters.search && (
            <button className="tb-sclear" onClick={() => onFiltersChange({ ...filters, search: "" })} aria-label="Clear">✕</button>
          )}
        </div>

        <div className="tb-ctrl">

          {/* Refresh */}
          <TBtn icon={Ico.Refresh} label="Refresh AIS data" onClick={onRefresh} disabled={loading} spin={loading} />

          <div className="tb-cdiv" />

          {/* View group */}
          <BtnGroup>
            <TBtn icon={Ico.Port}    label="Port Activity"         active={portPanelOpen} onClick={onTogglePortPanel} color="amber" />
            <TBtn icon={Ico.Heatmap} label="Congestion Heatmap"    active={heatmapOpen}   onClick={onToggleHeatmap}  color="orange" />
            <TBtn icon={Ico.Compare} label="Vessel Comparison"     active={compareOpen}   onClick={onToggleCompare}  color="green" />
          </BtnGroup>

          <div className="tb-cdiv" />

          {/* Fleet management group */}
          <BtnGroup>
            <TBtn icon={Ico.Star}  label={`Preferred Ships (${preferredCount})`} active={preferredOpen} onClick={onTogglePreferred} badge={preferredCount} color="gold" />
            <TBtn icon={Ico.Eye}   label={`Watchlist (${watchlistCount})`}       active={watchlistOpen} onClick={onToggleWatchlist} badge={watchlistCount} color="cyan" />
            <TBtn icon={Ico.Bell}  label={`Live Alerts (${alertCount})`}         active={alertsOpen}    onClick={onToggleAlerts}   badge={alertCount}    color="red" />
          </BtnGroup>

          <div className="tb-cdiv" />

          {/* Intelligence group */}
          <BtnGroup>
            <TBtn icon={Ico.Anchor} label="Port Agent Intelligence"   active={agentIntelOpen}   onClick={onToggleAgentIntel}   color="violet" />
            <TBtn icon={Ico.Phone}  label="Universal Contact Finder"  active={contactIntelOpen} onClick={onToggleContactIntel} color="violet" />
          </BtnGroup>

          <div className="tb-cdiv" />

          {/* AI group */}
          <BtnGroup>
            <TBtn icon={Ico.Bolt} label="AI Fleet Intelligence"  active={aiFleetOpen} onClick={onToggleAiFleet} color="emerald" />
            <TBtn icon={Ico.Chat} label="AI Maritime Assistant"  active={aiChatOpen}  onClick={onToggleAiChat}  color="cyan" />
          </BtnGroup>

          <div className="tb-cdiv" />

          {/* Settings */}
          <TBtn icon={Ico.Gear} label="Preferences" active={prefsOpen} onClick={onTogglePrefs} color="sky" />

          {/* User avatar */}
          <div className="tb-umwrap" ref={wrapRef}>
            <button
              className={`tb-avatar${menuOpen ? " tb-avatar--open" : ""}`}
              onClick={e => { e.stopPropagation(); setMenuOpen(o => !o); }}
              title={user?.email}
              aria-label="Account menu"
            >
              {user?.name ? user.name.slice(0, 2).toUpperCase() : "?"}
            </button>

            {menuOpen && (
              <div className="tb-umenu" onClick={e => e.stopPropagation()}>
                <div className="tb-um-head">
                  <div className="tb-um-av">{user?.name ? user.name.slice(0, 2).toUpperCase() : "?"}</div>
                  <div>
                    <div className="tb-um-name">{user?.name || "User"}</div>
                    <div className="tb-um-email">{user?.email}</div>
                    {user?.role && <div className="tb-um-role">{user.role.toUpperCase()}</div>}
                  </div>
                </div>
                <div className="tb-um-sep" />
                <button className="tb-um-btn" onClick={() => { setMenuOpen(false); onOpenProfile?.(); }}>
                  <span className="tb-um-bico"><Ico.User /></span>My Profile
                </button>
                <button className="tb-um-btn" onClick={() => { setMenuOpen(false); onTogglePrefs?.(); }}>
                  <span className="tb-um-bico"><Ico.Gear /></span>Preferences
                </button>
                <div className="tb-um-sep" />
                <button className="tb-um-btn tb-um-btn--danger" onClick={handleLogout}>
                  <span className="tb-um-bico"><Ico.Logout /></span>Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
