// VesselContactPanel.jsx — v6
// Auto-loads contact intelligence when vessel is selected.
// Gemini AI finder is completely hidden from user — runs server-side via GEMINI_API_KEY.
// Default tab is "Contact Intel" so contacts appear immediately.
import React, { useState, useEffect, useCallback, memo } from "react";
import { fetchVesselContacts, fetchPortAgents, triggerVesselEnrichment, fetchVesselIntelligence, checkGeminiStatus } from "../services/api";
import "./VesselContactPanel.css";

// ── Helpers ───────────────────────────────────────────────────────
function confidenceBadge(score) {
  if (score == null) return null;
  const pct = typeof score === "number" && score <= 1 ? Math.round(score * 100) : Math.round(score);
  const cls  = pct >= 85 ? "conf-high" : pct >= 60 ? "conf-mid" : "conf-low";
  return <span className={`conf-badge ${cls}`} title={`${pct}% confidence`}>{pct}%</span>;
}

function SourcePills({ source }) {
  if (!source) return null;
  const map = {
    equasis:"Equasis", ai_search:"AI Web", scrape:"Scraped",
    google_cse:"Google", vesselfinder:"VF", ai_enriched:"AI",
    bigquery:"Cached", website_mailto:"Mailto", website_scraped:"Scraped",
    smtp_validated:"SMTP✓", pattern_generated:"Pattern",
    "search+content_validated":"Search+Verified", "search+dns":"Search+DNS",
    "heuristic+content_validated":"Heuristic+Verified", "heuristic+dns":"Heuristic+DNS",
    gemini_ai:"AI",
  };
  return (
    <div className="cp-source-pills">
      {source.split("+").map(p => (
        <span key={p} className="cp-source-pill">{map[p] || p}</span>
      ))}
    </div>
  );
}

function CopyBtn({ value, label }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (!value) return;
    navigator.clipboard.writeText(value)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })
      .catch(() => {});
  }, [value]);
  if (!value) return null;
  return (
    <button className="cp-copy-btn" onClick={copy} title={`Copy ${label}`}>
      {copied ? "✓" : "⎘"}
    </button>
  );
}

function ContactRow({ icon, label, value, href, type }) {
  if (!value) return null;
  const isEmail = type === "email" || (href && href.startsWith("mailto:"));
  const isPhone = type === "phone";
  const isWeb   = type === "web"   || (href && href.startsWith("http"));
  return (
    <div className="cp-contact-row">
      <span className="cp-icon">{icon}</span>
      <div className="cp-contact-body">
        <span className="cp-label">{label}</span>
        {isEmail && (
          <div className="cp-contact-inline">
            <span className="cp-value cp-value-email">{value}</span>
            <a className="cp-action-btn" href={`mailto:${value}`} title="Open email client">✉ Mail</a>
          </div>
        )}
        {isPhone && (
          <div className="cp-contact-inline">
            <span className="cp-value">{value}</span>
            <a className="cp-action-btn" href={`tel:${value.replace(/\s/g,"")}`} title="Call">☎ Call</a>
          </div>
        )}
        {isWeb && (
          <div className="cp-contact-inline">
            <span className="cp-value cp-value-web">{value}</span>
            <a className="cp-action-btn" href={href} target="_blank" rel="noopener noreferrer" title="Open website">🌐 Open</a>
          </div>
        )}
        {!isEmail && !isPhone && !isWeb && <span className="cp-value">{value}</span>}
      </div>
      <CopyBtn value={value} label={label} />
    </div>
  );
}

function CompanyCard({ title, company, accent }) {
  if (!company?.company_name) return (
    <div className="cp-card cp-card-empty">
      <div className="cp-card-title" style={{ borderColor: accent }}>{title}</div>
      <div className="cp-empty-msg">No {title.toLowerCase()} data found</div>
    </div>
  );
  return (
    <div className="cp-card">
      <div className="cp-card-title" style={{ borderColor: accent }}>
        <span>{title}</span>
        <SourcePills source={company.data_source} />
      </div>
      <div className="cp-company-name">{company.company_name}</div>
      {company.registered_address && <div className="cp-address">📍 {company.registered_address}</div>}
      <ContactRow icon="✉" label="Email"     value={company.email}           type="email" />
      <ContactRow icon="✉" label="Alt Email" value={company.email_secondary} type="email" />
      <ContactRow icon="☎" label="Phone"     value={company.phone}           type="phone" />
      <ContactRow icon="☎" label="Alt Phone" value={company.phone_secondary} type="phone" />
      {company.website && <ContactRow icon="🌐" label="Website" value={company.website} href={company.website.startsWith("http") ? company.website : `https://${company.website}`} type="web" />}
      {company.linkedin && <ContactRow icon="💼" label="LinkedIn" value="View Profile" href={company.linkedin} type="web" />}
      {company.last_verified_at && <div className="cp-verified-date">✓ Verified {new Date(company.last_verified_at).toLocaleDateString()}</div>}
    </div>
  );
}

function AgentCard({ agent }) {
  return (
    <div className="cp-agent-card">
      <div className="cp-agent-header">
        <div className="cp-agent-name-row">
          <span className="cp-agent-name">{agent.agency_company || agent.agent_name || "Agent"}</span>
          {agent.port_context && (
            <span className={`cp-port-context-badge ${agent.port_context}`}>
              {agent.port_context === "next" ? "Next Port" : "Current Port"}
            </span>
          )}
        </div>
        {agent.agent_name && agent.agent_name !== agent.agency_company && (
          <span className="cp-agent-contact-name">Contact: {agent.agent_name}</span>
        )}
      </div>
      {agent.port_name && <div className="cp-agent-port">⚓ {agent.port_name}{agent.port_code ? ` (${agent.port_code})` : ""}</div>}
      <ContactRow icon="✉" label="Email"   value={agent.email}     type="email" />
      {agent.email_ops && agent.email_ops !== agent.email && (
        <ContactRow icon="✉" label="Ops Email" value={agent.email_ops} type="email" />
      )}
      <ContactRow icon="☎" label="Phone"   value={agent.phone}    type="phone" />
      {agent.phone_24h && <ContactRow icon="🆘" label="24h" value={agent.phone_24h} type="phone" />}
      {agent.vhf_channel && <ContactRow icon="📡" label="VHF" value={agent.vhf_channel} />}
      {agent.website && <ContactRow icon="🌐" label="Website" value={agent.website} href={agent.website.startsWith("http") ? agent.website : `https://${agent.website}`} type="web" />}
      <div className="cp-agent-meta">
        {agent.confidence != null && confidenceBadge(agent.confidence)}
        {agent.data_source && <span className="cp-agent-source">{agent.data_source}</span>}
      </div>
    </div>
  );
}

// ── Intelligence Tab — auto-loaded, shown by default ─────────────
function IntelligenceTab({ intelligence, intelLoading, intelError, onRefresh, imo, geminiActive }) {
  if (intelLoading) {
    return (
      <div className="cp-loading">
        <div className="cp-spinner" />
        <span>Finding contacts…</span>
        <span className="cp-loading-sub">Domain discovery → Website crawl → SMTP validation{geminiActive ? " → AI boost" : ""}</span>
      </div>
    );
  }

  if (intelError) {
    return (
      <div className="cp-error">
        <span>⚠ {intelError}</span>
        <button onClick={onRefresh}>Retry</button>
      </div>
    );
  }

  if (!intelligence?.companies?.length) {
    return (
      <div className="cp-no-data">
        <div className="cp-no-data-icon">🔎</div>
        <div>Searching for contacts…</div>
        <div className="cp-no-data-sub">
          The pipeline runs automatically. If no results appear, click <strong>↻ Refresh</strong>.
        </div>
        {imo && (
          <div className="cp-no-data-links">
            <a href={`https://www.equasis.org`} target="_blank" rel="noopener noreferrer">Equasis</a>
            {" · "}
            <a href={`https://www.marinetraffic.com/en/ais/details/ships/imo:${imo}`} target="_blank" rel="noopener noreferrer">MarineTraffic</a>
          </div>
        )}
      </div>
    );
  }

  const { companies, top_contacts, top_phones, pipeline_ran_at, cached } = intelligence;

  return (
    <div className="intel-tab">
      {/* Pipeline metadata bar */}
      <div className="intel-meta-bar">
        <span className="intel-meta-label">Updated</span>
        <span className="intel-meta-val">{pipeline_ran_at ? new Date(pipeline_ran_at).toLocaleTimeString() : "—"}</span>
        {cached && <span className="intel-badge-cached">cached</span>}
        {intelligence?.gemini_used && <span className="intel-badge-gemini">✨ AI</span>}
        <span className="intel-meta-steps">Domain · Crawl · MX · SMTP{intelligence?.gemini_used ? " · AI" : ""}</span>
      </div>

      {/* Top contacts */}
      {top_contacts?.length > 0 && (
        <div className="intel-section">
          <div className="intel-section-header">
            <span className="intel-section-icon">✉</span>
            <span className="intel-section-title">VERIFIED CONTACTS</span>
            <span className="intel-section-count">{top_contacts.length}</span>
          </div>
          <div className="intel-email-list">
            {top_contacts.map((e, i) => (
              <div key={i} className="intel-email-row">
                <a href={`mailto:${e.email}`} className="intel-email">{e.email}</a>
                <div className="intel-email-meta">
                  <span className={`intel-conf intel-conf-${e.confidence >= 80 ? "high" : e.confidence >= 60 ? "mid" : "low"}`}>
                    {e.confidence}%
                  </span>
                  {e.smtp_valid === true  && <span className="intel-badge-smtp">✓ SMTP</span>}
                  {e.smtp_valid === false && <span className="intel-badge-rejected">✗</span>}
                  <span className="intel-source">{e.source?.replace(/_/g," ")}</span>
                </div>
                <CopyBtn value={e.email} label="email" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Phones */}
      {top_phones?.length > 0 && (
        <div className="intel-section">
          <div className="intel-section-header">
            <span className="intel-section-icon">☎</span>
            <span className="intel-section-title">PHONE NUMBERS</span>
          </div>
          <div className="intel-phone-list">
            {top_phones.map((p, i) => (
              <div key={i} className="intel-phone-row">
                <span className="intel-phone">{p}</span>
                <CopyBtn value={p} label="phone" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-company breakdown */}
      <div className="intel-section">
        <div className="intel-section-header">
          <span className="intel-section-icon">🏢</span>
          <span className="intel-section-title">BY COMPANY</span>
        </div>
        {companies.map((co, i) => (
          <div key={i} className="intel-company-block">
            <div className="intel-company-header">
              <span className="intel-company-name">{co.company}</span>
              <span className="intel-company-role">{co.role}</span>
            </div>
            {co.domain ? (
              <div className="intel-domain-row">
                <span className="intel-domain-icon">🌐</span>
                <a href={`https://${co.domain}`} target="_blank" rel="noopener noreferrer" className="intel-domain-link">
                  {co.domain}
                </a>
                <div className="intel-domain-meta">
                  <span className={`intel-conf intel-conf-${co.domain_confidence >= 80 ? "high" : co.domain_confidence >= 60 ? "mid" : "low"}`}>
                    {co.domain_confidence}%
                  </span>
                  <span className="intel-source">{co.domain_method?.replace(/\+/g," · ")}</span>
                  {co.mx_exists && <span className="intel-badge-mx">MX✓</span>}
                </div>
              </div>
            ) : (
              <div className="intel-no-domain">⚠ Domain not found</div>
            )}
            {co.emails?.length > 0 && (
              <div className="intel-email-list intel-email-list-compact">
                {co.emails.slice(0, 5).map((e, j) => (
                  <div key={j} className="intel-email-row">
                    <a href={`mailto:${e.email}`} className="intel-email">{e.email}</a>
                    <div className="intel-email-meta">
                      <span className={`intel-conf intel-conf-${e.confidence >= 80 ? "high" : e.confidence >= 60 ? "mid" : "low"}`}>
                        {e.confidence}%
                      </span>
                      {e.smtp_valid === true && <span className="intel-badge-smtp">✓ SMTP</span>}
                      <span className="intel-source">{e.source?.replace(/_/g," ")}</span>
                    </div>
                    <CopyBtn value={e.email} label="email" />
                  </div>
                ))}
              </div>
            )}
            {co.phones?.slice(0,2).map((p, j) => (
              <div key={j} className="intel-phone-row">
                <span className="intel-phone-icon">☎</span>
                <span className="intel-phone">{p}</span>
                <CopyBtn value={p} label="phone" />
              </div>
            ))}
            {co.addresses?.slice(0,1).map((a, j) => (
              <div key={j} className="intel-address-row">
                <span className="intel-address-icon">📍</span>
                <span className="intel-address">{a}</span>
              </div>
            ))}
            {!co.domain && !co.emails?.length && (
              <div className="intel-no-domain">No contact data found for this company</div>
            )}
          </div>
        ))}
      </div>

      {/* External links */}
      {imo && (
        <div className="intel-external-links">
          <a href={`https://www.equasis.org`} target="_blank" rel="noopener noreferrer">Equasis</a>
          <a href={`https://www.marinetraffic.com/en/ais/details/ships/imo:${imo}`} target="_blank" rel="noopener noreferrer">MarineTraffic</a>
          <a href={`https://www.vesselfinder.com/?imo=${imo}`} target="_blank" rel="noopener noreferrer">VesselFinder</a>
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────
const VesselContactPanel = memo(function VesselContactPanel({ vessel, portCode }) {
  const [contacts,      setContacts]      = useState(null);
  const [intelligence,  setIntelligence]  = useState(null);
  const [intelLoading,  setIntelLoading]  = useState(false);
  const [intelError,    setIntelError]    = useState(null);
  const [agents,        setAgents]        = useState([]);
  const [loading,       setLoading]       = useState(false);
  const [enriching,     setEnriching]     = useState(false);
  const [error,         setError]         = useState(null);
  // Default to "intel" tab so contacts appear immediately on vessel select
  const [activeTab,     setActiveTab]     = useState("intel");
  const [geminiActive,  setGeminiActive]  = useState(false);

  const imo         = vessel?.imo_number  || null;
  const mmsi        = vessel?.mmsi_number || null;
  const name        = vessel?.vessel_name || null;
  const currentPort = portCode || vessel?.location_to || vessel?.port_name || null;
  const nextPort    = vessel?.next_port_destination || vessel?.destination || null;
  const vesselType  = vessel?.vessel_type || null;

  // Check if Gemini is configured server-side (no key shown to user)
  useEffect(() => {
    checkGeminiStatus()
      .then(s => setGeminiActive(s?.configured === true))
      .catch(() => {});
  }, []);

  // Reset state when vessel changes, then auto-load
  useEffect(() => {
    setContacts(null);
    setAgents([]);
    setError(null);
    setLoading(false);
    setIntelligence(null);
    setIntelError(null);
    setIntelLoading(false);
    setActiveTab("intel"); // always snap to contact intel tab on vessel change
  }, [imo, mmsi, name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Run intelligence pipeline automatically
  const runIntelPipeline = useCallback(async (ownerName, managerName, operatorName, shipMgrName, address, forceRefresh = false) => {
    if (!imo || (!ownerName && !managerName)) return;
    setIntelLoading(true);
    setIntelError(null);
    try {
      const intel = await fetchVesselIntelligence(imo, {
        owner: ownerName, manager: managerName,
        operator: operatorName, ship_manager: shipMgrName,
        address, forceRefresh,
      });
      if (intel?.companies?.length > 0) setIntelligence(intel);
      else setIntelError("No contact data found for this vessel's companies.");
    } catch (err) {
      setIntelError(err.message || "Intelligence pipeline failed.");
    } finally {
      setIntelLoading(false);
    }
  }, [imo]);

  const load = useCallback(async (bustCache = false) => {
    if (!imo && !mmsi && !name) return;
    setLoading(true);
    setError(null);
    try {
      const raw = await fetchVesselContacts(imo, { mmsi, name, currentPort, nextPort, vesselType, bustCache });
      const data = raw ? {
        ...raw,
        owner:        raw.owner || (raw.operator ? { ...raw.operator, company_name: raw.operator.name, primary_email: raw.operator.contact?.email, phone_primary: raw.operator.contact?.phone, website: raw.operator.contact?.website, data_source: raw.operator.data_source } : null),
        operator:     raw.operator     ? { company_name: raw.operator.name,     data_source: raw.operator.data_source }     : null,
        manager:      raw.manager      ? { company_name: raw.manager.name,      data_source: raw.manager.data_source }      : null,
        ship_manager: raw.ship_manager ? { company_name: raw.ship_manager.name, data_source: raw.ship_manager.data_source } : null,
        vessel_name:  raw.vessel?.name || null,
        enrichment:   raw.enrichment   ? { source: raw.enrichment.source, confidence: raw.enrichment.confidence, last_checked: raw.enrichment.last_checked, pipeline_ran: raw.enrichment.pipeline_ran } : null,
      } : null;
      setContacts(data);
      setAgents(data?.port_agents || []);

      // Auto-run intelligence pipeline immediately with company names
      const ownerName    = data?.owner?.company_name        || null;
      const managerName  = data?.manager?.company_name      || null;
      const operatorName = data?.operator?.company_name     || null;
      const shipMgrName  = data?.ship_manager?.company_name || null;
      const address      = data?.owner?.registered_address  || null;
      if (ownerName || managerName) {
        runIntelPipeline(ownerName, managerName, operatorName, shipMgrName, address, bustCache);
      } else if (imo) {
        // Fallback: run pipeline with just IMO — backend will look up company names
        runIntelPipeline(null, null, null, null, null, bustCache);
      }

      if (!data?.port_agents?.length && (currentPort || nextPort)) {
        try {
          const agentData = await fetchPortAgents(currentPort || nextPort, vesselType || "");
          if (Array.isArray(agentData)) setAgents(agentData);
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      setError(err.message || "Could not load contact data.");
    } finally {
      setLoading(false);
    }
  }, [imo, mmsi, name, currentPort, nextPort, vesselType, runIntelPipeline]);

  const triggerEnrich = useCallback(async () => {
    if (!imo) return;
    setEnriching(true);
    setError(null);
    try {
      await triggerVesselEnrichment(imo, { vessel_name: name, current_port: currentPort, next_port: nextPort, vessel_type: vesselType });
      await load(true);
    } catch (err) {
      setError(err.message || "Enrichment failed.");
    } finally {
      setEnriching(false);
    }
  }, [imo, name, currentPort, nextPort, vesselType, load]);

  useEffect(() => { load(); }, [load]);

  const agentCount      = agents.length;
  const intelEmailCount = intelligence?.top_contacts?.length || 0;
  const hasCompanyData  = contacts?.owner?.company_name || contacts?.manager?.company_name;

  const tabs = [
    { id: "intel",    label: `Contacts${intelEmailCount ? ` (${intelEmailCount})` : ""}`, icon: "✉" },
    { id: "company",  label: "Owner / Operator",                                           icon: "🏢" },
    { id: "agents",   label: `Port Agents${agentCount ? ` (${agentCount})` : ""}`,         icon: "⚓" },
    { id: "agentorg", label: "Agent Org",                                                  icon: "🏗" },
    { id: "master",   label: "Master",                                                     icon: "👨‍✈️" },
  ];

  return (
    <div className="cp-panel">
      {/* Tab bar — Gemini AI button removed */}
      <div className="cp-tabs">
        {tabs.map(t => (
          <button key={t.id} className={`cp-tab${activeTab === t.id ? " cp-tab-active" : ""}`} onClick={() => setActiveTab(t.id)}>
            <span className="cp-tab-icon">{t.icon}</span>{t.label}
          </button>
        ))}
        <div className="cp-tab-actions">
          {imo && (
            <button className="cp-enrich-btn" onClick={triggerEnrich} disabled={enriching || loading} title="Re-run full enrichment pipeline">
              {enriching ? "🔍 Searching…" : "🤖 Re-enrich"}
            </button>
          )}
          <button className="cp-refresh-btn" onClick={() => load(true)} title="Refresh" disabled={loading || enriching}>
            {loading ? "⟳" : "↻"}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="cp-content">
        {(loading || enriching) && (
          <div className="cp-loading">
            <div className="cp-spinner" />
            <span>{enriching ? "Running enrichment pipeline…" : "Fetching contact data…"}</span>
            {enriching && <span className="cp-loading-sub">Equasis → scrape → agents → master channel…</span>}
          </div>
        )}

        {!loading && !enriching && error && (
          <div className="cp-error"><span>⚠ {error}</span><button onClick={() => load(true)}>Retry</button></div>
        )}

        {/* ── Contact Intel tab (DEFAULT) ── */}
        {!loading && !enriching && !error && activeTab === "intel" && (
          <IntelligenceTab
            intelligence={intelligence}
            intelLoading={intelLoading}
            intelError={intelError}
            geminiActive={geminiActive}
            onRefresh={() => {
              const ownerName    = contacts?.owner?.company_name        || null;
              const managerName  = contacts?.manager?.company_name      || null;
              const operatorName = contacts?.operator?.company_name     || null;
              const shipMgrName  = contacts?.ship_manager?.company_name || null;
              const address      = contacts?.owner?.registered_address  || null;
              runIntelPipeline(ownerName, managerName, operatorName, shipMgrName, address, true);
            }}
            imo={imo}
          />
        )}

        {/* ── Owner/Operator tab ── */}
        {!loading && !enriching && !error && activeTab === "company" && (
          <div className="cp-companies">
            {contacts?.enrichment && (
              <div className="cp-enrich-meta">
                {confidenceBadge(contacts.enrichment.confidence)}
                <SourcePills source={contacts.enrichment.source} />
                {contacts.enrichment.last_checked && <span className="cp-last-checked">{new Date(contacts.enrichment.last_checked).toLocaleDateString()}</span>}
                {contacts.enrichment.pipeline_ran && <span className="cp-live-badge">🔴 Live</span>}
              </div>
            )}
            <CompanyCard title="Registered Owner" company={contacts?.owner}        accent="#00e5ff" />
            <CompanyCard title="Operator"          company={contacts?.operator}     accent="#fd9644" />
            <CompanyCard title="ISM Manager"       company={contacts?.manager}      accent="#a78bfa" />
            <CompanyCard title="Ship Manager"      company={contacts?.ship_manager} accent="#26de81" />
            {!hasCompanyData && (
              <div className="cp-no-data">
                <div className="cp-no-data-icon">🔍</div>
                <div>No company data found.</div>
                <div className="cp-no-data-sub">Click <strong>🤖 Re-enrich</strong> to search Equasis and maritime directories.</div>
                {imo && (
                  <div className="cp-no-data-links">
                    <a href="https://www.equasis.org" target="_blank" rel="noopener noreferrer">Equasis</a>
                    {" · "}<a href={`https://www.marinetraffic.com/en/ais/details/ships/imo:${imo}`} target="_blank" rel="noopener noreferrer">MarineTraffic</a>
                    {" · "}<a href={`https://www.vesselfinder.com/?imo=${imo}`} target="_blank" rel="noopener noreferrer">VesselFinder</a>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Port Agents tab ── */}
        {!loading && !enriching && !error && activeTab === "agents" && (
          <div className="cp-agents">
            <div className="cp-port-context-row">
              {currentPort && <span className="cp-port-badge current">⚓ Current: {currentPort}</span>}
              {nextPort    && <span className="cp-port-badge next">→ Next: {nextPort}</span>}
            </div>
            {agents.length === 0 ? (
              <div className="cp-no-data">
                <div className="cp-no-data-icon">⚓</div>
                <div>No port agents found.</div>
                <div className="cp-no-data-sub">Click <strong>🤖 Re-enrich</strong> to search for agents at {currentPort || nextPort || "this port"}.</div>
              </div>
            ) : (
              <>
                <div className="cp-agents-count">{agents.length} agent{agents.length !== 1 ? "s" : ""} found</div>
                {agents.map((a, i) => <AgentCard key={a.agent_id || `${a.agency_company}_${i}`} agent={a} />)}
              </>
            )}
          </div>
        )}

        {/* ── Agent Organisation tab ── */}
        {!loading && !enriching && !error && activeTab === "agentorg" && (
          <div className="cp-companies">
            {contacts?.agent_org ? (
              <div className="cp-card">
                <div className="cp-card-title" style={{ borderColor: "#f7b731" }}>
                  <span>Appointed Agent Organisation</span>
                  <span className="cp-source-pill">{contacts.agent_org.company_type}</span>
                  <SourcePills source={contacts.agent_org.data_source} />
                </div>
                <div className="cp-company-name">{contacts.agent_org.company_name}</div>
                {contacts.agent_org.registered_address && <div className="cp-address">📍 {contacts.agent_org.registered_address}</div>}
                <ContactRow icon="✉" label="Email"     value={contacts.agent_org.primary_email} href={contacts.agent_org.primary_email ? `mailto:${contacts.agent_org.primary_email}` : null} />
                <ContactRow icon="✉" label="Ops Email" value={contacts.agent_org.ops_email}     href={contacts.agent_org.ops_email ? `mailto:${contacts.agent_org.ops_email}` : null} />
                <ContactRow icon="☎" label="Phone"     value={contacts.agent_org.phone} />
                <ContactRow icon="🆘" label="24h"      value={contacts.agent_org.phone_24h} />
                <ContactRow icon="🌐" label="Website"  value={contacts.agent_org.website} href={contacts.agent_org.website ? (contacts.agent_org.website.startsWith("http") ? contacts.agent_org.website : `https://${contacts.agent_org.website}`) : null} />
              </div>
            ) : (
              <div className="cp-no-data"><div className="cp-no-data-icon">🏗</div><div>No agent org identified.</div><div className="cp-no-data-sub">Click <strong>🤖 Re-enrich</strong> to search.</div></div>
            )}
          </div>
        )}

        {/* ── Master Contact tab ── */}
        {!loading && !enriching && !error && activeTab === "master" && (
          <div className="cp-companies">
            <div className="cp-card" style={{ background: "rgba(255,160,60,0.04)" }}>
              <div className="cp-card-title" style={{ borderColor: "#fd9644" }}>👨‍✈️ Vessel Master / Captain</div>
              <div className="cp-privacy-notice">🔒 Personal contact of the master is not disclosed. Use channels below.</div>
            </div>
            {contacts?.master_contact ? (
              <>
                {contacts.master_contact.contact_note && (
                  <div className="cp-card">
                    <div className="cp-card-title" style={{ borderColor: "#00e5ff" }}>Preferred Channel: {contacts.master_contact.preferred_channel || "—"}</div>
                    <div className="cp-address" style={{ fontStyle: "normal" }}>{contacts.master_contact.contact_note}</div>
                  </div>
                )}
                {contacts.master_contact.crew_dept && (
                  <div className="cp-card">
                    <div className="cp-card-title" style={{ borderColor: "#26de81" }}>Ship Manager — Crew Dept</div>
                    {contacts.master_contact.crew_dept.company && <div className="cp-company-name">{contacts.master_contact.crew_dept.company}</div>}
                    <ContactRow icon="✉" label="Email" value={contacts.master_contact.crew_dept.email} href={contacts.master_contact.crew_dept.email ? `mailto:${contacts.master_contact.crew_dept.email}` : null} />
                    <ContactRow icon="☎" label="Phone" value={contacts.master_contact.crew_dept.phone} />
                  </div>
                )}
                {contacts.master_contact.mrcc && (
                  <div className="cp-card">
                    <div className="cp-card-title" style={{ borderColor: "#fc5c65" }}>🆘 MRCC</div>
                    <div className="cp-company-name">{contacts.master_contact.mrcc.name}</div>
                    <ContactRow icon="✉" label="Email" value={contacts.master_contact.mrcc.email} href={contacts.master_contact.mrcc.email ? `mailto:${contacts.master_contact.mrcc.email}` : null} />
                    <ContactRow icon="☎" label="Phone" value={contacts.master_contact.mrcc.phone} />
                  </div>
                )}
              </>
            ) : (
              <div className="cp-no-data"><div className="cp-no-data-icon">👨‍✈️</div><div>No master contact resolved.</div><div className="cp-no-data-sub">Click <strong>🤖 Re-enrich</strong>.</div></div>
            )}
          </div>
        )}
      </div>
      {/* GeminiContactFinder modal completely removed — Gemini runs server-side only */}
    </div>
  );
});

export default VesselContactPanel;