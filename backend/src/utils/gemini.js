// src/utils/gemini.js — Gemini-only caller with retry, backoff, model fallback
// Claude/Anthropic fallback removed — all AI calls use Gemini exclusively.
// Get a free Gemini API key at https://aistudio.google.com/apikey
"use strict";

const logger = require("./logger");

// Model cascade: try newest first, fall back to stable versions
const GEMINI_MODELS = [
  "gemini-2.0-flash",        // Latest — fast and capable
  "gemini-1.5-flash",        // Stable fallback
  "gemini-1.5-flash-8b",     // Lightweight last resort
];

// Simple in-memory rate limiter (per-process)
const rateLimiter = {
  requests: [],
  maxPerMinute: 12,          // Stay under 15 rpm free tier limit
  isAllowed() {
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < 60000);
    if (this.requests.length >= this.maxPerMinute) return false;
    this.requests.push(now);
    return true;
  },
  waitMs() {
    if (this.requests.length === 0) return 0;
    const oldest = this.requests[0];
    const elapsed = Date.now() - oldest;
    return Math.max(0, 60000 - elapsed + 1000);
  },
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Call Gemini with automatic retry, exponential backoff, and model fallback.
 */
async function callGeminiWithRetry(systemPrompt, userMessage, maxTokens = 1000, opts = {}) {
  const { maxRetries = 3, baseDelayMs = 1000 } = opts;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || "";

  if (!apiKey) throw new Error("GEMINI_API_KEY not configured in Render environment variables. Get a free key at https://aistudio.google.com/apikey");

  const fullMessage = systemPrompt
    ? `[SYSTEM CONTEXT]\n${systemPrompt}\n\n[REQUEST]\n${userMessage}`
    : userMessage;

  const requestBody = {
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

  let lastError = null;

  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (!rateLimiter.isAllowed()) {
        const waitMs = rateLimiter.waitMs();
        logger.warn(`[gemini] Rate limit: waiting ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        rateLimiter.isAllowed();
      }

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(35000),
        });

        if (res.status === 429) {
          const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
          logger.warn(`[gemini] ${model}: 429 rate limited, retrying in ${Math.round(delay)}ms`);
          if (attempt < maxRetries) { await sleep(delay); continue; }
          lastError = new Error(`Gemini rate limited (429) on ${model} after ${maxRetries} retries.`);
          break;
        }

        if (res.status === 503) {
          const delay = baseDelayMs * (attempt + 1);
          logger.warn(`[gemini] ${model}: 503 unavailable, retrying in ${delay}ms`);
          if (attempt < maxRetries) { await sleep(delay); continue; }
          lastError = new Error(`Gemini service unavailable (503) on ${model}`);
          break;
        }

        if (res.status === 404) {
          logger.warn(`[gemini] ${model}: 404 not found, trying next model`);
          lastError = new Error(`Model ${model} not found (404)`);
          break;
        }

        if (res.status === 403) {
          const errBody = await res.text().catch(() => "");
          throw new Error(`Gemini 403 Forbidden: ${errBody.slice(0, 200)} — check your API key at console.cloud.google.com`);
        }

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          lastError = new Error(`Gemini ${res.status}: ${errBody.slice(0, 200)}`);
          if (attempt < maxRetries) { await sleep(baseDelayMs * (attempt + 1)); continue; }
          break;
        }

        const json = await res.json();
        const candidate = json?.candidates?.[0];

        if (!candidate) {
          const blockReason = json?.promptFeedback?.blockReason;
          if (blockReason) { lastError = new Error(`Gemini content blocked: ${blockReason}`); break; }
          lastError = new Error("Gemini returned no candidates");
          if (attempt < maxRetries) { await sleep(baseDelayMs); continue; }
          break;
        }

        if (candidate.finishReason === "SAFETY") {
          lastError = new Error(`Gemini safety filter triggered on ${model}`);
          break;
        }

        const text = candidate?.content?.parts?.[0]?.text;
        if (!text) {
          lastError = new Error(`Gemini empty text (finishReason: ${candidate.finishReason || "UNKNOWN"})`);
          if (attempt < maxRetries) { await sleep(baseDelayMs); continue; }
          break;
        }

        logger.info(`[gemini] ✓ ${model} responded (${text.length} chars, attempt ${attempt + 1})`);
        return text;

      } catch (err) {
        if (err.name === "AbortError" || err.name === "TimeoutError") {
          lastError = new Error(`Gemini request timed out on ${model}`);
          if (attempt < maxRetries) { await sleep(baseDelayMs * (attempt + 1)); continue; }
        } else {
          lastError = err;
          if (attempt < maxRetries && !err.message.includes("403")) {
            await sleep(baseDelayMs * (attempt + 1));
            continue;
          }
        }
        break;
      }
    }

    if (lastError?.message.includes("403")) break;
  }

  throw lastError || new Error("Gemini: all models exhausted");
}

/**
 * Primary LLM call: Gemini-only (no Claude fallback).
 * Configure GEMINI_API_KEY in your Render environment variables.
 */
async function callLLM(systemPrompt, userMessage, maxTokens = 1000) {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY not configured. Add it to your Render environment variables. " +
      "Get a free key at https://aistudio.google.com/apikey"
    );
  }
  try {
    const text = await callGeminiWithRetry(systemPrompt, userMessage, maxTokens);
    return { text, provider: "gemini" };
  } catch (err) {
    logger.error(`[llm] Gemini failed: ${err.message}`);
    throw new Error(`AI generation failed — ${err.message}`);
  }
}

/**
 * Parse JSON from LLM response (handles code blocks and raw JSON)
 */
function parseJSON(raw) {
  if (!raw) return null;
  try {
    const m = /```json\s*([\s\S]+?)\s*```/i.exec(raw)
           || /```\s*([\s\S]+?)\s*```/i.exec(raw)
           || /([{\[][\s\S]*[}\]])/s.exec(raw);
    return m ? JSON.parse(m[1]) : null;
  } catch { return null; }
}

module.exports = { callLLM, callGeminiWithRetry, parseJSON };