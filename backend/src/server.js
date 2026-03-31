// backend/src/server.js — MPA v7 (pure Node.js intelligence pipeline)
"use strict";
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");

const vesselRoutes      = require("./routes/vessels");
const authRoutes        = require("./routes/auth");
const gisRoutes         = require("./routes/gis_route");
const predictRoutes     = require("./routes/predict");
const aiTrajRoutes      = require("./routes/ai_trajectory");
const weatherRoutes     = require("./routes/weather");
const contactRoutes     = require("./routes/contacts");
const intelligenceRoutes= require("./routes/intelligence");   // v3 — pure Node.js
const preferredRoutes   = require("./routes/preferred");
const watchlistRoutes   = require("./routes/watchlist");
const fuelRoutes        = require("./routes/fuel");
const aiContactRoutes   = require("./routes/ai_contact");
const logger            = require("./utils/logger");
const { warmCache, bigquery, BQ_LOCATION, T } = require("./services/bigquery");
const maritimeRouter    = require("./services/maritimeRouter");

const app  = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin:"*", methods:["GET","POST","PUT","DELETE","OPTIONS"], allowedHeaders:["Content-Type","Accept","Authorization","If-None-Match"] }));
app.options("*", cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, _res, next) => { logger.info(`${req.method} ${req.path}`); next(); });

app.get("/health", (_req, res) => res.json({ status:"ok", service:"mpa-api-v7", timestamp:new Date().toISOString() }));
app.get("/",       (_req, res) => res.json({ status:"ok", message:"MPA Vessel Tracking API v7 🚢" }));

app.use("/api/auth",         authRoutes);
app.use("/api/gis",          gisRoutes);
app.use("/api/predict",      predictRoutes);
app.use("/api/ai",           aiTrajRoutes);
app.use("/api/weather",      weatherRoutes);
app.use("/api/contacts",     contactRoutes);
app.use("/api",              contactRoutes);
app.use("/api",              intelligenceRoutes);   // /api/vessel/:imo/contact + /api/vessel/:imo/deep-research
app.use("/api/intelligence", intelligenceRoutes);   // /api/intelligence/company + /api/intelligence/stats
app.use("/api",              vesselRoutes);
app.use("/api/preferred",    preferredRoutes);
app.use("/api/watchlist",    watchlistRoutes);
app.use("/api/fuel",         fuelRoutes);
app.use("/api/ai-contact",   aiContactRoutes);

// Debug endpoint
app.get("/debug/enrich/:imo", async (req, res) => {
  try {
    const { runPipeline } = require("./services/intelligence/pipeline");
    const imo = parseInt(req.params.imo, 10);
    if (!imo) return res.json({ error: "Invalid IMO" });
    const result = await runPipeline({ imo, forceRefresh: true });
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.use((err, _req, res, _next) => {
  logger.error("Unhandled error:", err.message);
  res.status(500).json({ success: false, error: err.message });
});

maritimeRouter.init(bigquery, BQ_LOCATION, T);

app.listen(PORT, "0.0.0.0", () => {
  logger.info(`🚢 MPA API v7 → http://localhost:${PORT}`);
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