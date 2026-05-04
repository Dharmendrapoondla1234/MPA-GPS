// src/routes/ai_agents.js — Agentic AI Engine v5
// Same approach as ai_chat.js v5:
//   1. Response cache + in-flight dedup — identical agent runs served from cache
//   2. Local fallback for EVERY step — 429 / quota exhausted → returns computed
//      result from vessel data, never an error to the user
//   3. Multi-step agents collapse to single Gemini call on quota pressure,
//      remaining steps filled from local logic
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");
const { callLLM, parseJSON } = require("../utils/gemini");

// ── Shared cache + dedup (same pattern as ai_chat.js) ────────────────────────
const _cache    = new Map();
const _inflight = new Map();

function cacheKey(...parts) {
  return parts.map(p => String(p ?? "").trim().toLowerCase().slice(0, 80)).join("|");
}
function fromCache(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { _cache.delete(key); return null; }
  return e.result;
}
function toCache(key, result, ttlMs) {
  _cache.set(key, { result, expiresAt: Date.now() + ttlMs });
  if (_cache.size > 300) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
}
async function dedupe(key, fn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = fn().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// Safe Gemini call — never throws, returns null on any error
async function tryLLM(system, prompt, tokens) {
  try {
    const { text, provider } = await callLLM(system, prompt, tokens);
    return { text, provider, ok: true };
  } catch (err) {
    logger.warn(`[agents] LLM unavailable: ${err.message.slice(0, 80)}`);
    return { text: null, provider: "local_fallback", ok: false };
  }
}

// ── Local fallback builders ───────────────────────────────────────────────────

function localVesselProfile(vessel) {
  const age     = vessel.year_built ? new Date().getFullYear() - vessel.year_built : null;
  const ageNote = age ? (age < 5 ? "Modern vessel, low maintenance risk" : age < 15 ? "Mid-life vessel, monitor surveys" : "Older vessel, verify class status") : "Age unknown";
  const risk    = age && age > 20 ? "medium" : "low";
  return {
    profile_summary:    `${vessel.vessel_name || "Vessel"} is a ${vessel.vessel_type || "commercial"} vessel flagged in ${vessel.flag || "unknown flag state"}. IMO ${vessel.imo_number || "N/A"}. ${ageNote}.`,
    vessel_category:    vessel.vessel_type || "Commercial vessel",
    operational_risk:   risk,
    risk_factors:       age && age > 20 ? ["Age > 20 years — verify class certificates", "Check PSC inspection history"] : ["No significant risk factors identified"],
    flag_state_notes:   `Flag: ${vessel.flag || "Unknown"}. Verify Paris/Tokyo MOU compliance.`,
    age_assessment:     ageNote,
    tonnage_class:      vessel.deadweight ? (vessel.deadweight > 200000 ? "VLCC/Capesize" : vessel.deadweight > 80000 ? "Aframax/Panamax" : vessel.deadweight > 25000 ? "Handymax" : "Small vessel") : "Unknown",
  };
}

function localCommercialIntel(vessel) {
  const typeMap = {
    "TANKER": { segment: "Liquid bulk", cargo: "Crude oil, petroleum products, chemicals", market: "Spot or TC market — contact owner for fixture details" },
    "BULK CARRIER": { segment: "Dry bulk", cargo: "Iron ore, coal, grain, fertiliser", market: "Capesize/Panamax/Handysize market depending on DWT" },
    "CONTAINER": { segment: "Liner / container", cargo: "General cargo, containerised freight", market: "Liner trade — contact operator for slot/charter enquiries" },
    "LNG TANKER": { segment: "Gas shipping", cargo: "LNG, LPG", market: "Long-term TC market, specialist operators" },
    "GENERAL CARGO": { segment: "General cargo / MPP", cargo: "Break-bulk, project cargo, heavy lift", market: "Tramp market — available for voyage or short TC" },
  };
  const t = Object.keys(typeMap).find(k => (vessel.vessel_type || "").toUpperCase().includes(k)) || null;
  const info = typeMap[t] || { segment: "Commercial shipping", cargo: "Various", market: "Contact operator for details" };
  return {
    market_segment:        info.segment,
    typical_cargo:         info.cargo,
    charter_market_notes:  info.market,
    outreach_opportunity:  `${vessel.vessel_name} is approaching ${vessel.next_port_destination || "Singapore"} — timely opportunity for port services, bunker, or crew coordination outreach.`,
    value_to_operator:     "Port agency, bunker supply, crew change coordination, and customs clearance services.",
  };
}

function localStrategy(profile, commercial, vessel) {
  return {
    priority_actions:    [
      `Contact ${vessel.vessel_name} operator regarding upcoming port call`,
      "Prepare port services quotation",
      "Confirm vessel ETA and berth requirements",
    ],
    email_strategy:      `Lead with port services availability for ${vessel.next_port_destination || "Singapore"} call. Reference vessel type and size-appropriate services.`,
    best_contact_timing: "24-48 hours before vessel ETA for maximum relevance",
    value_proposition:   commercial.value_to_operator || "Full port agency services",
    risk_mitigation:     profile.risk_factors || ["Verify vessel class and P&I coverage before engagement"],
    confidence_score:    72,
  };
}

function localFleetHealth(vessels, stats) {
  const total    = vessels.length;
  const underway = vessels.filter(v => (v.speed || 0) > 1).length;
  const stale    = vessels.filter(v => v.is_stale).length;
  const byType   = {};
  vessels.forEach(v => { const t = v.vessel_type || "Unknown"; byType[t] = (byType[t] || 0) + 1; });
  const topType  = Object.entries(byType).sort((a, b) => b[1] - a[1])[0]?.[0] || "Mixed";
  const score    = Math.max(40, Math.round(100 - (stale / Math.max(total, 1)) * 60));
  return {
    health_score:       score,
    active_vessels:     underway,
    stale_signals:      stale,
    top_concerns:       stale > total * 0.3 ? [`${stale} vessels with stale AIS (>${Math.round(stale / total * 100)}%)`] : ["Fleet AIS coverage normal"],
    traffic_patterns:   `${underway} of ${total} vessels underway. Dominant type: ${topType}.`,
    congestion_hotspots: ["Singapore Strait", "Eastern Anchorage"],
  };
}

function localOptimizations(health, vessels) {
  const slow = vessels.filter(v => (v.speed || 0) > 0.5 && (v.speed || 0) < 6).length;
  return {
    fuel_savings_potential_percent: slow > 0 ? Math.min(15, Math.round(slow / vessels.length * 25)) : 5,
    route_optimizations:   ["Review slow-steam vessels for optimal speed bands", "Check TSS routing compliance through Singapore Strait"],
    speed_recommendations: ["Target 12-14 kn for fuel efficiency on most vessel types", "Reduce speed in Traffic Separation Scheme areas"],
    scheduling_improvements: ["Stagger arrival times to reduce anchorage wait", "Pre-arrange berth slots to minimise port dwell time"],
    estimated_cost_savings_usd_monthly: slow * 4000,
    co2_reduction_tons_monthly: slow * 12,
  };
}

function localActionPlan(health, opts) {
  return {
    week1_actions:   ["Investigate top stale AIS vessels", "Contact operators of vessels near Singapore for port service outreach", "Review bunker requirements for vessels calling this week"],
    week2_actions:   ["Follow up on outstanding port agency quotations", "Prepare crew change logistics for vessels with upcoming rotations"],
    week3_4_actions: ["Review fleet performance KPIs", "Update contact database with new vessel movements"],
    kpis_to_track:   ["Fleet AIS coverage %", "Port call response rate", "Average vessel turnaround time"],
    expected_roi:    "3-5 new port agency mandates per month from proactive outreach",
    priority_vessels: ["Focus on vessels with imminent Singapore ETAs"],
  };
}

function localPersonaAnalysis(sender, recipient, persona) {
  return {
    communication_style: "Professional maritime industry standard",
    key_pain_points:     ["Vessel scheduling efficiency", "Port cost optimisation", "Regulatory compliance"],
    motivators:          ["Operational reliability", "Cost savings", "Strong local agent network"],
    opening_strategy:    "Lead with vessel-specific context and a concrete service offer",
    tone_guidance:       persona?.tone || "professional",
    best_hook:           "Upcoming port call — specific, timely, relevant",
  };
}

function localEmailDraft(sender, recipient, vessel, intent, analysis) {
  const co   = recipient?.company_name || "your organisation";
  const vn   = vessel?.vessel_name     || "your vessel";
  const imo  = vessel?.imo_number      ? ` (IMO ${vessel.imo_number})` : "";
  const dest = vessel?.next_port_destination || "Singapore";
  return {
    subject: `Port Services — ${vn}${imo} | ${dest}`,
    body: `Dear ${co} Team,

We are reaching out regarding ${vn}${imo}'s upcoming call at ${dest}. ${sender?.name || "Our team"} at ${sender?.company || "Kaizentric Technologies"} provides comprehensive port agency services tailored to ${vessel?.vessel_type || "commercial"} vessels.

Our services include berth coordination, customs clearance, bunker arrangements, crew change support, and 24/7 operational assistance. Our established relationships with MPA Singapore and local port authorities ensure efficient and compliant operations for every vessel call.

We would welcome the opportunity to serve as your preferred port agent for this call and future visits. Please reply to discuss your requirements or request a proforma disbursement account.`,
    key_selling_points: ["Local MPA expertise", "24/7 support", "Competitive rates", "Established port relationships"],
    call_to_action: "Reply to request a proforma disbursement account or discuss requirements",
  };
}

function localRefinedEmail(draft) {
  return {
    subject:          draft.subject,
    body:             draft.body,
    improvements_made: ["Local template applied — professional maritime standard"],
    quality_score:    74,
    send_confidence:  "medium",
  };
}

function localSmartReplies(received_email, sender, vessel) {
  const vn  = vessel?.vessel_name || "the vessel";
  const co  = sender?.company     || "your company";
  const snip = received_email.slice(0, 120).replace(/\n/g, " ");
  return {
    replies: [
      {
        tone:    "formal",
        subject: `Re: ${snip.slice(0, 50)}...`,
        body:    `Dear Team,\n\nThank you for your email regarding ${vn}. We acknowledge receipt and will revert with a detailed response within 24 hours.\n\nKind regards,\n${sender?.name || "Operations Team"}\n${co}`,
      },
      {
        tone:    "concise",
        subject: `Re: ${vn} — Acknowledged`,
        body:    `Thank you for your message. We confirm receipt and will respond shortly. If urgent, please contact us directly.\n\n${sender?.name || "Operations"}`,
      },
      {
        tone:    "detailed",
        subject: `Re: ${snip.slice(0, 50)}...`,
        body:    `Dear Team,\n\nThank you for reaching out regarding ${vn}. We have reviewed your enquiry and are currently preparing a comprehensive response.\n\nWe aim to revert within 24 working hours. In the meantime, please do not hesitate to contact us if you require immediate assistance.\n\nBest regards,\n${sender?.name || "Operations Team"}\n${co}`,
      },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/vessel-research  — 3-step with full local fallback
// ══════════════════════════════════════════════════════════════════
router.post("/vessel-research", async (req, res) => {
  const { vessel } = req.body || {};
  if (!vessel?.imo_number) return res.status(400).json({ success: false, error: "vessel.imo_number required" });

  const key = cacheKey("vessel-research", vessel.imo_number);
  const cached = fromCache(key);
  if (cached) return res.json({ ...cached, cached: true });

  const result = await dedupe(key, async () => {
    const steps = [];

    // Step 1 — Profile
    const r1 = await tryLLM(
      "Maritime intelligence analyst. Return ONLY valid JSON — no other text, no markdown.",
      `Analyse this vessel and return ONLY JSON:\n${JSON.stringify({ name: vessel.vessel_name, imo: vessel.imo_number, type: vessel.vessel_type, flag: vessel.flag, built: vessel.year_built, dwt: vessel.deadweight, status: vessel.vessel_status, dest: vessel.next_port_destination })}\n\n{"profile_summary":"...","vessel_category":"...","operational_risk":"low|medium|high","risk_factors":["..."],"flag_state_notes":"...","age_assessment":"...","tonnage_class":"..."}`,
      700
    );
    const profile = (r1.ok && parseJSON(r1.text)) || localVesselProfile(vessel);
    steps.push({ step: 1, title: "Vessel Profile Analysis", provider: r1.provider, result: profile });

    // Step 2 — Commercial
    const r2 = await tryLLM(
      "Maritime commercial intelligence analyst. Return ONLY valid JSON.",
      `Vessel: ${vessel.vessel_name}, type: ${vessel.vessel_type || "unknown"}, flag: ${vessel.flag || "unknown"}, DWT: ${vessel.deadweight || "unknown"}, dest: ${vessel.next_port_destination || "unknown"}\n\nReturn ONLY this JSON:\n{"market_segment":"...","typical_cargo":"...","charter_market_notes":"...","outreach_opportunity":"...","value_to_operator":"..."}`,
      600
    );
    const commercial = (r2.ok && parseJSON(r2.text)) || localCommercialIntel(vessel);
    steps.push({ step: 2, title: "Commercial Intelligence", provider: r2.provider, result: commercial });

    // Step 3 — Strategy
    const r3 = await tryLLM(
      "Maritime business development strategist. Return ONLY valid JSON.",
      `Profile: ${JSON.stringify(profile)}\nCommercial: ${JSON.stringify(commercial)}\n\nReturn ONLY this JSON:\n{"priority_actions":["..."],"email_strategy":"...","best_contact_timing":"...","value_proposition":"...","risk_mitigation":["..."],"confidence_score":0}`,
      700
    );
    const recommendations = (r3.ok && parseJSON(r3.text)) || localStrategy(profile, commercial, vessel);
    steps.push({ step: 3, title: "Strategic Recommendations", provider: r3.provider, result: recommendations });

    return {
      success: true,
      vessel_name: vessel.vessel_name,
      imo: vessel.imo_number,
      steps,
      providers_used: [...new Set(steps.map(s => s.provider))],
    };
  });

  toCache(key, result, 10 * 60 * 1000); // 10 min
  return res.json(result);
});

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/crm-email  — 3-step with full local fallback
// ══════════════════════════════════════════════════════════════════
router.post("/crm-email", async (req, res) => {
  const { vessel, sender, recipient, persona, context, intent } = req.body || {};
  if (!sender || !recipient) return res.status(400).json({ success: false, error: "sender and recipient required" });

  const key = cacheKey("crm-email", vessel?.imo_number, recipient?.company_name, intent);
  const cached = fromCache(key);
  if (cached) return res.json({ ...cached, cached: true });

  const result = await dedupe(key, async () => {
    const steps = [];

    // Step 1 — Persona analysis
    const r1 = await tryLLM(
      "CRM communication strategist. Return ONLY valid JSON.",
      `Sender: ${sender.name} (${sender.role || ""} at ${sender.company || ""})\nRecipient: ${recipient.company_name} (${recipient.role || ""})\nPersona tone: ${persona?.tone || "professional"}\n\nReturn ONLY this JSON:\n{"communication_style":"...","key_pain_points":["..."],"motivators":["..."],"opening_strategy":"...","tone_guidance":"...","best_hook":"..."}`,
      600
    );
    const analysis = (r1.ok && parseJSON(r1.text)) || localPersonaAnalysis(sender, recipient, persona);
    steps.push({ step: 1, title: "Persona Analysis", provider: r1.provider, result: analysis });

    // Step 2 — Draft
    const vesselCtx = vessel ? `Vessel: ${vessel.vessel_name} (IMO ${vessel.imo_number}), ${vessel.vessel_type || ""}, dest: ${vessel.next_port_destination || "unknown"}` : "";
    const r2 = await tryLLM(
      "Maritime sales email specialist. Return ONLY valid JSON.",
      `Write a maritime business email.\nFROM: ${sender.name} at ${sender.company || ""}\nTO: ${recipient.company_name} (${recipient.role || ""})\n${vesselCtx}\nINTENT: ${intent || "business outreach"}\nTONE: ${analysis.tone_guidance || "professional"}\nCONTEXT: ${context || "none"}\n\nReturn ONLY this JSON:\n{"subject":"...","body":"...","key_selling_points":["..."],"call_to_action":"..."}`,
      900
    );
    const draft = (r2.ok && parseJSON(r2.text)) || localEmailDraft(sender, recipient, vessel, intent, analysis);
    steps.push({ step: 2, title: "Email Draft", provider: r2.provider, result: draft });

    // Step 3 — Refine
    const r3 = await tryLLM(
      "Email quality specialist. Return ONLY valid JSON.",
      `Improve this email for maximum impact (150-250 words, specific details, strong CTA):\nSUBJECT: ${draft.subject}\nBODY: ${draft.body}\n\nReturn ONLY this JSON:\n{"subject":"...","body":"...","improvements_made":["..."],"quality_score":0,"send_confidence":"high|medium|low"}`,
      900
    );
    const refined = (r3.ok && parseJSON(r3.text)) || localRefinedEmail(draft);
    steps.push({ step: 3, title: "Quality Refinement", provider: r3.provider, result: refined });

    return {
      success:         true,
      subject:         refined.subject        || draft.subject,
      body:            refined.body           || draft.body,
      quality_score:   refined.quality_score  || 74,
      send_confidence: refined.send_confidence || "medium",
      improvements:    refined.improvements_made || [],
      steps,
    };
  });

  toCache(key, result, 10 * 60 * 1000);
  return res.json(result);
});

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/fleet-optimize  — 3-step with full local fallback
// ══════════════════════════════════════════════════════════════════
router.post("/fleet-optimize", async (req, res) => {
  const { vessels = [], stats = {} } = req.body || {};
  if (!vessels.length) return res.status(400).json({ success: false, error: "vessels array required" });

  const key = cacheKey("fleet-optimize", vessels.length, JSON.stringify(stats).slice(0, 80));
  const cached = fromCache(key);
  if (cached) return res.json({ ...cached, cached: true });

  const result = await dedupe(key, async () => {
    const sample = vessels.slice(0, 20).map(v => ({ name: v.vessel_name, type: v.vessel_type, speed: v.speed, status: v.vessel_status, flag: v.flag, stale: v.is_stale }));
    const steps  = [];

    const r1 = await tryLLM(
      "Fleet operations analyst. Return ONLY valid JSON.",
      `Fleet: ${vessels.length} vessels. Stats: ${JSON.stringify(stats)}. Sample: ${JSON.stringify(sample)}\nReturn ONLY: {"health_score":0,"active_vessels":0,"stale_signals":0,"top_concerns":["..."],"traffic_patterns":"...","congestion_hotspots":["..."]}`,
      600
    );
    const health = (r1.ok && parseJSON(r1.text)) || localFleetHealth(vessels, stats);
    steps.push({ step: 1, title: "Fleet Health Assessment", provider: r1.provider, result: health });

    const r2 = await tryLLM(
      "Maritime route and fuel optimisation analyst. Return ONLY valid JSON.",
      `Fleet health: score ${health.health_score}, concerns: ${JSON.stringify(health.top_concerns)}, ${vessels.length} vessels.\nReturn ONLY: {"fuel_savings_potential_percent":0,"route_optimizations":["..."],"speed_recommendations":["..."],"scheduling_improvements":["..."],"estimated_cost_savings_usd_monthly":0,"co2_reduction_tons_monthly":0}`,
      600
    );
    const optimizations = (r2.ok && parseJSON(r2.text)) || localOptimizations(health, vessels);
    steps.push({ step: 2, title: "Optimisation Opportunities", provider: r2.provider, result: optimizations });

    const r3 = await tryLLM(
      "Maritime strategic planning specialist. Return ONLY valid JSON.",
      `Health score: ${health.health_score}. Fuel savings potential: ${optimizations.fuel_savings_potential_percent}%.\nReturn ONLY: {"week1_actions":["..."],"week2_actions":["..."],"week3_4_actions":["..."],"kpis_to_track":["..."],"expected_roi":"...","priority_vessels":["..."]}`,
      700
    );
    const plan = (r3.ok && parseJSON(r3.text)) || localActionPlan(health, optimizations);
    steps.push({ step: 3, title: "30-Day Action Plan", provider: r3.provider, result: plan });

    return { success: true, vessel_count: vessels.length, health, optimizations, action_plan: plan, steps };
  });

  toCache(key, result, 5 * 60 * 1000); // 5 min — fleet data changes
  return res.json(result);
});

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/contact-extract
// ══════════════════════════════════════════════════════════════════
router.post("/contact-extract", async (req, res) => {
  const { vessel, raw_data } = req.body || {};
  if (!vessel) return res.status(400).json({ success: false, error: "vessel required" });

  const key = cacheKey("contact-extract", vessel.imo_number);
  const cached = fromCache(key);
  if (cached) return res.json({ ...cached, cached: true });

  const result = await dedupe(key, async () => {
    const r = await tryLLM(
      "Maritime contact extraction specialist. Return ONLY a valid JSON array — no other text.",
      `Extract all known contacts for vessel: ${vessel.vessel_name} (IMO: ${vessel.imo_number})\nData: ${JSON.stringify({ type: vessel.vessel_type, flag: vessel.flag, operator: raw_data?.operator, owner: raw_data?.owner, manager: raw_data?.manager })}\nReturn ONLY a JSON array:\n[{"role":"Owner|Operator|Manager|Ship Manager","company_name":"...","email":"...","phone":"...","website":"...","address":"...","confidence":0}]`,
      700
    );

    let contacts = [];
    if (r.ok && r.text) {
      try {
        const arr = JSON.parse(r.text.replace(/```json|```/g, "").trim());
        if (Array.isArray(arr)) contacts = arr.filter(c => c.company_name || c.email);
      } catch { /* use empty */ }
    }

    // Local fallback — build contacts from raw_data if Gemini unavailable
    if (!contacts.length && raw_data) {
      ["owner", "operator", "manager"].forEach(role => {
        if (raw_data[role]) contacts.push({ role: role.charAt(0).toUpperCase() + role.slice(1), company_name: raw_data[role], email: null, phone: null, confidence: 60 });
      });
    }

    return { success: true, vessel: vessel.vessel_name, contacts, raw_count: contacts.length, provider: r.provider };
  });

  toCache(key, result, 15 * 60 * 1000); // 15 min — contact data is stable
  return res.json(result);
});

// ══════════════════════════════════════════════════════════════════
// POST /api/agents/smart-reply
// ══════════════════════════════════════════════════════════════════
router.post("/smart-reply", async (req, res) => {
  const { received_email, vessel, sender } = req.body || {};
  if (!received_email) return res.status(400).json({ success: false, error: "received_email required" });

  const key = cacheKey("smart-reply", received_email.slice(0, 120), vessel?.imo_number);
  const cached = fromCache(key);
  if (cached) return res.json({ ...cached, cached: true });

  const result = await dedupe(key, async () => {
    const r = await tryLLM(
      "Maritime email response specialist. Return ONLY valid JSON.",
      `Generate 3 smart reply options for this received email:\n\n${received_email.slice(0, 1000)}\n\nContext: From ${sender?.name || "maritime professional"} at ${sender?.company || "company"}${vessel ? `, re vessel ${vessel.vessel_name}` : ""}.\nReturn ONLY: {"replies":[{"tone":"formal","subject":"Re: ...","body":"..."},{"tone":"concise","subject":"Re: ...","body":"..."},{"tone":"detailed","subject":"Re: ...","body":"..."}]}`,
      800
    );

    const parsed = (r.ok && parseJSON(r.text)) || localSmartReplies(received_email, sender, vessel);
    return { success: true, replies: parsed.replies || [], provider: r.provider };
  });

  toCache(key, result, 10 * 60 * 1000);
  return res.json(result);
});

module.exports = router;