/**
 * 4KHDHub scraper & HubCloud Direct Stream Resolver
 * Resolves 4K / 1080p High-Bitrate Direct Google CDN and PixelDrain streams with Dual Audio [Hindi + English]
 */
class FourKHdHubClient {
  constructor() {
    this.baseUrl = "https://4khdhub.one";
    this.userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
  }

  rot13(str) {
    return str.replace(/[a-zA-Z]/g, function (c) {
      return String.fromCharCode(
        (c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26
      );
    });
  }

  decodeHomelander(rawB64) {
    try {
      const d1 = Buffer.from(rawB64, "base64").toString("utf8");
      const d2 = Buffer.from(d1, "base64").toString("utf8");
      const r13 = this.rot13(d2);
      const d3 = Buffer.from(r13, "base64").toString("utf8");
      const json = JSON.parse(d3);
      if (json.o) {
        return Buffer.from(json.o, "base64").toString("utf8");
      }
    } catch (_) {}
    return null;
  }

  async fetchHtml(url, referer = this.baseUrl) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": this.userAgent,
        Referer: referer,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  }

  async search(query) {
    const searchUrl = `${this.baseUrl}/?s=${encodeURIComponent(query)}`;
    const html = await this.fetchHtml(searchUrl);

    const aTags = html.match(/<a\s+[^>]*href=["'][^"']+["'][^>]*>/gi) || [];
    const results = [];

    for (const tag of aTags) {
      if (tag.includes("movie-card") && tag.includes("href=")) {
        const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
        const labelMatch = tag.match(/aria-label=["']([^"']+)["']/i);
        if (hrefMatch) {
          const path = hrefMatch[1];
          const title = labelMatch
            ? labelMatch[1].replace(/\s+details$/i, "").trim()
            : path.replace(/^\/|\/$/g, "").replace(/-/g, " ");
          results.push({
            path,
            url: path.startsWith("http") ? path : `${this.baseUrl}${path}`,
            title,
          });
        }
      }
    }
    return results;
  }

  async getReleases(detailUrl) {
    const html = await this.fetchHtml(detailUrl);
    const downloadLinks = [];

    const linkRegex =
      /href=["'](https?:\/\/(?:greenmotors\.cc|gamerxyt\.com|hubcloud\.[a-z]+)[^"']+)["']/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      if (!downloadLinks.includes(match[1])) {
        downloadLinks.push(match[1]);
      }
    }
    return downloadLinks;
  }

  async resolveDrive(driveUrl) {
    try {
      let currentUrl = driveUrl;

      // Step 1: Handle Greenmotors / Homelander mediator page
      if (currentUrl.includes("greenmotors.cc")) {
        const gmHtml = await this.fetchHtml(currentUrl);
        const sMatch = gmHtml.match(/s\('o',\s*'([^']+)'/);
        if (sMatch) {
          const hubUrl = this.decodeHomelander(sMatch[1]);
          if (hubUrl) {
            currentUrl = hubUrl;
          }
        }
      }

      // Step 2: Handle HubCloud page
      const hubHtml = await this.fetchHtml(currentUrl);
      const gamerMatch = hubHtml.match(
        /href=["'](https?:\/\/(?:gamerxyt\.com|hubcloud\.[a-z]+)\/hubcloud\.php[^"']+)["']/i
      );
      const gamerUrl = gamerMatch ? gamerMatch[1] : currentUrl;

      // Step 3: Handle Gamerxyt / Links page
      const gxHtml = await this.fetchHtml(gamerUrl, currentUrl);

      // Check for Pixel worker redirect or Direct Cloudflare Worker link
      const pixelWorkerMatch = gxHtml.match(
        /href=["'](https?:\/\/(?:pixel\.hubcloud\.[a-z]+|pixel\.[a-z0-9]+\.workers\.dev)[^"']+)["']/i
      );

      if (pixelWorkerMatch) {
        const workerUrl = pixelWorkerMatch[1];
        const res = await fetch(workerUrl, {
          headers: {
            "User-Agent": this.userAgent,
            Referer: gamerUrl,
          },
          redirect: "manual",
        });

        const loc1 = res.headers.get("location");
        if (loc1) {
          const res2 = await fetch(loc1, {
            headers: {
              "User-Agent": this.userAgent,
              Referer: gamerUrl,
            },
            redirect: "manual",
          });

          const loc2 = res2.headers.get("location");
          const finalDlUrl = loc2 || loc1;

          if (finalDlUrl.includes("link=")) {
            const parsed = new URL(finalDlUrl);
            const directVideo = parsed.searchParams.get("link");
            if (directVideo && directVideo.startsWith("http")) {
              return {
                streamUrl: directVideo,
                quality: "4K / 1080p Ultra",
                format: "MKV",
              };
            }
          }
        }
      }

      // Step 4: Check direct worker download links (e.g. workers.dev direct link)
      const directWorkerMatch = gxHtml.match(
        /href=["'](https?:\/\/[^"']*\.workers\.dev\/[^"']+)["']/i
      );
      if (directWorkerMatch) {
        return {
          streamUrl: directWorkerMatch[1],
          quality: "4K / 1080p",
          format: "MKV",
        };
      }

      return null;
    } catch (e) {
      console.error("[4KHDHub Resolver Error]:", e.message);
      return null;
    }
  }

  async resolveMovieStream(query) {
    const searchResults = await this.search(query);
    if (!searchResults || searchResults.length === 0) return null;

    const firstMovie = searchResults[0];
    const driveLinks = await this.getReleases(firstMovie.url);
    if (!driveLinks || driveLinks.length === 0) return null;

    for (const dl of driveLinks.slice(0, 3)) {
      const resolved = await this.resolveDrive(dl);
      if (resolved && resolved.streamUrl) {
        return {
          title: firstMovie.title,
          ...resolved,
        };
      }
    }
    return null;
  }
}

module.exports = { FourKHdHubClient };
