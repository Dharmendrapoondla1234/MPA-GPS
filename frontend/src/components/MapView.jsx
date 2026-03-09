// src/components/MapView.jsx — FIXED v10
import React, {
  useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle,
} from "react";
import { Loader } from "@googlemaps/js-api-loader";
import { buildInfoWindowContent, getSpeedColor, getRegionName } from "../utils/vesselUtils";
import "./MapView.css";
import WeatherPanel from "./WeatherPanel";

const MAP_CENTER  = { lat: 1.35, lng: 103.82 };
const BASE_URL    = process.env.REACT_APP_API_URL || "https://vessel-backends.onrender.com/api";
let loaderPromise = null;
const RADIUS   = { DANGER: 500, WARNING: 1500 };
const STALE_MS = 48 * 60 * 60 * 1000; // match backend 48h filter
const IS_MOBILE = /Mobi|Android/i.test(navigator.userAgent);

/* ─── helpers ───────────────────────────────────────────── */
function isStale(v) {
  const ts = v.effective_timestamp;
  if (!ts) return false;
  try { return Date.now() - new Date(typeof ts === "object" && ts.value ? ts.value : ts).getTime() > STALE_MS; }
  catch { return false; }
}

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
  if (IS_MOBILE || (Math.abs(dLat) < 0.00005 && Math.abs(dLng) < 0.00005)) {
    marker.setPosition({ lat: newLat, lng: newLng }); return;
  }
  if (marker._animId) cancelAnimationFrame(marker._animId);
  const ms = 1200, t0 = performance.now(), lat0 = from.lat(), lng0 = from.lng();
  const step = now => {
    const p = Math.min((now - t0) / ms, 1), e = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
    marker.setPosition({ lat: lat0 + dLat * e, lng: lng0 + dLng * e });
    if (p < 1) marker._animId = requestAnimationFrame(step);
    else marker._animId = null;
  };
  marker._animId = requestAnimationFrame(step);
}

/* ─── ZOOM-ADAPTIVE VESSEL ICON ──────────────────────────
   KEY FIXES vs broken version:
   1. scale grows at low zoom so vessels are VISIBLE on the world map
   2. stopped vessels use CYAN (#00e5ff) not grey — grey is invisible on
      the dark #071828 nautical background
   3. zoom param comes from mapZoomRef so icons always reflect current zoom
────────────────────────────────────────────────────────── */
function getVesselIcon(vessel, isSelected, alertLevel = null, zoom = 5) {
  const speed   = parseFloat(vessel.speed)   || 0;
  const heading = parseFloat(vessel.heading) || 0;

  // Stale if not updated in last 32h
  const minsAgo = vessel.minutes_since_last_ping != null
    ? Math.abs(Number(vessel.minutes_since_last_ping))
    : 0;
  const isStale = vessel.is_stale || minsAgo > 1920; // >32h

  // Scale up at low zoom levels
  const zs = zoom <= 3 ? 4.0
           : zoom <= 4 ? 3.0
           : zoom <= 5 ? 2.2
           : zoom <= 6 ? 1.7
           : zoom <= 7 ? 1.35
           : zoom <= 8 ? 1.15
           : 1.0;

  // Colour: alert overrides > speed colour. Stopped = BRIGHT CYAN.
  const color = alertLevel === "danger"  ? "#ff2244"
              : alertLevel === "warning" ? "#ffcc00"
              : speed > 0.3 ? getSpeedColor(speed)
              : "#00e5ff";

  const opacity = isStale ? 0.35 : 1.0;  // dim stale vessels

  if (speed > 0.3) {
    const base = isSelected ? 12 : alertLevel ? 9 : 8;
    return {
      path:         window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale:        base * zs,
      rotation:     heading,
      fillColor:    color,
      fillOpacity:  opacity,
      strokeColor:  isSelected ? "#ffffff" : "#000000",
      strokeWeight: isSelected ? 2.5 : 0.8,
      anchor:       new window.google.maps.Point(0, 2.5),
    };
  }
  const base = isSelected ? 7 : 5;
  return {
    path:         window.google.maps.SymbolPath.CIRCLE,
    scale:        base * zs,
    fillColor:    color,
    fillOpacity:  isStale ? 0.3 : (isSelected ? 1 : 0.92),
    strokeColor:  isSelected ? "#ffffff" : "#000000",
    strokeWeight: isSelected ? 2.5 : 0.8,
  };
}

/* ─── GIS coordinate helpers ────────────────────────────── */
function wktToLatLng(coords, type) {
  if (!coords) return null;
  const pointTypes = ["danger_point","seabed_point","tide_point","aid_nav","port_service","cultural_point"];
  const lineTypes  = ["depth_contour","danger_line","track_line"];
  const areaTypes  = ["danger_area","regulated_area","track_area","seabed_area","cultural_bridge"];
  if (pointTypes.includes(type)) return Array.isArray(coords) && typeof coords[0] === "number" ? { lat: coords[1], lng: coords[0] } : null;
  if (lineTypes.includes(type))  return Array.isArray(coords) && Array.isArray(coords[0]) ? coords.map(c => ({ lat: c[1], lng: c[0] })) : null;
  if (areaTypes.includes(type))  { const ring = Array.isArray(coords[0]) && Array.isArray(coords[0][0]) ? coords[0] : coords; return Array.isArray(ring) ? ring.map(c => ({ lat: c[1], lng: c[0] })) : null; }
  return null;
}

/* ─── AI Catmull-Rom spline interpolation ───────────────── */
function catmullRom(p0, p1, p2, p3, t) {
  return 0.5 * ((2*p1) + (-p0+p2)*t + (2*p0-5*p1+4*p2-p3)*t*t + (-p0+3*p1-3*p2+p3)*t*t*t);
}
function lerpAngle(a, b, t) {
  let d = b - a; while (d > 180) d -= 360; while (d < -180) d += 360; return a + d * t;
}
function interpolateTrajectory(points, gapThresholdMinutes = 30) {
  if (!points || points.length < 2) return points;
  const result = [];
  for (let i = 0; i < points.length - 1; i++) {
    result.push({ ...points[i], ai_interpolated: false });
    const t1 = new Date(points[i].effective_timestamp).getTime();
    const t2 = new Date(points[i+1].effective_timestamp).getTime();
    const gapMin = (t2 - t1) / 60000;
    if (gapMin > gapThresholdMinutes && gapMin < 360) {
      const steps = Math.min(Math.floor(gapMin / 8), 25);
      const p0 = points[Math.max(0,i-1)], p1 = points[i], p2 = points[i+1], p3 = points[Math.min(points.length-1,i+2)];
      for (let s = 1; s <= steps; s++) {
        const t = s / (steps + 1);
        result.push({
          latitude_degrees:  catmullRom(+p0.latitude_degrees,  +p1.latitude_degrees,  +p2.latitude_degrees,  +p3.latitude_degrees,  t),
          longitude_degrees: catmullRom(+p0.longitude_degrees, +p1.longitude_degrees, +p2.longitude_degrees, +p3.longitude_degrees, t),
          speed:   +p1.speed + (+p2.speed - +p1.speed) * t,
          heading: lerpAngle(+(p1.heading||0), +(p2.heading||0), t),
          effective_timestamp: new Date(t1 + (t2 - t1) * t).toISOString(),
          ai_interpolated: true,
          confidence: Math.max(0.25, 1 - gapMin / 360),
          gap_minutes: gapMin,
        });
      }
    }
  }
  result.push({ ...points[points.length-1], ai_interpolated: false });
  return result;
}

/* ══════════════════════════════════════════════════════════
   COMPONENT
══════════════════════════════════════════════════════════ */
const MapView = forwardRef(function MapView(
  { vessels, selectedVessel, onVesselClick, trailData, predictRoute }, ref
) {
  const mapRef        = useRef(null);
  const mapObj        = useRef(null);
  const markersRef    = useRef({});
  const infoWin       = useRef(null);
  const hoverWin      = useRef(null);
  const trailObjs     = useRef([]);
  const gisObjs       = useRef([]);
  const alertCircles  = useRef({});
  const vesselCircles = useRef({});
  const pulseCirc     = useRef(null);
  const pulseTimer    = useRef(null);
  const aiObjs        = useRef([]);
  const predRouteObjs  = useRef([]);
  const weatherObjs    = useRef([]);
  const mapZoomRef     = useRef(4);   // ← live zoom without re-render lag
  const hasFitBounds   = useRef(false); // auto-fit on first vessel load
  // Hover perf: cache pre-built tooltip HTML per IMO, throttle open calls
  const hoverCache    = useRef({});    // imo_number -> html string
  const hoverTimer    = useRef(null);  // debounce timer for mouseover
  const hoverOpenImo  = useRef(null);  // currently displayed hover IMO

  const [coords,         setCoords]         = useState(null);
  const [mapStyle,       setMapStyle]       = useState("satellite");
  const [mapReady,       setMapReady]       = useState(false);
  const [mapZoom,        setMapZoom]        = useState(4);       // triggers icon redraw
  const [gisData,        setGisData]        = useState(null);
  const [alerts,         setAlerts]         = useState([]);
  const [showLayerPanel, setShowLayerPanel] = useState(false);
  const [showAlerts,     setShowAlerts]     = useState(true);
  const [showAllAlerts,  setShowAllAlerts]  = useState(false);
  const [loadingGIS,     setLoadingGIS]     = useState(true);
  const [aiStats,        setAiStats]        = useState(null);
  const [weatherData,    setWeatherData]    = useState(null);
  const [layers, setLayers] = useState({
    dangers: true, depths: true, regulated: true, tracks: true,
    aids: true, seabed: false, ports: true, tides: false, cultural: true,
    vesselProximity: false,   // off by default — expensive + noisy in port
    aiTrajectory: true,
    weatherStations: true,
  });

  useImperativeHandle(ref, () => ({
    panToVessel(vessel) {
      const lat = Number(vessel?.latitude_degrees), lng = Number(vessel?.longitude_degrees);
      if (mapObj.current && lat && lng) { mapObj.current.panTo({ lat, lng }); mapObj.current.setZoom(12); }
    },
    // Called by App whenever the right detail panel opens or closes.
    triggerResize() {
      if (!mapObj.current) return;
      const centre = mapObj.current.getCenter();
      if (!centre) return;
      window.google.maps.event.trigger(mapObj.current, "resize");
      mapObj.current.setCenter(centre);
    },
  }));

  /* ── Weather data (for station markers on map) ─────────── */
  useEffect(() => {
    const fetchW = () => {
      fetch(`${BASE_URL}/weather`)
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j?.data) setWeatherData(j.data); })
        .catch(() => {});
    };
    fetchW();
    const t = setInterval(fetchW, 3 * 60 * 1000);  // 3 min
    return () => clearInterval(t);
  }, []);

  /* ── GIS data ─────────────────────────────────────────── */
  useEffect(() => {
    fetch(`${BASE_URL}/gis/all`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { if (j?.data) setGisData(j.data); })
      .catch(e => console.warn("[GIS]", e.message))
      .finally(() => setLoadingGIS(false));
  }, []);

  /* ── Memoised derived data ────────────────────────────── */
  const freshVessels = useMemo(() =>
    vessels.filter(v => {
      if (isStale(v)) return false;
      const lat = parseFloat(v.latitude_degrees), lng = parseFloat(v.longitude_degrees);
      return !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0;
    }),
  [vessels]);

  const alertMap = useMemo(() => {
    const m = {};
    alerts.forEach(a => { if (a.vessel && !m[a.vessel]) m[a.vessel] = a.level; });
    return m;
  }, [alerts]);

  /* ── Map initialisation ───────────────────────────────── */
  useEffect(() => {
    if (mapObj.current) return;
    if (!loaderPromise) {
      loaderPromise = new Loader({
        apiKey: process.env.REACT_APP_GOOGLE_MAPS_KEY || "",
        version: "weekly",
        libraries: ["geometry"],
      }).load();
    }
    loaderPromise.then(() => {
      if (mapObj.current) return;
      const map = new window.google.maps.Map(mapRef.current, {
        center: MAP_CENTER,
        zoom: 4,                         // wide overview
        mapTypeId: "hybrid",
        styles: [],                      // satellite hybrid from first paint
        zoomControl: false, streetViewControl: false, mapTypeControl: false,
        fullscreenControl: false, rotateControl: false,
        gestureHandling: "greedy", clickableIcons: false,
      });
      mapObj.current  = map;
      infoWin.current  = new window.google.maps.InfoWindow({ maxWidth: 340 });
      hoverWin.current = new window.google.maps.InfoWindow({ maxWidth: 240, disableAutoPan: true });

      // Throttle mousemove coords update to max 10fps to avoid React re-render storm
      let _mvTimer = null;
      map.addListener("mousemove", e => {
        if (_mvTimer) return;
        _mvTimer = setTimeout(() => {
          _mvTimer = null;
          setCoords({ lat: e.latLng.lat().toFixed(5), lng: e.latLng.lng().toFixed(5) });
        }, 100);
      });
      map.addListener("click", () => {
        infoWin.current.close();
        hoverWin.current.close();
        setShowLayerPanel(false);
        // NOTE: do NOT call setShowAlerts(false) here — alert panel
        // should only close via its own × button, not random map clicks
      });

      /* ── CRITICAL: zoom_changed ───────────────────────────
         Without this listener icon sizes never update when the user
         zooms in/out, so vessels stay invisible at the initial zoom.
      ───────────────────────────────────────────────────── */
      map.addListener("zoom_changed", () => {
        const z = map.getZoom() ?? 4;
        mapZoomRef.current = z;
        setMapZoom(z);                   // triggers marker useEffect
      });

      setMapReady(true);

      // ResizeObserver fires whenever the map container changes size
      // (e.g. detail panel slides in/out). Triggers Google Maps resize
      // so markers don't pile up at the old center point.
      // IMPORTANT: skip the first few fires that happen during initial
      // layout — map.getCenter() returns null/0,0 before tiles load.
      if (typeof ResizeObserver !== "undefined" && mapRef.current) {
        let resizeReady = false;
        // Only start responding to resizes after map has fully initialised
        window.google.maps.event.addListenerOnce(map, "tilesloaded", () => {
          resizeReady = true;
        });
        const ro = new ResizeObserver(() => {
          if (!mapObj.current || !resizeReady) return;
          const c = mapObj.current.getCenter();
          if (!c) return;
          window.google.maps.event.trigger(mapObj.current, "resize");
          mapObj.current.setCenter(c);
        });
        ro.observe(mapRef.current);
      }
    });
  }, []);

  /* ── GIS layers ───────────────────────────────────────── */
  useEffect(() => {
    if (!mapReady || !mapObj.current || !gisData) return;
    gisObjs.current.forEach(o => { try { o.setMap(null); } catch(_) {} });
    gisObjs.current = [];
    const map = mapObj.current;
    const add = o => { gisObjs.current.push(o); return o; };

    if (layers.regulated && gisData.regulated) gisData.regulated.forEach(f => { const p = wktToLatLng(f.coords,f.type); if(!p||!Array.isArray(p))return; add(new window.google.maps.Polygon({paths:p,map,fillColor:"#ffcc0020",strokeColor:"#ffcc00",strokeWeight:1.5,strokeOpacity:0.9,fillOpacity:1,zIndex:2,clickable:true})).addListener("click",()=>{infoWin.current.setContent(`<div style="font-family:'JetBrains Mono',monospace;background:#1a1200;border:1px solid #ffcc00;border-radius:8px;padding:10px 14px;color:#fff"><div style="color:#ffcc00;font-weight:700;font-size:12px">⚠️ REGULATED AREA</div><div style="margin-top:6px;font-size:11px">${f.name||"Restricted Zone"}</div></div>`);infoWin.current.setPosition(p[0]);infoWin.current.open(map);}); });
    if (layers.tracks && gisData.tracks) gisData.tracks.forEach(f => { if(f.type==="track_area"){const p=wktToLatLng(f.coords,f.type);if(!p)return;add(new window.google.maps.Polygon({paths:p,map,fillColor:"#00aaff12",strokeColor:"#00aaff88",strokeWeight:1,fillOpacity:1,zIndex:1}));}else if(f.type==="track_line"){const p=wktToLatLng(f.coords,f.type);if(!p)return;add(new window.google.maps.Polyline({path:p,map,strokeColor:"#0088ffaa",strokeWeight:1.5,strokeOpacity:0.8,zIndex:3,icons:[{icon:{path:window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,scale:2,fillColor:"#0088ff",fillOpacity:0.7,strokeColor:"#fff",strokeWeight:0.5},offset:"50%",repeat:"80px"}]}));} });
    if (layers.depths && gisData.depths) gisData.depths.forEach(f => { const p=wktToLatLng(f.coords,f.type);if(!p)return;const depth=parseFloat(f.depth)||0;const c=depth<=5?"#ff440088":depth<=10?"#ff880055":depth<=20?"#ffcc0044":"#0055aa44";add(new window.google.maps.Polyline({path:p,map,strokeColor:c,strokeWeight:depth<=5?2:1,zIndex:1})); });
    if (layers.dangers && gisData.dangers) gisData.dangers.forEach(f => { if(f.type==="danger_point"){const pos=wktToLatLng(f.coords,f.type);if(!pos)return;const m=add(new window.google.maps.Marker({position:pos,map,icon:{path:window.google.maps.SymbolPath.CIRCLE,scale:6,fillColor:"#ff2244",fillOpacity:0.9,strokeColor:"#fff",strokeWeight:1.5},title:f.name||"Danger",zIndex:10}));m.addListener("click",()=>{infoWin.current.setContent(dangerInfoContent(f));infoWin.current.open(map,m);});add(new window.google.maps.Circle({center:pos,radius:80,map,fillColor:"#ff2244",fillOpacity:0.15,strokeColor:"#ff2244",strokeWeight:1,strokeOpacity:0.6,zIndex:4}));}else if(f.type==="danger_area"){const p=wktToLatLng(f.coords,f.type);if(!p)return;add(new window.google.maps.Polygon({paths:p,map,fillColor:"#ff224433",strokeColor:"#ff2244",strokeWeight:2,fillOpacity:1,zIndex:5,clickable:true})).addListener("click",()=>{infoWin.current.setContent(dangerInfoContent(f));infoWin.current.setPosition(p[0]);infoWin.current.open(map);});}else if(f.type==="danger_line"){const p=wktToLatLng(f.coords,f.type);if(!p)return;add(new window.google.maps.Polyline({path:p,map,strokeColor:"#ff4466",strokeWeight:2.5,zIndex:6}));} });
    if (layers.aids && gisData.aids) gisData.aids.forEach(f => { if(!f.coords||isNaN(f.coords[0]))return;const pos={lat:f.coords[1],lng:f.coords[0]};const c=f.colour==="1"?"#ff2244":f.colour==="3"?"#00cc44":f.lighted?"#ffee00":"#cccccc";const m=add(new window.google.maps.Marker({position:pos,map,icon:{path:f.lighted?"M -2 -8 L 0 -10 L 2 -8 L 1 -8 L 1 0 L -1 0 L -1 -8 Z":window.google.maps.SymbolPath.CIRCLE,scale:f.lighted?1:4,fillColor:c,fillOpacity:0.9,strokeColor:"#000",strokeWeight:1},title:f.name||"Aid",zIndex:8}));if(f.lighted&&f.range_nm>0)add(new window.google.maps.Circle({center:pos,radius:f.range_nm*1852,map,fillColor:c+"08",strokeColor:c+"30",strokeWeight:0.5,zIndex:1}));m.addListener("click",()=>{infoWin.current.setContent(`<div style="font-family:'JetBrains Mono',monospace;background:#061020;border:1px solid ${c};border-radius:8px;padding:10px 14px;color:#fff"><div style="color:${c};font-weight:700;font-size:12px">${f.lighted?"💡":"🔘"} ${f.buoy?"BUOY":"BEACON"}</div><div style="margin-top:4px;font-size:11px">${f.name||"Aid"}</div></div>`);infoWin.current.open(map,m);}); });
    if (layers.ports && gisData.ports) gisData.ports.forEach(f => { if(!f.coords)return;const pos=wktToLatLng(f.coords,f.type);if(!pos||typeof pos!=="object"||Array.isArray(pos))return;const m=add(new window.google.maps.Marker({position:pos,map,icon:{path:"M -4 0 L -2 -6 L 2 -6 L 4 0 L 2 0 L 2 2 L -2 2 L -2 0 Z",scale:1,fillColor:"#44aaff",fillOpacity:0.9,strokeColor:"#fff",strokeWeight:1},title:f.name||"Port",zIndex:7}));m.addListener("click",()=>{infoWin.current.setContent(`<div style="font-family:'JetBrains Mono',monospace;background:#001830;border:1px solid #44aaff;border-radius:8px;padding:10px 14px;color:#fff"><div style="color:#44aaff;font-weight:700;font-size:12px">⚓ PORT / SERVICE</div><div style="font-size:11px;margin-top:4px">${f.name||"Facility"}</div>${f.depth?`<div style="font-size:10px;color:#88aacc">Depth: ${f.depth}m</div>`:""}</div>`);infoWin.current.open(map,m);}); });
    if (layers.tides && gisData.tides) gisData.tides.forEach(f => { const pos=wktToLatLng(f.coords,f.type);if(!pos||typeof pos!=="object"||Array.isArray(pos))return;add(new window.google.maps.Marker({position:pos,map,icon:{path:window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,scale:5,rotation:parseFloat(f.direction)||0,fillColor:"#00eeff",fillOpacity:0.8,strokeColor:"#fff",strokeWeight:1},title:`${f.current_speed||"?"}kn`,zIndex:6})); });
    if (layers.cultural && gisData.cultural) gisData.cultural.forEach(f => { if(f.type==="cultural_point"){const pos=wktToLatLng(f.coords,f.type);if(!pos||typeof pos!=="object")return;const c=f.cable?"#ff8800":f.pipe?"#884400":"#888888";add(new window.google.maps.Marker({position:pos,map,icon:{path:window.google.maps.SymbolPath.CIRCLE,scale:3,fillColor:c,fillOpacity:0.8,strokeColor:"#fff",strokeWeight:0.5},zIndex:5}));}else if(f.type==="cultural_bridge"){const p=wktToLatLng(f.coords,f.type);if(!p)return;add(new window.google.maps.Polygon({paths:p,map,fillColor:"#88888833",strokeColor:"#aaaaaa",strokeWeight:1.5,zIndex:4}));} });
    if (layers.seabed && gisData.seabed) gisData.seabed.forEach(f => { if(f.type==="seabed_area"){const p=wktToLatLng(f.coords,f.type);if(!p)return;add(new window.google.maps.Polygon({paths:p,map,fillColor:"#aa660033",strokeColor:"#aa6600",strokeWeight:1,fillOpacity:1,zIndex:2}));}else if(f.type==="seabed_point"){const pos=wktToLatLng(f.coords,f.type);if(!pos||typeof pos!=="object"||Array.isArray(pos))return;const c=f.surface==="rock"?"#cc4400":f.surface==="mud"?"#886600":"#aa8800";add(new window.google.maps.Marker({position:pos,map,icon:{path:window.google.maps.SymbolPath.CIRCLE,scale:3,fillColor:c,fillOpacity:0.7,strokeColor:"#fff",strokeWeight:0.5},zIndex:4}));} });
  }, [gisData, layers, mapReady]);

  /* ── Proximity alerts ─────────────────────────────────── */
  useEffect(() => {
    Object.values(alertCircles.current).forEach(c => { try{c.setMap(null);}catch(_){} });
    Object.values(vesselCircles.current).forEach(c => { try{c.setMap(null);}catch(_){} });
    alertCircles.current = {}; vesselCircles.current = {};
    if (!mapObj.current || !layers.vesselProximity) { setAlerts([]); return; }
    const fresh = freshVessels;
    const newAlerts = [];

    if (gisData && layers.dangers && gisData.dangers) {
      const pts = gisData.dangers.filter(d => d.type==="danger_point" && Array.isArray(d.coords) && typeof d.coords[0]==="number").map(d => ({ lat:d.coords[1], lng:d.coords[0], name:d.name }));
      fresh.forEach(v => {
        const vl=parseFloat(v.latitude_degrees), vg=parseFloat(v.longitude_degrees);
        let cd=Infinity, cn=null;
        pts.forEach(dp => { const dist=distanceM(vl,vg,dp.lat,dp.lng); if(dist<cd){cd=dist;cn=dp;} });
        if (cd<RADIUS.DANGER) { newAlerts.push({level:"danger",vessel:v.vessel_name,imo:v.imo_number,lat:vl,lng:vg,detail:`${Math.round(cd)}m from ${cn?.name||"hazard"}`}); alertCircles.current[`d_${v.imo_number}`]=new window.google.maps.Circle({center:{lat:vl,lng:vg},radius:RADIUS.DANGER,map:mapObj.current,fillColor:"#ff2244",fillOpacity:0.08,strokeColor:"#ff2244",strokeWeight:2,strokeOpacity:0.9,zIndex:20}); }
        else if (cd<RADIUS.WARNING) { newAlerts.push({level:"warning",vessel:v.vessel_name,imo:v.imo_number,lat:vl,lng:vg,detail:`${Math.round(cd)}m from ${cn?.name||"hazard"}`}); alertCircles.current[`w_${v.imo_number}`]=new window.google.maps.Circle({center:{lat:vl,lng:vg},radius:RADIUS.WARNING,map:mapObj.current,fillColor:"#ffaa00",fillOpacity:0.05,strokeColor:"#ffaa00",strokeWeight:1.5,strokeOpacity:0.7,zIndex:19}); }
      });
    }

    // Only MOVING vessels for vessel-vessel collision (speed > 1 kn), capped at 80
    const moving = fresh.filter(v => parseFloat(v.speed || 0) > 1.0);
    const NEAR = 0.015, cap = Math.min(moving.length, 80);
    for (let i = 0; i < cap; i++) for (let j = i+1; j < cap; j++) {
      const a=moving[i], b=moving[j];
      if (!a.imo_number||!b.imo_number||a.imo_number===b.imo_number) continue;
      if (Math.abs(+a.latitude_degrees - +b.latitude_degrees) > NEAR) continue;
      if (Math.abs(+a.longitude_degrees - +b.longitude_degrees) > NEAR) continue;
      const dist=distanceM(+a.latitude_degrees,+a.longitude_degrees,+b.latitude_degrees,+b.longitude_degrees);
      if (dist < RADIUS.DANGER) {
        newAlerts.push({level:"danger",vessel:a.vessel_name,imo:a.imo_number,lat:+a.latitude_degrees,lng:+a.longitude_degrees,otherVessel:b.vessel_name,detail:`${Math.round(dist)}m from ${b.vessel_name} — COLLISION RISK`});
        const ml=(+a.latitude_degrees + +b.latitude_degrees)/2, mg=(+a.longitude_degrees + +b.longitude_degrees)/2;
        vesselCircles.current[`vv_${a.imo_number}_${b.imo_number}`]=new window.google.maps.Circle({center:{lat:ml,lng:mg},radius:Math.max(dist/2,50),map:mapObj.current,fillColor:"#ff0000",fillOpacity:0.12,strokeColor:"#ff0000",strokeWeight:2,strokeOpacity:1,zIndex:25});
      } else if (dist < RADIUS.WARNING) {
        newAlerts.push({level:"warning",vessel:a.vessel_name,imo:a.imo_number,lat:+a.latitude_degrees,lng:+a.longitude_degrees,otherVessel:b.vessel_name,detail:`${Math.round(dist)}m from ${b.vessel_name}`});
      }
    }
    setAlerts(newAlerts.slice(0, 20));
  }, [freshVessels, gisData, layers.dangers, layers.vesselProximity]);

  /* ── Markers ──────────────────────────────────────────────
     NOTE: mapZoom is in deps so icons get redrawn on every zoom change.
     We use mapZoomRef (not mapZoom) inside the function to avoid
     the stale-closure issue while still triggering via mapZoom.
  ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!mapReady || !mapObj.current) return;
    const fresh    = freshVessels;
    // Rebuild hover content cache for all active vessels (fast: no DOM, pure string)
    const newHoverCache = {};
    fresh.forEach(v => {
      const spd = parseFloat(v.speed || 0);
      const col = getSpeedColor(spd);
      const region = getRegionName(parseFloat(v.latitude_degrees || 0), parseFloat(v.longitude_degrees || 0));
      newHoverCache[v.imo_number] = `<div style="font-family:'JetBrains Mono',monospace;background:#0b1525;border:1px solid ${col}66;border-radius:10px;padding:9px 13px;min-width:175px;color:#f0f8ff;box-shadow:0 8px 28px rgba(0,0,0,0.85)"><div style="font-size:12px;font-weight:700;color:#00e5ff">${v.vessel_name || 'Unknown'}</div><div style="margin-top:5px;display:flex;align-items:center;gap:10px"><span style="font-size:14px;font-weight:700;color:${col}">${spd.toFixed(1)} kn</span><span style="font-size:9px;color:#6a9ab0">${v.heading || 0}° HDG</span></div>${region ? `<div style="font-size:9px;color:#00e5ff;margin-top:4px">📍 ${region}</div>` : ''}<div style="margin-top:4px;font-size:8px;color:#3d6a8a;font-style:italic">Click for details</div></div>`;
    });
    hoverCache.current = newHoverCache;
    const activeIds = new Set(fresh.map(v => String(v.imo_number)));
    const selId     = selectedVessel?.imo_number;

    // Remove stale markers
    Object.keys(markersRef.current).forEach(id => {
      if (!activeIds.has(id)) {
        const m = markersRef.current[id];
        if (m._animId) cancelAnimationFrame(m._animId);
        m.setMap(null);
        delete markersRef.current[id];
      }
    });

    // Auto-fit map to vessel positions on first data load
    if (!hasFitBounds.current && fresh.length > 0 && mapObj.current) {
      hasFitBounds.current = true;
      const bounds = new window.google.maps.LatLngBounds();
      fresh.slice(0, 200).forEach(v => {
        const la = Number(v.latitude_degrees), lo = Number(v.longitude_degrees);
        if (la && lo && !isNaN(la) && !isNaN(lo)) bounds.extend({ lat: la, lng: lo });
      });
      if (!bounds.isEmpty()) {
        mapObj.current.fitBounds(bounds, { padding: 60 });
      }
    }

    // Add/update markers
    fresh.forEach(v => {
      const lat = Number(v.latitude_degrees), lng = Number(v.longitude_degrees);
      if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;
      const id = String(v.imo_number), isSel = v.imo_number === selId;
      const al = alertMap[v.vessel_name] || null;
      const icon = getVesselIcon(v, isSel, al, mapZoomRef.current);

      if (markersRef.current[id]) {
        const m = markersRef.current[id];
        smoothMove(m, lat, lng);
        m.setIcon(icon);
        m.setZIndex(isSel ? 1000 : al === "danger" ? 500 : 10);
        m._vessel = v; // hoverCache already rebuilt above for all vessels
      } else {
        const m = new window.google.maps.Marker({
          position: { lat, lng },
          icon,
          title: v.vessel_name || "Vessel",
          optimized: true,
          zIndex: isSel ? 1000 : al === "danger" ? 500 : 10,
          map: mapObj.current,
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
            // Throttle: only open if not already showing this vessel, debounce 80ms
            const imo = m._vessel?.imo_number;
            if (hoverOpenImo.current === imo) return;
            clearTimeout(hoverTimer.current);
            hoverTimer.current = setTimeout(() => {
              if (!m.getMap()) return; // marker may have been removed
              const html = hoverCache.current[imo];
              if (!html) return;
              hoverWin.current.setContent(html);
              hoverWin.current.open(mapObj.current, m);
              hoverOpenImo.current = imo;
            }, 80);
          });
          m.addListener("mouseout", () => {
            clearTimeout(hoverTimer.current);
            hoverTimer.current = null;
            hoverOpenImo.current = null;
            hoverWin.current.close();
          });
        }
        markersRef.current[id] = m;
      }
    });
  }, [freshVessels, selectedVessel, onVesselClick, alertMap, mapReady, mapZoom]);
  //                                                                       ↑ mapZoom triggers icon resize on zoom change

  /* ── Pulse ring for selected vessel ──────────────────── */
  useEffect(() => {
    clearInterval(pulseTimer.current);
    if (pulseCirc.current) { pulseCirc.current.setMap(null); pulseCirc.current = null; }
    if (!selectedVessel || !mapObj.current) return;
    const lat=Number(selectedVessel.latitude_degrees), lng=Number(selectedVessel.longitude_degrees);
    if (!lat||!lng) return;
    mapObj.current.panTo({ lat, lng });
    Object.values(markersRef.current).forEach(m => {
      if (m._vessel) m.setIcon(getVesselIcon(m._vessel, m._vessel.imo_number===selectedVessel.imo_number, null, mapZoomRef.current));
    });
    const color = getSpeedColor(selectedVessel.speed);
    pulseCirc.current = new window.google.maps.Circle({ center:{lat,lng}, radius:600, fillColor:color, fillOpacity:0.07, strokeColor:color, strokeOpacity:0.8, strokeWeight:2, map:mapObj.current, zIndex:5 });
    let r=600, grow=true;
    pulseTimer.current = setInterval(() => {
      if (!pulseCirc.current) return;
      r = grow ? r + 60 : r - 60;
      if (r > 1200) grow = false;
      if (r < 600)  grow = true;
      try { pulseCirc.current.setRadius(r); } catch(_) {}
    }, IS_MOBILE ? 150 : 80);
    return () => { clearInterval(pulseTimer.current); if (pulseCirc.current) { pulseCirc.current.setMap(null); pulseCirc.current = null; } };
  }, [selectedVessel]);

  /* ── Trail + AI trajectory ────────────────────────────── */
  useEffect(() => {
    trailObjs.current.forEach(o => { try{o.setMap(null);}catch(_){} });
    aiObjs.current.forEach(o => { try{o.setMap(null);}catch(_){} });
    trailObjs.current = []; aiObjs.current = []; setAiStats(null);
    if (!trailData?.length || !mapObj.current) return;
    const raw = trailData.map(p => ({
      latitude_degrees:  Number(p.latitude_degrees ?? p.lat ?? 0),
      longitude_degrees: Number(p.longitude_degrees ?? p.lng ?? 0),
      speed:   parseFloat(p.speed ?? 0),
      heading: parseFloat(p.heading ?? 0),
      effective_timestamp: p.effective_timestamp,
    })).filter(p => p.latitude_degrees && p.longitude_degrees && !isNaN(p.latitude_degrees));
    if (raw.length < 2) return;

    let pts = raw, aiCount = 0;
    if (layers.aiTrajectory) {
      pts = interpolateTrajectory(raw, 30);
      aiCount = pts.filter(p => p.ai_interpolated).length;
      if (aiCount > 0) setAiStats({ total: pts.length, interpolated: aiCount, original: raw.length });
    }

    const SEG=Math.min(raw.length-1,50), step=Math.max(1,Math.floor((raw.length-1)/SEG));
    for (let i=0; i<raw.length-1; i+=step) {
      const end=Math.min(i+step+1,raw.length), prog=i/(raw.length-1);
      const r=Math.round(prog*100), g=Math.round(150+prog*105), b=Math.round(200+prog*55);
      trailObjs.current.push(new window.google.maps.Polyline({path:raw.slice(i,end).map(p=>({lat:p.latitude_degrees,lng:p.longitude_degrees})),geodesic:true,strokeColor:`rgb(${r},${g},${b})`,strokeOpacity:0.35+prog*0.55,strokeWeight:1+prog*2,map:mapObj.current,zIndex:3}));
    }

    if (layers.aiTrajectory && aiCount > 0) {
      let start = null;
      for (let i=0; i<pts.length; i++) {
        if (pts[i].ai_interpolated) { if (start===null) start = i>0?i-1:i; }
        else { if (start!==null) { const seg=pts.slice(start,i+1).map(p=>({lat:p.latitude_degrees,lng:p.longitude_degrees}));const conf=pts[Math.floor((start+i)/2)].confidence||0.5;aiObjs.current.push(new window.google.maps.Polyline({path:seg,geodesic:true,strokeColor:"#7cdcff",strokeOpacity:0,strokeWeight:0,zIndex:4,map:mapObj.current,icons:[{icon:{path:"M 0,-1 0,1",strokeOpacity:conf*0.85,strokeColor:"#7cdcff",scale:3},offset:"0",repeat:"12px"}]}));start=null;} }
      }
      for (let i=1; i<raw.length; i++) {
        const t1=new Date(raw[i-1].effective_timestamp).getTime(), t2=new Date(raw[i].effective_timestamp).getTime();
        const gapMin=(t2-t1)/60000;
        if (gapMin>30 && gapMin<360) {
          const ml=(raw[i-1].latitude_degrees+raw[i].latitude_degrees)/2, mg=(raw[i-1].longitude_degrees+raw[i].longitude_degrees)/2;
          const m=new window.google.maps.Marker({position:{lat:ml,lng:mg},map:mapObj.current,icon:{path:window.google.maps.SymbolPath.CIRCLE,scale:5,fillColor:"#7cdcff",fillOpacity:0.85,strokeColor:"#fff",strokeWeight:1.5},title:`AI gap: ${Math.round(gapMin)}min`,zIndex:10});
          m.addListener("click",()=>{infoWin.current.setContent(`<div style="font-family:'JetBrains Mono',monospace;background:#061828;border:1px solid #7cdcff;border-radius:10px;padding:12px 15px;color:#fff;max-width:260px"><div style="color:#7cdcff;font-weight:700;font-size:12px;margin-bottom:8px">🤖 AI TRAJECTORY RECONSTRUCTION</div><div style="font-size:11px;color:#cde">AIS data gap: <b style="color:#7cdcff">${Math.round(gapMin)} min</b></div></div>`);infoWin.current.setPosition({lat:ml,lng:mg});infoWin.current.open(mapObj.current);});
          aiObjs.current.push(m);
        }
      }
    }

    const bounds = new window.google.maps.LatLngBounds();
    raw.forEach(p => bounds.extend({ lat: p.latitude_degrees, lng: p.longitude_degrees }));
    mapObj.current.fitBounds(bounds, { padding: 90 });
  }, [trailData, layers.aiTrajectory]);

  /* ── Predict route overlay ────────────────────────────── */
  useEffect(() => {
    predRouteObjs.current.forEach(o => { try{ o.setMap(null); }catch(_){} });
    predRouteObjs.current = [];
    const wps = predictRoute?.route_waypoints;
    if (!wps || wps.length < 2 || !mapObj.current) return;
    const path = wps.map(wp => ({ lat: wp.lat, lng: wp.lng }));
    const dest = wps[wps.length-1], start = wps[0], pred = predictRoute?.prediction;

    // ── AIS-Learned Maritime Route Rendering ─────────────────────────────
    // Color-code segments by lane type: TSS=blue, AIS-lane=cyan, DWR=teal
    const segmentsByType = [];
    let curSeg = [], curType = null;
    for (const wp of wps) {
      const t = wp.lane_type || wp.type || "waypoint";
      const segType = t === "TSS" ? "TSS" : t === "DWR" ? "DWR" : "AIS";
      if (segType !== curType) {
        if (curSeg.length > 0) { segmentsByType.push({ pts: curSeg, type: curType }); curSeg = [curSeg[curSeg.length-1]]; }
        curType = segType;
      }
      curSeg.push({ lat: wp.lat, lng: wp.lng });
    }
    if (curSeg.length > 1) segmentsByType.push({ pts: curSeg, type: curType });

    const typeColors = {
      TSS:  { outer:"#1d4ed8", inner:"#3b82f6", glow:"#93c5fd" }, // IMO TSS = blue
      DWR:  { outer:"#0f766e", inner:"#14b8a6", glow:"#99f6e4" }, // deep water = teal
      AIS:  { outer:"#6d28d9", inner:"#8b5cf6", glow:"#c4b5fd" }, // AIS-learned = purple
    };

    // Full-path outer glow
    predRouteObjs.current.push(new window.google.maps.Polyline({
      path, geodesic:true, strokeColor:"#1e1b4b", strokeOpacity:0.10, strokeWeight:24,
      zIndex:5, map:mapObj.current
    }));

    // Per-segment colored lines
    for (const seg of segmentsByType) {
      const c = typeColors[seg.type] || typeColors.AIS;
      // Halo
      predRouteObjs.current.push(new window.google.maps.Polyline({
        path:seg.pts, geodesic:true, strokeColor:c.outer, strokeOpacity:0.22, strokeWeight:12,
        zIndex:6, map:mapObj.current
      }));
      // Main line
      predRouteObjs.current.push(new window.google.maps.Polyline({
        path:seg.pts, geodesic:true, strokeColor:c.inner, strokeOpacity:0.92, strokeWeight:4,
        zIndex:8, map:mapObj.current
      }));
      // Centreline shimmer
      predRouteObjs.current.push(new window.google.maps.Polyline({
        path:seg.pts, geodesic:true, strokeColor:c.glow, strokeOpacity:0.55, strokeWeight:1.5,
        zIndex:9, map:mapObj.current
      }));
    }

    // Animated flow dashes (full path)
    predRouteObjs.current.push(new window.google.maps.Polyline({
      path, geodesic:true, strokeOpacity:0, strokeWeight:0, zIndex:10, map:mapObj.current,
      icons:[{icon:{path:"M 0,-1 0,1",strokeOpacity:0.85,strokeColor:"#e0e7ff",scale:2.2},offset:"0",repeat:"16px"}]
    }));
    // Directional arrows
    predRouteObjs.current.push(new window.google.maps.Polyline({
      path, geodesic:true, strokeOpacity:0, strokeWeight:0, zIndex:11, map:mapObj.current,
      icons:["6%","16%","26%","36%","46%","56%","66%","76%","86%","96%"].map(offset=>({
        icon:{path:window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale:2.8, strokeColor:"#312e81", strokeWeight:1,
          fillColor:"#818cf8", fillOpacity:1, strokeOpacity:1},
        offset
      }))
    }));

    wps.slice(1,-1).forEach((wp,i) => {
      const dot=new window.google.maps.Marker({position:{lat:wp.lat,lng:wp.lng},map:mapObj.current,icon:{path:window.google.maps.SymbolPath.CIRCLE,scale:6,fillColor:"#7c3aed",fillOpacity:1,strokeColor:"#e0d4ff",strokeWeight:2},title:wp.label||`Waypoint ${i+1}`,zIndex:10});
      dot.addListener("click",()=>{infoWin.current.setContent(`<div style="font-family:'JetBrains Mono',monospace;background:linear-gradient(135deg,#12082a,#1e0f40);border:1px solid #7c3aed88;border-radius:8px;padding:10px 14px;color:#fff"><div style="color:#a78bfa;font-weight:700;font-size:10px">⚓ WAYPOINT</div><div style="font-size:13px;font-weight:700;color:#ede9fe;margin:4px 0">${wp.label||"Waypoint"}</div>${wp.eta_hours_from_now?`<div style="font-size:9px;color:#c4b5fd">ETA: ~${wp.eta_hours_from_now}h</div>`:""}</div>`);infoWin.current.setPosition({lat:wp.lat,lng:wp.lng});infoWin.current.open(mapObj.current);});
      predRouteObjs.current.push(dot);
    });

    predRouteObjs.current.push(new window.google.maps.Marker({position:{lat:start.lat,lng:start.lng},map:mapObj.current,icon:{path:window.google.maps.SymbolPath.CIRCLE,scale:8,fillColor:"#00e5ff",fillOpacity:1,strokeColor:"#fff",strokeWeight:2},title:"Current Position",zIndex:12}));
    predRouteObjs.current.push(new window.google.maps.Circle({center:{lat:start.lat,lng:start.lng},radius:8000,map:mapObj.current,fillColor:"#00e5ff",fillOpacity:0.06,strokeColor:"#00e5ff",strokeWeight:1.5,strokeOpacity:0.4,zIndex:6}));

    const destMarker=new window.google.maps.Marker({position:{lat:dest.lat,lng:dest.lng},map:mapObj.current,icon:{path:"M -1 -10 L -1 4 M -1 -10 L 8 -6 L -1 -2",strokeColor:"#a78bfa",strokeWeight:2.5,strokeOpacity:1,fillColor:"#7c3aed",fillOpacity:0.8,scale:1.8},title:`🏁 ${dest.label}`,zIndex:15});
    destMarker.addListener("click",()=>{infoWin.current.setContent(`<div style="font-family:'JetBrains Mono',monospace;background:linear-gradient(135deg,#1a0a2e,#2d1b4e);border:1px solid #a78bfa88;border-radius:10px;padding:14px 18px;color:#fff;min-width:220px"><div style="color:#a78bfa;font-weight:700;font-size:10px">🎯 PREDICTED DESTINATION</div><div style="font-size:18px;font-weight:700;color:#ede9fe;margin:7px 0 5px">${dest.label}</div>${pred?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px"><div style="background:rgba(124,58,237,0.2);border-radius:6px;padding:6px 8px"><div style="font-size:8px;color:#a78bfa">ETA</div><div style="font-size:12px;font-weight:700;color:#e9d5ff">${pred.eta_label}</div></div><div style="background:rgba(124,58,237,0.2);border-radius:6px;padding:6px 8px"><div style="font-size:8px;color:#a78bfa">DISTANCE</div><div style="font-size:12px;font-weight:700;color:#e9d5ff">${pred.distance_nm} NM</div></div></div>`:""}</div>`);infoWin.current.setPosition({lat:dest.lat,lng:dest.lng});infoWin.current.open(mapObj.current);});
    predRouteObjs.current.push(destMarker);
    predRouteObjs.current.push(new window.google.maps.Circle({center:{lat:dest.lat,lng:dest.lng},radius:15000,map:mapObj.current,fillColor:"#7c3aed",fillOpacity:0.06,strokeColor:"#a78bfa",strokeWeight:1.5,strokeOpacity:0.45,zIndex:6}));
  }, [predictRoute]);


  /* ── Weather station markers ──────────────────────────── */
  useEffect(() => {
    weatherObjs.current.forEach(o => { try{o.setMap(null);}catch(_){} });
    weatherObjs.current = [];
    if (!mapReady || !mapObj.current || !weatherData || !layers.weatherStations) return;
    const stations = weatherData?.live?.stations || [];
    stations.forEach(s => {
      if (!s.lat || !s.lng) return;
      const spd = s.wind_speed_ms || 0;
      const col = spd < 3.4 ? "#00e5ff" : spd < 8 ? "#00ff9d" : spd < 13.9 ? "#ffcc00" : spd < 20.8 ? "#ff8800" : "#ff2244";
      const hdg = s.wind_direction ?? 0;
      // Wind barb arrow
      const marker = new window.google.maps.Marker({
        position: { lat: s.lat, lng: s.lng },
        map: mapObj.current,
        icon: {
          path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 7,
          rotation: hdg,
          fillColor: col,
          fillOpacity: 0.92,
          strokeColor: "#000",
          strokeWeight: 0.8,
        },
        title: `${s.station_name}: ${s.wind_speed_kn} kn`,
        zIndex: 15,
      });
      // Speed label
      const label = new window.google.maps.Marker({
        position: { lat: s.lat - 0.012, lng: s.lng },
        map: mapObj.current,
        icon: { path: "M 0 0", scale: 0 },
        label: {
          text: `${s.wind_speed_kn}kn`,
          color: col,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "9px",
          fontWeight: "800",
        },
        zIndex: 14,
        clickable: false,
      });
      marker.addListener("click", () => {
        infoWin.current.setContent(
          `<div style="font-family:'JetBrains Mono',monospace;background:rgba(4,10,22,0.97);border:1px solid ${col}55;border-radius:10px;padding:12px 15px;color:#fff;min-width:200px">
            <div style="color:${col};font-weight:800;font-size:11px;margin-bottom:8px">🌬️ ${s.station_name}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
              <div style="background:rgba(0,229,255,0.06);border-radius:6px;padding:6px">
                <div style="font-size:7px;color:#3d6a8a">WIND</div>
                <div style="font-size:15px;font-weight:800;color:${col}">${s.wind_speed_kn} kn</div>
                <div style="font-size:9px;color:#5a8aaa">${s.wind_speed_ms.toFixed(1)} m/s</div>
              </div>
              <div style="background:rgba(0,229,255,0.06);border-radius:6px;padding:6px">
                <div style="font-size:7px;color:#3d6a8a">BEAUFORT</div>
                <div style="font-size:15px;font-weight:800;color:${col}">${s.beaufort?.scale}</div>
                <div style="font-size:9px;color:#5a8aaa">${s.beaufort?.label}</div>
              </div>
            </div>
            ${s.wind_direction != null ? `<div style="margin-top:6px;font-size:9px;color:#6a9ab0">Direction: ${s.wind_direction}°</div>` : ""}
            ${s.rainfall_mm != null && s.rainfall_mm > 0 ? `<div style="margin-top:4px;font-size:9px;color:#44c8ff">🌧️ Rainfall: ${s.rainfall_mm.toFixed(1)} mm</div>` : ""}
            ${s.alert ? `<div style="margin-top:6px;font-size:9px;font-weight:700;color:${s.alert==="danger"?"#ff6688":"#ffaa44"}">${s.alert==="danger"?"⚠️ GALE WARNING":"〰️ ELEVATED WINDS"}</div>` : ""}
          </div>`
        );
        infoWin.current.open(mapObj.current, marker);
      });
      weatherObjs.current.push(marker, label);
    });
  }, [weatherData, layers.weatherStations, mapReady]);

  /* ── Map style cycle ──────────────────────────────────── */
  const cycleStyle = useCallback(() => {
    if (!mapObj.current) return;
    const order = ["satellite", "nautical", "map"];
    const next  = order[(order.indexOf(mapStyle) + 1) % order.length];
    if (next === "satellite") { mapObj.current.setMapTypeId("hybrid");  mapObj.current.setOptions({ styles: [] }); }
    else if (next === "nautical") { mapObj.current.setMapTypeId("roadmap"); mapObj.current.setOptions({ styles: DARK_NAUTICAL_STYLE }); }
    else                          { mapObj.current.setMapTypeId("roadmap"); mapObj.current.setOptions({ styles: CLEAN_MAP_STYLE }); }
    setMapStyle(next);
  }, [mapStyle]);

  const liveCount   = vessels.filter(v => !isStale(v)).length;
  const dangerCount = alerts.filter(a => a.level === "danger").length;
  const warnCount   = alerts.filter(a => a.level === "warning").length;
  const toggleLayer = key => setLayers(prev => ({ ...prev, [key]: !prev[key] }));
  const STYLE_ICON  = { satellite:"🛰️", nautical:"🌊", map:"🗺️" };

  /* ── JSX ──────────────────────────────────────────────── */
  return (
    <div className="mv-root">
      <div ref={mapRef} className="mv-map" />

      {/* TOP-RIGHT CONTROLS */}
      <div className="mv-ctrl-cluster">
        <button className="mv-ctrl-btn" onClick={cycleStyle} title="Map style">
          <span>{STYLE_ICON[mapStyle]}</span>
          <span className="mv-ctrl-txt">{mapStyle.toUpperCase()}</span>
        </button>
        <button className={`mv-ctrl-btn ${showLayerPanel ? "mv-ctrl-active" : ""}`}
          onClick={e => { e.stopPropagation(); setShowLayerPanel(p => !p); }}>
          <span>🗺️</span>
          <span className="mv-ctrl-txt">LAYERS{loadingGIS && <span className="mv-ctrl-dot" />}</span>
        </button>
        <div className="mv-zoom-group">
          <button className="mv-zoom-btn" onClick={() => mapObj.current?.setZoom((mapObj.current.getZoom()||10)+1)}>+</button>
          <button className="mv-zoom-btn" onClick={() => mapObj.current?.setZoom((mapObj.current.getZoom()||10)-1)}>−</button>
        </div>
      </div>

      {/* LAYER PANEL */}
      {showLayerPanel && (
        <div className="mv-layer-panel" onClick={e => e.stopPropagation()}>
          <div className="mv-lp-head">
            <span className="mv-lp-title">⚓ NAUTICAL LAYERS</span>
            <button className="mv-lp-close" onClick={() => setShowLayerPanel(false)}>✕</button>
          </div>
          {[
            { key:"dangers",         label:"Dangers & Hazards",  icon:"⛔", col:"#ff2244" },
            { key:"depths",          label:"Depth Contours",     icon:"🌊", col:"#0055aa" },
            { key:"regulated",       label:"Regulated Areas",    icon:"⚠️", col:"#ffcc00" },
            { key:"tracks",          label:"Tracks & Routes",    icon:"🛣️", col:"#00aaff" },
            { key:"aids",            label:"Aids to Navigation", icon:"💡", col:"#ffee44" },
            { key:"ports",           label:"Ports & Services",   icon:"⚓", col:"#44aaff" },
            { key:"tides",           label:"Tides & Currents",   icon:"🌊", col:"#00eeff" },
            { key:"cultural",        label:"Bridges & Cables",   icon:"🌉", col:"#aaaaaa" },
            { key:"seabed",          label:"Seabed Hazards",     icon:"🪨", col:"#aa6600" },
            { key:"vesselProximity", label:"Proximity Alerts",   icon:"📡", col:"#ff8800" },
            { key:"aiTrajectory",    label:"AI Trajectory Fill", icon:"🤖", col:"#7cdcff" },
            { key:"weatherStations",  label:"Wind Stations",      icon:"🌬️", col:"#00e5ff" },
          ].map(({ key, label, icon, col }) => (
            <div key={key} className={`mv-lp-row ${layers[key] ? "mv-lp-on" : ""}`} onClick={() => toggleLayer(key)}>
              <span className="mv-lp-icon">{icon}</span>
              <span className="mv-lp-label">{label}</span>
              <div className="mv-lp-toggle" style={{ "--tc": col }}>
                <div className={`mv-lp-knob ${layers[key] ? "mv-lp-knob-on" : ""}`} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ALERT PANEL */}
      {alerts.length > 0 && showAlerts && (
        <div className="mv-alert-panel" onClick={e => e.stopPropagation()}>
          <div className="mv-ap-radar">
            <div className="mv-ap-radar-sweep" />
            <div className="mv-ap-radar-ring mv-ap-radar-r1" />
            <div className="mv-ap-radar-ring mv-ap-radar-r2" />
            <div className="mv-ap-radar-dot" />
          </div>
          <div className="mv-ap-head">
            <div className="mv-ap-title-row">
              <span className="mv-ap-title">⚡ COLLISION ALERTS</span>
              <div className="mv-ap-badges">
                {dangerCount > 0 && <span className="mv-ap-badge mv-ap-danger">🚨 {dangerCount}</span>}
                {warnCount   > 0 && <span className="mv-ap-badge mv-ap-warn">⚠️ {warnCount}</span>}
              </div>
            </div>
            <button className="mv-ap-close" onClick={e => { e.stopPropagation(); setShowAlerts(false); }}>✕</button>
          </div>
          <div className="mv-ap-list">
            {(showAllAlerts ? alerts : alerts.slice(0, 5)).map((a, i) => (
              <div key={i} className={`mv-ap-item mv-ap-${a.level}`}
                onClick={e => {
                  e.stopPropagation();
                  if (a.lat && a.lng && mapObj.current) { mapObj.current.panTo({ lat: a.lat, lng: a.lng }); mapObj.current.setZoom(15); }
                  if (a.imo) onVesselClick(vessels.find(v => v.imo_number===a.imo || String(v.imo_number)===String(a.imo)) || null);
                }}
              >
                <div className="mv-ap-item-left">
                  <span className={`mv-ap-level-dot mv-ap-dot-${a.level}`} />
                  <div>
                    <div className="mv-ap-vessel">{a.vessel || "Unknown"}</div>
                    <div className="mv-ap-detail">{a.detail}</div>
                  </div>
                </div>
                <span className="mv-ap-arrow">›</span>
              </div>
            ))}
            {alerts.length > 5 && (
              <button className="mv-ap-more-btn" onClick={e => { e.stopPropagation(); setShowAllAlerts(x => !x); }}>
                {showAllAlerts ? "▲ Show less" : `▼ +${alerts.length - 5} more`}
              </button>
            )}
          </div>
          <div className="mv-ap-footer">
            <span>LIVE MONITORING · {alerts.length} ACTIVE</span>
          </div>
        </div>
      )}
      {alerts.length > 0 && !showAlerts && (
        <button className="mv-ap-bubble" onClick={e => { e.stopPropagation(); setShowAlerts(true); setShowAllAlerts(false); }}>
          <span className="mv-ap-bubble-ping" />
          🚨 <span>{dangerCount > 0 ? dangerCount : alerts.length}</span>
          <span className="mv-ap-bubble-label">DANGER</span>
        </button>
      )}

      {/* AI BADGE */}
      {aiStats && layers.aiTrajectory && (
        <div className="mv-ai-badge">
          <span className="mv-ai-icon">🤖</span>
          <div>
            <div className="mv-ai-title">AI TRAJECTORY</div>
            <div className="mv-ai-sub">+{aiStats.interpolated} pts reconstructed</div>
          </div>
        </div>
      )}

      {/* BOTTOM HUD */}
      <div className="mv-bottom-hud">
        <div className="mv-bh-vessels">
          <span className="mv-live-dot" />
          <span className="mv-bh-count">{liveCount.toLocaleString()}</span>
          <span className="mv-bh-label">LIVE</span>
        </div>
        {trailData?.length > 0 && (
          <div className="mv-bh-trail">
            🛤️ <span>{trailData.length} pts</span>
            {selectedVessel && <span className="mv-bh-tname">{selectedVessel.vessel_name}</span>}
          </div>
        )}
        {coords && !IS_MOBILE && (
          <div className="mv-bh-coords">
            {coords.lat}°N · {coords.lng}°E
            {(() => { const r = getRegionName(parseFloat(coords.lat), parseFloat(coords.lng)); return r ? <span className="mv-bh-region"> · {r}</span> : null; })()}
          </div>
        )}
      </div>

      {/* RANGE LEGEND */}
      <div className="mv-range-legend">
        <div className="mv-rl-row"><span className="mv-rl-dot" style={{ background:"#ff2244" }} /><span>DANGER &lt;{RADIUS.DANGER}m</span></div>
        <div className="mv-rl-row"><span className="mv-rl-dot" style={{ background:"#ffaa00" }} /><span>CAUTION &lt;{RADIUS.WARNING}m</span></div>
        <div className="mv-rl-row"><span className="mv-rl-dot" style={{ background:"#00cc44" }} /><span>SAFE</span></div>
        {layers.aiTrajectory && <div className="mv-rl-row"><span className="mv-rl-dot" style={{ background:"#7cdcff" }} /><span>AI FILLED</span></div>}
      </div>
      {/* COMPASS ROSE DECORATION */}
      <div className="mv-compass" aria-hidden="true">🧭</div>

      {/* WEATHER OVERLAY */}
      <WeatherPanel
        onStationHover={s => {
          if (!mapObj.current || !s?.lat || !s?.lng) return;
          const z = mapObj.current.getZoom() || 10;
          if (z < 8) { mapObj.current.panTo({ lat: s.lat, lng: s.lng }); }
        }}
        onStationLeave={() => {}}
      />
    </div>
  );
});

export default MapView;

/* ─── info window helper ────────────────────────────────── */
function dangerInfoContent(f) {
  return `<div style="font-family:'JetBrains Mono',monospace;background:#1a0010;border:1px solid #ff2244;border-radius:8px;padding:10px 14px;color:#fff;min-width:200px"><div style="color:#ff2244;font-weight:700;font-size:12px">⛔ DANGER / HAZARD</div><div style="margin-top:6px;font-size:11px">${f.name||"Unknown Hazard"}</div>${f.depth!=null?`<div style="font-size:10px;color:#ff8899;margin-top:3px">Depth: ${f.depth}m</div>`:""}${f.info?`<div style="margin-top:4px;font-size:9px;color:#cc8888">${String(f.info).substring(0,200)}</div>`:""}</div>`;
}

/* ─── map style themes ──────────────────────────────────── */
const CLEAN_MAP_STYLE = [
  { elementType:"geometry", stylers:[{ color:"#e8e8e8" }] },
  { featureType:"water", elementType:"geometry", stylers:[{ color:"#b0c8d8" }] },
  { featureType:"poi", stylers:[{ visibility:"off" }] },
  { featureType:"transit", stylers:[{ visibility:"off" }] },
  { elementType:"labels.icon", stylers:[{ visibility:"off" }] },
];

const DARK_NAUTICAL_STYLE = [
  { elementType:"geometry",              stylers:[{ color:"#0d1a28" }] },
  { elementType:"labels.text.fill",      stylers:[{ color:"#3d6a8a" }] },
  { elementType:"labels.text.stroke",    stylers:[{ color:"#040810" }] },
  { featureType:"water", elementType:"geometry", stylers:[{ color:"#071828" }] },
  { featureType:"water", elementType:"labels.text.fill", stylers:[{ color:"#1a4a6a" }] },
  { featureType:"landscape",             elementType:"geometry", stylers:[{ color:"#111e2c" }] },
  { featureType:"landscape.natural",     elementType:"geometry", stylers:[{ color:"#0d1a28" }] },
  { featureType:"road",                  stylers:[{ visibility:"off" }] },
  { featureType:"poi",                   stylers:[{ visibility:"off" }] },
  { featureType:"transit",               stylers:[{ visibility:"off" }] },
  { elementType:"labels.icon",           stylers:[{ visibility:"off" }] },
  { featureType:"administrative.country", elementType:"geometry.stroke", stylers:[{ color:"#1a3a5a" }, { weight:0.8 }] },
  { featureType:"administrative.locality", elementType:"labels.text.fill", stylers:[{ color:"#2a5a7a" }, { visibility:"simplified" }] },
];

// const DARK_NAUTICAL_STYLE = [
//   { elementType:"geometry",              stylers:[{ color:"#0d1a28" }] },
//   { elementType:"labels.text.fill",      stylers:[{ color:"#3d6a8a" }] },
//   { elementType:"labels.text.stroke",    stylers:[{ color:"#040810" }] },
//   { featureType:"water", elementType:"geometry", stylers:[{ color:"#071828" }] },
//   { featureType:"water", elementType:"labels.text.fill", stylers:[{ color:"#1a4a6a" }] },
//   { featureType:"landscape",             elementType:"geometry", stylers:[{ color:"#111e2c" }] },
//   { featureType:"landscape.natural",     elementType:"geometry", stylers:[{ color:"#0d1a28" }] },
//   { featureType:"road",                  stylers:[{ visibility:"off" }] },
//   { featureType:"poi",                   stylers:[{ visibility:"off" }] },
//   { featureType:"transit",               stylers:[{ visibility:"off" }] },
//   { elementType:"labels.icon",           stylers:[{ visibility:"off" }] },
//   { featureType:"administrative.country", elementType:"geometry.stroke", stylers:[{ color:"#1a3a5a" }, { weight:0.8 }] },
//   { featureType:"administrative.locality", elementType:"labels.text.fill", stylers:[{ color:"#2a5a7a" }, { visibility:"simplified" }] },
// ];