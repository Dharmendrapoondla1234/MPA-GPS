// src/routes/ai_chat.js — Maritime AI Chat + LLM Engine v2
// Gemini-primary, Claude fallback, graceful offline degradation
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");

// ── Model config ─────────────────────────────────────────────────
const GEMINI_MODEL    = "gemini-2.0-flash";
const CLAUDE_MODEL    = "claude-sonnet-4-5-20251022"; // correct versioned model ID

function getGeminiKey()    { return process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || ""; }
function getAnthropicKey() { return process.env.ANTHROPIC_API_KEY || ""; }

// ── Shared Gemini caller ─────────────────────────────────────────
async function callGemini(systemPrompt, userMessage, history = [], maxTokens = 1000) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured in environment");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // Build contents array (history + current message)
  const contents = [];
  for (const msg of history.slice(-10)) {
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: String(msg.content || "") }],
    });
  }
  contents.push({ role: "user", parts: [{ text: String(userMessage || "") }] });

  const body = {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: maxTokens,
      responseMimeType: "text/plain",
    },
  };

  // System instruction (optional — some versions don't support it)
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = json?.candidates?.[0]?.finishReason || "UNKNOWN";
    throw new Error(`Gemini returned empty response (finishReason: ${reason})`);
  }
  return text;
}

// ── Shared Claude caller ─────────────────────────────────────────
async function callClaude(systemPrompt, userMessage, history = [], maxTokens = 1000) {
  const apiKey = getAnthropicKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured in environment");

  const messages = [
    ...history.slice(-10).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") })),
    { role: "user", content: String(userMessage || "") },
  ];

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages,
  };
  if (systemPrompt) body.system = systemPrompt;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Claude API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json();
  const text = json?.content?.[0]?.text;
  if (!text) throw new Error("Claude returned empty response");
  return text;
}

// ── Unified LLM call: Gemini → Claude → Error ────────────────────
async function callLLM(systemPrompt, userMessage, history = [], maxTokens = 1000) {
  // Try Gemini first
  if (getGeminiKey()) {
    try {
      const text = await callGemini(systemPrompt, userMessage, history, maxTokens);
      return { text, provider: "gemini" };
    } catch (err) {
      logger.warn(`[ai] Gemini failed: ${err.message}`);
    }
  }
  // Fall back to Claude
  if (getAnthropicKey()) {
    try {
      const text = await callClaude(systemPrompt, userMessage, history, maxTokens);
      return { text, provider: "claude" };
    } catch (err) {
      logger.warn(`[ai] Claude failed: ${err.message}`);
    }
  }
  throw new Error("No AI provider available. Please configure GEMINI_API_KEY in your Render environment variables.");
}

// ── JSON parser helper ───────────────────────────────────────────
function parseJSON(raw) {
  try {
    const m = /```json\s*([\s\S]+?)\s*```/i.exec(raw) || /([\{\[][\s\S]*[\}\]])/s.exec(raw);
    return m ? JSON.parse(m[1]) : null;
  } catch { return null; }
}

// ── System prompt ────────────────────────────────────────────────
function buildSystemPrompt(vesselContext, fleetStats) {
  return `You are MARITIME AI — an expert assistant for the MPA (Maritime Port Authority) Singapore vessel tracking platform.

You specialise in:
• Vessel tracking and AIS data interpretation
• Maritime regulations and port operations
• Cargo management and logistics optimisation
• Fuel efficiency and route optimisation
• Port agent coordination and CRM
• Contract, invoice, and document analysis
• Shipping company intelligence and contact enrichment

Be concise, professional, and use correct maritime terminology. Always provide actionable advice.
${fleetStats ? `\nFleet: ${fleetStats}` : ""}
${vesselContext ? `\nSelected vessel:\n${vesselContext}` : ""}`;
}

// ══════════════════════════════════════════════════════════════════
// POST /api/ai/chat
// ══════════════════════════════════════════════════════════════════
router.post("/chat", async (req, res, next) => {
  try {
    const { message, context, history = [], vesselData, fleetStats } = req.body || {};
    if (!message || String(message).trim().length < 2) {
      return res.status(400).json({ success: false, error: "Message required (min 2 chars)" });
    }

    const systemPrompt = buildSystemPrompt(
      vesselData ? JSON.stringify(vesselData, null, 2) : (context || null),
      fleetStats || null
    );

    const { text, provider } = await callLLM(systemPrompt, message.trim(), history, 800);
    return res.json({ success: true, reply: text, provider });
  } catch (err) {
    logger.error("[ai-chat]", err.message);
    // Return a graceful error the frontend can display
    return res.status(200).json({
      success: false,
      reply: `⚠ AI unavailable: ${err.message}`,
      provider: "offline",
      error: err.message,
    });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/ai/draft-email
// ══════════════════════════════════════════════════════════════════
router.post("/draft-email", async (req, res, next) => {
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
      executive:     "executive-level, high-impact",
      urgent:        "urgent and action-oriented",
    };

    const systemPrompt = `You are a maritime business email specialist. Write ${toneMap[tone] || toneMap.professional} emails with proper maritime terminology. Always respond ONLY with valid JSON.`;

    const userPrompt = `Write a maritime business email with these parameters:
Purpose: ${purpose}
${vesselName   ? `Vessel: ${vesselName}` : ""}
${imoNumber    ? `IMO: ${imoNumber}` : ""}
${companyName  ? `Recipient company: ${companyName}` : ""}
${portName     ? `Port: ${portName}` : ""}
${details      ? `Additional context:\n${details}` : ""}

Requirements:
- Compelling subject line specific to the situation
- Professional email body (150-250 words)
- Clear call-to-action
- Proper maritime terminology

Respond with ONLY this JSON (no markdown, no extra text):
{"subject":"...","body":"..."}`;

    const { text, provider } = await callLLM(systemPrompt, userPrompt, [], 700);

    // Parse the JSON response
    let email = parseJSON(text);
    if (!email || !email.subject) {
      // Try to extract subject/body from plain text fallback
      const subMatch = /subject[:\s]+(.+?)(?:\n|body)/i.exec(text);
      const bodyMatch = /body[:\s]+([\s\S]+)/i.exec(text);
      email = {
        subject: subMatch?.[1]?.trim() || `Maritime Business — ${companyName || vesselName || "Follow Up"}`,
        body: bodyMatch?.[1]?.trim() || text,
      };
    }

    return res.json({ success: true, purpose, email, provider, raw: text });
  } catch (err) {
    logger.error("[ai-email]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/ai/summarize
// ══════════════════════════════════════════════════════════════════
router.post("/summarize", async (req, res, next) => {
  try {
    const { text, type = "cargo_report" } = req.body || {};
    if (!text || String(text).trim().length < 20) {
      return res.status(400).json({ success: false, error: "Document text required (min 20 chars)" });
    }

    const typePrompts = {
      cargo_report: "Summarize this cargo report. Extract: cargo type, quantity, ports, shipper, consignee, special handling, risk flags.",
      voyage_log:   "Analyze this voyage log. Extract: route, ports, fuel consumption, delays, incidents, ETA accuracy.",
      contract:     "Review this maritime contract. Extract: parties, vessel, charter type, rates, key clauses, payment terms, red flags.",
      invoice:      "Analyze this maritime invoice. Extract: services, amounts, vessel, port charges, discrepancies, payment status.",
      bol:          "Analyze this Bill of Lading. Extract: shipper, consignee, cargo, container numbers, routing, compliance flags.",
    };

    const systemPrompt = `You are a maritime document analyst. ${typePrompts[type] || typePrompts.cargo_report} Return structured JSON.`;
    const { text: result, provider } = await callLLM(systemPrompt, text.slice(0, 4000), [], 1000);

    const parsed = parseJSON(result);
    return res.json({ success: true, type, raw: result, parsed, provider, document_length: text.length });
  } catch (err) {
    logger.error("[ai-summarize]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/ai/analyze-fuel
// ══════════════════════════════════════════════════════════════════
router.post("/analyze-fuel", async (req, res, next) => {
  try {
    const { vesselData, routeData } = req.body || {};
    if (!vesselData) return res.status(400).json({ success: false, error: "Vessel data required" });

    const systemPrompt = `You are a maritime fuel efficiency expert. Analyse vessel performance and provide quantified recommendations. Return ONLY valid JSON.`;

    const userPrompt = `Analyse fuel efficiency for:
${JSON.stringify(vesselData, null, 2)}
${routeData ? `Route: ${JSON.stringify(routeData)}` : ""}

Return ONLY this JSON:
{"efficiency_score":0-100,"fuel_savings_daily_tons":0,"co2_reduction_daily_tons":0,"estimated_annual_savings_usd":0,"route_recommendations":["..."],"speed_recommendation":"...","ml_prediction":"...","confidence":"high|medium|low","current_vs_optimal_speed":{"current":0,"optimal":0,"savings_percent":0}}`;

    const { text, provider } = await callLLM(systemPrompt, userPrompt, [], 800);
    const analysis = parseJSON(text);
    return res.json({ success: true, vessel: vesselData.vessel_name, raw: text, analysis, provider });
  } catch (err) {
    logger.error("[ai-fuel]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/ai/predict-arrival
// ══════════════════════════════════════════════════════════════════
router.post("/predict-arrival", async (req, res, next) => {
  try {
    const { vesselData, destination, weatherData } = req.body || {};
    if (!vesselData || !destination) {
      return res.status(400).json({ success: false, error: "vesselData and destination required" });
    }

    const systemPrompt = `You are a maritime ETA prediction specialist. Return ONLY valid JSON.`;
    const userPrompt = `Predict ETA for vessel ${vesselData.vessel_name || ""} to ${destination}.
Vessel: ${JSON.stringify(vesselData)}
${weatherData ? `Weather: ${JSON.stringify(weatherData)}` : ""}

Return ONLY: {"eta_hours":0,"eta_range":{"min":0,"max":0},"confidence":"high|medium|low","factors":["..."],"risk_flags":["..."]}`;

    const { text, provider } = await callLLM(systemPrompt, userPrompt, [], 500);
    const prediction = parseJSON(text);
    return res.json({ success: true, destination, raw: text, prediction, provider });
  } catch (err) {
    logger.error("[ai-predict]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/ai/fleet-insights
// ══════════════════════════════════════════════════════════════════
router.post("/fleet-insights", async (req, res, next) => {
  try {
    const { stats, vessels = [] } = req.body || {};

    const systemPrompt = `You are a maritime fleet analytics expert. Analyse fleet performance and return actionable insights. Return ONLY valid JSON.`;

    const sample = vessels.slice(0, 25).map(v => ({
      name: v.vessel_name, type: v.vessel_type, speed: v.speed,
      status: v.vessel_status, flag: v.flag, stale: v.is_stale,
    }));

    const userPrompt = `Analyse fleet data (${vessels.length} vessels total):
Stats: ${JSON.stringify(stats || {})}
Sample: ${JSON.stringify(sample)}

Return ONLY this JSON:
{"headline_insight":"...","performance_summary":"...","top_concerns":["..."],"opportunities":["..."],"recommended_actions":["..."],"efficiency_trends":"...","port_congestion_risk":"low|medium|high"}`;

    const { text, provider } = await callLLM(systemPrompt, userPrompt, [], 800);
    const insights = parseJSON(text);
    return res.json({ success: true, raw: text, insights, provider });
  } catch (err) {
    logger.error("[ai-fleet]", err.message);
    // Return success:false so frontend can use local fallback
    return res.status(200).json({ success: false, error: err.message, insights: null });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/ai/status
// ══════════════════════════════════════════════════════════════════
router.get("/status", (_req, res) => {
  const geminiKey  = getGeminiKey();
  const claudeKey  = getAnthropicKey();
  res.json({
    gemini:  { configured: !!geminiKey, model: GEMINI_MODEL,  key_preview: geminiKey  ? `${geminiKey.slice(0,8)}...`  : null },
    claude:  { configured: !!claudeKey, model: CLAUDE_MODEL,  key_preview: claudeKey  ? `${claudeKey.slice(0,8)}...`  : null },
    features: ["chat", "draft-email", "summarize", "analyze-fuel", "predict-arrival", "fleet-insights"],
  });
});

module.exports = router;
