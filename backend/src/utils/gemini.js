// src/utils/gemini.js — Robust Gemini caller with retry, backoff, model fallback
// Handles: 429 rate limits, 503 unavailable, 404 model not found, 403 forbidden
"use strict";

const logger = require("./logger");

// Model cascade: try newest first, fall back to stable versions
const GEMINI_MODELS = [
  "gemini-1.5-flash",        // Most reliable free-tier model
  "gemini-1.5-flash-8b",     // Lightweight fallback
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
    return Math.max(0, 60000 - elapsed + 1000); // wait until window clears + 1s buffer
  },
};

// Sleep helper
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Call Gemini with automatic retry, exponential backoff, and model fallback.
 * @param {string} systemPrompt  - System context (embedded in user message)
 * @param {string} userMessage   - The actual user prompt
 * @param {number} maxTokens     - Max output tokens
 * @param {Object} opts
 * @param {number} opts.maxRetries   - Max retry attempts (default: 3)
 * @param {number} opts.baseDelayMs  - Base delay for backoff (default: 1000)
 * @returns {Promise<string>} The generated text
 */
async function callGeminiWithRetry(systemPrompt, userMessage, maxTokens = 1000, opts = {}) {
  const { maxRetries = 3, baseDelayMs = 1000 } = opts;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || "";

  if (!apiKey) throw new Error("GEMINI_API_KEY not configured in Render environment variables");

  // Embed system context into user message — free-tier compatible, no systemInstruction
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

  // Try each model in cascade
  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // Retry loop per model
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Rate limit check — wait if needed
      if (!rateLimiter.isAllowed()) {
        const waitMs = rateLimiter.waitMs();
        logger.warn(`[gemini] Rate limit: waiting ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        rateLimiter.isAllowed(); // consume a slot after waiting
      }

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(35000),
        });

        // Handle specific error codes
        if (res.status === 429) {
          // Rate limited — exponential backoff
          const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
          logger.warn(`[gemini] ${model}: 429 rate limited, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1})`);
          if (attempt < maxRetries) {
            await sleep(delay);
            continue;
          }
          lastError = new Error(`Gemini rate limited (429) on ${model} after ${maxRetries} retries. Free tier: 15 req/min, 1500 req/day.`);
          break;
        }

        if (res.status === 503) {
          // Service unavailable — shorter backoff
          const delay = baseDelayMs * (attempt + 1);
          logger.warn(`[gemini] ${model}: 503 unavailable, retrying in ${delay}ms`);
          if (attempt < maxRetries) {
            await sleep(delay);
            continue;
          }
          lastError = new Error(`Gemini service unavailable (503) on ${model}`);
          break;
        }

        if (res.status === 404) {
          // Model not found — try next model, don't retry this one
          logger.warn(`[gemini] ${model}: 404 not found, trying next model`);
          lastError = new Error(`Model ${model} not found (404)`);
          break; // break retry loop, go to next model
        }

        if (res.status === 403) {
          const errBody = await res.text().catch(() => "");
          throw new Error(`Gemini 403 Forbidden: ${errBody.slice(0, 200)} — check your API key has Generative Language API enabled at console.cloud.google.com`);
        }

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          lastError = new Error(`Gemini ${res.status}: ${errBody.slice(0, 200)}`);
          if (attempt < maxRetries) {
            await sleep(baseDelayMs * (attempt + 1));
            continue;
          }
          break;
        }

        // Parse successful response
        const json = await res.json();
        const candidate = json?.candidates?.[0];

        if (!candidate) {
          const blockReason = json?.promptFeedback?.blockReason;
          if (blockReason) {
            // Content blocked — don't retry, try next model
            lastError = new Error(`Gemini content blocked: ${blockReason}`);
            break;
          }
          lastError = new Error("Gemini returned no candidates");
          if (attempt < maxRetries) { await sleep(baseDelayMs); continue; }
          break;
        }

        if (candidate.finishReason === "SAFETY") {
          lastError = new Error(`Gemini safety filter triggered on ${model}`);
          break; // try next model
        }

        const text = candidate?.content?.parts?.[0]?.text;
        if (!text) {
          lastError = new Error(`Gemini empty text (finishReason: ${candidate.finishReason || "UNKNOWN"})`);
          if (attempt < maxRetries) { await sleep(baseDelayMs); continue; }
          break;
        }

        logger.info(`[gemini] ✓ ${model} responded (${text.length} chars, attempt ${attempt + 1})`);
        return text; // SUCCESS

      } catch (err) {
        if (err.name === "AbortError" || err.name === "TimeoutError") {
          lastError = new Error(`Gemini request timed out on ${model}`);
          if (attempt < maxRetries) {
            await sleep(baseDelayMs * (attempt + 1));
            continue;
          }
        } else {
          lastError = err;
          if (attempt < maxRetries && !err.message.includes("403")) {
            await sleep(baseDelayMs * (attempt + 1));
            continue;
          }
        }
        break;
      }
    } // end retry loop

    // If we got a 403 (key issue), no point trying other models
    if (lastError?.message.includes("403")) break;
  } // end model cascade

  throw lastError || new Error("Gemini: all models exhausted");
}

/**
 * Call Claude as fallback when Gemini fails.
 */
async function callClaude(systemPrompt, userMessage, maxTokens = 1000) {
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const CLAUDE_MODEL = "claude-sonnet-4-5-20251022";
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: userMessage }],
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
    signal: AbortSignal.timeout(35000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Claude ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = json?.content?.[0]?.text;
  if (!text) throw new Error("Claude: empty response");
  return text;
}

/**
 * Primary LLM call: Gemini (with retry/backoff) → Claude → descriptive error
 */
async function callLLM(systemPrompt, userMessage, maxTokens = 1000) {
  const errors = [];

  // Try Gemini with full retry logic
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY) {
    try {
      const text = await callGeminiWithRetry(systemPrompt, userMessage, maxTokens);
      return { text, provider: "gemini" };
    } catch (err) {
      errors.push(`Gemini: ${err.message}`);
      logger.warn(`[llm] Gemini failed: ${err.message}`);
    }
  } else {
    errors.push("Gemini: GEMINI_API_KEY not set");
  }

  // Fall back to Claude
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const text = await callClaude(systemPrompt, userMessage, maxTokens);
      return { text, provider: "claude" };
    } catch (err) {
      errors.push(`Claude: ${err.message}`);
      logger.warn(`[llm] Claude failed: ${err.message}`);
    }
  } else {
    errors.push("Claude: ANTHROPIC_API_KEY not set");
  }

  throw new Error(`AI generation failed — ${errors.join(" | ")}`);
}

/**
 * Parse JSON from LLM response (handles code blocks and raw JSON)
 */
function parseJSON(raw) {
  if (!raw) return null;
  try {
    const m = /```json\s*([\s\S]+?)\s*```/i.exec(raw)
           || /```\s*([\s\S]+?)\s*```/i.exec(raw)
           || /([\{\[][\s\S]*[\}\]])/s.exec(raw);
    return m ? JSON.parse(m[1]) : null;
  } catch { return null; }
}

module.exports = { callLLM, callGeminiWithRetry, callClaude, parseJSON };
