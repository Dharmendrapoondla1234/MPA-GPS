// src/App.jsx — MarineTrack v7  (map-first, no left panel)
import React, { useState, useCallback, useEffect, useRef } from "react";
import AuthPage           from "./components/Authpage";
import TopBar             from "./components/TopBar";
import VesselDetailPanel  from "./components/VesselDetailPanel";
import MapView            from "./components/MapView";
import SpeedLegend        from "./components/SpeedLegend";
import ErrorBanner        from "./components/ErrorBanner";
import PortActivityPanel  from "./components/PortActivityPanel";
import { useVessels }     from "./hooks/useVessels";
import { getCurrentUser, logoutUser } from "./services/api";
import "./styles/App.css";

export default function App() {
  const [user,           setUser]          = useState(() => getCurrentUser());
  const [filters,        setFilters]       = useState({ search:"", vesselType:"", speedRange:"", speedMin:null, speedMax:null });
  const [selectedVessel, setSelectedVessel]= useState(null);
  const [trailData,      setTrailData]     = useState(null);
  const [predictRoute,   setPredictRoute]  = useState(null);
  const [rightPanel,     setRightPanel]    = useState("port"); // "port" | "detail" | null
  const mapRef = useRef(null);

  const { vessels, stats, vesselTypes, loading, error, nextRefresh, lastUpdated, refresh } = useVessels(filters);

  // Auto-locate on search
  useEffect(() => {
    const q = (filters.search || "").trim();
    if (q.length < 2) return;
    const isNum = /^\d+$/.test(q);
    if (isNum && vessels.length > 0) {
      const exact = vessels.find(v =>
        String(v.imo_number) === q || String(v.mmsi_number) === q
      );
      if (exact) { _select(exact); return; }
    }
    if (vessels.length === 1) _select(vessels[0]);
  // eslint-disable-next-line
  }, [vessels, filters.search]);

  function _select(vessel) {
    if (!vessel?.imo_number) return;
    const full = vessels.find(v => v.imo_number === vessel.imo_number) || vessel;
    setSelectedVessel(full);
    setTrailData(null);
    setPredictRoute(null);
    setRightPanel("detail");
    if (mapRef.current?.panToVessel) mapRef.current.panToVessel(full);
  }

  const handleSelectVessel = useCallback((v) => _select(v), [vessels]); // eslint-disable-line

  const handleCloseDetail = useCallback(() => {
    setSelectedVessel(null);
    setTrailData(null);
    setPredictRoute(null);
    setRightPanel("port");
  }, []);

  const handleLogout = useCallback(() => { logoutUser(); setUser(null); }, []);

  const handleSearchEnter = useCallback(() => {
    const q = (filters.search || "").trim();
    if (/^\d+$/.test(q)) {
      const exact = vessels.find(v => String(v.imo_number) === q || String(v.mmsi_number) === q);
      if (exact) { _select(exact); return; }
    }
    if (vessels.length > 0) _select(vessels[0]);
  // eslint-disable-next-line
  }, [vessels, filters.search]);

  if (!user) return <AuthPage onAuth={setUser} />;

  const portOpen   = rightPanel === "port";
  const detailOpen = rightPanel === "detail" && !!selectedVessel;

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
        lastUpdated={lastUpdated}
        user={user}
        onLogout={handleLogout}
        onSearchEnter={handleSearchEnter}
        portPanelOpen={portOpen}
        onTogglePortPanel={() => setRightPanel(p => p === "port" ? null : "port")}
        /* pass dummy props TopBar still expects */
        panelOpen={false}
        onTogglePanel={() => {}}
      />

      <ErrorBanner message={error} onRetry={refresh} />

      <div className="app-body">

        {/* FULL-WIDTH MAP — always visible */}
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

        {/* RIGHT — Port Activity (default on login) */}
        <div className={`app-right-panel ${portOpen ? "open" : ""}`}>
          <PortActivityPanel
            onSelectVessel={handleSelectVessel}
            selectedImo={selectedVessel?.imo_number}
          />
        </div>

        {/* RIGHT — Vessel Detail (appears when vessel clicked/searched) */}
        <div className={`app-right-panel app-detail-panel ${detailOpen ? "open" : ""}`}>
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