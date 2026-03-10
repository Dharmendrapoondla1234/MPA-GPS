import React, { useState, useCallback, useEffect, useRef } from "react";
import AuthPage from "./components/Authpage";
import TopBar from "./components/TopBar";
import VesselPanel from "./components/VesselPanel";
import VesselDetailPanel from "./components/VesselDetailPanel";
import MapView from "./components/MapView";
import SpeedLegend from "./components/SpeedLegend";
import ErrorBanner from "./components/ErrorBanner";
import PortActivityPanel from "./components/PortActivityPanel";
import { useVessels } from "./hooks/useVessels";
import { getCurrentUser, logoutUser } from "./services/api";
import "./styles/App.css";

const IS_MOBILE = () => window.innerWidth <= 768;

/* ═══════════════════════════════════════════════════════════════
   FREE STREAMING — 5 minutes of free access before auth wall
   ─────────────────────────────────────────────────────────────
   Logic:
   • On FIRST open: record start time in sessionStorage, show map
   • Each second: calculate remaining = 300 - (now - start)
   • At 0: show AuthPage wall
   • On login: clear session, never show wall again
   • On logout: reset so user gets another free session
   • Uses sessionStorage (not localStorage) so each browser tab
     gets its own fresh 5-minute session
═══════════════════════════════════════════════════════════════ */
const FREE_SECONDS = 300;
const FREE_KEY = "mpa_free_start";

function getFreeSecsRemaining() {
  try {
    const raw = sessionStorage.getItem(FREE_KEY);
    if (!raw) return FREE_SECONDS; // no timer set yet
    const elapsed = Math.floor((Date.now() - parseInt(raw, 10)) / 1000);
    return Math.max(0, FREE_SECONDS - elapsed);
  } catch {
    return FREE_SECONDS;
  }
}

function startFreeTimer() {
  try {
    if (!sessionStorage.getItem(FREE_KEY)) {
      sessionStorage.setItem(FREE_KEY, String(Date.now()));
    }
  } catch {}
}

function resetFreeTimer() {
  try {
    sessionStorage.removeItem(FREE_KEY);
    sessionStorage.setItem(FREE_KEY, String(Date.now()));
  } catch {}
}

/* ═══════════════════════════════════════════════════════════════ */

export default function App() {

  const [user, setUser] = useState(() => getCurrentUser());

  // ── Free streaming ──────────────────────────────────────────
  // Always start with map visible. Timer starts on mount.
  const [freeSecsLeft, setFreeSecsLeft] = useState(FREE_SECONDS);
  const [freeExpired,  setFreeExpired]  = useState(false);
  const freeIntervalRef = useRef(null);

  // Start the free timer on first mount (or when user logs out)
  useEffect(() => {
    // If already logged in, no timer needed at all
    if (user) {
      clearInterval(freeIntervalRef.current);
      return;
    }

    // Stamp the start time (no-op if already stamped this session)
    startFreeTimer();

    // Check immediately in case page was loaded mid-session
    const initialRem = getFreeSecsRemaining();
    setFreeSecsLeft(initialRem);
    if (initialRem <= 0) {
      setFreeExpired(true);
      return;
    }

    // Tick every second
    freeIntervalRef.current = setInterval(() => {
      const rem = getFreeSecsRemaining();
      setFreeSecsLeft(rem);
      if (rem <= 0) {
        setFreeExpired(true);
        clearInterval(freeIntervalRef.current);
      }
    }, 1000);

    return () => clearInterval(freeIntervalRef.current);
  }, [user]); // re-runs when user logs in or out
  // ────────────────────────────────────────────────────────────

  const [filters, setFilters] = useState({
    search: "", vesselType: "", speedRange: "", speedMin: null, speedMax: null,
  });
  const [selectedVessel, setSelectedVessel] = useState(null);
  const [trailData,       setTrailData]      = useState(null);
  const [predictRoute,    setPredictRoute]   = useState(null);
  const [panelOpen,       setPanelOpen]      = useState(!IS_MOBILE());
  const [portPanelOpen,   setPortPanelOpen]  = useState(false);
  const mapRef = useRef(null);

  const { vessels, stats, vesselTypes, loading, error, nextRefresh, lastUpdated, refresh } =
    useVessels(filters);

  // Auto-locate on exact search match
  useEffect(() => {
    if (!filters.search || filters.search.length < 2) return;
    if (vessels.length === 1) {
      setSelectedVessel(vessels[0]); setTrailData(null); setPredictRoute(null);
      if (mapRef.current?.panToVessel) mapRef.current.panToVessel(vessels[0]);
      if (IS_MOBILE()) setPanelOpen(false);
    }
  }, [vessels, filters.search]);

  // Keep selected vessel in sync with live refreshes
  useEffect(() => {
    if (!selectedVessel) return;
    const fresh = vessels.find(v => v.imo_number === selectedVessel.imo_number);
    if (fresh) setSelectedVessel(fresh);
  }, [vessels]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reopen left panel on desktop resize
  useEffect(() => {
    const handler = () => { if (!IS_MOBILE() && !panelOpen) setPanelOpen(true); };
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [panelOpen]);

  const handleSelectVessel = useCallback((vessel) => {
    setSelectedVessel(vessel); setTrailData(null); setPredictRoute(null);
    if (IS_MOBILE()) setPanelOpen(false);
    setTimeout(() => {
      const live = vessels.find(v => v.imo_number === vessel?.imo_number);
      const target = (live?.latitude_degrees && live?.longitude_degrees) ? live : vessel;
      if (mapRef.current?.panToVessel) mapRef.current.panToVessel(target);
      mapRef.current?.triggerResize?.();
    }, 320);
  }, [vessels]);

  const handleCloseDetail = useCallback(() => {
    setSelectedVessel(null); setTrailData(null); setPredictRoute(null);
    setTimeout(() => { mapRef.current?.triggerResize?.(); }, 320);
  }, []);

  const handleLogout = useCallback(() => {
    logoutUser();
    setUser(null);
    // Give the user another free session after logout
    resetFreeTimer();
    setFreeSecsLeft(FREE_SECONDS);
    setFreeExpired(false);
  }, []);

  const handleSearchEnter = useCallback(() => {
    if (vessels.length > 0) {
      const v = vessels[0];
      setSelectedVessel(v); setTrailData(null); setPredictRoute(null);
      if (mapRef.current?.panToVessel) mapRef.current.panToVessel(v);
      if (IS_MOBILE()) setPanelOpen(false);
    }
  }, [vessels]);

  const handleBackdropClick = useCallback(() => {
    setPanelOpen(false); setSelectedVessel(null);
  }, []);

  // Called when user successfully signs in or registers
  const handleAuth = useCallback((u) => {
    setUser(u);
    clearInterval(freeIntervalRef.current);
    try { sessionStorage.removeItem(FREE_KEY); } catch {}
    setFreeExpired(false);
  }, []);

  /* ── Auth wall: only shown AFTER free time runs out ─────── */
  if (!user && freeExpired) {
    return <AuthPage onAuth={handleAuth} />;
  }

  const showLeftBackdrop  = IS_MOBILE() && panelOpen;
  const showRightBackdrop = IS_MOBILE() && !!selectedVessel;
  const freeMin = Math.floor(freeSecsLeft / 60);
  const freeSec = String(freeSecsLeft % 60).padStart(2, "0");
  const isUrgent = freeSecsLeft <= 60;

  return (
    <div className="app-root">

      <TopBar
        filters={filters} onFiltersChange={setFilters}
        vesselTypes={vesselTypes} stats={stats}
        nextRefresh={nextRefresh} loading={loading} onRefresh={refresh}
        panelOpen={panelOpen} onTogglePanel={() => setPanelOpen(p => !p)}
        lastUpdated={lastUpdated} user={user} onLogout={handleLogout}
        onSearchEnter={handleSearchEnter}
        portPanelOpen={portPanelOpen} onTogglePortPanel={() => setPortPanelOpen(p => !p)}
      />

      <ErrorBanner message={error} onRetry={refresh} />

      <div className="app-body">

        {/* LEFT PANEL */}
        <div className={`app-left-panel ${panelOpen ? "open" : "closed"}`}>
          <VesselPanel
            vessels={vessels} selectedId={selectedVessel?.imo_number}
            onSelect={handleSelectVessel} loading={loading} stats={stats}
            panelOpen={panelOpen} onMinimize={() => setPanelOpen(false)}
          />
        </div>

        {showLeftBackdrop && (
          <div className="app-mobile-backdrop" onClick={handleBackdropClick} />
        )}

        {/* MAP AREA */}
        <div className="app-map-area">

          <PortActivityPanel
            isOpen={portPanelOpen} onClose={() => setPortPanelOpen(false)}
            onSelectVessel={handleSelectVessel} selectedImo={selectedVessel?.imo_number}
            vessels={vessels}
          />

          <MapView
            ref={mapRef} vessels={vessels}
            selectedVessel={selectedVessel} onVesselClick={handleSelectVessel}
            trailData={trailData} predictRoute={predictRoute}
            portPanelOpen={portPanelOpen} onTogglePortPanel={() => setPortPanelOpen(p => !p)}
          />

          <div className="map-legend-overlay"><SpeedLegend /></div>

          {loading && (
            <div className="map-loading-overlay">
              <div className="map-loading-spinner" />
              <span>FETCHING AIS DATA</span>
            </div>
          )}

          {/* ── FREE STREAMING COUNTDOWN BADGE ─────────────────
              Shown only when NOT logged in and timer still running.
              Disappears forever once user signs in.
          ─────────────────────────────────────────────────────── */}
          {!user && !freeExpired && (
            <div className={`free-timer-badge${isUrgent ? " urgent" : ""}`}>
              <span className="free-timer-dot" />
              <div className="free-timer-info">
                <span className="free-timer-label">FREE STREAMING</span>
                <span className="free-timer-count">{freeMin}:{freeSec}</span>
              </div>
              <button
                className="free-timer-signin"
                onClick={() => setFreeExpired(true)}
              >
                SIGN IN
              </button>
            </div>
          )}

        </div>

        {showRightBackdrop && (
          <div
            className="app-mobile-backdrop"
            onClick={handleCloseDetail}
            style={{ zIndex: 45 }}
          />
        )}

        {/* RIGHT DETAIL PANEL */}
        <div className={`app-right-panel ${selectedVessel ? "open" : "closed"}`}>
          <VesselDetailPanel
            vessel={selectedVessel} onClose={handleCloseDetail}
            onShowTrail={setTrailData} onShowPredictRoute={setPredictRoute}
          />
        </div>

      </div>
    </div>
  );
}