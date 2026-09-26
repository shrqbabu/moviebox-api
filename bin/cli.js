#!/usr/bin/env node

const dns = require("dns");
try { dns.setDefaultResultOrder("ipv4first"); } catch (_) {}
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const { MovieBoxClient } = require("../src/core/client");
const { MultiProvider } = require("../src/core/multi_provider");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.on("close", () => {
  process.exit(0);
});

function ask(question) {
  return new Promise((resolve) => {
    if (rl.closed) return resolve("");
    try {
      rl.question(question, resolve);
    } catch (e) {
      resolve("");
    }
  });
}

const express = require("express");
const cors = require("cors");
const http = require("http");
const apiRouter = require("../src/routes/api");

let activeLocalServer = null;
let activeLocalPort = 3000;

function ensureLocalServer(desiredPort = 3000) {
  return new Promise((resolve) => {
    // 1. Check if server is already running on desiredPort
    const req = http.get(`http://localhost:${desiredPort}/health`, (res) => {
      activeLocalPort = desiredPort;
      resolve(desiredPort);
    });

    req.on("error", () => {
      // 2. Not running: launch lightweight internal proxy
      try {
        const app = express();
        app.use(cors());
        app.use(express.json());
        app.use((req, res, next) => {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Headers", "*");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          if (req.method === "OPTIONS") return res.sendStatus(200);
          next();
        });

        app.use("/id", (req, res, next) => {
          req.url = `/id${req.url}`;
          apiRouter(req, res, next);
        });
        app.use("/play", (req, res, next) => {
          req.url = `/play${req.url}`;
          apiRouter(req, res, next);
        });
        app.use("/api", apiRouter);
        app.use("/", apiRouter);

        const srv = app.listen(desiredPort, () => {
          activeLocalServer = srv;
          activeLocalPort = desiredPort;
          resolve(desiredPort);
        });

        srv.on("error", (err) => {
          if (err.code === "EADDRINUSE") {
            const fallbackSrv = app.listen(0, () => {
              activeLocalServer = fallbackSrv;
              activeLocalPort = fallbackSrv.address().port;
              resolve(activeLocalPort);
            });
          } else {
            resolve(desiredPort);
          }
        });
      } catch (e) {
        resolve(desiredPort);
      }
    });
  });
}

function findExecutable(name, candidates = []) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  try {
    const cmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
    const out = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch (e) {}
  return null;
}

function findMpvPath() {
  return findExecutable("mpv", [
    "C:/Program Files/MPV Player/mpv.exe",
    "C:/Program Files/mpv/mpv.exe",
    "C:/Program Files (x86)/MPV Player/mpv.exe",
    "C:/Program Files (x86)/mpv/mpv.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs/MPV Player/mpv.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs/mpv/mpv.exe"),
    path.join(process.env.USERPROFILE || "", "scoop/apps/mpv/current/mpv.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft/WinGet/Links/mpv.exe"),
    "/usr/bin/mpv",
    "/usr/local/bin/mpv",
    "/data/data/com.termux/files/usr/bin/mpv",
  ]);
}

function findVlcPath() {
  return findExecutable("vlc", [
    "C:/Program Files/VideoLAN/VLC/vlc.exe",
    "C:/Program Files (x86)/VideoLAN/VLC/vlc.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs/VLC/vlc.exe"),
    "/usr/bin/vlc",
    "/usr/local/bin/vlc",
    "/Applications/VLC.app/Contents/MacOS/VLC",
    "/data/data/com.termux/files/usr/bin/vlc",
  ]);
}

function findAmPath() {
  return findExecutable("am", [
    "/system/bin/am",
    "/data/data/com.termux/files/usr/bin/am",
  ]);
}

async function main() {
  console.clear();
  console.log("\x1b[36m====================================================\x1b[0m");
  console.log("\x1b[1m\x1b[33m       🎬 MOVIEBOX CLI - NODE.JS (HINDI 🇮🇳)        \x1b[0m");
  console.log("\x1b[36m====================================================\x1b[0m");
  console.log("\x1b[90m💡 Direct Streaming: 1-Click VLC, MX Player, MPV & M3U Playlist!\x1b[0m");
  console.log("\x1b[90m   Use Telegram Bot (MOVIEBOX_BOT_TOKEN) for instant mobile streaming.\x1b[0m\n");

  const client = new MovieBoxClient();
  const mpvExe = findMpvPath();
  const vlcExe = findVlcPath();

  process.stdout.write("Initializing secure stream engine...");
  try {
    await Promise.all([
      client.ensureSession(),
      ensureLocalServer(parseInt(process.env.PORT) || 3000),
    ]);
    console.log(" \x1b[32m[CONNECTED & READY]\x1b[0m\n");
  } catch (err) {
    console.log(` \x1b[31m[FAILED: ${err.message}]\x1b[0m\n`);
    process.exit(1);
  }

  while (true) {
    const query = await ask("\x1b[1mSearch Movie or TV Series (or 'exit'): \x1b[0m");
    if (!query.trim() || query.trim().toLowerCase() === "exit") {
      console.log("Goodbye!");
      rl.close();
      process.exit(0);
    }

    console.log(`\nSearching for '\x1b[33m${query}\x1b[0m' (Hindi prioritized)...\n`);
    try {
      const searchRes = await client.search(query, 1, 15);
      const items = searchRes.items;

      if (!items || items.length === 0) {
        console.log("\x1b[31mNo results found. Try another query.\x1b[0m\n");
        continue;
      }

      console.log("\x1b[32mResults:\x1b[0m");
      items.forEach((it, idx) => {
        const typeBadge =
          it.type === "series" ? "\x1b[35m[SERIES]\x1b[0m" : "\x1b[34m[MOVIE]\x1b[0m";
        const hindiBadge = it.isHindi ? " \x1b[32m[HINDI 🇮🇳]\x1b[0m" : "";
        console.log(
          `  \x1b[1m[${idx + 1}]\x1b[0m ${it.cleanTitle || it.title} (${it.year || "N/A"}) ${typeBadge}${hindiBadge}`
        );
      });

      const choiceStr = await ask(
        `\nSelect item number (1-${items.length}) or 0 to back: `
      );
      const choice = parseInt(choiceStr);
      if (isNaN(choice) || choice < 1 || choice > items.length) {
        continue;
      }

      const selected = items[choice - 1];
      console.log(`\nFetching details for \x1b[1m${selected.title}\x1b[0m...`);
      const details = await client.getDetails(selected.id);

      let targetSubjectId = selected.id;

      // Audio Dubs selection
      if (Array.isArray(details.dubs) && details.dubs.length > 0) {
        console.log("\n\x1b[36mAvailable Audio Dubs:\x1b[0m");
        const defaultIndex = details.dubs.findIndex((d) => d.isHindi);
        const preselectIdx = defaultIndex !== -1 ? defaultIndex : 0;

        details.dubs.forEach((d, idx) => {
          const isDef = idx === preselectIdx ? " \x1b[32m(Default)\x1b[0m" : "";
          console.log(`  [${idx + 1}] ${d.languageName}${isDef}`);
        });

        const dubChoice = await ask(
          `Select Dub (1-${details.dubs.length}, press Enter for Default): `
        );
        const picked = parseInt(dubChoice);
        if (!isNaN(picked) && picked >= 1 && picked <= details.dubs.length) {
          targetSubjectId = details.dubs[picked - 1].subjectId;
          console.log(`\x1b[32m✓ Selected: ${details.dubs[picked - 1].languageName}\x1b[0m`);
        } else {
          targetSubjectId = details.dubs[preselectIdx].subjectId;
          console.log(`\x1b[32m✓ Selected: ${details.dubs[preselectIdx].languageName}\x1b[0m`);
        }
      }

      let season = 0;
      let episode = 0;

      if (details.type === "series") {
        const totalSeasons = details.seasons.length || 1;
        console.log(`\n\x1b[35mThis is a TV Series with ${totalSeasons} season(s).\x1b[0m`);
        const seasonInput = await ask(`Enter Season number (1-${totalSeasons}, default 1): `);
        season = parseInt(seasonInput) || 1;

        const foundSeason = details.seasons.find((s) => s.se === season);
        const maxEp = foundSeason?.maxEp || 50;

        const epInput = await ask(`Enter Episode number (1-${maxEp}, default 1): `);
        episode = parseInt(epInput) || 1;
      }

      console.log(`\nResolving stream manifest & signed cookies...`);
      let streamInfo = await client.getStreams(targetSubjectId, season, episode);

      let targetStream = null;

      if (streamInfo.streams && streamInfo.streams.length > 0) {
        targetStream = streamInfo.streams[0];
      } else {
        // Fallback: Multi-provider cascade (4KHDHub, VidSrc, Salsa)
        console.log("\x1b[33mDirect MovieBox stream not found. Checking fallback providers (4KHDHub, VidSrc, Salsa)...\x1b[0m");
        const fallback = await MultiProvider.resolveAny(
          selected.cleanTitle || selected.title,
          season,
          episode
        );
        if (fallback && fallback.streamUrl) {
          console.log(`\x1b[32m✓ Fallback Stream Resolved via [${fallback.provider.toUpperCase()}]:\x1b[0m`);
          targetStream = {
            format: fallback.format || "HLS",
            resolutionLabel: fallback.resolution || "1080p",
            resolutions: [1080, 720, 480],
            codec: "hevc",
            streamUrl: fallback.streamUrl,
            signCookie: null,
            commands: {
              mpv: `mpv "${fallback.streamUrl}" --referrer="${fallback.referer || "https://sportslive.wine/"}"`,
              vlc: `vlc "${fallback.streamUrl}" --http-referrer="${fallback.referer || "https://sportslive.wine/"}"`,
            },
          };
        }
      }

      if (!targetStream) {
        console.log("\x1b[31mNo active stream sources found for this selection.\x1b[0m\n");
        continue;
      }

      // ----------------------------------------------------
      // 🎞️ QUALITY / RESOLUTION (HEVC / H.265) SELECTION
      // ----------------------------------------------------
      const availableRes = Array.isArray(targetStream.resolutions) && targetStream.resolutions.length > 0
        ? targetStream.resolutions
        : [1080, 720, 480];

      console.log(`\n\x1b[36mAvailable Video Qualities (HEVC / H.265):\x1b[0m`);
      console.log(`  [1] Auto / Adaptive Multi-Bitrate (Default - Recommended)`);
      availableRes.forEach((res, idx) => {
        const qualityTag = res >= 1080 ? "\x1b[32m[FHD 1080p HEVC]\x1b[0m" : res >= 720 ? "\x1b[33m[HD 720p HEVC]\x1b[0m" : "\x1b[34m[SD 480p HEVC]\x1b[0m";
        console.log(`  [${idx + 2}] ${res}p ${qualityTag}`);
      });

      const qChoiceStr = await ask(`Select Quality (1-${availableRes.length + 1}, press Enter for Auto): `);
      const qChoice = parseInt(qChoiceStr);
      let selectedRepId = null;
      let selectedQualityLabel = "Auto (Adaptive HEVC)";

      if (!isNaN(qChoice) && qChoice >= 2 && qChoice <= availableRes.length + 1) {
        const pickedRes = availableRes[qChoice - 2];
        selectedRepId = qChoice - 2; // Rep 0 = 1080p, Rep 1 = 720p, Rep 2 = 480p
        selectedQualityLabel = `${pickedRes}p HEVC (H.265)`;
        console.log(`\x1b[32m✓ Selected Quality: ${selectedQualityLabel}\x1b[0m`);
      } else {
        console.log(`\x1b[32m✓ Selected Quality: Auto (Adaptive Multi-Bitrate HEVC)\x1b[0m`);
      }

      const port = activeLocalPort || parseInt(process.env.PORT) || 3000;
      const hostUrl = (process.env.BASE_HOST_URL || process.env.HOST_URL || `http://localhost:${port}`).replace(/\/+$/, "");
      const isSeries = season > 0;
      const qQuery = selectedRepId !== null ? `?q=${selectedRepId}` : "";
      const qAmp = selectedRepId !== null ? `&q=${selectedRepId}` : "";
      const proxyHls = `${hostUrl}/id/${targetSubjectId}/${isSeries ? `${season}/${episode}/index.m3u8` : 'movie/index.m3u8'}${qQuery}`;
      const fastMp4 = `${hostUrl}/id/${targetSubjectId}/${isSeries ? `${season}/${episode}/stream.mp4` : 'movie/stream.mp4'}`;
      const mxLink = `${hostUrl}/play/mx?id=${targetSubjectId}${isSeries ? `&s=${season}&e=${episode}` : ''}${qAmp}&title=${encodeURIComponent(selected.cleanTitle || selected.title)}`;
      const vlcLink = `${hostUrl}/play/vlc?id=${targetSubjectId}${isSeries ? `&s=${season}&e=${episode}` : ''}${qAmp}&title=${encodeURIComponent(selected.cleanTitle || selected.title)}`;
      const m3uLink = `${hostUrl}/play/playlist.m3u?id=${targetSubjectId}${isSeries ? `&s=${season}&e=${episode}` : ''}${qAmp}&title=${encodeURIComponent(selected.cleanTitle || selected.title)}`;

      const sizeMb = targetStream.sizeBytes ? ` | Size: ~${(targetStream.sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB` : "";

      console.log(`\n\x1b[32m✓ Stream Ready:\x1b[0m`);
      console.log(`  Codec:      \x1b[33mHEVC (H.265 / hev1)\x1b[0m${sizeMb}`);
      console.log(`  Quality:    ${selectedQualityLabel}`);
      console.log(`  Audio:      Hindi Dub Priority 🇮🇳`);

      console.log(`\n\x1b[1m\x1b[36m🔗 DIRECT PLAYABLE LINKS (Zero-Buffer Streaming - No 403 Forbidden!):\x1b[0m`);
      console.log(`  ▶ \x1b[1mDirect HLS Stream:\x1b[0m  \x1b[4m${proxyHls}\x1b[0m`);
      console.log(`  🚀 \x1b[1m1-Click VLC Player:\x1b[0m \x1b[4m${vlcLink}\x1b[0m`);
      console.log(`  📱 \x1b[1m1-Click MX Player:\x1b[0m  \x1b[4m${mxLink}\x1b[0m`);
      console.log(`  📥 \x1b[1mDownload .M3U File:\x1b[0m \x1b[4m${m3uLink}\x1b[0m`);
      console.log(`  ⚡ \x1b[1mFast MP4 Stream:\x1b[0m    \x1b[4m${fastMp4}\x1b[0m`);

      if (targetStream.commands?.mpv) {
        console.log(`\n\x1b[36m💻 MPV Command (PC / Terminal):\x1b[0m`);
        console.log(`  ${targetStream.commands.mpv}\n`);
      }
      if (targetStream.commands?.mx) {
        console.log(`\x1b[36m📱 MX Player Command (Android / Termux):\x1b[0m`);
        console.log(`  ${targetStream.commands.mx}\n`);
      }

      const playerOptions = [];
      if (mpvExe) playerOptions.push("1: MPV (HEVC HW-Dec)");
      if (vlcExe) playerOptions.push("2: VLC");
      playerOptions.push("3: MX Player (Android/Termux)");
      playerOptions.push("0: Skip/Next Search");

      const promptMsg = playerOptions.length > 1
        ? `Launch Player? (${playerOptions.join(", ")}): `
        : `Press Enter to continue (0: Skip): `;

      const playChoice = await ask(promptMsg);

      if (playChoice.trim() === "1" && mpvExe) {
        console.log(`\nLaunching MPV with Hardware-Accelerated HEVC Decoding (Hindi Audio Priority)...\n`);
        const streamToPlay = targetStream.streamUrl || proxyHls;
        const args = [
          `--hwdec=auto`,
          `--user-agent=${client.userAgent}`,
          `--referrer=https://sportslive.wine`,
          `--alang=hi,hin,hindi,en,eng`,
          `--slang=hi,hin,hindi,en,eng`,
          `--title=${selected.cleanTitle || selected.title}`,
          `--force-window=immediate`,
          `--cache=yes`,
          `--demuxer-max-bytes=200M`,
          `--demuxer-max-back-bytes=50M`,
          `--demuxer-readahead-secs=30`,
        ];

        if (targetStream.signCookie) {
          args.push(`--http-header-fields=Cookie: ${targetStream.signCookie}`);
        }

        args.push(streamToPlay);

        await new Promise((resolve) => {
          const child = spawn(mpvExe, args, { stdio: "inherit", shell: false });
          child.on("error", (e) => {
            console.log(`\x1b[31mError launching MPV: ${e.message}\x1b[0m`);
            resolve();
          });
          child.on("exit", () => resolve());
        });
      } else if (playChoice.trim() === "2" && vlcExe) {
        console.log(`\nLaunching VLC Player (${selectedQualityLabel})...`);
        const args = [
          `--http-referrer=https://sportslive.wine`,
          `--http-user-agent=${client.userAgent}`,
          proxyHls,
        ];
        await new Promise((resolve) => {
          const child = spawn(vlcExe, args, { stdio: "inherit", shell: false });
          child.on("error", (e) => {
            console.log(`\x1b[31mError launching VLC: ${e.message}\x1b[0m`);
            resolve();
          });
          child.on("exit", () => resolve());
        });
      } else if (playChoice.trim() === "3") {
        const amExe = findAmPath();
        if (amExe) {
          console.log(`\nLaunching MX Player via Android Intent...`);
          const args = [
            "start",
            "-a", "android.intent.action.VIEW",
            "-d", proxyHls,
            "-t", "video/*",
            "-e", "title", selected.cleanTitle || selected.title,
          ];
          await new Promise((resolve) => {
            const child = spawn(amExe, args, { stdio: "inherit", shell: false });
            child.on("error", (e) => {
              console.log(`\x1b[31mError launching MX Player: ${e.message}\x1b[0m`);
              resolve();
            });
            child.on("exit", () => resolve());
          });
        } else {
          console.log(`\n\x1b[33m[!] MX Player operates via Android/Termux Activity Manager (am).\x1b[0m`);
          console.log(`To open in MX Player, tap this 1-click link on your phone/browser:`);
          console.log(`  \x1b[32m${mxLink}\x1b[0m`);
          console.log(`Or on Termux run:`);
          console.log(`  \x1b[32m${targetStream.commands?.mx}\x1b[0m\n`);
        }
      }

      console.log("\n----------------------------------------------------\n");
    } catch (err) {
      console.log(`\x1b[31mError: ${err.message}\x1b[0m\n`);
    }
  }
}

main();
