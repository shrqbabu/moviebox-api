const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { MovieBoxClient } = require("../core/client");
const { findFfmpegExecutable, isFfmpegAvailable, streamDashViaFfmpeg } = require("../core/ffmpeg_stream");
const { resolveMediaToSubject } = require("../core/resolver");
const { FourKHdHubClient } = require("../core/fourkhdhub");
const fourKHdClient = new FourKHdHubClient();

const router = express.Router();

const { LiveStreamProxy } = require("../core/live_stream");
const { MovieStreamProxy } = require("../core/movie_stream");


// =============================================================
// 🎬 MOVIE STREAM PROXY & RESILIENT AUTO-FALLBACK ENGINE
// =============================================================

// 1. List configured custom movie overrides
router.get("/movie/list", (req, res) => {
  res.json({
    success: true,
    movies: MovieStreamProxy.getMovies()
  });
});

// 2. Movie Details Endpoint (Cover, Poster, Title, Synopsis, Actors, Rating)
router.get(["/details/:id", "/detail/:id", "/movie/:id"], async (req, res) => {
  try {
    const rawId = req.params.id;
    await client.ensureSession();
    const details = await client.getDetails(rawId);
    if (details) {
      return res.json({
        success: true,
        data: details,
      });
    }
    return res.status(404).json({ success: false, error: `Details not found for ${rawId}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2b. Poster & Image Proxy (Bypasses Hotlink / Referrer / CORS blocking)
router.get(["/poster", "/image", "/poster/:id"], async (req, res) => {
  try {
    let imgUrl = req.query.url;
    const rawId = req.params.id;

    if (!imgUrl && rawId) {
      await client.ensureSession();
      const details = await client.getDetails(rawId);
      imgUrl = details?.cover || details?.poster;
    }

    if (!imgUrl) {
      return res.status(400).send("Missing image url");
    }

    const imgRes = await fetch(imgUrl, {
      headers: {
        "User-Agent": client.userAgent,
        "Referer": "https://sportslive.wine/",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!imgRes.ok) {
      return res.redirect(imgUrl);
    }

    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    return res.send(buffer);
  } catch (err) {
    if (req.query.url) {
      return res.redirect(req.query.url);
    }
    return res.status(500).send(err.message);
  }
});

// 3. Update a movie stream override (e.g. IMDb ID or Title -> custom upstream m3u8/mp4)
router.post("/movie/update", (req, res) => {
  const { id, upstreamUrl, referer, title } = req.body || {};
  if (!id || !upstreamUrl) {
    return res.status(400).json({ error: "Missing required fields 'id' and 'upstreamUrl'" });
  }
  const updated = MovieStreamProxy.updateMovie(id, upstreamUrl, referer, title);
  res.json({
    success: true,
    message: `Movie override for '${id}' updated successfully`,
    movie: updated
  });
});


// 4. Universal Stream Resolver API (Returns direct stream or fallback JSON)
router.get("/resolve/:id", async (req, res) => {
  try {
    const rawId = req.params.id;
    const season = parseInt(req.query.s || req.query.season) || 0;
    const episode = parseInt(req.query.e || req.query.episode) || 0;

    // Check custom override
    const custom = MovieStreamProxy.getMovie(rawId);
    if (custom && custom.upstreamUrl) {
      const isMpd = custom.upstreamUrl.includes(".mpd");
      const isDirect = MovieStreamProxy.isDirectVideoUrl(custom.upstreamUrl);
      return res.json({
        success: true,
        provider: "custom",
        streamUrl: custom.upstreamUrl,
        referer: custom.referer,
        format: isMpd ? "DASH" : (isDirect ? "DIRECT" : "HLS")
      });
    }

    // Check MovieBox
    const media = await resolveMediaToSubject(rawId, season);
    if (media && media.subjectId) {
      const streamInfo = await getCachedStreamInfo(media.subjectId, season, episode);
      if (streamInfo && streamInfo.streams && streamInfo.streams.length > 0) {
        const hostOrigin = getBaseOrigin(req);
        const isSeries = season > 0;
        const proxyUrl = isSeries
          ? `${hostOrigin}/id/${media.subjectId}/${season}/${episode}/index.m3u8`
          : `${hostOrigin}/id/${media.subjectId}/movie/index.m3u8`;

        const s0 = streamInfo.streams[0];
        return res.json({
          success: true,
          provider: "moviebox",
          streamUrl: proxyUrl,
          proxyUrl: proxyUrl,
          rawStreamUrl: s0.streamUrl,
          signCookie: s0.signCookie,
          details: media,
          headers: {
            "User-Agent": client.userAgent,
            "Referer": "https://sportslive.wine",
            ...(s0.signCookie ? { "Cookie": s0.signCookie } : {}),
          },
          format: "HLS",
          subtitles: s0.subtitles || []
        });
      }
    }

    // Check MultiProvider fallback
    const searchTitle = media?.title || rawId;
    const fallback = await MovieStreamProxy.resolveFallbackMovieStream(searchTitle, season, episode);
    if (fallback && fallback.streamUrl) {
      return res.json({
        success: true,
        provider: fallback.provider || "fallback",
        streamUrl: fallback.streamUrl,
        referer: fallback.referer || "https://sportslive.wine/",
        format: fallback.format || "HLS"
      });
    }

    return res.status(404).json({
      success: false,
      error: `No playable stream resolved for ${rawId}`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Dynamic on-the-fly Movie Proxy
router.get("/movie/proxy.m3u8", (req, res) => {
  const url = req.query.url;
  const ref = req.query.ref || req.query.referer || "";
  if (!url) {
    return res.status(400).send("Missing 'url' query parameter");
  }
  if (MovieStreamProxy.isDirectVideoUrl(url)) {
    const hostOrigin = LiveStreamProxy.getHostOrigin(req);
    const hls = MovieStreamProxy.buildDirectVideoHls(url, "Movie Stream", hostOrigin, ref);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    return res.send(hls);
  }
  return LiveStreamProxy.serveManifest(req, res, "movie_dynamic", url, ref);
});

// 3.1 Direct Progressive Video Streaming Proxy (MKV / MP4 with Range Support)
router.get("/movie/stream", (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).send("Missing 'url' query parameter");
  }
  return LiveStreamProxy.serveChunk(req, res);
});

// 3.2 Direct Telegram Video Streaming Endpoint (HTTP 206 Range + Zero Disk Storage)
// Usage: /api/tg/stream?msg=42&channel=-1001234567890
router.get("/tg/stream", (req, res) => {
  const msgId = req.query.msg || req.query.id;
  const channel = req.query.channel || req.query.chat_id;
  if (!msgId) {
    return res.status(400).send("Missing 'msg' query parameter (Telegram Message ID)");
  }
  const tgEngine = require("../core/telegram_stream");
  return tgEngine.streamMedia(req, res, msgId, channel);
});

// =============================================================
// 🏏 LIVE STREAM PROXY & AUTO-REFRESH ENGINE
// =============================================================

// 1. Get all configured live channels
router.get("/live/channels", (req, res) => {
  res.json({
    success: true,
    channels: LiveStreamProxy.getChannels()
  });
});

// 2. Update a live channel's upstream link & referer
router.post("/live/update", (req, res) => {
  const { id, upstreamUrl, referer, title } = req.body || {};
  if (!id || !upstreamUrl) {
    return res.status(400).json({ error: "Missing required fields 'id' and 'upstreamUrl'" });
  }
  const updated = LiveStreamProxy.updateChannel(id, upstreamUrl, referer, title);
  res.json({
    success: true,
    message: `Channel '${id}' updated successfully`,
    channel: updated
  });
});

// 3. Dynamic on-the-fly Live Proxy (Pass any expiring URL: ?url=...&ref=...)
router.get("/live/proxy.m3u8", (req, res) => {
  const url = req.query.url;
  const ref = req.query.ref || req.query.referer || "";
  if (!url) {
    return res.status(400).send("Missing 'url' query parameter");
  }
  return LiveStreamProxy.serveManifest(req, res, "dynamic", url, ref);
});

// 4. Nested sub-playlists
router.get("/live/sub.m3u8", (req, res) => {
  const url = req.query.url;
  const ref = req.query.ref || "";
  return LiveStreamProxy.serveManifest(req, res, "nested", url, ref);
});

// 5. High-speed Segment Relayer
router.get("/live/chunk", (req, res) => {
  return LiveStreamProxy.serveChunk(req, res);
});

// 6. Permanent Live HLS Manifest Endpoints
router.get("/live/:id/index.m3u8", (req, res) => {
  return LiveStreamProxy.serveManifest(req, res, req.params.id);
});
router.get("/live/:id", (req, res) => {
  if (req.params.id.endsWith(".m3u8")) {
    const cleanId = req.params.id.replace(/\.m3u8$/i, "");
    return LiveStreamProxy.serveManifest(req, res, cleanId);
  }
  return LiveStreamProxy.serveManifest(req, res, req.params.id);
});


// Admin PIN Login Endpoint
router.post("/admin/login", (req, res) => {
  const { pin, password } = req.body || {};
  const provided = (pin || password || "").trim();
  const { APP_SECRET_KEY, ADMIN_PIN } = require("../middleware/security");

  if (provided === ADMIN_PIN || provided === APP_SECRET_KEY) {
    return res.json({
      success: true,
      token: APP_SECRET_KEY,
      message: "Admin authentication successful",
    });
  }

  return res.status(401).json({
    success: false,
    error: "Invalid Admin PIN. Access Denied.",
  });
});

const client = new MovieBoxClient();

// In-memory stream cache
const streamCache = new Map();

async function getCachedStreamInfo(subjectId, season = 0, episode = 0) {
  const cacheKey = `${subjectId}_${season}_${episode}`;
  const cached = streamCache.get(cacheKey);
  const now = Date.now();

  if (cached && now < cached.expiresAt) {
    return cached.data;
  }

  const streamInfo = await client.getStreams(subjectId, season, episode);
  if (streamInfo.streams && streamInfo.streams.length > 0) {
    streamCache.set(cacheKey, {
      data: streamInfo,
      expiresAt: now + 6 * 3600 * 1000,
    });
  }
  return streamInfo;
}

function findVlcExecutable() {
  const candidates = [
    "C:/Program Files/VideoLAN/VLC/vlc.exe",
    "C:/Program Files (x86)/VideoLAN/VLC/vlc.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs/VLC/vlc.exe"),
    "/usr/bin/vlc",
    "/Applications/VLC.app/Contents/MacOS/VLC",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function findMpvExecutable() {
  const candidates = [
    "C:/Program Files/MPV Player/mpv.exe",
    "C:/Program Files/mpv/mpv.exe",
    "C:/Program Files (x86)/MPV Player/mpv.exe",
    "C:/Program Files (x86)/mpv/mpv.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs/MPV Player/mpv.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs/mpv/mpv.exe"),
    path.join(process.env.USERPROFILE || "", "scoop/apps/mpv/current/mpv.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft/WinGet/Links/mpv.exe"),
    "/usr/bin/mpv",
    "/usr/local/bin/mpv",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function findAmExecutable() {
  const candidates = [
    "/system/bin/am",
    "/data/data/com.termux/files/usr/bin/am",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function getBaseOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.get("host") || "localhost:3000";
  return `${proto}://${host}`;
}

function parseIsoDuration(durationStr) {
  if (!durationStr) return 0;
  const match = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!match) return 0;
  const hours = parseFloat(match[1] || 0);
  const minutes = parseFloat(match[2] || 0);
  const seconds = parseFloat(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function extractAdaptationSet(mpdXml, type = "video") {
  const sets = mpdXml.split("</AdaptationSet>");
  for (const s of sets) {
    if (s.includes(`contentType="${type}"`) || s.includes(`mimeType="${type}/`)) {
      return s + "</AdaptationSet>";
    }
  }
  return null;
}

function parseAdaptationSetToHls(setXml, totalDurationSec = 0, specificRepId = null) {
  if (!setXml) return "";

  let repId = "0";
  if (specificRepId !== null && specificRepId !== undefined && specificRepId !== "" && specificRepId !== "auto") {
    repId = String(specificRepId);
  } else {
    const repMatch = setXml.match(/<Representation[^>]*id="([^"]+)"/);
    repId = repMatch ? repMatch[1] : "0";
  }

  // Isolate the specific representation block to prevent multi-representation timeline concatenation
  let targetXml = setXml;
  const repRegex = new RegExp(`<Representation[^>]*id=["']${repId}["'][\\s\\S]*?<\\/Representation>`, "i");
  const repMatch = setXml.match(repRegex);
  if (repMatch) {
    targetXml = repMatch[0];
  } else {
    const startIdx = setXml.indexOf(`id="${repId}"`);
    if (startIdx !== -1) {
      const tagStart = setXml.lastIndexOf("<Representation", startIdx);
      const nextRep = setXml.indexOf("<Representation", startIdx + 1);
      targetXml = nextRep !== -1 ? setXml.substring(tagStart, nextRep) : setXml.substring(tagStart);
    }
  }

  const timescaleMatch = targetXml.match(/timescale="(\d+)"/) || setXml.match(/timescale="(\d+)"/);
  const timescale = timescaleMatch ? parseInt(timescaleMatch[1]) : 30000;

  const durationMatch = targetXml.match(/duration="(\d+)"/) || setXml.match(/duration="(\d+)"/);
  const fixedDuration = durationMatch ? parseInt(durationMatch[1]) : 0;

  const initMatch = targetXml.match(/initialization="([^"]+)"/) || setXml.match(/initialization="([^"]+)"/);
  let initFile = initMatch
    ? initMatch[1].replace(/\$RepresentationID\$/g, repId)
    : `init-stream${repId}.m4s`;

  const mediaMatch = targetXml.match(/media="([^"]+)"/) || setXml.match(/media="([^"]+)"/);
  const mediaTemplate = mediaMatch
    ? mediaMatch[1].replace(/\$RepresentationID\$/g, repId)
    : `chunk-stream${repId}-$Number%05d$.m4s`;

  const sRegex = /<S\s+(?:t="\d+"\s+)?d="(\d+)"(?:\s+r="(\d+)")?\s*\/>/g;
  let match;
  const segments = [];
  let chunkNumber = 1;

  // Case 1: Timeline Segments (<S d="..." />)
  while ((match = sRegex.exec(targetXml)) !== null) {
    const duration = parseInt(match[1]);
    const repeat = match[2] ? parseInt(match[2]) : 0;
    const durSec = duration / timescale;

    for (let r = 0; r <= repeat; r++) {
      let chunkFile = mediaTemplate;
      if (chunkFile.includes("$Number%05d$")) {
        chunkFile = chunkFile.replace("$Number%05d$", String(chunkNumber).padStart(5, "0"));
      } else if (chunkFile.includes("$Number$")) {
        chunkFile = chunkFile.replace("$Number$", String(chunkNumber));
      } else {
        chunkFile = `chunk-stream${repId}-${String(chunkNumber).padStart(5, "0")}.m4s`;
      }

      segments.push({
        duration: durSec.toFixed(4),
        url: chunkFile,
      });
      chunkNumber++;
    }
  }

  // Case 2: Fixed Duration Segments (Fallback)
  if (segments.length === 0 && fixedDuration > 0 && totalDurationSec > 0) {
    const chunkDurSec = fixedDuration / timescale;
    const totalChunks = Math.ceil(totalDurationSec / chunkDurSec);

    for (let i = 1; i <= totalChunks; i++) {
      let chunkFile = mediaTemplate;
      if (chunkFile.includes("$Number%05d$")) {
        chunkFile = chunkFile.replace("$Number%05d$", String(i).padStart(5, "0"));
      } else if (chunkFile.includes("$Number$")) {
        chunkFile = chunkFile.replace("$Number$", String(i));
      } else {
        chunkFile = `chunk-stream${repId}-${String(i).padStart(5, "0")}.m4s`;
      }

      const dur = (i === totalChunks && (totalDurationSec % chunkDurSec !== 0))
        ? (totalDurationSec % chunkDurSec).toFixed(4)
        : chunkDurSec.toFixed(4);

      segments.push({
        duration: dur,
        url: chunkFile,
      });
    }
  }

  const maxDur = segments.length > 0
    ? Math.ceil(Math.max(...segments.map((s) => parseFloat(s.duration)), 6))
    : 10;

  let m3u8 = `#EXTM3U\n`;
  m3u8 += `#EXT-X-VERSION:7\n`;
  m3u8 += `#EXT-X-TARGETDURATION:${maxDur}\n`;
  m3u8 += `#EXT-X-MEDIA-SEQUENCE:1\n`;
  m3u8 += `#EXT-X-PLAYLIST-TYPE:VOD\n`;
  m3u8 += `#EXT-X-MAP:URI="${initFile}"\n\n`;

  for (const seg of segments) {
    m3u8 += `#EXTINF:${seg.duration},\n${seg.url}\n`;
  }
  m3u8 += `#EXT-X-ENDLIST\n`;

  return m3u8;
}

function extractVideoRepresentations(mpdXml) {
  const videoSet = extractAdaptationSet(mpdXml, "video") || "";
  const audioSet = extractAdaptationSet(mpdXml, "audio") || "";

  let aCodec = "";
  const aMatch = audioSet.match(/codecs="([^"]+)"/);
  if (aMatch) {
    aCodec = aMatch[1];
  }

  const reps = [];
  const repRegex = /<Representation\b([^>]*?)(?:\/?>|>([\s\S]*?)<\/Representation>)/g;
  let match;
  while ((match = repRegex.exec(videoSet)) !== null) {
    const attrs = match[1] || "";
    const idMatch = attrs.match(/\bid="([^"]+)"/);
    if (!idMatch) continue;
    const repId = idMatch[1];

    let vCodec = "";
    const codecMatch = attrs.match(/\bcodecs="([^"]+)"/) || videoSet.match(/codecs="([^"]+)"/);
    if (codecMatch) {
      vCodec = codecMatch[1];
      if (vCodec.startsWith("hev1") || vCodec.startsWith("hvc1")) {
        vCodec = "hev1.1.6.L93.B0";
      }
    }

    let width = "";
    let height = "";
    const wMatch = attrs.match(/\bwidth="(\d+)"/) || videoSet.match(/\bwidth="(\d+)"/) || videoSet.match(/maxWidth="(\d+)"/);
    const hMatch = attrs.match(/\bheight="(\d+)"/) || videoSet.match(/\bheight="(\d+)"/) || videoSet.match(/maxHeight="(\d+)"/);
    if (wMatch) width = wMatch[1];
    if (hMatch) height = hMatch[1];

    let bandwidth = "2500000";
    const bwMatch = attrs.match(/\bbandwidth="(\d+)"/);
    if (bwMatch) bandwidth = bwMatch[1];

    reps.push({
      id: repId,
      bandwidth,
      width: width || "1920",
      height: height || "1080",
      vCodec,
      aCodec
    });
  }

  // Fallback if no specific representation tag matched
  if (reps.length === 0) {
    let vCodec = "";
    const vMatch = videoSet.match(/codecs="([^"]+)"/);
    if (vMatch) {
      vCodec = vMatch[1];
      if (vCodec.startsWith("hev1") || vCodec.startsWith("hvc1")) {
        vCodec = "hev1.1.6.L93.B0";
      }
    }
    let width = "1920";
    let height = "1080";
    const wMatch = videoSet.match(/\bwidth="(\d+)"/) || videoSet.match(/maxWidth="(\d+)"/);
    const hMatch = videoSet.match(/\bheight="(\d+)"/) || videoSet.match(/maxHeight="(\d+)"/);
    if (wMatch) width = wMatch[1];
    if (hMatch) height = hMatch[1];

    let bandwidth = "2500000";
    const bwMatch = videoSet.match(/\bbandwidth="(\d+)"/);
    if (bwMatch) bandwidth = bwMatch[1];

    reps.push({
      id: "0",
      bandwidth,
      width,
      height,
      vCodec,
      aCodec
    });
  }

  return { videoRepresentations: reps, aCodec };
}

function buildHlsMasterPlaylist(mpdXml, specificRepId = null) {
  const hasAudio = mpdXml.includes(`contentType="audio"`) || mpdXml.includes(`mimeType="audio`);
  const { videoRepresentations, aCodec } = extractVideoRepresentations(mpdXml);

  let master = `#EXTM3U\n`;
  master += `#EXT-X-VERSION:7\n\n`;

  if (hasAudio) {
    master += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-main",NAME="Hindi Audio",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="hi",CHANNELS="2",URI="audio.m3u8"\n\n`;
  }

  const filteredReps = (specificRepId !== null && specificRepId !== undefined && specificRepId !== "" && specificRepId !== "auto")
    ? videoRepresentations.filter((r) => String(r.id) === String(specificRepId))
    : videoRepresentations;

  const repsToUse = filteredReps.length > 0 ? filteredReps : videoRepresentations;

  for (let i = 0; i < repsToUse.length; i++) {
    const rep = repsToUse[i];
    let codecs = [];
    if (rep.vCodec) codecs.push(rep.vCodec);
    if (hasAudio && (rep.aCodec || aCodec)) codecs.push(rep.aCodec || aCodec);

    const codecAttr = codecs.length > 0 ? `,CODECS="${codecs.join(",")}"` : "";
    const audioAttr = hasAudio ? `,AUDIO="audio-main"` : "";

    master += `#EXT-X-STREAM-INF:BANDWIDTH=${rep.bandwidth},RESOLUTION=${rep.width}x${rep.height}${codecAttr}${audioAttr}\n`;
    master += `video-${rep.id}.m3u8\n\n`;
  }

  return master;
}

// In-memory stream configurations and segment caches for smooth bufferless playback
const streamConfigCache = new Map();
const initChunkCache = new Map();

async function getStreamConfig(rawId, season = 0, episode = 0) {
  const cacheKey = `${rawId}_${season}_${episode}`;
  const now = Date.now();
  const cached = streamConfigCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached;
  }

  // 1. Check custom overrides
  const customOverride = MovieStreamProxy.getMovie(rawId);
  if (customOverride && customOverride.upstreamUrl) {
    const config = {
      isCustom: true,
      customOverride,
      expiresAt: now + 3600 * 1000,
    };
    streamConfigCache.set(cacheKey, config);
    return config;
  }

  // 2. Resolve Subject ID (instant in 0ms if already numeric)
  const media = await resolveMediaToSubject(rawId, season);
  if (!media || !media.subjectId) {
    return null;
  }

  // 3. Get Stream Info (cached for 6 hours)
  const streamInfo = await getCachedStreamInfo(media.subjectId, season, episode);
  if (!streamInfo || !streamInfo.streams || streamInfo.streams.length === 0) {
    return null;
  }

  const firstStream = streamInfo.streams[0];
  const upstreamUrl = firstStream.streamUrl;
  const baseDir = upstreamUrl.replace(/\/index\.mpd$/, "");

  const config = {
    subjectId: media.subjectId,
    upstreamUrl,
    baseDir,
    signCookie: firstStream.signCookie || "",
    userAgent: client.userAgent,
    rawMpd: null,
    totalDurationSec: 0,
    masterM3u8: null,
    qualityMasterM3u8: new Map(),
    videoPlaylists: new Map(),
    audioM3u8: null,
    expiresAt: now + 6 * 3600 * 1000,
  };

  streamConfigCache.set(cacheKey, config);
  if (media.subjectId !== rawId) {
    streamConfigCache.set(`${media.subjectId}_${season}_${episode}`, config);
  }

  return config;
}

async function serveDirectManifest(req, res, idParam, season = 0, episode = 0, subPath = "", trackType = "master") {
  try {
    const rawId = String(idParam || "").replace(/\.(m3u8|mpd|json)$/i, "").trim();
    const config = await getStreamConfig(rawId, season, episode);

    if (!config) {
      // Secondary fallback to 4KHDHub if MovieBox unavailable
      const searchTitle = rawId.replace(/^(tt|tmdb:)/, "").trim();
      const fallbackStream = await MovieStreamProxy.resolveFallbackMovieStream(searchTitle, season, episode);
      if (fallbackStream && fallbackStream.streamUrl) {
        if (fallbackStream.streamUrl.includes(".mp4") || fallbackStream.streamUrl.includes(".mkv")) {
          const hls = MovieStreamProxy.buildDirectVideoHls(fallbackStream.streamUrl, searchTitle);
          res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
          res.setHeader("Access-Control-Allow-Origin", "*");
          return res.send(hls);
        }
        return LiveStreamProxy.serveManifest(req, res, "4khd_fallback", fallbackStream.streamUrl, fallbackStream.referer);
      }
      return res.status(404).send(`No stream available for: ${rawId}`);
    }

    if (config.isCustom) {
      const co = config.customOverride;
      if (co.upstreamUrl.includes(".mp4") || co.upstreamUrl.includes(".mkv")) {
        const hls = MovieStreamProxy.buildDirectVideoHls(co.upstreamUrl, co.title);
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.send(hls);
      }
      return LiveStreamProxy.serveManifest(req, res, "custom_movie", co.upstreamUrl, co.referer);
    }

    // Direct MP4 redirect
    if (config.upstreamUrl.includes(".mp4") && !config.upstreamUrl.includes(".mpd")) {
      return res.redirect(config.upstreamUrl);
    }

    // Fetch and parse upstream MPD once
    if (!config.rawMpd) {
      const headers = {
        "User-Agent": config.userAgent,
        Referer: "https://sportslive.wine",
      };
      if (config.signCookie) {
        headers.Cookie = config.signCookie;
      }
      const upstreamRes = await fetch(config.upstreamUrl, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!upstreamRes.ok) {
        return res.status(upstreamRes.status).send("Upstream stream unavailable");
      }
      config.rawMpd = await upstreamRes.text();
      const durMatch = config.rawMpd.match(/mediaPresentationDuration="([^"]+)"/);
      config.totalDurationSec = parseIsoDuration(durMatch ? durMatch[1] : "");
    }

    const hostOrigin = getBaseOrigin(req);
    const segmentProxyBase = subPath
      ? `${hostOrigin}${subPath}/`
      : (season > 0
          ? `${hostOrigin}/id/${rawId}/${season}/${episode}/`
          : `${hostOrigin}/id/${rawId}/movie/`);

    // 1. DASH MPD Manifest
    if (trackType === "mpd" || req.path.endsWith(".mpd")) {
      let rewritten = config.rawMpd;
      const periodIndex = rewritten.indexOf("<Period");
      if (periodIndex !== -1) {
        const periodTagEnd = rewritten.indexOf(">", periodIndex);
        if (periodTagEnd !== -1) {
          const before = rewritten.substring(0, periodTagEnd + 1);
          const after = rewritten.substring(periodTagEnd + 1);
          rewritten = `${before}\n\t\t<BaseURL>${segmentProxyBase}</BaseURL>${after}`;
        }
      }
      res.setHeader("Content-Type", "application/dash+xml; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      return res.send(rewritten);
    }

    // 2. Video sub-playlist (multi-bitrate or default, cached in RAM)
    if (trackType === "video" || trackType.startsWith("video")) {
      if (!config.videoPlaylists) {
        config.videoPlaylists = new Map();
      }
      let repId = null;
      if (trackType.startsWith("video-")) {
        repId = trackType.replace("video-", "");
      }
      const cacheKey = repId !== null ? `video_${repId}` : "video_default";
      if (!config.videoPlaylists.has(cacheKey)) {
        const videoSet = extractAdaptationSet(config.rawMpd, "video");
        const playlist = parseAdaptationSetToHls(videoSet, config.totalDurationSec, repId);
        config.videoPlaylists.set(cacheKey, playlist);
      }
      res.setHeader("Content-Type", "application/x-mpegURL; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.send(config.videoPlaylists.get(cacheKey));
    }

    // 3. Audio sub-playlist (cached in RAM)
    if (trackType === "audio") {
      if (!config.audioM3u8) {
        const audioSet = extractAdaptationSet(config.rawMpd, "audio");
        config.audioM3u8 = parseAdaptationSetToHls(audioSet, config.totalDurationSec);
      }
      res.setHeader("Content-Type", "application/x-mpegURL; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.send(config.audioM3u8);
    }

    // 4. Master Playlist (HLS - with Audio + Video synced)
    const qRep = req.query.q || req.query.rep || req.query.quality;
    if (qRep !== undefined && qRep !== null && qRep !== "" && qRep !== "auto") {
      const qKey = `q_${qRep}`;
      if (!config.qualityMasterM3u8) config.qualityMasterM3u8 = new Map();
      if (!config.qualityMasterM3u8.has(qKey)) {
        config.qualityMasterM3u8.set(qKey, buildHlsMasterPlaylist(config.rawMpd, qRep));
      }
      res.setHeader("Content-Type", "application/x-mpegURL; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.send(config.qualityMasterM3u8.get(qKey));
    }

    if (!config.masterM3u8) {
      config.masterM3u8 = buildHlsMasterPlaylist(config.rawMpd);
    }
    res.setHeader("Content-Type", "application/x-mpegURL; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.send(config.masterM3u8);
  } catch (err) {
    res.status(500).send(`Manifest resolution error: ${err.message}`);
  }
}

const chunkBufferCache = new Map();
const MAX_CACHED_CHUNKS = 50;

function cleanOldChunks() {
  if (chunkBufferCache.size > MAX_CACHED_CHUNKS) {
    const oldestKeys = Array.from(chunkBufferCache.keys()).slice(0, 15);
    for (const k of oldestKeys) {
      chunkBufferCache.delete(k);
    }
  }
}

async function serveMediaChunk(req, res, idParam, fileName, season = 0, episode = 0) {
  try {
    const rawId = String(idParam || "").replace(/\.(m3u8|mpd|json)$/i, "").trim();

    // Instant memory lookup: eliminates all getDetails and resolver latency
    let config = streamConfigCache.get(`${rawId}_${season}_${episode}`);
    if (!config) {
      config = await getStreamConfig(rawId, season, episode);
    }

    if (!config || !config.baseDir) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      return res.status(404).send("Stream not found");
    }

    // 1. Return init segments immediately from RAM if cached
    const initCacheKey = `${config.baseDir}_${fileName}`;
    if (fileName.startsWith("init") && initChunkCache.has(initCacheKey)) {
      const cachedInit = initChunkCache.get(initCacheKey);
      res.setHeader("Content-Type", cachedInit.contentType);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      return res.send(cachedInit.buffer);
    }

    // 2. Return media chunk immediately from RAM if cached
    const chunkCacheKey = `${config.baseDir}_${fileName}`;
    if (chunkBufferCache.has(chunkCacheKey)) {
      const cachedChunk = chunkBufferCache.get(chunkCacheKey);
      res.setHeader("Content-Type", cachedChunk.contentType);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      return res.send(cachedChunk.buffer);
    }

    const targetChunkUrl = `${config.baseDir}/${fileName}`;

    const headers = {
      "User-Agent": config.userAgent || client.userAgent,
      Referer: "https://sportslive.wine",
    };
    if (config.signCookie) {
      headers.Cookie = config.signCookie;
    }
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await fetch(targetChunkUrl, {
      headers,
      signal: AbortSignal.timeout(20000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      return res.status(upstream.status).send("Chunk fetch failed");
    }

    let contentType = upstream.headers.get("content-type");
    if (!contentType || contentType === "application/octet-stream" || contentType === "text/plain") {
      if (fileName.includes("stream3") || fileName.includes("audio") || fileName.endsWith(".aac") || fileName.endsWith(".m4a")) {
        contentType = "audio/mp4";
      } else {
        contentType = "video/mp4";
      }
    }
    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");

    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Accept-Ranges", "bytes");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }
    if (contentRange) {
      res.setHeader("Content-Range", contentRange);
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

    // Init segment caching
    if (fileName.startsWith("init")) {
      const arrayBuf = await upstream.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      initChunkCache.set(initCacheKey, { buffer: buf, contentType });
      return res.send(buf);
    }

    // Zero-Buffer Chunk Stream Piping with Non-Blocking RAM Caching
    if (upstream.body) {
      const chunks = [];
      const nodeStream = Readable.fromWeb(upstream.body);

      nodeStream.on("data", (chunk) => {
        chunks.push(chunk);
      });

      nodeStream.on("end", () => {
        const fullBuf = Buffer.concat(chunks);
        chunkBufferCache.set(chunkCacheKey, { buffer: fullBuf, contentType, timestamp: Date.now() });
        cleanOldChunks();
      });

      nodeStream.on("error", (err) => {
        console.error(`[serveMediaChunk] Stream error for ${fileName}:`, err.message);
      });

      nodeStream.pipe(res);
    } else {
      const arrayBuf = await upstream.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      chunkBufferCache.set(chunkCacheKey, { buffer: buf, contentType, timestamp: Date.now() });
      cleanOldChunks();
      return res.send(buf);
    }
  } catch (err) {
    if (!res.headersSent) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.status(500).send(`Chunk error: ${err.message}`);
    }
  }
}

/**
 * 4KHDHub Direct 4K/1080p Stream Resolver Endpoint
 */
router.get("/fourkhd", async (req, res) => {
  try {
    const q = req.query.q || req.query.query || req.query.title;
    if (!q) {
      return res.status(400).json({ error: "Missing query parameter 'q'" });
    }
    const stream = await fourKHdClient.resolveMovieStream(q);
    if (!stream) {
      return res.status(404).json({ error: "No 4KHDHub stream found for " + q });
    }
    res.json(stream);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/id/:id/fourkhd", async (req, res) => {
  try {
    const id = req.params.id;
    const media = await resolveMediaToSubject(id, 0);
    const title = media?.title || id.replace(/^(tt|tmdb:)/, "");
    const stream = await fourKHdClient.resolveMovieStream(title);
    if (!stream || !stream.streamUrl) {
      return res.status(404).send("4K stream not found");
    }
    res.redirect(stream.streamUrl);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// -------------------------------------------------------------
// 🌟 STREAMING ENDPOINTS
// -------------------------------------------------------------

// =============================================================
// ⚡ FFMPEG ZERO-BUFFER HIGH-SPEED STREAMING ENGINE (MovieBox-TUI Parity)
// =============================================================

async function serveFfmpegStream(req, res, idParam, season = 0, episode = 0) {
  try {
    const rawId = String(idParam || "").replace(/\.(m3u8|mpd|mp4|json)$/i, "").trim();
    const config = await getStreamConfig(rawId, season, episode);

    if (!config || !config.upstreamUrl) {
      return res.status(404).send(`No stream available for: ${rawId}`);
    }

    if (!isFfmpegAvailable()) {
      if (config.upstreamUrl.includes(".mp4") && !config.upstreamUrl.includes(".mpd")) {
        return res.redirect(config.upstreamUrl);
      }
      return serveDirectManifest(req, res, rawId, season, episode, "", "master");
    }

    streamDashViaFfmpeg({
      req,
      res,
      upstreamUrl: config.upstreamUrl,
      signCookie: config.signCookie || "",
      userAgent: config.userAgent || client.userAgent,
      referer: "https://sportslive.wine",
    });
  } catch (err) {
    console.error("[serveFfmpegStream] Error:", err.message);
    if (!res.headersSent) {
      res.status(500).send(`Stream error: ${err.message}`);
    }
  }
}

// 0. Zero-Buffer Direct MP4 Streams (FFmpeg Remuxed)
router.get("/id/:id/movie/stream.mp4", (req, res) => {
  return serveFfmpegStream(req, res, req.params.id, 0, 0);
});
router.get("/id/:id/movie/ffmpeg.mp4", (req, res) => {
  return serveFfmpegStream(req, res, req.params.id, 0, 0);
});
router.get("/id/:id/series/:season/:episode/stream.mp4", (req, res) => {
  const { id, season, episode } = req.params;
  return serveFfmpegStream(req, res, id, season, episode);
});
router.get("/id/:id/:season/:episode/stream.mp4", (req, res) => {
  const { id, season, episode } = req.params;
  return serveFfmpegStream(req, res, id, season, episode);
});
router.get("/id/:id/stream.mp4", (req, res) => {
  const season = parseInt(req.query.s || req.query.season) || 0;
  const episode = parseInt(req.query.e || req.query.episode) || 0;
  return serveFfmpegStream(req, res, req.params.id, season, episode);
});

// 1. Movie Manifests
router.get("/id/:id/movie/index.m3u8", (req, res) => {
  return serveDirectManifest(req, res, req.params.id, 0, 0, `/id/${req.params.id}/movie`, "master");
});
router.get("/id/:id/movie/index.mpd", (req, res) => {
  return serveDirectManifest(req, res, req.params.id, 0, 0, `/id/${req.params.id}/movie`, "mpd");
});
router.get("/id/:id/movie/video.m3u8", (req, res) => {
  return serveDirectManifest(req, res, req.params.id, 0, 0, `/id/${req.params.id}/movie`, "video");
});
router.get("/id/:id/movie/video-:repId.m3u8", (req, res) => {
  return serveDirectManifest(req, res, req.params.id, 0, 0, `/id/${req.params.id}/movie`, `video-${req.params.repId}`);
});
router.get("/id/:id/movie/audio.m3u8", (req, res) => {
  return serveDirectManifest(req, res, req.params.id, 0, 0, `/id/${req.params.id}/movie`, "audio");
});

// Movie Segments
router.get("/id/:id/movie/:file", (req, res) => {
  const file = req.params.file;
  if (file === "stream.mp4" || file === "ffmpeg.mp4") {
    return serveFfmpegStream(req, res, req.params.id, 0, 0);
  }
  if (file === "index.m3u8") {
    return serveDirectManifest(req, res, req.params.id, 0, 0, `/id/${req.params.id}/movie`, "master");
  }
  if (file === "index.mpd") {
    return serveDirectManifest(req, res, req.params.id, 0, 0, `/id/${req.params.id}/movie`, "mpd");
  }
  if (file === "video.m3u8") {
    return serveDirectManifest(req, res, req.params.id, 0, 0, `/id/${req.params.id}/movie`, "video");
  }
  if (file.startsWith("video-") && file.endsWith(".m3u8")) {
    const repId = file.replace(/^video-|\.m3u8$/g, "");
    return serveDirectManifest(req, res, req.params.id, 0, 0, `/id/${req.params.id}/movie`, `video-${repId}`);
  }
  if (file === "audio.m3u8") {
    return serveDirectManifest(req, res, req.params.id, 0, 0, `/id/${req.params.id}/movie`, "audio");
  }
  return serveMediaChunk(req, res, req.params.id, file, 0, 0);
});

// 2. Series Explicit Route
router.get("/id/:id/series/:season/:episode/index.m3u8", (req, res) => {
  const { id, season, episode } = req.params;
  return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, "master");
});
router.get("/id/:id/series/:season/:episode/index.mpd", (req, res) => {
  const { id, season, episode } = req.params;
  return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, "mpd");
});
router.get("/id/:id/series/:season/:episode/video.m3u8", (req, res) => {
  const { id, season, episode } = req.params;
  return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, "video");
});
router.get("/id/:id/series/:season/:episode/video-:repId.m3u8", (req, res) => {
  const { id, season, episode, repId } = req.params;
  return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, `video-${repId}`);
});
router.get("/id/:id/series/:season/:episode/audio.m3u8", (req, res) => {
  const { id, season, episode } = req.params;
  return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, "audio");
});

// 3. Short Convenient Series Route (e.g. /id/7147213651240699592/1/1/index.m3u8)
router.get("/id/:id/:season/:episode/index.m3u8", (req, res) => {
  const { id, season, episode } = req.params;
  return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, "master");
});
router.get("/id/:id/:season/:episode/index.mpd", (req, res) => {
  const { id, season, episode } = req.params;
  return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, "mpd");
});
router.get("/id/:id/:season/:episode/video.m3u8", (req, res) => {
  const { id, season, episode } = req.params;
  return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, "video");
});
router.get("/id/:id/:season/:episode/video-:repId.m3u8", (req, res) => {
  const { id, season, episode, repId } = req.params;
  return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, `video-${repId}`);
});
router.get("/id/:id/:season/:episode/audio.m3u8", (req, res) => {
  const { id, season, episode } = req.params;
  return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, "audio");
});

// Series Segments Route
router.get("/id/:id/:season/:episode/:file", (req, res) => {
  const { id, season, episode, file } = req.params;
  if (file === "index.m3u8") {
    return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, "master");
  }
  if (file === "index.mpd") {
    return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, "mpd");
  }
  if (file === "video.m3u8") {
    return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, "video");
  }
  if (file.startsWith("video-") && file.endsWith(".m3u8")) {
    const repId = file.replace(/^video-|\.m3u8$/g, "");
    return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, `video-${repId}`);
  }
  if (file === "audio.m3u8") {
    return serveDirectManifest(req, res, id, season, episode, `/id/${id}/${season}/${episode}`, "audio");
  }
  return serveMediaChunk(req, res, id, file, season, episode);
});

// 4. Root ID endpoints
router.get("/id/:id/index.m3u8", (req, res) => {
  const season = parseInt(req.query.s || req.query.season) || 0;
  const episode = parseInt(req.query.e || req.query.episode) || 0;
  return serveDirectManifest(req, res, req.params.id, season, episode, `/id/${req.params.id}/movie`, "master");
});
router.get("/id/:id/index.mpd", (req, res) => {
  const season = parseInt(req.query.s || req.query.season) || 0;
  const episode = parseInt(req.query.e || req.query.episode) || 0;
  return serveDirectManifest(req, res, req.params.id, season, episode, `/id/${req.params.id}/movie`, "mpd");
});
router.get("/id/:id", (req, res) => {
  const season = parseInt(req.query.s || req.query.season) || 0;
  const episode = parseInt(req.query.e || req.query.episode) || 0;
  // If opened directly in a Web Browser (HTML address bar request), open the Universal Player Hub
  if (req.headers.accept && req.headers.accept.includes("text/html")) {
    const sQuery = season > 0 ? `&s=${season}&e=${episode}` : "";
    return res.redirect(`/play?id=${req.params.id}${sQuery}`);
  }
  return serveDirectManifest(req, res, req.params.id, season, episode, `/id/${req.params.id}/movie`, "master");
});

// Health check
router.get("/health", async (req, res) => {
  try {
    const token = await client.ensureSession();
    res.json({
      status: "ok",
      authenticated: true,
      defaultLanguage: "hi",
      tokenPreview: token.substring(0, 20) + "...",
      ffmpegAvailable: isFfmpegAvailable(),
      ffmpegPath: findFfmpegExecutable(),
      vlcAvailable: findVlcExecutable() !== null,
      mpvAvailable: findMpvExecutable() !== null,
      mpvPath: findMpvExecutable(),
      userAgent: client.userAgent,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Search
router.get("/search", async (req, res) => {
  try {
    const query = req.query.q || req.query.query;
    if (!query) {
      return res.status(400).json({ error: "Missing search query parameter 'q'" });
    }
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 18;
    const type = parseInt(req.query.type) || 0;

    const results = await client.search(query, page, perPage, type);
    if (Array.isArray(results.items)) {
      results.items.sort((a, b) => {
        if (a.isHindi && !b.isHindi) return -1;
        if (!a.isHindi && b.isHindi) return 1;
        return 0;
      });
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Details
router.get("/details/:id", async (req, res) => {
  try {
    const subjectId = req.params.id;
    const details = await client.getDetails(subjectId);
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Streams
router.get("/streams/:id", async (req, res) => {
  try {
    const subjectId = req.params.id;
    const season = parseInt(req.query.season) || 0;
    const episode = parseInt(req.query.episode) || 0;

    const streamInfo = await client.getStreams(subjectId, season, episode);
    const hostOrigin = getBaseOrigin(req);

    if (Array.isArray(streamInfo.streams)) {
      streamInfo.streams = streamInfo.streams.map((s) => {
        const isMpd = s.streamUrl.includes(".mpd") || s.format === "DASH";
        const proxyUrl = isMpd
          ? (season > 0
              ? `${hostOrigin}/id/${subjectId}/${season}/${episode}/index.m3u8`
              : `${hostOrigin}/id/${subjectId}/movie/index.m3u8`)
          : s.streamUrl;

        return {
          ...s,
          streamUrl: proxyUrl,
          rawStreamUrl: s.streamUrl,
          proxyManifestUrl: proxyUrl,
          playlistDownloadUrl: `${hostOrigin}/api/playlist.m3u8?url=${encodeURIComponent(
            proxyUrl
          )}&title=${encodeURIComponent(streamInfo.cleanTitle || "MovieBox")}`,
        };
      });
    }

    res.json({
      ...streamInfo,
      defaultLanguage: "hi",
      hasMpv: findMpvExecutable() !== null,
      hasVlc: findVlcExecutable() !== null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Playlist Download
router.get("/playlist.m3u8", (req, res) => {
  const { url, title = "MovieBox Stream" } = req.query;
  if (!url) {
    return res.status(400).send("Missing url parameter");
  }
  const cleanTitle = decodeURIComponent(title).replace(/[\r\n]+/g, " ");
  const playlist = `#EXTM3U\n#EXTINF:-1,${cleanTitle}\n${url}\n`;
  res.setHeader("Content-Type", "application/x-mpegURL; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${cleanTitle.replace(/[^a-zA-Z0-9_\-]/g, "_")}.m3u8"`
  );
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(playlist);
});


// =============================================================
// 📱 UNIVERSAL PLAYER LAUNCHER & HUB (MX Player, VLC, Browser)
// =============================================================


function renderPlayerHubHtml({ title, streamUrl, hlsUrl, dashUrl, m3uUrl, autoLaunch = null, id = "", isSeries = false, s = 0, e = 0, hostOrigin = "" }) {
  const cleanTitle = String(title || "MovieBox Stream").replace(/[\r\n"']+/g, " ");
  const activeHlsUrl = hlsUrl || streamUrl;
  const activeDashUrl = dashUrl || streamUrl;
  
  let scheme = "http";
  let cleanHostAndPath = activeHlsUrl;
  try {
    const parsed = new URL(activeHlsUrl);
    scheme = parsed.protocol.replace(":", "");
    cleanHostAndPath = activeHlsUrl.replace(/^https?:\/\//i, "");
  } catch (_) {}

  // Android Chrome Intent & VLC link formats
  const mxIntent = `intent://${cleanHostAndPath}#Intent;scheme=${scheme};package=com.mxtech.videoplayer.ad;type=video/*;S.title=${encodeURIComponent(cleanTitle)};end`;
  const mxProIntent = `intent://${cleanHostAndPath}#Intent;scheme=${scheme};package=com.mxtech.videoplayer.pro;type=video/*;S.title=${encodeURIComponent(cleanTitle)};end`;
  const vlcIntent = `intent://${cleanHostAndPath}#Intent;scheme=${scheme};package=org.videolan.vlc;action=android.intent.action.VIEW;type=video/*;S.title=${encodeURIComponent(cleanTitle)};end`;
  const chooserIntent = `intent://${cleanHostAndPath}#Intent;scheme=${scheme};action=android.intent.action.VIEW;type=video/*;S.title=${encodeURIComponent(cleanTitle)};end`;
  const directVlcUri = `vlc://${activeHlsUrl}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${cleanTitle} - MovieBox Stream Player</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <script src="https://cdn.jsdelivr.net/npm/dashjs@latest/dist/dash.all.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #070a11; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 20px; padding: 24px 20px; max-width: 640px; width: 100%; text-align: center; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.8); }
    .badge { display: inline-block; background: rgba(16, 185, 129, 0.15); color: #10b981; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; margin-bottom: 10px; border: 1px solid rgba(16, 185, 129, 0.3); }
    h1 { font-size: 20px; font-weight: 800; color: #f8fafc; margin-bottom: 6px; line-height: 1.3; }
    .sub { color: #94a3b8; font-size: 13px; margin-bottom: 16px; }
    .player-container { position: relative; width: 100%; padding-top: 56.25%; background: #000; border-radius: 14px; overflow: hidden; margin-bottom: 16px; border: 1px solid #334155; }
    .player-container video { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; }
    .player-overlay-msg { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(0,0,0,0.8); color: #fff; font-size: 14px; z-index: 5; padding: 20px; }
    .player-overlay-msg.hidden { display: none; }
    .spinner-sm { width: 32px; height: 32px; border: 3px solid #334155; border-top-color: #e50914; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 10px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .btn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 12px 0; }
    .btn { display: flex; align-items: center; justify-content: center; width: 100%; padding: 12px; border-radius: 10px; font-size: 14px; font-weight: 700; text-decoration: none; color: #fff; border: none; cursor: pointer; transition: all 0.15s ease; gap: 8px; }
    .btn:active { transform: scale(0.98); }
    .btn-play-now { background: linear-gradient(135deg, #e50914, #b91c1c); grid-column: 1 / -1; padding: 14px; font-size: 15px; }
    .btn-mx { background: linear-gradient(135deg, #2563eb, #1d4ed8); }
    .btn-vlc { background: linear-gradient(135deg, #ea580c, #c2410c); }
    .btn-chooser { background: #334155; grid-column: 1 / -1; }
    .btn-copy { background: #1e293b; border: 1px solid #475569; color: #cbd5e1; font-size: 13px; padding: 10px; margin-top: 10px; }
    .url-box { margin-top: 8px; padding: 10px; background: #020617; border: 1px solid #1e293b; border-radius: 8px; font-size: 11px; word-break: break-all; color: #94a3b8; user-select: all; text-align: left; }
    .toast { display: none; position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #10b981; color: #fff; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; box-shadow: 0 4px 12px rgba(0,0,0,0.5); z-index: 1000; }
    .status-badge { font-size: 11px; color: #10b981; display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; }
    .status-dot { width: 6px; height: 6px; background: #10b981; border-radius: 50%; display: inline-block; box-shadow: 0 0 6px #10b981; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${isSeries ? `SEASON ${s} • EPISODE ${e}` : "MOVIE STREAM"} • HINDI PRIORITY 🇮🇳</div>
    <h1>${cleanTitle}</h1>
    <div class="status-badge"><span class="status-dot"></span> Streaming Engine Ready (HLS / DASH Adaptive)</div>

    <div class="player-container" style="margin-top: 14px;">
      <video id="videoPlayer" controls playsinline preload="auto" poster=""></video>
      <div id="playerLoading" class="player-overlay-msg hidden">
        <div class="spinner-sm"></div>
        <p id="playerLoadingText">Connecting to Stream...</p>
      </div>
    </div>

    <div class="btn-grid">
      <button class="btn btn-play-now" id="btnPlayInBrowser" onclick="startBrowserPlayback()">▶ Reload / Play in Browser</button>
      <button class="btn btn-mx" id="btn-mx" onclick="launchMxPlayer()">🎬 MX Player</button>
      <button class="btn btn-vlc" id="btn-vlc" onclick="launchVlcPlayer()">🍿 VLC Player</button>
      <a class="btn btn-chooser" href="${chooserIntent}">📱 Open in Any External Player</a>
    </div>

    <button class="btn btn-copy" onclick="copyStreamUrl()">📋 Copy Direct Stream Link</button>
    <div class="url-box" id="url-box">${activeHlsUrl}</div>

    ${m3uUrl ? `<a href="${m3uUrl}" style="display:inline-block; margin-top:12px; color:#38bdf8; font-size:13px; text-decoration:none;">📥 Download .M3U Playlist File</a>` : ""}
  </div>

  <div class="toast" id="toast">✅ Stream Link Copied to Clipboard!</div>

  <script>
    const hlsUrl = "${activeHlsUrl}";
    const dashUrl = "${activeDashUrl}";
    const auto = "${autoLaunch || ""}";
    const mxIntent = "${mxIntent}";
    const mxProIntent = "${mxProIntent}";
    const vlcIntent = "${vlcIntent}";
    const directVlcUri = "${directVlcUri}";
    const chooserIntent = "${chooserIntent}";

    function launchMxPlayer() {
      // Try free MX Player intent, then fallback to chooser
      window.location.href = mxIntent;
      setTimeout(() => {
        window.location.href = mxProIntent;
      }, 500);
      setTimeout(() => {
        window.location.href = chooserIntent;
      }, 1000);
    }

    function launchVlcPlayer() {
      // Try direct vlc:// URL then Android intent
      window.location.href = directVlcUri;
      setTimeout(() => {
        window.location.href = vlcIntent;
      }, 500);
    }

    // Auto-launch external player if triggered
    if (auto === "mx") {
      setTimeout(launchMxPlayer, 200);
    } else if (auto === "vlc") {
      setTimeout(launchVlcPlayer, 200);
    }

    function showLoading(msg) {
      const el = document.getElementById("playerLoading");
      const txt = document.getElementById("playerLoadingText");
      if (el && txt) {
        txt.innerText = msg || "Loading video stream...";
        el.classList.remove("hidden");
      }
    }

    function hideLoading() {
      const el = document.getElementById("playerLoading");
      if (el) el.classList.add("hidden");
    }

    function startBrowserPlayback() {
      const video = document.getElementById("videoPlayer");
      showLoading("Initializing HLS stream engine...");

      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }
      if (dashInstance) {
        dashInstance.reset();
        dashInstance = null;
      }

      // 1. Try HLS.js
      if (window.Hls && Hls.isSupported()) {
        hlsInstance = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 90,
        });

        hlsInstance.loadSource(hlsUrl);
        hlsInstance.attachMedia(video);

        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          hideLoading();
          video.play().catch(() => {});
        });

        hlsInstance.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            console.warn("HLS fatal error, trying DASH fallback:", data);
            hlsInstance.destroy();
            hlsInstance = null;
            tryDashPlayback();
          }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Native Safari HLS
        video.src = hlsUrl;
        video.addEventListener("loadedmetadata", () => {
          hideLoading();
          video.play().catch(() => {});
        });
        video.addEventListener("error", () => {
          tryDashPlayback();
        });
      } else {
        tryDashPlayback();
      }
    }

    function tryDashPlayback() {
      const video = document.getElementById("videoPlayer");
      showLoading("Switching to DASH engine...");

      if (window.dashjs) {
        try {
          dashInstance = dashjs.MediaPlayer().create();
          dashInstance.initialize(video, dashUrl, true);
          dashInstance.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
            hideLoading();
            video.play().catch(() => {});
          });
          dashInstance.on(dashjs.MediaPlayer.events.ERROR, (e) => {
            console.error("DASH error:", e);
            hideLoading();
          });
        } catch (e) {
          hideLoading();
          console.error("DASH init error:", e);
        }
      } else {
        hideLoading();
        video.src = hlsUrl;
        video.play().catch(() => {});
      }
    }

    function copyStreamUrl() {
      const url = document.getElementById("url-box").innerText;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(showToast);
      } else {
        showToast();
      }
    }

    function showToast() {
      const t = document.getElementById("toast");
      t.style.display = "block";
      setTimeout(() => { t.style.display = "none"; }, 2500);
    }

    // Auto-start video player on load
    document.addEventListener("DOMContentLoaded", () => {
      startBrowserPlayback();
    });
  </script>
</body>
</html>`;
}


// 0. Universal Player Hub Landing Page
router.get(["/play", "/play/hub"], (req, res) => {
  const { id, s = 0, e = 0, title = "MovieBox Stream", url, auto, q, rep, quality } = req.query;
  const hostOrigin = getBaseOrigin(req);
  const isSeries = parseInt(s) > 0;
  const repId = rep || q || quality;
  const qQuery = (repId !== undefined && repId !== null && repId !== "auto" && repId !== "") ? `?q=${repId}` : "";
  
  const hlsPath = isSeries ? `/id/${id}/${s}/${e}/index.m3u8${qQuery}` : `/id/${id}/movie/index.m3u8${qQuery}`;
  const dashPath = isSeries ? `/id/${id}/${s}/${e}/index.mpd` : `/id/${id}/movie/index.mpd`;
  
  const hlsUrl = url || (id ? `${hostOrigin}${hlsPath}` : "");
  const dashUrl = id ? `${hostOrigin}${dashPath}` : hlsUrl;
  const qParam = repId ? `&q=${repId}` : "";
  const m3uUrl = id ? `${hostOrigin}/play/playlist.m3u?id=${id}&s=${s}&e=${e}${qParam}&title=${encodeURIComponent(title)}` : null;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderPlayerHubHtml({
    title,
    streamUrl: hlsUrl,
    hlsUrl,
    dashUrl,
    m3uUrl,
    autoLaunch: auto,
    id,
    isSeries,
    s: parseInt(s),
    e: parseInt(e),
    hostOrigin
  }));
});

// 1. MX Player Deep Link Handler
router.get("/play/mx", (req, res) => {
  const { id, s = 0, e = 0, title = "MovieBox Stream", url, q, rep, quality } = req.query;
  const hostOrigin = getBaseOrigin(req);
  const isSeries = parseInt(s) > 0;
  const repId = rep || q || quality;
  const qQuery = (repId !== undefined && repId !== null && repId !== "auto" && repId !== "") ? `?q=${repId}` : "";

  const hlsPath = isSeries ? `/id/${id}/${s}/${e}/index.m3u8${qQuery}` : `/id/${id}/movie/index.m3u8${qQuery}`;
  const dashPath = isSeries ? `/id/${id}/${s}/${e}/index.mpd` : `/id/${id}/movie/index.mpd`;
  const hlsUrl = url || (id ? `${hostOrigin}${hlsPath}` : "");
  const dashUrl = id ? `${hostOrigin}${dashPath}` : hlsUrl;
  const qParam = repId ? `&q=${repId}` : "";
  const m3uUrl = id ? `${hostOrigin}/play/playlist.m3u?id=${id}&s=${s}&e=${e}${qParam}&title=${encodeURIComponent(title)}` : null;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderPlayerHubHtml({
    title,
    streamUrl: hlsUrl,
    hlsUrl,
    dashUrl,
    m3uUrl,
    autoLaunch: "mx",
    id,
    isSeries,
    s: parseInt(s),
    e: parseInt(e),
    hostOrigin
  }));
});

// 2. VLC Player Deep Link Handler
router.get("/play/vlc", (req, res) => {
  const { id, s = 0, e = 0, title = "MovieBox Stream", url, q, rep, quality } = req.query;
  const hostOrigin = getBaseOrigin(req);
  const isSeries = parseInt(s) > 0;
  const repId = rep || q || quality;
  const qQuery = (repId !== undefined && repId !== null && repId !== "auto" && repId !== "") ? `?q=${repId}` : "";

  const hlsPath = isSeries ? `/id/${id}/${s}/${e}/index.m3u8${qQuery}` : `/id/${id}/movie/index.m3u8${qQuery}`;
  const dashPath = isSeries ? `/id/${id}/${s}/${e}/index.mpd` : `/id/${id}/movie/index.mpd`;
  const hlsUrl = url || (id ? `${hostOrigin}${hlsPath}` : "");
  const dashUrl = id ? `${hostOrigin}${dashPath}` : hlsUrl;
  const qParam = repId ? `&q=${repId}` : "";
  const m3uUrl = id ? `${hostOrigin}/play/playlist.m3u?id=${id}&s=${s}&e=${e}${qParam}&title=${encodeURIComponent(title)}` : null;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderPlayerHubHtml({
    title,
    streamUrl: hlsUrl,
    hlsUrl,
    dashUrl,
    m3uUrl,
    autoLaunch: "vlc",
    id,
    isSeries,
    s: parseInt(s),
    e: parseInt(e),
    hostOrigin
  }));
});

// 3. M3U Playlist File Download (Double-click/Tap to open in MX Player / VLC on Android & PC)
router.get("/play/playlist.m3u", (req, res) => {
  const { id, s = 0, e = 0, title = "MovieBox Stream", url, q, rep, quality } = req.query;
  const hostOrigin = getBaseOrigin(req);
  let fullStreamUrl = url;
  if (!fullStreamUrl) {
    if (!id) return res.status(400).send("Missing id or url");
    const isSeries = parseInt(s) > 0;
    const repId = rep || q || quality;
    const qQuery = (repId !== undefined && repId !== null && repId !== "auto" && repId !== "") ? `?q=${repId}` : "";
    const streamPath = isSeries ? `/id/${id}/${s}/${e}/index.m3u8${qQuery}` : `/id/${id}/movie/index.m3u8${qQuery}`;
    fullStreamUrl = `${hostOrigin}${streamPath}`;
  }
  const cleanTitle = decodeURIComponent(title).replace(/[\r\n]+/g, " ");

  const playlist = `#EXTM3U\n#EXTINF:-1,${cleanTitle}\n${fullStreamUrl}\n`;
  res.setHeader("Content-Type", "audio/x-mpegurl; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${cleanTitle.replace(/[^a-zA-Z0-9_\-]/g, "_")}.m3u"`
  );
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(playlist);
});

// Launch Player
router.post("/launch-player", (req, res) => {
  try {
    const {
      streamUrl,
      signCookie,
      player = "mpv",
      title = "MovieBox",
      language = "hi",
    } = req.body;

    if (!streamUrl) {
      return res.status(400).json({ error: "Missing streamUrl" });
    }

    let exe = null;
    let args = [];

    const audioLangList =
      language.toLowerCase() === "hi"
        ? "hi,hin,hindi,en,eng"
        : `${language.toLowerCase()},hi,hin,en,eng`;

    const subLangList =
      language.toLowerCase() === "hi"
        ? "hi,hin,hindi,en,eng"
        : `${language.toLowerCase()},hi,hin,en,eng`;

    if (player.toLowerCase() === "mpv") {
      exe = findMpvExecutable();
      if (!exe) {
        return res.json({
          success: false,
          launched: false,
          message: "MPV copied to clipboard! Paste in your terminal.",
        });
      }

      args = [
        `--user-agent=${client.userAgent}`,
        `--referrer=https://sportslive.wine`,
        `--title=${title}`,
        `--alang=${audioLangList}`,
        `--slang=${subLangList}`,
        `--force-window=immediate`,
      ];
      if (signCookie) {
        args.push(`--http-header-fields=Cookie: ${signCookie}`);
        args.push(
          `--ytdl-raw-options=add-header=Referer:https://sportslive.wine,add-header=Cookie:${signCookie},add-header=User-Agent:${client.userAgent}`
        );
      }
      args.push(streamUrl);
    } else if (player.toLowerCase() === "mx") {
      exe = findAmExecutable();
      if (!exe) {
        return res.json({
          success: false,
          launched: false,
          message: "MX Player requires Android or Termux Activity Manager (am).",
        });
      }
      const headersExtra = [
        `User-Agent:${client.userAgent}`,
        `Referer:https://sportslive.wine`,
      ];
      if (signCookie) {
        headersExtra.push(`Cookie:${signCookie}`);
      }
      args = [
        "start",
        "-a", "android.intent.action.VIEW",
        "-d", streamUrl,
        "-t", "video/*",
        "-e", "title", title,
        "--esa", "headers", headersExtra.join(","),
      ];
    } else {
      exe = findVlcExecutable();
      if (!exe) {
        return res.json({
          success: false,
          launched: false,
          message: "VLC not found on server.",
        });
      }
      const hostOrigin = getBaseOrigin(req);
      const isMpd = streamUrl.includes(".mpd");
      const proxyStreamUrl = isMpd
        ? `${hostOrigin}/id/${title}/movie/index.m3u8`
        : streamUrl;

      args = [
        proxyStreamUrl,
        `--meta-title=${title}`,
        `--audio-language=hi,hin,en`,
        `--sub-language=hi,hin,en`,
      ];
    }

    const proc = spawn(exe, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });

    proc.on("error", (err) => {
      console.error(`[Launcher Error] Failed to launch ${exe}:`, err.message);
    });

    proc.unref();

    res.json({
      success: true,
      launched: true,
      message: `Launched in ${player.toUpperCase()}`,
      executable: exe,
      language,
    });
  } catch (err) {
    res.status(500).json({ error: `Launch failed: ${err.message}` });
  }
});

module.exports = router;
