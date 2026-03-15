// src/components/PortActivityPanel.jsx — v4 "Port Command Centre"
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { fetchArrivals, fetchDepartures, fetchPortActivity, fetchVesselDetail } from "../services/api";
import { getFlagEmoji, formatTimestamp, timeAgo, getVesselTypeLabel } from "../utils/vesselUtils";
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
  if (src === "DECLARATION")  return { bg:"rgba(0,229,255,0.10)",  border:"rgba(0,229,255,0.30)",  text:"#00e5ff", label:"DECL" };
  if (src === "AIS_CONFIRMED")return { bg:"rgba(38,222,129,0.10)", border:"rgba(38,222,129,0.30)", text:"#26de81", label:"AIS" };
  if (src === "SCHEDULED")    return { bg:"rgba(253,150,68,0.10)", border:"rgba(253,150,68,0.30)", text:"#fd9644", label:"SCHED" };
  return { bg:"rgba(120,160,200,0.06)", border:"rgba(120,160,200,0.15)", text:"#88aabb", label:src||"—" };
}

function timeRelative(ts) {
  if (!ts) return null;
  try {
    const d=new Date(ts), diff=Date.now()-d.getTime(), abs=Math.abs(diff);
    if (abs < 60000)    return { label:"just now", future:false, urgent:false };
    if (abs < 3600000)  { const m=Math.round(abs/60000); return { label:diff>0?`${m}m ago`:`in ${m}m`, future:diff<0, urgent:diff<0&&m<30 }; }
    if (abs < 86400000) { const h=(abs/3600000).toFixed(1); return { label:diff>0?`${h}h ago`:`in ${h}h`, future:diff<0, urgent:false }; }
    return { label:formatTimestamp(ts), future:false, urgent:false };
  } catch { return null; }
}

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
  { id:"OVERVIEW",   icon:"◈", label:"Overview",   color:"#00e5ff" },
  { id:"ARRIVALS",   icon:"↓", label:"Arrivals",   color:"#00ff9d" },
  { id:"DEPARTURES", icon:"↑", label:"Departures", color:"#ffaa00" },
  { id:"IN PORT",    icon:"⬡", label:"In Port",    color:"#38bdf8" },
  { id:"EXPECTED",   icon:"◷", label:"Expected",   color:"#a78bfa" },
];

export default function PortActivityPanel({ onSelectVessel, selectedImo, isOpen, onClose, vessels=[] }) {
  const [tab,         setTab]         = useState("OVERVIEW");
  const [arrivals,    setArrivals]    = useState([]);
  const [departures,  setDepartures]  = useState([]);
  const [portStats,   setPortStats]   = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [search,      setSearch]      = useState("");
  const [sortBy,      setSortBy]      = useState("time");
  const [expanded,    setExpanded]    = useState(null);
  const panelRef  = useRef(null);
  const searchRef = useRef(null);

  const [loadingVessel, setLoadingVessel] = useState(null);

  // Merge arrival/departure record fields onto live vessel — gives detail panel ALL data
  const mergeRecordOntoVessel = useCallback((live, record) => {
    if (!live) return null;
    return {
      ...live,
      berth_location:        live.berth_location        || bq(record.berth_location) || bq(record.berth_grid),
      berth_grid:            live.berth_grid             || bq(record.berth_grid),
      shipping_agent:        live.shipping_agent         || bq(record.shipping_agent),
      voyage_purpose:        live.voyage_purpose         || bq(record.voyage_purpose),
      last_port_departed:    live.last_port_departed     || bq(record.location_from),
      next_port_destination: live.next_port_destination  || bq(record.next_port),
      declared_arrival_time: live.declared_arrival_time  || bq(record.arrival_time) || bq(record.departure_time),
      crew_count:            live.crew_count             ?? record.crew_count,
      passenger_count:       live.passenger_count        ?? record.passenger_count,
    };
  }, []);

  const selectWithNav = useCallback(async (record) => {
    if (!onSelectVessel || !record?.imo_number) return;

    // 1. Live match — has position + all fields
    const live = vessels.find(v => String(v.imo_number) === String(record.imo_number));
    if (live) {
      onSelectVessel(mergeRecordOntoVessel(live, record));
      return;
    }

    // 2. No live match — fetch full vessel detail (position + static data) from API
    setLoadingVessel(String(record.imo_number));
    try {
      const res    = await fetchVesselDetail(record.imo_number);
      const detail = res?.data || res;
      if (detail?.imo_number) {
        onSelectVessel(mergeRecordOntoVessel(detail, record));
      } else {
        // 3. Fallback — pass record as-is (panel will show what data it has)
        onSelectVessel(record);
      }
    } catch {
      onSelectVessel(record);
    } finally {
      setLoadingVessel(null);
    }
  }, [vessels, onSelectVessel, mergeRecordOntoVessel]);

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

  useEffect(() => { load(); const t=setInterval(load,60_000); return ()=>clearInterval(t); }, [load]);

  useEffect(() => {
    if (!isOpen) return;
    const h = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target) && !e.target.closest(".pa-trigger")) onClose?.();
    };
    document.addEventListener("mousedown", h); document.addEventListener("touchstart", h);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("touchstart", h); };
  }, [isOpen, onClose]);

  const stats = useMemo(() => {
    const inPort   = vessels.filter(v => parseFloat(v.speed||0) < 0.5).length;
    const underway = vessels.filter(v => parseFloat(v.speed||0) >= 0.5).length;
    const upcoming = departures.filter(v => v.is_upcoming).length;
    // vessel type breakdown from in-port vessels
    const byType = {};
    TYPE_GROUPS.forEach(g => { byType[g.label] = 0; });
    vessels.filter(v => parseFloat(v.speed||0) < 0.5).forEach(v => {
      const g = getTypeGroup(bq(v.vessel_type));
      byType[g.label] = (byType[g.label]||0) + 1;
    });
    return { inPort, underway, upcoming, arrivals:arrivals.length, departures:departures.length, byType };
  }, [vessels, arrivals, departures]);

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
    if (sortBy==="name") out=[...out].sort((a,b)=>(bq(a.vessel_name)||"").localeCompare(bq(b.vessel_name)||""));
    else out=[...out].sort((a,b)=>{
      const ta=bq(a[timeField]),tb=bq(b[timeField]);
      if(!ta)return 1; if(!tb)return -1;
      return new Date(tb)-new Date(ta);
    });
    return out;
  }, [search, sortBy]);

  const filteredArrivals   = useMemo(() => filterList(arrivals,"arrival_time"), [arrivals,filterList]);
  const filteredDepartures = useMemo(() => filterList([...departures].sort((a,b)=>{
    if(a.is_upcoming&&!b.is_upcoming)return -1; if(!a.is_upcoming&&b.is_upcoming)return 1; return 0;
  }),"departure_time"), [departures,filterList]);
  const inPortVessels = useMemo(() =>
    vessels.filter(v=>parseFloat(v.speed||0)<0.5&&v.vessel_name)
      .filter(v=>!search||(bq(v.vessel_name)||"").toLowerCase().includes(search.toLowerCase()))
      .slice(0,80),
  [vessels,search]);
  const expectedVessels = useMemo(() =>
    departures.filter(v=>v.is_upcoming)
      .filter(v=>!search||(bq(v.vessel_name)||"").toLowerCase().includes(search.toLowerCase())),
  [departures,search]);

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
              <span>Live Maritime Activity</span>
            </div>
          </div>
        </div>
        <div className="pa-header-right">
          {lastRefresh && <span className="pa-refresh-ts">↻ {timeAgo(lastRefresh)}</span>}
          <button className="pa-icon-btn" onClick={load} disabled={loading} title="Refresh">
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
        <StatPill color="#00ff9d" val={stats.arrivals}   label="Arrived"  onClick={()=>setTab("ARRIVALS")}   active={tab==="ARRIVALS"} />
        <StatPill color="#ffaa00" val={stats.departures} label="Departed" onClick={()=>setTab("DEPARTURES")} active={tab==="DEPARTURES"} />
        <StatPill color="#38bdf8" val={stats.inPort}     label="In Port"  onClick={()=>setTab("IN PORT")}    active={tab==="IN PORT"} />
        <StatPill color="#a78bfa" val={stats.upcoming}   label="Expected" onClick={()=>setTab("EXPECTED")}   active={tab==="EXPECTED"} />
      </div>

      {/* ══ SEARCH ROW (hidden on overview) ══ */}
      {tab !== "OVERVIEW" && (
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
            <option value="time">Latest</option>
            <option value="name">Name</option>
          </select>
        </div>
      )}

      {/* ══ TABS ══ */}
      <div className="pa-tabs">
        {TABS.map(t => {
          const count = t.id==="ARRIVALS" ? filteredArrivals.length
                      : t.id==="DEPARTURES" ? filteredDepartures.length
                      : t.id==="IN PORT" ? inPortVessels.length
                      : t.id==="EXPECTED" ? expectedVessels.length : null;
          return (
            <button key={t.id}
              className={"pa-tab"+(tab===t.id?" pa-tab--on":"")}
              style={tab===t.id?{"--tc":t.color}:{}}
              onClick={()=>setTab(t.id)}>
              <span className="pa-tab-icon" style={tab===t.id?{color:t.color}:{}}>{t.icon}</span>
              <span className="pa-tab-lbl">{t.label}</span>
              {count!=null && <span className="pa-tab-ct" style={tab===t.id?{background:`${t.color}18`,borderColor:`${t.color}40`,color:t.color}:{}}>{count}</span>}
            </button>
          );
        })}
      </div>

      {/* ══ BODY ══ */}
      <div className="pa-body">

        {/* ─── OVERVIEW TAB ─── */}
        {tab==="OVERVIEW" && (
          <div className="pa-overview">

            {/* Port identity card */}
            <div className="pa-ov-identity">
              <div className="pa-ov-id-left">
                <div className="pa-ov-port-name">Singapore</div>
                <div className="pa-ov-port-meta">
                  <span className="pa-ov-tag">UN/LOCODE: SGSIN</span>
                  <span className="pa-ov-tag">Indonesia, SG Area</span>
                </div>
                <div className="pa-ov-aliases">Also known as: SPORE · SINGPORE · SIN EBGA · SIN PEBGA</div>
              </div>
              <div className="pa-ov-id-right">
                <div className="pa-rank-badge">
                  <div className="pa-rank-num">#1</div>
                  <div className="pa-rank-lbl">World's Busiest</div>
                </div>
              </div>
            </div>

            {/* Live pulse grid */}
            <div className="pa-ov-grid">
              <div className="pa-ov-cell pa-ov-cell--green" onClick={()=>setTab("ARRIVALS")}>
                <div className="pa-ov-cell-val">{stats.arrivals}</div>
                <div className="pa-ov-cell-label">ARRIVALS</div>
                <div className="pa-ov-cell-sub">last 24h</div>
                <div className="pa-ov-cell-arrow">→</div>
              </div>
              <div className="pa-ov-cell pa-ov-cell--amber" onClick={()=>setTab("DEPARTURES")}>
                <div className="pa-ov-cell-val">{stats.departures}</div>
                <div className="pa-ov-cell-label">DEPARTED</div>
                <div className="pa-ov-cell-sub">last 24h</div>
                <div className="pa-ov-cell-arrow">→</div>
              </div>
              <div className="pa-ov-cell pa-ov-cell--cyan" onClick={()=>setTab("IN PORT")}>
                <div className="pa-ov-cell-val">{stats.inPort}</div>
                <div className="pa-ov-cell-label">IN PORT</div>
                <div className="pa-ov-cell-sub">now</div>
                <div className="pa-ov-cell-arrow">→</div>
              </div>
              <div className="pa-ov-cell pa-ov-cell--purple" onClick={()=>setTab("EXPECTED")}>
                <div className="pa-ov-cell-val">{stats.upcoming}</div>
                <div className="pa-ov-cell-label">EXPECTED</div>
                <div className="pa-ov-cell-sub">upcoming</div>
                <div className="pa-ov-cell-arrow">→</div>
              </div>
            </div>

            {/* Vessel type breakdown */}
            <div className="pa-ov-section">
              <div className="pa-ov-section-title">FLEET COMPOSITION · IN PORT</div>
              <div className="pa-type-breakdown">
                {TYPE_GROUPS.map(g => {
                  const cnt = stats.byType[g.label] || 0;
                  const pct = stats.inPort > 0 ? Math.round(cnt/stats.inPort*100) : 0;
                  return (
                    <div key={g.label} className="pa-type-row">
                      <span className="pa-type-icon">{g.icon}</span>
                      <span className="pa-type-name">{g.label}</span>
                      <div className="pa-type-bar-wrap">
                        <div className="pa-type-bar-fill" style={{width:pct+"%",background:g.color}}/>
                      </div>
                      <span className="pa-type-cnt" style={{color:g.color}}>{cnt}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Top origin/dest ports heatmap */}
            {portStats.length > 0 && (
              <div className="pa-ov-section">
                <div className="pa-ov-section-title">TOP TRADE ROUTES</div>
                <div className="pa-heatmap-list">
                  {portStats.slice(0,6).map((p,i) => {
                    const max = Number(portStats[0]?.arrivals_24h||portStats[0]?.arrivals||1);
                    const val = Number(p.arrivals_24h||p.arrivals||0);
                    const pct = Math.round((val/max)*100);
                    return (
                      <div key={i} className="pa-hm-row">
                        <span className="pa-hm-rank">#{i+1}</span>
                        <span className="pa-hm-name">{bq(p.port)||"—"}</span>
                        <div className="pa-hm-bar"><div className="pa-hm-fill" style={{width:pct+"%"}}/></div>
                        <span className="pa-hm-val">{val}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Terminals */}
            <div className="pa-ov-section">
              <div className="pa-ov-section-title">TERMINALS</div>
              <div className="pa-terminals">
                {[
                  { name:"Tuas Port",         type:"Container", status:"operational", color:"#00e5ff" },
                  { name:"Pasir Panjang",      type:"Container", status:"operational", color:"#00e5ff" },
                  { name:"Brani Terminal",     type:"Container", status:"operational", color:"#00e5ff" },
                  { name:"Keppel Terminal",    type:"Container", status:"operational", color:"#00e5ff" },
                  { name:"Jurong Island",      type:"Petrochemical", status:"operational", color:"#ffaa00" },
                  { name:"Sembcorp Marine",    type:"Repair",    status:"operational", color:"#a78bfa" },
                ].map((t,i) => (
                  <div key={i} className="pa-terminal-chip" style={{"--tc":t.color}}>
                    <span className="pa-terminal-dot"/>
                    <span className="pa-terminal-name">{t.name}</span>
                    <span className="pa-terminal-type">{t.type}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Recent arrivals preview */}
            {arrivals.length > 0 && (
              <div className="pa-ov-section">
                <div className="pa-ov-section-title-row">
                  <span className="pa-ov-section-title">RECENT ARRIVALS</span>
                  <button className="pa-ov-see-all" onClick={()=>setTab("ARRIVALS")}>See all →</button>
                </div>
                <div className="pa-preview-list">
                  {arrivals.slice(0,4).map((v,i)=>(
                    <div key={i} className="pa-preview-row" onClick={()=>selectWithNav(v)}>
                      <span className="pa-preview-flag">{getFlagEmoji(bq(v.flag))}</span>
                      <span className="pa-preview-name">{bq(v.vessel_name)||"Unknown"}</span>
                      <span className="pa-preview-from">{bq(v.location_from)||"—"}</span>
                      <span className="pa-preview-time">{timeRelative(bq(v.arrival_time))?.label||"—"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── ARRIVALS TAB ─── */}
        {tab==="ARRIVALS" && (
          loading&&filteredArrivals.length===0 ? <PASkeleton/> :
          filteredArrivals.length===0 ? <PAEmpty msg="No arrivals match your search" icon="↓"/> :
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
          loading&&filteredDepartures.length===0 ? <PASkeleton/> :
          filteredDepartures.length===0 ? <PAEmpty msg="No departures match your search" icon="↑"/> :
          <div className="pa-list">
            {filteredDepartures.map((v,i)=>(
              <VesselCard key={v.imo_number+"-d-"+i} v={v} type="departure"
                isSelected={selectedImo===v.imo_number}
                isFetching={loadingVessel===String(v.imo_number)}
                isExpanded={expanded===(v.imo_number+"-d-"+i)}
                onSelect={()=>selectWithNav(v)}
                onExpand={()=>setExpanded(expanded===(v.imo_number+"-d-"+i)?null:(v.imo_number+"-d-"+i))}
                timeField="departure_time" routeFrom="Singapore" routeTo={bq(v.next_port)}
                dirColor={v.is_upcoming?"#a78bfa":"#ffaa00"} dirLabel={v.is_upcoming?"EXP":"DEP"}/>
            ))}
          </div>
        )}

        {/* ─── IN PORT TAB ─── */}
        {tab==="IN PORT" && (
          loading&&inPortVessels.length===0 ? <PASkeleton/> :
          inPortVessels.length===0 ? <PAEmpty msg="No vessels currently in port" icon="⬡"/> :
          <div className="pa-list">
            {inPortVessels.map((v,i)=>(
              <InPortCard key={v.imo_number+"-p-"+i} v={v}
                isSelected={selectedImo===v.imo_number} onSelect={()=>selectWithNav(v)}/>
            ))}
          </div>
        )}

        {/* ─── EXPECTED TAB ─── */}
        {tab==="EXPECTED" && (
          loading&&expectedVessels.length===0 ? <PASkeleton/> :
          expectedVessels.length===0 ? <PAEmpty msg="No expected arrivals" icon="◷"/> :
          <div className="pa-list">
            {expectedVessels.map((v,i)=>(
              <VesselCard key={v.imo_number+"-e-"+i} v={v} type="expected"
                isSelected={selectedImo===v.imo_number}
                isFetching={loadingVessel===String(v.imo_number)}
                isExpanded={expanded===(v.imo_number+"-e-"+i)}
                onSelect={()=>selectWithNav(v)}
                onExpand={()=>setExpanded(expanded===(v.imo_number+"-e-"+i)?null:(v.imo_number+"-e-"+i))}
                timeField="departure_time" routeFrom="Singapore" routeTo={bq(v.next_port)}
                dirColor="#a78bfa" dirLabel="EXP"/>
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
  const imo     = v.imo_number;
  const flag    = bq(v.flag);
  const agent   = bq(v.shipping_agent);
  const berth   = bq(v.berth_location)||bq(v.berth_grid);
  const crew    = safeNum(v.crew_count);
  const pax     = safeNum(v.passenger_count);
  const purpose = bq(v.voyage_purpose);
  const src     = bq(v.arrival_source||v.departure_source);
  const sc      = srcColor(src);
  const rawTs   = bq(v[timeField]);
  const rel     = timeRelative(rawTs);
  const tg      = getTypeGroup(bq(v.vessel_type));
  const dq      = safeNum(v.data_quality_score);

  return (
    <div className={"pa-card"+(isSelected?" pa-card--sel":"")+(v.is_upcoming?" pa-card--upcoming":"")+(isFetching?" pa-card--fetching":"")}
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
            <div className="pa-card-imo">IMO {imo||"—"} · {tg.label}</div>
          </div>
          <div className="pa-card-badges">
            <span className="pa-badge-dir" style={{background:`${dirColor}18`,borderColor:`${dirColor}40`,color:dirColor}}>{dirLabel}</span>
            <span className="pa-badge-src" style={{background:sc.bg,borderColor:sc.border,color:sc.text}}>{sc.label}</span>
          </div>
        </div>

        {/* Route row */}
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

        {/* Meta chips */}
        <div className="pa-card-chips">
          {rel && (
            <span className={"pa-chip-time"+(rel.urgent?" pa-chip-urgent":"")} style={rel.future?{color:"#a78bfa"}:{}}>
              {rel.future?"🕐 ":"⏱ "}{rel.label}
            </span>
          )}
          {!rel&&rawTs && <span className="pa-chip-time">{formatTimestamp(rawTs)}</span>}
          {berth   && <span className="pa-chip">🏗 {berth}</span>}
          {crew    && <span className="pa-chip">👥 {crew}</span>}
          {pax     && <span className="pa-chip">🧑‍✈️ {pax}</span>}
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
            {dq!=null && (
              <div className="pa-drawer-row">
                <span className="pa-drawer-k">Data Quality</span>
                <div className="pa-dq-row">
                  <div className="pa-dq-bar"><div className="pa-dq-fill" style={{width:`${dq}%`,background:dq>=80?"#00ff9d":dq>=50?"#ffaa00":"#ff4466"}}/></div>
                  <span className="pa-dq-num" style={{color:dq>=80?"#00ff9d":dq>=50?"#ffaa00":"#ff4466"}}>{dq}</span>
                </div>
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
  const name    = bq(v.vessel_name)||"Unknown";
  const flag    = bq(v.flag);
  const berth   = bq(v.berth_location);
  const agent   = bq(v.shipping_agent);
  const hoursIn = safeNum(v.hours_in_port_so_far);
  const portTime= safeNum(v.port_time_hours);
  const pct     = (hoursIn&&portTime&&portTime>0)?Math.min(Math.round(hoursIn/portTime*100),100):null;
  const tg      = getTypeGroup(bq(v.vessel_type));

  return (
    <div className={"pa-card pa-card--inport"+(isSelected?" pa-card--sel":"")}
      style={{"--dc":"#38bdf8"}} onClick={onSelect}>
      <div className="pa-card-accent"/>
      <div className="pa-card-body">
        <div className="pa-card-top">
          <span className="pa-card-flag">{getFlagEmoji(flag)}</span>
          <div className="pa-card-id">
            <div className="pa-card-name">
              <span className="pa-type-pip" style={{background:tg.color}}/>
              {name}
            </div>
            <div className="pa-card-imo">IMO {v.imo_number||"—"} · {tg.label}</div>
          </div>
          <span className="pa-badge-inport">IN PORT</span>
        </div>
        <div className="pa-card-chips">
          {hoursIn!=null && <span className="pa-chip-time">⏱ {hoursIn.toFixed(1)}h berthed</span>}
          {berth && <span className="pa-chip">🏗 {berth}</span>}
          {agent && <span className="pa-chip">{agent}</span>}
        </div>
        {pct!=null && (
          <div className="pa-bprogress">
            <div className="pa-bp-bar">
              <div className="pa-bp-fill" style={{width:pct+"%"}}/>
              <div className="pa-bp-head" style={{left:pct+"%"}}/>
            </div>
            <span className="pa-bp-lbl">{pct}% of port schedule</span>
          </div>
        )}
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

function PAEmpty({ msg, icon }) {
  return (
    <div className="pa-empty">
      <div className="pa-empty-glyph">{icon}</div>
      <p>{msg}</p>
    </div>
  );
}