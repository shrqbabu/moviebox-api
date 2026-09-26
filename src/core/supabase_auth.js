const crypto = require("crypto");

/**
 * Supabase & CineFlix OTT User Authentication Service
 * 
 * Verifies user credentials against Supabase GoTrue Auth API (/auth/v1/token?grant_type=password)
 * Matches accounts created in the CineFlix OTT Android/iOS app.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();
const ADMIN_PIN = process.env.ADMIN_PIN || "shrq6396827211";
const BOT_PASSWORD = process.env.BOT_PASSWORD || "shrq98083";
const JWT_SECRET = process.env.APP_SECRET || "cineflix_secret_jwt_salt_2026";

// In-memory active user sessions: token -> { user, expiresAt }
const activeSessions = new Map();

function createSessionToken(user) {
  const payload = {
    sub: user.id || user.email || "user",
    email: user.email || "",
    role: user.role || "user",
    iat: Date.now(),
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
  };
  const str = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(str).digest("base64url");
  const token = `${str}.${signature}`;
  activeSessions.set(token, payload);
  return token;
}

function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [str, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", JWT_SECRET).update(str).digest("base64url");
  if (sig !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(str, "base64url").toString("utf-8"));
    if (Date.now() > payload.exp) {
      activeSessions.delete(token);
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

function getSessionFromReq(req) {
  // 1. From Query
  const queryToken = req.query.auth_token || req.query.token;
  if (queryToken) {
    const valid = verifySessionToken(queryToken);
    if (valid) return valid;
  }

  // 2. From Cookie
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)cineflix_session=([^;]+)/);
  if (match) {
    const valid = verifySessionToken(match[1]);
    if (valid) return valid;
  }

  // 3. From Authorization header
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    const valid = verifySessionToken(authHeader.substring(7).trim());
    if (valid) return valid;
  }

  return null;
}

/**
 * Authenticate against Supabase or Admin credentials
 */
async function authenticateUser(identifier, password) {
  if (!identifier || !password) {
    return { success: false, error: "Please enter both Email/Username and Password" };
  }

  const cleanIdent = String(identifier).trim();
  const cleanPass = String(password).trim();

  // 1. Master Admin / App Secret Check
  if (
    cleanPass === ADMIN_PIN ||
    cleanPass === BOT_PASSWORD ||
    (process.env.APP_SECRET && cleanPass === process.env.APP_SECRET)
  ) {
    const user = {
      id: "admin",
      email: cleanIdent.includes("@") ? cleanIdent : `${cleanIdent}@cineflix.app`,
      role: "admin",
    };
    const token = createSessionToken(user);
    return { success: true, user, token };
  }

  // 2. Supabase GoTrue Auth Check
  if (SUPABASE_URL && SUPABASE_ANON_KEY && !SUPABASE_URL.includes("placeholder")) {
    try {
      const emailToTry = cleanIdent.includes("@") ? cleanIdent : `${cleanIdent}@cineflix.com`;

      const supaRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: emailToTry,
          password: cleanPass,
        }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await supaRes.json();

      if (supaRes.ok && data.access_token) {
        const user = {
          id: data.user?.id || data.user?.email || "supabase_user",
          email: data.user?.email || emailToTry,
          role: "user",
        };
        const token = createSessionToken(user);
        return { success: true, user, token };
      }

      return {
        success: false,
        error: data.error_description || data.msg || data.message || "Invalid CineFlix credentials",
      };
    } catch (err) {
      console.error("[Supabase Auth Error]:", err.message);
      return { success: false, error: `Auth server error: ${err.message}` };
    }
  }

  // If Supabase not yet configured in .env, check default user fallback
  if (cleanPass === "shrq98083" || cleanPass === "shrq6396827211") {
    const user = { id: cleanIdent, email: cleanIdent, role: "user" };
    const token = createSessionToken(user);
    return { success: true, user, token };
  }

  return {
    success: false,
    error: "Invalid account or password. Please use your CineFlix OTT App credentials.",
  };
}

/**
 * Modern Netflix / CineFlix Dark Themed Login HTML Page
 */
function renderLoginPageHtml(redirectUrl = "/", errorMessage = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CineFlix OTT — Login to Stream</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at center, #1e1022 0%, #08060b 100%);
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .login-card {
      background: rgba(18, 14, 24, 0.85);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      padding: 40px 32px;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 30px 60px rgba(0, 0, 0, 0.7);
      text-align: center;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-size: 26px;
      font-weight: 900;
      letter-spacing: -0.5px;
      color: #fff;
      margin-bottom: 6px;
    }
    .brand span {
      color: #e50914;
    }
    .subtitle {
      font-size: 14px;
      color: #9ca3af;
      margin-bottom: 24px;
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171;
      padding: 12px;
      border-radius: 10px;
      font-size: 13px;
      margin-bottom: 20px;
      display: ${errorMessage ? "block" : "none"};
      text-align: left;
    }
    .form-group {
      margin-bottom: 18px;
      text-align: left;
    }
    label {
      display: block;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #9ca3af;
      margin-bottom: 8px;
    }
    input {
      width: 100%;
      padding: 14px 16px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      color: #fff;
      font-size: 15px;
      outline: none;
      transition: all 0.2s ease;
    }
    input:focus {
      border-color: #e50914;
      background: rgba(255, 255, 255, 0.08);
      box-shadow: 0 0 0 3px rgba(229, 9, 20, 0.2);
    }
    .btn-submit {
      width: 100%;
      padding: 15px;
      background: linear-gradient(135deg, #e50914, #b91c1c);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      margin-top: 10px;
      transition: transform 0.1s ease, box-shadow 0.2s ease;
      box-shadow: 0 8px 24px rgba(229, 9, 20, 0.35);
    }
    .btn-submit:hover {
      box-shadow: 0 10px 30px rgba(229, 9, 20, 0.5);
    }
    .btn-submit:active {
      transform: scale(0.98);
    }
    .footer-note {
      font-size: 12px;
      color: #6b7280;
      margin-top: 24px;
      line-height: 1.5;
    }
    .footer-note b {
      color: #9ca3af;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="brand">🎬 Cine<span>Flix</span> OTT</div>
    <div class="subtitle">Enter your CineFlix account to watch stream</div>

    <div class="alert-error" id="errorMsg">${errorMessage}</div>

    <form id="loginForm" method="POST" action="/auth/login">
      <input type="hidden" name="redirect" value="${encodeURIComponent(redirectUrl)}">
      
      <div class="form-group">
        <label for="username">Email or App Username</label>
        <input type="text" id="username" name="username" placeholder="user@gmail.com or username" required autofocus autocomplete="username">
      </div>

      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" placeholder="Enter your password" required autocomplete="current-password">
      </div>

      <button type="submit" class="btn-submit" id="submitBtn">Sign In to Stream</button>
    </form>

    <div class="footer-note">
      🔒 Protected by <b>CineFlix Supabase Auth</b>.<br>
      Same account works on Android App, Web & VLC Player.
    </div>
  </div>

  <script>
    const form = document.getElementById("loginForm");
    const errBox = document.getElementById("errorMsg");
    const submitBtn = document.getElementById("submitBtn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errBox.style.display = "none";
      submitBtn.innerText = "Verifying...";
      submitBtn.disabled = true;

      const username = document.getElementById("username").value.trim();
      const password = document.getElementById("password").value;
      const redirect = "${encodeURIComponent(redirectUrl)}";

      try {
        const res = await fetch("/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password, redirect: decodeURIComponent(redirect) })
        });
        const data = await res.json();
        if (data.success) {
          window.location.href = data.redirect || decodeURIComponent(redirect) || "/";
        } else {
          errBox.innerText = data.error || "Login failed";
          errBox.style.display = "block";
          submitBtn.innerText = "Sign In to Stream";
          submitBtn.disabled = false;
        }
      } catch (err) {
        errBox.innerText = "Network error: " + err.message;
        errBox.style.display = "block";
        submitBtn.innerText = "Sign In to Stream";
        submitBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

module.exports = {
  authenticateUser,
  createSessionToken,
  verifySessionToken,
  getSessionFromReq,
  renderLoginPageHtml,
};
