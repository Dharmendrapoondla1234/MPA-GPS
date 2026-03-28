// src/components/PortAgentIntelligencePanel.jsx — MPA v1
// Full Port Agent Intelligence System panel:
//   - Search by IMO / MMSI / vessel name
//   - Shows vessel info, operator contact, ranked port agents
//   - Confidence scoring, source pills, copy-to-clipboard
//   - Matches exact response format from /api/vessel-contact spec
import React, { useState, useCallback, useRef, useEffect, memo } from "react";
import { fetchVesselContactSpec } from "../services/api";
import "./PortAgentIntelligencePanel.css";

// ── Helpers ───────────────────────────────────────────────────────
function confColor(v) {
  if (v >= 0.88) return "#00ff9d";
  if (v >= 0.70) return "#fd9644";
  return "#fc5c65";
}
function confLabel(v) {
  if (v >= 0.88) return "HIGH";
  if (v >= 0.70) return "MEDIUM";
  return "LOW";
}

const SOURCE_MAP = {
  equasis: { label: "Equasis", color: "#00e5ff" },
  ai_search: { label: "AI Web", color: "#a78bfa" },
  ai_enriched: { label: "AI", color: "#a78bfa" },
  scrape: { label: "Scraped", color: "#00ff9d" },
  google_cse: { label: "Google", color: "#fd9644" },
  vesselfinder: { label: "VF", color: "#607d8b" },
  bigquery: { label: "BQ Cache", color: "#38bdf8" },
  port_agent_db: { label: "DB", color: "#26de81" },
};

function SourcePill({ src }) {
  if (!src) return null;
  const parts = src.split("+");
  return (
    <div className="pai-pills">
      {parts.map((p) => {
        const m = SOURCE_MAP[p] || { label: p, color: "#78909c" };
        return (
          <span key={p} className="pai-pill" style={{ borderColor: m.color, color: m.color }}>
            {m.label}
          </span>
        );
      })}
    </div>
  );
}

function CopyBtn({ value }) {
  const [ok, setOk] = useState(false);
  const copy = useCallback(() => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setOk(true); setTimeout(() => setOk(false), 1400);
    }).catch(() => {});
  }, [value]);
  if (!value) return null;
  return (
    <button className="pai-copy" onClick={copy} title="Copy">
      {ok ? "✓" : "⎘"}
    </button>
  );
}

function ContactLine({ icon, label, value, href }) {
  if (!value) return null;
  return (
    <div className="pai-cline">
      <span className="pai-cline-icon">{icon}</span>
      <div className="pai-cline-body">
        <span className="pai-cline-label">{label}</span>
        {href
          ? <a className="pai-cline-val pai-link" href={href} target="_blank" rel="noopener noreferrer">{value}</a>
          : <span className="pai-cline-val">{value}</span>}
      </div>
      <CopyBtn value={value} />
    </div>
  );
}

// ── Operator Card ─────────────────────────────────────────────────
function OperatorCard({ data }) {
  if (!data) return (
    <div className="pai-card pai-card-empty">
      <div className="pai-card-head" style={{ "--accent": "#00e5ff" }}>OWNER / OPERATOR</div>
      <div className="pai-empty">No company data found</div>
    </div>
  );
  return (
    <div className="pai-card">
      <div className="pai-card-head" style={{ "--accent": "#00e5ff" }}>
        OWNER / OPERATOR
        {data.data_source && <SourcePill src={data.data_source} />}
      </div>
      <div className="pai-company-name">{data.name}</div>
      {data.type && <div className="pai-company-type">{data.type}</div>}
      {data.registered_address && (
        <div className="pai-address">{data.registered_address}</div>
      )}
      <div className="pai-contact-rows">
        <ContactLine icon="✉" label="Email" value={data.contact?.email}
          href={data.contact?.email ? `mailto:${data.contact.email}` : null} />
        <ContactLine icon="☎" label="Phone" value={data.contact?.phone} />
        {data.contact?.website && (
          <ContactLine icon="🌐" label="Website" value={data.contact.website}
            href={data.contact.website} />
        )}
      </div>
    </div>
  );
}

// ── Manager Card ──────────────────────────────────────────────────
function ManagerCard({ data, label = "MANAGER" }) {
  if (!data?.name) return null;
  return (
    <div className="pai-card pai-card-mgr">
      <div className="pai-card-head" style={{ "--accent": "#a78bfa" }}>{label}</div>
      <div className="pai-company-name">{data.name}</div>
      {data.data_source && <SourcePill src={data.data_source} />}
    </div>
  );
}

// ── Agent Card ────────────────────────────────────────────────────
function AgentCard({ agent, rank }) {
  const conf = parseFloat(agent.confidence_score) / 100 || 0;
  const col  = confColor(conf);
  const [open, setOpen] = useState(rank === 0);
  return (
    <div className={`pai-agent-card${rank === 0 ? " pai-agent-top" : ""}`}>
      <div className="pai-agent-header" onClick={() => setOpen(o => !o)}>
        <div className="pai-agent-rank" style={{ color: col }}>#{rank + 1}</div>
        <div className="pai-agent-identity">
          <div className="pai-agent-name">{agent.agent_name}</div>
          {agent.port_code && (
            <div className="pai-agent-port">
              {agent.port_name || agent.port_code}
              {agent.port_context && <span className="pai-agent-ctx"> · {agent.port_context}</span>}
            </div>
          )}
        </div>
        <div className="pai-agent-conf" style={{ color: col }}>
          <span className="pai-conf-val">{Math.round(conf * 100)}%</span>
          <span className="pai-conf-lbl">{confLabel(conf)}</span>
        </div>
        <div className="pai-agent-chevron">{open ? "▲" : "▼"}</div>
      </div>

      {open && (
        <div className="pai-agent-body">
          {agent.services?.length > 0 && (
            <div className="pai-services">
              {agent.services.map(s => (
                <span key={s} className="pai-service-tag">{s}</span>
              ))}
            </div>
          )}
          <div className="pai-contact-rows">
            <ContactLine icon="✉" label="Email" value={agent.contact?.email}
              href={agent.contact?.email ? `mailto:${agent.contact.email}` : null} />
            <ContactLine icon="☎" label="Phone" value={agent.contact?.phone} />
            {agent.contact?.phone_24h && (
              <ContactLine icon="🆘" label="24h Line" value={agent.contact.phone_24h} />
            )}
            {agent.contact?.vhf && (
              <ContactLine icon="📡" label="VHF" value={agent.contact.vhf} />
            )}
            {agent.website && (
              <ContactLine icon="🌐" label="Website" value={agent.website}
                href={agent.website} />
            )}
          </div>
          {agent.contact_person && (
            <div className="pai-contact-person">Contact: {agent.contact_person}</div>
          )}
          {agent.data_source && <SourcePill src={agent.data_source} />}
          <div className="pai-captain-note">
            📌 Captain contact available via this agent only
          </div>
        </div>
      )}
    </div>
  );
}

// ── Search Form ───────────────────────────────────────────────────
function SearchForm({ onSearch, loading }) {
  const [imo,       setImo]       = useState("");
  const [mmsi,      setMmsi]      = useState("");
  const [name,      setName]      = useState("");
  const [curPort,   setCurPort]   = useState("");
  const [nextPort,  setNextPort]  = useState("");
  const [vtype,     setVtype]     = useState("");

  const submit = useCallback((e) => {
    e.preventDefault();
    if (!imo && !mmsi && !name) return;
    onSearch({ imo: imo || undefined, mmsi: mmsi || undefined,
               name: name || undefined, currentPort: curPort || undefined,
               nextPort: nextPort || undefined, vesselType: vtype || undefined });
  }, [imo, mmsi, name, curPort, nextPort, vtype, onSearch]);

  return (
    <form className="pai-search-form" onSubmit={submit}>
      <div className="pai-search-grid">
        <div className="pai-field">
          <label className="pai-field-label">IMO NUMBER</label>
          <input className="pai-input" placeholder="e.g. 9234567"
            value={imo} onChange={e => setImo(e.target.value.replace(/\D/g,""))} />
        </div>
        <div className="pai-field">
          <label className="pai-field-label">MMSI</label>
          <input className="pai-input" placeholder="e.g. 563012345"
            value={mmsi} onChange={e => setMmsi(e.target.value.replace(/\D/g,""))} />
        </div>
        <div className="pai-field pai-field-wide">
          <label className="pai-field-label">VESSEL NAME</label>
          <input className="pai-input" placeholder="e.g. EVER GIVEN"
            value={name} onChange={e => setName(e.target.value.toUpperCase())} />
        </div>
        <div className="pai-field">
          <label className="pai-field-label">CURRENT PORT</label>
          <input className="pai-input" placeholder="e.g. SGSIN"
            value={curPort} onChange={e => setCurPort(e.target.value.toUpperCase())} />
        </div>
        <div className="pai-field">
          <label className="pai-field-label">NEXT PORT</label>
          <input className="pai-input" placeholder="e.g. NLRTM"
            value={nextPort} onChange={e => setNextPort(e.target.value.toUpperCase())} />
        </div>
        <div className="pai-field">
          <label className="pai-field-label">VESSEL TYPE</label>
          <select className="pai-input pai-select" value={vtype} onChange={e => setVtype(e.target.value)}>
            <option value="">Any</option>
            <option value="CONTAINER">Container</option>
            <option value="TANKER">Tanker</option>
            <option value="BULK">Bulk Carrier</option>
            <option value="CARGO">General Cargo</option>
            <option value="GAS">Gas Carrier</option>
          </select>
        </div>
      </div>
      <button type="submit" className="pai-search-btn" disabled={loading || (!imo && !mmsi && !name)}>
        {loading
          ? <><span className="pai-btn-spinner" />SEARCHING…</>
          : <><span className="pai-radar-icon">◎</span>FIND CONTACTS</>}
      </button>
    </form>
  );
}

// ── Main Panel ────────────────────────────────────────────────────
const PortAgentIntelligencePanel = memo(function PortAgentIntelligencePanel({
  isOpen, onClose, selectedVessel
}) {
  const [result,  setResult]  = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [query,   setQuery]   = useState(null);
  const panelRef = useRef(null);

  // Auto-search when a vessel is selected on the map
  useEffect(() => {
    if (!selectedVessel || !isOpen) return;
    const q = {
      imo:         selectedVessel.imo_number  || undefined,
      mmsi:        selectedVessel.mmsi_number || undefined,
      name:        selectedVessel.vessel_name || undefined,
      currentPort: selectedVessel.last_port_departed || selectedVessel.vessel_status === "MOORED"
                   ? selectedVessel.next_port_destination : undefined,
      nextPort:    selectedVessel.next_port_destination || undefined,
      vesselType:  selectedVessel.vessel_type || undefined,
    };
    if (q.imo || q.mmsi || q.name) {
      setQuery(q);
      doSearch(q);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVessel?.imo_number, isOpen]);

  const doSearch = useCallback(async (params) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchVesselContactSpec(params.imo, {
        mmsi:        params.mmsi,
        name:        params.name,
        currentPort: params.currentPort,
        nextPort:    params.nextPort,
        vesselType:  params.vesselType,
      });
      setResult(data);
    } catch (err) {
      setError(err.message || "Failed to fetch contacts");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = useCallback((params) => {
    setQuery(params);
    doSearch(params);
  }, [doSearch]);

  if (!isOpen) return null;

  const hasAgents  = result?.port_agents?.length > 0;
  const enrich     = result?.enrichment;

  return (
    <div className="pai-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pai-panel" ref={panelRef}>

        {/* Header */}
        <div className="pai-header">
          <div className="pai-header-left">
            <div className="pai-radar">
              <div className="pai-radar-ring" />
              <div className="pai-radar-ring" style={{ animationDelay: "0.7s" }} />
              <div className="pai-radar-dot" />
            </div>
            <div>
              <div className="pai-title">PORT AGENT INTELLIGENCE</div>
              <div className="pai-subtitle">Global contact resolution · AI-enriched · Confidence-scored</div>
            </div>
          </div>
          <button className="pai-close" onClick={onClose}>✕</button>
        </div>

        {/* Search */}
        <div className="pai-search-section">
          <SearchForm onSearch={handleSearch} loading={loading} />
        </div>

        {/* Results */}
        <div className="pai-results">

          {!result && !loading && !error && (
            <div className="pai-empty-state">
              <div className="pai-empty-icon">⚓</div>
              <div className="pai-empty-title">Enter vessel identifiers above</div>
              <div className="pai-empty-sub">
                The system will query Equasis, AI web search, and the global port agent database
                to return verified contacts for the operator and port agents.
              </div>
              <div className="pai-db-stats">
                <span>🌍 30+ ports worldwide</span>
                <span>·</span>
                <span>5-step enrichment pipeline</span>
                <span>·</span>
                <span>Confidence-scored results</span>
              </div>
            </div>
          )}

          {error && (
            <div className="pai-error">
              <span>⚠ {error}</span>
              <button onClick={() => query && doSearch(query)}>Retry</button>
            </div>
          )}

          {loading && (
            <div className="pai-loading">
              <div className="pai-loading-radar">
                <div className="pai-loading-sweep" />
              </div>
              <div className="pai-loading-text">
                <div className="pai-loading-step">Querying Equasis…</div>
                <div className="pai-loading-step" style={{ animationDelay: "1.2s" }}>AI web search…</div>
                <div className="pai-loading-step" style={{ animationDelay: "2.4s" }}>Matching port agents…</div>
              </div>
            </div>
          )}

          {result && !loading && (
            <div className="pai-result-body">

              {/* Vessel header */}
              <div className="pai-vessel-bar">
                <div className="pai-vessel-info">
                  <span className="pai-vessel-name">{result.vessel?.name || "—"}</span>
                  <span className="pai-vessel-ids">
                    {result.vessel?.imo && <span>IMO {result.vessel.imo}</span>}
                    {result.vessel?.mmsi && <span>MMSI {result.vessel.mmsi}</span>}
                  </span>
                </div>
                <div className="pai-port-route">
                  {result.port?.current && (
                    <div className="pai-port-badge pai-port-current" title="Current port">
                      <span className="pai-port-arrow">⬡</span> {result.port.current}
                    </div>
                  )}
                  {result.port?.next && (
                    <>
                      <span className="pai-route-arrow">→</span>
                      <div className="pai-port-badge pai-port-next" title="Next port">
                        <span className="pai-port-arrow">◎</span> {result.port.next}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Enrichment meta */}
              {enrich && (
                <div className="pai-enrich-bar">
                  <SourcePill src={enrich.source} />
                  {enrich.confidence_pct && (
                    <span className="pai-conf-global" style={{ color: confColor(enrich.confidence || 0) }}>
                      {enrich.confidence_pct} overall confidence
                    </span>
                  )}
                  {enrich.last_checked && (
                    <span className="pai-last-checked">
                      Checked {new Date(enrich.last_checked).toLocaleDateString()}
                    </span>
                  )}
                  {enrich.pipeline_ran && (
                    <span className="pai-live-badge">⚡ LIVE</span>
                  )}
                </div>
              )}

              {/* Two-col layout: operator + agents */}
              <div className="pai-cols">
                <div className="pai-col-left">
                  <OperatorCard data={result.operator} />
                  {result.manager && <ManagerCard data={result.manager} label="ISM MANAGER" />}
                  {result.ship_manager && <ManagerCard data={result.ship_manager} label="SHIP MANAGER" />}

                  {/* Captain contact note */}
                  <div className="pai-captain-panel">
                    <div className="pai-captain-icon">🚢</div>
                    <div>
                      <div className="pai-captain-title">CAPTAIN / SHIP CONTACT</div>
                      <div className="pai-captain-body">{result.captain_contact}</div>
                    </div>
                  </div>
                </div>

                <div className="pai-col-right">
                  <div className="pai-agents-header">
                    <span className="pai-agents-title">PORT AGENTS</span>
                    <span className="pai-agents-count">{hasAgents ? result.port_agents.length : 0} found</span>
                  </div>

                  {!hasAgents && (
                    <div className="pai-no-agents">
                      <div>No agents found for this port.</div>
                      <div className="pai-no-agents-sub">
                        Try providing a port LOCODE (e.g. SGSIN) in the search above.
                      </div>
                    </div>
                  )}

                  {hasAgents && result.port_agents.map((agent, i) => (
                    <AgentCard key={agent.agent_name + i} agent={agent} rank={i} />
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default PortAgentIntelligencePanel;
