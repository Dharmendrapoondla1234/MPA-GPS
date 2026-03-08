// src/components/VesselPanel.jsx
import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { getVesselStatus, getFlagEmoji, getVesselTypeLabel } from "../utils/vesselUtils";
import "./VesselPanel.css";

export default function VesselPanel({ vessels, selectedId, onSelect, loading, stats, onMinimize, panelOpen = true }) {
  const [sort,      setSort]      = useState("speed_desc");
  const [compact,   setCompact]   = useState(false);
  const [search,    setSearch]    = useState("");

  const filtered = useMemo(() => {
    if (!search) return vessels;
    const q    = search.trim();
    const qLow = q.toLowerCase();
    const isNum = /^\d+$/.test(q);

    const matches = vessels.filter(v =>
      (v.vessel_name||"").toLowerCase().includes(qLow) ||
      String(v.imo_number||"").includes(q) ||
      String(v.mmsi_number||"").includes(q) ||
      (v.flag||"").toLowerCase().includes(qLow) ||
      (v.call_sign||"").toLowerCase().includes(qLow)
    );

    // Exact IMO/MMSI matches float to top
    if (isNum) {
      matches.sort((a, b) => {
        const aExact = String(a.imo_number) === q || String(a.mmsi_number) === q;
        const bExact = String(b.imo_number) === q || String(b.mmsi_number) === q;
        return (bExact ? 1 : 0) - (aExact ? 1 : 0);
      });
    }
    return matches;
  }, [vessels, search]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sort) {
      case "name":       return arr.sort((a,b)=>(a.vessel_name||"").localeCompare(b.vessel_name||""));
      case "speed_desc": return arr.sort((a,b)=>(parseFloat(b.speed)||0)-(parseFloat(a.speed)||0));
      case "speed_asc":  return arr.sort((a,b)=>(parseFloat(a.speed)||0)-(parseFloat(b.speed)||0));
      case "dw_desc":    return arr.sort((a,b)=>(parseFloat(b.deadweight)||0)-(parseFloat(a.deadweight)||0));
      case "type":       return arr.sort((a,b)=>(a.vessel_type||"").localeCompare(b.vessel_type||""));
      default: return arr;
    }
  }, [filtered, sort]);

  // Speed band counts
  const bands = useMemo(() => {
    const stopped = vessels.filter(v=>(parseFloat(v.speed)||0)<=0.3).length;
    const slow    = vessels.filter(v=>{const s=parseFloat(v.speed)||0;return s>0.3&&s<5;}).length;
    const medium  = vessels.filter(v=>{const s=parseFloat(v.speed)||0;return s>=5&&s<12;}).length;
    const fast    = vessels.filter(v=>(parseFloat(v.speed)||0)>=12).length;
    return { stopped, slow, medium, fast };
  }, [vessels]);

  const total = vessels.length || 1;

  // Distinct counts
  const distinctIMO  = useMemo(()=>new Set(vessels.map(v=>v.imo_number).filter(Boolean)).size, [vessels]);
  const distinctMMSI = useMemo(()=>new Set(vessels.map(v=>v.mmsi_number).filter(Boolean)).size, [vessels]);

  return (
    <div className="vp-root">
      <div className="vp-header">
        <div className="vp-title-row">
          <span className="vp-label">FLEET</span>
          <span className="vp-count mono">{loading?"…":distinctIMO.toLocaleString()}</span>
          <div className="vp-view-btns">
            <button className={`vp-view-btn ${!compact?"active":""}`} onClick={()=>setCompact(false)} title="List">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
              </svg>
            </button>
            <button className={`vp-view-btn ${compact?"active":""}`} onClick={()=>setCompact(true)} title="Compact">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
            <button className="vp-view-btn vp-minimize-btn" onClick={()=>onMinimize?.()} title={!panelOpen?"Show vessel list":"Hide vessel list"}>
              <span style={{fontSize:"14px",fontWeight:"700",lineHeight:1,fontFamily:"sans-serif"}}>
                {!panelOpen ? "›" : "‹"}
              </span>
            </button>
          </div>
        </div>

        {/* Distinct counts row */}
        <div className="vp-distinct-row">
          <span className="vp-dist-chip">IMO: <b>{distinctIMO.toLocaleString()}</b></span>
          <span className="vp-dist-chip">MMSI: <b>{distinctMMSI.toLocaleString()}</b></span>
          {stats?.flag_count && <span className="vp-dist-chip">Flags: <b>{Number(stats.flag_count)}</b></span>}
        </div>

        {/* Speed bar */}
        <div className="vp-dist" title={`Stopped:${bands.stopped} Slow:${bands.slow} Medium:${bands.medium} Fast:${bands.fast}`}>
          {[{w:bands.stopped/total,c:"#90a4ae"},{w:bands.slow/total,c:"#26de81"},{w:bands.medium/total,c:"#fd9644"},{w:bands.fast/total,c:"#fc5c65"}]
            .map((s,i)=>s.w>0&&<div key={i} style={{width:`${s.w*100}%`,background:s.c,height:"100%",borderRadius:"2px",transition:"width 0.8s ease"}}/>)}
        </div>

        {/* Search within panel */}
        <div className="vp-panel-search">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input className="vp-panel-input" placeholder="Filter by name, IMO, MMSI, flag…"
            value={search} onChange={e=>setSearch(e.target.value)}/>
          {search && <button className="vp-panel-clear" onClick={()=>setSearch("")}>✕</button>}
        </div>

        {/* Sort */}
        <div className="vp-sort-row">
          <select className="vp-sort" value={sort} onChange={e=>setSort(e.target.value)}>
            <option value="speed_desc">Speed ↓</option>
            <option value="speed_asc">Speed ↑</option>
            <option value="name">Name A–Z</option>
            <option value="dw_desc">Dead Weight ↓</option>
            <option value="type">Type</option>
          </select>
          <span className="vp-band-legends">
            {[["#90a4ae","Stop"],["#26de81","Slow"],["#fd9644","Med"],["#fc5c65","Fast"]]
              .map(([c,l])=>(
                <span key={l} className="vp-band-badge" style={{color:c,borderColor:`${c}44`,background:`${c}0d`}}>{l}</span>
              ))}
          </span>
        </div>
      </div>

      {/* Body */}
      {panelOpen && (
        loading && vessels.length===0 ? (
          <div className="vp-loading">
            <div className="vp-spinner"/>
            {[...Array(5)].map((_,i)=><div key={i} className="vp-skel" style={{animationDelay:`${i*0.1}s`}}/>)}
          </div>
        ) : sorted.length===0 ? (
          <div className="vp-empty">
            <div className="vp-empty-icon">⚓</div>
            <div className="vp-empty-title">{search?"No matches":"No vessels found"}</div>
            <div className="vp-empty-sub">{search?"Try different search terms":"Adjust filters or refresh"}</div>
          </div>
        ) : (
          <VirtualList
            items={sorted}
            selectedId={selectedId}
            onSelect={onSelect}
            compact={compact}
          />
        )
      )}
    </div>
  );
}

// ── VIRTUAL LIST — only renders visible rows ──────────────────────
// Renders ~20 items at a time regardless of total count.
// Eliminates the main render bottleneck with 3000+ vessels.
const ITEM_H_FULL    = 88;   // px — must match .vp-item height in CSS
const ITEM_H_COMPACT = 32;   // px — must match .vp-compact height in CSS
const OVERSCAN       = 5;    // extra rows above/below viewport

function VirtualList({ items, selectedId, onSelect, compact }) {
  const containerRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const itemH = compact ? ITEM_H_COMPACT : ITEM_H_FULL;

  // Scroll selected item into view
  useEffect(() => {
    if (!selectedId || !containerRef.current) return;
    const idx = items.findIndex(v => v.imo_number === selectedId);
    if (idx < 0) return;
    const top = idx * itemH;
    const bot = top + itemH;
    const { scrollTop: st, clientHeight } = containerRef.current;
    if (top < st || bot > st + clientHeight) {
      containerRef.current.scrollTop = top - clientHeight / 2 + itemH / 2;
    }
  }, [selectedId, items, itemH]);

  const handleScroll = useCallback(e => setScrollTop(e.currentTarget.scrollTop), []);

  const viewH     = 500; // approximate — actual clamp happens via CSS
  const startIdx  = Math.max(0, Math.floor(scrollTop / itemH) - OVERSCAN);
  const endIdx    = Math.min(items.length, Math.ceil((scrollTop + viewH) / itemH) + OVERSCAN);
  const visible   = items.slice(startIdx, endIdx);
  const paddingTop    = startIdx * itemH;
  const paddingBottom = (items.length - endIdx) * itemH;

  return (
    <div
      ref={containerRef}
      className={`vp-list ${compact ? "compact" : ""} vp-virtual`}
      onScroll={handleScroll}
      style={{ overflowY: "auto", height: "100%", contain: "strict" }}
    >
      {paddingTop > 0 && <div style={{ height: paddingTop }} />}
      {visible.map((v) => compact
        ? <CompactItem key={v.imo_number} v={v} selected={v.imo_number === selectedId} onSelect={onSelect} idx={0} />
        : <FullItem    key={v.imo_number} v={v} selected={v.imo_number === selectedId} onSelect={onSelect} idx={0} />
      )}
      {paddingBottom > 0 && <div style={{ height: paddingBottom }} />}
    </div>
  );
}


const FullItem = React.memo(function FullItem({ v, selected, onSelect, idx }) {
  const st    = getVesselStatus(v.speed);
  const speed = parseFloat(v.speed||0);
  const pct   = Math.min((speed/25)*100,100);
  const flag  = getFlagEmoji(v.flag);
  return (
    <div className={`vp-item ${selected?"selected":""}`} onClick={()=>onSelect(v)} style={{animationDelay:`${Math.min(idx*15,300)}ms`}}>
      {selected && <div className="vp-sel-bar"/>}
      <div className="vpi-top">
        <span className="vpi-flag">{flag}</span>
        <div className="vpi-info">
          <div className="vpi-name">{v.vessel_name||"Unknown Vessel"}</div>
          <div className="vpi-sub mono">IMO {v.imo_number||"—"} · {v.mmsi_number||"—"}</div>
          {v.call_sign && <div className="vpi-sub mono" style={{fontSize:8}}>CS: {v.call_sign}</div>}
        </div>
        <div className="vpi-spd" style={{color:st.color,borderColor:`${st.color}33`,background:`${st.color}0d`}}>
          {speed.toFixed(1)} kn
        </div>
      </div>
      <div className="vpi-mid">
        {v.vessel_type && <span className="vpi-type">{getVesselTypeLabel(v.vessel_type)}</span>}
        <span className="vpi-status" style={{color:st.color}}>
          <span className="vpi-dot" style={{background:st.color}}/>{st.label}
        </span>
      </div>
      <div className="vpi-data-row">
        {v.deadweight && <span className="vpi-data-chip">⚖ {Number(v.deadweight).toLocaleString()} DWT</span>}
        {v.flag       && <span className="vpi-data-chip">{flag} {v.flag}</span>}
      </div>
      <div className="vpi-bar">
        <div className="vpi-fill" style={{width:`${pct}%`,background:`linear-gradient(90deg,${st.color}88,${st.color})`}}/>
      </div>
    </div>
  );
});

const CompactItem = React.memo(function CompactItem({ v, selected, onSelect, idx }) {
  const st = getVesselStatus(v.speed);
  return (
    <div className={`vp-compact ${selected?"selected":""}`} onClick={()=>onSelect(v)} style={{animationDelay:`${Math.min(idx*10,200)}ms`}}>
      <span className="vpi-flag">{getFlagEmoji(v.flag)}</span>
      <span className="vp-compact-name">{v.vessel_name||"Unknown"}</span>
      <span className="vp-compact-imo mono" style={{fontSize:8,color:"#3d6a8a"}}>{v.imo_number||"—"}</span>
      <span className="vp-compact-spd" style={{color:st.color}}>{parseFloat(v.speed||0).toFixed(1)} kn</span>
      <span className="vp-compact-dot" style={{background:st.color}}/>
    </div>
  );
});