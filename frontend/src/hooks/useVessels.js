// src/hooks/useVessels.js
import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchVessels,
  fetchFleetStats,
  fetchVesselTypes,
} from "../services/api";

// 60s refresh — dbt runs every 30min, backend cache 30s, so new data lands within ~60s
const REFRESH_MS = parseInt(process.env.REACT_APP_REFRESH_INTERVAL) || 60_000;

export function useVessels(filters = {}) {
  const [vessels,     setVessels]     = useState([]);
  const [stats,       setStats]       = useState(null);
  const [vesselTypes, setVesselTypes] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [syncing,     setSyncing]     = useState(false);
  const [error,       setError]       = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [nextRefresh, setNextRefresh] = useState(Date.now() + REFRESH_MS);
  const filtersRef  = useRef(filters);
  const firstLoad   = useRef(true);
  filtersRef.current = filters;

  const load = useCallback(async (bg = false) => {
    if (bg) setSyncing(true);
    else    setLoading(true);
    setError(null);
    try {
      // bg=true → bustCache:true → bypass frontend cache so positions actually refresh
      const data = await fetchVessels(filtersRef.current, { bustCache: bg });
      if (Array.isArray(data)) {
        setVessels(data);

        // FIX: Show REAL data freshness — use the most recent last_position_at
        // from the actual vessel data, not just "when JS made the fetch".
        // This way "Last updated" reflects when BigQuery/dbt actually wrote data.
        let maxDataTs = null;
        for (const v of data) {
          const raw = v.effective_timestamp || v.last_position_at;
          if (!raw) continue;
          const t = new Date(typeof raw === "object" && raw.value ? raw.value : raw);
          if (!isNaN(t) && (!maxDataTs || t > maxDataTs)) maxDataTs = t;
        }
        setLastUpdated(maxDataTs || new Date());
      }
      setLoading(false); // map visible immediately, before stats finish

      // Stats load quietly in the background
      fetchFleetStats()
        .then(setStats)
        .catch(e => console.warn("Stats fetch failed:", e.message));

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

  // Filter change reload — debounced 400ms
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

  // Silent background refresh — bustCache:true so fresh coords come through
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