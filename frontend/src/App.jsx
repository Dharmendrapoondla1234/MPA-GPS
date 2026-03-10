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

// ── Free-streaming: 5 minutes (300 s) before auth wall ──────────
const FREE_SECONDS = 300;
const STORAGE_KEY  = "mpa_free_start";

function getFreeRemaining() {
  try {
    const start = parseInt(localStorage.getItem(STORAGE_KEY) || "0", 10);
    if (!start) return FREE_SECONDS;
    return Math.max(0, FREE_SECONDS - Math.floor((Date.now() - start) / 1000));
  } catch { return FREE_SECONDS; }
}

function initFreeState() {
  // If no timer stored yet, this is a fresh visit — start fresh (map open)
  try {
    const start = parseInt(localStorage.getItem(STORAGE_KEY) || "0", 10);
    if (!start) {
      // First visit — set start time NOW so countdown begins immediately
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
      return { secsLeft: FREE_SECONDS, expired: false };
    }
    const remaining = Math.max(0, FREE_SECONDS - Math.floor((Date.now() - start) / 1000));
    return { secsLeft: remaining, expired: remaining === 0 };
  } catch {
    return { secsLeft: FREE_SECONDS, expired: false };
  }
}

export default function App() {

  const [user, setUser] = useState(() => getCurrentUser());

  // Free-streaming state — initialized synchronously so map is always open on first load
  const [freeSecsLeft, setFreeSecsLeft] = useState(() => initFreeState().secsLeft);
  const [freeExpired,  setFreeExpired]  = useState(() => initFreeState().expired);
  const freeTimerRef = useRef(null);

  useEffect(() => {
    if (user) return; // logged in — no countdown needed
    if (freeExpired) return; // already expired from a previous session
    // Tick every second
    freeTimerRef.current = setInterval(() => {
      const rem = getFreeRemaining();
      setFreeSecsLeft(rem);
      if (rem <= 0) {
        setFreeExpired(true);
        clearInterval(freeTimerRef.current);
      }
    }, 1000);
    return () => clearInterval(freeTimerRef.current);
  }, [user, freeExpired]); // eslint-disable-line react-hooks/exhaustive-deps

  const [filters, setFilters] = useState({
    search: "", vesselType: "", speedRange: "", speedMin: null, speedMax: null
  });
  const [selectedVessel, setSelectedVessel] = useState(null);
  const [trailData,       setTrailData]      = useState(null);
  const [predictRoute,    setPredictRoute]   = useState(null);
  const [panelOpen,       setPanelOpen]      = useState(!IS_MOBILE());
  const [portPanelOpen,   setPortPanelOpen]  = useState(false);
  const mapRef = useRef(null);

  const { vessels, stats, vesselTypes, loading, error, nextRefresh, lastUpdated, refresh } = useVessels(filters);

  useEffect(() => {
    if (!filters.search || filters.search.length < 2) return;
    if (vessels.length === 1) {
      setSelectedVessel(vessels[0]); setTrailData(null); setPredictRoute(null);
      if (mapRef.current?.panToVessel) mapRef.current.panToVessel(vessels[0]);
      if (IS_MOBILE()) setPanelOpen(false);
    }
  }, [vessels, filters.search]);

  useEffect(() => {
    if (!selectedVessel) return;
    const fresh = vessels.find(v => v.imo_number === selectedVessel.imo_number);
    if (fresh) setSelectedVessel(fresh);
  }, [vessels]); // eslint-disable-line react-hooks/exhaustive-deps

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
    logoutUser(); setUser(null);
    // Reset free timer — user gets a fresh 5 minutes after logging out
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch {}
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

  const handleBackdropClick = useCallback(() => { setPanelOpen(false); setSelectedVessel(null); }, []);

  const handleAuth = useCallback((u) => {
    setUser(u); clearInterval(freeTimerRef.current);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }, []);

  // Show auth wall when free time expires and user not logged in
  if (!user && freeExpired) return <AuthPage onAuth={handleAuth} />;

  const showLeftBackdrop  = IS_MOBILE() && panelOpen;
  const showRightBackdrop = IS_MOBILE() && !!selectedVessel;
  const freeMin = Math.floor(freeSecsLeft / 60);
  const freeSec = String(freeSecsLeft % 60).padStart(2, "0");

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

        <div className={`app-left-panel ${panelOpen ? "open" : "closed"}`}>
          <VesselPanel
            vessels={vessels} selectedId={selectedVessel?.imo_number}
            onSelect={handleSelectVessel} loading={loading} stats={stats}
            panelOpen={panelOpen} onMinimize={() => setPanelOpen(false)}
          />
        </div>

        {showLeftBackdrop && <div className="app-mobile-backdrop" onClick={handleBackdropClick} />}

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
              <div className="map-loading-spinner" /><span>FETCHING AIS DATA</span>
            </div>
          )}

          {/* ── FREE STREAMING COUNTDOWN BADGE ── */}
          {!user && !freeExpired && (
            <div className="free-timer-badge" data-urgent={freeSecsLeft <= 60 ? "true" : "false"}>
              <span className="free-timer-dot" />
              <div className="free-timer-info">
                <span className="free-timer-label">FREE STREAMING</span>
                <span className="free-timer-count" style={freeSecsLeft <= 60 ? {color:"#ff4466"} : {}}>
                  {freeMin}:{freeSec}
                </span>
              </div>
              <button className="free-timer-signin" onClick={() => setFreeExpired(true)}>
                SIGN IN
              </button>
            </div>
          )}
        </div>

        {showRightBackdrop && (
          <div className="app-mobile-backdrop" onClick={handleCloseDetail} style={{ zIndex: 45 }} />
        )}

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