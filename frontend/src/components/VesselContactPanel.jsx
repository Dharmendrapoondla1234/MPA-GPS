// src/components/VesselContactPanel.jsx — MPA Contacts v1
// Shows shipping company, owner/operator, and port agent contacts for a vessel.
// Opened from VesselDetailPanel when user clicks "CONTACTS" tab.
import React, { useState, useEffect, useCallback, memo } from "react";
import { fetchVesselContacts, fetchPortAgents } from "../services/api";
import "./VesselContactPanel.css";

// ── Small helpers ─────────────────────────────────────────────────
function confidenceBadge(score) {
  if (score == null) return null;
  const pct = Math.round(score * 100);
  const cls = score >= 0.8 ? "conf-high" : score >= 0.5 ? "conf-mid" : "conf-low";
  return <span className={`conf-badge ${cls}`}>{pct}% confidence</span>;
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
  if (!company || !company.company_name) return (
    <div className="cp-card cp-card-empty">
      <div className="cp-card-title" style={{ borderColor: accent }}>{title}</div>
      <div className="cp-empty-msg">No {title.toLowerCase()} data available</div>
    </div>
  );
  return (
    <div className="cp-card">
      <div className="cp-card-title" style={{ borderColor: accent }}>
        {title}
        {company.country_code && (
          <span className="cp-country-badge">{company.country_code}</span>
        )}
      </div>
      <div className="cp-company-name">{company.company_name}</div>
      {company.registered_address && (
        <div className="cp-address">{company.registered_address}</div>
      )}
      <ContactRow icon="✉" label="Email" value={company.email}
        href={company.email ? `mailto:${company.email}` : null} />
      <ContactRow icon="✉" label="Alt Email" value={company.email_secondary}
        href={company.email_secondary ? `mailto:${company.email_secondary}` : null} />
      <ContactRow icon="☎" label="Phone" value={company.phone} />
      <ContactRow icon="☎" label="Alt Phone" value={company.phone_secondary} />
      {company.website && (
        <ContactRow icon="🌐" label="Website" value={company.website}
          href={company.website.startsWith("http") ? company.website : `https://${company.website}`} />
      )}
      {company.data_source && (
        <div className="cp-source">Source: {company.data_source}
          {company.last_verified_at && (
            <span className="cp-verified"> · verified {new Date(company.last_verified_at).toLocaleDateString()}</span>
          )}
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent }) {
  return (
    <div className="cp-agent-card">
      <div className="cp-agent-header">
        <span className="cp-agent-name">{agent.agent_name || "Agent"}</span>
        {agent.agency_company && agent.agency_company !== agent.agent_name && (
          <span className="cp-agent-company">{agent.agency_company}</span>
        )}
        {agent.vessel_type_served && agent.vessel_type_served !== "ALL" && (
          <span className="cp-agent-type">{agent.vessel_type_served}</span>
        )}
      </div>
      <ContactRow icon="✉" label="Email" value={agent.email}
        href={agent.email ? `mailto:${agent.email}` : null} />
      {agent.email_ops && agent.email_ops !== agent.email && (
        <ContactRow icon="✉" label="Ops Email" value={agent.email_ops}
          href={agent.email_ops ? `mailto:${agent.email_ops}` : null} />
      )}
      <ContactRow icon="☎" label="Phone" value={agent.phone} />
      {agent.phone_24h && (
        <ContactRow icon="🆘" label="24h Line" value={agent.phone_24h} />
      )}
      {agent.vhf_channel && (
        <ContactRow icon="📡" label="VHF" value={agent.vhf_channel} />
      )}
      {agent.data_source && (
        <div className="cp-source">Source: {agent.data_source}</div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────
const VesselContactPanel = memo(function VesselContactPanel({ vessel, portCode }) {
  const [contacts,   setContacts]   = useState(null);
  const [agents,     setAgents]     = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [activeTab,  setActiveTab]  = useState("company");

  const imo  = vessel?.imo_number;
  const mmsi = vessel?.mmsi_number;
  const name = vessel?.vessel_name;
  const port = portCode || vessel?.next_port_destination || vessel?.location_to;

  const load = useCallback(async () => {
    if (!imo && !mmsi && !name) return;
    setLoading(true);
    setError(null);
    try {
      const [c, a] = await Promise.allSettled([
        fetchVesselContacts(imo || 0, { mmsi, name }),
        port ? fetchPortAgents(port, vessel?.vessel_type || "") : Promise.resolve([]),
      ]);
      if (c.status === "fulfilled") setContacts(c.value);
      else setError("Could not load company contacts.");
      if (a.status === "fulfilled") setAgents(a.value || []);
    } finally {
      setLoading(false);
    }
  }, [imo, mmsi, name, port, vessel?.vessel_type]);

  useEffect(() => { load(); }, [load]);

  const tabs = [
    { id: "company", label: "Owner / Operator", icon: "🏢" },
    { id: "agents",  label: `Port Agents${agents.length ? ` (${agents.length})` : ""}`, icon: "⚓" },
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
        <button className="cp-refresh-btn" onClick={load} title="Refresh contacts" disabled={loading}>
          {loading ? "⟳" : "↻"}
        </button>
      </div>

      {/* Content */}
      <div className="cp-content">
        {loading && (
          <div className="cp-loading">
            <div className="cp-spinner" />
            <span>Fetching contact data…</span>
          </div>
        )}

        {!loading && error && (
          <div className="cp-error">
            <span>⚠ {error}</span>
            <button onClick={load}>Retry</button>
          </div>
        )}

        {!loading && !error && activeTab === "company" && (
          <div className="cp-companies">
            {contacts?.enrichment && (
              <div className="cp-enrich-meta">
                {confidenceBadge(contacts.enrichment.confidence)}
                {contacts.enrichment.last_checked && (
                  <span className="cp-last-checked">
                    Last checked: {new Date(contacts.enrichment.last_checked).toLocaleDateString()}
                  </span>
                )}
              </div>
            )}
            <CompanyCard title="Owner"    company={contacts?.owner}    accent="#00e5ff" />
            <CompanyCard title="Operator" company={contacts?.operator} accent="#fd9644" />
            <CompanyCard title="Manager"  company={contacts?.manager}  accent="#a78bfa" />

            {!contacts && !loading && (
              <div className="cp-no-data">
                <div className="cp-no-data-icon">🔍</div>
                <div>No contact data found for this vessel.</div>
                <div className="cp-no-data-sub">
                  Add data via the admin panel or check free sources:
                  <a href={`https://www.equasis.org/EquasisWeb/public/HomePage`} target="_blank" rel="noopener noreferrer"> Equasis</a>
                  {imo && <>, <a href={`https://www.marinetraffic.com/en/ais/details/ships/imo:${imo}`} target="_blank" rel="noopener noreferrer">MarineTraffic</a></>}
                </div>
              </div>
            )}
          </div>
        )}

        {!loading && !error && activeTab === "agents" && (
          <div className="cp-agents">
            {port && <div className="cp-port-badge">Port: {port}</div>}
            {agents.length === 0 ? (
              <div className="cp-no-data">
                <div className="cp-no-data-icon">⚓</div>
                <div>No port agents found{port ? ` for ${port}` : ""}.</div>
                <div className="cp-no-data-sub">
                  Check <a href="https://www.mpa.gov.sg/port-marine-services/port-marine-circular/port-marine-notices" target="_blank" rel="noopener noreferrer">MPA Port Notices</a> for agent listings.
                </div>
              </div>
            ) : (
              agents.map((a, i) => <AgentCard key={a.agent_id || i} agent={a} />)
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default VesselContactPanel;
