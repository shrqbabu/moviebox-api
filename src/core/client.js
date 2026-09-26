const {
  buildSignedHeaders,
  generateDeviceProfile,
  randomSpoofedIp,
  resolveDashManifestFromPolicy,
  isDeprecationNoticeUrl,
  cleanMovieBoxTitle,
} = require("./crypto");
const { MovieBoxSession } = require("./session");

const HOST_POOL = [
  "https://api6.aoneroom.com",
  "https://api5.aoneroom.com",
  "https://api4.aoneroom.com",
  "https://api4sg.aoneroom.com",
  "https://api3.aoneroom.com",
  "https://api6sg.aoneroom.com",
  "https://api.inmoviebox.com",
];

const RETRY_STATUS_CODES = [403, 406, 407, 429, 500, 502, 503, 504];

class MovieBoxClient {
  constructor(options = {}) {
    const profile = generateDeviceProfile();
    this.userAgent = options.userAgent || profile.userAgent;
    this.clientInfo = options.clientInfo || profile.clientInfo;
    this.spoofedIp = options.spoofedIp || randomSpoofedIp();
    this.session = null;
    this.activeHostIndex = 0;
    this.initPromise = null;
  }

  /**
   * Ensures a valid session token exists
   */
  async ensureSession() {
    if (this.session && this.session.isValid()) {
      return this.session.token;
    }

    const cached = MovieBoxSession.load();
    if (cached && cached.isValid()) {
      this.session = cached;
      return this.session.token;
    }

    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          const fresh = await this.fetchFreshSession();
          this.session = fresh;
          fresh.save();
          return fresh.token;
        } finally {
          this.initPromise = null;
        }
      })();
    }

    return await this.initPromise;
  }

  /**
   * Fetches fresh visitor session token
   */
  async fetchFreshSession() {
    const path = "/wefeed-mobile-bff/user-api/visitor-login";
    const bodyStr = "{}";
    const res = await this.requestAcrossHosts("POST", path, bodyStr, null);
    const data = res?.data || res;
    const token = data?.token;
    if (!token || !token.trim()) {
      throw new Error("Failed to obtain visitor token from MovieBox API");
    }
    const uid = data?.uid || data?.userId;
    return MovieBoxSession.fromToken(
      token,
      uid ? String(uid) : null
    );
  }

  /**
   * Invalidates current session
   */
  invalidateSession() {
    this.session = null;
    MovieBoxSession.clear();
  }

  /**
   * Absorbs session updates from response x-user header
   */
  absorbXUser(headers) {
    const xUser = headers.get("x-user");
    if (!xUser) return;
    try {
      const json = JSON.parse(xUser);
      const token = json.token;
      if (token && typeof token === "string" && token.trim().length > 0) {
        const uid = json.uid || json.userId;
        const session = MovieBoxSession.fromToken(
          token,
          uid ? String(uid) : null
        );
        this.session = session;
        session.save();
      }
    } catch (e) {}
  }

  /**
   * Executes HTTP request with automatic host failover and retry
   */
  async requestAcrossHosts(method, pathAndQuery, bodyStr, authToken) {
    const startIdx = this.activeHostIndex;
    let lastError = null;

    for (let i = 0; i < HOST_POOL.length; i++) {
      const idx = (startIdx + i) % HOST_POOL.length;
      const host = HOST_POOL[idx];
      const fullUrl = `${host}${pathAndQuery}`;

      const headers = buildSignedHeaders({
        method,
        url: fullUrl,
        body: bodyStr,
        authToken,
        userAgent: this.userAgent,
        clientInfo: this.clientInfo,
        spoofedIp: this.spoofedIp,
      });

      try {
        const response = await fetch(fullUrl, {
          method,
          headers,
          body: bodyStr || undefined,
          signal: AbortSignal.timeout(12000),
        });

        this.absorbXUser(response.headers);
        const status = response.status;

        if (RETRY_STATUS_CODES.includes(status)) {
          lastError = new Error(`Host ${host} returned status ${status}`);
          continue;
        }

        if (!response.ok) {
          throw new Error(`API error HTTP ${status}: ${response.statusText}`);
        }

        this.activeHostIndex = idx;
        const json = await response.json();
        return json;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error("All MovieBox API hosts exhausted");
  }

  /**
   * Main authenticated API request handler with session auto-refresh
   */
  async apiRequest(method, pathAndQuery, body = null) {
    let token = await this.ensureSession();
    const bodyStr = body ? (typeof body === "string" ? body : JSON.stringify(body)) : null;

    try {
      const res = await this.requestAcrossHosts(method, pathAndQuery, bodyStr, token);
      return res?.data !== undefined ? res.data : res;
    } catch (err) {
      if (err.message.includes("401") || err.message.includes("403") || err.message.includes("exhausted")) {
        this.invalidateSession();
        token = await this.ensureSession();
        const res = await this.requestAcrossHosts(method, pathAndQuery, bodyStr, token);
        return res?.data !== undefined ? res.data : res;
      }
      throw err;
    }
  }

  /**
   * Search catalog for Movies and TV Series
   */
  async search(query, page = 1, perPage = 15, subjectType = 0) {
    const payload = {
      keyword: query,
      page,
      perPage,
      subjectType,
    };
    const data = await this.apiRequest(
      "POST",
      "/wefeed-mobile-bff/subject-api/search/v2",
      payload
    );

    let rawList = [];
    if (Array.isArray(data?.results) && data.results.length > 0) {
      for (const res of data.results) {
        if (Array.isArray(res.subjects)) {
          rawList.push(...res.subjects);
        }
      }
    } else if (Array.isArray(data?.list)) {
      rawList = data.list;
    } else if (Array.isArray(data)) {
      rawList = data;
    }

    const items = rawList.map((item) => this.formatCatalogItem(item)).filter(Boolean);
    return {
      query,
      page,
      total: data?.pager?.total || items.length,
      items,
    };
  }

  /**
   * Get detailed metadata for Movie or Series (including language/dubs)
   */
  async getDetails(subjectId) {
    const data = await this.apiRequest(
      "GET",
      `/wefeed-mobile-bff/subject-api/get?subjectId=${subjectId}`
    );

    const stype = data.subjectType || data.stype || 1;
    let seasons = [];

    if (stype === 2) {
      try {
        const seasonInfo = await this.apiRequest(
          "GET",
          `/wefeed-mobile-bff/subject-api/season-info?subjectId=${subjectId}`
        );
        seasons = seasonInfo?.seasons || seasonInfo || [];
      } catch (e) {}
    }

    // Parse audio dubs / language variants
    const dubsList = [];
    const rawDubs = data.dubs || data.dubList || [];
    if (Array.isArray(rawDubs)) {
      for (const d of rawDubs) {
        const dubSubjectId = String(d.subjectId || d.id || "");
        if (!dubSubjectId) continue;
        const lanName = d.lanName || d.language || d.lang || "Audio";
        const lanCode = (d.lanCode || d.lan || lanName).toLowerCase();
        dubsList.push({
          subjectId: dubSubjectId,
          languageName: lanName,
          languageCode: lanCode,
          isOriginal: !!d.original,
          isHindi: lanCode === "hi" || lanName.toLowerCase().includes("hindi"),
        });
      }
    }

    // If current subject is marked as Hindi or has Hindi in title
    const currentIsHindi =
      String(data.title || "").toLowerCase().includes("hindi") ||
      String(data.language || "").toLowerCase().includes("hindi");

    const coverUrl =
      (typeof data.cover === "object" ? data.cover?.url : data.cover) ||
      data.coverUrl ||
      data.posterUrl ||
      data.poster ||
      null;

    return {
      id: String(data.subjectId || data.id || subjectId),
      subjectId: String(data.subjectId || data.id || subjectId),
      title: data.title || data.name || "Unknown",
      cleanTitle: cleanMovieBoxTitle(data.title || data.name || ""),
      type: stype === 2 ? "series" : "movie",
      subjectType: stype,
      year: data.releaseDate || data.year || data.releaseInfo || null,
      rating: data.score || data.rating || null,
      cover: coverUrl,
      poster: coverUrl,
      posterUrl: coverUrl,
      backdrop: coverUrl,
      posters: coverUrl ? [coverUrl] : [],
      backdrops: coverUrl ? [coverUrl] : [],
      description: data.description || data.synopsis || data.intro || "",
      genres: data.genres || data.genreNames || [],
      country: data.country || data.region || null,
      duration: data.duration || null,
      actors: data.actors || data.cast || [],
      directors: data.directors || [],
      language: data.language || null,
      dubs: dubsList,
      isHindi: currentIsHindi,
      seasons: Array.isArray(seasons) ? seasons : [],
      raw: data,
    };
  }

  /**
   * Get Play Info & Stream details
   */
  async getPlayInfo(subjectId, season = 0, episode = 0) {
    const path =
      season === 0 && episode === 0
        ? `/wefeed-mobile-bff/subject-api/play-info/v2?subjectId=${subjectId}`
        : `/wefeed-mobile-bff/subject-api/play-info/v2?subjectId=${subjectId}&se=${season}&ep=${episode}`;

    return await this.apiRequest("GET", path);
  }

  /**
   * High-level stream extraction
   */
  async getStreams(subjectId, season = 0, episode = 0) {
    const playInfo = await this.getPlayInfo(subjectId, season, episode);
    const data = playInfo?.data || playInfo || {};
    const title = data.title || "MovieBox Stream";
    const cleanTitle = cleanMovieBoxTitle(title);

    const rawStreams = Array.isArray(data.streams) ? data.streams : [];
    const releases = [];

    for (const stream of rawStreams) {
      const streamId = String(stream.id || "");
      const formatType = stream.format || "MP4";
      const codec = stream.codecName || stream.codec || "";
      const sizeBytes = stream.size ? Number(stream.size) : null;
      const resolutionsStr = stream.resolutions || data.displayResolutions || "1080,720,480";
      const signCookie = stream.signCookie || "";
      const rawUrl = stream.url || "";

      let playableUrl = resolveDashManifestFromPolicy(signCookie);
      if (!playableUrl) {
        if (!isDeprecationNoticeUrl(rawUrl) && rawUrl.startsWith("http")) {
          playableUrl = rawUrl;
        }
      }

      if (!playableUrl) continue;

      const isDash = playableUrl.endsWith(".mpd") || formatType.toUpperCase() === "DASH";
      const isHls = playableUrl.endsWith(".m3u8") || formatType.toUpperCase() === "HLS";

      const headers = {
        Referer: "https://sportslive.wine",
        "User-Agent": this.userAgent,
      };

      let cookieHeader = "";
      if (signCookie && signCookie.trim().length > 0) {
        cookieHeader = signCookie
          .replace(/;+$/, "")
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .join("; ");
        headers.Cookie = cookieHeader;
      }

      const resolutions = resolutionsStr
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => !isNaN(n) && n > 0)
        .sort((a, b) => b - a);

      const maxRes = resolutions.length > 0 ? resolutions[0] : 1080;
      const resLabel = isDash ? "Multi-Res (Adaptive)" : `${maxRes}p`;
      const formatLabel = isDash ? "DASH" : isHls ? "HLS" : formatType;

      // Extract subtitles with Hindi auto-flag
      const extCaptions = data.extCaptions || stream.extCaptions || [];
      const subtitles = [];
      const seenSubs = new Set();

      if (Array.isArray(extCaptions)) {
        for (const cap of extCaptions) {
          const capUrl = cap.url;
          if (!capUrl || seenSubs.has(capUrl) || isDeprecationNoticeUrl(capUrl)) continue;
          seenSubs.add(capUrl);
          const lan = cap.lan || cap.lanName || "en";
          subtitles.push({
            name: cap.lanName || cap.lan || "Unknown",
            language: lan,
            isHindi: lan.toLowerCase().includes("hi") || (cap.lanName || "").toLowerCase().includes("hindi"),
            url: capUrl,
          });
        }
      }

      // MPV command following MovieBox-Tui with Hindi preference
      const mpvArgs = [
        `mpv "${playableUrl}"`,
        `--user-agent="${this.userAgent}"`,
        `--referrer="https://sportslive.wine"`,
        `--alang="hi,hin,hindi,en,eng"`,
        `--slang="hi,hin,hindi,en,eng"`,
      ];
      if (cookieHeader) {
        mpvArgs.push(`--http-header-fields="Cookie: ${cookieHeader}"`);
      }
      if (subtitles.length > 0 && subtitles[0].url) {
        mpvArgs.push(`--sub-file="${subtitles[0].url}"`);
      }

      const vlcArgs = [
        `vlc "${playableUrl}"`,
        `--http-referrer="https://sportslive.wine"`,
        `--http-user-agent="${this.userAgent}"`,
      ];

      const mxHeaders = [`User-Agent:${this.userAgent}`, `Referer:https://sportslive.wine`];
      if (cookieHeader) mxHeaders.push(`Cookie:${cookieHeader}`);
      const mxCommand = `am start -a android.intent.action.VIEW -d "${playableUrl}" -t "video/*" -e "title" "${cleanTitle}" --esa "headers" "${mxHeaders.join(",")}"`;

      releases.push({
        id: streamId,
        format: formatLabel,
        isDash,
        isHls,
        resolutions,
        resolutionLabel: resLabel,
        codec: codec || (isDash ? "hevc/h264" : "h264"),
        sizeBytes,
        streamUrl: playableUrl,
        headers,
        signCookie: cookieHeader,
        subtitles,
        commands: {
          mpv: mpvArgs.join(" "),
          vlc: vlcArgs.join(" "),
          mx: mxCommand,
        },
      });
    }

    return {
      subjectId: String(subjectId),
      title,
      cleanTitle,
      season,
      episode,
      streams: releases,
      availableResolutions: data.displayResolutions || "1080,720,480",
    };
  }

  /**
   * Catalog item formatter
   */
  formatCatalogItem(s) {
    if (!s) return null;
    const id = String(s.subjectId || s.id || "");
    if (!id) return null;

    const title = s.title || s.name || "Unknown";
    const stype = s.subjectType || s.stype || 1;
    const isHindi = title.toLowerCase().includes("hindi") || (s.language || "").toLowerCase().includes("hindi");

    let year = null;
    if (s.releaseDate) {
      const match = String(s.releaseDate).match(/\b(19\d\d|20\d\d)\b/);
      if (match) year = match[1];
    } else if (s.year) {
      year = String(s.year);
    }

    const coverUrl =
      (typeof s.cover === "object" ? s.cover?.url : s.cover) ||
      s.coverUrl ||
      s.posterUrl ||
      s.poster ||
      null;

    return {
      id,
      subjectId: id,
      title,
      cleanTitle: cleanMovieBoxTitle(title),
      type: stype === 2 ? "series" : "movie",
      subjectType: stype,
      isHindi,
      year,
      rating: s.score || s.rating || null,
      cover: coverUrl,
      poster: coverUrl,
      posterUrl: coverUrl,
      backdrop: coverUrl,
      description: s.description || s.synopsis || s.intro || "",
      genres: s.genres || s.genreNames || [],
    };
  }
}

module.exports = {
  MovieBoxClient,
  HOST_POOL,
};
