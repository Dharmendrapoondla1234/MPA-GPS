// backend/src/routes/preferred.js
// Per-user preferred (watchlist) ships — stored in BigQuery MPA_Preferred_Ships
"use strict";
const express = require("express");
const router  = express.Router();
const {
  getPreferredShips,
  addPreferredShip,
  removePreferredShip,
  clearPreferredShips,
} = require("../services/bigquery");
const logger = require("../utils/logger");

// ── Auth helper — decode the simple base64 token ─────────────────
function getUserFromToken(req) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;
    const payload = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    if (!payload?.id) return null;
    return payload; // { id, email, name, iat }
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({ success: false, error: "Authentication required" });
  req.currentUser = user;
  next();
}

// GET /api/preferred — list all preferred ships for logged-in user
router.get("/", requireAuth, async (req, res) => {
  try {
    const ships = await getPreferredShips(req.currentUser.id);
    return res.json({ success: true, data: ships });
  } catch (err) {
    logger.error("[preferred] GET error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/preferred — add a vessel to preferred
router.post("/", requireAuth, async (req, res) => {
  try {
    const vessel = req.body;
    if (!vessel?.imo_number) {
      return res.status(400).json({ success: false, error: "imo_number required" });
    }
    await addPreferredShip(req.currentUser.id, vessel);
    return res.json({ success: true });
  } catch (err) {
    logger.error("[preferred] POST error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/preferred/:imo — remove a specific vessel
router.delete("/:imo", requireAuth, async (req, res) => {
  try {
    const { imo } = req.params;
    await removePreferredShip(req.currentUser.id, imo);
    return res.json({ success: true });
  } catch (err) {
    logger.error("[preferred] DELETE error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/preferred — clear all preferred ships for this user
router.delete("/", requireAuth, async (req, res) => {
  try {
    await clearPreferredShips(req.currentUser.id);
    return res.json({ success: true });
  } catch (err) {
    logger.error("[preferred] DELETE all error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
