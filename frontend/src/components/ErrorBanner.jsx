// src/components/ErrorBanner.jsx
import React, { useState } from "react";
import "./ErrorBanner.css";

export default function ErrorBanner({ message, onRetry }) {
  const [dismissed, setDismissed] = useState(false);

  if (!message || dismissed) return null;

  return (
    <div className="error-banner">
      <div className="eb-icon">⚠</div>
      <div className="eb-content">
        <span className="eb-label">CONNECTION ERROR</span>
        <span className="eb-message">{message}</span>
      </div>
      <div className="eb-actions">
        {onRetry && (
          <button className="eb-retry" onClick={onRetry}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Retry
          </button>
        )}
        <button className="eb-dismiss" onClick={() => setDismissed(true)}>✕</button>
      </div>
    </div>
  );
}