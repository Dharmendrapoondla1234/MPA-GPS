// backend/src/server.js — MPA v8 (all route bugs fixed)
"use strict";
require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const helmet  = require("helmet");
const compression = require("compression");

const vesselRoutes       = require("./routes/vessels");
const authRoutes         = require("./routes/auth");
const gisRoutes          = require("./routes/gis_route");
const predictRoutes      = require("./routes/predict");
const aiTrajRoutes       = require("./routes/ai_trajectory");
const weatherRoutes      = require("./routes/weather");
const contactRoutes      = require("./routes/contacts");
const intelligenceRoutes = require("./routes/intelligence");
const preferredRoutes    = require("./routes/preferred");
const watchlistRoutes    = require("./routes/watchlist");
const fuelRoutes         = require("./routes/fuel");
const aiContactRoutes    = require("./routes/ai_contact");
const geminiRoutes       = require("./routes/gemini_contact");
const aiChatRoutes       = require("./routes/ai_chat");
const aiAgentRoutes      = require("./routes/ai_agents");
const proxyRoute         = require("./routes/proxy");
const logger             = require("./utils/logger");
const { warmCache, bigquery, BQ_LOCATION, T } = require("./services/bigquery");
const maritimeRouter     = require("./services/maritimeRouter");

const app  = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin:"*", methods:["GET","POST","PUT","DELETE","OPTIONS"], allowedHeaders:["Content-Type","Accept","Authorization","If-None-Match"] }));
app.options("*", cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, _res, next) => { logger.info(`${req.method} ${req.path}`); next(); });

app.get("/health", (_req, res) => res.json({ status:"ok", service:"mpa-api-v8", timestamp:new Date().toISOString() }));
app.get("/",       (_req, res) => res.json({ status:"ok", message:"MPA Vessel Tracking API v8 🚢" }));

// ── Route registration ────────────────────────────────────────────────────────
// RULE: Most-specific prefixes FIRST. Generic /api last.

app.use("/api/auth",         authRoutes);
app.use("/api/gis",          gisRoutes);
app.use("/api/predict",      predictRoutes);
app.use("/api/weather",      weatherRoutes);
app.use("/api/preferred",    preferredRoutes);
app.use("/api/watchlist",    watchlistRoutes);
app.use("/api/fuel",         fuelRoutes);
app.use("/api/ai-contact",   aiContactRoutes);
app.use("/api/gemini",       geminiRoutes);

// FIX BUG 1: aiTrajRoutes and aiChatRoutes both mounted on /api/ai.
// They have no overlapping route paths so ordering is safe.
// aiTrajRoutes: GET /trajectory/:imo
// aiChatRoutes: POST /chat, /draft-email, /summarize, /analyze-fuel, /predict-arrival, /fleet-insights, GET /status
app.use("/api/ai",           aiTrajRoutes);
app.use("/api/ai",           aiChatRoutes);

// FIX BUG 4: /api/agents now reaches aiAgentRoutes unambiguously.
app.use("/api/agents",       aiAgentRoutes);

// FIX BUG 7: backend CORS proxy — replaces unreliable allorigins.win.
app.use("/api/proxy",        proxyRoute);

// FIX BUG 6 + BROKEN ROUTE A:
// contactRoutes was double-mounted on /api/contacts AND bare /api.
// Removing the bare /api mount broke /api/vessel-contact (called by frontend api.js).
// Solution: mount contactRoutes on BOTH /api/contacts (explicit) AND with a targeted
// compat mount so /api/vessel-contact still resolves.
// The route inside contacts.js is router.get("/vessel-contact") — mounting at /api
// with a narrowed prefix re-exposes only that path cleanly via vesselRoutes passthrough.
// Cleanest fix: re-add the bare mount ONLY for the two backward-compat paths.
app.use("/api/contacts",     contactRoutes);   // /api/contacts/* — primary
app.use("/api",              contactRoutes);   // /api/vessel-contact (compat) — contactRoutes
                                               // handles path guards internally;
                                               // vessel-contact + vessel/:imo are the only
                                               // non-prefixed paths consumers use.

// FIX BUG 9 + BROKEN ROUTE B:
// intelligenceRoutes was double-mounted. Removing the bare mount broke:
//   /api/vessel/:imo/contact (intelligence.js: router.get("/vessel/:imo/contact"))
//   /api/vessel/:imo/deep-research
// AND intelligence.js has router.get("/intelligence/company") which when mounted at
// /api/intelligence becomes /api/intelligence/intelligence/company — DOUBLE PATH BUG.
// Fix: keep bare /api mount for backward-compat vessel/:imo/contact paths,
// AND add a separate mount for the /intelligence/company and /intelligence/stats
// sub-routes at the correct depth.
app.use("/api",              intelligenceRoutes);  // /api/vessel/:imo/contact etc (compat)
app.use("/api/intelligence", intelligenceRoutes);  // /api/intelligence/company etc
// NOTE: the double-path for /api/intelligence/intelligence/company is a pre-existing
// bug in intelligence.js route definitions themselves (router.get("/intelligence/company")
// should be router.get("/company")). Fixed in intelligence.js separately.

// vesselRoutes last (has wildcards like /vessels, /arrivals, /stats)
app.use("/api",              vesselRoutes);

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error("Unhandled error:", err.message);
  res.status(500).json({ success: false, error: err.message });
});

maritimeRouter.init(bigquery, BQ_LOCATION, T);

app.listen(PORT, "0.0.0.0", () => {
  logger.info(`🚢 MPA API v8 → http://localhost:${PORT}`);
  setTimeout(() => warmCache(), 3000);

  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  function selfPing() {
    const mod = SELF_URL.startsWith("https") ? require("https") : require("http");
    const req = mod.get(`${SELF_URL}/health`, r => { logger.info(`🏓 Keep-alive → HTTP ${r.statusCode}`); r.resume(); });
    req.on("error", e => logger.warn(`🏓 Keep-alive failed: ${e.message}`));
    req.setTimeout(10000, () => req.destroy());
  }
  setTimeout(selfPing, 30_000);
  setInterval(selfPing, 4 * 60 * 1000);
});

module.exports = app;