// CRMPanel.jsx — Maritime CRM Intelligence v1
// Full-screen overlay: contacts sidebar + persona builder + AI email composer
// Triggered via ✉ CRM button in VesselDetailPanel header
// Uses existing backend endpoints: /api/ai/draft-email + /api/gemini/enrich
import React, {
  useState, useEffect, useCallback, useRef, useMemo,
} from "react";
import {
  fetchVesselContacts, fetchVesselIntelligence, aiDraftEmail,
} from "../services/api";
import "./CRMPanel.css";

// ── Tiny persistence layer ────────────────────────────────────────
const LS = {
  get: (k, def) => {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }
    catch { return def; }
  },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

// ── DB hook (localStorage-backed) ────────────────────────────────
function useDB() {
  const [senderProfiles, setSP_] = useState(() => LS.get("crm_senders", []));
  const [clientPersonas, setCP_] = useState(() => LS.get("crm_personas", []));
  const [drafts, setDrafts_]     = useState(() => LS.get("crm_drafts",   []));

  const persist = (key, setter) => (updater) =>
    setter(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      LS.set(key, next);
      return next;
    });

  const setSP     = persist("crm_senders",  setSP_);
  const setCP     = persist("crm_personas", setCP_);
  const setDrafts = persist("crm_drafts",   setDrafts_);

  const upsertSender  = (s) => setSP(prev  => { const i = prev.findIndex(x => x.id === s.id); if (i >= 0) { const n = [...prev]; n[i] = s; return n; } return [...prev, s]; });
  const deleteSender  = (id) => setSP(prev  => prev.filter(x => x.id !== id));
  const upsertPersona = (p) => setCP(prev  => { const i = prev.findIndex(x => x.id === p.id); if (i >= 0) { const n = [...prev]; n[i] = p; return n; } return [...prev, p]; });
  const deletePersona = (id) => setCP(prev  => prev.filter(x => x.id !== id));
  const saveDraft     = (d) => setDrafts(prev => { const i = prev.findIndex(x => x.id === d.id); if (i >= 0) { const n = [...prev]; n[i] = d; return n; } return [...prev, d]; });
  const deleteDraft   = (id) => setDrafts(prev => prev.filter(x => x.id !== id));

  return {
    senderProfiles, upsertSender, deleteSender,
    clientPersonas, upsertPersona, deletePersona,
    drafts, saveDraft, deleteDraft,
  };
}

// ── Copy button ───────────────────────────────────────────────────
function CopyBtn({ value, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const go = () => {
    navigator.clipboard.writeText(value)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  };
  return (
    <button className="crm-copy-btn" onClick={go} title={label}>
      {copied ? "✓" : "⎘"}
    </button>
  );
}

// ── Contact card in sidebar ───────────────────────────────────────
function ContactCard({ contact, selected, onSelect }) {
  return (
    <div
      className={`crm-contact-card${selected ? " crm-contact-card--sel" : ""}`}
      onClick={() => onSelect(contact)}
    >
      <div className="crm-cc-role">{contact.role}</div>
      <div className="crm-cc-name">{contact.company_name || contact.name || "—"}</div>
      {contact.email && (
        <div className="crm-cc-email">
          <span className="crm-cc-email-text">{contact.email}</span>
          <CopyBtn value={contact.email} />
        </div>
      )}
      {contact.phone && <div className="crm-cc-phone">📞 {contact.phone}</div>}
      {contact.website && <div className="crm-cc-web truncate">🌐 {contact.website}</div>}
      {contact.confidence != null && (
        <div
          className="crm-cc-conf"
          style={{ color: contact.confidence >= 75 ? "#00ff9d" : contact.confidence >= 50 ? "#ffaa00" : "#ff5577" }}
        >
          {contact.confidence}% confidence
        </div>
      )}
    </div>
  );
}

// ── Sender / Persona modal ────────────────────────────────────────
function ProfileModal({ title, profile, onSave, onClose }) {
  const blank = { id: uid(), name: "", company: "", role: "", email: "", tone: "professional", notes: "", website: "" };
  const [form, setForm] = useState(profile || blank);
  const [extracting, setExtracting] = useState(false);

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const TONES = ["professional", "consultative", "direct", "friendly", "technical", "executive"];

  const handleExtract = async () => {
    if (!form.website) return;
    setExtracting(true);
    try {
      const API = process.env.REACT_APP_API_URL || "https://vessel-backend.onrender.com/api";
      const res = await fetch(`${API}/gemini/crm-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "persona_extract", url: form.website, label: form.name }),
      });
      if (res.ok) {
        const j = await res.json();
        const desc = j.persona || j.text || j.description;
        if (desc) setForm(f => ({ ...f, notes: desc }));
      }
    } catch { /* silently fail */ }
    finally { setExtracting(false); }
  };

  return (
    <div className="crm-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="crm-modal">
        <div className="crm-modal-head">
          <span>{title}</span>
          <button className="crm-modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="crm-modal-body">
          <label className="crm-lbl">Full Name / Label</label>
          <input className="crm-inp" value={form.name} onChange={set("name")} placeholder="e.g. Jane Smith" />

          <label className="crm-lbl">Company</label>
          <input className="crm-inp" value={form.company} onChange={set("company")} placeholder="e.g. Acme Shipping" />

          <label className="crm-lbl">Role / Title</label>
          <input className="crm-inp" value={form.role} onChange={set("role")} placeholder="e.g. Sales Director" />

          <label className="crm-lbl">Email</label>
          <input className="crm-inp" type="email" value={form.email} onChange={set("email")} placeholder="name@company.com" />

          <label className="crm-lbl">Communication Tone</label>
          <div className="crm-tone-grid">
            {TONES.map(t => (
              <button
                key={t}
                className={`crm-tone-btn${form.tone === t ? " on" : ""}`}
                onClick={() => setForm(f => ({ ...f, tone: t }))}
              >
                {t}
              </button>
            ))}
          </div>

          <label className="crm-lbl">Website (AI persona extraction)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="crm-inp" style={{ flex: 1 }} value={form.website} onChange={set("website")} placeholder="https://company.com" />
            <button
              className="crm-btn crm-btn-ai"
              onClick={handleExtract}
              disabled={extracting || !form.website}
              style={{ whiteSpace: "nowrap" }}
            >
              {extracting ? "⏳" : "✨ Extract"}
            </button>
          </div>

          <label className="crm-lbl">Notes / Persona Description</label>
          <textarea
            className="crm-inp crm-textarea"
            rows={4}
            value={form.notes}
            onChange={set("notes")}
            placeholder="Pain points, priorities, industry context, communication style…"
          />

          <div className="crm-modal-actions">
            <button className="crm-btn crm-btn-ghost" onClick={onClose}>Cancel</button>
            <button
              className="crm-btn crm-btn-primary"
              onClick={() => { if (form.name.trim()) onSave(form); }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Draft card ────────────────────────────────────────────────────
function DraftCard({ draft, onEdit, onDelete, onRegenerate, personas }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied]     = useState(false);
  const persona = personas.find(p => p.id === draft.personaId);

  const copy = async () => {
    const text = `Subject: ${draft.subject}\n\n${draft.body}`;
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { }
  };

  const send = () => {
    const u = `mailto:${draft.toEmail || ""}?subject=${encodeURIComponent(draft.subject || "")}&body=${encodeURIComponent(draft.body || "")}`;
    window.open(u, "_blank");
  };

  return (
    <div className="crm-draft-card">
      <div className="crm-draft-meta">
        <span className="crm-draft-to">→ {draft.toCompany || "Unknown"}</span>
        {persona && <span className="crm-persona-tag">{persona.name}</span>}
        <span className="crm-draft-date">{new Date(draft.createdAt).toLocaleDateString()}</span>
      </div>
      <div className="crm-draft-subject">{draft.subject || "(no subject)"}</div>
      <div
        className={`crm-draft-body-preview${expanded ? " expanded" : ""}`}
        onClick={() => setExpanded(e => !e)}
      >
        {expanded ? draft.body : (draft.body || "").slice(0, 140) + ((draft.body || "").length > 140 ? "…" : "")}
        <button className="crm-expand-btn">{expanded ? "▲" : "▼"}</button>
      </div>
      <div className="crm-draft-actions">
        <button className="crm-da" onClick={copy}>{copied ? "✓ Copied" : "⎘ Copy"}</button>
        <button className="crm-da" onClick={() => onEdit(draft)}>✏ Edit</button>
        <button className="crm-da crm-da-regen" onClick={() => onRegenerate(draft)}>↺ Regen</button>
        {draft.toEmail && <button className="crm-da crm-da-send" onClick={send}>✉ Send</button>}
        <button className="crm-da crm-da-del" onClick={() => onDelete(draft.id)}>🗑</button>
      </div>
    </div>
  );
}

// ── Inline draft editor ───────────────────────────────────────────
function DraftEditor({ draft, onSave, onCancel }) {
  const [subject, setSubject] = useState(draft.subject || "");
  const [body, setBody]       = useState(draft.body || "");
  return (
    <div className="crm-draft-editor">
      <div className="crm-de-head">✏ Editing Draft</div>
      <input
        className="crm-inp crm-de-subject"
        value={subject}
        onChange={e => setSubject(e.target.value)}
        placeholder="Subject line…"
      />
      <textarea
        className="crm-inp crm-de-body"
        rows={14}
        value={body}
        onChange={e => setBody(e.target.value)}
      />
      <div className="crm-de-actions">
        <button className="crm-btn crm-btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="crm-btn crm-btn-primary" onClick={() => onSave({ ...draft, subject, body })}>Save</button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═════════════════════════════════════════════════════════════════
export default function CRMPanel({ vessel, onClose }) {
  const db = useDB();

  // ── Contact loading state ──────────────────────────────────────
  const [rawContacts,    setRawContacts]    = useState([]);
  const [contactsLoad,   setContactsLoad]   = useState(false);
  const [contactsErr,    setContactsErr]    = useState(null);
  const [selectedContact, setSelectedContact] = useState(null);
  const [intelContacts,  setIntelContacts]  = useState([]); // enriched from pipeline

  // ── UI state ──────────────────────────────────────────────────
  const [activeTab,     setActiveTab]     = useState("compose"); // compose | personas | drafts
  const [senderModal,   setSenderModal]   = useState(null);
  const [personaModal,  setPersonaModal]  = useState(null);
  const [activeSender,  setActiveSender]  = useState(null);
  const [activePersona, setActivePersona] = useState(null);
  const [context,       setContext]       = useState("");
  const [generating,    setGenerating]    = useState(false);
  const [genError,      setGenError]      = useState(null);
  const [editingDraft,  setEditingDraft]  = useState(null);
  const [refineText,    setRefineText]    = useState("");
  const [refining,      setRefining]      = useState(false);

  // ── Sync active sender on first load ──────────────────────────
  useEffect(() => {
    if (!activeSender && db.senderProfiles.length > 0)
      setActiveSender(db.senderProfiles[0]);
  }, [db.senderProfiles]); // eslint-disable-line

  // ── Load vessel contacts from backend ─────────────────────────
  useEffect(() => {
    if (!vessel?.imo_number) return;
    setRawContacts([]);
    setIntelContacts([]);
    setSelectedContact(null);
    setContactsErr(null);
    setContactsLoad(true);

    const imo  = vessel.imo_number;
    const mmsi = vessel.mmsi_number || null;
    const name = vessel.vessel_name || null;

    fetchVesselContacts(imo, { mmsi, name })
      .then(raw => {
        if (!raw) { setContactsErr("No contact data available."); return; }

        // Normalise into a flat list
        const list = [];
        const roles = [
          ["owner",        "Owner"],
          ["operator",     "Operator"],
          ["manager",      "Manager"],
          ["ship_manager", "Ship Manager"],
        ];
        roles.forEach(([key, label]) => {
          const c = raw[key];
          if (!c) return;
          const name_  = c.company_name || c.name || "";
          if (!name_) return;
          list.push({
            id:           uid(),
            role:         label,
            company_name: name_,
            email:        c.email || c.primary_email || c.contact_email || "",
            phone:        c.phone || c.phone_primary || "",
            website:      c.website || "",
            address:      c.registered_address || c.address || "",
            confidence:   c.confidence ?? null,
            data_source:  c.data_source || "",
          });
        });

        // top_contacts from enrichment pipeline
        (raw.top_contacts || []).forEach(tc => {
          if (tc.email && !list.find(x => x.email === tc.email)) {
            list.push({
              id: uid(),
              role: tc.role || "Contact",
              company_name: tc.company || tc.name || "",
              email: tc.email,
              phone: "",
              website: "",
              confidence: tc.confidence ?? null,
            });
          }
        });

        setRawContacts(list);
        if (list.length > 0) setSelectedContact(list[0]);

        // Kick off intelligence pipeline for richer emails
        const ownerName   = raw.owner?.company_name   || raw.owner?.name   || null;
        const managerName = raw.manager?.company_name || raw.manager?.name || null;
        if (ownerName || managerName) {
          fetchVesselIntelligence(imo, {
            owner: ownerName, manager: managerName,
            operator: raw.operator?.company_name || null,
          })
            .then(intel => {
              if (!intel?.top_contacts?.length) return;
              const enriched = intel.top_contacts
                .filter(tc => tc.email)
                .map(tc => ({
                  id:           uid(),
                  role:         tc.role || "Verified Contact",
                  company_name: tc.company || "",
                  email:        tc.email,
                  phone:        "",
                  website:      "",
                  confidence:   tc.confidence ?? null,
                  data_source:  tc.source || "pipeline",
                }));
              setIntelContacts(enriched);
            })
            .catch(() => {});
        }
      })
      .catch(err => setContactsErr(err.message || "Failed to load contacts"))
      .finally(() => setContactsLoad(false));
  }, [vessel?.imo_number]); // eslint-disable-line

  // All contacts = Equasis contacts + pipeline-verified contacts
  const allContacts = useMemo(() => {
    const seen = new Set();
    return [...rawContacts, ...intelContacts].filter(c => {
      const key = `${c.company_name}:${c.role}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [rawContacts, intelContacts]);

  // Drafts scoped to current vessel
  const vesselDrafts = useMemo(
    () => db.drafts.filter(d => !vessel || d.vesselImo === String(vessel?.imo_number)),
    [db.drafts, vessel]
  );

  // ── Generate email via /api/ai/draft-email ─────────────────────
  const handleGenerate = useCallback(async () => {
    if (!activeSender || !selectedContact) return;
    setGenerating(true);
    setGenError(null);
    try {
      const persona = activePersona;

      // Build a rich details string that carries persona + vessel context
      const details = [
        persona ? `PERSONA: ${persona.name} (${persona.tone} tone) — ${persona.notes || ""}` : "",
        `SENDER: ${activeSender.name}${activeSender.role ? `, ${activeSender.role}` : ""}${activeSender.company ? ` at ${activeSender.company}` : ""}`,
        `RECIPIENT: ${selectedContact.company_name}${selectedContact.role ? ` (${selectedContact.role})` : ""}`,
        selectedContact.address ? `Address: ${selectedContact.address}` : "",
        context ? `CONTEXT: ${context}` : "",
      ].filter(Boolean).join("\n");

      const result = await aiDraftEmail({
        purpose: `Personalised maritime outreach from ${activeSender.name || activeSender.company} to ${selectedContact.company_name}`,
        vesselName: vessel?.vessel_name || "",
        imoNumber:  vessel?.imo_number  || "",
        companyName: selectedContact.company_name,
        portName: vessel?.next_port_destination || vessel?.location_to || "",
        details,
        tone: persona?.tone || activeSender.tone || "professional",
      });

      const subject = result?.email?.subject || result?.subject || `Follow-up from ${activeSender.company || activeSender.name}`;
      const body    = result?.email?.body    || result?.body    || result?.raw || "Draft generation failed.";

      db.saveDraft({
        id:         uid(),
        vesselImo:  String(vessel?.imo_number || ""),
        vesselName: vessel?.vessel_name || "",
        toCompany:  selectedContact.company_name,
        toRole:     selectedContact.role,
        toEmail:    selectedContact.email || "",
        fromId:     activeSender.id,
        personaId:  persona?.id || null,
        subject, body,
        createdAt:  Date.now(),
      });

      setActiveTab("drafts");
    } catch (err) {
      setGenError(err.message || "Generation failed");
    } finally {
      setGenerating(false);
    }
  }, [activeSender, selectedContact, activePersona, context, vessel, db]);

  // ── Regenerate draft ───────────────────────────────────────────
  const handleRegenerate = useCallback(async (draft) => {
    setGenerating(true);
    setGenError(null);
    try {
      const persona = db.clientPersonas.find(p => p.id === draft.personaId);
      const sender  = db.senderProfiles.find(s => s.id === draft.fromId) || activeSender;

      const result = await aiDraftEmail({
        purpose: `Rewrite and improve this email with fresh phrasing: ORIGINAL SUBJECT: ${draft.subject}`,
        vesselName:  vessel?.vessel_name || "",
        imoNumber:   vessel?.imo_number  || "",
        companyName: draft.toCompany,
        details: [
          persona ? `PERSONA: ${persona.name} (${persona.tone})` : "",
          sender  ? `SENDER: ${sender.name} at ${sender.company}` : "",
          "Write a completely fresh angle — different hook, different structure.",
        ].filter(Boolean).join("\n"),
        tone: persona?.tone || "professional",
      });

      const subject = result?.email?.subject || result?.subject || draft.subject;
      const body    = result?.email?.body    || result?.body    || result?.raw || draft.body;

      db.saveDraft({ ...draft, id: uid(), subject, body, createdAt: Date.now() });
    } catch (err) {
      setGenError(err.message);
    } finally {
      setGenerating(false);
    }
  }, [db, vessel, activeSender]);

  // ── AI Refine ──────────────────────────────────────────────────
  const handleRefine = useCallback(async (draft) => {
    if (!refineText.trim()) return;
    setRefining(true);
    try {
      const result = await aiDraftEmail({
        purpose: `Refine this existing email according to instruction: "${refineText}". CURRENT SUBJECT: ${draft.subject}. CURRENT BODY: ${draft.body}`,
        vesselName:  vessel?.vessel_name || "",
        imoNumber:   vessel?.imo_number  || "",
        companyName: draft.toCompany,
        details: "Preserve the overall intent. Only modify what the instruction asks.",
        tone: "professional",
      });
      const subject = result?.email?.subject || result?.subject || draft.subject;
      const body    = result?.email?.body    || result?.body    || result?.raw || draft.body;
      db.saveDraft({ ...draft, subject, body });
      setRefineText("");
    } catch (err) {
      setGenError(err.message);
    } finally {
      setRefining(false);
    }
  }, [refineText, vessel, db]);

  // ═════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════
  return (
    <div className="crm-root">

      {/* ── TOP BAR ── */}
      <div className="crm-topbar">
        <div className="crm-topbar-left">
          <span className="crm-topbar-gem">✦</span>
          <span className="crm-topbar-title">CRM INTELLIGENCE</span>
          {vessel && (
            <span className="crm-topbar-vessel">
              {vessel.vessel_name}
              <span className="crm-topbar-imo">IMO {vessel.imo_number}</span>
            </span>
          )}
        </div>

        <div className="crm-topbar-tabs">
          {[
            { id: "compose",  label: "✉ Compose"  },
            { id: "personas", label: "👤 Personas" },
            { id: "drafts",   label: `📋 Drafts${vesselDrafts.length ? ` (${vesselDrafts.length})` : ""}` },
          ].map(t => (
            <button
              key={t.id}
              className={`crm-topbar-tab${activeTab === t.id ? " active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <button className="crm-close-btn" onClick={onClose}>✕ Close CRM</button>
      </div>

      {/* ── BODY ── */}
      <div className="crm-body">

        {/* ════ LEFT SIDEBAR — vessel contacts ════ */}
        <aside className="crm-sidebar">
          <div className="crm-sidebar-head">
            <span className="crm-sidebar-label">VESSEL CONTACTS</span>
            {vessel && (
              <button
                className="crm-sidebar-refresh"
                title="Refresh"
                onClick={() => {
                  setRawContacts([]);
                  setContactsLoad(true);
                  fetchVesselContacts(vessel.imo_number, { bustCache: true })
                    .then(raw => {
                      if (!raw) return;
                      const list = [];
                      [["owner","Owner"],["operator","Operator"],["manager","Manager"],["ship_manager","Ship Manager"]].forEach(([k,l]) => {
                        const c = raw[k]; if (!c || !(c.company_name || c.name)) return;
                        list.push({ id:uid(), role:l, company_name:c.company_name||c.name, email:c.email||c.primary_email||"", phone:c.phone||"", website:c.website||"", confidence:c.confidence??null });
                      });
                      setRawContacts(list);
                      if (list.length && !selectedContact) setSelectedContact(list[0]);
                    })
                    .catch(err => setContactsErr(err.message))
                    .finally(() => setContactsLoad(false));
                }}
              >↻</button>
            )}
          </div>

          <div className="crm-sidebar-scroll">
            {!vessel && (
              <div className="crm-sidebar-empty">
                <span className="crm-empty-icon">⚓</span>
                <span>Select a vessel to load contacts</span>
              </div>
            )}

            {vessel && contactsLoad && (
              <div className="crm-sidebar-loading">
                <span className="crm-spin" />
                <span>Loading Equasis data…</span>
              </div>
            )}

            {contactsErr && !contactsLoad && (
              <div className="crm-sidebar-err">⚠ {contactsErr}</div>
            )}

            {allContacts.length === 0 && !contactsLoad && vessel && !contactsErr && (
              <div className="crm-sidebar-empty">
                <span className="crm-empty-icon">📋</span>
                <span>No contacts found</span>
              </div>
            )}

            {allContacts.map(c => (
              <ContactCard
                key={c.id}
                contact={c}
                selected={selectedContact?.id === c.id}
                onSelect={setSelectedContact}
              />
            ))}
          </div>
        </aside>

        {/* ════ MAIN CONTENT ════ */}
        <main className="crm-main">

          {/* ─── COMPOSE TAB ─── */}
          {activeTab === "compose" && (
            <div className="crm-compose">
              <div className="crm-compose-heading">
                <div className="crm-compose-title">NEW EMAIL DRAFT</div>
                <div className="crm-compose-sub">AI-powered personalised outreach using vessel &amp; Equasis data</div>
              </div>

              {/* FROM */}
              <section className="crm-section">
                <div className="crm-section-head">
                  <span>FROM — SENDER PROFILE</span>
                  <button className="crm-add-btn" onClick={() => setSenderModal("new")}>＋ Add</button>
                </div>
                {db.senderProfiles.length === 0 ? (
                  <div className="crm-hint-card" onClick={() => setSenderModal("new")}>
                    <span className="crm-hint-icon">＋</span>
                    <span>Create your sender profile to get started</span>
                  </div>
                ) : (
                  <div className="crm-chip-row">
                    {db.senderProfiles.map(s => (
                      <button
                        key={s.id}
                        className={`crm-sender-chip${activeSender?.id === s.id ? " active" : ""}`}
                        onClick={() => setActiveSender(s)}
                      >
                        <span className="crm-chip-name">{s.name}</span>
                        <span className="crm-chip-co">{s.company}</span>
                        <span
                          className="crm-chip-edit"
                          onClick={e => { e.stopPropagation(); setSenderModal(s); }}
                        >✏</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              {/* TO */}
              <section className="crm-section">
                <div className="crm-section-head">TO — RECIPIENT</div>
                {selectedContact ? (
                  <div className="crm-to-card">
                    <div className="crm-to-role">{selectedContact.role}</div>
                    <div className="crm-to-name">{selectedContact.company_name}</div>
                    {selectedContact.email && (
                      <div className="crm-to-email">
                        {selectedContact.email}
                        <CopyBtn value={selectedContact.email} />
                      </div>
                    )}
                    <div className="crm-to-hint">← Select a different contact in the sidebar</div>
                  </div>
                ) : (
                  <div className="crm-hint-card">
                    <span className="crm-hint-icon">←</span>
                    <span>Select a recipient from the contacts sidebar</span>
                  </div>
                )}
              </section>

              {/* PERSONA */}
              <section className="crm-section">
                <div className="crm-section-head">
                  <span>CLIENT PERSONA (optional)</span>
                  <button className="crm-add-btn" onClick={() => setPersonaModal("new")}>＋ Add</button>
                </div>
                <div className="crm-persona-chips">
                  <button
                    className={`crm-persona-chip${!activePersona ? " active" : ""}`}
                    onClick={() => setActivePersona(null)}
                  >None</button>
                  {db.clientPersonas.map(p => (
                    <button
                      key={p.id}
                      className={`crm-persona-chip${activePersona?.id === p.id ? " active" : ""}`}
                      onClick={() => setActivePersona(p)}
                      title={p.notes}
                    >
                      <span className="crm-pc-dot" />
                      {p.name}
                      <span className="crm-pc-tone">{p.tone}</span>
                    </button>
                  ))}
                </div>
              </section>

              {/* CONTEXT */}
              <section className="crm-section">
                <div className="crm-section-head">ADDITIONAL CONTEXT (optional)</div>
                <textarea
                  className="crm-inp crm-context-inp"
                  rows={3}
                  value={context}
                  onChange={e => setContext(e.target.value)}
                  placeholder="Specific deal context, pricing, schedule, vessel cargo details…"
                />
              </section>

              {/* GENERATE */}
              {genError && <div className="crm-gen-error">⚠ {genError}</div>}
              <button
                className={`crm-generate-btn${generating ? " loading" : ""}`}
                disabled={!activeSender || !selectedContact || generating}
                onClick={handleGenerate}
              >
                {generating
                  ? <><span className="crm-spin" /> Drafting with AI…</>
                  : <><span className="crm-gen-star">✦</span> Generate Email Draft</>
                }
              </button>
              {(!activeSender || !selectedContact) && (
                <div className="crm-prereqs">
                  {!activeSender    && <span className="crm-prereq">⚠ Add a sender profile above</span>}
                  {!selectedContact && <span className="crm-prereq">⚠ Select a recipient contact</span>}
                </div>
              )}
            </div>
          )}

          {/* ─── PERSONAS TAB ─── */}
          {activeTab === "personas" && (
            <div className="crm-personas-view">

              {/* My Sender Profiles */}
              <div className="crm-pv-section">
                <div className="crm-pv-head">
                  <span className="crm-pv-title">MY SENDER PROFILES</span>
                  <button className="crm-add-btn" onClick={() => setSenderModal("new")}>＋ New Profile</button>
                </div>
                {db.senderProfiles.length === 0 ? (
                  <div className="crm-pv-empty" onClick={() => setSenderModal("new")}>
                    <span className="crm-empty-icon">👤</span>
                    <span>Create your sender profile</span>
                  </div>
                ) : (
                  <div className="crm-pv-grid">
                    {db.senderProfiles.map(s => (
                      <div key={s.id} className="crm-pv-card crm-pv-card--sender">
                        <div className="crm-pv-card-name">{s.name}</div>
                        <div className="crm-pv-card-co">{s.company}</div>
                        <div className="crm-pv-card-role">{s.role}</div>
                        {s.email && <div className="crm-pv-card-email">{s.email}</div>}
                        <span className="crm-tone-tag">{s.tone}</span>
                        {s.notes && <div className="crm-pv-card-notes">{s.notes.slice(0, 100)}{s.notes.length > 100 ? "…" : ""}</div>}
                        <div className="crm-pv-card-btns">
                          <button className="crm-btn crm-btn-sm" onClick={() => setSenderModal(s)}>✏ Edit</button>
                          <button
                            className="crm-btn crm-btn-sm crm-btn-danger"
                            onClick={() => { db.deleteSender(s.id); if (activeSender?.id === s.id) setActiveSender(null); }}
                          >🗑</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Client Personas */}
              <div className="crm-pv-section">
                <div className="crm-pv-head">
                  <span className="crm-pv-title">CLIENT PERSONAS</span>
                  <button className="crm-add-btn" onClick={() => setPersonaModal("new")}>＋ New Persona</button>
                </div>
                {db.clientPersonas.length === 0 ? (
                  <div className="crm-pv-empty" onClick={() => setPersonaModal("new")}>
                    <span className="crm-empty-icon">🎯</span>
                    <span>Add client personas to tailor email tone &amp; style</span>
                  </div>
                ) : (
                  <div className="crm-pv-grid">
                    {db.clientPersonas.map(p => (
                      <div key={p.id} className="crm-pv-card crm-pv-card--persona">
                        <div className="crm-pv-card-name">{p.name}</div>
                        <div className="crm-pv-card-co">{p.company}</div>
                        <div className="crm-pv-card-role">{p.role}</div>
                        <span className="crm-tone-tag crm-tone-tag--cyan">{p.tone}</span>
                        {p.notes && <div className="crm-pv-card-notes">{p.notes.slice(0, 120)}{p.notes.length > 120 ? "…" : ""}</div>}
                        <div className="crm-pv-card-btns">
                          <button className="crm-btn crm-btn-sm" onClick={() => setPersonaModal(p)}>✏ Edit</button>
                          <button
                            className="crm-btn crm-btn-sm crm-btn-danger"
                            onClick={() => { db.deletePersona(p.id); if (activePersona?.id === p.id) setActivePersona(null); }}
                          >🗑</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ─── DRAFTS TAB ─── */}
          {activeTab === "drafts" && (
            <div className="crm-drafts-view">
              <div className="crm-drafts-head">
                <span className="crm-drafts-title">EMAIL DRAFTS</span>
                {vessel && <span className="crm-drafts-count">{vesselDrafts.length} for {vessel.vessel_name}</span>}
              </div>

              {/* AI Refine bar */}
              {vesselDrafts.length > 0 && (
                <div className="crm-refine-bar">
                  <span className="crm-refine-label">✨ AI Refine</span>
                  <input
                    className="crm-inp crm-refine-inp"
                    value={refineText}
                    onChange={e => setRefineText(e.target.value)}
                    placeholder="e.g. Make it shorter, add urgency, use executive tone…"
                    onKeyDown={e => {
                      if (e.key === "Enter" && !e.shiftKey && refineText.trim()) {
                        const latest = [...vesselDrafts].sort((a, b) => b.createdAt - a.createdAt)[0];
                        if (latest) handleRefine(latest);
                      }
                    }}
                  />
                  <button
                    className="crm-btn crm-btn-ai"
                    disabled={refining || !refineText.trim()}
                    onClick={() => {
                      const latest = [...vesselDrafts].sort((a, b) => b.createdAt - a.createdAt)[0];
                      if (latest) handleRefine(latest);
                    }}
                  >
                    {refining ? <><span className="crm-spin" /> Refining…</> : "Refine Latest"}
                  </button>
                </div>
              )}

              {genError && <div className="crm-gen-error">⚠ {genError}</div>}

              {vesselDrafts.length === 0 ? (
                <div className="crm-drafts-empty">
                  <span className="crm-empty-icon" style={{ fontSize: 32 }}>✉</span>
                  <span>No drafts yet</span>
                  <button className="crm-btn crm-btn-primary" onClick={() => setActiveTab("compose")}>
                    Go to Compose →
                  </button>
                </div>
              ) : (
                <div className="crm-drafts-list">
                  {[...vesselDrafts]
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .map(d =>
                      editingDraft?.id === d.id ? (
                        <DraftEditor
                          key={d.id}
                          draft={d}
                          onSave={updated => { db.saveDraft(updated); setEditingDraft(null); }}
                          onCancel={() => setEditingDraft(null)}
                        />
                      ) : (
                        <DraftCard
                          key={d.id}
                          draft={d}
                          personas={db.clientPersonas}
                          onEdit={setEditingDraft}
                          onDelete={db.deleteDraft}
                          onRegenerate={handleRegenerate}
                        />
                      )
                    )
                  }
                </div>
              )}
            </div>
          )}

        </main>
      </div>

      {/* ── MODALS ── */}
      {senderModal && (
        <ProfileModal
          title={senderModal === "new" ? "New Sender Profile" : "Edit Sender Profile"}
          profile={senderModal === "new" ? null : senderModal}
          onSave={s => { db.upsertSender(s); setActiveSender(s); setSenderModal(null); }}
          onClose={() => setSenderModal(null)}
        />
      )}
      {personaModal && (
        <ProfileModal
          title={personaModal === "new" ? "New Client Persona" : "Edit Client Persona"}
          profile={personaModal === "new" ? null : personaModal}
          onSave={p => { db.upsertPersona(p); setPersonaModal(null); }}
          onClose={() => setPersonaModal(null)}
        />
      )}
    </div>
  );
}
