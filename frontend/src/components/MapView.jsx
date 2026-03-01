// src/components/MapView.jsx
import React, { useEffect, useRef, useState, useCallback } from "react";
import { Loader } from "@googlemaps/js-api-loader";
import { MarkerClusterer } from "@googlemaps/markerclusterer";
import {
  getVesselIcon,
  buildInfoWindowContent,
  getSpeedColor,
} from "../utils/vesselUtils";
import "./MapView.css";

const MAP_CENTER = { lat: 1.35, lng: 103.82 };
const MAP_ZOOM = 9;
let googleLoaded = false;

function smoothMove(marker, newLat, newLng, ms = 1600) {
  const from = marker.getPosition();
  if (!from) {
    marker.setPosition({ lat: newLat, lng: newLng });
    return;
  }
  const dLat = newLat - from.lat();
  const dLng = newLng - from.lng();
  if (Math.abs(dLat) < 0.00001 && Math.abs(dLng) < 0.00001) return;
  const t0 = performance.now();
  const lat0 = from.lat(),
    lng0 = from.lng();
  const step = (now) => {
    const p = Math.min((now - t0) / ms, 1);
    const e = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
    marker.setPosition({ lat: lat0 + dLat * e, lng: lng0 + dLng * e });
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export default function MapView({
  vessels,
  selectedVessel,
  onVesselClick,
  trailData,
}) {
  const mapRef = useRef(null);
  const mapObj = useRef(null);
  const markersRef = useRef({});
  const clusterer = useRef(null);
  const infoWin = useRef(null);
  const trailObjs = useRef([]);
  const pulseCirc = useRef(null);
  const pulseTimer = useRef(null);
  const [coords, setCoords] = useState(null);
  const [mapStyle, setMapStyle] = useState("nautical");

  // ── INIT ──────────────────────────────────────────────────
  useEffect(() => {
    if (googleLoaded || mapObj.current) return;
    new Loader({
      apiKey: process.env.REACT_APP_GOOGLE_MAPS_KEY || "",
      version: "weekly",
      libraries: ["geometry"],
    })
      .load()
      .then(() => {
        googleLoaded = true;
        const map = new window.google.maps.Map(mapRef.current, {
          center: MAP_CENTER,
          zoom: MAP_ZOOM,
          mapTypeId: "roadmap",
          zoomControl: true,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
          scaleControl: true,
          styles: NAUTICAL_STYLE,
        });
        mapObj.current = map;
        infoWin.current = new window.google.maps.InfoWindow({ maxWidth: 290 });

        // OpenSeaMap nautical overlay — free tile layer showing sea routes/depths
        map.overlayMapTypes.insertAt(
          0,
          new window.google.maps.ImageMapType({
            getTileUrl: (coord, zoom) =>
              `https://tiles.openseamap.org/seamark/${zoom}/${coord.x}/${coord.y}.png`,
            tileSize: new window.google.maps.Size(256, 256),
            opacity: 0.65,
            maxZoom: 17,
          }),
        );

        map.addListener("mousemove", (e) =>
          setCoords({
            lat: e.latLng.lat().toFixed(5),
            lng: e.latLng.lng().toFixed(5),
          }),
        );
        map.addListener("click", () => infoWin.current.close());

        clusterer.current = new MarkerClusterer({
          map,
          markers: [],
          renderer: {
            render({ count, position }) {
              return new window.google.maps.Marker({
                position,
                icon: {
                  path: window.google.maps.SymbolPath.CIRCLE,
                  scale: Math.min(14 + Math.log(count) * 5, 40),
                  fillColor: "#00e5ff",
                  fillOpacity: 0.14,
                  strokeColor: "#00e5ff",
                  strokeWeight: 1.5,
                },
                label: {
                  text:
                    count > 999
                      ? `${Math.floor(count / 1000)}k`
                      : String(count),
                  color: "#00e5ff",
                  fontSize: "11px",
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

  // ── MARKERS ───────────────────────────────────────────────
  useEffect(() => {
    if (!mapObj.current || !clusterer.current) return;
    const activeIds = new Set(vessels.map((v) => String(v.imo_number)));
    Object.keys(markersRef.current).forEach((id) => {
      if (!activeIds.has(id)) {
        markersRef.current[id].setMap(null);
        delete markersRef.current[id];
      }
    });
    const selId = selectedVessel?.imo_number;
    vessels.forEach((v) => {
      const lat = Number(v.latitude_degrees);
      const lng = Number(v.longitude_degrees);
      if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;
      const id = String(v.imo_number);
      const isSel = v.imo_number === selId;
      if (markersRef.current[id]) {
        smoothMove(markersRef.current[id], lat, lng);
        markersRef.current[id].setIcon(getVesselIcon(v, isSel));
        markersRef.current[id].setZIndex(isSel ? 1000 : 10);
        markersRef.current[id]._vessel = v;
      } else {
        const m = new window.google.maps.Marker({
          position: { lat, lng },
          icon: getVesselIcon(v, isSel),
          title: v.vessel_name || "Vessel",
          optimized: false,
          zIndex: isSel ? 1000 : 10,
        });
        m._vessel = v;
        m.addListener("click", () => {
          infoWin.current.setContent(buildInfoWindowContent(v));
          infoWin.current.open(mapObj.current, m);
          onVesselClick(v);
        });
        markersRef.current[id] = m;
      }
    });
    clusterer.current.clearMarkers();
    clusterer.current.addMarkers(Object.values(markersRef.current));
  }, [vessels, selectedVessel, onVesselClick]);

  // ── SELECTED VESSEL PULSE ─────────────────────────────────
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
    Object.values(markersRef.current).forEach((m) => {
      if (m._vessel) {
        const s = m._vessel.imo_number === selectedVessel.imo_number;
        m.setIcon(getVesselIcon(m._vessel, s));
        m.setZIndex(s ? 1000 : 10);
      }
    });

    const color = getSpeedColor(selectedVessel.speed);
    pulseCirc.current = new window.google.maps.Circle({
      center: { lat, lng },
      radius: 700,
      fillColor: color,
      fillOpacity: 0.06,
      strokeColor: color,
      strokeOpacity: 0.7,
      strokeWeight: 2,
      map: mapObj.current,
      zIndex: 5,
    });
    let r = 700,
      grow = true;
    pulseTimer.current = setInterval(() => {
      if (!pulseCirc.current) return;
      if (grow) {
        r += 55;
        if (r > 1400) grow = false;
      } else {
        r -= 55;
        if (r < 700) grow = true;
      }
      try {
        pulseCirc.current.setRadius(r);
        pulseCirc.current.set("fillOpacity", 0.02 + (1400 - r) / 30000);
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

  // ── TRAIL ─────────────────────────────────────────────────
  useEffect(() => {
    trailObjs.current.forEach((o) => {
      try {
        o.setMap(null);
      } catch (_) {}
    });
    trailObjs.current = [];
    if (!trailData?.length || !mapObj.current) return;

    // Normalize all possible BigQuery field name variants
    const pts = trailData
      .map((p) => ({
        lat: Number(p.latitude_degrees ?? p.latitude ?? p.lat ?? 0),
        lng: Number(p.longitude_degrees ?? p.longitude ?? p.lon ?? p.lng ?? 0),
        spd: parseFloat(p.speed ?? p.sog ?? 0),
      }))
      .filter((p) => p.lat && p.lng && !isNaN(p.lat) && !isNaN(p.lng));

    if (pts.length < 2) return;

    // Gradient polyline: dark blue (old) → bright cyan (recent)
    const SEG = Math.min(pts.length - 1, 25);
    const step = Math.max(1, Math.floor((pts.length - 1) / SEG));
    for (let i = 0; i < pts.length - 1; i += step) {
      const end = Math.min(i + step + 1, pts.length);
      const prog = i / (pts.length - 1);
      const g = Math.round(80 + prog * 149)
        .toString(16)
        .padStart(2, "0");
      const b = Math.round(120 + prog * 135)
        .toString(16)
        .padStart(2, "0");
      trailObjs.current.push(
        new window.google.maps.Polyline({
          path: pts.slice(i, end),
          geodesic: true,
          strokeColor: `#00${g}${b}`,
          strokeOpacity: 0.25 + prog * 0.75,
          strokeWeight: 1.5 + prog * 3,
          map: mapObj.current,
          zIndex: 3,
        }),
      );
    }

    // Direction arrows
    const asp = Math.max(1, Math.floor(pts.length / 7));
    for (let i = asp; i < pts.length; i += asp) {
      trailObjs.current.push(
        new window.google.maps.Polyline({
          path: [pts[i - 1], pts[i]],
          strokeOpacity: 0,
          icons: [
            {
              icon: {
                path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                scale: 3,
                fillColor: "#00e5ff",
                fillOpacity: 0.85,
                strokeColor: "#001a26",
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

    // Start marker
    const startM = new window.google.maps.Marker({
      position: pts[0],
      icon: {
        path: window.google.maps.SymbolPath.CIRCLE,
        scale: 9,
        fillColor: "#ffffff",
        fillOpacity: 1,
        strokeColor: "#00e5ff",
        strokeWeight: 3,
      },
      title: "Journey Start",
      map: mapObj.current,
      zIndex: 8,
    });
    trailObjs.current.push(startM);

    // "JOURNEY START" label
    const startLabel = new window.google.maps.InfoWindow({
      content: `<div style="font-family:'JetBrains Mono',monospace;font-size:11px;
        background:#00e5ff;color:#001018;font-weight:800;padding:5px 10px;
        border-radius:6px;white-space:nowrap;letter-spacing:0.05em">⚓ JOURNEY START</div>`,
      position: pts[0],
      pixelOffset: new window.google.maps.Size(0, -16),
    });
    startLabel.open(mapObj.current);
    trailObjs.current.push(startLabel);

    // Fit bounds
    const bounds = new window.google.maps.LatLngBounds();
    pts.forEach((p) => bounds.extend(p));
    mapObj.current.fitBounds(bounds, { padding: 80 });
  }, [trailData]);

  // ── STYLE TOGGLE ──────────────────────────────────────────
  const cycleStyle = useCallback(() => {
    if (!mapObj.current) return;
    const next = { nautical: "dark", dark: "satellite", satellite: "nautical" }[
      mapStyle
    ];
    if (next === "satellite") {
      mapObj.current.setMapTypeId("hybrid");
      mapObj.current.setOptions({ styles: [] });
    } else {
      mapObj.current.setMapTypeId("roadmap");
      mapObj.current.setOptions({
        styles: next === "dark" ? DARK_STYLE : NAUTICAL_STYLE,
      });
    }
    setMapStyle(next);
  }, [mapStyle]);

  const ICONS = { nautical: "🗺️", dark: "🌑", satellite: "🛰️" };
  const NAMES = { nautical: "SEA", dark: "DARK", satellite: "SAT" };

  return (
    <div className="mv-root">
      <div ref={mapRef} className="mv-map" />
      <button className="mv-btn mv-style-btn" onClick={cycleStyle}>
        {ICONS[mapStyle]} {NAMES[mapStyle]}
      </button>
      <div className="mv-hud mv-count-hud">
        <span className="mv-dot-live" />
        {vessels.length.toLocaleString()} vessels
      </div>
      {trailData?.length > 0 && (
        <div className="mv-hud mv-trail-hud">
          📍 {trailData.length} track pts · {selectedVessel?.vessel_name || ""}
        </div>
      )}
      {coords && (
        <div className="mv-coords">
          {coords.lat}° N &nbsp; {coords.lng}° E
        </div>
      )}
    </div>
  );
}

// ── STYLES ────────────────────────────────────────────────

// Nautical: deep blue sea, green land — authentic chart look, no watermark
const NAUTICAL_STYLE = [
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#0d2b4e" }],
  },
  {
    featureType: "water",
    elementType: "labels.text.fill",
    stylers: [{ color: "#4a90c4" }],
  },
  {
    featureType: "water",
    elementType: "labels.text.stroke",
    stylers: [{ color: "#061525" }],
  },
  {
    featureType: "landscape",
    elementType: "geometry",
    stylers: [{ color: "#2d5a27" }],
  },
  {
    featureType: "landscape.natural",
    elementType: "geometry",
    stylers: [{ color: "#2a5524" }],
  },
  {
    featureType: "landscape.man_made",
    elementType: "geometry",
    stylers: [{ color: "#384830" }],
  },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#3a5030" }],
  },
  {
    featureType: "road",
    elementType: "geometry.stroke",
    stylers: [{ color: "#2a3a20" }],
  },
  {
    featureType: "road",
    elementType: "labels.text.fill",
    stylers: [{ color: "#6a9a60" }],
  },
  {
    featureType: "road",
    elementType: "labels.text.stroke",
    stylers: [{ color: "#0a1a08" }],
  },
  {
    featureType: "administrative",
    elementType: "geometry.stroke",
    stylers: [{ color: "#5a8a50" }, { weight: 1 }],
  },
  {
    featureType: "administrative.country",
    elementType: "labels.text.fill",
    stylers: [{ color: "#a0cca0" }],
  },
  {
    featureType: "administrative.locality",
    elementType: "labels.text.fill",
    stylers: [{ color: "#88bb88" }],
  },
  {
    featureType: "administrative.locality",
    elementType: "labels.text.stroke",
    stylers: [{ color: "#0d1f0d" }],
  },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  {
    elementType: "labels.text.stroke",
    stylers: [{ color: "#0a1a0a" }, { weight: 3 }],
  },
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
];

const DARK_STYLE = [
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
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#0e1e30" }],
  },
  {
    featureType: "road",
    elementType: "geometry.stroke",
    stylers: [{ color: "#081520" }],
  },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  {
    featureType: "administrative",
    elementType: "geometry",
    stylers: [{ color: "#0f2440" }],
  },
  {
    featureType: "landscape",
    elementType: "geometry",
    stylers: [{ color: "#0a1820" }],
  },
];
