// src/routes/ai_chat.js — Maritime AI Chat + LLM Engine v1
// Unified AI chat endpoint powering Gemini + Claude Sonnet fallback
// Supports: vessel Q&A, cargo summarization, email drafting, RAG over fleet data
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");

const GEMINI_MODEL = "gemini-2.0-flash";
const ANTHROPIC_MODEL = "claude-sonnet-4-5";

function getGeminiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || null;
}
function getAnthropicKey() {
  return process.env.ANTHROPIC_API_KEY || null;
}

async function callGemini(systemPrompt, userMessage, history = [], maxTokens = 800) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const contents = [];
  // Add history
  for (const msg of history) {
    contents.push({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: msg.content }] });
  }
  contents.push({ role: "user", parts: [{ text: userMessage }] });

  const body = {
    contents,
    systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
    generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens, responseMimeType: "text/plain" },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text().catch(() => "")}`);
  const json = await res.json();
  return json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callClaude(systemPrompt, userMessage, history = [], maxTokens = 800) {
  const apiKey = getAnthropicKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system: systemPrompt, messages }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Claude error ${res.status}`);
  const json = await res.json();
  return json?.content?.[0]?.text || "";
}

function buildSystemPrompt(vesselContext, fleetStats) {
  return `You are an expert AI assistant for a Maritime Port Authority vessel tracking platform (MPA - Singapore). 
You specialize in:
- Vessel tracking and AIS data interpretation
- Maritime law and port regulations  
- Cargo management and logistics optimization
- Fuel efficiency and route optimization
- Port agent coordination and CRM
- Contract and invoice analysis
- Shipping company intelligence and contact enrichment

You have access to real-time fleet data. Be concise, professional, and use maritime terminology.
${fleetStats ? `\nFleet Summary: ${fleetStats}` : ""}
${vesselContext ? `\nCurrently selected vessel context:\n${vesselContext}` : ""}

Always provide actionable, specific maritime advice. Format responses clearly.`;
}

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────
router.post("/chat", async (req, res, next) => {
  try {
    const { message, context, history = [], vesselData, fleetStats, mode = "chat" } = req.body || {};
    if (!message || message.trim().length < 2) {
      return res.status(400).json({ success: false, error: "Message required" });
    }

    const systemPrompt = buildSystemPrompt(
      vesselData ? JSON.stringify(vesselData, null, 2) : context || null,
      fleetStats || null
    );

    let reply = "";
    let provider = "gemini";

    // Try Gemini first, fallback to Claude
    try {
      reply = await callGemini(systemPrompt, message.trim(), history);
      provider = "gemini";
    } catch (geminiErr) {
      logger.warn("[ai-chat] Gemini failed:", geminiErr.message?.slice(0, 80));
      try {
        reply = await callClaude(systemPrompt, message.trim(), history);
        provider = "claude";
      } catch (claudeErr) {
        logger.warn("[ai-chat] Claude failed:", claudeErr.message?.slice(0, 80));
        throw new Error("All AI providers unavailable");
      }
    }

    return res.json({ success: true, reply, provider, mode });
  } catch (err) {
    logger.error("[ai-chat]", err.message);
    next(err);
  }
});

// ── POST /api/ai/summarize ────────────────────────────────────────────────────
// Cargo report / voyage document summarization
router.post("/summarize", async (req, res, next) => {
  try {
    const { text, type = "cargo_report" } = req.body || {};
    if (!text || text.trim().length < 20) {
      return res.status(400).json({ success: false, error: "Document text required (min 20 chars)" });
    }

    const typePrompts = {
      cargo_report: "Summarize this cargo report. Extract: cargo type, quantity, loading/discharge ports, shipper, consignee, special handling requirements, risk flags.",
      voyage_log:   "Analyze this voyage log. Extract: route taken, ports called, fuel consumption, delays, incidents, ETA accuracy, crew notes.",
      contract:     "Review this maritime contract. Extract: parties, vessel details, charter type, rates, key clauses, payment terms, dispute resolution, red flags.",
      invoice:      "Analyze this maritime invoice. Extract: services rendered, amounts, vessel, port charges, discrepancies, payment status.",
      bol:          "Analyze this Bill of Lading. Extract: shipper, consignee, cargo description, container numbers, routing, special instructions, compliance flags.",
    };

    const prompt = typePrompts[type] || typePrompts.cargo_report;
    const systemPrompt = `You are a maritime document analyst. ${prompt}\n\nProvide a structured JSON response with: summary, key_details (object), action_items (array), risk_flags (array), confidence_score (0-100).`;

    let result = "";
    try {
      result = await callGemini(systemPrompt, text.slice(0, 4000), [], 1000);
    } catch {
      result = await callClaude(systemPrompt, text.slice(0, 4000), [], 1000);
    }

    // Try to parse JSON from response
    let parsed = null;
    try {
      const jsonMatch = /```json\s*([\s\S]+?)\s*```/.exec(result) || /(\{[\s\S]+\})/.exec(result);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[1]);
    } catch {}

    return res.json({ success: true, type, raw: result, parsed, document_length: text.length });
  } catch (err) {
    logger.error("[ai-summarize]", err.message);
    next(err);
  }
});

// ── POST /api/ai/draft-email ──────────────────────────────────────────────────
// AI email drafting for maritime CRM
router.post("/draft-email", async (req, res, next) => {
  try {
    const { purpose, vesselName, imoNumber, companyName, portName, details, tone = "professional" } = req.body || {};
    if (!purpose) return res.status(400).json({ success: false, error: "Email purpose required" });

    const toneMap = { professional: "formal and professional", friendly: "friendly but professional", urgent: "urgent and direct" };
    const systemPrompt = `You are a maritime operations specialist drafting business emails. Write ${toneMap[tone] || toneMap.professional} maritime emails. Use proper maritime terminology.`;

    const userPrompt = `Draft a maritime email for the following:
Purpose: ${purpose}
${vesselName ? `Vessel: ${vesselName}` : ""}
${imoNumber ? `IMO: ${imoNumber}` : ""}
${companyName ? `Company/Recipient: ${companyName}` : ""}
${portName ? `Port: ${portName}` : ""}
${details ? `Additional details: ${details}` : ""}

Provide: Subject line and full email body. Format as JSON: { "subject": "...", "body": "..." }`;

    let result = "";
    try {
      result = await callGemini(systemPrompt, userPrompt, [], 600);
    } catch {
      result = await callClaude(systemPrompt, userPrompt, [], 600);
    }

    let parsed = null;
    try {
      const m = /```json\s*([\s\S]+?)\s*```/.exec(result) || /(\{[\s\S]+\})/s.exec(result);
      if (m) parsed = JSON.parse(m[1]);
    } catch {}

    return res.json({ success: true, purpose, raw: result, email: parsed });
  } catch (err) {
    logger.error("[ai-email]", err.message);
    next(err);
  }
});

// ── POST /api/ai/analyze-fuel ─────────────────────────────────────────────────
// AI-powered fuel & route optimization
router.post("/analyze-fuel", async (req, res, next) => {
  try {
    const { vesselData, routeData, fuelHistory } = req.body || {};
    if (!vesselData) return res.status(400).json({ success: false, error: "Vessel data required" });

    const systemPrompt = `You are a maritime fuel efficiency and route optimization expert. Analyze vessel performance and provide specific, quantified recommendations.`;

    const userPrompt = `Analyze fuel efficiency and route optimization for this vessel:
${JSON.stringify(vesselData, null, 2)}
${routeData ? `Route data: ${JSON.stringify(routeData)}` : ""}
${fuelHistory ? `Fuel history: ${JSON.stringify(fuelHistory)}` : ""}

Provide JSON response with:
{
  "efficiency_score": 0-100,
  "current_vs_optimal_speed": { "current": x, "optimal": y, "savings_percent": z },
  "fuel_savings_daily_tons": number,
  "co2_reduction_daily_tons": number,
  "route_recommendations": ["..."],
  "speed_recommendation": "...",
  "estimated_annual_savings_usd": number,
  "ml_prediction": "...",
  "confidence": "high|medium|low"
}`;

    let result = "";
    try {
      result = await callGemini(systemPrompt, userPrompt, [], 800);
    } catch {
      result = await callClaude(systemPrompt, userPrompt, [], 800);
    }

    let parsed = null;
    try {
      const m = /```json\s*([\s\S]+?)\s*```/.exec(result) || /(\{[\s\S]+\})/s.exec(result);
      if (m) parsed = JSON.parse(m[1]);
    } catch {}

    return res.json({ success: true, vessel: vesselData.vessel_name, raw: result, analysis: parsed });
  } catch (err) {
    logger.error("[ai-fuel]", err.message);
    next(err);
  }
});

// ── POST /api/ai/predict-arrival ──────────────────────────────────────────────
// ML-enhanced ETA prediction
router.post("/predict-arrival", async (req, res, next) => {
  try {
    const { vesselData, destination, weatherData } = req.body || {};
    if (!vesselData || !destination) {
      return res.status(400).json({ success: false, error: "vesselData and destination required" });
    }

    const systemPrompt = `You are a maritime ETA prediction specialist. Use vessel speed, heading, distance, and weather to predict arrival times with confidence intervals.`;
    const userPrompt = `Predict ETA for this vessel to ${destination}:
Vessel: ${JSON.stringify(vesselData)}
${weatherData ? `Weather: ${JSON.stringify(weatherData)}` : ""}

Respond with JSON: { "eta_hours": number, "eta_range": { "min": h, "max": h }, "confidence": "high|medium|low", "factors": [...], "risk_flags": [...] }`;

    let result = "";
    try {
      result = await callGemini(systemPrompt, userPrompt, [], 400);
    } catch {
      result = await callClaude(systemPrompt, userPrompt, [], 400);
    }

    let parsed = null;
    try {
      const m = /```json\s*([\s\S]+?)\s*```/.exec(result) || /(\{[\s\S]+\})/s.exec(result);
      if (m) parsed = JSON.parse(m[1]);
    } catch {}

    return res.json({ success: true, destination, raw: result, prediction: parsed });
  } catch (err) {
    logger.error("[ai-predict]", err.message);
    next(err);
  }
});

// ── GET /api/ai/fleet-insights ────────────────────────────────────────────────
// AI-generated fleet insights from BigQuery data
router.post("/fleet-insights", async (req, res, next) => {
  try {
    const { stats, vessels = [] } = req.body || {};
    const systemPrompt = `You are a maritime fleet analytics expert. Analyze fleet performance data and provide actionable insights.`;

    const vesselSample = vessels.slice(0, 20).map(v => ({
      name: v.vessel_name, type: v.vessel_type, speed: v.speed,
      status: v.vessel_status, flag: v.flag, stale: v.is_stale,
    }));

    const userPrompt = `Analyze this fleet data and provide strategic insights:
Stats: ${JSON.stringify(stats || {})}
Sample vessels (${vessels.length} total): ${JSON.stringify(vesselSample)}

Provide JSON: {
  "headline_insight": "...",
  "performance_summary": "...",
  "top_concerns": ["..."],
  "opportunities": ["..."],
  "recommended_actions": ["..."],
  "efficiency_trends": "...",
  "port_congestion_risk": "low|medium|high"
}`;

    let result = "";
    try {
      result = await callGemini(systemPrompt, userPrompt, [], 800);
    } catch {
      result = await callClaude(systemPrompt, userPrompt, [], 800);
    }

    let parsed = null;
    try {
      const m = /```json\s*([\s\S]+?)\s*```/.exec(result) || /(\{[\s\S]+\})/s.exec(result);
      if (m) parsed = JSON.parse(m[1]);
    } catch {}

    return res.json({ success: true, raw: result, insights: parsed });
  } catch (err) {
    logger.error("[ai-fleet]", err.message);
    next(err);
  }
});

// ── GET /api/ai/status ────────────────────────────────────────────────────────
router.get("/status", (_req, res) => {
  const geminiKey = getGeminiKey();
  const claudeKey = getAnthropicKey();
  res.json({
    gemini:  { configured: !!geminiKey, model: GEMINI_MODEL, key_preview: geminiKey ? `${geminiKey.slice(0,8)}...` : null },
    claude:  { configured: !!claudeKey, model: ANTHROPIC_MODEL, key_preview: claudeKey ? `${claudeKey.slice(0,8)}...` : null },
    features: ["chat", "summarize", "draft-email", "analyze-fuel", "predict-arrival", "fleet-insights"],
  });
});

module.exports = router;
