// backend/src/routes/auth.js
// Real user registration + login stored in backend memory (or file for persistence)
const express = require("express");
const router  = express.Router();
const crypto  = require("crypto");
const path    = require("path");
const fs      = require("fs");

// ── Simple persistent JSON store (file-based, no DB needed) ──
const USERS_FILE = path.join(__dirname, "../../users.json");

function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch { return []; }
}

function writeUsers(users) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
  catch (e) { console.error("Failed to write users:", e.message); }
}

function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw + "mt_salt_2024").digest("hex");
}

function generateToken(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id, email: user.email, name: user.name, iat: Date.now()
  })).toString("base64");
  return payload;
}

// ── POST /api/auth/register ──────────────────────────────────
router.post("/register", (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ success: false, error: "All fields required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, error: "Password must be 6+ characters" });
  }
  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRx.test(email)) {
    return res.status(400).json({ success: false, error: "Invalid email address" });
  }

  const users = readUsers();
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ success: false, error: "already_registered", message: "Email already registered. Please sign in." });
  }

  const user = {
    id:        crypto.randomUUID(),
    name:      name.trim(),
    email:     email.toLowerCase().trim(),
    password:  hashPassword(password),
    role:      "Operator",
    avatar:    name.trim()[0].toUpperCase(),
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  writeUsers(users);

  const { password: _, ...safeUser } = user;
  const token = generateToken(user);

  return res.status(201).json({ success: true, data: { ...safeUser, token } });
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Email and password required" });
  }

  const users = readUsers();
  const user  = users.find(u => u.email.toLowerCase() === email.toLowerCase());

  if (!user || user.password !== hashPassword(password)) {
    return res.status(401).json({ success: false, error: "Invalid email or password" });
  }

  const { password: _, ...safeUser } = user;
  const token = generateToken(user);

  return res.json({ success: true, data: { ...safeUser, token } });
});

// ── GET /api/auth/check-email?email=x ───────────────────────
router.get("/check-email", (req, res) => {
  const { email } = req.query;
  if (!email) return res.json({ exists: false });
  const users = readUsers();
  const exists = !!users.find(u => u.email.toLowerCase() === email.toLowerCase());
  return res.json({ exists });
});

module.exports = router;
