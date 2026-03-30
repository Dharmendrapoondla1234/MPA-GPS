// src/components/Vesselcomparison.jsx — MPA v9 HIGH-VISUAL
// Full grid comparison: speed gauges, fuel estimates, tonnage bars,
// dimensions, navigation, identity — all vessels side-by-side
import React, { useState, useCallback, useMemo } from "react";
import { getSpeedColor, getFlagEmoji } from "../utils/vesselUtils";
import "./Vesselcomparison.css";

const MAX_VESSELS = 4;

const SORT_OPTIONS = [
  { id:"speed",      label:"Speed",      unit:"kn",  key: v => parseFloat(v.speed)                  || 0 },
  { id:"gross",      label:"GRT",        unit:"GT",  key: v => parseFloat(v.gross_tonnage)           || 0 },
  { id:"deadweight", label:"DWT",        unit:"t",   key: v => parseFloat(v.deadweight)              || 0 },
  { id:"length",     label:"LOA",        unit:"m",   key: v => parseFloat(v.vessel_length)           || 0 },
  { id:"draught",    label:"Draught",    unit:"m",   key: v => parseFloat(v.draught)                 || 0 },
  { id:"ping",       label:"Ping Age",   unit:"min", key: v => parseFloat(v.minutes_since_last_ping) || 0 },
  { id:"year",       label:"Year Built", unit:"",    key: v => parseFloat(v.year_built)              || 0 },
];

/* ── helpers ──────────────────────────────────────────────────── */
function typeShort(raw) {
  const t = (raw || "").toLowerCase();
  if (t.includes("tanker"))    return { label:"TANKER",    cls:"tanker" };
  if (t.includes("container")) return { label:"CONTAINER", cls:"container" };
  if (t.includes("bulk"))      return { label:"BULK",      cls:"bulk" };
  if (t.includes("gas"))       return { label:"GAS",       cls:"gas" };
  if (t.includes("cargo"))     return { label:"CARGO",     cls:"cargo" };
  if (t.includes("passenger")) return { label:"PASSENGER", cls:"passenger" };
  if (t.includes("tug"))       return { label:"TUG",       cls:"tug" };
  if (t.includes("fishing"))   return { label:"FISHING",   cls:"fishing" };
  return { label: (raw || "VESSEL").substring(0, 7).toUpperCase(), cls:"generic" };
}

function speedBand(kn) {
  if (kn < 2)  return { label:"ANCHORED", cls:"anchor", color:"#90a4ae" };
  if (kn < 8)  return { label:"SLOW",     cls:"slow",   color:"#26de81" };
  if (kn < 15) return { label:"CRUISING", cls:"cruise", color:"#fd9644" };
  return              { label:"FAST",     cls:"fast",   color:"#fc5c65" };
}

// Rough fuel consumption estimate: tonnes/day based on vessel type + speed
function estimateFuel(vessel) {
  const spd = parseFloat(vessel.speed) || 0;
  const dwt = parseFloat(vessel.deadweight) || 0;
  const grt = parseFloat(vessel.gross_tonnage) || 0;
  if (spd < 0.5) return { tpd: 0, label:"AT REST", daily_usd: 0 };
  const sizeFactor = dwt > 0
    ? Math.min(dwt / 10000, 20)
    : Math.min(grt / 5000, 15);
  const base = Math.max(1, sizeFactor);
  const tpd = +(base * Math.pow(spd / 12, 3)).toFixed(1);
  const daily_usd = Math.round(tpd * 650);
  return { tpd, label:`${tpd}t/day`, daily_usd };
}

// REMOVED: unused `fmt` function — was causing 'defined but never used' lint/build error.

function exportCSV(vessels) {
  const cols = [
    ["IMO", v=>v.imo_number], ["MMSI", v=>v.mmsi_number], ["Name", v=>v.vessel_name],
    ["Flag", v=>v.flag], ["Type", v=>v.vessel_type], ["Speed (kn)", v=>v.speed],
    ["Course (°)", v=>v.course||v.heading], ["Heading (°)", v=>v.heading],
    ["Draught (m)", v=>v.draught], ["LOA (m)", v=>v.vessel_length],
    ["Beam (m)", v=>v.vessel_breadth], ["GRT", v=>v.gross_tonnage],
    ["NRT", v=>v.net_tonnage], ["DWT", v=>v.deadweight],
    ["Year Built", v=>v.year_built], ["Status", v=>v.vessel_status||v.status_label],
    ["Destination", v=>v.next_port_destination||v.destination],
    ["ETA", v=>v.eta], ["Ping (min)", v=>v.minutes_since_last_ping],
  ];
  const csv = [
    cols.map(([h]) => h).join(","),
    ...vessels.map(v => cols.map(([, fn]) => {
      const val = fn(v);
      return val != null ? `"${String(val).replace(/"/g,'""')}"` : "";
    }).join(","))
  ].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type:"text/csv" }));
  a.download = `fleet_comparison_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

/* ── Sub-components ───────────────────────────────────────────── */

function SpeedGauge({ speed, color }) {
  const spd = parseFloat(speed) || 0;
  const max = 25;
  const pct = Math.min(spd / max, 1);
  const r = 32, cx = 40, cy = 40;
  const circ = 2 * Math.PI * r;
  const arc = circ * 0.75;
  const offset = arc - pct * arc;
  const dashOffset = circ * 0.125;

  return (
    <svg className="vc-gauge-svg" viewBox="0 0 80 80" width="80" height="80">
      <circle cx={cx} cy={cy} r={r}
        fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="6"
        strokeDasharray={`${arc} ${circ - arc}`}
        strokeDashoffset={-dashOffset}
        strokeLinecap="round"
        transform={`rotate(135 ${cx} ${cy})`}
      />
      <circle cx={cx} cy={cy} r={r}
        fill="none" stroke={color} strokeWidth="6"
        strokeDasharray={`${arc} ${circ - arc}`}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(135 ${cx} ${cy})`}
        style={{ transition:"stroke-dashoffset 0.8s cubic-bezier(0.22,1,0.36,1)" }}
        filter={`drop-shadow(0 0 4px ${color})`}
      />
      <text x={cx} y={cy - 3} textAnchor="middle"
        fill={color} fontSize="14" fontWeight="700"
        fontFamily="Orbitron, monospace">
        {spd.toFixed(1)}
      </text>
      <text x={cx} y={cy + 10} textAnchor="middle"
        fill="rgba(0,229,255,0.45)" fontSize="7"
        fontFamily="JetBrains Mono, monospace">
        KN
      </text>
    </svg>
  );
}

function MiniBar({ value, max, color, label, unit, isMax }) {
  const pct = max > 0 ? Math.min((value || 0) / max, 1) * 100 : 0;
  return (
    <div className="vc-minibar-wrap">
      <div className="vc-minibar-top">
        <span className="vc-minibar-label">{label}</span>
        <span className="vc-minibar-val" style={{ color: isMax ? color : undefined }}>
          {value ? `${Number(value).toLocaleString()}${unit ? ` ${unit}` : ""}` : "—"}
          {isMax && <span className="vc-minibar-star">★</span>}
        </span>
      </div>
      <div className="vc-minibar-track">
        <div className="vc-minibar-fill"
          style={{ width:`${pct}%`, background:color,
            boxShadow: pct > 0 ? `0 0 6px ${color}88` : "none" }} />
      </div>
    </div>
  );
}

function StatRow({ label, value, highlight }) {
  return (
    <div className={`vc-srow${highlight ? " vc-srow-hi" : ""}`}>
      <span className="vc-srow-k">{label}</span>
      <span className="vc-srow-v">{value ?? "—"}</span>
      {highlight && <span className="vc-srow-star">★</span>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════════════ */
export default function VesselComparison({ vessels=[], onSelectVessel, isOpen, onClose }) {
  const [pinned,        setPinned]        = useState([]);
  const [highlightDiff, setHighlightDiff] = useState(true);
  const [sortOption,    setSortOption]    = useState("speed");
  const [sortAsc,       setSortAsc]       = useState(false);
  const [pickerOpen,    setPickerOpen]    = useState(false);
  const [pickerQuery,   setPickerQuery]   = useState("");
  const [pickerFlag,    setPickerFlag]    = useState("");

  const add = useCallback(v => {
    setPinned(prev => {
      if (prev.length >= MAX_VESSELS) return prev;
      if (prev.find(p => p.imo_number === v.imo_number)) return prev;
      return [...prev, v];
    });
    setPickerOpen(false); setPickerQuery(""); setPickerFlag("");
  }, []);

  const remove = useCallback(imo => {
    setPinned(prev => prev.filter(p => p.imo_number !== imo));
  }, []);

  const sortOpt = useMemo(() =>
    SORT_OPTIONS.find(s => s.id === sortOption) || SORT_OPTIONS[0], [sortOption]);

  const displayed = useMemo(() => {
    if (pinned.length < 2) return pinned;
    const dir = sortAsc ? 1 : -1;
    return [...pinned].sort((a,b) => dir * (sortOpt.key(a) - sortOpt.key(b)));
  }, [pinned, sortOpt, sortAsc]);

  const maxVals = useMemo(() => {
    if (!pinned.length) return {};
    const g = n => v => parseFloat(v[n]) || 0;
    const max = fn => Math.max(...pinned.map(fn), 1);
    return {
      speed:       max(g("speed")),
      gross:       max(g("gross_tonnage")),
      deadweight:  max(g("deadweight")),
      length:      max(g("vessel_length")),
      draught:     max(g("draught")),
      breadth:     max(g("vessel_breadth")),
      fuel:        Math.max(...pinned.map(v => estimateFuel(v).tpd), 0.1),
    };
  }, [pinned]);

  const statExtremes = useMemo(() => {
    if (!highlightDiff || pinned.length < 2) return {};
    const res = {};
    SORT_OPTIONS.forEach(({ id, key }) => {
      const vals = pinned.map(v => ({ imo: v.imo_number, val: key(v) })).filter(x => x.val !== 0);
      if (vals.length < 2) return;
      const mx = Math.max(...vals.map(x => x.val));
      const mn = Math.min(...vals.map(x => x.val));
      res[`${id}_max`] = vals.find(x => x.val === mx)?.imo;
      res[`${id}_min`] = vals.find(x => x.val === mn)?.imo;
    });
    return res;
  }, [pinned, highlightDiff]);

  const uniqueFlags = useMemo(() =>
    [...new Set(vessels.map(v => v.flag).filter(Boolean))].sort(), [vessels]);

  const available = useMemo(() => vessels
    .filter(v => !pinned.find(p => p.imo_number === v.imo_number))
    .filter(v => {
      if (pickerFlag && v.flag !== pickerFlag) return false;
      if (!pickerQuery) return true;
      const q = pickerQuery.toLowerCase();
      return (v.vessel_name||"").toLowerCase().includes(q)
          || String(v.imo_number||"").includes(q)
          || String(v.mmsi_number||"").includes(q);
    })
    .slice(0, 60), [vessels, pinned, pickerQuery, pickerFlag]);

  if (!isOpen) return null;

  return (
    <div className="vc-panel">

      {/* ── HEADER ───────────────────────────────────────────── */}
      <div className="vc-header">
        <div className="vc-header-left">
          <div className="vc-sonar"><div className="vc-sonar-sweep" /></div>
          <div>
            <div className="vc-title">FLEET COMPARISON</div>
            <div className="vc-subtitle">Side-by-side vessel analytics</div>
          </div>
          <div className="vc-slot-pills">
            {[0,1,2,3].map(i => (
              <div key={i} className={`vc-slot-pip ${i < pinned.length ? "vc-slot-filled" : ""}`} />
            ))}
          </div>
        </div>
        <div className="vc-header-actions">
          {pinned.length >= 2 && (
            <button className="vc-hbtn vc-hbtn-csv" onClick={() => exportCSV(pinned)}>
              ⬇ CSV
            </button>
          )}
          <button
            className={`vc-hbtn${highlightDiff ? " vc-hbtn-on" : ""}`}
            onClick={() => setHighlightDiff(p => !p)}
          >DIFF</button>
          <select className="vc-sort-select" value={sortOption}
            onChange={e => setSortOption(e.target.value)}>
            {SORT_OPTIONS.map(s => (
              <option key={s.id} value={s.id}>↕ {s.label}</option>
            ))}
          </select>
          <button className="vc-hbtn" onClick={() => setSortAsc(p => !p)}>
            {sortAsc ? "↑ ASC" : "↓ DESC"}
          </button>
          <button className="vc-hbtn-close" onClick={onClose}>✕</button>
        </div>
      </div>

      {/* ── CARDS AREA ───────────────────────────────────────── */}
      <div className="vc-cards">

        {displayed.map(v => {
          const spd   = parseFloat(v.speed) || 0;
          const col   = getSpeedColor(spd);
          const band  = speedBand(spd);
          const type  = typeShort(v.vessel_type);
          const fuel  = estimateFuel(v);
          const stale = (v.minutes_since_last_ping || 0) > 30;
          const imo   = v.imo_number;
          const isTopSpeed = highlightDiff && statExtremes["speed_max"] === imo;

          return (
            <div key={imo} className={`vc-card${isTopSpeed ? " vc-card-top" : ""}`}>

              <div className="vc-card-accent" style={{ background: col }} />

              {/* ── VESSEL IDENTITY ─────────────────────────── */}
              <div className="vc-id-row">
                <div className="vc-flag-wrap">
                  <span className="vc-flag">{getFlagEmoji(v.flag)}</span>
                  <span className={`vc-type-pill vc-type-${type.cls}`}>{type.label}</span>
                </div>
                <div className="vc-id-info">
                  <div className="vc-vessel-name"
                    onClick={() => onSelectVessel?.(v)} title="Locate on map">
                    {v.vessel_name || "UNKNOWN"}
                    <span className="vc-locate-icon">⊹</span>
                  </div>
                  <div className="vc-vessel-meta">
                    IMO {imo}
                    {v.mmsi_number && <span> · {v.mmsi_number}</span>}
                    {v.flag && <span> · {v.flag}</span>}
                  </div>
                </div>
                <button className="vc-card-remove" onClick={() => remove(imo)} title="Remove">✕</button>
              </div>

              {/* ── SPEED GAUGE + BAND ───────────────────────── */}
              <div className="vc-speed-block">
                <SpeedGauge speed={spd} color={col} />
                <div className="vc-speed-right">
                  <div className={`vc-band vc-band-${band.cls}`}>{band.label}</div>
                  <div className="vc-heading-row">
                    <span className="vc-heading-lbl">HDG</span>
                    <span className="vc-heading-val">{v.heading || v.course || "—"}°</span>
                  </div>
                  <div className="vc-heading-row">
                    <span className="vc-heading-lbl">PING</span>
                    <span className={`vc-heading-val${stale ? " vc-stale" : ""}`}>
                      {v.minutes_since_last_ping || 0}m{stale ? " ⚠" : ""}
                    </span>
                  </div>
                  {isTopSpeed && (
                    <div className="vc-fastest-badge">▲ FASTEST</div>
                  )}
                </div>
              </div>

              {/* ── FUEL ESTIMATE ────────────────────────────── */}
              <div className="vc-section">
                <div className="vc-section-head">⛽ FUEL ESTIMATE</div>
                <div className="vc-fuel-grid">
                  <div className="vc-fuel-stat">
                    <div className="vc-fuel-val" style={{ color: col }}>
                      {fuel.tpd > 0 ? fuel.tpd : "—"}
                    </div>
                    <div className="vc-fuel-unit">T / DAY</div>
                  </div>
                  <div className="vc-fuel-stat">
                    <div className="vc-fuel-val" style={{ color:"#ffd700" }}>
                      {fuel.daily_usd > 0 ? `$${(fuel.daily_usd/1000).toFixed(1)}k` : "—"}
                    </div>
                    <div className="vc-fuel-unit">USD / DAY</div>
                  </div>
                </div>
                <MiniBar
                  value={fuel.tpd} max={maxVals.fuel}
                  color={col} label="Consumption" unit="t/day"
                  isMax={highlightDiff && statExtremes["speed_max"] === imo}
                />
              </div>

              {/* ── TONNAGE ──────────────────────────────────── */}
              <div className="vc-section">
                <div className="vc-section-head">⚓ TONNAGE</div>
                <MiniBar value={parseFloat(v.gross_tonnage)||0}  max={maxVals.gross}
                  color="#00b8d9" label="GRT" unit="GT"
                  isMax={highlightDiff && statExtremes["gross_max"]===imo} />
                <MiniBar value={parseFloat(v.deadweight)||0}     max={maxVals.deadweight}
                  color="#6c63ff" label="DWT" unit="t"
                  isMax={highlightDiff && statExtremes["deadweight_max"]===imo} />
                <MiniBar value={parseFloat(v.net_tonnage)||0}    max={maxVals.gross}
                  color="#4a9eff" label="NRT" unit="NT"
                  isMax={false} />
              </div>

              {/* ── DIMENSIONS ───────────────────────────────── */}
              <div className="vc-section">
                <div className="vc-section-head">📐 DIMENSIONS</div>
                <MiniBar value={parseFloat(v.vessel_length)||0}  max={maxVals.length}
                  color="#26de81" label="LOA" unit="m"
                  isMax={highlightDiff && statExtremes["length_max"]===imo} />
                <MiniBar value={parseFloat(v.vessel_breadth)||0} max={maxVals.breadth}
                  color="#fd9644" label="BEAM" unit="m"
                  isMax={false} />
                <MiniBar value={parseFloat(v.draught)||0}        max={maxVals.draught}
                  color="#fc5c65" label="DRAUGHT" unit="m"
                  isMax={highlightDiff && statExtremes["draught_max"]===imo} />
              </div>

              {/* ── NAVIGATION ───────────────────────────────── */}
              <div className="vc-section">
                <div className="vc-section-head">🧭 NAVIGATION</div>
                <StatRow label="DEST"
                  value={(v.next_port_destination||v.destination||"").substring(0,16)||"—"} />
                <StatRow label="ETA"
                  value={v.eta ? String(v.eta).substring(0,10) : "—"} />
                <StatRow label="FROM"
                  value={(v.last_port_departed||"").substring(0,16)||"—"} />
                <StatRow label="STATUS"
                  value={(v.vessel_status||v.status_label||"").substring(0,16)||"—"} />
              </div>

              {/* ── IDENTITY ─────────────────────────────────── */}
              <div className="vc-section">
                <div className="vc-section-head">🪪 IDENTITY</div>
                <StatRow label="CALL SIGN" value={v.call_sign||"—"} />
                <StatRow label="YEAR BUILT"
                  value={v.year_built||"—"}
                  highlight={highlightDiff && statExtremes["year_max"]===imo} />
                <StatRow label="DEPTH" value={v.vessel_depth ? `${v.vessel_depth}m` : "—"} />
              </div>

            </div>
          );
        })}

        {/* ── ADD VESSEL SLOT ──────────────────────────────── */}
        {pinned.length < MAX_VESSELS && (
          <div className="vc-add-slot">
            {pickerOpen ? (
              <div className="vc-picker">
                <div className="vc-picker-head">ADD VESSEL</div>
                <input autoFocus className="vc-picker-input"
                  placeholder="Search name, IMO or MMSI…"
                  value={pickerQuery}
                  onChange={e => setPickerQuery(e.target.value)} />
                <select className="vc-picker-flag" value={pickerFlag}
                  onChange={e => setPickerFlag(e.target.value)}>
                  <option value="">All flags</option>
                  {uniqueFlags.map(f => (
                    <option key={f} value={f}>{getFlagEmoji(f)} {f}</option>
                  ))}
                </select>
                <div className="vc-picker-list">
                  {vessels.length === 0 ? (
                    <div className="vc-picker-empty">No vessels loaded</div>
                  ) : available.length === 0 ? (
                    <div className="vc-picker-empty">No vessels match your search</div>
                  ) : null}
                  {available.map((v, idx) => {
                    const spd = parseFloat(v.speed)||0;
                    const col = getSpeedColor(spd);
                    // Safe key: fall back to mmsi or index if imo_number is missing
                    const rowKey = v.imo_number || v.mmsi_number || idx;
                    return (
                      <div key={rowKey} className="vc-picker-row" onClick={() => add(v)}>
                        <span className="vc-picker-flag-icon">{getFlagEmoji(v.flag)}</span>
                        <div className="vc-picker-info">
                          <div className="vc-picker-name">{v.vessel_name}</div>
                          <div className="vc-picker-sub">
                            IMO {v.imo_number} · {typeShort(v.vessel_type).label}
                            {v.gross_tonnage ? ` · ${Number(v.gross_tonnage).toLocaleString()} GT` : ""}
                          </div>
                        </div>
                        <span className="vc-picker-spd" style={{ color: col }}>
                          {spd.toFixed(1)} kn
                        </span>
                      </div>
                    );
                  })}
                </div>
                <button className="vc-picker-cancel"
                  onClick={() => { setPickerOpen(false); setPickerQuery(""); setPickerFlag(""); }}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="vc-add-btn" onClick={() => setPickerOpen(true)}>
                <div className="vc-add-circle">
                  <span className="vc-add-plus">+</span>
                </div>
                <span className="vc-add-label">ADD VESSEL</span>
                <span className="vc-add-sub">{MAX_VESSELS - pinned.length} slot{MAX_VESSELS - pinned.length !== 1 ? "s" : ""} available</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── LEGEND FOOTER ────────────────────────────────────── */}
      <div className="vc-footer">
        <div className="vc-legend">
          {[["#90a4ae","ANCHORED","< 2 kn"],["#26de81","SLOW","2–8 kn"],
            ["#fd9644","CRUISING","8–15 kn"],["#fc5c65","FAST","> 15 kn"]].map(([c,l,r]) => (
            <div key={l} className="vc-legend-item">
              <span className="vc-legend-dot" style={{ background:c, boxShadow:`0 0 5px ${c}` }} />
              <span className="vc-legend-l">{l}</span>
              <span className="vc-legend-r">{r}</span>
            </div>
          ))}
        </div>
        {pinned.length >= 2 && (
          <button className="vc-footer-csv" onClick={() => exportCSV(pinned)}>⬇ Export CSV</button>
        )}
      </div>

    </div>
  );
}