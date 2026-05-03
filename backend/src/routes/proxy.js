// src/routes/proxy.js — Server-side CORS proxy
// Replaces the public allorigins.win dependency used by GeminiContactFinder.jsx
// Fetches a URL server-side and returns its HTML content, bypassing browser CORS.
// BUG 7 FIX: allorigins.win was rate-limited, unreliable, and blocked by
// maritime data sites (MarineTraffic, VesselFinder, FleetMon).
"use strict";

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Simple domain blocklist — prevent SSRF against internal services
const BLOCKED_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "::1",
  "169.254.169.254",  // AWS metadata
  "metadata.google.internal",
]);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/proxy?url=<encoded-url>
// Returns: { contents: "<html>..." } — matches the allorigins.win response shape
//          so the frontend needs no additional changes.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: "url query parameter required" });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return res.status(400).json({ error: "Only http/https URLs are allowed" });
  }

  if (BLOCKED_HOSTS.has(parsed.hostname)) {
    return res.status(403).json({ error: "Blocked host" });
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);

    const response = await fetch(parsed.href, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    }).finally(() => clearTimeout(t));

    if (!response.ok) {
      logger.warn(`[proxy] ${response.status} for ${parsed.hostname}`);
      return res.status(502).json({ error: `Upstream returned ${response.status}`, contents: null });
    }

    const contents = await response.text();
    logger.info(`[proxy] fetched ${parsed.hostname} (${contents.length} chars)`);

    return res.json({ contents, status_code: response.status });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "Upstream request timed out", contents: null });
    }
    logger.warn(`[proxy] fetch error for ${targetUrl.slice(0, 80)}: ${err.message}`);
    return res.status(502).json({ error: err.message, contents: null });
  }
});

module.exports = router;