// backend/src/server.js
"use strict";
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const vesselRoutes = require("./routes/vessels");
const authRoutes = require("./routes/auth"); // ← ADD THIS
const logger = require("./utils/logger");

const app = express();
const PORT = process.env.PORT || 10000;

// CORS — allow all origins
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Authorization"],
  }),
);
app.options("*", cors());

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Health check
app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    service: "vessel-tracking-api",
    timestamp: new Date().toISOString(),
  }),
);
app.get("/", (_req, res) =>
  res.json({ status: "ok", message: "Vessel Tracking API 🚢" }),
);

// ── Routes ────────────────────────────────────────────────────
app.use("/api/auth", authRoutes); // ← Auth: /api/auth/register, /api/auth/login
app.use("/api", vesselRoutes); // ← Vessels: /api/vessels, /api/stats etc.

// Global error handler
app.use((err, _req, res, _next) => {
  logger.error("Unhandled error:", err.message);
  res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, "0.0.0.0", () => {
  logger.info(`🚢  Vessel Tracking API  → http://localhost:${PORT}`);
  logger.info(
    `🔐  Auth endpoints ready → /api/auth/register | /api/auth/login`,
  );
  logger.info(
    `📊  BigQuery table       → ${process.env.BIGQUERY_PROJECT_ID || "photons-377606"}.${process.env.BIGQUERY_DATASET || "MPA"}.${process.env.BIGQUERY_TABLE || "MPA_VesselPositionsSnapshot"}`,
  );
  logger.info(`🌍  CORS                 → ALL ORIGINS`);
});

module.exports = app;
