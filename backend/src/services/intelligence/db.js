// services/intelligence/db.js
// Lightweight in-process store for enriched contact intelligence.
// Uses a simple JSON file as persistence (no PostgreSQL dependency needed for Render free tier).
// Swap out the _store object for a real pg/BigQuery write in production.
"use strict";

const fs     = require("fs");
const path   = require("path");
const logger = require("../../utils/logger");

const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, "../../../../data");
const DB_FILE   = path.join(DATA_DIR, "contact_intelligence.json");

// ── In-memory store (loaded from disk on startup) ─────────────────
let _store = {
  companies: {},   // keyed by domain
  contacts:  {},   // keyed by email
  people:    {},   // keyed by `${companyId}::${name}`
  imo_map:   {},   // imo_number → [domain, ...]
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  try {
    if (fs.existsSync(DB_FILE)) {
      _store = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      logger.info(`[intelligence-db] loaded ${Object.keys(_store.companies).length} companies from disk`);
    }
  } catch (err) {
    logger.warn(`[intelligence-db] failed to load: ${err.message}`);
  }
}

function save() {
  ensureDir();
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(_store, null, 2), "utf8");
  } catch (err) {
    logger.warn(`[intelligence-db] failed to save: ${err.message}`);
  }
}

load(); // load on module init

// ── Companies ─────────────────────────────────────────────────────
function upsertCompany({ name, domain, imoNumber, role }) {
  const id = domain || name.toLowerCase().replace(/\s+/g, "_");
  const existing = _store.companies[id] || {};
  _store.companies[id] = {
    ...existing,
    id,
    name:       name || existing.name,
    domain:     domain || existing.domain,
    role:       role   || existing.role,
    updated_at: new Date().toISOString(),
    created_at: existing.created_at || new Date().toISOString(),
  };
  if (imoNumber) {
    if (!_store.imo_map[imoNumber]) _store.imo_map[imoNumber] = [];
    if (!_store.imo_map[imoNumber].includes(id)) _store.imo_map[imoNumber].push(id);
  }
  save();
  return _store.companies[id];
}

function getCompany(id) { return _store.companies[id] || null; }

function getCompaniesByImo(imoNumber) {
  const ids = _store.imo_map[String(imoNumber)] || [];
  return ids.map(id => _store.companies[id]).filter(Boolean);
}

// ── Contacts (emails) ─────────────────────────────────────────────
function upsertContact({ companyId, email, confidence, source, smtpValid }) {
  const key = email.toLowerCase();
  const existing = _store.contacts[key] || {};
  _store.contacts[key] = {
    ...existing,
    company_id:     companyId,
    email:          key,
    confidence:     Math.max(confidence || 0, existing.confidence || 0),
    source:         source || existing.source,
    smtp_valid:     smtpValid ?? existing.smtp_valid ?? null,
    updated_at:     new Date().toISOString(),
    created_at:     existing.created_at || new Date().toISOString(),
  };
  save();
  return _store.contacts[key];
}

function getContactsByCompany(companyId) {
  return Object.values(_store.contacts)
    .filter(c => c.company_id === companyId)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
}

// ── People ────────────────────────────────────────────────────────
function upsertPerson({ companyId, name, role, inferredEmail, source }) {
  const key = `${companyId}::${name.toLowerCase()}`;
  const existing = _store.people[key] || {};
  _store.people[key] = {
    ...existing,
    company_id:    companyId,
    name:          name || existing.name,
    role:          role || existing.role,
    inferred_email: inferredEmail || existing.inferred_email,
    source:        source || existing.source,
    updated_at:    new Date().toISOString(),
    created_at:    existing.created_at || new Date().toISOString(),
  };
  save();
  return _store.people[key];
}

function getPeopleByCompany(companyId) {
  return Object.values(_store.people).filter(p => p.company_id === companyId);
}

// ── Full record for an IMO ────────────────────────────────────────
function getIntelligenceByImo(imoNumber) {
  const companies = getCompaniesByImo(imoNumber);
  return companies.map(co => ({
    company:  co,
    contacts: getContactsByCompany(co.id),
    people:   getPeopleByCompany(co.id),
  }));
}

// ── Stats ─────────────────────────────────────────────────────────
function getStats() {
  return {
    companies: Object.keys(_store.companies).length,
    contacts:  Object.keys(_store.contacts).length,
    people:    Object.keys(_store.people).length,
    imo_index: Object.keys(_store.imo_map).length,
  };
}

module.exports = {
  upsertCompany, getCompany, getCompaniesByImo,
  upsertContact, getContactsByCompany,
  upsertPerson,  getPeopleByCompany,
  getIntelligenceByImo,
  getStats,
};