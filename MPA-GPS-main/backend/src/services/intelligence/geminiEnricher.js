// src/services/intelligence/geminiEnricher.js — v1
// Gemini AI-Powered Contact Enrichment Engine
// Uses Google Gemini to extract and validate contact details for maritime companies
// Integrates as a fallback + booster in the main intelligence pipeline
"use strict";

const logger = require("../../utils/logger");
const { HTTP_TIMEOUT_MS } = require("../../config");

const GEMINI_MODEL = "gemini-2.0-flash"; // Fast and cheap

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
      temperature: 0.1,
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
    },
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      logger.warn(`[gemini] API error ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    // Parse JSON response
    try {
      return JSON.parse(text);
    } catch {
      // Try to extract JSON from markdown code blocks
      const match = /```(?:json)?\s*([\s\S]+?)\s*```/.exec(text);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch {}
      }
      logger.warn("[gemini] Could not parse JSON response:", text.slice(0, 200));
      return null;
    }
  } catch (err) {
    logger.warn("[gemini] fetch error:", err.message?.slice(0, 100));
    return null;
  }
}

// ── Web content fetcher for Gemini grounding ─────────────────────────────────

async function fetchPageText(url, ms = 10000) {
  try {
    const res = await safeFetch(url, {}, ms);
    if (!res?.ok) return null;
    const html = await res.text();
    // Strip tags, get clean text
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8000); // Keep first 8000 chars for Gemini
  } catch {
    return null;
  }
}

// ── DuckDuckGo search (no key needed) ────────────────────────────────────────

async function duckduckgoSearchText(query) {
  try {
    const q = encodeURIComponent(query);
    const res = await safeFetch(
      `https://html.duckduckgo.com/html/?q=${q}`,
      { headers: { Referer: "https://duckduckgo.com/" } },
      10000
    );
    if (!res?.ok) return null;
    const html = await res.text();
    return html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 6000);
  } catch {
    return null;
  }
}

// ── Core: Gemini contact extraction from company name ────────────────────────

/**
 * Use Gemini to find contact details for a maritime company.
 * Returns { emails, phones, website, address, confidence, source }
 */
async function enrichCompanyWithGemini(companyName, existingDomain = null) {
  if (!companyName || !getApiKey()) return null;

  logger.info(`[gemini] enriching: "${companyName}"`);

  // Step 1: Gather web evidence
  const searchText = await duckduckgoSearchText(
    `"${companyName}" shipping maritime company contact email website`
  );

  // Step 2: Try to fetch website content if we already know the domain
  let websiteText = null;
  if (existingDomain) {
    const urls = [
      `https://${existingDomain}/contact`,
      `https://${existingDomain}/contact-us`,
      `https://${existingDomain}/contacts`,
      `https://${existingDomain}/about`,
      `https://${existingDomain}`,
    ];
    for (const url of urls) {
      websiteText = await fetchPageText(url, 8000);
      if (websiteText && websiteText.length > 200) break;
    }
  }

  // Step 3: Build Gemini prompt with all evidence
  const system = `You are a maritime intelligence expert. Extract factual company contact information only.
Return ONLY valid JSON, no markdown, no explanation.
Only include data that appears in the provided text evidence — do not hallucinate.
Confidence: 0-100 based on how clearly the data appears in evidence.`;

  const evidence = [
    searchText ? `=== SEARCH RESULTS ===\n${searchText}` : "",
    websiteText ? `=== WEBSITE CONTENT ===\n${websiteText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = `Find contact details for this maritime company: "${companyName}"

${evidence ? `Evidence from web:\n${evidence}` : "No web evidence available — use your training knowledge if confident."}

Return JSON in this exact format:
{
  "company_name": "...",
  "official_website": "example.com or null",
  "emails": ["email1@domain.com", "email2@domain.com"],
  "phones": ["+1234567890", "..."],
  "address": "full address or null",
  "linkedin": "linkedin URL or null",
  "key_personnel": [
    {"name": "...", "role": "Fleet Manager", "email": "... or null"}
  ],
  "confidence": 85,
  "notes": "brief note about data quality"
}

Rules:
- Only include emails that actually appear in the evidence text
- Do NOT generate fake emails
- If no emails found, return empty array
- official_website should be just the domain (no https://)
- confidence = how sure you are the data is correct (0-100)`;

  const result = await callGemini(prompt, system, 1000);

  if (!result) return null;

  // Validate and clean results
  const emails = (result.emails || [])
    .filter((e) => typeof e === "string" && e.includes("@") && e.includes(".") && e.length < 80)
    .map((e) => e.toLowerCase().trim());

  const phones = (result.phones || [])
    .filter((p) => typeof p === "string" && p.replace(/\D/g, "").length >= 7)
    .slice(0, 3);

  const website = result.official_website
    ? result.official_website
        .replace(/^https?:\/\/(www\.)?/, "")
        .split("/")[0]
        .toLowerCase()
    : existingDomain || null;

  logger.info(
    `[gemini] "${companyName}": emails=${emails.length} website=${website || "—"} conf=${result.confidence || 0}`
  );

  return {
    emails: emails.map((e) => ({
      email: e,
      confidence: Math.min(Math.round((result.confidence || 50) * 0.9), 90),
      source: "gemini_ai",
      smtp_valid: null,
    })),
    phones,
    website,
    address: result.address || null,
    linkedin: result.linkedin || null,
    key_personnel: result.key_personnel || [],
    confidence: result.confidence || 50,
    notes: result.notes || null,
    source: "gemini_ai",
  };
}

// ── Gemini: IMO → Company lookup ─────────────────────────────────────────────

/**
 * Ask Gemini to identify the company managing a vessel by IMO number.
 * Uses web search grounding.
 */
async function lookupVesselByIMO(imo, vesselName = null) {
  if (!imo || !getApiKey()) return null;

  logger.info(`[gemini] IMO lookup: ${imo}`);

  // Gather web evidence
  const searchText = await duckduckgoSearchText(
    `IMO ${imo} vessel ship owner company ${vesselName || ""}`
  );

  const system = `You are a maritime data expert. Extract vessel ownership data from evidence. Return only valid JSON.`;

  const prompt = `Find the registered owner and ISM manager for vessel with IMO number: ${imo}${vesselName ? ` (vessel name: ${vesselName})` : ""}

Web search evidence:
${searchText || "(no web evidence — use training knowledge if confident)"}

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
  "confidence": 70
}`;

  return await callGemini(prompt, system, 500);
}

// ── Gemini: Domain verification ───────────────────────────────────────────────

/**
 * Ask Gemini to confirm or find the official domain for a company.
 */
async function verifyOrFindDomain(companyName, candidates = []) {
  if (!companyName || !getApiKey()) return null;

  const searchText = await duckduckgoSearchText(`"${companyName}" official website domain`);

  const system = `You are a web research expert. Find the official website domain for companies. Return only JSON.`;

  const prompt = `What is the official website domain for: "${companyName}"

${candidates.length ? `Candidate domains to verify: ${candidates.join(", ")}` : ""}

Search evidence:
${searchText || "(none)"}

Return JSON:
{
  "domain": "example.com",
  "confidence": 85,
  "reason": "brief explanation"
}

Rules:
- Return only the domain (no https://, no www.)
- If uncertain, set confidence < 50
- If no domain found, return {"domain": null, "confidence": 0, "reason": "not found"}`;

  const result = await callGemini(prompt, system, 300);
  return result;
}

// ── Gemini: Port agent lookup ─────────────────────────────────────────────────

/**
 * Ask Gemini to find port agents for a specific port.
 */
async function findPortAgentsWithGemini(portName, portCode = null, vesselType = null) {
  if (!portName || !getApiKey()) return null;

  const searchText = await duckduckgoSearchText(
    `port agent ${portName} shipping maritime contact email`
  );

  const system = `You are a maritime port operations expert. Find port agent contacts. Return only valid JSON.`;

  const prompt = `Find port agents operating at: ${portName}${portCode ? ` (${portCode})` : ""}${vesselType ? ` for ${vesselType} vessels` : ""}

Web evidence:
${searchText || "(none)"}

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
  return result.filter((a) => a.agency_name).slice(0, 5);
}

// ── Main enrichment pipeline with Gemini boost ───────────────────────────────

/**
 * Full Gemini-boosted intelligence run for a set of companies.
 * Called when the standard pipeline finds no contacts or domain.
 */
async function geminiBoostPipeline({ imo, owner, manager, operator, ship_manager }) {
  if (!getApiKey()) {
    return { boosted: false, reason: "No GEMINI_API_KEY configured" };
  }

  const companies = [
    { name: owner, role: "owner" },
    { name: manager, role: "manager" },
    { name: operator, role: "operator" },
    { name: ship_manager, role: "ship_manager" },
  ].filter((c) => c.name && c.name.trim().length > 2);

  if (!companies.length) {
    // Try to identify from IMO first
    if (imo) {
      const vesselData = await lookupVesselByIMO(imo);
      if (vesselData?.registered_owner) {
        companies.push({ name: vesselData.registered_owner, role: "owner" });
      }
      if (vesselData?.ism_manager) {
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
      if (data) {
        results.push({
          company: co.name,
          role: co.role,
          domain: data.website,
          domain_confidence: data.website ? data.confidence : 0,
          domain_method: "gemini_ai",
          domain_title: null,
          emails: data.emails || [],
          phones: data.phones || [],
          addresses: data.address ? [data.address] : [],
          scraped: false,
          mx_exists: false,
          boosted_by: "gemini",
          gemini_notes: data.notes,
        });
      }
    } catch (err) {
      logger.warn(`[gemini-boost] "${co.name}": ${err.message}`);
    }
  }

  const allEmails = results.flatMap((r) => r.emails);
  const allPhones = [...new Set(results.flatMap((r) => r.phones))];

  return {
    boosted: results.length > 0,
    companies: results,
    top_contacts: allEmails.sort((a, b) => b.confidence - a.confidence).slice(0, 8),
    top_phones: allPhones.slice(0, 5),
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
