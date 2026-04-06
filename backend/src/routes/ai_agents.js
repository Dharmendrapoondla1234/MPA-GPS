// src/routes/ai_agents.js — Agentic AI Engine v3
// Free-tier Gemini compatible, no responseMimeType, system in user turn
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");

const GEMINI_MODEL = "gemini-2.0-flash";
const CLAUDE_MODEL = "claude-sonnet-4-5-20251022";

function getGeminiKey()    { return process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || ""; }
function getAnthropicKey() { return process.env.ANTHROPIC_API_KEY || ""; }

// ── Free-tier compatible Gemini caller ───────────────────────────
async function callGemini(system, user, maxTokens = 1200) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  // Embed system context in user message — works on all Gemini tiers
  const fullMessage = system ? `[SYSTEM]\n${system}\n\n[REQUEST]\n${user}` : user;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: fullMessage }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      ],
    }),
    signal: AbortSignal.timeout(35000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const json = await res.json();
  const candidate = json?.candidates?.[0];
  if (!candidate) {
    const blockReason = json?.promptFeedback?.blockReason;
    throw new Error(`Gemini: no candidates${blockReason ? ` (blocked: ${blockReason})` : ""}`);
  }
  if (candidate.finishReason === "SAFETY") throw new Error("Gemini: safety filter blocked response");

  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini: empty text (finishReason: ${candidate.finishReason || "UNKNOWN"})`);
  return text;
}

// ── Claude caller ─────────────────────────────────────────────────
async function callClaude(system, user, maxTokens = 1200) {
  const apiKey = getAnthropicKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const body = { model: CLAUDE_MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: user }] };
  if (system) body.system = system;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Claude ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = json?.content?.[0]?.text;
  if (!text) throw new Error("Claude: empty response");
  return text;
}

// ── Unified LLM (Gemini → Claude → descriptive error) ────────────
async function llm(system, user, maxTokens = 1200) {
  const errors = [];

  if (getGeminiKey()) {
    try {
      const text = await callGemini(system, user, maxTokens);
      return { text, provider: "gemini" };
    } catch (e) {
      errors.push(`Gemini: ${e.message}`);
      logger.warn(`[agent] Gemini: ${e.message}`);
    }
  } else {
    errors.push("Gemini: key not set");
  }

  if (getAnthropicKey()) {
    try {
      const text = await callClaude(system, user, maxTokens);
      return { text, provider: "claude" };
    } catch (e) {
      errors.push(`Claude: ${e.message}`);
      logger.warn(`[agent] Claude: ${e.message}`);
    }
  } else {
    errors.push("Claude: key not set");
  }

  throw new Error(`AI failed — ${errors.join(" | ")}`);
}

// ── JSON parser ───────────────────────────────────────────────────
function parseJSON(raw) {
  if (!raw) return null;
  try {
    const m = /```json\s*([\s\S]+?)\s*```/i.exec(raw)
           || /```\s*([\s\S]+?)\s*```/i.exec(raw)
           || /([\{\[][\s\S]*[\}\]])/s.exec(raw);
    return m ? JSON.parse(m[1]) : null;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/vessel-research  (3-step agent)
// ══════════════════════════════════════════════════════════════════
router.post("/vessel-research", async (req, res) => {
  try {
    const { vessel } = req.body || {};
    if (!vessel?.imo_number) return res.status(400).json({ success: false, error: "vessel.imo_number required" });

    const steps = [];

    // Step 1 — Profile
    const s1 = await llm(
      "Maritime intelligence analyst. Return ONLY valid JSON, no other text.",
      `Analyse vessel: ${JSON.stringify(vessel, null, 2)}\nReturn ONLY JSON:\n{"profile_summary":"...","vessel_category":"...","operational_risk":"low|medium|high","risk_factors":["..."],"flag_state_notes":"...","age_assessment":"...","tonnage_class":"..."}`,
      700
    );
    const profile = parseJSON(s1.text) || { profile_summary: s1.text.slice(0, 300), operational_risk: "medium" };
    steps.push({ step: 1, title: "Vessel Profile Analysis", provider: s1.provider, result: profile });

    // Step 2 — Commercial
    const s2 = await llm(
      "Maritime commercial intelligence analyst. Return ONLY valid JSON.",
      `Vessel: ${vessel.vessel_name} (${vessel.vessel_type||""}), Flag: ${vessel.flag||""}, Built: ${vessel.year_built||""}, DWT: ${vessel.deadweight||""}, Status: ${vessel.vessel_status||""}, Dest: ${vessel.next_port_destination||""}\nReturn ONLY JSON:\n{"market_segment":"...","typical_cargo":"...","charter_market_notes":"...","outreach_opportunity":"...","value_to_operator":"..."}`,
      600
    );
    const commercial = parseJSON(s2.text) || { outreach_opportunity: s2.text.slice(0, 200) };
    steps.push({ step: 2, title: "Commercial Intelligence", provider: s2.provider, result: commercial });

    // Step 3 — Strategy
    const s3 = await llm(
      "Maritime business development strategist. Return ONLY valid JSON.",
      `Profile: ${JSON.stringify(profile)}\nCommercial: ${JSON.stringify(commercial)}\nReturn ONLY JSON:\n{"priority_actions":["..."],"email_strategy":"...","best_contact_timing":"...","value_proposition":"...","risk_mitigation":["..."],"confidence_score":0}`,
      700
    );
    const recommendations = parseJSON(s3.text) || { priority_actions: [s3.text.slice(0, 200)], confidence_score: 70 };
    steps.push({ step: 3, title: "Strategic Recommendations", provider: s3.provider, result: recommendations });

    res.json({ success: true, vessel_name: vessel.vessel_name, imo: vessel.imo_number, steps, providers_used: [...new Set(steps.map(s => s.provider))] });
  } catch (err) {
    logger.error("[agent-vessel-research]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/crm-email  (3-step agent)
// ══════════════════════════════════════════════════════════════════
router.post("/crm-email", async (req, res) => {
  try {
    const { vessel, sender, recipient, persona, context, intent } = req.body || {};
    if (!sender || !recipient) return res.status(400).json({ success: false, error: "sender and recipient required" });

    const steps = [];

    // Step 1 — Persona analysis
    const s1 = await llm(
      "CRM communication strategist. Return ONLY valid JSON.",
      `Sender: ${JSON.stringify(sender)}\nRecipient: ${JSON.stringify(recipient)}\nPersona: ${JSON.stringify(persona||{})}\nReturn ONLY JSON:\n{"communication_style":"...","key_pain_points":["..."],"motivators":["..."],"opening_strategy":"...","tone_guidance":"...","best_hook":"..."}`,
      600
    );
    const analysis = parseJSON(s1.text) || {};
    steps.push({ step: 1, title: "Persona Analysis", provider: s1.provider, result: analysis });

    // Step 2 — Draft
    const vesselCtx = vessel ? `Vessel: ${vessel.vessel_name} (IMO ${vessel.imo_number}), ${vessel.vessel_type||""}, dest: ${vessel.next_port_destination||"unknown"}` : "";
    const s2 = await llm(
      "Maritime sales email specialist. Return ONLY valid JSON.",
      `FROM: ${sender.name} (${sender.role||""} at ${sender.company||""})\nTO: ${recipient.company_name} — ${recipient.role||""}\n${vesselCtx}\nINTENT: ${intent||"business outreach"}\nSTRATEGY: ${JSON.stringify(analysis)}\nCONTEXT: ${context||"none"}\nReturn ONLY JSON:\n{"subject":"...","body":"...","key_selling_points":["..."],"call_to_action":"..."}`,
      900
    );
    const draft = parseJSON(s2.text) || { subject: `Follow Up — ${recipient.company_name}`, body: s2.text };
    steps.push({ step: 2, title: "Email Draft", provider: s2.provider, result: draft });

    // Step 3 — Refine
    const s3 = await llm(
      "Email quality agent. Improve for impact. Return ONLY valid JSON.",
      `Improve this email (150-250 words, strong CTA, specific maritime details):\nSUBJECT: ${draft.subject}\nBODY: ${draft.body}\nReturn ONLY JSON:\n{"subject":"...","body":"...","improvements_made":["..."],"quality_score":0,"send_confidence":"high|medium|low"}`,
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
// POST /api/agents/fleet-optimize  (3-step agent)
// ══════════════════════════════════════════════════════════════════
router.post("/fleet-optimize", async (req, res) => {
  try {
    const { vessels = [], stats = {} } = req.body || {};
    if (!vessels.length) return res.status(400).json({ success: false, error: "vessels array required" });

    const sample = vessels.slice(0, 25).map(v => ({
      name: v.vessel_name, type: v.vessel_type, speed: v.speed,
      status: v.vessel_status, flag: v.flag, dest: v.next_port_destination, stale: v.is_stale,
    }));

    const steps = [];

    const s1 = await llm(
      "Fleet operations AI. Return ONLY valid JSON.",
      `Fleet (${vessels.length} vessels): ${JSON.stringify(sample)}\nStats: ${JSON.stringify(stats)}\nReturn ONLY JSON:\n{"health_score":0,"active_vessels":0,"stale_signals":0,"top_concerns":["..."],"traffic_patterns":"...","congestion_hotspots":["..."]}`,
      700
    );
    const health = parseJSON(s1.text) || { health_score: 70, top_concerns: ["Unable to analyse"] };
    steps.push({ step: 1, title: "Fleet Health Assessment", provider: s1.provider, result: health });

    const s2 = await llm(
      "Maritime route and fuel optimisation agent. Return ONLY valid JSON.",
      `Health: ${JSON.stringify(health)}, ${vessels.length} vessels.\nReturn ONLY JSON:\n{"fuel_savings_potential_percent":0,"route_optimizations":["..."],"speed_recommendations":["..."],"scheduling_improvements":["..."],"estimated_cost_savings_usd_monthly":0,"co2_reduction_tons_monthly":0}`,
      700
    );
    const optimizations = parseJSON(s2.text) || {};
    steps.push({ step: 2, title: "Optimisation Opportunities", provider: s2.provider, result: optimizations });

    const s3 = await llm(
      "Maritime strategic planning agent. Return ONLY valid JSON.",
      `Health: ${JSON.stringify(health)}\nOptimisations: ${JSON.stringify(optimizations)}\nReturn ONLY JSON:\n{"week1_actions":["..."],"week2_actions":["..."],"week3_4_actions":["..."],"kpis_to_track":["..."],"expected_roi":"...","priority_vessels":["..."]}`,
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
// ══════════════════════════════════════════════════════════════════
router.post("/contact-extract", async (req, res) => {
  try {
    const { vessel, raw_data } = req.body || {};
    if (!vessel) return res.status(400).json({ success: false, error: "vessel required" });

    const { text } = await llm(
      "Maritime contact extraction specialist. Return ONLY a valid JSON array.",
      `Extract contacts for: ${vessel.vessel_name} (IMO: ${vessel.imo_number})\nData: ${JSON.stringify(raw_data || vessel, null, 2)}\nReturn ONLY a JSON array (no other text):\n[{"role":"Owner|Operator|Manager|Ship Manager","company_name":"...","email":"...","phone":"...","website":"...","address":"...","confidence":0}]`,
      800
    );

    let contacts = [];
    try {
      const arr = JSON.parse(text.replace(/```json|```/g, "").trim());
      if (Array.isArray(arr)) contacts = arr.filter(c => c.company_name || c.email);
    } catch { /* empty contacts */ }

    res.json({ success: true, vessel: vessel.vessel_name, contacts, raw_count: contacts.length });
  } catch (err) {
    logger.error("[agent-contact-extract]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/smart-reply
// ══════════════════════════════════════════════════════════════════
router.post("/smart-reply", async (req, res) => {
  try {
    const { received_email, vessel, sender } = req.body || {};
    if (!received_email) return res.status(400).json({ success: false, error: "received_email required" });

    const { text } = await llm(
      "Maritime email response specialist. Return ONLY valid JSON.",
      `Generate 3 smart reply options for this email:\n\n${received_email}\n\nSender context: ${sender?.name||"maritime professional"} at ${sender?.company||"company"}. ${vessel ? `Re: ${vessel.vessel_name}` : ""}\nReturn ONLY JSON:\n{"replies":[{"tone":"formal","subject":"Re: ...","body":"..."},{"tone":"concise","subject":"Re: ...","body":"..."},{"tone":"detailed","subject":"Re: ...","body":"..."}]}`,
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
