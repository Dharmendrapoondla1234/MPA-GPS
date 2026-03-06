// backend/src/routes/gis.js
// Add to server.js:  app.use("/api/gis", require("./routes/gis"));

const express = require("express");
const router  = express.Router();
const {
  getAllGISLayers, getDangers, getDepths, getRegulatedAreas,
  getTracks, getAidsToNavigation, getSeabed, getPortsAndServices,
  getTides, getCulturalFeatures
} = require("../services/gis");

// GET /api/gis/all  — full payload, cached
router.get("/all", async (req, res, next) => {
  try {
    const data = await getAllGISLayers();
    res.json({ success: true, data });
  } catch(e) { next(e); }
});

// Individual layers (for lazy loading)
router.get("/dangers",  async (req, res, next) => { try { res.json({ success:true, data: await getDangers() }); } catch(e){ next(e); } });
router.get("/depths",   async (req, res, next) => { try { res.json({ success:true, data: await getDepths() }); }  catch(e){ next(e); } });
router.get("/regulated",async (req, res, next) => { try { res.json({ success:true, data: await getRegulatedAreas() }); } catch(e){ next(e); } });
router.get("/tracks",   async (req, res, next) => { try { res.json({ success:true, data: await getTracks() }); } catch(e){ next(e); } });
router.get("/aids",     async (req, res, next) => { try { res.json({ success:true, data: await getAidsToNavigation() }); } catch(e){ next(e); } });
router.get("/seabed",   async (req, res, next) => { try { res.json({ success:true, data: await getSeabed() }); } catch(e){ next(e); } });
router.get("/ports",    async (req, res, next) => { try { res.json({ success:true, data: await getPortsAndServices() }); } catch(e){ next(e); } });
router.get("/tides",    async (req, res, next) => { try { res.json({ success:true, data: await getTides() }); } catch(e){ next(e); } });
router.get("/cultural", async (req, res, next) => { try { res.json({ success:true, data: await getCulturalFeatures() }); } catch(e){ next(e); } });

module.exports = router;