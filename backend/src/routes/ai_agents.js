// src/routes/ai_agents.js — Agentic AI Engine v4
// Uses shared gemini.js: retry, backoff, model cascade, rate limiting
// Note: agents make 3 sequential LLM calls — adds delay between steps to respect rate limits
"use strict";

const express    = require("express");
const router     = express.Router();
const logger     = require("../utils/logger");
const { callLLM, parseJSON } = require("../utils/gemini");

// Small delay between agent steps to avoid rate-limit spikes
const stepDelay = ms => new Promise(r => setTimeout(r, ms));
const INTER_STEP_DELAY = 2000; // 2s between steps = max ~1.5 req/6s = well under 15 rpm

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/vessel-research  (3-step)
// ══════════════════════════════════════════════════════════════════
router.post("/vessel-research", async (req, res) => {
  try {
    const { vessel } = req.body || {};
    if (!vessel?.imo_number) return res.status(400).json({ success: false, error: "vessel.imo_number required" });

    const steps = [];

    // Step 1 — Profile
    const s1 = await callLLM(
      "Maritime intelligence analyst. Return ONLY valid JSON — no other text, no markdown.",
      `Analyse this vessel and return ONLY JSON:\n${JSON.stringify({ name: vessel.vessel_name, imo: vessel.imo_number, type: vessel.vessel_type, flag: vessel.flag, built: vessel.year_built, dwt: vessel.deadweight, status: vessel.vessel_status, dest: vessel.next_port_destination }, null, 2)}\n\n{"profile_summary":"...","vessel_category":"...","operational_risk":"low|medium|high","risk_factors":["..."],"flag_state_notes":"...","age_assessment":"...","tonnage_class":"..."}`,
      700
    );
    const profile = parseJSON(s1.text) || { profile_summary: s1.text.slice(0, 300), operational_risk: "medium" };
    steps.push({ step: 1, title: "Vessel Profile Analysis", provider: s1.provider, result: profile });

    await stepDelay(INTER_STEP_DELAY);

    // Step 2 — Commercial
    const s2 = await callLLM(
      "Maritime commercial intelligence analyst. Return ONLY valid JSON.",
      `Vessel: ${vessel.vessel_name}, type: ${vessel.vessel_type||"unknown"}, flag: ${vessel.flag||"unknown"}, DWT: ${vessel.deadweight||"unknown"}, dest: ${vessel.next_port_destination||"unknown"}\n\nReturn ONLY this JSON:\n{"market_segment":"...","typical_cargo":"...","charter_market_notes":"...","outreach_opportunity":"...","value_to_operator":"..."}`,
      600
    );
    const commercial = parseJSON(s2.text) || { outreach_opportunity: s2.text.slice(0, 200) };
    steps.push({ step: 2, title: "Commercial Intelligence", provider: s2.provider, result: commercial });

    await stepDelay(INTER_STEP_DELAY);

    // Step 3 — Strategy
    const s3 = await callLLM(
      "Maritime business development strategist. Return ONLY valid JSON.",
      `Profile: ${JSON.stringify(profile)}\nCommercial: ${JSON.stringify(commercial)}\n\nReturn ONLY this JSON:\n{"priority_actions":["..."],"email_strategy":"...","best_contact_timing":"...","value_proposition":"...","risk_mitigation":["..."],"confidence_score":0}`,
      700
    );
    const recommendations = parseJSON(s3.text) || { priority_actions: ["Review vessel profile"], confidence_score: 70 };
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
// POST /api/agents/crm-email  (3-step)
// ══════════════════════════════════════════════════════════════════
router.post("/crm-email", async (req, res) => {
  try {
    const { vessel, sender, recipient, persona, context, intent } = req.body || {};
    if (!sender || !recipient) return res.status(400).json({ success: false, error: "sender and recipient required" });

    const steps = [];

    // Step 1 — Persona analysis
    const s1 = await callLLM(
      "CRM communication strategist. Return ONLY valid JSON.",
      `Sender: ${sender.name} (${sender.role||""} at ${sender.company||""})\nRecipient: ${recipient.company_name} (${recipient.role||""})\nPersona tone: ${persona?.tone||"professional"}\n\nReturn ONLY this JSON:\n{"communication_style":"...","key_pain_points":["..."],"motivators":["..."],"opening_strategy":"...","tone_guidance":"...","best_hook":"..."}`,
      600
    );
    const analysis = parseJSON(s1.text) || { tone_guidance: "professional", best_hook: "vessel opportunity" };
    steps.push({ step: 1, title: "Persona Analysis", provider: s1.provider, result: analysis });

    await stepDelay(INTER_STEP_DELAY);

    // Step 2 — Draft
    const vesselCtx = vessel ? `Vessel: ${vessel.vessel_name} (IMO ${vessel.imo_number}), ${vessel.vessel_type||""}, dest: ${vessel.next_port_destination||"unknown"}` : "";
    const s2 = await callLLM(
      "Maritime sales email specialist. Return ONLY valid JSON.",
      `Write a maritime business email.\nFROM: ${sender.name} at ${sender.company||""}\nTO: ${recipient.company_name} (${recipient.role||""})\n${vesselCtx}\nINTENT: ${intent||"business outreach"}\nTONE: ${analysis.tone_guidance||"professional"}\nCONTEXT: ${context||"none"}\n\nReturn ONLY this JSON:\n{"subject":"...","body":"...","key_selling_points":["..."],"call_to_action":"..."}`,
      900
    );
    const draft = parseJSON(s2.text) || { subject: `Maritime Opportunity — ${recipient.company_name}`, body: s2.text };
    steps.push({ step: 2, title: "Email Draft", provider: s2.provider, result: draft });

    await stepDelay(INTER_STEP_DELAY);

    // Step 3 — Refine
    const s3 = await callLLM(
      "Email quality specialist. Return ONLY valid JSON.",
      `Improve this email for maximum impact (150-250 words, specific details, strong CTA):\nSUBJECT: ${draft.subject}\nBODY: ${draft.body}\n\nReturn ONLY this JSON:\n{"subject":"...","body":"...","improvements_made":["..."],"quality_score":0,"send_confidence":"high|medium|low"}`,
      900
    );
    const refined = parseJSON(s3.text) || { ...draft, quality_score: 75, send_confidence: "medium", improvements_made: [] };
    steps.push({ step: 3, title: "Quality Refinement", provider: s3.provider, result: refined });

    res.json({
      success: true,
      subject: refined.subject || draft.subject,
      body: refined.body || draft.body,
      quality_score: refined.quality_score || 75,
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
// POST /api/agents/fleet-optimize  (3-step)
// ══════════════════════════════════════════════════════════════════
router.post("/fleet-optimize", async (req, res) => {
  try {
    const { vessels = [], stats = {} } = req.body || {};
    if (!vessels.length) return res.status(400).json({ success: false, error: "vessels array required" });

    const sample = vessels.slice(0, 20).map(v => ({
      name: v.vessel_name, type: v.vessel_type, speed: v.speed,
      status: v.vessel_status, flag: v.flag, stale: v.is_stale,
    }));

    const steps = [];

    const s1 = await callLLM(
      "Fleet operations analyst. Return ONLY valid JSON.",
      `Fleet: ${vessels.length} vessels. Stats: ${JSON.stringify(stats)}. Sample: ${JSON.stringify(sample)}\nReturn ONLY: {"health_score":0,"active_vessels":0,"stale_signals":0,"top_concerns":["..."],"traffic_patterns":"...","congestion_hotspots":["..."]}`,
      600
    );
    const health = parseJSON(s1.text) || { health_score: 70, top_concerns: ["Unable to analyse"] };
    steps.push({ step: 1, title: "Fleet Health Assessment", provider: s1.provider, result: health });

    await stepDelay(INTER_STEP_DELAY);

    const s2 = await callLLM(
      "Maritime route and fuel optimisation analyst. Return ONLY valid JSON.",
      `Fleet health: score ${health.health_score}, concerns: ${JSON.stringify(health.top_concerns)}, ${vessels.length} vessels.\nReturn ONLY: {"fuel_savings_potential_percent":0,"route_optimizations":["..."],"speed_recommendations":["..."],"scheduling_improvements":["..."],"estimated_cost_savings_usd_monthly":0,"co2_reduction_tons_monthly":0}`,
      600
    );
    const optimizations = parseJSON(s2.text) || { fuel_savings_potential_percent: 0, route_optimizations: [] };
    steps.push({ step: 2, title: "Optimisation Opportunities", provider: s2.provider, result: optimizations });

    await stepDelay(INTER_STEP_DELAY);

    const s3 = await callLLM(
      "Maritime strategic planning specialist. Return ONLY valid JSON.",
      `Health score: ${health.health_score}. Fuel savings potential: ${optimizations.fuel_savings_potential_percent}%.\nReturn ONLY: {"week1_actions":["..."],"week2_actions":["..."],"week3_4_actions":["..."],"kpis_to_track":["..."],"expected_roi":"...","priority_vessels":["..."]}`,
      700
    );
    const plan = parseJSON(s3.text) || { week1_actions: ["Review stale AIS vessels"], kpis_to_track: ["Fleet health score"] };
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

    const { text } = await callLLM(
      "Maritime contact extraction specialist. Return ONLY a valid JSON array — no other text.",
      `Extract all known contacts for vessel: ${vessel.vessel_name} (IMO: ${vessel.imo_number})\nData: ${JSON.stringify({ type: vessel.vessel_type, flag: vessel.flag, operator: raw_data?.operator, owner: raw_data?.owner, manager: raw_data?.manager }, null, 2)}\nReturn ONLY a JSON array:\n[{"role":"Owner|Operator|Manager|Ship Manager","company_name":"...","email":"...","phone":"...","website":"...","address":"...","confidence":0}]`,
      700
    );

    let contacts = [];
    try {
      const cleaned = text.replace(/```json|```/g, "").trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) contacts = arr.filter(c => c.company_name || c.email);
    } catch { /* return empty */ }

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

    const { text } = await callLLM(
      "Maritime email response specialist. Return ONLY valid JSON.",
      `Generate 3 smart reply options for this received email:\n\n${received_email.slice(0, 1000)}\n\nContext: From ${sender?.name||"maritime professional"} at ${sender?.company||"company"}${vessel ? `, re vessel ${vessel.vessel_name}` : ""}.\nReturn ONLY: {"replies":[{"tone":"formal","subject":"Re: ...","body":"..."},{"tone":"concise","subject":"Re: ...","body":"..."},{"tone":"detailed","subject":"Re: ...","body":"..."}]}`,
      800
    );

    const parsed = parseJSON(text) || { replies: [] };
    res.json({ success: true, replies: parsed.replies || [] });
  } catch (err) {
    logger.error("[agent-smart-reply]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
