const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { MultiProvider } = require("./multi_provider");

const MOVIES_FILE = path.join(__dirname, "../../data/movies.json");

// Ensure data directory exists
const dataDir = path.join(__dirname, "../../data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function loadMovies() {
  try {
    if (fs.existsSync(MOVIES_FILE)) {
      const data = fs.readFileSync(MOVIES_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("⚠️ [MovieStream] Failed to read movies.json:", e.message);
  }
  return {};
}

function saveMovies(movies) {
  try {
    fs.writeFileSync(MOVIES_FILE, JSON.stringify(movies, null, 2), "utf8");
  } catch (e) {
    console.error("⚠️ [MovieStream] Failed to save movies.json:", e.message);
  }
}

let customMovies = loadMovies();

class MovieStreamProxy {
  static getMovies() {
    return customMovies;
  }

  static getMovie(id) {
    return customMovies[id.toLowerCase()] || null;
  }

  static updateMovie(id, upstreamUrl, referer = "", title = "") {
    const cleanId = id.toLowerCase().trim();
    const existing = customMovies[cleanId] || {};
    customMovies[cleanId] = {
      id: cleanId,
      title: title || existing.title || cleanId,
      upstreamUrl: upstreamUrl.trim(),
      referer: referer.trim() || existing.referer || "https://sportslive.wine/",
      userAgent: existing.userAgent || "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36",
      updatedAt: Date.now()
    };
    saveMovies(customMovies);
    console.log(`[MovieStream] Updated movie override for '${cleanId}' -> ${upstreamUrl}`);
    return customMovies[cleanId];
  }

  /**
   * Detects if a URL is a direct binary video stream (MKV, MP4, Google CDN, PixelDrain, etc.)
   */
  static isDirectVideoUrl(url = "") {
    if (!url) return false;
    const lower = url.toLowerCase();
    return (
      lower.includes(".mp4") ||
      lower.includes(".mkv") ||
      lower.includes(".webm") ||
      lower.includes(".avi") ||
      lower.includes(".mov") ||
      lower.includes("video-downloads.googleusercontent.com") ||
      lower.includes("pixeldrain.com/api/file") ||
      lower.includes("drive.google.com/uc") ||
      (!lower.includes(".m3u8") && !lower.includes(".mpd") && !lower.includes("/live/"))
    );
  }

  /**
   * Resilient fallback resolver:
   * Multi-provider cascade (4KHDHub, VidSrc, Salsa) to guarantee a non-404 stream.
   */
  static async resolveFallbackMovieStream(idOrTitle, season = 0, episode = 0) {
    if (!idOrTitle) return null;
    return await MultiProvider.resolveAny(idOrTitle, season, episode);
  }

  /**
   * Generates a single-file VOD HLS playlist for direct MP4/MKV video URLs
   * so ExoPlayer / VLC / Web Players can play them natively with CORS support.
   */
  static buildDirectVideoHls(videoUrl, title = "Movie Stream", hostOrigin = "", referer = "") {
    let segmentUrl = videoUrl;
    if (hostOrigin) {
      segmentUrl = `${hostOrigin}/api/live/chunk?url=${encodeURIComponent(videoUrl)}&ref=${encodeURIComponent(referer)}`;
    }
    let m3u8 = `#EXTM3U\n`;
    m3u8 += `#EXT-X-VERSION:3\n`;
    m3u8 += `#EXT-X-TARGETDURATION:7200\n`;
    m3u8 += `#EXT-X-MEDIA-SEQUENCE:1\n`;
    m3u8 += `#EXT-X-PLAYLIST-TYPE:VOD\n`;
    m3u8 += `#EXTINF:7200.000,${title}\n`;
    m3u8 += `${segmentUrl}\n`;
    m3u8 += `#EXT-X-ENDLIST\n`;
    return m3u8;
  }
}

module.exports = {
  MovieStreamProxy
};
