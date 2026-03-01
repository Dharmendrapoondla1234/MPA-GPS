// check-clock.js
// Run: node check-clock.js
// Checks if your system clock is causing the JWT error

const https = require("https");

console.log("\n🕐 CHECKING SYSTEM CLOCK...\n");

const localTime = new Date();
console.log("Your PC time:  ", localTime.toISOString());

// Fetch real time from Google's servers
https
  .get(
    "https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=test",
    (res) => {
      const googleDate = res.headers["date"];
      if (googleDate) {
        const googleTime = new Date(googleDate);
        const localTime2 = new Date();
        const diffSeconds = Math.abs((localTime2 - googleTime) / 1000);

        console.log("Google time:   ", googleTime.toISOString());
        console.log("Difference:    ", diffSeconds.toFixed(1), "seconds");
        console.log("");

        if (diffSeconds > 30) {
          console.log(
            "❌ CLOCK IS OUT OF SYNC BY",
            diffSeconds.toFixed(0),
            "SECONDS!",
          );
          console.log("   This is causing the JWT Invalid Signature error.");
          console.log("");
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          console.log("  FIX: Run these commands in CMD as Administrator:");
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          console.log("");
          console.log("  net stop w32tm");
          console.log("  net start w32tm");
          console.log("  w32tm /resync /force");
          console.log("");
          console.log("  OR go to:");
          console.log("  Settings → Time & Language → Date & Time");
          console.log("  → Turn ON 'Set time automatically'");
          console.log("  → Click 'Sync now'");
        } else {
          console.log(
            "✅ Clock is fine (",
            diffSeconds.toFixed(1),
            "sec difference)",
          );
          console.log("");
          console.log("Clock is NOT the issue. The service account key itself");
          console.log("may have been disabled in Google Cloud Console.");
          console.log("");
          console.log("→ Check: console.cloud.google.com");
          console.log("→ IAM & Admin → Service Accounts");
          console.log("→ Is the service account ENABLED (not disabled)?");
          console.log("→ Does it have BigQuery roles assigned?");
        }
      }
      res.resume();
    },
  )
  .on("error", () => {
    console.log("Could not reach Google. Check your internet connection.");
  });
