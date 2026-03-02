// backend/src/server.js  ← REPLACE YOUR ENTIRE server.js WITH THIS
"use strict";
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const vesselRoutes = require("./routes/vessels");
const logger = require("./utils/logger");

const app = express();
const PORT = process.env.PORT || 10000;

// ─────────────────────────────────────────────────────────────
// CORS  — allow ALL origins so Vercel / Netlify / any browser works
// ─────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: "*", // ← THE KEY FIX (was "http://localhost:3000")
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Authorization"],
  }),
);
app.options("*", cors()); // handle preflight for every route

// ─────────────────────────────────────────────────────────────
// Standard middleware
// ─────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Simple request logger
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────────────────────
// Health-check  (GET /health)
// ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "vessel-tracking-api",
    timestamp: new Date().toISOString(),
    cors: "all origins allowed",
  });
});

// Root — prevents the 404 you see in Render logs
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Vessel Tracking API is running 🚢" });
});

// ─────────────────────────────────────────────────────────────
// API routes  → /api/vessels, /api/stats, etc.
// ─────────────────────────────────────────────────────────────
app.use("/api", vesselRoutes);

// ─────────────────────────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error("Unhandled error:", err.message);
  res.status(500).json({ success: false, error: err.message });
});

// ─────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  logger.info(`🚢  Vessel Tracking API  → http://localhost:${PORT}`);
  logger.info(
    `📊  BigQuery table       → ${process.env.BIGQUERY_PROJECT_ID || "photons-377606"}.${process.env.BIGQUERY_DATASET || "MPA"}.${process.env.BIGQUERY_TABLE || "MPA_VesselPositionsSnapshot"}`,
  );
  logger.info(`🌍  CORS origin          → ALL ORIGINS (fixed)`);
  logger.info(``);
  logger.info(`  Test endpoints:`);
  logger.info(`    http://localhost:${PORT}/health`);
  logger.info(`    http://localhost:${PORT}/api/vessels?limit=5`);
  logger.info(`    http://localhost:${PORT}/api/vessel-types`);
  logger.info(`    http://localhost:${PORT}/api/stats`);
});

module.exports = app;
