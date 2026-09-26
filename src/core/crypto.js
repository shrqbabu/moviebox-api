const crypto = require("crypto");

const SECRET_KEY_DEFAULT = "76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O";
const SIGNATURE_BODY_MAX_BYTES = 102400;

/**
 * Decodes base64 string with auto padding restoration
 */
function b64Decode(str) {
  if (!str) return Buffer.alloc(0);
  let padded = str;
  const pad = (4 - (padded.length % 4)) % 4;
  if (pad > 0 && pad < 4) {
    padded += "=".repeat(pad);
  }
  return Buffer.from(padded, "base64");
}

/**
 * Calculates MD5 hex digest
 */
function md5Hex(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || "", "utf-8");
  return crypto.createHash("md5").update(buf).digest("hex");
}

/**
 * Generates x-client-token header value
 * Format: {timestamp_ms},{md5(reversed_timestamp_str)}
 */
function generateXClientToken(ts) {
  const tsStr = ts.toString();
  const reversedTs = tsStr.split("").reverse().join("");
  const hashVal = md5Hex(reversedTs);
  return `${tsStr},${hashVal}`;
}

/**
 * Sorts query parameters alphabetically
 */
function sortedQueryString(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const params = Array.from(parsed.searchParams.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    if (params.length === 0) return "";
    return params.map(([k, v]) => `${k}=${v}`).join("&");
  } catch (e) {
    return "";
  }
}

/**
 * Builds canonical string for HMAC signature
 */
function buildCanonicalString(
  method,
  accept,
  contentType,
  urlStr,
  body,
  timestampMs
) {
  let canonicalUrl = urlStr;
  try {
    const parsed = new URL(urlStr);
    const query = sortedQueryString(urlStr);
    canonicalUrl = query ? `${parsed.pathname}?${query}` : parsed.pathname;
  } catch (e) {
    canonicalUrl = urlStr;
  }

  let bodyLength = "";
  let bodyHash = "";
  if (body !== undefined && body !== null) {
    const bodyBuf = Buffer.isBuffer(body)
      ? body
      : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf-8");
    bodyLength = bodyBuf.length.toString();
    const truncated = bodyBuf.subarray(0, SIGNATURE_BODY_MAX_BYTES);
    bodyHash = md5Hex(truncated);
  }

  return [
    method.toUpperCase(),
    accept || "",
    contentType || "",
    bodyLength,
    timestampMs,
    bodyHash,
    canonicalUrl,
  ].join("\n");
}

/**
 * Generates x-tr-signature header
 * Format: {timestamp_ms}|2|{hmac_md5_base64}
 */
function generateXTrSignature(
  method,
  accept,
  contentType,
  urlStr,
  body,
  timestampMs
) {
  const canonical = buildCanonicalString(
    method,
    accept,
    contentType,
    urlStr,
    body,
    timestampMs
  );
  const secretBytes = b64Decode(SECRET_KEY_DEFAULT);
  const hmac = crypto.createHmac("md5", secretBytes);
  hmac.update(Buffer.from(canonical, "utf-8"));
  const sigB64 = hmac.digest("base64");
  return `${timestampMs}|2|${sigB64}`;
}

/**
 * Generates an emulated Android device profile & user agent
 */
function generateDeviceProfile() {
  const versionCodes = [50020117, 50020118, 50020119, 50020120, 50020121];
  const androidVersions = [
    { ver: "9", build: "PQ3A.190605.03081104" },
    { ver: "10", build: "QP1A.191005.007.A3" },
    { ver: "11", build: "RP1A.200720.011" },
    { ver: "12", build: "S1B.220414.015" },
    { ver: "13", build: "TQ2A.230405.003" },
  ];
  const redmiDevices = [
    { brand: "Redmi", model: "23078RKD5C" },
    { brand: "Redmi", model: "2201117TY" },
    { brand: "Redmi", model: "2201117TG" },
    { brand: "Redmi", model: "22101316G" },
    { brand: "Redmi", model: "21121210G" },
    { brand: "Redmi", model: "M2012K11AG" },
    { brand: "Redmi", model: "M2007J20CG" },
  ];
  const networkTypes = ["NETWORK_WIFI", "NETWORK_MOBILE"];
  const timezones = [
    "Asia/Kolkata",
    "Asia/Shanghai",
    "Asia/Tokyo",
    "America/New_York",
    "Europe/London",
  ];

  const vc = versionCodes[Math.floor(Math.random() * versionCodes.length)];
  const av = androidVersions[Math.floor(Math.random() * androidVersions.length)];
  const dev = redmiDevices[Math.floor(Math.random() * redmiDevices.length)];
  const net = networkTypes[Math.floor(Math.random() * networkTypes.length)];
  const tz = timezones[Math.floor(Math.random() * timezones.length)];
  const deviceId = crypto.randomBytes(16).toString("hex");
  const gaid = crypto.randomUUID();

  const userAgent = `com.community.oneroom/${vc} (Linux; U; Android ${av.ver}; en_US; ${dev.model}; Build/${av.build}; Cronet/135.0.7012.3)`;
  const clientInfo = JSON.stringify({
    package_name: "com.community.oneroom",
    version_name: "4.0.01.0813.03",
    version_code: vc,
    os: "android",
    os_version: av.ver,
    install_ch: "ps",
    device_id: deviceId,
    install_store: "ps",
    gaid: gaid,
    brand: dev.brand,
    model: dev.model,
    system_language: "en",
    net: net,
    region: "US",
    timezone: tz,
    sp_code: "40401",
    "X-Play-Mode": "2",
  });

  return { userAgent, clientInfo, version: vc };
}

/**
 * Generates a realistic spoofed client IP
 */
function randomSpoofedIp() {
  const prefixes = [
    "103.241",
    "49.36",
    "117.195",
    "106.198",
    "122.162",
    "157.32",
    "182.70",
    "103.58",
    "27.60",
    "59.90",
  ];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const c = Math.floor(Math.random() * 253 + 1);
  const d = Math.floor(Math.random() * 253 + 1);
  return `${prefix}.${c}.${d}`;
}

/**
 * Builds all signed HTTP headers for a MovieBox API request
 */
function buildSignedHeaders({
  method,
  url,
  body,
  authToken,
  userAgent,
  clientInfo,
  spoofedIp,
}) {
  const ts = Date.now();
  const accept = "application/json";
  const contentType = "application/json";

  const clientToken = generateXClientToken(ts);
  const signature = generateXTrSignature(
    method,
    accept,
    contentType,
    url,
    body,
    ts
  );

  const headers = {
    "User-Agent": userAgent,
    Accept: accept,
    "Content-Type": contentType,
    Connection: "keep-alive",
    "x-client-token": clientToken,
    "x-tr-signature": signature,
    "x-client-info": clientInfo,
    "x-client-status": "0",
    "x-forwarded-for": spoofedIp,
  };

  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  return headers;
}

/**
 * Resolves MPEG-DASH manifest .mpd URL from CloudFront-Policy cookie
 */
function resolveDashManifestFromPolicy(signCookie) {
  if (!signCookie) return null;

  // 1. Check Edge-Cache-Cookie or urlprefix parameter
  const urlPrefixMatch = signCookie.match(/urlprefix=([A-Za-z0-9+/=_-]+)/i);
  if (urlPrefixMatch) {
    let rawPrefix = urlPrefixMatch[1].trim();
    let normalized = rawPrefix.replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (normalized.length % 4)) % 4;
    if (pad > 0 && pad < 4) {
      normalized += "=".repeat(pad);
    }
    try {
      const decoded = Buffer.from(normalized, "base64").toString("utf-8");
      if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
        const baseResource = decoded.replace(/\/+$/, "");
        if (baseResource.endsWith(".mpd") || baseResource.endsWith(".m3u8")) {
          return baseResource;
        }
        return `${baseResource}/index.mpd`;
      }
    } catch (e) {
      // Continue searching
    }
  }

  // 2. Check CloudFront-Policy cookie
  const parts = signCookie.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith("CloudFront-Policy=")) {
      const rawPolicy = trimmed.substring("CloudFront-Policy=".length).trim();
      let normalized = rawPolicy
        .replace(/-/g, "+")
        .replace(/_/g, "=")
        .replace(/~/g, "/");
      const pad = (4 - (normalized.length % 4)) % 4;
      if (pad > 0 && pad < 4) {
        normalized += "=".repeat(pad);
      }
      try {
        const decoded = Buffer.from(normalized, "base64").toString("utf-8");
        const json = JSON.parse(decoded);
        const resource =
          json?.Statement?.[0]?.Resource ||
          (Array.isArray(json?.Statement) && json.Statement[0]?.Resource);
        if (resource && typeof resource === "string") {
          const baseResource = resource.replace(/\*+$/, "").replace(/\/+$/, "");
          if (
            baseResource.startsWith("http://") ||
            baseResource.startsWith("https://")
          ) {
            return `${baseResource}/index.mpd`;
          }
        }
      } catch (e) {
        // Continue searching
      }
    }
  }
  return null;
}

/**
 * Detects if a stream URL is a known deprecation notice video
 */
function isDeprecationNoticeUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes("1c7de0bd3393702d9191801f15f88f8d") ||
    lower.includes("9a0461bc39da389663bf3dbb17091d3f") ||
    lower.includes("/notice.mp4") ||
    lower.includes("notice") ||
    (lower.includes("macdn.aoneroom.com") && lower.includes("/other/"))
  );
}

/**
 * Cleans raw moviebox title (removes quality tags, brackets, dub info, etc.)
 */
function cleanMovieBoxTitle(rawTitle) {
  if (!rawTitle) return "";
  let title = rawTitle.trim();

  while (title.startsWith("[")) {
    const closePos = title.indexOf("]");
    if (closePos !== -1) {
      const remainder = title.substring(closePos + 1).trim();
      if (remainder.length > 0) {
        title = remainder;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  const bracketPos = title.indexOf("[");
  if (bracketPos > 0) {
    title = title.substring(0, bracketPos).trim();
  }

  const parenPos = title.indexOf("(");
  if (parenPos > 0) {
    const inside = title.substring(parenPos + 1);
    const insideContent = inside.split(")")[0].trim();
    const isYear =
      insideContent.length === 4 &&
      /^\d{4}$/.test(insideContent) &&
      Number(insideContent) >= 1900 &&
      Number(insideContent) <= 2099;
    if (!isYear) {
      title = title.substring(0, parenPos).trim();
    }
  }

  const dashPos = title.lastIndexOf(" - ");
  if (dashPos !== -1) {
    const suffix = title.substring(dashPos + 3).toLowerCase();
    const tags = [
      "hindi", "tamil", "telugu", "kannada", "malayalam", "bengali",
      "marathi", "punjabi", "gujarati", "urdu", "english", "spanish",
      "french", "german", "italian", "japanese", "korean", "chinese",
      "russian", "portuguese", "turkish", "arabic", "dub", "audio",
      "multi", "season",
    ];
    if (tags.some((tag) => suffix.includes(tag)) || /^s\d+/.test(suffix)) {
      title = title.substring(0, dashPos).trim();
    }
  }

  const sPos = title.lastIndexOf(" S");
  if (sPos !== -1) {
    const suffix = title.substring(sPos + 2);
    if (/^\d+/.test(suffix)) {
      title = title.substring(0, sPos).trim();
    }
  }

  // Remove trailing resolution patterns like _1080P, .720p, etc.
  title = title.replace(/[_\s.-]+(144|240|360|480|720|1080|2160|4k)[pP]?$/i, "");

  const cleaned = title.replace(/[-:_.\s]+$/, "").trim();
  return cleaned || rawTitle.trim();
}

module.exports = {
  SECRET_KEY_DEFAULT,
  b64Decode,
  md5Hex,
  generateXClientToken,
  sortedQueryString,
  buildCanonicalString,
  generateXTrSignature,
  generateDeviceProfile,
  randomSpoofedIp,
  buildSignedHeaders,
  resolveDashManifestFromPolicy,
  isDeprecationNoticeUrl,
  cleanMovieBoxTitle,
};
