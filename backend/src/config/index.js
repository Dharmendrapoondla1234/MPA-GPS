// src/config/index.js — centralised config for the intelligence pipeline
"use strict";

module.exports = {
  // ── Pipeline ──────────────────────────────────────────────────────────────
  PIPELINE_CACHE_TTL_MS : 6 * 60 * 60 * 1000,   // 6 hours
  MIN_CONFIDENCE        : 70,                     // threshold to accept a contact
  MAX_EMAILS_PER_CO     : 10,
  CRAWL_DELAY_MS        : 400,                    // polite delay between companies
  HTTP_TIMEOUT_MS       : 12_000,
  SMTP_TIMEOUT_MS       : 7_000,

  // ── Equasis ───────────────────────────────────────────────────────────────
  EQUASIS_BASE        : "https://www.equasis.org/EquasisWeb",
  EQUASIS_SESSION_TTL : 20 * 60 * 1000,           // 20 min (server kills at 30)
  EQUASIS_KEEPALIVE_MS: 15 * 60 * 1000,

  // ── Confidence scoring weights ────────────────────────────────────────────
  CONFIDENCE_WEIGHTS: {
    officialWebsite : 40,
    smtpValidated   : 30,
    domainMatch     : 20,
    multiSource     : 10,
    maritimeRole    :  5,
  },

  // ── Domain blacklist ──────────────────────────────────────────────────────
  DOMAIN_BLACKLIST: new Set([
    "duckduckgo.com","bing.com","google.com","yahoo.com","wikipedia.org",
    "linkedin.com","facebook.com","twitter.com","bloomberg.com","reuters.com",
    "dnb.com","kompass.com","zoominfo.com","crunchbase.com",
    "companies-house.gov.uk","opencorporates.com",
    "marinetraffic.com","vesselfinder.com","fleetmon.com","equasis.org",
    "glassdoor.com","indeed.com","yellowpages.com","alibaba.com","manta.com",
  ]),

  BLACKLIST_ROOTS: [
    "bing.com","google.com","gstatic.com","microsoft.com",
    "duckduckgo.com","yahoo.com","baidu.com","yandex.com",
  ],

  // ── Known shipping company domains ───────────────────────────────────────
  KNOWN_DOMAINS: {
    "MAERSK"            : "maersk.com",
    "MSC"               : "msc.com",
    "CMA CGM"           : "cmacgm.com",
    "HAPAG-LLOYD"       : "hapag-lloyd.com",
    "EVERGREEN"         : "evergreen-marine.com",
    "COSCO"             : "cosco.com",
    "YANG MING"         : "yangming.com",
    "HMM"               : "hmm21.com",
    "PIL"               : "pilship.com",
    "PACIFIC BASIN"     : "pacificbasin.com",
    "TEEKAY"            : "teekay.com",
    "FRONTLINE"         : "frontline.bm",
    "EURONAV"           : "euronav.com",
    "TORM"              : "torm.com",
    "NORDEN"            : "ds-norden.com",
    "SCORPIO"           : "scorpiotankers.com",
    "ARDMORE"           : "ardmoreshipping.com",
    "DHT"               : "dhtankers.com",
    "NORDIC AMERICAN"   : "nat.bm",
    "STENA"             : "stena.com",
    "BW GROUP"          : "bwgroup.com",
    "GOLAR"             : "golar.com",
    "DANAOS"            : "danaos.com",
    "COSTAMARE"         : "costamare.com",
    "SEASPAN"           : "seaspancorp.com",
    "NAVIOS"            : "navios-maritime.com",
    "DIANA SHIPPING"    : "dianashipping.gr",
    "TSAKOS"            : "tng.gr",
    "THENAMARIS"        : "thenamaris.com",
    "MARAN"             : "maran.gr",
    "ZODIAC"            : "zodiacmaritime.com",
    "V.GROUP"           : "vgroup.com",
    "V GROUP"           : "vgroup.com",
    "COLUMBIA"          : "columbia-shipmanagement.com",
    "FLEET MANAGEMENT"  : "fleetship.com",
    "BERNHARD SCHULTE"  : "bs-shipmanagement.com",
    "EXECUTIVE SHIP"    : "executiveship.com",
    "WILHELMSEN"        : "wilhelmsen.com",
    "GAC"               : "gac.com",
    "INCHCAPE"          : "iss-shipping.com",
    "ISS SHIPPING"      : "iss-shipping.com",
    "HAFNIA"            : "hafniabw.com",
    "GOLDEN OCEAN"      : "goldenocean.no",
  },

  // ── Legal suffixes (longest first for correct stripping) ─────────────────
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

  // ── Generic industry words — strip from domain slug only ─────────────────
  DOMAIN_STRIP: [
    "shipping","maritime","marine","navigation","navigazione",
    "management","mgmt","services","service","solutions",
    "international","intl","group","holdings","enterprises",
    "trading","logistics","transport","agency",
  ],

  // ── Maritime role email prefixes (priority order) ─────────────────────────
  EMAIL_PREFIXES: [
    "info","contact","operations","ops","chartering","charter",
    "commercial","sales","admin","general","enquiries","enquiry",
    "mail","office","technical","tech","crewing","crew",
    "accounts","finance","agency","singapore","sg",
    "management","mgmt","fleet","voyages","trading",
  ],

  MARITIME_ROLE_PREFIXES: new Set([
    "operations","ops","chartering","charter","commercial","crewing","fleet",
  ]),

  // ── Crawl paths (priority order) ─────────────────────────────────────────
  CRAWL_PATHS: [
    "/contact","/contact-us","/contacts","/contact.html","/contact-us.html",
    "/en/contact","/en/contact-us","/en/contacts",
    "/about/contact","/about-us/contact","/our-offices","/offices",
    "/global-offices","/locations","/office",
    "/about","/about-us","/company/contact",
    "/",
  ],

  // ── Email blacklist patterns ──────────────────────────────────────────────
  EMAIL_BLACKLIST_RE: /example|yourdomain|sentry|noreply|no-reply|unsubscribe|webmaster@|postmaster@|abuse@|\.png|\.jpg|\.gif|@2x|@3x|wix|cdn/i,

  // ── Disposable email domains ──────────────────────────────────────────────
  DISPOSABLE_DOMAINS: new Set([
    "mailinator.com","guerrillamail.com","temp-mail.org","throwam.com",
    "fakeinbox.com","yopmail.com","maildrop.cc","trashmail.com",
  ]),

  // ── HTTP user-agent ───────────────────────────────────────────────────────
  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};