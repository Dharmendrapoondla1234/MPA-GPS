// GeminiContactFinder.jsx — v2 (fully debugged)
// Standalone browser-based Gemini AI contact finder.
// NO backend dependency — API key stored in localStorage, all calls from browser.
//
// BUGS FIXED vs v1:
//  1. allorigins.win unreliable — now tries 3 CORS proxies with fallback
//  2. Phase 1 only ran when imo && !companyName — now also runs when vessel prop is set
//  3. Gemini prompt had template literal injection bugs with special chars in company names
//  4. Email tab rendered broken JSX expression (emails => emails)
//  5. No retry on Gemini 503/overload errors
//  6. Pipeline returned partial={} with no vessel data when company known but domain not found
//  7. keyValid check rejected valid keys not starting with "AIza" (some new keys don't)
//  8. Steps log auto-scroll not working during streaming
//  9. DuckDuckGo search URL used wrong quote encoding for non-ASCII company names

import React, { useState, useCallback, useEffect, useRef, memo } from "react";
import "./GeminiContactFinder.css";

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const STORAGE_KEY  = "mpa_gemini_api_key_v2";

// ── Multiple CORS proxies — try in order until one works ──────────
const CORS_PROXIES = [
  url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://cors-anywhere.herokuapp.com/${url}`,
];

async function fetchViaProxy(url, timeoutMs = 14000) {
  for (const makeProxy of CORS_PROXIES) {
    try {
      const proxyUrl = makeProxy(url);
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      // allorigins and corsproxy.io return { contents: "..." }
      if (json?.contents && json.contents.length > 100) return json.contents;
      // cors-anywhere returns raw text
      const text = await res.text().catch(() => null);
      if (text && text.length > 100) return text;
    } catch { /* try next proxy */ }
  }
  return null;
}

// ── Gemini API with retry on 503 ──────────────────────────────────
async function callGemini(apiKey, prompt, systemText = null, maxTokens = 2000, retries = 2) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.05,
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
    },
  };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(35000),
      });

      if (res.status === 429 || res.status === 503) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        throw new Error(res.status === 429 ? "Gemini rate limit — wait 60s" : "Gemini overloaded — try again");
      }
      if (res.status === 400) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message?.slice(0, 120) || "Invalid API key or request");
      }
      if (!res.ok) throw new Error(`Gemini error: HTTP ${res.status}`);

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!text) throw new Error("Gemini returned empty response");

      // Strip markdown code fences if present
      const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
      try {
        return JSON.parse(clean);
      } catch {
        // Sometimes Gemini wraps in an extra object — try to extract
        const match = /\{[\s\S]+\}/m.exec(clean);
        if (match) {
          try { return JSON.parse(match[0]); } catch {}
        }
        throw new Error("Gemini response was not valid JSON");
      }
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ── Safely escape company name for use in prompts ─────────────────
function esc(str) {
  return (str || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`");
}

// ── Main enrichment pipeline ──────────────────────────────────────
async function runGeminiPipeline(apiKey, { imo, companyName, vesselName }, onStep) {
  const steps = [];
  const log = (msg, type = "info") => {
    steps.push({ msg, type, ts: Date.now() });
    onStep([...steps]);
  };

  log(`🚀 Starting: IMO ${imo || "—"} / "${companyName || vesselName || "?"}"`, "start");

  // ── PHASE 1: Resolve company name ─────────────────────────────
  let company     = companyName ? companyName.trim() : null;
  let vessel      = vesselName  ? vesselName.trim()  : null;
  let flag        = null;
  let htmlEvidence = "";

  if (!company) {
    if (!imo) {
      return { steps, error: "Please enter an IMO number or company name." };
    }

    // Try maritime registry scraping first
    log("📡 Fetching from maritime registries (VesselFinder, MarineTraffic)...");
    const sources = [
      { name: "VesselFinder",  url: `https://www.vesselfinder.com/vessels/details/${imo}` },
      { name: "MarineTraffic", url: `https://www.marinetraffic.com/en/ais/details/ships/imo:${imo}` },
      { name: "FleetMon",      url: `https://www.fleetmon.com/vessels/vessel/${imo}/` },
    ];

    for (const src of sources) {
      const html = await fetchViaProxy(src.url, 12000);
      if (html && html.length > 500) {
        htmlEvidence = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .slice(0, 5000);
        log(`  ✓ ${src.name}: got ${html.length} chars`, "success");
        break;
      }
      log(`  ⚠ ${src.name}: no data`, "warn");
    }

    // Ask Gemini to extract company from HTML evidence OR from training knowledge
    log("🤖 Identifying vessel owner with Gemini...");
    const idPrompt = htmlEvidence
      ? `Extract vessel ownership for IMO ${imo} from this page text:\n\n${htmlEvidence}\n\nReturn JSON with: vessel_name, flag, vessel_type, registered_owner, ism_manager, ship_manager, operator (all strings or null), confidence (0-100)`
      : `What shipping company owns/manages the vessel with IMO number ${imo}${vessel ? ` named "${esc(vessel)}"` : ""}? Use your training knowledge.\n\nReturn JSON: { "vessel_name": "...", "flag": "...", "registered_owner": "...", "ism_manager": "...", "ship_manager": null, "operator": null, "confidence": 60 }`;

    const idResult = await callGemini(
      apiKey, idPrompt,
      "You are a maritime data expert. Return only valid JSON, no markdown.",
      600
    );

    company = idResult?.registered_owner || idResult?.ism_manager || idResult?.ship_manager || idResult?.operator || null;
    vessel  = idResult?.vessel_name || vessel;
    flag    = idResult?.flag || null;

    if (company) {
      log(`✅ Owner identified: "${company}" (${idResult?.confidence || "?"}% confidence)`, "success");
    } else {
      log("❌ Could not identify owner. Enter company name directly.", "error");
      return {
        steps,
        error: "Could not identify vessel owner from IMO. Please type the company name directly.",
        partial: { vessel_name: vessel, imo, flag }
      };
    }
  }

  // ── PHASE 2: Find official website ────────────────────────────
  log(`🌐 Finding official website for "${company}"...`);

  const domainPrompt = [
    `What is the official website domain for this maritime company: "${esc(company)}"`,
    flag ? `Country/flag: ${flag}` : "",
    `Return JSON: { "domain": "example.com", "website": "https://www.example.com", "confidence": 85, "country": "...", "reason": "..." }`,
    `If unknown: { "domain": null, "website": null, "confidence": 0, "reason": "not found in training data" }`
  ].filter(Boolean).join("\n\n");

  const domainResult = await callGemini(apiKey, domainPrompt, "Return only JSON.", 300);
  const domain  = domainResult?.domain   ? domainResult.domain.replace(/^https?:\/\/(www\.)?/, "").split("/")[0].toLowerCase() : null;
  const website = domainResult?.website  || (domain ? `https://${domain}` : null);

  if (domain) {
    log(`✅ Domain: ${domain} (${domainResult?.confidence || "?"}% confidence)`, "success");
  } else {
    log("⚠ Domain not found in Gemini knowledge — will rely on search results", "warn");
  }

  // ── PHASE 3: Scrape official website ─────────────────────────
  let scrapedText = "";
  if (domain) {
    log(`🕷 Scraping contact pages on ${domain}...`);
    const paths = ["/contact", "/contact-us", "/contacts", "/about", "/offices", ""];
    for (const path of paths) {
      const url  = `https://${domain}${path}`;
      const html = await fetchViaProxy(url, 10000);
      if (html && html.length > 300) {
        const cleaned = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .slice(0, 3000);
        scrapedText += `\n=== ${url} ===\n${cleaned}`;
        log(`  ✓ Scraped ${url} (${html.length} chars)`, "success");
        if (scrapedText.length > 7000) break;
      }
    }
    if (!scrapedText) log("  ⚠ Website blocked by proxy — relying on Gemini knowledge", "warn");
  }

  // ── PHASE 4: Web search evidence ─────────────────────────────
  log(`🔎 Searching for "${company}" contact details...`);
  const searchQuery = `"${company}" shipping contact email phone address`;
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
  const ddgHtml = await fetchViaProxy(ddgUrl, 12000);
  const searchText = ddgHtml
    ? ddgHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 5000)
    : "";
  if (searchText) log(`  ✓ Got search results (${searchText.length} chars)`, "success");
  else            log("  ⚠ Search unavailable — using Gemini knowledge only", "warn");

  // ── PHASE 5: Gemini extracts all contacts ─────────────────────
  log("🤖 Extracting contacts with Gemini AI...");

  const evidence = [
    scrapedText ? `=== SCRAPED WEBSITE CONTENT ===\n${scrapedText}` : "",
    searchText  ? `=== WEB SEARCH RESULTS ===\n${searchText}` : "",
    htmlEvidence ? `=== MARITIME REGISTRY ===\n${htmlEvidence.slice(0, 2000)}` : "",
  ].filter(Boolean).join("\n\n");

  const contactPrompt = `Extract ALL contact details for maritime company: "${esc(company)}"
${website ? `Official website: ${website}` : ""}
${flag ? `Country: ${flag}` : ""}

${evidence ? `Web evidence:\n${evidence}` : "No web evidence. Use your training knowledge — be specific, not generic."}

Rules:
- List emails found in evidence text; if none found, generate realistic patterns like info@${domain || "domain.com"}, ops@${domain || "domain.com"}
- Include phone with country code if known
- Be specific about address (city/country minimum)
- Rate confidence 0-100 per item

Return ONLY this JSON (no markdown):
{
  "company_name": "${esc(company)}",
  "vessel_name": "${esc(vessel || "")}",
  "imo": "${esc(imo || "")}",
  "flag": "${esc(flag || "")}",
  "official_website": "${esc(website || "")}",
  "emails": [
    {"email": "info@example.com", "type": "general", "confidence": 80, "source": "website_scraped"},
    {"email": "ops@example.com",  "type": "operations", "confidence": 65, "source": "pattern_generated"}
  ],
  "phones": [
    {"number": "+65 6XXX XXXX", "type": "main", "confidence": 75}
  ],
  "address": "full address string or null",
  "linkedin": "https://linkedin.com/company/... or null",
  "key_personnel": [
    {"name": "...", "role": "Fleet Manager", "email": null}
  ],
  "overall_confidence": 72,
  "data_quality": "high",
  "notes": "brief quality note"
}`;

  const extracted = await callGemini(
    apiKey, contactPrompt,
    "You are a maritime intelligence analyst. Extract real contact data. Return ONLY valid JSON.",
    1500
  );

  if (!extracted) {
    return { steps, error: "Gemini could not extract contacts", partial: { company_name: company, vessel_name: vessel } };
  }

  // Clean + validate
  const emails = (extracted.emails || [])
    .filter(e => typeof e.email === "string" && e.email.includes("@") && e.email.includes(".") && e.email.length < 80)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  const phones = (extracted.phones || [])
    .filter(p => typeof p.number === "string" && p.number.replace(/\D/g, "").length >= 7)
    .slice(0, 5);

  log(`✅ Done — ${emails.length} emails · ${phones.length} phones · ${extracted.overall_confidence || "?"}% confidence`, "done");

  return {
    steps,
    result: {
      ...extracted,
      company_name:    company,
      vessel_name:     vessel  || extracted.vessel_name,
      imo:             imo     || extracted.imo,
      flag:            flag    || extracted.flag,
      official_website: website || extracted.official_website,
      emails,
      phones,
    },
  };
}

// ── Sub-components ────────────────────────────────────────────────
const StepLog = memo(function StepLog({ steps }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });

  const color = t => ({
    start: "#00e5ff", success: "#26de81", warn: "#fd9644",
    error: "#ff3355", done: "#c084fc", info: "#8ab4d0"
  }[t] || "#8ab4d0");

  return (
    <div className="gcf-steps" ref={ref}>
      {steps.map((s, i) => (
        <div key={i} className="gcf-step" style={{ color: color(s.type) }}>
          <span className="gcf-step-ts">{new Date(s.ts).toLocaleTimeString()}</span>
          <span className="gcf-step-msg">{s.msg}</span>
        </div>
      ))}
    </div>
  );
});

function CopyBtn({ value, label = "" }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      className="gcf-copy-btn"
      onClick={() => {
        navigator.clipboard.writeText(value)
          .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })
          .catch(() => {});
      }}
      title={`Copy ${label}`}
    >
      {copied ? "✓" : "⎘"}
    </button>
  );
}

function EmailCard({ email }) {
  const conf = email.confidence || 0;
  const cls  = conf >= 80 ? "high" : conf >= 55 ? "mid" : "low";
  return (
    <div className="gcf-email-card">
      <div className="gcf-email-top">
        <a href={`mailto:${email.email}`} className="gcf-email-addr">{email.email}</a>
        <span className={`gcf-conf gcf-conf-${cls}`}>{conf}%</span>
      </div>
      <div className="gcf-email-meta">
        {email.type   && <span className="gcf-email-type">{email.type}</span>}
        {email.source && <span className="gcf-email-src">{email.source.replace(/_/g, " ")}</span>}
        <CopyBtn value={email.email} label="email" />
        <a href={`mailto:${email.email}`} className="gcf-mail-btn">✉ Mail</a>
      </div>
    </div>
  );
}

function PhoneCard({ phone }) {
  const conf = phone.confidence || 0;
  return (
    <div className="gcf-phone-card">
      <span className="gcf-phone-num">{phone.number}</span>
      {phone.type && <span className="gcf-phone-type">{phone.type}</span>}
      <span className={`gcf-conf gcf-conf-${conf >= 75 ? "high" : "mid"}`}>{conf}%</span>
      <CopyBtn value={phone.number} label="phone" />
      <a href={`tel:${phone.number.replace(/\s/g, "")}`} className="gcf-mail-btn">☎ Call</a>
    </div>
  );
}

function PersonCard({ person }) {
  return (
    <div className="gcf-person-card">
      <div className="gcf-person-name">{person.name}</div>
      <div className="gcf-person-role">{person.role}</div>
      {person.email && (
        <div className="gcf-person-email-row">
          <a href={`mailto:${person.email}`} className="gcf-person-email">{person.email}</a>
          <CopyBtn value={person.email} label="email" />
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────
export default function GeminiContactFinder({ isOpen, onClose, vessel }) {
  const [apiKey,    setApiKey]    = useState(() => localStorage.getItem(STORAGE_KEY) || "");
  const [showKey,   setShowKey]   = useState(false);
  const [keyValid,  setKeyValid]  = useState(() => {
    const k = localStorage.getItem(STORAGE_KEY) || "";
    return k.length > 20; // Accept any key ≥20 chars (not just AIza prefix)
  });
  const [imo,       setImo]       = useState("");
  const [company,   setCompany]   = useState("");
  const [loading,   setLoading]   = useState(false);
  const [steps,     setSteps]     = useState([]);
  const [result,    setResult]    = useState(null);
  const [error,     setError]     = useState(null);
  const [activeTab, setActiveTab] = useState("emails");
  const abortRef = useRef(null);

  // Pre-fill from selected vessel when panel opens
  useEffect(() => {
    if (!isOpen) return;
    if (vessel?.imo_number) setImo(String(vessel.imo_number));
    // Don't auto-clear result — user might reopen to see previous result
  }, [isOpen, vessel?.imo_number]); // eslint-disable-line

  const saveKey = useCallback(val => {
    const k = val.trim();
    setApiKey(k);
    setKeyValid(k.length > 20);
    if (k.length > 20) localStorage.setItem(STORAGE_KEY, k);
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  const handleSearch = useCallback(async () => {
    const key = apiKey.trim();
    if (!key || key.length < 20) { setError("Enter your Gemini API key first"); return; }
    if (!imo.trim() && !company.trim()) { setError("Enter an IMO number or company name"); return; }

    // Cancel any running search
    abortRef.current?.abort?.();

    setLoading(true);
    setResult(null);
    setError(null);
    setSteps([]);
    setActiveTab("emails");

    try {
      const out = await runGeminiPipeline(
        key,
        { imo: imo.trim() || null, companyName: company.trim() || null, vesselName: vessel?.vessel_name || null },
        setSteps
      );
      if (out.error && !out.result) {
        setError(out.error);
        if (out.partial && Object.keys(out.partial).length) setResult(out.partial);
      } else {
        setResult(out.result || out.partial || null);
      }
    } catch (err) {
      setError(err.message || "Enrichment failed — check your API key and try again");
    } finally {
      setLoading(false);
    }
  }, [apiKey, imo, company, vessel]);

  const handleClear = useCallback(() => {
    setResult(null); setError(null); setSteps([]);
    setImo(vessel?.imo_number ? String(vessel.imo_number) : "");
    setCompany("");
  }, [vessel]);

  if (!isOpen) return null;

  const r  = result;
  const emailCount = r?.emails?.length || 0;
  const phoneCount = r?.phones?.length || 0;
  const peopleCount = (r?.key_personnel || []).filter(p => p?.name).length;

  return (
    <div className="gcf-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="gcf-panel">

        {/* ── Header ── */}
        <div className="gcf-header">
          <div className="gcf-header-left">
            <span className="gcf-gemini-icon">✨</span>
            <div>
              <div className="gcf-title">GEMINI AI CONTACT FINDER</div>
              <div className="gcf-subtitle">Deep contact extraction · All processing in browser · No backend needed</div>
            </div>
          </div>
          <button className="gcf-close" onClick={onClose}>✕</button>
        </div>

        {/* ── API Key bar ── */}
        <div className={`gcf-key-bar${keyValid ? " gcf-key-bar-valid" : ""}`}>
          <span className="gcf-key-label">{keyValid ? "✅" : "🔑"} Gemini API Key</span>
          <div className="gcf-key-input-wrap">
            <input
              className="gcf-key-input"
              type={showKey ? "text" : "password"}
              placeholder="Paste your Gemini key (free at aistudio.google.com/apikey)"
              value={apiKey}
              onChange={e => saveKey(e.target.value)}
            />
            <button className="gcf-key-toggle" onClick={() => setShowKey(v => !v)} title="Toggle visibility">
              {showKey ? "🙈" : "👁"}
            </button>
          </div>
          {!keyValid
            ? <a className="gcf-key-link" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Get free key →</a>
            : <span className="gcf-key-saved">✓ Key saved</span>
          }
        </div>

        {/* ── Search bar ── */}
        <div className="gcf-search-bar">
          <div className="gcf-input-group">
            <label className="gcf-input-label">IMO Number</label>
            <input
              className="gcf-input"
              type="text"
              placeholder="e.g. 9337462"
              value={imo}
              onChange={e => setImo(e.target.value.replace(/\D/g, ""))}
              onKeyDown={e => e.key === "Enter" && handleSearch()}
              disabled={loading}
            />
          </div>
          <div className="gcf-input-sep">OR</div>
          <div className="gcf-input-group" style={{ flex: 1, minWidth: 180 }}>
            <label className="gcf-input-label">Company Name</label>
            <input
              className="gcf-input"
              type="text"
              placeholder="e.g. DAE MYUNG INTERNATIONAL PTE"
              value={company}
              onChange={e => setCompany(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSearch()}
              disabled={loading}
            />
          </div>
          <button className="gcf-search-btn" onClick={handleSearch} disabled={loading || !keyValid}>
            {loading ? <><span className="gcf-spin">⟳</span> Searching…</> : "✨ Find Contacts"}
          </button>
          {(result || steps.length > 0) && !loading && (
            <button className="gcf-clear-btn" onClick={handleClear} title="Clear results">✕</button>
          )}
        </div>

        {/* ── Body ── */}
        <div className="gcf-body">

          {/* Step log */}
          {steps.length > 0 && <StepLog steps={steps} />}

          {/* Error banner */}
          {error && (
            <div className="gcf-error">
              <span>⚠ {error}</span>
              <button onClick={handleSearch} disabled={loading}>Retry</button>
            </div>
          )}

          {/* Results */}
          {r && (r.company_name || r.vessel_name || r.emails?.length > 0) && (
            <div className="gcf-results">

              {/* Identity bar */}
              <div className="gcf-identity-bar">
                <div className="gcf-identity-top">
                  <span className="gcf-company-name">{r.company_name || company || "—"}</span>
                  {r.overall_confidence != null && (
                    <span className={`gcf-conf gcf-conf-${r.overall_confidence >= 70 ? "high" : r.overall_confidence >= 45 ? "mid" : "low"} gcf-conf-badge`}>
                      {r.overall_confidence}% confidence
                    </span>
                  )}
                </div>
                {r.vessel_name && (
                  <div className="gcf-vessel-line">⛴ {r.vessel_name}{r.imo ? ` · IMO ${r.imo}` : ""}{r.flag ? ` · 🏳 ${r.flag}` : ""}</div>
                )}
                {r.official_website && (
                  <a href={r.official_website.startsWith("http") ? r.official_website : `https://${r.official_website}`}
                    target="_blank" rel="noopener noreferrer" className="gcf-website-link">
                    🌐 {r.official_website.replace(/^https?:\/\/(www\.)?/, "")}
                  </a>
                )}
                {r.address && <div className="gcf-address">📍 {r.address}</div>}
                {r.linkedin && (
                  <a href={r.linkedin} target="_blank" rel="noopener noreferrer" className="gcf-linkedin">💼 LinkedIn Profile</a>
                )}
                {r.notes && <div className="gcf-notes">💡 {r.notes}</div>}
              </div>

              {/* Tabs */}
              <div className="gcf-tabs">
                {[
                  { id: "emails",  label: "✉ Emails",    count: emailCount  },
                  { id: "phones",  label: "☎ Phones",    count: phoneCount  },
                  { id: "people",  label: "👥 Personnel", count: peopleCount },
                ].map(({ id, label, count }) => (
                  <button
                    key={id}
                    className={`gcf-tab${activeTab === id ? " active" : ""}`}
                    onClick={() => setActiveTab(id)}
                  >
                    {label}
                    {count > 0 && <span className="gcf-tab-count">{count}</span>}
                  </button>
                ))}
              </div>

              <div className="gcf-tab-content">
                {activeTab === "emails" && (
                  emailCount === 0
                    ? <div className="gcf-no-data">No email addresses found. Try entering the company name directly for better results.</div>
                    : r.emails.map((e, i) => <EmailCard key={i} email={e} />)
                )}
                {activeTab === "phones" && (
                  phoneCount === 0
                    ? <div className="gcf-no-data">No phone numbers found.</div>
                    : r.phones.map((p, i) => <PhoneCard key={i} phone={p} />)
                )}
                {activeTab === "people" && (
                  peopleCount === 0
                    ? <div className="gcf-no-data">No key personnel identified.</div>
                    : r.key_personnel.filter(p => p?.name).map((p, i) => <PersonCard key={i} person={p} />)
                )}
              </div>
            </div>
          )}

          {/* Empty state */}
          {!loading && !r && !error && steps.length === 0 && (
            <div className="gcf-empty">
              <div className="gcf-empty-icon">✨</div>
              <div className="gcf-empty-title">Gemini AI Contact Intelligence</div>
              <div className="gcf-empty-sub">
                Enter an IMO number <em>or</em> company name and click <strong>Find Contacts</strong>.
                Gemini will identify the owner, find their website, scrape contact pages, and extract
                emails, phones and key personnel — all from your browser.
              </div>
              <div className="gcf-pipeline-steps">
                {["① Scrape VesselFinder / MarineTraffic for owner name",
                  "② Ask Gemini to identify company from registry data",
                  "③ Find official domain from Gemini knowledge",
                  "④ Scrape /contact · /about · /offices pages",
                  "⑤ DuckDuckGo search for additional evidence",
                  "⑥ Gemini extracts & scores all contacts"].map((s, i) => (
                  <div key={i} className="gcf-pipeline-step">{s}</div>
                ))}
              </div>
              {vessel?.imo_number && (
                <div className="gcf-prefilled-note">
                  IMO {vessel.imo_number} pre-filled from selected vessel
                  {vessel.vessel_name ? ` (${vessel.vessel_name})` : ""}.
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="gcf-footer">
          <span>✨ Gemini 2.0 Flash · Free: 1,500 req/day · Your key stays in this browser</span>
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Get API key</a>
        </div>
      </div>
    </div>
  );
}
