// backend/src/routes/auth.js
// Users stored in BigQuery: photons-377606.MPA.MPA_Users
const express = require("express");
const router  = express.Router();
const crypto  = require("crypto");
const { getUserByEmail, createUser, updateLastLogin } = require("../services/bigquery");
const logger  = require("../utils/logger");

function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw + "mt_mpa_salt_2024").digest("hex");
}

function generateToken(user) {
  return Buffer.from(JSON.stringify({
    id: user.id, email: user.email, name: user.name, iat: Date.now()
  })).toString("base64");
}

// ── POST /api/auth/register ──────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password)
      return res.status(400).json({ success: false, error: "All fields required" });
    if (password.length < 6)
      return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ success: false, error: "Invalid email address" });

    const cleanEmail = email.toLowerCase().trim();
    const cleanName  = name.trim();

    // Check if already registered
    const existing = await getUserByEmail(cleanEmail);
    if (existing) {
      return res.status(409).json({
        success: false,
        error: "already_registered",
        message: "Email already registered. Please sign in.",
      });
    }

    // Insert into BigQuery MPA_Users
    const user = {
      id:           crypto.randomUUID(),
      name:         cleanName,
      email:        cleanEmail,
      passwordHash: hashPassword(password),
      role:         "Operator",
      avatar:       cleanName[0].toUpperCase(),
    };

    await createUser(user);
    logger.info(`✅ Registered: ${cleanEmail}`);

    const safeUser = {
      id: user.id, name: user.name, email: user.email,
      role: user.role, avatar: user.avatar,
    };
    return res.status(201).json({
      success: true,
      data: { ...safeUser, token: generateToken(user) },
    });

  } catch (err) {
    // Log the REAL error so you can see it in Render logs
    logger.error("❌ Register error:", err.message);
    logger.error("Stack:", err.stack);
    return res.status(500).json({
      success: false,
      error: err.message || "Registration failed",
    });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ success: false, error: "Email and password required" });

    const cleanEmail = email.toLowerCase().trim();
    const user = await getUserByEmail(cleanEmail);

    if (!user)
      return res.status(401).json({
        success: false,
        error: "No account found with this email. Please register first.",
      });

    if (user.password_hash !== hashPassword(password))
      return res.status(401).json({
        success: false,
        error: "Incorrect password. Please try again.",
      });

    // Update last_login (non-blocking)
    updateLastLogin(cleanEmail).catch(e =>
      logger.warn("updateLastLogin failed:", e.message)
    );

    logger.info(`✅ Login: ${cleanEmail}`);

    const safeUser = {
      id:     user.id,
      name:   user.name,
      email:  user.email,
      role:   user.role   || "Operator",
      avatar: user.avatar || user.name[0].toUpperCase(),
    };
    return res.json({
      success: true,
      data: { ...safeUser, token: generateToken(safeUser) },
    });

  } catch (err) {
    logger.error("❌ Login error:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "Login failed",
    });
  }
});

// ── GET /api/auth/check-email ────────────────────────────────
router.get("/check-email", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.json({ exists: false });
    const user = await getUserByEmail(email.toLowerCase().trim());
    return res.json({ exists: !!user });
  } catch (err) {
    logger.error("check-email error:", err.message);
    return res.json({ exists: false });
  }
});

module.exports = router;
