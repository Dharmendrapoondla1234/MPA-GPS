// src/components/PortActivityPanel.jsx — v3 "MarineTraffic-Beater"
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { fetchArrivals, fetchDepartures, fetchPortActivity } from "../services/api";
import { getFlagEmoji, formatTimestamp, timeAgo, getVesselTypeLabel } from "../utils/vesselUtils";
import "./PortActivityPanel.css";

function bq(v) {
  if (v == null) return null;
  if (typeof v === "object" && "value" in v) return String(v.value).trim() || null;
  return String(v).trim() || null;
}

function safeNum(v) { const n = Number(v); return isNaN(n) ? null : n; }

const VESSEL_TYPE_ICONS = {
  "Container Ship": "📦", "Tanker": "🛢️", "Bulk Carrier": "⚓",
  "General Cargo": "🚢", "Ro-Ro": "🚗", "Passenger": "🛳️",
  "LNG Tanker": "💨", "Chemical Tanker": "⚗️", "Tug": "🔧",
  "Pilot Vessel": "🧭", "unknown": "🚢",
};

function vesselTypeIcon(typeCode) {
  const label = getVesselTypeLabel(typeCode) || "";
  for (const [k, ico] of Object.entries(VESSEL_TYPE_ICONS)) {
    if (label.toLowerCase().includes(k.toLowerCase())) return ico;
  }
  return "🚢";
}

function srcColor(src) {
  if (src === "DECLARATION") return { bg: "rgba(0,229,255,0.10)", border: "rgba(0,229,255,0.30)", text: "#00e5ff", label: "DECL" };
  if (src === "AIS_CONFIRMED") return { bg: "rgba(38,222,129,0.10)", border: "rgba(38,222,129,0.30)", text: "#26de81", label: "AIS" };
  if (src === "SCHEDULED")     return { bg: "rgba(253,150,68,0.10)", border: "rgba(253,150,68,0.30)", text: "#fd9644", label: "SCHED" };
  return { bg: "rgba(120,160,200,0.06)", border: "rgba(120,160,200,0.15)", text: "#88aabb", label: src || "—" };
}

function timeRelative(ts) {
  if (!ts) return null;
  try {
    const d = new Date(ts), now = Date.now(), diff = now - d.getTime();
    const absDiff = Math.abs(diff);
    if (absDiff < 60000) return { label: "just now", future: false, urgent: false };
    if (absDiff < 3600000) {
      const m = Math.round(absDiff / 60000);
      return { label: diff > 0 ? `${m}m ago` : `in ${m}m`, future: diff < 0, urgent: diff < 0 && m < 30 };
    }
    if (absDiff < 86400000) {
      const h = (absDiff / 3600000).toFixed(1);
      return { label: diff > 0 ? `${h}h ago` : `in ${h}h`, future: diff < 0, urgent: false };
    }
    return { label: formatTimestamp(ts), future: false, urgent: false };
  } catch { return null; }
}

export function PortActivityTrigger({ onClick, arrivals, departures, isOpen }) {
  const total = (arrivals || 0) + (departures || 0);
  return (
    <button className={"pa-trigger" + (isOpen ? " pa-trigger--open" : "")} onClick={onClick} title="Port Activity">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
      {total > 0 && <span className="pa-trigger-badge">{total > 99 ? "99+" : total}</span>}
      <span className="pa-trigger-label">PORT</span>
    </button>
  );
}

const TABS = [
  { id:"ARRIVALS",   icon:"↓", label:"Arrivals",   color:"#00ff9d" },
  { id:"DEPARTURES", icon:"↑", label:"Departures", color:"#ffaa00" },
  { id:"IN PORT",    icon:"⬡", label:"In Port",    color:"#00e5ff" },
  { id:"EXPECTED",   icon:"◷", label:"Expected",   color:"#a78bfa" },
];

export default function PortActivityPanel({ onSelectVessel, selectedImo, isOpen, onClose, vessels = [] }) {
  const [tab,         setTab]         = useState("ARRIVALS");
  const [arrivals,    setArrivals]    = useState([]);
  const [departures,  setDepartures]  = useState([]);
  const [portStats,   setPortStats]   = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [search,      setSearch]      = useState("");
  const [sortBy,      setSortBy]      = useState("time");
  const [expanded,    setExpanded]    = useState(null);
  const panelRef = useRef(null);
  const searchRef = useRef(null);

  const selectWithNav = useCallback((record) => {
    if (!onSelectVessel || !record?.imo_number) return;
    const live = vessels.find(v => String(v.imo_number) === String(record.imo_number));
    onSelectVessel(live || record);
  }, [vessels, onSelectVessel]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [arr, dep, ports] = await Promise.all([
        fetchArrivals(150), fetchDepartures(150), fetchPortActivity(),
      ]);
      if (Array.isArray(arr))   setArrivals(arr);
      if (Array.isArray(dep))   setDepartures(dep);
      if (Array.isArray(ports)) setPortStats(ports);
      setLastRefresh(new Date());
    } catch(e) { console.warn("[PortActivity]", e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target) && !e.target.closest(".pa-trigger"))
        onClose?.();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => { document.removeEventListener("mousedown", handler); document.removeEventListener("touchstart", handler); };
  }, [isOpen, onClose]);

  // Live stats bar
  const stats = useMemo(() => {
    const inPort = vessels.filter(v => parseFloat(v.speed || 0) < 0.5).length;
    const underway = vessels.filter(v => parseFloat(v.speed || 0) >= 0.5).length;
    const upcoming = departures.filter(v => v.is_upcoming).length;
    return { inPort, underway, upcoming, arrivals: arrivals.length, departures: departures.length };
  }, [vessels, arrivals, departures]);

  // Filter + sort logic
  const filterList = useCallback((list, timeField) => {
    let out = list;
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(v =>
        (bq(v.vessel_name)||"").toLowerCase().includes(q) ||
        (bq(v.location_from)||bq(v.next_port)||"").toLowerCase().includes(q) ||
        (String(v.imo_number)||"").includes(q) ||
        (bq(v.shipping_agent)||"").toLowerCase().includes(q)
      );
    }
    if (sortBy === "name") out = [...out].sort((a,b) => (bq(a.vessel_name)||"").localeCompare(bq(b.vessel_name)||""));
    else out = [...out].sort((a,b) => {
      const ta = bq(a[timeField]), tb = bq(b[timeField]);
      if (!ta) return 1; if (!tb) return -1;
      return new Date(tb) - new Date(ta);
    });
    return out;
  }, [search, sortBy]);

  const filteredArrivals   = useMemo(() => filterList(arrivals,   "arrival_time"),   [arrivals, filterList]);
  const filteredDepartures = useMemo(() => filterList([...departures].sort((a,b) => {
    if (a.is_upcoming && !b.is_upcoming) return -1;
    if (!a.is_upcoming && b.is_upcoming) return 1;
    return 0;
  }), "departure_time"), [departures, filterList]);
  const inPortVessels = useMemo(() =>
    vessels.filter(v => parseFloat(v.speed||0) < 0.5 && v.vessel_name)
      .filter(v => !search || (bq(v.vessel_name)||"").toLowerCase().includes(search.toLowerCase()))
      .slice(0, 80),
  [vessels, search]);
  const expectedVessels = useMemo(() =>
    departures.filter(v => v.is_upcoming)
      .filter(v => !search || (bq(v.vessel_name)||"").toLowerCase().includes(search.toLowerCase())),
  [departures, search]);

  return (
    <div ref={panelRef} className={"pa-panel" + (isOpen ? " pa-panel--open" : "")}>

      {/* ── HEADER ── */}
      <div className="pa-header">
        <div className="pa-header-title">
          <div className="pa-header-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00e5ff" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
          </div>
          <div>
            <div className="pa-title-main">PORT OF SINGAPORE</div>
            <div className="pa-title-sub">SGSIN · Live Maritime Activity</div>
          </div>
        </div>
        <div className="pa-header-actions">
          {lastRefresh && <span className="pa-refresh-ts">↻ {timeAgo(lastRefresh)}</span>}
          <button className="pa-icon-btn" onClick={load} disabled={loading} title="Refresh">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={loading ? "pa-spin" : ""}>
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
          <button className="pa-icon-btn pa-close-btn" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {/* ── LIVE STATS BAR ── */}
      <div className="pa-stats-bar">
        <div className="pa-stat-pill pa-stat-green">
          <span className="pa-stat-dot"/>
          <span className="pa-stat-val">{stats.arrivals}</span>
          <span className="pa-stat-label">Arrived</span>
        </div>
        <div className="pa-stat-pill pa-stat-amber">
          <span className="pa-stat-dot"/>
          <span className="pa-stat-val">{stats.departures}</span>
          <span className="pa-stat-label">Departed</span>
        </div>
        <div className="pa-stat-pill pa-stat-cyan">
          <span className="pa-stat-dot"/>
          <span className="pa-stat-val">{stats.inPort}</span>
          <span className="pa-stat-label">In Port</span>
        </div>
        <div className="pa-stat-pill pa-stat-purple">
          <span className="pa-stat-dot"/>
          <span className="pa-stat-val">{stats.upcoming}</span>
          <span className="pa-stat-label">Expected</span>
        </div>
      </div>

      {/* ── SEARCH + FILTER BAR ── */}
      <div className="pa-search-row">
        <div className="pa-search-wrap">
          <svg className="pa-search-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={searchRef}
            className="pa-search-input"
            placeholder="Search vessel, IMO, port, agent…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && <button className="pa-search-clear" onClick={() => setSearch("")}>✕</button>}
        </div>
        <select className="pa-filter-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="time">Latest first</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>

      {/* ── TABS ── */}
      <div className="pa-tabs">
        {TABS.map(t => {
          const count = t.id === "ARRIVALS" ? filteredArrivals.length
                      : t.id === "DEPARTURES" ? filteredDepartures.length
                      : t.id === "IN PORT" ? inPortVessels.length
                      : expectedVessels.length;
          return (
            <button key={t.id} className={"pa-tab" + (tab === t.id ? " pa-tab--on" : "")}
              style={tab === t.id ? {"--tab-color": t.color} : {}}
              onClick={() => setTab(t.id)}>
              <span className="pa-tab-icon" style={tab === t.id ? {color: t.color} : {}}>{t.icon}</span>
              <span className="pa-tab-label">{t.label}</span>
              <span className="pa-tab-count" style={tab === t.id ? {background:`${t.color}18`, borderColor:`${t.color}40`, color:t.color} : {}}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* ── BODY ── */}
      <div className="pa-body">

        {/* ARRIVALS */}
        {tab === "ARRIVALS" && (
          loading && filteredArrivals.length === 0 ? <PASkeleton /> :
          filteredArrivals.length === 0 ? <PAEmpty msg="No arrivals match your search" icon="↓" /> :
          <div className="pa-list">
            {filteredArrivals.map((v, i) => (
              <VesselCard
                key={v.imo_number + "-a-" + i}
                v={v}
                type="arrival"
                isSelected={selectedImo === v.imo_number}
                isExpanded={expanded === (v.imo_number + "-a-" + i)}
                onSelect={() => selectWithNav(v)}
                onExpand={() => setExpanded(expanded === (v.imo_number + "-a-" + i) ? null : (v.imo_number + "-a-" + i))}
                timeField="arrival_time"
                routeFrom={bq(v.location_from)}
                routeTo="Singapore"
                dirColor="#00ff9d"
                dirLabel="ARR"
              />
            ))}
          </div>
        )}

        {/* DEPARTURES */}
        {tab === "DEPARTURES" && (
          loading && filteredDepartures.length === 0 ? <PASkeleton /> :
          filteredDepartures.length === 0 ? <PAEmpty msg="No departures match your search" icon="↑" /> :
          <div className="pa-list">
            {filteredDepartures.map((v, i) => (
              <VesselCard
                key={v.imo_number + "-d-" + i}
                v={v}
                type="departure"
                isSelected={selectedImo === v.imo_number}
                isExpanded={expanded === (v.imo_number + "-d-" + i)}
                onSelect={() => selectWithNav(v)}
                onExpand={() => setExpanded(expanded === (v.imo_number + "-d-" + i) ? null : (v.imo_number + "-d-" + i))}
                timeField="departure_time"
                routeFrom="Singapore"
                routeTo={bq(v.next_port)}
                dirColor={v.is_upcoming ? "#a78bfa" : "#ffaa00"}
                dirLabel={v.is_upcoming ? "EXP" : "DEP"}
              />
            ))}
          </div>
        )}

        {/* IN PORT */}
        {tab === "IN PORT" && (
          loading && inPortVessels.length === 0 ? <PASkeleton /> :
          inPortVessels.length === 0 ? <PAEmpty msg="No vessels in port" icon="⬡" /> :
          <div className="pa-list">
            {inPortVessels.map((v, i) => (
              <InPortCard key={v.imo_number + "-p-" + i} v={v}
                isSelected={selectedImo === v.imo_number}
                onSelect={() => selectWithNav(v)} />
            ))}
          </div>
        )}

        {/* EXPECTED */}
        {tab === "EXPECTED" && (
          loading && expectedVessels.length === 0 ? <PASkeleton /> :
          expectedVessels.length === 0 ? <PAEmpty msg="No expected arrivals" icon="◷" /> :
          <div className="pa-list">
            {expectedVessels.map((v, i) => (
              <VesselCard
                key={v.imo_number + "-e-" + i}
                v={v}
                type="expected"
                isSelected={selectedImo === v.imo_number}
                isExpanded={expanded === (v.imo_number + "-e-" + i)}
                onSelect={() => selectWithNav(v)}
                onExpand={() => setExpanded(expanded === (v.imo_number + "-e-" + i) ? null : (v.imo_number + "-e-" + i))}
                timeField="departure_time"
                routeFrom="Singapore"
                routeTo={bq(v.next_port)}
                dirColor="#a78bfa"
                dirLabel="EXP"
              />
            ))}
          </div>
        )}

      </div>

      {/* ── PORT HEATMAP FOOTER ── */}
      {portStats.length > 0 && (
        <div className="pa-heatmap">
          <div className="pa-heatmap-title">TOP PORTS THIS WEEK</div>
          <div className="pa-heatmap-bars">
            {portStats.slice(0, 6).map((p, i) => {
              const max = Number(portStats[0]?.arrivals_24h || portStats[0]?.arrivals || 1);
              const val = Number(p.arrivals_24h || p.arrivals || 0);
              const pct = Math.round((val / max) * 100);
              return (
                <div key={i} className="pa-heatmap-row">
                  <span className="pa-heatmap-name">{bq(p.port) || "—"}</span>
                  <div className="pa-heatmap-bar-wrap">
                    <div className="pa-heatmap-bar-fill" style={{width: pct + "%", opacity: 0.4 + pct/200}}/>
                  </div>
                  <span className="pa-heatmap-count">{val}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Vessel Card ── */
function VesselCard({ v, type, isSelected, isExpanded, onSelect, onExpand, timeField, routeFrom, routeTo, dirColor, dirLabel }) {
  const name     = bq(v.vessel_name) || "Unknown Vessel";
  const imo      = v.imo_number;
  const flag     = bq(v.flag);
  const agent    = bq(v.shipping_agent);
  const berth    = bq(v.berth_location) || bq(v.berth_grid);
  const crew     = safeNum(v.crew_count);
  const pax      = safeNum(v.passenger_count);
  const purpose  = bq(v.voyage_purpose);
  const src      = bq(v.arrival_source || v.departure_source);
  const sc       = srcColor(src);
  const rawTs    = bq(v[timeField]);
  const rel      = timeRelative(rawTs);
  const vtype    = bq(v.vessel_type);
  const ico      = vesselTypeIcon(vtype);
  const dq       = safeNum(v.data_quality_score);
  const isUpcoming = v.is_upcoming;

  return (
    <div
      className={"pa-card" + (isSelected ? " pa-card--sel" : "") + (isUpcoming ? " pa-card--upcoming" : "")}
      style={{"--dir-color": dirColor}}
      onClick={onSelect}
    >
      {/* Direction stripe */}
      <div className="pa-card-stripe"/>

      <div className="pa-card-main">
        {/* Row 1: flag + name + dir badge */}
        <div className="pa-card-top">
          <span className="pa-card-flag">{getFlagEmoji(flag)}</span>
          <div className="pa-card-identity">
            <div className="pa-card-name">{ico} {name}</div>
            <div className="pa-card-imo">IMO {imo || "—"}</div>
          </div>
          <div className="pa-card-badges">
            <span className="pa-dir-badge" style={{background:`${dirColor}18`,borderColor:`${dirColor}40`,color:dirColor}}>
              {dirLabel}
            </span>
            <span className="pa-src-badge2" style={{background:sc.bg, borderColor:sc.border, color:sc.text}}>
              {sc.label}
            </span>
          </div>
        </div>

        {/* Row 2: route */}
        {(routeFrom || routeTo) && (
          <div className="pa-card-route">
            {routeFrom && <span className="pa-route-node pa-route-from">{routeFrom}</span>}
            <span className="pa-route-line">
              <svg width="40" height="8" viewBox="0 0 40 8">
                <line x1="0" y1="4" x2="34" y2="4" stroke={dirColor} strokeWidth="1" strokeOpacity="0.5" strokeDasharray="3,2"/>
                <polygon points="34,1 40,4 34,7" fill={dirColor} fillOpacity="0.8"/>
              </svg>
            </span>
            {routeTo && <span className="pa-route-node pa-route-to" style={{borderColor:`${dirColor}30`,color:dirColor}}>{routeTo}</span>}
          </div>
        )}

        {/* Row 3: time + meta */}
        <div className="pa-card-meta">
          {rel && (
            <span className={"pa-time-chip" + (rel.urgent ? " pa-time-urgent" : "")} style={rel.future ? {color:"#a78bfa"} : {}}>
              {rel.label}
            </span>
          )}
          {!rel && rawTs && <span className="pa-time-chip">{formatTimestamp(rawTs)}</span>}
          {berth  && <span className="pa-meta-chip">🏗 {berth}</span>}
          {crew   && <span className="pa-meta-chip">👥 {crew}</span>}
          {pax    && <span className="pa-meta-chip">🧑‍✈️ {pax}</span>}
          {purpose && <span className="pa-meta-chip">{purpose}</span>}
        </div>

        {/* Expandable detail */}
        {isExpanded && (
          <div className="pa-card-detail" onClick={e => e.stopPropagation()}>
            {agent && (
              <div className="pa-detail-row">
                <span className="pa-detail-label">Agent</span>
                <span className="pa-detail-val">{agent}</span>
              </div>
            )}
            {dq != null && (
              <div className="pa-detail-row">
                <span className="pa-detail-label">Data Quality</span>
                <div className="pa-dq-inline">
                  <div className="pa-dq-bar-sm">
                    <div className="pa-dq-fill-sm" style={{width:`${dq}%`, background: dq>=80?"#00ff9d":dq>=50?"#ffaa00":"#ff4466"}}/>
                  </div>
                  <span style={{color: dq>=80?"#00ff9d":dq>=50?"#ffaa00":"#ff4466"}}>{dq}/100</span>
                </div>
              </div>
            )}
            <button className="pa-track-btn" onClick={() => {/* handled by parent click */}}>
              📍 Track on Map
            </button>
          </div>
        )}
      </div>

      {/* Expand toggle */}
      <button className={"pa-expand-btn" + (isExpanded ? " pa-expand-btn--open" : "")}
        onClick={e => { e.stopPropagation(); onExpand(); }}>
        ›
      </button>
    </div>
  );
}

/* ── In-Port Card (from live vessel data) ── */
function InPortCard({ v, isSelected, onSelect }) {
  const name    = bq(v.vessel_name) || "Unknown";
  const flag    = bq(v.flag);
  const berth   = bq(v.berth_location);
  const agent   = bq(v.shipping_agent);
  const hoursIn = safeNum(v.hours_in_port_so_far);
  const portTime= safeNum(v.port_time_hours);
  const pctDone = (hoursIn && portTime && portTime > 0) ? Math.min(Math.round(hoursIn / portTime * 100), 100) : null;
  const vtype   = bq(v.vessel_type);
  const ico     = vesselTypeIcon(vtype);

  return (
    <div className={"pa-card pa-card--inport" + (isSelected ? " pa-card--sel" : "")}
      style={{"--dir-color": "#00e5ff"}} onClick={onSelect}>
      <div className="pa-card-stripe"/>
      <div className="pa-card-main">
        <div className="pa-card-top">
          <span className="pa-card-flag">{getFlagEmoji(flag)}</span>
          <div className="pa-card-identity">
            <div className="pa-card-name">{ico} {name}</div>
            <div className="pa-card-imo">IMO {v.imo_number || "—"}</div>
          </div>
          <div className="pa-card-badges">
            <span className="pa-inport-badge">IN PORT</span>
          </div>
        </div>
        <div className="pa-card-meta">
          {hoursIn != null && <span className="pa-meta-chip">⏱ {hoursIn.toFixed(1)}h in port</span>}
          {berth && <span className="pa-meta-chip">🏗 {berth}</span>}
          {agent && <span className="pa-meta-chip">{agent}</span>}
        </div>
        {pctDone != null && (
          <div className="pa-berth-progress">
            <div className="pa-bp-track">
              <div className="pa-bp-fill" style={{width: pctDone + "%"}}/>
              <div className="pa-bp-dot" style={{left: pctDone + "%"}}/>
            </div>
            <span className="pa-bp-label">{pctDone}% of scheduled port time</span>
          </div>
        )}
      </div>
    </div>
  );
}

function PASkeleton() {
  return (
    <div className="pa-skel-wrap">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="pa-skel" style={{ animationDelay: i * 0.08 + "s", height: i % 2 === 0 ? "78px" : "66px" }}/>
      ))}
    </div>
  );
}

function PAEmpty({ msg, icon }) {
  return (
    <div className="pa-empty">
      <div className="pa-empty-icon">{icon}</div>
      <span>{msg}</span>
    </div>
  );
}