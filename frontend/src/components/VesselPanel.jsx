// src/components/VesselPanel.jsx — Redesigned v3: cleaner, mobile-first
import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import {   getFlagEmoji } from "../utils/vesselUtils";
import "./VesselPanel.css";

function speedLabel(s) {
  if (s <= 0.3) return { label: "STOP", color: "#90a4ae" };
  if (s < 5)    return { label: "SLOW", color: "#26de81" };
  if (s < 12)   return { label: "MED",  color: "#fd9644" };
  return             { label: "FAST", color: "#fc5c65" };
}

export default function VesselPanel({ vessels, selectedId, onSelect, loading, stats, onMinimize, panelOpen = true }) {
  const [sort,   setSort]   = useState("speed_desc");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return vessels;
    const q = search.trim().toLowerCase();
    const isNum = /^\d+$/.test(search.trim());
    const out = vessels.filter(v =>
      (v.vessel_name || "").toLowerCase().includes(q) ||
      String(v.imo_number  || "").includes(search.trim()) ||
      String(v.mmsi_number || "").includes(search.trim()) ||
      (v.flag || "").toLowerCase().includes(q)
    );
    if (isNum) out.sort((a, b) => {
      const ae = String(a.imo_number) === search.trim() || String(a.mmsi_number) === search.trim();
      const be = String(b.imo_number) === search.trim() || String(b.mmsi_number) === search.trim();
      return (be ? 1 : 0) - (ae ? 1 : 0);
    });
    return out;
  }, [vessels, search]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sort) {
      case "name":       return arr.sort((a, b) => (a.vessel_name || "").localeCompare(b.vessel_name || ""));
      case "speed_desc": return arr.sort((a, b) => (parseFloat(b.speed) || 0) - (parseFloat(a.speed) || 0));
      case "speed_asc":  return arr.sort((a, b) => (parseFloat(a.speed) || 0) - (parseFloat(b.speed) || 0));
      case "dw_desc":    return arr.sort((a, b) => (parseFloat(b.deadweight) || 0) - (parseFloat(a.deadweight) || 0));
      default: return arr;
    }
  }, [filtered, sort]);

  // Counts
  const counts = useMemo(() => {
    const underway = vessels.filter(v => (parseFloat(v.speed) || 0) > 0.3).length;
    const stopped  = vessels.filter(v => (parseFloat(v.speed) || 0) <= 0.3).length;
    const flags    = new Set(vessels.map(v => v.flag).filter(Boolean)).size;
    return { underway, stopped, flags };
  }, [vessels]);

  const total = vessels.length || 1;
  const bands = useMemo(() => ({
    stopped: vessels.filter(v => (parseFloat(v.speed)||0) <= 0.3).length / total,
    slow:    vessels.filter(v => { const s=parseFloat(v.speed)||0; return s>0.3&&s<5; }).length / total,
    med:     vessels.filter(v => { const s=parseFloat(v.speed)||0; return s>=5&&s<12; }).length / total,
    fast:    vessels.filter(v => (parseFloat(v.speed)||0) >= 12).length / total,
  }), [vessels, total]);

  return (
    <div className="vp-root">
      {/* ── Header ── */}
      <div className="vp-header">
        <div className="vp-title-row">
          <div className="vp-fleet-info">
            <span className="vp-fleet-num">{loading ? "…" : vessels.length.toLocaleString()}</span>
            <span className="vp-fleet-lbl">VESSELS LIVE</span>
          </div>
          <button className="vp-collapse-btn" onClick={() => onMinimize?.()} title="Hide panel">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
        </div>

        {/* Stats chips */}
        <div className="vp-stats-row">
          <div className="vp-stat-chip vp-stat-underway">
            <span className="vp-stat-dot" style={{ background:"#26de81" }}/>
            <span className="vp-stat-val">{counts.underway}</span>
            <span className="vp-stat-lbl">UNDERWAY</span>
          </div>
          <div className="vp-stat-chip vp-stat-stopped">
            <span className="vp-stat-dot" style={{ background:"#90a4ae" }}/>
            <span className="vp-stat-val">{counts.stopped}</span>
            <span className="vp-stat-lbl">AT REST</span>
          </div>
          <div className="vp-stat-chip">
            <span className="vp-stat-val">{counts.flags}</span>
            <span className="vp-stat-lbl">FLAGS</span>
          </div>
        </div>

        {/* Speed distribution bar */}
        <div className="vp-speed-bar" title="Speed distribution">
          {[
            { w: bands.stopped, c: "#90a4ae" },
            { w: bands.slow,    c: "#26de81" },
            { w: bands.med,     c: "#fd9644" },
            { w: bands.fast,    c: "#fc5c65" },
          ].map((s, i) => s.w > 0 && (
            <div key={i} style={{ width: `${s.w*100}%`, background: s.c, height: "100%", borderRadius: "2px", transition: "width 0.8s" }}/>
          ))}
        </div>

        {/* Search */}
        <div className="vp-search">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            className="vp-search-input"
            placeholder="Search vessel, IMO, flag…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && <button className="vp-search-clear" onClick={() => setSearch("")}>✕</button>}
        </div>

        {/* Sort */}
        <div className="vp-sort-row">
          <select className="vp-sort" value={sort} onChange={e => setSort(e.target.value)}>
            <option value="speed_desc">Speed ↓</option>
            <option value="speed_asc">Speed ↑</option>
            <option value="name">Name A–Z</option>
            <option value="dw_desc">Deadweight ↓</option>
          </select>
          <span className="vp-count-lbl">{filtered.length !== vessels.length ? `${filtered.length} / ` : ""}{vessels.length}</span>
        </div>
      </div>

      {/* ── List ── */}
      {panelOpen && (
        loading && vessels.length === 0 ? (
          <div className="vp-skels">
            {[...Array(6)].map((_, i) => <div key={i} className="vp-skel" style={{ animationDelay: i*0.08+"s" }}/>)}
          </div>
        ) : sorted.length === 0 ? (
          <div className="vp-empty">
            <span className="vp-empty-icon">⚓</span>
            <span>{search ? "No matches found" : "No vessels"}</span>
          </div>
        ) : (
          <VirtualList items={sorted} selectedId={selectedId} onSelect={onSelect} />
        )
      )}
    </div>
  );
}

// ── Virtual list ─────────────────────────────────────────────────────────────
const ITEM_H = 56;
const OVERSCAN = 6;

function VirtualList({ items, selectedId, onSelect }) {
  const containerRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    if (!selectedId || !containerRef.current) return;
    const idx = items.findIndex(v => v.imo_number === selectedId);
    if (idx < 0) return;
    const top = idx * ITEM_H;
    const bot = top + ITEM_H;
    const { scrollTop: st, clientHeight } = containerRef.current;
    if (top < st || bot > st + clientHeight) {
      containerRef.current.scrollTop = top - clientHeight / 2 + ITEM_H / 2;
    }
  }, [selectedId, items]);

  const handleScroll = useCallback(e => setScrollTop(e.currentTarget.scrollTop), []);
  const viewH = 600;
  const startIdx = Math.max(0, Math.floor(scrollTop / ITEM_H) - OVERSCAN);
  const endIdx   = Math.min(items.length, Math.ceil((scrollTop + viewH) / ITEM_H) + OVERSCAN);
  const visible  = items.slice(startIdx, endIdx);

  return (
    <div ref={containerRef} className="vp-list" onScroll={handleScroll}
      style={{ overflowY:"auto", height:"100%", contain:"strict" }}>
      {startIdx > 0 && <div style={{ height: startIdx * ITEM_H }}/>}
      {visible.map(v => <VesselItem key={v.imo_number} v={v} selected={v.imo_number === selectedId} onSelect={onSelect}/>)}
      {endIdx < items.length && <div style={{ height: (items.length - endIdx) * ITEM_H }}/>}
    </div>
  );
}

const VesselItem = React.memo(function VesselItem({ v, selected, onSelect }) {
  const speed = parseFloat(v.speed || 0);
  const spd   = speedLabel(speed);
  const pct   = Math.min((speed / 25) * 100, 100);
  return (
    <div className={"vp-item" + (selected ? " vp-item--sel" : "")} onClick={() => onSelect(v)}>
      {selected && <div className="vp-sel-bar"/>}
      <div className="vp-item-main">
        <span className="vp-item-flag">{getFlagEmoji(v.flag)}</span>
        <div className="vp-item-text">
          <div className="vp-item-name">{v.vessel_name || "Unknown Vessel"}</div>
          <div className="vp-item-meta">
            <span className="vp-item-imo">{v.imo_number || "—"}</span>
            {v.vessel_type && <span className="vp-item-type">{v.vessel_type}</span>}
          </div>
        </div>
        <div className="vp-item-spd" style={{ color: spd.color, borderColor: spd.color+"33", background: spd.color+"0d" }}>
          <span className="vp-item-spd-val">{speed.toFixed(1)}</span>
          <span className="vp-item-spd-unit">kn</span>
        </div>
      </div>
      <div className="vp-item-bar">
        <div className="vp-item-fill" style={{ width: pct+"%", background: `linear-gradient(90deg, ${spd.color}66, ${spd.color})` }}/>
      </div>
    </div>
  );
});