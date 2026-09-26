const crypto = require("crypto");
const { FourKHdHubClient } = require("./fourkhdhub");
const fourKHdClient = new FourKHdHubClient();

class MultiProvider {
  /**
   * Universal resolver: Takes an IMDb ID, TMDB ID or title and queries all active
   * scrapers (VidSrc, 4KHDHub, NxSha) in parallel/cascade to guarantee a valid stream.
   */
  static async resolveAny(idOrTitle, season = 0, episode = 0) {
    const rawId = String(idOrTitle || "").trim();
    if (!rawId) return null;

    const isSeries = season > 0;

    // 1. Provider: 4KHDHub Direct Google CDN (Fast 4K / 1080p Ultra)
    try {
      const cleanTitle = rawId.replace(/^(tt|tmdb:)/i, "").replace(/[-_]/g, " ").trim();
      const fourkStream = await fourKHdClient.resolveMovieStream(cleanTitle);
      if (fourkStream && fourkStream.streamUrl) {
        console.log(`[MultiProvider] ✓ 4KHDHub resolved stream for "${rawId}":`, fourkStream.streamUrl);
        return {
          provider: "4khd",
          streamUrl: fourkStream.streamUrl,
          referer: fourkStream.referer || "https://sportslive.wine/",
          format: "HLS",
          resolution: fourkStream.resolution || "1080p"
        };
      }
    } catch (e) {
      console.warn(`[MultiProvider] 4KHDHub attempt failed for "${rawId}":`, e.message);
    }

    // 2. Provider: VidSrc Buzz Scraper
    try {
      const vidsrcStream = await MultiProvider.resolveVidSrc(rawId, isSeries, season, episode);
      if (vidsrcStream && vidsrcStream.streamUrl) {
        console.log(`[MultiProvider] ✓ VidSrc resolved stream for "${rawId}":`, vidsrcStream.streamUrl);
        return {
          provider: "vidsrc",
          streamUrl: vidsrcStream.streamUrl,
          referer: "https://vidsrc.buzz/",
          format: "HLS",
          resolution: "1080p"
        };
      }
    } catch (e) {
      console.warn(`[MultiProvider] VidSrc attempt failed for "${rawId}":`, e.message);
    }

    // 3. Provider: Slast / Salsa Embed Scraper
    try {
      const salsaStream = await MultiProvider.resolveSalsa(rawId);
      if (salsaStream && salsaStream.streamUrl) {
        console.log(`[MultiProvider] ✓ Salsa resolved stream for "${rawId}":`, salsaStream.streamUrl);
        return {
          provider: "salsa",
          streamUrl: salsaStream.streamUrl,
          referer: "https://slast430did.com/",
          format: "HLS",
          resolution: "1080p"
        };
      }
    } catch (e) {
      console.warn(`[MultiProvider] Salsa attempt failed for "${rawId}":`, e.message);
    }

    // 4. Provider: HighXHD Direct High-Speed MP4 Fallback
    try {
      const highStream = await MultiProvider.resolveHighXhd(rawId);
      if (highStream && highStream.streamUrl) {
        console.log(`[MultiProvider] ✓ HighXHD resolved stream for "${rawId}":`, highStream.streamUrl);
        return {
          provider: "highxhd",
          streamUrl: highStream.streamUrl,
          referer: "https://dl1.highxhd.com/",
          format: "MP4",
          resolution: highStream.resolution || "1080p"
        };
      }
    } catch (e) {
      console.warn(`[MultiProvider] HighXHD attempt failed for "${rawId}":`, e.message);
    }

    return null;
  }

  /**
   * HighXHD Fast MP4 Stream Resolver
   */
  static async resolveHighXhd(idOrTitle) {
    if (!idOrTitle) return null;
    const clean = String(idOrTitle).trim();
    if (clean.includes("highxhd.com") || clean.includes("new_download.php")) {
      return { streamUrl: clean, resolution: "1080p", format: "MP4" };
    }
    return null;
  }

  /**
   * Scrapes direct playable stream from vidsrc.buzz
   */
  static async resolveVidSrc(tmdbOrImdbId, isSeries = false, season = 1, episode = 1) {
    const baseUrl = "https://vidsrc.buzz";
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
    const embedUrl = isSeries
      ? `${baseUrl}/embed/tv/${tmdbOrImdbId}/${season}/${episode}`
      : `${baseUrl}/embed/movie/${tmdbOrImdbId}`;

    const res = await fetch(embedUrl, {
      headers: { "User-Agent": userAgent, "Accept": "text/html" },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return null;

    const html = await res.text();
    const qMatch = html.match(/var\s+Q\s*=\s*(\{.+?\});/s);
    if (!qMatch) return null;

    const qJson = JSON.parse(qMatch[1]);
    const type = qJson.type || (isSeries ? "tv" : "movie");
    const id = qJson.id || tmdbOrImdbId;
    const s = qJson.s || (isSeries ? season : 0);
    const e = qJson.e || (isSeries ? episode : 0);
    const token = qJson.t;

    if (!token) return null;

    const qs = `type=${type}&id=${encodeURIComponent(id)}&s=${s}&e=${e}&t=${encodeURIComponent(token)}`;
    const sourcesRes = await fetch(`${baseUrl}/pl/api.php?a=sources&${qs}`, {
      headers: { "User-Agent": userAgent, "Referer": embedUrl, "Accept": "application/json" },
      signal: AbortSignal.timeout(6000)
    });
    if (!sourcesRes.ok) return null;

    const sourcesJson = await sourcesRes.json();
    const servers = sourcesJson.servers || [];

    for (const srv of servers) {
      if (!srv.ref) continue;
      const playUrl = `${baseUrl}/pl/api.php?a=play&ref=${encodeURIComponent(srv.ref)}&t=${encodeURIComponent(token)}`;
      const playRes = await fetch(playUrl, {
        headers: { "User-Agent": userAgent, "Referer": embedUrl, "Accept": "application/json" },
        signal: AbortSignal.timeout(6000)
      });
      if (!playRes.ok) continue;

      const playJson = await playRes.json().catch(() => null);
      if (playJson && playJson.url) {
        const streamUrl = playJson.url.startsWith("http") ? playJson.url : `${baseUrl}/${playJson.url.replace(/^\//, "")}`;
        return { streamUrl };
      }
    }
    return null;
  }

  /**
   * Scrapes direct playable stream from slast430did.com / salsa436jam
   */
  static async resolveSalsa(imdbId) {
    if (!imdbId || !imdbId.startsWith("tt")) return null;
    const embedUrl = `https://slast430did.com/play/${imdbId}`;
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

    const res = await fetch(embedUrl, {
      headers: { "User-Agent": userAgent, "Referer": "https://vidsrc.to/" },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return null;

    const html = await res.text();
    const configMatch = html.match(/var\s+pl\s*=\s*new\s+HDVBPlayer\((\{[\s\S]*?\})\);/);
    if (!configMatch) return null;

    const config = JSON.parse(configMatch[1]);
    if (config.href && config.file) {
      // Return the salsa host stream base
      return {
        streamUrl: `https://i-arch-400.${config.href}/stream2/i-arch-400/${config.file.replace(/^.*\/playlist\//, "").replace(/\.txt$/, "")}/index.m3u8`
      };
    }
    return null;
  }
}

module.exports = {
  MultiProvider
};
