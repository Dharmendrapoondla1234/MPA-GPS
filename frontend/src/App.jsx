import React, { useState, useCallback, useEffect, useRef } from "react";
import AuthPage from "./components/Authpage";
import TopBar from "./components/TopBar";
import VesselPanel from "./components/VesselPanel";
import VesselDetailPanel from "./components/VesselDetailPanel";
import MapView from "./components/MapView";
import SpeedLegend from "./components/SpeedLegend";
import ErrorBanner from "./components/ErrorBanner";
import PortActivityPanel, { PortActivityTrigger } from "./components/PortActivityPanel";
import { useVessels } from "./hooks/useVessels";
import { getCurrentUser, logoutUser } from "./services/api";
import "./styles/App.css";

const IS_MOBILE = () => window.innerWidth <= 768;

export default function App() {

  const [user, setUser] = useState(() => getCurrentUser());

  const [filters, setFilters] = useState({
    search: "",
    vesselType: "",
    speedRange: "",
    speedMin: null,
    speedMax: null
  });

  const [selectedVessel, setSelectedVessel] = useState(null);
  const [trailData, setTrailData] = useState(null);
  const [predictRoute, setPredictRoute] = useState(null);
  const [panelOpen, setPanelOpen] = useState(!IS_MOBILE());
  const [portPanelOpen, setPortPanelOpen] = useState(false);

  const mapRef = useRef(null);

  const {
    vessels,
    stats,
    vesselTypes,
    loading,
    error,
    nextRefresh,
    lastUpdated,
    refresh
  } = useVessels(filters);

  // Auto-locate vessel on exact search match
  useEffect(() => {

    if (!filters.search || filters.search.length < 2) return;

    if (vessels.length === 1) {

      setSelectedVessel(vessels[0]);
      setTrailData(null); setPredictRoute(null);

      if (mapRef.current?.panToVessel) {
        mapRef.current.panToVessel(vessels[0]);
      }

      if (IS_MOBILE()) {
        setPanelOpen(false);
      }

    }

  }, [vessels, filters.search]);

  // Sync selectedVessel with live data on every background refresh.
  // Without this the detail panel stays frozen at the snapshot from when
  // the user clicked — speed, position, heading, timestamps never update.
  useEffect(() => {
    if (!selectedVessel) return;
    const fresh = vessels.find(v => v.imo_number === selectedVessel.imo_number);
    if (fresh) setSelectedVessel(fresh);
  }, [vessels]); // eslint-disable-line react-hooks/exhaustive-deps


  // Handle resize mobile → desktop
  useEffect(() => {

    const handler = () => {

      if (!IS_MOBILE() && !panelOpen) {
        setPanelOpen(true);
      }

    };

    window.addEventListener("resize", handler);

    return () => {
      window.removeEventListener("resize", handler);
    };

  }, [panelOpen]);

  const handleSelectVessel = useCallback((vessel) => {
    setSelectedVessel(vessel);
    setTrailData(null); setPredictRoute(null);
    if (IS_MOBILE()) setPanelOpen(false);
    // Defer resize until after the CSS slide-in transition finishes (~300ms).
    // Running it too early causes a double layout + blank tile flash.
    setTimeout(() => { mapRef.current?.triggerResize?.(); }, 320);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedVessel(null);
    setTrailData(null); setPredictRoute(null);
    setTimeout(() => { mapRef.current?.triggerResize?.(); }, 320);
  }, []);

  const handleLogout = useCallback(() => {

    logoutUser();
    setUser(null);

  }, []);

  const handleSearchEnter = useCallback(() => {

    if (vessels.length > 0) {

      const v = vessels[0];

      setSelectedVessel(v);
      setTrailData(null); setPredictRoute(null);

      if (mapRef.current?.panToVessel) {
        mapRef.current.panToVessel(v);
      }

      if (IS_MOBILE()) {
        setPanelOpen(false);
      }

    }

  }, [vessels]);

  // Mobile backdrop click
  const handleBackdropClick = useCallback(() => {

    setPanelOpen(false);
    setSelectedVessel(null);

  }, []);

  if (!user) {
    return <AuthPage onAuth={setUser} />;
  }

  const showLeftBackdrop = IS_MOBILE() && panelOpen;
  const showRightBackdrop = IS_MOBILE() && !!selectedVessel;

  return (

    <div className="app-root">

      <TopBar
        filters={filters}
        onFiltersChange={setFilters}
        vesselTypes={vesselTypes}
        stats={stats}
        nextRefresh={nextRefresh}
        loading={loading}
        onRefresh={refresh}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen(p => !p)}
        lastUpdated={lastUpdated}
        user={user}
        onLogout={handleLogout}
        onSearchEnter={handleSearchEnter}
      />

      <ErrorBanner
        message={error}
        onRetry={refresh}
      />

      <div className="app-body">

        {/* LEFT PANEL */}
        <div className={`app-left-panel ${panelOpen ? "open" : "closed"}`}>

          <VesselPanel
            vessels={vessels}
            selectedId={selectedVessel?.imo_number}
            onSelect={handleSelectVessel}
            loading={loading}
            stats={stats}
            panelOpen={panelOpen}
            onMinimize={() => setPanelOpen(false)}
          />

        </div>

        {/* LEFT BACKDROP (mobile) */}
        {showLeftBackdrop && (
          <div
            className="app-mobile-backdrop"
            onClick={handleBackdropClick}
          />
        )}

        {/* MAP */}
        <div className="app-map-area">

          {/* PORT ACTIVITY FLOATING TRIGGER */}
          <div style={{ position:"absolute", bottom:"90px", right:"12px", zIndex:100 }}>
            <PortActivityTrigger
              onClick={() => setPortPanelOpen(p => !p)}
              isOpen={portPanelOpen}
              arrivals={0}
              departures={0}
            />
          </div>

          {/* PORT ACTIVITY FLOATING PANEL */}
          <PortActivityPanel
            isOpen={portPanelOpen}
            onClose={() => setPortPanelOpen(false)}
            onSelectVessel={handleSelectVessel}
            selectedImo={selectedVessel?.imo_number}
          />

          <MapView
            ref={mapRef}
            vessels={vessels}
            selectedVessel={selectedVessel}
            onVesselClick={handleSelectVessel}
            trailData={trailData}
            predictRoute={predictRoute}
          />

          <div className="map-legend-overlay">
            <SpeedLegend />
          </div>

          {loading && (
            <div className="map-loading-overlay">
              <div className="map-loading-spinner" />
              <span>FETCHING AIS DATA</span>
            </div>
          )}

        </div>

        {/* RIGHT BACKDROP (mobile) */}
        {showRightBackdrop && (
          <div
            className="app-mobile-backdrop"
            onClick={handleCloseDetail}
            style={{ zIndex: 45 }}
          />
        )}

        {/* RIGHT PANEL */}
        <div className={`app-right-panel ${selectedVessel ? "open" : "closed"}`}>

          <VesselDetailPanel
            vessel={selectedVessel}
            onClose={handleCloseDetail}
            onShowTrail={setTrailData}
            onShowPredictRoute={setPredictRoute}
          />

        </div>

      </div>

    </div>

  );

}