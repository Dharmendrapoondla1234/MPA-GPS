// src/App.jsx
import React, { useState, useCallback, useEffect, useRef } from "react";
import AuthPage from "./components/Authpage";
import TopBar from "./components/TopBar";
import VesselPanel from "./components/VesselPanel";
import VesselDetailPanel from "./components/VesselDetailPanel";
import MapView from "./components/MapView";
import SpeedLegend from "./components/SpeedLegend";
import ErrorBanner from "./components/ErrorBanner";
import { useVessels } from "./hooks/useVessels";
import { getCurrentUser, logoutUser } from "./services/api";
import "./styles/App.css";

export default function App() {
  const [user, setUser] = useState(() => getCurrentUser());
  const [filters, setFilters] = useState({
    search: "",
    vesselType: "",
    speedRange: "",
    speedMin: null,
    speedMax: null,
  });
  const [selectedVessel, setSelectedVessel] = useState(null);
  const [trailData, setTrailData] = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const mapRef = useRef(null); // ref to MapView so we can call panTo from outside

  const {
    vessels,
    stats,
    vesselTypes,
    loading,
    error,
    nextRefresh,
    lastUpdated,
    refresh,
  } = useVessels(filters);

  // ── Auto-locate vessel when search matches exactly 1 result ─────────
  useEffect(() => {
    if (!filters.search || filters.search.length < 2) return;
    if (vessels.length === 1) {
      // Exact match — auto-select and pan
      setSelectedVessel(vessels[0]);
      setTrailData(null);
      // Pan map via ref
      if (mapRef.current?.panToVessel) {
        mapRef.current.panToVessel(vessels[0]);
      }
    }
  }, [vessels, filters.search]);

  const handleSelectVessel = useCallback((vessel) => {
    setSelectedVessel(vessel);
    setTrailData(null);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedVessel(null);
    setTrailData(null);
  }, []);

  const handleLogout = useCallback(() => {
    logoutUser();
    setUser(null);
  }, []);

  // On Enter key in search — pan to first matching vessel
  const handleSearchEnter = useCallback(() => {
    if (vessels.length > 0) {
      const v = vessels[0];
      setSelectedVessel(v);
      setTrailData(null);
      if (mapRef.current?.panToVessel) mapRef.current.panToVessel(v);
    }
  }, [vessels]);

  if (!user) return <AuthPage onAuth={setUser} />;

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
        onTogglePanel={() => setPanelOpen((p) => !p)}
        lastUpdated={lastUpdated}
        user={user}
        onLogout={handleLogout}
        onSearchEnter={handleSearchEnter}
      />
      <ErrorBanner message={error} onRetry={refresh} />

      <div className="app-body">
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

        <div className="app-map-area">
          <MapView
            ref={mapRef}
            vessels={vessels}
            selectedVessel={selectedVessel}
            onVesselClick={handleSelectVessel}
            trailData={trailData}
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

        <div
          className={`app-right-panel ${selectedVessel ? "open" : "closed"}`}
        >
          <VesselDetailPanel
            vessel={selectedVessel}
            onClose={handleCloseDetail}
            onShowTrail={setTrailData}
          />
        </div>
      </div>
    </div>
  );
}
