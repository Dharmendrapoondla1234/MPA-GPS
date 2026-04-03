// src/pages/AuthPage.jsx
import React, { useState } from "react";
import { loginUser, signupUser } from "../services/api";
import "./AuthPage.css";

export default function AuthPage({ onAuth }) {
  const [mode,     setMode]     = useState("login"); // "login"|"signup"
  const [name,     setName]     = useState("");
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true); setError("");
    try {
      const user = mode === "login"
        ? await loginUser(email, password)
        : await signupUser(name, email, password);
      onAuth(user);
    } catch(err) { setError(err.message); }
    finally { setLoading(false); }
  }

  return (
    <div className="auth-root">
      {/* Animated background */}
      <div className="auth-bg">
        <div className="auth-grid" />
        <div className="auth-radar">
          {[...Array(4)].map((_,i) => (
            <div key={i} className="radar-ring" style={{ animationDelay:`${i*0.6}s` }} />
          ))}
          <div className="radar-center" />
        </div>
        <div className="auth-ships">
          {[...Array(8)].map((_,i) => (
            <div key={i} className="auth-ship" style={{
              left:`${10+i*11}%`, top:`${20+Math.sin(i)*30}%`,
              animationDelay:`${i*0.8}s`, animationDuration:`${3+i*0.4}s`
            }}>▲</div>
          ))}
        </div>
      </div>

      {/* Card */}
      <div className="auth-card">
        {/* Logo */}
        <div className="auth-logo">
          <div className="auth-logo-icon">
            <div className="logo-sonar-ring" />
            <div className="logo-sonar-ring" style={{animationDelay:"0.5s"}} />
            <span>⚓</span>
          </div>
          <div>
            <div className="auth-logo-text">MARINE<span>TRACK</span></div>
            <div className="auth-logo-sub">LIVE AIS · VESSEL INTELLIGENCE</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="auth-tabs">
          <button className={`auth-tab ${mode==="login"?"active":""}`} onClick={()=>{setMode("login");setError("")}}>
            SIGN IN
          </button>
          <button className={`auth-tab ${mode==="signup"?"active":""}`} onClick={()=>{setMode("signup");setError("")}}>
            REGISTER
          </button>
          <div className="auth-tab-indicator" style={{ transform:`translateX(${mode==="login"?"0":"100%"})` }} />
        </div>

        {/* Form */}
        <form className="auth-form" onSubmit={handleSubmit}>
          {mode === "signup" && (
            <div className="auth-field" style={{ animation:"fadeUp 0.3s ease both" }}>
              <label className="auth-label">OPERATOR NAME</label>
              <div className="auth-input-wrap">
                <span className="auth-input-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                    <circle cx="12" cy="7" r="4"/>
                  </svg>
                </span>
                <input
                  className="auth-input"
                  type="text"
                  placeholder="Your full name"
                  value={name}
                  onChange={e=>setName(e.target.value)}
                  required
                />
              </div>
            </div>
          )}

          <div className="auth-field">
            <label className="auth-label">EMAIL ADDRESS</label>
            <div className="auth-input-wrap">
              <span className="auth-input-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                  <polyline points="22,6 12,13 2,6"/>
                </svg>
              </span>
              <input
                className="auth-input"
                type="email"
                placeholder="operator@maritime.com"
                value={email}
                onChange={e=>setEmail(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="auth-field">
            <label className="auth-label">PASSWORD</label>
            <div className="auth-input-wrap">
              <span className="auth-input-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
              </span>
              <input
                className="auth-input"
                type="password"
                placeholder={mode==="login"?"Enter password":"Min. 6 characters"}
                value={password}
                onChange={e=>setPassword(e.target.value)}
                required
              />
            </div>
          </div>

          {error && (
            <div className="auth-error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              {error}
            </div>
          )}

          <button className="auth-submit" type="submit" disabled={loading}>
            {loading ? (
              <><div className="auth-spinner" /> AUTHENTICATING…</>
            ) : (
              <>{mode==="login" ? "ACCESS SYSTEM" : "CREATE ACCOUNT"}</>
            )}
          </button>
        </form>

        {/* Stats row */}
        <div className="auth-stats">
          {[["437K+","Vessels Tracked"],["180+","Countries"],["99.9%","Uptime"],["Live","AIS Data"]].map(([v,l])=>(
            <div key={l} className="auth-stat">
              <div className="auth-stat-val">{v}</div>
              <div className="auth-stat-label">{l}</div>
            </div>
          ))}
        </div>

        <div className="auth-footer">
          MarineTrack · Powered by Google BigQuery AIS Data
        </div>
      </div>
    </div>
  );
}