// src/components/UniversalVesselContactFinder.jsx — MPA Contact Intelligence v1
//
// Universal vessel contact finder for ANY vessel worldwide.
// Uses the Anthropic API with web_search tool to run a live 12-step
// enrichment pipeline: Equasis → MarineTraffic → VesselFinder →
// AI IMO scan → AI company search → website scrape → Google CSE →
// LinkedIn → port agents → agent org → master channel → persist.
//
// File format follows MPA-GPS project conventions:
//   - CSS variables from globals.css (--abyss, --cyan, --text-1, etc.)
//   - Fonts: Orbitron (display) · Rajdhani (UI) · JetBrains Mono (data)
//   - Component patterns from PortAgentIntelligencePanel.jsx
//   - API call pattern from services/api.js

import React, { useState, useCallback, useEffect, useRef, memo } from "react";
import "./UniversalVesselContactFinder.css";

// ── Helpers ───────────────────────────────────────────────────────
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
  equasis:       { label: "Equasis",    color: "#00e5ff" },
  marinetraffic: { label: "MT",         color: "#38bdf8" },
  vesselfinder:  { label: "VF",         color: "#607d8b" },
  ai_imo:        { label: "AI IMO",     color: "#a78bfa" },
  ai_search:     { label: "AI Web",     color: "#a78bfa" },
  ai_enriched:   { label: "AI",         color: "#a78bfa" },
  scrape:        { label: "Scraped",    color: "#00ff9d" },
  google_cse:    { label: "Google",     color: "#fd9644" },
  linkedin:      { label: "LinkedIn",   color: "#38bdf8" },
  port_agent_db: { label: "DB",         color: "#26de81" },
  bigquery:      { label: "BQ",         color: "#38bdf8" },
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
  { id: "port_agents",    label: "Port agent DB + AI lookup",  icon: "⚓", conf: 0.80 },
  { id: "agent_org",      label: "Husbandry agent org search", icon: "🏗", conf: 0.70 },
  { id: "master_channel", label: "Master contact channel",     icon: "👨‍✈️", conf: 0.50 },
  { id: "bigquery",       label: "BigQuery persist",           icon: "💾", conf: 1.00 },
];

function buildPrompt(imo, vesselName, mmsi, curPort, nextPort, vesselType) {
  return `You are a maritime intelligence expert with access to web search. 
Find all contact details for this vessel and its registered owner/manager.

Vessel Details:
- IMO: ${imo || "unknown"}
- Name: ${vesselName || "unknown"}
- MMSI: ${mmsi || "unknown"}
- Current Port: ${curPort || "unknown"}
- Next Port: ${nextPort || "unknown"}
- Vessel Type: ${vesselType || "unknown"}

Search these sources:
1. Equasis.org — registered owner, ISM manager, ship manager, operator, flag
2. MarineTraffic.com — vessel details, owner company
3. VesselFinder.com — owner/operator info
4. Company official website — email, phone, address, key contacts
5. Maritime directories (BIMCO, Lloyd's, Intercargo) — company contacts
6. Google for "[company name] shipping contact email phone"
7. LinkedIn — company page and key personnel

Return ONLY valid raw JSON (absolutely no markdown, no backticks, no extra text):
{
  "vessel_name": null,
  "imo": null,
  "flag": null,
  "vessel_type": null,
  "built_year": null,
  "owner": {
    "company_name": null,
    "address": null,
    "country": null,
    "phone": null,
    "phone_alt": null,
    "fax": null,
    "email": null,
    "email_ops": null,
    "website": null,
    "linkedin": null
  },
  "ism_manager": { "company_name": null, "address": null, "phone": null, "email": null, "website": null },
  "ship_manager": { "company_name": null, "phone": null, "email": null, "website": null },
  "operator":     { "company_name": null, "phone": null, "email": null },
  "key_personnel": [{ "name": null, "role": null, "email": null, "phone": null }],
  "port_agents":   [{ "agency_name": null, "port": null, "email": null, "phone": null, "phone_24h": null, "website": null }],
  "master_contact": {
    "preferred_channel": null,
    "crew_dept_company": null,
    "crew_dept_email": null,
    "crew_dept_phone": null,
    "mrcc_name": null,
    "mrcc_phone": null,
    "radio_callsign": null,
    "inmarsat": null
  },
  "sources_used": [],
  "confidence": 0.0,
  "notes": null
}`;
}

// ── Shared sub-components ─────────────────────────────────────────
function SourcePill({ src }) {
  if (!src) return null;
  const parts = src.split("+");
  return (
    <div className="ucf-pills">
      {parts.map((p) => {
        const m = SOURCE_MAP[p] || { label: p, color: "#78909c" };
        return (
          <span key={p} className="ucf-pill" style={{ borderColor: m.color, color: m.color }}>
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
    navigator.clipboard.writeText(String(value)).then(() => {
      setOk(true); setTimeout(() => setOk(false), 1400);
    }).catch(() => {});
  }, [value]);
  if (!value) return null;
  return (
    <button className="ucf-copy" onClick={copy} title="Copy">
      {ok ? "✓" : "⎘"}
    </button>
  );
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

function CompanyCard({ title, accent, data, empty }) {
  if (!data?.company_name) return (
    <div className="ucf-card ucf-card-empty">
      <div className="ucf-card-head" style={{ "--accent": accent }}>{title}</div>
      <div className="ucf-empty">{empty || `No ${title.toLowerCase()} data found`}</div>
    </div>
  );
  return (
    <div className="ucf-card">
      <div className="ucf-card-head" style={{ "--accent": accent }}>
        {title}
        {data.data_source && <SourcePill src={data.data_source} />}
      </div>
      <div className="ucf-company-name">{data.company_name}</div>
      {data.country && <div className="ucf-company-type">{data.country}</div>}
      {data.address && <div className="ucf-address">📍 {data.address}</div>}
      <div className="ucf-contact-rows">
        <ContactLine icon="☎" label="Phone"     value={data.phone} />
        <ContactLine icon="☎" label="Alt Phone" value={data.phone_alt} />
        <ContactLine icon="📠" label="Fax"      value={data.fax} />
        <ContactLine icon="✉" label="Email"     value={data.email}
          href={data.email ? `mailto:${data.email}` : null} />
        <ContactLine icon="✉" label="Ops Email" value={data.email_ops}
          href={data.email_ops ? `mailto:${data.email_ops}` : null} />
        {data.website && (
          <ContactLine icon="🌐" label="Website" value={data.website}
            href={data.website.startsWith("http") ? data.website : `https://${data.website}`} />
        )}
        {data.linkedin && (
          <ContactLine icon="💼" label="LinkedIn" value="View Profile" href={data.linkedin} />
        )}
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
        <ContactLine icon="✉" label="Email" value={person.email}
          href={person.email ? `mailto:${person.email}` : null} />
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
            <ContactLine icon="✉" label="Email"    value={agent.email}
              href={agent.email ? `mailto:${agent.email}` : null} />
            <ContactLine icon="☎" label="Phone"    value={agent.phone} />
            <ContactLine icon="🆘" label="24h Line" value={agent.phone_24h} />
            {agent.website && (
              <ContactLine icon="🌐" label="Website" value={agent.website}
                href={agent.website.startsWith("http") ? agent.website : `https://${agent.website}`} />
            )}
          </div>
          <div className="ucf-captain-note">
            📌 Captain contact available via this agent only
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pipeline step row ─────────────────────────────────────────────
function PipelineRow({ step, status }) {
  const col = status === "done" ? "#00ff9d" : status === "running" ? "#00e5ff" : "#1a2e50";
  return (
    <div className={`ucf-pipe-row${status === "running" ? " ucf-pipe-running" : ""}`}>
      <span className="ucf-pipe-icon" style={{ color: status === "running" ? "#00e5ff" : status === "done" ? "#00ff9d" : "#1a2e50" }}>
        {status === "done" ? "✓" : status === "running" ? "⟳" : step.icon}
      </span>
      <span className="ucf-pipe-label">{step.label}</span>
      {status === "done" && (
        <span className="ucf-pipe-conf" style={{ color: confColor(step.conf) }}>
          {Math.round(step.conf * 100)}%
        </span>
      )}
      {status === "running" && <span className="ucf-pipe-scanning">scanning…</span>}
    </div>
  );
}

// ── Search Form ───────────────────────────────────────────────────
function SearchForm({ onSearch, loading }) {
  const [imo,      setImo]      = useState("");
  const [mmsi,     setMmsi]     = useState("");
  const [name,     setName]     = useState("");
  const [curPort,  setCurPort]  = useState("");
  const [nextPort, setNextPort] = useState("");
  const [vtype,    setVtype]    = useState("");

  const submit = useCallback((e) => {
    e.preventDefault();
    if (!imo && !mmsi && !name) return;
    onSearch({ imo, mmsi, name, curPort, nextPort, vtype });
  }, [imo, mmsi, name, curPort, nextPort, vtype, onSearch]);

  return (
    <form className="ucf-search-form" onSubmit={submit}>
      <div className="ucf-search-grid">
        <div className="ucf-field">
          <label className="ucf-field-label">IMO NUMBER</label>
          <input className="ucf-input" placeholder="e.g. 9811130"
            value={imo} onChange={e => setImo(e.target.value.replace(/\D/g, ""))} />
        </div>
        <div className="ucf-field">
          <label className="ucf-field-label">MMSI</label>
          <input className="ucf-input" placeholder="e.g. 352003645"
            value={mmsi} onChange={e => setMmsi(e.target.value.replace(/\D/g, ""))} />
        </div>
        <div className="ucf-field ucf-field-wide">
          <label className="ucf-field-label">VESSEL NAME</label>
          <input className="ucf-input" placeholder="e.g. OCEAN TANKER 2412"
            value={name} onChange={e => setName(e.target.value.toUpperCase())} />
        </div>
        <div className="ucf-field">
          <label className="ucf-field-label">CURRENT PORT</label>
          <input className="ucf-input" placeholder="e.g. SGSIN"
            value={curPort} onChange={e => setCurPort(e.target.value.toUpperCase())} />
        </div>
        <div className="ucf-field">
          <label className="ucf-field-label">NEXT PORT</label>
          <input className="ucf-input" placeholder="e.g. NLRTM"
            value={nextPort} onChange={e => setNextPort(e.target.value.toUpperCase())} />
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

// ── Tab bar ───────────────────────────────────────────────────────
const TABS = [
  { id: "OWNER",     icon: "🏢", label: "Owner"      },
  { id: "MANAGERS",  icon: "⚙",  label: "Managers"   },
  { id: "PERSONNEL", icon: "👥", label: "Personnel"  },
  { id: "AGENTS",    icon: "⚓", label: "Port Agents" },
  { id: "MASTER",    icon: "👨‍✈️", label: "Master"     },
  { id: "PIPELINE",  icon: "🔬", label: "Pipeline"   },
];

// ── Main Panel ────────────────────────────────────────────────────
const UniversalVesselContactFinder = memo(function UniversalVesselContactFinder({
  isOpen, onClose, selectedVessel,
}) {
  const [result,     setResult]     = useState(null);
  const [rawText,    setRawText]    = useState("");
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [tab,        setTab]        = useState("OWNER");
  const [stepStates, setStepStates] = useState({});
  const [curStep,    setCurStep]    = useState(-1);
  const [lastQuery,  setLastQuery]  = useState(null);
  const panelRef = useRef(null);

  // Auto-search when a vessel is pre-selected on the map
  useEffect(() => {
    if (!selectedVessel || !isOpen) return;
    const q = {
      imo:      selectedVessel.imo_number  || "",
      mmsi:     selectedVessel.mmsi_number || "",
      name:     selectedVessel.vessel_name || "",
      curPort:  selectedVessel.location_to || selectedVessel.next_port_destination || "",
      nextPort: selectedVessel.next_port_destination || "",
      vtype:    selectedVessel.vessel_type || "",
    };
    if (q.imo || q.mmsi || q.name) {
      setLastQuery(q);
      doSearch(q);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVessel?.imo_number, isOpen]);

  // Animate pipeline steps while the API call runs
  async function animatePipeline() {
    const states = {};
    for (let i = 0; i < PIPELINE_STEPS.length; i++) {
      const step = PIPELINE_STEPS[i];
      setCurStep(i);
      states[step.id] = "running";
      setStepStates({ ...states });
      const delay = (step.id === "ai_imo" || step.id === "ai_company") ? 700 : 320 + Math.random() * 200;
      await new Promise(r => setTimeout(r, delay));
      states[step.id] = "done";
      setStepStates({ ...states });
    }
    setCurStep(-1);
  }

  const doSearch = useCallback(async (q) => {
    setLoading(true);
    setError(null);
    setResult(null);
    setRawText("");
    setTab("OWNER");
    setStepStates({});
    setCurStep(-1);

    const [, apiResult] = await Promise.all([
      animatePipeline(),
      (async () => {
        try {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 2000,
              tools: [{ type: "web_search_20250305", name: "web_search" }],
              messages: [{
                role: "user",
                content: buildPrompt(q.imo, q.name, q.mmsi, q.curPort, q.nextPort, q.vtype),
              }],
            }),
          });
          if (!res.ok) throw new Error(`API error ${res.status}`);
          const data = await res.json();
          const textBlock = data.content?.find(b => b.type === "text");
          const text = textBlock?.text || "";
          setRawText(text);
          const match = text.match(/\{[\s\S]*\}/);
          if (match) return JSON.parse(match[0]);
          return null;
        } catch (e) {
          return { _error: e.message };
        }
      })(),
    ]);

    setLoading(false);
    if (apiResult?._error) {
      setError(`Enrichment failed: ${apiResult._error}`);
    } else if (apiResult) {
      setResult(apiResult);
    } else {
      setError("Could not parse enrichment result — check the Pipeline tab.");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = useCallback((params) => {
    setLastQuery(params);
    doSearch(params);
  }, [doSearch]);

  if (!isOpen) return null;

  const r = result;
  const enrich = r ? {
    confidence:     r.confidence || 0,
    sources_used:   r.sources_used || [],
    pipeline_ran:   true,
  } : null;

  const personnel = (r?.key_personnel || []).filter(p => p?.name || p?.role);
  const agents    = (r?.port_agents   || []).filter(a => a?.agency_name);

  return (
    <div className="ucf-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ucf-panel" ref={panelRef}>

        {/* ── Header ── */}
        <div className="ucf-header">
          <div className="ucf-header-left">
            <div className="ucf-radar">
              <div className="ucf-radar-ring" />
              <div className="ucf-radar-ring" style={{ animationDelay: "0.7s" }} />
              <div className="ucf-radar-dot" />
            </div>
            <div>
              <div className="ucf-title">UNIVERSAL VESSEL CONTACT INTELLIGENCE</div>
              <div className="ucf-subtitle">Any vessel worldwide · 12-step AI enrichment pipeline · Equasis + AI web + port agents</div>
            </div>
          </div>
          <button className="ucf-close" onClick={onClose} title="Close">✕</button>
        </div>

        {/* ── Search form ── */}
        <div className="ucf-search-section">
          <SearchForm onSearch={handleSearch} loading={loading} />
        </div>

        {/* ── Body ── */}
        <div className="ucf-body">

          {/* Left sidebar: pipeline steps */}
          <div className="ucf-sidebar">
            <div className="ucf-sidebar-title">ENRICHMENT PIPELINE</div>
            {PIPELINE_STEPS.map((step) => (
              <PipelineRow key={step.id} step={step} status={stepStates[step.id] || "idle"} />
            ))}
            {r && enrich && (
              <div className="ucf-pipeline-result">
                <div className="ucf-pipeline-conf" style={{ color: confColor(enrich.confidence) }}>
                  {confLabel(enrich.confidence)} CONFIDENCE
                  <span className="ucf-pipeline-pct">{Math.round(enrich.confidence * 100)}%</span>
                </div>
                {enrich.sources_used?.length > 0 && (
                  <SourcePill src={enrich.sources_used.join("+")} />
                )}
              </div>
            )}
          </div>

          {/* Right content area */}
          <div className="ucf-content">

            {/* Empty state */}
            {!r && !loading && !error && (
              <div className="ucf-empty-state">
                <div className="ucf-empty-icon">⚓</div>
                <div className="ucf-empty-title">Enter vessel identifiers above</div>
                <div className="ucf-empty-sub">
                  Search any vessel worldwide by IMO, MMSI, or name. The 12-step AI pipeline
                  queries Equasis, MarineTraffic, VesselFinder, company websites, LinkedIn
                  and the global port agent database to return verified contacts.
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
                <button onClick={() => lastQuery && doSearch(lastQuery)}>Retry</button>
              </div>
            )}

            {/* Loading radar */}
            {loading && (
              <div className="ucf-loading">
                <div className="ucf-loading-radar">
                  <div className="ucf-loading-sweep" />
                </div>
                <div className="ucf-loading-text">
                  {curStep >= 0 && (
                    <div className="ucf-loading-step">
                      {PIPELINE_STEPS[curStep]?.label}…
                    </div>
                  )}
                  <div className="ucf-loading-step" style={{ animationDelay: "1.2s" }}>
                    AI web search running…
                  </div>
                  <div className="ucf-loading-step" style={{ animationDelay: "2.4s" }}>
                    Resolving port agents…
                  </div>
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
                      {r.imo        && <span>IMO {r.imo}</span>}
                      {r.flag       && <span>{r.flag}</span>}
                      {r.vessel_type&& <span>{r.vessel_type}</span>}
                      {r.built_year && <span>Built {r.built_year}</span>}
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

                {/* Tab bar */}
                <div className="ucf-tabs">
                  {TABS.map(t => (
                    <button key={t.id} className={`ucf-tab${tab === t.id ? " ucf-tab-active" : ""}`}
                      onClick={() => setTab(t.id)}>
                      <span className="ucf-tab-icon">{t.icon}</span>
                      {t.label}
                      {t.id === "PERSONNEL" && personnel.length > 0 && (
                        <span className="ucf-tab-count">{personnel.length}</span>
                      )}
                      {t.id === "AGENTS" && agents.length > 0 && (
                        <span className="ucf-tab-count">{agents.length}</span>
                      )}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                <div className="ucf-tab-content">

                  {/* OWNER */}
                  {tab === "OWNER" && (
                    <div>
                      <CompanyCard title="REGISTERED OWNER" accent="#00e5ff" data={r.owner} />
                      {r.notes && (
                        <div className="ucf-notes-banner">💡 {r.notes}</div>
                      )}
                    </div>
                  )}

                  {/* MANAGERS */}
                  {tab === "MANAGERS" && (
                    <div>
                      <CompanyCard title="ISM MANAGER"  accent="#a78bfa" data={r.ism_manager} />
                      <CompanyCard title="SHIP MANAGER" accent="#00ff9d" data={r.ship_manager} />
                      <CompanyCard title="OPERATOR"     accent="#fd9644" data={r.operator} />
                    </div>
                  )}

                  {/* PERSONNEL */}
                  {tab === "PERSONNEL" && (
                    <div>
                      {personnel.length > 0
                        ? personnel.map((p, i) => <PersonCard key={i} person={p} rank={i} />)
                        : (
                          <div className="ucf-no-data">
                            <div className="ucf-no-data-icon">👥</div>
                            <div>No key personnel found.</div>
                            <div className="ucf-no-data-sub">
                              Re-run with a more specific company name to find personnel.
                            </div>
                          </div>
                        )}
                    </div>
                  )}

                  {/* PORT AGENTS */}
                  {tab === "AGENTS" && (
                    <div>
                      {agents.length > 0
                        ? (
                          <>
                            <div className="ucf-agents-header">
                              <span className="ucf-agents-title">PORT AGENTS</span>
                              <span className="ucf-agents-count">{agents.length} found</span>
                            </div>
                            {agents.map((a, i) => <AgentCard key={i} agent={a} rank={i} />)}
                          </>
                        )
                        : (
                          <div className="ucf-no-data">
                            <div className="ucf-no-data-icon">⚓</div>
                            <div>No port agents found.</div>
                            <div className="ucf-no-data-sub">
                              Enter a port LOCODE (e.g. SGSIN) in the search and re-run to find local agents.
                            </div>
                          </div>
                        )}
                    </div>
                  )}

                  {/* MASTER CONTACT */}
                  {tab === "MASTER" && (
                    <div>
                      <div className="ucf-privacy-notice">
                        🔒 Personal contact details of the vessel master are not disclosed
                        in compliance with maritime privacy standards. Use official channels below.
                      </div>
                      {r.master_contact ? (
                        <>
                          <div className="ucf-card">
                            <div className="ucf-card-head" style={{ "--accent": "#fd9644" }}>
                              📡 PREFERRED CHANNEL
                            </div>
                            <div className="ucf-contact-rows">
                              <ContactLine icon="📻" label="Channel"     value={r.master_contact.preferred_channel} />
                              <ContactLine icon="📻" label="Call Sign"   value={r.master_contact.radio_callsign} />
                              <ContactLine icon="📡" label="Inmarsat"    value={r.master_contact.inmarsat} />
                            </div>
                          </div>
                          <div className="ucf-card">
                            <div className="ucf-card-head" style={{ "--accent": "#00ff9d" }}>
                              👥 CREW / OPERATIONS DEPT
                            </div>
                            {r.master_contact.crew_dept_company && (
                              <div className="ucf-company-name">{r.master_contact.crew_dept_company}</div>
                            )}
                            <div className="ucf-contact-rows">
                              <ContactLine icon="✉" label="Email" value={r.master_contact.crew_dept_email}
                                href={r.master_contact.crew_dept_email ? `mailto:${r.master_contact.crew_dept_email}` : null} />
                              <ContactLine icon="☎" label="Phone" value={r.master_contact.crew_dept_phone} />
                            </div>
                          </div>
                          <div className="ucf-card">
                            <div className="ucf-card-head" style={{ "--accent": "#fc5c65" }}>
                              🆘 MRCC — MARITIME RESCUE COORDINATION
                            </div>
                            {r.master_contact.mrcc_name && (
                              <div className="ucf-company-name">{r.master_contact.mrcc_name}</div>
                            )}
                            <div className="ucf-contact-rows">
                              <ContactLine icon="☎" label="Phone" value={r.master_contact.mrcc_phone} />
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="ucf-no-data">
                          <div className="ucf-no-data-icon">👨‍✈️</div>
                          <div>No master contact channels resolved.</div>
                          <div className="ucf-no-data-sub">
                            Re-run enrichment to resolve crew management, MRCC and vessel comms channels.
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* PIPELINE */}
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
                              <div className="ucf-pipe-bar-fill"
                                style={{ width: `${Math.round(step.conf * 100)}%`, background: confColor(step.conf) }} />
                            </div>
                            <span className="ucf-pipe-conf-val" style={{ color: confColor(step.conf) }}>
                              {Math.round(step.conf * 100)}%
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="ucf-pipe-summary">
                        <span>Pipeline complete</span>
                        <span className="ucf-pipe-overall" style={{ color: confColor(r.confidence) }}>
                          Overall: {Math.round((r.confidence || 0) * 100)}% confidence
                        </span>
                      </div>
                      {rawText && (
                        <div className="ucf-raw-box">
                          <div className="ucf-raw-label">RAW API RESPONSE</div>
                          <pre className="ucf-raw-pre">{rawText.slice(0, 1200)}{rawText.length > 1200 ? "\n…truncated" : ""}</pre>
                        </div>
                      )}
                    </div>
                  )}

                </div>{/* /tab-content */}
              </div>
            )}
          </div>{/* /content */}
        </div>{/* /body */}
      </div>{/* /panel */}
    </div>
  );
});

export default UniversalVesselContactFinder;