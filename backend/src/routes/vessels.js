// backend/src/routes/vessels.js — MPA Advanced v6
"use strict";
const express = require("express");
const router = express.Router();
const { validateVesselQuery } = require("../middleware/validate");
const logger = require("../utils/logger");
const {
  getLatestVessels,
  getVesselHistory,
  getVesselDetail,
  getRecentArrivals,
  getRecentDepartures,
  getVesselTypes,
  getFleetStats,
  getPortActivity,
} = require("../services/bigquery");

// ── Normalize BigQuery row → clean JS ────────────────────────────
function bqStr(v) {
  if (v == null) return null;
  if (typeof v === "object" && "value" in v)
    return String(v.value).trim() || null;
  return String(v).trim() || null;
}
function bqNum(v) {
  if (v == null) return null;
  const n = Number(bqStr(v) || v);
  return isNaN(n) ? null : n;
}
function bqBool(v) {
  return v === true || v === "true" || v === 1;
}

function normalizeVessel(v) {
  // Handle both dbt column names and legacy column names gracefully.
  // dbt fct_vessel_live_tracking uses different aliases than legacy MPA_Master_Vessels.
  return {
    // identity
    imo_number: bqNum(v.imo_number),
    vessel_name: bqStr(v.vessel_name),
    mmsi_number: bqNum(v.mmsi_number),
    call_sign: bqStr(v.call_sign),
    flag: bqStr(v.flag),
    vessel_type: bqStr(v.vessel_type),
    // position
    latitude_degrees: bqNum(v.latitude_degrees),
    longitude_degrees: bqNum(v.longitude_degrees),
    speed: bqNum(v.speed) ?? 0,
    heading: bqNum(v.heading) ?? 0,
    course: bqNum(v.course) ?? 0,
    // dbt: last_position_at  |  legacy: effective_timestamp
    effective_timestamp:
      bqStr(v.last_position_at) || bqStr(v.effective_timestamp),
    minutes_since_last_ping: bqNum(v.minutes_since_last_ping),
    // dbt: no is_stale column — derive from minutes_since_last_ping > 60
    is_stale:
      v.is_stale != null
        ? bqBool(v.is_stale)
        : (bqNum(v.minutes_since_last_ping) || 0) > 60,
    speed_category: bqStr(v.speed_category),
    speed_colour_class: bqStr(v.speed_colour_class),
    // static — dbt omits vessel_breadth, vessel_depth, net_tonnage, year_built
    vessel_length: bqNum(v.vessel_length),
    vessel_breadth: bqNum(v.vessel_breadth) ?? null,
    vessel_depth: bqNum(v.vessel_depth) ?? null,
    gross_tonnage: bqNum(v.gross_tonnage),
    net_tonnage: bqNum(v.net_tonnage) ?? null,
    deadweight: bqNum(v.deadweight),
    year_built: bqNum(v.year_built) ?? null,
    // voyage / status
    vessel_status: bqStr(v.vessel_status),
    status_label: bqStr(v.status_label),
    last_port_departed: bqStr(v.last_port_departed),
    next_port_destination: bqStr(v.next_port_destination),
    // dbt: latest_arrival_time / latest_departure_time
    last_arrived_time:
      bqStr(v.latest_arrival_time) || bqStr(v.last_arrived_time),
    last_departed_time:
      bqStr(v.latest_departure_time) || bqStr(v.last_departed_time),
    // declaration — berth_grid & declared_arrival_time not in dbt yet
    berth_location: bqStr(v.berth_location),
    berth_grid: bqStr(v.berth_grid) ?? null,
    voyage_purpose: bqStr(v.voyage_purpose),
    shipping_agent: bqStr(v.shipping_agent),
    declared_arrival_time: bqStr(v.declared_arrival_time) ?? null,
    crew_count: bqNum(v.crew_count),
    passenger_count: bqNum(v.passenger_count),
    // quality flags — dbt uses has_arrival_record / has_departure_record
    has_arrival_data: bqBool(
      v.has_arrival_data ?? v.has_arrival_record ?? v.has_live_position,
    ),
    has_departure_data: bqBool(
      v.has_departure_data ?? v.has_departure_record ?? false,
    ),
    has_declaration_data: bqBool(v.has_declaration_data ?? false),
    data_quality_score: bqNum(v.data_quality_score),
    // port time
    port_time_hours: bqNum(v.port_time_hours),
    hours_in_port_so_far: bqNum(v.hours_in_port_so_far),
    last_updated_at: bqStr(v.last_updated_at),
  };
}

function normalizeArrival(v) {
  return {
    imo_number: bqNum(v.imo_number),
    vessel_name: bqStr(v.vessel_name),
    call_sign: bqStr(v.call_sign),
    flag: bqStr(v.flag),
    arrival_time: bqStr(v.arrival_time),
    arrival_date: bqStr(v.arrival_date),
    location_from: bqStr(v.location_from),
    location_to: bqStr(v.location_to),
    arrival_source: bqStr(v.arrival_source),
    berth_grid: bqStr(v.berth_grid),
    voyage_purpose: bqStr(v.voyage_purpose),
    shipping_agent: bqStr(v.shipping_agent),
    crew_count: bqNum(v.crew_count),
    passenger_count: bqNum(v.passenger_count),
  };
}

function normalizeDeparture(v) {
  return {
    imo_number: bqNum(v.imo_number),
    vessel_name: bqStr(v.vessel_name),
    call_sign: bqStr(v.call_sign),
    flag: bqStr(v.flag),
    departure_time: bqStr(v.departure_time),
    departure_date: bqStr(v.departure_date),
    departure_source: bqStr(v.departure_source),
    next_port: bqStr(v.next_port),
    shipping_agent: bqStr(v.shipping_agent),
    crew_count: bqNum(v.crew_count),
    passenger_count: bqNum(v.passenger_count),
  };
}

// ── GET /api/vessels ──────────────────────────────────────────────
router.get("/vessels", validateVesselQuery, async (req, res, next) => {
  try {
    const {
      search = "",
      vesselType = "",
      speedMin,
      speedMax,
      limit,
    } = req.query;
    const raw = await getLatestVessels({
      search,
      vesselType,
      speedMin: speedMin !== undefined ? parseFloat(speedMin) : null,
      speedMax: speedMax !== undefined ? parseFloat(speedMax) : null,
      limit: limit ? parseInt(limit) : 5000,
    });
    const data = raw.map(normalizeVessel);
    logger.info(`GET /api/vessels → ${data.length}`);
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/vessels/:imo ─────────────────────────────────────────
router.get("/vessels/:imo", async (req, res, next) => {
  try {
    const { imo } = req.params;
    if (!imo || isNaN(imo))
      return res.status(400).json({ success: false, error: "Invalid IMO" });
    const raw = await getVesselDetail(imo);
    if (!raw)
      return res
        .status(404)
        .json({ success: false, error: `IMO ${imo} not found` });
    res.json({ success: true, data: normalizeVessel(raw) });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/vessels/:imo/history?hours=24 ───────────────────────
router.get("/vessels/:imo/history", async (req, res, next) => {
  try {
    const { imo } = req.params;
    if (!imo || isNaN(imo))
      return res.status(400).json({ success: false, error: "Invalid IMO" });
    const hours = parseInt(req.query.hours) || 24;
    const raw = await getVesselHistory(imo, hours);
    const data = raw.map((v) => ({
      imo_number: bqNum(v.imo_number),
      latitude_degrees: bqNum(v.latitude_degrees),
      longitude_degrees: bqNum(v.longitude_degrees),
      speed: bqNum(v.speed) ?? 0,
      heading: bqNum(v.heading) ?? 0,
      course: bqNum(v.course) ?? 0,
      effective_timestamp: bqStr(v.effective_timestamp),
    }));
    res.json({ success: true, count: data.length, hours, data });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/arrivals ─────────────────────────────────────────────
router.get("/arrivals", async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const raw = await getRecentArrivals(limit);
    res.json({
      success: true,
      count: raw.length,
      data: raw.map(normalizeArrival),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/departures ───────────────────────────────────────────
router.get("/departures", async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const raw = await getRecentDepartures(limit);
    res.json({
      success: true,
      count: raw.length,
      data: raw.map(normalizeDeparture),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/port-activity ────────────────────────────────────────
router.get("/port-activity", async (req, res, next) => {
  try {
    const raw = await getPortActivity();
    res.json({ success: true, data: raw });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/vessel-types ─────────────────────────────────────────
router.get("/vessel-types", async (req, res, next) => {
  try {
    const types = await getVesselTypes();
    res.json({ success: true, data: types });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/stats ────────────────────────────────────────────────
router.get("/stats", async (req, res, next) => {
  try {
    const raw = await getFleetStats();
    const data = {};
    for (const [k, v] of Object.entries(raw))
      data[k] = v != null ? Number(v) : 0;
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
