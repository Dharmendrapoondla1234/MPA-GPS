// tests/intelligence.test.js
// Unit + integration tests for the Node.js maritime intelligence pipeline
// Run with: npm test
"use strict";

// ── Jest mock for winston (not installed in test env) ─────────────────────────
jest.mock("winston", () => ({
  createLogger: () => ({ info:()=>{}, warn:()=>{}, debug:()=>{}, error:()=>{} }),
  format: { combine:()=>{}, timestamp:()=>{}, errors:()=>{}, printf:()=>{} },
  transports: { Console: function(){} },
}));

const { normalize, candidateDomains, deduplicateCompanies } =
  require("../src/services/intelligence/engines/normalizer");

const { generateEmails, inferPersonEmails, rankEmails, isValidSyntax, isDisposable } =
  require("../src/services/intelligence/engines/emailEngine");

const { scoreEmail, applyConfidenceScoring, methodConfidence } =
  require("../src/services/intelligence/engines/confidenceScorer");

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZER
// ─────────────────────────────────────────────────────────────────────────────
describe("Normalizer — legal suffix stripping", () => {
  test("strips pte. ltd.", ()  => expect(normalize("Pacific Shipping Pte. Ltd.").normalized).not.toContain("pte"));
  test("strips Ltd",      ()  => expect(normalize("Pacific Shipping Ltd").normalized).not.toContain("ltd"));
  test("strips Inc.",     ()  => expect(normalize("Acme Shipping Inc.").normalized).not.toContain("inc"));
  test("strips GmbH",    ()  => expect(normalize("Bernhard Schulte GmbH").normalized).not.toContain("gmbh"));
  test("strips GmbH & Co. KG", () => {
    const n = normalize("DFDS GmbH & Co. KG");
    expect(n.normalized).not.toContain("gmbh");
    expect(n.normalized).not.toContain("kg");
  });
  test("strips Pvt Ltd",  ()  => expect(normalize("Reliance Pvt Ltd").normalized).not.toContain("pvt"));
  test("strips PLC",      ()  => expect(normalize("British Shipping PLC").normalized).not.toContain("plc"));
});

describe("Normalizer — null/edge cases", () => {
  test("empty string → null", () => expect(normalize("")).toBeNull());
  test("null → null",         () => expect(normalize(null)).toBeNull());
  test("whitespace → null",   () => expect(normalize("   ")).toBeNull());
  test("very short → null",   () => expect(normalize("A")).toBeNull());
});

describe("Normalizer — slug generation", () => {
  test("slug strips generic words", () => {
    const n = normalize("Pacific Shipping Group Ltd");
    expect(n.slug).not.toContain("shipping");
    expect(n.slug).not.toContain("group");
    expect(n.slug).toContain("pacific");
  });
  test("slugFull keeps generic words", () => {
    expect(normalize("Pacific Shipping Group Ltd").slugFull).toContain("shipping");
  });
  test("slugHyphen has hyphens", () => {
    const n = normalize("Pacific Basin Shipping");
    expect(n.slugHyphen).toMatch(/pacific-basin/);
  });
  test("tokens are correct", () => {
    const n = normalize("Pacific Basin Shipping Ltd");
    expect(n.tokens).toContain("pacific");
    expect(n.tokens).toContain("basin");
    expect(n.tokens).not.toContain("ltd");
  });
});

describe("Normalizer — candidateDomains", () => {
  test("returns non-empty array", () => expect(candidateDomains("Pacific Shipping").length).toBeGreaterThan(0));
  test("includes .com TLD",       () => expect(candidateDomains("Pacific Shipping").some(d => d.endsWith(".com"))).toBe(true));
  test("no blacklisted domains",  () => expect(candidateDomains("Pacific Shipping").every(d => !d.includes("google") && !d.includes("bing"))).toBe(true));
  test("no domain over 63 chars", () => expect(candidateDomains("Pacific Shipping").every(d => d.length < 64)).toBe(true));
  test("empty input → []",        () => expect(candidateDomains("")).toEqual([]));
  test("null input → []",         () => expect(candidateDomains(null)).toEqual([]));
});

describe("Normalizer — deduplicateCompanies", () => {
  test("deduplicates same normalized name", () => {
    const result = deduplicateCompanies([
      { name: "Pacific Shipping Pte Ltd" },
      { name: "Pacific Shipping Limited" },
    ]);
    expect(result.length).toBe(1);
  });
  test("keeps different companies", () => {
    const result = deduplicateCompanies([
      { name: "Pacific Shipping Ltd" },
      { name: "Atlantic Shipping Ltd" },
    ]);
    expect(result.length).toBe(2);
  });
  test("empty list → []", () => expect(deduplicateCompanies([])).toEqual([]));
  test("removes entries with no name", () => {
    const result = deduplicateCompanies([{ name: "" }, { name: "Maersk" }]);
    expect(result.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL ENGINE
// ─────────────────────────────────────────────────────────────────────────────
describe("EmailEngine — syntax validation", () => {
  test("valid email",          () => expect(isValidSyntax("ops@pacificshipping.com")).toBe(true));
  test("valid subdomain",      () => expect(isValidSyntax("info@sg.company.com")).toBe(true));
  test("rejects no @",         () => expect(isValidSyntax("notanemail")).toBe(false));
  test("rejects no dot",       () => expect(isValidSyntax("user@nodot")).toBe(false));
  test("rejects empty",        () => expect(isValidSyntax("")).toBe(false));
  test("rejects null",         () => expect(isValidSyntax(null)).toBe(false));
  test("rejects too long",     () => expect(isValidSyntax("a".repeat(250) + "@x.com")).toBe(false));
});

describe("EmailEngine — disposable domain check", () => {
  test("mailinator is disposable",   () => expect(isDisposable("mailinator.com")).toBe(true));
  test("yopmail is disposable",      () => expect(isDisposable("yopmail.com")).toBe(true));
  test("maersk.com is NOT disposable", () => expect(isDisposable("maersk.com")).toBe(false));
  test("custom domain not disposable", () => expect(isDisposable("pacificshipping.com")).toBe(false));
});

describe("EmailEngine — generateEmails", () => {
  test("returns non-empty list",    () => expect(generateEmails("maersk.com").length).toBeGreaterThan(0));
  test("all have correct domain",   () => expect(generateEmails("maersk.com").every(e => e.email.endsWith("@maersk.com"))).toBe(true));
  test("all have confidence > 0",   () => expect(generateEmails("maersk.com").every(e => e.confidence > 0)).toBe(true));
  test("all have source field",     () => expect(generateEmails("maersk.com").every(e => !!e.source)).toBe(true));
  test("empty domain → []",         () => expect(generateEmails("")).toEqual([]));
  test("null domain → []",          () => expect(generateEmails(null)).toEqual([]));
  test("contains ops@ prefix",      () => expect(generateEmails("x.com").some(e => e.email.startsWith("ops@"))).toBe(true));
  test("contains chartering@ prefix", () => expect(generateEmails("x.com").some(e => e.email.startsWith("chartering@"))).toBe(true));
  test("contains info@ prefix",     () => expect(generateEmails("x.com").some(e => e.email.startsWith("info@"))).toBe(true));
});

describe("EmailEngine — inferPersonEmails", () => {
  test("generates john.smith pattern", () => {
    expect(inferPersonEmails("John","Smith","x.com").some(e => e.email === "john.smith@x.com")).toBe(true);
  });
  test("generates jsmith pattern",     () => {
    expect(inferPersonEmails("John","Smith","x.com").some(e => e.email === "jsmith@x.com")).toBe(true);
  });
  test("generates johnsmith pattern",  () => {
    expect(inferPersonEmails("John","Smith","x.com").some(e => e.email === "johnsmith@x.com")).toBe(true);
  });
  test("lowercases output",            () => {
    inferPersonEmails("JOHN","SMITH","X.COM").forEach(e => expect(e.email).toBe(e.email.toLowerCase()));
  });
  test("empty first name → []",  () => expect(inferPersonEmails("","Smith","x.com")).toEqual([]));
  test("empty last name → []",   () => expect(inferPersonEmails("John","","x.com")).toEqual([]));
  test("empty domain → []",      () => expect(inferPersonEmails("John","Smith","")).toEqual([]));
});

describe("EmailEngine — rankEmails", () => {
  test("sorts descending by confidence", () => {
    const ranked = rankEmails([
      { email: "a@x.com", confidence: 50 },
      { email: "b@x.com", confidence: 90 },
      { email: "c@x.com", confidence: 70 },
    ]);
    expect(ranked.map(e => e.confidence)).toEqual([90, 70, 50]);
  });
  test("deduplicates case-insensitively", () => {
    const ranked = rankEmails([
      { email: "ops@x.com", confidence: 80 },
      { email: "OPS@X.COM", confidence: 60 },
    ]);
    expect(ranked.length).toBe(1);
    expect(ranked[0].confidence).toBe(80);
  });
  test("empty list → []", () => expect(rankEmails([])).toEqual([]));
  test("filters null emails", () => {
    const ranked = rankEmails([{ email: null, confidence: 80 }, { email: "a@x.com", confidence: 50 }]);
    expect(ranked.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENCE SCORER
// ─────────────────────────────────────────────────────────────────────────────
describe("ConfidenceScorer — scoreEmail", () => {
  const make = (overrides) => ({
    email: "info@co.com", confidence: 50, source: "pattern_generated", smtp_valid: null, ...overrides,
  });

  test("website_mailto adds +40", () => {
    const s = scoreEmail(make({ source: "website_mailto" }), "co.com", [], 90);
    expect(s.confidence).toBeGreaterThanOrEqual(90);
  });
  test("smtp_valid:true adds +30", () => {
    const s = scoreEmail(make({ smtp_valid: true }), "co.com", [], 90);
    expect(s.confidence).toBeGreaterThanOrEqual(80);
  });
  test("maritime role adds +5", () => {
    const s = scoreEmail(make({ email: "ops@co.com", source: "website_mailto" }), "co.com", [], 90);
    expect(s.confidence).toBeGreaterThanOrEqual(95);
  });
  test("confidence capped at 99", () => {
    const s = scoreEmail(make({ source: "website_mailto", smtp_valid: true }), "co.com", [], 100);
    expect(s.confidence).toBeLessThanOrEqual(99);
  });
  test("score is rounded integer", () => {
    const s = scoreEmail(make({ source: "website_mailto" }), "co.com", [], 90);
    expect(Number.isInteger(s.confidence)).toBe(true);
  });
});

describe("ConfidenceScorer — applyConfidenceScoring", () => {
  test("filters emails below threshold (30 conf, no bonus)", () => {
    const result = applyConfidenceScoring(
      [{ email: "x@co.com", confidence: 30, source: "pattern_generated", smtp_valid: null }],
      "co.com", [], 50
    );
    expect(result.length).toBe(0);
  });
  test("passes emails that reach threshold via website bonus", () => {
    const result = applyConfidenceScoring(
      [{ email: "info@co.com", confidence: 50, source: "website_mailto", smtp_valid: null }],
      "co.com", [], 90
    );
    expect(result.length).toBe(1);
  });
  test("result is sorted descending by confidence", () => {
    const result = applyConfidenceScoring([
      { email: "a@co.com", confidence: 50, source: "website_mailto", smtp_valid: null },
      { email: "b@co.com", confidence: 50, source: "website_mailto", smtp_valid: true },
    ], "co.com", [], 90);
    if (result.length > 1) {
      expect(result[0].confidence).toBeGreaterThanOrEqual(result[1].confidence);
    }
  });
});

describe("ConfidenceScorer — methodConfidence", () => {
  test("known_table → 98",                  () => expect(methodConfidence("known_table")).toBe(98));
  test("search+content_validated → 90",     () => expect(methodConfidence("search+content_validated")).toBe(90));
  test("heuristic+content_validated → 75",  () => expect(methodConfidence("heuristic+content_validated")).toBe(75));
  test("search+dns → 65",                   () => expect(methodConfidence("search+dns")).toBe(65));
  test("unresolved → 0",                    () => expect(methodConfidence("unresolved")).toBe(0));
  test("unknown → 50 (default)",            () => expect(methodConfidence("unknown_method")).toBe(50));
});