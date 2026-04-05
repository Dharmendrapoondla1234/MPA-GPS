// src/components/VesselDetailPanel.jsx — v7 "Naval Intelligence Terminal"
import React, { useState, useEffect, useCallback } from "react";
import {
    getSpeedColor, formatTimestamp, timeAgo,
  getFlagEmoji, getVesselTypeLabel, getCountryName, calcDistanceNM, getRegionName,
} from "../utils/vesselUtils";
import { fetchVesselHistory, fetchRoutePrediction } from "../services/api";
import VesselContactPanel from "./VesselContactPanel";
import { StarButton } from "./PreferredShipsGrid";
import { WatchlistStar } from "./WatchlistPanel";
import FuelEfficiencyPanel from "./FuelEfficiencyPanel";
import "./VesselDetailPanel.css";

function bq(val) {
  if (val===null||val===undefined) return null;
  if (typeof val==="object"&&val.value!==undefined) return val.value||null;
  const s=String(val).trim();
  return (s===""||s==="null"||s==="undefined")?null:s;
}
function safeNum(v){ const n=Number(v); return isNaN(n)?null:n; }

const TABS = [
  { id:"VESSEL",   icon:"⬡", label:"Vessel"   },
  { id:"VOYAGE",   icon:"🧭", label:"Voyage"   },
  { id:"STATUS",   icon:"📊", label:"Status"   },
  { id:"TRAIL",    icon:"🛤", label:"Trail"    },
  { id:"PREDICT",  icon:"🤖", label:"AI"       },
  { id:"FUEL",     icon:"⛽", label:"Fuel"     },
  { id:"CONTACTS", icon:"📞", label:"Contacts" },
];
const HOUR_OPTIONS = [12,24,48,72];

export default function VesselDetailPanel({ vessel, onClose, onShowTrail, onShowPredictRoute, onOpenCRM }) {
  const [tab,         setTab]          = useState("VESSEL");
  const [hours,       setHours]        = useState(24);
  const [trailOn,     setTrailOn]      = useState(false);
  const [loading,     setLoading]      = useState(false);
  const [stats,       setStats]        = useState(null);
  const [prediction,  setPrediction]   = useState(null);
  const [predLoading, setPredLoading]  = useState(false);
  const [predError,   setPredError]    = useState(null);
  const [predRouteOn, setPredRouteOn]  = useState(false);

  useEffect(() => {
    setTab("VESSEL"); setTrailOn(false); setStats(null);
    setPrediction(null); setPredError(null); setPredRouteOn(false);
    onShowTrail?.(null); onShowPredictRoute?.(null);
  }, [vessel?.imo_number]); // eslint-disable-line

  const loadTrail = useCallback(async (h) => {
    if (!vessel?.imo_number) return;
    setLoading(true);
    try {
      const hist = await fetchVesselHistory(vessel.imo_number, h);
      setTrailOn(true); onShowTrail?.(hist);
      if (hist?.length>1) {
        let dist=0; const spds=[];
        hist.forEach(p=>{ const s=parseFloat(p.speed??0); if(s>0) spds.push(s); });
        for(let i=1;i<hist.length;i++){
          const la1=Number(hist[i-1].latitude_degrees??0), lo1=Number(hist[i-1].longitude_degrees??0);
          const la2=Number(hist[i].latitude_degrees??0),   lo2=Number(hist[i].longitude_degrees??0);
          if(la1&&lo1&&la2&&lo2) dist+=calcDistanceNM(la1,lo1,la2,lo2);
        }
        const fp=hist[0], lp=hist[hist.length-1];
        setStats({
          pts:hist.length, dist:dist.toFixed(1),
          avg:spds.length?(spds.reduce((a,b)=>a+b,0)/spds.length).toFixed(1):"—",
          max:spds.length?Math.max(...spds).toFixed(1):"—",
          from:formatTimestamp(fp?.effective_timestamp),
          to:  formatTimestamp(lp?.effective_timestamp),
          fromRegion:getRegionName(Number(fp?.latitude_degrees||0),Number(fp?.longitude_degrees||0)),
          toRegion:  getRegionName(Number(lp?.latitude_degrees||0),Number(lp?.longitude_degrees||0)),
        });
      }
    } catch(e){ console.error(e); }
    finally{ setLoading(false); }
  }, [vessel?.imo_number,onShowTrail]); // eslint-disable-line

  const loadPrediction = useCallback(async () => {
    if (!vessel?.imo_number) return;
    setPredLoading(true); setPredError(null);
    try { const d=await fetchRoutePrediction(vessel.imo_number); setPrediction(d); }
    catch(e){ setPredError(e.message||"Prediction failed"); }
    finally{ setPredLoading(false); }
  }, [vessel?.imo_number]);

  const togglePredictRoute = useCallback(() => {
    if (!prediction?.route_waypoints?.length) return;
    const next=!predRouteOn; setPredRouteOn(next);
    onShowPredictRoute?.(next?prediction:null);
  }, [prediction,predRouteOn,onShowPredictRoute]);

  if (!vessel) return null;

  // ── Extract all fields ────────────────────────────────────────────
  const name      = vessel.vessel_name    || "Unknown Vessel";
  const imoNum    = vessel.imo_number;
  const mmsi      = vessel.mmsi_number;
  const callSign  = vessel.call_sign;
  const vtype     = vessel.vessel_type;
  const flag      = vessel.flag;
  const speed     = parseFloat(vessel.speed    ||0);
  const heading   = parseFloat(vessel.heading  ||0);
  const course    = parseFloat(vessel.course   ||0)||null;
  const lat       = parseFloat(vessel.latitude_degrees  ||0);
  const lng       = parseFloat(vessel.longitude_degrees ||0);
  const ts        = vessel.effective_timestamp;
  const lenOA     = safeNum(vessel.vessel_length);
  const beam      = safeNum(vessel.vessel_breadth);
  const depth     = safeNum(vessel.vessel_depth);
  const grossT    = safeNum(vessel.gross_tonnage);
  const netT      = safeNum(vessel.net_tonnage);
  const dw        = safeNum(vessel.deadweight);
  const built     = vessel.year_built&&Number(vessel.year_built)>0?String(vessel.year_built):null;

  const lastPortDeparted    = bq(vessel.last_port_departed);
  const nextPortDest        = bq(vessel.next_port_destination);
  const lastArrivedTime     = bq(vessel.last_arrived_time);
  const lastDepartedTime    = bq(vessel.last_departed_time);
  const berthLocation       = bq(vessel.berth_location);
  const berthGrid           = bq(vessel.berth_grid);
  const voyagePurpose       = bq(vessel.voyage_purpose);
  const shippingAgent       = bq(vessel.shipping_agent);
  const declaredArrivalTime = bq(vessel.declared_arrival_time);
  const crewCount           = bq(vessel.crew_count);
  const passengerCount      = bq(vessel.passenger_count);

  const vesselStatus  = bq(vessel.vessel_status) || "UNKNOWN";
  const statusLabel   = bq(vessel.status_label)  || vesselStatus;
  const portTimeHours = safeNum(vessel.port_time_hours);
  const hoursInPort   = safeNum(vessel.hours_in_port_so_far);
  const dataQuality   = safeNum(vessel.data_quality_score);
  const minsSincePing = vessel.minutes_since_last_ping!=null
    ? Math.max(0, Number(vessel.minutes_since_last_ping)) : null;
  const speedCategory = bq(vessel.speed_category);
  const hasArrival    = vessel.has_arrival_data;
  const hasDeparture  = vessel.has_departure_data;
  const hasDeclaration= vessel.has_declaration_data;

   
  const color  = getSpeedColor(speed);
  const pct    = Math.min((speed/25)*100,100);
  const flagE  = getFlagEmoji(flag);
  const region = getRegionName(lat,lng);
  const vtypeLabel = getVesselTypeLabel(vtype);

  const dbtColor = {
    UNDERWAY:"#00ff9d", IN_PORT:"#ffaa00", DEPARTED:"#00e5ff",
    EXPECTED:"#ff9900", UNKNOWN:"#607d8b",
  }[vesselStatus]||"#607d8b";

  const dqColor = dataQuality>=80?"#00ff9d":dataQuality>=50?"#ffaa00":"#ff3355";

  function hideTrail()          { setTrailOn(false); setStats(null); onShowTrail?.(null); }
  function handleHoursChange(h) { setHours(h); if(trailOn) loadTrail(h); }
  function toggleTrail()        { trailOn?hideTrail():loadTrail(hours); }

  const portProgress = hoursInPort&&portTimeHours&&portTimeHours>0
    ? Math.min(Math.round(hoursInPort/portTimeHours*100),100) : null;

  return (
    <div className="dp-root">

      {/* ══ HEADER ══ */}
      <div className="dp-head">
        <div className="dp-head-corner"/>
        <div className="dp-head-flag">{flagE}</div>
        <div className="dp-head-info">
          <div className="dp-name">{name}</div>
          <div className="dp-sub-row">
            <span className="dp-imo-badge">IMO {imoNum||"—"}</span>
            {mmsi && <span className="dp-mmsi-badge">MMSI {mmsi}</span>}
            {callSign && <span className="dp-cs-badge">{callSign}</span>}
          </div>
          <div className="dp-badge-row">
            {vtypeLabel && <span className="dp-type-badge">{vtypeLabel}</span>}
            {region     && <span className="dp-region-badge">📍 {region}</span>}
            {flag       && <span className="dp-flag-badge">{getCountryName(flag)}</span>}
          </div>
        </div>
        <div className="dp-head-actions">
          <StarButton vessel={vessel} className="dp-star-btn" />
          <WatchlistStar vessel={vessel} className="dp-star-btn" />
          {onOpenCRM && (
            <button
              className="dp-crm-btn"
              onClick={onOpenCRM}
              title="Open CRM — draft personalised emails to vessel contacts"
            >
              ✉ CRM
            </button>
          )}
          <button className="dp-close" onClick={onClose}>✕</button>
        </div>
      </div>

      {/* ══ STATUS STRIP ══ */}
      <div className="dp-status-strip" style={{"--sc":dbtColor}}>
        <div className="dp-ss-left">
          <span className="dp-ss-dot"/>
          <span className="dp-ss-label">{statusLabel}</span>
          {hoursInPort!=null && <span className="dp-ss-time">⏱ {hoursInPort.toFixed(1)}h in port</span>}
          {minsSincePing!=null && <span className="dp-ss-ping">{minsSincePing}m ago</span>}
        </div>
        {dataQuality!=null && (
          <div className="dp-dq-strip">
            <span className="dp-dq-label">DQ</span>
            <div className="dp-dq-bar"><div className="dp-dq-fill" style={{width:`${dataQuality}%`,background:dqColor}}/></div>
            <span className="dp-dq-num" style={{color:dqColor}}>{dataQuality}</span>
          </div>
        )}
      </div>

      {/* ══ SPEED HERO ══ */}
      <div className="dp-hero">
        {/* Speed gauge */}
        <div className="dp-speed-block">
          <div className="dp-speed-num" style={{color}}>{speed.toFixed(1)}</div>
          <div className="dp-speed-unit">KNOTS</div>
          <div className="dp-speed-kmh" style={{color:`${color}99`}}>{(speed*1.852).toFixed(1)} km/h</div>
          {speedCategory && <div className="dp-speed-cat" style={{color}}>{speedCategory}</div>}
        </div>

        {/* Radial gauge SVG */}
        <div className="dp-gauge-wrap">
          <svg width="88" height="88" viewBox="0 0 88 88">
            <circle cx="44" cy="44" r="34" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="8"/>
            <circle cx="44" cy="44" r="34" fill="none" stroke={color} strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${2*Math.PI*34}`}
              strokeDashoffset={`${2*Math.PI*34*(1-pct/100)}`}
              transform="rotate(-90 44 44)"
              style={{filter:`drop-shadow(0 0 10px ${color})`,transition:"stroke-dashoffset 1s ease"}}/>
            <text x="44" y="40" textAnchor="middle" fill={color} fontSize="16"
              fontFamily="'Barlow Condensed',sans-serif" fontWeight="900">{pct.toFixed(0)}</text>
            <text x="44" y="52" textAnchor="middle" fill={color} fontSize="7"
              fontFamily="'JetBrains Mono',monospace" fontWeight="700" opacity="0.6">%MAX</text>
          </svg>
        </div>

        {/* Metrics column */}
        <div className="dp-metrics-col">
          <Metric label="HDG" value={`${heading}°`} color={color}/>
          {course && <Metric label="COG" value={`${course.toFixed(1)}°`}/>}
          <Metric label="LAT"  value={lat?`${lat.toFixed(4)}°`:"—"} mono/>
          <Metric label="LON"  value={lng?`${lng.toFixed(4)}°`:"—"} mono/>
        </div>
      </div>

      {/* ══ VOYAGE RIBBON (from→to) ══ */}
      {(lastPortDeparted||nextPortDest||berthLocation) && (
        <div className="dp-voyage-ribbon">
          {lastPortDeparted && (
            <div className="dp-vr-port dp-vr-from">
              <span className="dp-vr-icon">⚓</span>
              <div className="dp-vr-text">
                <div className="dp-vr-lbl">FROM</div>
                <div className="dp-vr-val">{lastPortDeparted}</div>
                {lastDepartedTime && <div className="dp-vr-time">{formatTimestamp(lastDepartedTime)}</div>}
              </div>
            </div>
          )}
          {(lastPortDeparted||berthLocation) && nextPortDest && (
            <div className="dp-vr-arrow">
              <svg width="32" height="10" viewBox="0 0 32 10">
                <line x1="0" y1="5" x2="24" y2="5" stroke="rgba(0,229,255,0.35)" strokeWidth="1.5" strokeDasharray="3,2"/>
                <polygon points="24,2 32,5 24,8" fill="rgba(0,229,255,0.6)"/>
              </svg>
            </div>
          )}
          {nextPortDest && (
            <div className="dp-vr-port dp-vr-to">
              <span className="dp-vr-icon">🏁</span>
              <div className="dp-vr-text">
                <div className="dp-vr-lbl">DEST</div>
                <div className="dp-vr-val">{nextPortDest}</div>
                {declaredArrivalTime && <div className="dp-vr-time">ETA {formatTimestamp(declaredArrivalTime)}</div>}
              </div>
            </div>
          )}
          {berthLocation && (
            <div className="dp-vr-port dp-vr-berth">
              <span className="dp-vr-icon">🛳️</span>
              <div className="dp-vr-text">
                <div className="dp-vr-lbl">BERTH</div>
                <div className="dp-vr-val">{berthLocation}{berthGrid?` · ${berthGrid}`:""}</div>
                {portProgress!=null && (
                  <div className="dp-berth-prog">
                    <div className="dp-bp-bar">
                      <div className="dp-bp-fill" style={{width:portProgress+"%"}}/>
                    </div>
                    <span>{portProgress}%</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══ TRAIL BAR ══ */}
      <div className="dp-trail-bar">
        <span className="dp-tl-label">TRAIL</span>
        <div className="dp-tl-hours">
          {HOUR_OPTIONS.map(h=>(
            <button key={h} className={"dp-tl-h"+(hours===h?" active":"")}
              onClick={()=>handleHoursChange(h)}>{h}h</button>
          ))}
        </div>
        <button className={"dp-tl-btn"+(trailOn?" on":"")} onClick={toggleTrail} disabled={loading}>
          {loading?<><span className="dp-spin"/>…</>:trailOn?"✕ HIDE":"▶ SHOW"}
        </button>
      </div>

      {stats && (
        <div className="dp-trail-stats">
          <TrailStat icon="📍" label="Points"   val={stats.pts}/>
          <TrailStat icon="⛵" label="Distance" val={`${stats.dist} NM`}/>
          <TrailStat icon="⚡" label="Avg Spd"  val={`${stats.avg} kn`}/>
          <TrailStat icon="🚀" label="Max Spd"  val={`${stats.max} kn`}/>
        </div>
      )}

      {/* ══ TABS ══ */}
      <div className="dp-tabs">
        {TABS.map(t=>(
          <button key={t.id}
            className={"dp-tab"+(tab===t.id?" dp-tab--on":"")+(t.id==="PREDICT"?" dp-tab--ai":"")}
            onClick={()=>setTab(t.id)}>
            <span className="dp-tab-icon">{t.icon}</span>
            <span className="dp-tab-lbl">{t.label}</span>
          </button>
        ))}
      </div>

      {/* ══ TAB BODY ══ */}
      <div className="dp-body">

        {/* ─── VESSEL TAB ─── */}
        {tab==="VESSEL" && (
          <div className="dp-section">

            {/* Identity card */}
            <div className="dp-info-card">
              <div className="dp-ic-header">⬡ IDENTIFICATION</div>
              <Row k="Vessel Name"  v={name}/>
              <Row k="IMO Number"   v={imoNum} mono hi/>
              <Row k="MMSI"         v={mmsi} mono/>
              <Row k="Call Sign"    v={callSign} mono/>
              <Row k="Vessel Type"  v={vtypeLabel}/>
              <Row k="Flag"         v={flag?`${flagE} ${getCountryName(flag)} (${flag})`:null}/>
              <Row k="Year Built"   v={built}/>
            </div>

            {/* Dimensions card */}
            {(lenOA||beam||grossT||dw) && (
              <div className="dp-info-card">
                <div className="dp-ic-header">⊞ DIMENSIONS & TONNAGE</div>
                <div className="dp-cap-grid">
                  <CapCell code="LOA"  val={lenOA?`${lenOA}m`:"N/A"} desc="Length Overall"/>
                  <CapCell code="BM"   val={beam?`${beam}m`:"N/A"}   desc="Beam"/>
                  <CapCell code="DEP"  val={depth?`${depth}m`:"N/A"} desc="Depth"/>
                  <CapCell code="GT"   val={grossT?grossT.toLocaleString():"N/A"} desc="Gross Tonnage"/>
                  <CapCell code="NT"   val={netT?netT.toLocaleString():"N/A"}     desc="Net Tonnage"/>
                  <CapCell code="DWT"  val={dw?dw.toLocaleString():"N/A"}         desc="Dead Weight" hi/>
                </div>
              </div>
            )}

            {/* Position card */}
            <div className="dp-info-card">
              <div className="dp-ic-header">📡 LIVE POSITION</div>
              <Row k="Region"       v={region} hi/>
              <Row k="Latitude"     v={lat?`${lat.toFixed(6)}°`:null} mono/>
              <Row k="Longitude"    v={lng?`${lng.toFixed(6)}°`:null} mono/>
              <Row k="Heading"      v={`${heading}°`}/>
              <Row k="Course (COG)" v={course?`${course.toFixed(1)}°`:null}/>
              <Row k="Speed"        v={`${speed.toFixed(1)} kn · ${(speed*1.852).toFixed(1)} km/h`} hi/>
              <Row k="Last Update"  v={formatTimestamp(ts)}/>
              <Row k="Updated"      v={timeAgo(ts)} hi/>
            </div>
          </div>
        )}

        {/* ─── VOYAGE TAB ─── */}
        {tab==="VOYAGE" && (
          <div className="dp-section">

            {(lastPortDeparted||nextPortDest) && (
              <div className="dp-info-card">
                <div className="dp-ic-header">🧭 PORT MOVEMENT</div>
                <div className="dp-voyage-boxes">
                  <div className="dp-vb dp-vb--from">
                    <div className="dp-vb-icon">⚓</div>
                    <div className="dp-vb-title">LAST PORT</div>
                    <div className="dp-vb-val">{lastPortDeparted||"—"}</div>
                    {lastArrivedTime  && <div className="dp-vb-time">Arr: {formatTimestamp(lastArrivedTime)}</div>}
                    {lastDepartedTime && <div className="dp-vb-time">Dep: {formatTimestamp(lastDepartedTime)}</div>}
                    {portTimeHours    && <div className="dp-vb-time">Time: {portTimeHours.toFixed(1)}h</div>}
                  </div>
                  <div className="dp-vb-divider">
                    <svg width="20" height="40" viewBox="0 0 20 40">
                      <line x1="10" y1="0" x2="10" y2="32" stroke="rgba(0,229,255,0.2)" strokeWidth="1.5" strokeDasharray="3,2"/>
                      <polygon points="4,30 10,40 16,30" fill="rgba(0,229,255,0.4)"/>
                    </svg>
                  </div>
                  <div className="dp-vb dp-vb--to">
                    <div className="dp-vb-icon">🏁</div>
                    <div className="dp-vb-title">DESTINATION</div>
                    <div className="dp-vb-val">{nextPortDest||"—"}</div>
                    {declaredArrivalTime && <div className="dp-vb-time">ETA: {formatTimestamp(declaredArrivalTime)}</div>}
                  </div>
                </div>
              </div>
            )}

            {(berthLocation||shippingAgent||voyagePurpose||crewCount) && (
              <div className="dp-info-card">
                <div className="dp-ic-header">🛳️ BERTH & DECLARATION</div>
                <Row k="Berth Location"   v={berthLocation} hi/>
                <Row k="Berth Grid"       v={berthGrid}/>
                <Row k="Voyage Purpose"   v={voyagePurpose}/>
                <Row k="Shipping Agent"   v={shippingAgent} hi/>
                <Row k="Declared Arrival" v={formatTimestamp(declaredArrivalTime)}/>
                <Row k="Crew on Board"    v={crewCount}/>
                <Row k="Passengers"       v={passengerCount}/>
              </div>
            )}

            {portProgress!=null && (
              <div className="dp-info-card">
                <div className="dp-ic-header">⏱ PORT TIME</div>
                <div className="dp-port-time-block">
                  <div className="dp-pt-nums">
                    <span className="dp-pt-current">{hoursInPort?.toFixed(1)}h</span>
                    <span className="dp-pt-sep">/</span>
                    <span className="dp-pt-total">{portTimeHours?.toFixed(1)}h</span>
                  </div>
                  <div className="dp-pt-bar">
                    <div className="dp-pt-fill" style={{width:portProgress+"%"}}/>
                    <div className="dp-pt-dot" style={{left:portProgress+"%"}}/>
                  </div>
                  <div className="dp-pt-label">{portProgress}% of scheduled port time elapsed</div>
                </div>
              </div>
            )}

            <div className="dp-info-card">
              <div className="dp-ic-header">🔗 DATA SOURCES</div>
              <div className="dp-src-badges">
                <SrcBadge active={hasArrival}    icon="↓" label="Arrival AIS"/>
                <SrcBadge active={hasDeparture}  icon="↑" label="Departure AIS"/>
                <SrcBadge active={hasDeclaration}icon="📋" label="Declaration"/>
              </div>
            </div>
          </div>
        )}

        {/* ─── STATUS TAB ─── */}
        {tab==="STATUS" && (
          <div className="dp-section">

            <div className="dp-info-card">
              <div className="dp-ic-header">📊 VESSEL STATUS</div>
              <div className="dp-status-card" style={{"--sc":dbtColor}}>
                <div className="dp-sc-dot"/>
                <div className="dp-sc-body">
                  <div className="dp-sc-label">{statusLabel}</div>
                  <div className="dp-sc-sub">dbt · fct_vessel_master</div>
                </div>
                <div className="dp-sc-badge">{vesselStatus}</div>
              </div>
              {portTimeHours!=null && <Row k="Port Time (this call)"  v={`${portTimeHours.toFixed(2)}h`} hi/>}
              {hoursInPort!=null   && <Row k="Hours In Port So Far"   v={`${hoursInPort.toFixed(2)}h`} hi/>}
            </div>

            {dataQuality!=null && (
              <div className="dp-info-card">
                <div className="dp-ic-header">🔬 DATA QUALITY</div>
                <div className="dp-dq-full-block">
                  <div className="dp-dq-score-row">
                    <span className="dp-dq-score-num" style={{color:dqColor}}>{dataQuality}</span>
                    <span className="dp-dq-score-den">/100</span>
                  </div>
                  <div className="dp-dq-full-bar">
                    <div className="dp-dq-full-fill" style={{width:`${dataQuality}%`,background:dqColor}}/>
                  </div>
                  <div className="dp-dq-checks">
                    {[
                      ["+20","Live AIS position",   minsSincePing!=null&&minsSincePing<360],
                      ["+20","AIS arrival record",  hasArrival],
                      ["+20","Official declaration",hasDeclaration],
                      ["+20","Departure record",    hasDeparture],
                      ["+20","Gross tonnage data",  grossT!=null],
                    ].map(([pts,label,ok])=>(
                      <div key={label} className={"dp-dq-check"+(ok?" ok":" na")}>
                        <span className="dp-dq-pts">{pts}</span>
                        <span className="dp-dq-icon">{ok?"✓":"✗"}</span>
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="dp-info-card">
              <div className="dp-ic-header">📡 AIS SIGNAL</div>
              <Row k="Minutes Since Ping" v={minsSincePing!=null?`${minsSincePing} min`:null} hi/>
              <Row k="Speed Category"     v={speedCategory}/>
              <Row k="Stale Signal"       v={vessel.is_stale?"Yes (>6h)":"No — fresh"} hi/>
              <Row k="Data Source"        v={bq(vessel.data_source)||"MPA AIS"} />
            </div>

            <div className="dp-info-card">
              <div className="dp-ic-header">⬜ CAPACITY MATRIX</div>
              <div className="dp-cap-grid">
                <CapCell code="DWT" val={dw?dw.toLocaleString():"N/A"}          desc="Dead Weight Tons" hi/>
                <CapCell code="GT"  val={grossT?grossT.toLocaleString():"N/A"}  desc="Gross Tonnage"/>
                <CapCell code="NT"  val={netT?netT.toLocaleString():"N/A"}      desc="Net Tonnage"/>
                <CapCell code="LOA" val={lenOA?`${lenOA}m`:"N/A"}               desc="Length Overall"/>
                <CapCell code="BM"  val={beam?`${beam}m`:"N/A"}                 desc="Beam"/>
                <CapCell code="DEP" val={depth?`${depth}m`:"N/A"}               desc="Depth"/>
              </div>
            </div>
          </div>
        )}

        {/* ─── TRAIL TAB ─── */}
        {tab==="TRAIL" && (
          <div className="dp-section">
            <div className="dp-info-card">
              <div className="dp-ic-header">🛤 TRACK CONTROLS</div>
              <div className="dp-trail-ctrl">
                <div className="dp-trail-hours">
                  {HOUR_OPTIONS.map(h=>(
                    <button key={h} className={"dp-tl-h"+(hours===h?" active":"")}
                      onClick={()=>handleHoursChange(h)}>{h}h</button>
                  ))}
                </div>
                <button className={"dp-trail-show-btn"+(trailOn?" on":"")} onClick={toggleTrail} disabled={loading}>
                  {loading?<><span className="dp-spin"/>Loading…</>:trailOn?"📍 Hide Trail":"📍 Show Trail"}
                </button>
              </div>
            </div>

            {stats && (
              <div className="dp-info-card">
                <div className="dp-ic-header">📈 TRAIL STATISTICS</div>
                <div className="dp-trail-stat-grid">
                  <TrailStat icon="📍" label="Track Points"   val={stats.pts}/>
                  <TrailStat icon="🌊" label="Distance"       val={`${stats.dist} NM`}/>
                  <TrailStat icon="⚡" label="Avg Speed"      val={`${stats.avg} kn`}/>
                  <TrailStat icon="🚀" label="Max Speed"      val={`${stats.max} kn`}/>
                </div>
                <Row k="Trail From"    v={stats.from} mono/>
                <Row k="Trail To"      v={stats.to}   mono/>
                {stats.fromRegion && <Row k="Start Region" v={stats.fromRegion} hi/>}
                {stats.toRegion   && <Row k="End Region"   v={stats.toRegion}   hi/>}
              </div>
            )}

            <div className="dp-info-card">
              <div className="dp-ic-header">📡 CURRENT POSITION</div>
              <Row k="Region"      v={region} hi/>
              <Row k="Latitude"    v={lat?`${lat.toFixed(6)}°`:null} mono/>
              <Row k="Longitude"   v={lng?`${lng.toFixed(6)}°`:null} mono/>
              <Row k="Last Update" v={formatTimestamp(ts)}/>
            </div>
          </div>
        )}

        {/* ─── PREDICT TAB ─── */}
        {tab==="PREDICT" && (
          <PredictTab
            vessel={vessel}
            prediction={prediction}
            predLoading={predLoading}
            predError={predError}
            predRouteOn={predRouteOn}
            onLoad={loadPrediction}
            onToggleRoute={togglePredictRoute}
          />
        )}

        {tab==="FUEL" && (
          <FuelEfficiencyPanel vessel={vessel} />
        )}

        {tab==="CONTACTS" && (
          <VesselContactPanel
            vessel={vessel}
            portCode={vessel?.next_port_destination || vessel?.location_to}
          />
        )}
      </div>
    </div>
  );
}

// ── Predict Tab ───────────────────────────────────────────────────
function PredictTab({ prediction, predLoading, predError, predRouteOn, onLoad, onToggleRoute }) {
  const hasRun = prediction!==null||predError!==null;
  const pred   = prediction?.prediction;
  const alts   = prediction?.alternatives||[];
  const wps    = prediction?.route_waypoints||[];

  function confColor(c){ return c>=75?"#00ff9d":c>=50?"#ffaa00":"#ff5577"; }
  function fmtEta(h){ if(!h)return"—"; if(h<1)return`${Math.round(h*60)}min`; if(h<24)return`${h.toFixed(1)}h`; return`${Math.floor(h/24)}d ${Math.round(h%24)}h`; }

  return (
    <div className="dp-section">
      {!hasRun&&!predLoading && (
        <div className="pred-hero">
          <div className="pred-hero-orb">🤖</div>
          <div className="pred-hero-title">AI Route Prediction</div>
          <div className="pred-hero-sub">Analyses AIS trajectory, heading, and port proximity to predict the next destination and ETA.</div>
          <div className="pred-caps">
            {["Next Port","ETA","Route","Confidence"].map(c=><span key={c} className="pred-cap">{c}</span>)}
          </div>
          <button className="pred-run-btn" onClick={onLoad}>▶ Predict Route</button>
        </div>
      )}

      {predLoading && (
        <div className="pred-loading">
          <div className="pred-spinner-wrap"><div className="pred-spinner"/><div className="pred-spinner-core"/></div>
          <div className="pred-loading-title">Analysing trajectory…</div>
          <div className="pred-steps">
            {["Fetching 72h AIS history","Computing heading alignment","Scoring candidate ports","Generating route waypoints"]
              .map((s,i)=><div key={i} className="pred-step" style={{animationDelay:`${i*0.45}s`}}><span className="pred-step-dot"/>{s}</div>)}
          </div>
        </div>
      )}

      {predError&&!predLoading && (
        <div className="pred-error-block">
          <div className="pred-error-icon">⚠️</div>
          <div className="pred-error-msg">{predError}</div>
          <button className="pred-retry-btn" onClick={onLoad}>↺ Retry</button>
        </div>
      )}

      {pred&&!predLoading && (
        <>
          <div className="pred-result-card">
            <div className="pred-rc-eyebrow">PREDICTED DESTINATION {pred.is_declared&&<span className="pred-declared">✓ DECLARED</span>}</div>
            <div className="pred-rc-port">{pred.destination}</div>
            <div className="pred-rc-meta">{pred.distance_nm} NM · HDG {pred.bearing_deg}°</div>

            <div className="pred-eta-row">
              <div className="pred-eta-main">
                <div className="pred-eta-label">ESTIMATED ARRIVAL</div>
                <div className="pred-eta-val">{pred.eta_label}</div>
                {pred.eta_iso && (
                  <div className="pred-eta-date">
                    {new Date(pred.eta_iso).toLocaleString("en-SG",{weekday:"short",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})}
                  </div>
                )}
              </div>
              <div className="pred-dist-big">
                <div className="pred-dist-num">{pred.distance_nm}</div>
                <div className="pred-dist-unit">NM</div>
              </div>
            </div>

            <div className="pred-conf-block">
              <div className="pred-conf-hdr">
                <span>CONFIDENCE</span>
                <span className="pred-conf-pct" style={{color:confColor(pred.confidence)}}>{pred.confidence}%</span>
              </div>
              <div className="pred-conf-bar">
                <div className="pred-conf-fill" style={{width:`${pred.confidence}%`,background:confColor(pred.confidence)}}/>
              </div>
            </div>

            {pred.method && <div className="pred-method">🔬 {pred.method}</div>}

            {pred.route_method && (
              <div className="pred-lane-legend">
                <span className="pred-lane-tag pred-tss">■ TSS</span>
                <span className="pred-lane-tag pred-ais">■ AIS Lane</span>
                <span className="pred-lane-tag pred-dwr">■ Deep Water</span>
              </div>
            )}

            <button className={"pred-map-btn"+(predRouteOn?" on":"")} onClick={onToggleRoute}>
              🗺️ {predRouteOn?"Hide Route on Map":"Show Route on Map"}
            </button>
          </div>

          {alts.length>0 && (
            <div className="dp-info-card">
              <div className="dp-ic-header">⬡ ALTERNATIVES</div>
              {alts.map((a,i)=>(
                <div key={i} className="pred-alt">
                  <span className="pred-alt-rank">#{i+2}</span>
                  <div className="pred-alt-body">
                    <div className="pred-alt-port">{a.port}</div>
                    <div className="pred-alt-meta">{a.distance_nm} NM · {a.eta_label}</div>
                  </div>
                  <div className="pred-alt-right">
                    <span className="pred-alt-conf" style={{color:confColor(a.confidence||0)}}>{a.confidence||0}%</span>
                    {a.bearing_deg!=null && <span className="pred-alt-brng">{a.bearing_deg}°</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {wps.length>0 && (
            <div className="dp-info-card">
              <div className="dp-ic-header">📍 ROUTE WAYPOINTS</div>
              <div className="pred-wps">
                {wps.map((wp,i)=>(
                  <div key={i} className="pred-wp">
                    <div className="pred-wp-spine">
                      <div className={"pred-wp-dot pred-wp-dot--"+( wp.type||"waypoint")}/>
                      {i<wps.length-1 && <div className="pred-wp-line"/>}
                    </div>
                    <div className="pred-wp-body">
                      <div className="pred-wp-label">{wp.label}</div>
                      {wp.eta_hours_from_now && <div className="pred-wp-eta">in {fmtEta(wp.eta_hours_from_now)}</div>}
                    </div>
                    <div className="pred-wp-coords">{wp.lat.toFixed(3)}°, {wp.lng.toFixed(3)}°</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="pred-rerun-wrap">
            <button className="pred-rerun-btn" onClick={onLoad}>↺ Re-run Prediction</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────
function Row({ k, v, mono, hi }) {
  const display = v!==null&&v!==undefined&&String(v).trim()!==""?String(v):null;
  return (
    <div className={"dp-row"+(hi?" dp-row--hi":"")}>
      <span className="dp-row-k">{k}</span>
      <span className={"dp-row-v"+(mono?" mono":"")+(hi?" dp-row-v--hi":"")+(display?"":" dp-row-v--null")}>
        {display||"—"}
      </span>
    </div>
  );
}

function Metric({ label, value, color, mono }) {
  return (
    <div className="dp-metric">
      <div className={"dp-metric-val"+(mono?" mono":"")} style={color?{color}:{}}>
        {value}
      </div>
      <div className="dp-metric-label">{label}</div>
    </div>
  );
}

function CapCell({ code, val, desc, hi }) {
  return (
    <div className={"dp-cap-cell"+(hi?" dp-cap-cell--hi":"")}>
      <div className="dp-cap-code">{code}</div>
      <div className="dp-cap-val">{val}</div>
      <div className="dp-cap-desc">{desc}</div>
    </div>
  );
}

function TrailStat({ icon, label, val }) {
  return (
    <div className="dp-trail-stat">
      <div className="dp-ts-icon">{icon}</div>
      <div className="dp-ts-val">{val}</div>
      <div className="dp-ts-label">{label}</div>
    </div>
  );
}

function SrcBadge({ active, icon, label }) {
  return (
    <div className={"dp-src-badge"+(active?" dp-src-badge--on":"")}>
      <span>{icon}</span>
      <span>{label}</span>
      <span className="dp-src-tick">{active?"✓":"✗"}</span>
    </div>
  );
}