// src/components/PortActivityPanel.jsx — FloatingPanel v2
import React, { useState, useEffect, useCallback, useRef } from "react";
import { fetchArrivals, fetchDepartures, fetchPortActivity } from "../services/api";
import { getFlagEmoji, formatTimestamp, timeAgo } from "../utils/vesselUtils";
import "./PortActivityPanel.css";

function bq(v) {
  if (v == null) return null;
  if (typeof v === "object" && "value" in v) return String(v.value).trim() || null;
  return String(v).trim() || null;
}

export function PortActivityTrigger({ onClick, arrivals, departures, isOpen }) {
  const total = (arrivals || 0) + (departures || 0);
  return (
    <button
      className={"pa-trigger" + (isOpen ? " pa-trigger--open" : "")}
      onClick={onClick}
      title="Port Activity"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
      {total > 0 && <span className="pa-trigger-badge">{total > 99 ? "99+" : total}</span>}
      <span className="pa-trigger-label">PORT</span>
    </button>
  );
}

export default function PortActivityPanel({ onSelectVessel, selectedImo, isOpen, onClose, vessels = [] }) {
  const [tab,        setTab]        = useState("ARRIVALS");
  const [arrivals,   setArrivals]   = useState([]);
  const [departures, setDepartures] = useState([]);
  const [portStats,  setPortStats]  = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [lastRefresh,setLastRefresh]= useState(null);
  const panelRef = useRef(null);

  // Look up live position from vessels array, fall back to record fields
  const selectWithNav = useCallback((record) => {
    if (!onSelectVessel || !record?.imo_number) return;
    const live = vessels.find(v => String(v.imo_number) === String(record.imo_number));
    onSelectVessel(live || record);
  }, [vessels, onSelectVessel]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [arr, dep, ports] = await Promise.all([
        fetchArrivals(100), fetchDepartures(100), fetchPortActivity(),
      ]);
      if (Array.isArray(arr))   setArrivals(arr);
      if (Array.isArray(dep))   setDepartures(dep);
      if (Array.isArray(ports)) setPortStats(ports);
      setLastRefresh(new Date());
    } catch(e) { console.warn("[PortActivity]", e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 90_000); return () => clearInterval(t); }, [load]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target) && !e.target.closest(".pa-trigger")) {
        onClose?.();
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => { document.removeEventListener("mousedown", handler); document.removeEventListener("touchstart", handler); };
  }, [isOpen, onClose]);

  const srcBadge = (src) => {
    const map = { DECLARATION:"DECL", AIS_CONFIRMED:"AIS", SCHEDULED:"SCHED" };
    const cls  = { DECLARATION:"src-decl", AIS_CONFIRMED:"src-ais", SCHEDULED:"src-sched" };
    return <span className={"pa-src-badge " + (cls[src] || "")}>{map[src] || src || "—"}</span>;
  };

  return (
    <div ref={panelRef} className={"pa-panel" + (isOpen ? " pa-panel--open" : "")}>
      <div className="pa-header">
        <div className="pa-header-left">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#00e5ff" strokeWidth="2">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
          </svg>
          <span className="pa-title-text">PORT ACTIVITY</span>
          {lastRefresh && <span className="pa-refresh-ts">{timeAgo(lastRefresh)}</span>}
        </div>
        <div className="pa-header-right">
          <button className="pa-icon-btn" onClick={load} disabled={loading} title="Refresh">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={loading ? "pa-spin" : ""}>
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
          <button className="pa-icon-btn pa-close-btn" onClick={onClose} title="Close">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="pa-tabs">
        {[
          { id:"ARRIVALS",   icon:"↓", count: arrivals.length },
          { id:"DEPARTURES", icon:"↑", count: departures.length },
          { id:"PORTS",      icon:"⬡", count: portStats.length },
        ].map(t => (
          <button key={t.id} className={"pa-tab" + (tab === t.id ? " pa-tab--on" : "")} onClick={() => setTab(t.id)}>
            <span className="pa-tab-icon">{t.icon}</span>
            <span className="pa-tab-label">{t.id}</span>
            <span className="pa-tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      <div className="pa-body">
        {tab === "ARRIVALS" && (
          loading && arrivals.length === 0 ? <PASkeleton /> :
          arrivals.length === 0 ? <PAEmpty msg="No recent arrivals" /> :
          <div className="pa-list">
            {arrivals.map((v, i) => (
              <div key={v.imo_number + "-" + i}
                className={"pa-item" + (selectedImo === v.imo_number ? " pa-item--sel" : "")}
                onClick={() => selectWithNav(v)}>
                <div className="pa-item-row">
                  <span className="pa-item-flag">{getFlagEmoji(bq(v.flag))}</span>
                  <div className="pa-item-info">
                    <div className="pa-item-name">{bq(v.vessel_name) || "Unknown"}</div>
                    <div className="pa-item-imo">IMO {v.imo_number || "—"}</div>
                  </div>
                  {srcBadge(bq(v.arrival_source))}
                </div>
                {(bq(v.location_from) || bq(v.location_to)) && (
                  <div className="pa-route">
                    {bq(v.location_from) && <span className="pa-route-from">{bq(v.location_from)}</span>}
                    {bq(v.location_from) && bq(v.location_to) && <span className="pa-route-arr">→</span>}
                    {bq(v.location_to) && <span className="pa-route-to">{bq(v.location_to)}</span>}
                  </div>
                )}
                <div className="pa-meta">
                  <span className="pa-meta-time">{formatTimestamp(bq(v.arrival_time))}</span>
                  {bq(v.berth_grid) && <span className="pa-chip">Grid {bq(v.berth_grid)}</span>}
                  {v.crew_count && <span className="pa-chip">👥 {Number(v.crew_count)}</span>}
                  {bq(v.voyage_purpose) && <span className="pa-chip">{bq(v.voyage_purpose)}</span>}
                </div>
                {bq(v.shipping_agent) && <div className="pa-agent">🏢 {bq(v.shipping_agent)}</div>}
              </div>
            ))}
          </div>
        )}

        {tab === "DEPARTURES" && (
          loading && departures.length === 0 ? <PASkeleton /> :
          departures.length === 0 ? <PAEmpty msg="No recent departures" /> :
          <div className="pa-list">
            {[...departures].sort((a,b) => {
              // Upcoming first, then sort by departure_time ascending
              if (a.is_upcoming && !b.is_upcoming) return -1;
              if (!a.is_upcoming && b.is_upcoming) return 1;
              return new Date(bq(a.departure_time)||0) - new Date(bq(b.departure_time)||0);
            }).map((v, i) => (
              <div key={v.imo_number + "-" + i}
                className={"pa-item" + (selectedImo === v.imo_number ? " pa-item--sel" : "")}
                onClick={() => selectWithNav(v)}>
                <div className="pa-item-row">
                  <span className="pa-item-flag">{getFlagEmoji(bq(v.flag))}</span>
                  <div className="pa-item-info">
                    <div className="pa-item-name">{bq(v.vessel_name) || "Unknown"}</div>
                    <div className="pa-item-imo">IMO {v.imo_number || "—"}</div>
                  </div>
                  {srcBadge(bq(v.departure_source))}
                  {v.is_upcoming && <span className="pa-upcoming-badge">UPCOMING</span>}
                </div>
                {bq(v.next_port) && (
                  <div className="pa-route">
                    <span className="pa-route-arr">→</span>
                    <span className="pa-route-to">{bq(v.next_port)}</span>
                  </div>
                )}
                <div className="pa-meta">
                  <span className="pa-meta-time">{formatTimestamp(bq(v.departure_time))}</span>
                  {v.crew_count && <span className="pa-chip">👥 {Number(v.crew_count)}</span>}
                  {v.passenger_count && <span className="pa-chip">🧑‍✈️ {Number(v.passenger_count)}</span>}
                </div>
                {bq(v.shipping_agent) && <div className="pa-agent">🏢 {bq(v.shipping_agent)}</div>}
              </div>
            ))}
          </div>
        )}

        {tab === "PORTS" && (
          loading && portStats.length === 0 ? <PASkeleton /> :
          portStats.length === 0 ? <PAEmpty msg="No port data" /> :
          <div className="pa-ports-list">
            {portStats.slice(0, 20).map((p, i) => {
              const count    = Number(p.arrivals)    || 0;
              const count24h = Number(p.arrivals_24h) || 0;
              const pct      = Math.round((count24h > 0 ? count24h : count) / Math.max(Number(portStats[0]?.arrivals_24h || portStats[0]?.arrivals) || 1, 1) * 100);
              return (
                <div key={i} className="pa-port-item">
                  <div className="pa-port-row">
                    <span className="pa-port-rank">#{i + 1}</span>
                    <span className="pa-port-name">{bq(p.port) || "Unknown"}</span>
                    <div className="pa-port-counts">
                      {count24h > 0 && <span className="pa-port-count-24h">{count24h} <span className="pa-port-24h-label">24H</span></span>}
                      <span className="pa-port-count">{count}</span>
                    </div>
                  </div>
                  <div className="pa-port-bar"><div className="pa-port-fill" style={{ width: pct + "%" }}/></div>
                  <div className="pa-port-meta">
                    <span className="pa-port-last">Last: {formatTimestamp(bq(p.last_arrival))}</span>
                    <span className="pa-port-src">{bq(p.arrival_source) || "AIS"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PASkeleton() {
  return (
    <div className="pa-skel-wrap">
      {[...Array(5)].map((_, i) => <div key={i} className="pa-skel" style={{ animationDelay: i * 0.07 + "s" }}/>)}
    </div>
  );
}
function PAEmpty({ msg }) {
  return (
    <div className="pa-empty">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="rgba(0,229,255,0.2)" strokeWidth="1.5">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
      <span>{msg}</span>
    </div>
  );
}