// src/components/VesselDetailPanel.jsx — MPA Advanced v6
import React, { useState, useEffect, useCallback } from "react";
import {
  getVesselStatus, getSpeedColor, formatTimestamp, timeAgo,
  getFlagEmoji, getVesselTypeLabel, getCountryName, calcDistanceNM, getRegionName,
} from "../utils/vesselUtils";
import { fetchVesselHistory, fetchRoutePrediction } from "../services/api";
import "./VesselDetailPanel.css";

function bq(val) {
  if (val===null||val===undefined) return null;
  if (typeof val==="object"&&val.value!==undefined) return val.value||null;
  const s=String(val).trim();
  return (s===""||s==="null"||s==="undefined")?null:s;
}

const TABS = ["VESSEL","VOYAGE","STATUS","TRAIL","PREDICT"];
const HOUR_OPTIONS = [12,24,48,72];

export default function VesselDetailPanel({ vessel, onClose, onShowTrail, onShowPredictRoute }) {
  const [tab,        setTab]       = useState("VESSEL");
  const [hours,      setHours]     = useState(24);
  const [trailOn,    setTrailOn]   = useState(false);
  const [loading,    setLoading]   = useState(false);
  const [stats,      setStats]     = useState(null);
  const [prediction, setPrediction]= useState(null);
  const [predLoading,setPredLoading]=useState(false);
  const [predError,  setPredError] = useState(null);
  const [predRouteOn,setPredRouteOn]=useState(false);

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
        hist.forEach(p=>{const s=parseFloat(p.speed??0);if(s>0)spds.push(s);});
        for(let i=1;i<hist.length;i++){
          const la1=Number(hist[i-1].latitude_degrees??0),lo1=Number(hist[i-1].longitude_degrees??0);
          const la2=Number(hist[i].latitude_degrees??0),  lo2=Number(hist[i].longitude_degrees??0);
          if(la1&&lo1&&la2&&lo2) dist+=calcDistanceNM(la1,lo1,la2,lo2);
        }
        const fp=hist[0],lp=hist[hist.length-1];
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
    } catch(e){console.error(e);}
    finally{setLoading(false);}
  }, [vessel?.imo_number,onShowTrail]); // eslint-disable-line

  const loadPrediction = useCallback(async () => {
    if (!vessel?.imo_number) return;
    setPredLoading(true); setPredError(null);
    try { const d=await fetchRoutePrediction(vessel.imo_number); setPrediction(d); }
    catch(e){setPredError(e.message||"Prediction failed");}
    finally{setPredLoading(false);}
  }, [vessel?.imo_number]);

  const togglePredictRoute = useCallback(() => {
    if (!prediction?.route_waypoints?.length) return;
    const next=!predRouteOn; setPredRouteOn(next);
    onShowPredictRoute?.(next?prediction:null);
  }, [prediction,predRouteOn,onShowPredictRoute]);

  if (!vessel) return null;

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
  const lenOA     = vessel.vessel_length  ? Number(vessel.vessel_length)  : null;
  const beam      = vessel.vessel_breadth ? Number(vessel.vessel_breadth) : null;
  const depth     = vessel.vessel_depth   ? Number(vessel.vessel_depth)   : null;
  const grossT    = vessel.gross_tonnage  ? Number(vessel.gross_tonnage)  : null;
  const netT      = vessel.net_tonnage    ? Number(vessel.net_tonnage)    : null;
  const dw        = vessel.deadweight     ? Number(vessel.deadweight)     : null;
  const built     = vessel.year_built&&Number(vessel.year_built)>0?String(vessel.year_built):null;

  // Voyage fields
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

  // dbt-enriched fields
  const vesselStatus    = bq(vessel.vessel_status)    || "UNKNOWN";
  const statusLabel     = bq(vessel.status_label)     || vesselStatus;
  const portTimeHours   = vessel.port_time_hours ? Number(vessel.port_time_hours) : null;
  const hoursInPort     = vessel.hours_in_port_so_far ? Number(vessel.hours_in_port_so_far) : null;
  const dataQuality     = vessel.data_quality_score ? Number(vessel.data_quality_score) : null;
  // FIX: guard against negative values (SGT timezone bug residual) — floor at 0
  const minsSincePing   = vessel.minutes_since_last_ping != null
    ? Math.max(0, Number(vessel.minutes_since_last_ping))
    : null;
  const speedCategory   = bq(vessel.speed_category);

  const hasArrival    = vessel.has_arrival_data;
  const hasDeparture  = vessel.has_departure_data;
  const hasDeclaration= vessel.has_declaration_data;

  const status = getVesselStatus(speed);
  const color  = getSpeedColor(speed);
  const pct    = Math.min((speed/25)*100,100);
  const flagE  = getFlagEmoji(flag);
  const region = getRegionName(lat,lng);

  function hideTrail()         { setTrailOn(false); setStats(null); onShowTrail?.(null); }
  function handleHoursChange(h){ setHours(h); if(trailOn) loadTrail(h); }
  function toggleTrail()       { trailOn?hideTrail():loadTrail(hours); }

  // dbt vessel_status → color
  const dbtStatusColor = {
    UNDERWAY:"#00ff9d", IN_PORT:"#ffaa00", DEPARTED:"#00e5ff", EXPECTED:"#ff9900", UNKNOWN:"#607d8b",
  }[vesselStatus]||"#607d8b";

  // Data quality color
  const dqColor = dataQuality>=80?"#00ff9d":dataQuality>=50?"#ffaa00":"#ff3355";

  return (
    <div className="dp-root">

      {/* HEADER */}
      <div className="dp-head">
        <span className="dp-flag">{flagE}</span>
        <div className="dp-head-info">
          <div className="dp-name">{name}</div>
          <div className="dp-sub mono">IMO {imoNum||"—"} · MMSI {mmsi||"—"}</div>
          {vtype && <span className="dp-badge">{getVesselTypeLabel(vtype)}</span>}
          {region && <span className="dp-region-badge">📍 {region}</span>}
        </div>
        <button className="dp-close" onClick={onClose}>✕</button>
      </div>

      {/* dbt STATUS STRIP */}
      <div className="dp-dbt-status" style={{background:`${dbtStatusColor}10`,borderColor:`${dbtStatusColor}30`}}>
        <div className="dp-dbt-left">
          <span className="dp-dbt-dot" style={{background:dbtStatusColor,boxShadow:`0 0 6px ${dbtStatusColor}`}}/>
          <span className="dp-dbt-label" style={{color:dbtStatusColor}}>{statusLabel}</span>
          {hoursInPort && <span className="dp-dbt-port-time">⏱ {hoursInPort.toFixed(1)}h in port</span>}
        </div>
        {dataQuality!=null && (
          <div className="dp-dq-wrap">
            <span className="dp-dq-label">DATA</span>
            <div className="dp-dq-bar">
              <div className="dp-dq-fill" style={{width:`${dataQuality}%`,background:dqColor}}/>
            </div>
            <span className="dp-dq-val" style={{color:dqColor}}>{dataQuality}</span>
          </div>
        )}
      </div>

      {/* AIS STATUS BAR */}
      <div className="dp-status-bar" style={{background:`${color}14`,borderColor:`${color}30`}}>
        <span className="dp-sdot" style={{background:color,boxShadow:`0 0 8px ${color}`}}/>
        <span className="dp-slabel" style={{color}}>{status.icon} {status.label}</span>
        <span className="dp-time-ago">{timeAgo(ts)}{minsSincePing!=null&&` · ${minsSincePing}min ago`}</span>
      </div>

      {/* PORT STRIP */}
      {(lastPortDeparted||nextPortDest||berthLocation)&&(
        <div className="dp-port-strip">
          {lastPortDeparted&&(
            <div className="dp-ps-item">
              <span className="dp-ps-icon">⚓</span>
              <div>
                <div className="dp-ps-label">FROM</div>
                <div className="dp-ps-val">{lastPortDeparted}</div>
                {lastArrivedTime&&<div className="dp-ps-time">{formatTimestamp(lastArrivedTime)}</div>}
              </div>
            </div>
          )}
          {nextPortDest&&(
            <div className="dp-ps-item">
              <span className="dp-ps-icon">🏁</span>
              <div>
                <div className="dp-ps-label">TO</div>
                <div className="dp-ps-val">{nextPortDest}</div>
                {lastDepartedTime&&<div className="dp-ps-time">{formatTimestamp(lastDepartedTime)}</div>}
              </div>
            </div>
          )}
          {berthLocation&&(
            <div className="dp-ps-item">
              <span className="dp-ps-icon">🛳️</span>
              <div>
                <div className="dp-ps-label">BERTH</div>
                <div className="dp-ps-val">{berthLocation}{berthGrid?` · ${berthGrid}`:""}</div>
                {declaredArrivalTime&&<div className="dp-ps-time">{formatTimestamp(declaredArrivalTime)}</div>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* SPEED HERO */}
      <div className="dp-hero">
        <div>
          <div className="dp-speed-num" style={{color}}>{speed.toFixed(1)}</div>
          <div className="dp-speed-unit">knots</div>
          <div className="dp-speed-km" style={{color:`${color}cc`}}>{(speed*1.852).toFixed(1)} km/h</div>
          {speedCategory&&<div className="dp-spd-cat" style={{color}}>{speedCategory}</div>}
        </div>
        <svg width="90" height="90" viewBox="0 0 90 90">
          <circle cx="45" cy="45" r="36" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="7"/>
          <circle cx="45" cy="45" r="36" fill="none" stroke={color} strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${2*Math.PI*36}`}
            strokeDashoffset={`${2*Math.PI*36*(1-pct/100)}`}
            transform="rotate(-90 45 45)"
            style={{filter:`drop-shadow(0 0 8px ${color})`,transition:"stroke-dashoffset 1s ease"}}/>
          <text x="45" y="41" textAnchor="middle" fill={color} fontSize="14"
            fontFamily="'Barlow Condensed','Rajdhani',sans-serif" fontWeight="900">{pct.toFixed(0)}</text>
          <text x="45" y="52" textAnchor="middle" fill={color} fontSize="7"
            fontFamily="'JetBrains Mono',monospace" fontWeight="700" opacity="0.7">%MAX</text>
        </svg>
        <div className="dp-metrics">
          <M label="HDG" v={`${heading}°`}/>
          <M label="LAT" v={lat?`${lat.toFixed(4)}°`:"—"} mono/>
          <M label="LON" v={lng?`${lng.toFixed(4)}°`:"—"} mono/>
        </div>
      </div>

      {/* TRAIL BAR */}
      <div className="dp-trailbar">
        <span className="dp-tl">TRAIL</span>
        <div className="dp-th-btns">
          {HOUR_OPTIONS.map(h=>(
            <button key={h} className={`dp-th ${hours===h?"active":""}`} onClick={()=>handleHoursChange(h)}>{h}h</button>
          ))}
        </div>
        <button className={`dp-ts-btn ${trailOn?"on":""}`} onClick={toggleTrail} disabled={loading}>
          {loading?<><span className="dp-spin"/>…</>:trailOn?"✕ HIDE":"▶ SHOW"}
        </button>
      </div>

      {stats&&(
        <div className="dp-trail-strip">
          <span>📍 {stats.pts}</span><span>⛵ {stats.dist} NM</span>
          <span>avg {stats.avg} kn</span><span>max {stats.max} kn</span>
        </div>
      )}

      {/* TABS */}
      <div className="dp-tabs">
        {TABS.map(t=>(
          <button key={t} className={`dp-tab ${tab===t?"on":""} ${t==="PREDICT"?"dp-tab-ai":""}`} onClick={()=>setTab(t)}>
            {t==="PREDICT"?"🤖 AI":t==="STATUS"?"📊 DBT":t}
          </button>
        ))}
      </div>

      {/* TAB BODY */}
      <div className="dp-body">

        {/* VESSEL */}
        {tab==="VESSEL"&&(
          <div className="dp-section">
            <SH>IDENTIFICATION</SH>
            <R k="Vessel Name"    v={name}/>
            <R k="IMO Number"     v={imoNum} mono/>
            <R k="MMSI"           v={mmsi} mono/>
            <R k="Call Sign"      v={callSign} mono/>
            <R k="Vessel Type"    v={getVesselTypeLabel(vtype)}/>
            <R k="Flag / Country" v={flag?`${flagE} ${getCountryName(flag)} (${flag})`:null}/>
            <SH>DIMENSIONS</SH>
            <R k="Length Overall" v={lenOA?`${lenOA} m`:null}/>
            <R k="Beam / Breadth" v={beam?`${beam} m`:null}/>
            <R k="Depth"          v={depth?`${depth} m`:null}/>
            <R k="Gross Tonnage"  v={grossT?`${grossT.toLocaleString()} GT`:null}/>
            <R k="Net Tonnage"    v={netT?`${netT.toLocaleString()} NT`:null}/>
            <R k="Dead Weight"    v={dw?`${dw.toLocaleString()} DWT`:null} hi/>
            <R k="Year Built"     v={built}/>
            <SH>POSITION</SH>
            <R k="Region"         v={region} hi/>
            <R k="Latitude"       v={lat?`${lat.toFixed(6)}°`:null} mono/>
            <R k="Longitude"      v={lng?`${lng.toFixed(6)}°`:null} mono/>
            <R k="Heading"        v={`${heading}°`}/>
            <R k="Course (COG)"   v={course?`${course.toFixed(1)}°`:null}/>
            <R k="Last Update"    v={formatTimestamp(ts)}/>
            <R k="Updated"        v={timeAgo(ts)} hi/>
          </div>
        )}

        {/* VOYAGE */}
        {tab==="VOYAGE"&&(
          <div className="dp-section">
            {(lastPortDeparted||nextPortDest)&&(
              <>
                <SH>PORT MOVEMENT</SH>
                <div className="dp-voyage-route">
                  <div className="dp-vr-box">
                    <div className="dp-vr-icon">⚓</div>
                    <div className="dp-vr-label">LAST PORT DEPARTED</div>
                    <div className="dp-vr-val hi">{lastPortDeparted||"—"}</div>
                    {lastArrivedTime  &&<div className="dp-vr-time">Arrived: {formatTimestamp(lastArrivedTime)}</div>}
                    {lastDepartedTime &&<div className="dp-vr-time">Departed: {formatTimestamp(lastDepartedTime)}</div>}
                    {portTimeHours    &&<div className="dp-vr-time">Port time: {portTimeHours.toFixed(1)}h</div>}
                  </div>
                  <div className="dp-vr-arrow">→</div>
                  <div className="dp-vr-box">
                    <div className="dp-vr-icon">🏁</div>
                    <div className="dp-vr-label">DESTINATION</div>
                    <div className="dp-vr-val hi">{nextPortDest||"—"}</div>
                    {declaredArrivalTime&&<div className="dp-vr-time">ETA: {formatTimestamp(declaredArrivalTime)}</div>}
                  </div>
                </div>
              </>
            )}
            {(berthLocation||shippingAgent||voyagePurpose)&&(
              <>
                <SH>BERTH & DECLARATION</SH>
                <R k="Berth Location"   v={berthLocation} hi/>
                <R k="Berth Grid"       v={berthGrid}/>
                <R k="Voyage Purpose"   v={voyagePurpose}/>
                <R k="Shipping Agent"   v={shippingAgent} hi/>
                <R k="Declared Arrival" v={formatTimestamp(declaredArrivalTime)}/>
                <R k="Crew on Board"    v={crewCount}/>
                <R k="Passengers"       v={passengerCount}/>
              </>
            )}
            <SH>DATA SOURCES</SH>
            <div className="dp-source-badges">
              <span className={`dp-src ${hasArrival?"active":"off"}`}>✈ Arrivals</span>
              <span className={`dp-src ${hasDeparture?"active":"off"}`}>🚢 Departures</span>
              <span className={`dp-src ${hasDeclaration?"active":"off"}`}>📋 Declaration</span>
            </div>
          </div>
        )}

        {/* STATUS — dbt enriched data */}
        {tab==="STATUS"&&(
          <div className="dp-section">
            <SH>dbt VESSEL STATUS</SH>
            <div className="dp-op-card" style={{borderColor:`${dbtStatusColor}35`,background:`${dbtStatusColor}0a`}}>
              <span className="dp-op-icon">📊</span>
              <div>
                <div className="dp-op-title" style={{color:dbtStatusColor}}>{statusLabel}</div>
                <div className="dp-op-sub">dbt computed from fct_vessel_master</div>
              </div>
            </div>
            {portTimeHours!=null&&<R k="Port Time (this call)"   v={`${portTimeHours.toFixed(2)} hours`} hi/>}
            {hoursInPort!=null  &&<R k="Hours in Port So Far"    v={`${hoursInPort.toFixed(2)} hours`} hi/>}
            <SH>DATA QUALITY</SH>
            {dataQuality!=null&&(
              <div className="dp-dq-full">
                <div className="dp-dq-full-top">
                  <span>Overall Score</span>
                  <span style={{color:dqColor,fontWeight:700}}>{dataQuality}/100</span>
                </div>
                <div className="dp-dq-full-bar">
                  <div className="dp-dq-full-fill" style={{width:`${dataQuality}%`,background:dqColor}}/>
                </div>
                <div className="dp-dq-checklist">
                  {[["+20","Live AIS position",minsSincePing!=null&&minsSincePing<360],["+20","AIS arrival record",hasArrival],["+20","Official declaration",hasDeclaration],["+20","Departure record",hasDeparture],["+20","Gross tonnage data",grossT!=null]]
                    .map(([pts,label,ok])=>(
                      <div key={label} className={`dp-dq-check ${ok?"ok":"na"}`}>
                        <span className="dp-dq-pts">{pts}</span>
                        <span className={`dp-dq-icon ${ok?"ok":"na"}`}>{ok?"✓":"✗"}</span>
                        <span>{label}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
            <SH>AIS SIGNAL</SH>
            <R k="Minutes Since Ping" v={minsSincePing!=null?`${minsSincePing} min`:null} hi/>
            <R k="Speed Category"     v={speedCategory}/>
            <R k="Is Stale"           v={vessel.is_stale?"Yes (>6h)":"No (fresh)"} hi/>
            <SH>CAPACITY</SH>
            <div className="dp-cap-grid">
              {[["DWT",dw?dw.toLocaleString():"N/A","Dead Weight Tons"],["GT",grossT?grossT.toLocaleString():"N/A","Gross Tonnage"],["NT",netT?netT.toLocaleString():"N/A","Net Tonnage"],["LOA",lenOA?`${lenOA}m`:"N/A","Length Overall"],["BM",beam?`${beam}m`:"N/A","Beam/Breadth"],["DEP",depth?`${depth}m`:"N/A","Depth"]]
                .map(([code,val,desc])=>(
                  <div key={code} className="dp-cap-card">
                    <div className="dp-cap-code">{code}</div>
                    <div className="dp-cap-val mono">{val}</div>
                    <div className="dp-cap-desc">{desc}</div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* TRAIL */}
        {tab==="TRAIL"&&(
          <div className="dp-section">
            <SH>TRACK CONTROLS</SH>
            <div className="dp-tr-ctrl">
              <div className="dp-tr-hours">
                {[12,24,48,72].map(h=>(
                  <button key={h} className={`dp-tr-h ${hours===h?"on":""}`} onClick={()=>handleHoursChange(h)}>{h}h</button>
                ))}
              </div>
              <button className={`dp-tr-btn ${trailOn?"hide":""}`} onClick={toggleTrail} disabled={loading}>
                {loading?<><span className="dp-spin"/>Loading {hours}h trail…</>:trailOn?<>📍 Hide Trail</>:<>📍 Show {hours}h Route</>}
              </button>
            </div>
            {stats&&(
              <>
                <SH>AIS TRAIL STATS</SH>
                <div className="dp-stat-grid">
                  {[["📍","Track Points",`${stats.pts}`],["🌊","Distance",`${stats.dist} NM`],["⚡","Avg Speed",`${stats.avg} kn`],["🚀","Max Speed",`${stats.max} kn`]]
                    .map(([icon,k,val])=>(
                      <div key={k} className="dp-stat-card">
                        <div className="dp-stat-icon">{icon}</div>
                        <div className="dp-stat-val mono">{val}</div>
                        <div className="dp-stat-key">{k}</div>
                      </div>
                    ))}
                </div>
                <R k="Trail From" v={stats.from} mono/>
                <R k="Trail To"   v={stats.to}   mono/>
                {stats.fromRegion&&<R k="Start Region" v={stats.fromRegion} hi/>}
                {stats.toRegion  &&<R k="End Region"   v={stats.toRegion}   hi/>}
              </>
            )}
            <SH>CURRENT POSITION</SH>
            <R k="Region"      v={region} hi/>
            <R k="Latitude"    v={lat?`${lat.toFixed(6)}°`:null} mono/>
            <R k="Longitude"   v={lng?`${lng.toFixed(6)}°`:null} mono/>
            <R k="Last Update" v={formatTimestamp(ts)}/>
          </div>
        )}

        {/* PREDICT */}
        {tab==="PREDICT"&&(
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
      </div>
    </div>
  );
}

// ── PREDICT TAB (unchanged from v5) ──────────────────────────────
function PredictTab({ prediction, predLoading, predError, predRouteOn, onLoad, onToggleRoute }) {
  const hasRun=prediction!==null||predError!==null;
  const pred=prediction?.prediction;
  const alts=prediction?.alternatives||[];
  const wps=prediction?.route_waypoints||[];

  function confColor(c){return c>=75?"#00ff9d":c>=50?"#ffaa00":"#ff5577";}
  function confClass(c){return c>=75?"conf-high":c>=50?"conf-medium":"conf-low";}
  function fmtEta(h){if(!h)return"—";if(h<1)return`${Math.round(h*60)}min`;if(h<24)return`${h.toFixed(1)}h`;return`${Math.floor(h/24)}d ${Math.round(h%24)}h`;}

  return (
    <div className="dp-section">
      {!hasRun&&!predLoading&&(
        <div className="pred-hero">
          <div className="pred-hero-orb">🤖</div>
          <div className="pred-hero-title">AI Route Prediction</div>
          <div className="pred-hero-sub">Analyses AIS trajectory, heading alignment, and port proximity to predict the next destination and ETA.</div>
          <div className="pred-hero-caps">
            <span className="pred-hero-cap">Next Port</span><span className="pred-hero-cap">ETA</span>
            <span className="pred-hero-cap">Route</span><span className="pred-hero-cap">Confidence</span>
          </div>
          <button className="pred-run-btn" onClick={onLoad}><span className="pred-run-icon">▶</span>Predict Route</button>
        </div>
      )}
      {predLoading&&(
        <div className="pred-loading">
          <div className="pred-spinner-wrap"><div className="pred-spinner"/><div className="pred-spinner-core"/></div>
          <div className="pred-loading-title">Analysing trajectory…</div>
          <div className="pred-loading-steps">
            {["Fetching 72h AIS history","Computing heading alignment","Scoring 20 candidate ports","Generating route waypoints"]
              .map((s,i)=><div key={i} className="pred-step" style={{animationDelay:`${i*0.45}s`}}><span className="pred-step-dot"/>{s}</div>)}
          </div>
        </div>
      )}
      {predError&&!predLoading&&(
        <div className="pred-error">
          <div className="pred-error-icon">⚠️</div>
          <div className="pred-error-msg">{predError}</div>
          <button className="pred-retry-btn" onClick={onLoad}>↺ Retry</button>
        </div>
      )}
      {pred&&!predLoading&&(
        <>
          <div className="pred-main-card">
            <div className="pred-mc-header">
              <span className="pred-mc-label">PREDICTED DESTINATION</span>
              {pred.is_declared&&<span className="pred-declared-badge">✓ DECLARED</span>}
            </div>
            <div className="pred-mc-port">{pred.destination}</div>
            <div className="pred-mc-meta">
              <span className="pred-mc-dist">{pred.distance_nm} NM</span>
              <span className="pred-mc-bearing">· HDG {pred.bearing_deg}°</span>
            </div>
            <div className="pred-eta-block">
              <div className="pred-eta-left">
                <div className="pred-eta-label">ESTIMATED ARRIVAL</div>
                <div className="pred-eta-value">{pred.eta_label}</div>
                {pred.eta_iso&&(
                  <div className="pred-eta-date">{new Date(pred.eta_iso).toLocaleString("en-SG",{weekday:"short",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})}</div>
                )}
              </div>
              <div className="pred-eta-right">
                <div className="pred-eta-dist-big">{pred.distance_nm}</div>
                <div className="pred-eta-dist-unit">NAUTICAL MI</div>
              </div>
            </div>
            <div className="pred-conf-wrap">
              <div className="pred-conf-header"><span>CONFIDENCE</span><span className={`pred-conf-pct ${confClass(pred.confidence)}`}>{pred.confidence}%</span></div>
              <div className="pred-conf-bar"><div className="pred-conf-fill" style={{width:`${pred.confidence}%`,background:`linear-gradient(90deg,${confColor(pred.confidence)}66,${confColor(pred.confidence)})`}}/></div>
            </div>
            <div className="pred-method"><span className="pred-method-icon">🔬</span>{pred.method}</div>
            {pred.route_method && (
              <div className="pred-lane-legend">
                <span className="pred-lane-title">ROUTE TYPE</span>
                <span className="pred-lane-tag pred-lane-tss">■ TSS</span>
                <span className="pred-lane-tag pred-lane-ais">■ AIS Lane</span>
                <span className="pred-lane-tag pred-lane-dwr">■ Deep Water</span>
              </div>
            )}
            <button className={`pred-route-btn ${predRouteOn?"on":""}`} onClick={onToggleRoute}>
              {predRouteOn?"🗺️  Hide Route on Map":"🗺️  Show Route on Map"}
            </button>
          </div>
          {alts.length>0&&(
            <>
              <SH>ALTERNATIVES</SH>
              <div className="pred-alts-list">
                {alts.map((a,i)=>(
                  <div key={i} className="pred-alt-item">
                    <div className="pred-alt-rank">#{i+2}</div>
                    <div className="pred-alt-info">
                      <div className="pred-alt-port">{a.port}</div>
                      <div className="pred-alt-meta">{a.distance_nm} NM · {a.eta_label}</div>
                    </div>
                    <div className="pred-alt-right">
                      <div className={`pred-alt-conf ${confClass(a.confidence||0)}`}>{a.confidence||0}%</div>
                      <div className="pred-alt-eta">{a.bearing_deg != null ? `${a.bearing_deg}° bearing` : a.eta_label}</div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {wps.length>0&&(
            <>
              <SH>ROUTE WAYPOINTS</SH>
              <div className="pred-timeline">
                {wps.map((wp,i)=>(
                  <div key={i} className="pred-wp">
                    <div className="pred-wp-dot-wrap"><div className={`pred-wp-dot ${wp.type}`}/></div>
                    <div className="pred-wp-info">
                      <div className="pred-wp-label">{wp.label}</div>
                      {wp.eta_hours_from_now&&<div className="pred-wp-eta">in {fmtEta(wp.eta_hours_from_now)}</div>}
                    </div>
                    <div className="pred-wp-coords">{wp.lat.toFixed(3)}°, {wp.lng.toFixed(3)}°</div>
                  </div>
                ))}
              </div>
            </>
          )}
          <div style={{padding:"6px 12px 14px"}}>
            <button className="pred-rerun-btn" onClick={onLoad}>↺ Re-run Prediction</button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────
function SH({children}) {
  return <div className="dp-sh"><div className="dp-sh-line"/><span>{children}</span><div className="dp-sh-line"/></div>;
}
function R({k,v,mono,hi}) {
  const display=v!==null&&v!==undefined&&String(v).trim()!==""?String(v):null;
  return (
    <div className={`dp-row ${hi?"dp-hi":""}`}>
      <span className="dp-rk">{k}</span>
      <span className={`dp-rv ${mono?"mono":""} ${hi?"dp-rv-hi":""} ${!display?"dp-rv-null":""}`}>{display||"—"}</span>
    </div>
  );
}
function M({label,v,mono}) {
  return <div className="dp-metric"><div className={`dp-mv ${mono?"mono":""}`}>{v}</div><div className="dp-ml">{label}</div></div>;
}