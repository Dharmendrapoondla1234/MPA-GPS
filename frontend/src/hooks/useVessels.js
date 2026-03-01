// src/hooks/useVessels.js
import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchVessels,
  fetchFleetStats,
  fetchVesselTypes,
} from "../services/api";
const REFRESH_MS = parseInt(process.env.REACT_APP_REFRESH_INTERVAL) || 300_000;

export function useVessels(filters = {}) {
  const [vessels, setVessels] = useState([]);
  const [stats, setStats] = useState(null);
  const [vesselTypes, setVesselTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [nextRefresh, setNextRefresh] = useState(Date.now() + REFRESH_MS);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, statsData] = await Promise.all([
        fetchVessels(filtersRef.current),
        fetchFleetStats(),
      ]);
      setVessels(Array.isArray(data) ? data : []);
      setStats(statsData);
      setLastUpdated(new Date());
      setNextRefresh(Date.now() + REFRESH_MS);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVesselTypes()
      .then(setVesselTypes)
      .catch(() => setVesselTypes([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const t = setTimeout(load, 600);
    return () => clearTimeout(t);
  }, [
    filters.search,
    filters.vesselType,
    filters.speedMin,
    filters.speedMax,
    load,
  ]);
  useEffect(() => {
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return {
    vessels,
    stats,
    vesselTypes,
    loading,
    error,
    lastUpdated,
    nextRefresh,
    refresh: load,
  };
}
