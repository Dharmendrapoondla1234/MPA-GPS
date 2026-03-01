// backend/src/server.js
"use strict";
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const vesselRoutes = require("./routes/vessels");
const authRoutes = require("./routes/auth");
const logger = require("./utils/logger");

const app = express();
const PORT = process.env.PORT || 10000;

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

app.use("/api/auth", authRoutes);
app.use("/api", vesselRoutes);

app.use((err, _req, res, _next) => {
  logger.error("Unhandled error:", err.message);
  res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, "0.0.0.0", () => {
  logger.info(`🚢 Vessel Tracking API → http://localhost:${PORT}`);
  logger.info(
    `🔐 Auth endpoints: POST /api/auth/register, POST /api/auth/login`,
  );
  logger.info(`🌍 CORS: ALL ORIGINS`);
});

module.exports = app;
