// VesselContactPanel.jsx — v6 "Split-Editor Contact Panel" (FIXED)
// Fixes: BQ table mismatch, empty contact display, cascade failures
// New:   Resizable Sash between Company/Intel pane and Agents/Master pane
 
import React, { useState, useEffect, useCallback, useRef, memo } from "react";
import {
  fetchVesselContacts, fetchPortAgents,
  triggerVesselEnrichment, fetchVesselIntelligence,
  checkGeminiStatus,
} from "../services/api";
import GeminiContactFinder from "./GeminiContactFinder";
import "./VesselContactPanel.css";

// ─────────────────────────────────────────
// ── SASH (resizable split handle) ────────
// ─────────────────────────────────────────
function Sash({ split, onSplit, containerRef, minTop = 140, minBottom = 100 }) {
  const dragging  = useRef(false);
  const startY    = useRef(0);
  const startSpl  = useRef(split);

  const move = useCallback((clientY) => {
    if (!containerRef.current) return;
    const rect  = containerRef.current.getBoundingClientRect();
    const total = rect.height;
    const delta = clientY - startY.current;
    const raw   = startSpl.current * total + delta;
    const clamped = Math.min(Math.max(raw, minTop), total - minBottom);
    onSplit(clamped / total);
  }, [containerRef, onSplit, minTop, minBottom]);

  const onMD = (e) => {
    e.preventDefault();
    dragging.current  = true;
    startY.current    = e.clientY;
    startSpl.current  = split;
    document.addEventListener("mousemove", onMM);
    document.addEventListener("mouseup",   onMU);
    document.body.style.cursor     = "row-resize";
    document.body.style.userSelect = "none";
  };
  const onMM = (e) => { if (dragging.current) move(e.clientY); };
  const onMU = () => {
    dragging.current = false;
    document.removeEventListener("mousemove", onMM);
    document.removeEventListener("mouseup",   onMU);
    document.body.style.cursor     = "";
    document.body.style.userSelect = "";
  };
  const onTS = (e) => { startY.current = e.touches[0].clientY; startSpl.current = split; };
  const onTM = (e) => { e.preventDefault(); move(e.touches[0].clientY); };

  return (
    <div className="cp-sash" onMouseDown={onMD} onTouchStart={onTS} onTouchMove={onTM}>
      <div className="cp-sash-grip"><span/><span/><span/></div>
    </div>
  );
}

// ─────────────────────────────────────────
// ── UI HELPERS ────────────────────────────
// ─────────────────────────────────────────
function confidenceBadge(score) {
  if (score == null) return null;
  const pct = typeof score === "number" && score <= 1 ? Math.round(score * 100) : Math.round(score);
  const cls  = pct >= 80 ? "conf-high" : pct >= 55 ? "conf-mid" : "conf-low";
  return <span className={`conf-badge ${cls}`}>{pct}%</span>;
}

function SourcePills({ source }) {
  if (!source) return null;
  const map = {
    equasis:"Equasis", ai_search:"AI Web", scrape:"Scraped",
    google_cse:"Google", website_mailto:"Mailto", website_scraped:"Scraped",
    smtp_validated:"SMTP✓", pattern_generated:"Pattern", bigquery:"BQ Cache",
    manual:"Manual", "search+content_validated":"Verified", marinetraffic:"MT",
  };
  return (
    <div className="cp-source-pills">
      {source.split("+").map(p => (
        <span key={p} className="cp-source-pill">{map[p] || p}</span>
      ))}
    </div>
  );
}

// ── Company card ──────────────────────────
function CompanyCard({ title, company, accent = "#00e5ff" }) {
  const [copied, setCopied] = useState(false);

  const copyEmail = async (email) => {
    if (!email) return;
    try { await navigator.clipboard.writeText(email); }
    catch { const t=document.createElement("textarea"); t.value=email; document.body.appendChild(t); t.select(); document.execCommand("copy"); document.body.removeChild(t); }
    setCopied(true); setTimeout(() => setCopied(false), 1400);
  };

  if (!company?.company_name) return (
    <div className="cp-card cp-card-empty">
      <div className="cp-card-title" style={{ borderColor: accent }}>
        <span>{title}</span>
        <span className="cp-card-status cp-card-none">—</span>
      </div>
    </div>
  );

  return (
    <div className="cp-card">
      <div className="cp-card-title" style={{ borderColor: accent }}>
        <span>{title}</span>
        {company.data_source && <SourcePills source={company.data_source}/>}
      </div>
      <div className="cp-card-name">{company.company_name}</div>
      {company.registered_address && <div className="cp-card-addr">📍 {company.registered_address}</div>}
      <div className="cp-card-contacts">
        {company.primary_email && (
          <div className="cp-contact-row">
            <span className="cp-contact-icon">✉</span>
            <a href={`mailto:${company.primary_email}`} className="cp-contact-val cp-email">{company.primary_email}</a>
            <button className="cp-copy-btn" onClick={() => copyEmail(company.primary_email)} title="Copy">{copied ? "✅" : "📋"}</button>
          </div>
        )}
        {company.secondary_email && (
          <div className="cp-contact-row">
            <span className="cp-contact-icon">✉</span>
            <a href={`mailto:${company.secondary_email}`} className="cp-contact-val cp-email">{company.secondary_email}</a>
          </div>
        )}
        {company.phone_primary && (
          <div className="cp-contact-row">
            <span className="cp-contact-icon">📞</span>
            <a href={`tel:${company.phone_primary}`} className="cp-contact-val">{company.phone_primary}</a>
          </div>
        )}
        {company.phone_secondary && (
          <div className="cp-contact-row">
            <span className="cp-contact-icon">📞</span>
            <span className="cp-contact-val">{company.phone_secondary}</span>
          </div>
        )}
        {company.website && (
          <div className="cp-contact-row">
            <span className="cp-contact-icon">🌐</span>
            <a href={company.website.startsWith("http") ? company.website : `https://${company.website}`}
               target="_blank" rel="noopener noreferrer" className="cp-contact-val">{company.website}</a>
          </div>
        )}
        {company.linkedin && (
          <div className="cp-contact-row">
            <span className="cp-contact-icon">in</span>
            <a href={company.linkedin} target="_blank" rel="noopener noreferrer" className="cp-contact-val">LinkedIn</a>
          </div>
        )}
      </div>
      {company.confidence != null && (
        <div className="cp-card-footer">{confidenceBadge(company.confidence)}</div>
      )}
    </div>
  );
}

// ── Agent card ────────────────────────────
function AgentCard({ agent }) {
  const a = agent;
  return (
    <div className="cp-agent-card">
      <div className="cp-agent-head">
        <span className="cp-agent-name">{a.agency_company || a.agent_name || "Agent"}</span>
        {a.port_code && <span className="cp-agent-port">{a.port_code}</span>}
        {a.vessel_type_served && a.vessel_type_served !== "ALL" && (
          <span className="cp-agent-type">{a.vessel_type_served}</span>
        )}
      </div>
      {a.agent_name && a.agent_name !== a.agency_company && (
        <div className="cp-agent-person">Contact: {a.agent_name}</div>
      )}
      <div className="cp-agent-contacts">
        {a.email_primary || a.email ? (
          <a href={`mailto:${a.email_primary||a.email}`} className="cp-agent-email">✉ {a.email_primary||a.email}</a>
        ) : null}
        {a.email_ops && <a href={`mailto:${a.email_ops}`} className="cp-agent-email">✉ {a.email_ops} (ops)</a>}
        {(a.phone_main||a.phone) && <span className="cp-agent-phone">📞 {a.phone_main||a.phone}</span>}
        {a.phone_24h  && <span className="cp-agent-phone">📞 {a.phone_24h} (24h)</span>}
        {a.vhf_channel && <span className="cp-agent-vhf">VHF {a.vhf_channel}</span>}
      </div>
      {a.services?.length > 0 && (
        <div className="cp-agent-services">{a.services.slice(0,4).map(s => <span key={s} className="cp-service-tag">{s}</span>)}</div>
      )}
      {a.confidence && <div className="cp-agent-footer">{confidenceBadge(a.confidence)}</div>}
    </div>
  );
}

// ── Intelligence email list ───────────────
function IntelPane({ intelligence, loading, error, onRefresh, imo }) {
  if (loading) return (
    <div className="cp-intel-loading">
      <div className="cp-spinner"/><span>Running domain → crawl → SMTP pipeline…</span>
    </div>
  );
  if (error) return (
    <div className="cp-intel-error">
      <span>⚠ {error}</span>
      <button className="cp-retry-btn" onClick={onRefresh}>Retry</button>
    </div>
  );
  if (!intelligence?.companies?.length) return (
    <div className="cp-intel-empty">
      <div className="cp-no-data-icon">🔎</div>
      <div>No email intelligence yet.</div>
      <div className="cp-no-data-sub">Click <strong>🔍 Run Intel</strong> after owner name is loaded.</div>
    </div>
  );

  const { companies, top_contacts, top_phones, cached, gemini_used } = intelligence;

  return (
    <div className="cp-intel-pane">
      <div className="cp-intel-meta">
        {cached     && <span className="cp-badge-cached">cached</span>}
        {gemini_used&& <span className="cp-badge-gemini">✨ Gemini</span>}
        <button className="cp-refresh-sm" onClick={onRefresh} title="Re-run pipeline">↺ Refresh</button>
      </div>

      {top_contacts?.length > 0 && (
        <div className="cp-intel-section">
          <div className="cp-intel-section-hd">✉ TOP CONTACTS <span className="cp-intel-count">{top_contacts.length}</span></div>
          {top_contacts.map((e,i) => (
            <div key={i} className="cp-intel-email-row">
              <a href={`mailto:${e.email}`} className="cp-intel-email">{e.email}</a>
              {confidenceBadge(e.confidence)}
              {e.smtp_valid===true  && <span className="cp-badge-smtp">SMTP✓</span>}
              {e.smtp_valid===false && <span className="cp-badge-rejected">✗</span>}
              <span className="cp-intel-source">{(e.source||"").replace(/_/g," ")}</span>
            </div>
          ))}
        </div>
      )}

      {top_phones?.length > 0 && (
        <div className="cp-intel-section">
          <div className="cp-intel-section-hd">☎ PHONES</div>
          {top_phones.map((p,i) => <div key={i} className="cp-intel-phone-row">{p}</div>)}
        </div>
      )}

      <div className="cp-intel-section">
        <div className="cp-intel-section-hd">🏢 BY COMPANY</div>
        {companies.map((co,i) => (
          <div key={i} className="cp-intel-co-block">
            <div className="cp-intel-co-hd">
              <span className="cp-intel-co-name">{co.company}</span>
              {co.domain && (
                <a href={`https://${co.domain}`} target="_blank" rel="noopener noreferrer"
                   className="cp-intel-domain">{co.domain}</a>
              )}
              <span className="cp-intel-role">{co.role}</span>
            </div>
            {co.emails?.map((e,j) => (
              <div key={j} className="cp-intel-email-row cp-intel-email-sub">
                <a href={`mailto:${e.email}`} className="cp-intel-email">{e.email}</a>
                {confidenceBadge(e.confidence)}
              </div>
            ))}
            {!co.emails?.length && <div className="cp-intel-no-email">No emails found</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// ── MAIN COMPONENT ────────────────────────
// ─────────────────────────────────────────
const VesselContactPanel = memo(function VesselContactPanel({ vessel, portCode }) {
  // Data state
  const [contacts,     setContacts]     = useState(null);
  const [intelligence, setIntelligence] = useState(null);
  const [agents,       setAgents]       = useState([]);

  // UI state
  const [loading,      setLoading]      = useState(false);
  const [enriching,    setEnriching]    = useState(false);
  const [intelLoading, setIntelLoading] = useState(false);
  const [error,        setError]        = useState(null);
  const [intelError,   setIntelError]   = useState(null);
  const [geminiOpen,   setGeminiOpen]   = useState(false);
  const [geminiCfg,    setGeminiCfg]    = useState(null);

  // Tab state (top pane)
  const [topTab,  setTopTab]  = useState("company"); // company | intel
  // Tab state (bottom pane)
  const [botTab,  setBotTab]  = useState("agents");  // agents | agentorg | master

  // Sash
  const containerRef = useRef(null);
  const [splitRatio, setSplitRatio] = useState(0.52); // top pane = 52%

  const imo         = vessel?.imo_number  || null;
  const mmsi        = vessel?.mmsi_number || null;
  const name        = vessel?.vessel_name || null;
  const currentPort = portCode || vessel?.location_to || vessel?.port_name || null;
  const nextPort    = vessel?.next_port_destination || vessel?.destination || null;
  const vesselType  = vessel?.vessel_type || null;

  useEffect(() => {
    checkGeminiStatus().then(s => setGeminiCfg(s?.configured ?? null)).catch(() => {});
  }, []);

  // Reset on vessel change
  useEffect(() => {
    setContacts(null); setAgents([]); setError(null);
    setIntelligence(null); setIntelError(null);
    setLoading(false); setEnriching(false); setIntelLoading(false);
  }, [imo, mmsi, name]); // eslint-disable-line

  // Run intelligence pipeline
  const runIntel = useCallback(async (ownerName, managerName, operatorName, shipMgr, address, force=false) => {
    if (!imo || (!ownerName && !managerName)) return;
    setIntelLoading(true); setIntelError(null);
    try {
      const r = await fetchVesselIntelligence(imo, {
        owner: ownerName, manager: managerName,
        operator: operatorName, ship_manager: shipMgr,
        address, forceRefresh: force,
      });
      if (r?.companies?.length) setIntelligence(r);
      else setIntelError("No email contacts found for this vessel's companies.");
    } catch(err) { setIntelError(err.message || "Intelligence pipeline failed."); }
    finally { setIntelLoading(false); }
  }, [imo]);

  // Main load
  const load = useCallback(async (bust = false) => {
    if (!imo && !mmsi && !name) return;
    setLoading(true); setError(null);
    try {
      const raw = await fetchVesselContacts(imo, { mmsi, name, currentPort, nextPort, vesselType, bustCache: bust });

      // Normalise the /vessel-contact spec response shape
      const data = raw ? {
        ...raw,
        owner: raw.owner
          ? { ...raw.owner,
              company_name:  raw.owner.company_name || raw.owner.name,
              primary_email: raw.owner.primary_email || raw.owner.contact?.email || raw.owner.email,
              phone_primary: raw.owner.phone_primary || raw.owner.contact?.phone || raw.owner.phone,
              website:       raw.owner.website       || raw.owner.contact?.website,
            }
          : null,
        operator: raw.operator
          ? { company_name: raw.operator.company_name||raw.operator.name, data_source: raw.operator.data_source }
          : null,
        manager: raw.manager
          ? { company_name: raw.manager.company_name||raw.manager.name,   data_source: raw.manager.data_source }
          : null,
        ship_manager: raw.ship_manager
          ? { company_name: raw.ship_manager.company_name||raw.ship_manager.name }
          : null,
        vessel_name: raw.vessel?.name || raw.vessel_name || null,
      } : null;

      setContacts(data);
      setAgents(data?.port_agents || []);

      // Auto-trigger intel pipeline with company names
      const ownerName = data?.owner?.company_name || null;
      const mgrName   = data?.manager?.company_name || null;
      if (ownerName || mgrName) {
        runIntel(ownerName, mgrName, data?.operator?.company_name||null, data?.ship_manager?.company_name||null, data?.owner?.registered_address||null, bust);
      }

      // Separate port agent fetch if missing
      if (!(data?.port_agents?.length) && (currentPort || nextPort)) {
        try {
          const agentData = await fetchPortAgents(currentPort||nextPort, vesselType||"");
          if (Array.isArray(agentData)) setAgents(agentData);
        } catch { /* non-fatal */ }
      }
    } catch(err) { setError(err.message || "Could not load contact data."); }
    finally { setLoading(false); }
  }, [imo, mmsi, name, currentPort, nextPort, vesselType, runIntel]);

  const triggerEnrich = useCallback(async () => {
    if (!imo) return;
    setEnriching(true); setError(null);
    try {
      await triggerVesselEnrichment(imo, { vessel_name:name, current_port:currentPort, next_port:nextPort, vessel_type:vesselType });
      await load(true);
    } catch(err) { setError(err.message || "Enrichment failed."); }
    finally { setEnriching(false); }
  }, [imo, name, currentPort, nextPort, vesselType, load]);

  useEffect(() => { load(); }, [load]);

  const hasCompany = contacts?.owner?.company_name || contacts?.manager?.company_name;
  const intelCount = intelligence?.top_contacts?.length || 0;
  const agentCount = agents.length;

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="cp-panel" ref={containerRef}>

      {/* ── Action bar ── */}
      <div className="cp-action-bar">
        <div className="cp-action-title">
          {imo ? <span className="cp-imo-tag">IMO {imo}</span> : null}
          {(currentPort||nextPort) && <span className="cp-port-tag">⚓ {currentPort||nextPort}</span>}
        </div>
        <div className="cp-action-btns">
          {geminiCfg !== false && (
            <button className="cp-gemini-btn" onClick={() => setGeminiOpen(true)} title="AI contact search">✨ AI Search</button>
          )}
          {imo && (
            <button className="cp-enrich-btn" onClick={triggerEnrich} disabled={enriching||loading} title="Full enrichment pipeline">
              {enriching ? "🔍 Searching…" : "🤖 Re-enrich"}
            </button>
          )}
          {hasCompany && (
            <button className="cp-intel-btn"
              onClick={() => { setTopTab("intel"); runIntel(contacts?.owner?.company_name, contacts?.manager?.company_name, contacts?.operator?.company_name, contacts?.ship_manager?.company_name, contacts?.owner?.registered_address, true); }}
              disabled={intelLoading} title="Run email intelligence pipeline">
              {intelLoading ? "⏳" : "🔍"} Intel
            </button>
          )}
          <button className="cp-refresh-btn" onClick={() => load(true)} disabled={loading||enriching}>↺</button>
        </div>
      </div>

      {/* ── Loading overlay ── */}
      {(loading||enriching) && (
        <div className="cp-loading">
          <div className="cp-spinner"/>
          <span>{enriching ? "Running enrichment pipeline…" : "Fetching contacts…"}</span>
          {enriching && <span className="cp-loading-sub">Equasis → scrape → domain → SMTP</span>}
        </div>
      )}

      {/* ── Error ── */}
      {!loading && !enriching && error && (
        <div className="cp-error">
          <span>⚠ {error}</span>
          <button onClick={() => load(true)}>Retry</button>
        </div>
      )}

      {/* ── Split body ── */}
      {!loading && !enriching && !error && (
        <div className="cp-split-body">

          {/* TOP PANE */}
          <div className="cp-top-pane" style={{ height: `calc(${splitRatio * 100}% - 8px)` }}>
            {/* Top tab bar */}
            <div className="cp-subtabs">
              <button className={"cp-subtab"+(topTab==="company"?" cp-subtab--on":"")} onClick={() => setTopTab("company")}>
                🏢 Owner / Operator
              </button>
              <button className={"cp-subtab"+(topTab==="intel"?" cp-subtab--on":"")} onClick={() => setTopTab("intel")}>
                🔎 Contact Intel{intelCount ? ` (${intelCount})` : ""}
              </button>
            </div>

            <div className="cp-top-scroll">
              {topTab === "company" && (
                <div className="cp-companies">
                  {contacts?.enrichment && (
                    <div className="cp-enrich-meta">
                      {confidenceBadge(contacts.enrichment.confidence)}
                      <SourcePills source={contacts.enrichment.source}/>
                      {contacts.enrichment.last_checked && (
                        <span className="cp-last-checked">{new Date(contacts.enrichment.last_checked).toLocaleDateString()}</span>
                      )}
                      {contacts.enrichment.pipeline_ran && <span className="cp-live-badge">🔴 Live</span>}
                    </div>
                  )}
                  <CompanyCard title="Registered Owner" company={contacts?.owner}        accent="#00e5ff"/>
                  <CompanyCard title="Operator"          company={contacts?.operator}     accent="#fd9644"/>
                  <CompanyCard title="ISM Manager"       company={contacts?.manager}      accent="#a78bfa"/>
                  <CompanyCard title="Ship Manager"      company={contacts?.ship_manager} accent="#26de81"/>

                  {!hasCompany && !loading && (
                    <div className="cp-no-data">
                      <div className="cp-no-data-icon">🔍</div>
                      <div>No company data found.</div>
                      <div className="cp-no-data-sub">
                        Click <strong>🤖 Re-enrich</strong> to search Equasis and maritime directories.
                      </div>
                      {imo && (
                        <div className="cp-no-data-links">
                          <a href="https://www.equasis.org"            target="_blank" rel="noopener noreferrer">Equasis</a>
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

              {topTab === "intel" && (
                <IntelPane
                  intelligence={intelligence}
                  loading={intelLoading}
                  error={intelError}
                  imo={imo}
                  onRefresh={() => runIntel(
                    contacts?.owner?.company_name, contacts?.manager?.company_name,
                    contacts?.operator?.company_name, contacts?.ship_manager?.company_name,
                    contacts?.owner?.registered_address, true
                  )}
                />
              )}
            </div>
          </div>

          {/* SASH */}
          <Sash split={splitRatio} onSplit={setSplitRatio} containerRef={containerRef}/>

          {/* BOTTOM PANE */}
          <div className="cp-bot-pane" style={{ height: `calc(${(1-splitRatio)*100}% - 8px)` }}>
            {/* Bottom tab bar */}
            <div className="cp-subtabs">
              <button className={"cp-subtab"+(botTab==="agents"?" cp-subtab--on":"")} onClick={() => setBotTab("agents")}>
                ⚓ Port Agents{agentCount ? ` (${agentCount})` : ""}
              </button>
              <button className={"cp-subtab"+(botTab==="agentorg"?" cp-subtab--on":"")} onClick={() => setBotTab("agentorg")}>
                🏗 Agent Org
              </button>
              <button className={"cp-subtab"+(botTab==="master"?" cp-subtab--on":"")} onClick={() => setBotTab("master")}>
                👨‍✈️ Master
              </button>
            </div>

            <div className="cp-bot-scroll">
              {botTab === "agents" && (
                <div className="cp-agents">
                  {(currentPort||nextPort) && (
                    <div className="cp-port-ctx">
                      {currentPort && <span className="cp-port-badge cp-port-cur">⚓ Current: {currentPort}</span>}
                      {nextPort    && <span className="cp-port-badge cp-port-nxt">→ Next: {nextPort}</span>}
                    </div>
                  )}
                  {agents.length === 0 ? (
                    <div className="cp-no-data">
                      <div className="cp-no-data-icon">⚓</div>
                      <div>No port agents found.</div>
                      <div className="cp-no-data-sub">Click <strong>🤖 Re-enrich</strong> to search for agents at {currentPort||nextPort||"this port"}.</div>
                      {(currentPort||nextPort) && (
                        <div className="cp-no-data-links">
                          <a href="https://www.mpa.gov.sg"        target="_blank" rel="noopener noreferrer">MPA SG</a>
                          {" · "}<a href="https://www.gac.com"    target="_blank" rel="noopener noreferrer">GAC</a>
                          {" · "}<a href="https://www.wilhelmsen.com" target="_blank" rel="noopener noreferrer">Wilhelmsen</a>
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="cp-agents-count">{agents.length} agent{agents.length!==1?"s":""} found</div>
                      {agents.map((a,i) => <AgentCard key={a.agent_id||`${a.agency_company}_${i}`} agent={a}/>)}
                    </>
                  )}
                </div>
              )}

              {botTab === "agentorg" && (
                <div className="cp-companies">
                  {contacts?.agent_org ? (
                    <div className="cp-card">
                      <div className="cp-card-title" style={{ borderColor:"#f7b731" }}>
                        <span>Appointed Agent Organisation</span>
                        {contacts.agent_org.data_source && <SourcePills source={contacts.agent_org.data_source}/>}
                      </div>
                      <div className="cp-card-name">{contacts.agent_org.company_name}</div>
                      {contacts.agent_org.primary_email && (
                        <div className="cp-contact-row">
                          <span className="cp-contact-icon">✉</span>
                          <a href={`mailto:${contacts.agent_org.primary_email}`} className="cp-contact-val cp-email">{contacts.agent_org.primary_email}</a>
                        </div>
                      )}
                      {contacts.agent_org.phone && (
                        <div className="cp-contact-row">
                          <span className="cp-contact-icon">📞</span>
                          <span className="cp-contact-val">{contacts.agent_org.phone}</span>
                        </div>
                      )}
                      {contacts.agent_org.website && (
                        <div className="cp-contact-row">
                          <span className="cp-contact-icon">🌐</span>
                          <a href={contacts.agent_org.website} target="_blank" rel="noopener noreferrer" className="cp-contact-val">{contacts.agent_org.website}</a>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="cp-no-data">
                      <div className="cp-no-data-icon">🏗</div>
                      <div>No husbandry agent data.</div>
                      <div className="cp-no-data-sub">Enrich the vessel to find appointed agent organisations.</div>
                    </div>
                  )}
                </div>
              )}

              {botTab === "master" && (
                <div className="cp-companies">
                  {contacts?.master_contact ? (
                    <div className="cp-card">
                      <div className="cp-card-title" style={{ borderColor:"#26de81" }}>
                        <span>Master / Captain Contact</span>
                      </div>
                      {contacts.master_contact.contact_note && (
                        <div className="cp-master-note">{contacts.master_contact.contact_note}</div>
                      )}
                      {contacts.master_contact.preferred_channel && (
                        <div className="cp-contact-row">
                          <span className="cp-contact-icon">📡</span>
                          <span className="cp-contact-val">Preferred: {contacts.master_contact.preferred_channel}</span>
                        </div>
                      )}
                      {contacts.master_contact.crew_dept && (
                        <>
                          <div className="cp-card-section-label">Crew Department</div>
                          <div className="cp-contact-row">
                            <span className="cp-contact-icon">🏢</span>
                            <span className="cp-contact-val">{contacts.master_contact.crew_dept.company}</span>
                          </div>
                          {contacts.master_contact.crew_dept.email && (
                            <div className="cp-contact-row">
                              <span className="cp-contact-icon">✉</span>
                              <a href={`mailto:${contacts.master_contact.crew_dept.email}`} className="cp-contact-val cp-email">{contacts.master_contact.crew_dept.email}</a>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="cp-no-data">
                      <div className="cp-no-data-icon">👨‍✈️</div>
                      <div>Direct master contact not available.</div>
                      <div className="cp-no-data-sub">Contact via owner, operator or port agent.</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Gemini modal */}
      {geminiOpen && (
        <GeminiContactFinder
          vessel={vessel}
          onClose={() => setGeminiOpen(false)}
          onFound={(data) => {
            if (data?.companies?.length) setIntelligence(data);
            setGeminiOpen(false);
            setTopTab("intel");
          }}
        />
      )}
    </div>
  );
});

export default VesselContactPanel;
