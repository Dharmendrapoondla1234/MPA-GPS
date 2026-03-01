// backend/src/middleware/validate.js

/**
 * Validates query parameters for the /api/vessels endpoint.
 * Returns 400 with a clear error message if any param is invalid.
 */
function validateVesselQuery(req, res, next) {
  const { speedMin, speedMax, limit } = req.query;

  if (speedMin !== undefined && isNaN(Number(speedMin))) {
    return res
      .status(400)
      .json({ success: false, error: "speedMin must be a number" });
  }
  if (speedMax !== undefined && isNaN(Number(speedMax))) {
    return res
      .status(400)
      .json({ success: false, error: "speedMax must be a number" });
  }
  if (limit !== undefined && (isNaN(Number(limit)) || Number(limit) <= 0)) {
    return res
      .status(400)
      .json({ success: false, error: "limit must be a positive number" });
  }

  next();
}

module.exports = { validateVesselQuery };
