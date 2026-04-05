// src/routes/ai_agents.js — Agentic AI Engine v1
// Multi-step AI agents: vessel research, CRM intelligence, fleet optimizer
"use strict";
const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");

const GEMINI_MODEL    = "gemini-2.0-flash";
const ANTHROPIC_MODEL = "claude-sonnet-4-5";

function getGeminiKey()    { return process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || null; }
function getAnthropicKey() { return process.env.ANTHROPIC_API_KEY || null; }

async function llm(system, user, maxTokens = 1200) {
  // Try Gemini first, fall back to Claude
  const gKey = getGeminiKey();
  if (gKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${gKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: user }] }],
          systemInstruction: { parts: [{ text: system }] },
          generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const j = await res.json();
        const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (text) return { text, provider: "gemini" };
      }
    } catch {}
  }

  const cKey = getAnthropicKey();
  if (cKey) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": cKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const j = await res.json();
      return { text: j?.content?.[0]?.text || "", provider: "claude" };
    }
  }
  throw new Error("No AI provider available");
}

function parseJSON(raw) {
  try {
    const m = /```json\s*([\s\S]+?)\s*```/.exec(raw) || /([\s\S]*)/s.exec(raw);
    return JSON.parse(m ? m[1].trim() : raw.trim());
  } catch { return null; }
}

// ── POST /api/agents/vessel-research ─────────────────────────────────────────
// Agentic multi-step vessel intelligence: AIS + company + risk + recommendations
router.post("/vessel-research", async (req, res, next) => {
  try {
    const { vessel } = req.body || {};
    if (!vessel?.imo_number) return res.status(400).json({ success: false, error: "vessel.imo_number required" });

    const steps = [];

    // Step 1 — Vessel profile analysis
    const step1 = await llm(
      "You are a maritime intelligence agent. Analyze vessel data and produce a structured profile.",
      `Analyze this vessel: ${JSON.stringify(vessel, null, 2)}\n\nReturn JSON: { "profile_summary": "...", "vessel_category": "...", "operational_risk": "low|medium|high", "risk_factors": [...], "flag_state_notes": "...", "age_assessment": "...", "tonnage_class": "..." }`,
      600
    );
    const profile = parseJSON(step1.text) || { profile_summary: step1.text, operational_risk: "medium" };
    steps.push({ step: 1, title: "Vessel Profile Analysis", provider: step1.provider, result: profile });

    // Step 2 — Commercial intelligence
    const step2 = await llm(
      "You are a maritime commercial intelligence agent. Assess commercial and market context.",
      `Vessel: ${vessel.vessel_name} (${vessel.vessel_type || "unknown type"}), Flag: ${vessel.flag || "unknown"}, Built: ${vessel.year_built || "unknown"}, DWT: ${vessel.deadweight || "unknown"}. Current status: ${vessel.vessel_status || "unknown"}. Destination: ${vessel.next_port_destination || "unknown"}.\n\nReturn JSON: { "market_segment": "...", "typical_cargo": "...", "commercial_value_estimate": "...", "charter_market_notes": "...", "competitive_landscape": "...", "outreach_opportunity": "..." }`,
      600
    );
    const commercial = parseJSON(step2.text) || { market_segment: step2.text };
    steps.push({ step: 2, title: "Commercial Intelligence", provider: step2.provider, result: commercial });

    // Step 3 — Agentic recommendations
    const step3 = await llm(
      "You are a senior maritime business development agent. Generate actionable recommendations.",
      `Based on vessel profile: ${JSON.stringify(profile)} and commercial context: ${JSON.stringify(commercial)}, generate a strategic action plan.\n\nReturn JSON: { "priority_actions": ["..."], "email_strategy": "...", "best_contact_timing": "...", "value_proposition": "...", "risk_mitigation": ["..."], "follow_up_schedule": "...", "confidence_score": 0-100 }`,
      700
    );
    const recommendations = parseJSON(step3.text) || { priority_actions: [step3.text] };
    steps.push({ step: 3, title: "Strategic Recommendations", provider: step3.provider, result: recommendations });

    res.json({ success: true, vessel_name: vessel.vessel_name, imo: vessel.imo_number, steps, providers_used: [...new Set([step1.provider, step2.provider, step3.provider])] });
  } catch (err) {
    logger.error("[agent-vessel-research]", err.message);
    next(err);
  }
});

// ── POST /api/agents/crm-email ────────────────────────────────────────────────
// Agentic CRM email: persona analysis → context enrichment → draft → refine
router.post("/crm-email", async (req, res, next) => {
  try {
    const { vessel, sender, recipient, persona, context, intent } = req.body || {};
    if (!sender || !recipient) return res.status(400).json({ success: false, error: "sender and recipient required" });

    const steps = [];

    // Step 1 — Persona & recipient analysis
    const step1 = await llm(
      "You are a CRM persona analysis agent. Deeply analyze sender and recipient to optimize communication strategy.",
      `Sender: ${JSON.stringify(sender)}\nRecipient: ${JSON.stringify(recipient)}\nPersona: ${JSON.stringify(persona || {})}\n\nReturn JSON: { "communication_style": "...", "key_pain_points": [...], "motivators": [...], "opening_strategy": "...", "tone_guidance": "...", "cultural_notes": "...", "best_hook": "..." }`,
      600
    );
    const analysis = parseJSON(step1.text) || {};
    steps.push({ step: 1, title: "Persona Analysis", provider: step1.provider, result: analysis });

    // Step 2 — Draft generation
    const vesselCtx = vessel ? `Vessel: ${vessel.vessel_name} (IMO ${vessel.imo_number}), ${vessel.vessel_type || ""}, ${vessel.vessel_status || ""}, destination: ${vessel.next_port_destination || "unknown"}` : "";
    const step2 = await llm(
      "You are a maritime sales email specialist. Write highly personalised, compelling emails.",
      `Write a maritime business email.\n\nFROM: ${sender.name} (${sender.role || ""} at ${sender.company || ""})\nTO: ${recipient.company_name} — ${recipient.role || ""}\n${vesselCtx}\nINTENT: ${intent || "business outreach"}\nCOMMUNICATION GUIDANCE: ${JSON.stringify(analysis)}\nADDITIONAL CONTEXT: ${context || "none"}\n\nReturn JSON: { "subject": "...", "body": "...", "key_selling_points": [...], "call_to_action": "..." }`,
      900
    );
    const draft = parseJSON(step2.text) || { subject: "Follow Up", body: step2.text };
    steps.push({ step: 2, title: "Email Draft Generation", provider: step2.provider, result: draft });

    // Step 3 — Quality refinement
    const step3 = await llm(
      "You are an email quality agent. Review and refine maritime emails for impact and professionalism.",
      `Review and improve this email:\nSUBJECT: ${draft.subject}\nBODY: ${draft.body}\n\nEnsure: specific details, clear value proposition, professional maritime terminology, strong CTA, right length (150-250 words).\n\nReturn JSON: { "subject": "...", "body": "...", "improvements_made": [...], "quality_score": 0-100, "send_confidence": "high|medium|low" }`,
      900
    );
    const refined = parseJSON(step3.text) || draft;
    steps.push({ step: 3, title: "Quality Refinement", provider: step3.provider, result: refined });

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
    next(err);
  }
});

// ── POST /api/agents/fleet-optimize ──────────────────────────────────────────
// Agentic fleet optimizer: routing + fuel + scheduling + risk
router.post("/fleet-optimize", async (req, res, next) => {
  try {
    const { vessels = [], stats = {} } = req.body || {};
    if (!vessels.length) return res.status(400).json({ success: false, error: "vessels array required" });

    const sample = vessels.slice(0, 30).map(v => ({
      name: v.vessel_name, type: v.vessel_type, speed: v.speed,
      status: v.vessel_status, flag: v.flag, dest: v.next_port_destination,
      lat: v.latitude_degrees, lng: v.longitude_degrees, stale: v.is_stale,
    }));

    const steps = [];

    // Step 1 — Fleet health assessment
    const step1 = await llm(
      "You are a fleet operations AI agent. Assess overall fleet health and identify patterns.",
      `Fleet data (${vessels.length} vessels): ${JSON.stringify(sample)}\nStats: ${JSON.stringify(stats)}\n\nReturn JSON: { "health_score": 0-100, "active_vessels": n, "stale_signals": n, "top_concerns": [...], "traffic_patterns": "...", "congestion_hotspots": [...] }`,
      700
    );
    const health = parseJSON(step1.text) || {};
    steps.push({ step: 1, title: "Fleet Health Assessment", provider: step1.provider, result: health });

    // Step 2 — Optimization opportunities
    const step2 = await llm(
      "You are a maritime route and fuel optimization agent.",
      `Given fleet health: ${JSON.stringify(health)} and ${vessels.length} vessels, identify top optimization opportunities.\n\nReturn JSON: { "fuel_savings_potential_percent": n, "route_optimizations": [...], "speed_recommendations": [...], "scheduling_improvements": [...], "estimated_cost_savings_usd_monthly": n, "co2_reduction_tons_monthly": n }`,
      700
    );
    const optimizations = parseJSON(step2.text) || {};
    steps.push({ step: 2, title: "Optimization Opportunities", provider: step2.provider, result: optimizations });

    // Step 3 — Action plan
    const step3 = await llm(
      "You are a maritime strategic planning agent.",
      `Based on health ${JSON.stringify(health)} and optimizations ${JSON.stringify(optimizations)}, create a 30-day action plan.\n\nReturn JSON: { "week1_actions": [...], "week2_actions": [...], "week3_4_actions": [...], "kpis_to_track": [...], "expected_roi": "...", "priority_vessels": [...] }`,
      800
    );
    const plan = parseJSON(step3.text) || {};
    steps.push({ step: 3, title: "30-Day Action Plan", provider: step3.provider, result: plan });

    res.json({ success: true, vessel_count: vessels.length, health, optimizations, action_plan: plan, steps });
  } catch (err) {
    logger.error("[agent-fleet-optimize]", err.message);
    next(err);
  }
});

// ── POST /api/agents/contact-extract ─────────────────────────────────────────
// Agentic contact extraction from raw Equasis / web data
router.post("/contact-extract", async (req, res, next) => {
  try {
    const { vessel, raw_data } = req.body || {};
    if (!vessel) return res.status(400).json({ success: false, error: "vessel required" });

    const { text } = await llm(
      "You are a maritime contact extraction agent. Extract structured contact information.",
      `Extract all contacts for vessel: ${vessel.vessel_name} (IMO: ${vessel.imo_number})\nRaw data: ${JSON.stringify(raw_data || vessel)}\n\nReturn JSON array: [{ "role": "Owner|Operator|Manager|Ship Manager|Agent", "company_name": "...", "email": "...", "phone": "...", "website": "...", "address": "...", "confidence": 0-100 }]`,
      800
    );

    let contacts = [];
    try {
      const arr = JSON.parse(text.replace(/```json|```/g, "").trim());
      if (Array.isArray(arr)) contacts = arr;
    } catch {}

    res.json({ success: true, vessel: vessel.vessel_name, contacts, raw_count: contacts.length });
  } catch (err) {
    logger.error("[agent-contact-extract]", err.message);
    next(err);
  }
});

// ── POST /api/agents/smart-reply ──────────────────────────────────────────────
// Generate smart reply suggestions for received emails
router.post("/smart-reply", async (req, res, next) => {
  try {
    const { received_email, vessel, sender } = req.body || {};
    if (!received_email) return res.status(400).json({ success: false, error: "received_email required" });

    const { text } = await llm(
      "You are a maritime email response agent. Generate professional reply options.",
      `Generate 3 smart reply options for this received email:\n\n${received_email}\n\nContext: Sender is ${sender?.name || "maritime professional"} at ${sender?.company || "shipping company"}. ${vessel ? `Regarding vessel ${vessel.vessel_name}` : ""}\n\nReturn JSON: { "replies": [{ "tone": "formal|concise|detailed", "subject": "Re: ...", "body": "..." }] }`,
      900
    );

    const parsed = parseJSON(text) || { replies: [] };
    res.json({ success: true, replies: parsed.replies || [] });
  } catch (err) {
    logger.error("[agent-smart-reply]", err.message);
    next(err);
  }
});

module.exports = router;
