// src/App.jsx — FIXED: added auth, correct imports
import React, { useState, useCallback } from "react";
import AuthPage from "./components/Authpage";
import TopBar from "./components/TopBar";
import VesselPanel from "./components/VesselPanel";
import VesselDetailPanel from "./components/VesselDetailPanel";
import MapView from "./components/MapView";
import SpeedLegend from "./components/SpeedLegend";
import ErrorBanner from "./components/ErrorBanner";
import { useVessels } from "./hooks/useVessels";
import { getCurrentUser, logoutUser } from "./services/api";
import "./styles/globals.css";
import "./styles/App.css";

export default function App() {
  const [user, setUser] = useState(() => getCurrentUser());
  const [filters, setFilters] = useState({
    search: "", vesselType: "", speedRange: "", speedMin: null, speedMax: null,
  });
  const [selectedVessel, setSelectedVessel] = useState(null);
  const [trailData, setTrailData] = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);

  const { vessels, stats, vesselTypes, loading, error, nextRefresh, lastUpdated, refresh } =
    useVessels(filters);

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

  // Show login page if not authenticated
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
      />
      <ErrorBanner message={error} onRetry={refresh} />

      <div className="app-body">
        <div className={`app-left-panel ${panelOpen ? "open" : "closed"}`}>
          <VesselPanel
            vessels={vessels}
            selectedId={selectedVessel?.imo_number}
            onSelect={handleSelectVessel}
            loading={loading}
          />
        </div>

        <div className="app-map-area">
          <MapView
            vessels={vessels}
            selectedVessel={selectedVessel}
            onVesselClick={handleSelectVessel}
            trailData={trailData}
          />
          <div className="map-legend-overlay"><SpeedLegend /></div>
          {loading && (
            <div className="map-loading-overlay">
              <div className="map-loading-spinner" />
              <span>FETCHING AIS DATA</span>
            </div>
          )}
        </div>

        <div className={`app-right-panel ${selectedVessel ? "open" : "closed"}`}>
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
