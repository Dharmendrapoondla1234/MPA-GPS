// backend/src/routes/gis_route.js — with HTTP caching headers
// GIS data changes very rarely (weekly at most). Cache aggressively.
const express = require("express");
const router  = express.Router();
const {
  getAllGISLayers, getDangers, getDepths, getRegulatedAreas,
  getTracks, getAidsToNavigation, getSeabed, getPortsAndServices,
  getTides, getCulturalFeatures
} = require("../services/gis");

// GIS data is static — cache for 1 hour in browser, 24h on CDN
const GIS_CACHE = "public, max-age=3600, s-maxage=86400";

function sendGIS(res, data) {
  res.set("Cache-Control", GIS_CACHE);
  res.set("ETag", `W/"gis-${Date.now() - (Date.now() % 3600000)}"`); // changes once/hour
  res.json({ success: true, data });
}

router.get("/all", async (req, res, next) => {
  try {
    // Check browser cache — if ETag matches, send 304
    const etag = `W/"gis-all-${Date.now() - (Date.now() % 3600000)}"`;
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    res.set("ETag", etag);
    res.set("Cache-Control", GIS_CACHE);
    const data = await getAllGISLayers();
    res.json({ success: true, data });
  } catch(e) { next(e); }
});

router.get("/dangers",   async (req, res, next) => { try { sendGIS(res, await getDangers());          } catch(e){ next(e); } });
router.get("/depths",    async (req, res, next) => { try { sendGIS(res, await getDepths());           } catch(e){ next(e); } });
router.get("/regulated", async (req, res, next) => { try { sendGIS(res, await getRegulatedAreas());  } catch(e){ next(e); } });
router.get("/tracks",    async (req, res, next) => { try { sendGIS(res, await getTracks());           } catch(e){ next(e); } });
router.get("/aids",      async (req, res, next) => { try { sendGIS(res, await getAidsToNavigation());} catch(e){ next(e); } });
router.get("/seabed",    async (req, res, next) => { try { sendGIS(res, await getSeabed());           } catch(e){ next(e); } });
router.get("/ports",     async (req, res, next) => { try { sendGIS(res, await getPortsAndServices()); } catch(e){ next(e); } });
router.get("/tides",     async (req, res, next) => { try { sendGIS(res, await getTides());            } catch(e){ next(e); } });
router.get("/cultural",  async (req, res, next) => { try { sendGIS(res, await getCulturalFeatures()); } catch(e){ next(e); } });

module.exports = router;