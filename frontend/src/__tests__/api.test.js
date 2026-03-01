// src/__tests__/api.test.js
import {
  fetchVessels,
  fetchVesselHistory,
  fetchVesselTypes,
  fetchFleetStats,
} from "../services/api";

const VESSEL = {
  vessel_name: "MARLIN LORETO",
  imo_number: 9823558,
  speed: 11.5869,
};

function mockFetch(payload, ok = true) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  });
}

afterEach(() => jest.resetAllMocks());

describe("fetchVessels", () => {
  test("returns data array on success: true", async () => {
    mockFetch({ success: true, count: 1, data: [VESSEL] });
    const r = await fetchVessels();
    expect(Array.isArray(r)).toBe(true);
    expect(r[0].vessel_name).toBe("MARLIN LORETO");
  });

  test("returns plain array response", async () => {
    mockFetch([VESSEL]);
    const r = await fetchVessels();
    expect(Array.isArray(r)).toBe(true);
  });

  test("appends search param", async () => {
    mockFetch({ success: true, data: [] });
    await fetchVessels({ search: "MARLIN" });
    expect(global.fetch.mock.calls[0][0]).toContain("search=MARLIN");
  });

  test("appends vesselType param", async () => {
    mockFetch({ success: true, data: [] });
    await fetchVessels({ vesselType: "TA" });
    expect(global.fetch.mock.calls[0][0]).toContain("vesselType=TA");
  });

  test("appends speedMin/speedMax", async () => {
    mockFetch({ success: true, data: [] });
    await fetchVessels({ speedMin: 5, speedMax: 12 });
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain("speedMin=5");
    expect(url).toContain("speedMax=12");
  });

  test("throws on HTTP error", async () => {
    mockFetch({}, false);
    await expect(fetchVessels()).rejects.toThrow("HTTP 500");
  });

  test("throws on success:false", async () => {
    mockFetch({ success: false, error: "BQ error" });
    await expect(fetchVessels()).rejects.toThrow("BQ error");
  });
});

describe("fetchVesselHistory", () => {
  test("calls /vessels/:imo/history with hours", async () => {
    mockFetch({ success: true, data: [VESSEL] });
    const r = await fetchVesselHistory(9823558, 48);
    expect(global.fetch.mock.calls[0][0]).toContain("/vessels/9823558/history");
    expect(global.fetch.mock.calls[0][0]).toContain("hours=48");
    expect(Array.isArray(r)).toBe(true);
  });
});

describe("fetchVesselTypes", () => {
  test("returns types array", async () => {
    mockFetch({ success: true, data: ["TA", "FR", "BC", "LC", "PV", "CH"] });
    const r = await fetchVesselTypes();
    expect(r).toContain("TA");
    expect(r).toContain("FR");
  });
});

describe("fetchFleetStats", () => {
  test("returns stats object", async () => {
    mockFetch({ success: true, data: { total_vessels: 1200, avg_speed: 8.7 } });
    const r = await fetchFleetStats();
    expect(r.total_vessels).toBe(1200);
    expect(r.avg_speed).toBe(8.7);
  });
});
