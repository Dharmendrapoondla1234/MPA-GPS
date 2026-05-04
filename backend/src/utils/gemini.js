// src/utils/gemini.js — Gemini caller v6
//
// FINAL MODEL FIX (from live logs):
//   gemini-2.0-flash              ✅ works — PRIMARY AND ONLY MODEL
//   gemini-2.0-flash-lite         ❌ same quota pool as 2.0-flash, both hit 429 together
//   gemini-2.5-flash-preview-*    ❌ 404 on this API key
//   gemini-1.5-flash-*            ❌ 404 on free-tier keys
//
// Free-tier quota: 15 requests/minute TOTAL across all gemini-2.0-* models.
// Trying multiple models when quota is full is pointless — they share the pool.
//
// STRATEGY: Single model, strict global serial queue, intelligent 429 handling.
//   - One call every 5s max (12/min, safely under 15 RPM)
//   - On 429: read Retry-After header, wait exactly that long, then retry ONCE
//   - On 429 with no Retry-After: wait 20s (empirically safe reset window)
//   - Queue all calls across all routes — no concurrent Gemini requests ever
"use strict";

const logger = require("./logger");

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ── Global serial queue ───────────────────────────────────────────────────────
// Single queue shared by ALL routes. Prevents multiple features from firing
// simultaneously and blowing through the 15 RPM quota instantly.
const MIN_GAP_MS = 5_000;  // 5s between calls = max 12/min
let _queue  = Promise.resolve();
let _lastAt = 0;

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

// ── Core caller ───────────────────────────────────────────────────────────────
async function callGeminiWithRetry(systemPrompt, userMessage, maxTokens = 1000, opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || "";

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY not configured. " +
      "Add it in Render → Environment → GEMINI_API_KEY. " +
      "Get a free key at: https://aistudio.google.com/apikey"
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

  // Max 3 attempts for this single model
  // On 429: wait the correct reset period, then retry
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await enqueue(async () => {
        const url = `${GEMINI_URL}?key=${apiKey}`;
        return fetch(url, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
          signal:  AbortSignal.timeout(35_000),
        });
      });
    } catch (err) {
      if (err.name === "AbortError" || err.name === "TimeoutError") {
        if (attempt < MAX_ATTEMPTS) {
          logger.warn(`[gemini] timeout on attempt ${attempt}, retrying`);
          continue;
        }
        throw new Error("Gemini request timed out. Please try again.");
      }
      throw err;
    }

    // ── 429: quota hit ────────────────────────────────────────────────────────
    if (res.status === 429) {
      // Retry-After header gives us the exact seconds to wait
      const retryAfter = parseInt(res.headers.get("Retry-After") || "0");
      const waitMs = retryAfter > 0 ? (retryAfter + 1) * 1000 : 20_000;

      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`[gemini] 429 — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
        await sleep(waitMs);
        continue;
      }
      throw new Error(
        `Gemini rate limited (429) after ${MAX_ATTEMPTS} attempts. ` +
        `Free tier: 15 requests/minute. Please wait a moment and try again.`
      );
    }

    // ── 404: model not available on this key ──────────────────────────────────
    if (res.status === 404) {
      throw new Error(
        `Gemini model '${GEMINI_MODEL}' not found (404). ` +
        `Your API key may not have access. Verify at https://aistudio.google.com/apikey`
      );
    }

    // ── 403: bad API key ──────────────────────────────────────────────────────
    if (res.status === 403) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `Gemini API key rejected (403). ` +
        `Check GEMINI_API_KEY in Render dashboard. ` +
        `Get a free key at https://aistudio.google.com/apikey`
      );
    }

    // ── 503: service temporarily unavailable ─────────────────────────────────
    if (res.status === 503) {
      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`[gemini] 503 on attempt ${attempt}, retrying in 3s`);
        await sleep(3_000);
        continue;
      }
      throw new Error("Gemini service temporarily unavailable (503). Try again shortly.");
    }

    // ── Other error ───────────────────────────────────────────────────────────
    if (!res.ok) {
      const errTxt = await res.text().catch(() => "");
      if (attempt < MAX_ATTEMPTS) {
        logger.warn(`[gemini] HTTP ${res.status} on attempt ${attempt}, retrying`);
        await sleep(2_000);
        continue;
      }
      throw new Error(`Gemini HTTP ${res.status}: ${errTxt.slice(0, 150)}`);
    }

    // ── Success ───────────────────────────────────────────────────────────────
    const json = await res.json();
    const cand = json?.candidates?.[0];

    if (!cand) {
      const reason = json?.promptFeedback?.blockReason;
      if (reason) throw new Error(`Content blocked by Gemini safety filter: ${reason}`);
      if (attempt < MAX_ATTEMPTS) { await sleep(1_000); continue; }
      throw new Error("Gemini returned no response candidates.");
    }

    const text = cand?.content?.parts?.[0]?.text;
    if (!text) {
      if (attempt < MAX_ATTEMPTS) { await sleep(1_000); continue; }
      throw new Error(`Gemini returned empty text (finishReason: ${cand.finishReason || "UNKNOWN"})`);
    }

    logger.info(`[gemini] ✓ ${GEMINI_MODEL} — ${text.length} chars (attempt ${attempt})`);
    return text;
  }

  throw new Error("Gemini: exhausted all attempts");
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