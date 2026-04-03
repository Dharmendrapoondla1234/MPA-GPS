// src/hooks/useVessels.js — v9 anti-rerender edition
// Key changes:
//  1. vessels array is stabilised with JSON fingerprint — same data = same reference,
//     so memo'd child components (MapView markers, VesselPanel list) don't re-render
//     unless actual vessel data changed.
//  2. Filters ref prevents the effect from re-running when the parent re-renders
//     with structurally-equal but newly created filter objects.
//  3. Background syncing flag separated from initial loading flag so spinners
//     don't flash on every 60s refresh.
import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchVessels,
  fetchFleetStats,
  fetchVesselTypes,
} from "../services/api";

const REFRESH_MS = parseInt(process.env.REACT_APP_REFRESH_INTERVAL) || 60_000;

// Stable fingerprint — only re-render consumers when actual vessel data changes
function fingerprint(arr) {
  if (!arr?.length) return "";
  // Use sum of (imo * speed * lat) — cheap, collision-resistant enough for UI
  let h = arr.length;
  for (const v of arr) {
    h = (h * 31 + (v.imo_number || 0) + (v.speed || 0) * 100 + (v.latitude_degrees || 0) * 1000) | 0;
  }
  return h;
}

export function useVessels(filters = {}) {
  const [vessels,     setVesselsRaw]  = useState([]);
  const [stats,       setStats]       = useState(null);
  const [vesselTypes, setVesselTypes] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [syncing,     setSyncing]     = useState(false);
  const [error,       setError]       = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [nextRefresh, setNextRefresh] = useState(Date.now() + REFRESH_MS);

  // Stable ref for filters so effects don't re-fire on every parent render
  const filtersRef  = useRef(filters);
  const firstLoad   = useRef(true);
  const fpRef       = useRef("");       // last fingerprint — skips setVessels when data unchanged

  // Track filter changes with a stable primitive for effect deps
  const filterKey = `${filters.search||""}|${filters.vesselType||""}|${filters.speedMin??""}}|${filters.speedMax??""}`;
  const filterKeyRef = useRef(filterKey);
  filterKeyRef.current = filterKey;
  filtersRef.current   = filters;

  // Stabilised setter — only triggers re-render when data actually changed
  const setVessels = useCallback((data) => {
    if (!Array.isArray(data)) return;
    const fp = fingerprint(data);
    if (fp === fpRef.current) return;  // identical data — skip render
    fpRef.current = fp;
    setVesselsRaw(data);
  }, []);

  const load = useCallback(async (bg = false) => {
    if (bg) setSyncing(true);
    else    setLoading(true);
    setError(null);
    try {
      const data = await fetchVessels(filtersRef.current, { bustCache: bg });
      if (Array.isArray(data)) {
        setVessels(data);

        let maxDataTs = null;
        for (const v of data) {
          const raw = v.effective_timestamp || v.last_position_at;
          if (!raw) continue;
          const t = new Date(typeof raw === "object" && raw.value ? raw.value : raw);
          if (!isNaN(t) && (!maxDataTs || t > maxDataTs)) maxDataTs = t;
        }
        setLastUpdated(maxDataTs || new Date());
      }
      setLoading(false);

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
  }, [setVessels]);

  // Vessel types — load once
  useEffect(() => {
    const t = setTimeout(() => {
      fetchVesselTypes()
        .then(setVesselTypes)
        .catch(() => setVesselTypes([]));
    }, 2000);
    return () => clearTimeout(t);
  }, []);

  // Initial load
  useEffect(() => { load(false); }, [load]);

  // Filter change — debounced 400ms, keyed on stable primitive
  useEffect(() => {
    if (firstLoad.current) return;
    const t = setTimeout(() => load(false), 400);
    return () => clearTimeout(t);
  }, [filterKey, load]); // eslint-disable-line react-hooks/exhaustive-deps

  // Background refresh
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
    refresh: () => load(true),
  };
}
