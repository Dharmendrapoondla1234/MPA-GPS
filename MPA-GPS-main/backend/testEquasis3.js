// testEquasis3.js — tests restricted/Search endpoint
require("dotenv").config();

(async () => {
  const IMO = 9487081;

  // Login
  const p = await fetch("https://www.equasis.org/EquasisWeb/public/HomePage", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  const pc = p.headers.getSetCookie ? p.headers.getSetCookie().join("; ") : (p.headers.get("set-cookie") || "");

  const l = await fetch("https://www.equasis.org/EquasisWeb/authen/HomePage?fs=Search", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: pc,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://www.equasis.org/EquasisWeb/public/HomePage",
    },
    body: new URLSearchParams({ j_email: process.env.EQUASIS_EMAIL, j_password: process.env.EQUASIS_PASSWORD, submit: "Login" }),
    redirect: "follow",
  });
  const lc = l.headers.getSetCookie ? l.headers.getSetCookie().join("; ") : (l.headers.get("set-cookie") || "");
  const allCookies = [pc, lc].filter(Boolean).join("; ");
  console.log("Logged in:", l.status, "url:", l.url);

  const BASE = "https://www.equasis.org/EquasisWeb";
  const hdrs = {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: allCookies,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Referer: `${BASE}/authen/HomePage?fs=Search`,
    Accept: "text/html,application/xhtml+xml",
  };

  // Try the restricted/Search endpoint with IMO in P_ENTREE_HOME
  const attempts = [
    { url: `${BASE}/restricted/Search?fs=HomePage`,       body: { P_ENTREE_HOME: IMO, checkbox_ship: "on", P_PAGE_SHIP: 1 } },
    { url: `${BASE}/restricted/Search?fs=HomePage`,       body: { P_ENTREE_HOME: IMO, P_ENTREE_HOME_HIDDEN: IMO } },
    { url: `${BASE}/restricted/Search?fs=HomePage`,       body: { P_ENTREE_HOME: IMO } },
    { url: `${BASE}/restricted/Search`,                   body: { P_ENTREE_HOME: IMO, checkbox_ship: "on" } },
    { url: `${BASE}/authen/Search?fs=ByShip`,             body: { P_IMO: IMO } },
    { url: `${BASE}/authen/ShipInfo?fs=ByShip`,           body: { P_IMO: IMO } },
    // Try GET with IMO directly
  ];

  for (const attempt of attempts) {
    const r = await fetch(attempt.url, {
      method: "POST",
      headers: hdrs,
      body: new URLSearchParams(attempt.body),
      redirect: "follow",
    });
    const html = await r.text();
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const hasData = text.includes("Registered owner") || text.includes("9487081") || text.includes("CORAL") || text.includes("ISM Manager");
    console.log(`${r.status} ${attempt.url.split("Web/")[1]} body=${JSON.stringify(attempt.body)} hasData=${hasData} finalUrl=${r.url}`);
    if (hasData) {
      console.log("\nSUCCESS! Content:\n", text.slice(0, 800));
      break;
    }
  }

  // Also try GET requests
  console.log("\n--- GET attempts ---");
  const getUrls = [
    `${BASE}/restricted/Search?fs=ByShip&P_IMO=${IMO}`,
    `${BASE}/restricted/ShipInfo?fs=ByShip&P_IMO=${IMO}`,
    `${BASE}/authen/restricted/ShipInfo?P_IMO=${IMO}`,
  ];
  for (const url of getUrls) {
    const r = await fetch(url, { headers: { ...hdrs, "Content-Type": undefined }, redirect: "follow" });
    const html = await r.text();
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const hasData = text.includes("Registered owner") || text.includes("9487081") || text.includes("CORAL");
    console.log(`GET ${r.status} ${url.split("Web/")[1]} hasData=${hasData} finalUrl=${r.url}`);
    if (hasData) { console.log("Content:", text.slice(0, 600)); break; }
  }
})().catch(console.error);