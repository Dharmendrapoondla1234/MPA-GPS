// src/App.jsx — MPA Advanced v6
import React, { useState, useCallback, useEffect, useRef } from "react";
import AuthPage           from "./components/Authpage";
import TopBar             from "./components/TopBar";
import VesselPanel        from "./components/VesselPanel";
import VesselDetailPanel  from "./components/VesselDetailPanel";
import MapView            from "./components/MapView";
import SpeedLegend        from "./components/SpeedLegend";
import ErrorBanner        from "./components/ErrorBanner";
import PortActivityPanel  from "./components/PortActivityPanel";
import { useVessels }     from "./hooks/useVessels";
import { getCurrentUser, logoutUser } from "./services/api";
import "./styles/App.css";

const IS_MOBILE = () => window.innerWidth <= 768;
const IS_TABLET = () => window.innerWidth <= 1100;

export default function App() {
  const [user,          setUser]         = useState(() => getCurrentUser());
  const [filters,       setFilters]      = useState({ search:"", vesselType:"", speedRange:"", speedMin:null, speedMax:null });
  const [selectedVessel,setSelectedVessel]=useState(null);
  const [trailData,     setTrailData]    = useState(null);
  const [predictRoute,  setPredictRoute] = useState(null);
  const [panelOpen,     setPanelOpen]    = useState(!IS_MOBILE());
  const [portPanelOpen, setPortPanelOpen]= useState(!IS_TABLET());
  const mapRef = useRef(null);

  const { vessels, stats, vesselTypes, loading, error, nextRefresh, lastUpdated, refresh } = useVessels(filters);

  // Auto-locate on search — local lookup first, then filtered result
  useEffect(() => {
    const q = (filters.search || "").trim();
    if (q.length < 2) return;

    // Priority 1: exact IMO/MMSI match in full vessel list (instant, no API round-trip)
    const isNum = /^\d+$/.test(q);
    if (isNum && vessels.length > 0) {
      const exact = vessels.find(v =>
        String(v.imo_number)  === q ||
        String(v.mmsi_number) === q
      );
      if (exact) {
        setSelectedVessel(exact);
        setTrailData(null); setPredictRoute(null);
        if (mapRef.current?.panToVessel) mapRef.current.panToVessel(exact);
        if (IS_MOBILE()) setPanelOpen(false);
        return;
      }
    }

    // Priority 2: single result from server-filtered list
    if (vessels.length === 1) {
      setSelectedVessel(vessels[0]);
      setTrailData(null); setPredictRoute(null);
      if (mapRef.current?.panToVessel) mapRef.current.panToVessel(vessels[0]);
      if (IS_MOBILE()) setPanelOpen(false);
    }
  }, [vessels, filters.search]);

  // Handle resize
  useEffect(() => {
    const handler = () => {
      if (!IS_MOBILE() && !panelOpen) setPanelOpen(true);
      if (!IS_TABLET() && !portPanelOpen) setPortPanelOpen(true);
    };
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [panelOpen, portPanelOpen]);

  const handleSelectVessel = useCallback((vessel) => {
    // Accept minimal vessel object from PortActivityPanel click too
    if (vessel?.imo_number) {
      setSelectedVessel(vessel);
      setTrailData(null); setPredictRoute(null);
      // Try to find full vessel data
      const full = vessels.find(v => v.imo_number === vessel.imo_number);
      if (full) { setSelectedVessel(full); if (mapRef.current?.panToVessel) mapRef.current.panToVessel(full); }
      if (IS_MOBILE()) { setPanelOpen(false); setPortPanelOpen(false); }
    }
  }, [vessels]);

  const handleCloseDetail = useCallback(() => {
    setSelectedVessel(null); setTrailData(null); setPredictRoute(null);
  }, []);

  const handleLogout = useCallback(() => {
    logoutUser(); setUser(null);
  }, []);

  const handleSearchEnter = useCallback(() => {
    const q = (filters.search || "").trim();
    // Try exact IMO/MMSI match in full list first
    if (/^\d+$/.test(q)) {
      const exact = vessels.find(v =>
        String(v.imo_number) === q || String(v.mmsi_number) === q
      );
      if (exact) {
        setSelectedVessel(exact); setTrailData(null); setPredictRoute(null);
        if (mapRef.current?.panToVessel) mapRef.current.panToVessel(exact);
        if (IS_MOBILE()) setPanelOpen(false);
        return;
      }
    }
    if (vessels.length > 0) {
      const v = vessels[0];
      setSelectedVessel(v); setTrailData(null); setPredictRoute(null);
      if (mapRef.current?.panToVessel) mapRef.current.panToVessel(v);
      if (IS_MOBILE()) setPanelOpen(false);
    }
  }, [vessels, filters.search]);

  if (!user) return <AuthPage onAuth={setUser} />;

  const showLeftBackdrop  = IS_MOBILE() && panelOpen;
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
        onTogglePanel={() => setPanelOpen(p=>!p)}
        lastUpdated={lastUpdated}
        user={user}
        onLogout={handleLogout}
        onSearchEnter={handleSearchEnter}
        portPanelOpen={portPanelOpen}
        onTogglePortPanel={() => setPortPanelOpen(p=>!p)}
      />
      <ErrorBanner message={error} onRetry={refresh} />

      <div className="app-body">

        {/* LEFT — Vessel List */}
        <div className={`app-left-panel ${panelOpen?"open":"closed"}`}>
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

        {showLeftBackdrop && (
          <div className="app-mobile-backdrop" onClick={() => setPanelOpen(false)} />
        )}

        {/* CENTER — Map */}
        <div className="app-map-area">
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

        {showRightBackdrop && (
          <div className="app-mobile-backdrop" onClick={handleCloseDetail} style={{zIndex:45}} />
        )}

        {/* RIGHT — Vessel Detail */}
        <div className={`app-right-panel ${selectedVessel?"open":"closed"}`}>
          <VesselDetailPanel
            vessel={selectedVessel}
            onClose={handleCloseDetail}
            onShowTrail={setTrailData}
            onShowPredictRoute={setPredictRoute}
          />
        </div>

        {/* FAR RIGHT — Port Activity */}
        <div className={`app-port-panel ${portPanelOpen?"open":"closed"}`}>
          <PortActivityPanel
            onSelectVessel={handleSelectVessel}
            selectedImo={selectedVessel?.imo_number}
          />
        </div>

      </div>
    </div>
  );
}