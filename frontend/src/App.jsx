import React, { useState, useCallback, useEffect, useRef,  memo, lazy, Suspense } from "react";
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

const VesselComparison      = lazy(() => import("./components/Vesselcomparison"));
const LiveAlertsFeed        = lazy(() => import("./components/Livealertsfeed"));
const PortCongestionHeatmap = lazy(() => import("./components/Portcongestionheatmap"));
const ThemePreferences      = lazy(() => import("./components/Themepreferences"));

const IS_MOBILE = () => window.innerWidth <= 768;

const FREE_SECONDS = 300;
const FREE_KEY     = "mpa_free_start";

function getFreeSecsRemaining() {
  try {
    const raw = sessionStorage.getItem(FREE_KEY);
    if (!raw) return FREE_SECONDS;
    return Math.max(0, FREE_SECONDS - Math.floor((Date.now() - parseInt(raw, 10)) / 1000));
  } catch { return FREE_SECONDS; }
}
function startFreeTimer() {
  try { if (!sessionStorage.getItem(FREE_KEY)) sessionStorage.setItem(FREE_KEY, String(Date.now())); } catch {}
}
function resetFreeTimer() {
  try { sessionStorage.removeItem(FREE_KEY); sessionStorage.setItem(FREE_KEY, String(Date.now())); } catch {}
}

// ── Memoized heavy children — only re-render when their specific props change ──
const MemoVesselPanel       = memo(VesselPanel);
const MemoVesselDetailPanel = memo(VesselDetailPanel);
const MemoPortActivityPanel = memo(PortActivityPanel);
const MemoMapView           = memo(MapView, (prev, next) => (
  prev.vessels         === next.vessels         &&
  prev.selectedVessel  === next.selectedVessel  &&
  prev.trailData       === next.trailData        &&
  prev.predictRoute    === next.predictRoute     &&
  prev.portPanelOpen   === next.portPanelOpen    &&
  prev.onVesselClick   === next.onVesselClick    &&
  prev.onTogglePortPanel === next.onTogglePortPanel
));

export default function App() {
  const [user, setUser] = useState(() => getCurrentUser());

  // ── Free timer: write to DOM directly instead of setState every second ──
  // Previously setFreeSecsLeft every 1s → App re-rendered → ALL children re-rendered
   
  const freeCountDomRef  = useRef(null);
  const freeBadgeDomRef  = useRef(null);
  const [freeExpired,  setFreeExpired]  = useState(false);
  const freeIntervalRef = useRef(null);

  useEffect(() => {
    if (user) { clearInterval(freeIntervalRef.current); return; }
    startFreeTimer();
    const rem0 = getFreeSecsRemaining();
    if (rem0 <= 0) { setFreeExpired(true); return; }

    const tick = () => {
      const rem = getFreeSecsRemaining();
      if (freeCountDomRef.current) {
        const m = Math.floor(rem / 60);
        const s = String(rem % 60).padStart(2, "0");
        freeCountDomRef.current.textContent = `${m}:${s}`;
      }
      if (freeBadgeDomRef.current) {
        if (rem <= 60) freeBadgeDomRef.current.classList.add("urgent");
        else freeBadgeDomRef.current.classList.remove("urgent");
      }
      if (rem <= 0) {
        clearInterval(freeIntervalRef.current);
        setFreeExpired(true); // only one setState total
      }
    };
    tick();
    freeIntervalRef.current = setInterval(tick, 1000);
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

  // Auto-locate on exact search match
  useEffect(() => {
    if (!filters.search || filters.search.length < 2) return;
    if (vessels.length === 1) {
      setSelectedVessel(vessels[0]); setTrailData(null); setPredictRoute(null);
      if (mapRef.current?.panToVessel) mapRef.current.panToVessel(vessels[0]);
      if (IS_MOBILE()) setPanelOpen(false);
    }
  }, [vessels, filters.search]);

  // Keep selected vessel in sync
  useEffect(() => {
    if (!selectedVessel) return;
    const fresh = vessels.find(v => v.imo_number === selectedVessel.imo_number);
    if (fresh) setSelectedVessel(fresh);
  }, [vessels]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reopen panel on desktop resize
  useEffect(() => {
    const handler = () => { if (!IS_MOBILE() && !panelOpen) setPanelOpen(true); };
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [panelOpen]);

  const vesselsRef = useRef(vessels);
  useEffect(() => { vesselsRef.current = vessels; }, [vessels]);

  // ── All handlers stable (useCallback with no changing deps) ──
  const handleSelectVessel = useCallback((vessel) => {
    setSelectedVessel(vessel); setTrailData(null); setPredictRoute(null);
    if (IS_MOBILE()) setPanelOpen(false);
    setTimeout(() => {
      const live   = vesselsRef.current.find(v => v.imo_number === vessel?.imo_number);
      const target = (live?.latitude_degrees && live?.longitude_degrees) ? live : vessel;
      if (mapRef.current?.panToVessel) mapRef.current.panToVessel(target);
      mapRef.current?.triggerResize?.();
    }, 350);
  }, []);

  const handleCloseDetail    = useCallback(() => {
    setSelectedVessel(null); setTrailData(null); setPredictRoute(null);
    setTimeout(() => { mapRef.current?.triggerResize?.(); }, 350);
  }, []);

  const handleLogout         = useCallback(() => {
    logoutUser(); setUser(null); resetFreeTimer(); setFreeExpired(false);
  }, []);

  const handleSearchEnter    = useCallback(() => {
    const cur = vesselsRef.current;
    if (cur.length > 0) {
      const v = cur[0];
      setSelectedVessel(v); setTrailData(null); setPredictRoute(null);
      if (mapRef.current?.panToVessel) mapRef.current.panToVessel(v);
      if (IS_MOBILE()) setPanelOpen(false);
    }
  }, []);

  const handleBackdropClick  = useCallback(() => { setPanelOpen(false); setSelectedVessel(null); }, []);
  const handleAuth           = useCallback((u) => {
    setUser(u); clearInterval(freeIntervalRef.current);
    try { sessionStorage.removeItem(FREE_KEY); } catch {}
    setFreeExpired(false);
  }, []);

  // Stable panel toggles — one panel open at a time
  const openCompare  = useCallback(() => { setCompareOpen(p => !p); setAlertsOpen(false); setHeatmapOpen(false); setPrefsOpen(false); }, []);
  const openAlerts   = useCallback(() => { setAlertsOpen(p => !p);  setCompareOpen(false); setHeatmapOpen(false); setPrefsOpen(false); }, []);
  const openHeatmap  = useCallback(() => { setHeatmapOpen(p => !p); setCompareOpen(false); setAlertsOpen(false);  setPrefsOpen(false); }, []);
  const openPrefs    = useCallback(() => { setPrefsOpen(p => !p);   setCompareOpen(false); setAlertsOpen(false);  setHeatmapOpen(false); }, []);

  // Stable inline handlers — previously created new functions on every render
  const handleTogglePanel      = useCallback(() => setPanelOpen(p => !p), []);
  const handleTogglePortPanel  = useCallback(() => setPortPanelOpen(p => !p), []);
  const handleClosePortPanel   = useCallback(() => setPortPanelOpen(false), []);
  const handleMinimizePanel    = useCallback(() => setPanelOpen(false), []);
  const handleExpireTimer      = useCallback(() => setFreeExpired(true), []);
  const handleCloseCompare     = useCallback(() => setCompareOpen(false), []);
  const handleCloseAlerts      = useCallback(() => setAlertsOpen(false), []);
  const handleCloseHeatmap     = useCallback(() => setHeatmapOpen(false), []);
  const handleClosePrefs       = useCallback(() => setPrefsOpen(false), []);
  const handlePrefsSave        = useCallback((p) => console.log("[MPA] Preferences saved:", p), []);

  if (!user && freeExpired) return <AuthPage onAuth={handleAuth} />;

  const showLeftBackdrop  = IS_MOBILE() && panelOpen;
  const showRightBackdrop = IS_MOBILE() && !!selectedVessel;
  const dockOpen          = compareOpen || alertsOpen || heatmapOpen || prefsOpen;
  const isUrgent          = getFreeSecsRemaining() <= 60;

  return (
    <div className="app-root">

      <TopBar
        filters={filters}        onFiltersChange={setFilters}
        vesselTypes={vesselTypes} stats={stats}
        nextRefresh={nextRefresh} loading={loading} onRefresh={refresh}
        panelOpen={panelOpen}     onTogglePanel={handleTogglePanel}
        lastUpdated={lastUpdated} user={user} onLogout={handleLogout}
        onSearchEnter={handleSearchEnter}
        portPanelOpen={portPanelOpen} onTogglePortPanel={handleTogglePortPanel}
        compareOpen={compareOpen}  onToggleCompare={openCompare}
        alertsOpen={alertsOpen}    onToggleAlerts={openAlerts}   alertCount={alertCount}
        heatmapOpen={heatmapOpen}  onToggleHeatmap={openHeatmap}
        prefsOpen={prefsOpen}      onTogglePrefs={openPrefs}
      />

      <ErrorBanner message={error} onRetry={refresh} />

      <div className="app-body">

        <div className={`app-left-panel ${panelOpen ? "open" : "closed"}`}>
          <MemoVesselPanel
            vessels={vessels}        selectedId={selectedVessel?.imo_number}
            onSelect={handleSelectVessel} loading={loading} stats={stats}
            panelOpen={panelOpen}    onMinimize={handleMinimizePanel}
          />
        </div>

        {showLeftBackdrop && <div className="app-mobile-backdrop" onClick={handleBackdropClick} />}

        <div className="app-map-area">

          <MemoPortActivityPanel
            isOpen={portPanelOpen}  onClose={handleClosePortPanel}
            onSelectVessel={handleSelectVessel}
            selectedImo={selectedVessel?.imo_number}
            vessels={vessels}
          />

          <MemoMapView
            ref={mapRef}            vessels={vessels}
            selectedVessel={selectedVessel} onVesselClick={handleSelectVessel}
            trailData={trailData}   predictRoute={predictRoute}
            portPanelOpen={portPanelOpen} onTogglePortPanel={handleTogglePortPanel}
          />

          <div className="map-legend-overlay"><SpeedLegend /></div>

          {loading && (
            <div className="map-loading-overlay">
              <div className="map-loading-spinner" />
              <span>FETCHING AIS DATA</span>
            </div>
          )}

          {/* Free timer — written to DOM directly, no setState every second */}
          {!user && !freeExpired && (
            <div ref={freeBadgeDomRef} className={`free-timer-badge${isUrgent ? " urgent" : ""}`}>
              <span className="free-timer-dot" />
              <div className="free-timer-info">
                <span className="free-timer-label">FREE STREAMING</span>
                <span ref={freeCountDomRef} className="free-timer-count">5:00</span>
              </div>
              <button className="free-timer-signin" onClick={handleExpireTimer}>SIGN IN</button>
            </div>
          )}

        </div>

        {showRightBackdrop && (
          <div className="app-mobile-backdrop" onClick={handleCloseDetail} style={{ zIndex: 45 }} />
        )}

        <div className={`app-right-panel ${selectedVessel ? "open" : "closed"}`}>
          <MemoVesselDetailPanel
            vessel={selectedVessel}    onClose={handleCloseDetail}
            onShowTrail={setTrailData} onShowPredictRoute={setPredictRoute}
          />
        </div>

      </div>

      <div className={`app-bottom-dock${dockOpen ? " open" : ""}`}>
        <Suspense fallback={null}>
          {compareOpen && (
            <VesselComparison
              vessels={vessels}       onSelectVessel={handleSelectVessel}
              isOpen={compareOpen}    onClose={handleCloseCompare}
            />
          )}
          {alertsOpen && (
            <LiveAlertsFeed
              vessels={vessels}       onSelectVessel={handleSelectVessel}
              isOpen={alertsOpen}     onClose={handleCloseAlerts}
              onAlertCountChange={setAlertCount}
            />
          )}
          {heatmapOpen && (
            <PortCongestionHeatmap isOpen={heatmapOpen} onClose={handleCloseHeatmap} />
          )}
          {prefsOpen && (
            <ThemePreferences
              isOpen={prefsOpen}   onClose={handleClosePrefs}
              onSave={handlePrefsSave}
            />
          )}
        </Suspense>
      </div>

    </div>
  );
}