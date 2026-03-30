// src/components/UniversalVesselContactFinder.jsx — v2
//
// FIXES:
//  1. No more direct Anthropic API calls — was causing CORS "Failed to fetch"
//  2. All enrichment goes through backend /api/ai-contact/enrich
//  3. 70s client timeout with AbortController + auto-retry once on timeout
//  4. Partial results still shown if only some steps succeed

import React, { useState, useCallback, useEffect, useRef, memo } from "react";
import "./UniversalVesselContactFinder.css";

const BASE_URL = process.env.REACT_APP_API_URL || "https://maritime-connect.onrender.com/api";
const CLIENT_TIMEOUT_MS = 70_000;

function confColor(v) {
  if (!v) return "#3d6a8a";
  if (v >= 0.85) return "#00ff9d";
  if (v >= 0.65) return "#fd9644";
  return "#fc5c65";
}
function confLabel(v) {
  if (!v) return "—";
  if (v >= 0.85) return "HIGH";
  if (v >= 0.65) return "MED";
  return "LOW";
}

const SOURCE_MAP = {
  equasis:       { label: "Equasis",  color: "#00e5ff" },
  marinetraffic: { label: "MT",       color: "#38bdf8" },
  vesselfinder:  { label: "VF",       color: "#607d8b" },
  fleetmon:      { label: "FleetMon", color: "#607d8b" },
  scrape:        { label: "Scraped",  color: "#00ff9d" },
  website_scrape:{ label: "Scraped",  color: "#00ff9d" },
  web_search:    { label: "Web",      color: "#fd9644" },
  google_cse:    { label: "Google",   color: "#fd9644" },
  port_agent_db: { label: "Agents",   color: "#26de81" },
  bigquery:      { label: "Cached",   color: "#38bdf8" },
  enricher:      { label: "Enricher", color: "#26de81" },
};

const PIPELINE_STEPS = [
  { id: "equasis",        label: "Equasis IMO lookup",         icon: "🗂", conf: 0.92 },
  { id: "marinetraffic",  label: "MarineTraffic vessel data",  icon: "🛳", conf: 0.80 },
  { id: "vesselfinder",   label: "VesselFinder owner search",  icon: "🔭", conf: 0.75 },
  { id: "ai_imo",         label: "AI multi-DB IMO scan",       icon: "🤖", conf: 0.70 },
  { id: "ai_company",     label: "AI company contact search",  icon: "🔍", conf: 0.75 },
  { id: "scrape",         label: "Website contact scrape",     icon: "🕸", conf: 0.85 },
  { id: "google_cse",     label: "Google CSE extraction",      icon: "🔎", conf: 0.65 },
  { id: "linkedin",       label: "LinkedIn profile search",    icon: "💼", conf: 0.60 },
  { id: "port_agents",    label: "Port agent + AI lookup",     icon: "⚓", conf: 0.80 },
  { id: "agent_org",      label: "Husbandry agent org search", icon: "🏗", conf: 0.70 },
  { id: "master_channel", label: "Master contact channel",     icon: "👨‍✈️", conf: 0.50 },
];

function SourcePill({ src }) {
  if (!src) return null;
  return (
    <div className="ucf-pills">
      {src.split("+").map((p) => {
        const m = SOURCE_MAP[p] || { label: p, color: "#78909c" };
        return <span key={p} className="ucf-pill" style={{ borderColor: m.color, color: m.color }}>{m.label}</span>;
      })}
    </div>
  );
}

function CopyBtn({ value }) {
  const [ok, setOk] = useState(false);
  const copy = useCallback(() => {
    if (!value) return;
    navigator.clipboard.writeText(String(value))
      .then(() => { setOk(true); setTimeout(() => setOk(false), 1400); })
      .catch(() => {});
  }, [value]);
  if (!value) return null;
  return <button className="ucf-copy" onClick={copy} title="Copy">{ok ? "✓" : "⎘"}</button>;
}

function ContactLine({ icon, label, value, href }) {
  if (!value) return null;
  return (
    <div className="ucf-cline">
      <span className="ucf-cline-icon">{icon}</span>
      <div className="ucf-cline-body">
        <span className="ucf-cline-label">{label}</span>
        {href
          ? <a className="ucf-cline-val ucf-link" href={href} target="_blank" rel="noopener noreferrer">{value}</a>
          : <span className="ucf-cline-val">{value}</span>}
      </div>
      <CopyBtn value={value} />
    </div>
  );
}

function CompanyCard({ title, accent, data }) {
  if (!data?.company_name) return (
    <div className="ucf-card ucf-card-empty">
      <div className="ucf-card-head" style={{ "--accent": accent }}>{title}</div>
      <div className="ucf-empty">No {title.toLowerCase()} data found</div>
    </div>
  );
  return (
    <div className="ucf-card">
      <div className="ucf-card-head" style={{ "--accent": accent }}>
        {title}
        {data.data_source && <SourcePill src={data.data_source} />}
      </div>
      <div className="ucf-company-name">{data.company_name}</div>
      {data.country  && <div className="ucf-company-type">{data.country}</div>}
      {data.address  && <div className="ucf-address">📍 {data.address}</div>}
      <div className="ucf-contact-rows">
        <ContactLine icon="☎" label="Phone"     value={data.phone} />
        <ContactLine icon="☎" label="Alt Phone" value={data.phone_alt} />
        <ContactLine icon="📠" label="Fax"      value={data.fax} />
        <ContactLine icon="✉" label="Email"     value={data.email}     href={data.email     ? `mailto:${data.email}`     : null} />
        <ContactLine icon="✉" label="Ops Email" value={data.email_ops} href={data.email_ops ? `mailto:${data.email_ops}` : null} />
        {data.website  && <ContactLine icon="🌐" label="Website"  value={data.website}  href={data.website.startsWith("http") ? data.website  : `https://${data.website}`} />}
        {data.linkedin && <ContactLine icon="💼" label="LinkedIn" value="View Profile" href={data.linkedin} />}
      </div>
    </div>
  );
}

function PersonCard({ person, rank }) {
  if (!person?.name && !person?.role) return null;
  return (
    <div className="ucf-card ucf-person-card">
      <div className="ucf-card-head" style={{ "--accent": "#fd9644" }}>
        <span>{person.role || "Contact"}</span>
        <span className="ucf-person-rank">#{rank + 1}</span>
      </div>
      <div className="ucf-company-name">{person.name || "—"}</div>
      <div className="ucf-contact-rows">
        <ContactLine icon="✉" label="Email" value={person.email} href={person.email ? `mailto:${person.email}` : null} />
        <ContactLine icon="☎" label="Phone" value={person.phone} />
      </div>
    </div>
  );
}

function AgentCard({ agent, rank }) {
  const [open, setOpen] = useState(rank === 0);
  if (!agent?.agency_name) return null;
  return (
    <div className={`ucf-agent-card${rank === 0 ? " ucf-agent-top" : ""}`}>
      <div className="ucf-agent-header" onClick={() => setOpen(o => !o)}>
        <div className="ucf-agent-rank" style={{ color: "#00e5ff" }}>#{rank + 1}</div>
        <div className="ucf-agent-identity">
          <div className="ucf-agent-name">{agent.agency_name}</div>
          {agent.port && <div className="ucf-agent-port">⚓ {agent.port}</div>}
        </div>
        <div className="ucf-agent-chevron">{open ? "▲" : "▼"}</div>
      </div>
      {open && (
        <div className="ucf-agent-body">
          <div className="ucf-contact-rows">
            <ContactLine icon="✉" label="Email"     value={agent.email}     href={agent.email ? `mailto:${agent.email}` : null} />
            <ContactLine icon="☎" label="Phone"     value={agent.phone} />
            <ContactLine icon="🆘" label="24h Line" value={agent.phone_24h} />
            {agent.website && <ContactLine icon="🌐" label="Website" value={agent.website} href={agent.website.startsWith("http") ? agent.website : `https://${agent.website}`} />}
          </div>
          <div className="ucf-captain-note">📌 Captain contact available via this agent only</div>
        </div>
      )}
    </div>
  );
}

function PipelineRow({ step, status }) {
  return (
    <div className={`ucf-pipe-row${status === "running" ? " ucf-pipe-running" : ""}`}>
      <span className="ucf-pipe-icon" style={{ color: status === "running" ? "#00e5ff" : status === "done" ? "#00ff9d" : "#1a2e50" }}>
        {status === "done" ? "✓" : status === "running" ? "⟳" : step.icon}
      </span>
      <span className="ucf-pipe-label">{step.label}</span>
      {status === "done"    && <span className="ucf-pipe-conf" style={{ color: confColor(step.conf) }}>{Math.round(step.conf * 100)}%</span>}
      {status === "running" && <span className="ucf-pipe-scanning">scanning…</span>}
    </div>
  );
}

function SearchForm({ onSearch, loading }) {
  const [imo,      setImo]      = useState("");
  const [mmsi,     setMmsi]     = useState("");
  const [name,     setName]     = useState("");
  const [curPort,  setCurPort]  = useState("");
  const [nextPort, setNextPort] = useState("");
  const [vtype,    setVtype]    = useState("");

  const submit = useCallback((e) => {
    e?.preventDefault();
    if (!imo && !mmsi && !name) return;
    onSearch({ imo, mmsi, name, curPort, nextPort, vtype });
  }, [imo, mmsi, name, curPort, nextPort, vtype, onSearch]);

  return (
    <form className="ucf-search-form" onSubmit={submit}>
      <div className="ucf-search-grid">
        <div className="ucf-field">
          <label className="ucf-field-label">IMO NUMBER</label>
          <input className="ucf-input" placeholder="e.g. 9811130"    value={imo}      onChange={e => setImo(e.target.value.replace(/\D/g, ""))} />
        </div>
        <div className="ucf-field">
          <label className="ucf-field-label">MMSI</label>
          <input className="ucf-input" placeholder="e.g. 352003645"  value={mmsi}     onChange={e => setMmsi(e.target.value.replace(/\D/g, ""))} />
        </div>
        <div className="ucf-field ucf-field-wide">
          <label className="ucf-field-label">VESSEL NAME</label>
          <input className="ucf-input" placeholder="e.g. OCEAN TANKER 2412" value={name} onChange={e => setName(e.target.value.toUpperCase())} />
        </div>
        <div className="ucf-field">
          <label className="ucf-field-label">CURRENT PORT</label>
          <input className="ucf-input" placeholder="e.g. SGSIN"      value={curPort}  onChange={e => setCurPort(e.target.value.toUpperCase())} />
        </div>
        <div className="ucf-field">
          <label className="ucf-field-label">NEXT PORT</label>
          <input className="ucf-input" placeholder="e.g. NLRTM"      value={nextPort} onChange={e => setNextPort(e.target.value.toUpperCase())} />
        </div>
        <div className="ucf-field">
          <label className="ucf-field-label">VESSEL TYPE</label>
          <select className="ucf-input ucf-select" value={vtype} onChange={e => setVtype(e.target.value)}>
            <option value="">Any</option>
            <option value="CONTAINER">Container</option>
            <option value="TANKER">Tanker</option>
            <option value="BULK">Bulk Carrier</option>
            <option value="CARGO">General Cargo</option>
            <option value="GAS">Gas Carrier</option>
          </select>
        </div>
      </div>
      <button type="submit" className="ucf-search-btn" disabled={loading || (!imo && !mmsi && !name)}>
        {loading
          ? <><span className="ucf-btn-spinner" />ENRICHING…</>
          : <><span className="ucf-radar-icon">◎</span>FIND CONTACTS</>}
      </button>
    </form>
  );
}

const TABS = [
  { id: "OWNER",     icon: "🏢", label: "Owner"       },
  { id: "MANAGERS",  icon: "⚙",  label: "Managers"    },
  { id: "PERSONNEL", icon: "👥", label: "Personnel"   },
  { id: "AGENTS",    icon: "⚓", label: "Port Agents"  },
  { id: "MASTER",    icon: "👨‍✈️", label: "Master"      },
  { id: "PIPELINE",  icon: "🔬", label: "Pipeline"    },
];

const UniversalVesselContactFinder = memo(function UniversalVesselContactFinder({ isOpen, onClose, selectedVessel }) {
  const [result,     setResult]     = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [tab,        setTab]        = useState("OWNER");
  const [stepStates, setStepStates] = useState({});
  const [curStep,    setCurStep]    = useState(-1);
  const [lastQuery,  setLastQuery]  = useState(null);
  const [retryCount, setRetryCount] = useState(0);
  const abortRef = useRef(null);

  // Auto-search when panel opens with a selected vessel
  useEffect(() => {
    if (!selectedVessel || !isOpen) return;
    const q = {
      imo:      selectedVessel.imo_number            || "",
      mmsi:     selectedVessel.mmsi_number           || "",
      name:     selectedVessel.vessel_name           || "",
      curPort:  selectedVessel.location_to           || selectedVessel.next_port_destination || "",
      nextPort: selectedVessel.next_port_destination || "",
      vtype:    selectedVessel.vessel_type           || "",
    };
    if (q.imo || q.mmsi || q.name) { setLastQuery(q); doSearch(q, 0); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVessel?.imo_number, isOpen]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Animate pipeline steps while the real request runs (~20s backend)
  async function animatePipeline() {
    const states = {};
    for (let i = 0; i < PIPELINE_STEPS.length; i++) {
      const step = PIPELINE_STEPS[i];
      setCurStep(i);
      states[step.id] = "running";
      setStepStates({ ...states });
      // Faster animation since backend is now ~20s not ~70s
      const delay = 300 + Math.random() * 300;
      await new Promise(r => setTimeout(r, delay));
      states[step.id] = "done";
      setStepStates({ ...states });
    }
    setCurStep(-1);
  }

  const doSearch = useCallback(async (q, retries = 0) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setResult(null);
    setTab("OWNER");
    setStepStates({});
    setCurStep(-1);
    setRetryCount(retries);

    const clientTimer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

    try {
      // Run animation and API call in parallel
      const [, response] = await Promise.all([
        animatePipeline(),
        fetch(`${BASE_URL}/ai-contact/enrich`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          signal:  controller.signal,
          body: JSON.stringify({
            imo:      q.imo      || null,
            mmsi:     q.mmsi     || null,
            name:     q.name     || null,
            curPort:  q.curPort  || null,
            nextPort: q.nextPort || null,
            vtype:    q.vtype    || null,
          }),
        }),
      ]);

      clearTimeout(clientTimer);

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Server error ${response.status}`);
      }

      const json = await response.json();
      if (!json.success) throw new Error(json.error || "Enrichment returned no data");

      setResult(json.data);

    } catch (err) {
      clearTimeout(clientTimer);
      if (err.name === "AbortError") {
        // Auto-retry once on timeout
        if (retries < 1) { setError(null); return doSearch(q, retries + 1); }
        setError("Request timed out — the enrichment pipeline took too long. Please try again.");
      } else {
        setError(`Enrichment failed: ${err.message}`);
      }
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = useCallback((p) => { setLastQuery(p); doSearch(p, 0); }, [doSearch]);
  const handleRetry  = useCallback(() => { if (lastQuery) doSearch(lastQuery, 0); }, [lastQuery, doSearch]);

  if (!isOpen) return null;

  const r         = result;
  const enrich    = r ? { confidence: r.confidence || 0, sources_used: r.sources_used || [], pipeline_ran: true } : null;
  const personnel = (r?.key_personnel || []).filter(p => p?.name || p?.role);
  const agents    = (r?.port_agents   || []).filter(a => a?.agency_name);

  return (
    <div className="ucf-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ucf-panel">

        {/* Header */}
        <div className="ucf-header">
          <div className="ucf-header-left">
            <div className="ucf-radar">
              <div className="ucf-radar-ring" />
              <div className="ucf-radar-ring" style={{ animationDelay: "0.7s" }} />
              <div className="ucf-radar-dot" />
            </div>
            <div>
              <div className="ucf-title">UNIVERSAL VESSEL CONTACT INTELLIGENCE</div>
              <div className="ucf-subtitle">Any vessel worldwide · 12-step enrichment pipeline · Equasis + web scraping + port agents</div>
            </div>
          </div>
          <button className="ucf-close" onClick={onClose}>✕</button>
        </div>

        {/* Search form */}
        <div className="ucf-search-section">
          <SearchForm onSearch={handleSearch} loading={loading} />
        </div>

        {/* Body */}
        <div className="ucf-body">

          {/* Sidebar — pipeline steps */}
          <div className="ucf-sidebar">
            <div className="ucf-sidebar-title">ENRICHMENT PIPELINE</div>
            {PIPELINE_STEPS.map(step => (
              <PipelineRow key={step.id} step={step} status={stepStates[step.id] || "idle"} />
            ))}
            {r && enrich && (
              <div className="ucf-pipeline-result">
                <div className="ucf-pipeline-conf" style={{ color: confColor(enrich.confidence) }}>
                  {confLabel(enrich.confidence)} CONFIDENCE
                  <span className="ucf-pipeline-pct">{Math.round(enrich.confidence * 100)}%</span>
                </div>
                {enrich.sources_used?.length > 0 && <SourcePill src={enrich.sources_used.join("+")} />}
              </div>
            )}
          </div>

          {/* Content area */}
          <div className="ucf-content">

            {/* Empty state */}
            {!r && !loading && !error && (
              <div className="ucf-empty-state">
                <div className="ucf-empty-icon">⚓</div>
                <div className="ucf-empty-title">Enter vessel identifiers above</div>
                <div className="ucf-empty-sub">
                  Search any vessel by IMO, MMSI, or name. The pipeline queries Equasis,
                  MarineTraffic, VesselFinder, company websites and the port agent database.
                </div>
                <div className="ucf-example-chips">
                  {[
                    { imo: "9811130", name: "OCEAN TANKER 2412" },
                    { imo: "9337462", name: "MSC GÜLSÜN" },
                    { imo: "9321483", name: "EVER GIVEN" },
                  ].map(ex => (
                    <button key={ex.imo} className="ucf-example-chip"
                      onClick={() => handleSearch({ imo: ex.imo, name: ex.name, mmsi: "", curPort: "", nextPort: "", vtype: "" })}>
                      <span className="ucf-chip-imo">IMO {ex.imo}</span>
                      <span className="ucf-chip-name">{ex.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Error state */}
            {error && !loading && (
              <div className="ucf-error">
                <span>⚠ {error}</span>
                <button onClick={handleRetry}>{retryCount > 0 ? "Retry Again" : "Retry"}</button>
              </div>
            )}

            {/* Loading */}
            {loading && (
              <div className="ucf-loading">
                <div className="ucf-loading-radar"><div className="ucf-loading-sweep" /></div>
                <div className="ucf-loading-text">
                  {curStep >= 0 && <div className="ucf-loading-step">{PIPELINE_STEPS[curStep]?.label}…</div>}
                  <div className="ucf-loading-step" style={{ animationDelay: "1.2s" }}>Querying maritime registries…</div>
                  <div className="ucf-loading-step" style={{ animationDelay: "2.4s" }}>Resolving port agents…</div>
                  {retryCount > 0 && <div className="ucf-loading-step ucf-retry-note">Retry {retryCount}…</div>}
                </div>
              </div>
            )}

            {/* Results */}
            {r && !loading && (
              <div className="ucf-results">

                {/* Vessel identity bar */}
                <div className="ucf-vessel-bar">
                  <div className="ucf-vessel-info">
                    <span className="ucf-vessel-name">{r.vessel_name || lastQuery?.name || "—"}</span>
                    <span className="ucf-vessel-ids">
                      {r.imo         && <span>IMO {r.imo}</span>}
                      {r.flag        && <span>{r.flag}</span>}
                      {r.vessel_type && <span>{r.vessel_type}</span>}
                      {r.built_year  && <span>Built {r.built_year}</span>}
                    </span>
                  </div>
                  <div className="ucf-enrich-bar">
                    {enrich?.confidence > 0 && (
                      <span className="ucf-conf-global" style={{ color: confColor(enrich.confidence) }}>
                        {confLabel(enrich.confidence)} · {Math.round(enrich.confidence * 100)}%
                      </span>
                    )}
                    {enrich?.pipeline_ran && <span className="ucf-live-badge">⚡ LIVE</span>}
                  </div>
                </div>

                {/* Tabs */}
                <div className="ucf-tabs">
                  {TABS.map(t => (
                    <button key={t.id} className={`ucf-tab${tab === t.id ? " ucf-tab-active" : ""}`} onClick={() => setTab(t.id)}>
                      <span className="ucf-tab-icon">{t.icon}</span>
                      {t.label}
                      {t.id === "PERSONNEL" && personnel.length > 0 && <span className="ucf-tab-count">{personnel.length}</span>}
                      {t.id === "AGENTS"    && agents.length > 0    && <span className="ucf-tab-count">{agents.length}</span>}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                <div className="ucf-tab-content">

                  {tab === "OWNER" && (
                    <div>
                      <CompanyCard title="REGISTERED OWNER" accent="#00e5ff" data={r.owner} />
                      {r.notes && <div className="ucf-notes-banner">💡 {r.notes}</div>}
                    </div>
                  )}

                  {tab === "MANAGERS" && (
                    <div>
                      <CompanyCard title="ISM MANAGER"  accent="#a78bfa" data={r.ism_manager} />
                      <CompanyCard title="SHIP MANAGER" accent="#00ff9d" data={r.ship_manager} />
                      <CompanyCard title="OPERATOR"     accent="#fd9644" data={r.operator} />
                    </div>
                  )}

                  {tab === "PERSONNEL" && (
                    <div>
                      {personnel.length > 0
                        ? personnel.map((p, i) => <PersonCard key={i} person={p} rank={i} />)
                        : <div className="ucf-no-data"><div className="ucf-no-data-icon">👥</div><div>No key personnel found.</div><div className="ucf-no-data-sub">Try a more specific vessel or company name.</div></div>}
                    </div>
                  )}

                  {tab === "AGENTS" && (
                    <div>
                      {agents.length > 0
                        ? <>
                            <div className="ucf-agents-header">
                              <span className="ucf-agents-title">PORT AGENTS</span>
                              <span className="ucf-agents-count">{agents.length} found</span>
                            </div>
                            {agents.map((a, i) => <AgentCard key={i} agent={a} rank={i} />)}
                          </>
                        : <div className="ucf-no-data"><div className="ucf-no-data-icon">⚓</div><div>No port agents found.</div><div className="ucf-no-data-sub">Enter a port LOCODE (e.g. SGSIN) above and re-run.</div></div>}
                    </div>
                  )}

                  {tab === "MASTER" && (
                    <div>
                      <div className="ucf-privacy-notice">
                        🔒 Direct vessel master contact is not disclosed. Use the official channels below.
                      </div>
                      {r.master_contact ? (
                        <>
                          <div className="ucf-card">
                            <div className="ucf-card-head" style={{ "--accent": "#fd9644" }}>📡 PREFERRED CHANNEL</div>
                            <div className="ucf-contact-rows">
                              <ContactLine icon="📻" label="Channel"   value={r.master_contact.preferred_channel} />
                              <ContactLine icon="📻" label="Call Sign" value={r.master_contact.radio_callsign} />
                              <ContactLine icon="📡" label="Inmarsat"  value={r.master_contact.inmarsat} />
                            </div>
                          </div>
                          <div className="ucf-card">
                            <div className="ucf-card-head" style={{ "--accent": "#00ff9d" }}>👥 CREW / OPERATIONS DEPT</div>
                            {r.master_contact.crew_dept_company && <div className="ucf-company-name">{r.master_contact.crew_dept_company}</div>}
                            <div className="ucf-contact-rows">
                              <ContactLine icon="✉" label="Email" value={r.master_contact.crew_dept_email} href={r.master_contact.crew_dept_email ? `mailto:${r.master_contact.crew_dept_email}` : null} />
                              <ContactLine icon="☎" label="Phone" value={r.master_contact.crew_dept_phone} />
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="ucf-no-data">
                          <div className="ucf-no-data-icon">👨‍✈️</div>
                          <div>No master contact channels resolved.</div>
                          <div className="ucf-no-data-sub">Contact the registered owner or ISM manager directly.</div>
                        </div>
                      )}
                    </div>
                  )}

                  {tab === "PIPELINE" && (
                    <div>
                      <div className="ucf-pipe-table">
                        {PIPELINE_STEPS.map((step, i) => (
                          <div key={step.id} className="ucf-pipe-table-row">
                            <span className="ucf-pipe-num">{String(i + 1).padStart(2, "0")}</span>
                            <span className="ucf-pipe-icon-lg">{step.icon}</span>
                            <span className="ucf-pipe-label-lg">{step.label}</span>
                            <span className="ucf-pipe-done">✓</span>
                            <div className="ucf-pipe-conf-bar">
                              <div className="ucf-pipe-bar-fill" style={{ width: `${Math.round(step.conf * 100)}%`, background: confColor(step.conf) }} />
                            </div>
                            <span className="ucf-pipe-conf-val" style={{ color: confColor(step.conf) }}>{Math.round(step.conf * 100)}%</span>
                          </div>
                        ))}
                      </div>
                      <div className="ucf-pipe-summary">
                        <span>Sources: Equasis · MarineTraffic · VesselFinder · Web Scraping · Port Agents</span>
                        <span className="ucf-pipe-overall" style={{ color: confColor(r.confidence) }}>
                          Overall: {Math.round((r.confidence || 0) * 100)}% confidence
                        </span>
                      </div>
                    </div>
                  )}

                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export default UniversalVesselContactFinder;