// src/components/WeatherPanel.jsx — MPA Live Weather Overlay v1
import React, { useState, useEffect, useCallback, useRef } from "react";
import "./WeatherPanel.css";

const BASE_URL = process.env.REACT_APP_API_URL || "https://maritime-connect.onrender.com/api";
const REFRESH_MS = 3 * 60 * 1000; // 3 min — matches backend cache

// ── Wind speed to colour (Beaufort-based) ──────────────────────
function windColor(ms) {
  if (ms < 3.4)  return "#00e5ff";   // calm/light  — cyan
  if (ms < 8.0)  return "#00ff9d";   // gentle/mod  — green
  if (ms < 13.9) return "#ffcc00";   // fresh/strong — amber
  if (ms < 20.8) return "#ff8800";   // gale        — orange
  return "#ff2244";                   // storm+      — red
}
function beaufortBg(scale) {
  if (scale <= 2) return "rgba(0,229,255,0.10)";
  if (scale <= 4) return "rgba(0,255,157,0.10)";
  if (scale <= 6) return "rgba(255,204,0,0.10)";
  if (scale <= 8) return "rgba(255,136,0,0.10)";
  return "rgba(255,34,68,0.14)";
}
function windArrow(deg) {
  if (deg == null) return "–";
  // Unicode arrow: rotate with CSS or just use cardinal
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ── Forecast code → background gradient ──────────────────────
function forecastGrad(code) {
  const c = (code || "").toUpperCase();
  if (c.includes("TL") || c.includes("TH")) return "linear-gradient(135deg,#1a0a2e,#2c1a00)";
  if (c.includes("HR") || c.includes("SH")) return "linear-gradient(135deg,#031828,#002838)";
  if (c.includes("LR") || c.includes("RN")) return "linear-gradient(135deg,#051e28,#041428)";
  if (c.includes("CL") || c.includes("OC")) return "linear-gradient(135deg,#0d0d1a,#101820)";
  if (c.includes("PC") || c.includes("FG")) return "linear-gradient(135deg,#071428,#0a1820)";
  return "linear-gradient(135deg,#071428,#081820)";
}

/* ══════════════════════════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════════════════════════ */
export default function WeatherPanel({ onStationHover, onStationLeave, expanded: expandedProp, onClose, onDataLoad }) {
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [expanded,  setExpanded]  = useState(expandedProp || false);
  const [tab,       setTab]       = useState("live");   // live | 24h | 4day
  const [lastUpdate,setLastUpdate]= useState(null);
  const timerRef = useRef(null);

  // Sync with parent-controlled expanded state
  useEffect(() => {
    if (expandedProp !== undefined) setExpanded(expandedProp);
  }, [expandedProp]);

  const fetchWeather = useCallback(async () => {
    try {
      const r = await fetch(`${BASE_URL}/weather`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`Server error (HTTP ${r.status})`);
      const j = await r.json();
      if (j?.data) {
        setData(j.data);
        onDataLoad?.(j.data);
        setLastUpdate(new Date());
        setError(null);
      } else {
        throw new Error("No weather data in response");
      }
    } catch (e) {
      if (e.name === "TimeoutError") setError("Connection timed out — retrying…");
      else if (e.message.includes("Failed to fetch")) setError("Cannot reach weather server");
      else setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [onDataLoad]);

  useEffect(() => {
    fetchWeather();
    timerRef.current = setInterval(fetchWeather, REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, [fetchWeather]);

  /* ── Derived values ──────────────────────────────────────── */
  const stations   = data?.live?.stations || [];
  const twoHr      = data?.live?.twoHr    || [];
  const fourDay    = data?.forecast?.fourDay     || [];
  const twentyFour = data?.forecast?.twentyFour  || [];

  // Pick "headline" station — highest wind speed (Marina Bay area preferred)
  const headline = stations.length
    ? [...stations].sort((a,b) => b.wind_speed_ms - a.wind_speed_ms)[0]
    : null;

  // Overall Beaufort alert level
  const maxBeaufort = stations.reduce((m, s) => Math.max(m, s.beaufort?.scale || 0), 0);
  const hasAlert    = stations.some(s => s.alert);
  const hasDanger   = stations.some(s => s.alert === "danger");

  // Rainfall: find any station reporting rain
  const rainingStations = stations.filter(s => s.rainfall_mm != null && s.rainfall_mm > 0);

  /* ── Collapsed: render nothing — strip button handles toggle ── */
  if (!expanded) return null;

  /* ── Expanded panel ────────────────────────────────────── */
  return (
    <div className="wp-panel" onClick={e => e.stopPropagation()}>

      {/* HEADER */}
      <div className="wp-header">
        <div className="wp-header-left">
          <span className="wp-icon">🌊</span>
          <div>
            <div className="wp-title">LIVE WEATHER</div>
            <div className="wp-subtitle">
              {lastUpdate
                ? `Updated ${lastUpdate.toLocaleTimeString("en-SG",{hour:"2-digit",minute:"2-digit"})}`
                : "Loading…"}
            </div>
          </div>
        </div>
        <div className="wp-header-right">
          <button className="wp-refresh" onClick={fetchWeather} title="Refresh">↻</button>
          <button className="wp-close"   onClick={() => { setExpanded(false); onClose?.(); }}>✕</button>
        </div>
      </div>

      {/* WEATHER ALERT BANNER */}
      {hasDanger && (
        <div className="wp-alert wp-alert-danger">
          ⚠️ STRONG WIND ADVISORY — Beaufort {maxBeaufort}
        </div>
      )}
      {!hasDanger && hasAlert && (
        <div className="wp-alert wp-alert-warn">
          💨 ELEVATED WIND — Beaufort {maxBeaufort}
        </div>
      )}

      {/* HEADLINE WEATHER CARD */}
      {headline && !loading && (
        <div className="wp-hero" style={{ background: beaufortBg(headline.beaufort?.scale) }}>
          <div className="wp-hero-left">
            <div className="wp-hero-speed" style={{ color: windColor(headline.wind_speed_ms) }}>
              {headline.wind_speed_kn}
              <span className="wp-hero-unit"> kn</span>
            </div>
            <div className="wp-hero-ms">{headline.wind_speed_ms.toFixed(1)} m/s</div>
            <div className="wp-hero-beaufort" style={{ color: windColor(headline.wind_speed_ms) }}>
              BFT {headline.beaufort?.scale} · {headline.beaufort?.label}
            </div>
          </div>
          <div className="wp-hero-right">
            <div className="wp-hero-dir">
              {headline.wind_direction != null
                ? <><span className="wp-hero-arrow">↑</span> {windArrow(headline.wind_direction)}</>
                : "–"
              }
            </div>
            {rainingStations.length > 0 && (
              <div className="wp-hero-rain">
                🌧️ {rainingStations[0].rainfall_mm?.toFixed(1)} mm
              </div>
            )}
            <div className="wp-hero-station">{headline.station_name}</div>
          </div>
        </div>
      )}

      {loading && (
        <div className="wp-loading">
          <div className="wp-spin" />
          <span>Fetching live data…</span>
        </div>
      )}
      {error && (
        <div className="wp-error">⚠️ {error}</div>
      )}

      {/* TABS */}
      {!loading && !error && (
        <>
          <div className="wp-tabs">
            {[["live","📡 STATIONS"],["24h","🕐 24HR"],["4day","📅 4-DAY"]].map(([k,l]) => (
              <button key={k} className={`wp-tab ${tab === k ? "wp-tab-active" : ""}`} onClick={() => setTab(k)}>
                {l}
              </button>
            ))}
          </div>

          {/* ── TAB: LIVE STATIONS ── */}
          {tab === "live" && (
            <div className="wp-station-list">
              {stations.length === 0 && <div className="wp-empty">No live station data</div>}
              {stations.map(s => (
                <div
                  key={s.station_id}
                  className={`wp-station ${s.alert === "danger" ? "wp-station-danger" : s.alert === "warning" ? "wp-station-warn" : ""}`}
                  onMouseEnter={() => onStationHover?.(s)}
                  onMouseLeave={() => onStationLeave?.()}
                >
                  <div className="wp-st-left">
                    <div className="wp-st-name">{s.station_name}</div>
                    <div className="wp-st-id">{s.station_id}</div>
                  </div>
                  <div className="wp-st-right">
                    <span className="wp-st-speed" style={{ color: windColor(s.wind_speed_ms) }}>
                      {s.wind_speed_kn} kn
                    </span>
                    {s.wind_direction != null && (
                      <span className="wp-st-dir">{windArrow(s.wind_direction)}</span>
                    )}
                    {s.rainfall_mm != null && s.rainfall_mm > 0 && (
                      <span className="wp-st-rain">🌧️{s.rainfall_mm.toFixed(1)}</span>
                    )}
                    {s.alert && (
                      <span className={`wp-st-alert ${s.alert === "danger" ? "wp-st-alert-d" : "wp-st-alert-w"}`}>
                        {s.alert === "danger" ? "⚠️" : "〰️"}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {twoHr.length > 0 && (
                <>
                  <div className="wp-section-label">2-HOUR AREA FORECAST</div>
                  <div className="wp-twhr-grid">
                    {twoHr.slice(0, 9).map((a, i) => (
                      <div key={i} className="wp-twhr-cell" title={a.forecast}>
                        <span className="wp-twhr-icon">{a.icon}</span>
                        <span className="wp-twhr-area">{a.area?.split(" ")[0]}</span>
                      </div>
                    ))}
                  </div>
                  {twoHr[0] && (
                    <div className="wp-twhr-period">⏱ {twoHr[0].period_text}</div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── TAB: 24HR FORECAST ── */}
          {tab === "24h" && (
            <div className="wp-forecast-list">
              {twentyFour.length === 0 && <div className="wp-empty">No 24hr forecast</div>}
              {twentyFour.map((p, i) => (
                <div key={i} className="wp-period-card" style={{ background: forecastGrad(p.code) }}>
                  <div className="wp-pc-header">
                    <span className="wp-pc-icon">{p.icon}</span>
                    <div>
                      <div className="wp-pc-period">{p.period}</div>
                      <div className="wp-pc-text">{p.text}</div>
                    </div>
                  </div>
                  <div className="wp-pc-grid">
                    <div className="wp-pc-cell">
                      <span className="wp-pc-label">TEMP</span>
                      <span className="wp-pc-val">{p.temp.low}–{p.temp.high}°C</span>
                    </div>
                    <div className="wp-pc-cell">
                      <span className="wp-pc-label">HUMID</span>
                      <span className="wp-pc-val">{p.humidity.low}–{p.humidity.high}%</span>
                    </div>
                    <div className="wp-pc-cell">
                      <span className="wp-pc-label">WIND</span>
                      <span className="wp-pc-val">{p.wind.low}–{p.wind.high} {p.wind.direction}</span>
                    </div>
                  </div>
                  {p.regions && Object.keys(p.regions).length > 0 && (
                    <div className="wp-pc-regions">
                      {Object.entries(p.regions).map(([region, rf]) => (
                        <span key={region} className="wp-pc-region" title={rf.text}>
                          {rf.icon} {region}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── TAB: 4-DAY FORECAST ── */}
          {tab === "4day" && (
            <div className="wp-fourday">
              {fourDay.length === 0 && <div className="wp-empty">No forecast data</div>}
              {fourDay.map((d, i) => (
                <div key={i} className="wp-day-card" style={{ background: forecastGrad(d.code) }}>
                  <div className="wp-day-top">
                    <span className="wp-day-icon">{d.icon}</span>
                    <div className="wp-day-meta">
                      <div className="wp-day-name">{d.day}</div>
                      <div className="wp-day-summary">{d.summary}</div>
                    </div>
                  </div>
                  <div className="wp-day-stats">
                    <div className="wp-day-stat">
                      <span className="wp-ds-label">🌡️</span>
                      <span className="wp-ds-val">{d.temp.low}–{d.temp.high}°C</span>
                    </div>
                    <div className="wp-day-stat">
                      <span className="wp-ds-label">💧</span>
                      <span className="wp-ds-val">{d.humidity.low}–{d.humidity.high}%</span>
                    </div>
                    <div className="wp-day-stat">
                      <span className="wp-ds-label">💨</span>
                      <span className="wp-ds-val">{d.wind.low}–{d.wind.high} km/h {d.wind.direction}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* FOOTER */}
      <div className="wp-footer">
        <span>MPA WEATHER · {stations.length} STATIONS</span>
        <span className="wp-footer-dot">·</span>
        <span>NEA DATA</span>
      </div>
    </div>
  );
}