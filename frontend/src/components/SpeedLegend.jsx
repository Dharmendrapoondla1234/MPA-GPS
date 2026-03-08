// src/components/SpeedLegend.jsx
import React, { useState } from "react";
import "./SpeedLegend.css";

const LEGEND = [
  { label: "Stopped", range: "≤ 0.3 kn", color: "#90a4ae", icon: "⚓" },
  { label: "Slow",    range: "0.3–5 kn",  color: "#26de81", icon: "🐢" },
  { label: "Medium",  range: "5–12 kn",   color: "#fd9644", icon: "⚡" },
  { label: "Fast",    range: "≥ 12 kn",   color: "#fc5c65", icon: "🚀" },
];

export default function SpeedLegend() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`speed-legend ${expanded ? "expanded" : ""}`}>
      <button className="sl-toggle" onClick={() => setExpanded((e) => !e)}>
        <span className="sl-toggle-label">SPEED</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s",
          }}
        >
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>

      {expanded && (
        <div className="sl-items">
          {LEGEND.map((item) => (
            <div key={item.label} className="sl-item">
              <div
                className="sl-dot"
                style={{
                  background: item.color,
                  boxShadow: `0 0 6px ${item.color}88`,
                }}
              />
              <div className="sl-info">
                <span className="sl-label">{item.label}</span>
                <span className="sl-range">{item.range}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {!expanded && (
        <div className="sl-dots-row">
          {LEGEND.map((item) => (
            <div
              key={item.label}
              className="sl-mini-dot"
              style={{ background: item.color }}
              title={`${item.label}: ${item.range}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}