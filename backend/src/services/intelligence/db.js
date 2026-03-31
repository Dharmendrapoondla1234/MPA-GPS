// src/services/intelligence/db.js — v3
// Lightweight JSON-file-backed store + in-memory knowledge graph
"use strict";

const fs   = require("fs");
const path = require("path");
const logger = require("../../utils/logger");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../../../../data");
const DB_FILE  = path.join(DATA_DIR, "contact_intelligence.json");

let _store = { companies:{}, contacts:{}, people:{}, imo_map:{}, results:{} };

const _graph = { vessels:{}, companies:{}, domains:{}, emails:{}, edges:[] };

function graphUpsert(type, id, data) {
  if (!_graph[type]) return;
  _graph[type][id] = { ..._graph[type][id], ...data };
  return _graph[type][id];
}
function graphEdge(src, rel, dst) {
  if (!_graph.edges.some(e => e.src===src && e.rel===rel && e.dst===dst))
    _graph.edges.push({ src, rel, dst });
}

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

function save() {
  ensureDir();
  try {
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), "utf8");
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { logger.warn(`[db] save failed: ${e.message}`); }
}

function load() {
  ensureDir();
  try {
    if (fs.existsSync(DB_FILE)) {
      _store = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      _store.results = _store.results || {};
      logger.info(`[db] loaded ${Object.keys(_store.companies||{}).length} companies, ${Object.keys(_store.contacts||{}).length} contacts`);
    }
  } catch (e) { logger.warn(`[db] load failed: ${e.message}`); }
}
load();

function upsertCompany({ name, domain, imoNumber, role }) {
  const id  = domain || name.toLowerCase().replace(/\s+/g, "_");
  const now = new Date().toISOString();
  const ex  = _store.companies[id] || {};
  _store.companies[id] = { ...ex, id, name: name||ex.name, domain: domain||ex.domain, role: role||ex.role, updated_at: now, created_at: ex.created_at||now };
  if (imoNumber) {
    const k = String(imoNumber);
    if (!_store.imo_map[k]) _store.imo_map[k] = [];
    if (!_store.imo_map[k].includes(id)) _store.imo_map[k].push(id);
  }
  const norm = name.toLowerCase().replace(/\s+/g,"_");
  graphUpsert("companies", `company:${norm}`, { name, norm, role });
  if (imoNumber) {
    graphUpsert("vessels", `vessel:${imoNumber}`, { imo: String(imoNumber) });
    graphEdge(`vessel:${imoNumber}`, role==="owner"?"owns":"manages", `company:${norm}`);
  }
  if (domain) {
    graphUpsert("domains", `domain:${domain}`, { domain });
    graphEdge(`company:${norm}`, "uses_domain", `domain:${domain}`);
  }
  save();
  return _store.companies[id];
}

function getCompany(id)           { return _store.companies[id] || null; }
function getCompaniesByImo(imo)   { return (_store.imo_map[String(imo)]||[]).map(id=>_store.companies[id]).filter(Boolean); }

function upsertContact({ companyId, email, confidence, source, smtpValid=null }) {
  const key = email.toLowerCase();
  const now = new Date().toISOString();
  const ex  = _store.contacts[key] || {};
  _store.contacts[key] = {
    ...ex, company_id: companyId, email: key,
    confidence:  Math.max(confidence||0, ex.confidence||0),
    source:      source||ex.source,
    smtp_valid:  smtpValid!==null ? smtpValid : (ex.smtp_valid??null),
    updated_at:  now, created_at: ex.created_at||now,
  };
  graphUpsert("emails", `email:${key}`, { email: key, confidence, source, smtp_valid: smtpValid });
  if (companyId) graphEdge(`company:${companyId}`, "has_email", `email:${key}`);
  save();
  return _store.contacts[key];
}

function getContactsByCompany(id) {
  return Object.values(_store.contacts).filter(c=>c.company_id===id).sort((a,b)=>(b.confidence||0)-(a.confidence||0));
}

function upsertPerson({ companyId, name, role, inferredEmail, source }) {
  const key = `${companyId}::${name.toLowerCase()}`;
  const now = new Date().toISOString();
  const ex  = _store.people[key] || {};
  _store.people[key] = { ...ex, company_id:companyId, name, role:role||ex.role, inferred_email:inferredEmail||ex.inferred_email, source:source||ex.source, updated_at:now, created_at:ex.created_at||now };
  save();
  return _store.people[key];
}

function getPeopleByCompany(id)   { return Object.values(_store.people).filter(p=>p.company_id===id); }
function cacheResult(imo,r)       { _store.results[String(imo)]=r; save(); }
function getCachedResult(imo)     { return _store.results[String(imo)]||null; }
function clearCachedResult(imo)   { delete _store.results[String(imo)]; save(); }

function getIntelligenceByImo(imo) {
  return getCompaniesByImo(imo).map(co=>({ company:co, contacts:getContactsByCompany(co.id), people:getPeopleByCompany(co.id) }));
}

function getStats() {
  return {
    companies:      Object.keys(_store.companies||{}).length,
    contacts:       Object.keys(_store.contacts||{}).length,
    people:         Object.keys(_store.people||{}).length,
    imo_index:      Object.keys(_store.imo_map||{}).length,
    cached_results: Object.keys(_store.results||{}).length,
    graph: {
      vessels:   Object.keys(_graph.vessels).length,
      companies: Object.keys(_graph.companies).length,
      domains:   Object.keys(_graph.domains).length,
      emails:    Object.keys(_graph.emails).length,
      edges:     _graph.edges.length,
    },
  };
}

module.exports = {
  upsertCompany, getCompany, getCompaniesByImo,
  upsertContact, getContactsByCompany,
  upsertPerson,  getPeopleByCompany,
  cacheResult,   getCachedResult, clearCachedResult,
  getIntelligenceByImo, getStats,
  graphUpsert, graphEdge, getGraph: () => _graph,
};