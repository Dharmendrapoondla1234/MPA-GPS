// src/components/MapView.jsx
import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Loader } from "@googlemaps/js-api-loader";
import { MarkerClusterer } from "@googlemaps/markerclusterer";
import {
  buildInfoWindowContent,
  getSpeedColor,
  getRegionName,
} from "../utils/vesselUtils";
import "./MapView.css";

const MAP_CENTER = { lat: 1.35, lng: 103.82 };
let loaderPromise = null;

function smoothMove(marker, newLat, newLng, ms = 1800) {
  const from = marker.getPosition();
  if (!from) {
    marker.setPosition({ lat: newLat, lng: newLng });
    return;
  }
  const dLat = newLat - from.lat(),
    dLng = newLng - from.lng();
  if (Math.abs(dLat) < 0.00001 && Math.abs(dLng) < 0.00001) return;
  const t0 = performance.now(),
    lat0 = from.lat(),
    lng0 = from.lng();
  const step = (now) => {
    const p = Math.min((now - t0) / ms, 1);
    const e = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
    marker.setPosition({ lat: lat0 + dLat * e, lng: lng0 + dLng * e });
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Vessel icon: arrow for moving, circle for stopped — colored by speed
function getVesselIcon(vessel, isSelected = false) {
  const color = getSpeedColor(vessel.speed);
  const heading = parseFloat(vessel.heading) || 0;
  const speed = parseFloat(vessel.speed) || 0;

  if (speed > 0.5) {
    // Moving vessel — directional arrow
    return {
      path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: isSelected ? 11 : 7,
      rotation: heading,
      fillColor: color,
      fillOpacity: 1,
      strokeColor: isSelected ? "#ffffff" : "rgba(0,0,0,0.6)",
      strokeWeight: isSelected ? 2.5 : 1,
    };
  } else {
    // Stopped vessel — small circle
    return {
      path: window.google.maps.SymbolPath.CIRCLE,
      scale: isSelected ? 9 : 5,
      fillColor: color,
      fillOpacity: 0.85,
      strokeColor: isSelected ? "#ffffff" : "rgba(0,0,0,0.5)",
      strokeWeight: isSelected ? 2 : 1,
    };
  }
}

const MapView = forwardRef(function MapView({
  vessels,
  selectedVessel,
  onVesselClick,
  trailData,
}, ref) {
  const mapRef = useRef(null);
  const mapObj = useRef(null);
  const markersRef = useRef({});
  const clusterer = useRef(null);
  const infoWin = useRef(null);
  const hoverWin = useRef(null);
  const trailObjs = useRef([]);
  const pulseCirc = useRef(null);
  const pulseTimer = useRef(null);
  const seaOverlay = useRef(null);
  const [coords, setCoords] = useState(null);
  // Default: satellite hybrid (like Image 2)
  const [mapStyle, setMapStyle] = useState("satellite");

  // Expose panToVessel so App.jsx can pan map from search
  useImperativeHandle(ref, () => ({
    panToVessel(vessel) {
      const lat = Number(vessel?.latitude_degrees);
      const lng = Number(vessel?.longitude_degrees);
      if (mapObj.current && lat && lng) {
        mapObj.current.panTo({ lat, lng });
        mapObj.current.setZoom(13);
      }
    }
  }));

  // ── INIT MAP ────────────────────────────────────────────────
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

      // Start in SATELLITE/HYBRID mode (Image 2 style)
      const map = new window.google.maps.Map(mapRef.current, {
        center: MAP_CENTER,
        zoom: 10,
        mapTypeId: "hybrid", // ← satellite with labels
        zoomControl: true,
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false,
        rotateControl: false,
        styles: [],
      });
      mapObj.current = map;

      infoWin.current = new window.google.maps.InfoWindow({ maxWidth: 310 });
      hoverWin.current = new window.google.maps.InfoWindow({
        maxWidth: 240,
        disableAutoPan: true,
      });

      // OpenSeaMap nautical overlay (shipping lanes, depth marks)
      const seaLayer = new window.google.maps.ImageMapType({
        getTileUrl: (coord, zoom) =>
          `https://tiles.openseamap.org/seamark/${zoom}/${coord.x}/${coord.y}.png`,
        tileSize: new window.google.maps.Size(256, 256),
        opacity: 0.35,
        maxZoom: 18,
        name: "OpenSeaMap",
      });
      map.overlayMapTypes.insertAt(0, seaLayer);
      seaOverlay.current = seaLayer;

      map.addListener("mousemove", (e) =>
        setCoords({
          lat: e.latLng.lat().toFixed(5),
          lng: e.latLng.lng().toFixed(5),
        }),
      );
      map.addListener("click", () => {
        infoWin.current.close();
        hoverWin.current.close();
      });

      // ── Cluster renderer — small, clean, no big cyan rings ──
      clusterer.current = new MarkerClusterer({
        map,
        markers: [],
        renderer: {
          render({ count, position }) {
            const size =
              count < 10 ? 24 : count < 50 ? 28 : count < 200 ? 32 : 38;
            return new window.google.maps.Marker({
              position,
              icon: {
                path: window.google.maps.SymbolPath.CIRCLE,
                scale: size / 2,
                fillColor: "rgba(255,255,255,0.15)",
                fillOpacity: 1,
                strokeColor: "rgba(255,255,255,0.6)",
                strokeWeight: 1.5,
              },
              label: {
                text:
                  count > 999 ? `${(count / 1000).toFixed(1)}k` : String(count),
                color: "#ffffff",
                fontSize: count < 10 ? "10px" : "11px",
                fontFamily: "'JetBrains Mono',monospace",
                fontWeight: "700",
              },
              zIndex: 999,
            });
          },
        },
      });
    });
  }, []);

  // ── UPDATE MARKERS — smooth move, no flicker ──────────────
  useEffect(() => {
    if (!mapObj.current || !clusterer.current) return;
    const activeIds = new Set(vessels.map((v) => String(v.imo_number)));
    const selId = selectedVessel?.imo_number;

    // Remove stale markers
    Object.keys(markersRef.current).forEach((id) => {
      if (!activeIds.has(id)) {
        markersRef.current[id].setMap(null);
        delete markersRef.current[id];
      }
    });

    vessels.forEach((v) => {
      const lat = Number(v.latitude_degrees);
      const lng = Number(v.longitude_degrees);
      if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;
      const id = String(v.imo_number);
      const isSel = v.imo_number === selId;

      if (markersRef.current[id]) {
        // Existing marker — animate position, update icon
        smoothMove(markersRef.current[id], lat, lng);
        markersRef.current[id].setIcon(getVesselIcon(v, isSel));
        markersRef.current[id].setZIndex(isSel ? 1000 : 10);
        markersRef.current[id]._vessel = v;
      } else {
        // New marker
        const m = new window.google.maps.Marker({
          position: { lat, lng },
          icon: getVesselIcon(v, isSel),
          title: v.vessel_name || "Vessel",
          optimized: false,
          zIndex: isSel ? 1000 : 10,
        });
        m._vessel = v;

        // Click → info window + detail panel
        m.addListener("click", () => {
          hoverWin.current.close();
          infoWin.current.setContent(buildInfoWindowContent(v));
          infoWin.current.open(mapObj.current, m);
          onVesselClick(v);
        });

        // Hover → quick tooltip
        m.addListener("mouseover", () => {
          const vessel = m._vessel;
          const spd = parseFloat(vessel.speed || 0);
          const col = getSpeedColor(spd);
          const region = getRegionName(
            parseFloat(vessel.latitude_degrees || 0),
            parseFloat(vessel.longitude_degrees || 0),
          );
          hoverWin.current.setContent(`
            <div style="font-family:'JetBrains Mono',monospace;background:#0b1525;border:1px solid ${col}66;border-radius:10px;padding:9px 13px;min-width:175px;color:#f0f8ff;box-shadow:0 8px 28px rgba(0,0,0,0.85)">
              <div style="font-size:12px;font-weight:700;color:#00e5ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:195px">${vessel.vessel_name || "Unknown Vessel"}</div>
              <div style="margin-top:5px;display:flex;align-items:center;gap:10px">
                <span style="font-size:14px;font-weight:700;color:${col}">${spd.toFixed(1)} kn</span>
                <span style="font-size:9px;color:#6a9ab0">${vessel.heading || 0}° HDG</span>
                <span style="font-size:9px;color:#6a9ab0">${vessel.flag || ""}</span>
              </div>
              ${region ? `<div style="font-size:9px;color:#00e5ff;margin-top:4px">📍 ${region}</div>` : ""}
              <div style="margin-top:4px;font-size:8px;color:#3d6a8a;font-style:italic">Click for full details</div>
            </div>
          `);
          hoverWin.current.open(mapObj.current, m);
        });
        m.addListener("mouseout", () => hoverWin.current.close());

        markersRef.current[id] = m;
      }
    });

    clusterer.current.clearMarkers();
    clusterer.current.addMarkers(Object.values(markersRef.current));
  }, [vessels, selectedVessel, onVesselClick]);

  // ── SELECTED VESSEL PULSE RING ───────────────────────────────
  useEffect(() => {
    clearInterval(pulseTimer.current);
    if (pulseCirc.current) {
      pulseCirc.current.setMap(null);
      pulseCirc.current = null;
    }
    if (!selectedVessel || !mapObj.current) return;

    const lat = Number(selectedVessel.latitude_degrees);
    const lng = Number(selectedVessel.longitude_degrees);
    if (!lat || !lng) return;

    mapObj.current.panTo({ lat, lng });

    // Refresh all icons so selected vessel stands out
    Object.values(markersRef.current).forEach((m) => {
      if (m._vessel) {
        const isSel = m._vessel.imo_number === selectedVessel.imo_number;
        m.setIcon(getVesselIcon(m._vessel, isSel));
        m.setZIndex(isSel ? 1000 : 10);
      }
    });

    const color = getSpeedColor(selectedVessel.speed);
    pulseCirc.current = new window.google.maps.Circle({
      center: { lat, lng },
      radius: 600,
      fillColor: color,
      fillOpacity: 0.07,
      strokeColor: color,
      strokeOpacity: 0.8,
      strokeWeight: 2,
      map: mapObj.current,
      zIndex: 5,
    });
    let r = 600,
      grow = true;
    pulseTimer.current = setInterval(() => {
      if (!pulseCirc.current) return;
      if (grow) {
        r += 50;
        if (r > 1200) grow = false;
      } else {
        r -= 50;
        if (r < 600) grow = true;
      }
      try {
        pulseCirc.current.setRadius(r);
      } catch (_) {}
    }, 80);

    return () => {
      clearInterval(pulseTimer.current);
      if (pulseCirc.current) {
        pulseCirc.current.setMap(null);
        pulseCirc.current = null;
      }
    };
  }, [selectedVessel]);

  // ── TRAIL ────────────────────────────────────────────────────
  useEffect(() => {
    trailObjs.current.forEach((o) => {
      try {
        o.setMap(null);
      } catch (_) {}
    });
    trailObjs.current = [];
    if (!trailData?.length || !mapObj.current) return;

    const pts = trailData
      .map((p) => ({
        lat: Number(p.latitude_degrees ?? p.lat ?? 0),
        lng: Number(p.longitude_degrees ?? p.lng ?? 0),
        spd: parseFloat(p.speed ?? 0),
        ts: p.effective_timestamp,
      }))
      .filter((p) => p.lat && p.lng && !isNaN(p.lat) && !isNaN(p.lng));

    if (pts.length < 2) return;

    // Gradient trail — dark blue (old) → bright white/cyan (recent)
    const SEG = Math.min(pts.length - 1, 50);
    const step = Math.max(1, Math.floor((pts.length - 1) / SEG));
    for (let i = 0; i < pts.length - 1; i += step) {
      const end = Math.min(i + step + 1, pts.length);
      const prog = i / (pts.length - 1);
      // Old = dark navy, recent = bright white-cyan
      const r = Math.round(prog * 100);
      const g = Math.round(150 + prog * 105);
      const b = Math.round(200 + prog * 55);
      trailObjs.current.push(
        new window.google.maps.Polyline({
          path: pts.slice(i, end),
          geodesic: true,
          strokeColor: `rgb(${r},${g},${b})`,
          strokeOpacity: 0.25 + prog * 0.75,
          strokeWeight: 1.5 + prog * 3.5,
          map: mapObj.current,
          zIndex: 3,
        }),
      );
    }

    // Direction arrows along trail
    const arrowStep = Math.max(1, Math.floor(pts.length / 12));
    for (let i = arrowStep; i < pts.length; i += arrowStep) {
      trailObjs.current.push(
        new window.google.maps.Polyline({
          path: [pts[i - 1], pts[i]],
          strokeOpacity: 0,
          icons: [
            {
              icon: {
                path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                scale: 3,
                fillColor: "#ffffff",
                fillOpacity: 0.85,
                strokeColor: "#0a1a2e",
                strokeWeight: 1,
              },
              offset: "100%",
            },
          ],
          map: mapObj.current,
          zIndex: 4,
        }),
      );
    }

    // ⚓ Start point — departure
    const startPt = pts[0];
    const startRegion = getRegionName(startPt.lat, startPt.lng) || "Departure";
    trailObjs.current.push(
      new window.google.maps.Marker({
        position: startPt,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: "#ffffff",
          fillOpacity: 1,
          strokeColor: "#00aaff",
          strokeWeight: 3,
        },
        title: `Departed: ${startRegion}`,
        map: mapObj.current,
        zIndex: 8,
      }),
    );
    const startInfo = new window.google.maps.InfoWindow({
      content: `<div style="font-family:'JetBrains Mono',monospace;font-size:10px;background:#0b1a2e;color:#60cfff;border:1px solid #60cfff55;font-weight:800;padding:5px 10px;border-radius:5px;white-space:nowrap">⚓ ${startRegion}</div>`,
      position: startPt,
      pixelOffset: new window.google.maps.Size(0, -20),
    });
    startInfo.open(mapObj.current);
    trailObjs.current.push(startInfo);

    // 📍 End point — current position
    const endPt = pts[pts.length - 1];
    const endRegion = getRegionName(endPt.lat, endPt.lng) || "Current Position";
    trailObjs.current.push(
      new window.google.maps.Marker({
        position: endPt,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: "#00e5ff",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2.5,
        },
        title: `Current: ${endRegion}`,
        map: mapObj.current,
        zIndex: 9,
      }),
    );
    const endInfo = new window.google.maps.InfoWindow({
      content: `<div style="font-family:'JetBrains Mono',monospace;font-size:10px;background:#cc1133;color:#fff;font-weight:800;padding:5px 10px;border-radius:5px;white-space:nowrap">📍 ${endRegion}</div>`,
      position: endPt,
      pixelOffset: new window.google.maps.Size(0, -22),
    });
    endInfo.open(mapObj.current);
    trailObjs.current.push(endInfo);

    // Fit map to trail
    const bounds = new window.google.maps.LatLngBounds();
    pts.forEach((p) => bounds.extend(p));
    mapObj.current.fitBounds(bounds, { padding: 90 });
  }, [trailData]);

  // ── MAP STYLE TOGGLE ─────────────────────────────────────────
  // 3 modes: satellite (default) → clean map → nautical dark
  const cycleStyle = useCallback(() => {
    if (!mapObj.current) return;
    const next = { satellite: "map", map: "dark", dark: "satellite" }[mapStyle];

    if (next === "satellite") {
      // Google satellite + labels (hybrid)
      mapObj.current.setMapTypeId("hybrid");
      mapObj.current.setOptions({ styles: [] });
      // Keep OpenSeaMap overlay
      if (
        mapObj.current.overlayMapTypes.getLength() === 0 &&
        seaOverlay.current
      ) {
        mapObj.current.overlayMapTypes.insertAt(0, seaOverlay.current);
      }
    } else if (next === "map") {
      // Clean grey map (like Image 3) — no roads highlighted, sea lanes visible
      mapObj.current.setMapTypeId("roadmap");
      mapObj.current.setOptions({ styles: CLEAN_MAP_STYLE });
    } else {
      // Dark nautical
      mapObj.current.setMapTypeId("roadmap");
      mapObj.current.setOptions({ styles: DARK_NAUTICAL_STYLE });
    }
    setMapStyle(next);
  }, [mapStyle]);

  const STYLE_LABEL = { satellite: "🛰️ SAT", map: "🗺️ MAP", dark: "🌑 DARK" };

  return (
    <div className="mv-root">
      <div ref={mapRef} className="mv-map" />

      {/* Style toggle button */}
      <button className="mv-btn mv-style-btn" onClick={cycleStyle}>
        {STYLE_LABEL[mapStyle]}
      </button>

      {/* Vessel count HUD */}
      <div className="mv-hud mv-count-hud">
        <span className="mv-dot-live" />
        {vessels.length.toLocaleString()} vessels live
      </div>

      {/* Trail info HUD */}
      {trailData?.length > 0 && (
        <div className="mv-hud mv-trail-hud">
          🛤️ {trailData.length} track pts · {selectedVessel?.vessel_name || ""}
        </div>
      )}

      {/* Coordinates + region */}
      {coords && <CoordsHUD lat={coords.lat} lng={coords.lng} />}
    </div>
  );
});

export default MapView;

// ── MAP STYLES ───────────────────────────────────────────────

// Clean grey map — like Image 3 (minimal, sea lanes visible, no road colors)

const CLEAN_MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#e8e8e8" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#666666" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#ffffff" }] },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#b0c8d8" }],
  },
  {
    featureType: "water",
    elementType: "labels.text.fill",
    stylers: [{ color: "#4a7a9a" }],
  },
  {
    featureType: "landscape",
    elementType: "geometry",
    stylers: [{ color: "#d8d8d8" }],
  },
  {
    featureType: "landscape.natural.landcover",
    elementType: "geometry",
    stylers: [{ color: "#d0d8d0" }],
  },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#cccccc" }],
  },
  {
    featureType: "road",
    elementType: "geometry.stroke",
    stylers: [{ color: "#bbbbbb" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry",
    stylers: [{ color: "#c8c8c8" }],
  },
  {
    featureType: "road",
    elementType: "labels",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "administrative",
    elementType: "geometry.stroke",
    stylers: [{ color: "#aaaaaa" }, { weight: 0.8 }],
  },
  {
    featureType: "administrative.country",
    elementType: "labels.text.fill",
    stylers: [{ color: "#555555" }],
  },
  {
    featureType: "administrative.locality",
    elementType: "labels.text.fill",
    stylers: [{ color: "#444444" }],
  },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
];

// Dark nautical — command center style
const DARK_NAUTICAL_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#0a1628" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#4a7a9b" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#06111d" }] },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#03070e" }],
  },
  {
    featureType: "water",
    elementType: "labels.text.fill",
    stylers: [{ color: "#1a3a5c" }],
  },
  {
    featureType: "landscape",
    elementType: "geometry",
    stylers: [{ color: "#0a1820" }],
  },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#0e1e30" }],
  },
  {
    featureType: "administrative.country",
    elementType: "labels.text.fill",
    stylers: [{ color: "#2a5a7a" }],
  },
  {
    featureType: "administrative.locality",
    elementType: "labels.text.fill",
    stylers: [{ color: "#1a4a6a" }],
  },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
];

function CoordsHUD({ lat, lng }) {
  const region = getRegionName(parseFloat(lat), parseFloat(lng));
  return (
    <div className="mv-coords">
      {lat}° N &nbsp;{lng}° E
      {region && <span className="mv-region"> · {region}</span>}
    </div>
  );
}

