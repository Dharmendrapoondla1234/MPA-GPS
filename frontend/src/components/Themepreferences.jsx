// src/components/ThemePreferences.jsx — MPA v7
import React, { useState, useCallback } from "react";
import "./Themepreferences.css";

const THEMES = [
  {
    id: "nautical-dark",
    name: "Nautical Dark",
    colors: ["#060e18", "#00e5ff", "#26de81"],
    desc: "Deep navy · Cyan accents",
  },
  {
    id: "harbor-light",
    name: "Harbor Light",
    colors: ["#f0f4f8", "#0059b3", "#00875a"],
    desc: "Clean light · Blue accents",
  },
  {
    id: "deep-ocean",
    name: "Deep Ocean",
    colors: ["#020c1a", "#7cdcff", "#00cc99"],
    desc: "Darker navy · Sky blue",
  },
  {
    id: "radar-amber",
    name: "Radar Amber",
    colors: ["#0a0800", "#ffaa00", "#ff6600"],
    desc: "Radar black · Amber glow",
  },
];

const OVERLAYS = [
  { key:"tss",        label:"Traffic Sep. Schemes", desc:"Show TSS lane boundaries on map" },
  { key:"anchorage",  label:"Anchorage Zones",       desc:"Display anchoring area polygons" },
  { key:"weather",    label:"Weather Overlay",        desc:"Wind station markers & weather panel" },
  { key:"aiPredict",  label:"AI Route Prediction",   desc:"Show predicted routes for selected vessels" },
  { key:"portAuto",   label:"Port Panel Auto-open",   desc:"Open port activity when zooming in" },
  { key:"fleetStats", label:"Fleet Statistics Bar",  desc:"Stats strip in the top bar" },
];

export default function ThemePreferences({ isOpen, onClose, onSave }) {
  const [theme,    setTheme]    = useState("nautical-dark");
  const [refresh,  setRefresh]  = useState(30);
  const [trail,    setTrail]    = useState(70);
  const [stale,    setStale]    = useState(30);
  const [aiConf,   setAiConf]   = useState(65);
  const [overlays, setOverlays] = useState({
    tss: true, anchorage: true, weather: true,
    aiPredict: true, portAuto: false, fleetStats: true,
  });
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);

  const toggleOverlay = useCallback((key) => {
    setOverlays(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    await new Promise(r => setTimeout(r, 800));
    setSaving(false);
    setSaved(true);
    onSave?.({ theme, refresh, trail, stale, aiConf, overlays });
    setTimeout(() => setSaved(false), 3000);
  }, [theme, refresh, trail, stale, aiConf, overlays, onSave]);

  if (!isOpen) return null;

  return (
    <div className="tp-panel">
      {/* Header */}
      <div className="tp-header">
        <div className="tp-header-left">
          <span className="tp-icon">⚙</span>
          <span className="tp-title">THEME & PREFERENCES</span>
        </div>
        <button className="tp-close-btn" onClick={onClose}>✕</button>
      </div>

      <div className="tp-body">
        {/* ─── Color Theme ─── */}
        <div className="tp-section">
          <div className="tp-section-label">COLOR THEME</div>
          <div className="tp-theme-grid">
            {THEMES.map(t => (
              <div
                key={t.id}
                className={`tp-theme-card${theme === t.id ? " selected" : ""}`}
                onClick={() => setTheme(t.id)}
              >
                <div className="tp-theme-preview">
                  {t.colors.map((c, i) => (
                    <div key={i} className="tp-theme-swatch" style={{ background: c }} />
                  ))}
                </div>
                <div className="tp-theme-name">{t.name}</div>
                <div className="tp-theme-desc">{t.desc}</div>
                {theme === t.id && <div className="tp-theme-check">✓</div>}
              </div>
            ))}
          </div>
        </div>

        {/* ─── Data Preferences ─── */}
        <div className="tp-section">
          <div className="tp-section-label">DATA PREFERENCES</div>
          <div className="tp-sliders">
            <SliderRow
              label="Map Refresh Interval"
              value={refresh}
              min={10} max={120} step={5}
              fmt={v => `${v}s`}
              onChange={setRefresh}
              color="#00e5ff"
            />
            <SliderRow
              label="Trail Opacity"
              value={trail}
              min={10} max={100} step={5}
              fmt={v => `${v}%`}
              onChange={setTrail}
              color="#26de81"
            />
            <SliderRow
              label="Stale Vessel Threshold"
              value={stale}
              min={5} max={60} step={5}
              fmt={v => `${v}m`}
              onChange={setStale}
              color="#ffaa00"
              warn
            />
            <SliderRow
              label="AI Prediction Confidence Floor"
              value={aiConf}
              min={40} max={95} step={5}
              fmt={v => `${v}%`}
              onChange={setAiConf}
              color="#7cdcff"
            />
          </div>
        </div>

        {/* ─── Map Overlay Toggles ─── */}
        <div className="tp-section">
          <div className="tp-section-label">MAP OVERLAY TOGGLES</div>
          <div className="tp-overlays">
            {OVERLAYS.map(o => (
              <div key={o.key} className="tp-overlay-row">
                <div className="tp-overlay-info">
                  <div className="tp-overlay-label">{o.label}</div>
                  <div className="tp-overlay-desc">{o.desc}</div>
                </div>
                <div
                  className={`tp-toggle${overlays[o.key] ? " on" : ""}`}
                  onClick={() => toggleOverlay(o.key)}
                  role="switch"
                  aria-checked={overlays[o.key]}
                >
                  <div className="tp-toggle-knob" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Save */}
        <div className="tp-footer">
          {saved && (
            <span className="tp-saved-msg">✓ Preferences saved</span>
          )}
          <button
            className={`tp-save-btn${saving ? " saving" : ""}${saved ? " saved" : ""}`}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? (
              <><span className="tp-save-spinner" /> SAVING…</>
            ) : saved ? (
              "✓ SAVED"
            ) : (
              "SAVE PREFERENCES"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function SliderRow({ label, value, min, max, step, fmt, onChange, color, warn }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="tp-slider-row">
      <div className="tp-slider-top">
        <span className="tp-slider-label">{label}</span>
        <span className="tp-slider-val" style={{ color }}>{fmt(value)}</span>
      </div>
      <div className="tp-slider-track" style={{ "--fill": color }}>
        <div className="tp-slider-fill" style={{ width: `${pct}%`, background: color }} />
        <input
          type="range"
          className={`tp-slider${warn ? " warn" : ""}`}
          min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          style={{ "--col": color }}
        />
      </div>
    </div>
  );
}