# 🎬 MovieBox Node.js SDK, REST API, OTT Backend & Telegram Bot

A reverse-engineered, high-performance Node.js backend and SDK for MovieBox. Features built-in DASH-to-HLS proxying (bypassing CDN 403 Forbidden errors), full Android OTT / ExoPlayer support, multi-player integration (**MX Player**, **VLC**, **MPV**), an interactive terminal CLI, and an interactive **Telegram Bot**.

---

## 📌 Table of Contents
1. [Important: Telegram Bot Token Guide (Alag ya Same?)](#-important-telegram-bot-token-guide-alag-ya-same)
2. [Why Streams Failed Earlier & How the Proxy Fixes It](#-why-streams-failed-earlier--how-the-proxy-fixes-it)
3. [Android OTT App & ExoPlayer Integration](#-android-ott-app--exoplayer-integration)
4. [Multi-Player Support (MX Player, VLC, MPV, M3U)](#-multi-player-support-mx-player-vlc-mpv-m3u)
5. [Interactive Terminal CLI (`bin/cli.js`)](#-interactive-terminal-cli-binclijs)
6. [Interactive Telegram Bot (`telegram_bot.js`)](#-interactive-telegram-bot-telegram_botjs)
7. [Environment Variables (`.env`)](#-environment-variables-env)
8. [REST API Endpoints](#-rest-api-endpoints)
9. [Quick Start & Setup](#-quick-start--setup)

---

## 🤖 Important: Telegram Bot Token Guide (Alag ya Same?)

Iss project mein **2 alag Telegram components** hain:

| Component | File | Purpose | Environment Variable |
|---|---|---|---|
| **MovieBox Search & Player Bot** | `src/core/telegram_bot.js` | Movies/Series search karna, poster dekhna, MX Player, VLC aur `.m3u` buttons se direct play karna | `MOVIEBOX_BOT_TOKEN` |
| **Telegram MTProto Cloud Streamer** | `src/core/telegram_stream.js` | Telegram private channels se files stream karna (GramJS MTProto engine) | `TG_BOT_TOKEN` + `TG_API_ID` + `TG_API_HASH` |

### ❓ Kya Token Alag Hoga ya Same?

- **Agar aap DONO components ek saath chala rahe hain (MovieBox Bot + Channel Streamer):**
  - **Tokens ALAG hone chahiye.**
  - Agar aap dono mein ek hi `TG_BOT_TOKEN` use karenge, toh Telegram server **`409 Conflict: terminated by other getUpdates request`** error dega, kyunki do alag engines ek hi token par updates lene ki koshish karenge.
  - **Solution:** 
    - `@BotFather` se ek naya bot banayein (jaise `@MyMovieBoxBot`) aur uska token `MOVIEBOX_BOT_TOKEN` mein daalein.
    - Purana channel streamer token `TG_BOT_TOKEN` mein rakhein.

- **Agar aap sirf MovieBox Search Bot chala rahe hain (MTProto Channel Streamer use nahi kar rahe):**
  - Aap chahein toh `MOVIEBOX_BOT_TOKEN` ya `TG_BOT_TOKEN` dono mein se koi bhi variable use kar sakte hain (`TG_API_ID` blank chhod dein). Server automatically detect kar lega.

---

## 🛡️ Why Streams Failed Earlier & How the Proxy Fixes It

### ❌ Problem
1. **Edge-Cache CDN Protection:** MovieBox CDN (`hakunaymatata.com`) CloudFront cookies se naye `Edge-Cache-Cookie=urlprefix=...` format par migrate ho chuka hai.
2. **Strict Headers Check:** Direct CDN stream URLs bina `Referer: https://sportslive.wine` aur MovieBox Android User-Agents ke open karne par **`403 Forbidden`** error throw karte hain.
3. External players (MX Player, VLC) aur Android ExoPlayer direct CDN URL par custom dynamic cookies inject nahi kar paate the.
4. OTT Android apps hit karne par API security PIN middleware `401 Unauthorized` de raha tha.

### ✅ Solution in this Codebase
1. **DASH & Edge-Cache Decoder (`src/core/crypto.js`):** Automatically base64 payload decode karke direct `.mpd` manifest link banata hai.
2. **Local/VPS Stream Proxy (`src/routes/api.js`):** Endpoint `/id/:id/movie/index.m3u8` DASH manifest ko on-the-fly HLS m3u8 format mein convert karta hai aur har video segment request mein required `Edge-Cache-Cookie` aur `Referer` headers inject karta hai.
3. **Player Whitelisting (`src/middleware/security.js`):** Stream endpoints (`/play/*`, `/api/resolve/*`, `/id/*`) aur Android User-Agents (`ExoPlayer`, `Dalvik`, `Android`, `okhttp`) ko PIN authentication se exempt kiya gaya hai.

---

## 📱 Android OTT App & ExoPlayer Integration

Agar aapka Android OTT App pehle MovieBox backend se stream nahi chala pa raha tha, ab aapko sirf apne app mein stream resolve URL call karna hai:

### 1. Resolve Stream Endpoint
```http
GET http://<YOUR_SERVER_IP>:3000/api/resolve/:id?season=1&episode=1
```

**JSON Response:**
```json
{
  "success": true,
  "id": "1002345",
  "title": "Inception",
  "streamUrl": "http://<YOUR_SERVER_IP>:3000/id/1002345/movie/index.m3u8",
  "type": "hls"
}
```

### 2. ExoPlayer Implementation in Android App (Kotlin / Java)
Aapke app ke ExoPlayer ko koi special headers ya cookies pass karne ki zaroorat nahi hai. Proxy URL seedha pass karein:

```kotlin
val streamUrl = "http://YOUR_SERVER_IP:3000/id/1002345/movie/index.m3u8"

val mediaItem = MediaItem.Builder()
    .setUri(Uri.parse(streamUrl))
    .setMimeType(MimeTypes.APPLICATION_M3U8)
    .build()

val player = ExoPlayer.Builder(context).build()
player.setMediaItem(mediaItem)
player.prepare()
player.play()
```

> 💡 **Tip:** Agar aapka server VPS par chal raha hai ya local network par, toh `.env` mein `BASE_HOST_URL=http://<YOUR_IP>:3000` set karein taaki response mein valid IP aaye.

---

## 🎮 Multi-Player Support (MX Player, VLC, MPV, M3U)

Ab aap kisi bhi movie/series ko direct external players mein 1-click se play kar sakte hain:

### 1. 🎬 MX Player (Android)
- **1-Click Web / Mobile Link:**
  ```http
  http://<YOUR_SERVER_IP>:3000/play/mx?id=<id>&season=1&episode=1
  ```
  Ye link open karne par browser Android Intent trigger karta hai aur MX Player (free ya pro) seedha start ho jata hai:
  ```
  intent:http://<YOUR_SERVER_IP>:3000/id/<id>/movie/index.m3u8#Intent;package=com.mxtech.videoplayer.ad;type=video/*;end
  ```
- **CLI Support:** CLI chalate waqt option `[3]` select karein (Android Termux ya ADB par seedha MX Player open karega).

### 2. 🍿 VLC Media Player
- **1-Click VLC Deep Link:**
  ```http
  http://<YOUR_SERVER_IP>:3000/play/vlc?id=<id>&season=1&episode=1
  ```
  Ye link seedha `vlc://http://...` protocol se VLC open kar deta hai.
- **CLI Support:** Option `[2]` select karein (VLC custom headers ke saath system background mein launch hota hai).

### 3. ⚡ MPV
- **CLI Support:** Option `[1]` select karein (MPV optimal low-latency configuration ke saath stream karta hai).

### 4. 📥 Universal M3U Playlist File
- **Direct Download Link:**
  ```http
  http://<YOUR_SERVER_IP>:3000/play/playlist.m3u?id=<id>&season=1&episode=1
  ```
  Ye endpoint valid `.m3u` file generate karke download kar deta hai, jise aap kisi bhi player (KMPlayer, PotPlayer, Nova, etc.) mein drag & drop karke play kar sakte hain.

---

## 🖥️ Interactive Terminal CLI (`bin/cli.js`)

Terminal CLI ko poori tarah fix aur enhance kar diya gaya hai:
- Player na hone par CLI freeze/hang nahi hota (non-blocking error handling).
- Agar background proxy server band hai, toh CLI background mein proxy automatically start kar deta hai.
- Screen par 1-click MX Player, VLC, aur M3U links print hote hain.

### Run CLI:
```bash
npm run cli
# ya
node bin/cli.js
```

**Features in CLI:**
1. Type search query (e.g., `Avatar`).
2. Select title from numbered list.
3. If TV show, select Season and Episode.
4. Select Player:
   - `[1] MPV`
   - `[2] VLC`
   - `[3] MX Player (Android Intent / am start)`
   - `[4] Just Print Stream & Intent URLs`

---

## 🤖 Interactive Telegram Bot (`telegram_bot.js`)

Aap MovieBox ke pure catalog ko Telegram bot ke through access kar sakte hain.

### Features:
- `/search <movie name>` ya koi bhi title message karein (e.g., `Oppenheimer`).
- Movie poster, release year, rating, aur genres card display hota hai.
- TV shows ke liye interactive **Inline Buttons** se Season aur Episode choose karein.
- **Inline Action Buttons:**
  - 🎬 **Open in MX Player**: Android device par MX Player seedha open karta hai.
  - 🍿 **Open in VLC**: VLC player deep link open karta hai.
  - 🌐 **Web Player**: In-browser Shaka Player mein play karta hai.
  - 📥 **Get .m3u File**: Telegram bot chat mein direct `.m3u` playlist file send karta hai jise tap karke kisi bhi app mein play kar sakte hain.

### 🔒 VPS Security & Authentication (UserId / Password Protection)

Agar aapka project VPS par hosted hai, toh koi bhi anjaan vyakti Telegram par aapke bot ko access karke VPS bandwidth aur MovieBox limits consume na kare, isliye **UserId aur Password protection** add kiya gaya hai:

#### 1. How Authentication Works:
- **Default Lock:** Jab tak koi user login nahi karega, bot koi bhi search query ya button access allow nahi karega (`Access Denied`).
- **Persistent Sessions:** Ek baar login karne par session `data/bot_auth_sessions.json` mein save ho jata hai, VPS restart hone par bhi user ko baar-baar login nahi karna padega.

#### 2. Authentication Methods (`.env`):
- **Option A (Password Only):** `.env` mein `BOT_PASSWORD=secret123` set karein. User chat mein bhejega:
  ```
  /login secret123
  ```
- **Option B (Username + Password):** `.env` mein `BOT_USERNAME=admin` aur `BOT_PASSWORD=secret123` set karein. User bhejega:
  ```
  /login admin secret123
  ```
- **Option C (Whitelist Telegram User IDs):** Apne `.env` mein `BOT_ALLOWED_USER_IDS=123456789,987654321` daalein. Yeh users bina password dale direct bot use kar sakte hain!

#### 3. Bot Auth Commands:
| Command | Description |
|---|---|
| `/id` ya `/whoami` | Apna numeric Telegram User ID aur Auth Status check karein |
| `/login <pass>` | Password daal kar login karein |
| `/login <user> <pass>` | Username aur Password daal kar login karein |
| `/logout` | Current session close karein |
| `/sessions` | *(Admin only)* Active logged-in users ki list dekhein |
| `/revoke <userId>` | *(Admin only)* Kisi user ka access cancel karein |

### Setup Telegram Bot:
1. `@BotFather` se naya bot banayein aur Token copy karein.
2. `.env` file mein daalein:
   ```env
   MOVIEBOX_BOT_TOKEN=1234567890:ABCdefGhIJKlmNoPQRsTUVwxyZ
   BASE_HOST_URL=http://<YOUR_VPS_PUBLIC_IP_OR_DOMAIN>:3000
   BOT_PASSWORD=cineflix2026
   BOT_USERNAME=admin
   BOT_ALLOWED_USER_IDS=
   ```
3. Server start karein:
   ```bash
   npm start
   ```
   Bot automatically connect ho jayega!

---

## ⚙️ Environment Variables (`.env`)

Apne project root par `.env` file banayein (`.env.example` copy karke):

```env
# Server Port (Default: 3000)
PORT=3000

# Public or Local IP for Mobile Apps & Telegram Bot links
# (Important: Mobile players and Telegram need to reach your VPS server)
BASE_HOST_URL=http://<YOUR_VPS_IP>:3000

# Environment Mode
NODE_ENV=production

# App Secret Key for Native Android App Authorization
APP_SECRET=cineflix_sec_99a8b7c6d5e4f3a210

# Master Admin PIN for Web Dashboard (Default: 1234)
ADMIN_PIN=1234

# ==============================================================
# 🤖 MovieBox Interactive Telegram Bot (VPS Remote CLI)
# ==============================================================
MOVIEBOX_BOT_TOKEN=

# VPS Bot Security / Authentication:
# Login Password (users type /login <password>)
BOT_PASSWORD=cineflix2026

# Optional Username (users type /login <username> <password>)
BOT_USERNAME=admin

# Whitelisted Telegram User IDs (Permanent instant access, no password needed)
BOT_ALLOWED_USER_IDS=

# ==============================================================
# 🚀 Telegram MTProto Cloud Streaming Engine (telegram_stream.js)
# ==============================================================
# Inhe tabhi bharein agar aap Telegram Private Channel Streamer use kar rahe hain
TG_API_ID=
TG_API_HASH=
TG_BOT_TOKEN=
TG_CHANNEL_ID=
```

---

## 📡 REST API Endpoints

| Method | Endpoint | Query / Params | Description |
|---|---|---|---|
| `GET` | `/api/health` | None | API connectivity & session status |
| `GET` | `/api/search` | `?q=Batman&type=0&page=1` | Search catalog (`type`: 0=All, 1=Movies, 2=Series) |
| `GET` | `/api/details/:id` | None | Get movie or TV show metadata & seasons |
| `GET` | `/api/streams/:id` | `?season=1&episode=1` | DASH manifest, signed cookies & player commands |
| `GET` | `/api/resolve/:id` | `?season=1&episode=1` | **ExoPlayer OTT Endpoint** (Returns ready-to-play proxy HLS URL) |
| `GET` | `/play/mx` | `?id=:id&season=0&episode=0` | Redirects to MX Player Android Intent |
| `GET` | `/play/vlc` | `?id=:id&season=0&episode=0` | Redirects to VLC Deep Link (`vlc://...`) |
| `GET` | `/play/playlist.m3u` | `?id=:id&season=0&episode=0` | Downloads playable `.m3u` playlist file |
| `GET` | `/id/:id/movie/index.m3u8` | Route | Proxied HLS stream (injects dynamic Edge-Cache cookies) |
| `GET` | `/api/subtitles` | `?id=:id&resourceId=:resId` | Fetch subtitle tracks |
| `GET` | `/api/home` | `?tab=1&page=1` | Featured content & categories |

---

## ⚡ Quick Start & Setup

### 1. Install Dependencies
```bash
git clone https://github.com/shariqbabu/moviebox-node.git
cd moviebox-node
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your favorite editor
```

### 3. Start the Server
```bash
npm start
```
- Web UI: [http://localhost:3000](http://localhost:3000)
- Telegram Bot starts automatically if `MOVIEBOX_BOT_TOKEN` is set.

### 4. Interactive CLI
```bash
npm run cli
```
