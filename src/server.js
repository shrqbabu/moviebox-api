require("dotenv").config();
const fs = require("fs");
const dns = require("dns");
try { dns.setDefaultResultOrder("ipv4first"); } catch (_) {}
const express = require("express");
const cors = require("cors");
const path = require("path");
const apiRouter = require("./routes/api");
const { rateLimiter, appAuthValidator, botFilter } = require("./middleware/security");
const { workerPool } = require("./core/worker_pool");

const app = express();
const PORT = process.env.PORT || 3000;

process.on("uncaughtException", (err) => {
  console.error("⚠️ [Uncaught Exception]:", err.message);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("⚠️ [Unhandled Rejection]:", reason);
});

// Trust proxy for proper IP & https:// detection behind ngrok / Nginx / Cloudflare
app.set("trust proxy", true);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Apply security filters
app.use(botFilter);
app.use(rateLimiter);

// Allow Telegram WebApp & iframe embedding without external browser popup
app.use((req, res, next) => {
  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy", "frame-ancestors * https://web.telegram.org https://*.telegram.org telegram: t.me https://t.me;");
  res.setHeader("ngrok-skip-browser-warning", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

const { authenticateUser, getSessionFromReq, renderLoginPageHtml } = require("./core/supabase_auth");

// Browser HTML Authentication Guard (Requires CineFlix OTT App / Supabase Login)
function browserAuthGuard(req, res, next) {
  const isHtml = req.headers.accept && req.headers.accept.includes("text/html");
  if (!isHtml) {
    return next();
  }

  // Exempt Auth, ExoPlayer Mini App & Web Player from Supabase HTML login redirect
  if (
    req.path.startsWith("/auth") ||
    req.path.startsWith("/player") ||
    req.path.startsWith("/exoplayer") ||
    req.path === "/styles.css" ||
    req.path === "/player.js"
  ) {
    return next();
  }

  const session = getSessionFromReq(req);
  if (!session) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(renderLoginPageHtml(req.originalUrl || req.url));
  }

  req.user = session;
  next();
}

// 0. Serve CineFlix OTT Telegram Mini App static assets & routes
const exoplayerRoot = fs.existsSync(path.join(__dirname, "../public/player/index.html"))
  ? path.join(__dirname, "../public/player")
  : (fs.existsSync(path.resolve(__dirname, "../../index.html"))
    ? path.resolve(__dirname, "../../")
    : path.join(__dirname, "../public"));

app.use("/player", express.static(exoplayerRoot));
app.use("/exoplayer", express.static(exoplayerRoot));

app.get(["/player", "/player/index.html", "/exoplayer", "/exoplayer/index.html"], (req, res) => {
  res.sendFile(path.join(exoplayerRoot, "index.html"));
});

// 1. CineFlix Supabase Auth Endpoints
app.get("/auth/login", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderLoginPageHtml(req.query.redirect || "/"));
});

app.post("/auth/login", async (req, res) => {
  const { username, password, redirect } = req.body || {};
  const result = await authenticateUser(username, password);
  if (result.success) {
    res.setHeader("Set-Cookie", `cineflix_session=${result.token}; Path=/; Max-Age=2592000; SameSite=Lax`);
    return res.json({ success: true, redirect: redirect || "/" });
  }
  return res.status(401).json({ success: false, error: result.error });
});

app.get("/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", `cineflix_session=; Path=/; Max-Age=0; SameSite=Lax`);
  res.redirect("/auth/login");
});

// 2. Cloudflare Multi-Workers Pool Info & Smart Failover API
app.get(["/api/workers", "/workers"], (req, res) => {
  res.json({
    success: true,
    active: workerPool.getBestWorker(),
    workers: workerPool.getAllWorkers(),
  });
});

// Direct top-level ID endpoint (e.g. /id/tt0848228 or /id/tt0848228.m3u8)
app.use("/id", browserAuthGuard, appAuthValidator, (req, res, next) => {
  req.url = `/id${req.url}`;
  apiRouter(req, res, next);
});

// Direct top-level Play endpoint (e.g. /play/mx, /play/vlc, /play/playlist.m3u)
app.use("/play", browserAuthGuard, (req, res, next) => {
  req.url = `/play${req.url}`;
  apiRouter(req, res, next);
});

// Root Backend Status / Web Player
app.get("/", browserAuthGuard, (req, res) => {
  if (req.headers.accept && req.headers.accept.includes("text/html")) {
    return res.redirect("/play");
  }
  res.json({
    status: "online",
    service: "MovieBox Streaming Backend",
    version: "2.5.0",
    auth: "Supabase & CineFlix OTT",
    user: req.user ? req.user.email : "anonymous",
    endpoints: {
      streamMovie: "/id/:id/movie/index.m3u8",
      streamSeries: "/id/:id/:season/:episode/index.m3u8",
      search: "/api/search?q=<title>",
      resolve: "/api/resolve/:id",
      vlcPlayer: "/play/vlc?id=<id>",
      mxPlayer: "/play/mx?id=<id>",
    },
  });
});

// API routes protected with app authentication
app.use("/api", appAuthValidator, apiRouter);

// 404 for unknown endpoints
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("==================================================");
  console.log(`🎬 MovieBox Node.js Service (SECURED 🛡️) is running!`);
  console.log(`📡 REST API:   http://localhost:${PORT}/api`);
  console.log(`🌐 Web Player: http://localhost:${PORT}`);
  console.log(`⚡ Direct ID:  http://localhost:${PORT}/id/tt0848228`);
  console.log(`📱 MX Player:  http://localhost:${PORT}/play/mx?id=<id>`);
  console.log(`🚀 VLC Player: http://localhost:${PORT}/play/vlc?id=<id>`);
  console.log("==================================================");

  // 1. Auto-start MovieBox Telegram Search & Player Bot (MX Player, VLC, MPV)
  const movieBotToken = String(
    process.env.MOVIEBOX_BOT_TOKEN ||
    process.env.TG_BOT_TOKEN ||
    ""
  ).trim();

  if (movieBotToken) {
    const { botInstance } = require("./core/telegram_bot");
    botInstance.token = movieBotToken;
    botInstance.start().catch((e) => console.warn("MovieBox Telegram Bot notice:", e.message));
  }

  // 2. Auto-start Telegram MTProto Storage Stream Engine if TG_API_ID is configured
  if (process.env.TG_BOT_TOKEN && process.env.TG_API_ID) {
    const tgEngine = require("./core/telegram_stream");
    tgEngine.init().catch((e) => console.warn("Telegram MTProto notice:", e.message));
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`ℹ️ [Server] Port ${PORT} is already in use by another instance. Reusing existing stream proxy.`);
  } else {
    console.error("⚠️ [Server Error]:", err.message);
  }
});

module.exports = app;
