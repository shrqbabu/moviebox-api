const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

let cachedFfmpegPath = undefined;

/**
 * Searches for ffmpeg executable across common Linux, Windows, macOS, and Termux paths
 */
function findFfmpegExecutable() {
  if (cachedFfmpegPath !== undefined) {
    return cachedFfmpegPath;
  }

  // 1. Explicit env override
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    cachedFfmpegPath = process.env.FFMPEG_PATH;
    return cachedFfmpegPath;
  }

  // 2. Common Linux & VPS paths
  const candidates = [
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/snap/bin/ffmpeg",
    "/data/data/com.termux/files/usr/bin/ffmpeg",
    "C:/ffmpeg/bin/ffmpeg.exe",
    "C:/Program Files/ffmpeg/bin/ffmpeg.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs/ffmpeg/bin/ffmpeg.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft/WinGet/Links/ffmpeg.exe"),
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      cachedFfmpegPath = c;
      return cachedFfmpegPath;
    }
  }

  // 3. System PATH lookup
  try {
    const checkCmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    const out = execSync(checkCmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) {
      cachedFfmpegPath = out;
      return cachedFfmpegPath;
    }
  } catch (_) {}

  cachedFfmpegPath = null;
  return cachedFfmpegPath;
}

function isFfmpegAvailable() {
  return findFfmpegExecutable() !== null;
}

/**
 * Streams MPEG-DASH (.mpd) or multi-track audio/video stream through FFmpeg into fragmented MP4
 * This mimics MovieBox-TUI's native demuxing: 0-second buffer, audio+video synced, 0 CPU re-encoding
 */
function streamDashViaFfmpeg({ req, res, upstreamUrl, signCookie = "", userAgent = "", referer = "" }) {
  const ffmpegPath = findFfmpegExecutable();
  if (!ffmpegPath) {
    throw new Error("FFmpeg executable not found on host. Please install ffmpeg.");
  }

  let headerLines = [];
  if (signCookie) headerLines.push(`Cookie: ${signCookie}`);
  if (referer) headerLines.push(`Referer: ${referer}`);
  if (userAgent) headerLines.push(`User-Agent: ${userAgent}`);
  const headerStr = headerLines.length > 0 ? headerLines.join("\r\n") + "\r\n" : "";

  const args = [
    "-loglevel", "error",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
  ];

  if (headerStr) {
    args.push("-headers", headerStr);
  }

  args.push(
    "-i", upstreamUrl,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c", "copy",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1"
  );

  console.log(`[FFmpegStream] Launching FFmpeg remuxer for ${upstreamUrl.substring(0, 60)}...`);

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Cache-Control", "no-cache");

  if (req.method === "HEAD") {
    return res.end();
  }

  const proc = spawn(ffmpegPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrLog = "";
  if (proc.stderr) {
    proc.stderr.on("data", (chunk) => {
      stderrLog += chunk.toString();
    });
  }

  proc.stdout.pipe(res);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (!proc.killed) {
      try {
        proc.kill("SIGKILL");
      } catch (_) {}
    }
  };

  req.once("close", cleanup);
  req.once("aborted", cleanup);
  res.once("close", cleanup);
  res.once("error", cleanup);

  proc.on("error", (err) => {
    console.error("[FFmpegStream] Process error:", err.message);
    cleanup();
    if (!res.headersSent) {
      res.status(500).send(`FFmpeg error: ${err.message}`);
    }
  });

  proc.on("close", (code) => {
    if (code !== 0 && code !== null && !cleanedUp) {
      console.warn(`[FFmpegStream] Process exited with code ${code}. Stderr: ${stderrLog.slice(-300)}`);
    }
    cleanup();
  });
}

/**
 * Creates an in-flight FFmpeg remuxing pipeline for piped inputs (e.g. Telegram MTProto chunks)
 * Remuxes MKV/MP4 stream into fragmented MP4 with empty moov for instant playback
 */
function createPipedFfmpegRemuxer(res) {
  const ffmpegPath = findFfmpegExecutable();
  if (!ffmpegPath) {
    return null;
  }

  const args = [
    "-loglevel", "error",
    "-i", "pipe:0",
    "-c", "copy",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1"
  ];

  const proc = spawn(ffmpegPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stdout.pipe(res);

  return proc;
}

module.exports = {
  findFfmpegExecutable,
  isFfmpegAvailable,
  streamDashViaFfmpeg,
  createPipedFfmpegRemuxer,
};
