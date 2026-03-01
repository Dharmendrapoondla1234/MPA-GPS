/**
 * BIGQUERY SERVICE UNIT TESTS
 * Tests the sanitize logic, query building, and error handling
 * without calling real BigQuery (mocked).
 */

jest.mock("@google-cloud/bigquery");
const { BigQuery } = require("@google-cloud/bigquery");

// Mock query method
const mockQuery = jest.fn();
BigQuery.mockImplementation(() => ({ query: mockQuery }));

// Re-require after mock
const {
  getLatestVessels,
  getVesselHistory,
  getVesselTypes,
  getFleetStats,
} = require("../src/services/bigquery");

const MOCK_ROW = {
  vessel_name: "TEST SHIP",
  imo_number: 9999999,
  latitude_degrees: 1.3,
  longitude_degrees: 103.8,
  speed: 10,
  heading: 90,
  vessel_type: "Cargo",
  effective_timestamp: new Date(),
};

beforeEach(() => mockQuery.mockReset());

describe("getLatestVessels", () => {
  test("returns rows from BigQuery", async () => {
    mockQuery.mockResolvedValue([[MOCK_ROW]]);
    const result = await getLatestVessels();
    expect(result).toHaveLength(1);
    expect(result[0].vessel_name).toBe("TEST SHIP");
  });

  test("includes WHERE clause when search provided", async () => {
    mockQuery.mockResolvedValue([[MOCK_ROW]]);
    await getLatestVessels({ search: "test" });
    const calledQuery = mockQuery.mock.calls[0][0].query;
    expect(calledQuery.toLowerCase()).toContain("where");
    expect(calledQuery.toLowerCase()).toContain("test");
  });

  test("includes speed filter when speedMin provided", async () => {
    mockQuery.mockResolvedValue([[]]);
    await getLatestVessels({ speedMin: 5 });
    const calledQuery = mockQuery.mock.calls[0][0].query;
    expect(calledQuery).toContain("speed >= 5");
  });

  test("includes speed filter when speedMax provided", async () => {
    mockQuery.mockResolvedValue([[]]);
    await getLatestVessels({ speedMax: 15 });
    const calledQuery = mockQuery.mock.calls[0][0].query;
    expect(calledQuery).toContain("speed <= 15");
  });

  test("strips dangerous characters from search (SQL injection protection)", async () => {
    mockQuery.mockResolvedValue([[]]);
    await getLatestVessels({ search: "'; DROP TABLE users;--" });
    const calledQuery = mockQuery.mock.calls[0][0].query;
    expect(calledQuery).not.toContain("DROP TABLE");
    expect(calledQuery).not.toContain("'");
  });

  test("respects limit parameter", async () => {
    mockQuery.mockResolvedValue([[]]);
    await getLatestVessels({ limit: 100 });
    const calledQuery = mockQuery.mock.calls[0][0].query;
    expect(calledQuery).toContain("LIMIT 100");
  });

  test("throws when BigQuery rejects", async () => {
    mockQuery.mockRejectedValue(new Error("BQ error"));
    await expect(getLatestVessels()).rejects.toThrow("BQ error");
  });
});

describe("getVesselHistory", () => {
  test("returns history rows", async () => {
    mockQuery.mockResolvedValue([[MOCK_ROW, MOCK_ROW]]);
    const result = await getVesselHistory(9999999, 24);
    expect(result).toHaveLength(2);
  });

  test("throws for invalid IMO", async () => {
    await expect(getVesselHistory("not-a-number")).rejects.toThrow("Invalid IMO");
  });

  test("uses correct IMO in query", async () => {
    mockQuery.mockResolvedValue([[]]);
    await getVesselHistory(1234567, 24);
    const calledQuery = mockQuery.mock.calls[0][0].query;
    expect(calledQuery).toContain("1234567");
  });
});

describe("getVesselTypes", () => {
  test("returns array of type strings", async () => {
    mockQuery.mockResolvedValue([[{ vessel_type: "Cargo" }, { vessel_type: "Tanker" }]]);
    const result = await getVesselTypes();
    expect(result).toEqual(["Cargo", "Tanker"]);
  });

  test("filters out null/empty types", async () => {
    mockQuery.mockResolvedValue([[{ vessel_type: "Cargo" }, { vessel_type: null }, { vessel_type: "" }]]);
    const result = await getVesselTypes();
    expect(result).toEqual(["Cargo"]);
  });
});

describe("getFleetStats", () => {
  test("returns stats object", async () => {
    const mockStats = { total_vessels: 200, moving_vessels: 150, avg_speed: 9.5 };
    mockQuery.mockResolvedValue([[mockStats]]);
    const result = await getFleetStats();
    expect(result.total_vessels).toBe(200);
    expect(result.avg_speed).toBe(9.5);
  });

  test("returns empty object on no data", async () => {
    mockQuery.mockResolvedValue([[]]);
    const result = await getFleetStats();
    expect(result).toEqual({});
  });
});