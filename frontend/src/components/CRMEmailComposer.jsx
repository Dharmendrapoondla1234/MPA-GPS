// CRMEmailComposer.jsx — v2  "Split-Editor CRM"
// Persona-driven email drafting with resizable Sash split editor.
// All AI calls proxied through backend — zero API key exposure.
// DB: localStorage-backed in-memory store (production: swap to BigQuery).
// NOTE: "use strict" removed — ES modules (import/export) are strict by default.
import React, {
  useState, useEffect, useRef, useCallback, useMemo,
  // FIX 1: Removed unused `memo` import
} from "react";
import "./CRMEmailComposer.css";

// ─────────────────────────────────────────
// ── PERSISTENCE (localStorage)  ──────────
// ─────────────────────────────────────────
const LS = {
  get: (k, def) => { try { const v=localStorage.getItem(k); return v?JSON.parse(v):def; } catch{return def;} },
  set: (k, v)  => { try { localStorage.setItem(k,JSON.stringify(v)); } catch{} },
};

function uid() { return Date.now().toString(36)+Math.random().toString(36).slice(2); }

// ─────────────────────────────────────────
// ── DB LAYER ─────────────────────────────
// ─────────────────────────────────────────
function useDB() {
  const [sellers,   setSellers_]   = useState(() => LS.get("crm_sellers",   []));
  const [buyers,    setBuyers_]    = useState(() => LS.get("crm_buyers",    []));
  const [personas,  setPersonas_]  = useState(() => LS.get("crm_personas",  []));
  const [contacts,  setContacts_]  = useState(() => LS.get("crm_contacts",  []));
  const [drafts,    setDrafts_]    = useState(() => LS.get("crm_drafts",    []));

  // FIX 2: persist() now supports functional updates by intercepting the updater function.
  // Previously `persist` only accepted a plain value, so `setSellers(prev => ...)` would
  // pass a function as `data` into LS.set() — persisting a function string instead of state.
  const persist = (key, setter) => (updater) => {
    setter(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      LS.set(key, next);
      return next;
    });
  };

  const setSellers  = persist("crm_sellers",  setSellers_);
  const setBuyers   = persist("crm_buyers",   setBuyers_);
  const setPersonas = persist("crm_personas", setPersonas_);
  const setContacts = persist("crm_contacts", setContacts_);
  const setDrafts   = persist("crm_drafts",   setDrafts_);

  // Sellers
  const upsertSeller = (s) => {
    setSellers(prev => {
      const idx = prev.findIndex(x=>x.id===s.id);
      if (idx>=0) { const n=[...prev]; n[idx]=s; return n; }
      return [...prev, s];
    });
  };
  const deleteSeller = (id) => setSellers(prev => prev.filter(x=>x.id!==id));

  // Buyers (global — shared across sellers)
  const upsertBuyer = (b) => {
    setBuyers(prev => {
      const idx = prev.findIndex(x=>x.id===b.id);
      if (idx>=0) { const n=[...prev]; n[idx]=b; return n; }
      return [...prev, b];
    });
  };
  const deleteBuyer = (id) => {
    setBuyers(prev => prev.filter(x=>x.id!==id));
    setContacts(prev => prev.filter(x=>x.buyerId!==id));
  };

  // Contacts (seller→buyer link)
  const linkBuyerToSeller   = (sellerId,buyerId) => {
    setContacts(prev => prev.find(x=>x.sellerId===sellerId&&x.buyerId===buyerId)
      ? prev : [...prev,{id:uid(),sellerId,buyerId}]);
  };
  const unlinkBuyerFromSeller = (sellerId,buyerId) =>
    setContacts(prev => prev.filter(x=>!(x.sellerId===sellerId&&x.buyerId===buyerId)));
  const getBuyersForSeller = (sellerId) => {
    const ids = contacts.filter(x=>x.sellerId===sellerId).map(x=>x.buyerId);
    return buyers.filter(b=>ids.includes(b.id));
  };

  // Personas
  const upsertPersona = (p) => {
    setPersonas(prev => {
      const idx = prev.findIndex(x=>x.id===p.id);
      if (idx>=0) { const n=[...prev]; n[idx]=p; return n; }
      return [...prev, p];
    });
  };
  const deletePersona = (id) => setPersonas(prev=>prev.filter(x=>x.id!==id));

  // Drafts
  const saveDraft = (d) => {
    setDrafts(prev => {
      const idx = prev.findIndex(x=>x.id===d.id);
      if (idx>=0) { const n=[...prev]; n[idx]=d; return n; }
      return [...prev, d];
    });
  };
  const deleteDraft = (id) => setDrafts(prev=>prev.filter(x=>x.id!==id));
  const getDraftsFor = (sellerId,buyerId) =>
    drafts.filter(d=>d.sellerId===sellerId&&d.buyerId===buyerId);

  return {
    sellers, upsertSeller, deleteSeller,
    buyers, upsertBuyer, deleteBuyer,
    personas, upsertPersona, deletePersona,
    contacts, linkBuyerToSeller, unlinkBuyerFromSeller, getBuyersForSeller,
    drafts, saveDraft, deleteDraft, getDraftsFor,
  };
}

// ─────────────────────────────────────────
// ── AI proxy (calls backend — no key exposure) ─
// ─────────────────────────────────────────
// FIX BUG 2: Was "maritime-connect.onrender.com" — that service doesn't exist.
// Backend is deployed as "vessel-backend" per render.yaml. Using the env var
// (set at build time by Render) with the correct fallback.
const API = process.env.REACT_APP_API_URL || "https://vessel-backend.onrender.com/api";

async function aiGenerate(prompt) {
  const res = await fetch(`${API}/gemini/crm-draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, type: "email_draft" }),
  });
  if (!res.ok) throw new Error(`AI error ${res.status}`);
  const j = await res.json();
  return j.text || j.email || j.content || j.draft ||
    (j.companies?.[0]?.email_draft) ||
    "Draft generation failed — please try again.";
}

async function aiPersona(websiteUrl, label) {
  try {
    const res = await fetch(`${API}/gemini/crm-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "persona_extract", url: websiteUrl, label }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.persona || j.text || j.description || null;
  } catch { return null; }
}

// ─────────────────────────────────────────
// ── SASH (resizable split handle) ────────
// ─────────────────────────────────────────
function Sash({ split, onSplit, minA=120, minB=80, containerRef }) {
  const dragging   = useRef(false);
  const startY     = useRef(0);
  const startSplit = useRef(split);

  // FIX 4: Hoist handlers into refs so the same function references are used for both
  // addEventListener and removeEventListener — previously useCallback closures caused
  // the remove calls to target different function instances, leaking the listeners.
  const onMouseMoveRef = useRef(null);
  const onMouseUpRef   = useRef(null);

  const onMouseDown = (e) => {
    e.preventDefault();
    dragging.current    = true;
    startY.current      = e.clientY;
    startSplit.current  = split;

    onMouseMoveRef.current = (ev) => {
      if (!dragging.current || !containerRef.current) return;
      const rect   = containerRef.current.getBoundingClientRect();
      const total  = rect.height;
      const delta  = ev.clientY - startY.current;
      const newPct = Math.min(
        Math.max((startSplit.current * total + delta) / total, minA / total),
        (total - minB) / total
      );
      onSplit(newPct);
    };

    onMouseUpRef.current = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMouseMoveRef.current);
      document.removeEventListener("mouseup",   onMouseUpRef.current);
      document.body.style.cursor     = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMouseMoveRef.current);
    document.addEventListener("mouseup",   onMouseUpRef.current);
    document.body.style.cursor     = "row-resize";
    document.body.style.userSelect = "none";
  };

  // Cleanup on unmount in case the user releases outside the window
  useEffect(() => {
    return () => {
      if (onMouseMoveRef.current) document.removeEventListener("mousemove", onMouseMoveRef.current);
      if (onMouseUpRef.current)   document.removeEventListener("mouseup",   onMouseUpRef.current);
    };
  }, []);

  // Touch support
  const onTouchStart = (e) => {
    startY.current     = e.touches[0].clientY;
    startSplit.current = split;
  };
  const onTouchMove = (e) => {
    if (!containerRef.current) return;
    const rect  = containerRef.current.getBoundingClientRect();
    const total = rect.height;
    const delta = e.touches[0].clientY - startY.current;
    const newPct = Math.min(
      Math.max((startSplit.current * total + delta) / total, minA / total),
      (total - minB) / total
    );
    onSplit(newPct);
  };

  return (
    <div
      className="crm-sash"
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      title="Drag to resize panes"
    >
      <div className="crm-sash-dots">
        <span/><span/><span/>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// ── MODAL HELPERS ─────────────────────────
// ─────────────────────────────────────────
function Modal({ title, onClose, children, width=380 }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
  return (
    <div className="crm-overlay" onClick={e => { if(e.target===e.currentTarget) onClose(); }}>
      <div className="crm-modal" style={{width}}>
        <div className="crm-modal-head">
          <span className="crm-modal-title">{title}</span>
          <button className="crm-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="crm-modal-body">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="crm-field">
      <label className="crm-label">{label}</label>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────
// ── SELLER MODAL ──────────────────────────
// ─────────────────────────────────────────
function SellerModal({ seller, onSave, onClose }) {
  const [form, setForm] = useState(seller || { id:uid(), name:"", email:"", website:"", company:"", role:"" });
  const set = (k) => (e) => setForm(f=>({...f,[k]:e.target.value}));
  return (
    <Modal title={seller?"Edit Seller Profile":"New Seller Profile"} onClose={onClose}>
      <Field label="Full Name"><input className="crm-input" value={form.name} onChange={set("name")} placeholder="Jane Smith"/></Field>
      <Field label="Company"><input className="crm-input" value={form.company} onChange={set("company")} placeholder="Acme Shipping"/></Field>
      <Field label="Role"><input className="crm-input" value={form.role} onChange={set("role")} placeholder="Sales Director"/></Field>
      <Field label="Email"><input className="crm-input" type="email" value={form.email} onChange={set("email")} placeholder="jane@acme.com"/></Field>
      <Field label="Website (for persona)"><input className="crm-input" value={form.website} onChange={set("website")} placeholder="https://acme.com"/></Field>
      <div className="crm-modal-actions">
        <button className="crm-btn crm-btn-ghost" onClick={onClose}>Cancel</button>
        <button className="crm-btn crm-btn-primary" onClick={()=>{ if(form.name.trim()) onSave(form); }}>Save</button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────
// ── BUYER MODAL ───────────────────────────
// ─────────────────────────────────────────
function BuyerModal({ buyer, onSave, onClose }) {
  const [form, setForm] = useState(buyer || { id:uid(), name:"", email:"", company:"", website:"", role:"" });
  const set = (k) => (e) => setForm(f=>({...f,[k]:e.target.value}));
  return (
    <Modal title={buyer?"Edit Buyer":"Add Buyer Contact"} onClose={onClose}>
      <Field label="Full Name"><input className="crm-input" value={form.name} onChange={set("name")} placeholder="John Buyer"/></Field>
      <Field label="Company"><input className="crm-input" value={form.company} onChange={set("company")} placeholder="GlobalFreight Ltd"/></Field>
      <Field label="Role"><input className="crm-input" value={form.role} onChange={set("role")} placeholder="Procurement Manager"/></Field>
      <Field label="Email"><input className="crm-input" type="email" value={form.email} onChange={set("email")} placeholder="john@globalfreight.com"/></Field>
      <Field label="Website (for persona)"><input className="crm-input" value={form.website} onChange={set("website")} placeholder="https://globalfreight.com"/></Field>
      <div className="crm-modal-actions">
        <button className="crm-btn crm-btn-ghost" onClick={onClose}>Cancel</button>
        <button className="crm-btn crm-btn-primary" onClick={()=>{ if(form.name.trim()) onSave(form); }}>Save</button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────
// ── PERSONA MODAL ─────────────────────────
// ─────────────────────────────────────────
function PersonaModal({ persona, sellerId, onSave, onClose }) {
  const [form, setForm] = useState(persona || {
    id:uid(), sellerId, name:"", description:"", tone:"professional",
    sellerWebsite:"", buyerWebsite:"", autoGenerated:false,
  });
  const [extracting, setExtracting] = useState(false);
  const set = (k) => (e) => setForm(f=>({...f,[k]:e.target.value}));

  const handleExtract = async () => {
    if (!form.sellerWebsite && !form.buyerWebsite) return;
    setExtracting(true);
    try {
      const url = form.buyerWebsite || form.sellerWebsite;
      const desc = await aiPersona(url, form.name || "persona");
      if (desc) setForm(f=>({...f, description:desc, autoGenerated:true}));
    } finally { setExtracting(false); }
  };

  return (
    <Modal title={persona?"Edit Persona":"New Persona"} onClose={onClose} width={420}>
      <Field label="Persona Name"><input className="crm-input" value={form.name} onChange={set("name")} placeholder="Enterprise Decision Maker"/></Field>
      <Field label="Tone">
        <select className="crm-input crm-select" value={form.tone} onChange={set("tone")}>
          <option value="professional">Professional</option>
          <option value="consultative">Consultative</option>
          <option value="direct">Direct / Bold</option>
          <option value="friendly">Friendly</option>
          <option value="technical">Technical</option>
          <option value="executive">Executive / C-Suite</option>
        </select>
      </Field>
      <Field label="Seller Website (context)">
        <input className="crm-input" value={form.sellerWebsite} onChange={set("sellerWebsite")} placeholder="https://your-company.com"/>
      </Field>
      <Field label="Buyer Website (context)">
        <input className="crm-input" value={form.buyerWebsite} onChange={set("buyerWebsite")} placeholder="https://buyer-company.com"/>
      </Field>
      <Field label="Persona Description">
        <div style={{position:"relative"}}>
          <textarea className="crm-input crm-textarea" rows={4}
            value={form.description} onChange={set("description")}
            placeholder="Describe this buyer persona: industry, pain points, priorities, communication style..."/>
          <button className="crm-btn crm-btn-ai crm-btn-extract"
            onClick={handleExtract} disabled={extracting}
            title="Auto-extract persona from website">
            {extracting ? "⏳ Extracting…" : "✨ Extract from Website"}
          </button>
        </div>
      </Field>
      <div className="crm-modal-actions">
        <button className="crm-btn crm-btn-ghost" onClick={onClose}>Cancel</button>
        <button className="crm-btn crm-btn-primary"
          onClick={()=>{ if(form.name.trim()) onSave({...form}); }}>Save Persona</button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────
// ── SINGLE DRAFT CARD ─────────────────────
// ─────────────────────────────────────────
function DraftCard({ draft, personas, onEdit, onDelete, onDuplicate, onRegenerate }) {
  const [copied, setCopied] = useState(false);
  const persona = personas.find(p=>p.id===draft.personaId);

  const copy = async () => {
    try { await navigator.clipboard.writeText(draft.body); setCopied(true); setTimeout(()=>setCopied(false),1500); }
    catch { const el=document.createElement("textarea"); el.value=draft.body; document.body.appendChild(el); el.select(); document.execCommand("copy"); document.body.removeChild(el); setCopied(true); setTimeout(()=>setCopied(false),1500); }
  };

  return (
    <div className="crm-draft-card">
      <div className="crm-draft-header">
        <div className="crm-draft-meta">
          {persona && <span className="crm-persona-pill">{persona.name}</span>}
          <span className="crm-draft-date">{new Date(draft.createdAt).toLocaleDateString()}</span>
        </div>
        <div className="crm-draft-actions">
          <button className="crm-da-btn" onClick={copy} title="Copy to clipboard">{copied?"✅":"📋"} {copied?"Copied":"Copy"}</button>
          <button className="crm-da-btn" onClick={()=>onEdit(draft)} title="Edit">✏️ Edit</button>
          <button className="crm-da-btn" onClick={()=>onDuplicate(draft)} title="Duplicate">⧉ Dup</button>
          <button className="crm-da-btn crm-da-regen" onClick={()=>onRegenerate(draft)} title="Regenerate">↺ Regen</button>
          <button className="crm-da-btn crm-da-del" onClick={()=>onDelete(draft.id)} title="Clear/Delete">🗑</button>
        </div>
      </div>
      <div className="crm-draft-subject">{draft.subject}</div>
      <div className="crm-draft-body">{draft.body}</div>
    </div>
  );
}

// ─────────────────────────────────────────
// ── DRAFT EDITOR (inline edit) ────────────
// ─────────────────────────────────────────
function DraftEditor({ draft, onSave, onCancel }) {
  const [subject, setSubject] = useState(draft.subject || "");
  const [body,    setBody]    = useState(draft.body    || "");
  return (
    <div className="crm-draft-editor">
      <div className="crm-de-head">Edit Email Draft</div>
      <input className="crm-input crm-de-subject" value={subject}
        onChange={e=>setSubject(e.target.value)} placeholder="Email subject…"/>
      <textarea className="crm-input crm-de-body" rows={10}
        value={body} onChange={e=>setBody(e.target.value)}/>
      <div className="crm-de-actions">
        <button className="crm-btn crm-btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="crm-btn crm-btn-primary" onClick={()=>onSave({...draft,subject,body})}>Save</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// ── COMPOSE PANEL (top split pane) ────────
// ─────────────────────────────────────────
function ComposePane({ seller, buyer, personas, onGenerate, generating }) {
  const [selectedPersonas, setSelectedPersonas] = useState([]);
  const [context, setContext] = useState("");

  const toggle = (id) => setSelectedPersonas(prev =>
    prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]
  );

  const canGenerate = selectedPersonas.length > 0 && seller && buyer;

  return (
    <div className="crm-compose-pane">
      <div className="crm-compose-header">
        <div className="crm-compose-pair">
          {seller
            ? <><span className="crm-pair-label">FROM</span><span className="crm-pair-name">{seller.name} <em>{seller.company}</em></span></>
            : <span className="crm-pair-hint">← Select a seller profile</span>}
          {buyer && <><span className="crm-pair-sep">→</span><span className="crm-pair-label">TO</span><span className="crm-pair-name">{buyer.name} <em>{buyer.company}</em></span></>}
        </div>
      </div>

      <div className="crm-persona-section">
        <div className="crm-section-label">SELECT PERSONA{selectedPersonas.length>0?` (${selectedPersonas.length} active)`:""}</div>
        <div className="crm-persona-chips">
          {personas.length === 0
            ? <span className="crm-hint-text">No personas yet — create one below</span>
            : personas.map(p => (
              <button
                key={p.id}
                className={"crm-persona-chip"+(selectedPersonas.includes(p.id)?" crm-persona-chip--on":"")}
                onClick={()=>toggle(p.id)}
                title={p.description}
              >
                <span className="crm-chip-dot"/>
                {p.name}
                <span className="crm-chip-tone">{p.tone}</span>
              </button>
            ))
          }
        </div>
      </div>

      <div className="crm-context-section">
        <div className="crm-section-label">ADDITIONAL CONTEXT (optional)</div>
        <textarea className="crm-input crm-context-area" rows={2}
          value={context} onChange={e=>setContext(e.target.value)}
          placeholder="Specific deal context, vessel details, pricing notes…"/>
      </div>

      <button
        className={"crm-btn crm-btn-generate"+(generating?" crm-btn-generating":"")}
        disabled={!canGenerate || generating}
        onClick={()=>onGenerate(selectedPersonas, context)}
      >
        {generating
          ? <><span className="crm-spin"/>Drafting email…</>
          : <><span className="crm-gen-icon">✉</span>Generate Email</>
        }
      </button>
    </div>
  );
}

// ─────────────────────────────────────────
// ── MAIN CRM EMAIL COMPOSER ───────────────
// ─────────────────────────────────────────
export default function CRMEmailComposer({ vessel }) {
  const db = useDB();

  // ── View state ──
  // FIX 5: Removed the unused `view` / `setView` state that was declared but never
  // consumed in the render tree. Keeping dead state misleads future readers.

  const [activeSeller, setActiveSeller] = useState(() => {
    // FIX 6: Guard the initial seller lookup — db.sellers could be empty on first render.
    const sellers = LS.get("crm_sellers", []);
    return sellers.length > 0 ? sellers[0] : null;
  });
  const [activeBuyer,  setActiveBuyer]  = useState(null);
  const [editingDraft, setEditingDraft] = useState(null);
  const [generating,   setGenerating]   = useState(false);
  const [genError,     setGenError]     = useState(null);

  // ── Split state ──
  // FIX 3: Separate refs for the outer root container (layout) and the inner split
  // area (height measurement). Previously both were assigned the same ref, so Sash
  // measured the full page height instead of just the split pane's height.
  const rootRef      = useRef(null);
  const splitAreaRef = useRef(null);
  const [splitRatio, setSplitRatio] = useState(0.42);

  // ── Modals ──
  const [sellerModal,  setSellerModal]  = useState(null);
  const [buyerModal,   setBuyerModal]   = useState(null);
  const [personaModal, setPersonaModal] = useState(null);

  // FIX 2-4: Destructure stable array references from `db`.
  // `db` is a new object every render, so `db.X` in dep arrays
  // triggers hooks on every render. Destructuring gives React
  // stable references it can actually diff.
  const { sellers, personas, buyers, contacts, drafts } = db;

  // Sync activeSeller when sellers list changes
  useEffect(() => {
    if (!activeSeller && sellers.length) setActiveSeller(sellers[0]);
  }, [sellers, activeSeller]);

  const sellerPersonas  = useMemo(() =>
    personas.filter(p => p.sellerId === activeSeller?.id),
    [personas, activeSeller]);
  // FIX: getBuyersForSeller and getDraftsFor are plain functions recreated inside
  // useDB on every render — they are not stable references and must NOT appear in
  // dep arrays. The actual reactive data (contacts, buyers, drafts) already drives
  // recalculation correctly, so inline the logic directly instead.
  const sellerBuyers = useMemo(() => {
    if (!activeSeller) return [];
    const ids = contacts.filter(x => x.sellerId === activeSeller.id).map(x => x.buyerId);
    return buyers.filter(b => ids.includes(b.id));
  }, [contacts, buyers, activeSeller]);

  const activeDrafts = useMemo(() =>
    (activeSeller && activeBuyer)
      ? drafts.filter(d => d.sellerId === activeSeller.id && d.buyerId === activeBuyer.id)
      : [],
    [drafts, activeSeller, activeBuyer]);

  // ── Generate email ──
  const handleGenerate = useCallback(async (personaIds, context) => {
    if (!activeSeller || !activeBuyer) return;
    setGenerating(true); setGenError(null);
    try {
      const selectedPersonas = sellerPersonas.filter(p=>personaIds.includes(p.id));
      const personaBlock = selectedPersonas.map(p =>
        `Persona "${p.name}" (${p.tone} tone): ${p.description}`
      ).join("\n");

      const prompt = `
You are a professional maritime sales email writer.

SELLER: ${activeSeller.name}, ${activeSeller.role} at ${activeSeller.company}
Seller website context: ${activeSeller.website || "N/A"}

BUYER: ${activeBuyer.name}, ${activeBuyer.role} at ${activeBuyer.company}
Buyer website context: ${activeBuyer.website || "N/A"}

${vessel ? `VESSEL CONTEXT: ${vessel.vessel_name || ""} (IMO ${vessel.imo_number || ""}) — ${vessel.vessel_type || ""}, Flag: ${vessel.flag || ""}` : ""}

BUYER PERSONAS:
${personaBlock}

ADDITIONAL CONTEXT: ${context || "None"}

Write a compelling, personalised sales email from the seller to the buyer.
The email should:
- Have a strong subject line
- Reference specific details about the buyer's company and the vessel
- Match the persona tone(s) exactly
- Be concise (under 250 words)
- End with a clear call-to-action

Return format:
SUBJECT: [subject line]
BODY:
[email body]
`.trim();

      const raw = await aiGenerate(prompt);

      const subjectMatch = raw.match(/^SUBJECT:\s*(.+?)(?:\n|$)/im);
      const bodyMatch    = raw.match(/BODY:\s*\n([\s\S]+)/im);
      const subject = subjectMatch?.[1]?.trim() || "Follow-up from " + activeSeller.company;
      const body    = bodyMatch?.[1]?.trim() || raw;

      const draft = {
        id: uid(),
        sellerId: activeSeller.id,
        buyerId:  activeBuyer.id,
        personaId: personaIds[0],
        subject, body,
        createdAt: Date.now(),
      };
      db.saveDraft(draft);
    } catch(err) {
      setGenError(err.message);
    } finally {
      setGenerating(false);
    }
  }, [activeSeller, activeBuyer, sellerPersonas, vessel, db]);

  // ── Regenerate existing draft ──
  const handleRegenerate = useCallback(async (draft) => {
    if (!activeSeller || !activeBuyer) return;
    setGenerating(true); setGenError(null);
    try {
      const persona = sellerPersonas.find(p=>p.id===draft.personaId);
      const prompt = `
Rewrite this sales email with fresh phrasing and a different angle:
FROM: ${activeSeller.name} (${activeSeller.company})
TO: ${activeBuyer.name} (${activeBuyer.company})
${persona ? `PERSONA: ${persona.name} — ${persona.description}` : ""}
${vessel ? `VESSEL: ${vessel.vessel_name} IMO ${vessel.imo_number}` : ""}
ORIGINAL SUBJECT: ${draft.subject}

Write a fresh version. Return:
SUBJECT: [subject]
BODY:
[body]
`.trim();
      const raw = await aiGenerate(prompt);
      const subjectMatch = raw.match(/^SUBJECT:\s*(.+?)(?:\n|$)/im);
      const bodyMatch    = raw.match(/BODY:\s*\n([\s\S]+)/im);
      db.saveDraft({
        ...draft,
        id: uid(),
        subject: subjectMatch?.[1]?.trim() || draft.subject,
        body:    bodyMatch?.[1]?.trim() || raw,
        createdAt: Date.now(),
      });
    } catch(err) { setGenError(err.message); }
    finally { setGenerating(false); }
  }, [activeSeller, activeBuyer, sellerPersonas, vessel, db]);

  const handleDuplicate = (draft) => {
    db.saveDraft({ ...draft, id:uid(), createdAt:Date.now() });
  };

  const handleSaveDraft = (draft) => {
    db.saveDraft(draft);
    setEditingDraft(null);
  };

  // ─── Seller selector bar ───
  const SellerBar = () => (
    <div className="crm-seller-bar">
      <span className="crm-bar-label">SELLER</span>
      <div className="crm-bar-tabs">
        {db.sellers.map(s => (
          <button key={s.id}
            className={"crm-bar-tab"+(activeSeller?.id===s.id?" crm-bar-tab--on":"")}
            onClick={()=>{ setActiveSeller(s); setActiveBuyer(null); }}>
            {s.name}
          </button>
        ))}
        <button className="crm-bar-add" onClick={()=>setSellerModal("new")}>＋ Seller</button>
      </div>
      {activeSeller && (
        <div className="crm-seller-actions">
          <button className="crm-icon-btn" onClick={()=>setSellerModal(activeSeller)} title="Edit seller">✏️</button>
          <button className="crm-icon-btn crm-icon-btn-danger"
            onClick={()=>{ db.deleteSeller(activeSeller.id); setActiveSeller(db.sellers[0]||null); }}
            title="Delete seller">🗑</button>
        </div>
      )}
    </div>
  );

  // ─── Buyer sidebar ───
  const BuyerSidebar = () => (
    <div className="crm-buyer-sidebar">
      <div className="crm-sidebar-head">
        <span className="crm-bar-label">CONTACTS</span>
        <button className="crm-bar-add" onClick={()=>setBuyerModal("new")}>＋ Add</button>
      </div>
      <div className="crm-buyer-list">
        {sellerBuyers.length===0
          ? <div className="crm-empty-hint">No contacts yet</div>
          : sellerBuyers.map(b => (
            <div key={b.id}
              className={"crm-buyer-item"+(activeBuyer?.id===b.id?" crm-buyer-item--on":"")}
              onClick={()=>setActiveBuyer(b)}>
              <div className="crm-buyer-name">{b.name}</div>
              <div className="crm-buyer-co">{b.company}</div>
              <div className="crm-buyer-email">{b.email}</div>
              <div className="crm-buyer-btns">
                <button className="crm-tiny-btn" onClick={e=>{e.stopPropagation();setBuyerModal(b);}}>✏️</button>
                <button className="crm-tiny-btn crm-tiny-danger"
                  onClick={e=>{e.stopPropagation();db.unlinkBuyerFromSeller(activeSeller.id,b.id);
                    if(activeBuyer?.id===b.id)setActiveBuyer(null);}}>✕</button>
              </div>
            </div>
          ))
        }
      </div>
      {activeSeller && db.buyers.filter(b=>!sellerBuyers.find(s=>s.id===b.id)).length>0 && (
        <div className="crm-global-buyers">
          <div className="crm-section-label" style={{padding:"6px 8px"}}>SHARED CONTACTS</div>
          {db.buyers.filter(b=>!sellerBuyers.find(s=>s.id===b.id)).map(b=>(
            <div key={b.id} className="crm-buyer-item crm-buyer-global">
              <div className="crm-buyer-name">{b.name} <span className="crm-global-tag">global</span></div>
              <div className="crm-buyer-co">{b.company}</div>
              <button className="crm-tiny-btn crm-tiny-link"
                onClick={()=>db.linkBuyerToSeller(activeSeller.id,b.id)}>＋ Link</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // ─── Persona manager strip ───
  const PersonaStrip = () => (
    <div className="crm-persona-strip">
      <span className="crm-bar-label">PERSONAS</span>
      <div className="crm-persona-strip-chips">
        {sellerPersonas.map(p=>(
          <div key={p.id} className="crm-persona-strip-item">
            <span className="crm-ps-name">{p.name}</span>
            <span className="crm-ps-tone">{p.tone}</span>
            <button className="crm-tiny-btn" onClick={()=>setPersonaModal(p)}>✏️</button>
            <button className="crm-tiny-btn crm-tiny-danger" onClick={()=>db.deletePersona(p.id)}>✕</button>
          </div>
        ))}
        <button className="crm-bar-add" onClick={()=>setPersonaModal("new")}>＋ Persona</button>
      </div>
    </div>
  );

  // ─────────────────────────────────────────
  // ── RENDER ───────────────────────────────
  // ─────────────────────────────────────────
  if (!activeSeller && db.sellers.length === 0) {
    return (
      <div className="crm-root crm-empty-state">
        <div className="crm-empty-icon">✉️</div>
        <div className="crm-empty-title">CRM Email Composer</div>
        <div className="crm-empty-desc">Create a seller profile to start drafting personalised emails</div>
        <button className="crm-btn crm-btn-primary crm-btn-lg" onClick={()=>setSellerModal("new")}>
          ＋ Create Seller Profile
        </button>
        {sellerModal && (
          <SellerModal
            seller={sellerModal==="new"?null:sellerModal}
            onSave={(s)=>{ db.upsertSeller(s); setActiveSeller(s); setSellerModal(null); }}
            onClose={()=>setSellerModal(null)}
          />
        )}
      </div>
    );
  }

  return (
    // FIX 3 (cont): rootRef goes here on the outer wrapper; splitAreaRef goes on the
    // inner crm-split-area so Sash measures the correct pane height.
    <div className="crm-root" ref={rootRef}>
      {/* ── TOP: Seller bar ── */}
      <SellerBar/>

      {/* ── MAIN BODY: sidebar + split editor ── */}
      <div className="crm-main">
        {/* Buyer sidebar */}
        <BuyerSidebar/>

        {/* Split editor area — measured by Sash */}
        <div className="crm-split-area" ref={splitAreaRef}>
          {/* TOP PANE — Compose */}
          <div className="crm-top-pane" style={{height: `calc(${splitRatio*100}% - 8px)`}}>
            {activeSeller && activeBuyer
              ? <ComposePane
                  seller={activeSeller}
                  buyer={activeBuyer}
                  personas={sellerPersonas}
                  onGenerate={handleGenerate}
                  generating={generating}
                />
              : <div className="crm-select-hint">
                  <span className="crm-hint-icon">←</span>
                  Select a buyer contact to compose
                </div>
            }
          </div>

          {/* SASH — now receives the correct splitAreaRef */}
          <Sash
            split={splitRatio}
            onSplit={setSplitRatio}
            containerRef={splitAreaRef}
            minA={120} minB={100}
          />

          {/* BOTTOM PANE — Drafts */}
          <div className="crm-bottom-pane" style={{height:`calc(${(1-splitRatio)*100}% - 8px)`}}>
            <div className="crm-drafts-header">
              <span className="crm-bar-label">EMAIL DRAFTS</span>
              {activeSeller && activeBuyer && (
                <span className="crm-draft-count">{activeDrafts.length} draft{activeDrafts.length!==1?"s":""}</span>
              )}
            </div>
            <div className="crm-drafts-scroll">
              {genError && <div className="crm-gen-error">⚠ {genError}</div>}
              {!activeBuyer
                ? <div className="crm-empty-hint">Select a contact to see drafts</div>
                : activeDrafts.length===0
                  ? <div className="crm-empty-hint">No drafts yet — generate your first email above</div>
                  : activeDrafts.slice().reverse().map(d =>
                    editingDraft?.id===d.id
                      ? <DraftEditor key={d.id} draft={d}
                          onSave={handleSaveDraft}
                          onCancel={()=>setEditingDraft(null)}/>
                      : <DraftCard key={d.id} draft={d}
                          personas={sellerPersonas}
                          onEdit={setEditingDraft}
                          onDelete={db.deleteDraft}
                          onDuplicate={handleDuplicate}
                          onRegenerate={handleRegenerate}/>
                  )
              }
            </div>
          </div>
        </div>
      </div>

      {/* ── BOTTOM: Persona strip ── */}
      <PersonaStrip/>

      {/* ── MODALS ── */}
      {sellerModal && (
        <SellerModal
          seller={sellerModal==="new"?null:sellerModal}
          onSave={(s)=>{ db.upsertSeller(s); setActiveSeller(s); setSellerModal(null); }}
          onClose={()=>setSellerModal(null)}
        />
      )}
      {buyerModal && (
        <BuyerModal
          buyer={buyerModal==="new"?null:buyerModal}
          onSave={(b)=>{
            db.upsertBuyer(b);
            if(activeSeller) db.linkBuyerToSeller(activeSeller.id, b.id);
            setActiveBuyer(b);
            setBuyerModal(null);
          }}
          onClose={()=>setBuyerModal(null)}
        />
      )}
      {personaModal && (
        <PersonaModal
          persona={personaModal==="new"?null:personaModal}
          sellerId={activeSeller?.id}
          onSave={(p)=>{ db.upsertPersona(p); setPersonaModal(null); }}
          onClose={()=>setPersonaModal(null)}
        />
      )}
    </div>
  );
}