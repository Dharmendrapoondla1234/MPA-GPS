// src/App.jsx — Full responsive layout with mobile/tablet/desktop support
import React, { useState, useCallback, useEffect } from "react";
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

function useBreakpoint() {
  const getBP = () => window.innerWidth < 768 ? "mobile" : window.innerWidth < 1100 ? "tablet" : "desktop";
  const [bp, setBp] = useState(getBP);
  useEffect(() => {
    const h = () => setBp(getBP());
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return bp;
}

export default function App() {
  const [user, setUser] = useState(() => getCurrentUser());
  const [filters, setFilters] = useState({ search:"", vesselType:"", speedRange:"", speedMin:null, speedMax:null });
  const [selectedVessel, setSelectedVessel] = useState(null);
  const [trailData, setTrailData] = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [mobileView, setMobileView] = useState("map"); // "map"|"list"|"detail"
  const bp = useBreakpoint();
  const isMobile = bp === "mobile";

  const { vessels, stats, vesselTypes, loading, syncing, error, nextRefresh, lastUpdated, refresh } = useVessels(filters);

  const handleSelectVessel = useCallback((vessel) => {
    setSelectedVessel(vessel);
    setTrailData(null);
    if (isMobile) setMobileView("detail");
  }, [isMobile]);

  const handleCloseDetail = useCallback(() => {
    setSelectedVessel(null);
    setTrailData(null);
    if (isMobile) setMobileView("map");
  }, [isMobile]);

  const handleLogout = useCallback(() => { logoutUser(); setUser(null); }, []);

  if (!user) return <AuthPage onAuth={setUser} />;

  const topBarProps = {
    filters, onFiltersChange: setFilters,
    vesselTypes, stats, nextRefresh,
    loading, syncing, onRefresh: refresh,
    panelOpen, onTogglePanel: () => setPanelOpen(p => !p),
    lastUpdated, user, onLogout: handleLogout,
    isMobile, mobileView, onMobileViewChange: setMobileView,
  };

  // ── MOBILE ──
  if (isMobile) {
    return (
      <div className="app-root">
        <TopBar {...topBarProps} />
        <ErrorBanner message={error} onRetry={refresh} />
        <div className="app-mobile-body">
          <div className={`app-mobile-pane ${mobileView==="map"?"active":""}`}>
            <MapView vessels={vessels} selectedVessel={selectedVessel} onVesselClick={handleSelectVessel} trailData={trailData} />
            <div className="map-legend-overlay"><SpeedLegend /></div>
            {loading && <div className="map-loading-overlay"><div className="map-loading-spinner"/><span>FETCHING AIS DATA</span></div>}
          </div>
          <div className={`app-mobile-pane ${mobileView==="list"?"active":""}`}>
            <VesselPanel vessels={vessels} selectedId={selectedVessel?.imo_number} onSelect={handleSelectVessel} loading={loading} />
          </div>
          <div className={`app-mobile-pane ${mobileView==="detail"?"active":""}`}>
            {selectedVessel
              ? <VesselDetailPanel vessel={selectedVessel} onClose={handleCloseDetail} onShowTrail={setTrailData} />
              : <div className="app-no-sel"><span>🚢</span><p>Select a vessel from the Fleet tab or tap a marker on the map</p></div>
            }
          </div>
        </div>
      </div>
    );
  }

  // ── TABLET + DESKTOP ──
  return (
    <div className="app-root">
      <TopBar {...topBarProps} />
      <ErrorBanner message={error} onRetry={refresh} />
      <div className="app-body">
        <div className={`app-left-panel ${panelOpen?"open":"closed"}`}>
          <VesselPanel vessels={vessels} selectedId={selectedVessel?.imo_number} onSelect={handleSelectVessel} loading={loading} />
        </div>
        <div className="app-map-area">
          <MapView vessels={vessels} selectedVessel={selectedVessel} onVesselClick={handleSelectVessel} trailData={trailData} />
          <div className="map-legend-overlay"><SpeedLegend /></div>
          {/* Only show overlay on first load — not on background refresh */}
          {loading && vessels.length === 0 && (
            <div className="map-loading-overlay">
              <div className="map-loading-spinner"/>
              <span>FETCHING AIS DATA</span>
            </div>
          )}
          {/* Subtle syncing badge for background refreshes */}
          {syncing && (
            <div className="map-sync-badge">
              <div className="map-sync-dot"/>SYNCING
            </div>
          )}
        </div>
        <div className={`app-right-panel ${selectedVessel?"open":"closed"}`}>
          <VesselDetailPanel vessel={selectedVessel} onClose={handleCloseDetail} onShowTrail={setTrailData} />
        </div>
      </div>
    </div>
  );
}
