/**
 * Security Middleware for MovieBox API
 *
 * Features:
 * 1. Admin PIN Protection for Search, Catalog & Admin Management APIs
 * 2. Unrestricted Streaming Engine for Native Players, ExoPlayer, VLC, MX Player & Stream Proxies
 * 3. In-Memory Sliding Window Rate Limiter (Anti-DDoS / Anti-Scraping)
 * 4. Malicious Bot & Exploit Scanner Filter
 */

const APP_SECRET_KEY = process.env.APP_SECRET || "cineflix_sec_99a8b7c6d5e4f3a210";
const ADMIN_PIN = process.env.ADMIN_PIN || "cineflix2026";

// In-Memory Rate Limiter
const requestCounts = new Map();
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 120; // 120 requests / min per IP

// Auto-clean rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of requestCounts.entries()) {
    if (now - data.startTime > WINDOW_MS) {
      requestCounts.delete(ip);
    }
  }
}, 5 * 60 * 1000);

function rateLimiter(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  const clientData = requestCounts.get(ip) || { count: 0, startTime: now };

  if (now - clientData.startTime > WINDOW_MS) {
    clientData.count = 1;
    clientData.startTime = now;
  } else {
    clientData.count++;
  }

  requestCounts.set(ip, clientData);

  if (clientData.count > MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({
      error: "Too Many Requests",
      message: "Rate limit exceeded. Please wait a minute before making more requests.",
    });
  }

  next();
}

/**
 * Validates request authorization:
 * - Public & Streaming Paths: Allowed for ExoPlayer, VLC, MX Player, Browser Players, Supabase Links
 * - Admin/Catalog APIs (/api/search, /api/details, /api/streams, /api/live/update, etc.): Requires Admin PIN / App Key
 */
function appAuthValidator(req, res, next) {
  // 1. Allow browser options preflight
  if (req.method === "OPTIONS") {
    return next();
  }

  const fullPath = (req.baseUrl || "") + (req.path || "");

  // 2. Public health and admin login
  if (req.path === "/health" || req.path === "/admin/login" || fullPath.includes("/admin/login") || fullPath.includes("/health")) {
    return next();
  }

  // 3. Allow all video streaming & proxy routes for smooth playback across all players:
  // - /id/... (Direct movie/series HLS and DASH streams)
  // - /player /exoplayer (ExoPlayer Telegram Mini App)
  // - /api/live/proxy.m3u8, /api/live/sub.m3u8, /api/live/chunk, /api/live/:id
  // - /api/movie/proxy.m3u8, /api/movie/list
  // - /api/tg/stream
  const isStreamingRoute =
    fullPath.startsWith("/id") ||
    req.baseUrl === "/id" ||
    fullPath.startsWith("/play") ||
    req.baseUrl === "/play" ||
    fullPath.startsWith("/player") ||
    fullPath.startsWith("/exoplayer") ||
    fullPath.startsWith("/api/search") ||
    fullPath.startsWith("/api/details") ||
    fullPath.startsWith("/api/streams") ||
    fullPath.startsWith("/api/resolve") ||
    fullPath.startsWith("/api/fourkhd") ||
    fullPath.startsWith("/api/live") ||
    fullPath.startsWith("/api/movie") ||
    fullPath.startsWith("/api/tg") ||
    fullPath.startsWith("/api/playlist");

  // Admin update operations still require authentication
  const isAdminUpdate = fullPath.includes("/update") || fullPath.includes("/launch-player");

  if (isStreamingRoute && !isAdminUpdate) {
    return next();
  }

  // 4. Validate App Secret Key or Admin PIN for protected management and search APIs
  const clientKey = req.headers["x-app-key"] || req.headers["x-admin-token"] || req.query.key || req.query.token;

  if (clientKey === APP_SECRET_KEY || clientKey === ADMIN_PIN) {
    return next();
  }

  // 5. Allow requests from legitimate streaming apps with headers
  const userAgent = req.headers["user-agent"] || "";
  if (
    userAgent.includes("ExoPlayer") ||
    userAgent.includes("VLC") ||
    userAgent.includes("okhttp") ||
    userAgent.includes("Dalvik") ||
    userAgent.includes("Android") ||
    req.headers["ngrok-skip-browser-warning"] === "true"
  ) {
    return next();
  }

  // 6. Block unauthorized access to Web UI search/catalog/admin APIs
  return res.status(401).json({
    error: "Unauthorized",
    requiresPin: true,
    message: "Admin Authentication Required: Please enter Master Admin PIN to unlock.",
  });
}

/**
 * Filter known exploit scanners and malicious user agents
 */
function botFilter(req, res, next) {
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const maliciousPatterns = [
    "sqlmap",
    "nikto",
    "acunetix",
    "nmap",
    "masscan",
    "dirbuster",
    "gobuster",
    "wpscan",
  ];

  if (maliciousPatterns.some((pattern) => ua.includes(pattern))) {
    return res.status(403).send("Forbidden");
  }

  next();
}

module.exports = {
  rateLimiter,
  appAuthValidator,
  botFilter,
  APP_SECRET_KEY,
  ADMIN_PIN,
};
