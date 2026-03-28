// src/components/Vesselcomparison.jsx — MPA v8 Enhanced
// Compare up to 4 vessels by ALL properties, not just speed.
// Additions:
//   • Sort by any property (speed, GRT, deadweight, LOA, ping age, draught, year)
//   • Flag filter in picker
//   • Highlight outlier (max/min) for every numeric field when DIFF is on
//   • Export comparison as CSV
import React, { useState, useCallback, useMemo } from "react";
import { getSpeedColor, getFlagEmoji } from "../utils/vesselUtils";
import "./Vesselcomparison.css";

const MAX_VESSELS = 4;

const SORT_OPTIONS = [
  { id:"speed",      label:"Speed",      unit:"kn",  key: v => parseFloat(v.speed)         || 0 },
  { id:"gross",      label:"GRT",        unit:"GT",  key: v => parseFloat(v.gross_tonnage)  || 0 },
  { id:"deadweight", label:"DWT",        unit:"DWT", key: v => parseFloat(v.deadweight)     || 0 },
  { id:"length",     label:"LOA",        unit:"m",   key: v => parseFloat(v.vessel_length)  || 0 },
  { id:"draught",    label:"Draught",    unit:"m",   key: v => parseFloat(v.draught)        || 0 },
  { id:"ping",       label:"Ping Age",   unit:"min", key: v => parseFloat(v.minutes_since_last_ping) || 0 },
  { id:"year",       label:"Year Built", unit:"",    key: v => parseFloat(v.year_built)     || 0 },
];

function typeShort(raw) {
  const t = (raw||"").toLowerCase();
  if (t.includes("tanker"))    return "TANKER";
  if (t.includes("container")) return "CNTNR";
  if (t.includes("bulk"))      return "BULK";
  if (t.includes("gas"))       return "GAS";
  if (t.includes("cargo"))     return "CARGO";
  if (t.includes("passenger")) return "PASS";
  if (t.includes("tug"))       return "TUG";
  if (t.includes("fishing"))   return "FISH";
  return (raw||"GEN").substring(0,5).toUpperCase();
}

function speedBand(kn) {
  const s = parseFloat(kn)||0;
  if (s < 2)  return { label:"ANCHORED", cls:"band-anchor" };
  if (s < 8)  return { label:"SLOW",     cls:"band-slow"   };
  if (s < 15) return { label:"CRUISING", cls:"band-cruise" };
  return              { label:"FAST",     cls:"band-fast"   };
}

function fmt(v, decimals=1) {
  if (v==null||v===0||v==="") return null;
  return Number(v).toLocaleString(undefined,{maximumFractionDigits:decimals});
}

function exportCSV(vessels) {
  const cols = [
    ["IMO",v=>v.imo_number],["MMSI",v=>v.mmsi_number],["Name",v=>v.vessel_name],
    ["Flag",v=>v.flag],["Type",v=>v.vessel_type],["Speed (kn)",v=>v.speed],
    ["Course (°)",v=>v.course||v.heading],["Heading (°)",v=>v.heading],
    ["Draught (m)",v=>v.draught],["LOA (m)",v=>v.vessel_length],
    ["Breadth (m)",v=>v.vessel_breadth],["Depth (m)",v=>v.vessel_depth],
    ["GRT",v=>v.gross_tonnage],["NRT",v=>v.net_tonnage],["DWT",v=>v.deadweight],
    ["Year Built",v=>v.year_built],["Status",v=>v.vessel_status||v.status_label],
    ["Call Sign",v=>v.call_sign],["Destination",v=>v.next_port_destination||v.destination],
    ["ETA",v=>v.eta],["Last Port",v=>v.last_port_departed],
    ["Ping (min)",v=>v.minutes_since_last_ping],["Last Seen",v=>v.effective_timestamp],
  ];
  const header = cols.map(([h])=>h).join(",");
  const rows   = vessels.map(v=>cols.map(([,fn])=>{
    const val=fn(v);
    return val!=null?`"${String(val).replace(/"/g,'""')}"` : "";
  }).join(","));
  const csv  = [header,...rows].join("\n");
  const blob = new Blob([csv],{type:"text/csv;charset=utf-8;"});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href=url; a.download=`fleet_comparison_${new Date().toISOString().slice(0,10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function PropRow({label, value, isHighlight}) {
  if (value==null) return (
    <div className="vc-stat-row"><span className="vc-stat-k">{label}</span><span className="vc-stat-v">—</span></div>
  );
  return (
    <div className={`vc-stat-row${isHighlight?" vc-stat-highlight":""}`}>
      <span className="vc-stat-k">{label}</span>
      <span className="vc-stat-v">{value}{isHighlight&&<span className="vc-star"> ★</span>}</span>
    </div>
  );
}

export default function VesselComparison({ vessels=[], onSelectVessel, isOpen, onClose }) {
  const [pinned,        setPinned]        = useState([]);
  const [highlightDiff, setHighlightDiff] = useState(false);
  const [sortOption,    setSortOption]    = useState("speed");
  const [sortAsc,       setSortAsc]       = useState(false);
  const [pickerOpen,    setPickerOpen]    = useState(false);
  const [pickerQuery,   setPickerQuery]   = useState("");
  const [pickerFlag,    setPickerFlag]    = useState("");

  const add = useCallback((v)=>{
    setPinned(prev=>{
      if(prev.length>=MAX_VESSELS) return prev;
      if(prev.find(p=>p.imo_number===v.imo_number)) return prev;
      return [...prev,v];
    });
    setPickerOpen(false); setPickerQuery(""); setPickerFlag("");
  },[]);

  const remove = useCallback((imo)=>{ setPinned(prev=>prev.filter(p=>p.imo_number!==imo)); },[]);

  const sortOpt = useMemo(()=>SORT_OPTIONS.find(s=>s.id===sortOption)||SORT_OPTIONS[0],[sortOption]);

  const displayed = useMemo(()=>{
    if(pinned.length<2) return pinned;
    const dir = sortAsc ? 1 : -1;
    return [...pinned].sort((a,b)=>dir*(sortOpt.key(a)-sortOpt.key(b)));
  },[pinned,sortOpt,sortAsc]);

  const statExtremes = useMemo(()=>{
    if(!highlightDiff||pinned.length<2) return {};
    const result={};
    SORT_OPTIONS.forEach(({id,key})=>{
      const vals=pinned.map(v=>({imo:v.imo_number,val:key(v)})).filter(x=>x.val!==0);
      if(vals.length<2) return;
      const maxV=Math.max(...vals.map(x=>x.val));
      const minV=Math.min(...vals.map(x=>x.val));
      result[`${id}_max`]=vals.find(x=>x.val===maxV)?.imo;
      result[`${id}_min`]=vals.find(x=>x.val===minV)?.imo;
    });
    return result;
  },[pinned,highlightDiff]);

  const uniqueFlags = useMemo(()=>[...new Set(vessels.map(v=>v.flag).filter(Boolean))].sort(),[vessels]);

  const available = useMemo(()=>vessels
    .filter(v=>!pinned.find(p=>p.imo_number===v.imo_number))
    .filter(v=>{
      if(pickerFlag && v.flag!==pickerFlag) return false;
      if(!pickerQuery) return true;
      const q=pickerQuery.toLowerCase();
      return (v.vessel_name||"").toLowerCase().includes(q)
          || String(v.imo_number||"").includes(q)
          || String(v.mmsi_number||"").includes(q);
    })
    .slice(0,50),[vessels,pinned,pickerQuery,pickerFlag]);

  if(!isOpen) return null;

  return (
    <div className="vc-panel">
      {/* Header */}
      <div className="vc-header">
        <div className="vc-header-left">
          <div className="vc-sonar"><div className="vc-sonar-sweep"/></div>
          <span className="vc-title">VESSEL COMPARISON</span>
          <span className="vc-count">{pinned.length}/{MAX_VESSELS}</span>
        </div>
        <div className="vc-header-actions">
          {pinned.length>=2&&(
            <button className="vc-toggle-btn" onClick={()=>exportCSV(pinned)} title="Download CSV">⬇ CSV</button>
          )}
          <button className={`vc-toggle-btn${highlightDiff?" active":""}`}
            onClick={()=>setHighlightDiff(p=>!p)} title="Highlight outliers per field">DIFF</button>
          <select className="vc-sort-select" value={sortOption} onChange={e=>setSortOption(e.target.value)}>
            {SORT_OPTIONS.map(s=><option key={s.id} value={s.id}>↕ {s.label}</option>)}
          </select>
          <button className="vc-toggle-btn" onClick={()=>setSortAsc(p=>!p)} title="Toggle sort direction">
            {sortAsc?"↑ ASC":"↓ DESC"}
          </button>
          <button className="vc-close-btn" onClick={onClose}>✕</button>
        </div>
      </div>

      {/* Cards */}
      <div className="vc-cards">
        {displayed.map(v=>{
          const spd  = parseFloat(v.speed)||0;
          const col  = getSpeedColor(spd);
          const band = speedBand(spd);
          const stale= (v.minutes_since_last_ping||0)>30;
          const imo  = v.imo_number;
          const isTopField = highlightDiff&&(
            statExtremes[`${sortOption}_max`]===imo||statExtremes[`${sortOption}_min`]===imo
          );

          return (
            <div key={imo} className={`vc-card${isTopField?" vc-card-highlight":""}`}>
              <div className="vc-card-top">
                <div className="vc-flag">{getFlagEmoji(v.flag)}</div>
                <div className="vc-identity">
                  <div className="vc-name" onClick={()=>onSelectVessel?.(v)} title="Select on map">
                    {v.vessel_name||"UNKNOWN"}
                  </div>
                  <div className="vc-imo">IMO {imo}{v.mmsi_number?` · ${v.mmsi_number}`:""}</div>
                </div>
                <div className={`vc-type-badge vc-type-${typeShort(v.vessel_type).toLowerCase().replace(/[^a-z]/g,"")}`}>
                  {typeShort(v.vessel_type)}
                </div>
              </div>

              <div className="vc-speed-section">
                <div className="vc-speed-top">
                  <span className="vc-speed-val" style={{color:col}}>{spd.toFixed(1)}<span className="vc-speed-unit"> kn</span></span>
                  <span className={`vc-band ${band.cls}`}>{band.label}</span>
                </div>
                <div className="vc-bar-track">
                  <div className={`vc-bar-fill ${band.cls}`} style={{width:`${Math.min(spd/25,1)*100}%`,background:col}}/>
                </div>
              </div>

              <div className="vc-stats">
                <div className="vc-stats-group">
                  <div className="vc-stats-group-label">NAVIGATION</div>
                  <PropRow label="CRS"  value={v.course||v.heading ? `${v.course||v.heading}°T` : null} isHighlight={false}/>
                  <PropRow label="DEST" value={(v.next_port_destination||v.destination||"").substring(0,12)||null} isHighlight={false}/>
                  <PropRow label="ETA"  value={v.eta?String(v.eta).substring(0,10):null} isHighlight={false}/>
                  <PropRow label="FROM" value={(v.last_port_departed||"").substring(0,12)||null} isHighlight={false}/>
                  <PropRow label="PING" value={stale?<span className="vc-stale">{v.minutes_since_last_ping}m ⚠</span>:`${v.minutes_since_last_ping||0}m`}
                    isHighlight={highlightDiff&&statExtremes["ping_min"]===imo}/>
                </div>

                <div className="vc-stats-group">
                  <div className="vc-stats-group-label">DIMENSIONS</div>
                  <PropRow label="LOA"   value={fmt(v.vessel_length)  ? `${fmt(v.vessel_length)}m`  : null} isHighlight={highlightDiff&&statExtremes["length_max"]===imo}/>
                  <PropRow label="BEAM"  value={fmt(v.vessel_breadth) ? `${fmt(v.vessel_breadth)}m` : null} isHighlight={false}/>
                  <PropRow label="DEPTH" value={fmt(v.vessel_depth)   ? `${fmt(v.vessel_depth)}m`   : null} isHighlight={false}/>
                  <PropRow label="DRT"   value={fmt(v.draught)        ? `${fmt(v.draught)}m`        : null} isHighlight={highlightDiff&&statExtremes["draught_max"]===imo}/>
                </div>

                <div className="vc-stats-group">
                  <div className="vc-stats-group-label">TONNAGE</div>
                  <PropRow label="GRT"   value={fmt(v.gross_tonnage,0)} isHighlight={highlightDiff&&statExtremes["gross_max"]===imo}/>
                  <PropRow label="NRT"   value={fmt(v.net_tonnage,0)}   isHighlight={false}/>
                  <PropRow label="DWT"   value={fmt(v.deadweight,0)}    isHighlight={highlightDiff&&statExtremes["deadweight_max"]===imo}/>
                  <PropRow label="BUILT" value={v.year_built||null}     isHighlight={highlightDiff&&statExtremes["year_max"]===imo}/>
                </div>

                <div className="vc-stats-group">
                  <div className="vc-stats-group-label">IDENTITY</div>
                  <PropRow label="FLAG"  value={v.flag||null}      isHighlight={false}/>
                  <PropRow label="SIGN"  value={v.call_sign||null} isHighlight={false}/>
                  <PropRow label="STATE" value={(v.vessel_status||v.status_label||"").substring(0,14)||null} isHighlight={false}/>
                </div>
              </div>

              {isTopField&&(
                <div className="vc-diff-badge vc-diff-speed">
                  {statExtremes[`${sortOption}_max`]===imo?"▲":"▼"} {sortOpt.label.toUpperCase()}
                </div>
              )}
              <button className="vc-remove" onClick={()=>remove(imo)}>✕ REMOVE</button>
            </div>
          );
        })}

        {/* Add slot */}
        {pinned.length<MAX_VESSELS&&(
          <div className="vc-add-slot">
            {pickerOpen?(
              <div className="vc-picker">
                <input autoFocus className="vc-picker-input" placeholder="Name, IMO, or MMSI…"
                  value={pickerQuery} onChange={e=>setPickerQuery(e.target.value)}/>
                <select className="vc-picker-flag-filter" value={pickerFlag} onChange={e=>setPickerFlag(e.target.value)}>
                  <option value="">All flags</option>
                  {uniqueFlags.map(f=><option key={f} value={f}>{getFlagEmoji(f)} {f}</option>)}
                </select>
                <div className="vc-picker-list">
                  {available.length===0&&<div className="vc-picker-empty">No vessels found</div>}
                  {available.map(v=>(
                    <div key={v.imo_number} className="vc-picker-item" onClick={()=>add(v)}>
                      <span className="vc-picker-flag">{getFlagEmoji(v.flag)}</span>
                      <div>
                        <div className="vc-picker-name">{v.vessel_name}</div>
                        <div className="vc-picker-meta">
                          IMO {v.imo_number} · {typeShort(v.vessel_type)} · {(parseFloat(v.speed)||0).toFixed(1)} kn
                          {v.gross_tonnage?` · ${Number(v.gross_tonnage).toLocaleString()} GT`:""}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <button className="vc-picker-cancel"
                  onClick={()=>{setPickerOpen(false);setPickerQuery("");setPickerFlag("");}}>Cancel</button>
              </div>
            ):(
              <button className="vc-add-btn" onClick={()=>setPickerOpen(true)}>
                <span className="vc-add-plus">+</span><span>ADD VESSEL</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Legend + export */}
      <div className="vc-legend">
        {[["ANCHORED","< 2 kn","#90a4ae"],["SLOW","2–8 kn","#26de81"],
          ["CRUISING","8–15 kn","#fd9644"],["FAST","> 15 kn","#fc5c65"]].map(([label,range,col])=>(
          <div key={label} className="vc-legend-item">
            <span className="vc-legend-dot" style={{background:col}}/>
            <span className="vc-legend-label">{label}</span>
            <span className="vc-legend-range">{range}</span>
          </div>
        ))}
        {pinned.length>=2&&(
          <div className="vc-legend-item" style={{cursor:"pointer",marginLeft:"auto"}} onClick={()=>exportCSV(pinned)}>
            <span>⬇</span><span className="vc-legend-label">EXPORT CSV</span>
          </div>
        )}
      </div>
    </div>
  );
}
