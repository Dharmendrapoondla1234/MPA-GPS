// backend/src/routes/watchlist.js
// Per-user watchlist stored in BigQuery — add, remove, list by user email
// Vessels filtered on map when watchlist is active
"use strict";
const express = require("express");
const router  = express.Router();
const { bigquery, BQ_LOCATION } = require("../services/bigquery");
const logger = require("../utils/logger");

const PROJECT = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET = process.env.BIGQUERY_DATASET    || "MPA";
const T_WATCH = `\`${PROJECT}.${DATASET}.MPA_Watchlist\``;

function sanitize(str) {
  if (!str) return "";
  return String(str).replace(/['"\\\`;]/g, "").substring(0, 200);
}

function getUserFromToken(req) {
  try {
    const auth  = req.headers.authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;
    const payload = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    return payload?.id ? payload : null;
  } catch { return null; }
}

function requireAuth(req, res, next) {
  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({ success: false, error: "Authentication required" });
  req.currentUser = user;
  next();
}

// ── GET /api/watchlist — list this user's watchlist vessels ───────
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = sanitize(req.currentUser.id);
    const [rows] = await bigquery.query({
      query: `SELECT imo_number, vessel_name, vessel_type, flag, added_at, notes
              FROM ${T_WATCH}
              WHERE user_id = '${userId}'
              ORDER BY added_at DESC LIMIT 100`,
      location: BQ_LOCATION,
    });
    res.json({ success: true, data: rows });
  } catch (err) {
    logger.error("[watchlist] GET error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/watchlist — add vessel to watchlist ─────────────────
router.post("/", requireAuth, async (req, res) => {
  try {
    const userId = sanitize(req.currentUser.id);
    const { imo_number, vessel_name, vessel_type, flag, notes } = req.body;
    if (!imo_number) return res.status(400).json({ success: false, error: "imo_number required" });

    const imo  = sanitize(String(imo_number));
    const name = sanitize(vessel_name || "");
    const type = sanitize(vessel_type || "");
    const fl   = sanitize(flag || "");
    const nt   = sanitize(notes || "");

    // Upsert: delete old then insert
    await bigquery.query({
      query: `DELETE FROM ${T_WATCH} WHERE user_id='${userId}' AND imo_number='${imo}'`,
      location: BQ_LOCATION,
    });
    await bigquery.query({
      query: `INSERT INTO ${T_WATCH}
              (user_id, user_email, imo_number, vessel_name, vessel_type, flag, notes, added_at)
              VALUES ('${userId}','${sanitize(req.currentUser.email||"")}',
                      '${imo}','${name}','${type}','${fl}','${nt}',CURRENT_TIMESTAMP())`,
      location: BQ_LOCATION,
    });
    logger.info(`[watchlist] User ${userId} added IMO ${imo}`);
    res.json({ success: true });
  } catch (err) {
    logger.error("[watchlist] POST error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/watchlist/:imo — remove one vessel ────────────────
router.delete("/:imo", requireAuth, async (req, res) => {
  try {
    const userId = sanitize(req.currentUser.id);
    const imo    = sanitize(String(req.params.imo));
    await bigquery.query({
      query: `DELETE FROM ${T_WATCH} WHERE user_id='${userId}' AND imo_number='${imo}'`,
      location: BQ_LOCATION,
    });
    logger.info(`[watchlist] User ${userId} removed IMO ${imo}`);
    res.json({ success: true });
  } catch (err) {
    logger.error("[watchlist] DELETE error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/watchlist — clear all for this user ───────────────
router.delete("/", requireAuth, async (req, res) => {
  try {
    const userId = sanitize(req.currentUser.id);
    await bigquery.query({
      query: `DELETE FROM ${T_WATCH} WHERE user_id='${userId}'`,
      location: BQ_LOCATION,
    });
    res.json({ success: true });
  } catch (err) {
    logger.error("[watchlist] DELETE all error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
