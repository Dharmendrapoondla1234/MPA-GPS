// src/components/Authpage.jsx — Full backend auth with smart registration flow
import React, { useState, useEffect, useRef } from "react";
import { loginUser, signupUser, checkEmailExists } from "../services/api";
import "./AuthPage.css";

export default function AuthPage({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [step, setStep] = useState("email"); // "email" | "password" | "register"
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showPw, setShowPw] = useState(false);
  const emailRef = useRef(null);
  const passRef = useRef(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  // Smart email check — is this email registered?
  async function handleEmailNext(e) {
    e.preventDefault();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Enter a valid email address");
      return;
    }
    setChecking(true);
    setError("");
    const exists = await checkEmailExists(email);
    setChecking(false);
    if (exists) {
      setMode("login");
      setStep("password");
      setTimeout(() => passRef.current?.focus(), 100);
    } else {
      setMode("signup");
      setStep("register");
      setTimeout(() => passRef.current?.focus(), 100);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");
    try {
      if (mode === "login") {
        const user = await loginUser(email, password);
        setSuccess("Access granted! Loading…");
        setTimeout(() => onAuth(user), 700);
      } else {
        const user = await signupUser(name, email, password);
        setSuccess("Account created! Welcome aboard!");
        setTimeout(() => onAuth(user), 700);
      }
    } catch (err) {
      if (err.code === "already_registered") {
        setError("Already registered — switching to sign in");
        setTimeout(() => {
          setMode("login");
          setStep("password");
          setError("");
        }, 1200);
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }

  function resetToEmail() {
    setStep("email");
    setMode("login");
    setPassword("");
    setError("");
    setSuccess("");
  }

  const isLogin = mode === "login";
  const isEmailSt = step === "email";
  const isPassSt = step === "password";
  const isRegSt = step === "register";

  return (
    <div className="auth-root">
      {/* Background */}
      <div className="auth-bg">
        <div className="auth-grid" />
        <div className="auth-radar">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="radar-ring"
              style={{ animationDelay: `${i * 0.6}s` }}
            />
          ))}
          <div className="radar-center" />
        </div>
        <div className="auth-ships">
          {[...Array(8)].map((_, i) => (
            <div
              key={i}
              className="auth-ship"
              style={{
                left: `${10 + i * 11}%`,
                top: `${20 + Math.sin(i) * 30}%`,
                animationDelay: `${i * 0.8}s`,
                animationDuration: `${3 + i * 0.4}s`,
              }}
            >
              ▲
            </div>
          ))}
        </div>
      </div>

      {/* Card */}
      <div className="auth-card">
        {/* Logo */}
        <div className="auth-logo">
          <div className="auth-logo-icon">
            <div className="logo-sonar-ring" />
            <div
              className="logo-sonar-ring"
              style={{ animationDelay: "0.5s" }}
            />
            <span>⚓</span>
          </div>
          <div>
            <div className="auth-logo-text">
              MARINE<span>TRACK</span>
            </div>
            <div className="auth-logo-sub">LIVE AIS · VESSEL INTELLIGENCE</div>
          </div>
        </div>

        {/* Status pill */}
        <div className={`auth-mode-pill ${isLogin ? "login" : "register"}`}>
          {isEmailSt && (
            <>
              <span className="auth-pill-dot" />
              Enter your email to continue
            </>
          )}
          {isPassSt && (
            <>
              <span className="auth-pill-dot" />
              Welcome back — enter your password
            </>
          )}
          {isRegSt && (
            <>
              <span className="auth-pill-dot new" />
              New here — create your account
            </>
          )}
        </div>

        {/* Email step */}
        {isEmailSt && (
          <form
            className="auth-form"
            onSubmit={handleEmailNext}
            key="email-step"
          >
            <div className="auth-field">
              <label className="auth-label">EMAIL ADDRESS</label>
              <div className="auth-input-wrap">
                <span className="auth-input-icon">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                    <polyline points="22,6 12,13 2,6" />
                  </svg>
                </span>
                <input
                  ref={emailRef}
                  className="auth-input"
                  type="email"
                  placeholder="operator@maritime.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError("");
                  }}
                  required
                  autoComplete="email"
                />
              </div>
            </div>
            {error && (
              <div className="auth-error">
                <ErrIcon />
                {error}
              </div>
            )}
            <button
              className="auth-submit"
              type="submit"
              disabled={checking || loading}
            >
              {checking ? (
                <>
                  <div className="auth-spinner" />
                  Checking…
                </>
              ) : (
                <>CONTINUE →</>
              )}
            </button>
          </form>
        )}

        {/* Password step (login) */}
        {isPassSt && (
          <form className="auth-form" onSubmit={handleSubmit} key="pass-step">
            <div className="auth-field">
              <div className="auth-email-display">
                <span>✉️ {email}</span>
                <button
                  type="button"
                  className="auth-change-email"
                  onClick={resetToEmail}
                >
                  Change
                </button>
              </div>
            </div>
            <div className="auth-field">
              <label className="auth-label">PASSWORD</label>
              <div className="auth-input-wrap">
                <span className="auth-input-icon">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </span>
                <input
                  ref={passRef}
                  className="auth-input"
                  type={showPw ? "text" : "password"}
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError("");
                  }}
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="auth-pw-toggle"
                  onClick={() => setShowPw((p) => !p)}
                  tabIndex={-1}
                >
                  {showPw ? "🙈" : "👁️"}
                </button>
              </div>
            </div>
            {error && (
              <div className="auth-error">
                <ErrIcon />
                {error}
              </div>
            )}
            {success && <div className="auth-success">✅ {success}</div>}
            <button className="auth-submit" type="submit" disabled={loading}>
              {loading ? (
                <>
                  <div className="auth-spinner" />
                  AUTHENTICATING…
                </>
              ) : (
                <>ACCESS SYSTEM</>
              )}
            </button>
            <button
              type="button"
              className="auth-back-btn"
              onClick={resetToEmail}
            >
              ← Back
            </button>
          </form>
        )}

        {/* Register step */}
        {isRegSt && (
          <form className="auth-form" onSubmit={handleSubmit} key="reg-step">
            <div className="auth-new-badge">🆕 New account for {email}</div>
            <div
              className="auth-field"
              style={{ animation: "fadeUp 0.3s ease both" }}
            >
              <label className="auth-label">YOUR NAME</label>
              <div className="auth-input-wrap">
                <span className="auth-input-icon">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </span>
                <input
                  className="auth-input"
                  type="text"
                  placeholder="Full name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError("");
                  }}
                  required
                  autoComplete="name"
                />
              </div>
            </div>
            <div className="auth-field">
              <label className="auth-label">PASSWORD</label>
              <div className="auth-input-wrap">
                <span className="auth-input-icon">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </span>
                <input
                  ref={passRef}
                  className="auth-input"
                  type={showPw ? "text" : "password"}
                  placeholder="Min 6 characters"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError("");
                  }}
                  required
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="auth-pw-toggle"
                  onClick={() => setShowPw((p) => !p)}
                  tabIndex={-1}
                >
                  {showPw ? "🙈" : "👁️"}
                </button>
              </div>
            </div>
            {password && (
              <div className="auth-pw-strength">
                <div className="pw-bar">
                  {[1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className={`pw-seg ${password.length >= i * 3 ? (i === 3 ? "strong" : i === 2 ? "medium" : "weak") : ""}`}
                    />
                  ))}
                </div>
                <span>
                  {password.length < 6
                    ? "Too short"
                    : password.length < 8
                      ? "Fair"
                      : "Strong"}
                </span>
              </div>
            )}
            {error && (
              <div className="auth-error">
                <ErrIcon />
                {error}
              </div>
            )}
            {success && <div className="auth-success">✅ {success}</div>}
            <button
              className="auth-submit register"
              type="submit"
              disabled={loading}
            >
              {loading ? (
                <>
                  <div className="auth-spinner" />
                  CREATING ACCOUNT…
                </>
              ) : (
                <>CREATE ACCOUNT</>
              )}
            </button>
            <button
              type="button"
              className="auth-back-btn"
              onClick={resetToEmail}
            >
              ← Use different email
            </button>
          </form>
        )}

        {/* Stats */}
        <div className="auth-stats">
          {[
            ["437K+", "Vessels Tracked"],
            ["180+", "Countries"],
            ["99.9%", "Uptime"],
            ["Live", "AIS Data"],
          ].map(([v, l]) => (
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

function ErrIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
