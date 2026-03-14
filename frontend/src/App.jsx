import React, { useState, useCallback, useEffect, useRef, lazy, Suspense } from "react";
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

// ── New panels — lazy loaded so missing files don't break the build ──
const VesselComparison      = lazy(() => import("./components/VesselComparison"));
const LiveAlertsFeed        = lazy(() => import("./components/LiveAlertsFeed"));
const PortCongestionHeatmap = lazy(() => import("./components/PortCongestionHeatmap"));
const ThemePreferences      = lazy(() => import("./components/ThemePreferences"));

const IS_MOBILE = () => window.innerWidth <= 768;

const FREE_SECONDS = 300;
const FREE_KEY = "mpa_free_start";

function getFreeSecsRemaining() {
  try {
    const raw = sessionStorage.getItem(FREE_KEY);
    if (!raw) return FREE_SECONDS;
    const elapsed = Math.floor((Date.now() - parseInt(raw, 10)) / 1000);
    return Math.max(0, FREE_SECONDS - elapsed);
  } catch { return FREE_SECONDS; }
}

function startFreeTimer() {
  try { if (!sessionStorage.getItem(FREE_KEY)) sessionStorage.setItem(FREE_KEY, String(Date.now())); } catch {}
}

function resetFreeTimer() {
  try { sessionStorage.removeItem(FREE_KEY); sessionStorage.setItem(FREE_KEY, String(Date.now())); } catch {}
}

export default function App() {
  const [user, setUser] = useState(() => getCurrentUser());
  const [freeSecsLeft, setFreeSecsLeft] = useState(FREE_SECONDS);
  const [freeExpired,  setFreeExpired]  = useState(false);
  const freeIntervalRef = useRef(null);

  useEffect(() => {
    if (user) { clearInterval(freeIntervalRef.current); return; }
    startFreeTimer();
    const initialRem = getFreeSecsRemaining();
    setFreeSecsLeft(initialRem);
    if (initialRem <= 0) { setFreeExpired(true); return; }
    freeIntervalRef.current = setInterval(() => {
      const rem = getFreeSecsRemaining();
      setFreeSecsLeft(rem);
      if (rem <= 0) { setFreeExpired(true); clearInterval(freeIntervalRef.current); }
    }, 1000);
    return () => clearInterval(freeIntervalRef.current);
  }, [user]);

  const [filters,       setFilters]       = useState({ search: "", vesselType: "", speedRange: "", speedMin: null, speedMax: null });
  const [selectedVessel,setSelectedVessel]= useState(null);
  const [trailData,     setTrailData]     = useState(null);
  const [predictRoute,  setPredictRoute]  = useState(null);
  const [panelOpen,     setPanelOpen]     = useState(!IS_MOBILE());
  const [portPanelOpen, setPortPanelOpen] = useState(false);
  const [compareOpen,   setCompareOpen]   = useState(false);
  const [alertsOpen,    setAlertsOpen]    = useState(false);
  const [alertCount,    setAlertCount]    = useState(0);
  const [heatmapOpen,   setHeatmapOpen]   = useState(false);
  const [prefsOpen,     setPrefsOpen]     = useState(false);
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

  const vesselsRef = useRef(vessels);
  useEffect(() => { vesselsRef.current = vessels; }, [vessels]);

  const handleSelectVessel = useCallback((vessel) => {
    setSelectedVessel(vessel); setTrailData(null); setPredictRoute(null);
    if (IS_MOBILE()) setPanelOpen(false);
    setTimeout(() => {
      const live = vesselsRef.current.find(v => v.imo_number === vessel?.imo_number);
      const target = (live?.latitude_degrees && live?.longitude_degrees) ? live : vessel;
      if (mapRef.current?.panToVessel) mapRef.current.panToVessel(target);
      mapRef.current?.triggerResize?.();
    }, 320);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedVessel(null); setTrailData(null); setPredictRoute(null);
    setTimeout(() => { mapRef.current?.triggerResize?.(); }, 320);
  }, []);

  const handleLogout = useCallback(() => {
    logoutUser(); setUser(null); resetFreeTimer(); setFreeSecsLeft(FREE_SECONDS); setFreeExpired(false);
  }, []);

  const handleSearchEnter = useCallback(() => {
    const cur = vesselsRef.current;
    if (cur.length > 0) {
      const v = cur[0];
      setSelectedVessel(v); setTrailData(null); setPredictRoute(null);
      if (mapRef.current?.panToVessel) mapRef.current.panToVessel(v);
      if (IS_MOBILE()) setPanelOpen(false);
    }
  }, []);

  const handleBackdropClick = useCallback(() => { setPanelOpen(false); setSelectedVessel(null); }, []);

  const handleAuth = useCallback((u) => {
    setUser(u); clearInterval(freeIntervalRef.current);
    try { sessionStorage.removeItem(FREE_KEY); } catch {}
    setFreeExpired(false);
  }, []);

  // Helpers to open one panel at a time
  const openCompare  = useCallback(() => { setCompareOpen(p => !p); setAlertsOpen(false); setHeatmapOpen(false); setPrefsOpen(false); }, []);
  const openAlerts   = useCallback(() => { setAlertsOpen(p => !p);  setCompareOpen(false); setHeatmapOpen(false); setPrefsOpen(false); }, []);
  const openHeatmap  = useCallback(() => { setHeatmapOpen(p => !p); setCompareOpen(false); setAlertsOpen(false);  setPrefsOpen(false); }, []);
  const openPrefs    = useCallback(() => { setPrefsOpen(p => !p);   setCompareOpen(false); setAlertsOpen(false);  setHeatmapOpen(false); }, []);

  if (!user && freeExpired) return <AuthPage onAuth={handleAuth} />;

  const showLeftBackdrop  = IS_MOBILE() && panelOpen;
  const showRightBackdrop = IS_MOBILE() && !!selectedVessel;
  const freeMin  = Math.floor(freeSecsLeft / 60);
  const freeSec  = String(freeSecsLeft % 60).padStart(2, "0");
  const isUrgent = freeSecsLeft <= 60;
  const dockOpen = compareOpen || alertsOpen || heatmapOpen || prefsOpen;

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
        compareOpen={compareOpen}  onToggleCompare={openCompare}
        alertsOpen={alertsOpen}    onToggleAlerts={openAlerts}   alertCount={alertCount}
        heatmapOpen={heatmapOpen}  onToggleHeatmap={openHeatmap}
        prefsOpen={prefsOpen}      onTogglePrefs={openPrefs}
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
              <div className="map-loading-spinner" />
              <span>FETCHING AIS DATA</span>
            </div>
          )}

          {!user && !freeExpired && (
            <div className={`free-timer-badge${isUrgent ? " urgent" : ""}`}>
              <span className="free-timer-dot" />
              <div className="free-timer-info">
                <span className="free-timer-label">FREE STREAMING</span>
                <span className="free-timer-count">{freeMin}:{freeSec}</span>
              </div>
              <button className="free-timer-signin" onClick={() => setFreeExpired(true)}>SIGN IN</button>
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

      {/* ── BOTTOM PANEL DOCK ─────────────────────────────────── */}
      <div className={`app-bottom-dock${dockOpen ? " open" : ""}`}>
        <Suspense fallback={null}>
          {compareOpen && (
            <VesselComparison
              vessels={vessels} onSelectVessel={handleSelectVessel}
              isOpen={compareOpen} onClose={() => setCompareOpen(false)}
            />
          )}
          {alertsOpen && (
            <LiveAlertsFeed
              vessels={vessels} onSelectVessel={handleSelectVessel}
              isOpen={alertsOpen} onClose={() => setAlertsOpen(false)}
              onAlertCountChange={setAlertCount}
            />
          )}
          {heatmapOpen && (
            <PortCongestionHeatmap isOpen={heatmapOpen} onClose={() => setHeatmapOpen(false)} />
          )}
          {prefsOpen && (
            <ThemePreferences
              isOpen={prefsOpen} onClose={() => setPrefsOpen(false)}
              onSave={(prefs) => console.log("[MPA] Preferences saved:", prefs)}
            />
          )}
        </Suspense>
      </div>

    </div>
  );
}