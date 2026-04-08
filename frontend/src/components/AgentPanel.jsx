// AgentPanel.jsx — Agentic AI Workspace v1
// Multi-step AI agents: vessel research, fleet optimization, contact extraction
import React, { useState, useCallback, useRef } from "react";
import { BASE_URL } from "../services/api";
import "./AgentPanel.css";

const API = BASE_URL;

async function callAgent(endpoint, body, signal) {
  const res = await fetch(`${API}/agents/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Step progress indicator ───────────────────────────────────────
function StepProgress({ steps, current, total }) {
  return (
    <div className="ap-step-progress">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className={`ap-step-dot ${i < steps ? "done" : i === steps ? "active" : ""}`}>
          <div className="ap-step-dot-inner" />
          {i < total - 1 && <div className="ap-step-line" />}
        </div>
      ))}
      <span className="ap-step-label">{current}</span>
    </div>
  );
}

// ── Result section ────────────────────────────────────────────────
function ResultSection({ title, icon, data, highlight }) {
  const [open, setOpen] = useState(true);
  if (!data || (Array.isArray(data) && !data.length)) return null;

  return (
    <div className={`ap-result-section${highlight ? " ap-result-section--hi" : ""}`}>
      <button className="ap-result-head" onClick={() => setOpen(o => !o)}>
        <span className="ap-result-icon">{icon}</span>
        <span className="ap-result-title">{title}</span>
        <span className="ap-result-toggle">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="ap-result-body">
          {typeof data === "string" && <p className="ap-result-text">{data}</p>}
          {typeof data === "number" && <p className="ap-result-num">{data}</p>}
          {Array.isArray(data) && (
            <ul className="ap-result-list">
              {data.map((item, i) => (
                <li key={i} className="ap-result-list-item">
                  {typeof item === "object" ? (
                    <div className="ap-result-obj">
                      {Object.entries(item).map(([k, v]) => (
                        <div key={k} className="ap-result-kv">
                          <span className="ap-result-k">{k.replace(/_/g, " ")}</span>
                          <span className="ap-result-v">{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    String(item)
                  )}
                </li>
              ))}
            </ul>
          )}
          {typeof data === "object" && !Array.isArray(data) && (
            <div className="ap-result-obj-block">
              {Object.entries(data).map(([k, v]) => v !== null && v !== undefined && (
                <div key={k} className="ap-result-kv">
                  <span className="ap-result-k">{k.replace(/_/g, " ")}</span>
                  <span className="ap-result-v">
                    {Array.isArray(v) ? v.join(", ") : String(v)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Agent Cards ───────────────────────────────────────────────────
const AGENTS = [
  {
    id: "vessel-research",
    icon: "🔬",
    title: "Vessel Research Agent",
    desc: "3-step deep dive: profile analysis → commercial intelligence → strategic recommendations",
    steps: 3,
    requiresVessel: true,
    color: "#00e5ff",
  },
  {
    id: "fleet-optimize",
    icon: "⚡",
    title: "Fleet Optimizer Agent",
    desc: "Health assessment → optimization opportunities → 30-day action plan for full fleet",
    steps: 3,
    requiresVessel: false,
    color: "#00ff9d",
  },
  {
    id: "contact-extract",
    icon: "🎯",
    title: "Contact Extractor Agent",
    desc: "AI-powered extraction of owner, manager, operator emails from vessel data",
    steps: 1,
    requiresVessel: true,
    color: "#ffaa00",
  },
];

export default function AgentPanel({ vessel, vessels, stats, isOpen, onClose }) {
  const [activeAgent, setActiveAgent]   = useState(null);
  const [running, setRunning]           = useState(false);
  const [stepsDone, setStepsDone]       = useState(0);
  const [currentStep, setCurrentStep]   = useState("");
  const [result, setResult]             = useState(null);
  const [error, setError]               = useState(null);
  const abortRef                        = useRef(null);

  const runAgent = useCallback(async (agentId) => {
    const agent = AGENTS.find(a => a.id === agentId);
    if (!agent) return;
    if (agent.requiresVessel && !vessel) {
      setError("Please select a vessel on the map first.");
      return;
    }
    if (agentId === "fleet-optimize" && (!vessels || vessels.length === 0)) {
      setError("No vessels loaded yet. Please wait for vessel data to load, or check your connection.");
      return;
    }

    setActiveAgent(agentId);
    setRunning(true);
    setStepsDone(0);
    setResult(null);
    setError(null);

    abortRef.current = new AbortController();

    try {
      const STEP_LABELS = {
        "vessel-research": ["Analysing vessel profile…", "Gathering commercial intelligence…", "Generating recommendations…"],
        "fleet-optimize":  ["Assessing fleet health…", "Finding optimizations…", "Building action plan…"],
        "contact-extract": ["Extracting contacts with AI…"],
      };
      const labels = STEP_LABELS[agentId] || ["Running agent…"];

      // Animate step labels during the single fetch
      let stepIdx = 0;
      setCurrentStep(labels[0]);
      const stepTimer = setInterval(() => {
        stepIdx = Math.min(stepIdx + 1, labels.length - 1);
        setStepsDone(stepIdx);
        setCurrentStep(labels[stepIdx]);
      }, 4000);

      let body = {};
      if (agentId === "vessel-research") body = { vessel };
      else if (agentId === "fleet-optimize") body = { vessels: vessels || [], stats: stats || {} };
      else if (agentId === "contact-extract") body = { vessel, raw_data: vessel };

      const data = await callAgent(agentId, body, abortRef.current.signal);
      clearInterval(stepTimer);
      setStepsDone(agent.steps);
      setCurrentStep("Complete");
      setResult(data);
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
    } finally {
      setRunning(false);
    }
  }, [vessel, vessels, stats]);

  const reset = () => {
    abortRef.current?.abort();
    setActiveAgent(null);
    setRunning(false);
    setStepsDone(0);
    setCurrentStep("");
    setResult(null);
    setError(null);
  };

  if (!isOpen) return null;

  return (
    <div className="ap-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ap-panel">
        {/* Header */}
        <div className="ap-head">
          <div className="ap-head-left">
            <span className="ap-head-gem">⬡</span>
            <div>
              <div className="ap-head-title">AGENTIC AI WORKSPACE</div>
              <div className="ap-head-sub">Multi-step AI agents powered by Gemini 2.0</div>
            </div>
          </div>
          <button className="ap-head-close" onClick={onClose}>✕</button>
        </div>

        <div className="ap-body">
          {/* Agent selector */}
          {!activeAgent && (
            <div className="ap-agents">
              <div className="ap-agents-label">SELECT AN AGENT TO RUN</div>
              {vessel && (
                <div className="ap-vessel-ctx">
                  <span className="ap-vessel-ctx-icon">🚢</span>
                  Selected: <strong>{vessel.vessel_name}</strong> — IMO {vessel.imo_number}
                </div>
              )}
              {AGENTS.map(a => (
                <button
                  key={a.id}
                  className="ap-agent-card"
                  style={{ "--ac": a.color }}
                  onClick={() => runAgent(a.id)}
                  disabled={a.requiresVessel && !vessel}
                >
                  <span className="ap-agent-icon">{a.icon}</span>
                  <div className="ap-agent-info">
                    <div className="ap-agent-title">{a.title}</div>
                    <div className="ap-agent-desc">{a.desc}</div>
                    <div className="ap-agent-steps">{a.steps}-step agentic pipeline</div>
                  </div>
                  {a.requiresVessel && !vessel && (
                    <span className="ap-agent-lock">Select vessel first</span>
                  )}
                  <span className="ap-agent-arrow">→</span>
                </button>
              ))}
            </div>
          )}

          {/* Running / result view */}
          {activeAgent && (
            <div className="ap-run-view">
              <div className="ap-run-header">
                <button className="ap-back-btn" onClick={reset} disabled={running}>← Back</button>
                <span className="ap-run-title">{AGENTS.find(a => a.id === activeAgent)?.title}</span>
              </div>

              {running && (
                <div className="ap-running">
                  <StepProgress
                    steps={stepsDone}
                    current={currentStep}
                    total={AGENTS.find(a => a.id === activeAgent)?.steps || 3}
                  />
                  <div className="ap-running-anim">
                    <div className="ap-orb" />
                    <div className="ap-orb ap-orb--2" />
                    <div className="ap-orb ap-orb--3" />
                  </div>
                  <div className="ap-running-label">{currentStep}</div>
                  <button className="ap-cancel-btn" onClick={() => { abortRef.current?.abort(); setRunning(false); }}>Cancel</button>
                </div>
              )}

              {error && (
                <div className="ap-error">
                  <span className="ap-error-icon">⚠</span>
                  <span>{error}</span>
                  <button className="ap-retry-btn" onClick={() => runAgent(activeAgent)}>↺ Retry</button>
                </div>
              )}

              {result && !running && (
                <div className="ap-results">
                  <div className="ap-results-badge">
                    <span className="ap-results-check">✓</span>
                    Agent complete — {result.steps?.length || 1} steps executed
                    {result.providers_used && (
                      <span className="ap-providers"> via {result.providers_used.join(" + ")}</span>
                    )}
                  </div>

                  {/* Vessel Research results */}
                  {activeAgent === "vessel-research" && result.steps && (
                    <>
                      {result.steps[0]?.result && (
                        <>
                          <ResultSection title="Profile Summary" icon="📋" data={result.steps[0].result.profile_summary} />
                          <ResultSection title="Operational Risk" icon="⚠" data={result.steps[0].result.operational_risk} highlight />
                          <ResultSection title="Risk Factors" icon="🔴" data={result.steps[0].result.risk_factors} />
                        </>
                      )}
                      {result.steps[1]?.result && (
                        <>
                          <ResultSection title="Market Segment" icon="📈" data={result.steps[1].result.market_segment} />
                          <ResultSection title="Outreach Opportunity" icon="💡" data={result.steps[1].result.outreach_opportunity} highlight />
                        </>
                      )}
                      {result.steps[2]?.result && (
                        <>
                          <ResultSection title="Priority Actions" icon="🎯" data={result.steps[2].result.priority_actions} highlight />
                          <ResultSection title="Email Strategy" icon="✉" data={result.steps[2].result.email_strategy} />
                          <ResultSection title="Value Proposition" icon="💰" data={result.steps[2].result.value_proposition} />
                        </>
                      )}
                    </>
                  )}

                  {/* Fleet Optimizer results */}
                  {activeAgent === "fleet-optimize" && (
                    <>
                      <ResultSection title="Fleet Health Score" icon="🏥" data={result.health?.health_score} highlight />
                      <ResultSection title="Top Concerns" icon="⚠" data={result.health?.top_concerns} />
                      <ResultSection title="Fuel Savings Potential" icon="⛽" data={result.optimizations?.fuel_savings_potential_percent ? `${result.optimizations.fuel_savings_potential_percent}%` : null} highlight />
                      <ResultSection title="Route Optimizations" icon="🗺" data={result.optimizations?.route_optimizations} />
                      <ResultSection title="Week 1 Actions" icon="📅" data={result.action_plan?.week1_actions} highlight />
                      <ResultSection title="KPIs to Track" icon="📊" data={result.action_plan?.kpis_to_track} />
                      <ResultSection title="Expected ROI" icon="💰" data={result.action_plan?.expected_roi} highlight />
                    </>
                  )}

                  {/* Contact Extractor results */}
                  {activeAgent === "contact-extract" && result.contacts?.length > 0 && (
                    <div className="ap-contacts">
                      <div className="ap-contacts-label">EXTRACTED CONTACTS ({result.contacts.length})</div>
                      {result.contacts.map((c, i) => (
                        <div key={i} className="ap-contact-row">
                          <div className="ap-contact-role">{c.role}</div>
                          <div className="ap-contact-company">{c.company_name}</div>
                          {c.email && (
                            <div className="ap-contact-email">
                              <a href={`mailto:${c.email}`}>{c.email}</a>
                            </div>
                          )}
                          {c.phone && <div className="ap-contact-phone">📞 {c.phone}</div>}
                          {c.confidence && (
                            <div
                              className="ap-contact-conf"
                              style={{ color: c.confidence >= 75 ? "#00ff9d" : c.confidence >= 50 ? "#ffaa00" : "#ff5577" }}
                            >
                              {c.confidence}% confidence
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <button className="ap-run-again-btn" onClick={() => runAgent(activeAgent)}>
                    ↺ Run Again
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
