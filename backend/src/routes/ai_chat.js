// src/routes/ai_chat.js — Maritime AI Chat + LLM Engine v3
// Gemini-primary (free-tier compatible), Claude fallback, graceful degradation
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");

const GEMINI_MODEL = "gemini-2.0-flash";
const CLAUDE_MODEL = "claude-sonnet-4-5-20251022";

function getGeminiKey()    { return process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || ""; }
function getAnthropicKey() { return process.env.ANTHROPIC_API_KEY || ""; }

// ── Reliable Gemini caller (free-tier compatible) ─────────────────
// Key fixes vs v2:
// 1. No "responseMimeType" — it conflicts with systemInstruction on free tier
// 2. System prompt embedded inside user turn for maximum compatibility
// 3. Full error body logged so you can see what Gemini actually returned
async function callGemini(systemPrompt, userMessage, maxTokens = 1000) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY not set in environment");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // Embed system context in the user message — most reliable approach for free tier
  const fullMessage = systemPrompt
    ? `[SYSTEM CONTEXT]\n${systemPrompt}\n\n[USER REQUEST]\n${userMessage}`
    : userMessage;

  const reqBody = {
    contents: [{ role: "user", parts: [{ text: fullMessage }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: maxTokens,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(35000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const json = await res.json();

  // Check for blocked content
  const candidate = json?.candidates?.[0];
  if (!candidate) {
    const blockReason = json?.promptFeedback?.blockReason;
    throw new Error(`Gemini: no candidates returned${blockReason ? ` (blocked: ${blockReason})` : ""}`);
  }

  const finishReason = candidate.finishReason;
  if (finishReason === "SAFETY") throw new Error("Gemini: response blocked by safety filter");
  if (finishReason === "RECITATION") throw new Error("Gemini: response blocked by recitation filter");

  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini: empty text in response (finishReason: ${finishReason || "UNKNOWN"})`);

  return text;
}

// ── Claude caller ─────────────────────────────────────────────────
async function callClaude(systemPrompt, userMessage, maxTokens = 1000) {
  const apiKey = getAnthropicKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in environment");

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: userMessage }],
  };
  if (systemPrompt) body.system = systemPrompt;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":       "application/json",
      "x-api-key":          apiKey,
      "anthropic-version":  "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Claude ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const json = await res.json();
  const text = json?.content?.[0]?.text;
  if (!text) throw new Error("Claude: empty response");
  return text;
}

// ── Unified: Gemini → Claude → descriptive error ─────────────────
async function callLLM(systemPrompt, userMessage, maxTokens = 1000) {
  const errors = [];

  if (getGeminiKey()) {
    try {
      const text = await callGemini(systemPrompt, userMessage, maxTokens);
      return { text, provider: "gemini" };
    } catch (err) {
      errors.push(`Gemini: ${err.message}`);
      logger.warn(`[ai] Gemini failed: ${err.message}`);
    }
  } else {
    errors.push("Gemini: GEMINI_API_KEY not set");
  }

  if (getAnthropicKey()) {
    try {
      const text = await callClaude(systemPrompt, userMessage, maxTokens);
      return { text, provider: "claude" };
    } catch (err) {
      errors.push(`Claude: ${err.message}`);
      logger.warn(`[ai] Claude failed: ${err.message}`);
    }
  } else {
    errors.push("Claude: ANTHROPIC_API_KEY not set");
  }

  throw new Error(`AI generation failed — ${errors.join(" | ")}`);
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
// POST /api/ai/chat
// ══════════════════════════════════════════════════════════════════
router.post("/chat", async (req, res) => {
  try {
    const { message, context, history = [], vesselData, fleetStats } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, error: "Message required" });
    }

    const systemPrompt = [
      "You are MARITIME AI — expert assistant for MPA Singapore vessel tracking.",
      "Specialties: AIS data, port regulations, cargo, fuel efficiency, CRM, contracts.",
      "Be concise, professional, use maritime terminology. Provide actionable advice.",
      fleetStats ? `Fleet: ${fleetStats}` : "",
      vesselData ? `Selected vessel: ${JSON.stringify(vesselData, null, 2)}` : (context || ""),
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

    const toneDescriptions = {
      professional:  "formal and professional",
      consultative:  "consultative and advisory",
      direct:        "direct and concise",
      friendly:      "friendly but professional",
      technical:     "technical and precise",
      executive:     "executive-level, strategic",
      urgent:        "urgent and action-oriented",
    };

    const systemPrompt = `You are a maritime business email specialist. Write a ${toneDescriptions[tone] || "professional"} email. Use maritime terminology. Return ONLY a JSON object with "subject" and "body" fields — no other text, no markdown.`;

    const userPrompt = [
      `Purpose: ${purpose}`,
      vesselName  ? `Vessel: ${vesselName}` : "",
      imoNumber   ? `IMO: ${imoNumber}` : "",
      companyName ? `Recipient: ${companyName}` : "",
      portName    ? `Port: ${portName}` : "",
      details     ? `Context:\n${details}` : "",
      "",
      "Write a compelling email (150-200 words) with a specific subject line and clear CTA.",
      'Return ONLY: {"subject":"...","body":"..."}',
    ].filter(s => s !== undefined).join("\n");

    const { text, provider } = await callLLM(systemPrompt, userPrompt, 700);

    let email = parseJSON(text);

    // Fallback: try to extract subject/body from plain text
    if (!email || !email.subject || !email.body) {
      const subMatch  = /subject[:\s"]+([^\n"]+)/i.exec(text);
      const bodyMatch = /body[:\s"]+([^"]+)/i.exec(text) || /\n\n([\s\S]+)/s.exec(text);
      email = {
        subject: subMatch?.[1]?.trim()  || `Re: ${companyName || vesselName || "Maritime Inquiry"}`,
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
      contract:     "Extract: parties, vessel, charter type, rates, key clauses, payment, red flags.",
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

    const system = "Maritime fuel efficiency expert. Return ONLY valid JSON — no other text.";
    const prompt = `Analyse fuel efficiency for vessel: ${JSON.stringify(vesselData)}
${routeData ? `Route: ${JSON.stringify(routeData)}` : ""}
Return ONLY: {"efficiency_score":0,"fuel_savings_daily_tons":0,"co2_reduction_daily_tons":0,"estimated_annual_savings_usd":0,"route_recommendations":["..."],"speed_recommendation":"...","ml_prediction":"...","confidence":"high|medium|low","current_vs_optimal_speed":{"current":0,"optimal":0,"savings_percent":0}}`;

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
    const prompt = `Predict ETA for ${vesselData.vessel_name || "vessel"} to ${destination}.
Vessel: ${JSON.stringify(vesselData)}
${weatherData ? `Weather: ${JSON.stringify(weatherData)}` : ""}
Return ONLY: {"eta_hours":0,"eta_range":{"min":0,"max":0},"confidence":"high|medium|low","factors":["..."],"risk_flags":["..."]}`;

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

    const sample = vessels.slice(0, 25).map(v => ({
      name: v.vessel_name, type: v.vessel_type, speed: v.speed,
      status: v.vessel_status, flag: v.flag, stale: v.is_stale,
    }));

    const system = "Maritime fleet analytics expert. Return ONLY valid JSON — no other text.";
    const prompt = `Analyse fleet (${vessels.length} vessels):
Stats: ${JSON.stringify(stats || {})}
Sample: ${JSON.stringify(sample)}
Return ONLY: {"headline_insight":"...","performance_summary":"...","top_concerns":["..."],"opportunities":["..."],"recommended_actions":["..."],"efficiency_trends":"...","port_congestion_risk":"low|medium|high"}`;

    const { text, provider } = await callLLM(system, prompt, 800);
    const insights = parseJSON(text);
    return res.json({ success: true, raw: text, insights, provider });
  } catch (err) {
    logger.error("[ai-fleet]", err.message);
    // Return 200 so frontend uses local fallback
    return res.json({ success: false, error: err.message, insights: null });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/ai/status
// ══════════════════════════════════════════════════════════════════
router.get("/status", (_req, res) => {
  const gKey = getGeminiKey();
  const cKey = getAnthropicKey();
  res.json({
    gemini: { configured: !!gKey, model: GEMINI_MODEL, key_preview: gKey ? `${gKey.slice(0,8)}...` : null },
    claude: { configured: !!cKey, model: CLAUDE_MODEL, key_preview: cKey ? `${cKey.slice(0,8)}...` : null },
    features: ["chat", "draft-email", "summarize", "analyze-fuel", "predict-arrival", "fleet-insights"],
  });
});

module.exports = router;
