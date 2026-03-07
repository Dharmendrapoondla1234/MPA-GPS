// src/components/PortActivityPanel.jsx — MPA Advanced v6
import React, { useState, useEffect, useCallback } from "react";
import { fetchArrivals, fetchDepartures, fetchPortActivity } from "../services/api";
import { getFlagEmoji, formatTimestamp, timeAgo } from "../utils/vesselUtils";
import "./PortActivityPanel.css";

const TABS = ["ARRIVALS", "DEPARTURES", "PORTS"];

function bq(v) {
  if (v == null) return null;
  if (typeof v === "object" && "value" in v) return String(v.value).trim() || null;
  return String(v).trim() || null;
}

export default function PortActivityPanel({ onSelectVessel, selectedImo }) {
  const [tab,        setTab]        = useState("ARRIVALS");
  const [arrivals,   setArrivals]   = useState([]);
  const [departures, setDepartures] = useState([]);
  const [portStats,  setPortStats]  = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [lastRefresh,setLastRefresh]= useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [arr, dep, ports] = await Promise.all([
        fetchArrivals(60),
        fetchDepartures(60),
        fetchPortActivity(),
      ]);
      if (Array.isArray(arr))   setArrivals(arr);
      if (Array.isArray(dep))   setDepartures(dep);
      if (Array.isArray(ports)) setPortStats(ports);
      setLastRefresh(new Date());
    } catch(e) { console.warn("[PortActivity]", e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const t=setInterval(load,300_000); return ()=>clearInterval(t); }, [load]);

  const srcBadge = (src) => {
    const map = { DECLARATION:"📋 Declared", AIS_CONFIRMED:"📡 AIS", SCHEDULED:"🕐 Scheduled" };
    const cls  = { DECLARATION:"src-decl",   AIS_CONFIRMED:"src-ais",   SCHEDULED:"src-sched" };
    return <span className={`pa-src-badge ${cls[src]||""}`}>{map[src]||src}</span>;
  };

  return (
    <div className="pa-root">
      <div className="pa-header">
        <div className="pa-title">
          <span className="pa-icon">⚓</span>
          PORT ACTIVITY
          {lastRefresh && <span className="pa-refresh-time">{timeAgo(lastRefresh)}</span>}
        </div>
        <button className="pa-reload" onClick={load} disabled={loading} title="Refresh">
          <span className={loading ? "pa-spin" : ""}>↺</span>
        </button>
      </div>

      <div className="pa-tabs">
        {TABS.map(t => (
          <button key={t} className={`pa-tab ${tab===t?"on":""}`} onClick={()=>setTab(t)}>
            {t === "ARRIVALS"   && `✈ ${arrivals.length||""}`}
            {t === "DEPARTURES" && `🚢 ${departures.length||""}`}
            {t === "PORTS"      && `🏛 ${portStats.length||""}`}
            <span className="pa-tab-label">{t}</span>
          </button>
        ))}
      </div>

      <div className="pa-body">

        {/* ══ ARRIVALS ══ */}
        {tab === "ARRIVALS" && (
          loading && arrivals.length===0 ? <Skeleton /> : arrivals.length===0 ? <Empty msg="No recent arrivals" /> : (
            <div className="pa-list">
              {arrivals.map((v,i) => (
                <div
                  key={`${v.imo_number}-${i}`}
                  className={`pa-item ${selectedImo===v.imo_number?"selected":""}`}
                  onClick={() => onSelectVessel && v.imo_number && onSelectVessel({ imo_number:v.imo_number, vessel_name:v.vessel_name, flag:v.flag })}
                >
                  <div className="pa-item-top">
                    <span className="pa-flag">{getFlagEmoji(bq(v.flag))}</span>
                    <div className="pa-item-info">
                      <div className="pa-item-name">{bq(v.vessel_name)||"Unknown Vessel"}</div>
                      <div className="pa-item-sub mono">IMO {v.imo_number||"—"} · {bq(v.call_sign)||"—"}</div>
                    </div>
                    {srcBadge(bq(v.arrival_source))}
                  </div>
                  <div className="pa-item-route">
                    {bq(v.location_from) && <span className="pa-from">⚓ {bq(v.location_from)}</span>}
                    {bq(v.location_from) && bq(v.location_to) && <span className="pa-arrow">→</span>}
                    {bq(v.location_to)   && <span className="pa-to">🏁 {bq(v.location_to)}</span>}
                  </div>
                  <div className="pa-item-meta">
                    <span className="pa-time">{formatTimestamp(bq(v.arrival_time))}</span>
                    {bq(v.berth_grid)     && <span className="pa-chip">Grid: {bq(v.berth_grid)}</span>}
                    {v.crew_count         && <span className="pa-chip">👥 {Number(v.crew_count)}</span>}
                    {bq(v.voyage_purpose) && <span className="pa-chip">{bq(v.voyage_purpose)}</span>}
                    {bq(v.shipping_agent) && <span className="pa-agent">🏢 {bq(v.shipping_agent)}</span>}
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {/* ══ DEPARTURES ══ */}
        {tab === "DEPARTURES" && (
          loading && departures.length===0 ? <Skeleton /> : departures.length===0 ? <Empty msg="No recent departures" /> : (
            <div className="pa-list">
              {departures.map((v,i) => (
                <div
                  key={`${v.imo_number}-${i}`}
                  className={`pa-item ${selectedImo===v.imo_number?"selected":""}`}
                  onClick={() => onSelectVessel && v.imo_number && onSelectVessel({ imo_number:v.imo_number, vessel_name:v.vessel_name, flag:v.flag })}
                >
                  <div className="pa-item-top">
                    <span className="pa-flag">{getFlagEmoji(bq(v.flag))}</span>
                    <div className="pa-item-info">
                      <div className="pa-item-name">{bq(v.vessel_name)||"Unknown Vessel"}</div>
                      <div className="pa-item-sub mono">IMO {v.imo_number||"—"} · {bq(v.call_sign)||"—"}</div>
                    </div>
                    {srcBadge(bq(v.departure_source))}
                  </div>
                  {bq(v.next_port) && (
                    <div className="pa-item-route">
                      <span className="pa-to">🏁 Bound for: <strong>{bq(v.next_port)}</strong></span>
                    </div>
                  )}
                  <div className="pa-item-meta">
                    <span className="pa-time">{formatTimestamp(bq(v.departure_time))}</span>
                    {v.crew_count         && <span className="pa-chip">👥 {Number(v.crew_count)}</span>}
                    {v.passenger_count    && <span className="pa-chip">🧑‍✈️ {Number(v.passenger_count)} pax</span>}
                    {bq(v.shipping_agent) && <span className="pa-agent">🏢 {bq(v.shipping_agent)}</span>}
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {/* ══ PORT STATS ══ */}
        {tab === "PORTS" && (
          loading && portStats.length===0 ? <Skeleton /> : portStats.length===0 ? <Empty msg="No port data" /> : (
            <div className="pa-ports-list">
              {portStats.slice(0,20).map((p,i) => {
                const portName = bq(p.port) || "Unknown";
                const count    = Number(p.arrivals)||0;
                const maxCount = Number(portStats[0]?.arrivals)||1;
                const pct      = Math.round((count/maxCount)*100);
                return (
                  <div key={i} className="pa-port-item">
                    <div className="pa-port-top">
                      <span className="pa-port-rank">#{i+1}</span>
                      <span className="pa-port-name">{portName}</span>
                      <span className="pa-port-src">{bq(p.arrival_source)}</span>
                      <span className="pa-port-count mono">{count}</span>
                    </div>
                    <div className="pa-port-bar">
                      <div className="pa-port-fill" style={{width:`${pct}%`}}/>
                    </div>
                    <div className="pa-port-meta">
                      <span>Last: {formatTimestamp(bq(p.last_arrival))}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="pa-skel-wrap">
      {[...Array(6)].map((_,i)=>(
        <div key={i} className="pa-skel" style={{animationDelay:`${i*0.08}s`}}/>
      ))}
    </div>
  );
}

function Empty({ msg }) {
  return <div className="pa-empty"><div className="pa-empty-icon">⚓</div><div>{msg}</div></div>;
}