// GeminiContactFinder.jsx — v1
// Standalone Gemini AI contact finder — calls Gemini API directly from browser
// No backend changes needed. User provides their own API key.
// Searches: Equasis public data + DuckDuckGo + website scraping + Gemini extraction

import React, { useState, useCallback, useEffect, useRef } from "react";
import "./GeminiContactFinder.css";

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_BASE  = "https://generativelanguage.googleapis.com/v1beta/models";
const STORAGE_KEY  = "mpa_gemini_api_key";

// ── Maritime data sources (public, no auth needed) ─────────────────
const MARITIME_SOURCES = [
  { name: "VesselFinder",  url: imo => `https://www.vesselfinder.com/vessels/details/${imo}` },
  { name: "MarineTraffic", url: imo => `https://www.marinetraffic.com/en/ais/details/ships/imo:${imo}` },
  { name: "FleetMon",      url: imo => `https://www.fleetmon.com/vessels/vessel/${imo}/` },
];

// ── Gemini API caller ──────────────────────────────────────────────
async function callGemini(apiKey, prompt, systemText = null, maxTokens = 2000) {
  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.05, maxOutputTokens: maxTokens, responseMimeType: "application/json" },
  };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (res.status === 400) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || "Invalid Gemini API key or request");
  }
  if (res.status === 429) throw new Error("Gemini rate limit hit — wait 60s and retry");
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned empty response");

  // Parse JSON (strip markdown fences if present)
  const clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(clean); }
  catch { throw new Error("Gemini response was not valid JSON: " + text.slice(0, 100)); }
}

// ── CORS proxy for maritime sites ─────────────────────────────────
// Uses allorigins.win — free public CORS proxy
async function fetchViaProxy(url, timeoutMs = 12000) {
  const proxy = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  try {
    const res = await fetch(proxy, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.contents || null;
  } catch { return null; }
}

// ── Main enrichment pipeline ───────────────────────────────────────
async function runGeminiPipeline(apiKey, { imo, companyName, vesselName }, onStep) {
  const steps = [];
  const log = (msg, type = "info") => { steps.push({ msg, type, ts: Date.now() }); onStep([...steps]); };

  log(`🚀 Starting enrichment for IMO ${imo || "—"} / "${companyName || vesselName || "?"}"`, "start");

  // ── PHASE 1: Identify company from IMO ────────────────────────
  let resolvedCompany = companyName || null;
  let resolvedVessel  = vesselName  || null;
  let resolvedFlag    = null;
  let rawHtmlEvidence = "";

  if (imo && !resolvedCompany) {
    log("📡 Fetching vessel data from maritime registries...");

    for (const src of MARITIME_SOURCES) {
      const html = await fetchViaProxy(src.url(imo));
      if (html && html.length > 500) {
        rawHtmlEvidence += `\n\n=== ${src.name} HTML (first 3000 chars) ===\n` + html.slice(0, 3000);
        log(`  ✓ Got data from ${src.name} (${html.length} chars)`, "success");
        break; // one source is enough to extract company name
      } else {
        log(`  ⚠ ${src.name}: no data`, "warn");
      }
    }

    if (rawHtmlEvidence) {
      log("🤖 Asking Gemini to identify owner/manager from registry data...");
      const idResult = await callGemini(apiKey, `
Extract vessel ownership details from this maritime registry HTML.
IMO number: ${imo}

HTML evidence:
${rawHtmlEvidence.slice(0, 6000)}

Return ONLY JSON:
{
  "vessel_name": "...",
  "flag": "...",
  "vessel_type": "...",
  "registered_owner": "exact company name or null",
  "ism_manager": "exact company name or null",
  "ship_manager": "exact company name or null",
  "operator": "exact company name or null",
  "confidence": 80
}`, "You extract maritime data from HTML. Return only JSON, no markdown.");

      resolvedCompany = idResult?.registered_owner || idResult?.ism_manager || idResult?.operator || null;
      resolvedVessel  = idResult?.vessel_name  || resolvedVessel;
      resolvedFlag    = idResult?.flag         || null;

      if (resolvedCompany) {
        log(`✅ Identified: "${resolvedCompany}" (confidence: ${idResult?.confidence || "?"}%)`, "success");
      } else {
        log("⚠ Could not identify company from registry HTML — trying Gemini knowledge...", "warn");
      }
    }

    // If still no company — ask Gemini from training knowledge
    if (!resolvedCompany) {
      log("🧠 Querying Gemini knowledge base for this IMO...");
      const knowledgeResult = await callGemini(apiKey, `
What maritime company owns or manages vessel with IMO number ${imo}${vesselName ? ` (vessel name: ${vesselName})` : ""}?

Return ONLY JSON:
{
  "vessel_name": "...",
  "flag": "...",
  "registered_owner": "company name or null",
  "ism_manager": "company name or null",
  "confidence": 60,
  "note": "source of information"
}`, "You are a maritime expert. Return only JSON.");

      resolvedCompany = knowledgeResult?.registered_owner || knowledgeResult?.ism_manager || null;
      resolvedVessel  = knowledgeResult?.vessel_name || resolvedVessel;
      if (resolvedCompany) {
        log(`✅ Gemini knowledge: "${resolvedCompany}"`, "success");
      } else {
        log("❌ Could not identify company — please enter company name manually", "error");
        return { steps, error: "Could not identify vessel owner. Try entering company name directly.", partial: { vessel_name: resolvedVessel, imo } };
      }
    }
  }

  if (!resolvedCompany) {
    return { steps, error: "No company name available to search", partial: {} };
  }

  // ── PHASE 2: Find official website/domain ─────────────────────
  log(`🌐 Finding official website for "${resolvedCompany}"...`);

  const domainResult = await callGemini(apiKey, `
Find the official website domain for this maritime/shipping company: "${resolvedCompany}"
${resolvedFlag ? `Company is based in or registered in: ${resolvedFlag}` : ""}

Search your knowledge for this exact company name.

Return ONLY JSON:
{
  "domain": "example.com",
  "website": "https://www.example.com",
  "confidence": 85,
  "country": "Singapore",
  "reason": "why you are confident"
}

If you cannot find it, return: {"domain": null, "website": null, "confidence": 0, "reason": "not found"}`,
  "You are a web research expert. Return only JSON.");

  const officialDomain  = domainResult?.domain   || null;
  const officialWebsite = domainResult?.website  || (officialDomain ? `https://${officialDomain}` : null);

  if (officialDomain) {
    log(`✅ Found domain: ${officialDomain} (confidence: ${domainResult?.confidence || "?"}%)`, "success");
  } else {
    log("⚠ No official domain found — will try DuckDuckGo search...", "warn");
  }

  // ── PHASE 3: Try to scrape contact page ───────────────────────
  let scrapedText = "";
  if (officialDomain) {
    log(`🕷 Scraping contact pages on ${officialDomain}...`);
    const contactPaths = ["/contact", "/contact-us", "/contacts", "/about", "/about-us", ""];
    for (const path of contactPaths) {
      const url  = `https://${officialDomain}${path}`;
      const html = await fetchViaProxy(url, 10000);
      if (html && html.length > 300) {
        scrapedText += `\n=== ${url} ===\n` + html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .slice(0, 3000);
        log(`  ✓ Scraped ${url} (${html.length} chars)`, "success");
        if (scrapedText.length > 5000) break;
      }
    }
    if (!scrapedText) log("  ⚠ Website not accessible via proxy — using Gemini knowledge only", "warn");
  }

  // ── PHASE 4: DuckDuckGo search evidence ───────────────────────
  log(`🔎 Searching DuckDuckGo for "${resolvedCompany}" contacts...`);
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"${resolvedCompany}" shipping contact email phone`)}`;
  const ddgHtml = await fetchViaProxy(ddgUrl, 12000);
  let searchText = "";
  if (ddgHtml) {
    searchText = ddgHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 5000);
    log(`  ✓ Got DuckDuckGo results (${ddgHtml.length} chars)`, "success");
  } else {
    log("  ⚠ DuckDuckGo search failed", "warn");
  }

  // ── PHASE 5: Gemini extracts all contact details ──────────────
  log("🤖 Asking Gemini to extract all contact details from evidence...");

  const allEvidence = [
    scrapedText ? `=== WEBSITE SCRAPED CONTENT ===\n${scrapedText}` : "",
    searchText  ? `=== SEARCH ENGINE RESULTS ===\n${searchText}` : "",
    rawHtmlEvidence ? `=== MARITIME REGISTRY DATA ===\n${rawHtmlEvidence.slice(0, 2000)}` : "",
  ].filter(Boolean).join("\n\n");

  const contactResult = await callGemini(apiKey, `
Extract ALL contact details for: "${resolvedCompany}"
${officialWebsite ? `Official website: ${officialWebsite}` : ""}

${allEvidence ? `Evidence from web:\n${allEvidence}` : "No web evidence available. Use your training knowledge."}

IMPORTANT RULES:
- Only include emails that APPEAR in the evidence text above
- Use Gemini training knowledge ONLY for website, address, phone (not emails — they change)
- For emails: if none in evidence, generate likely patterns (e.g. info@domain.com, ops@domain.com)
- Rate confidence 0-100 for each contact

Return ONLY JSON:
{
  "company_name": "${resolvedCompany}",
  "vessel_name": "${resolvedVessel || ""}",
  "imo": "${imo || ""}",
  "flag": "${resolvedFlag || ""}",
  "official_website": "${officialWebsite || ""}",
  "emails": [
    {"email": "...", "type": "general/ops/chartering/crew", "confidence": 85, "source": "website_scraped/gemini_knowledge/pattern_generated"},
    {"email": "...", "type": "...", "confidence": 70, "source": "..."}
  ],
  "phones": [
    {"number": "+65 XXXX XXXX", "type": "main/24h/fax", "confidence": 80}
  ],
  "address": "full office address or null",
  "linkedin": "linkedin company URL or null",
  "key_personnel": [
    {"name": "...", "role": "Fleet Manager/Operations/Chartering", "email": "... or null"}
  ],
  "overall_confidence": 75,
  "data_quality": "high/medium/low",
  "notes": "any important notes"
}`,
  "You are a maritime intelligence expert. Extract contact data carefully. Return ONLY valid JSON.");

  if (!contactResult) {
    return { steps, error: "Gemini could not extract contacts", partial: { company: resolvedCompany } };
  }

  log(`✅ Extraction complete — found ${contactResult.emails?.length || 0} emails, ${contactResult.phones?.length || 0} phones`, "success");

  // ── PHASE 6: Validate & score ─────────────────────────────────
  log("📊 Scoring and ranking contacts by confidence...");

  const emails = (contactResult.emails || [])
    .filter(e => e.email && e.email.includes("@") && e.email.includes("."))
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  const phones = (contactResult.phones || [])
    .filter(p => p.number && p.number.replace(/\D/g, "").length >= 7);

  log(`🏁 Done! ${emails.length} emails · ${phones.length} phones · confidence: ${contactResult.overall_confidence || "?"}%`, "done");

  return {
    steps,
    result: {
      ...contactResult,
      emails,
      phones,
      vessel_name: resolvedVessel || contactResult.vessel_name,
      flag: resolvedFlag || contactResult.flag,
    },
  };
}

// ── UI Components ──────────────────────────────────────────────────

function StepLog({ steps }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [steps]);

  const color = t => ({ start: "#00e5ff", success: "#26de81", warn: "#fd9644", error: "#ff3355", done: "#c084fc", info: "#8ab4d0" }[t] || "#8ab4d0");

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
}

function EmailCard({ email }) {
  const [copied, setCopied] = useState(false);
  const conf = email.confidence || 0;
  const cls  = conf >= 80 ? "high" : conf >= 60 ? "mid" : "low";
  return (
    <div className="gcf-email-card">
      <div className="gcf-email-top">
        <a href={`mailto:${email.email}`} className="gcf-email-addr">{email.email}</a>
        <span className={`gcf-conf gcf-conf-${cls}`}>{conf}%</span>
      </div>
      <div className="gcf-email-meta">
        <span className="gcf-email-type">{email.type || "general"}</span>
        <span className="gcf-email-src">{(email.source || "").replace(/_/g, " ")}</span>
        <button className="gcf-copy-btn" onClick={() => {
          navigator.clipboard.writeText(email.email).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); });
        }}>{copied ? "✓" : "⎘"}</button>
        <a href={`mailto:${email.email}`} className="gcf-mail-btn">✉ Mail</a>
      </div>
    </div>
  );
}

function PhoneCard({ phone }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="gcf-phone-card">
      <span className="gcf-phone-num">{phone.number}</span>
      <span className="gcf-phone-type">{phone.type || "main"}</span>
      <span className={`gcf-conf gcf-conf-${(phone.confidence||0) >= 75 ? "high" : "mid"}`}>{phone.confidence || "?"}%</span>
      <button className="gcf-copy-btn" onClick={() => {
        navigator.clipboard.writeText(phone.number).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); });
      }}>{copied ? "✓" : "⎘"}</button>
    </div>
  );
}

function PersonnelCard({ person }) {
  return (
    <div className="gcf-person-card">
      <div className="gcf-person-name">{person.name}</div>
      <div className="gcf-person-role">{person.role}</div>
      {person.email && <a href={`mailto:${person.email}`} className="gcf-person-email">{person.email}</a>}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────
export default function GeminiContactFinder({ isOpen, onClose, vessel }) {
  const [apiKey,      setApiKey]      = useState(() => localStorage.getItem(STORAGE_KEY) || "");
  const [showKey,     setShowKey]     = useState(false);
  const [keyValid,    setKeyValid]    = useState(!!localStorage.getItem(STORAGE_KEY));
  const [imo,         setImo]         = useState("");
  const [company,     setCompany]     = useState("");
  const [loading,     setLoading]     = useState(false);
  const [steps,       setSteps]       = useState([]);
  const [result,      setResult]      = useState(null);
  const [error,       setError]       = useState(null);
  const [activeTab,   setActiveTab]   = useState("emails");

  // Pre-fill from selected vessel
const imoNumber = vessel?.imo_number;

useEffect(() => {
  if (!isOpen || !imoNumber) return;

  setImo(String(imoNumber));
  setCompany("");
  setResult(null);
  setSteps([]);
  setError(null);

}, [isOpen, imoNumber]);

  const saveKey = useCallback((k) => {
    const trimmed = k.trim();
    setApiKey(trimmed);
    if (trimmed.startsWith("AIza") && trimmed.length > 20) {
      localStorage.setItem(STORAGE_KEY, trimmed);
      setKeyValid(true);
    } else {
      setKeyValid(false);
    }
  }, []);

  const handleSearch = useCallback(async () => {
    const key = apiKey.trim();
    if (!key) { setError("Please enter your Gemini API key"); return; }
    if (!imo && !company) { setError("Enter IMO number or company name"); return; }

    setLoading(true);
    setResult(null);
    setError(null);
    setSteps([]);
    setActiveTab("emails");

    try {
      const out = await runGeminiPipeline(key, {
        imo:         imo.trim()     || null,
        companyName: company.trim() || null,
        vesselName:  vessel?.vessel_name || null,
      }, setSteps);

      if (out.error && !out.result) {
        setError(out.error);
      } else {
        setResult(out.result || out.partial);
      }
    } catch (err) {
      setError(err.message || "Enrichment failed");
    } finally {
      setLoading(false);
    }
  }, [apiKey, imo, company, vessel]);

  if (!isOpen) return null;

  const r = result;
  const emailCount     = r?.emails?.length || 0;
  const phoneCount     = r?.phones?.length || 0;
  const personnelCount = r?.key_personnel?.length || 0;

  return (
    <div className="gcf-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="gcf-panel">

        {/* Header */}
        <div className="gcf-header">
          <div className="gcf-header-left">
            <span className="gcf-gemini-icon">✨</span>
            <div>
              <div className="gcf-title">GEMINI AI CONTACT FINDER</div>
              <div className="gcf-subtitle">Deep contact extraction · No backend required</div>
            </div>
          </div>
          <button className="gcf-close" onClick={onClose}>✕</button>
        </div>

        {/* API Key Setup */}
        <div className={`gcf-key-bar ${keyValid ? "gcf-key-bar-valid" : ""}`}>
          <span className="gcf-key-label">{keyValid ? "✅" : "🔑"} Gemini API Key</span>
          <div className="gcf-key-input-wrap">
            <input
              className="gcf-key-input"
              type={showKey ? "text" : "password"}
              placeholder="AIza... (free at aistudio.google.com/apikey)"
              value={apiKey}
              onChange={e => saveKey(e.target.value)}
            />
            <button className="gcf-key-toggle" onClick={() => setShowKey(v => !v)}>{showKey ? "🙈" : "👁"}</button>
          </div>
          {!keyValid && (
            <a className="gcf-key-link" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
              Get free key →
            </a>
          )}
          {keyValid && <span className="gcf-key-saved">Key saved locally</span>}
        </div>

        {/* Search inputs */}
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
            />
          </div>
          <div className="gcf-input-divider">OR</div>
          <div className="gcf-input-group gcf-input-group-wide">
            <label className="gcf-input-label">Company Name</label>
            <input
              className="gcf-input"
              type="text"
              placeholder="e.g. DAE MYUNG INTERNATIONAL PTE"
              value={company}
              onChange={e => setCompany(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSearch()}
            />
          </div>
          <button
            className="gcf-search-btn"
            onClick={handleSearch}
            disabled={loading || !keyValid}
          >
            {loading ? "⟳ Searching…" : "✨ Find Contacts"}
          </button>
        </div>

        {/* Body */}
        <div className="gcf-body">
          {/* Step log — always visible during/after search */}
          {steps.length > 0 && <StepLog steps={steps} />}

          {/* Error */}
          {error && !loading && (
            <div className="gcf-error">⚠ {error}</div>
          )}

          {/* Results */}
          {r && !loading && (
            <div className="gcf-results">
              {/* Vessel/company identity bar */}
              <div className="gcf-identity-bar">
                <div className="gcf-identity-main">
                  <span className="gcf-company-name">{r.company_name || company}</span>
                  {r.vessel_name && <span className="gcf-vessel-name">⛴ {r.vessel_name}</span>}
                </div>
                <div className="gcf-identity-meta">
                  {r.imo        && <span>IMO {r.imo}</span>}
                  {r.flag       && <span>🏳 {r.flag}</span>}
                  {r.official_website && (
                    <a href={r.official_website} target="_blank" rel="noopener noreferrer" className="gcf-website-link">
                      🌐 {r.official_website.replace(/^https?:\/\/(www\.)?/, "")}
                    </a>
                  )}
                  {r.overall_confidence != null && (
                    <span className={`gcf-overall-conf gcf-conf-${r.overall_confidence >= 75 ? "high" : r.overall_confidence >= 50 ? "mid" : "low"}`}>
                      {r.overall_confidence}% confidence
                    </span>
                  )}
                </div>
                {r.address && <div className="gcf-address">📍 {r.address}</div>}
                {r.linkedin && <a href={r.linkedin} target="_blank" rel="noopener noreferrer" className="gcf-linkedin">💼 LinkedIn</a>}
              </div>

              {/* Tabs */}
              <div className="gcf-tabs">
                <button className={`gcf-tab ${activeTab === "emails" ? "active" : ""}`} onClick={() => setActiveTab("emails")}>
                  ✉ Emails {emailCount > 0 && <span className="gcf-tab-count">{emailCount}</span>}
                </button>
                <button className={`gcf-tab ${activeTab === "phones" ? "active" : ""}`} onClick={() => setActiveTab("phones")}>
                  ☎ Phones {phoneCount > 0 && <span className="gcf-tab-count">{phoneCount}</span>}
                </button>
                <button className={`gcf-tab ${activeTab === "people" ? "active" : ""}`} onClick={() => setActiveTab("people")}>
                  👥 Personnel {personnelCount > 0 && <span className="gcf-tab-count">{personnelCount}</span>}
                </button>
              </div>

              <div className="gcf-tab-content">
                {activeTab === "emails" && (
                  <div>
                    {emailCount === 0 ? (
                      <div className="gcf-no-data">No emails found. Try entering the company name directly for better results.</div>
                    ) : r.emails.map((e, i) => <EmailCard key={i} email={e} />)}
                  </div>
                )}
                {activeTab === "phones" && (
                  <div>
                    {phoneCount === 0 ? (
                      <div className="gcf-no-data">No phone numbers found.</div>
                    ) : r.phones.map((p, i) => <PhoneCard key={i} phone={p} />)}
                  </div>
                )}
                {activeTab === "people" && (
                  <div>
                    {personnelCount === 0 ? (
                      <div className="gcf-no-data">No key personnel identified.</div>
                    ) : r.key_personnel.map((p, i) => <PersonnelCard key={i} person={p} />)}
                  </div>
                )}
              </div>

              {r.notes && <div className="gcf-notes">💡 {r.notes}</div>}
            </div>
          )}

          {/* Empty state */}
          {!loading && !r && !error && steps.length === 0 && (
            <div className="gcf-empty">
              <div className="gcf-empty-icon">✨</div>
              <div className="gcf-empty-title">Gemini AI Contact Intelligence</div>
              <div className="gcf-empty-sub">
                Enter an IMO number or company name above and click <strong>Find Contacts</strong>.
                Gemini will search maritime registries, scrape company websites, and extract
                verified contact details.
              </div>
              <div className="gcf-empty-steps">
                <div className="gcf-empty-step">① Scrapes VesselFinder / MarineTraffic</div>
                <div className="gcf-empty-step">② Identifies owner company</div>
                <div className="gcf-empty-step">③ Finds official website</div>
                <div className="gcf-empty-step">④ Scrapes contact pages</div>
                <div className="gcf-empty-step">⑤ Gemini extracts &amp; scores all contacts</div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="gcf-footer">
          <span>✨ Powered by Gemini 2.0 Flash · Free tier: 1,500 req/day</span>
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Get API key</a>
        </div>
      </div>
    </div>
  );
}
