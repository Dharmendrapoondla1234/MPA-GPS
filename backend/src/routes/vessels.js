// backend/src/routes/vessels.js — MPA Advanced v7 (Enhanced Vessel Tracking)
"use strict";
const express = require("express");
const router  = express.Router();
const { validateVesselQuery } = require("../middleware/validate");
const logger  = require("../utils/logger");
const {
  getLatestVessels, getVesselHistory, getVesselDetail,
  getRecentArrivals, getRecentDepartures,
  getVesselTypes, getFleetStats, getPortActivity,
  getVesselByIdentifier, getVesselLastArrival, getUpcomingArrivals,
  getVesselCompanyDetails,
} = require("../services/bigquery");

// ── Normalize BigQuery row → clean JS ────────────────────────────
function bqStr(v)  { if(v==null)return null; if(typeof v==="object"&&"value"in v)return String(v.value).trim()||null; return String(v).trim()||null; }
function bqNum(v)  { if(v==null)return null; const n=Number(bqStr(v)||v); return isNaN(n)?null:n; }
function bqBool(v) { return v===true||v==="true"||v===1; }

const RAD_TO_DEG = 180 / Math.PI;
function toLatDeg(v) { return bqNum(v); }
function toLngDeg(v) { return bqNum(v); }

function correctSgtTimestamp(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  if (d > new Date()) return new Date(d.getTime() - 8 * 60 * 60 * 1000).toISOString();
  return raw;
}

function normalizeVessel(v) {
  const rawLat = v.latitude_degrees ?? v.latitude;
  const rawLng = v.longitude_degrees ?? v.longitude;
  const rawSpd = v.speed_kn  ?? v.speed;
  const rawHdg = v.heading_deg ?? v.heading;
  const rawCrs = v.course_deg  ?? v.course;

  const rawTs  = bqStr(v.last_position_at) || bqStr(v.effective_timestamp);
  const effectiveTs = correctSgtTimestamp(rawTs);

  let minutesSincePing = null;
  if (effectiveTs) {
    minutesSincePing = Math.round((Date.now() - new Date(effectiveTs).getTime()) / 60000);
  }
  if (minutesSincePing == null || minutesSincePing < 0) {
    minutesSincePing = Math.max(0, bqNum(v.minutes_since_last_ping) ?? 0);
  }

  return {
    // identity
    imo_number:     bqNum(v.imo_number),
    vessel_name:    bqStr(v.vessel_name),
    mmsi_number:    bqNum(v.mmsi_number),
    call_sign:      bqStr(v.call_sign),
    flag:           bqStr(v.flag),
    vessel_type:    bqStr(v.vessel_type),
    // position
    latitude_degrees:  toLatDeg(rawLat),
    longitude_degrees: toLngDeg(rawLng),
    speed:   bqNum(rawSpd) ?? 0,
    heading: bqNum(rawHdg) ?? 0,
    course:  bqNum(rawCrs) ?? 0,
    effective_timestamp: effectiveTs,
    minutes_since_last_ping: minutesSincePing,
    is_stale: (minutesSincePing || 0) > 120,
    speed_category:     bqStr(v.speed_category),
    speed_colour_class: bqStr(v.speed_colour_class),
    // static
    vessel_length:  bqNum(v.vessel_length),
    vessel_breadth: bqNum(v.vessel_breadth),
    vessel_depth:   bqNum(v.vessel_depth),
    gross_tonnage:  bqNum(v.gross_tonnage),
    net_tonnage:    bqNum(v.net_tonnage),
    deadweight:     bqNum(v.deadweight),
    year_built:     bqNum(v.year_built),
    // voyage / status
    vessel_status:  bqStr(v.vessel_status),
    status_label:   bqStr(v.status_label),
    last_port_departed:    bqStr(v.last_port_departed) || bqStr(v.arrived_from),
    next_port_destination: bqStr(v.next_port_destination) || bqStr(v.next_port),
    // arrival info
    last_arrived_time:   bqStr(v.latest_arrival_time)   || bqStr(v.last_arrived_time),
    last_departed_time:  bqStr(v.latest_departure_time) || bqStr(v.last_departed_time),
    location_from:       bqStr(v.location_from) || bqStr(v.arrived_from),
    location_to:         bqStr(v.location_to)   || bqStr(v.arrived_at_berth),
    berth_location:      bqStr(v.berth_location) || bqStr(v.arrived_at_berth),
    berth_grid:          bqStr(v.berth_grid),
    voyage_purpose:      bqStr(v.voyage_purpose),
    shipping_agent:      bqStr(v.shipping_agent) || bqStr(v.arrival_agent) || bqStr(v.departure_agent),
    declared_arrival_time: bqStr(v.declared_arrival_time),
    crew_count:          bqNum(v.crew_count),
    passenger_count:     bqNum(v.passenger_count),
    // quality flags
    has_arrival_data:    bqBool(v.has_arrival_data ?? v.has_arrival_record ?? v.has_live_position),
    has_departure_data:  bqBool(v.has_departure_data ?? v.has_departure_record ?? false),
    has_declaration_data:bqBool(v.has_declaration_data ?? false),
    data_quality_score:  bqNum(v.data_quality_score),
    // port time
    port_time_hours:     bqNum(v.port_time_hours),
    hours_in_port_so_far:bqNum(v.hours_in_port_so_far),
    last_updated_at:     bqStr(v.last_updated_at),
  };
}

function normalizeArrival(v) {
  return {
    imo_number:     bqNum(v.imo_number    ?? v.imoNumber),
    vessel_name:    bqStr(v.vessel_name   ?? v.vesselName),
    mmsi_number:    bqNum(v.mmsi_number   ?? v.mmsiNumber),
    call_sign:      bqStr(v.call_sign     ?? v.callSign),
    flag:           bqStr(v.flag),
    vessel_type:    bqStr(v.vessel_type),
    arrival_time:   bqStr(v.arrival_time  ?? v.arrivedTime   ?? v.arrived_time),
    arrival_date:   bqStr(v.arrival_date  ?? v.arrivedDate),
    location_from:  bqStr(v.location_from ?? v.locationFrom  ?? v.location_from),
    location_to:    bqStr(v.location_to   ?? v.locationTo    ?? v.location_to),
    arrival_source: bqStr(v.arrival_source ?? v.arrivalSource ?? "AIS_CONFIRMED"),
    berth_grid:     bqStr(v.berth_grid    ?? v.berthGrid),
    voyage_purpose: bqStr(v.voyage_purpose ?? v.voyagePurpose),
    shipping_agent: bqStr(v.shipping_agent ?? v.shippingAgent),
    crew_count:     bqNum(v.crew_count    ?? v.crewCount),
    passenger_count:bqNum(v.passenger_count ?? v.passengerCount),
    is_upcoming:    v.is_upcoming === true || v.is_upcoming === "true",
    // NEW: company details
    company_name:    bqStr(v.company_name    ?? v.companyName),
    contact_person:  bqStr(v.contact_person  ?? v.contactPerson),
    contact_email:   bqStr(v.contact_email   ?? v.contactEmail),
    contact_phone:   bqStr(v.contact_phone   ?? v.contactPhone),
    company_address: bqStr(v.company_address ?? v.companyAddress),
  };
}

function normalizeDeparture(v) {
  const depTime = v.departure_time ?? v.departedTime ?? v.departed_time;
  const isUpcoming = depTime ? new Date(typeof depTime === "object" && "value" in depTime ? depTime.value : depTime) > new Date() : false;
  return {
    imo_number:       bqNum(v.imo_number      ?? v.imoNumber),
    vessel_name:      bqStr(v.vessel_name     ?? v.vesselName),
    mmsi_number:      bqNum(v.mmsi_number     ?? v.mmsiNumber),
    call_sign:        bqStr(v.call_sign       ?? v.callSign),
    flag:             bqStr(v.flag),
    vessel_type:      bqStr(v.vessel_type),
    departure_time:   bqStr(v.departure_time  ?? v.departedTime  ?? v.departed_time),
    departure_date:   bqStr(v.departure_date  ?? v.departedDate),
    departure_source: bqStr(v.departure_source ?? v.departureSource ?? "AIS_CONFIRMED"),
    next_port:        bqStr(v.next_port       ?? v.nextPort       ?? v.destinationPort),
    shipping_agent:   bqStr(v.shipping_agent  ?? v.shippingAgent),
    crew_count:       bqNum(v.crew_count      ?? v.crewCount),
    passenger_count:  bqNum(v.passenger_count ?? v.passengerCount),
    is_upcoming:      isUpcoming,
    // NEW: company details
    company_name:    bqStr(v.company_name    ?? v.companyName),
    contact_person:  bqStr(v.contact_person  ?? v.contactPerson),
    contact_email:   bqStr(v.contact_email   ?? v.contactEmail),
    contact_phone:   bqStr(v.contact_phone   ?? v.contactPhone),
    company_address: bqStr(v.company_address ?? v.companyAddress),
  };
}

// ── CSV export helper ─────────────────────────────────────────────
function toCSV(rows, fields) {
  const header = fields.join(",");
  const lines  = rows.map(row =>
    fields.map(f => {
      const val = row[f] ?? "";
      // Wrap in quotes if contains comma, newline, or quote
      const s = String(val);
      return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
    }).join(",")
  );
  return [header, ...lines].join("\n");
}

// ── GET /api/vessels ──────────────────────────────────────────────
router.get("/vessels", validateVesselQuery, async (req, res, next) => {
  try {
    const { search="", vesselType="", speedMin, speedMax, limit,
            imo, mmsi, flag, callSign } = req.query;

    // NEW: identifier-based direct lookup
    if (imo || mmsi) {
      const identifier = { imo, mmsi };
      const raw = await getVesselByIdentifier(identifier);
      if (!raw) return res.status(404).json({ success:false, error:"Vessel not found" });
      const data = Array.isArray(raw) ? raw.map(normalizeVessel) : [normalizeVessel(raw)];
      return res.json({ success:true, count:data.length, data });
    }

    const raw  = await getLatestVessels({
      search, vesselType, flag: flag || "",
      callSign: callSign || "",
      speedMin: speedMin !== undefined ? parseFloat(speedMin) : null,
      speedMax: speedMax !== undefined ? parseFloat(speedMax) : null,
      limit: limit ? parseInt(limit) : 3000,
    });
    const data = raw.map(normalizeVessel);

    const isFiltered = search || vesselType || speedMin || speedMax || flag || callSign;
    if (!isFiltered) {
      let maxTs = 0;
      for (const v of data) {
        const ts = v.effective_timestamp || v.last_position_at;
        if (!ts) continue;
        const t = new Date(typeof ts === "object" && ts.value ? ts.value : ts).getTime();
        if (!isNaN(t) && t > maxTs) maxTs = t;
      }
      const cacheSlot = Math.floor(Date.now() / 30_000);
      const etag = `W/"v-${data.length}-${maxTs}-${cacheSlot}"`;
      if (req.headers["if-none-match"] === etag) return res.status(304).end();
      res.set("ETag", etag);
      res.set("Cache-Control", "no-store");
    }

    if (data.length > 0) {
      const s = data[0];
      logger.info(
        `GET /api/vessels -> ${data.length} vessels | sample: ${s.vessel_name} ` +
        `lat=${s.latitude_degrees} lng=${s.longitude_degrees} ` +
        `spd=${s.speed} ts=${s.effective_timestamp} stale=${s.is_stale}`
      );
    } else {
      logger.warn("GET /api/vessels -> 0 vessels returned");
    }

    const slim = data.map(v => {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (val !== null && val !== undefined) out[k] = val;
      }
      return out;
    });
    res.json({ success:true, count:slim.length, data: slim });
  } catch(err) { next(err); }
});

// ── GET /api/vessels/search — advanced multi-field search ─────────
// Supports: ?imo=&mmsi=&name=&flag=&callSign=
router.get("/vessels/search", async (req, res, next) => {
  try {
    const { imo, mmsi, name, flag, callSign } = req.query;
    if (!imo && !mmsi && !name && !flag && !callSign) {
      return res.status(400).json({
        success:false,
        error:"Provide at least one search parameter: imo, mmsi, name, flag, or callSign"
      });
    }

    const raw = await getVesselByIdentifier({ imo, mmsi, name, flag, callSign });
    if (!raw || (Array.isArray(raw) && raw.length === 0)) {
      return res.status(404).json({ success:false, error:"No vessels found matching criteria" });
    }

    const data = Array.isArray(raw) ? raw.map(normalizeVessel) : [normalizeVessel(raw)];
    res.json({ success:true, count:data.length, data });
  } catch(err) { next(err); }
});

// ── GET /api/vessels/:imo ─────────────────────────────────────────
router.get("/vessels/:imo", async (req, res, next) => {
  try {
    const { imo } = req.params;
    if (!imo || isNaN(imo)) return res.status(400).json({ success:false, error:"Invalid IMO" });
    const raw = await getVesselDetail(imo);
    if (!raw) return res.status(404).json({ success:false, error:`IMO ${imo} not found` });
    res.json({ success:true, data: normalizeVessel(raw) });
  } catch(err) { next(err); }
});

// ── GET /api/vessels/:imo/company — NEW ───────────────────────────
// Returns shipping company + contact details for vessel
router.get("/vessels/:imo/company", async (req, res, next) => {
  try {
    const { imo } = req.params;
    if (!imo || isNaN(imo)) return res.status(400).json({ success:false, error:"Invalid IMO" });
    const raw = await getVesselCompanyDetails(imo);
    if (!raw) return res.status(404).json({ success:false, error:`Company details not found for IMO ${imo}` });
    res.json({
      success: true,
      data: {
        imo_number:      bqNum(raw.imo_number),
        vessel_name:     bqStr(raw.vessel_name),
        company_name:    bqStr(raw.company_name   ?? raw.shipping_company),
        contact_person:  bqStr(raw.contact_person ?? raw.contact_name),
        contact_email:   bqStr(raw.contact_email  ?? raw.email),
        contact_phone:   bqStr(raw.contact_phone  ?? raw.phone),
        company_address: bqStr(raw.company_address ?? raw.address),
        shipping_agent:  bqStr(raw.shipping_agent  ?? raw.agent),
        agent_email:     bqStr(raw.agent_email),
        agent_phone:     bqStr(raw.agent_phone),
      }
    });
  } catch(err) { next(err); }
});

// ── GET /api/vessels/:imo/last-arrival — NEW ──────────────────────
// Returns most recent historical arrival record for a specific vessel
router.get("/vessels/:imo/last-arrival", async (req, res, next) => {
  try {
    const { imo } = req.params;
    if (!imo || isNaN(imo)) return res.status(400).json({ success:false, error:"Invalid IMO" });
    const raw = await getVesselLastArrival(imo);
    if (!raw) return res.status(404).json({ success:false, error:`No arrival record found for IMO ${imo}` });
    res.json({ success:true, data: normalizeArrival(raw) });
  } catch(err) { next(err); }
});

// ── GET /api/vessels/:imo/history?hours=24 ───────────────────────
router.get("/vessels/:imo/history", async (req, res, next) => {
  try {
    const { imo } = req.params;
    if (!imo || isNaN(imo)) return res.status(400).json({ success:false, error:"Invalid IMO" });
    const hours = parseInt(req.query.hours) || 24;
    const raw   = await getVesselHistory(imo, hours);

    const aisPoints = raw.map(v => ({
      imo_number:        bqNum(v.imo_number),
      latitude_degrees:  bqNum(v.latitude_degrees),
      longitude_degrees: bqNum(v.longitude_degrees),
      speed:             bqNum(v.speed)   ?? 0,
      heading:           bqNum(v.heading) ?? 0,
      course:            bqNum(v.course)  ?? 0,
      effective_timestamp: correctSgtTimestamp(bqStr(v.effective_timestamp)),
    })).filter(p => p.latitude_degrees && p.longitude_degrees);

    const { distNM }                                = require("../services/maritimeRouter");
    const { learnLanes, nearestLaneCell, dijkstraLane } = require("../services/aisLaneExtractor");
    const { TSS_LANES, DEEP_WATER_ROUTES }          = require("../services/tssData");
    const { bigquery: bq2, BQ_LOCATION: bloc2, T: bqT2 } = require("../services/bigquery");

    const DENSIFY_THRESHOLD_NM = 15;
    const data = [];

    let laneGraph = null;
    try { laneGraph = await learnLanes(bq2, bloc2, bqT2); } catch (_) {}

    function tssInterp(a, b) {
      const allPts = [
        ...Object.values(TSS_LANES).flatMap(l => l.points.map(([la,lo])=>({lat:la,lng:lo}))),
        ...DEEP_WATER_ROUTES.flatMap(r => r.points.map(([la,lo])=>({lat:la,lng:lo}))),
      ];
      const dT = distNM(a.latitude_degrees, a.longitude_degrees, b.latitude_degrees, b.longitude_degrees);
      return allPts
        .filter(p => {
          const d1 = distNM(a.latitude_degrees, a.longitude_degrees, p.lat, p.lng);
          const d2 = distNM(b.latitude_degrees, b.longitude_degrees, p.lat, p.lng);
          return d1+d2 < dT*1.4 && d1>5 && d2>5;
        })
        .sort((x,y) => distNM(a.latitude_degrees,a.longitude_degrees,x.lat,x.lng)
                     - distNM(a.latitude_degrees,a.longitude_degrees,y.lat,y.lng));
    }

    for (let i = 0; i < aisPoints.length; i++) {
      data.push(aisPoints[i]);
      if (i < aisPoints.length - 1) {
        const a = aisPoints[i], b = aisPoints[i + 1];
        const gap = distNM(a.latitude_degrees, a.longitude_degrees, b.latitude_degrees, b.longitude_degrees);
        if (gap > DENSIFY_THRESHOLD_NM) {
          try {
            let inner = [];
            if (laneGraph && laneGraph.laneCells.size > 20) {
              const sk = nearestLaneCell(a.latitude_degrees, a.longitude_degrees, laneGraph.laneCells, a.heading);
              const ek = nearestLaneCell(b.latitude_degrees, b.longitude_degrees, laneGraph.laneCells);
              if (sk && ek) {
                const path = dijkstraLane(laneGraph.graph, laneGraph.laneCells, sk, ek);
                if (path && path.length > 2)
                  inner = path.slice(1,-1).map(k => { const c=laneGraph.laneCells.get(k); return{lat:c.lat,lng:c.lng}; });
              }
            }
            if (!inner.length) inner = tssInterp(a, b);
            const tA = new Date(a.effective_timestamp).getTime();
            const tB = new Date(b.effective_timestamp).getTime();
            inner.forEach((wp, idx) => {
              const frac = (idx+1)/(inner.length+1);
              data.push({
                imo_number:          a.imo_number,
                latitude_degrees:    wp.lat,
                longitude_degrees:   wp.lng,
                speed:               a.speed,
                heading:             a.heading,
                course:              a.course,
                effective_timestamp: new Date(tA + frac*(tB-tA)).toISOString(),
                sea_routed:          true,
              });
            });
          } catch (_) { /* skip on error */ }
        }
      }
    }

    data.sort((a, b) => new Date(a.effective_timestamp) - new Date(b.effective_timestamp));
    res.json({ success:true, count:data.length, hours, data });
  } catch(err) { next(err); }
});

// ── GET /api/arrivals ─────────────────────────────────────────────
// Enhanced: supports ?imo=&mmsi=&name=&flag= filters + download
router.get("/arrivals", async (req, res, next) => {
  try {
    const { limit, imo, mmsi, name, flag, download } = req.query;
    const lim = parseInt(limit) || 50;
    const raw = await getRecentArrivals(lim);
    let data = raw.map(normalizeArrival);

    // Apply identifier filters
    if (imo)   data = data.filter(v => String(v.imo_number||"").includes(imo.trim()));
    if (mmsi)  data = data.filter(v => String(v.mmsi_number||"").includes(mmsi.trim()));
    if (name)  data = data.filter(v => (v.vessel_name||"").toLowerCase().includes(name.trim().toLowerCase()));
    if (flag)  data = data.filter(v => (v.flag||"").toLowerCase().includes(flag.trim().toLowerCase()));

    // CSV download support
    if (download === "csv") {
      const fields = ["imo_number","vessel_name","mmsi_number","flag","vessel_type",
                      "arrival_time","arrival_date","location_from","location_to",
                      "berth_grid","voyage_purpose","shipping_agent","crew_count",
                      "passenger_count","arrival_source","company_name","contact_person",
                      "contact_email","contact_phone"];
      const csv = toCSV(data, fields);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="arrivals_${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(csv);
    }

    res.json({ success:true, count:data.length, data });
  } catch(err) { next(err); }
});

// ── GET /api/departures ───────────────────────────────────────────
// Enhanced: supports ?imo=&mmsi=&name=&flag= filters + download
router.get("/departures", async (req, res, next) => {
  try {
    const { limit, imo, mmsi, name, flag, download } = req.query;
    const lim = parseInt(limit) || 50;
    const raw = await getRecentDepartures(lim);
    let data = raw.map(normalizeDeparture);

    // Apply identifier filters
    if (imo)   data = data.filter(v => String(v.imo_number||"").includes(imo.trim()));
    if (mmsi)  data = data.filter(v => String(v.mmsi_number||"").includes(mmsi.trim()));
    if (name)  data = data.filter(v => (v.vessel_name||"").toLowerCase().includes(name.trim().toLowerCase()));
    if (flag)  data = data.filter(v => (v.flag||"").toLowerCase().includes(flag.trim().toLowerCase()));

    // CSV download support
    if (download === "csv") {
      const fields = ["imo_number","vessel_name","mmsi_number","flag","vessel_type",
                      "departure_time","departure_date","next_port","shipping_agent",
                      "crew_count","passenger_count","departure_source","is_upcoming",
                      "company_name","contact_person","contact_email","contact_phone"];
      const csv = toCSV(data, fields);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="departures_${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(csv);
    }

    res.json({ success:true, count:data.length, data });
  } catch(err) { next(err); }
});

// ── GET /api/arrivals/upcoming — NEW ─────────────────────────────
// Returns scheduled/expected future arrivals
router.get("/arrivals/upcoming", async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const raw   = await getUpcomingArrivals(limit);
    const data  = raw.map(normalizeArrival);

    if (req.query.download === "csv") {
      const fields = ["imo_number","vessel_name","mmsi_number","flag","vessel_type",
                      "arrival_time","arrival_date","location_from","berth_grid",
                      "voyage_purpose","shipping_agent","company_name","contact_person","contact_email"];
      const csv = toCSV(data, fields);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="upcoming_arrivals_${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(csv);
    }

    res.json({ success:true, count:data.length, data });
  } catch(err) { next(err); }
});

// ── GET /api/port-activity ────────────────────────────────────────
router.get("/port-activity", async (req, res, next) => {
  try {
    const raw = await getPortActivity();
    res.json({ success:true, data: raw });
  } catch(err) { next(err); }
});

// ── GET /api/vessel-types ─────────────────────────────────────────
router.get("/vessel-types", async (req, res, next) => {
  try {
    const types = await getVesselTypes();
    res.json({ success:true, data: types });
  } catch(err) { next(err); }
});

// ── GET /api/stats ────────────────────────────────────────────────
router.get("/stats", async (req, res, next) => {
  try {
    const raw  = await getFleetStats();
    const data = {};
    for (const [k,v] of Object.entries(raw)) data[k] = v!=null ? Number(v) : 0;
    res.json({ success:true, data });
  } catch(err) { next(err); }
});

module.exports = router;