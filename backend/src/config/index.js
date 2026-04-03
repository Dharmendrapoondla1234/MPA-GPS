// src/config/index.js — v2 (Enhanced accuracy + coverage)
"use strict";

module.exports = {
  PIPELINE_CACHE_TTL_MS : 6 * 60 * 60 * 1000,
  MIN_CONFIDENCE        : 65,       // lowered from 70 — catches more valid emails
  MAX_EMAILS_PER_CO     : 12,       // increased from 10
  CRAWL_DELAY_MS        : 300,
  HTTP_TIMEOUT_MS       : 14_000,   // increased for slow maritime sites
  SMTP_TIMEOUT_MS       : 8_000,

  EQUASIS_BASE        : "https://www.equasis.org/EquasisWeb",
  EQUASIS_SESSION_TTL : 20 * 60 * 1000,
  EQUASIS_KEEPALIVE_MS: 15 * 60 * 1000,

  CONFIDENCE_WEIGHTS: {
    officialWebsite : 45,   // was 40
    smtpValidated   : 35,   // was 30
    domainMatch     : 15,   // was 20
    multiSource     :  8,
    maritimeRole    :  7,   // was 5
    nameInferred    : 12,   // NEW
    linkedinMatch   : 10,   // NEW
    pdfExtracted    :  6,   // NEW
  },

  DOMAIN_BLACKLIST: new Set([
    "duckduckgo.com","bing.com","google.com","yahoo.com","wikipedia.org",
    "linkedin.com","facebook.com","twitter.com","bloomberg.com","reuters.com",
    "dnb.com","kompass.com","zoominfo.com","crunchbase.com",
    "companies-house.gov.uk","opencorporates.com",
    "marinetraffic.com","vesselfinder.com","fleetmon.com","equasis.org",
    "glassdoor.com","indeed.com","yellowpages.com","alibaba.com","manta.com",
    "bizfile.gov.sg","acra.gov.sg","corporationwiki.com","bizapedia.com",
    "tradewindsnews.com","lloydslist.com","hellenicshippingnews.com",
    "splash247.com","worldmaritimenews.com","theloadstar.com",
  ]),

  BLACKLIST_ROOTS: [
    "bing.com","google.com","gstatic.com","microsoft.com",
    "duckduckgo.com","yahoo.com","baidu.com","yandex.com",
    "cloudflare.com","amazonaws.com",
  ],

  KNOWN_DOMAINS: {
    // Container lines
    "MAERSK":"maersk.com","MSC":"msc.com","CMA CGM":"cmacgm.com",
    "HAPAG-LLOYD":"hapag-lloyd.com","HAPAG LLOYD":"hapag-lloyd.com",
    "EVERGREEN":"evergreen-marine.com","COSCO":"cosco.com",
    "YANG MING":"yangming.com","HMM":"hmm21.com",
    "ONE LINE":"one-line.com","OCEAN NETWORK EXPRESS":"one-line.com",
    "ZIM":"zim.com","PIL":"pilship.com",
    "PACIFIC INTERNATIONAL LINE":"pilship.com",
    // Tankers
    "TEEKAY":"teekay.com","FRONTLINE":"frontline.bm",
    "EURONAV":"euronav.com","TORM":"torm.com","NORDEN":"ds-norden.com",
    "SCORPIO":"scorpiotankers.com","ARDMORE":"ardmoreshipping.com",
    "DHT":"dhtankers.com","NORDIC AMERICAN":"nat.bm","HAFNIA":"hafniabw.com",
    "GOLDEN OCEAN":"goldenocean.no","DORIAN LPG":"dorianlpg.com",
    "NAVIGATOR GAS":"navigatorgas.com","STOLT-NIELSEN":"stolt-nielsen.com",
    "STOLT NIELSEN":"stolt-nielsen.com","ODFJELL":"odfjell.com",
    "AET TANKERS":"aet.com.my","AET":"aet.com.my",
    "OVERSEAS SHIPHOLDING":"osg.com","OSG":"osg.com",
    "INTERNATIONAL SEAWAYS":"intlsws.com",
    // Dry bulk
    "PACIFIC BASIN":"pacificbasin.com","SAFE BULKERS":"safebulkers.com",
    "STAR BULK":"starbulk.com","DIANA SHIPPING":"dianashipping.gr",
    "TSAKOS":"tng.gr","NAVIOS":"navios-maritime.com","DANAOS":"danaos.com",
    "COSTAMARE":"costamare.com","SEASPAN":"seaspancorp.com",
    // Misc shipping
    "STENA":"stena.com","BW GROUP":"bwgroup.com","GOLAR":"golar.com",
    "THENAMARIS":"thenamaris.com","MARAN":"maran.gr",
    "ZODIAC":"zodiacmaritime.com",
    // Ship managers
    "V.GROUP":"vgroup.com","V GROUP":"vgroup.com",
    "COLUMBIA":"columbia-shipmanagement.com",
    "FLEET MANAGEMENT":"fleetship.com",
    "BERNHARD SCHULTE":"bs-shipmanagement.com","BSM":"bs-shipmanagement.com",
    "EXECUTIVE SHIP":"executiveship.com","WILHELMSEN":"wilhelmsen.com",
    "THOME SHIP":"thome-group.com","THOME GROUP":"thome-group.com",
    "ANGLO-EASTERN":"angloeastern.com","ANGLO EASTERN":"angloeastern.com",
    "SYNERGY MARINE":"synergymarine.com","SYNERGY":"synergymarine.com",
    "WALLEM":"wallem.com","TECHNOMAR":"technomar.gr",
    "NYK LINE":"nyk.com","NYK":"nyk.com","MOL":"mol.co.jp",
    "MITSUI OSK":"mol.co.jp","K LINE":"kline.co.jp",
    "KAWASAKI KISEN":"kline.co.jp",
    // Agents & logistics
    "GAC":"gac.com","INCHCAPE":"iss-shipping.com","ISS SHIPPING":"iss-shipping.com",
    "SVITZER":"svitzer.com","ICTSI":"ictsi.com",
  },

  LEGAL_SUFFIXES: [
    "private limited","pte. ltd.","pte ltd","pvt. ltd.","pvt ltd",
    "sdn. bhd.","sdn bhd","co. ltd.","co ltd","l.l.c.","l.l.c",
    "incorporated","corporation","co-operative","cooperative",
    "limited liability company","limited partnership",
    "limited","ltd.","ltd","llc","inc.","inc","corp.","corp",
    "gmbh & co. kg","gmbh & co kg","gmbh","b.v.","bv","n.v.","nv",
    "s.a.s.","s.a.s","s.a.","s.p.a.","spa","s.r.l.","srl",
    "plc","pty. ltd.","pty ltd","ag","kg","oy","ab","as","a/s",
    "a.s.","s.c.","k.g.",
  ],

  DOMAIN_STRIP: [
    "shipping","maritime","marine","navigation","navigazione",
    "management","mgmt","services","service","solutions",
    "international","intl","group","holdings","enterprises",
    "trading","logistics","transport","agency",
  ],

  EMAIL_PREFIXES: [
    "info","contact","operations","ops","chartering","charter",
    "commercial","sales","admin","general","enquiries","enquiry",
    "mail","office","technical","tech","crewing","crew",
    "accounts","finance","agency","singapore","sg",
    "management","mgmt","fleet","voyages","trading",
    // NEW additions for better coverage
    "hello","support","reception","bookings","cargo","freight",
    "dispatch","port","portops","vessel","tanker","bulk",
    "marine","maritime","shipping","logistics","compliance",
    "hse","safety","dpa","sire","vetting","greece","athens",
    "cyprus","hongkong","hk","uk","london","norway","oslo",
    "denmark","germany","uae","dubai",
  ],

  MARITIME_ROLE_PREFIXES: new Set([
    "operations","ops","chartering","charter","commercial","crewing","fleet",
    "dpa","vetting","hse","safety","sire","compliance",
    "cargo","freight","vessel","tanker","bulk","port",
  ]),

  CRAWL_PATHS: [
    "/contact","/contact-us","/contacts","/contact.html","/contact-us.html",
    "/en/contact","/en/contact-us","/en/contacts",
    "/about/contact","/about-us/contact","/our-offices","/offices",
    "/global-offices","/locations","/office",
    "/about","/about-us","/company/contact",
    // NEW additions
    "/reach-us","/get-in-touch","/contact-form",
    "/offices-worldwide","/worldwide-offices","/our-locations",
    "/contact-information","/contactus",
    "/en/about/contact","/en/about-us",
    "/sitemap.xml",
    "/",
  ],

  EMAIL_BLACKLIST_RE: /example|yourdomain|sentry|noreply|no-reply|unsubscribe|webmaster@|postmaster@|abuse@|privacy@|legal@|\.png|\.jpg|\.gif|@2x|@3x|wix|cdn|placeholder|test@|demo@/i,

  DISPOSABLE_DOMAINS: new Set([
    "mailinator.com","guerrillamail.com","temp-mail.org","throwam.com",
    "fakeinbox.com","yopmail.com","maildrop.cc","trashmail.com",
    "10minutemail.com","throwaway.email","dispostable.com",
  ]),

  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",

  USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  ],
};
