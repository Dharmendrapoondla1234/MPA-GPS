// backend/src/server.js — MPA Advanced v6
"use strict";
require("dotenv").config();

const express       = require("express");
const cors          = require("cors");
const helmet        = require("helmet");
const vesselRoutes  = require("./routes/vessels");
const authRoutes    = require("./routes/auth");
const gisRoutes     = require("./routes/gis_route");
const predictRoutes = require("./routes/predict");
const logger        = require("./utils/logger");
const { warmCache } = require("./services/bigquery");

const app  = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin:"*", methods:["GET","POST","PUT","DELETE","OPTIONS"], allowedHeaders:["Content-Type","Accept","Authorization"] }));
app.options("*", cors());
app.use(helmet({ contentSecurityPolicy:false }));
app.use(express.json());
app.use(express.urlencoded({ extended:false }));
app.use((req,_res,next) => { logger.info(`${req.method} ${req.path}`); next(); });

app.get("/health", (_req,res) => res.json({ status:"ok", service:"vessel-tracking-api-v6", dataset:"Photons_MPA", timestamp:new Date().toISOString() }));
app.get("/",       (_req,res) => res.json({ status:"ok", message:"MPA Vessel Tracking API v6 🚢", tables:["fct_vessel_live_tracking","fct_vessel_master","fct_vessel_arrivals","fct_vessel_departures","stg_vessel_positions"] }));

app.use("/api/auth",    authRoutes);
app.use("/api/gis",     gisRoutes);
app.use("/api/predict", predictRoutes);
app.use("/api",         vesselRoutes);   // covers /vessels, /arrivals, /departures, /port-activity, /stats

app.use((err,_req,res,_next) => {
  logger.error("Unhandled error:", err.message);
  res.status(500).json({ success:false, error:err.message });
});

app.listen(PORT, "0.0.0.0", () => {
  logger.info(`🚢 MPA Vessel Tracking API v6 → http://localhost:${PORT}`);
  setTimeout(() => warmCache(), 3000);

  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(() => {
    try {
      const mod = SELF_URL.startsWith("https") ? require("https") : require("http");
      mod.get(`${SELF_URL}/health`, r => logger.info(`🏓 Keep-alive → ${r.statusCode}`)).on("error", ()=>{});
    } catch(_) {}
  }, 10*60*1000);
});

module.exports = app;