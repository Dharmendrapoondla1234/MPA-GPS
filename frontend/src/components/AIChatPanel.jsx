// src/components/AIChatPanel.jsx — Maritime AI Brain v1
// Full-featured LLM chat panel: Gemini + Claude, vessel context, maritime tools
import React, { useState, useRef, useEffect, useCallback } from "react";
import { BASE_URL } from "../services/api";
import "./AIChatPanel.css";

const QUICK_PROMPTS = [
  { label: "⛽ Fuel Analysis", text: "Analyze the fuel efficiency of the selected vessel and suggest optimizations." },
  { label: "📧 Draft Email", text: "Draft a professional email to the vessel operator requesting an ETA update." },
  { label: "⚓ Port Status", text: "What is the current congestion situation at the Port of Singapore?" },
  { label: "🌊 Weather Risk", text: "What weather risks should I be aware of for vessels in the Strait of Malacca?" },
  { label: "📋 Report Summary", text: "Summarize the voyage performance for the fleet this week." },
  { label: "🔍 Contact Help", text: "How do I find the shipping agent for a vessel arriving at Port Klang?" },
];

export default function AIChatPanel({ selectedVessel, vessels, stats, isOpen }) {
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content: `Welcome to **Maritime AI** — powered by Google Gemini 2.0 Flash.\n\nI can help you with:\n• Vessel intelligence & contact enrichment\n• Fuel optimization & route analysis\n• Cargo report summarization\n• Email drafting for maritime CRM\n• Port agent coordination\n• Contract & invoice analysis\n• Fleet performance insights\n\nSelect a vessel on the map, then ask me anything about it!`,
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("chat"); // chat | tools | email
  const [emailForm, setEmailForm] = useState({ purpose: "", details: "", tone: "professional" });
  const [emailResult, setEmailResult] = useState(null);
  const [docText, setDocText] = useState("");
  const [docType, setDocType] = useState("cargo_report");
  const [docResult, setDocResult] = useState(null);
  const [provider, setProvider] = useState("gemini");
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async (text) => {
    const msg = (text || input).trim();
    if (!msg || loading) return;
    setInput("");
    setLoading(true);

    const userMsg = { role: "user", content: msg, timestamp: new Date() };
    setMessages(prev => [...prev, userMsg]);

    const history = messages.slice(-8).map(m => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch(`${BASE_URL}/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          history,
          vesselData: selectedVessel || null,
          fleetStats: stats ? `${stats.total || 0} vessels tracked, ${stats.active || 0} underway` : null,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Backend now returns success:false with reply for graceful degradation
      const reply   = data.reply || "I couldn't generate a response. Please try again.";
      const prov    = data.provider || "gemini";
      setProvider(prov);
      setMessages(prev => [...prev, {
        role: "assistant",
        content: reply,
        timestamp: new Date(),
        provider: prov,
      }]);
    } catch (err) {
      // Network error — show a helpful message
      setMessages(prev => [...prev, {
        role: "assistant",
        content: `⚠ Could not reach the AI backend: ${err.message}\n\nPlease check that your Render backend is running and GEMINI_API_KEY is configured.`,
        timestamp: new Date(),
        provider: "offline",
      }]);
    }
    setLoading(false);
  }, [input, loading, messages, selectedVessel, stats]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const draftEmail = async () => {
    if (!emailForm.purpose) return;
    setLoading(true);
    setEmailResult(null);
    try {
      const res = await fetch(`${BASE_URL}/ai/draft-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...emailForm,
          vesselName: selectedVessel?.vessel_name,
          imoNumber: selectedVessel?.imo_number,
        }),
        signal: AbortSignal.timeout(25000),
      });
      const data = await res.json();
      setEmailResult(data.email || { subject: "Draft Email", body: data.raw });
    } catch { setEmailResult({ subject: "Error", body: "Failed to draft email. Check AI configuration." }); }
    setLoading(false);
  };

  const summarizeDoc = async () => {
    if (!docText.trim()) return;
    setLoading(true);
    setDocResult(null);
    try {
      const res = await fetch(`${BASE_URL}/ai/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: docText, type: docType }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      setDocResult(data);
    } catch { setDocResult({ raw: "Summarization failed. Ensure GEMINI_API_KEY is configured in Render." }); }
    setLoading(false);
  };

  return (
    <div className={`ai-panel ${isOpen ? "open" : ""}`}>
      {/* Header */}
      <div className="ai-panel-header">
        <div className="ai-panel-title">
          <span className="ai-pulse-dot" />
          <span>MARITIME AI</span>
          <span className="ai-provider-badge">{provider === "offline" ? "OFFLINE" : "GEMINI"}</span>
        </div>
        <div className="ai-tab-row">
          {["chat", "email", "docs"].map(t => (
            <button key={t} className={`ai-tab ${activeTab === t ? "active" : ""}`} onClick={() => setActiveTab(t)}>
              {t === "chat" ? "💬 Chat" : t === "email" ? "📧 Email" : "📋 Docs"}
            </button>
          ))}
        </div>
      </div>

      {/* CHAT TAB */}
      {activeTab === "chat" && (
        <>
          {selectedVessel && (
            <div className="ai-vessel-context">
              <span className="ai-ctx-label">CONTEXT:</span>
              <span className="ai-ctx-vessel">{selectedVessel.vessel_name}</span>
              <span className="ai-ctx-type">{selectedVessel.vessel_type}</span>
              <span className="ai-ctx-speed">{(selectedVessel.speed || 0).toFixed(1)}kn</span>
            </div>
          )}

          <div className="ai-quick-prompts">
            {QUICK_PROMPTS.map((p, i) => (
              <button key={i} className="ai-quick-btn" onClick={() => sendMessage(p.text)}>{p.label}</button>
            ))}
          </div>

          <div className="ai-messages">
            {messages.map((msg, i) => (
              <div key={i} className={`ai-msg ai-msg-${msg.role}`}>
                {msg.role === "assistant" && (
                  <div className="ai-msg-label">
                    ✦ MARITIME AI
                    {msg.provider && msg.provider !== "gemini" && (
                      <span className="ai-msg-provider">via {msg.provider}</span>
                    )}
                  </div>
                )}
                <div className="ai-msg-body" dangerouslySetInnerHTML={{ __html: formatMessage(msg.content) }} />
                <div className="ai-msg-time">{formatTime(msg.timestamp)}</div>
              </div>
            ))}
            {loading && (
              <div className="ai-msg ai-msg-assistant">
                <div className="ai-msg-label">✦ MARITIME AI</div>
                <div className="ai-typing"><span/><span/><span/></div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="ai-input-row">
            <textarea
              ref={inputRef}
              className="ai-input-field"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about vessels, routes, ports, contacts..."
              rows={2}
              disabled={loading}
            />
            <button className="ai-send-btn" onClick={() => sendMessage()} disabled={loading || !input.trim()}>
              {loading ? "..." : "▶"}
            </button>
          </div>
        </>
      )}

      {/* EMAIL TAB */}
      {activeTab === "email" && (
        <div className="ai-tools-panel">
          <div className="ai-tool-section">
            <div className="ai-section-title">✉ AI EMAIL DRAFTER</div>
            <div className="ai-section-desc">Generate professional maritime emails using AI</div>

            {selectedVessel && (
              <div className="ai-auto-context">
                Auto-filled: <strong>{selectedVessel.vessel_name}</strong> (IMO {selectedVessel.imo_number})
              </div>
            )}

            <label className="ai-form-label">Purpose / Subject</label>
            <input
              className="ai-form-input"
              value={emailForm.purpose}
              onChange={e => setEmailForm(p => ({ ...p, purpose: e.target.value }))}
              placeholder="e.g. Request ETA update for Port Klang arrival"
            />

            <label className="ai-form-label">Additional Details</label>
            <textarea
              className="ai-form-textarea"
              value={emailForm.details}
              onChange={e => setEmailForm(p => ({ ...p, details: e.target.value }))}
              placeholder="Cargo details, special instructions, urgency..."
              rows={3}
            />

            <label className="ai-form-label">Tone</label>
            <select className="ai-form-select" value={emailForm.tone} onChange={e => setEmailForm(p => ({ ...p, tone: e.target.value }))}>
              <option value="professional">Professional (formal)</option>
              <option value="friendly">Friendly (warm)</option>
              <option value="urgent">Urgent (direct)</option>
            </select>

            <button className="ai-action-btn" onClick={draftEmail} disabled={loading || !emailForm.purpose}>
              {loading ? "⟳ Drafting..." : "✦ DRAFT WITH AI"}
            </button>

            {emailResult && (
              <div className="ai-email-result">
                <div className="ai-email-subject">
                  <span className="ai-label-sm">SUBJECT:</span>
                  <span>{emailResult.subject}</span>
                </div>
                <div className="ai-email-body">{emailResult.body}</div>
                <button className="ai-copy-btn" onClick={() => navigator.clipboard?.writeText(`Subject: ${emailResult.subject}\n\n${emailResult.body}`)}>
                  📋 Copy to Clipboard
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* DOCS TAB */}
      {activeTab === "docs" && (
        <div className="ai-tools-panel">
          <div className="ai-tool-section">
            <div className="ai-section-title">📋 DOCUMENT ANALYZER</div>
            <div className="ai-section-desc">AI-powered cargo reports, contracts, invoices</div>

            <label className="ai-form-label">Document Type</label>
            <select className="ai-form-select" value={docType} onChange={e => setDocType(e.target.value)}>
              <option value="cargo_report">Cargo Report</option>
              <option value="voyage_log">Voyage Log</option>
              <option value="contract">Charter Contract</option>
              <option value="invoice">Invoice / Disbursement</option>
              <option value="bol">Bill of Lading</option>
            </select>

            <label className="ai-form-label">Paste Document Text</label>
            <textarea
              className="ai-form-textarea"
              value={docText}
              onChange={e => setDocText(e.target.value)}
              placeholder="Paste your cargo report, voyage log, contract, or any maritime document here..."
              rows={6}
            />

            <button className="ai-action-btn" onClick={summarizeDoc} disabled={loading || !docText.trim()}>
              {loading ? "⟳ Analyzing..." : "✦ ANALYZE WITH AI"}
            </button>

            {docResult && (
              <div className="ai-doc-result">
                {docResult.parsed ? (
                  <>
                    {docResult.parsed.summary && (
                      <div className="ai-doc-section">
                        <div className="ai-label-sm">SUMMARY</div>
                        <div className="ai-doc-text">{docResult.parsed.summary}</div>
                      </div>
                    )}
                    {docResult.parsed.risk_flags?.length > 0 && (
                      <div className="ai-doc-section">
                        <div className="ai-label-sm" style={{ color: "var(--red)" }}>⚠ RISK FLAGS</div>
                        {docResult.parsed.risk_flags.map((f, i) => (
                          <div key={i} className="ai-flag-item">• {f}</div>
                        ))}
                      </div>
                    )}
                    {docResult.parsed.action_items?.length > 0 && (
                      <div className="ai-doc-section">
                        <div className="ai-label-sm" style={{ color: "var(--green)" }}>✓ ACTION ITEMS</div>
                        {docResult.parsed.action_items.map((a, i) => (
                          <div key={i} className="ai-action-item">→ {a}</div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="ai-doc-raw">{docResult.raw}</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatMessage(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br>")
    .replace(/•/g, "•");
}

function formatTime(ts) {
  if (!ts) return "";
  try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}


