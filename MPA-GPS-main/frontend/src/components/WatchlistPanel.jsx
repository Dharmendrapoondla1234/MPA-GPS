// src/components/WatchlistPanel.jsx
// Per-user vessel watchlist backed by BigQuery MPA_Watchlist table.
// Synced by user email. Fuel efficiency shown per card. Map-only filter.
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  getCurrentUser,
  fetchWatchlist,
  addToWatchlistAPI,
  removeFromWatchlistAPI,
  clearWatchlistAPI,
} from "../services/api";
import "./WatchlistPanel.css";

const BASE_URL = process.env.REACT_APP_API_URL || "https://maritime-connect.onrender.com/api";

// ── Shared module-level state (one source of truth across all components) ──
let _watchlist = [];
let _loaded    = false;
const _listeners = new Set();
function notifyWatchlistListeners() {
  _listeners.forEach(fn => fn([..._watchlist]));
}

export function useWatchlist() {
  const [list, setList] = useState([..._watchlist]);
  useEffect(() => {
    if (!_loaded) loadWatchlistFromAPI();
    _listeners.add(setList);
    return () => _listeners.delete(setList);
  }, []);
  return list;
}

export function isInWatchlist(imo) {
  return _watchlist.some(v => String(v.imo_number) === String(imo));
}

export async function loadWatchlistFromAPI() {
  const user = getCurrentUser();
  if (!user) { _watchlist = []; _loaded = true; notifyWatchlistListeners(); return; }
  try {
    const data = await fetchWatchlist();
    _watchlist = Array.isArray(data) ? data : [];
    _loaded    = true;
    notifyWatchlistListeners();
  } catch (e) {
    console.warn("[watchlist] load failed:", e.message);
    _loaded = true;
  }
}

export async function addToWatchlist(vessel) {
  const imo = String(vessel?.imo_number || "");
  if (!imo || isInWatchlist(imo)) return;
  const entry = {
    imo_number:  imo,
    vessel_name: vessel.vessel_name || "Unknown",
    vessel_type: vessel.vessel_type || null,
    flag:        vessel.flag || null,
    added_at:    new Date().toISOString(),
  };
  _watchlist = [..._watchlist, entry];
  notifyWatchlistListeners();
  try {
    await addToWatchlistAPI(entry);
  } catch (e) {
    console.warn("[watchlist] add failed:", e.message);
    _watchlist = _watchlist.filter(v => v.imo_number !== imo);
    notifyWatchlistListeners();
  }
}

export async function removeFromWatchlist(imo) {
  const prev = [..._watchlist];
  _watchlist = _watchlist.filter(v => String(v.imo_number) !== String(imo));
  notifyWatchlistListeners();
  try {
    await removeFromWatchlistAPI(imo);
  } catch (e) {
    console.warn("[watchlist] remove failed:", e.message);
    _watchlist = prev;
    notifyWatchlistListeners();
  }
}

export function WatchlistStar({ vessel, className = "" }) {
  const list   = useWatchlist();
  const imo    = String(vessel?.imo_number || "");
  const active = list.some(v => String(v.imo_number) === imo);
  const toggle = useCallback(e => {
    e.stopPropagation();
    if (!imo || !vessel) return;
    if (active) removeFromWatchlist(imo);
    else        addToWatchlist(vessel);
  }, [active, imo, vessel]);
  if (!imo) return null;
  return (
    <button
      className={`wl-star-btn ${active ? "wl-star-btn--on" : ""} ${className}`}
      onClick={toggle}
      title={active ? "Remove from watchlist" : "Add to watchlist"}
    >
      {active ? "★" : "☆"}
    </button>
  );
}

function CIIBadge({ rating }) {
  if (!rating || rating === "N/A") return null;
  const colors = { A: "#26de81", B: "#a3e635", C: "#ffaa00", D: "#fd7272", E: "#ff2244" };
  return (
    <span className="wl-cii-badge" style={{ background: colors[rating] || "#607d8b" }}>
      CII {rating}
    </span>
  );
}

function FuelGauge({ score }) {
  if (score == null) return null;
  const color = score >= 80 ? "#26de81" : score >= 60 ? "#a3e635" : score >= 40 ? "#ffaa00" : "#fd7272";
  return (
    <div className="wl-gauge-wrap" title={`Fuel efficiency: ${score}%`}>
      <div className="wl-gauge-bar" style={{ width: `${score}%`, background: color }} />
      <span className="wl-gauge-val">{score}%</span>
    </div>
  );
}

function WatchlistCard({ vessel, liveData, fuel, onSelect, onRemove, onLocate }) {
  const live     = liveData || vessel;
  const speed    = parseFloat(live?.speed || 0);
  const isMoving = speed > 0.5;
  const sc = speed === 0 ? "#546e7a" : speed < 4 ? "#ffaa00" : speed < 10 ? "#00e5ff" : "#00ff9d";

  return (
    <div className="wl-card" onClick={() => onSelect(live)}>
      <div className="wl-card-top">
        <div className="wl-card-name" title={vessel.vessel_name}>{vessel.vessel_name}</div>
        <div className="wl-card-actions">
          <button className="wl-locate-btn" onClick={e => { e.stopPropagation(); onLocate(live); }} title="Centre on map">📍</button>
          <button className="wl-remove-btn" onClick={e => { e.stopPropagation(); onRemove(vessel.imo_number); }} title="Remove">✕</button>
        </div>
      </div>
      <div className="wl-card-imo">IMO {vessel.imo_number}</div>
      <div className="wl-card-row">
        <span className="wl-speed" style={{ color: sc }}>{speed.toFixed(1)} kn</span>
        <span className={`wl-status ${isMoving ? "moving" : "stopped"}`}>
          {isMoving ? "● UNDERWAY" : "● STOPPED"}
        </span>
        {fuel?.cii_rating && <CIIBadge rating={fuel.cii_rating} />}
      </div>
      {fuel && (
        <div className="wl-fuel-row">
          <span className="wl-fuel-label">Efficiency</span>
          <FuelGauge score={fuel.efficiency_score} />
        </div>
      )}
      {fuel && isMoving && (
        <div className="wl-fuel-details">
          <span>⛽ {fuel.fuel_consumption_mt_day} MT/day</span>
          <span>💨 {fuel.co2_emissions_mt_day} t CO₂</span>
          <span>💲{(fuel.est_fuel_cost_usd_day || 0).toLocaleString()}/day</span>
        </div>
      )}
      {live?.next_port_destination && (
        <div className="wl-dest">→ {live.next_port_destination}</div>
      )}
      <div className="wl-card-footer">
        {vessel.vessel_type && <span className="wl-tag">{vessel.vessel_type}</span>}
        {vessel.flag        && <span className="wl-tag wl-tag-flag">{vessel.flag}</span>}
      </div>
    </div>
  );
}

export default function WatchlistPanel({ vessels = [], onSelectVessel, onLocateVessel, isOpen, onClose }) {
  const watchlist  = useWatchlist();
  const [query,       setQuery]       = useState("");
  const [sortBy,      setSortBy]      = useState("added");
  const [fuelData,    setFuelData]    = useState({});
  const [showMapOnly, setShowMapOnly] = useState(false);
  const [fuelLoading, setFuelLoading] = useState(false);
  const fetchedImos = useRef(new Set());

  const liveMap = useMemo(() => new Map(vessels.map(v => [String(v.imo_number), v])), [vessels]);

  // Load fuel data for new watchlist entries whenever panel opens
  useEffect(() => {
    if (!isOpen || !watchlist.length) return;
    const newImos = watchlist.map(v => String(v.imo_number)).filter(imo => !fetchedImos.current.has(imo));
    if (!newImos.length) return;
    newImos.forEach(imo => fetchedImos.current.add(imo));
    setFuelLoading(true);
    Promise.all(
      newImos.map(imo =>
        fetch(`${BASE_URL}/fuel/vessel/${imo}`)
          .then(r => r.json()).then(j => ({ imo, data: j?.data || null }))
          .catch(() => ({ imo, data: null }))
      )
    ).then(results => {
      const updates = {};
      results.forEach(r => { if (r.data) updates[r.imo] = r.data; });
      setFuelData(prev => ({ ...prev, ...updates }));
      setFuelLoading(false);
    });
  }, [isOpen, watchlist]);

  const enriched = useMemo(() =>
    watchlist.map(wv => {
      const live = liveMap.get(String(wv.imo_number));
      return live ? { ...wv, ...live, imo_number: wv.imo_number, vessel_name: wv.vessel_name } : wv;
    }), [watchlist, liveMap]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    let list = q
      ? enriched.filter(v =>
          (v.vessel_name || "").toLowerCase().includes(q) ||
          String(v.imo_number).includes(q) ||
          (v.next_port_destination || "").toLowerCase().includes(q) ||
          (v.flag || "").toLowerCase().includes(q))
      : enriched;
    if (showMapOnly) list = list.filter(v => liveMap.has(String(v.imo_number)));
    switch (sortBy) {
      case "name":       return [...list].sort((a,b) => (a.vessel_name||"").localeCompare(b.vessel_name||""));
      case "speed":      return [...list].sort((a,b) => (parseFloat(b.speed)||0)-(parseFloat(a.speed)||0));
      case "efficiency": return [...list].sort((a,b) => {
        const ea = fuelData[String(a.imo_number)]?.efficiency_score ?? 101;
        const eb = fuelData[String(b.imo_number)]?.efficiency_score ?? 101;
        return ea - eb;
      });
      default:           return [...list].sort((a,b) => new Date(b.added_at||0)-new Date(a.added_at||0));
    }
  }, [enriched, query, sortBy, showMapOnly, liveMap, fuelData]);

  const fuelVals  = Object.values(fuelData);
  const underway  = vessels.filter(v => isInWatchlist(v.imo_number) && parseFloat(v.speed||0) > 0.5).length;
  const avgEff    = fuelVals.length ? Math.round(fuelVals.reduce((s,f)=>s+(f.efficiency_score||0),0)/fuelVals.length) : null;
  const totalFuel = Math.round(fuelVals.reduce((s,f)=>s+(f.fuel_consumption_mt_day||0),0));
  const totalCost = Math.round(fuelVals.reduce((s,f)=>s+(f.est_fuel_cost_usd_day||0),0)/1000);

  const watchlistImos = useMemo(() => new Set(watchlist.map(v => String(v.imo_number))), [watchlist]);
  const onMapCount    = vessels.filter(v => watchlistImos.has(String(v.imo_number))).length;

  const handleClearAll = useCallback(async () => {
    if (!window.confirm("Remove all vessels from your watchlist?")) return;
    try {
      await clearWatchlistAPI();
      _watchlist = []; fetchedImos.current.clear(); setFuelData({});
      notifyWatchlistListeners();
    } catch (e) { console.warn("[watchlist] clear failed:", e.message); }
  }, []);

  if (!isOpen) return null;

  return (
    <div className="wl-overlay" onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="wl-panel">

        <div className="wl-header">
          <div className="wl-header-left">
            <span className="wl-header-icon">★</span>
            <div>
              <div className="wl-title">MY WATCHLIST</div>
              <div className="wl-subtitle">
                {watchlist.length} vessels · {onMapCount} live on map
                {fuelLoading && " · loading fuel data…"}
              </div>
            </div>
          </div>
          <button className="wl-close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="wl-controls">
          <div className="wl-search-wrap">
            <span className="wl-search-icon">🔍</span>
            <input
              className="wl-search"
              placeholder="Search name, IMO, port, flag…"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            {query && <button className="wl-search-clear" onClick={() => setQuery("")}>✕</button>}
          </div>
          <div className="wl-sort-row">
            <label className="wl-toggle-label">
              <input type="checkbox" checked={showMapOnly} onChange={e => setShowMapOnly(e.target.checked)} />
              Map only
            </label>
            <span className="wl-sort-label">Sort:</span>
            {[
              ["added","Recent"], ["name","Name"], ["speed","Speed"], ["efficiency","Efficiency"]
            ].map(([id, lbl]) => (
              <button key={id} className={`wl-sort-btn ${sortBy===id?"active":""}`} onClick={() => setSortBy(id)}>{lbl}</button>
            ))}
          </div>
        </div>

        {watchlist.length > 0 && (
          <div className="wl-fleet-bar">
            <div className="wl-fleet-stat"><span className="wl-fleet-val">{underway}</span><span className="wl-fleet-label">Underway</span></div>
            <div className="wl-fleet-stat"><span className="wl-fleet-val">{avgEff != null ? `${avgEff}%` : "—"}</span><span className="wl-fleet-label">Avg Efficiency</span></div>
            <div className="wl-fleet-stat"><span className="wl-fleet-val">{totalFuel} MT</span><span className="wl-fleet-label">Fuel / day</span></div>
            <div className="wl-fleet-stat"><span className="wl-fleet-val">${totalCost}k</span><span className="wl-fleet-label">Cost / day</span></div>
          </div>
        )}

        <div className="wl-body">
          {watchlist.length === 0 && (
            <div className="wl-empty">
              <div className="wl-empty-icon">☆</div>
              <div className="wl-empty-title">Watchlist is empty</div>
              <div className="wl-empty-sub">
                Tap <strong>☆</strong> on any vessel detail panel to add it.<br/>
                Saves to BigQuery and persists across devices.
              </div>
            </div>
          )}
          {watchlist.length > 0 && filtered.length === 0 && (
            <div className="wl-empty">
              <div className="wl-empty-icon">🔍</div>
              <div className="wl-empty-title">No matches for "{query}"</div>
            </div>
          )}
          <div className="wl-grid">
            {filtered.map(v => (
              <WatchlistCard
                key={v.imo_number}
                vessel={v}
                liveData={liveMap.get(String(v.imo_number))}
                fuel={fuelData[String(v.imo_number)] || null}
                onSelect={vessel => onSelectVessel?.(vessel)}
                onRemove={imo => removeFromWatchlist(imo)}
                onLocate={vessel => { onLocateVessel?.(vessel); onClose?.(); }}
              />
            ))}
          </div>
        </div>

        <div className="wl-footer">
          <button className="wl-clear-btn" onClick={handleClearAll} disabled={watchlist.length === 0}>
            Clear All
          </button>
          <span className="wl-footer-hint">★ Synced to BigQuery · 📍 to locate on map</span>
        </div>

      </div>
    </div>
  );
}
