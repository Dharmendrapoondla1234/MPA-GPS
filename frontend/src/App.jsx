import React, { useState, useCallback, useEffect, useRef, useMemo, memo, lazy, Suspense } from "react";
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
import PreferredShipsGrid, { loadPreferredFromAPI, usePreferred } from "./components/PreferredShipsGrid";
import WatchlistPanel, { loadWatchlistFromAPI, useWatchlist } from "./components/WatchlistPanel";
import ProfilePanel from "./components/ProfilePanel";
import AIChatPanel from "./components/AIChatPanel";
import AIFleetIntelligence from "./components/AIFleetIntelligence";
import "./styles/App.css";

const VesselComparison           = lazy(() => import("./components/Vesselcomparison"));
const LiveAlertsFeed             = lazy(() => import("./components/Livealertsfeed"));
const PortCongestionHeatmap      = lazy(() => import("./components/Portcongestionheatmap"));
const ThemePreferences           = lazy(() => import("./components/Themepreferences"));
const PortAgentIntelligencePanel      = lazy(() => import("./components/PortAgentIntelligencePanel"));
const UniversalVesselContactFinder    = lazy(() => import("./components/UniversalVesselContactFinder"));

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
  prev.vessels              === next.vessels              &&
  prev.selectedVessel       === next.selectedVessel       &&
  prev.trailData            === next.trailData             &&
  prev.predictRoute         === next.predictRoute          &&
  prev.portPanelOpen        === next.portPanelOpen         &&
  prev.onVesselClick        === next.onVesselClick         &&
  prev.onTogglePortPanel    === next.onTogglePortPanel     &&
  prev.showWatchlistOnly    === next.showWatchlistOnly     &&
  prev.watchlistCount       === next.watchlistCount
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

  const [filters,       setFilters]       = useState({ search: "", vesselType: "", speedRange: "", speedMin: null, speedMax: null, flag: "" });
  const [selectedVessel,setSelectedVessel]= useState(null);
  const [trailData,     setTrailData]     = useState(null);
  const [predictRoute,  setPredictRoute]  = useState(null);
  const [panelOpen,     setPanelOpen]     = useState(!IS_MOBILE());
  const [portPanelOpen, setPortPanelOpen] = useState(false);
  const [compareOpen,     setCompareOpen]     = useState(false);
  const [alertsOpen,      setAlertsOpen]       = useState(false);
  const [alertCount,      setAlertCount]       = useState(0);
  const [heatmapOpen,     setHeatmapOpen]      = useState(false);
  const [prefsOpen,       setPrefsOpen]        = useState(false);
  const [agentIntelOpen,  setAgentIntelOpen]   = useState(false);
  const [contactIntelOpen, setContactIntelOpen] = useState(false);
  const [preferredOpen,   setPreferredOpen]    = useState(false);
  const [watchlistOpen,   setWatchlistOpen]    = useState(false);
  const [watchlistMapFilter, setWatchlistMapFilter] = useState(false);
  const [profileOpen,     setProfileOpen]      = useState(false);
  const [aiChatOpen,      setAiChatOpen]       = useState(false);
  const [aiFleetOpen,     setAiFleetOpen]      = useState(false);
  const mapRef = useRef(null);

  // ── Right-panel drag-to-resize ────────────────────────────────
  const panelRef      = useRef(null);
  const [panelWidth, setPanelWidth] = useState(420);
  const resizeDragging = useRef(false);
  const resizeStartX   = useRef(0);
  const resizeStartW   = useRef(0);

  const startResize = useCallback((e) => {
    e.preventDefault();
    resizeDragging.current = true;
    resizeStartX.current   = e.clientX;
    resizeStartW.current   = panelRef.current?.offsetWidth || panelWidth;
    document.body.style.userSelect = "none";
    document.body.style.cursor     = "ew-resize";
  }, [panelWidth]);

  useEffect(() => {
    const onMove = (e) => {
      if (!resizeDragging.current) return;
      const delta = resizeStartX.current - e.clientX; // panel is on right → drag left = wider
      const newW  = Math.min(800, Math.max(320, resizeStartW.current + delta));
      setPanelWidth(newW);
    };
    const onUp = () => {
      if (!resizeDragging.current) return;
      resizeDragging.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor     = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
  }, []);

  const { vessels: rawVessels, stats, vesselTypes, loading, error, nextRefresh, lastUpdated, refresh } = useVessels(filters);
  const preferredList  = usePreferred();
  const preferredCount = preferredList.length;
  const watchlistList  = useWatchlist();
  const watchlistCount = watchlistList.length;

  // Client-side flag filter (flag is not a BigQuery param, applied here)
  const vessels = useMemo(() => {
    let v = rawVessels;
    if (filters.flag) v = v.filter(vessel => vessel.flag === filters.flag);
    return v;
  }, [rawVessels, filters.flag]);

  // Vessels shown on map — watchlist filter takes priority when active.
  // selectedVessel is passed separately to the map for highlighting only,
  // not for filtering — so the watchlist view stays intact after clicking a vessel.
  const mapVessels = useMemo(() => {
    if (watchlistMapFilter) {
      // Watchlist mode is ON: always filter to watchlist vessels only.
      // If the list is empty (still loading or user has no watchlist entries),
      // return an empty array so the map correctly shows nothing rather than
      // falling through to show ALL vessels.
      if (!watchlistList.length) return [];
      const imoSet = new Set(watchlistList.map(w => String(w.imo_number)));
      return vessels.filter(v => imoSet.has(String(v.imo_number)));
    }
    if (selectedVessel) {
      // Only collapse to single vessel when NOT in watchlist mode
      return vessels.filter(v => String(v.imo_number) === String(selectedVessel.imo_number));
    }
    return vessels;
  }, [vessels, selectedVessel, watchlistMapFilter, watchlistList]);

  // Unique flag codes for the TopBar dropdown — derived from live data
  const flagOptions = useMemo(() => {
    const flags = [...new Set(rawVessels.map(v => v.flag).filter(Boolean))].sort();
    return flags;
  }, [rawVessels]);

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
    // Clear in-memory watchlist so next user doesn't see previous user's ships
    loadPreferredFromAPI();
    loadWatchlistFromAPI();
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
    // Load this user's watchlist from BigQuery
    loadPreferredFromAPI();
    loadWatchlistFromAPI();
  }, []);

  // Stable panel toggles — one panel open at a time
  const openCompare    = useCallback(() => { setCompareOpen(p => !p);    setAlertsOpen(false); setHeatmapOpen(false); setPrefsOpen(false); setAgentIntelOpen(false); }, []);
  const openAlerts     = useCallback(() => { setAlertsOpen(p => !p);     setCompareOpen(false); setHeatmapOpen(false); setPrefsOpen(false); setAgentIntelOpen(false); }, []);
  const openHeatmap    = useCallback(() => { setHeatmapOpen(p => !p);    setCompareOpen(false); setAlertsOpen(false);  setPrefsOpen(false); setAgentIntelOpen(false); }, []);
  const openPrefs      = useCallback(() => { setPrefsOpen(p => !p);      setCompareOpen(false); setAlertsOpen(false);  setHeatmapOpen(false); setAgentIntelOpen(false); }, []);
  const openAgentIntel = useCallback(() => { setAgentIntelOpen(p => !p); setCompareOpen(false); setAlertsOpen(false); setHeatmapOpen(false); setPrefsOpen(false); setContactIntelOpen(false); }, []);
  const openContactIntel = useCallback(() => { setContactIntelOpen(p => !p); setAgentIntelOpen(false); setCompareOpen(false); setAlertsOpen(false); setHeatmapOpen(false); setPrefsOpen(false); }, []);

  // Locate vessel on map from watchlist
  const handleLocateVessel = useCallback((vessel) => {
    setWatchlistOpen(false);
    setSelectedVessel(vessel);
    setTimeout(() => {
      if (mapRef.current?.panToVessel) mapRef.current.panToVessel(vessel);
      mapRef.current?.triggerResize?.();
    }, 200);
  }, []);

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
        vesselTypes={vesselTypes} flagOptions={flagOptions} stats={stats}
        nextRefresh={nextRefresh} loading={loading} onRefresh={refresh}
        panelOpen={panelOpen}     onTogglePanel={handleTogglePanel}
        lastUpdated={lastUpdated} user={user} onLogout={handleLogout}
        onSearchEnter={handleSearchEnter}
        portPanelOpen={portPanelOpen} onTogglePortPanel={handleTogglePortPanel}
        preferredOpen={preferredOpen}   onTogglePreferred={() => setPreferredOpen(p => !p)}
        preferredCount={preferredCount}
        watchlistOpen={watchlistOpen}   onToggleWatchlist={() => setWatchlistOpen(p => !p)}
        watchlistCount={watchlistCount}
        compareOpen={compareOpen}      onToggleCompare={openCompare}
        alertsOpen={alertsOpen}        onToggleAlerts={openAlerts}   alertCount={alertCount}
        heatmapOpen={heatmapOpen}      onToggleHeatmap={openHeatmap}
        prefsOpen={prefsOpen}          onTogglePrefs={openPrefs}
        agentIntelOpen={agentIntelOpen} onToggleAgentIntel={openAgentIntel}
        contactIntelOpen={contactIntelOpen} onToggleContactIntel={openContactIntel}
        aiChatOpen={aiChatOpen} onToggleAiChat={() => setAiChatOpen(p => !p)}
        aiFleetOpen={aiFleetOpen} onToggleAiFleet={() => setAiFleetOpen(p => !p)}
        onOpenProfile={() => setProfileOpen(true)}
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
            ref={mapRef}            vessels={mapVessels}
            selectedVessel={selectedVessel} onVesselClick={handleSelectVessel}
            trailData={trailData}   predictRoute={predictRoute}
            portPanelOpen={portPanelOpen} onTogglePortPanel={handleTogglePortPanel}
            showWatchlistOnly={watchlistMapFilter}
            onToggleWatchlistOnly={() => {
              const next = !watchlistMapFilter;
              setWatchlistMapFilter(next);
              // Clear any selected vessel when entering watchlist mode so the
              // selectedVessel guard doesn't override the watchlist filter
              if (next) {
                setSelectedVessel(null);
                setTrailData(null);
                setPredictRoute(null);
              }
            }}
            watchlistCount={watchlistCount}
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

        <div
          className={`app-right-panel ${selectedVessel ? "open" : "closed"}`}
          style={selectedVessel ? { width: panelWidth, minWidth: panelWidth } : {}}
          ref={panelRef}
        >
          {/* Drag-to-resize handle on the left edge */}
          {selectedVessel && (
            <div
              className="app-panel-resize-handle"
              onMouseDown={startResize}
              title="Drag to resize panel"
            />
          )}
          <MemoVesselDetailPanel
            vessel={selectedVessel}    onClose={handleCloseDetail}
            onShowTrail={setTrailData} onShowPredictRoute={setPredictRoute}
          />
        </div>

      </div>

      {/* ── Preferred Ships Grid ── */}
      <PreferredShipsGrid
        vessels={vessels}
        onSelectVessel={handleSelectVessel}
        isOpen={preferredOpen}
        onClose={() => setPreferredOpen(false)}
      />

      {/* ── Watchlist Panel (BigQuery-backed) ── */}
      <WatchlistPanel
  vessels={vessels}
  onSelectVessel={handleSelectVessel}
  onLocateVessel={handleLocateVessel}
  isOpen={watchlistOpen}
  onClose={() => setWatchlistOpen(false)}
  watchlistMapFilter={watchlistMapFilter}
  onToggleMapFilter={() => setWatchlistMapFilter(p => !p)}
/>

      {/* ── Profile Panel ── */}
      <ProfilePanel
        isOpen={profileOpen}
        onClose={() => setProfileOpen(false)}
        user={user}
        onLogout={handleLogout}
      />

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

      {/* Port Agent Intelligence — modal overlay, outside dock */}
      <Suspense fallback={null}>
        {agentIntelOpen && (
          <PortAgentIntelligencePanel
            isOpen={agentIntelOpen}
            onClose={() => setAgentIntelOpen(false)}
            selectedVessel={selectedVessel}
          />
        )}
      </Suspense>

      {/* Universal Vessel Contact Intelligence — modal overlay */}
      <Suspense fallback={null}>
        {contactIntelOpen && (
          <UniversalVesselContactFinder
            isOpen={contactIntelOpen}
            onClose={() => setContactIntelOpen(false)}
            selectedVessel={selectedVessel}
          />
        )}
      </Suspense>

      {/* AI Chat Panel — slide-in drawer */}
      <div className={"app-ai-chat-drawer " + (aiChatOpen ? "open" : "")}>
        <AIChatPanel
          selectedVessel={selectedVessel}
          vessels={vessels}
          stats={stats}
          isOpen={aiChatOpen}
        />
      </div>
      {aiChatOpen && (
        <div className="app-mobile-backdrop" style={{ zIndex: 55 }} onClick={() => setAiChatOpen(false)} />
      )}

      {/* AI Fleet Intelligence — modal */}
      <AIFleetIntelligence
        vessels={vessels}
        stats={stats}
        isOpen={aiFleetOpen}
        onClose={() => setAiFleetOpen(false)}
      />

      {/* Floating AI buttons */}
      {!aiChatOpen && (
        <div className="ai-fab-group">
          <button className="ai-fab ai-fab-fleet" onClick={() => setAiFleetOpen(true)} title="AI Fleet Intelligence">⚡</button>
          <button className="ai-fab ai-fab-chat" onClick={() => setAiChatOpen(true)} title="AI Maritime Assistant">✦</button>
        </div>
      )}

    </div>
  );
}