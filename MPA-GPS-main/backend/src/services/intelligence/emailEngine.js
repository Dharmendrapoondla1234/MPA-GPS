// services/intelligence/emailEngine.js  v2
// Steps 5-6: Email generation + multi-layer validation
// Layer 1: Domain MX check  Layer 2: SMTP probe  Layer 3: Pattern confidence
"use strict";

const net  = require("net");
const dns  = require("dns").promises;
const logger = require("../../utils/logger");

// Maritime-specific prefix priority (most likely first)
const PREFIXES = [
  "info", "contact", "operations", "ops", "chartering", "charter",
  "commercial", "sales", "admin", "general", "enquiries", "enquiry",
  "mail", "office", "technical", "tech", "crewing", "crew",
  "accounts", "finance", "agency", "singapore", "sg",
  "management", "mgmt", "fleet",
];

function generateEmails(domain) {
  if (!domain) return [];
  return PREFIXES.map(p => ({ email: `${p}@${domain}`, confidence: 50, source: "pattern_generated" }));
}

// Infer emails from person name + domain
function inferPersonEmails(firstName, lastName, domain) {
  if (!firstName || !lastName || !domain) return [];
  const f  = firstName.toLowerCase().replace(/[^a-z]/g, "");
  const l  = lastName.toLowerCase().replace(/[^a-z]/g, "");
  const fi = f[0] || "";
  return [
    { email: `${f}.${l}@${domain}`,  confidence: 70, source: "name_inferred" },
    { email: `${fi}${l}@${domain}`,  confidence: 60, source: "name_inferred" },
    { email: `${f}${l}@${domain}`,   confidence: 55, source: "name_inferred" },
    { email: `${l}.${f}@${domain}`,  confidence: 55, source: "name_inferred" },
  ];
}

async function getMxRecord(domain) {
  try {
    const records = await dns.resolveMx(domain);
    if (!records?.length) return null;
    return records.sort((a, b) => a.priority - b.priority)[0].exchange;
  } catch { return null; }
}

// SMTP probe — no email sent
async function smtpProbe(email, mxHost, timeoutMs = 7000) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let stage = 0;
    const done = v => { if (!sock.destroyed) sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.on("timeout", () => done(null));   // null = inconclusive (not false)
    sock.on("error",   () => done(null));
    sock.connect(25, mxHost);
    sock.on("data", data => {
      const line = data.toString();
      try {
        if      (stage === 0 && line.startsWith("2"))  { sock.write("EHLO verify.bot\r\n"); stage = 1; }
        else if (stage === 1 && line.startsWith("2"))  { sock.write("MAIL FROM:<check@verify.bot>\r\n"); stage = 2; }
        else if (stage === 2 && line.startsWith("2"))  { sock.write(`RCPT TO:<${email}>\r\n`); stage = 3; }
        else if (stage === 3) {
          const v = line.startsWith("250") ? true : line.startsWith("550") || line.startsWith("551") ? false : null;
          sock.write("QUIT\r\n");
          done(v);
        } else if (line.startsWith("5")) done(false);
        else if (line.startsWith("4")) done(null); // greylisting — inconclusive
      } catch { done(null); }
    });
  });
}

/**
 * Validate a list of emails against a domain.
 * Returns enriched list with smtp_valid and updated confidence.
 */
async function validateEmails(emails, domain) {
  // Layer 1: MX check
  const mxHost = await getMxRecord(domain);
  if (!mxHost) {
    logger.info(`[email-engine] no MX for ${domain} — skipping SMTP`);
    return emails.map(e => ({ ...e, smtp_valid: null, mx_exists: false }));
  }

  const results = [];
  // Layer 2: SMTP probe in small batches
  for (const e of emails) {
    let smtpValid = null;
    try { smtpValid = await smtpProbe(e.email, mxHost); } catch { /* blocked */ }

    let confidence = e.confidence;
    let source     = e.source;

    if      (smtpValid === true)  { confidence = Math.max(confidence, 82); source = "smtp_validated"; }
    else if (smtpValid === false) { confidence = 0; source = "smtp_rejected"; } // mailbox doesn't exist
    // null = inconclusive — keep existing confidence

    results.push({ ...e, confidence, source, smtp_valid: smtpValid, mx_exists: true });
  }
  return results.filter(e => e.confidence > 0); // remove SMTP-rejected
}

function rankEmails(emails) {
  const seen = new Set();
  return emails
    .filter(e => { if (!e?.email || seen.has(e.email)) return false; seen.add(e.email); return true; })
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
}

module.exports = { generateEmails, validateEmails, rankEmails, getMxRecord, inferPersonEmails };