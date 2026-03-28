// testEquasis.js — finds correct Equasis ship URL
require("dotenv").config();

(async () => {
  const IMO = 9487081;

  // Step 1: get page cookies
  const p = await fetch("https://www.equasis.org/EquasisWeb/public/HomePage", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  const pc = p.headers.getSetCookie
    ? p.headers.getSetCookie().join("; ")
    : (p.headers.get("set-cookie") || "");
  console.log("Page status:", p.status);

  // Step 2: login
  const l = await fetch("https://www.equasis.org/EquasisWeb/authen/HomePage?fs=Search", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: pc,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://www.equasis.org/EquasisWeb/public/HomePage",
      Accept: "text/html,application/xhtml+xml",
    },
    body: new URLSearchParams({
      j_email: process.env.EQUASIS_EMAIL,
      j_password: process.env.EQUASIS_PASSWORD,
      submit: "Login",
    }),
    redirect: "follow",
  });

  const lc = l.headers.getSetCookie
    ? l.headers.getSetCookie().join("; ")
    : (l.headers.get("set-cookie") || "");
  const allCookies = [pc, lc].filter(Boolean).join("; ");

  console.log("Login status:", l.status);
  console.log("Final URL:", l.url);

  const body = await l.text();
  const loggedIn = body.toLowerCase().includes("welcome") || body.toLowerCase().includes("logout");
  console.log("Logged in:", loggedIn);

  // Step 3: find all ship-related links in the page
  const links = [];
  const re = /href=["']([^"']*Ship[^"']*)["']/gi;
  let m;
  while ((m = re.exec(body)) !== null) links.push(m[1]);
  console.log("\nShip links found:");
  [...new Set(links)].slice(0, 20).forEach(h => console.log(" ", h));

  // Step 4: try POST search for ship by IMO (Equasis uses POST forms)
  console.log("\n--- Trying POST search ---");
  const searchUrls = [
    "https://www.equasis.org/EquasisWeb/authen/HomePage?fs=ByShip",
    "https://www.equasis.org/EquasisWeb/authen/HomePage?fs=Search",
    "https://www.equasis.org/EquasisWeb/authen/ShipSearch",
  ];

  for (const url of searchUrls) {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: allCookies,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: l.url,
        Accept: "text/html,application/xhtml+xml",
      },
      body: new URLSearchParams({ P_IMO: IMO, P_SEARCH_TYPE: "IMO", submit: "Search" }),
    });
    console.log(`POST ${r.status} -> ${url}`);
    if (r.status === 200) {
      const html = await r.text();
      const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      console.log("Content:", text.slice(0, 600));
      break;
    }
  }
})().catch(console.error);