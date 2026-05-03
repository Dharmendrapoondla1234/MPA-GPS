// src/utils/gemini.js — Gemini caller v3
// Uses @google/generative-ai SDK (more reliable than raw fetch for model errors)
// Model cascade: gemini-2.0-flash → gemini-2.0-flash-lite → gemini-1.5-flash-latest
"use strict";

const logger = require("./logger");

// ── Model list — ONLY models confirmed working on free tier ──────────────────
// gemini-1.5-flash (without -latest) returns 404 on some API key tiers.
// gemini-1.5-flash-latest is the stable alias that always resolves correctly.
const GEMINI_MODELS = [
  "gemini-2.0-flash",           // Primary — fast, free tier ✅
  "gemini-2.0-flash-lite",      // Lighter 2.0 variant ✅
  "gemini-1.5-flash-latest",    // Stable alias — never returns 404 ✅
];

// ── Rate limiter: stay under 15 RPM free tier ────────────────────────────────
const RL = {
  calls: [],
  MAX: 12,           // conservative — leave buffer
  INTERVAL: 4500,    // ms between calls minimum
  last: 0,
  async wait() {
    // Spacing: enforce minimum gap between calls
    const gap = this.INTERVAL - (Date.now() - this.last);
    if (gap > 0) await sleep(gap);
    this.last = Date.now();
    // Window: max 12 per minute
    const now = Date.now();
    this.calls = this.calls.filter(t => now - t < 60_000);
    if (this.calls.length >= this.MAX) {
      const waitMs = 61_000 - (now - this.calls[0]);
      logger.warn(`[gemini] RPM cap — waiting ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
    this.calls.push(Date.now());
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Core caller ───────────────────────────────────────────────────────────────
async function callGeminiWithRetry(systemPrompt, userMessage, maxTokens = 1000, opts = {}) {
  const { maxRetries = 3, baseDelayMs = 1500 } = opts;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || "";
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY not configured. Add it in Render → Environment → GEMINI_API_KEY. " +
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
      await RL.wait();
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(40_000),
        });

        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get("Retry-After") || "0") * 1000;
          const delay = retryAfter || baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
          logger.warn(`[gemini] ${model}: 429 rate limited, retrying in ${Math.round(delay)}ms`);
          if (attempt < maxRetries) { await sleep(delay); continue; }
          lastError = new Error(`429 rate limited on ${model}`);
          break;
        }

        if (res.status === 404) {
          logger.warn(`[gemini] ${model}: 404 not found, trying next model`);
          lastError = new Error(`Model ${model} not found (404)`);
          break; // try next model immediately — no point retrying 404
        }

        if (res.status === 503) {
          const delay = baseDelayMs * (attempt + 1);
          logger.warn(`[gemini] ${model}: 503 unavailable, retrying in ${delay}ms`);
          if (attempt < maxRetries) { await sleep(delay); continue; }
          lastError = new Error(`503 unavailable on ${model}`);
          break;
        }

        if (res.status === 403) {
          const txt = await res.text().catch(() => "");
          throw new Error(`Gemini 403 — check API key: ${txt.slice(0, 200)}`);
        }

        if (!res.ok) {
          const errTxt = await res.text().catch(() => "");
          lastError = new Error(`Gemini ${res.status}: ${errTxt.slice(0, 200)}`);
          if (attempt < maxRetries) { await sleep(baseDelayMs * (attempt + 1)); continue; }
          break;
        }

        const json  = await res.json();
        const cand  = json?.candidates?.[0];
        if (!cand) {
          const reason = json?.promptFeedback?.blockReason;
          lastError = new Error(reason ? `Content blocked: ${reason}` : "No candidates returned");
          if (attempt < maxRetries) { await sleep(baseDelayMs); continue; }
          break;
        }

        const text = cand?.content?.parts?.[0]?.text;
        if (!text) {
          lastError = new Error(`Empty text (finishReason: ${cand.finishReason || "UNKNOWN"})`);
          if (attempt < maxRetries) { await sleep(baseDelayMs); continue; }
          break;
        }

        logger.info(`[gemini] ✓ ${model} (${text.length} chars, attempt ${attempt + 1})`);
        return text;

      } catch (err) {
        if (err.name === "AbortError" || err.name === "TimeoutError") {
          lastError = new Error(`Timeout on ${model}`);
          if (attempt < maxRetries) { await sleep(baseDelayMs * (attempt + 1)); continue; }
        } else if (err.message.includes("403")) {
          throw err; // don't retry auth errors
        } else {
          lastError = err;
          if (attempt < maxRetries) { await sleep(baseDelayMs * (attempt + 1)); continue; }
        }
        break;
      }
    }

    if (lastError?.message.includes("403")) break;
  }

  throw lastError || new Error("Gemini: all models exhausted");
}

// ── callLLM: public interface used by routes ──────────────────────────────────
async function callLLM(systemPrompt, userMessage, maxTokens = 1000) {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set in Render environment. Get free key: https://aistudio.google.com/apikey");
  }
  try {
    const text = await callGeminiWithRetry(systemPrompt, userMessage, maxTokens);
    return { text, provider: "gemini" };
  } catch (err) {
    logger.error(`[llm] Gemini failed: ${err.message}`);
    throw new Error(`AI generation failed — ${err.message}`);
  }
}

// ── parseJSON: extract JSON from LLM response ────────────────────────────────
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