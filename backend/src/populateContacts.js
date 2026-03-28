// populateContacts.js — MPA Contact Data Population Script
//
// WHAT THIS DOES:
//   1. Reads all vessels from your existing BigQuery tables (d_vessel_master / f_vessel_live_tracking)
//   2. For each vessel, uses Claude AI + web search to find owner/company contact info
//   3. Inserts found data into:
//      - d_shipping_companies
//      - d_vessel_company_map
//      - d_contact_audit_log
//
// HOW TO RUN:
//   node populateContacts.js              -- process 50 vessels (default)
//   node populateContacts.js --limit 200  -- process 200 vessels
//   node populateContacts.js --imo 9254549 -- process single vessel by IMO
//
// REQUIREMENTS (set in .env or as env vars):
//   ANTHROPIC_API_KEY=sk-ant-...
//   GOOGLE_APPLICATION_CREDENTIALS_JSON={"type":"service_account",...}
//   BIGQUERY_PROJECT_ID=photons-377606  (optional, this is the default)
//   BIGQUERY_DATASET=MPA               (optional, this is the default)
//   EQUASIS_EMAIL=your@email.com       (optional but highly recommended)
//   EQUASIS_PASSWORD=yourpassword      (optional but highly recommended)

"use strict";
require("dotenv").config();

const { BigQuery } = require("@google-cloud/bigquery");
const Anthropic    = require("@anthropic-ai/sdk");

// ── CONFIG ────────────────────────────────────────────────────────
const PROJECT    = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET    = process.env.BIGQUERY_DATASET    || "MPA";
const BQ_LOC     = process.env.BIGQUERY_LOCATION   || "asia-southeast1";
const DELAY_MS   = 4000;   // 4s between vessels — respect API rate limits
const BATCH_SIZE = 10;     // insert rows in batches

// Parse CLI args
const args    = process.argv.slice(2);
const LIMIT   = parseInt(args[args.indexOf("--limit")  + 1] || "50");
const SINGLE_IMO = args.includes("--imo") ? parseInt(args[args.indexOf("--imo") + 1]) : null;

// ── CLIENTS ───────────────────────────────────────────────────────
let bq;
const _creds = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (_creds?.trim().startsWith("{")) {
  try {
    const c = JSON.parse(_creds);
    bq = new BigQuery({ credentials: c, projectId: c.project_id || PROJECT, location: BQ_LOC });
    console.log("✅ BigQuery: JSON credentials");
  } catch { bq = new BigQuery({ projectId: PROJECT, location: BQ_LOC }); }
} else {
  bq = new BigQuery({ projectId: PROJECT, location: BQ_LOC });
  console.log("✅ BigQuery: Application Default Credentials");
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── HELPERS ───────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function uuid(imo, type) { return `enriched_${imo}_${type}_${Date.now()}`; }
function bqv(v) {
  if (v == null) return null;
  if (typeof v === "object" && "value" in v) return String(v.value).trim() || null;
  return String(v).trim() || null;
}

// ── EQUASIS LOGIN ─────────────────────────────────────────────────
let _equasisCookies = null;
let _equasisTs      = 0;

async function equasisLogin() {
  if (_equasisCookies && Date.now() - _equasisTs < 4 * 3600 * 1000) return _equasisCookies;
  const email    = process.env.EQUASIS_EMAIL;
  const password = process.env.EQUASIS_PASSWORD;
  if (!email || !password) { console.warn("⚠️  EQUASIS_EMAIL/PASSWORD not set — skipping Equasis"); return null; }
  try {
    const pageRes = await fetch("https://www.equasis.org/EquasisWeb/public/HomePage", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/2.0)" },
    });
    const cookies = pageRes.headers.get("set-cookie") || "";
    const loginRes = await fetch("https://www.equasis.org/EquasisWeb/authen/HomePage?fs=Search", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookies,
        "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/2.0)",
        Referer: "https://www.equasis.org/EquasisWeb/public/HomePage",
      },
      body: new URLSearchParams({ j_email: email, j_password: password, submit: "Login" }),
      redirect: "manual",
    });
    const sessionCookie = loginRes.headers.get("set-cookie") || cookies;
    if (sessionCookie && (loginRes.status === 302 || loginRes.status === 200)) {
      _equasisCookies = sessionCookie;
      _equasisTs      = Date.now();
      console.log("✅ Equasis login successful");
      return sessionCookie;
    }
    console.warn("⚠️  Equasis login failed, status:", loginRes.status);
    return null;
  } catch (e) { console.warn("⚠️  Equasis login error:", e.message); return null; }
}

async function fetchEquasis(imo) {
  const cookies = await equasisLogin();
  if (!cookies) return null;
  try {
    const res = await fetch(
      `https://www.equasis.org/EquasisWeb/authen/ShipInfo?fs=Search&P_IMO=${imo}`,
      { headers: { Cookie: cookies, "User-Agent": "Mozilla/5.0 (compatible; MPA-GPS/2.0)" } }
    );
    if (!res.ok) return null;
    const html = await res.text();
    const ownerMatch   = html.match(/Registered owner[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,100})</i);
    const managerMatch = html.match(/ISM[^<]*[Mm]anager[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]{3,100})</i);
    const owner   = ownerMatch?.[1]?.trim();
    const manager = managerMatch?.[1]?.trim();
    if (!owner && !manager) return null;
    console.log(`  [Equasis] owner="${owner}" manager="${manager}"`);
    return { owner_name: owner || null, manager_name: manager || null, confidence: 0.90 };
  } catch (e) { console.warn("  [Equasis] error:", e.message); return null; }
}

// ── AI WEB SEARCH ─────────────────────────────────────────────────
async function aiSearchContacts(companyName, vesselName, flag) {
  if (!process.env.ANTHROPIC_API_KEY) { console.warn("  ⚠️  ANTHROPIC_API_KEY not set"); return null; }
  const searchTerm = companyName || vesselName;
  if (!searchTerm) return null;
  try {
    const prompt = companyName
      ? `You are a maritime data researcher. Find official contact information for this shipping company:

Company: "${companyName}"${flag ? `\nFlag/Country: ${flag}` : ""}

Search the web and return ONLY a valid JSON object (no explanation, no markdown) with:
{
  "company_name": "official company name",
  "website": "https://...",
  "email": "primary contact email",
  "email_ops": "operations email or null",
  "phone": "+country code number",
  "phone_secondary": "alternative phone or null",
  "address": "registered address or null",
  "country_code": "ISO-2 country code",
  "confidence": 0.0
}
Rules: Only REAL verified data. Prefer ops@, operations@, info@, contact@ emails. Set null for anything unverified. confidence: 0.9=official site, 0.7=directory, 0.5=uncertain.`
      : `You are a maritime data researcher. Find the registered owner company for vessel:

Vessel Name: "${vesselName}"${flag ? `\nFlag: ${flag}` : ""}

Search the web (try MarineTraffic, VesselFinder, Equasis) and return ONLY a valid JSON object:
{
  "company_name": "owner company name",
  "website": "https://... or null",
  "email": "contact email or null",
  "email_ops": "ops email or null",
  "phone": "phone or null",
  "address": "address or null",
  "country_code": "ISO-2 or null",
  "confidence": 0.0
}`;

    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 600,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find(b => b.type === "text");
    if (!textBlock?.text) return null;
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const data = JSON.parse(jsonMatch[0]);
    if (!data.company_name && !data.email) return null;
    console.log(`  [AI] company="${data.company_name}" email=${data.email} conf=${data.confidence}`);
    return data;
  } catch (e) {
    console.warn("  [AI] error:", e.message?.slice(0, 100));
    return null;
  }
}

// ── BIGQUERY INSERT HELPERS ───────────────────────────────────────
async function insertRows(tableName, rows) {
  if (!rows.length) return;
  try {
    await bq.dataset(DATASET).table(tableName).insert(rows, { skipInvalidRows: true, ignoreUnknownValues: true });
  } catch (e) {
    // BQ streaming insert errors are often partial — log but continue
    if (e.name === "PartialFailureError") {
      const errs = e.errors?.slice(0, 3).map(e2 => e2.errors?.[0]?.message).join(", ");
      console.warn(`  [BQ] Partial insert error in ${tableName}: ${errs}`);
    } else {
      console.warn(`  [BQ] Insert error in ${tableName}:`, e.message?.slice(0, 100));
    }
  }
}

// ── FETCH VESSELS FROM YOUR EXISTING BQ TABLES ───────────────────
async function fetchVessels() {
  if (SINGLE_IMO) {
    console.log(`\n🔍 Single vessel mode — IMO ${SINGLE_IMO}`);
    const [rows] = await bq.query({
      query: `
        SELECT CAST(imo_number AS INT64) AS imo_number, vessel_name, flag, vessel_type
        FROM \`${PROJECT}.${DATASET}.d_vessel_master\`
        WHERE CAST(imo_number AS STRING) = '${SINGLE_IMO}'
        LIMIT 1`,
      location: BQ_LOC,
    });
    if (!rows.length) {
      // Try live tracking table
      const [rows2] = await bq.query({
        query: `
          SELECT CAST(imo_number AS INT64) AS imo_number, vessel_name, flag, vessel_type
          FROM \`${PROJECT}.${DATASET}.f_vessel_live_tracking\`
          WHERE CAST(imo_number AS STRING) = '${SINGLE_IMO}'
          LIMIT 1`,
        location: BQ_LOC,
      });
      return rows2;
    }
    return rows;
  }

  console.log(`\n📋 Fetching up to ${LIMIT} vessels not yet in d_vessel_company_map...`);
  try {
    const [rows] = await bq.query({
      query: `
        SELECT DISTINCT
          CAST(v.imo_number AS INT64) AS imo_number,
          v.vessel_name,
          v.flag,
          v.vessel_type
        FROM \`${PROJECT}.${DATASET}.d_vessel_master\` v
        LEFT JOIN \`${PROJECT}.${DATASET}.d_vessel_company_map\` m
          ON CAST(m.imo_number AS INT64) = CAST(v.imo_number AS INT64)
        WHERE m.imo_number IS NULL
          AND v.imo_number IS NOT NULL
          AND CAST(v.imo_number AS INT64) > 1000000
        ORDER BY v.vessel_name
        LIMIT ${LIMIT}`,
      location: BQ_LOC,
    });
    if (rows.length > 0) return rows;
  } catch (e) {
    console.warn("d_vessel_master query failed, trying f_vessel_live_tracking:", e.message.slice(0, 80));
  }

  // Fallback to live tracking table
  const [rows] = await bq.query({
    query: `
      SELECT DISTINCT
        CAST(v.imo_number AS INT64) AS imo_number,
        v.vessel_name,
        v.flag,
        v.vessel_type
      FROM \`${PROJECT}.${DATASET}.f_vessel_live_tracking\` v
      LEFT JOIN \`${PROJECT}.${DATASET}.d_vessel_company_map\` m
        ON CAST(m.imo_number AS INT64) = CAST(v.imo_number AS INT64)
      WHERE m.imo_number IS NULL
        AND v.imo_number IS NOT NULL
        AND CAST(v.imo_number AS INT64) > 1000000
      ORDER BY v.vessel_name
      LIMIT ${LIMIT}`,
    location: BQ_LOC,
  });
  return rows;
}

// ── PROCESS ONE VESSEL ────────────────────────────────────────────
async function processVessel(vessel) {
  const imo  = Number(vessel.imo_number);
  const name = bqv(vessel.vessel_name) || "Unknown";
  const flag = bqv(vessel.flag) || null;

  if (!imo || imo < 1000000) { console.log(`  ⏭  Skipping invalid IMO: ${imo}`); return null; }

  console.log(`\n🚢 Processing IMO ${imo} — ${name} [${flag || "?"}]`);

  // Step 1: Equasis
  const equasis = await fetchEquasis(imo);

  // Step 2: AI search — use company name from Equasis or vessel name
  const companyName = equasis?.owner_name || equasis?.manager_name || null;
  const aiData      = await aiSearchContacts(companyName, name, flag);

  // Combine results
  const ownerName   = aiData?.company_name || companyName || null;
  const managerName = equasis?.manager_name || null;

  if (!ownerName && !aiData?.email) {
    console.log(`  ⚠️  No data found for IMO ${imo} — skipping`);
    return null;
  }

  const now       = new Date().toISOString();
  const companyId = uuid(imo, "owner");
  const managerId = managerName ? uuid(imo, "manager") : null;

  // ── INSERT d_shipping_companies (owner) ──────────────────────
  const ownerRow = {
    company_id:         companyId,
    company_name:       ownerName,
    company_type:       "OWNER",
    imo_company_number: null,
    country_code:       aiData?.country_code || flag?.slice(0, 2) || null,
    registered_address: aiData?.address      || null,
    primary_email:      aiData?.email        || null,
    secondary_email:    aiData?.email_ops    || null,
    phone_primary:      aiData?.phone        || null,
    phone_secondary:    aiData?.phone_secondary || null,
    website:            aiData?.website      || null,
    data_source:        equasis ? "equasis+ai_search" : "ai_search",
    last_verified_at:   now,
    created_at:         now,
    updated_at:         now,
  };
  await insertRows("d_shipping_companies", [ownerRow]);

  // ── INSERT d_shipping_companies (manager) if found ──────────
  if (managerName && managerId) {
    await insertRows("d_shipping_companies", [{
      company_id:         managerId,
      company_name:       managerName,
      company_type:       "MANAGER",
      imo_company_number: null,
      country_code:       null,
      registered_address: null,
      primary_email:      null,
      secondary_email:    null,
      phone_primary:      null,
      phone_secondary:    null,
      website:            null,
      data_source:        "equasis",
      last_verified_at:   now,
      created_at:         now,
      updated_at:         now,
    }]);
  }

  // ── INSERT d_vessel_company_map ──────────────────────────────
  await insertRows("d_vessel_company_map", [{
    imo_number:          imo,
    mmsi_number:         null,
    vessel_name:         name,
    owner_company_id:    companyId,
    operator_company_id: null,
    manager_company_id:  managerId || null,
    direct_email:        aiData?.email || null,
    direct_phone:        aiData?.phone || null,
    data_source:         equasis ? "equasis+ai_search" : "ai_search",
    last_verified_at:    now,
    created_at:          now,
    updated_at:          now,
  }]);

  // ── INSERT d_contact_audit_log ───────────────────────────────
  await insertRows("d_contact_audit_log", [{
    log_id:        `log_${imo}_${Date.now()}`,
    imo_number:    imo,
    field_changed: "full_enrichment",
    old_value:     null,
    new_value:     JSON.stringify({ owner: ownerName, email: aiData?.email, source: ownerRow.data_source }),
    changed_by:    "populateContacts.js",
    change_source: ownerRow.data_source,
    changed_at:    now,
  }]);

  console.log(`  ✅ IMO ${imo} — owner="${ownerName}" email=${aiData?.email || "not found"}`);
  return { imo, owner: ownerName, email: aiData?.email };
}

// ── MAIN ──────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  MPA Contact Data Population Script");
  console.log(`  Project: ${PROJECT} | Dataset: ${DATASET}`);
  console.log(`  Limit: ${SINGLE_IMO ? `IMO ${SINGLE_IMO}` : LIMIT} vessels`);
  console.log("═══════════════════════════════════════════════════════");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY is required. Set it in your .env file.");
    process.exit(1);
  }

  // Verify BQ connection
  try {
    await bq.query({ query: `SELECT 1`, location: BQ_LOC });
    console.log("✅ BigQuery connection OK");
  } catch (e) {
    console.error("❌ BigQuery connection failed:", e.message);
    process.exit(1);
  }

  // Fetch vessels to process
  let vessels;
  try {
    vessels = await fetchVessels();
  } catch (e) {
    console.error("❌ Failed to fetch vessels:", e.message);
    process.exit(1);
  }

  if (!vessels.length) {
    console.log("\n✅ No vessels to process — all vessels already have contact data!");
    return;
  }
  console.log(`\n📊 Found ${vessels.length} vessels to enrich\n`);

  // Process each vessel
  const results = { success: 0, failed: 0, total: vessels.length };

  for (let i = 0; i < vessels.length; i++) {
    const vessel = vessels[i];
    console.log(`\n[${i + 1}/${vessels.length}]`);
    try {
      const result = await processVessel(vessel);
      if (result) results.success++;
      else        results.failed++;
    } catch (e) {
      console.error(`  ❌ Error processing IMO ${vessel.imo_number}:`, e.message);
      results.failed++;
    }
    // Rate limit: wait between vessels
    if (i < vessels.length - 1) {
      console.log(`  ⏳ Waiting ${DELAY_MS / 1000}s...`);
      await sleep(DELAY_MS);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`  ✅ Done! ${results.success}/${results.total} vessels enriched`);
  console.log(`  ❌ Failed: ${results.failed}`);
  console.log("═══════════════════════════════════════════════════════");
}

main().catch(e => { console.error("Fatal error:", e); process.exit(1); });