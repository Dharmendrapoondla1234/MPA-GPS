// src/hooks/useCountdown.js
import { useState, useEffect } from "react";
export function useCountdown(targetMs) {
  const [label, setLabel] = useState("—");
  useEffect(() => {
    const tick = () => {
      const r = Math.max(0, targetMs - Date.now());
      const m = Math.floor(r / 60000),
        s = Math.floor((r % 60000) / 1000);
      setLabel(`${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetMs]);
  return label;
}
