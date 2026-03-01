// backend/tests/api.test.js
// Run: npm test
// No real BigQuery needed — everything is mocked.

const request = require("supertest");
const app = require("../src/server");

// ── Mock BigQuery service ───────────────────────────────────────────
jest.mock("../src/services/bigquery", () => ({
  getLatestVessels: jest.fn(),
  getVesselHistory: jest.fn(),
  getVesselTypes: jest.fn(),
  getFleetStats: jest.fn(),
  healthCheck: jest.fn(),
}));

const bq = require("../src/services/bigquery");

// ── Fixture ─────────────────────────────────────────────────────────
const VESSEL = {
  vessel_name: "MARLIN LORETO",
  imo_number: 9823558,
  mmsi_number: 538009736,
  flag: "MH",
  vessel_type: "TA",
  call_sign: "V7A5099",
  latitude_degrees: 1.76262234076,
  longitude_degrees: 102.482197175,
  speed: 11.5869,
  heading: 110,
  course: 111,
  vessel_length: 250,
  vessel_breadth: 45,
  gross_tonnage: 65552,
  deadweight: 114823,
  year_built: 2021,
  effective_timestamp: "2026-02-28T00:08:08.000Z",
};

// ══ /health ══════════════════════════════════════════════════════════
describe("GET /health", () => {
  test("200 when BigQuery is OK", async () => {
    bq.healthCheck.mockResolvedValue(true);
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.bigquery).toBe("connected");
    expect(res.body).toHaveProperty("uptime");
  });

  test("503 when BigQuery throws", async () => {
    bq.healthCheck.mockRejectedValue(new Error("unreachable"));
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.bigquery).toBe("unreachable");
  });
});

// ══ GET /api/vessels ══════════════════════════════════════════════════
describe("GET /api/vessels", () => {
  beforeEach(() => bq.getLatestVessels.mockResolvedValue([VESSEL]));

  test("200 with success+count+data shape", async () => {
    const res = await request(app).get("/api/vessels");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0].vessel_name).toBe("MARLIN LORETO");
    expect(typeof res.body.data[0].speed).toBe("number");
  });

  test("passes search param to BigQuery", async () => {
    await request(app).get("/api/vessels?search=MARLIN");
    expect(bq.getLatestVessels).toHaveBeenCalledWith(
      expect.objectContaining({ search: "MARLIN" }),
    );
  });

  test("passes vesselType param", async () => {
    await request(app).get("/api/vessels?vesselType=TA");
    expect(bq.getLatestVessels).toHaveBeenCalledWith(
      expect.objectContaining({ vesselType: "TA" }),
    );
  });

  test("passes speedMin + speedMax", async () => {
    bq.getLatestVessels.mockResolvedValue([]);
    await request(app).get("/api/vessels?speedMin=5&speedMax=15");
    expect(bq.getLatestVessels).toHaveBeenCalledWith(
      expect.objectContaining({ speedMin: 5, speedMax: 15 }),
    );
  });

  test("400 on invalid speedMin", async () => {
    const res = await request(app).get("/api/vessels?speedMin=abc");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("400 on invalid speedMax", async () => {
    const res = await request(app).get("/api/vessels?speedMax=xyz");
    expect(res.status).toBe(400);
  });

  test("400 on invalid limit", async () => {
    const res = await request(app).get("/api/vessels?limit=-5");
    expect(res.status).toBe(400);
  });

  test("200 empty array when no vessels", async () => {
    bq.getLatestVessels.mockResolvedValue([]);
    const res = await request(app).get("/api/vessels");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.data).toEqual([]);
  });

  test("500 on BigQuery failure", async () => {
    bq.getLatestVessels.mockRejectedValue(new Error("BQ down"));
    const res = await request(app).get("/api/vessels");
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

// ══ GET /api/vessels/:imo/history ════════════════════════════════════
describe("GET /api/vessels/:imo/history", () => {
  test("200 with history array", async () => {
    bq.getVesselHistory.mockResolvedValue([VESSEL, VESSEL]);
    const res = await request(app).get("/api/vessels/9823558/history");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(2);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test("400 for non-numeric IMO", async () => {
    const res = await request(app).get("/api/vessels/ABCXYZ/history");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("passes hours param", async () => {
    bq.getVesselHistory.mockResolvedValue([]);
    await request(app).get("/api/vessels/9823558/history?hours=48");
    expect(bq.getVesselHistory).toHaveBeenCalledWith("9823558", 48);
  });

  test("500 on BQ error", async () => {
    bq.getVesselHistory.mockRejectedValue(new Error("BQ error"));
    const res = await request(app).get("/api/vessels/9823558/history");
    expect(res.status).toBe(500);
  });
});

// ══ GET /api/vessel-types ═════════════════════════════════════════════
describe("GET /api/vessel-types", () => {
  test("200 with data array", async () => {
    bq.getVesselTypes.mockResolvedValue(["TA", "FR", "BC", "LC", "PV"]);
    const res = await request(app).get("/api/vessel-types");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toContain("TA");
  });

  test("500 on error", async () => {
    bq.getVesselTypes.mockRejectedValue(new Error("fail"));
    const res = await request(app).get("/api/vessel-types");
    expect(res.status).toBe(500);
  });
});

// ══ GET /api/stats ════════════════════════════════════════════════════
describe("GET /api/stats", () => {
  test("200 with stats", async () => {
    bq.getFleetStats.mockResolvedValue({
      total_vessels: 1200,
      moving_vessels: 850,
      stationary_vessels: 350,
      avg_speed: 8.7,
      max_speed: 22.4,
    });
    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total_vessels).toBe(1200);
  });
});

// ══ 404 ═══════════════════════════════════════════════════════════════
describe("404 handler", () => {
  test("returns 404 for unknown routes", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
