// PreferredShipsGrid.jsx — Configurable watchlist grid
// Users star vessels → stored in localStorage → shown as a quick-access grid
import React, { useState, useEffect, useCallback, useMemo } from "react";
import "./PreferredShipsGrid.css";

const STORAGE_KEY = "mpa_preferred_ships";
const MAX_PREFERRED = 20;

// ── Persistence helpers ───────────────────────────────────────────
function loadPreferred() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}
function savePreferred(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch {}
}

// ── Global preferred state (shared across components) ─────────────
let _preferred = loadPreferred();
const _listeners = new Set();
function notifyListeners() { _listeners.forEach(fn => fn([..._preferred])); }

export function addPreferred(vessel) {
  const imo = String(vessel.imo_number || vessel.imo || "");
  if (!imo || _preferred.some(v => String(v.imo_number) === imo)) return;
  if (_preferred.length >= MAX_PREFERRED) _preferred.shift(); // drop oldest
  _preferred = [..._preferred, {
    imo_number:   imo,
    vessel_name:  vessel.vessel_name  || vessel.name || "Unknown",
    vessel_type:  vessel.vessel_type  || null,
    flag:         vessel.flag         || null,
    speed:        vessel.speed        || 0,
    heading:      vessel.heading      || 0,
    status:       vessel.vessel_status|| null,
    next_port:    vessel.next_port_destination || null,
    lat:          vessel.latitude_degrees || vessel.lat || null,
    lng:          vessel.longitude_degrees|| vessel.lng || null,
    added_at:     Date.now(),
  }];
  savePreferred(_preferred);
  notifyListeners();
}

export function removePreferred(imo) {
  _preferred = _preferred.filter(v => String(v.imo_number) !== String(imo));
  savePreferred(_preferred);
  notifyListeners();
}

export function isPreferred(imo) {
  return _preferred.some(v => String(v.imo_number) === String(imo));
}

export function usePreferred() {
  const [list, setList] = useState([..._preferred]);
  useEffect(() => {
    _listeners.add(setList);
    return () => _listeners.delete(setList);
  }, []);
  return list;
}

// ── Star button (embed anywhere) ─────────────────────────────────
export function StarButton({ vessel, className = "" }) {
  const preferred = usePreferred();
  const imo = String(vessel?.imo_number || "");
  const active = preferred.some(v => String(v.imo_number) === imo);

  const toggle = useCallback((e) => {
    e.stopPropagation();
    if (!vessel) return;
    if (active) removePreferred(imo);
    else addPreferred(vessel);
  }, [active, imo, vessel]);

  if (!imo) return null;
  return (
    <button
      className={`star-btn ${active ? "star-btn--on" : ""} ${className}`}
      onClick={toggle}
      title={active ? "Remove from preferred ships" : "Add to preferred ships"}
    >
      {active ? "★" : "☆"}
    </button>
  );
}

// ── Speed colour ─────────────────────────────────────────────────
function speedColor(spd) {
  const s = parseFloat(spd) || 0;
  if (s === 0) return "#546e7a";
  if (s < 4)   return "#ffaa00";
  if (s < 10)  return "#00e5ff";
  return "#00ff9d";
}

// ── Single vessel card ────────────────────────────────────────────
function VesselCard({ vessel, onSelect, onRemove }) {
  const spd   = parseFloat(vessel.speed) || 0;
  const col   = speedColor(spd);
  const isMoving = spd > 0.5;

  return (
    <div className="psg-card" onClick={() => onSelect(vessel)}>
      <div className="psg-card-header">
        <div className="psg-card-name" title={vessel.vessel_name}>
          {vessel.vessel_name}
        </div>
        <button
          className="psg-remove-btn"
          onClick={e => { e.stopPropagation(); onRemove(vessel.imo_number); }}
          title="Remove from preferred"
        >✕</button>
      </div>

      <div className="psg-card-imo">IMO {vessel.imo_number}</div>

      <div className="psg-card-metrics">
        <div className="psg-metric">
          <span className="psg-metric-val" style={{ color: col }}>
            {spd.toFixed(1)}
          </span>
          <span className="psg-metric-unit">kn</span>
        </div>
        <div className={`psg-status-dot ${isMoving ? "moving" : "stopped"}`} />
        <div className="psg-metric-label">
          {isMoving ? "UNDERWAY" : "STOPPED"}
        </div>
      </div>

      {vessel.next_port && (
        <div className="psg-card-dest" title={vessel.next_port}>
          → {vessel.next_port}
        </div>
      )}

      <div className="psg-card-footer">
        {vessel.vessel_type && <span className="psg-tag">{vessel.vessel_type}</span>}
        {vessel.flag && <span className="psg-tag psg-tag-flag">{vessel.flag}</span>}
      </div>
    </div>
  );
}

// ── Search row within grid ────────────────────────────────────────
function SearchBar({ query, onChange }) {
  return (
    <div className="psg-search-bar">
      <span className="psg-search-icon">🔍</span>
      <input
        className="psg-search-input"
        placeholder="Search preferred ships…"
        value={query}
        onChange={e => onChange(e.target.value)}
      />
      {query && (
        <button className="psg-search-clear" onClick={() => onChange("")}>✕</button>
      )}
    </div>
  );
}

// ── Main grid component ───────────────────────────────────────────
export default function PreferredShipsGrid({ vessels = [], onSelectVessel, isOpen, onClose }) {
  const preferred = usePreferred();
  const [query, setQuery]     = useState("");
  const [sortBy, setSortBy]   = useState("added"); // added | name | speed
  const [viewMode, setView]   = useState("grid"); // grid | list

  // Merge live data into preferred list
  const enriched = useMemo(() => {
    const liveMap = new Map(vessels.map(v => [String(v.imo_number), v]));
    return preferred.map(pv => {
      const live = liveMap.get(String(pv.imo_number));
      return live ? { ...pv, ...live, imo_number: pv.imo_number } : pv;
    });
  }, [preferred, vessels]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    let list = q
      ? enriched.filter(v =>
          (v.vessel_name || "").toLowerCase().includes(q) ||
          String(v.imo_number).includes(q) ||
          (v.next_port || "").toLowerCase().includes(q)
        )
      : enriched;

    switch (sortBy) {
      case "name":  return [...list].sort((a,b) => (a.vessel_name||"").localeCompare(b.vessel_name||""));
      case "speed": return [...list].sort((a,b) => (parseFloat(b.speed)||0) - (parseFloat(a.speed)||0));
      default:      return [...list].sort((a,b) => (b.added_at||0) - (a.added_at||0));
    }
  }, [enriched, query, sortBy]);

  const handleSelect = useCallback((vessel) => {
    // Find full vessel data from live list
    const live = vessels.find(v => String(v.imo_number) === String(vessel.imo_number));
    onSelectVessel?.(live || vessel);
  }, [vessels, onSelectVessel]);

  if (!isOpen) return null;

  return (
    <div className="psg-overlay" onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="psg-panel">

        {/* Header */}
        <div className="psg-header">
          <div className="psg-header-left">
            <span className="psg-header-icon">★</span>
            <div>
              <div className="psg-title">PREFERRED SHIPS</div>
              <div className="psg-subtitle">
                {preferred.length} of {MAX_PREFERRED} vessels · Click any vessel for full details
              </div>
            </div>
          </div>
          <div className="psg-header-controls">
            <button
              className={`psg-view-btn ${viewMode === "grid" ? "active" : ""}`}
              onClick={() => setView("grid")} title="Grid view"
            >⊞</button>
            <button
              className={`psg-view-btn ${viewMode === "list" ? "active" : ""}`}
              onClick={() => setView("list")} title="List view"
            >☰</button>
            <button className="psg-close-btn" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Controls bar */}
        <div className="psg-controls">
          <SearchBar query={query} onChange={setQuery} />
          <div className="psg-sort-btns">
            <span className="psg-sort-label">Sort:</span>
            {["added","name","speed"].map(s => (
              <button
                key={s}
                className={`psg-sort-btn ${sortBy === s ? "active" : ""}`}
                onClick={() => setSortBy(s)}
              >{s === "added" ? "Recent" : s.charAt(0).toUpperCase() + s.slice(1)}</button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="psg-body">
          {filtered.length === 0 && preferred.length === 0 && (
            <div className="psg-empty">
              <div className="psg-empty-icon">☆</div>
              <div className="psg-empty-title">No preferred ships yet</div>
              <div className="psg-empty-sub">
                Click the <strong>☆</strong> star on any vessel's detail panel to add it here.
                You can track up to {MAX_PREFERRED} vessels.
              </div>
            </div>
          )}

          {filtered.length === 0 && preferred.length > 0 && (
            <div className="psg-empty">
              <div className="psg-empty-icon">🔍</div>
              <div className="psg-empty-title">No matches for "{query}"</div>
            </div>
          )}

          {filtered.length > 0 && viewMode === "grid" && (
            <div className="psg-grid">
              {filtered.map(v => (
                <VesselCard
                  key={v.imo_number}
                  vessel={v}
                  onSelect={handleSelect}
                  onRemove={removePreferred}
                />
              ))}
            </div>
          )}

          {filtered.length > 0 && viewMode === "list" && (
            <div className="psg-list">
              {filtered.map(v => (
                <div key={v.imo_number} className="psg-list-row" onClick={() => handleSelect(v)}>
                  <div className="psg-list-name">{v.vessel_name}</div>
                  <div className="psg-list-imo">IMO {v.imo_number}</div>
                  <div className="psg-list-speed" style={{ color: speedColor(v.speed) }}>
                    {(parseFloat(v.speed)||0).toFixed(1)} kn
                  </div>
                  <div className="psg-list-dest">{v.next_port || "—"}</div>
                  <button
                    className="psg-list-remove"
                    onClick={e => { e.stopPropagation(); removePreferred(v.imo_number); }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="psg-footer">
          <button
            className="psg-clear-btn"
            onClick={() => { if (window.confirm("Remove all preferred ships?")) { _preferred = []; savePreferred([]); notifyListeners(); } }}
            disabled={preferred.length === 0}
          >Clear All</button>
          <span className="psg-footer-hint">★ Star any vessel in its detail panel to add here</span>
        </div>

      </div>
    </div>
  );
}
