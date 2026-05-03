// src/utils/gemini.js — Gemini caller v5
// ROOT CAUSE FIX: gemini-1.5-flash-latest returns 404 on free-tier API keys.
// All 1.5-family models removed. Using ONLY confirmed 2.x free-tier models.
//
// Model priority:
//   1. gemini-2.0-flash              — primary, fastest
//   2. gemini-2.0-flash-lite         — lighter, same quota pool
//   3. gemini-2.5-flash-preview-04-17 — newest, slightly slower
//
// Rate limit strategy:
//   - Global serial queue: ALL calls across ALL routes share one queue.
//     No concurrent requests → never bust 15 RPM.
//   - 5s minimum gap between calls (12/min max, under 15 RPM limit).
//   - On 429: skip model immediately, wait 15s, try next model.
//   - On ALL models 429: wait full 60s window, retry primary once.
"use strict";

const logger = require("./logger");

// ── ONLY confirmed-working free-tier models (May 2026) ────────────────────────
// gemini-1.5-flash-latest  → 404 on free-tier keys — REMOVED
// gemini-1.5-flash-8b      → removed from API      — REMOVED
// gemini-2.5-flash-preview uses same quota pool as 2.0-flash
const GEMINI_MODELS = [
  "gemini-2.0-flash",                // Primary ✅
  "gemini-2.0-flash-lite",           // Fallback ✅
  "gemini-2.5-flash-preview-04-17",  // Latest preview ✅
];

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ── Global serial queue ───────────────────────────────────────────────────────
// One queue shared by ALL routes (draft-email, fleet-insights, contact-enrich).
// Prevents simultaneous requests from burning the 15 RPM quota all at once.
const MIN_GAP_MS = 5_000;  // 5s gap = max 12 req/min, safely under 15 RPM
let _queue   = Promise.resolve();
let _lastAt  = 0;

function enqueue(fn) {
  _queue = _queue.then(async () => {
    const gap = MIN_GAP_MS - (Date.now() - _lastAt);
    if (gap > 0) await sleep(gap);
    _lastAt = Date.now();
    return fn();
  });
  return _queue;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Single HTTP attempt ───────────────────────────────────────────────────────
async function _attempt(model, apiKey, body) {
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(35_000),
  });
  return res;
}

// ── Main caller ───────────────────────────────────────────────────────────────
async function callGeminiWithRetry(systemPrompt, userMessage, maxTokens = 1000, opts = {}) {
  const { maxRetries = 1, baseDelayMs = 2000 } = opts;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || "";

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY not configured. Add it in Render → Environment → GEMINI_API_KEY. " +
      "Free key at: https://aistudio.google.com/apikey"
    );
  }

  const fullMessage = systemPrompt
    ? `[SYSTEM CONTEXT]\n${systemPrompt}\n\n[REQUEST]\n${userMessage}`
    : userMessage;

  const body = {
    contents: [{ role: "user", parts: [{ text: fullMessage }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };

  let lastError  = null;
  let allHit429  = true;   // track if every model got 429 (full quota hit)

  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res;
      try {
        res = await enqueue(() => _attempt(model, apiKey, body));
      } catch (err) {
        if (err.name === "AbortError" || err.name === "TimeoutError") {
          lastError = new Error(`Timeout on ${model}`);
          logger.warn(`[gemini] ${model}: timeout`);
          if (attempt < maxRetries) continue;
        } else {
          lastError = err;
        }
        break;
      }

      // ── 429: quota hit — skip this model, wait, try next ─────────────────
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "0");
        const waitMs     = retryAfter > 0 ? retryAfter * 1000 : 15_000;
        logger.warn(`[gemini] ${model}: 429 — waiting ${Math.round(waitMs / 1000)}s, trying next model`);
        await sleep(waitMs);
        lastError = new Error(`429 on ${model}`);
        break;  // move to next model, don't retry same one
      }

      // ── 404: model not on this key — skip immediately ─────────────────────
      if (res.status === 404) {
        logger.warn(`[gemini] ${model}: 404 not found — skipping`);
        lastError = new Error(`Model ${model} not found (404)`);
        allHit429 = false;
        break;  // next model
      }

      // ── 503: temporary — brief retry ─────────────────────────────────────
      if (res.status === 503) {
        logger.warn(`[gemini] ${model}: 503 — retrying`);
        if (attempt < maxRetries) { await sleep(baseDelayMs); continue; }
        lastError = new Error(`503 on ${model}`);
        allHit429 = false;
        break;
      }

      // ── 403: bad key — fail immediately ──────────────────────────────────
      if (res.status === 403) {
        const txt = await res.text().catch(() => "");
        throw new Error(
          `Gemini API key rejected (403). Check GEMINI_API_KEY in Render dashboard. ` +
          `Get a free key at https://aistudio.google.com/apikey. Details: ${txt.slice(0, 100)}`
        );
      }

      // ── Other HTTP error ──────────────────────────────────────────────────
      if (!res.ok) {
        const errTxt = await res.text().catch(() => "");
        lastError = new Error(`Gemini HTTP ${res.status}: ${errTxt.slice(0, 150)}`);
        allHit429 = false;
        if (attempt < maxRetries) { await sleep(baseDelayMs); continue; }
        break;
      }

      // ── Success ───────────────────────────────────────────────────────────
      allHit429 = false;
      const json = await res.json();
      const cand = json?.candidates?.[0];

      if (!cand) {
        const reason = json?.promptFeedback?.blockReason;
        lastError = new Error(reason ? `Content blocked: ${reason}` : "No candidates returned");
        if (attempt < maxRetries) { await sleep(baseDelayMs); continue; }
        break;
      }

      const text = cand?.content?.parts?.[0]?.text;
      if (!text) {
        lastError = new Error(`Empty response (finishReason: ${cand.finishReason || "UNKNOWN"})`);
        if (attempt < maxRetries) { await sleep(baseDelayMs); continue; }
        break;
      }

      logger.info(`[gemini] ✓ ${model} (${text.length} chars, attempt ${attempt + 1})`);
      return text;
    }
  }

  // All models exhausted. If all hit 429, the quota window needs to reset.
  // Wait 60s and retry once with the primary model as a last-chance attempt.
  if (allHit429) {
    logger.warn("[gemini] All models hit 429 — quota window full. Waiting 60s for reset…");
    await sleep(62_000);
    try {
      const res = await enqueue(() => _attempt(GEMINI_MODELS[0], apiKey, body));
      if (res.ok) {
        const json = await res.json();
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          logger.info(`[gemini] ✓ ${GEMINI_MODELS[0]} after quota reset`);
          return text;
        }
      }
    } catch (_) { /* fall through */ }
    throw new Error(
      "Gemini free-tier quota exhausted (15 req/min). " +
      "Waited 60s but still rate-limited. Try again in a moment, or upgrade to a paid key."
    );
  }

  throw lastError || new Error("Gemini: all models failed");
}

// ── callLLM: public interface ─────────────────────────────────────────────────
async function callLLM(systemPrompt, userMessage, maxTokens = 1000) {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set. Get free key: https://aistudio.google.com/apikey");
  }
  try {
    const text = await callGeminiWithRetry(systemPrompt, userMessage, maxTokens);
    return { text, provider: "gemini" };
  } catch (err) {
    logger.error(`[llm] Gemini failed: ${err.message}`);
    throw new Error(`AI generation failed — ${err.message}`);
  }
}

// ── parseJSON ─────────────────────────────────────────────────────────────────
function parseJSON(raw) {
  if (!raw) return null;
  try {
    const m = /```json\s*([\s\S]+?)\s*```/i.exec(raw)
           || /```\s*([\s\S]+?)\s*```/i.exec(raw)
           || /([{\[][^]*[}\]])/s.exec(raw);
    return m ? JSON.parse(m[1]) : null;
  } catch { return null; }
}

module.exports = { callLLM, callGeminiWithRetry, parseJSON };