// src/routes/gemini_contact.js — v1
// Direct Gemini AI contact enrichment endpoints
// Provides high-accuracy contact discovery powered by Gemini 2.0 Flash
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");
const {
  enrichCompanyWithGemini,
  lookupVesselByIMO,
  findPortAgentsWithGemini,
  geminiBoostPipeline,
} = require("../services/intelligence/geminiEnricher");
const { runPipeline } = require("../services/intelligence/pipeline");

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    p,
    new Promise((_, r) => { t = setTimeout(() => r(new Error(`${label} timed out after ${ms/1000}s`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/gemini/enrich
// Full AI-powered enrichment: IMO → company names → contacts
// Body: { imo, owner?, manager?, operator?, ship_manager?, forceRefresh? }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/enrich", async (req, res, next) => {
  try {
    const { imo, owner, manager, operator, ship_manager, forceRefresh } = req.body || {};
    const imoInt = imo ? parseInt(imo, 10) : null;

    if (!imoInt && !owner && !manager) {
      return res.status(400).json({ success: false, error: "Provide imo or owner/manager name" });
    }

    if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GEMINI_API_KEY) {
      return res.status(503).json({
        success: false,
        error: "GEMINI_API_KEY not configured. Add it to your .env file.",
        setup: "Get a free key at https://aistudio.google.com/apikey",
      });
    }

    logger.info(`[gemini-route] enrich IMO=${imoInt || "—"} owner="${owner || "—"}"`);

    // Run full pipeline with Gemini boost
    const result = await withTimeout(
      runPipeline({ imo: imoInt, owner, manager, operator, ship_manager, forceRefresh: forceRefresh === true }),
      120_000,
      `gemini enrich IMO ${imoInt}`
    );

    if (!result?.companies?.length) {
      return res.status(404).json({
        success: false,
        error: "No data found for this vessel/company",
        imo: imoInt,
      });
    }

    return res.json({
      success: true,
      imo: imoInt,
      gemini_used: result.gemini_used || false,
      companies: result.companies,
      top_contacts: result.top_contacts || [],
      top_phones: result.top_phones || [],
      pipeline_ran_at: result.pipeline_ran_at,
    });
  } catch (err) {
    logger.error("[gemini-route] enrich error:", err.message);
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/gemini/company
// Enrich a single company by name only
// Body: { company_name, domain? }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/company", async (req, res, next) => {
  try {
    const { company_name, domain } = req.body || {};
    if (!company_name || company_name.trim().length < 3) {
      return res.status(400).json({ success: false, error: "Provide company_name (min 3 chars)" });
    }
    if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GEMINI_API_KEY) {
      return res.status(503).json({ success: false, error: "GEMINI_API_KEY not configured" });
    }

    logger.info(`[gemini-route] company: "${company_name}"`);
    const result = await withTimeout(
      enrichCompanyWithGemini(company_name.trim(), domain || null),
      30_000,
      `gemini company "${company_name}"`
    );

    if (!result) {
      return res.status(404).json({ success: false, error: "No data found", company: company_name });
    }

    return res.json({ success: true, company: company_name, data: result });
  } catch (err) {
    logger.error("[gemini-route] company error:", err.message);
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/gemini/vessel/:imo
// Quick vessel identity lookup via Gemini
// ─────────────────────────────────────────────────────────────────────────────
router.get("/vessel/:imo", async (req, res, next) => {
  try {
    const imo = parseInt(req.params.imo, 10);
    if (!imo) return res.status(400).json({ success: false, error: "Invalid IMO" });
    if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GEMINI_API_KEY) {
      return res.status(503).json({ success: false, error: "GEMINI_API_KEY not configured" });
    }

    const result = await withTimeout(
      lookupVesselByIMO(imo, req.query.name || null),
      20_000,
      `vessel lookup IMO ${imo}`
    );

    if (!result) return res.status(404).json({ success: false, error: "No vessel data found", imo });
    return res.json({ success: true, imo, data: result });
  } catch (err) {
    logger.error("[gemini-route] vessel error:", err.message);
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/gemini/port-agents?port=Singapore&vesselType=tanker
// Find port agents using Gemini AI
// ─────────────────────────────────────────────────────────────────────────────
router.get("/port-agents", async (req, res, next) => {
  try {
    const portName   = req.query.port || req.query.portName || "";
    const portCode   = req.query.portCode || "";
    const vesselType = req.query.vesselType || "";

    if (!portName && !portCode) {
      return res.status(400).json({ success: false, error: "Provide port or portName" });
    }
    if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GEMINI_API_KEY) {
      return res.status(503).json({ success: false, error: "GEMINI_API_KEY not configured" });
    }

    const agents = await withTimeout(
      findPortAgentsWithGemini(portName || portCode, portCode, vesselType),
      25_000,
      `port agents ${portName}`
    );

    return res.json({
      success: true,
      port: portName || portCode,
      count: agents.length,
      agents,
    });
  } catch (err) {
    logger.error("[gemini-route] port-agents error:", err.message);
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/gemini/status
// Check Gemini API key status
// ─────────────────────────────────────────────────────────────────────────────
router.get("/status", (_req, res) => {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
  res.json({
    configured: !!key,
    model: "gemini-2.0-flash",
    key_preview: key ? `${key.slice(0, 8)}...${key.slice(-4)}` : null,
    free_tier: { requests_per_minute: 15, requests_per_day: 1500 },
    setup_url: "https://aistudio.google.com/apikey",
  });
});

module.exports = router;


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/gemini/crm-draft
// Persona extraction and CRM email helper using shared gemini util (with retry)
// ─────────────────────────────────────────────────────────────────────────────
const { callGeminiWithRetry } = require("../utils/gemini");

router.post("/crm-draft", async (req, res, next) => {
  try {
    const { type, url, label, prompt: userPrompt } = req.body || {};
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        success: false,
        error: "GEMINI_API_KEY not configured in Render environment variables",
      });
    }

    let systemPrompt = "";
    let fullPrompt   = "";

    if (type === "persona_extract") {
      systemPrompt = "You are a business intelligence analyst specialising in maritime industry personas. Write plain text descriptions only — no JSON, no headers, no bullet points.";
      fullPrompt   = [
        `Analyse company: ${url || "unknown"}`,
        `Persona name: ${label || "client"}`,
        "",
        "Write 3-4 sentences covering:",
        "• Industry focus and company size",
        "• Likely pain points and priorities in maritime operations",
        "• Decision-making style and communication preferences",
        "• What they value most in maritime service providers",
        "",
        "Respond with ONLY the persona description — plain text, no formatting.",
      ].join("\n");
    } else {
      systemPrompt = "You are a maritime CRM assistant.";
      fullPrompt   = userPrompt || "Help with maritime CRM.";
    }

    // Use shared utility: retry, backoff, model cascade
    const text = await callGeminiWithRetry(systemPrompt, fullPrompt, 600);

    return res.json({
      success:     true,
      type:        type || "generic",
      text,
      persona:     type === "persona_extract" ? text : undefined,
      description: type === "persona_extract" ? text : undefined,
    });
  } catch (err) {
    logger.error("[gemini-crm-draft]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});
