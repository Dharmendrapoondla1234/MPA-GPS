// src/services/intelligence/engines/emailEngine.js — v2 (enhanced accuracy)
// Email Pattern Generator + Multi-layer Validation Engine
// Enhancements: smarter SMTP, catch-all detection, name-pattern generation
"use strict";

const net    = require("net");
const dns    = require("dns").promises;
const logger = require("../../../utils/logger");
const {
  EMAIL_PREFIXES, SMTP_TIMEOUT_MS, MARITIME_ROLE_PREFIXES, DISPOSABLE_DOMAINS,
} = require("../../../config");

const EMAIL_SYNTAX_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

function isValidSyntax(email) {
  return typeof email === "string" && email.length <= 254 && EMAIL_SYNTAX_RE.test(email);
}

function isDisposable(domain) {
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}

/** Generate maritime-role prefix email candidates for a domain. */
function generateEmails(domain) {
  if (!domain) return [];
  return EMAIL_PREFIXES.map(p => ({ email: `${p}@${domain}`, confidence: 50, source: "pattern_generated" }));
}

/** Generate email permutations from a person name + domain. */
function inferPersonEmails(firstName, lastName, domain) {
  if (!firstName || !lastName || !domain) return [];
  const f  = firstName.toLowerCase().replace(/[^a-z]/g, "");
  const l  = lastName.toLowerCase().replace(/[^a-z]/g, "");
  const fi = f[0] || "";
  if (!f || !l) return [];
  return [
    { email: `${f}.${l}@${domain}`,  confidence: 72, source: "name_inferred" },  // most common
    { email: `${fi}${l}@${domain}`,  confidence: 62, source: "name_inferred" },
    { email: `${f}${l}@${domain}`,   confidence: 57, source: "name_inferred" },
    { email: `${l}.${f}@${domain}`,  confidence: 55, source: "name_inferred" },
    { email: `${l}${fi}@${domain}`,  confidence: 50, source: "name_inferred" },  // NEW: lastnamefirstinitial
    { email: `${fi}.${l}@${domain}`, confidence: 52, source: "name_inferred" },  // NEW: f.lastname
  ];
}

async function getMxHost(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    if (!mx?.length) return null;
    return mx.sort((a, b) => a.priority - b.priority)[0].exchange;
  } catch { return null; }
}

// NEW: Catch-all detection — checks if server accepts non-existent addresses
async function detectCatchAll(domain, mxHost) {
  const bogusEmail = `definitely_not_real_abc123xyz_${Date.now()}@${domain}`;
  const result = await smtpProbe(bogusEmail, mxHost);
  return result === true; // if true, server accepts everything (catch-all)
}

/** SMTP RCPT TO probe — never sends an email. */
async function smtpProbe(email, mxHost) {
  return new Promise(resolve => {
    const sock  = new net.Socket();
    let   stage = 0;
    const done  = v => { if (!sock.destroyed) sock.destroy(); resolve(v); };

    sock.setTimeout(SMTP_TIMEOUT_MS);
    sock.on("timeout", () => done(null));
    sock.on("error",   () => done(null));

    sock.connect(25, mxHost);
    sock.on("data", data => {
      const line = data.toString();
      try {
        if      (stage === 0 && line.startsWith("2"))  { sock.write("EHLO verify.maritime.bot\r\n"); stage = 1; }
        else if (stage === 1 && line.startsWith("2"))  { sock.write(`MAIL FROM:<probe@verify.maritime.bot>\r\n`); stage = 2; }
        else if (stage === 2 && line.startsWith("2"))  { sock.write(`RCPT TO:<${email}>\r\n`); stage = 3; }
        else if (stage === 3) {
          const v = line.startsWith("250") ? true
                  : (line.startsWith("550") || line.startsWith("551") || line.startsWith("553")) ? false
                  : null;
          sock.write("QUIT\r\n");
          done(v);
        } else if (line.startsWith("5")) done(false);
        else if (line.startsWith("4")) done(null); // greylisting
      } catch { done(null); }
    });
  });
}

/**
 * Validate a list of email addresses.
 * Enhancement: catch-all detection prevents false positives on catch-all servers.
 * Returns enriched list with smtp_valid, mx_exists, updated confidence.
 */
async function validateEmails(emails, domain) {
  // Layer 0: syntax + disposable filter
  const syntaxOk = emails.filter(e =>
    isValidSyntax(e.email) && !isDisposable(e.email.split("@")[1] || "")
  );
  if (!syntaxOk.length) return [];

  // Layer 1: MX record
  const mxHost = await getMxHost(domain).catch(() => null);
  if (!mxHost) {
    logger.debug(`[email-engine] no MX for ${domain} — skipping SMTP`);
    return syntaxOk.map(e => ({ ...e, smtp_valid: null, mx_exists: false }));
  }

  // NEW: Catch-all detection — if server is catch-all, SMTP results are unreliable
  const isCatchAll = await detectCatchAll(domain, mxHost).catch(() => false);
  if (isCatchAll) {
    logger.info(`[email-engine] ${domain} is catch-all server — skipping SMTP validation`);
    // Still return emails but mark them as unverifiable; set smtp_valid = "catch_all"
    return syntaxOk.map(e => ({
      ...e,
      smtp_valid: null,
      mx_exists: true,
      catch_all: true,
      // Slightly boost pattern-generated emails since server doesn't reject them
      confidence: Math.min((e.confidence || 50) + 5, 80),
    }));
  }

  // Layer 2: SMTP probe in batches of 5
  const BATCH   = 5;
  const results = [];
  let   confirmed = 0;

  for (let i = 0; i < syntaxOk.length; i += BATCH) {
    const batch  = syntaxOk.slice(i, i + BATCH);
    const probes = await Promise.all(
      batch.map(e => smtpProbe(e.email, mxHost).catch(() => null))
    );
    for (let j = 0; j < batch.length; j++) {
      const item  = batch[j];
      const smtp  = probes[j];
      let   conf  = item.confidence ?? 50;
      let   src   = item.source     ?? "unknown";
      if      (smtp === true)  { conf = Math.max(conf, 82); src = "smtp_validated"; confirmed++; }
      else if (smtp === false) { conf = 0; src = "smtp_rejected"; }
      results.push({ ...item, confidence: Math.round(conf), source: src, smtp_valid: smtp, mx_exists: true });
    }
    if (confirmed >= 3) break; // stop early once we have enough
  }

  return results.filter(r => r.confidence > 0);
}

/** Deduplicate and sort emails by confidence descending. */
function rankEmails(emails) {
  const seen = new Map(); // email → highest-confidence item
  for (const e of emails) {
    if (!e?.email) continue;
    const k = e.email.toLowerCase();
    const existing = seen.get(k);
    if (!existing || (e.confidence ?? 0) > (existing.confidence ?? 0)) {
      seen.set(k, e);
    }
  }
  return [...seen.values()].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
}

module.exports = {
  generateEmails, inferPersonEmails, validateEmails, rankEmails,
  getMxHost, isValidSyntax, isDisposable, detectCatchAll,
};
