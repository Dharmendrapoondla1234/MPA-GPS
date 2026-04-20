// src/components/PortActivityPanel.jsx — v5 "Upcoming Focus"
// Shows ONLY upcoming arrivals & departures (future timestamps).
// Unlimited results, day-range filter (1 / 3 / 7 / 14 / 30 days).
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { fetchArrivals, fetchDepartures,   fetchVesselDetail } from "../services/api";
import { getFlagEmoji, formatTimestamp, getVesselTypeLabel } from "../utils/vesselUtils";
import "./PortActivityPanel.css";

function bq(v) {
  if (v == null) return null;
  if (typeof v === "object" && "value" in v) return String(v.value).trim() || null;
  return String(v).trim() || null;
}
function safeNum(v) { const n = Number(v); return isNaN(n) ? null : n; }

const TYPE_GROUPS = [
  { label:"Container", keys:["container"], color:"#00e5ff",  icon:"📦" },
  { label:"Tanker",    keys:["tanker","lng","chemical","crude"], color:"#ffaa00", icon:"🛢️" },
  { label:"Bulk",      keys:["bulk"],      color:"#00ff9d",  icon:"⚓" },
  { label:"Cargo",     keys:["cargo","general"], color:"#a78bfa", icon:"🚢" },
  { label:"Other",     keys:[],            color:"#607d8b",  icon:"⬡" },
];

function getTypeGroup(typeCode) {
  const label = (getVesselTypeLabel(typeCode) || "").toLowerCase();
  for (const g of TYPE_GROUPS.slice(0, -1)) {
    if (g.keys.some(k => label.includes(k))) return g;
  }
  return TYPE_GROUPS[TYPE_GROUPS.length - 1];
}

function srcColor(src) {
  if (src === "DECLARATION")   return { bg:"rgba(0,229,255,0.10)",  border:"rgba(0,229,255,0.30)",  text:"#00e5ff", label:"DECL" };
  if (src === "AIS_CONFIRMED") return { bg:"rgba(38,222,129,0.10)", border:"rgba(38,222,129,0.30)", text:"#26de81", label:"AIS" };
  if (src === "SCHEDULED")     return { bg:"rgba(253,150,68,0.10)", border:"rgba(253,150,68,0.30)", text:"#fd9644", label:"SCHED" };
  return { bg:"rgba(120,160,200,0.06)", border:"rgba(120,160,200,0.15)", text:"#88aabb", label:src||"—" };
}

function timeRelative(ts) {
  if (!ts) return null;
  try {
    const d = new Date(ts), diff = Date.now() - d.getTime(), abs = Math.abs(diff);
    if (abs < 60000)    return { label:"just now", future:false, urgent:false };
    if (abs < 3600000)  { const m=Math.round(abs/60000); return { label:diff>0?`${m}m ago`:`in ${m}m`, future:diff<0, urgent:diff<0&&m<30 }; }
    if (abs < 86400000) { const h=(abs/3600000).toFixed(1); return { label:diff>0?`${h}h ago`:`in ${h}h`, future:diff<0, urgent:false }; }
    const days = Math.round(abs/86400000);
    return { label:diff>0?`${days}d ago`:`in ${days}d`, future:diff<0, urgent:false };
  } catch { return null; }
}

// Day range options for the filter
const DAY_OPTIONS = [
  { value:1,  label:"Today" },
  { value:3,  label:"3 Days" },
  { value:7,  label:"7 Days" },
  { value:14, label:"14 Days" },
  { value:30, label:"30 Days" },
];

export function PortActivityTrigger({ onClick, arrivals, departures, isOpen }) {
  const total = (arrivals||0)+(departures||0);
  return (
    <button className={"pa-trigger"+(isOpen?" pa-trigger--open":"")} onClick={onClick} title="Port Activity">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
      {total>0 && <span className="pa-trigger-badge">{total>99?"99+":total}</span>}
      <span className="pa-trigger-label">PORT</span>
    </button>
  );
}

const TABS = [
  { id:"ARRIVALS",   icon:"↓", label:"Arrivals",   color:"#00ff9d" },
  { id:"DEPARTURES", icon:"↑", label:"Departures", color:"#ffaa00" },
  { id:"IN PORT",    icon:"⬡", label:"In Port",    color:"#38bdf8" },
];

export default function PortActivityPanel({ onSelectVessel, selectedImo, isOpen, onClose, vessels=[] }) {
  const [tab,        setTab]        = useState("ARRIVALS");
  const [arrivals,   setArrivals]   = useState([]);
  const [departures, setDepartures] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [lastRefresh,setLastRefresh]= useState(null);
  const [search,     setSearch]     = useState("");
  const [flagFilter, setFlagFilter] = useState("");
  const [sortBy,     setSortBy]     = useState("time");
  const [days,       setDays]       = useState(7);   // day-range filter
  const [expanded,   setExpanded]   = useState(null);
  const [loadingVessel, setLoadingVessel] = useState(null);
  const panelRef  = useRef(null);
  const searchRef = useRef(null);

  const mergeRecordOntoVessel = useCallback((live, record) => {
    if (!live) return null;
    return {
      ...live,
      berth_location:        live.berth_location        || bq(record.berth_location) || bq(record.berth_grid),
      shipping_agent:        live.shipping_agent         || bq(record.shipping_agent),
      voyage_purpose:        live.voyage_purpose         || bq(record.voyage_purpose),
      last_port_departed:    live.last_port_departed     || bq(record.location_from),
      next_port_destination: live.next_port_destination  || bq(record.next_port),
      declared_arrival_time: live.declared_arrival_time  || bq(record.arrival_time) || bq(record.departure_time),
      crew_count:            live.crew_count             ?? record.crew_count,
    };
  }, []);

  const selectWithNav = useCallback(async (record) => {
    if (!onSelectVessel || !record?.imo_number) return;
    const live = vessels.find(v => String(v.imo_number) === String(record.imo_number));
    if (live) { onSelectVessel(mergeRecordOntoVessel(live, record)); return; }
    setLoadingVessel(String(record.imo_number));
    try {
      const res    = await fetchVesselDetail(record.imo_number);
      const detail = res?.data || res;
      onSelectVessel(detail?.imo_number ? mergeRecordOntoVessel(detail, record) : record);
    } catch { onSelectVessel(record); }
    finally { setLoadingVessel(null); }
  }, [vessels, onSelectVessel, mergeRecordOntoVessel]);

  const load = useCallback(async (dayOverride) => {
    const d = dayOverride ?? days;
    setLoading(true);
    try {
      const [arr, dep] = await Promise.all([
        fetchArrivals(2000, d, true),
        fetchDepartures(2000, d, true),
      ]);
      // Show only upcoming records within the selected day range
      const now = Date.now();
      const cutoff = now + d * 24 * 60 * 60 * 1000;
      const isUpcoming = (ts) => {
        if (!ts) return false;
        const t = new Date(typeof ts === 'object' && 'value' in ts ? ts.value : ts).getTime();
        return t >= now && t <= cutoff;
      };

      if (Array.isArray(arr)) {
        setArrivals(arr.filter(v => isUpcoming(v.arrival_time)));
      }
      if (Array.isArray(dep)) {
        setDepartures(dep.filter(v => isUpcoming(v.departure_time)));
      }
      setLastRefresh(new Date());
    } catch(e) { console.warn("[PortActivity]", e.message); }
    finally { setLoading(false); }
  }, [days]);

  // Reload when days filter changes
  useEffect(() => { load(days); }, [days]); // eslint-disable-line
  // Auto-refresh every 60s
  useEffect(() => {
    const t = setInterval(() => load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!isOpen) return;
    const h = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target) && !e.target.closest(".pa-trigger")) onClose?.();
    };
    document.addEventListener("mousedown", h); document.addEventListener("touchstart", h);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("touchstart", h); };
  }, [isOpen, onClose]);

  const uniqueFlags = useMemo(() => {
    const all = [...arrivals, ...departures].map(v => bq(v.flag)).filter(Boolean);
    return [...new Set(all)].sort();
  }, [arrivals, departures]);

  const inPortVessels = useMemo(() =>
    vessels
      .filter(v => parseFloat(v.speed||0) < 0.5 && v.vessel_name)
      .filter(v => !search || (bq(v.vessel_name)||"").toLowerCase().includes(search.toLowerCase()))
      .filter(v => !flagFilter || bq(v.flag) === flagFilter),
  [vessels, search, flagFilter]);

  const filterList = useCallback((list, timeField) => {
    let out = list;
    if (flagFilter) out = out.filter(v => bq(v.flag) === flagFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(v =>
        (bq(v.vessel_name)||"").toLowerCase().includes(q) ||
        (bq(v.location_from)||bq(v.next_port)||"").toLowerCase().includes(q) ||
        String(v.imo_number||"").includes(q) ||
        (bq(v.shipping_agent)||"").toLowerCase().includes(q)
      );
    }
    if (sortBy === "name") return [...out].sort((a,b)=>(bq(a.vessel_name)||"").localeCompare(bq(b.vessel_name)||""));
    return [...out].sort((a,b) => {
      const ta=bq(a[timeField]), tb=bq(b[timeField]);
      if (!ta) return 1; if (!tb) return -1;
      return new Date(ta) - new Date(tb); // soonest first
    });
  }, [search, sortBy, flagFilter]);

  const filteredArrivals   = useMemo(() => filterList(arrivals,   "arrival_time"),   [arrivals,   filterList]);
  const filteredDepartures = useMemo(() => filterList(departures,  "departure_time"), [departures, filterList]);

  // CSV export
  const exportCSV = useCallback((list, type) => {
    const isArr = type === "arrivals";
    const cols = isArr
      ? [["IMO","imo_number"],["Vessel","vessel_name"],["Flag","flag"],["From","location_from"],
         ["Arrival Time","arrival_time"],["Berth","berth_grid"],["Agent","shipping_agent"],["Source","arrival_source"]]
      : [["IMO","imo_number"],["Vessel","vessel_name"],["Flag","flag"],["Next Port","next_port"],
         ["Departure Time","departure_time"],["Agent","shipping_agent"],["Source","departure_source"]];
    const csv = [cols.map(([h])=>h).join(","),
      ...list.map(v=>cols.map(([,k])=>{ const val=bq(v[k])??v[k]; return val!=null?`"${String(val).replace(/"/g,'""')}"`:""}).join(","))
    ].join("\n");
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([csv],{type:"text/csv"})),
      download: `upcoming_${type}_${new Date().toISOString().slice(0,10)}.csv`
    });
    a.click(); URL.revokeObjectURL(a.href);
  }, []);

  const timeAgo = (d) => {
    if (!d) return "";
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 10) return "just now";
    if (s < 60) return `${s}s ago`;
    return `${Math.round(s/60)}m ago`;
  };

  return (
    <div ref={panelRef} className={"pa-panel"+(isOpen?" pa-panel--open":"")}>

      {/* ══ HEADER ══ */}
      <div className="pa-header">
        <div className="pa-header-left">
          <div className="pa-port-emblem">
            <div className="pa-emblem-ring"/>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#00e5ff" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
          </div>
          <div className="pa-header-text">
            <div className="pa-title-main">
              <span className="pa-flag-sg">🇸🇬</span> PORT OF SINGAPORE
            </div>
            <div className="pa-title-sub">
              <span className="pa-locode">SGSIN</span>
              <span className="pa-dot-sep">·</span>
              <span className="pa-live-dot-inline"/>
              <span>Upcoming Traffic</span>
            </div>
          </div>
        </div>
        <div className="pa-header-right">
          {lastRefresh && <span className="pa-refresh-ts">↻ {timeAgo(lastRefresh)}</span>}
          <button className="pa-icon-btn" onClick={()=>load()} disabled={loading} title="Refresh">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={loading?"pa-spin":""}>
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
          <button className="pa-icon-btn pa-close-btn" onClick={onClose}>✕</button>
        </div>
      </div>

      {/* ══ STATS TICKER ══ */}
      <div className="pa-ticker">
        <StatPill color="#00ff9d" val={filteredArrivals.length}   label="Arriving"  onClick={()=>setTab("ARRIVALS")}   active={tab==="ARRIVALS"} />
        <StatPill color="#ffaa00" val={filteredDepartures.length} label="Departing" onClick={()=>setTab("DEPARTURES")} active={tab==="DEPARTURES"} />
        <StatPill color="#38bdf8" val={inPortVessels.length}      label="In Port"   onClick={()=>setTab("IN PORT")}    active={tab==="IN PORT"} />
      </div>

      {/* ══ DAY RANGE + SEARCH ROW ══ */}
      <div className="pa-filter-row">
        {/* Days filter pills */}
        <div className="pa-day-pills">
          <span className="pa-day-label">Next:</span>
          {DAY_OPTIONS.map(opt => (
            <button
              key={opt.value}
              className={"pa-day-pill"+(days===opt.value?" pa-day-pill--on":"")}
              onClick={()=>{ setDays(opt.value); }}
            >{opt.label}</button>
          ))}
        </div>
      </div>

      <div className="pa-search-row">
        <div className="pa-search-wrap">
          <svg className="pa-search-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input ref={searchRef} className="pa-search-input"
            placeholder="Vessel name, IMO, port, agent…"
            value={search} onChange={e=>setSearch(e.target.value)}/>
          {search && <button className="pa-search-clear" onClick={()=>setSearch("")}>✕</button>}
        </div>
        <select className="pa-sort-select" value={sortBy} onChange={e=>setSortBy(e.target.value)}>
          <option value="time">Soonest</option>
          <option value="name">Name A–Z</option>
        </select>
        <select className="pa-sort-select pa-flag-filter" value={flagFilter} onChange={e=>setFlagFilter(e.target.value)} title="Filter by flag">
          <option value="">🏴 All flags</option>
          {uniqueFlags.map(f=><option key={f} value={f}>{f}</option>)}
        </select>
        {(tab==="ARRIVALS"||tab==="DEPARTURES") && (
          <button className="pa-download-btn"
            onClick={()=>exportCSV(tab==="ARRIVALS"?filteredArrivals:filteredDepartures, tab==="ARRIVALS"?"arrivals":"departures")}
            title="Download as CSV">⬇</button>
        )}
      </div>

      {/* ══ TABS ══ */}
      <div className="pa-tabs">
        {TABS.map(t => {
          const count = t.id==="ARRIVALS"?filteredArrivals.length : t.id==="DEPARTURES"?filteredDepartures.length : inPortVessels.length;
          return (
            <button key={t.id}
              className={"pa-tab"+(tab===t.id?" pa-tab--on":"")}
              style={tab===t.id?{"--tc":t.color}:{}}
              onClick={()=>setTab(t.id)}>
              <span className="pa-tab-icon" style={tab===t.id?{color:t.color}:{}}>{t.icon}</span>
              <span className="pa-tab-lbl">{t.label}</span>
              <span className="pa-tab-ct" style={tab===t.id?{background:`${t.color}18`,borderColor:`${t.color}40`,color:t.color}:{}}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* ══ BODY ══ */}
      <div className="pa-body">

        {/* ─── ARRIVALS TAB ─── */}
        {tab==="ARRIVALS" && (
          loading && filteredArrivals.length===0 ? <PASkeleton/> :
          filteredArrivals.length===0 ? (
            <PAEmpty
              msg={`No upcoming arrivals in the next ${days===1?"24 hours":days+" days"}`}
              icon="↓"
              sub="Try extending the day range above"
            />
          ) :
          <div className="pa-list">
            {filteredArrivals.map((v,i)=>(
              <VesselCard key={v.imo_number+"-a-"+i} v={v} type="arrival"
                isSelected={selectedImo===v.imo_number}
                isFetching={loadingVessel===String(v.imo_number)}
                isExpanded={expanded===(v.imo_number+"-a-"+i)}
                onSelect={()=>selectWithNav(v)}
                onExpand={()=>setExpanded(expanded===(v.imo_number+"-a-"+i)?null:(v.imo_number+"-a-"+i))}
                timeField="arrival_time" routeFrom={bq(v.location_from)} routeTo="Singapore"
                dirColor="#00ff9d" dirLabel="ARR"/>
            ))}
          </div>
        )}

        {/* ─── DEPARTURES TAB ─── */}
        {tab==="DEPARTURES" && (
          loading && filteredDepartures.length===0 ? <PASkeleton/> :
          filteredDepartures.length===0 ? (
            <PAEmpty
              msg={`No upcoming departures in the next ${days===1?"24 hours":days+" days"}`}
              icon="↑"
              sub="Try extending the day range above"
            />
          ) :
          <div className="pa-list">
            {filteredDepartures.map((v,i)=>(
              <VesselCard key={v.imo_number+"-d-"+i} v={v} type="departure"
                isSelected={selectedImo===v.imo_number}
                isFetching={loadingVessel===String(v.imo_number)}
                isExpanded={expanded===(v.imo_number+"-d-"+i)}
                onSelect={()=>selectWithNav(v)}
                onExpand={()=>setExpanded(expanded===(v.imo_number+"-d-"+i)?null:(v.imo_number+"-d-"+i))}
                timeField="departure_time" routeFrom="Singapore" routeTo={bq(v.next_port)}
                dirColor="#ffaa00" dirLabel="DEP"/>
            ))}
          </div>
        )}

        {/* ─── IN PORT TAB ─── */}
        {tab==="IN PORT" && (
          inPortVessels.length===0 ? <PAEmpty msg="No vessels currently in port" icon="⬡"/> :
          <div className="pa-list">
            {inPortVessels.map((v,i)=>(
              <InPortCard key={v.imo_number+"-p-"+i} v={v}
                isSelected={selectedImo===v.imo_number} onSelect={()=>selectWithNav(v)}/>
            ))}
          </div>
        )}

      </div>

      {/* ══ STATUS BAR ══ */}
      <div className="pa-statusbar">
        <span className="pa-sb-live"><span className="pa-sb-dot"/>LIVE</span>
        <span className="pa-sb-info">{vessels.length.toLocaleString()} vessels tracked</span>
        <span className="pa-sb-sep">·</span>
        <span className="pa-sb-info">Port of Singapore</span>
        <span className="pa-sb-info pa-sb-right">1°17'N 103°49'E</span>
      </div>
    </div>
  );
}

/* ── Stat Pill ── */
function StatPill({ color, val, label, onClick, active }) {
  return (
    <button className={"pa-stat-pill"+(active?" pa-stat-pill--active":"")}
      style={{"--sc":color}} onClick={onClick}>
      <span className="pa-stat-dot"/>
      <span className="pa-stat-val">{val}</span>
      <span className="pa-stat-lbl">{label}</span>
    </button>
  );
}

/* ── Vessel Card ── */
function VesselCard({ v, isSelected, isExpanded, isFetching, onSelect, onExpand, timeField, routeFrom, routeTo, dirColor, dirLabel }) {
  const name    = bq(v.vessel_name)||"Unknown Vessel";
  const flag    = bq(v.flag);
  const agent   = bq(v.shipping_agent);
  const berth   = bq(v.berth_location)||bq(v.berth_grid);
  const crew    = safeNum(v.crew_count);
  const purpose = bq(v.voyage_purpose);
  const src     = bq(v.arrival_source||v.departure_source);
  const sc      = srcColor(src);
  const rawTs   = bq(v[timeField]);
  const rel     = timeRelative(rawTs);
  const tg      = getTypeGroup(bq(v.vessel_type));

  return (
    <div className={"pa-card"+(isSelected?" pa-card--sel":"")+(isFetching?" pa-card--fetching":"")}
      style={{"--dc":dirColor}} onClick={onSelect}>
      {isFetching && <div className="pa-card-fetch-overlay"><span className="pa-fetch-spinner"/>Locating…</div>}
      <div className="pa-card-accent"/>
      <div className="pa-card-body">
        {/* Top row */}
        <div className="pa-card-top">
          <span className="pa-card-flag">{getFlagEmoji(flag)}</span>
          <div className="pa-card-id">
            <div className="pa-card-name">
              <span className="pa-type-pip" style={{background:tg.color}} title={tg.label}/>
              {name}
            </div>
            <div className="pa-card-imo">IMO {v.imo_number||"—"} · {tg.label}</div>
          </div>
          <div className="pa-card-badges">
            <span className="pa-badge-dir" style={{background:`${dirColor}18`,borderColor:`${dirColor}40`,color:dirColor}}>{dirLabel}</span>
            <span className="pa-badge-src" style={{background:sc.bg,borderColor:sc.border,color:sc.text}}>{sc.label}</span>
          </div>
        </div>

        {/* Route */}
        {(routeFrom||routeTo) && (
          <div className="pa-route-row">
            <span className="pa-route-port pa-route-from">{routeFrom||"—"}</span>
            <span className="pa-route-arrow">
              <svg width="44" height="10" viewBox="0 0 44 10">
                <line x1="0" y1="5" x2="36" y2="5" stroke={dirColor} strokeWidth="1.2" strokeOpacity="0.45" strokeDasharray="4,3"/>
                <polygon points="36,2 44,5 36,8" fill={dirColor} fillOpacity="0.9"/>
              </svg>
            </span>
            <span className="pa-route-port pa-route-to" style={{borderColor:`${dirColor}35`,color:dirColor}}>{routeTo||"—"}</span>
          </div>
        )}

        {/* Chips */}
        <div className="pa-card-chips">
          {rel && (
            <span className={"pa-chip-time pa-chip-future"+(rel.urgent?" pa-chip-urgent":"")} style={{color:rel.future?"#a78bfa":"#88aabb"}}>
              🕐 {rel.label}
            </span>
          )}
          {!rel && rawTs && <span className="pa-chip-time">{formatTimestamp(rawTs)}</span>}
          {berth   && <span className="pa-chip">🏗 {berth}</span>}
          {crew    && <span className="pa-chip">👥 {crew}</span>}
          {purpose && <span className="pa-chip">{purpose}</span>}
        </div>

        {/* Expanded drawer */}
        {isExpanded && (
          <div className="pa-drawer" onClick={e=>e.stopPropagation()}>
            {agent && (
              <div className="pa-drawer-row">
                <span className="pa-drawer-k">Shipping Agent</span>
                <span className="pa-drawer-v">{agent}</span>
              </div>
            )}
            <button className="pa-track-btn" onClick={onSelect}>📍 Track on Map</button>
          </div>
        )}
      </div>
      <button className={"pa-expander"+(isExpanded?" open":"")} onClick={e=>{e.stopPropagation();onExpand();}}>›</button>
    </div>
  );
}

/* ── In-Port Card ── */
function InPortCard({ v, isSelected, onSelect }) {
  const name  = bq(v.vessel_name)||"Unknown";
  const flag  = bq(v.flag);
  const berth = bq(v.berth_location);
  const agent = bq(v.shipping_agent);
  const tg    = getTypeGroup(bq(v.vessel_type));
  return (
    <div className={"pa-card pa-card--inport"+(isSelected?" pa-card--sel":"")}
      style={{"--dc":"#38bdf8"}} onClick={onSelect}>
      <div className="pa-card-accent"/>
      <div className="pa-card-body">
        <div className="pa-card-top">
          <span className="pa-card-flag">{getFlagEmoji(flag)}</span>
          <div className="pa-card-id">
            <div className="pa-card-name"><span className="pa-type-pip" style={{background:tg.color}}/>{name}</div>
            <div className="pa-card-imo">IMO {v.imo_number||"—"} · {tg.label}</div>
          </div>
          <span className="pa-badge-inport">IN PORT</span>
        </div>
        <div className="pa-card-chips">
          {berth && <span className="pa-chip">🏗 {berth}</span>}
          {agent && <span className="pa-chip">{agent}</span>}
        </div>
      </div>
    </div>
  );
}

function PASkeleton() {
  return (
    <div className="pa-skel-list">
      {[...Array(5)].map((_,i)=>(
        <div key={i} className="pa-skel" style={{animationDelay:i*0.09+"s",height:i%2===0?"82px":"68px"}}/>
      ))}
    </div>
  );
}

function PAEmpty({ msg, icon, sub }) {
  return (
    <div className="pa-empty">
      <div className="pa-empty-glyph">{icon}</div>
      <p>{msg}</p>
      {sub && <p className="pa-empty-sub">{sub}</p>}
    </div>
  );
}