// backend/src/utils/logger.js
const { createLogger, format, transports } = require("winston");
const path = require("path");
const fs = require("fs");

// Ensure logs directory exists
const logsDir = path.join(__dirname, "../../logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logger = createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.splat(),
    format.printf(({ timestamp, level, message, stack, ...meta }) => {
      // Render any extra splat/meta args so logger.warn("label:", value) prints both
      const metaKeys = Object.keys(meta).filter(k => k !== "service");
      const metaStr = metaKeys.length
        ? " " + metaKeys.map(k => {
            const v = meta[k];
            return typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
          }).join(" ")
        : "";
      return stack
        ? `[${timestamp}] ${level.toUpperCase()}: ${message}\n${stack}`
        : `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
    }),
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize({ all: true }),
        format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        format.splat(),
        format.printf(({ timestamp, level, message, ...meta }) => {
          const metaKeys = Object.keys(meta).filter(k => k !== "service");
          const metaStr = metaKeys.length
            ? " " + metaKeys.map(k => {
                const v = meta[k];
                return typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
              }).join(" ")
            : "";
          return `[${timestamp}] ${level}: ${message}${metaStr}`;
        }),
      ),
    }),
    new transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
    }),
    new transports.File({
      filename: path.join(logsDir, "combined.log"),
    }),
  ],
});

module.exports = logger;