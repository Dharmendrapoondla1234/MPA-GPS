// services/intelligence/emailEngine.js
// Generates standard corporate email patterns and validates them via SMTP
"use strict";

const net    = require("net");
const dns    = require("dns").promises;
const logger = require("../../utils/logger");

// ── Standard maritime/corporate email prefixes ────────────────────
const STANDARD_PREFIXES = [
  "info",
  "contact",
  "operations",
  "ops",
  "chartering",
  "charter",
  "commercial",
  "sales",
  "admin",
  "general",
  "enquiries",
  "enquiry",
  "mail",
  "office",
  "technical",
  "crewing",
  "crew",
  "accounts",
];

// ── Email generation ──────────────────────────────────────────────
function generateEmails(domain) {
  if (!domain) return [];
  return STANDARD_PREFIXES.map(prefix => ({
    email:      `${prefix}@${domain}`,
    confidence: 50,
    source:     "pattern_generated",
  }));
}

// ── Extract MX records (required for SMTP validation) ─────────────
async function getMxRecord(domain) {
  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) return null;
    records.sort((a, b) => a.priority - b.priority);
    return records[0].exchange;
  } catch {
    return null;
  }
}

// ── SMTP validation (no email sent) ──────────────────────────────
// Connects to MX server, issues EHLO + MAIL FROM + RCPT TO
// A 250 response to RCPT TO means the mailbox exists
async function smtpValidate(email, mxHost, timeoutMs = 8000) {
  const [, domain] = email.split("@");
  return new Promise(resolve => {
    const sock = new net.Socket();
    let stage = 0;
    let validated = false;
    const done = (result) => {
      if (!sock.destroyed) sock.destroy();
      resolve(result);
    };

    sock.setTimeout(timeoutMs);
    sock.on("timeout", () => done(false));
    sock.on("error",   () => done(false));

    sock.connect(25, mxHost, () => { /* wait for banner */ });

    sock.on("data", data => {
      const line = data.toString();
      try {
        if (stage === 0 && line.startsWith("2")) {
          sock.write(`EHLO mailcheck.validator\r\n`);
          stage = 1;
        } else if (stage === 1 && line.startsWith("2")) {
          sock.write(`MAIL FROM:<check@mailcheck.validator>\r\n`);
          stage = 2;
        } else if (stage === 2 && line.startsWith("2")) {
          sock.write(`RCPT TO:<${email}>\r\n`);
          stage = 3;
        } else if (stage === 3) {
          validated = line.startsWith("2");   // 250 = exists, 550 = does not exist
          sock.write("QUIT\r\n");
          done(validated);
        } else if (line.startsWith("5")) {
          done(false); // permanent error
        }
      } catch { done(false); }
    });
  });
}

// ── Validate a batch of generated emails ─────────────────────────
/**
 * @param {string[]} emails - list of email addresses
 * @param {string}   domain - the domain (to look up MX once)
 * @returns {Array<{email, confidence, source, smtp_valid}>}
 */
async function validateEmails(emails, domain) {
  let mxHost = null;
  try { mxHost = await getMxRecord(domain); } catch { /* no MX */ }

  const results = [];
  for (const email of emails) {
    let confidence = 50;
    let source     = "pattern_generated";
    let smtpValid  = null;

    if (mxHost) {
      try {
        smtpValid = await smtpValidate(email, mxHost);
        if (smtpValid) {
          confidence = 80;
          source     = "smtp_validated";
        }
      } catch { /* SMTP blocked — common, not an error */ }
    }

    results.push({ email, confidence, source, smtp_valid: smtpValid });
  }

  return results;
}

// ── Deduplicate + rank emails ─────────────────────────────────────
function rankEmails(emails) {
  const seen = new Set();
  return emails
    .filter(e => {
      if (!e?.email || seen.has(e.email)) return false;
      seen.add(e.email);
      return true;
    })
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
}

module.exports = { generateEmails, validateEmails, rankEmails, getMxRecord };