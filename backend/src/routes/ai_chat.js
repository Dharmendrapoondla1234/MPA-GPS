// src/routes/ai_chat.js — Maritime AI Chat + LLM Engine v4
// Uses shared gemini.js util: retry, backoff, model cascade, rate limiting
"use strict";

const express    = require("express");
const router     = express.Router();
const logger     = require("../utils/logger");
const { callLLM, parseJSON } = require("../utils/gemini");

// ══════════════════════════════════════════════════════════════════
// POST /api/ai/chat
// ══════════════════════════════════════════════════════════════════
router.post("/chat", async (req, res) => {
  try {
    const { message, context, history = [], vesselData, fleetStats } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, error: "Message required" });
    }

    const systemPrompt = [
      "You are MARITIME AI — expert assistant for MPA Singapore vessel tracking platform.",
      "Specialties: AIS data, port ops, cargo, fuel efficiency, CRM, maritime contracts.",
      "Be concise, professional, use correct maritime terminology. Give actionable advice.",
      fleetStats ? `Fleet summary: ${fleetStats}` : "",
      vesselData ? `Selected vessel:\n${JSON.stringify(vesselData, null, 2)}` : (context || ""),
    ].filter(Boolean).join("\n");

    const { text, provider } = await callLLM(systemPrompt, String(message).trim(), 800);
    return res.json({ success: true, reply: text, provider });
  } catch (err) {
    logger.error("[ai-chat]", err.message);
    return res.json({
      success: false,
      reply: `⚠ ${err.message}`,
      provider: "offline",
      error: err.message,
    });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/ai/draft-email
// ══════════════════════════════════════════════════════════════════
router.post("/draft-email", async (req, res) => {
  try {
    const {
      purpose, vesselName, imoNumber, companyName, portName, details, tone = "professional",
    } = req.body || {};

    if (!purpose || !String(purpose).trim()) {
      return res.status(400).json({ success: false, error: "Email purpose required" });
    }

    const toneMap = {
      professional:  "formal and professional",
      consultative:  "consultative and advisory",
      direct:        "direct and concise",
      friendly:      "friendly but professional",
      technical:     "technical and precise",
      executive:     "executive-level, strategic",
      urgent:        "urgent and action-oriented",
    };

    const systemPrompt = `You are a maritime business email specialist. Write a ${toneMap[tone] || "professional"} email with correct maritime terminology. Return ONLY a JSON object — no other text, no markdown wrapping.`;

    const userPrompt = [
      `Purpose: ${purpose}`,
      vesselName  ? `Vessel: ${vesselName}` : "",
      imoNumber   ? `IMO: ${imoNumber}` : "",
      companyName ? `Recipient company: ${companyName}` : "",
      portName    ? `Port: ${portName}` : "",
      details     ? `Additional context:\n${details}` : "",
      "",
      "Write a compelling maritime business email (150-200 words) with a specific subject line and a clear call-to-action.",
      'Return ONLY this JSON (no other text): {"subject":"...","body":"..."}',
    ].filter(Boolean).join("\n");

    const { text, provider } = await callLLM(systemPrompt, userPrompt, 700);

    let email = parseJSON(text);
    if (!email || !email.subject || !email.body) {
      // Fallback: extract from plain text
      const subMatch  = /subject[:\s"]+([^\n"]{5,100})/i.exec(text);
      const bodyMatch = /body[:\s"]+([^"]{20,})/i.exec(text) || /\n\n([\s\S]{20,})/s.exec(text);
      email = {
        subject: subMatch?.[1]?.trim()  || `Re: ${companyName || vesselName || "Maritime Business"}`,
        body:    bodyMatch?.[1]?.trim() || text,
      };
    }

    return res.json({ success: true, email, provider, raw: text });
  } catch (err) {
    logger.error("[ai-email]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/ai/summarize
// ══════════════════════════════════════════════════════════════════
router.post("/summarize", async (req, res) => {
  try {
    const { text, type = "cargo_report" } = req.body || {};
    if (!text || String(text).trim().length < 20) {
      return res.status(400).json({ success: false, error: "Document text required (min 20 chars)" });
    }

    const typeInstructions = {
      cargo_report: "Extract: cargo type, quantity, ports, shipper, consignee, special handling, risks.",
      voyage_log:   "Extract: route, ports called, fuel, delays, incidents, ETA accuracy.",
      contract:     "Extract: parties, vessel, charter type, rates, key clauses, payment terms, red flags.",
      invoice:      "Extract: services, amounts, vessel, port charges, discrepancies, payment status.",
      bol:          "Extract: shipper, consignee, cargo, containers, routing, compliance flags.",
    };

    const system = `Maritime document analyst. ${typeInstructions[type] || typeInstructions.cargo_report} Return JSON: {"summary":"...","key_details":{},"action_items":[],"risk_flags":[],"confidence_score":0}`;
    const { text: result, provider } = await callLLM(system, text.slice(0, 4000), 1000);

    return res.json({ success: true, type, raw: result, parsed: parseJSON(result), provider });
  } catch (err) {
    logger.error("[ai-summarize]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/ai/analyze-fuel
// ══════════════════════════════════════════════════════════════════
router.post("/analyze-fuel", async (req, res) => {
  try {
    const { vesselData, routeData } = req.body || {};
    if (!vesselData) return res.status(400).json({ success: false, error: "vesselData required" });

    const system = "Maritime fuel efficiency expert. Return ONLY a valid JSON object — no other text.";
    const prompt = `Analyse fuel efficiency for:\n${JSON.stringify(vesselData)}\n${routeData ? `Route: ${JSON.stringify(routeData)}` : ""}\nReturn ONLY: {"efficiency_score":0,"fuel_savings_daily_tons":0,"co2_reduction_daily_tons":0,"estimated_annual_savings_usd":0,"route_recommendations":["..."],"speed_recommendation":"...","ml_prediction":"...","confidence":"high|medium|low","current_vs_optimal_speed":{"current":0,"optimal":0,"savings_percent":0}}`;

    const { text, provider } = await callLLM(system, prompt, 800);
    return res.json({ success: true, vessel: vesselData.vessel_name, raw: text, analysis: parseJSON(text), provider });
  } catch (err) {
    logger.error("[ai-fuel]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/ai/predict-arrival
// ══════════════════════════════════════════════════════════════════
router.post("/predict-arrival", async (req, res) => {
  try {
    const { vesselData, destination, weatherData } = req.body || {};
    if (!vesselData || !destination) {
      return res.status(400).json({ success: false, error: "vesselData and destination required" });
    }

    const system = "Maritime ETA prediction specialist. Return ONLY valid JSON.";
    const prompt = `Predict ETA for ${vesselData.vessel_name || "vessel"} to ${destination}.\nVessel: ${JSON.stringify(vesselData)}\n${weatherData ? `Weather: ${JSON.stringify(weatherData)}` : ""}\nReturn ONLY: {"eta_hours":0,"eta_range":{"min":0,"max":0},"confidence":"high|medium|low","factors":["..."],"risk_flags":["..."]}`;

    const { text, provider } = await callLLM(system, prompt, 500);
    return res.json({ success: true, destination, raw: text, prediction: parseJSON(text), provider });
  } catch (err) {
    logger.error("[ai-predict]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/ai/fleet-insights
// ══════════════════════════════════════════════════════════════════
router.post("/fleet-insights", async (req, res) => {
  try {
    const { stats, vessels = [] } = req.body || {};

    const sample = vessels.slice(0, 20).map(v => ({
      name: v.vessel_name, type: v.vessel_type, speed: v.speed,
      status: v.vessel_status, flag: v.flag, stale: v.is_stale,
    }));

    const system = "Maritime fleet analytics expert. Return ONLY a valid JSON object — no other text.";
    const prompt = `Analyse fleet (${vessels.length} vessels):\nStats: ${JSON.stringify(stats || {})}\nSample: ${JSON.stringify(sample)}\nReturn ONLY: {"headline_insight":"...","performance_summary":"...","top_concerns":["..."],"opportunities":["..."],"recommended_actions":["..."],"efficiency_trends":"...","port_congestion_risk":"low|medium|high"}`;

    const { text, provider } = await callLLM(system, prompt, 800);
    const insights = parseJSON(text);
    return res.json({ success: true, raw: text, insights, provider });
  } catch (err) {
    logger.error("[ai-fleet]", err.message);
    return res.json({ success: false, error: err.message, insights: null });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/ai/status
// ══════════════════════════════════════════════════════════════════
router.get("/status", (_req, res) => {
  const gKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || "";
  const cKey = process.env.ANTHROPIC_API_KEY || "";
  res.json({
    gemini: {
      configured: !!gKey,
      models: ["gemini-1.5-flash", "gemini-1.5-flash-8b"],
      key_preview: gKey ? `${gKey.slice(0, 8)}...` : null,
      free_tier: { rpm: 15, rpd: 1500 },
    },
    claude: {
      configured: !!cKey,
      model: "claude-sonnet-4-5-20251022",
      key_preview: cKey ? `${cKey.slice(0, 8)}...` : null,
    },
    features: ["chat", "draft-email", "summarize", "analyze-fuel", "predict-arrival", "fleet-insights"],
  });
});

module.exports = router;
