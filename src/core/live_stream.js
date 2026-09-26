const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

// Store channel stream mappings (file-backed for persistence across restarts)
const CHANNELS_FILE = path.join(__dirname, "../../data/channels.json");

// Ensure data directory exists
const dataDir = path.join(__dirname, "../../data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Default pre-configured channels
const defaultChannels = {
  starsports1: {
    id: "starsports1",
    title: "Star Sports 1 Hindi HD",
    upstreamUrl: "https://cloudplay-sonyliv.pages.dev/ten3hd.m3u8",
    referer: "https://sportslive.wine/",
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36",
    updatedAt: Date.now()
  },
  sports18: {
    id: "sports18",
    title: "Sports18 1 Hindi HD",
    upstreamUrl: "https://cloudplay-sonyliv.pages.dev/ten3hd.m3u8",
    referer: "https://sportslive.wine/",
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36",
    updatedAt: Date.now()
  },
  sonyten3: {
    id: "sonyten3",
    title: "Sony Sports Ten 3 HD",
    upstreamUrl: "https://cloudplay-sonyliv.pages.dev/ten3hd.m3u8",
    referer: "https://sportslive.wine/",
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36",
    updatedAt: Date.now()
  },
  willow: {
    id: "willow",
    title: "Willow Cricket HD",
    upstreamUrl: "https://cloudplay-sonyliv.pages.dev/ten3hd.m3u8",
    referer: "https://sportslive.wine/",
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36",
    updatedAt: Date.now()
  }
};

function loadChannels() {
  try {
    if (fs.existsSync(CHANNELS_FILE)) {
      const data = fs.readFileSync(CHANNELS_FILE, "utf8");
      return { ...defaultChannels, ...JSON.parse(data) };
    }
  } catch (e) {
    console.error("⚠️ [LiveStream] Failed to read channels.json:", e.message);
  }
  return { ...defaultChannels };
}

function saveChannels(channels) {
  try {
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2), "utf8");
  } catch (e) {
    console.error("⚠️ [LiveStream] Failed to save channels.json:", e.message);
  }
}

let channels = loadChannels();

class LiveStreamProxy {
  static getChannels() {
    return channels;
  }

  static getChannel(id) {
    return channels[id.toLowerCase()] || null;
  }

  static updateChannel(id, upstreamUrl, referer = "", title = "") {
    const cleanId = id.toLowerCase().trim();
    const existing = channels[cleanId] || {};
    channels[cleanId] = {
      id: cleanId,
      title: title || existing.title || cleanId.toUpperCase(),
      upstreamUrl: upstreamUrl.trim(),
      referer: referer.trim() || existing.referer || "https://sportslive.wine/",
      userAgent: existing.userAgent || "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36",
      updatedAt: Date.now()
    };
    saveChannels(channels);
    console.log(`[LiveStream] Updated channel '${cleanId}' -> ${upstreamUrl}`);
    return channels[cleanId];
  }

  /**
   * Fetches upstream live manifest and rewrites chunk & sub-playlist URLs
   * into permanent proxy URLs pointing to this server.
   */
  static async serveManifest(req, res, channelId, dynamicUrl = "", dynamicReferer = "") {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    req.on("close", () => {
      clearTimeout(timeoutId);
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    try {
      let targetUrl = dynamicUrl;
      let referer = dynamicReferer;
      let userAgent = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36";

      if (!targetUrl) {
        const chan = LiveStreamProxy.getChannel(channelId);
        if (!chan || !chan.upstreamUrl) {
          clearTimeout(timeoutId);
          return res.status(404).send(`Channel '${channelId}' not configured.`);
        }
        targetUrl = chan.upstreamUrl;
        referer = chan.referer;
        userAgent = chan.userAgent;
      }

      const headers = {
        "User-Agent": userAgent,
        "Accept": "*/*",
      };
      if (referer) {
        headers["Referer"] = referer;
      }

      const upstream = await fetch(targetUrl, {
        headers,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!upstream.ok) {
        return res.status(upstream.status).send(`Upstream server returned HTTP ${upstream.status}`);
      }

      const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
      const contentLength = parseInt(upstream.headers.get("content-length") || "0", 10);

      // If upstream is a direct binary video file (MKV/MP4) instead of an M3U8 text playlist
      if (contentType.startsWith("video/") || contentLength > 5 * 1024 * 1024) {
        const hostOrigin = LiveStreamProxy.getHostOrigin(req);
        const chunkUrl = `${hostOrigin}/api/live/chunk?url=${encodeURIComponent(targetUrl)}&ref=${encodeURIComponent(referer)}`;
        let m3u8 = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7200\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:7200.000,Direct Stream\n${chunkUrl}\n#EXT-X-ENDLIST\n`;
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        return res.send(m3u8);
      }

      const manifestText = await upstream.text();
      const hostOrigin = LiveStreamProxy.getHostOrigin(req);
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
      let parentQuery = "";
      try {
        parentQuery = new URL(targetUrl).search;
      } catch (_) {}

      const lines = manifestText.split("\n");
      const rewrittenLines = [];

      for (let line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("#")) {
          // Check for URI inside tag (e.g. #EXT-X-KEY, #EXT-X-MAP)
          if (trimmed.includes('URI="')) {
            const rewrittenTag = trimmed.replace(/URI="([^"]+)"/, (match, uri) => {
              const absoluteUri = LiveStreamProxy.resolveUrl(uri, baseUrl, parentQuery);
              const proxyChunkUrl = `${hostOrigin}/api/live/chunk?url=${encodeURIComponent(absoluteUri)}&ref=${encodeURIComponent(referer)}`;
              return `URI="${proxyChunkUrl}"`;
            });
            rewrittenLines.push(rewrittenTag);
          } else {
            rewrittenLines.push(line);
          }
        } else {
          // This is a segment (.ts / .m4s / .m3u8) URL
          const absoluteUri = LiveStreamProxy.resolveUrl(trimmed, baseUrl, parentQuery);
          let proxyUrl = "";

          if (absoluteUri.includes(".m3u8")) {
            // Nested sub-playlist
            proxyUrl = `${hostOrigin}/api/live/sub.m3u8?url=${encodeURIComponent(absoluteUri)}&ref=${encodeURIComponent(referer)}`;
          } else {
            // Video / Audio Chunk
            proxyUrl = `${hostOrigin}/api/live/chunk?url=${encodeURIComponent(absoluteUri)}&ref=${encodeURIComponent(referer)}`;
          }
          rewrittenLines.push(proxyUrl);
        }
      }

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      return res.send(rewrittenLines.join("\n"));
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError" || controller.signal.aborted) {
        return;
      }
      console.error("[LiveStream Proxy Error]:", err.message);
      if (!res.headersSent) {
        return res.status(500).send(`Live proxy error: ${err.message}`);
      }
    }
  }

  /**
   * High-speed Binary Chunk Proxy (Pipes chunks directly to player with Range support)
   */
  static async serveChunk(req, res) {
    const controller = new AbortController();

    // Cleanly cancel upstream request if client aborts or closes tab/player
    req.on("close", () => {
      if (!res.writableEnded) {
        try { controller.abort(); } catch (_) {}
      }
    });

    try {
      const chunkUrl = req.query.url;
      const referer = req.query.ref || "https://sportslive.wine/";

      if (!chunkUrl) {
        return res.status(400).send("Missing chunk URL parameter");
      }

      const headers = {
        "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36",
        "Referer": referer,
      };
      if (req.headers.range) {
        headers["Range"] = req.headers.range;
      }

      const upstream = await fetch(chunkUrl, {
        headers,
        signal: controller.signal
      });

      if (!upstream.ok && upstream.status !== 206) {
        return res.status(upstream.status).send("Chunk fetch failed");
      }

      res.status(upstream.status);
      for (const [key, val] of upstream.headers.entries()) {
        const k = key.toLowerCase();
        if (!["content-encoding", "transfer-encoding", "access-control-allow-origin", "access-control-allow-headers", "access-control-allow-methods", "access-control-expose-headers"].includes(k)) {
          res.setHeader(key, val);
        }
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Type");
      res.setHeader("Cache-Control", "public, max-age=60");

      if (upstream.body) {
        const nodeStream = Readable.fromWeb(upstream.body);
        nodeStream.on("error", () => {
          if (!res.writableEnded) {
            try { res.end(); } catch (_) {}
          }
        });
        nodeStream.pipe(res);
      } else {
        const buf = await upstream.arrayBuffer();
        res.send(Buffer.from(buf));
      }
    } catch (err) {
      if (err.name === "AbortError" || controller.signal.aborted) {
        return;
      }
      console.error("[Chunk Proxy Error]:", err.message);
      if (!res.headersSent) {
        return res.status(500).send(`Chunk error: ${err.message}`);
      }
    }
  }

  static resolveUrl(relativeUrl, baseUrl, parentQuery = "") {
    let resolved = "";
    if (relativeUrl.startsWith("http://") || relativeUrl.startsWith("https://")) {
      resolved = relativeUrl;
    } else {
      try {
        resolved = new URL(relativeUrl, baseUrl).href;
      } catch (e) {
        resolved = baseUrl + relativeUrl;
      }
    }
    if (parentQuery && !resolved.includes("?")) {
      resolved += parentQuery.startsWith("?") ? parentQuery : "?" + parentQuery;
    }
    return resolved;
  }

  static getHostOrigin(req) {
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || (req.get ? req.get("host") : req.headers["host"]) || "localhost:3000";
    return `${proto}://${host}`;
  }
}

module.exports = {
  LiveStreamProxy
};
