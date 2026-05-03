// src/utils/gemini.js — Gemini caller v4
// KEY FIXES vs v3:
//   1. Global serial queue — all Gemini calls across the whole process are
//      serialised. No more concurrent requests blowing through 15 RPM.
//   2. On 429: stop retrying the same model, drain the queue wait, then try
//      the next model — avoids exponential backoff cascade that causes timeout.
//   3. Minimum 5s gap between requests (60s / 12 slots = 5s).
//   4. On 429 with no Retry-After, wait a full 15s before next attempt.
"use strict";

const logger = require("./logger");

// ── Models — only confirmed-working free-tier models ─────────────────────────
const GEMINI_MODELS = [
  "gemini-2.0-flash",         // Primary ✅
  "gemini-2.0-flash-lite",    // Lighter variant ✅
  "gemini-1.5-flash-latest",  // Stable alias (never 404) ✅
];

// ── Global serial queue ───────────────────────────────────────────────────────
// All calls share ONE queue so concurrent requests from different routes
// (draft-email + fleet-insights + contact enrichment) don't all fire at once.
let _queuePromise = Promise.resolve();
let _lastCallAt   = 0;
const MIN_GAP_MS  = 5_000;   // 5s gap → max 12 req/min, safely under 15 RPM

function enqueue(fn) {
  _queuePromise = _queuePromise.then(async () => {
    const gap = MIN_GAP_MS - (Date.now() - _lastCallAt);
    if (gap > 0) await sleep(gap);
    _lastCallAt = Date.now();
    return fn();
  });
  return _queuePromise;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Core HTTP call (single attempt, no retry logic — queue handles pacing) ───
async function _callOnce(url, body) {
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
  const { maxRetries = 2, baseDelayMs = 2000 } = opts;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || "";

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY not configured. Add it in Render → Environment. " +
      "Free key: https://aistudio.google.com/apikey"
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

  let lastError = null;

  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res;
      try {
        // All calls go through the serial queue — no concurrent requests
        res = await enqueue(() => _callOnce(url, body));
      } catch (err) {
        if (err.name === "AbortError" || err.name === "TimeoutError") {
          lastError = new Error(`Timeout on ${model} (attempt ${attempt + 1})`);
          logger.warn(`[gemini] ${model}: request timeout`);
          if (attempt < maxRetries) continue;
        } else {
          lastError = err;
        }
        break;
      }

      // ── 429: rate limited ─────────────────────────────────────────────────
      if (res.status === 429) {
        // Read Retry-After if provided, else use 15s flat wait
        const retryAfter = parseInt(res.headers.get("Retry-After") || "0");
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : 15_000;
        logger.warn(`[gemini] ${model}: 429 — waiting ${Math.round(waitMs / 1000)}s then trying next model`);
        // On 429: don't retry same model — burn the wait then move on
        await sleep(waitMs);
        lastError = new Error(`429 quota exceeded on ${model}`);
        break; // jump to next model
      }

      // ── 404: model not found ──────────────────────────────────────────────
      if (res.status === 404) {
        logger.warn(`[gemini] ${model}: 404 — skipping`);
        lastError = new Error(`Model ${model} not found (404)`);
        break; // jump to next model immediately
      }

      // ── 503: temporary unavailable ────────────────────────────────────────
      if (res.status === 503) {
        const delay = baseDelayMs * (attempt + 1);
        logger.warn(`[gemini] ${model}: 503 — retrying in ${delay}ms`);
        if (attempt < maxRetries) { await sleep(delay); continue; }
        lastError = new Error(`503 on ${model}`);
        break;
      }

      // ── 403: bad API key ──────────────────────────────────────────────────
      if (res.status === 403) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Gemini 403 — check your API key. Details: ${txt.slice(0, 150)}`);
      }

      // ── Other HTTP error ──────────────────────────────────────────────────
      if (!res.ok) {
        const errTxt = await res.text().catch(() => "");
        lastError = new Error(`Gemini HTTP ${res.status}: ${errTxt.slice(0, 150)}`);
        if (attempt < maxRetries) { await sleep(baseDelayMs); continue; }
        break;
      }

      // ── Success ───────────────────────────────────────────────────────────
      const json = await res.json();
      const cand = json?.candidates?.[0];

      if (!cand) {
        const reason = json?.promptFeedback?.blockReason;
        lastError = new Error(reason ? `Content blocked: ${reason}` : "No candidates");
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

    if (lastError?.message.includes("403")) break; // don't try other models on auth error
  }

  throw lastError || new Error("Gemini: all models exhausted");
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