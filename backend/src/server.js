// backend/src/server.js — MPA Advanced v6
"use strict";
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const vesselRoutes = require("./routes/vessels");
const authRoutes = require("./routes/auth");
const gisRoutes = require("./routes/gis_route");
const predictRoutes = require("./routes/predict");
const aiTrajRoutes = require("./routes/ai_trajectory");
const weatherRoutes = require("./routes/weather");
const contactRoutes = require("./routes/contacts");
const logger = require("./utils/logger");
const { warmCache, bigquery, BQ_LOCATION, T } = require("./services/bigquery");
const maritimeRouter = require("./services/maritimeRouter");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Accept",
      "Authorization",
      "If-None-Match",
    ],
  }),
);
app.options("*", cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression()); // gzip all responses — massive payload reduction
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    service: "vessel-tracking-api-v6",
    dataset: "MPA",
    timestamp: new Date().toISOString(),
  }),
);
app.get("/", (_req, res) =>
  res.json({
    status: "ok",
    message: "MPA Vessel Tracking API v6 🚢",
    tables: [
      "f_vessel_live_tracking",
      "d_vessel_master",
      "f_vessel_arrivals",
      "f_vessel_departures",
      "f_vessel_positions_latest",
      "stg_vessel_positions",
      "stg_vessel_arrivals",
      "stg_vessel_departures",
      "stg_arrival_declarations",
      "stg_departure_declarations",
    ],
  }),
);

app.use("/api/auth", authRoutes);
app.use("/api/gis", gisRoutes);
app.use("/api/predict", predictRoutes);
app.use("/api/ai", aiTrajRoutes);
app.use("/api/weather", weatherRoutes);
app.use("/api", vesselRoutes); // covers /vessels, /arrivals, /departures, /port-activity, /stats
app.use("/api/contacts", contactRoutes); // vessel contact enrichment
app.use("/api", contactRoutes);           // spec endpoint: GET /api/vessel-contact

// ── DEBUG: sample raw + converted coords ─────────────────────
// ── DEBUG: vessels endpoint — shows raw BQ vs normalized output ──────────────
app.get("/debug/vessels", async (_req, res) => {
  try {
    const { bigquery, BQ_LOCATION, T } = require("./services/bigquery");
    // Also check raw source table freshness
    const [[rows], [stgRows]] = await Promise.all([
      bigquery.query({
        query: `SELECT vessel_name, imo_number,
                       latitude_degrees, longitude_degrees,
                       speed, last_position_at,
                       minutes_since_last_ping, is_stale
                FROM \`photons-377606.MPA.f_vessel_live_tracking\`
                WHERE latitude_degrees IS NOT NULL
                ORDER BY last_position_at DESC LIMIT 5`,
        location: BQ_LOCATION,
      }),
      bigquery.query({
        query: `SELECT MAX(effective_timestamp) as max_ts, COUNT(*) as total_rows,
                       TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(effective_timestamp), MINUTE) as mins_since_latest
                FROM \`photons-377606.MPA.stg_vessel_positions\``,
        location: BQ_LOCATION,
      }),
    ]);
    const RAD = 180 / Math.PI;
    const now = new Date();
    const result = rows.map((r) => {
      const rawLat = Number(r.latitude_degrees);
      const rawLng = Number(r.longitude_degrees);
      const convertedLat = Math.abs(rawLat) <= 3 ? rawLat * RAD : rawLat;
      const convertedLng = Math.abs(rawLng) <= 4 ? rawLng * RAD : rawLng;
      const tsRaw = r.last_position_at?.value || r.last_position_at;
      const tsDate = tsRaw ? new Date(tsRaw) : null;
      const isFuture = tsDate && tsDate > now;
      const correctedTs = isFuture
        ? new Date(tsDate.getTime() - 8 * 3600000)
        : tsDate;
      const minsAgo = correctedTs
        ? Math.round((now - correctedTs) / 60000)
        : null;
      return {
        vessel_name: r.vessel_name,
        imo: r.imo_number,
        raw_lat: rawLat,
        raw_lng: rawLng,
        converted_lat: convertedLat,
        converted_lng: convertedLng,
        lat_in_range: convertedLat >= -90 && convertedLat <= 90,
        lng_in_range: convertedLng >= -180 && convertedLng <= 180,
        raw_timestamp: tsRaw,
        timestamp_was_future: isFuture,
        corrected_ts: correctedTs?.toISOString(),
        minutes_ago: minsAgo,
        dbt_mins_since_ping: r.minutes_since_last_ping,
        dbt_is_stale: r.is_stale,
        would_be_filtered:
          minsAgo > 360 || convertedLat < -90 || convertedLat > 90,
      };
    });
    const stgSummary = stgRows[0] || {};
    res.json({
      now: now.toISOString(),
      f_vessel_live_tracking: { count: rows.length, vessels: result },
      stg_vessel_positions: {
        total_rows: Number(stgSummary.total_rows),
        latest_position_at: stgSummary.max_ts?.value || stgSummary.max_ts,
        mins_since_latest_raw_ping: Number(stgSummary.mins_since_latest),
      },
      diagnosis:
        Number(stgSummary.mins_since_latest) > 120
          ? "RAW DATA IS STALE: stg_vessel_positions not receiving new AIS pings"
          : "Raw data is fresh — dbt model may not be refreshing f_vessel_live_tracking",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/debug/coords", async (_req, res) => {
  try {
    // Init AI maritime router (learns lanes from AIS data)
    const { bigquery, BQ_LOCATION, T } = require("./services/bigquery");
    maritimeRouter.init(bigquery, BQ_LOCATION, T);
    // Warm AIS lane learning in background (don't await — runs async)
    maritimeRouter
      .route(1.2, 103.82, 5.35, 100.28, 315)
      .then(() => logger.info("[STARTUP] Maritime AI lane graph ready"))
      .catch((e) =>
        logger.warn("[STARTUP] Maritime AI lane learning:", e.message),
      );
    const RAD = 180 / Math.PI;
    const [rows] = await bigquery.query({
      query: `SELECT vessel_name, imo_number, latitude_degrees, longitude_degrees,
                     speed, last_position_at
              FROM \`photons-377606.MPA.f_vessel_live_tracking\`
              WHERE latitude_degrees IS NOT NULL AND longitude_degrees IS NOT NULL
              LIMIT 10`,
      location: BQ_LOCATION,
    });
    const sample = rows.map((r) => ({
      vessel_name: r.vessel_name,
      raw_lat: r.latitude_degrees,
      raw_lng: r.longitude_degrees,
      converted_lat: Number(r.latitude_degrees) * RAD,
      converted_lng: Number(r.longitude_degrees) * RAD,
      speed: r.speed,
    }));
    res.json({
      note: "raw values are radians, converted = degrees",
      count: rows.length,
      sample,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((err, _req, res, _next) => {
  logger.error("Unhandled error:", err.message);
  res.status(500).json({ success: false, error: err.message });
});

// ── Wire AIS+TSS intelligent router ──────────────────────────────────────────
maritimeRouter.init(bigquery, BQ_LOCATION, T);

app.listen(PORT, "0.0.0.0", () => {
  logger.info(`🚢 MPA Vessel Tracking API v6 → http://localhost:${PORT}`);
  setTimeout(() => warmCache(), 3000);

  // ── KEEP-ALIVE SELF-PING ──────────────────────────────────────────
  // Render free tier sleeps after 15 min of INBOUND inactivity.
  // We ping /health every 4 min so the service is always awake.
  // RENDER_EXTERNAL_URL is automatically set by Render for web services.
  const SELF_URL =
    process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  logger.info(`🏓 Keep-alive target: ${SELF_URL}/health (every 4 min)`);

  function selfPing() {
    try {
      const mod = SELF_URL.startsWith("https")
        ? require("https")
        : require("http");
      const req = mod.get(`${SELF_URL}/health`, (r) => {
        logger.info(`🏓 Keep-alive ping → HTTP ${r.statusCode}`);
        r.resume(); // drain response so socket closes cleanly
      });
      req.on("error", (e) =>
        logger.warn(`🏓 Keep-alive ping failed: ${e.message}`),
      );
      req.setTimeout(10000, () => {
        req.destroy();
        logger.warn("🏓 Keep-alive ping timed out");
      });
    } catch (e) {
      logger.warn(`🏓 Keep-alive error: ${e.message}`);
    }
  }

  // First ping after 30s (let server fully start), then every 4 min
  setTimeout(selfPing, 30_000);
  setInterval(selfPing, 4 * 60 * 1000);
});

module.exports = app;