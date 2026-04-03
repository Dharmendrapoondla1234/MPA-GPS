// ProfilePanel.jsx — Enhanced User Profile v2
// Features: Overview · Fleet · Activity · Account · Preferences
// No database/table names exposed anywhere
import React, { useState, useCallback, useRef, useEffect } from "react";
import { getCurrentUser, logoutUser } from "../services/api";
import { useWatchlist } from "./WatchlistPanel";
import "./ProfilePanel.css";

const AVATARS = ["🧑‍✈️","👨‍💻","🧭","⚓","🛳️","🌊","🔭","🗺️","📡","🚢","🌐","📊"];
const ROLE_COLORS = { Admin:"#ff6b6b", Operator:"#00e5ff", Analyst:"#a78bfa", Viewer:"#26de81" };

function StatCard({ icon, label, value, color="#00e5ff", sub }) {
  return (
    <div className="pp-stat-card">
      <div className="pp-stat-icon" style={{ color }}>{icon}</div>
      <div className="pp-stat-val" style={{ color }}>{value}</div>
      <div className="pp-stat-label">{label}</div>
      {sub && <div className="pp-stat-sub">{sub}</div>}
    </div>
  );
}

function Toggle({ value, onChange }) {
  return (
    <div className={`pp-toggle ${value ? "on" : "off"}`} onClick={() => onChange(!value)}>
      <div className="pp-toggle-knob" />
    </div>
  );
}

function PrefRow({ label, desc, value, onChange }) {
  return (
    <label className="pp-pref-row">
      <div className="pp-pref-text">
        <span className="pp-pref-label">{label}</span>
        {desc && <span className="pp-pref-desc">{desc}</span>}
      </div>
      <Toggle value={value} onChange={onChange} />
    </label>
  );
}

function ActivityBar({ label, value, max, color }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="pp-activity-bar">
      <div className="pp-activity-label">{label}</div>
      <div className="pp-activity-track">
        <div className="pp-activity-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="pp-activity-val">{value}</div>
    </div>
  );
}

function InfoRow({ label, value, highlight }) {
  return (
    <div className="pp-info-row">
      <span className="pp-info-key">{label}</span>
      <span className="pp-info-val" style={highlight ? { color: highlight } : {}}>{value}</span>
    </div>
  );
}

function NotifItem({ icon, text, time, type="info" }) {
  return (
    <div className={`pp-notif-item pp-notif-${type}`}>
      <span className="pp-notif-icon">{icon}</span>
      <div className="pp-notif-body">
        <span className="pp-notif-text">{text}</span>
        <span className="pp-notif-time">{time}</span>
      </div>
    </div>
  );
}

export default function ProfilePanel({ isOpen, onClose, user: propUser, onLogout }) {
  const user      = propUser || getCurrentUser();
  const watchlist = useWatchlist();

  const [activeTab,      setActiveTab]      = useState("overview");
  const [editName,       setEditName]       = useState(false);
  const [nameVal,        setNameVal]        = useState(user?.name || "");
  const [savingName,     setSavingName]     = useState(false);
  const [nameMsg,        setNameMsg]        = useState("");
  const [selectedAvatar, setSelectedAvatar] = useState(user?.avatar || null);
  const [copyMsg,        setCopyMsg]        = useState("");
  const [showDanger,     setShowDanger]     = useState(false);
  const nameInputRef = useRef(null);

  const [preferences, setPreferences] = useState(() => {
    try { return JSON.parse(localStorage.getItem("mpa_prefs") || "{}"); } catch { return {}; }
  });

  const [sessionStats] = useState(() => {
    try {
      const raw = sessionStorage.getItem("mpa_session_stats");
      return raw ? JSON.parse(raw) : {
        vessels_viewed: 0, searches: 0, contacts_looked: 0,
        alerts_dismissed: 0, session_start: Date.now()
      };
    } catch {
      return { vessels_viewed: 0, searches: 0, contacts_looked: 0,
               alerts_dismissed: 0, session_start: Date.now() };
    }
  });

  const sessionDurationMin = Math.floor((Date.now() - (sessionStats.session_start || Date.now())) / 60000);
  const sessionDurationStr = sessionDurationMin >= 60
    ? `${Math.floor(sessionDurationMin / 60)}h ${sessionDurationMin % 60}m`
    : `${sessionDurationMin}m`;

  const watchlistTypes = watchlist.reduce((acc, v) => {
    const t = v.vessel_type || "Unknown";
    acc[t] = (acc[t] || 0) + 1; return acc;
  }, {});
  const watchlistFlags = [...new Set(watchlist.map(v => v.flag).filter(Boolean))];
  const topType = Object.entries(watchlistTypes).sort((a, b) => b[1] - a[1])[0];

  const memberSince = user?.created_at
    ? new Date(user.created_at).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
    : "—";

  const lastLogin = user?.last_login
    ? new Date(user.last_login).toLocaleString("en-GB", {
        day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit"
      })
    : "This session";

  const recentNotifs = [
    watchlist.length > 0 && {
      icon: "★", type: "success",
      text: `${watchlist.length} vessel${watchlist.length !== 1 ? "s" : ""} in your fleet`,
      time: "Now"
    },
    sessionStats.vessels_viewed > 0 && {
      icon: "🚢", type: "info",
      text: `Viewed ${sessionStats.vessels_viewed} vessel${sessionStats.vessels_viewed !== 1 ? "s" : ""} this session`,
      time: "Session"
    },
    sessionStats.searches > 0 && {
      icon: "🔍", type: "info",
      text: `${sessionStats.searches} search${sessionStats.searches !== 1 ? "es" : ""} performed`,
      time: "Session"
    },
    sessionStats.contacts_looked > 0 && {
      icon: "📋", type: "info",
      text: `${sessionStats.contacts_looked} contact lookup${sessionStats.contacts_looked !== 1 ? "s" : ""}`,
      time: "Session"
    },
    { icon: "✅", type: "success", text: "Fleet synced and up to date", time: "Live" },
  ].filter(Boolean).slice(0, 5);

  const savePref = useCallback((key, val) => {
    const next = { ...preferences, [key]: val };
    setPreferences(next);
    try { localStorage.setItem("mpa_prefs", JSON.stringify(next)); } catch {}
  }, [preferences]);

  const getPref = useCallback((key, def) => preferences[key] ?? def, [preferences]);

  const saveDisplayName = useCallback(async () => {
    if (!nameVal.trim() || nameVal.trim() === user?.name) { setEditName(false); return; }
    setSavingName(true);
    try {
      const stored = JSON.parse(localStorage.getItem("mpa_user") || "{}");
      stored.name = nameVal.trim();
      localStorage.setItem("mpa_user", JSON.stringify(stored));
      setNameMsg("Display name updated ✓");
      setTimeout(() => setNameMsg(""), 3000);
    } catch {
      setNameMsg("Could not save — try again");
    } finally {
      setSavingName(false);
      setEditName(false);
    }
  }, [nameVal, user]);

  const copyEmail = useCallback(() => {
    if (!user?.email) return;
    navigator.clipboard.writeText(user.email)
      .then(() => { setCopyMsg("Copied!"); setTimeout(() => setCopyMsg(""), 1500); })
      .catch(() => {});
  }, [user?.email]);

  useEffect(() => {
    if (editName && nameInputRef.current) nameInputRef.current.focus();
  }, [editName]);

  if (!isOpen) return null;

  const roleColor = ROLE_COLORS[user?.role] || "#00e5ff";

  const tabs = [
    { id: "overview",  label: "Overview",    icon: "📊" },
    { id: "fleet",     label: `Fleet${watchlist.length ? ` (${watchlist.length})` : ""}`, icon: "★" },
    { id: "activity",  label: "Activity",    icon: "📈" },
    { id: "account",   label: "Account",     icon: "👤" },
    { id: "prefs",     label: "Preferences", icon: "⚙" },
  ];

  return (
    <div className="pp-overlay" onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="pp-panel">

        {/* ── Header ── */}
        <div className="pp-header">
          <div className="pp-header-bg" />
          <div className="pp-avatar-wrap">
            <div className="pp-avatar">{selectedAvatar || user?.avatar || "?"}</div>
            <div className="pp-avatar-ring" style={{ borderColor: roleColor + "66" }} />
            <div className="pp-avatar-online" title="Online" />
          </div>
          <div className="pp-header-info">
            <div className="pp-user-name">{user?.name || "Mariner"}</div>
            <div className="pp-user-email" onClick={copyEmail} title="Click to copy">
              {user?.email}
              {copyMsg
                ? <span className="pp-copy-flash">{copyMsg}</span>
                : <span className="pp-copy-hint">⎘</span>
              }
            </div>
            <div className="pp-role-badge" style={{
              background: roleColor + "22", color: roleColor, borderColor: roleColor + "55"
            }}>
              {user?.role || "Operator"}
            </div>
          </div>
          <div className="pp-header-meta">
            <div className="pp-header-meta-item">
              <span className="pp-header-meta-val">{watchlist.length}</span>
              <span className="pp-header-meta-lbl">Fleet</span>
            </div>
            <div className="pp-header-meta-divider" />
            <div className="pp-header-meta-item">
              <span className="pp-header-meta-val">{sessionStats.vessels_viewed || 0}</span>
              <span className="pp-header-meta-lbl">Viewed</span>
            </div>
            <div className="pp-header-meta-divider" />
            <div className="pp-header-meta-item">
              <span className="pp-header-meta-val">{sessionDurationStr}</span>
              <span className="pp-header-meta-lbl">Session</span>
            </div>
          </div>
          <button className="pp-close" onClick={onClose}>✕</button>
        </div>

        {/* ── Tabs ── */}
        <div className="pp-tabs">
          {tabs.map(t => (
            <button key={t.id} className={`pp-tab ${activeTab === t.id ? "active" : ""}`}
              onClick={() => setActiveTab(t.id)}>
              <span className="pp-tab-icon">{t.icon}</span>
              <span className="pp-tab-label">{t.label}</span>
            </button>
          ))}
        </div>

        {/* ── Content ── */}
        <div className="pp-content">

          {/* ═══ OVERVIEW ═══ */}
          {activeTab === "overview" && (
            <div className="pp-section">
              <div className="pp-stat-grid">
                <StatCard icon="★"  label="Fleet size"    value={watchlist.length}                 color="#ffd700" sub={topType ? topType[0] : undefined} />
                <StatCard icon="🚢" label="Viewed"        value={sessionStats.vessels_viewed || 0} color="#00e5ff" />
                <StatCard icon="🌍" label="Flags"         value={watchlistFlags.length || "—"}     color="#26de81" />
                <StatCard icon="⏱" label="Online"         value={sessionDurationStr}               color="#a78bfa" />
              </div>

              <div className="pp-section-title">RECENT ACTIVITY</div>
              <div className="pp-notif-list">
                {recentNotifs.length > 0
                  ? recentNotifs.map((n, i) => (
                      <NotifItem key={i} icon={n.icon} text={n.text} time={n.time} type={n.type} />
                    ))
                  : <div className="pp-empty-mini">No activity yet this session.</div>
                }
              </div>

              <div className="pp-section-title">QUICK ACTIONS</div>
              <div className="pp-quick-actions">
                {[
                  { tab: "fleet",    icon: "★", label: "My Fleet",   sub: `${watchlist.length} vessel${watchlist.length !== 1 ? "s" : ""}` },
                  { tab: "activity", icon: "📈", label: "Activity",   sub: "Session stats" },
                  { tab: "account",  icon: "🔑", label: "Account",    sub: "Edit profile" },
                  { tab: "prefs",    icon: "⚙",  label: "Preferences",sub: "Customise" },
                ].map(q => (
                  <button key={q.tab} className="pp-quick-btn" onClick={() => setActiveTab(q.tab)}>
                    <span className="pp-quick-icon">{q.icon}</span>
                    <div className="pp-quick-text">
                      <span className="pp-quick-label">{q.label}</span>
                      <span className="pp-quick-sub">{q.sub}</span>
                    </div>
                  </button>
                ))}
              </div>

              <div className="pp-member-banner">
                <span className="pp-member-icon">⚓</span>
                <span>Member since {memberSince}</span>
                <span className="pp-member-dot">·</span>
                <span className="pp-status-active">● Active</span>
              </div>
            </div>
          )}

          {/* ═══ FLEET ═══ */}
          {activeTab === "fleet" && (
            <div className="pp-section">
              {watchlist.length === 0 ? (
                <div className="pp-empty">
                  <div className="pp-empty-icon">☆</div>
                  <div className="pp-empty-title">Fleet is empty</div>
                  <div className="pp-empty-sub">
                    Tap <strong>☆</strong> on any vessel detail panel to add it to your fleet.
                    Your fleet syncs across all your devices.
                  </div>
                </div>
              ) : (
                <>
                  <div className="pp-fleet-summary-pills">
                    {[
                      { val: watchlist.length,                    lbl: "Total",  c: "#ffd700" },
                      { val: Object.keys(watchlistTypes).length,  lbl: "Types",  c: "#00e5ff" },
                      { val: watchlistFlags.length,               lbl: "Flags",  c: "#26de81" },
                    ].map(p => (
                      <div key={p.lbl} className="pp-fleet-pill" style={{ borderColor: p.c + "44" }}>
                        <span className="pp-fleet-pill-val" style={{ color: p.c }}>{p.val}</span>
                        <span className="pp-fleet-pill-lbl">{p.lbl}</span>
                      </div>
                    ))}
                  </div>

                  <div className="pp-section-title">BY VESSEL TYPE</div>
                  <div className="pp-fleet-breakdown">
                    {Object.entries(watchlistTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                      <div key={type} className="pp-fleet-row">
                        <span className="pp-fleet-type">{type}</span>
                        <div className="pp-fleet-bar-wrap">
                          <div className="pp-fleet-bar-fill" style={{ width: `${(count / watchlist.length) * 100}%` }} />
                        </div>
                        <span className="pp-fleet-count">{count}</span>
                      </div>
                    ))}
                  </div>

                  {watchlistFlags.length > 0 && (
                    <>
                      <div className="pp-section-title">FLAGS IN FLEET</div>
                      <div className="pp-flag-list">
                        {watchlistFlags.map(f => <span key={f} className="pp-flag-chip">{f}</span>)}
                      </div>
                    </>
                  )}

                  <div className="pp-section-title">VESSEL LIST</div>
                  <div className="pp-vessel-list">
                    {watchlist.map((v, i) => (
                      <div key={v.imo_number} className="pp-vessel-row">
                        <div className="pp-vessel-idx">{i + 1}</div>
                        <div className="pp-vessel-body">
                          <div className="pp-vessel-name">{v.vessel_name}</div>
                          <div className="pp-vessel-meta">
                            <span className="pp-vessel-imo">IMO {v.imo_number}</span>
                            {v.vessel_type && <span className="pp-vessel-type">{v.vessel_type}</span>}
                            {v.flag        && <span className="pp-vessel-flag">{v.flag}</span>}
                          </div>
                        </div>
                        {v.added_at && (
                          <span className="pp-vessel-added">
                            {new Date(v.added_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ═══ ACTIVITY ═══ */}
          {activeTab === "activity" && (
            <div className="pp-section">
              <div className="pp-section-title">THIS SESSION</div>
              <div className="pp-activity-list">
                <ActivityBar label="Vessels Viewed"  value={sessionStats.vessels_viewed   || 0} max={50} color="#00e5ff" />
                <ActivityBar label="Searches"         value={sessionStats.searches          || 0} max={30} color="#a78bfa" />
                <ActivityBar label="Contact Lookups"  value={sessionStats.contacts_looked  || 0} max={20} color="#26de81" />
                <ActivityBar label="Alerts Dismissed" value={sessionStats.alerts_dismissed || 0} max={10} color="#fd9644" />
              </div>

              <div className="pp-section-title">SESSION INFO</div>
              <div className="pp-info-list">
                <InfoRow label="Duration"   value={sessionDurationStr} />
                <InfoRow label="Started"    value={new Date(sessionStats.session_start || Date.now()).toLocaleTimeString()} />
                <InfoRow label="Last login" value={lastLogin} />
              </div>

              <div className="pp-section-title">FLEET SYNC</div>
              <div className="pp-sync-status">
                <div className="pp-sync-dot" />
                <div className="pp-sync-text">
                  <span className="pp-sync-label">Cloud sync active</span>
                  <span className="pp-sync-sub">Fleet data saved — accessible across all your devices</span>
                </div>
              </div>

              <div className="pp-section-title">TIPS</div>
              <div className="pp-tips-list">
                {[
                  { icon: "☆", tip: "Star any vessel in the detail panel to add it to your fleet" },
                  { icon: "🔍", tip: "Use the search bar or click a vessel on the map to inspect it" },
                  { icon: "📋", tip: "Open Contact Intelligence to find vessel emails and phone numbers" },
                  { icon: "⚡", tip: "Comparison mode lets you analyse two vessels side-by-side" },
                  { icon: "🗺️", tip: "Enable Watchlist Map Filter to see only your fleet on the map" },
                ].map((t, i) => (
                  <div key={i} className="pp-tip-row">
                    <span className="pp-tip-icon">{t.icon}</span>
                    <span className="pp-tip-text">{t.tip}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ═══ ACCOUNT ═══ */}
          {activeTab === "account" && (
            <div className="pp-section">
              <div className="pp-section-title">DISPLAY NAME</div>
              <div className="pp-field-row">
                {editName ? (
                  <>
                    <input
                      ref={nameInputRef}
                      className="pp-input"
                      value={nameVal}
                      onChange={e => setNameVal(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter")  saveDisplayName();
                        if (e.key === "Escape") { setEditName(false); setNameVal(user?.name || ""); }
                      }}
                      maxLength={40}
                      placeholder="Your display name"
                    />
                    <button className="pp-save-btn" onClick={saveDisplayName} disabled={savingName}>
                      {savingName ? "…" : "Save"}
                    </button>
                    <button className="pp-cancel-btn" onClick={() => { setEditName(false); setNameVal(user?.name || ""); }}>✕</button>
                  </>
                ) : (
                  <>
                    <span className="pp-field-val">{nameVal || user?.name}</span>
                    <button className="pp-edit-btn" onClick={() => setEditName(true)}>✏ Edit</button>
                  </>
                )}
              </div>
              {nameMsg && <div className="pp-field-msg">{nameMsg}</div>}

              <div className="pp-section-title">AVATAR</div>
              <div className="pp-avatar-picker">
                {AVATARS.map(av => (
                  <button
                    key={av}
                    className={`pp-avatar-opt ${(selectedAvatar || user?.avatar) === av ? "selected" : ""}`}
                    onClick={() => setSelectedAvatar(av)}
                    title={av}
                  >
                    {av}
                  </button>
                ))}
              </div>

              <div className="pp-section-title">ACCOUNT INFO</div>
              <div className="pp-info-list">
                <InfoRow label="Email"        value={user?.email} />
                <InfoRow label="Role"         value={user?.role || "Operator"} highlight={roleColor} />
                <InfoRow label="Member since" value={memberSince} />
                <InfoRow label="Last login"   value={lastLogin} />
                <InfoRow label="Status"       value="● Active" highlight="#26de81" />
              </div>

              <div className="pp-section-title">SECURITY</div>
              <div className="pp-security-note">
                <span className="pp-sec-icon">🔒</span>
                <span>Passwords are hashed and never stored in plain text. Session tokens expire automatically after inactivity.</span>
              </div>

              <div className="pp-section-title">DANGER ZONE</div>
              {!showDanger ? (
                <button className="pp-danger-reveal" onClick={() => setShowDanger(true)}>
                  Show danger zone options ▾
                </button>
              ) : (
                <div className="pp-danger-zone">
                  <div className="pp-danger-item">
                    <div className="pp-danger-text">
                      <span className="pp-danger-title">Clear session data</span>
                      <span className="pp-danger-sub">Resets session activity counters</span>
                    </div>
                    <button className="pp-danger-btn" onClick={() => {
                      try { sessionStorage.removeItem("mpa_session_stats"); } catch {}
                      setShowDanger(false);
                    }}>Clear</button>
                  </div>
                  <div className="pp-danger-item">
                    <div className="pp-danger-text">
                      <span className="pp-danger-title">Sign out</span>
                      <span className="pp-danger-sub">End your current session</span>
                    </div>
                    <button className="pp-danger-btn pp-danger-btn--red" onClick={() => {
                      logoutUser(); onLogout?.(); onClose?.();
                    }}>Sign Out</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ═══ PREFERENCES ═══ */}
          {activeTab === "prefs" && (
            <div className="pp-section">
              <div className="pp-section-title">MAP DISPLAY</div>
              <div className="pp-pref-list">
                <PrefRow label="Vessel trails"          desc="Show movement trails on map"           value={getPref("showTrails",    true)}  onChange={v => savePref("showTrails",    v)} />
                <PrefRow label="Cluster nearby vessels" desc="Group vessels when zoomed out"         value={getPref("clusterPins",   false)} onChange={v => savePref("clusterPins",   v)} />
                <PrefRow label="Colour pins by speed"   desc="Pin colour reflects vessel speed"      value={getPref("showSpeed",     true)}  onChange={v => savePref("showSpeed",     v)} />
                <PrefRow label="Auto-centre selection"  desc="Map pans when selecting a vessel"      value={getPref("autoFollow",    false)} onChange={v => savePref("autoFollow",    v)} />
                <PrefRow label="High density mode"      desc="Show more vessel labels at once"       value={getPref("highDensity",   false)} onChange={v => savePref("highDensity",   v)} />
              </div>

              <div className="pp-section-title">ALERTS & NOTIFICATIONS</div>
              <div className="pp-pref-list">
                <PrefRow label="Alert sound effects"    desc="Audio cue on new alerts"               value={getPref("alertSound",     false)} onChange={v => savePref("alertSound",     v)} />
                <PrefRow label="Show alert banners"     desc="Display banner on new events"          value={getPref("alertBanner",    true)}  onChange={v => savePref("alertBanner",    v)} />
                <PrefRow label="Fleet change alerts"    desc="Notify when a watched vessel updates"  value={getPref("watchlistAlert", true)}  onChange={v => savePref("watchlistAlert", v)} />
              </div>

              <div className="pp-section-title">DATA & DISPLAY</div>
              <div className="pp-pref-list">
                <PrefRow label="Auto-refresh data"      desc="Automatically reload vessel positions" value={getPref("autoRefresh",   true)}  onChange={v => savePref("autoRefresh",   v)} />
                <PrefRow label="Metric units"           desc="Knots, nautical miles, metric tonnes"  value={getPref("metricUnits",   true)}  onChange={v => savePref("metricUnits",   v)} />
                <PrefRow label="Compact vessel cards"   desc="Smaller cards in vessel list panel"    value={getPref("compactCards",  false)} onChange={v => savePref("compactCards",  v)} />
              </div>

              <div className="pp-section-title">CONTACT INTELLIGENCE</div>
              <div className="pp-pref-list">
                <PrefRow label="Auto-run contact search" desc="Start pipeline when vessel is opened" value={getPref("autoContact",  false)} onChange={v => savePref("autoContact",  v)} />
                <PrefRow label="Show confidence scores"  desc="Show reliability % on contact data"   value={getPref("showConf",     true)}  onChange={v => savePref("showConf",     v)} />
              </div>

              <div className="pp-prefs-saved">
                <span className="pp-prefs-saved-icon">✓</span>
                Preferences saved to this device automatically.
              </div>

              <button className="pp-reset-prefs" onClick={() => {
                setPreferences({});
                try { localStorage.removeItem("mpa_prefs"); } catch {}
              }}>
                Reset all preferences to defaults
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}