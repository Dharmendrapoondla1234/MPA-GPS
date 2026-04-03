// src/services/intelligence/geminiEnricher.js — v2 (Enhanced accuracy)
// Gemini AI-Powered Contact Enrichment Engine
// Enhancements: better prompts, structured output validation, confidence calibration,
//               web grounding with multiple search strategies, retry logic
"use strict";

const logger = require("../../utils/logger");
const { HTTP_TIMEOUT_MS } = require("../../config");

const GEMINI_MODEL = "gemini-2.0-flash";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || null;
}

async function safeFetch(url, opts = {}, ms = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml,*/*",
        ...opts.headers,
      },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── Gemini API caller ─────────────────────────────────────────────────────────

async function callGemini(prompt, systemInstruction = null, maxTokens = 1500) {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn("[gemini] No GEMINI_API_KEY set — skipping Gemini enrichment");
    return null;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.05,          // lowered from 0.1 for more deterministic output
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
    },
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  // Retry once on transient errors
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(28000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        logger.warn(`[gemini] API error ${res.status}: ${errText.slice(0, 200)}`);
        if (res.status === 429 && attempt === 0) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        return null;
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return null;

      try {
        return JSON.parse(text);
      } catch {
        const match = /```(?:json)?\s*([\s\S]+?)\s*```/.exec(text);
        if (match) {
          try { return JSON.parse(match[1]); } catch {}
        }
        logger.warn("[gemini] Could not parse JSON response:", text.slice(0, 200));
        return null;
      }
    } catch (err) {
      logger.warn("[gemini] fetch error:", err.message?.slice(0, 100));
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return null;
}

// ── Web content fetcher for Gemini grounding ──────────────────────────────────

async function fetchPageText(url, ms = 10000) {
  try {
    const res = await safeFetch(url, {}, ms);
    if (!res?.ok) return null;
    const html = await res.text();
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8000);
  } catch {
    return null;
  }
}

// ── DuckDuckGo search helper ──────────────────────────────────────────────────

async function duckduckgoSearchText(query, maxChars = 3000) {
  try {
    const q   = encodeURIComponent(query);
    const res = await safeFetch(
      `https://api.duckduckgo.com/?q=${q}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
      { headers: { Referer: "https://duckduckgo.com/" } },
      10000,
    );
    if (!res?.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json) return null;
    const parts = [
      json.AbstractText,
      ...(json.RelatedTopics || []).map(t => t.Text || t.Result || ""),
      ...(json.Results || []).map(r => r.Text || ""),
    ].filter(Boolean);
    return parts.join(" ").slice(0, maxChars) || null;
  } catch {
    return null;
  }
}

// NEW: Bing search text for more grounding coverage
async function bingSearchText(query, maxChars = 3000) {
  try {
    const q   = encodeURIComponent(query);
    const res = await safeFetch(
      `https://www.bing.com/search?q=${q}&count=5`,
      { headers: { Referer: "https://www.bing.com/" } },
      10000,
    );
    if (!res?.ok) return null;
    const html = await res.text();
    // Extract snippet text from Bing results
    const snippets = [];
    const re = /<p class="b_algoSlug"[^>]*>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      snippets.push(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    }
    return snippets.join(" ").slice(0, maxChars) || null;
  } catch {
    return null;
  }
}

// ── Validate Gemini-returned emails ──────────────────────────────────────────
// NEW: Basic sanity-check on Gemini's email output before adding to pipeline

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const JUNK_RE  = /example|yourdomain|noreply|no-reply|test@|demo@|placeholder/i;

function validateGeminiEmails(emails, domain) {
  if (!Array.isArray(emails)) return [];
  return emails
    .filter(e => {
      if (!e?.email || typeof e.email !== "string") return false;
      if (!EMAIL_RE.test(e.email)) return false;
      if (JUNK_RE.test(e.email)) return false;
      // If we know the domain, reject emails from a completely different domain
      if (domain && !e.email.toLowerCase().endsWith(`@${domain}`)) {
        // Allow if confidence is high (Gemini may have found an alternate domain)
        return (e.confidence || 0) >= 70;
      }
      return true;
    })
    .map(e => ({
      email      : e.email.toLowerCase().trim(),
      confidence : Math.min(Math.max(e.confidence || 55, 0), 85), // cap Gemini confidence at 85
      source     : "gemini_ai",
    }));
}

// ── Main enrichment function ──────────────────────────────────────────────────

async function enrichCompanyWithGemini(companyName, knownDomain = null) {
  if (!companyName || !getApiKey()) return null;
  logger.info(`[gemini] enriching: "${companyName}" domain=${knownDomain || "?"}`);

  // Gather web evidence from multiple sources for better grounding
  const [ddgText, bingText, pageText] = await Promise.all([
    duckduckgoSearchText(`"${companyName}" shipping maritime contact email phone`),
    bingSearchText(`"${companyName}" maritime official website contact`),
    knownDomain ? fetchPageText(`https://${knownDomain}/contact`).catch(() => null) : Promise.resolve(null),
  ]);

  const evidence = [
    ddgText  ? `[DuckDuckGo]: ${ddgText}`  : null,
    bingText ? `[Bing]: ${bingText}`        : null,
    pageText ? `[Website /contact]: ${pageText}` : null,
  ].filter(Boolean).join("\n\n").slice(0, 10000);

  const system = `You are a maritime industry data expert with deep knowledge of shipping companies worldwide.
Your task is to extract and validate contact information for maritime companies.
Return ONLY valid JSON. Do not guess or hallucinate email addresses.
If you are not confident about a piece of information, omit it or set confidence < 60.`;

  const prompt = `Extract contact information for maritime company: "${companyName}"
${knownDomain ? `Known website domain: ${knownDomain}` : ""}

Web evidence:
${evidence || "(no web evidence available — use training knowledge only if highly confident)"}

Return this exact JSON structure:
{
  "company_name": "exact company name",
  "website": "domain.com (no https/www)",
  "emails": [
    {"email": "contact@domain.com", "confidence": 75, "role": "general contact"},
    {"email": "ops@domain.com", "confidence": 70, "role": "operations"}
  ],
  "phones": ["+1-234-567-8900"],
  "address": "full office address",
  "key_personnel": [
    {"name": "John Smith", "title": "Managing Director", "email": "j.smith@domain.com"}
  ],
  "confidence": 75,
  "notes": "brief note on data source/reliability"
}

Rules:
- emails array: only include addresses you found in the evidence or are very certain about
- confidence: 80+ = found in evidence, 60-79 = inferred from patterns, <60 = uncertain
- website: domain only (e.g. "maersk.com" not "https://www.maersk.com")
- if uncertain about any field, omit it rather than guess
- max 6 emails`;

  const result = await callGemini(prompt, system, 1200);
  if (!result) return null;

  // Validate and sanitize output
  const domain = knownDomain || result.website || null;
  return {
    company_name  : result.company_name || companyName,
    website       : result.website      || null,
    emails        : validateGeminiEmails(result.emails || [], domain),
    phones        : Array.isArray(result.phones) ? result.phones.filter(p => typeof p === "string" && p.length > 5).slice(0, 4) : [],
    address       : typeof result.address === "string" && result.address.length > 5 ? result.address : null,
    key_personnel : Array.isArray(result.key_personnel) ? result.key_personnel.slice(0, 5) : [],
    linkedin      : result.linkedin || null,
    confidence    : Math.min(result.confidence || 50, 85),
    notes         : result.notes   || null,
    source        : "gemini_ai",
  };
}

// ── Gemini: IMO → Company lookup ──────────────────────────────────────────────

async function lookupVesselByIMO(imo, vesselName = null) {
  if (!imo || !getApiKey()) return null;
  logger.info(`[gemini] IMO lookup: ${imo}`);

  const [ddgText, bingText] = await Promise.all([
    duckduckgoSearchText(`IMO ${imo} vessel ship owner company ${vesselName || ""}`),
    bingSearchText(`IMO number ${imo} registered owner ship manager`),
  ]);

  const evidence = [ddgText, bingText].filter(Boolean).join("\n\n").slice(0, 6000);

  const system = `You are a maritime data expert. Extract vessel ownership data from evidence. Return only valid JSON.
Only include company names you can confirm from the evidence. Do not guess.`;

  const prompt = `Find the registered owner and ISM manager for vessel with IMO number: ${imo}${vesselName ? ` (vessel name: ${vesselName})` : ""}

Web search evidence:
${evidence || "(no web evidence — use training knowledge only if IMO is well-known)"}

Return JSON:
{
  "vessel_name": "...",
  "imo": "${imo}",
  "flag": "country",
  "vessel_type": "...",
  "registered_owner": "company name or null",
  "ism_manager": "company name or null",
  "ship_manager": "company name or null",
  "operator": "company name or null",
  "confidence": 70,
  "source": "evidence|training"
}

If confidence < 50, set all company fields to null.`;

  return await callGemini(prompt, system, 500);
}

// ── Gemini: Domain verification ───────────────────────────────────────────────

async function verifyOrFindDomain(companyName, candidates = []) {
  if (!companyName || !getApiKey()) return null;

  const [ddgText, bingText] = await Promise.all([
    duckduckgoSearchText(`"${companyName}" official website domain`),
    bingSearchText(`"${companyName}" official maritime website`),
  ]);
  const evidence = [ddgText, bingText].filter(Boolean).join("\n\n").slice(0, 4000);

  const system = `You are a web research expert. Find the official website domain for companies. Return only JSON.
Only return domains you found in the evidence. Do not guess or hallucinate domains.`;

  const prompt = `What is the official website domain for: "${companyName}"
${candidates.length ? `Candidate domains to verify: ${candidates.join(", ")}` : ""}

Search evidence:
${evidence || "(none)"}

Return JSON:
{
  "domain": "example.com",
  "confidence": 85,
  "reason": "brief explanation of how you found it"
}

Rules:
- Return only the domain (no https://, no www.)
- If uncertain, set confidence < 50
- If not found in evidence, return {"domain": null, "confidence": 0, "reason": "not found in evidence"}
- Do not return aggregator sites (linkedin, marinetraffic, etc.)`;

  const result = await callGemini(prompt, system, 300);
  return result;
}

// ── Gemini: Port agent lookup ─────────────────────────────────────────────────

async function findPortAgentsWithGemini(portName, portCode = null, vesselType = null) {
  if (!portName || !getApiKey()) return null;

  const [ddgText, bingText] = await Promise.all([
    duckduckgoSearchText(`port agent ${portName} shipping maritime contact email`),
    bingSearchText(`ship agent ${portName} ${portCode || ""} maritime services`),
  ]);
  const evidence = [ddgText, bingText].filter(Boolean).join("\n\n").slice(0, 5000);

  const system = `You are a maritime port operations expert. Find port agent contacts. Return only valid JSON.
Only include agents found in the evidence.`;

  const prompt = `Find port agents operating at: ${portName}${portCode ? ` (${portCode})` : ""}${vesselType ? ` for ${vesselType} vessels` : ""}

Web evidence:
${evidence || "(none)"}

Return JSON array:
[
  {
    "agency_name": "...",
    "email": "...",
    "phone": "...",
    "website": "...",
    "services": ["tankers", "bulk"],
    "confidence": 80
  }
]

Only include agents that appear in the evidence. Return empty array [] if none found.`;

  const result = await callGemini(prompt, system, 800);
  if (!Array.isArray(result)) return [];
  return result.filter((a) => a.agency_name && (a.confidence || 0) >= 50).slice(0, 6); // min confidence filter
}

// ── Main enrichment pipeline with Gemini boost ────────────────────────────────

async function geminiBoostPipeline({ imo, owner, manager, operator, ship_manager }) {
  if (!getApiKey()) {
    return { boosted: false, reason: "No GEMINI_API_KEY configured" };
  }

  const companies = [
    { name: owner,        role: "owner" },
    { name: manager,      role: "manager" },
    { name: operator,     role: "operator" },
    { name: ship_manager, role: "ship_manager" },
  ].filter((c) => c.name && c.name.trim().length > 2);

  if (!companies.length) {
    if (imo) {
      const vesselData = await lookupVesselByIMO(imo);
      if (vesselData?.registered_owner && (vesselData.confidence || 0) >= 55) {
        companies.push({ name: vesselData.registered_owner, role: "owner" });
      }
      if (vesselData?.ism_manager && (vesselData.confidence || 0) >= 55) {
        companies.push({ name: vesselData.ism_manager, role: "manager" });
      }
    }
    if (!companies.length) {
      return { boosted: false, reason: "No company names available" };
    }
  }

  const results = [];

  for (const co of companies) {
    try {
      const data = await enrichCompanyWithGemini(co.name, null);
      if (data && (data.emails?.length || data.website)) {
        results.push({
          company        : co.name,
          role           : co.role,
          domain         : data.website,
          domain_confidence: data.website ? data.confidence : 0,
          domain_method  : "gemini_ai",
          domain_title   : null,
          emails         : data.emails || [],
          phones         : data.phones || [],
          addresses      : data.address ? [data.address] : [],
          key_personnel  : data.key_personnel || [],
          scraped        : false,
          mx_exists      : false,
          boosted_by     : "gemini",
          gemini_notes   : data.notes,
        });
      }
    } catch (err) {
      logger.warn(`[gemini-boost] "${co.name}": ${err.message}`);
    }
  }

  const allEmails = results.flatMap((r) => r.emails);
  const allPhones = [...new Set(results.flatMap((r) => r.phones))];

  return {
    boosted     : results.length > 0,
    companies   : results,
    top_contacts: allEmails.sort((a, b) => b.confidence - a.confidence).slice(0, 10),
    top_phones  : allPhones.slice(0, 6),
  };
}

module.exports = {
  enrichCompanyWithGemini,
  lookupVesselByIMO,
  verifyOrFindDomain,
  findPortAgentsWithGemini,
  geminiBoostPipeline,
  callGemini,
};
