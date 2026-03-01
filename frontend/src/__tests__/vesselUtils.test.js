// src/__tests__/vesselUtils.test.js
import {
  getSpeedColor,
  getVesselStatus,
  formatTimestamp,
  buildInfoWindowContent,
} from "../utils/vesselUtils";

describe("getSpeedColor", () => {
  test("0 → grey (stopped)", () => expect(getSpeedColor(0)).toBe("#607d8b"));
  test("null → grey", () => expect(getSpeedColor(null)).toBe("#607d8b"));
  test("undefined → grey", () =>
    expect(getSpeedColor(undefined)).toBe("#607d8b"));
  test("0.5 → grey", () => expect(getSpeedColor(0.5)).toBe("#607d8b"));
  test("1 → green", () => expect(getSpeedColor(1)).toBe("#26c97a"));
  test("4.9 → green", () => expect(getSpeedColor(4.9)).toBe("#26c97a"));
  test("5 → amber", () => expect(getSpeedColor(5)).toBe("#f5a623"));
  test("11.9 → amber", () => expect(getSpeedColor(11.9)).toBe("#f5a623"));
  test("12 → red", () => expect(getSpeedColor(12)).toBe("#e8404e"));
  test("22 → red", () => expect(getSpeedColor(22)).toBe("#e8404e"));
});

describe("getVesselStatus", () => {
  test("stopped → moored/stopped label + grey", () => {
    const s = getVesselStatus(0);
    expect(s.label).toMatch(/moored|stopped/i);
    expect(s.color).toBe("#607d8b");
  });
  test("slow → Slow Speed + green", () => {
    const s = getVesselStatus(3);
    expect(s.label).toMatch(/slow/i);
    expect(s.color).toBe("#26c97a");
  });
  test("medium → Under Way + amber", () => {
    const s = getVesselStatus(8);
    expect(s.label).toMatch(/way/i);
    expect(s.color).toBe("#f5a623");
  });
  test("fast → Full Ahead + red", () => {
    const s = getVesselStatus(15);
    expect(s.label).toMatch(/full|ahead/i);
    expect(s.color).toBe("#e8404e");
  });
});

describe("formatTimestamp", () => {
  test("formats ISO string to locale string", () => {
    const r = formatTimestamp("2026-02-28T00:08:08.000Z");
    expect(typeof r).toBe("string");
    expect(r.length).toBeGreaterThan(5);
  });
  test("null → Unknown", () => expect(formatTimestamp(null)).toBe("Unknown"));
  test("undefined → Unknown", () =>
    expect(formatTimestamp(undefined)).toBe("Unknown"));
  test("empty → Unknown", () => expect(formatTimestamp("")).toBe("Unknown"));
});

describe("buildInfoWindowContent", () => {
  const v = {
    vessel_name: "MARLIN LORETO",
    imo_number: 9823558,
    speed: 11.5869,
    heading: 110,
    vessel_type: "TA",
    flag: "MH",
    effective_timestamp: "2026-02-28T00:08:08.000Z",
  };

  // Mock window.google for vesselUtils
  beforeAll(() => {
    global.window.google = {
      maps: {
        SymbolPath: { FORWARD_CLOSED_ARROW: 0 },
      },
    };
  });

  test("includes vessel name", () =>
    expect(buildInfoWindowContent(v)).toContain("MARLIN LORETO"));
  test("includes IMO", () =>
    expect(buildInfoWindowContent(v)).toContain("9823558"));
  test("includes speed value", () =>
    expect(buildInfoWindowContent(v)).toContain("11.6"));
  test("includes flag", () =>
    expect(buildInfoWindowContent(v)).toContain("MH"));
  test("handles null vessel_name", () => {
    const html = buildInfoWindowContent({ ...v, vessel_name: null });
    expect(html).toContain("Unknown Vessel");
  });
  test("handles null speed", () => {
    const html = buildInfoWindowContent({ ...v, speed: null });
    expect(html).toContain("0.0");
  });
});
