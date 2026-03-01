// src/utils/vesselUtils.js
// FIXED: reads EXACT backend field names (mmsi_number, vessel_length, vessel_breadth)

export function getSpeedColor(speed) {
  const s = parseFloat(speed) || 0;
  if (s <= 0.5) return "#607d8b";
  if (s < 5)    return "#00ff9d";
  if (s < 12)   return "#ffaa00";
  return "#ff3355";
}

export function getVesselStatus(speed) {
  const s = parseFloat(speed) || 0;
  if (s <= 0.5) return { label: "Moored / Stopped", color: "#607d8b", icon: "⚓" };
  if (s < 5)    return { label: "Slow Speed",        color: "#00ff9d", icon: "🐢" };
  if (s < 12)   return { label: "Under Way",          color: "#ffaa00", icon: "⚡" };
  return               { label: "Full Ahead",          color: "#ff3355", icon: "🚀" };
}

export function getVesselIcon(vessel, isSelected = false) {
  return {
    path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
    scale: isSelected ? 11 : 7,
    rotation: parseFloat(vessel.heading) || 0,
    fillColor: getSpeedColor(vessel.speed),
    fillOpacity: 1,
    strokeColor: isSelected ? "#ffffff" : "rgba(0,0,0,0.5)",
    strokeWeight: isSelected ? 2.5 : 1.2,
  };
}

export function formatTimestamp(ts) {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    if (isNaN(d)) return String(ts);
    return d.toLocaleString("en-SG", {
      hour12: false, year: "numeric", month: "short",
      day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch { return String(ts); }
}

export function getFlagEmoji(code) {
  if (!code || code.length !== 2) return "🏴";
  try {
    const offset = 127397;
    return String.fromCodePoint(
      code.toUpperCase().charCodeAt(0) + offset,
      code.toUpperCase().charCodeAt(1) + offset
    );
  } catch { return "🏴"; }
}

const TYPE_MAP = {
  TU:"Tug", CH:"Chemical Tanker", BA:"Barge", FB:"Ferry/Boat",
  TA:"Tanker", FR:"Freighter", BC:"Bulk Carrier", LC:"Launch/Craft",
  PV:"Passenger", FV:"Fishing", CS:"Container Ship", RO:"Ro-Ro",
  GB:"General Cargo", LT:"LNG/LPG Tanker", CV:"Cargo Vessel",
  MT:"Motor Tanker", MV:"Motor Vessel", DR:"Dredger", TK:"Tanker",
  PC:"Patrol Craft", WV:"Work Vessel", SV:"Support Vessel",
};
export function getVesselTypeLabel(code) {
  if (!code) return "Unknown";
  return TYPE_MAP[code] || TYPE_MAP[String(code).toUpperCase()] || code;
}

const COUNTRY_MAP = {
  SG:"Singapore", MY:"Malaysia", US:"United States", GB:"United Kingdom",
  CN:"China", JP:"Japan", KR:"South Korea", IN:"India", ID:"Indonesia",
  TH:"Thailand", VN:"Vietnam", PH:"Philippines", AU:"Australia",
  MH:"Marshall Islands", PA:"Panama", LR:"Liberia", BS:"Bahamas",
  MT:"Malta", CY:"Cyprus", GR:"Greece", NO:"Norway", DK:"Denmark",
  DE:"Germany", NL:"Netherlands", FR:"France", IT:"Italy", ES:"Spain",
  TR:"Turkey", SA:"Saudi Arabia", AE:"UAE", HK:"Hong Kong", BR:"Brazil",
  MX:"Mexico", CA:"Canada", RU:"Russia", TW:"Taiwan", CM:"Cameroon",
  BD:"Bangladesh", PK:"Pakistan", LK:"Sri Lanka", MM:"Myanmar",
};
export function getCountryName(code) {
  return COUNTRY_MAP[code?.toUpperCase()] || code || "Unknown";
}

export function calcDistanceNM(lat1, lng1, lat2, lng2) {
  const R = 3440.065;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function animateMarker(marker, newPos, ms = 1600) {
  const from = marker.getPosition();
  if (!from) { marker.setPosition(newPos); return; }
  const dLat = newPos.lat - from.lat();
  const dLng = newPos.lng - from.lng();
  if (Math.abs(dLat) < 0.00001 && Math.abs(dLng) < 0.00001) return;
  const t0 = performance.now();
  const lat0 = from.lat(), lng0 = from.lng();
  const step = (now) => {
    const p = Math.min((now - t0) / ms, 1);
    const e = p < 0.5 ? 2*p*p : -1+(4-2*p)*p;
    marker.setPosition({ lat: lat0 + dLat*e, lng: lng0 + dLng*e });
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// InfoWindow using EXACT backend field names
export function buildInfoWindowContent(v) {
  const name   = v.vessel_name    || "Unknown Vessel";
  const imo    = v.imo_number     || "—";
  const mmsi   = v.mmsi_number    || "—";       // ← mmsi_NUMBER
  const speed  = parseFloat(v.speed || 0);
  const heading= v.heading        || 0;
  const flag   = v.flag           || "";
  const vtype  = v.vessel_type    || "";
  const len    = v.vessel_length  || null;       // ← vessel_LENGTH
  const beam   = v.vessel_breadth || null;       // ← vessel_BREADTH
  const grossT = v.gross_tonnage  || null;
  const dw     = v.deadweight     || null;
  const ts     = v.effective_timestamp || null;

  const st  = getVesselStatus(speed);
  const col = st.color;
  const fe  = getFlagEmoji(flag);

  return `<div style="
    font-family:'Rajdhani',sans-serif;
    background:linear-gradient(145deg,#0b1525,#0f1e35);
    border:1px solid rgba(0,229,255,0.28);border-radius:14px;overflow:hidden;
    min-width:260px;max-width:285px;color:#f0f8ff;
    box-shadow:0 20px 60px rgba(0,0,0,0.9);">
    <div style="padding:12px 14px 10px;border-bottom:1px solid rgba(0,229,255,0.07)">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:24px">${fe}</span>
        <div style="flex:1;min-width:0">
          <div style="font-family:'Orbitron',monospace;font-size:12px;font-weight:700;
            color:#00e5ff;letter-spacing:0.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${name}</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#3d6a8a;margin-top:2px">
            IMO ${imo} · MMSI ${mmsi}</div>
        </div>
      </div>
      <div style="margin-top:8px;display:inline-flex;align-items:center;gap:6px;
        background:${col}18;border:1px solid ${col}40;border-radius:20px;padding:3px 11px">
        <span style="width:6px;height:6px;border-radius:50%;background:${col};display:inline-block"></span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;color:${col}">
          ${st.label}</span>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;border-bottom:1px solid rgba(0,229,255,0.06)">
      ${[["SPEED",`${speed.toFixed(1)} kn`,col],["HDG",`${heading}°`,"#f0f8ff"],["FLAG",flag||"—","#8ab4d0"]]
        .map(([l,val,c])=>`
        <div style="padding:8px 6px;text-align:center;border-right:1px solid rgba(255,255,255,0.04)">
          <div style="font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:700;color:${c}">${val}</div>
          <div style="font-size:8px;color:#3d6a8a;letter-spacing:0.15em;margin-top:2px">${l}</div>
        </div>`).join("")}
    </div>
    <div style="padding:8px 13px">
      ${[
        ["Type",    getVesselTypeLabel(vtype)],
        ["Country", getCountryName(flag)],
        ["Length",  len   ? `${len} m`                            : "—"],
        ["Beam",    beam  ? `${beam} m`                           : "—"],
        ["Gross T", grossT? `${Number(grossT).toLocaleString()} GT`: "—"],
        ["DWT",     dw    ? `${Number(dw).toLocaleString()} DWT`  : "—"],
        ["Updated", formatTimestamp(ts)],
      ].map(([k,val])=>`
      <div style="display:flex;justify-content:space-between;align-items:baseline;
        padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.03);gap:8px">
        <span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#3d6a8a;flex-shrink:0">${k}</span>
        <span style="font-size:11px;font-weight:600;color:#8ab4d0;text-align:right;
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px">${val}</span>
      </div>`).join("")}
    </div>
  </div>`;
}
