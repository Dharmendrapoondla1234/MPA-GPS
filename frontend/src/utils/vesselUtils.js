// src/utils/vesselUtils.js
export function getSpeedColor(speed) {
  const s = parseFloat(speed) || 0;
  if (s <= 0.5) return "#607d8b";
  if (s < 5)    return "#00ff9d";
  if (s < 12)   return "#ffaa00";
  return "#ff3355";
}

export function getVesselStatus(speed) {
  const s = parseFloat(speed) || 0;
  if (s <= 0.5) return { label:"Moored / Stopped", color:"#607d8b", icon:"⚓" };
  if (s < 5)    return { label:"Slow Speed",        color:"#00ff9d", icon:"🐢" };
  if (s < 12)   return { label:"Under Way",          color:"#ffaa00", icon:"⚡" };
  return               { label:"Full Ahead",          color:"#ff3355", icon:"🚀" };
}

export function getVesselIcon(vessel, isSelected = false) {
  return {
    path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
    scale: isSelected ? 12 : 7,
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
      hour12: false, year:"numeric", month:"short",
      day:"2-digit", hour:"2-digit", minute:"2-digit",
    });
  } catch { return String(ts); }
}

export function timeAgo(ts) {
  if (!ts) return "—";
  try {
    const diff = Date.now() - new Date(ts).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1)  return "Just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h/24)}d ago`;
  } catch { return "—"; }
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
  MX:"Mexico", CA:"Canada", RU:"Russia", TW:"Taiwan",
  BD:"Bangladesh", PK:"Pakistan", LK:"Sri Lanka", MM:"Myanmar",
};
export function getCountryName(code) {
  return COUNTRY_MAP[code?.toUpperCase()] || code || "Unknown";
}

// ── Reverse geocode lat/lng → region name using known maritime zones ──
const MARITIME_ZONES = [
  { name:"Singapore Strait",  lat:1.25,   lng:103.82, r:0.5  },
  { name:"Port of Singapore", lat:1.26,   lng:103.82, r:0.3  },
  { name:"Strait of Malacca", lat:2.5,    lng:102.0,  r:2.0  },
  { name:"South China Sea",   lat:14.0,   lng:113.0,  r:8.0  },
  { name:"Andaman Sea",       lat:11.0,   lng:96.0,   r:4.0  },
  { name:"Gulf of Thailand",  lat:9.5,    lng:101.5,  r:3.0  },
  { name:"Java Sea",          lat:-5.5,   lng:110.0,  r:4.0  },
  { name:"Philippine Sea",    lat:14.0,   lng:126.0,  r:6.0  },
  { name:"East China Sea",    lat:28.0,   lng:125.0,  r:5.0  },
  { name:"Bay of Bengal",     lat:13.0,   lng:87.0,   r:7.0  },
  { name:"Arabian Sea",       lat:18.0,   lng:65.0,   r:8.0  },
  { name:"Indian Ocean",      lat:-15.0,  lng:75.0,   r:15.0 },
  { name:"Pacific Ocean",     lat:20.0,   lng:155.0,  r:20.0 },
];

export function getRegionName(lat, lng) {
  if (!lat || !lng) return null;
  let closest = null, minDist = Infinity;
  for (const z of MARITIME_ZONES) {
    const d = Math.sqrt(Math.pow(lat - z.lat, 2) + Math.pow(lng - z.lng, 2));
    if (d < z.r && d < minDist) { minDist = d; closest = z; }
  }
  return closest?.name || null;
}

export function calcDistanceNM(lat1, lng1, lat2, lng2) {
  const R = 3440.065;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function buildInfoWindowContent(v) {
  const name   = v.vessel_name    || "Unknown Vessel";
  const imo    = v.imo_number     || "—";
  const mmsi   = v.mmsi_number    || "—";
  const speed  = parseFloat(v.speed || 0);
  const heading= v.heading        || 0;
  const flag   = v.flag           || "";
  const vtype  = v.vessel_type    || "";
  const lat    = parseFloat(v.latitude_degrees  || 0);
  const lng    = parseFloat(v.longitude_degrees || 0);
  const ts     = v.effective_timestamp;
  const st     = getVesselStatus(speed);
  const col    = st.color;
  const fe     = getFlagEmoji(flag);
  const region = getRegionName(lat, lng);

  return `<div style="font-family:'Rajdhani',sans-serif;background:linear-gradient(145deg,#0b1525,#0f1e35);border:1px solid rgba(0,229,255,0.28);border-radius:14px;overflow:hidden;min-width:270px;max-width:300px;color:#f0f8ff;box-shadow:0 20px 60px rgba(0,0,0,0.9);">
    <div style="padding:12px 14px 10px;border-bottom:1px solid rgba(0,229,255,0.07)">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:24px">${fe}</span>
        <div style="flex:1;min-width:0">
          <div style="font-family:'Orbitron',monospace;font-size:12px;font-weight:700;color:#00e5ff;letter-spacing:0.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#3d6a8a;margin-top:2px">IMO ${imo} · MMSI ${mmsi}</div>
          ${region ? `<div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#00e5ff;margin-top:2px">📍 ${region}</div>` : ""}
        </div>
      </div>
      <div style="margin-top:8px;display:inline-flex;align-items:center;gap:6px;background:${col}18;border:1px solid ${col}40;border-radius:20px;padding:3px 11px">
        <span style="width:6px;height:6px;border-radius:50%;background:${col};display:inline-block"></span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;color:${col}">${st.label}</span>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;border-bottom:1px solid rgba(0,229,255,0.06)">
      ${[["SPEED",`${speed.toFixed(1)} kn`,col],["HDG",`${heading}°`,"#f0f8ff"],["FLAG",flag||"—","#8ab4d0"]]
        .map(([l,val,c])=>`<div style="padding:8px 6px;text-align:center;border-right:1px solid rgba(255,255,255,0.04)"><div style="font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:700;color:${c}">${val}</div><div style="font-size:8px;color:#3d6a8a;letter-spacing:0.15em;margin-top:2px">${l}</div></div>`).join("")}
    </div>
    <div style="padding:8px 13px">
      ${[
        ["Type",    getVesselTypeLabel(vtype)],
        ["Country", getCountryName(flag)],
        ["Coords",  `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`],
        ["Updated", formatTimestamp(ts)],
      ].map(([k,val])=>`<div style="display:flex;justify-content:space-between;align-items:baseline;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.03);gap:8px"><span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#3d6a8a;flex-shrink:0">${k}</span><span style="font-size:11px;font-weight:600;color:#8ab4d0;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px">${val}</span></div>`).join("")}
    </div>
  </div>`;
}
