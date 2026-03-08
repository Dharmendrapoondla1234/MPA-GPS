// src/components/MapView.jsx — ULTRA-ADVANCED v4
import React, {
  useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle,
} from "react";
import { Loader } from "@googlemaps/js-api-loader";
import { MarkerClusterer } from "@googlemaps/markerclusterer";
import { buildInfoWindowContent, getSpeedColor, getRegionName } from "../utils/vesselUtils";
import "./MapView.css";

const MAP_CENTER  = { lat: 1.35, lng: 103.82 };
const BASE_URL    = process.env.REACT_APP_API_URL || "https://vessel-backends.onrender.com/api";
let loaderPromise = null;
const RADIUS = { DANGER: 500, WARNING: 1500 };
const STALE_MS = 24 * 60 * 60 * 1000;
const IS_MOBILE = /Mobi|Android/i.test(navigator.userAgent);

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
  const speed   = parseFloat(vessel.speed)   || 0;
  const heading = parseFloat(vessel.heading) || 0;

  // Color: alert overrides speed-color
  const color = alertLevel === "danger"  ? "#ff2244" :
                alertLevel === "warning" ? "#ffcc00" :
                getSpeedColor(speed);

  // MarineTraffic-style: prominent arrows that are always readable
  // Larger base so vessels are visible at zoom 8+
  const scale = isSelected ? 16 : alertLevel ? 13 : 11;

  if (speed > 0.3) {
    // Moving vessel — directional arrow (MarineTraffic style)
    return {
      path:         window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale,
      rotation:     heading,
      fillColor:    color,
      fillOpacity:  1,
      strokeColor:  isSelected ? "#ffffff" : "rgba(0,0,0,0.55)",
      strokeWeight: isSelected ? 2.5 : 1.0,
      anchor:       new window.google.maps.Point(0, 2.5),
    };
  }
  // Stationary — circle dot like MarineTraffic
  return {
    path:         window.google.maps.SymbolPath.CIRCLE,
    scale:        isSelected ? 8 : 5,
    fillColor:    color,
    fillOpacity:  isSelected ? 1 : 0.85,
    strokeColor:  isSelected ? "#ffffff" : "rgba(0,0,0,0.5)",
    strokeWeight: isSelected ? 2.5 : 1.0,
  };
}

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

// ── AI TRAJECTORY RECONSTRUCTION (Catmull-Rom Spline) ────────
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
          speed:   +p1.speed   + (+p2.speed   - +p1.speed)   * t,
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

const MapView = forwardRef(function MapView({ vessels, selectedVessel, onVesselClick, trailData, predictRoute }, ref) {
  const mapRef       = useRef(null);
  const mapObj       = useRef(null);
  const markersRef   = useRef({});
  const clusterer    = useRef(null);
  const infoWin      = useRef(null);
  const hoverWin     = useRef(null);
  const trailObjs    = useRef([]);
  const gisObjs      = useRef([]);
  const alertCircles = useRef({});
  const vesselCircles= useRef({});
  const pulseCirc    = useRef(null);
  const pulseTimer   = useRef(null);
  const clusterDirty = useRef(false);
  const aiObjs       = useRef([]);
  const predRouteObjs= useRef([]);

  const [coords,         setCoords]         = useState(null);
  const [mapStyle,       setMapStyle]       = useState("dark");
  const [mapReady,       setMapReady]       = useState(false);
  const [gisData,        setGisData]        = useState(null);
  const [alerts,         setAlerts]         = useState([]);
  const [showLayerPanel, setShowLayerPanel] = useState(false);
  const [showAlerts,     setShowAlerts]     = useState(true);
  const [showAllAlerts,  setShowAllAlerts]  = useState(false);
  const [loadingGIS,     setLoadingGIS]     = useState(true);
  const [aiStats,        setAiStats]        = useState(null);
  const [layers, setLayers] = useState({
    dangers: true, depths: true, regulated: true, tracks: true,
    aids: true, seabed: false, ports: true, tides: false, cultural: true,
    vesselProximity: false, aiTrajectory: true,  // OFF by default — too noisy in busy ports
  });

  useImperativeHandle(ref, () => ({
    panToVessel(vessel) {
      const lat = Number(vessel?.latitude_degrees), lng = Number(vessel?.longitude_degrees);
      if (mapObj.current && lat && lng) { mapObj.current.panTo({ lat, lng }); mapObj.current.setZoom(12); }
    },
  }));

  useEffect(() => {
    fetch(`${BASE_URL}/gis/all`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { if (j?.data) setGisData(j.data); }).catch(e => console.warn("[GIS]", e.message)).finally(() => setLoadingGIS(false));
  }, []);


  // ── PERFORMANCE: memoised derived data ──────────────────────
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

  useEffect(() => {
    if (mapObj.current) return;
    if (!loaderPromise) loaderPromise = new Loader({ apiKey: process.env.REACT_APP_GOOGLE_MAPS_KEY || "", version: "weekly", libraries: ["geometry"] }).load();
    loaderPromise.then(() => {
      if (mapObj.current) return;
      const map = new window.google.maps.Map(mapRef.current, {
        center: MAP_CENTER, zoom: 5, mapTypeId: "roadmap",
        styles: DARK_NAUTICAL_STYLE,
        zoomControl: false, streetViewControl: false, mapTypeControl: false,
        fullscreenControl: false, rotateControl: false, gestureHandling: "greedy", clickableIcons: false,
      });
      mapObj.current = map;
      infoWin.current  = new window.google.maps.InfoWindow({ maxWidth: 340 });
      hoverWin.current = new window.google.maps.InfoWindow({ maxWidth: 240, disableAutoPan: true });
      map.addListener("mousemove", e => setCoords({ lat: e.latLng.lat().toFixed(5), lng: e.latLng.lng().toFixed(5) }));
      map.addListener("click", () => { infoWin.current.close(); hoverWin.current.close(); setShowLayerPanel(false); setShowAlerts(false); });
      // Custom cluster renderer — color-coded by density
      const clusterRenderer = { render({ count, position }) {
        const col  = count < 20  ? "#00e5ff" : count < 100 ? "#ffaa00" : "#ff3355";
        const sz   = count < 10  ? 18 : count < 50 ? 22 : count < 200 ? 27 : 33;
        const txt  = count > 999 ? `${(count/1000).toFixed(1)}k` : String(count);
        return new window.google.maps.Marker({
          position, zIndex: 999,
          icon: { path: window.google.maps.SymbolPath.CIRCLE, scale: sz/2,
                  fillColor: "#060e1a", fillOpacity: 0.92,
                  strokeColor: col, strokeWeight: 2 },
          label: { text: txt, color: col, fontSize: "10px",
                   fontFamily: "'JetBrains Mono',monospace", fontWeight: "700" },
        });
      }};
      // Only cluster at very low zoom levels (< 8) — at zoom 8+ show all individual vessels
      // This matches MarineTraffic behavior: individual arrows visible from mid zoom
      clusterer.current = new MarkerClusterer({
        map, markers: [],
        renderer: clusterRenderer,
        algorithmOptions: { maxZoom: 7, radius: 80 },
      });
      setMapReady(true);
    });
  }, []);

  // GIS LAYERS
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

  // PROXIMITY
  useEffect(() => {
    Object.values(alertCircles.current).forEach(c => { try{c.setMap(null);}catch(_){} });
    Object.values(vesselCircles.current).forEach(c => { try{c.setMap(null);}catch(_){} });
    alertCircles.current = {}; vesselCircles.current = {};
    if (!mapObj.current || !layers.vesselProximity) { setAlerts([]); return; }
    const fresh = freshVessels;
    const newAlerts = [];
    if (gisData && layers.dangers && gisData.dangers) {
      const pts = gisData.dangers.filter(d=>d.type==="danger_point"&&Array.isArray(d.coords)&&typeof d.coords[0]==="number").map(d=>({lat:d.coords[1],lng:d.coords[0],name:d.name}));
      fresh.forEach(v => {
        const vl=parseFloat(v.latitude_degrees),vg=parseFloat(v.longitude_degrees);
        let cd=Infinity,cn=null;
        pts.forEach(dp => { const dist=distanceM(vl,vg,dp.lat,dp.lng);if(dist<cd){cd=dist;cn=dp;} });
        if(cd<RADIUS.DANGER){newAlerts.push({level:"danger",vessel:v.vessel_name,imo:v.imo_number,lat:vl,lng:vg,detail:`${Math.round(cd)}m from ${cn?.name||"hazard"}`});alertCircles.current[`d_${v.imo_number}`]=new window.google.maps.Circle({center:{lat:vl,lng:vg},radius:RADIUS.DANGER,map:mapObj.current,fillColor:"#ff2244",fillOpacity:0.08,strokeColor:"#ff2244",strokeWeight:2,strokeOpacity:0.9,zIndex:20});}
        else if(cd<RADIUS.WARNING){newAlerts.push({level:"warning",vessel:v.vessel_name,imo:v.imo_number,lat:vl,lng:vg,detail:`${Math.round(cd)}m from ${cn?.name||"hazard"}`});alertCircles.current[`w_${v.imo_number}`]=new window.google.maps.Circle({center:{lat:vl,lng:vg},radius:RADIUS.WARNING,map:mapObj.current,fillColor:"#ffaa00",fillOpacity:0.05,strokeColor:"#ffaa00",strokeWeight:1.5,strokeOpacity:0.7,zIndex:19});}
      });
    }
    // Only check MOVING vessels for collision risk (stationary vessels in port are expected to be close)
    const moving = fresh.filter(v => parseFloat(v.speed || 0) > 1.0);
    const NEAR = 0.015, cap = Math.min(moving.length, 80); // cap at 80 moving vessels
    for (let i = 0; i < cap; i++) for (let j = i + 1; j < cap; j++) {
      const a = moving[i], b = moving[j];
      if (!a.imo_number || !b.imo_number || a.imo_number === b.imo_number) continue;
      if (Math.abs(+a.latitude_degrees - +b.latitude_degrees) > NEAR) continue;
      if (Math.abs(+a.longitude_degrees - +b.longitude_degrees) > NEAR) continue;
      const dist = distanceM(+a.latitude_degrees, +a.longitude_degrees, +b.latitude_degrees, +b.longitude_degrees);
      if (dist < RADIUS.DANGER) {
        newAlerts.push({ level: "danger", vessel: a.vessel_name, imo: a.imo_number,
          lat: +a.latitude_degrees, lng: +a.longitude_degrees,
          otherVessel: b.vessel_name, detail: `${Math.round(dist)}m from ${b.vessel_name} — COLLISION RISK` });
        const ml = (+a.latitude_degrees + +b.latitude_degrees) / 2, mg = (+a.longitude_degrees + +b.longitude_degrees) / 2;
        vesselCircles.current[`vv_${a.imo_number}_${b.imo_number}`] = new window.google.maps.Circle({
          center: { lat: ml, lng: mg }, radius: Math.max(dist / 2, 50), map: mapObj.current,
          fillColor: "#ff0000", fillOpacity: 0.12, strokeColor: "#ff0000", strokeWeight: 2, strokeOpacity: 1, zIndex: 25,
        });
      }
      // Skip drawing warning circles for vessel-vessel — too noisy, just log the alert
      else if (dist < RADIUS.WARNING) {
        newAlerts.push({ level: "warning", vessel: a.vessel_name, imo: a.imo_number,
          lat: +a.latitude_degrees, lng: +a.longitude_degrees,
          otherVessel: b.vessel_name, detail: `${Math.round(dist)}m from ${b.vessel_name}` });
      }
    }
    setAlerts(newAlerts.slice(0,20));
  }, [freshVessels, gisData, layers.dangers, layers.vesselProximity]);

  // MARKERS
  useEffect(() => {
    if (!mapReady || !mapObj.current || !clusterer.current) return;
    const fresh=freshVessels;
    const activeIds=new Set(fresh.map(v=>String(v.imo_number)));
    const selId=selectedVessel?.imo_number;
    const toAdd=[],toRemove=[];
    Object.keys(markersRef.current).forEach(id=>{if(!activeIds.has(id)){const m=markersRef.current[id];if(m._animId)cancelAnimationFrame(m._animId);toRemove.push(m);delete markersRef.current[id];}});
    fresh.forEach(v=>{
      const lat=Number(v.latitude_degrees),lng=Number(v.longitude_degrees);
      if(!lat||!lng||isNaN(lat)||isNaN(lng))return;
      const id=String(v.imo_number),isSel=v.imo_number===selId;
      const al=alertMap[v.vessel_name]||null;
      if(markersRef.current[id]){
        const m=markersRef.current[id];
        const prev=m._vessel;
        const posChanged = !prev || Math.abs(Number(prev.latitude_degrees)-lat)>0.00001 || Math.abs(Number(prev.longitude_degrees)-lng)>0.00001;
        const selChanged = prev?._isSel !== isSel;
        const spdChanged = prev?.speed !== v.speed;
        if(posChanged) smoothMove(m,lat,lng);
        if(posChanged||selChanged||spdChanged||al) { m.setIcon(getVesselIcon(v,isSel,al)); m.setZIndex(isSel?1000:al==="danger"?500:10); }
        m._vessel=v; m._isSel=isSel;
      }
      else{const m=new window.google.maps.Marker({position:{lat,lng},icon:getVesselIcon(v,isSel,al),title:v.vessel_name||"Vessel",optimized:true,zIndex:isSel?1000:al==="danger"?500:10});
        m._vessel=v;
        m.addListener("click",()=>{hoverWin.current.close();infoWin.current.setContent(buildInfoWindowContent(v));infoWin.current.open(mapObj.current,m);onVesselClick(v);});
        if(!IS_MOBILE){m.addListener("mouseover",()=>{const ve=m._vessel,spd=parseFloat(ve.speed||0),col=getSpeedColor(spd),region=getRegionName(parseFloat(ve.latitude_degrees||0),parseFloat(ve.longitude_degrees||0));hoverWin.current.setContent(`<div style="font-family:'JetBrains Mono',monospace;background:#0b1525;border:1px solid ${col}66;border-radius:10px;padding:9px 13px;min-width:175px;color:#f0f8ff;box-shadow:0 8px 28px rgba(0,0,0,0.85)"><div style="font-size:12px;font-weight:700;color:#00e5ff">${ve.vessel_name||"Unknown"}</div><div style="margin-top:5px;display:flex;align-items:center;gap:10px"><span style="font-size:14px;font-weight:700;color:${col}">${spd.toFixed(1)} kn</span><span style="font-size:9px;color:#6a9ab0">${ve.heading||0}° HDG</span></div>${region?`<div style="font-size:9px;color:#00e5ff;margin-top:4px">📍 ${region}</div>`:""}<div style="margin-top:4px;font-size:8px;color:#3d6a8a;font-style:italic">Click for details</div></div>`);hoverWin.current.open(mapObj.current,m);});m.addListener("mouseout",()=>hoverWin.current.close());}
        markersRef.current[id]=m;toAdd.push(m);
      }
    });
    if(!clusterDirty.current&&(toAdd.length>0||toRemove.length>0)){clusterDirty.current=true;requestAnimationFrame(()=>{clusterDirty.current=false;if(!clusterer.current)return;if(toRemove.length)clusterer.current.removeMarkers(toRemove,true);if(toAdd.length)clusterer.current.addMarkers(toAdd,true);if(toRemove.length||toAdd.length)clusterer.current.render();});}
  }, [freshVessels, selectedVessel, onVesselClick, alertMap, mapReady]);

  // PULSE
  useEffect(() => {
    clearInterval(pulseTimer.current);
    if(pulseCirc.current){pulseCirc.current.setMap(null);pulseCirc.current=null;}
    if(!selectedVessel||!mapObj.current)return;
    const lat=Number(selectedVessel.latitude_degrees),lng=Number(selectedVessel.longitude_degrees);
    if(!lat||!lng)return;
    mapObj.current.panTo({lat,lng});
    Object.values(markersRef.current).forEach(m=>{if(m._vessel)m.setIcon(getVesselIcon(m._vessel,m._vessel.imo_number===selectedVessel.imo_number,null));});
    const color=getSpeedColor(selectedVessel.speed);
    pulseCirc.current=new window.google.maps.Circle({center:{lat,lng},radius:600,fillColor:color,fillOpacity:0.07,strokeColor:color,strokeOpacity:0.8,strokeWeight:2,map:mapObj.current,zIndex:5});
    let r=600,grow=true;
    pulseTimer.current=setInterval(()=>{if(!pulseCirc.current)return;r=grow?r+60:r-60;if(r>1200)grow=false;if(r<600)grow=true;try{pulseCirc.current.setRadius(r);}catch(_){}},IS_MOBILE?150:80);
    return()=>{clearInterval(pulseTimer.current);if(pulseCirc.current){pulseCirc.current.setMap(null);pulseCirc.current=null;}};
  }, [selectedVessel]);

  // TRAIL + AI
  useEffect(() => {
    trailObjs.current.forEach(o=>{try{o.setMap(null);}catch(_){}});
    aiObjs.current.forEach(o=>{try{o.setMap(null);}catch(_){}});
    trailObjs.current=[];aiObjs.current=[];setAiStats(null);
    if(!trailData?.length||!mapObj.current)return;
    const raw=trailData.map(p=>({latitude_degrees:Number(p.latitude_degrees??p.lat??0),longitude_degrees:Number(p.longitude_degrees??p.lng??0),speed:parseFloat(p.speed??0),heading:parseFloat(p.heading??0),effective_timestamp:p.effective_timestamp})).filter(p=>p.latitude_degrees&&p.longitude_degrees&&!isNaN(p.latitude_degrees));
    if(raw.length<2)return;

    let pts=raw;
    let aiCount=0;
    if(layers.aiTrajectory){
      pts=interpolateTrajectory(raw,30);
      aiCount=pts.filter(p=>p.ai_interpolated).length;
      if(aiCount>0)setAiStats({total:pts.length,interpolated:aiCount,original:raw.length});
    }

    // Real trail
    const realPts=raw;
    const SEG=Math.min(realPts.length-1,50),step=Math.max(1,Math.floor((realPts.length-1)/SEG));
    for(let i=0;i<realPts.length-1;i+=step){
      const end=Math.min(i+step+1,realPts.length),prog=i/(realPts.length-1);
      const r=Math.round(prog*100),g=Math.round(150+prog*105),b=Math.round(200+prog*55);
      trailObjs.current.push(new window.google.maps.Polyline({path:realPts.slice(i,end).map(p=>({lat:p.latitude_degrees,lng:p.longitude_degrees})),geodesic:true,strokeColor:`rgb(${r},${g},${b})`,strokeOpacity:0.25+prog*0.75,strokeWeight:1.5+prog*3.5,map:mapObj.current,zIndex:3}));
    }

    // AI interpolated — dashed cyan lines
    if(layers.aiTrajectory&&aiCount>0){
      let start=null;
      for(let i=0;i<pts.length;i++){
        if(pts[i].ai_interpolated){if(start===null)start=i>0?i-1:i;}
        else{if(start!==null){const seg=pts.slice(start,i+1).map(p=>({lat:p.latitude_degrees,lng:p.longitude_degrees}));const conf=pts[Math.floor((start+i)/2)].confidence||0.5;aiObjs.current.push(new window.google.maps.Polyline({path:seg,geodesic:true,strokeColor:"#7cdcff",strokeOpacity:0,strokeWeight:0,zIndex:4,map:mapObj.current,icons:[{icon:{path:"M 0,-1 0,1",strokeOpacity:conf*0.85,strokeColor:"#7cdcff",scale:3},offset:"0",repeat:"12px"}]}));start=null;}}
      }
      // Gap markers
      for(let i=1;i<raw.length;i++){
        const t1=new Date(raw[i-1].effective_timestamp).getTime(),t2=new Date(raw[i].effective_timestamp).getTime();
        const gapMin=(t2-t1)/60000;
        if(gapMin>30&&gapMin<360){
          const ml=(raw[i-1].latitude_degrees+raw[i].latitude_degrees)/2,mg=(raw[i-1].longitude_degrees+raw[i].longitude_degrees)/2;
          const m=new window.google.maps.Marker({position:{lat:ml,lng:mg},map:mapObj.current,icon:{path:window.google.maps.SymbolPath.CIRCLE,scale:5,fillColor:"#7cdcff",fillOpacity:0.85,strokeColor:"#fff",strokeWeight:1.5},title:`AI gap: ${Math.round(gapMin)}min`,zIndex:10});
          m.addListener("click",()=>{infoWin.current.setContent(`<div style="font-family:'JetBrains Mono',monospace;background:#061828;border:1px solid #7cdcff;border-radius:10px;padding:12px 15px;color:#fff;max-width:260px"><div style="color:#7cdcff;font-weight:700;font-size:12px;margin-bottom:8px">🤖 AI TRAJECTORY RECONSTRUCTION</div><div style="font-size:11px;color:#cde">AIS data gap: <b style="color:#7cdcff">${Math.round(gapMin)} min</b></div><div style="margin-top:6px;font-size:10px;color:#8ab4d0;line-height:1.5">Path reconstructed using Catmull-Rom spline interpolation. Prediction confidence decreases with gap duration.</div><div style="margin-top:6px;font-size:9px;color:#4a7a9b;border-top:1px solid rgba(124,220,255,0.2);padding-top:6px">Research area: AIS gap filling & trajectory prediction</div></div>`);infoWin.current.setPosition({lat:ml,lng:mg});infoWin.current.open(mapObj.current);});
          aiObjs.current.push(m);
        }
      }
    }

    const bounds=new window.google.maps.LatLngBounds();
    raw.forEach(p=>bounds.extend({lat:p.latitude_degrees,lng:p.longitude_degrees}));
    mapObj.current.fitBounds(bounds,{padding:90});
  }, [trailData, layers.aiTrajectory]);

  // PREDICT ROUTE OVERLAY
  useEffect(() => {
    predRouteObjs.current.forEach(o => { try{ o.setMap(null); }catch(_){} });
    predRouteObjs.current = [];

    const wps = predictRoute?.route_waypoints;
    if (!wps || wps.length < 2 || !mapObj.current) return;

    const path = wps.map(wp => ({ lat: wp.lat, lng: wp.lng }));
    const dest  = wps[wps.length - 1];
    const start = wps[0];
    const pred  = predictRoute?.prediction;

    // ── Outer glow (thick, low opacity) ──
    predRouteObjs.current.push(new window.google.maps.Polyline({
      path, geodesic: true,
      strokeColor: "#7c3aed", strokeOpacity: 0.18, strokeWeight: 14,
      zIndex: 6, map: mapObj.current,
    }));

    // ── Main route line ──
    predRouteObjs.current.push(new window.google.maps.Polyline({
      path, geodesic: true,
      strokeColor: "#a78bfa", strokeOpacity: 0.7, strokeWeight: 3,
      zIndex: 8, map: mapObj.current,
    }));

    // ── Animated dashes overlay ──
    predRouteObjs.current.push(new window.google.maps.Polyline({
      path, geodesic: true,
      strokeColor: "#c4b5fd", strokeOpacity: 0, strokeWeight: 0,
      zIndex: 9, map: mapObj.current,
      icons: [{
        icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: "#e0d4ff", scale: 2.5 },
        offset: "0", repeat: "20px",
      }],
    }));

    // ── Direction arrows every ~25% of route ──
    const arrowOffsets = ["15%", "35%", "55%", "75%", "90%"];
    predRouteObjs.current.push(new window.google.maps.Polyline({
      path, geodesic: true,
      strokeOpacity: 0, strokeWeight: 0,
      zIndex: 10, map: mapObj.current,
      icons: arrowOffsets.map(offset => ({
        icon: {
          path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 3.5,
          strokeColor: "#a78bfa",
          strokeWeight: 2,
          fillColor: "#c4b5fd",
          fillOpacity: 0.9,
          strokeOpacity: 1,
        },
        offset,
      })),
    }));

    // ── Waypoint markers (intermediate) ──
    wps.slice(1, -1).forEach((wp, i) => {
      const dot = new window.google.maps.Marker({
        position: { lat: wp.lat, lng: wp.lng },
        map: mapObj.current,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 6,
          fillColor: "#7c3aed",
          fillOpacity: 1,
          strokeColor: "#e0d4ff",
          strokeWeight: 2,
        },
        title: wp.label || `Waypoint ${i+1}`,
        zIndex: 10,
      });
      // Waypoint info on click
      dot.addListener("click", () => {
        const etaT = wp.eta_hours_from_now;
        infoWin.current.setContent(
          `<div style="font-family:'JetBrains Mono',monospace;background:linear-gradient(135deg,#12082a,#1e0f40);border:1px solid #7c3aed88;border-radius:8px;padding:10px 14px;color:#fff;min-width:160px">
            <div style="color:#a78bfa;font-weight:700;font-size:10px;letter-spacing:0.1em">⚓ SEA ROUTE WAYPOINT</div>
            <div style="font-size:13px;font-weight:700;color:#ede9fe;margin:5px 0 3px">${wp.label||"Waypoint"}</div>
            ${etaT ? `<div style="font-size:9px;color:#c4b5fd">ETA from now: ~${etaT}h</div>` : ""}
            <div style="font-size:8px;color:#6d28d9;margin-top:3px">${wp.lat.toFixed(3)}°N ${wp.lng.toFixed(3)}°E</div>
          </div>`
        );
        infoWin.current.setPosition({ lat: wp.lat, lng: wp.lng });
        infoWin.current.open(mapObj.current);
      });
      predRouteObjs.current.push(dot);
    });

    // ── Origin marker ──
    predRouteObjs.current.push(new window.google.maps.Marker({
      position: { lat: start.lat, lng: start.lng },
      map: mapObj.current,
      icon: {
        path: window.google.maps.SymbolPath.CIRCLE,
        scale: 8, fillColor: "#00e5ff", fillOpacity: 1,
        strokeColor: "#fff", strokeWeight: 2,
      },
      title: "Current Position", zIndex: 12,
    }));
    predRouteObjs.current.push(new window.google.maps.Circle({
      center: { lat: start.lat, lng: start.lng },
      radius: 8000, map: mapObj.current,
      fillColor: "#00e5ff", fillOpacity: 0.06,
      strokeColor: "#00e5ff", strokeWeight: 1.5, strokeOpacity: 0.4, zIndex: 6,
    }));

    // ── Destination marker (flag icon) ──
    const destMarker = new window.google.maps.Marker({
      position: { lat: dest.lat, lng: dest.lng },
      map: mapObj.current,
      icon: {
        // Flag shape
        path: "M -1 -10 L -1 4 M -1 -10 L 8 -6 L -1 -2",
        strokeColor: "#a78bfa", strokeWeight: 2.5, strokeOpacity: 1,
        fillColor: "#7c3aed", fillOpacity: 0.8, scale: 1.8,
      },
      title: `🏁 ${dest.label}`,
      zIndex: 15,
    });
    destMarker.addListener("click", () => {
      infoWin.current.setContent(
        `<div style="font-family:'JetBrains Mono',monospace;background:linear-gradient(135deg,#1a0a2e,#2d1b4e);border:1px solid #a78bfa88;border-radius:10px;padding:14px 18px;color:#fff;min-width:220px">
          <div style="color:#a78bfa;font-weight:700;font-size:10px;letter-spacing:0.12em">🎯 PREDICTED DESTINATION</div>
          <div style="font-size:18px;font-weight:700;color:#ede9fe;margin:7px 0 5px">${dest.label}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px">
            ${pred ? `
            <div style="background:rgba(124,58,237,0.2);border-radius:6px;padding:6px 8px">
              <div style="font-size:8px;color:#a78bfa;letter-spacing:0.08em">ETA</div>
              <div style="font-size:12px;font-weight:700;color:#e9d5ff">${pred.eta_label}</div>
            </div>
            <div style="background:rgba(124,58,237,0.2);border-radius:6px;padding:6px 8px">
              <div style="font-size:8px;color:#a78bfa;letter-spacing:0.08em">DISTANCE</div>
              <div style="font-size:12px;font-weight:700;color:#e9d5ff">${pred.distance_nm} NM</div>
            </div>
            <div style="background:rgba(124,58,237,0.2);border-radius:6px;padding:6px 8px">
              <div style="font-size:8px;color:#a78bfa;letter-spacing:0.08em">CONFIDENCE</div>
              <div style="font-size:12px;font-weight:700;color:#e9d5ff">${pred.confidence}%</div>
            </div>
            <div style="background:rgba(124,58,237,0.2);border-radius:6px;padding:6px 8px">
              <div style="font-size:8px;color:#a78bfa;letter-spacing:0.08em">BEARING</div>
              <div style="font-size:12px;font-weight:700;color:#e9d5ff">${pred.bearing_deg}°</div>
            </div>
            ` : ""}
          </div>
          ${pred?.method ? `<div style="margin-top:8px;font-size:8px;color:#6d28d9;border-top:1px solid rgba(124,58,237,0.3);padding-top:6px">${pred.method}</div>` : ""}
        </div>`
      );
      infoWin.current.setPosition({ lat: dest.lat, lng: dest.lng });
      infoWin.current.open(mapObj.current);
    });
    predRouteObjs.current.push(destMarker);

    // ── Destination zone circle ──
    predRouteObjs.current.push(new window.google.maps.Circle({
      center: { lat: dest.lat, lng: dest.lng },
      radius: 15000, map: mapObj.current,
      fillColor: "#7c3aed", fillOpacity: 0.06,
      strokeColor: "#a78bfa", strokeWeight: 1.5, strokeOpacity: 0.45, zIndex: 6,
    }));

  }, [predictRoute]);

    // STYLE CYCLE
  const cycleStyle = useCallback(() => {
    if (!mapObj.current) return;
    const next = {satellite:"map", map:"dark", dark:"satellite"}[mapStyle];
    if (next === "satellite") { mapObj.current.setMapTypeId("hybrid"); mapObj.current.setOptions({styles:[]}); }
    else if (next === "map")  { mapObj.current.setMapTypeId("roadmap"); mapObj.current.setOptions({styles:CLEAN_MAP_STYLE}); }
    else                      { mapObj.current.setMapTypeId("roadmap"); mapObj.current.setOptions({styles:DARK_NAUTICAL_STYLE}); }
    setMapStyle(next);
  }, [mapStyle]);

  const liveCount=vessels.filter(v=>!isStale(v)).length;
  const dangerCount=alerts.filter(a=>a.level==="danger").length;
  const warnCount=alerts.filter(a=>a.level==="warning").length;
  const toggleLayer=key=>setLayers(prev=>({...prev,[key]:!prev[key]}));
  const STYLE_ICON={satellite:"🛰️",map:"🗺️",dark:"🌑"};

  return (
    <div className="mv-root">
      <div ref={mapRef} className="mv-map" />

      {/* TOP-RIGHT CONTROL CLUSTER */}
      <div className="mv-ctrl-cluster">
        <button className="mv-ctrl-btn" onClick={cycleStyle} title="Map style">
          <span>{STYLE_ICON[mapStyle]}</span>
          <span className="mv-ctrl-txt">{mapStyle.toUpperCase()}</span>
        </button>
        <button className={`mv-ctrl-btn ${showLayerPanel?"mv-ctrl-active":""}`} onClick={e=>{e.stopPropagation();setShowLayerPanel(p=>!p);}}>
          <span>🗺️</span>
          <span className="mv-ctrl-txt">LAYERS{loadingGIS&&<span className="mv-ctrl-dot"/>}</span>
        </button>
        <div className="mv-zoom-group">
          <button className="mv-zoom-btn" onClick={()=>mapObj.current?.setZoom((mapObj.current.getZoom()||10)+1)}>+</button>
          <button className="mv-zoom-btn" onClick={()=>mapObj.current?.setZoom((mapObj.current.getZoom()||10)-1)}>−</button>
        </div>
      </div>

      {/* LAYER PANEL */}
      {showLayerPanel && (
        <div className="mv-layer-panel" onClick={e=>e.stopPropagation()}>
          <div className="mv-lp-head">
            <span className="mv-lp-title">⚓ NAUTICAL LAYERS</span>
            <button className="mv-lp-close" onClick={()=>setShowLayerPanel(false)}>✕</button>
          </div>
          {[
            {key:"dangers",  label:"Dangers & Hazards",   icon:"⛔",col:"#ff2244"},
            {key:"depths",   label:"Depth Contours",      icon:"🌊",col:"#0055aa"},
            {key:"regulated",label:"Regulated Areas",     icon:"⚠️",col:"#ffcc00"},
            {key:"tracks",   label:"Tracks & Routes",     icon:"🛣️",col:"#00aaff"},
            {key:"aids",     label:"Aids to Navigation",  icon:"💡",col:"#ffee44"},
            {key:"ports",    label:"Ports & Services",    icon:"⚓",col:"#44aaff"},
            {key:"tides",    label:"Tides & Currents",    icon:"🌊",col:"#00eeff"},
            {key:"cultural", label:"Bridges & Cables",    icon:"🌉",col:"#aaaaaa"},
            {key:"seabed",   label:"Seabed Hazards",      icon:"🪨",col:"#aa6600"},
            {key:"vesselProximity",label:"Proximity Alerts",icon:"📡",col:"#ff8800"},
            {key:"aiTrajectory",label:"AI Trajectory Fill",icon:"🤖",col:"#7cdcff"},
          ].map(({key,label,icon,col})=>(
            <div key={key} className={`mv-lp-row ${layers[key]?"mv-lp-on":""}`} onClick={()=>toggleLayer(key)}>
              <span className="mv-lp-icon">{icon}</span>
              <span className="mv-lp-label">{label}</span>
              <div className="mv-lp-toggle" style={{"--tc":col}}>
                <div className={`mv-lp-knob ${layers[key]?"mv-lp-knob-on":""}`}/>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ALERT PANEL */}
      {alerts.length>0 && showAlerts && (
        <div className="mv-alert-panel" onClick={e=>e.stopPropagation()}>
          {/* Radar sweep animation */}
          <div className="mv-ap-radar">
            <div className="mv-ap-radar-sweep"/>
            <div className="mv-ap-radar-ring mv-ap-radar-r1"/>
            <div className="mv-ap-radar-ring mv-ap-radar-r2"/>
            <div className="mv-ap-radar-dot"/>
          </div>
          <div className="mv-ap-head">
            <div className="mv-ap-title-row">
              <span className="mv-ap-title">⚡ COLLISION ALERTS</span>
              <div className="mv-ap-badges">
                {dangerCount>0&&<span className="mv-ap-badge mv-ap-danger">🚨 {dangerCount}</span>}
                {warnCount>0&&<span className="mv-ap-badge mv-ap-warn">⚠️ {warnCount}</span>}
              </div>
            </div>
            <button className="mv-ap-close" onClick={e=>{e.stopPropagation();setShowAlerts(false);}}>✕</button>
          </div>
          <div className="mv-ap-list">
            {(showAllAlerts ? alerts : alerts.slice(0,5)).map((a,i)=>(
              <div key={i}
                className={`mv-ap-item mv-ap-${a.level}`}
                onClick={e=>{
                  e.stopPropagation();
                  if(a.lat&&a.lng&&mapObj.current){
                    mapObj.current.panTo({lat:a.lat,lng:a.lng});
                    mapObj.current.setZoom(15);
                  }
                  if(a.imo) onVesselClick(vessels.find(v=>v.imo_number===a.imo||String(v.imo_number)===String(a.imo))||null);
                }}
              >
                <div className="mv-ap-item-left">
                  <span className={`mv-ap-level-dot mv-ap-dot-${a.level}`}/>
                  <div>
                    <div className="mv-ap-vessel">{a.vessel||"Unknown"}</div>
                    <div className="mv-ap-detail">{a.detail}</div>
                  </div>
                </div>
                <span className="mv-ap-arrow">›</span>
              </div>
            ))}
            {alerts.length>5&&(
              <button className="mv-ap-more-btn" onClick={e=>{e.stopPropagation();setShowAllAlerts(x=>!x);}}>
                {showAllAlerts ? "▲ Show less" : `▼ +${alerts.length-5} more`}
              </button>
            )}
          </div>
          <div className="mv-ap-footer">
            <span>LIVE MONITORING · {alerts.length} ACTIVE</span>
          </div>
        </div>
      )}
      {alerts.length>0&&!showAlerts&&(
        <button className="mv-ap-bubble" onClick={e=>{e.stopPropagation();setShowAlerts(true);setShowAllAlerts(false);}}>
          <span className="mv-ap-bubble-ping"/>
          🚨 <span>{dangerCount>0?dangerCount:alerts.length}</span>
          <span className="mv-ap-bubble-label">DANGER</span>
        </button>
      )}

      {/* AI BADGE */}
      {aiStats&&layers.aiTrajectory&&(
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
          <span className="mv-live-dot"/>
          <span className="mv-bh-count">{liveCount.toLocaleString()}</span>
          <span className="mv-bh-label">LIVE</span>
        </div>
        {trailData?.length>0&&(
          <div className="mv-bh-trail">
            🛤️ <span>{trailData.length} pts</span>
            {selectedVessel&&<span className="mv-bh-tname">{selectedVessel.vessel_name}</span>}
          </div>
        )}
        {coords&&!IS_MOBILE&&(
          <div className="mv-bh-coords">
            {coords.lat}°N · {coords.lng}°E
            {(()=>{const r=getRegionName(parseFloat(coords.lat),parseFloat(coords.lng));return r?<span className="mv-bh-region"> · {r}</span>:null;})()}
          </div>
        )}
      </div>

      {/* RANGE LEGEND */}
      <div className="mv-range-legend">
        <div className="mv-rl-row"><span className="mv-rl-dot" style={{background:"#ff2244"}}/><span>DANGER &lt;{RADIUS.DANGER}m</span></div>
        <div className="mv-rl-row"><span className="mv-rl-dot" style={{background:"#ffaa00"}}/><span>CAUTION &lt;{RADIUS.WARNING}m</span></div>
        <div className="mv-rl-row"><span className="mv-rl-dot" style={{background:"#00cc44"}}/><span>SAFE</span></div>
        {layers.aiTrajectory&&<div className="mv-rl-row"><span className="mv-rl-dot" style={{background:"#7cdcff"}}/><span>AI FILLED</span></div>}
      </div>
    </div>
  );
});

export default MapView;

function dangerInfoContent(f){return `<div style="font-family:'JetBrains Mono',monospace;background:#1a0010;border:1px solid #ff2244;border-radius:8px;padding:10px 14px;color:#fff;min-width:200px"><div style="color:#ff2244;font-weight:700;font-size:12px">⛔ DANGER / HAZARD</div><div style="margin-top:6px;font-size:11px">${f.name||"Unknown Hazard"}</div>${f.depth!==undefined&&f.depth!==null?`<div style="font-size:10px;color:#ff8899;margin-top:3px">Depth: ${f.depth}m</div>`:""}${f.info?`<div style="margin-top:4px;font-size:9px;color:#cc8888">${String(f.info).substring(0,200)}</div>`:""}</div>`;}

const CLEAN_MAP_STYLE=[{elementType:"geometry",stylers:[{color:"#e8e8e8"}]},{featureType:"water",elementType:"geometry",stylers:[{color:"#b0c8d8"}]},{featureType:"poi",stylers:[{visibility:"off"}]},{featureType:"transit",stylers:[{visibility:"off"}]},{elementType:"labels.icon",stylers:[{visibility:"off"}]}];
const DARK_NAUTICAL_STYLE=[
  {elementType:"geometry",stylers:[{color:"#0d1a28"}]},
  {elementType:"labels.text.fill",stylers:[{color:"#3d6a8a"}]},
  {elementType:"labels.text.stroke",stylers:[{color:"#040810"}]},
  {featureType:"water",elementType:"geometry",stylers:[{color:"#071828"}]},
  {featureType:"water",elementType:"labels.text.fill",stylers:[{color:"#1a4a6a"}]},
  {featureType:"landscape",elementType:"geometry",stylers:[{color:"#111e2c"}]},
  {featureType:"landscape.natural",elementType:"geometry",stylers:[{color:"#0d1a28"}]},
  {featureType:"road",stylers:[{visibility:"off"}]},
  {featureType:"poi",stylers:[{visibility:"off"}]},
  {featureType:"transit",stylers:[{visibility:"off"}]},
  {elementType:"labels.icon",stylers:[{visibility:"off"}]},
  {featureType:"administrative.country",elementType:"geometry.stroke",stylers:[{color:"#1a3a5a"},{weight:0.8}]},
  {featureType:"administrative.locality",elementType:"labels.text.fill",stylers:[{color:"#2a5a7a"},{visibility:"simplified"}]},
];