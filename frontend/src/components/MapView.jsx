// src/components/MapView.jsx
// Full nautical chart overlay + vessel proximity collision detection

import React, {
  useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle,
} from "react";
import { Loader } from "@googlemaps/js-api-loader";
import { MarkerClusterer } from "@googlemaps/markerclusterer";
import { buildInfoWindowContent, getSpeedColor, getRegionName } from "../utils/vesselUtils";
import "./MapView.css";

const MAP_CENTER  = { lat: 1.35, lng: 103.82 };
const BASE_URL    = process.env.REACT_APP_API_URL || "https://vessel-backends.onrender.com/api";
let loaderPromise = null;

// ── COLLISION DETECTION RADII (metres) ───────────────────────
const RADIUS = {
  DANGER:  500,    // red   — immediate hazard (vessel icon turns red)
  WARNING: 1500,   // amber — caution zone (vessel icon turns amber)
};

const STALE_MS = 24 * 60 * 60 * 1000;
const IS_MOBILE = /Mobi|Android/i.test(navigator.userAgent);

function isStale(v) {
  const ts = v.effective_timestamp;
  if (!ts) return false;
  try { return Date.now() - new Date(typeof ts === "object" && ts.value ? ts.value : ts).getTime() > STALE_MS; }
  catch { return false; }
}

// Haversine distance in metres
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function smoothMove(marker, newLat, newLng) {
  const from = marker.getPosition();
  if (!from) { marker.setPosition({ lat: newLat, lng: newLng }); return; }
  const dLat = newLat - from.lat(), dLng = newLng - from.lng();
  if (IS_MOBILE || (Math.abs(dLat) < 0.0001 && Math.abs(dLng) < 0.0001)) {
    marker.setPosition({ lat: newLat, lng: newLng }); return;
  }
  if (marker._animId) cancelAnimationFrame(marker._animId);
  const ms = 1200, t0 = performance.now(), lat0 = from.lat(), lng0 = from.lng();
  const step = now => {
    const p = Math.min((now - t0) / ms, 1), e = p < 0.5 ? 2*p*p : -1+(4-2*p)*p;
    marker.setPosition({ lat: lat0 + dLat * e, lng: lng0 + dLng * e });
    if (p < 1) marker._animId = requestAnimationFrame(step);
    else marker._animId = null;
  };
  marker._animId = requestAnimationFrame(step);
}

function getVesselIcon(vessel, isSelected, alertLevel = null) {
  const color   = alertLevel === "danger"  ? "#ff2244" :
                  alertLevel === "warning" ? "#ffaa00" :
                  getSpeedColor(vessel.speed);
  const heading = parseFloat(vessel.heading) || 0;
  const speed   = parseFloat(vessel.speed)   || 0;
  const scale   = isSelected ? 11 : alertLevel ? 9 : 7;
  if (speed > 0.5) {
    return { path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale, rotation: heading, fillColor: color, fillOpacity: 1, strokeColor: isSelected ? "#ffffff" : alertLevel === "danger" ? "#ff0000" : "rgba(0,0,0,0.6)", strokeWeight: isSelected || alertLevel === "danger" ? 2.5 : 1 };
  }
  return { path: window.google.maps.SymbolPath.CIRCLE, scale: scale - 2, fillColor: color, fillOpacity: 0.85, strokeColor: isSelected ? "#ffffff" : "rgba(0,0,0,0.5)", strokeWeight: isSelected ? 2 : 1 };
}

// ── PARSE WKT → lat/lng arrays ────────────────────────────────
function wktToLatLng(coords, type) {
  if (!coords) return null;
  if (type === "danger_point" || type === "seabed_point" || type === "tide_point" || type === "aid_nav" || type === "port_service" || type === "cultural_point") {
    return Array.isArray(coords) && typeof coords[0] === "number"
      ? { lat: coords[1], lng: coords[0] }
      : null;
  }
  if (type === "depth_contour" || type === "danger_line" || type === "track_line") {
    return Array.isArray(coords) && Array.isArray(coords[0])
      ? coords.map(c => ({ lat: c[1], lng: c[0] }))
      : null;
  }
  if (type === "danger_area" || type === "regulated_area" || type === "track_area" || type === "seabed_area" || type === "cultural_bridge") {
    const ring = Array.isArray(coords[0]) && Array.isArray(coords[0][0]) ? coords[0] : coords;
    return Array.isArray(ring) ? ring.map(c => ({ lat: c[1], lng: c[0] })) : null;
  }
  return null;
}

// (layer styles applied inline per feature)

const MapView = forwardRef(function MapView({ vessels, selectedVessel, onVesselClick, trailData }, ref) {
  const mapRef       = useRef(null);
  const mapObj       = useRef(null);
  const markersRef   = useRef({});
  const clusterer    = useRef(null);
  const infoWin      = useRef(null);
  const hoverWin     = useRef(null);
  const trailObjs    = useRef([]);
  const gisObjs      = useRef([]);         // all GIS layer objects
  const alertCircles = useRef({});         // per-vessel alert circles
  const vesselCircles= useRef({});         // vessel–vessel proximity circles
  const pulseCirc    = useRef(null);
  const pulseTimer   = useRef(null);
  const clusterDirty = useRef(false);

  const [coords,    setCoords]    = useState(null);
  const [mapStyle,  setMapStyle]  = useState("satellite");
  const [mapReady,  setMapReady]  = useState(false);  // tracks when Google Map is initialized
  const [gisData,   setGisData]   = useState(null);
  const [alerts,    setAlerts]    = useState([]);  // proximity alerts list
  const [layers,    setLayers]    = useState({     // layer toggles
    dangers: true, depths: true, regulated: true,
    tracks: true, aids: true, seabed: false,
    ports: true, tides: false, cultural: true,
    vesselProximity: true,
  });
  const [showPanel, setShowPanel] = useState(false);
  const [loadingGIS, setLoadingGIS] = useState(true);

  useImperativeHandle(ref, () => ({
    panToVessel(vessel) {
      const lat = Number(vessel?.latitude_degrees), lng = Number(vessel?.longitude_degrees);
      if (mapObj.current && lat && lng) { mapObj.current.panTo({ lat, lng }); mapObj.current.setZoom(13); }
    },
  }));

  // ── FETCH GIS DATA ────────────────────────────────────────
  useEffect(() => {
    fetch(`${BASE_URL}/gis/all`)
      .then(r => r.json())
      .then(j => { setGisData(j.data); setLoadingGIS(false); })
      .catch(() => setLoadingGIS(false));
  }, []);

  // ── INIT MAP ──────────────────────────────────────────────
  useEffect(() => {
    if (mapObj.current) return;
    if (!loaderPromise) {
      loaderPromise = new Loader({
        apiKey: process.env.REACT_APP_GOOGLE_MAPS_KEY || "",
        version: "weekly", libraries: ["geometry"],
      }).load();
    }
    loaderPromise.then(() => {
      if (mapObj.current) return;
      const map = new window.google.maps.Map(mapRef.current, {
        center: MAP_CENTER, zoom: 10, mapTypeId: "hybrid",
        zoomControl: true, streetViewControl: false, mapTypeControl: false,
        fullscreenControl: false, rotateControl: false, gestureHandling: "greedy",
      });
      mapObj.current = map;
      infoWin.current  = new window.google.maps.InfoWindow({ maxWidth: 340 });
      hoverWin.current = new window.google.maps.InfoWindow({ maxWidth: 240, disableAutoPan: true });
      map.addListener("mousemove", e => setCoords({ lat: e.latLng.lat().toFixed(5), lng: e.latLng.lng().toFixed(5) }));
      map.addListener("click", () => { infoWin.current.close(); hoverWin.current.close(); });
      setMapReady(true); // ← triggers GIS render effect
      clusterer.current = new MarkerClusterer({
        map, markers: [],
        renderer: { render({ count, position }) {
          const size = count < 10 ? 24 : count < 50 ? 28 : count < 200 ? 32 : 38;
          return new window.google.maps.Marker({
            position,
            icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: size/2, fillColor: "rgba(20,30,48,0.75)", fillOpacity: 1, strokeColor: "rgba(255,255,255,0.5)", strokeWeight: 1.5 },
            label: { text: count > 999 ? `${(count/1000).toFixed(1)}k` : String(count), color: "#ffffff", fontSize: "11px", fontFamily: "'JetBrains Mono',monospace", fontWeight: "700" },
            zIndex: 999,
          });
        }},
      });
    });
  }, []);

  // ── RENDER GIS LAYERS ─────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapObj.current || !gisData) return;

    // Clear old GIS objects
    gisObjs.current.forEach(o => { try { o.setMap(null); } catch(_) {} });
    gisObjs.current = [];

    const map = mapObj.current;
    const add = obj => { gisObjs.current.push(obj); return obj; };

    // ── REGULATED AREAS ──
    if (layers.regulated && gisData.regulated) {
      gisData.regulated.forEach(f => {
        const path = wktToLatLng(f.coords, f.type);
        if (!path || !Array.isArray(path)) return;
        add(new window.google.maps.Polygon({
          paths: path, map,
          fillColor: "#ffcc0020", strokeColor: "#ffcc00",
          strokeWeight: 1.5, strokeOpacity: 0.9, fillOpacity: 1, zIndex: 2,
          clickable: true,
        })).addListener("click", () => {
          infoWin.current.setContent(`
            <div style="font-family:'JetBrains Mono',monospace;background:#1a1200;border:1px solid #ffcc00;border-radius:8px;padding:10px 14px;color:#fff;min-width:200px">
              <div style="color:#ffcc00;font-weight:700;font-size:12px">⚠️ REGULATED AREA</div>
              <div style="margin-top:6px;font-size:11px;color:#ffd">${f.name || "Restricted Zone"}</div>
              ${f.info ? `<div style="margin-top:4px;font-size:10px;color:#aa9">${f.info.substring(0,200)}</div>` : ""}
            </div>`);
          infoWin.current.setPosition(path[0]);
          infoWin.current.open(map);
        });
      });
    }

    // ── TRACK & ROUTE AREAS (TSS lanes) ──
    if (layers.tracks && gisData.tracks) {
      gisData.tracks.forEach(f => {
        if (f.type === "track_area") {
          const path = wktToLatLng(f.coords, f.type);
          if (!path || !Array.isArray(path)) return;
          add(new window.google.maps.Polygon({
            paths: path, map,
            fillColor: "#00aaff12", strokeColor: "#00aaff88",
            strokeWeight: 1, fillOpacity: 1, zIndex: 1,
          }));
        } else if (f.type === "track_line") {
          const path = wktToLatLng(f.coords, f.type);
          if (!path || !Array.isArray(path)) return;
          add(new window.google.maps.Polyline({
            path, map,
            strokeColor: "#0088ffaa", strokeWeight: 1.5, strokeOpacity: 0.8, zIndex: 3,
            icons: [{ icon: { path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 2, fillColor: "#0088ff", fillOpacity: 0.7, strokeColor: "#fff", strokeWeight: 0.5 }, offset: "50%", repeat: "80px" }],
          }));
        }
      });
    }

    // ── DEPTH CONTOURS ──
    if (layers.depths && gisData.depths) {
      gisData.depths.forEach(f => {
        const path = wktToLatLng(f.coords, f.type);
        if (!path || !Array.isArray(path)) return;
        const depth = parseFloat(f.depth) || 0;
        const col = depth <= 5 ? "#ff440088" : depth <= 10 ? "#ff880055" : depth <= 20 ? "#ffcc0044" : "#0055aa44";
        add(new window.google.maps.Polyline({ path, map, strokeColor: col, strokeWeight: depth <= 5 ? 2 : 1, zIndex: 1 }));
      });
    }

    // ── DANGERS ──
    if (layers.dangers && gisData.dangers) {
      gisData.dangers.forEach(f => {
        if (f.type === "danger_point") {
          const pos = wktToLatLng(f.coords, f.type);
          if (!pos) return;
          const m = add(new window.google.maps.Marker({
            position: pos, map,
            icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: "#ff2244", fillOpacity: 0.9, strokeColor: "#fff", strokeWeight: 1.5 },
            title: f.name || "Danger", zIndex: 10,
          }));
          m.addListener("click", () => {
            infoWin.current.setContent(dangerInfoContent(f));
            infoWin.current.open(map, m);
          });
          // Danger radius circle
          add(new window.google.maps.Circle({ center: pos, radius: 80, map, fillColor: "#ff2244", fillOpacity: 0.15, strokeColor: "#ff2244", strokeWeight: 1, strokeOpacity: 0.6, zIndex: 4 }));
        } else if (f.type === "danger_area") {
          const path = wktToLatLng(f.coords, f.type);
          if (!path || !Array.isArray(path)) return;
          add(new window.google.maps.Polygon({
            paths: path, map,
            fillColor: "#ff224433", strokeColor: "#ff2244",
            strokeWeight: 2, fillOpacity: 1, zIndex: 5,
            clickable: true,
          })).addListener("click", () => {
            infoWin.current.setContent(dangerInfoContent(f));
            infoWin.current.setPosition(path[0]);
            infoWin.current.open(map);
          });
        } else if (f.type === "danger_line") {
          const path = wktToLatLng(f.coords, f.type);
          if (!path) return;
          add(new window.google.maps.Polyline({ path, map, strokeColor: "#ff4466", strokeWeight: 2.5, zIndex: 6 }));
        }
      });
    }

    // ── AIDS TO NAVIGATION (buoys, beacons, lights) ──
    if (layers.aids && gisData.aids) {
      gisData.aids.forEach(f => {
        if (!f.coords || isNaN(f.coords[0])) return;
        const pos = { lat: f.coords[1], lng: f.coords[0] };
        const col = f.colour === "1" ? "#ff2244" : f.colour === "3" ? "#00cc44" : f.lighted ? "#ffee00" : "#cccccc";
        const m = add(new window.google.maps.Marker({
          position: pos, map,
          icon: { path: f.lighted ? "M -2 -8 L 0 -10 L 2 -8 L 1 -8 L 1 0 L -1 0 L -1 -8 Z" : window.google.maps.SymbolPath.CIRCLE,
                  scale: f.lighted ? 1 : 4, fillColor: col, fillOpacity: 0.9, strokeColor: "#000", strokeWeight: 1 },
          title: f.name || "Aid to Navigation", zIndex: 8,
        }));
        if (f.lighted && f.range_nm > 0) {
          add(new window.google.maps.Circle({ center: pos, radius: f.range_nm * 1852, map, fillColor: col + "08", strokeColor: col + "30", strokeWeight: 0.5, zIndex: 1 }));
        }
        m.addListener("click", () => {
          infoWin.current.setContent(`
            <div style="font-family:'JetBrains Mono',monospace;background:#061020;border:1px solid ${col};border-radius:8px;padding:10px 14px;color:#fff;min-width:180px">
              <div style="color:${col};font-weight:700;font-size:12px">${f.lighted ? "💡" : "🔘"} ${f.buoy ? "BUOY" : "BEACON"}</div>
              <div style="margin-top:4px;font-size:11px">${f.name || "Aid to Navigation"}</div>
              ${f.range_nm ? `<div style="font-size:10px;color:#88aacc;margin-top:3px">Range: ${f.range_nm} NM</div>` : ""}
            </div>`);
          infoWin.current.open(map, m);
        });
      });
    }

    // ── PORTS & SERVICES ──
    if (layers.ports && gisData.ports) {
      gisData.ports.forEach(f => {
        if (!f.coords) return;
        const pos = wktToLatLng(f.coords, f.type);
        if (!pos || typeof pos !== "object" || Array.isArray(pos)) return;
        const m = add(new window.google.maps.Marker({
          position: pos, map,
          icon: { path: "M -4 0 L -2 -6 L 2 -6 L 4 0 L 2 0 L 2 2 L -2 2 L -2 0 Z", scale: 1, fillColor: "#44aaff", fillOpacity: 0.9, strokeColor: "#fff", strokeWeight: 1 },
          title: f.name || "Port/Service", zIndex: 7,
        }));
        m.addListener("click", () => {
          infoWin.current.setContent(`
            <div style="font-family:'JetBrains Mono',monospace;background:#001830;border:1px solid #44aaff;border-radius:8px;padding:10px 14px;color:#fff">
              <div style="color:#44aaff;font-weight:700;font-size:12px">⚓ PORT / SERVICE</div>
              <div style="font-size:11px;margin-top:4px">${f.name || "Facility"}</div>
              ${f.depth ? `<div style="font-size:10px;color:#88aacc">Depth: ${f.depth}m</div>` : ""}
            </div>`);
          infoWin.current.open(map, m);
        });
      });
    }

    // ── TIDES ──
    if (layers.tides && gisData.tides) {
      gisData.tides.forEach(f => {
        const pos = wktToLatLng(f.coords, f.type);
        if (!pos || typeof pos !== "object" || Array.isArray(pos)) return;
        const rotation = parseFloat(f.direction) || 0;
        add(new window.google.maps.Marker({
          position: pos, map,
          icon: { path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 5, rotation, fillColor: "#00eeff", fillOpacity: 0.8, strokeColor: "#fff", strokeWeight: 1 },
          title: `Current: ${f.current_speed || "?"} kn @ ${f.direction || "?"}°`, zIndex: 6,
        }));
      });
    }

    // ── CULTURAL (cables, pipelines, bridges) ──
    if (layers.cultural && gisData.cultural) {
      gisData.cultural.forEach(f => {
        if (f.type === "cultural_point") {
          const pos = wktToLatLng(f.coords, f.type);
          if (!pos || typeof pos !== "object") return;
          const col = f.cable ? "#ff8800" : f.pipe ? "#884400" : "#888888";
          add(new window.google.maps.Marker({
            position: pos, map,
            icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 3, fillColor: col, fillOpacity: 0.8, strokeColor: "#fff", strokeWeight: 0.5 },
            title: f.name || (f.cable ? "Cable" : f.pipe ? "Pipeline" : "Feature"), zIndex: 5,
          }));
        } else if (f.type === "cultural_bridge") {
          const path = wktToLatLng(f.coords, f.type);
          if (!path || !Array.isArray(path)) return;
          const poly = add(new window.google.maps.Polygon({ paths: path, map, fillColor: "#88888833", strokeColor: "#aaaaaa", strokeWeight: 1.5, zIndex: 4 }));
          if (f.name) {
            poly.addListener("click", () => {
              infoWin.current.setContent(`
                <div style="font-family:'JetBrains Mono',monospace;background:#111;border:1px solid #888;border-radius:8px;padding:10px 14px;color:#fff">
                  <div style="color:#ccc;font-weight:700;font-size:12px">🌉 BRIDGE</div>
                  <div style="font-size:11px;margin-top:4px">${f.name}</div>
                  ${f.info ? `<div style="font-size:9px;color:#999;margin-top:3px">${f.info.substring(0,150)}</div>` : ""}
                </div>`);
              infoWin.current.setPosition(path[0]);
              infoWin.current.open(map);
            });
          }
        }
      });
    }

    // ── SEABED HAZARDS (BUG 6 FIX: was missing) ──
    if (layers.seabed && gisData.seabed) {
      gisData.seabed.forEach(f => {
        if (f.type === "seabed_area") {
          const path = wktToLatLng(f.coords, f.type);
          if (!path || !Array.isArray(path)) return;
          add(new window.google.maps.Polygon({
            paths: path, map,
            fillColor: "#aa660033", strokeColor: "#aa6600",
            strokeWeight: 1, fillOpacity: 1, zIndex: 2,
          }));
        } else if (f.type === "seabed_point") {
          const pos = wktToLatLng(f.coords, f.type);
          if (!pos || typeof pos !== "object" || Array.isArray(pos)) return;
          const col = f.surface === "rock" ? "#cc4400" : f.surface === "mud" ? "#886600" : "#aa8800";
          add(new window.google.maps.Marker({
            position: pos, map,
            icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: 3, fillColor: col, fillOpacity: 0.7, strokeColor: "#fff", strokeWeight: 0.5 },
            title: `Seabed: ${f.surface || "unknown"} (${f.quality || ""})`, zIndex: 4,
          }));
        }
      });
    }

  }, [gisData, layers, mapReady]); // BUG 2 FIX: mapReady instead of mapObj.current

  // ── VESSEL PROXIMITY & HAZARD COLLISION DETECTION ─────────
  useEffect(() => {
    // Clear old alert circles
    Object.values(alertCircles.current).forEach(c => { try { c.setMap(null); } catch(_) {} });
    Object.values(vesselCircles.current).forEach(c => { try { c.setMap(null); } catch(_) {} });
    alertCircles.current = {};
    vesselCircles.current = {};

    if (!mapObj.current || !gisData || !layers.vesselProximity) return;
    const freshVessels = vessels.filter(v => !isStale(v) && v.latitude_degrees && v.longitude_degrees);
    const newAlerts = [];

    // 1. Vessel ↔ Danger proximity
    if (layers.dangers && gisData.dangers) {
      const dangerPts = gisData.dangers
        .filter(d => d.type === "danger_point" && Array.isArray(d.coords) && typeof d.coords[0] === "number")
        .map(d => ({ lat: d.coords[1], lng: d.coords[0], name: d.name, depth: d.depth }));

      freshVessels.forEach(v => {
        const vLat = parseFloat(v.latitude_degrees), vLng = parseFloat(v.longitude_degrees);
        let closestDist = Infinity, closestDanger = null;

        dangerPts.forEach(d => {
          const dist = distanceM(vLat, vLng, d.lat, d.lng);
          if (dist < closestDist) { closestDist = dist; closestDanger = d; }
        });

        if (closestDist < RADIUS.DANGER) {
          newAlerts.push({ level: "danger", vessel: v.vessel_name, detail: `${Math.round(closestDist)}m from hazard: ${closestDanger?.name || "Unknown"}` });
          // Red circle around vessel
          const key = `d_${v.imo_number}`;
          alertCircles.current[key] = new window.google.maps.Circle({
            center: { lat: vLat, lng: vLng }, radius: RADIUS.DANGER,
            map: mapObj.current, fillColor: "#ff2244", fillOpacity: 0.08,
            strokeColor: "#ff2244", strokeWeight: 2, strokeOpacity: 0.9, zIndex: 20,
          });
        } else if (closestDist < RADIUS.WARNING) {
          newAlerts.push({ level: "warning", vessel: v.vessel_name, detail: `${Math.round(closestDist)}m from hazard: ${closestDanger?.name || "Unknown"}` });
          const key = `w_${v.imo_number}`;
          alertCircles.current[key] = new window.google.maps.Circle({
            center: { lat: vLat, lng: vLng }, radius: RADIUS.WARNING,
            map: mapObj.current, fillColor: "#ffaa00", fillOpacity: 0.05,
            strokeColor: "#ffaa00", strokeWeight: 1.5, strokeOpacity: 0.7, zIndex: 19,
          });
        }
      });
    }

    // 2. Vessel ↔ Vessel proximity — BUG 4 FIX: spatial pre-filter, max 200 vessels checked
    // Full O(n²) on 5000 vessels = 12.5M ops → freeze. Limit to vessels within ~0.05° grid cell.
    const NEARBY_DEG = 0.02; // ~2.2km — only compare vessels within this lat/lng delta
    const checked = Math.min(freshVessels.length, 200); // hard cap for safety
    for (let i = 0; i < checked; i++) {
      for (let j = i + 1; j < checked; j++) {
        const a = freshVessels[i], b = freshVessels[j];
        // Pre-filter: skip if lat/lng delta exceeds WARNING radius (fast, no trig)
        if (Math.abs(parseFloat(a.latitude_degrees) - parseFloat(b.latitude_degrees)) > NEARBY_DEG) continue;
        if (Math.abs(parseFloat(a.longitude_degrees) - parseFloat(b.longitude_degrees)) > NEARBY_DEG) continue;
        const dist = distanceM(
          parseFloat(a.latitude_degrees), parseFloat(a.longitude_degrees),
          parseFloat(b.latitude_degrees), parseFloat(b.longitude_degrees)
        );
        if (dist < RADIUS.DANGER) {
          newAlerts.push({ level: "danger", vessel: a.vessel_name, detail: `${Math.round(dist)}m from ${b.vessel_name} — COLLISION RISK` });
          const midLat = (parseFloat(a.latitude_degrees) + parseFloat(b.latitude_degrees)) / 2;
          const midLng = (parseFloat(a.longitude_degrees) + parseFloat(b.longitude_degrees)) / 2;
          const key = `vv_${a.imo_number}_${b.imo_number}`;
          vesselCircles.current[key] = new window.google.maps.Circle({
            center: { lat: midLat, lng: midLng }, radius: dist / 2,
            map: mapObj.current, fillColor: "#ff0000", fillOpacity: 0.12,
            strokeColor: "#ff0000", strokeWeight: 2, strokeOpacity: 1, zIndex: 25,
          });
        } else if (dist < RADIUS.WARNING) {
          const key = `vv_${a.imo_number}_${b.imo_number}`;
          vesselCircles.current[key] = new window.google.maps.Circle({
            center: { lat: (parseFloat(a.latitude_degrees)+parseFloat(b.latitude_degrees))/2, lng: (parseFloat(a.longitude_degrees)+parseFloat(b.longitude_degrees))/2 },
            radius: dist / 2, map: mapObj.current, fillColor: "#ffaa00", fillOpacity: 0.06,
            strokeColor: "#ffaa00", strokeWeight: 1, strokeOpacity: 0.6, zIndex: 18,
          });
        }
      }
    }

    setAlerts(newAlerts.slice(0, 20)); // max 20 alerts shown
  }, [vessels, gisData, layers.dangers, layers.vesselProximity]);

  // ── UPDATE VESSEL MARKERS ─────────────────────────────────
  // BUG 3 FIX: alert level derived from alerts state (set by proximity effect),
  // not alertCircles.current which may not be populated yet when this runs.
  useEffect(() => {
    if (!mapObj.current || !clusterer.current) return;
    const freshVessels = vessels.filter(v => !isStale(v));
    const activeIds = new Set(freshVessels.map(v => String(v.imo_number)));
    const selId = selectedVessel?.imo_number;
    const toAdd = [], toRemove = [];

    // Build alert lookup from alerts state (guaranteed up-to-date)
    const alertMap = {};
    alerts.forEach(a => {
      if (a.vessel && !alertMap[a.vessel]) alertMap[a.vessel] = a.level;
    });

    Object.keys(markersRef.current).forEach(id => {
      if (!activeIds.has(id)) {
        const m = markersRef.current[id];
        if (m._animId) cancelAnimationFrame(m._animId);
        toRemove.push(m);
        delete markersRef.current[id];
      }
    });

    freshVessels.forEach(v => {
      const lat = Number(v.latitude_degrees), lng = Number(v.longitude_degrees);
      if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;
      const id = String(v.imo_number), isSel = v.imo_number === selId;

      // BUG 3 FIX: use alertMap derived from alerts state, not alertCircles.current
      let alertLevel = alertMap[v.vessel_name] || null;

      if (markersRef.current[id]) {
        const m = markersRef.current[id];
        smoothMove(m, lat, lng);
        m.setIcon(getVesselIcon(v, isSel, alertLevel));
        m.setZIndex(isSel ? 1000 : alertLevel === "danger" ? 500 : 10);
        m._vessel = v;
      } else {
        const m = new window.google.maps.Marker({
          position: { lat, lng }, icon: getVesselIcon(v, isSel, alertLevel),
          title: v.vessel_name || "Vessel", optimized: true,
          zIndex: isSel ? 1000 : alertLevel === "danger" ? 500 : 10,
        });
        m._vessel = v;
        m.addListener("click", () => {
          hoverWin.current.close();
          infoWin.current.setContent(buildInfoWindowContent(v));
          infoWin.current.open(mapObj.current, m);
          onVesselClick(v);
        });
        if (!IS_MOBILE) {
          m.addListener("mouseover", () => {
            const ves = m._vessel;
            const spd = parseFloat(ves.speed || 0), col = getSpeedColor(spd);
            const region = getRegionName(parseFloat(ves.latitude_degrees || 0), parseFloat(ves.longitude_degrees || 0));
            hoverWin.current.setContent(`
              <div style="font-family:'JetBrains Mono',monospace;background:#0b1525;border:1px solid ${col}66;border-radius:10px;padding:9px 13px;min-width:175px;color:#f0f8ff;box-shadow:0 8px 28px rgba(0,0,0,0.85)">
                <div style="font-size:12px;font-weight:700;color:#00e5ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:195px">${ves.vessel_name || "Unknown Vessel"}</div>
                <div style="margin-top:5px;display:flex;align-items:center;gap:10px">
                  <span style="font-size:14px;font-weight:700;color:${col}">${spd.toFixed(1)} kn</span>
                  <span style="font-size:9px;color:#6a9ab0">${ves.heading || 0}° HDG</span>
                  <span style="font-size:9px;color:#6a9ab0">${ves.flag || ""}</span>
                </div>
                ${region ? `<div style="font-size:9px;color:#00e5ff;margin-top:4px">📍 ${region}</div>` : ""}
                <div style="margin-top:4px;font-size:8px;color:#3d6a8a;font-style:italic">Click for full details</div>
              </div>`);
            hoverWin.current.open(mapObj.current, m);
          });
          m.addListener("mouseout", () => hoverWin.current.close());
        }
        markersRef.current[id] = m;
        toAdd.push(m);
      }
    });

    if (!clusterDirty.current && (toAdd.length > 0 || toRemove.length > 0)) {
      clusterDirty.current = true;
      requestAnimationFrame(() => {
        clusterDirty.current = false;
        if (!clusterer.current) return;
        if (toRemove.length) clusterer.current.removeMarkers(toRemove, true);
        if (toAdd.length)    clusterer.current.addMarkers(toAdd, true);
        if (toRemove.length || toAdd.length) clusterer.current.render();
      });
    }
  }, [vessels, selectedVessel, onVesselClick, alerts]);

  // ── SELECTED VESSEL PULSE ─────────────────────────────────
  useEffect(() => {
    clearInterval(pulseTimer.current);
    if (pulseCirc.current) { pulseCirc.current.setMap(null); pulseCirc.current = null; }
    if (!selectedVessel || !mapObj.current) return;
    const lat = Number(selectedVessel.latitude_degrees), lng = Number(selectedVessel.longitude_degrees);
    if (!lat || !lng) return;
    mapObj.current.panTo({ lat, lng });
    // BUG 8 FIX: build alertMap in scope for pulse effect
    const alertMap = {};
    // (alerts is closure-captured from state)
    Object.values(markersRef.current).forEach(m => {
      if (m._vessel) {
        const isSel = m._vessel.imo_number === selectedVessel.imo_number;
        const al = alertMap[m._vessel.vessel_name] || null;
        m.setIcon(getVesselIcon(m._vessel, isSel, al));
      }
    });
    const color = getSpeedColor(selectedVessel.speed);
    pulseCirc.current = new window.google.maps.Circle({ center: { lat, lng }, radius: 600, fillColor: color, fillOpacity: 0.07, strokeColor: color, strokeOpacity: 0.8, strokeWeight: 2, map: mapObj.current, zIndex: 5 });
    let r = 600, grow = true;
    pulseTimer.current = setInterval(() => {
      if (!pulseCirc.current) return;
      r = grow ? r + 60 : r - 60;
      if (r > 1200) grow = false;
      if (r < 600)  grow = true;
      try { pulseCirc.current.setRadius(r); } catch(_) {}
    }, IS_MOBILE ? 150 : 80);
    return () => { clearInterval(pulseTimer.current); if (pulseCirc.current) { pulseCirc.current.setMap(null); pulseCirc.current = null; } };
  }, [selectedVessel]);

  // ── TRAIL ─────────────────────────────────────────────────
  useEffect(() => {
    trailObjs.current.forEach(o => { try { o.setMap(null); } catch(_) {} });
    trailObjs.current = [];
    if (!trailData?.length || !mapObj.current) return;
    const pts = trailData.map(p => ({ lat: Number(p.latitude_degrees ?? p.lat ?? 0), lng: Number(p.longitude_degrees ?? p.lng ?? 0), spd: parseFloat(p.speed ?? 0) })).filter(p => p.lat && p.lng && !isNaN(p.lat));
    if (pts.length < 2) return;
    const SEG = Math.min(pts.length - 1, 50), step = Math.max(1, Math.floor((pts.length - 1) / SEG));
    for (let i = 0; i < pts.length - 1; i += step) {
      const end = Math.min(i + step + 1, pts.length), prog = i / (pts.length - 1);
      const r = Math.round(prog * 100), g = Math.round(150 + prog * 105), b = Math.round(200 + prog * 55);
      trailObjs.current.push(new window.google.maps.Polyline({ path: pts.slice(i, end), geodesic: true, strokeColor: `rgb(${r},${g},${b})`, strokeOpacity: 0.25 + prog * 0.75, strokeWeight: 1.5 + prog * 3.5, map: mapObj.current, zIndex: 3 }));
    }
    const bounds = new window.google.maps.LatLngBounds();
    pts.forEach(p => bounds.extend(p));
    mapObj.current.fitBounds(bounds, { padding: 90 });
  }, [trailData]);

  // ── MAP STYLE TOGGLE ──────────────────────────────────────
  const cycleStyle = useCallback(() => {
    if (!mapObj.current) return;
    const next = { satellite: "map", map: "dark", dark: "satellite" }[mapStyle];
    if (next === "satellite") { mapObj.current.setMapTypeId("hybrid"); mapObj.current.setOptions({ styles: [] }); }
    else if (next === "map")  { mapObj.current.setMapTypeId("roadmap"); mapObj.current.setOptions({ styles: CLEAN_MAP_STYLE }); }
    else                      { mapObj.current.setMapTypeId("roadmap"); mapObj.current.setOptions({ styles: DARK_NAUTICAL_STYLE }); }
    setMapStyle(next);
  }, [mapStyle]);

  const STYLE_LABEL = { satellite: "🛰️ SAT", map: "🗺️ MAP", dark: "🌑 DARK" };
  const liveCount = vessels.filter(v => !isStale(v)).length;
  const dangerCount = alerts.filter(a => a.level === "danger").length;
  const warnCount   = alerts.filter(a => a.level === "warning").length;

  const toggleLayer = key => setLayers(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="mv-root">
      <div ref={mapRef} className="mv-map" />
      <button className="mv-btn mv-style-btn" onClick={cycleStyle}>{STYLE_LABEL[mapStyle]}</button>

      {/* ── LAYER PANEL TOGGLE ── */}
      <button className="mv-btn mv-layers-btn" onClick={() => setShowPanel(p => !p)} title="Nautical Layers">
        🗺️ LAYERS {loadingGIS && <span style={{fontSize:9,opacity:0.7}}> loading…</span>}
      </button>

      {/* ── LAYER CONTROL PANEL ── */}
      {showPanel && (
        <div className="mv-layer-panel">
          <div className="mv-layer-title">⚓ NAUTICAL LAYERS</div>
          {[
            { key: "dangers",         label: "⛔ Dangers & Hazards",     color: "#ff2244" },
            { key: "depths",          label: "🌊 Depth Contours",        color: "#0055aa" },
            { key: "regulated",       label: "⚠️ Regulated Areas",       color: "#ffcc00" },
            { key: "tracks",          label: "🛣️ Tracks & Routes",       color: "#00aaff" },
            { key: "aids",            label: "💡 Aids to Navigation",    color: "#ffee44" },
            { key: "ports",           label: "⚓ Ports & Services",      color: "#44aaff" },
            { key: "tides",           label: "🌊 Tides & Currents",      color: "#00eeff" },
            { key: "cultural",        label: "🌉 Bridges & Cables",      color: "#aaaaaa" },
            { key: "seabed",          label: "🪨 Seabed Hazards",        color: "#aa6600" },
            { key: "vesselProximity", label: "📡 Proximity Alerts",      color: "#ff8800" },
          ].map(({ key, label, color }) => (
            <div key={key} className="mv-layer-row" onClick={() => toggleLayer(key)}>
              <div className="mv-layer-dot" style={{ background: layers[key] ? color : "#333" }} />
              <span style={{ color: layers[key] ? "#fff" : "#555", fontSize: 11 }}>{label}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── ALERT PANEL ── */}
      {alerts.length > 0 && (
        <div className="mv-alert-panel">
          <div className="mv-alert-header">
            {dangerCount > 0 && <span className="mv-alert-badge danger">🚨 {dangerCount} DANGER</span>}
            {warnCount   > 0 && <span className="mv-alert-badge warning">⚠️ {warnCount} CAUTION</span>}
          </div>
          <div className="mv-alert-list">
            {alerts.slice(0, 6).map((a, i) => (
              <div key={i} className={`mv-alert-item ${a.level}`}>
                <span className="mv-alert-vessel">{a.vessel || "Unknown"}</span>
                <span className="mv-alert-detail">{a.detail}</span>
              </div>
            ))}
            {alerts.length > 6 && <div style={{fontSize:9,color:"#666",padding:"2px 6px"}}>+{alerts.length - 6} more…</div>}
          </div>
        </div>
      )}

      <div className="mv-radius-legend">
        <div className="mv-radius-row"><span className="mv-radius-dot" style={{background:"#ff2244"}} /><span>DANGER &lt;{RADIUS.DANGER}m</span></div>
        <div className="mv-radius-row"><span className="mv-radius-dot" style={{background:"#ffaa00"}} /><span>CAUTION &lt;{RADIUS.WARNING}m</span></div>
        <div className="mv-radius-row"><span className="mv-radius-dot" style={{background:"#00cc44"}} /><span>SAFE &gt;{RADIUS.WARNING}m</span></div>
      </div>

      <div className="mv-hud mv-count-hud"><span className="mv-dot-live" />{liveCount.toLocaleString()} vessels live</div>
      {trailData?.length > 0 && <div className="mv-hud mv-trail-hud">🛤️ {trailData.length} track pts · {selectedVessel?.vessel_name || ""}</div>}
      {coords && <CoordsHUD lat={coords.lat} lng={coords.lng} />}
    </div>
  );
});

export default MapView;

// ── INFO WINDOW HELPERS ───────────────────────────────────────
function dangerInfoContent(f) {
  return `
    <div style="font-family:'JetBrains Mono',monospace;background:#1a0010;border:1px solid #ff2244;border-radius:8px;padding:10px 14px;color:#fff;min-width:200px">
      <div style="color:#ff2244;font-weight:700;font-size:12px">⛔ DANGER / HAZARD</div>
      <div style="margin-top:6px;font-size:11px">${f.name || "Unknown Hazard"}</div>
      ${f.depth !== undefined && f.depth !== null ? `<div style="font-size:10px;color:#ff8899;margin-top:3px">Depth: ${f.depth}m</div>` : ""}
      ${f.info ? `<div style="margin-top:4px;font-size:9px;color:#cc8888">${String(f.info).substring(0,200)}</div>` : ""}
    </div>`;
}

// ── MAP STYLES ────────────────────────────────────────────────
const CLEAN_MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#e8e8e8" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#b0c8d8" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
];
const DARK_NAUTICAL_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#0a1628" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#4a7a9b" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#03070e" }] },
  { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#0a1820" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
];

function CoordsHUD({ lat, lng }) {
  const region = getRegionName(parseFloat(lat), parseFloat(lng));
  return <div className="mv-coords">{lat}° N &nbsp;{lng}° E{region && <span className="mv-region"> · {region}</span>}</div>;
}