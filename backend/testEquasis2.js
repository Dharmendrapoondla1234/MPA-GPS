// testEquasis2.js — finds correct Equasis POST form fields
require("dotenv").config();

(async () => {
  const IMO = 9487081;

  // Login
  const p = await fetch("https://www.equasis.org/EquasisWeb/public/HomePage", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  const pc = p.headers.getSetCookie
    ? p.headers.getSetCookie().join("; ")
    : (p.headers.get("set-cookie") || "");

  const l = await fetch("https://www.equasis.org/EquasisWeb/authen/HomePage?fs=Search", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: pc,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://www.equasis.org/EquasisWeb/public/HomePage",
      Accept: "text/html,application/xhtml+xml",
    },
    body: new URLSearchParams({ j_email: process.env.EQUASIS_EMAIL, j_password: process.env.EQUASIS_PASSWORD, submit: "Login" }),
    redirect: "follow",
  });
  const lc = l.headers.getSetCookie ? l.headers.getSetCookie().join("; ") : (l.headers.get("set-cookie") || "");
  const allCookies = [pc, lc].filter(Boolean).join("; ");
  console.log("Logged in:", l.status);

  // Get the search page HTML to find form fields
  const searchPage = await fetch("https://www.equasis.org/EquasisWeb/authen/HomePage?fs=ByShip", {
    headers: {
      Cookie: allCookies,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: l.url,
    },
  });
  const searchHtml = await searchPage.text();

  // Extract all form fields and actions
  console.log("\n--- Forms found ---");
  const formRe = /<form[^>]*action=["']([^"']*)["'][^>]*>([\s\S]*?)<\/form>/gi;
  let fm;
  while ((fm = formRe.exec(searchHtml)) !== null) {
    console.log("Form action:", fm[1]);
    const inputs = [];
    const inputRe = /<input[^>]*name=["']([^"']*)["'][^>]*(?:value=["']([^"']*)["'])?/gi;
    let im;
    while ((im = inputRe.exec(fm[2])) !== null) inputs.push(`${im[1]}=${im[2]||""}`);
    console.log("Fields:", inputs.join(", "));
  }

  // Try submitting IMO search with various field names
  console.log("\n--- Trying IMO search with different field names ---");
  const attempts = [
    { P_IMO: IMO },
    { p_imo: IMO },
    { imo: IMO },
    { P_IMO: IMO, P_ENTITY_TYPE: "S" },
    { P_IMO: IMO, submit: "Search" },
    { P_IMO: IMO, P_SEARCH_TYPE: "S" },
    { P_IMO: IMO, fs: "ByShip" },
  ];

  for (const body of attempts) {
    const r = await fetch("https://www.equasis.org/EquasisWeb/authen/ShipInfo", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: allCookies,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://www.equasis.org/EquasisWeb/authen/HomePage?fs=ByShip",
      },
      body: new URLSearchParams(body),
    });
    const text = await r.text();
    const hasShipData = text.includes("Registered owner") || text.includes("IMO number") || text.includes("9487081");
    console.log(`POST ShipInfo ${r.status} fields=${JSON.stringify(body)} hasData=${hasShipData}`);
    if (hasShipData) {
      console.log("SUCCESS! Content:", text.replace(/<[^>]+>/g," ").replace(/\s+/g," ").slice(0,400));
      break;
    }
  }
})().catch(console.error);