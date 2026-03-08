// src/hooks/useVessels.js
import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchVessels,
  fetchFleetStats,
  fetchVesselTypes,
} from "../services/api";

// Vessels change slowly — 90s refresh halves BigQuery cost vs old 300s,
// while still feeling live (map animates marker movements between refreshes).
const REFRESH_MS = parseInt(process.env.REACT_APP_REFRESH_INTERVAL) || 90_000;

export function useVessels(filters = {}) {
  const [vessels, setVessels] = useState([]);
  const [stats, setStats] = useState(null);
  const [vesselTypes, setVesselTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [nextRefresh, setNextRefresh] = useState(Date.now() + REFRESH_MS);
  const filtersRef = useRef(filters);
  const firstLoad = useRef(true);
  filtersRef.current = filters;

  const load = useCallback(async (bg = false) => {
    if (bg) setSyncing(true);
    else setLoading(true);
    setError(null);
    try {
      // ── STAGGERED LOAD ─────────────────────────────────────────
      // Fetch vessels first — show map as fast as possible.
      // Stats and types load in parallel after, without blocking the map.
      const data = await fetchVessels(filtersRef.current);
      if (Array.isArray(data)) setVessels(data);
      setLoading(false); // ← map visible NOW, before stats finish

      // Stats + types load quietly in background
      fetchFleetStats()
        .then(setStats)
        .catch((e) => console.warn("Stats fetch failed:", e.message));

      setLastUpdated(new Date());
      setNextRefresh(Date.now() + REFRESH_MS);
      firstLoad.current = false;
    } catch (err) {
      setError(err.message);
      setLoading(false);
    } finally {
      setSyncing(false);
    }
  }, []);

  // Vessel types — load once, very low priority
  useEffect(() => {
    // Delay vessel types fetch by 2s — not needed for initial render
    const t = setTimeout(() => {
      fetchVesselTypes()
        .then(setVesselTypes)
        .catch(() => setVesselTypes([]));
    }, 2000);
    return () => clearTimeout(t);
  }, []);

  // Initial load
  useEffect(() => {
    load(false);
  }, [load]);

  // Filter change reload — debounced 600ms
  useEffect(() => {
    if (firstLoad.current) return;
    const t = setTimeout(() => load(false), 400);
    return () => clearTimeout(t);
  }, [
    filters.search,
    filters.vesselType,
    filters.speedMin,
    filters.speedMax,
    load,
  ]);

  // Silent background refresh
  useEffect(() => {
    const id = setInterval(() => load(true), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return {
    vessels,
    stats,
    vesselTypes,
    loading,
    syncing,
    error,
    lastUpdated,
    nextRefresh,
    refresh: () => load(false),
  };
}