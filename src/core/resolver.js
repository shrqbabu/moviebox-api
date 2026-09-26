const https = require("https");
const { MovieBoxClient } = require("./client");

const client = new MovieBoxClient();
const TMDB_API_KEY = "00cacd3458b56d5218cd6b85411cb547";
const TMDB_ANYCAST_IPS = [
  "13.224.245.92",
  "13.224.245.44",
  "13.224.245.47",
  "13.224.245.63",
  "3.160.188.33",
  "3.160.188.44",
  "3.160.188.49",
  "3.160.188.68",
];

const mediaResolutionCache = new Map();

/**
 * Direct HTTPS request to TMDB bypassing poisoned/blocked Indian ISP DNS
 */
function fetchTmdbDirect(path) {
  return new Promise((resolve) => {
    let settled = false;
    const ip = TMDB_ANYCAST_IPS[Math.floor(Math.random() * TMDB_ANYCAST_IPS.length)];
    const req = https.request(
      {
        host: ip,
        port: 443,
        path: path,
        method: "GET",
        headers: {
          Host: "api.themoviedb.org",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json",
        },
        servername: "api.themoviedb.org",
        timeout: 2500,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          try {
            resolve(JSON.parse(data));
          } catch (_) {
            resolve(null);
          }
        });
      }
    );

    req.on("error", () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });

    req.on("timeout", () => {
      req.destroy();
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });

    req.end();
  });
}

/**
 * Resolves IMDb ID (tt...) or TMDB ID or raw title to MovieBox subjectId & details
 */
async function resolveMediaToSubject(idOrQuery, season = 0) {
  const query = String(idOrQuery).trim();
  if (!query) return null;

  const cacheKey = `${query}_${season}`;
  if (mediaResolutionCache.has(cacheKey)) {
    return mediaResolutionCache.get(cacheKey);
  }

  // 1. Direct MovieBox numeric Subject ID (e.g. 5608459269503862552, 7147213651240699592)
  if (/^\d{15,}$/.test(query)) {
    const res = {
      subjectId: query,
      title: "MovieBox Media",
      type: season > 0 ? "series" : "movie",
    };
    mediaResolutionCache.set(cacheKey, res);
    return res;
  }

  let resolvedTitle = "";
  let resolvedYear = "";
  let resolvedType = season > 0 ? "series" : "movie";

  // 2. IMDb ID Resolution (e.g. tt0848228, tt0903747, tt10676048)
  if (/^tt\d+$/i.test(query)) {
    // Fast Direct TMDB Find by IMDb ID (0.5s - Bypasses DNS blocks)
    try {
      const tmdbData = await fetchTmdbDirect(
        `/3/find/${query}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
      );
      if (tmdbData) {
        if (season > 0 && tmdbData.tv_results && tmdbData.tv_results.length > 0) {
          resolvedTitle = tmdbData.tv_results[0].name || tmdbData.tv_results[0].original_name;
          resolvedYear = (tmdbData.tv_results[0].first_air_date || "").substring(0, 4);
          resolvedType = "series";
        } else if (tmdbData.movie_results && tmdbData.movie_results.length > 0) {
          resolvedTitle = tmdbData.movie_results[0].title || tmdbData.movie_results[0].original_title;
          resolvedYear = (tmdbData.movie_results[0].release_date || "").substring(0, 4);
          resolvedType = "movie";
        } else if (tmdbData.tv_results && tmdbData.tv_results.length > 0) {
          resolvedTitle = tmdbData.tv_results[0].name || tmdbData.tv_results[0].original_name;
          resolvedYear = (tmdbData.tv_results[0].first_air_date || "").substring(0, 4);
          resolvedType = "series";
        }
      }
    } catch (_) {}

    // Fallback to Cinemeta if TMDB did not return
    if (!resolvedTitle) {
      try {
        const type = season > 0 ? "series" : "movie";
        const metaRes = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${query}.json`, {
          signal: AbortSignal.timeout(3000),
        });
        if (metaRes.ok) {
          const sd = await metaRes.json();
          if (sd?.meta?.name) {
            resolvedTitle = sd.meta.name;
            resolvedYear = sd.meta.year;
          }
        }
      } catch (_) {}
    }
  }

  // 3. TMDB ID Resolution (e.g. tmdb:299534 or numeric 299534)
  if (query.startsWith("tmdb:") || (/^\d{1,9}$/.test(query) && !resolvedTitle)) {
    const tmdbId = query.replace(/^tmdb:/, "");
    try {
      const endpoint = season > 0 ? `/3/tv/${tmdbId}` : `/3/movie/${tmdbId}`;
      const d = await fetchTmdbDirect(`${endpoint}?api_key=${TMDB_API_KEY}`);
      if (d) {
        resolvedTitle = d.title || d.name || "";
        resolvedYear = (d.release_date || d.first_air_date || "").substring(0, 4);
      }
    } catch (_) {}
  }

  const searchTerm = resolvedTitle || query.replace(/^(tt|tmdb:)/, "");

  // Search MovieBox catalog
  const searchRes = await client.search(searchTerm, 1, 15);
  if (!searchRes.items || searchRes.items.length === 0) {
    return null;
  }

  // Match season if looking for a specific season of series
  let bestMatch = null;
  if (season > 0) {
    const seasonTag = `s${season}`;
    const seasonItem = searchRes.items.find((i) =>
      i.title.toLowerCase().includes(seasonTag)
    );
    if (seasonItem) {
      bestMatch = seasonItem;
    }
  }

  if (!bestMatch) {
    const hindiMatch = searchRes.items.find((i) => i.isHindi);
    bestMatch = hindiMatch || searchRes.items[0];
  }

  let finalSubjectId = bestMatch.id;
  try {
    const details = await client.getDetails(bestMatch.id);
    const dubList = details.dubs || details.dubAudioList || [];
    if (Array.isArray(dubList) && dubList.length > 0) {
      const hindiDub = dubList.find(
        (d) =>
          d.isHindi ||
          (d.languageName && d.languageName.toLowerCase().includes("hindi")) ||
          (d.language && d.language.toLowerCase().includes("hindi")) ||
          d.languageCode === "hi"
      );
      if (hindiDub) {
        finalSubjectId = hindiDub.subjectId;
      }
    }
  } catch (_) {}

  const result = {
    subjectId: finalSubjectId,
    title: bestMatch.cleanTitle || bestMatch.title,
    type: bestMatch.type,
    isHindi: bestMatch.isHindi,
  };
  mediaResolutionCache.set(cacheKey, result);
  return result;
}

module.exports = {
  resolveMediaToSubject,
  fetchTmdbDirect,
};
