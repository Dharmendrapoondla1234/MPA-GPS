// PreferredShipsGrid.jsx — v6
// Per-user watchlist stored in BigQuery (not localStorage).
// Panel is resizable by the user. Contact details shown inline in UI.
import React, {
  useState, useEffect, useCallback, useMemo, useRef
} from "react";
import {
  fetchPreferredShips,
  addPreferredShipAPI,
  removePreferredShipAPI,
  clearPreferredShipsAPI,
  fetchVesselContacts,
  getCurrentUser,
} from "../services/api";
import "./PreferredShipsGrid.css";

const MAX_PREFERRED = 20;

// ── Shared in-memory state (synced with BigQuery) ─────────────────
let _preferred = [];
const _listeners = new Set();
function notifyListeners() { _listeners.forEach(fn => fn([..._preferred])); }

let _loaded = false;
export async function loadPreferredFromAPI() {
  try {
    const user = getCurrentUser();
    if (!user) { _preferred = []; notifyListeners(); return; }
    const data = await fetchPreferredShips();
    _preferred = Array.isArray(data) ? data : [];
    _loaded = true;
    notifyListeners();
  } catch (e) {
    console.warn("[PSG] Failed to load preferred ships from API:", e.message);
  }
}

export function addPreferred(vessel) {
  const imo = String(vessel?.imo_number || vessel?.imo || "");
  if (!imo || _preferred.some(v => String(v.imo_number) === imo)) return;
  const entry = {
    imo_number:  imo,
    vessel_name: vessel.vessel_name || vessel.name || "Unknown",
    vessel_type: vessel.vessel_type || null,
    flag:        vessel.flag || null,
    speed:       vessel.speed || 0,
    next_port:   vessel.next_port_destination || null,
    added_at:    Date.now(),
  };
  if (_preferred.length >= MAX_PREFERRED) _preferred.shift();
  _preferred = [..._preferred, entry];
  notifyListeners();
  const user = getCurrentUser();
  if (user) {
    addPreferredShipAPI(entry).catch(e =>
      console.warn("[PSG] addPreferredShipAPI failed:", e.message)
    );
  }
}

export function removePreferred(imo) {
  _preferred = _preferred.filter(v => String(v.imo_number) !== String(imo));
  notifyListeners();
  const user = getCurrentUser();
  if (user) {
    removePreferredShipAPI(imo).catch(e =>
      console.warn("[PSG] removePreferredShipAPI failed:", e.message)
    );
  }
}

export function isPreferred(imo) {
  return _preferred.some(v => String(v.imo_number) === String(imo));
}

export function usePreferred() {
  const [list, setList] = useState([..._preferred]);
  useEffect(() => {
    if (!_loaded) loadPreferredFromAPI();
    _listeners.add(setList);
    return () => _listeners.delete(setList);
  }, []);
  return list;
}

// ── Star button ───────────────────────────────────────────────────
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
      title={active ? "Remove from watchlist" : "Add to watchlist"}
    >{active ? "★" : "☆"}</button>
  );
}

// ── Speed color ───────────────────────────────────────────────────
function speedColor(spd) {
  const s = parseFloat(spd) || 0;
  if (s === 0) return "#546e7a";
  if (s < 4)   return "#ffaa00";
  if (s < 10)  return "#00e5ff";
  return "#00ff9d";
}

// ── Inline Contact Details ────────────────────────────────────────
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}

function ContactSection({ title, accent, company }) {
  if (!company?.company_name) return null;
  return (
    <div className="psg-contact-section">
      <div className="psg-cs-title" style={{ borderLeftColor: accent }}>{title}</div>
      <div className="psg-cs-name">{company.company_name}</div>
      {company.registered_address && (
        <div className="psg-cs-row">📍 <span>{company.registered_address}</span></div>
      )}
      {company.email && (
        <div className="psg-cs-row">
          ✉ <a href={`mailto:${company.email}`} className="psg-cs-link">{company.email}</a>
          <button className="psg-copy-btn" onClick={() => copyToClipboard(company.email)}>⎘</button>
        </div>
      )}
      {company.email_secondary && (
        <div className="psg-cs-row">
          ✉ <a href={`mailto:${company.email_secondary}`} className="psg-cs-link">{company.email_secondary}</a>
        </div>
      )}
      {company.phone && (
        <div className="psg-cs-row">
          ☎ <a href={`tel:${company.phone}`} className="psg-cs-link">{company.phone}</a>
          <button className="psg-copy-btn" onClick={() => copyToClipboard(company.phone)}>⎘</button>
        </div>
      )}
      {company.website && (
        <div className="psg-cs-row">
          🌐 <a
            href={company.website.startsWith("http") ? company.website : `https://${company.website}`}
            target="_blank" rel="noopener noreferrer" className="psg-cs-link"
          >{company.website}</a>
        </div>
      )}
    </div>
  );
}

function AgentSection({ agents }) {
  if (!agents?.length) return null;
  return (
    <div className="psg-contact-section">
      <div className="psg-cs-title" style={{ borderLeftColor: "#ffaa00" }}>⚓ Port Agents ({agents.length})</div>
      {agents.map((a, i) => (
        <div key={i} className="psg-agent-row">
          <div className="psg-cs-name">{a.agency_company || a.agent_name}</div>
          {a.port_name && <div className="psg-agent-port">⚓ {a.port_name}</div>}
          {a.email && (
            <div className="psg-cs-row">
              ✉ <a href={`mailto:${a.email}`} className="psg-cs-link">{a.email}</a>
              <button className="psg-copy-btn" onClick={() => copyToClipboard(a.email)}>⎘</button>
            </div>
          )}
          {a.phone && (
            <div className="psg-cs-row">☎ <a href={`tel:${a.phone}`} className="psg-cs-link">{a.phone}</a></div>
          )}
        </div>
      ))}
    </div>
  );
}

function ContactDetailPanel({ vessel, onClose }) {
  const [contacts, setContacts] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);

  // Destructure to stable primitives — never put object references in dep array
  const imo         = vessel?.imo_number   ?? null;
  const vesselName  = vessel?.vessel_name  ?? null;
  const currentPort = vessel?.current_port ?? null;
  const nextPort    = vessel?.next_port ?? vessel?.next_port_destination ?? null;
  const vesselType  = vessel?.vessel_type  ?? null;

  useEffect(() => {
    if (!imo && !vesselName) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setContacts(null);

    fetchVesselContacts(imo, { name: vesselName, currentPort, nextPort, vesselType })
      .then(d  => { if (!cancelled) { setContacts(d); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });

    return () => { cancelled = true; };
  }, [imo, vesselName, currentPort, nextPort, vesselType]);

  const hasAny = contacts && (
    contacts.owner?.company_name || contacts.operator?.company_name ||
    contacts.manager?.company_name || contacts.ship_manager?.company_name ||
    contacts.port_agents?.length
  );

  return (
    <div className="psg-contact-panel">
      <div className="psg-cp-header">
        <span>📋 {vesselName}</span>
        <button className="psg-contact-close" onClick={onClose}>✕</button>
      </div>
      {loading && (
        <div className="psg-cp-loading">
          <div className="psg-spinner" />
          <span>Fetching contact data…</span>
          <span className="psg-cp-loading-sub">Equasis → port agents → enrichment</span>
        </div>
      )}
      {error && <div className="psg-cp-error">⚠ {error}</div>}
      {!loading && !error && !hasAny && (
        <div className="psg-cp-empty">
          No contact data found.<br/>
          <small>Open the vessel detail panel and click 🤖 Re-enrich.</small>
        </div>
      )}
      {!loading && !error && hasAny && (
        <div className="psg-cp-body">
          <ContactSection title="Registered Owner" accent="#00e5ff" company={contacts.owner} />
          <ContactSection title="Operator"         accent="#fd9644" company={contacts.operator} />
          <ContactSection title="ISM Manager"      accent="#a78bfa" company={contacts.manager} />
          <ContactSection title="Ship Manager"     accent="#26de81" company={contacts.ship_manager} />
          <AgentSection agents={contacts.port_agents} />
        </div>
      )}
    </div>
  );
}

// ── Vessel card ────────────────────────────────────────────────────
function VesselCard({ vessel, onSelect, onRemove, onShowContact, contactActive }) {
  const spd      = parseFloat(vessel.speed) || 0;
  const col      = speedColor(spd);
  const isMoving = spd > 0.5;
  return (
    <div className={`psg-card ${contactActive ? "psg-card-active" : ""}`} onClick={() => onSelect(vessel)}>
      <div className="psg-card-header">
        <div className="psg-card-name" title={vessel.vessel_name}>{vessel.vessel_name}</div>
        <div className="psg-card-actions">
          <button
            className={`psg-contact-btn ${contactActive ? "active" : ""}`}
            onClick={e => { e.stopPropagation(); onShowContact(vessel); }}
            title="View contact details"
          >📋</button>
          <button
            className="psg-remove-btn"
            onClick={e => { e.stopPropagation(); onRemove(vessel.imo_number); }}
            title="Remove from watchlist"
          >✕</button>
        </div>
      </div>
      <div className="psg-card-imo">IMO {vessel.imo_number}</div>
      <div className="psg-card-metrics">
        <div className="psg-metric">
          <span className="psg-metric-val" style={{ color: col }}>{spd.toFixed(1)}</span>
          <span className="psg-metric-unit">kn</span>
        </div>
        <div className={`psg-status-dot ${isMoving ? "moving" : "stopped"}`} />
        <div className="psg-metric-label">{isMoving ? "UNDERWAY" : "STOPPED"}</div>
      </div>
      {vessel.next_port && (
        <div className="psg-card-dest" title={vessel.next_port}>→ {vessel.next_port}</div>
      )}
      <div className="psg-card-footer">
        {vessel.vessel_type && <span className="psg-tag">{vessel.vessel_type}</span>}
        {vessel.flag && <span className="psg-tag psg-tag-flag">{vessel.flag}</span>}
      </div>
    </div>
  );
}

// ── Search bar ────────────────────────────────────────────────────
function SearchBar({ query, onChange }) {
  return (
    <div className="psg-search-bar">
      <span className="psg-search-icon">🔍</span>
      <input
        className="psg-search-input"
        placeholder="Search watchlist…"
        value={query}
        onChange={e => onChange(e.target.value)}
      />
      {query && <button className="psg-search-clear" onClick={() => onChange("")}>✕</button>}
    </div>
  );
}

// ── Main grid — resizable ─────────────────────────────────────────
const MIN_W = 340;
const MAX_W = 1400;
const DEF_W = 920;

export default function PreferredShipsGrid({ vessels = [], onSelectVessel, isOpen, onClose }) {
  const preferred = usePreferred();
  const [query,         setQuery]         = useState("");
  const [sortBy,        setSortBy]        = useState("added");
  const [viewMode,      setView]          = useState("grid");
  const [contactVessel, setContactVessel] = useState(null);

  // Resizable panel
  const panelRef = useRef(null);
  const [panelW,  setPanelW] = useState(DEF_W);
  const dragging  = useRef(false);
  const startX    = useRef(0);
  const startW    = useRef(0);

  const onResizeMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    startX.current   = e.clientX;
    startW.current   = panelRef.current?.offsetWidth || panelW;
    document.body.style.userSelect = "none";
    document.body.style.cursor     = "ew-resize";
  }, [panelW]);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return;
      const newW = Math.min(MAX_W, Math.max(MIN_W, startW.current + (e.clientX - startX.current)));
      setPanelW(newW);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor     = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
  }, []);

  // Merge live AIS data into preferred list
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
      default:      return [...list].sort((a,b) => new Date(b.added_at||0) - new Date(a.added_at||0));
    }
  }, [enriched, query, sortBy]);

  const handleSelect = useCallback((vessel) => {
    const live = vessels.find(v => String(v.imo_number) === String(vessel.imo_number));
    onSelectVessel?.(live || vessel);
  }, [vessels, onSelectVessel]);

  const handleClearAll = useCallback(async () => {
    if (!window.confirm("Remove all vessels from your watchlist?")) return;
    const user = getCurrentUser();
    if (user) {
      try { await clearPreferredShipsAPI(); } catch(e) { console.warn(e); }
    }
    _preferred = [];
    notifyListeners();
  }, []);

  const handleShowContact = useCallback((vessel) => {
    setContactVessel(cv =>
      cv && String(cv.imo_number) === String(vessel.imo_number) ? null : vessel
    );
  }, []);

  if (!isOpen) return null;

  return (
    <div className="psg-overlay" onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div
        className="psg-panel"
        ref={panelRef}
        style={{ width: panelW, maxWidth: "calc(100vw - 32px)" }}
      >
        {/* Right edge drag-to-resize handle */}
        <div className="psg-resize-handle" onMouseDown={onResizeMouseDown} title="Drag to resize" />

        {/* Header */}
        <div className="psg-header">
          <div className="psg-header-left">
            <span className="psg-header-icon">★</span>
            <div>
              <div className="psg-title">MY WATCHLIST</div>
              <div className="psg-subtitle">
                {preferred.length} of {MAX_PREFERRED} vessels · 📋 = contacts · Click card to locate on map
              </div>
            </div>
          </div>
          <div className="psg-header-controls">
            <button className={`psg-view-btn ${viewMode==="grid"?"active":""}`} onClick={() => setView("grid")} title="Grid view">⊞</button>
            <button className={`psg-view-btn ${viewMode==="list"?"active":""}`} onClick={() => setView("list")} title="List view">☰</button>
            <button className="psg-close-btn" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Controls */}
        <div className="psg-controls">
          <SearchBar query={query} onChange={setQuery} />
          <div className="psg-sort-btns">
            <span className="psg-sort-label">Sort:</span>
            {["added","name","speed"].map(s => (
              <button
                key={s}
                className={`psg-sort-btn ${sortBy===s?"active":""}`}
                onClick={() => setSortBy(s)}
              >{s==="added"?"Recent":s.charAt(0).toUpperCase()+s.slice(1)}</button>
            ))}
          </div>
        </div>

        {/* Split body */}
        <div className="psg-body-split">
          <div className={`psg-body ${contactVessel ? "psg-body-narrow" : ""}`}>

            {filtered.length === 0 && preferred.length === 0 && (
              <div className="psg-empty">
                <div className="psg-empty-icon">☆</div>
                <div className="psg-empty-title">Your watchlist is empty</div>
                <div className="psg-empty-sub">
                  Click the <strong>☆</strong> star on any vessel's detail panel to add it here.
                  Your watchlist is saved to your account across all devices.
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
                    onShowContact={handleShowContact}
                    contactActive={contactVessel && String(contactVessel.imo_number) === String(v.imo_number)}
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
                      className={`psg-contact-btn-sm ${contactVessel && String(contactVessel.imo_number) === String(v.imo_number) ? "active" : ""}`}
                      onClick={e => { e.stopPropagation(); handleShowContact(v); }}
                      title="View contacts"
                    >📋</button>
                    <button
                      className="psg-list-remove"
                      onClick={e => { e.stopPropagation(); removePreferred(v.imo_number); }}
                    >✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Inline contact panel */}
          {contactVessel && (
            <ContactDetailPanel
              vessel={contactVessel}
              onClose={() => setContactVessel(null)}
            />
          )}
        </div>

        {/* Footer */}
        <div className="psg-footer">
          <button
            className="psg-clear-btn"
            onClick={handleClearAll}
            disabled={preferred.length === 0}
          >Clear All</button>
          <span className="psg-footer-hint">★ Star vessels in their detail panel · Synced to your account</span>
        </div>
      </div>
    </div>
  );
}
