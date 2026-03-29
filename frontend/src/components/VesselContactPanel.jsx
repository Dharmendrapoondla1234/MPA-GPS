// src/components/VesselContactPanel.jsx — MPA Contacts v4
// Uses api.js service functions (fixes "Network error" by routing through the
// shared call() helper which handles auth headers, caching, and error formatting)
import React, { useState, useEffect, useCallback, memo } from "react";
import { fetchVesselContacts, fetchPortAgents, triggerVesselEnrichment, fetchVesselIntelligence } from "../services/api";
import "./VesselContactPanel.css";

// ── Helpers ───────────────────────────────────────────────────────
function confidenceBadge(score) {
  if (score == null) return null;
  const pct = Math.round(score * 100);
  const cls  = score >= 0.85 ? "conf-high" : score >= 0.60 ? "conf-mid" : "conf-low";
  const label = score >= 0.85 ? "High" : score >= 0.60 ? "Medium" : "Low";
  return <span className={`conf-badge ${cls}`} title={`${label} confidence`}>{pct}%</span>;
}

function SourcePills({ source }) {
  if (!source) return null;
  const map = { equasis: "Equasis", ai_search: "AI Web", scrape: "Website",
                google_cse: "Google", vesselfinder: "VF", ai_enriched: "AI", bigquery: "BQ" };
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
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  }, [value]);
  if (!value) return null;
  return (
    <button className="cp-copy-btn" onClick={copy} title={`Copy ${label}`}>
      {copied ? "✓" : "⎘"}
    </button>
  );
}

function ContactRow({ icon, label, value, href }) {
  if (!value) return null;
  return (
    <div className="cp-contact-row">
      <span className="cp-icon">{icon}</span>
      <div className="cp-contact-body">
        <span className="cp-label">{label}</span>
        {href
          ? <a className="cp-value cp-link" href={href} target="_blank" rel="noopener noreferrer">{value}</a>
          : <span className="cp-value">{value}</span>}
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
      {company.registered_address && (
        <div className="cp-address">📍 {company.registered_address}</div>
      )}
      <ContactRow icon="✉" label="Email"     value={company.email}
        href={company.email ? `mailto:${company.email}` : null} />
      <ContactRow icon="✉" label="Alt Email" value={company.email_secondary}
        href={company.email_secondary ? `mailto:${company.email_secondary}` : null} />
      <ContactRow icon="☎" label="Phone"     value={company.phone} />
      <ContactRow icon="☎" label="Alt Phone" value={company.phone_secondary} />
      {company.website && (
        <ContactRow icon="🌐" label="Website" value={company.website}
          href={company.website.startsWith("http") ? company.website : `https://${company.website}`} />
      )}
      {company.linkedin && (
        <ContactRow icon="💼" label="LinkedIn" value="View Profile" href={company.linkedin} />
      )}
      {company.last_verified_at && (
        <div className="cp-verified-date">
          ✓ Verified {new Date(company.last_verified_at).toLocaleDateString()}
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent }) {
  const ctxLabel = agent.port_context === "next" ? "Next Port" : "Current Port";
  return (
    <div className="cp-agent-card">
      <div className="cp-agent-header">
        <div className="cp-agent-name-row">
          <span className="cp-agent-name">{agent.agency_company || agent.agent_name || "Agent"}</span>
          {agent.port_context && (
            <span className={`cp-port-context-badge ${agent.port_context}`}>{ctxLabel}</span>
          )}
        </div>
        {agent.agent_name && agent.agent_name !== agent.agency_company && (
          <span className="cp-agent-contact-name">Contact: {agent.agent_name}</span>
        )}
        {agent.vessel_type_served && agent.vessel_type_served !== "ALL" && (
          <span className="cp-agent-type">{agent.vessel_type_served}</span>
        )}
      </div>

      {agent.port_name && (
        <div className="cp-agent-port">
          ⚓ {agent.port_name}{agent.port_code ? ` (${agent.port_code})` : ""}
        </div>
      )}

      <ContactRow icon="✉" label="Email"    value={agent.email}
        href={agent.email ? `mailto:${agent.email}` : null} />
      {agent.email_ops && agent.email_ops !== agent.email && (
        <ContactRow icon="✉" label="Ops Email" value={agent.email_ops}
          href={`mailto:${agent.email_ops}`} />
      )}
      <ContactRow icon="☎" label="Phone"   value={agent.phone} />
      {agent.phone_24h && (
        <ContactRow icon="🆘" label="24h Emergency" value={agent.phone_24h} />
      )}
      {agent.vhf_channel && (
        <ContactRow icon="📡" label="VHF" value={agent.vhf_channel} />
      )}
      {agent.website && (
        <ContactRow icon="🌐" label="Website" value={agent.website}
          href={agent.website.startsWith("http") ? agent.website : `https://${agent.website}`} />
      )}

      {agent.services?.length > 0 && (
        <div className="cp-agent-services">
          {agent.services.map(s => (
            <span key={s} className="cp-service-pill">{s}</span>
          ))}
        </div>
      )}

      <div className="cp-agent-meta">
        {agent.confidence != null && confidenceBadge(agent.confidence)}
        {agent.data_source && (
          <span className="cp-agent-source">{agent.data_source}</span>
        )}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────
const VesselContactPanel = memo(function VesselContactPanel({ vessel, portCode }) {
  const [contacts,  setContacts]  = useState(null);
  const [intelligence, setIntelligence] = useState(null);
  const [agents,    setAgents]    = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [error,     setError]     = useState(null);
  const [activeTab, setActiveTab] = useState("company");

  const imo         = vessel?.imo_number || null;
  const mmsi        = vessel?.mmsi_number || null;
  const name        = vessel?.vessel_name || null;
  const currentPort = portCode || vessel?.location_to || vessel?.port_name || null;
  const nextPort    = vessel?.next_port_destination || vessel?.destination || null;
  const vesselType  = vessel?.vessel_type || null;

  // Reset panel state immediately when the selected vessel changes — prevents
  // stale data from a previous vessel showing while new data loads
  useEffect(() => {
    setContacts(null);
    setAgents([]);
    setError(null);
    setLoading(false);
  }, [imo, mmsi, name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load contacts — uses api.js call() with caching + auth headers
  const load = useCallback(async (bustCache = false) => {
    if (!imo && !mmsi && !name) return;
    setLoading(true);
    setError(null);
    try {
      // Pass imo as null when absent — never 0 (imo=0 would cache-collide across vessels)
      const raw = await fetchVesselContacts(imo, {
        mmsi, name, currentPort, nextPort, vesselType, bustCache,
      });
      // Normalise spec endpoint shape → panel shape
      const data = raw ? {
        ...raw,
        // spec uses "operator" for owner info — map to "owner" for backward compat
        owner:        raw.owner       || (raw.operator ? { ...raw.operator, company_name: raw.operator.name, primary_email: raw.operator.contact?.email, phone_primary: raw.operator.contact?.phone, website: raw.operator.contact?.website, data_source: raw.operator.data_source } : null),
        operator:     raw.operator    ? { company_name: raw.operator.name,    data_source: raw.operator.data_source }    : null,
        manager:      raw.manager     ? { company_name: raw.manager.name,     data_source: raw.manager.data_source }     : null,
        ship_manager: raw.ship_manager? { company_name: raw.ship_manager.name,data_source: raw.ship_manager.data_source }: null,
        vessel_name:  raw.vessel?.name || null,
        enrichment: raw.enrichment ? {
          source:       raw.enrichment.source,
          confidence:   raw.enrichment.confidence,
          last_checked: raw.enrichment.last_checked,
          pipeline_ran: raw.enrichment.pipeline_ran,
        } : null,
      } : null;
      setContacts(data);
      setAgents(data?.port_agents || []);

      // After getting Equasis data, run intelligence pipeline for emails/domain
      // This works without AI: DuckDuckGo + DNS + website scraper + SMTP validation
      const ownerName   = data?.owner?.company_name || null;
      const managerName = data?.manager?.company_name || null;
      const operatorName= data?.operator?.company_name || null;
      const shipMgrName = data?.ship_manager?.company_name || null;
      if (imo && (ownerName || managerName)) {
        fetchVesselIntelligence(imo, {
          owner: ownerName, manager: managerName,
          operator: operatorName, ship_manager: shipMgrName,
        }).then(intel => {
          if (intel?.companies?.length > 0) setIntelligence(intel);
        }).catch(() => {});
      }

      // If no agents from contacts call, try standalone port agent lookup
      if (!(data?.port_agents?.length) && (currentPort || nextPort)) {
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
  }, [imo, mmsi, name, currentPort, nextPort, vesselType]);

  // Force re-run AI enrichment pipeline
  const triggerEnrich = useCallback(async () => {
    if (!imo) return;
    setEnriching(true);
    setError(null);
    try {
      await triggerVesselEnrichment(imo, {
        vessel_name:  name,
        current_port: currentPort,
        next_port:    nextPort,
        vessel_type:  vesselType,
      });
      await load(true); // bust cache after enrichment
    } catch (err) {
      setError(err.message || "Enrichment failed — try again.");
    } finally {
      setEnriching(false);
    }
  }, [imo, name, currentPort, nextPort, vesselType, load]);

  useEffect(() => { load(); }, [load]);

  const hasCompanyData = contacts?.owner?.company_name || contacts?.manager?.company_name;
  const agentCount     = agents.length;
  const agentOrg       = contacts?.agent_org       || null;
  const masterContact  = contacts?.master_contact  || null;

  const tabs = [
    { id: "company", label: "Owner / Operator",    icon: "🏢" },
    { id: "agents",  label: `Port Agents${agentCount ? ` (${agentCount})` : ""}`, icon: "⚓" },
    { id: "agentorg",label: "Agent Org",            icon: "🏗" },
    { id: "master",  label: "Master Contact",       icon: "👨‍✈️" },
  ];

  return (
    <div className="cp-panel">
      {/* Tab bar */}
      <div className="cp-tabs">
        {tabs.map(t => (
          <button
            key={t.id}
            className={`cp-tab${activeTab === t.id ? " cp-tab-active" : ""}`}
            onClick={() => setActiveTab(t.id)}
          >
            <span className="cp-tab-icon">{t.icon}</span>{t.label}
          </button>
        ))}
        <div className="cp-tab-actions">
          {imo && (
            <button
              className="cp-enrich-btn"
              onClick={triggerEnrich}
              disabled={enriching || loading}
              title="Re-run full AI enrichment pipeline"
            >
              {enriching ? "🔍 Searching…" : "🤖 Re-enrich"}
            </button>
          )}
          <button
            className="cp-refresh-btn"
            onClick={() => load(true)}
            title="Refresh"
            disabled={loading || enriching}
          >
            {loading ? "⟳" : "↻"}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="cp-content">
        {(loading || enriching) && (
          <div className="cp-loading">
            <div className="cp-spinner" />
            <span>{enriching ? "Running AI enrichment…" : "Fetching contact data…"}</span>
            {enriching && (
              <span className="cp-loading-sub">
                Equasis → AI web → scrape → agents → agent org → master channel…
              </span>
            )}
          </div>
        )}

        {!loading && !enriching && error && (
          <div className="cp-error">
            <span>⚠ {error}</span>
            <button onClick={() => load(true)}>Retry</button>
          </div>
        )}

        {/* ── Company tab ── */}
        {!loading && !enriching && !error && activeTab === "company" && (
          <div className="cp-companies">
            {contacts?.enrichment && (
              <div className="cp-enrich-meta">
                {confidenceBadge(contacts.enrichment.confidence)}
                <SourcePills source={contacts.enrichment.source} />
                {contacts.enrichment.last_checked && (
                  <span className="cp-last-checked">
                    {new Date(contacts.enrichment.last_checked).toLocaleDateString()}
                  </span>
                )}
                {contacts.enrichment.pipeline_ran && (
                  <span className="cp-live-badge">🔴 Live</span>
                )}
              </div>
            )}

            <CompanyCard title="Registered Owner" company={contacts?.owner}        accent="#00e5ff" />
            <CompanyCard title="Operator"          company={contacts?.operator}     accent="#fd9644" />
            <CompanyCard title="ISM Manager"       company={contacts?.manager}      accent="#a78bfa" />
            <CompanyCard title="Ship Manager"      company={contacts?.ship_manager} accent="#26de81" />

            {/* Intelligence pipeline results — emails/domain/phone from non-AI scraping */}
            {intelligence && intelligence.companies?.length > 0 && (
              <div className="cp-intelligence-panel">
                <div className="cp-intel-header">
                  <span className="cp-intel-icon">🔎</span>
                  <span className="cp-intel-title">CONTACT INTELLIGENCE</span>
                  <span className="cp-intel-badge">Domain · Email · Phone</span>
                </div>
                {intelligence.companies.map((co, i) => co.domain ? (
                  <div key={i} className="cp-intel-company">
                    <div className="cp-intel-company-name">{co.company} <span className="cp-intel-role">({co.role})</span></div>
                    {co.domain && (
                      <div className="cp-intel-row">
                        <span className="cp-intel-label">🌐 Website</span>
                        <a href={`https://${co.domain}`} target="_blank" rel="noopener noreferrer"
                           className="cp-intel-link">{co.domain}</a>
                      </div>
                    )}
                    {co.emails?.slice(0,3).map((e, j) => (
                      <div key={j} className="cp-intel-row">
                        <span className="cp-intel-label">✉ Email {j > 0 ? j+1 : ""}</span>
                        <a href={`mailto:${e.email}`} className="cp-intel-link">{e.email}</a>
                        <span className="cp-intel-conf" style={{color: e.confidence>=80?"#00ff9d":e.confidence>=60?"#fd9644":"#78909c"}}>
                          {e.confidence}%
                        </span>
                        {e.smtp_valid && <span className="cp-intel-smtp">✓ SMTP</span>}
                      </div>
                    ))}
                    {co.phones?.slice(0,2).map((p, j) => (
                      <div key={j} className="cp-intel-row">
                        <span className="cp-intel-label">☎ Phone</span>
                        <span className="cp-intel-val">{p}</span>
                      </div>
                    ))}
                  </div>
                ) : null)}
              </div>
            )}

            {!hasCompanyData && (
              <div className="cp-no-data">
                <div className="cp-no-data-icon">🔍</div>
                <div>No contact data found for this vessel.</div>
                <div className="cp-no-data-sub">
                  Click <strong>🤖 Re-enrich</strong> to search Equasis and company directories.
                </div>
                {imo && (
                  <div className="cp-no-data-links">
                    <a href="https://www.equasis.org" target="_blank" rel="noopener noreferrer">Equasis</a>
                    {" · "}
                    <a href={`https://www.marinetraffic.com/en/ais/details/ships/imo:${imo}`}
                       target="_blank" rel="noopener noreferrer">MarineTraffic</a>
                    {" · "}
                    <a href={`https://www.vesselfinder.com/?imo=${imo}`}
                       target="_blank" rel="noopener noreferrer">VesselFinder</a>
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
              {currentPort && (
                <span className="cp-port-badge current">⚓ Current: {currentPort}</span>
              )}
              {nextPort && (
                <span className="cp-port-badge next">→ Next: {nextPort}</span>
              )}
            </div>

            {agents.length === 0 ? (
              <div className="cp-no-data">
                <div className="cp-no-data-icon">⚓</div>
                <div>No port agents found.</div>
                <div className="cp-no-data-sub">
                  Click <strong>🤖 Re-enrich</strong> to search for agents at{" "}
                  {currentPort || nextPort || "this port"}.
                </div>
                {(currentPort || nextPort) && (
                  <div className="cp-no-data-links">
                    <a href="https://www.mpa.gov.sg" target="_blank" rel="noopener noreferrer">MPA Singapore</a>
                    {" · "}
                    <a href="https://www.gac.com" target="_blank" rel="noopener noreferrer">GAC</a>
                    {" · "}
                    <a href="https://www.wilhelmsen.com" target="_blank" rel="noopener noreferrer">Wilhelmsen</a>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="cp-agents-count">
                  {agents.length} agent{agents.length !== 1 ? "s" : ""} found
                </div>
                {agents.map((a, i) => (
                  <AgentCard key={a.agent_id || `${a.agency_company}_${i}`} agent={a} />
                ))}
              </>
            )}
          </div>
        )}

        {/* ── Agent Organisation tab ── */}
        {!loading && !enriching && !error && activeTab === "agentorg" && (
          <div className="cp-companies">
            {agentOrg ? (
              <div className="cp-card">
                <div className="cp-card-title" style={{ borderColor: "#f7b731" }}>
                  <span>Appointed Agent Organisation</span>
                  <span className="cp-source-pill">{agentOrg.company_type}</span>
                  {agentOrg.appointment_basis && (
                    <span className="cp-source-pill">{agentOrg.appointment_basis}</span>
                  )}
                  <SourcePills source={agentOrg.data_source} />
                </div>
                <div className="cp-company-name">{agentOrg.company_name}</div>
                {agentOrg.registered_address && (
                  <div className="cp-address">📍 {agentOrg.registered_address}</div>
                )}
                <ContactRow icon="✉" label="Primary Email" value={agentOrg.primary_email}
                  href={agentOrg.primary_email ? `mailto:${agentOrg.primary_email}` : null} />
                <ContactRow icon="✉" label="Ops Email"     value={agentOrg.ops_email}
                  href={agentOrg.ops_email ? `mailto:${agentOrg.ops_email}` : null} />
                <ContactRow icon="☎" label="Phone"         value={agentOrg.phone} />
                <ContactRow icon="🆘" label="24h Emergency" value={agentOrg.phone_24h} />
                <ContactRow icon="🌐" label="Website"       value={agentOrg.website}
                  href={agentOrg.website ? (agentOrg.website.startsWith("http") ? agentOrg.website : `https://${agentOrg.website}`) : null} />
                {agentOrg.services?.length > 0 && (
                  <div className="cp-agent-services" style={{ marginTop: 8 }}>
                    {agentOrg.services.map(s => <span key={s} className="cp-service-pill">{s}</span>)}
                  </div>
                )}
                {agentOrg.regions_covered?.length > 0 && (
                  <div className="cp-agent-services" style={{ marginTop: 6 }}>
                    {agentOrg.regions_covered.map(r => (
                      <span key={r} className="cp-service-pill" style={{ background: "rgba(247,183,49,0.1)", color: "#f7b731" }}>{r}</span>
                    ))}
                  </div>
                )}
                <div className="cp-agent-meta" style={{ marginTop: 8 }}>
                  {agentOrg.confidence != null && confidenceBadge(agentOrg.confidence)}
                </div>
              </div>
            ) : (
              <div className="cp-no-data">
                <div className="cp-no-data-icon">🏗</div>
                <div>No agent organisation identified.</div>
                <div className="cp-no-data-sub">
                  Click <strong>🤖 Re-enrich</strong> to search for the vessel's appointed husbandry agent organisation (e.g. GAC, Wilhelmsen, Inchcape).
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Master Contact tab ── */}
        {!loading && !enriching && !error && activeTab === "master" && (
          <div className="cp-companies">
            <div className="cp-card" style={{ background: "rgba(255,160,60,0.04)", borderColor: "rgba(255,160,60,0.15)" }}>
              <div className="cp-card-title" style={{ borderColor: "#fd9644" }}>
                👨‍✈️ Vessel Master / Captain Communication
              </div>
              <div className="cp-privacy-notice">
                🔒 Personal contact details of the vessel master are not disclosed in compliance with maritime privacy standards.
                Use the official channels below.
              </div>
            </div>

            {masterContact ? (
              <>
                {masterContact.contact_note && (
                  <div className="cp-card">
                    <div className="cp-card-title" style={{ borderColor: "#00e5ff" }}>
                      Preferred Channel: {masterContact.preferred_channel || "—"}
                    </div>
                    <div className="cp-address" style={{ color: "#b0bec5", fontStyle: "normal" }}>
                      {masterContact.contact_note}
                    </div>
                    {masterContact.contact_protocol && (
                      <div className="cp-address">{masterContact.contact_protocol}</div>
                    )}
                  </div>
                )}

                {masterContact.crew_dept && (
                  <div className="cp-card">
                    <div className="cp-card-title" style={{ borderColor: "#26de81" }}>
                      Ship Manager — Crew / Operations Dept
                    </div>
                    {masterContact.crew_dept.company && (
                      <div className="cp-company-name">{masterContact.crew_dept.company}</div>
                    )}
                    <ContactRow icon="✉" label="Email" value={masterContact.crew_dept.email}
                      href={masterContact.crew_dept.email ? `mailto:${masterContact.crew_dept.email}` : null} />
                    <ContactRow icon="☎" label="Phone" value={masterContact.crew_dept.phone} />
                  </div>
                )}

                {masterContact.mrcc && (
                  <div className="cp-card">
                    <div className="cp-card-title" style={{ borderColor: "#fc5c65" }}>
                      🆘 MRCC — Maritime Rescue Coordination Centre
                    </div>
                    <div className="cp-company-name">{masterContact.mrcc.name}</div>
                    {masterContact.mrcc.country && (
                      <div className="cp-address">Flag State: {masterContact.mrcc.country}</div>
                    )}
                    <ContactRow icon="✉" label="Email" value={masterContact.mrcc.email}
                      href={masterContact.mrcc.email ? `mailto:${masterContact.mrcc.email}` : null} />
                    <ContactRow icon="☎" label="Phone" value={masterContact.mrcc.phone} />
                  </div>
                )}

                {(masterContact.sat_phone_public || masterContact.radio_call_sign || masterContact.inmarsat_number) && (
                  <div className="cp-card">
                    <div className="cp-card-title" style={{ borderColor: "#a78bfa" }}>
                      📡 Vessel Communications
                    </div>
                    <ContactRow icon="📻" label="Radio Call Sign"  value={masterContact.radio_call_sign} />
                    <ContactRow icon="📡" label="Inmarsat Number"  value={masterContact.inmarsat_number} />
                    <ContactRow icon="📞" label="Sat Phone (Public)" value={masterContact.sat_phone_public} />
                  </div>
                )}

                <div className="cp-agent-meta" style={{ padding: "4px 0" }}>
                  {masterContact.confidence != null && confidenceBadge(masterContact.confidence)}
                  {masterContact.data_source && <span className="cp-agent-source">{masterContact.data_source}</span>}
                </div>
              </>
            ) : (
              <div className="cp-no-data">
                <div className="cp-no-data-icon">👨‍✈️</div>
                <div>No master contact channel resolved yet.</div>
                <div className="cp-no-data-sub">
                  Click <strong>🤖 Re-enrich</strong> to resolve the ship manager crew department, MRCC, and vessel comms channels.
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default VesselContactPanel;