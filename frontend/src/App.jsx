// // src/App.jsx — Ultra v4
// import React, { useState, useCallback, useEffect, useRef } from "react";
// import AuthPage from "./components/Authpage";
// import TopBar from "./components/TopBar";
// import VesselPanel from "./components/VesselPanel";
// import VesselDetailPanel from "./components/VesselDetailPanel";
// import MapView from "./components/MapView";
// import SpeedLegend from "./components/SpeedLegend";
// import ErrorBanner from "./components/ErrorBanner";
// import { useVessels } from "./hooks/useVessels";
// import { getCurrentUser, logoutUser } from "./services/api";
// import "./styles/App.css";

// const IS_MOBILE = () => window.innerWidth <= 768;

// export default function App() {
//   const [user, setUser] = useState(() => getCurrentUser());
//   const [filters, setFilters] = useState({ search: "", vesselType: "", speedRange: "", speedMin: null, speedMax: null });
//   const [selectedVessel, setSelectedVessel] = useState(null);
//   const [trailData, setTrailData] = useState(null);
//   const [panelOpen, setPanelOpen] = useState(!IS_MOBILE());
//   const mapRef = useRef(null);

//   const { vessels, stats, vesselTypes, loading, error, nextRefresh, lastUpdated, refresh } = useVessels(filters);

//   // Auto-locate vessel on exact search match
//   useEffect(() => {
//     if (!filters.search || filters.search.length < 2) return;
//     if (vessels.length === 1) {
//       setSelectedVessel(vessels[0]);
//       setTrailData(null);
//       if (mapRef.current?.panToVessel) mapRef.current.panToVessel(vessels[0]);
//       if (IS_MOBILE()) setPanelOpen(false);
//     }
//   }, [vessels, filters.search]);

//   // Close panel on resize from mobile -> desktop
//   useEffect(() => {
//     const handler = () => {
//       if (!IS_MOBILE() && !panelOpen) setPanelOpen(true);
//     };
//     window.addEventListener("resize", handler);
//     return () => window.removeEventListener("resize", handler);
//   }, [panelOpen]);

//   const handleSelectVessel = useCallback((vessel) => {
//     setSelectedVessel(vessel);
//     setTrailData(null);
//     // On mobile, auto-close left panel when selecting vessel
//     if (IS_MOBILE()) setPanelOpen(false);
//   }, []);

//   const handleCloseDetail = useCallback(() => {
//     setSelectedVessel(null);
//     setTrailData(null);
//   }, []);

//   const handleLogout = useCallback(() => {
//     logoutUser();
//     setUser(null);
//   }, []);

//   const handleSearchEnter = useCallback(() => {
//     if (vessels.length > 0) {
//       const v = vessels[0];
//       setSelectedVessel(v);
//       setTrailData(null);
//       if (mapRef.current?.panToVessel) mapRef.current.panToVessel(v);
//       if (IS_MOBILE()) setPanelOpen(false);
//     }
//   }, [vessels]);

//   // Mobile: clicking backdrop dismisses panel
//   const handleBackdropClick = useCallback(() => {
//     setPanelOpen(false);
//     setSelectedVessel(null);
//   }, []);

//   if (!user) return <AuthPage onAuth={setUser} />;

//   const showLeftBackdrop  = IS_MOBILE() && panelOpen;
//   const showRightBackdrop = IS_MOBILE() && !!selectedVessel;

//   return (
//     <div className="app-root">
//       <TopBar
//         filters={filters}
//         onFiltersChange={setFilters}
//         vesselTypes={vesselTypes}
//         stats={stats}
//         nextRefresh={nextRefresh}
//         loading={loading}
//         onRefresh={refresh}
//         panelOpen={panelOpen}
//         onTogglePanel={() => setPanelOpen(p => !p)}
//         lastUpdated={lastUpdated}
//         user={user}
//         onLogout={handleLogout}
//         onSearchEnter={handleSearchEnter}
//       />
//       <ErrorBanner message={error} onRetry={refresh} />

//       <div className="app-body">
//         {/* LEFT PANEL */}
//         <div className={`app-left-panel ${panelOpen ? "open" : "closed"}`}>
//           <VesselPanel
//             vessels={vessels}
//             selectedId={selectedVessel?.imo_number}
//             onSelect={handleSelectVessel}
//             loading={loading}
//             stats={stats}
//             panelOpen={panelOpen}
//             onMinimize={() => setPanelOpen(false)}
//           />
//         </div>

//         {/* Left panel backdrop (mobile) */}
//         {showLeftBackdrop && (
//           <div className="app-mobile-backdrop" onClick={() => setPanelOpen(false)} />
//         )}

//         {/* MAP */}
//         <div className="app-map-area">
//           <MapView
//             ref={mapRef}
//             vessels={vessels}
//             selectedVessel={selectedVessel}
//             onVesselClick={handleSelectVessel}
//             trailData={trailData}
//           />
//           <div className="map-legend-overlay">
//             <SpeedLegend />
//           </div>
//           {loading && (
//             <div className="map-loading-overlay">
//               <div className="map-loading-spinner" />
//               <span>FETCHING AIS DATA</span>
//             </div>
//           )}
//         </div>

//         {/* Right panel backdrop (mobile) */}
//         {showRightBackdrop && (
//           <div className="app-mobile-backdrop" onClick={handleCloseDetail} style={{ zIndex: 45 }} />
//         )}

//         {/* RIGHT PANEL (detail) */}
//         <div className={`app-right-panel ${selectedVessel ? "open" : "closed"}`}>
//           <VesselDetailPanel
//             vessel={selectedVessel}
//             onClose={handleCloseDetail}
//             onShowTrail={setTrailData}
//           />
//         </div>
//       </div>
//     </div>
//   );
// }
 
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
  const [panelOpen, setPanelOpen] = useState(!IS_MOBILE());

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
      setTrailData(null);

      if (mapRef.current?.panToVessel) {
        mapRef.current.panToVessel(vessels[0]);
      }

      if (IS_MOBILE()) {
        setPanelOpen(false);
      }

    }

  }, [vessels, filters.search]);

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
    setTrailData(null);

    if (IS_MOBILE()) {
      setPanelOpen(false);
    }

  }, []);

  const handleCloseDetail = useCallback(() => {

    setSelectedVessel(null);
    setTrailData(null);

  }, []);

  const handleLogout = useCallback(() => {

    logoutUser();
    setUser(null);

  }, []);

  const handleSearchEnter = useCallback(() => {

    if (vessels.length > 0) {

      const v = vessels[0];

      setSelectedVessel(v);
      setTrailData(null);

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
          />

        </div>

      </div>

    </div>

  );

} 