// src/routes/ai_chat.js — Maritime AI Chat + LLM Engine v5
// FIXES:
//   1. In-memory response cache — identical requests served from cache instantly.
//      draft-email: 10min TTL (same vessel+company+purpose = same email)
//      fleet-insights: 5min TTL (fleet doesn't change second-by-second)
//      fuel-analysis: 10min TTL per vessel
//      chat: not cached (conversational, stateful)
//   2. In-flight deduplication — if two identical requests arrive simultaneously,
//      the second waits for the first to complete and shares its result.
//   3. Local fallback for fleet-insights — if Gemini is rate-limited, returns
//      computed analytics from vessel data without any API call.
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");
const { callLLM, parseJSON } = require("../utils/gemini");

// ── In-memory response cache ──────────────────────────────────────────────────
// key → { result, expiresAt }
const _cache    = new Map();
const _inflight = new Map(); // key → Promise (deduplication)

function cacheKey(...parts) {
  return parts.map(p => String(p ?? "").trim().toLowerCase().slice(0, 80)).join("|");
}

function fromCache(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.result;
}

function toCache(key, result, ttlMs) {
  _cache.set(key, { result, expiresAt: Date.now() + ttlMs });
  // Evict oldest entries if cache grows large
  if (_cache.size > 200) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
}

// Deduplication: if same key is already in-flight, wait for it
async function dedupe(key, fn) {
  if (_inflight.has(key)) {
    logger.info(`[ai-cache] dedupe hit for key "${key.slice(0, 60)}"`);
    return _inflight.get(key);
  }
  const promise = fn().finally(() => _inflight.delete(key));
  _inflight.set(key, promise);
  return promise;
}

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────
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

// ── Local email template engine ───────────────────────────────────────────────
// Generates a professional maritime email without any API call.
// Used as: (1) instant fallback when Gemini is rate-limited,
//          (2) immediate response while Gemini result is being cached.
function buildLocalEmail(purpose, vesselName, imoNumber, companyName, portName, tone, details) {
  const vessel  = vesselName  || "your vessel";
  const company = companyName || "your organisation";
  const port    = portName    || "Singapore";
  const imo     = imoNumber   ? ` (IMO ${imoNumber})` : "";

  const toneOpener = {
    urgent:       "We are writing with urgency regarding",
    executive:    "We wish to bring to your attention",
    friendly:     "We hope this message finds you well. We are reaching out regarding",
    technical:    "Please refer to the following technical correspondence regarding",
    direct:       "This email concerns",
    consultative: "Following our assessment, we would like to discuss",
  }[tone] || "We are writing regarding";

  // Purpose-specific templates
  const templates = {
    port_services: {
      subject: `Port Services Offer — ${vessel}${imo} | ${port}`,
      body: `${toneOpener} port services for ${vessel}${imo} at ${port}.

Our team at Kaizentric Technologies provides comprehensive port agency services including berthing arrangements, customs clearance, crew changes, bunker coordination, and 24/7 port operations support.

For ${vessel}'s upcoming call at ${port}, we can ensure efficient turnaround, competitive tariffs, and dedicated support from arrival to departure. Our local expertise and established relationships with MPA and port authorities guarantee smooth operations.

We would welcome the opportunity to serve as your preferred port agent. Please reply to this email or contact us directly to discuss your requirements.${details ? `\n\nAdditional context: ${details}` : ""}`,
    },
    bunker_inquiry: {
      subject: `Bunker Supply Enquiry — ${vessel}${imo} | ${port}`,
      body: `${toneOpener} bunker supply requirements for ${vessel}${imo} during its upcoming port call at ${port}.

We request your competitive quotation for the following grades: VLSFO, MGO, and HSFO (if applicable). Please provide your best all-in rates, quantity flexibility, and earliest delivery window.

${vessel} is managed by ${company}. All relevant vessel certificates and compliance documents are available upon request. We require full MARPOL compliance and valid BDN documentation.

Kindly revert with your offer at your earliest convenience so we may confirm arrangements ahead of the vessel's ETA.${details ? `\n\nAdditional notes: ${details}` : ""}`,
    },
    charter_inquiry: {
      subject: `Charter Enquiry — ${vessel}${imo}`,
      body: `${toneOpener} the potential charter of ${vessel}${imo} operated by ${company}.

We are interested in discussing charter arrangements for this vessel. Could you please provide the vessel's current availability, charter rate indications, and last cargo details? We are also interested in the vessel's trading history and any upcoming survey dates.

Our requirements include full vessel details, P&I club information, and class certificates. Subject to satisfactory inspection and documentation, we are prepared to move forward expeditiously.

We look forward to your prompt response.${details ? `\n\nSpecific requirements: ${details}` : ""}`,
    },
    crewing: {
      subject: `Crew Change Coordination — ${vessel}${imo} | ${port}`,
      body: `${toneOpener} crew change arrangements for ${vessel}${imo} at ${port}.

We require coordination support for an upcoming crew change. Please advise on current port authority requirements, quarantine protocols if applicable, and your agency fees for handling crew logistics.

We will need assistance with immigration formalities, transport arrangements between the vessel and airport, hotel accommodation if required, and any medical certificates or documentation.

Please confirm your availability to handle this crew change and provide a proforma disbursement account.${details ? `\n\nDetails: ${details}` : ""}`,
    },
    default: {
      subject: `Maritime Correspondence — ${vessel}${imo} | ${company}`,
      body: `${toneOpener} ${purpose.toLowerCase()} in connection with ${vessel}${imo}, managed by ${company}.

We would appreciate your prompt attention to this matter. Our team is available to discuss requirements, provide additional documentation, or arrange a call at your convenience.

Please do not hesitate to contact us should you require any further information or clarification.${details ? `\n\nAdditional context: ${details}` : ""}`,
    },
  };

  // Match purpose to template
  const purposeLower = purpose.toLowerCase();
  let tmpl = templates.default;
  if (purposeLower.includes("port") || purposeLower.includes("agent") || purposeLower.includes("service"))
    tmpl = templates.port_services;
  else if (purposeLower.includes("bunker") || purposeLower.includes("fuel"))
    tmpl = templates.bunker_inquiry;
  else if (purposeLower.includes("charter") || purposeLower.includes("hire"))
    tmpl = templates.charter_inquiry;
  else if (purposeLower.includes("crew") || purposeLower.includes("manning"))
    tmpl = templates.crewing;

  return {
    subject: tmpl.subject,
    body: tmpl.body.trim(),
  };
}

// ── POST /api/ai/draft-email ──────────────────────────────────────────────────
// Cache TTL: 10 min — same vessel + company + purpose = same email
router.post("/draft-email", async (req, res) => {
  try {
    const {
      purpose, vesselName, imoNumber, companyName, portName, details, tone = "professional",
    } = req.body || {};

    if (!purpose || !String(purpose).trim()) {
      return res.status(400).json({ success: false, error: "Email purpose required" });
    }

    const key = cacheKey("email", purpose, vesselName, imoNumber, companyName, portName, tone);

    // Serve from cache if available
    const cached = fromCache(key);
    if (cached) {
      logger.info(`[ai-cache] draft-email cache hit (${companyName || vesselName})`);
      return res.json({ ...cached, cached: true });
    }

    const result = await dedupe(key, async () => {
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
        vesselName  ? `Vessel: ${vesselName}`             : "",
        imoNumber   ? `IMO: ${imoNumber}`                 : "",
        companyName ? `Recipient company: ${companyName}` : "",
        portName    ? `Port: ${portName}`                 : "",
        details     ? `Additional context:\n${details}`   : "",
        "",
        "Write a compelling maritime business email (150-200 words) with a specific subject line and a clear call-to-action.",
        'Return ONLY this JSON (no other text): {"subject":"...","body":"..."}',
      ].filter(Boolean).join("\n");

      try {
        // Try Gemini first
        const { text, provider } = await callLLM(systemPrompt, userPrompt, 700);
        let email = parseJSON(text);
        if (!email || !email.subject || !email.body) {
          const subMatch  = /subject[:\s"]+([^\n"]{5,100})/i.exec(text);
          const bodyMatch = /body[:\s"]+([^"]{20,})/i.exec(text) || /\n\n([\s\S]{20,})/s.exec(text);
          email = {
            subject: subMatch?.[1]?.trim()  || `Re: ${companyName || vesselName || "Maritime Business"}`,
            body:    bodyMatch?.[1]?.trim() || text,
          };
        }
        return { success: true, email, provider, raw: text };

      } catch (geminiErr) {
        // Gemini rate-limited or unavailable — use local template instantly
        // This ensures the user ALWAYS gets a usable email draft, never an error
        logger.warn(`[ai-email] Gemini unavailable (${geminiErr.message.slice(0, 60)}), using local template`);
        const email = buildLocalEmail(purpose, vesselName, imoNumber, companyName, portName, tone, details);
        return {
          success:  true,
          email,
          provider: "local_template",
          note:     "Generated from local template — Gemini quota temporarily exhausted. This is a professional draft ready to use.",
        };
      }
    });

    toCache(key, result, 10 * 60 * 1000); // 10 min TTL
    return res.json(result);
  } catch (err) {
    logger.error("[ai-email]", err.message);
    // Last resort — never show a bare error, always return a template
    const email = buildLocalEmail(
      req.body?.purpose || "port services",
      req.body?.vesselName, req.body?.imoNumber,
      req.body?.companyName, req.body?.portName,
      req.body?.tone || "professional", req.body?.details
    );
    return res.json({ success: true, email, provider: "local_template", error: err.message });
  }
});

// ── POST /api/ai/summarize ────────────────────────────────────────────────────
router.post("/summarize", async (req, res) => {
  try {
    const { text, type = "cargo_report" } = req.body || {};
    if (!text || String(text).trim().length < 20) {
      return res.status(400).json({ success: false, error: "Document text required (min 20 chars)" });
    }

    const key = cacheKey("summarize", type, text.slice(0, 200));
    const cached = fromCache(key);
    if (cached) return res.json({ ...cached, cached: true });

    const typeInstructions = {
      cargo_report: "Extract: cargo type, quantity, ports, shipper, consignee, special handling, risks.",
      voyage_log:   "Extract: route, ports called, fuel, delays, incidents, ETA accuracy.",
      contract:     "Extract: parties, vessel, charter type, rates, key clauses, payment terms, red flags.",
      invoice:      "Extract: services, amounts, vessel, port charges, discrepancies, payment status.",
      bol:          "Extract: shipper, consignee, cargo, containers, routing, compliance flags.",
    };

    const system = `Maritime document analyst. ${typeInstructions[type] || typeInstructions.cargo_report} Return JSON: {"summary":"...","key_details":{},"action_items":[],"risk_flags":[],"confidence_score":0}`;
    const { text: result, provider } = await callLLM(system, text.slice(0, 4000), 1000);

    const out = { success: true, type, raw: result, parsed: parseJSON(result), provider };
    toCache(key, out, 15 * 60 * 1000); // 15 min — documents don't change
    return res.json(out);
  } catch (err) {
    logger.error("[ai-summarize]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/ai/analyze-fuel ─────────────────────────────────────────────────
router.post("/analyze-fuel", async (req, res) => {
  try {
    const { vesselData, routeData } = req.body || {};
    if (!vesselData) return res.status(400).json({ success: false, error: "vesselData required" });

    const key = cacheKey("fuel", vesselData.imo_number || vesselData.vessel_name, vesselData.speed);
    const cached = fromCache(key);
    if (cached) return res.json({ ...cached, cached: true });

    const result = await dedupe(key, async () => {
      const system = "Maritime fuel efficiency expert. Return ONLY a valid JSON object — no other text.";
      const prompt = `Analyse fuel efficiency for:\n${JSON.stringify(vesselData)}\n${routeData ? `Route: ${JSON.stringify(routeData)}` : ""}\nReturn ONLY: {"efficiency_score":0,"fuel_savings_daily_tons":0,"co2_reduction_daily_tons":0,"estimated_annual_savings_usd":0,"route_recommendations":["..."],"speed_recommendation":"...","ml_prediction":"...","confidence":"high|medium|low","current_vs_optimal_speed":{"current":0,"optimal":0,"savings_percent":0}}`;
      const { text, provider } = await callLLM(system, prompt, 800);
      return { success: true, vessel: vesselData.vessel_name, raw: text, analysis: parseJSON(text), provider };
    });

    toCache(key, result, 10 * 60 * 1000); // 10 min TTL
    return res.json(result);
  } catch (err) {
    logger.error("[ai-fuel]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/ai/predict-arrival ──────────────────────────────────────────────
router.post("/predict-arrival", async (req, res) => {
  try {
    const { vesselData, destination, weatherData } = req.body || {};
    if (!vesselData || !destination) {
      return res.status(400).json({ success: false, error: "vesselData and destination required" });
    }

    const key = cacheKey("predict", vesselData.imo_number, destination);
    const cached = fromCache(key);
    if (cached) return res.json({ ...cached, cached: true });

    const system = "Maritime ETA prediction specialist. Return ONLY valid JSON.";
    const prompt = `Predict ETA for ${vesselData.vessel_name || "vessel"} to ${destination}.\nVessel: ${JSON.stringify(vesselData)}\n${weatherData ? `Weather: ${JSON.stringify(weatherData)}` : ""}\nReturn ONLY: {"eta_hours":0,"eta_range":{"min":0,"max":0},"confidence":"high|medium|low","factors":["..."],"risk_flags":["..."]}`;

    const { text, provider } = await callLLM(system, prompt, 500);
    const out = { success: true, destination, raw: text, prediction: parseJSON(text), provider };
    toCache(key, out, 5 * 60 * 1000); // 5 min TTL
    return res.json(out);
  } catch (err) {
    logger.error("[ai-predict]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/ai/fleet-insights ───────────────────────────────────────────────
// Cache TTL: 5 min — fleet data doesn't change every second.
// Has a robust local fallback so UI never shows an error even if Gemini is busy.
router.post("/fleet-insights", async (req, res) => {
  try {
    const { stats, vessels = [] } = req.body || {};

    const key = cacheKey("fleet", vessels.length, JSON.stringify(stats || {}).slice(0, 100));

    // Serve from cache — fleet insights are expensive, cache aggressively
    const cached = fromCache(key);
    if (cached) {
      logger.info("[ai-cache] fleet-insights cache hit");
      return res.json({ ...cached, cached: true });
    }

    const result = await dedupe(key, async () => {
      const sample = vessels.slice(0, 20).map(v => ({
        name: v.vessel_name, type: v.vessel_type, speed: v.speed,
        status: v.vessel_status, flag: v.flag, stale: v.is_stale,
      }));

      const system = "Maritime fleet analytics expert. Return ONLY a valid JSON object — no other text.";
      const prompt = `Analyse fleet (${vessels.length} vessels):\nStats: ${JSON.stringify(stats || {})}\nSample: ${JSON.stringify(sample)}\nReturn ONLY: {"headline_insight":"...","performance_summary":"...","top_concerns":["..."],"opportunities":["..."],"recommended_actions":["..."],"efficiency_trends":"...","port_congestion_risk":"low|medium|high"}`;

      try {
        const { text, provider } = await callLLM(system, prompt, 800);
        const insights = parseJSON(text);
        return { success: true, raw: text, insights, provider };
      } catch (geminiErr) {
        // Local fallback — never return an error for fleet insights,
        // compute basic analytics from the vessel data directly
        logger.warn(`[ai-fleet] Gemini unavailable, using local fallback: ${geminiErr.message}`);
        const insights = buildLocalFleetInsights(vessels, stats);
        return { success: true, insights, provider: "local_fallback", cached_reason: geminiErr.message };
      }
    });

    toCache(key, result, 5 * 60 * 1000); // 5 min TTL
    return res.json(result);
  } catch (err) {
    logger.error("[ai-fleet]", err.message);
    // Always return something useful — never a bare 500 for fleet insights
    return res.json({
      success: true,
      insights: buildLocalFleetInsights([], {}),
      provider: "local_fallback",
      error: err.message,
    });
  }
});

// ── Local fleet insights fallback (no Gemini needed) ─────────────────────────
function buildLocalFleetInsights(vessels, stats) {
  const total    = vessels.length || (stats?.total_vessels ?? 0);
  const underway = vessels.filter(v => v.vessel_status === "underway" || (v.speed || 0) > 1).length;
  const inPort   = vessels.filter(v => v.vessel_status === "anchored" || (v.speed || 0) <= 1).length;
  const stale    = vessels.filter(v => v.is_stale).length;
  const avgSpeed = total > 0
    ? (vessels.reduce((s, v) => s + (v.speed || 0), 0) / total).toFixed(1)
    : 0;
  const types = {};
  vessels.forEach(v => { const t = v.vessel_type || "Unknown"; types[t] = (types[t] || 0) + 1; });
  const topType = Object.entries(types).sort((a, b) => b[1] - a[1])[0]?.[0] || "Mixed";

  return {
    headline_insight:    `${total} vessels tracked — ${underway} underway, ${inPort} at anchor/port. Average speed ${avgSpeed} kn.`,
    performance_summary: `Fleet is ${stale > total * 0.3 ? "showing significant AIS data lag" : "reporting normally"}. Dominant vessel type: ${topType}.`,
    top_concerns:        stale > 0 ? [`${stale} vessels with stale AIS data (>30 min)`] : ["No critical concerns detected"],
    opportunities:       ["Review slow-speed vessels for fuel optimisation", "Check port dwell times for efficiency gains"],
    recommended_actions: ["Refresh AIS feed for stale vessels", "Monitor vessels approaching Singapore Strait TSS"],
    efficiency_trends:   `Average fleet speed ${avgSpeed} kn. ${underway} of ${total} vessels actively underway.`,
    port_congestion_risk: inPort > total * 0.5 ? "high" : inPort > total * 0.3 ? "medium" : "low",
  };
}

// ── GET /api/ai/status ────────────────────────────────────────────────────────
router.get("/status", (_req, res) => {
  const gKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || "";
  res.json({
    gemini: {
      configured: !!gKey,
      model:      "gemini-2.0-flash",
      key_preview: gKey ? `${gKey.slice(0, 8)}...` : null,
      free_tier:  { rpm: 15, rpd: 1500 },
      setup_url:  "https://aistudio.google.com/apikey",
    },
    cache: {
      entries: _cache.size,
      note: "Responses cached 5-15min to reduce quota usage",
    },
    provider: "gemini-only",
    features:  ["chat", "draft-email", "summarize", "analyze-fuel", "predict-arrival", "fleet-insights"],
  });
});

module.exports = router;