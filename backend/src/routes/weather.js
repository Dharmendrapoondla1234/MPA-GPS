// backend/src/routes/weather.js — MPA Weather API v1
// Queries all 5 weather tables from BigQuery.MPA and returns
// a unified, deduplicated, and prioritised weather data object.
"use strict";
const express  = require("express");
const router   = express.Router();
const logger   = require("../utils/logger");
const { bigquery, BQ_LOCATION } = require("../services/bigquery");

// ── Simple in-memory cache (refresh every 3 min for live, 10 min for forecast) ─
const cache = { live: null, liveTs: 0, forecast: null, forecastTs: 0 };
const LIVE_TTL     = 3 * 60 * 1000;   // 3 min — matches sensor update freq
const FORECAST_TTL = 10 * 60 * 1000;  // 10 min — forecasts don't change often

function bqv(v) {
  if (v == null) return null;
  if (typeof v === "object" && "value" in v) return v.value;
  return v;
}

// ── GET /api/weather — full weather payload ──────────────────────────────────
router.get("/", async (_req, res) => {
  try {
    const now = Date.now();
    let live = cache.live, forecast = cache.forecast;

    // ── LIVE DATA ────────────────────────────────────────────────────────────
    if (!live || now - cache.liveTs > LIVE_TTL) {
      const [windSpeedRows, windDirRows, rainfallRows] = await Promise.all([

        // Wind speed — latest reading per station
        bigquery.query({
          query: `
            SELECT w.station_id, w.station_name, w.latitude, w.longitude,
                   w.wind_speed_ms,
                   w.reading_timestamp
            FROM \`photons-377606.MPA.MPA_weather_wind_speed\` w
            INNER JOIN (
              SELECT station_id, MAX(reading_timestamp) AS max_ts
              FROM \`photons-377606.MPA.MPA_weather_wind_speed\`
              WHERE reading_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 HOUR)
                AND latitude IS NOT NULL AND longitude IS NOT NULL
              GROUP BY station_id
            ) latest ON w.station_id = latest.station_id AND w.reading_timestamp = latest.max_ts
            WHERE w.latitude IS NOT NULL AND w.longitude IS NOT NULL
            ORDER BY w.station_id`,
          location: BQ_LOCATION,
        }),

        // Wind direction — latest reading per station
        bigquery.query({
          query: `
            SELECT d.station_id, d.station_name, d.latitude, d.longitude,
                   d.wind_direction,
                   d.reading_timestamp
            FROM \`photons-377606.MPA.MPA_wind_direction_readings\` d
            INNER JOIN (
              SELECT station_id, MAX(reading_timestamp) AS max_ts
              FROM \`photons-377606.MPA.MPA_wind_direction_readings\`
              WHERE reading_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 HOUR)
                AND latitude IS NOT NULL AND longitude IS NOT NULL
              GROUP BY station_id
            ) latest ON d.station_id = latest.station_id AND d.reading_timestamp = latest.max_ts
            WHERE d.latitude IS NOT NULL AND d.longitude IS NOT NULL
            ORDER BY d.station_id`,
          location: BQ_LOCATION,
        }),

        // Rainfall — latest reading, filter out null-only rows
        bigquery.query({
          query: `
            SELECT station_id, station_name, latitude, longitude,
                   rainfall_mm, reading_timestamp
            FROM \`photons-377606.MPA.MPA_weather_rainfall_readings\`
            WHERE reading_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 HOUR)
              AND station_id IS NOT NULL
              AND latitude IS NOT NULL AND longitude IS NOT NULL
              AND rainfall_mm IS NOT NULL
            QUALIFY ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY reading_timestamp DESC) = 1
            ORDER BY station_id`,
          location: BQ_LOCATION,
        }),
      ]);

      // Merge wind speed + direction by station_id
      const dirMap = new Map();
      for (const r of windDirRows[0]) {
        dirMap.set(String(r.station_id), Number(r.wind_direction) || null);
      }
      const rainMap = new Map();
      for (const r of rainfallRows[0]) {
        rainMap.set(String(r.station_id), Number(r.rainfall_mm) || 0);
      }

      const stations = windSpeedRows[0].map(r => {
        const sid = String(r.station_id);
        const spd = Number(r.wind_speed_ms) || 0;
        return {
          station_id:   sid,
          station_name: bqv(r.station_name),
          lat:          Number(r.latitude),
          lng:          Number(r.longitude),
          wind_speed_ms:    spd,
          wind_speed_kn:    Math.round(spd * 1.944 * 10) / 10,  // m/s → knots
          wind_speed_kmh:   Math.round(spd * 3.6 * 10) / 10,    // m/s → km/h
          wind_direction:   dirMap.get(sid) ?? null,
          rainfall_mm:      rainMap.get(sid) ?? null,
          reading_timestamp: bqv(r.reading_timestamp),
          beaufort:          getBeaufort(spd),
          alert:             getWindAlert(spd),
        };
      }).filter(s => s.lat && s.lng);

      // 2-hour area forecasts (area-level, has coords)
      const [twoHrRows] = await bigquery.query({
        query: `
          SELECT area, latitude, longitude, forecast,
                 period_text, period_start, period_end, forecast_timestamp
          FROM \`photons-377606.MPA.MPA_weather_2hr_forecast\`
          WHERE forecast_timestamp = (
            SELECT MAX(forecast_timestamp)
            FROM \`photons-377606.MPA.MPA_weather_2hr_forecast\`
          )
          ORDER BY area`,
        location: BQ_LOCATION,
      });

      const twoHr = twoHrRows.map(r => ({
        area:       bqv(r.area),
        lat:        Number(r.latitude),
        lng:        Number(r.longitude),
        forecast:   bqv(r.forecast),
        period_text: bqv(r.period_text),
        period_start: bqv(r.period_start),
        period_end:   bqv(r.period_end),
        icon:        forecastIcon(bqv(r.forecast)),
      })).filter(a => a.lat && a.lng);

      live = { stations, twoHr, updated_at: new Date().toISOString() };
      cache.live   = live;
      cache.liveTs = now;
      logger.info(`[WEATHER] Live: ${stations.length} wind stations, ${twoHr.length} 2hr areas`);
    }

    // ── FORECAST DATA ────────────────────────────────────────────────────────
    if (!forecast || now - cache.forecastTs > FORECAST_TTL) {
      const [fourDayRows, twentyFourRows] = await Promise.all([

        // 4-day forecast — most recent update, one row per day
        bigquery.query({
          query: `
            SELECT forecast_day, forecast_timestamp, forecast_code, forecast_text,
                   forecast_summary, temp_low, temp_high, humidity_low, humidity_high,
                   wind_speed_low, wind_speed_high, wind_direction
            FROM \`photons-377606.MPA.MPA_weather_4day_forecast\`
            WHERE record_date = CURRENT_DATE()
              AND updated_timestamp = (
                SELECT MAX(updated_timestamp)
                FROM \`photons-377606.MPA.MPA_weather_4day_forecast\`
                WHERE record_date = CURRENT_DATE()
              )
            ORDER BY forecast_timestamp
            LIMIT 4`,
          location: BQ_LOCATION,
        }),

        // 24hr forecast — most recent update, one row per period×region
        bigquery.query({
          query: `
            SELECT forecast_code, forecast_text, temp_low, temp_high,
                   humidity_low, humidity_high, wind_speed_low, wind_speed_high,
                   wind_direction, valid_text, period_text, region,
                   region_forecast_code, region_forecast_text
            FROM \`photons-377606.MPA.MPA_weather_24hr_forecast\`
            WHERE date = CURRENT_DATE()
              AND updated_timestamp = (
                SELECT MAX(updated_timestamp)
                FROM \`photons-377606.MPA.MPA_weather_24hr_forecast\`
                WHERE date = CURRENT_DATE()
              )
            ORDER BY region, period_start
            LIMIT 40`,
          location: BQ_LOCATION,
        }),
      ]);

      const fourDay = fourDayRows[0].map(r => ({
        day:           bqv(r.forecast_day),
        forecast_time: bqv(r.forecast_timestamp),
        code:          bqv(r.forecast_code),
        text:          bqv(r.forecast_text),
        summary:       bqv(r.forecast_summary),
        temp:  { low: Number(r.temp_low), high: Number(r.temp_high) },
        humidity: { low: Number(r.humidity_low), high: Number(r.humidity_high) },
        wind: {
          low: Number(r.wind_speed_low), high: Number(r.wind_speed_high),
          direction: bqv(r.wind_direction)
        },
        icon: forecastIcon(bqv(r.forecast_text)),
      }));

      // 24hr — pivot to periods with region breakdown
      const periodMap = new Map();
      for (const r of twentyFourRows[0]) {
        const key = bqv(r.period_text) || "now";
        if (!periodMap.has(key)) {
          periodMap.set(key, {
            period:    key,
            valid:     bqv(r.valid_text),
            code:      bqv(r.forecast_code),
            text:      bqv(r.forecast_text),
            temp:      { low: Number(r.temp_low), high: Number(r.temp_high) },
            humidity:  { low: Number(r.humidity_low), high: Number(r.humidity_high) },
            wind:      { low: Number(r.wind_speed_low), high: Number(r.wind_speed_high), direction: bqv(r.wind_direction) },
            icon:      forecastIcon(bqv(r.forecast_text)),
            regions:   {},
          });
        }
        const region = bqv(r.region) || "general";
        periodMap.get(key).regions[region] = {
          code: bqv(r.region_forecast_code),
          text: bqv(r.region_forecast_text),
          icon: forecastIcon(bqv(r.region_forecast_text)),
        };
      }

      forecast = {
        fourDay,
        twentyFour: Array.from(periodMap.values()),
        updated_at: new Date().toISOString(),
      };
      cache.forecast   = forecast;
      cache.forecastTs = now;
      logger.info(`[WEATHER] Forecast: ${fourDay.length} days, ${periodMap.size} 24hr periods`);
    }

    res.json({ success: true, data: { live, forecast } });

  } catch (err) {
    logger.error("[WEATHER] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function getBeaufort(ms) {
  if (ms < 0.3) return { scale: 0, label: "Calm" };
  if (ms < 1.6) return { scale: 1, label: "Light air" };
  if (ms < 3.4) return { scale: 2, label: "Light breeze" };
  if (ms < 5.5) return { scale: 3, label: "Gentle breeze" };
  if (ms < 8.0) return { scale: 4, label: "Moderate breeze" };
  if (ms < 10.8)return { scale: 5, label: "Fresh breeze" };
  if (ms < 13.9)return { scale: 6, label: "Strong breeze" };
  if (ms < 17.2)return { scale: 7, label: "High wind" };
  if (ms < 20.8)return { scale: 8, label: "Gale" };
  if (ms < 24.5)return { scale: 9, label: "Strong gale" };
  if (ms < 28.5)return { scale: 10, label: "Storm" };
  if (ms < 32.7)return { scale: 11, label: "Violent storm" };
  return { scale: 12, label: "Hurricane" };
}
function getWindAlert(ms) {
  if (ms >= 17.2) return "danger";   // Gale+
  if (ms >= 10.8) return "warning";  // Strong breeze+
  return null;
}
function forecastIcon(text) {
  if (!text) return "🌤️";
  const t = text.toLowerCase();
  if (t.includes("thunder"))   return "⛈️";
  if (t.includes("heavy rain") || t.includes("shower")) return "🌧️";
  if (t.includes("rain"))      return "🌦️";
  if (t.includes("overcast") || t.includes("cloudy")) return "☁️";
  if (t.includes("partly"))    return "⛅";
  if (t.includes("fair") || t.includes("sunny") || t.includes("clear")) return "☀️";
  if (t.includes("haze") || t.includes("fog"))  return "🌫️";
  if (t.includes("windy"))     return "💨";
  return "🌤️";
}

module.exports = router;