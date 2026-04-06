// src/routes/ai_agents.js — Agentic AI Engine v2
// Multi-step AI agents: vessel research, CRM email, fleet optimizer, contact extraction
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");

const GEMINI_MODEL = "gemini-2.0-flash";
const CLAUDE_MODEL = "claude-sonnet-4-5-20251022";

function getGeminiKey()    { return process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || ""; }
function getAnthropicKey() { return process.env.ANTHROPIC_API_KEY || ""; }

// ── Robust Gemini caller ─────────────────────────────────────────
async function callGemini(system, user, maxTokens = 1200) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: String(user) }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens, responseMimeType: "text/plain" },
  };
  if (system) body.systemInstruction = { parts: [{ text: String(system) }] };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 150)}`);
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = json?.candidates?.[0]?.finishReason || "UNKNOWN";
    throw new Error(`Gemini empty response, finishReason: ${reason}`);
  }
  return text;
}

// ── Claude caller ────────────────────────────────────────────────
async function callClaude(system, user, maxTokens = 1200) {
  const apiKey = getAnthropicKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: String(user) }],
  };
  if (system) body.system = String(system);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Claude ${res.status}: ${errText.slice(0, 150)}`);
  }
  const json = await res.json();
  const text = json?.content?.[0]?.text;
  if (!text) throw new Error("Claude returned empty response");
  return text;
}

// ── Unified LLM (Gemini → Claude → error with details) ──────────
async function llm(system, user, maxTokens = 1200) {
  let geminiErr = null;

  if (getGeminiKey()) {
    try {
      const text = await callGemini(system, user, maxTokens);
      return { text, provider: "gemini" };
    } catch (e) {
      geminiErr = e.message;
      logger.warn(`[agent] Gemini failed: ${e.message}`);
    }
  }

  if (getAnthropicKey()) {
    try {
      const text = await callClaude(system, user, maxTokens);
      return { text, provider: "claude" };
    } catch (e) {
      logger.warn(`[agent] Claude failed: ${e.message}`);
      throw new Error(`All AI providers failed. Gemini: ${geminiErr || "not configured"}. Claude: ${e.message}`);
    }
  }

  const geminiStatus = getGeminiKey() ? `failed (${geminiErr})` : "GEMINI_API_KEY not set";
  throw new Error(`No AI provider available. Gemini: ${geminiStatus}. ANTHROPIC_API_KEY: ${getAnthropicKey() ? "set but failed" : "not set"}.`);
}

// ── JSON parser ──────────────────────────────────────────────────
function parseJSON(raw) {
  try {
    const m = /```json\s*([\s\S]+?)\s*```/i.exec(raw) || /([\{\[][\s\S]*[\}\]])/s.exec(raw);
    return m ? JSON.parse(m[1]) : null;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/vessel-research
// 3-step: profile → commercial intel → strategic recommendations
// ══════════════════════════════════════════════════════════════════
router.post("/vessel-research", async (req, res, next) => {
  try {
    const { vessel } = req.body || {};
    if (!vessel?.imo_number) return res.status(400).json({ success: false, error: "vessel.imo_number required" });

    const steps = [];

    // Step 1 — Vessel profile
    const s1 = await llm(
      "You are a maritime intelligence agent. Analyse vessel data and return ONLY valid JSON.",
      `Analyse: ${JSON.stringify(vessel, null, 2)}\n\nReturn ONLY JSON:\n{"profile_summary":"...","vessel_category":"...","operational_risk":"low|medium|high","risk_factors":["..."],"flag_state_notes":"...","age_assessment":"...","tonnage_class":"..."}`,
      700
    );
    const profile = parseJSON(s1.text) || { profile_summary: s1.text.slice(0, 300), operational_risk: "medium" };
    steps.push({ step: 1, title: "Vessel Profile Analysis", provider: s1.provider, result: profile });

    // Step 2 — Commercial intelligence
    const s2 = await llm(
      "You are a maritime commercial intelligence agent. Return ONLY valid JSON.",
      `Vessel: ${vessel.vessel_name} (${vessel.vessel_type||"unknown"}), Flag: ${vessel.flag||"unknown"}, Built: ${vessel.year_built||"unknown"}, DWT: ${vessel.deadweight||"unknown"}, Status: ${vessel.vessel_status||"unknown"}, Dest: ${vessel.next_port_destination||"unknown"}.\n\nReturn ONLY JSON:\n{"market_segment":"...","typical_cargo":"...","charter_market_notes":"...","outreach_opportunity":"...","value_to_operator":"..."}`,
      700
    );
    const commercial = parseJSON(s2.text) || { market_segment: s2.text.slice(0, 200) };
    steps.push({ step: 2, title: "Commercial Intelligence", provider: s2.provider, result: commercial });

    // Step 3 — Strategic recommendations
    const s3 = await llm(
      "You are a maritime business development strategist. Return ONLY valid JSON.",
      `Profile: ${JSON.stringify(profile)}\nCommercial: ${JSON.stringify(commercial)}\n\nReturn ONLY JSON:\n{"priority_actions":["..."],"email_strategy":"...","best_contact_timing":"...","value_proposition":"...","risk_mitigation":["..."],"confidence_score":0}`,
      700
    );
    const recommendations = parseJSON(s3.text) || { priority_actions: [s3.text.slice(0, 200)] };
    steps.push({ step: 3, title: "Strategic Recommendations", provider: s3.provider, result: recommendations });

    res.json({
      success: true,
      vessel_name: vessel.vessel_name,
      imo: vessel.imo_number,
      steps,
      providers_used: [...new Set(steps.map(s => s.provider))],
    });
  } catch (err) {
    logger.error("[agent-vessel-research]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/crm-email
// 3-step agentic email: persona analysis → draft → quality refine
// ══════════════════════════════════════════════════════════════════
router.post("/crm-email", async (req, res, next) => {
  try {
    const { vessel, sender, recipient, persona, context, intent } = req.body || {};
    if (!sender || !recipient) return res.status(400).json({ success: false, error: "sender and recipient required" });

    const steps = [];

    // Step 1 — Persona analysis
    const s1 = await llm(
      "You are a CRM communication strategist. Analyse sender/recipient and return ONLY valid JSON.",
      `Sender: ${JSON.stringify(sender)}\nRecipient: ${JSON.stringify(recipient)}\nPersona: ${JSON.stringify(persona||{})}\n\nReturn ONLY JSON:\n{"communication_style":"...","key_pain_points":["..."],"motivators":["..."],"opening_strategy":"...","tone_guidance":"...","best_hook":"..."}`,
      600
    );
    const analysis = parseJSON(s1.text) || {};
    steps.push({ step: 1, title: "Persona Analysis", provider: s1.provider, result: analysis });

    // Step 2 — Email draft
    const vesselCtx = vessel
      ? `Vessel: ${vessel.vessel_name} (IMO ${vessel.imo_number}), ${vessel.vessel_type||""}, status: ${vessel.vessel_status||""}, destination: ${vessel.next_port_destination||"unknown"}`
      : "";

    const s2 = await llm(
      "You are a maritime sales email specialist. Write highly personalised emails. Return ONLY valid JSON.",
      `FROM: ${sender.name} (${sender.role||""} at ${sender.company||""})\nTO: ${recipient.company_name} — ${recipient.role||""}\n${vesselCtx}\nINTENT: ${intent||"business outreach"}\nSTRATEGY: ${JSON.stringify(analysis)}\nCONTEXT: ${context||"none"}\n\nReturn ONLY JSON:\n{"subject":"...","body":"...","key_selling_points":["..."],"call_to_action":"..."}`,
      900
    );
    const draft = parseJSON(s2.text) || { subject: `Follow Up — ${recipient.company_name}`, body: s2.text };
    steps.push({ step: 2, title: "Email Draft", provider: s2.provider, result: draft });

    // Step 3 — Quality refinement
    const s3 = await llm(
      "You are an email quality agent. Improve this maritime email for maximum impact. Return ONLY valid JSON.",
      `Review and improve:\nSUBJECT: ${draft.subject}\nBODY: ${draft.body}\n\nEnsure: specific vessel details, clear value prop, professional maritime tone, strong CTA, 150-250 words.\n\nReturn ONLY JSON:\n{"subject":"...","body":"...","improvements_made":["..."],"quality_score":0,"send_confidence":"high|medium|low"}`,
      900
    );
    const refined = parseJSON(s3.text) || draft;
    steps.push({ step: 3, title: "Quality Refinement", provider: s3.provider, result: refined });

    res.json({
      success: true,
      subject: refined.subject || draft.subject,
      body: refined.body || draft.body,
      quality_score: refined.quality_score || 80,
      send_confidence: refined.send_confidence || "medium",
      improvements: refined.improvements_made || [],
      steps,
    });
  } catch (err) {
    logger.error("[agent-crm-email]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/fleet-optimize
// 3-step fleet optimization
// ══════════════════════════════════════════════════════════════════
router.post("/fleet-optimize", async (req, res, next) => {
  try {
    const { vessels = [], stats = {} } = req.body || {};
    if (!vessels.length) return res.status(400).json({ success: false, error: "vessels array required" });

    const sample = vessels.slice(0, 30).map(v => ({
      name: v.vessel_name, type: v.vessel_type, speed: v.speed,
      status: v.vessel_status, flag: v.flag, dest: v.next_port_destination, stale: v.is_stale,
    }));

    const steps = [];

    const s1 = await llm(
      "You are a fleet operations AI agent. Return ONLY valid JSON.",
      `Fleet (${vessels.length} vessels): ${JSON.stringify(sample)}\nStats: ${JSON.stringify(stats)}\n\nReturn ONLY JSON:\n{"health_score":0,"active_vessels":0,"stale_signals":0,"top_concerns":["..."],"traffic_patterns":"...","congestion_hotspots":["..."]}`,
      700
    );
    const health = parseJSON(s1.text) || { health_score: 70, top_concerns: ["Unable to analyse — check AI configuration"] };
    steps.push({ step: 1, title: "Fleet Health Assessment", provider: s1.provider, result: health });

    const s2 = await llm(
      "You are a maritime route and fuel optimisation agent. Return ONLY valid JSON.",
      `Health: ${JSON.stringify(health)}, ${vessels.length} vessels.\n\nReturn ONLY JSON:\n{"fuel_savings_potential_percent":0,"route_optimizations":["..."],"speed_recommendations":["..."],"scheduling_improvements":["..."],"estimated_cost_savings_usd_monthly":0,"co2_reduction_tons_monthly":0}`,
      700
    );
    const optimizations = parseJSON(s2.text) || {};
    steps.push({ step: 2, title: "Optimisation Opportunities", provider: s2.provider, result: optimizations });

    const s3 = await llm(
      "You are a maritime strategic planning agent. Return ONLY valid JSON.",
      `Health: ${JSON.stringify(health)}\nOptimisations: ${JSON.stringify(optimizations)}\n\nReturn ONLY JSON:\n{"week1_actions":["..."],"week2_actions":["..."],"week3_4_actions":["..."],"kpis_to_track":["..."],"expected_roi":"...","priority_vessels":["..."]}`,
      800
    );
    const plan = parseJSON(s3.text) || {};
    steps.push({ step: 3, title: "30-Day Action Plan", provider: s3.provider, result: plan });

    res.json({ success: true, vessel_count: vessels.length, health, optimizations, action_plan: plan, steps });
  } catch (err) {
    logger.error("[agent-fleet-optimize]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/contact-extract
// AI contact extraction from Equasis/vessel data
// ══════════════════════════════════════════════════════════════════
router.post("/contact-extract", async (req, res, next) => {
  try {
    const { vessel, raw_data } = req.body || {};
    if (!vessel) return res.status(400).json({ success: false, error: "vessel required" });

    const { text } = await llm(
      "You are a maritime contact extraction agent. Extract structured contacts. Return ONLY valid JSON array.",
      `Extract all contacts for vessel: ${vessel.vessel_name} (IMO: ${vessel.imo_number})\nVessel data: ${JSON.stringify(raw_data || vessel, null, 2)}\n\nReturn ONLY a JSON array:\n[{"role":"Owner|Operator|Manager|Ship Manager|Agent","company_name":"...","email":"...","phone":"...","website":"...","address":"...","confidence":0}]`,
      800
    );

    let contacts = [];
    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      if (Array.isArray(parsed)) contacts = parsed.filter(c => c.company_name || c.email);
    } catch {
      // Try to extract from the text as fallback
      const matches = text.match(/"company_name"\s*:\s*"([^"]+)"/g) || [];
      contacts = matches.map(m => ({ company_name: m.replace(/"company_name"\s*:\s*"/, "").replace(/"$/, ""), role: "Contact" }));
    }

    res.json({ success: true, vessel: vessel.vessel_name, contacts, raw_count: contacts.length });
  } catch (err) {
    logger.error("[agent-contact-extract]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/smart-reply
// Generate smart email reply suggestions
// ══════════════════════════════════════════════════════════════════
router.post("/smart-reply", async (req, res, next) => {
  try {
    const { received_email, vessel, sender } = req.body || {};
    if (!received_email) return res.status(400).json({ success: false, error: "received_email required" });

    const { text } = await llm(
      "You are a maritime email response agent. Generate professional reply options. Return ONLY valid JSON.",
      `Generate 3 reply options for:\n\n${received_email}\n\nSender: ${sender?.name||"maritime professional"} at ${sender?.company||"shipping company"}. ${vessel ? `Re: vessel ${vessel.vessel_name}` : ""}\n\nReturn ONLY JSON:\n{"replies":[{"tone":"formal","subject":"Re: ...","body":"..."},{"tone":"concise","subject":"Re: ...","body":"..."},{"tone":"detailed","subject":"Re: ...","body":"..."}]}`,
      900
    );

    const parsed = parseJSON(text) || { replies: [] };
    res.json({ success: true, replies: parsed.replies || [] });
  } catch (err) {
    logger.error("[agent-smart-reply]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
