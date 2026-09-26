const fs = require("fs");
const path = require("path");
const os = require("os");

const CACHE_FILE = path.join(os.homedir(), ".moviebox_session.json");

/**
 * Parses JWT token payload claims (userId, exp)
 */
function parseJwtClaims(token) {
  if (!token) return { userId: null, exp: null };
  const parts = token.split(".");
  if (parts.length < 2) return { userId: null, exp: null };

  const payloadB64 = parts[1];
  let normalized = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (normalized.length % 4)) % 4;
  if (pad > 0 && pad < 4) {
    normalized += "=".repeat(pad);
  }

  try {
    const jsonStr = Buffer.from(normalized, "base64").toString("utf-8");
    const json = JSON.parse(jsonStr);
    const userId = json.userId || json.uid || json.sub || null;
    const exp = json.exp ? Number(json.exp) : null;
    return { userId: userId ? String(userId) : null, exp };
  } catch (e) {
    return { userId: null, exp: null };
  }
}

class MovieBoxSession {
  constructor(token, userId = null, expiresAt = null, createdAt = null) {
    this.token = token || "";
    this.userId = userId;
    this.expiresAt = expiresAt;
    this.createdAt = createdAt || Math.floor(Date.now() / 1000);
  }

  static fromToken(token, explicitUid = null) {
    const { userId, exp } = parseJwtClaims(token);
    return new MovieBoxSession(token, explicitUid || userId, exp);
  }

  isValid() {
    if (!this.token || !this.token.trim()) return false;
    const now = Math.floor(Date.now() / 1000);
    if (this.expiresAt) {
      return now + 60 < this.expiresAt;
    }
    return now < this.createdAt + 7 * 24 * 3600;
  }

  save() {
    try {
      const data = {
        token: this.token,
        userId: this.userId,
        expiresAt: this.expiresAt,
        createdAt: this.createdAt,
      };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      // Ignore cache write error
    }
  }

  static load() {
    try {
      if (!fs.existsSync(CACHE_FILE)) return null;
      const content = fs.readFileSync(CACHE_FILE, "utf-8");
      const data = JSON.parse(content);
      const session = new MovieBoxSession(
        data.token,
        data.userId,
        data.expiresAt,
        data.createdAt
      );
      if (session.isValid()) {
        return session;
      }
    } catch (e) {
      // Ignore cache read error
    }
    return null;
  }

  static clear() {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        fs.unlinkSync(CACHE_FILE);
      }
    } catch (e) {}
  }
}

module.exports = {
  MovieBoxSession,
  parseJwtClaims,
};
