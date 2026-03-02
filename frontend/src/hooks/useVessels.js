// src/hooks/useVessels.js
import { useState, useEffect, useCallback, useRef } from "react";
import { fetchVessels, fetchFleetStats, fetchVesselTypes } from "../services/api";

const REFRESH_MS = parseInt(process.env.REACT_APP_REFRESH_INTERVAL) || 300_000;

export function useVessels(filters = {}) {
  const [vessels,     setVessels]     = useState([]);
  const [stats,       setStats]       = useState(null);
  const [vesselTypes, setVesselTypes] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [syncing,     setSyncing]     = useState(false);
  const [error,       setError]       = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [nextRefresh, setNextRefresh] = useState(Date.now() + REFRESH_MS);
  const filtersRef = useRef(filters);
  const firstLoad  = useRef(true);
  filtersRef.current = filters;

  const load = useCallback(async (bg = false) => {
    if (bg) setSyncing(true); else setLoading(true);
    setError(null);
    try {
      const [data, statsData] = await Promise.all([
        fetchVessels(filtersRef.current),
        fetchFleetStats(),
      ]);
      // Merge: update positions smoothly — don't replace array reference for unchanged vessels
      setVessels(prev => {
        if (!Array.isArray(data)) return prev;
        return data; // Map handles smooth movement
      });
      setStats(statsData);
      setLastUpdated(new Date());
      setNextRefresh(Date.now() + REFRESH_MS);
      firstLoad.current = false;
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    fetchVesselTypes().then(setVesselTypes).catch(() => setVesselTypes([]));
  }, []);

  // Initial load
  useEffect(() => { load(false); }, [load]);

  // Filter change reload (debounced)
  useEffect(() => {
    if (firstLoad.current) return;
    const t = setTimeout(() => load(false), 500);
    return () => clearTimeout(t);
  }, [filters.search, filters.vesselType, filters.speedMin, filters.speedMax, load]);

  // Silent background refresh — NO page reload, NO loading overlay
  useEffect(() => {
    const id = setInterval(() => load(true), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return {
    vessels, stats, vesselTypes,
    loading, syncing, error,
    lastUpdated, nextRefresh,
    refresh: () => load(false),
  };
}
