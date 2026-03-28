// src/components/VesselContactPanel.jsx — MPA Contacts v3
// Shows owner/operator/manager contacts + AI-discovered port agents
import React, { useState, useEffect, useCallback, memo } from "react";
import "./VesselContactPanel.css";

// ── Helpers ───────────────────────────────────────────────────────
function confidenceBadge(score) {
  if (score == null) return null;
  const pct = Math.round(score * 100);
  const cls  = score >= 0.85 ? "conf-high" : score >= 0.60 ? "conf-mid" : "conf-low";
  const label = score >= 0.85 ? "High confidence" : score >= 0.60 ? "Medium confidence" : "Low confidence";
  return <span className={`conf-badge ${cls}`} title={label}>{pct}%</span>;
}

function sourcePill(source) {
  if (!source) return null;
  const parts  = source.split("+");
  const labels = { equasis: "Equasis", ai_search: "AI", scrape: "Web", google_cse: "Google", vesselfinder: "VF", ai_enriched: "AI" };
  return (
    <div className="cp-source-pills">
      {parts.map(p => (
        <span key={p} className="cp-source-pill" title={p}>{labels[p] || p}</span>
      ))}
    </div>
  );
}

function CopyBtn({ value, label }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
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
          : <span className="cp-value">{value}</span>
        }
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
        {company.data_source && sourcePill(company.data_source)}
      </div>
      <div className="cp-company-name">{company.company_name}</div>
      {company.registered_address && (
        <div className="cp-address">📍 {company.registered_address}</div>
      )}
      <ContactRow icon="✉" label="Email"      value={company.email}
        href={company.email ? `mailto:${company.email}` : null} />
      <ContactRow icon="✉" label="Alt Email"  value={company.email_secondary}
        href={company.email_secondary ? `mailto:${company.email_secondary}` : null} />
      <ContactRow icon="☎" label="Phone"      value={company.phone} />
      <ContactRow icon="☎" label="Alt Phone"  value={company.phone_secondary} />
      {company.website && (
        <ContactRow icon="🌐" label="Website" value={company.website}
          href={company.website.startsWith("http") ? company.website : `https://${company.website}`} />
      )}
      {company.linkedin && (
        <ContactRow icon="💼" label="LinkedIn" value="View Profile"
          href={company.linkedin} />
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
  const contextLabel = agent.port_context === "next" ? "Next Port" : "Current Port";
  return (
    <div className="cp-agent-card">
      <div className="cp-agent-header">
        <div className="cp-agent-name-row">
          <span className="cp-agent-name">{agent.agency_company || agent.agent_name || "Agent"}</span>
          {agent.port_context && (
            <span className={`cp-port-context-badge ${agent.port_context}`}>{contextLabel}</span>
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
        <div className="cp-agent-port">⚓ {agent.port_name}{agent.port_code ? ` (${agent.port_code})` : ""}</div>
      )}

      <ContactRow icon="✉" label="Email"    value={agent.email}
        href={agent.email ? `mailto:${agent.email}` : null} />
      {agent.email_ops && agent.email_ops !== agent.email && (
        <ContactRow icon="✉" label="Ops Email" value={agent.email_ops}
          href={agent.email_ops ? `mailto:${agent.email_ops}` : null} />
      )}
      <ContactRow icon="☎" label="Phone"    value={agent.phone} />
      {agent.phone_24h && (
        <ContactRow icon="🆘" label="24h Emergency" value={agent.phone_24h} />
      )}
      {agent.vhf_channel && (
        <ContactRow icon="📡" label="VHF Channel" value={agent.vhf_channel} />
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
        {agent.data_source && <span className="cp-agent-source">{agent.data_source}</span>}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────
const VesselContactPanel = memo(function VesselContactPanel({ vessel, portCode }) {
  const [contacts,   setContacts]   = useState(null);
  const [agents,     setAgents]     = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [enriching,  setEnriching]  = useState(false);
  const [error,      setError]      = useState(null);
  const [activeTab,  setActiveTab]  = useState("company");

  const imo         = vessel?.imo_number;
  const mmsi        = vessel?.mmsi_number;
  const name        = vessel?.vessel_name;
  const currentPort = portCode || vessel?.location_to || vessel?.port_name || null;
  const nextPort    = vessel?.next_port_destination || vessel?.destination || null;
  const vesselType  = vessel?.vessel_type || null;

  const load = useCallback(async () => {
    if (!imo && !mmsi && !name) return;
    setLoading(true);
    setError(null);
    try {
      // Build query params for port context
      const params = new URLSearchParams();
      if (mmsi)        params.set("mmsi", mmsi);
      if (name)        params.set("name", name);
      if (currentPort) params.set("currentPort", currentPort);
      if (nextPort)    params.set("nextPort", nextPort);
      if (vesselType)  params.set("vesselType", vesselType);

      const apiBase = process.env.REACT_APP_API_URL || "";
      const url = `${apiBase}/api/contacts/vessel/${imo || 0}?${params}`;

      const res  = await fetch(url);
      const json = await res.json();

      if (json.success && json.data) {
        setContacts(json.data);
        setAgents(json.data.port_agents || []);
      } else {
        setError("Could not load contact data.");
      }
    } catch (err) {
      setError("Network error — please retry.");
    } finally {
      setLoading(false);
    }
  }, [imo, mmsi, name, currentPort, nextPort, vesselType]);

  // Manual enrich trigger (force re-run pipeline)
  const triggerEnrich = useCallback(async () => {
    if (!imo) return;
    setEnriching(true);
    try {
      const apiBase = process.env.REACT_APP_API_URL || "";
      await fetch(`${apiBase}/api/contacts/enrich/${imo}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vessel_name:  name,
          current_port: currentPort,
          next_port:    nextPort,
          vessel_type:  vesselType,
        }),
      });
      await load(); // reload after enrichment
    } catch (err) {
      setError("Enrichment failed — try again.");
    } finally {
      setEnriching(false);
    }
  }, [imo, name, currentPort, nextPort, vesselType, load]);

  useEffect(() => { load(); }, [load]);

  const hasCompanyData = contacts?.owner?.company_name || contacts?.manager?.company_name;
  const agentCount     = agents.length;

  const tabs = [
    { id: "company", label: "Owner / Operator", icon: "🏢" },
    { id: "agents",  label: `Port Agents${agentCount ? ` (${agentCount})` : ""}`, icon: "⚓" },
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
            <span className="cp-tab-icon">{t.icon}</span> {t.label}
          </button>
        ))}
        <div className="cp-tab-actions">
          {imo && (
            <button
              className="cp-enrich-btn"
              onClick={triggerEnrich}
              disabled={enriching || loading}
              title="Re-run AI enrichment pipeline"
            >
              {enriching ? "🔍 Searching…" : "🤖 Re-enrich"}
            </button>
          )}
          <button className="cp-refresh-btn" onClick={load} title="Refresh" disabled={loading}>
            {loading ? "⟳" : "↻"}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="cp-content">
        {(loading || enriching) && (
          <div className="cp-loading">
            <div className="cp-spinner" />
            <span>{enriching ? "Running AI enrichment pipeline…" : "Fetching contact data…"}</span>
            {enriching && (
              <span className="cp-loading-sub">Searching Equasis, AI web, company sites…</span>
            )}
          </div>
        )}

        {!loading && !enriching && error && (
          <div className="cp-error">
            <span>⚠ {error}</span>
            <button onClick={load}>Retry</button>
          </div>
        )}

        {/* ── Company tab ── */}
        {!loading && !enriching && !error && activeTab === "company" && (
          <div className="cp-companies">
            {contacts?.enrichment && (
              <div className="cp-enrich-meta">
                {confidenceBadge(contacts.enrichment.confidence)}
                {contacts.enrichment.source && sourcePill(contacts.enrichment.source)}
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

            <CompanyCard title="Registered Owner" company={contacts?.owner}    accent="#00e5ff" />
            <CompanyCard title="Operator"         company={contacts?.operator} accent="#fd9644" />
            <CompanyCard title="ISM Manager"      company={contacts?.manager}  accent="#a78bfa" />
            <CompanyCard title="Ship Manager"     company={contacts?.ship_manager} accent="#26de81" />

            {!hasCompanyData && !loading && (
              <div className="cp-no-data">
                <div className="cp-no-data-icon">🔍</div>
                <div>No contact data found for this vessel.</div>
                <div className="cp-no-data-sub">
                  Click <strong>🤖 Re-enrich</strong> to search Equasis, AI web, and company directories.
                </div>
                {imo && (
                  <div className="cp-no-data-links">
                    <a href={`https://www.equasis.org/EquasisWeb/public/HomePage`} target="_blank" rel="noopener noreferrer">Equasis</a>
                    {" · "}
                    <a href={`https://www.marinetraffic.com/en/ais/details/ships/imo:${imo}`} target="_blank" rel="noopener noreferrer">MarineTraffic</a>
                    {" · "}
                    <a href={`https://www.vesselfinder.com/?imo=${imo}`} target="_blank" rel="noopener noreferrer">VesselFinder</a>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Port Agents tab ── */}
        {!loading && !enriching && !error && activeTab === "agents" && (
          <div className="cp-agents">
            {/* Port context header */}
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
                  {currentPort || nextPort || "the current port"}.
                </div>
                {(currentPort || nextPort) && (
                  <div className="cp-no-data-links">
                    <a href={`https://www.mpa.gov.sg`} target="_blank" rel="noopener noreferrer">MPA Singapore</a>
                    {" · "}
                    <a href={`https://www.iacs.org.uk`} target="_blank" rel="noopener noreferrer">IACS</a>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="cp-agents-count">{agents.length} agent{agents.length !== 1 ? "s" : ""} found</div>
                {agents.map((a, i) => <AgentCard key={a.agent_id || i} agent={a} />)}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default VesselContactPanel;