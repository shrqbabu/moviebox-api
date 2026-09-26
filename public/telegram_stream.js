const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

class TelegramStreamEngine {
  constructor() {
    this.client = null;
    this.isReady = false;
    this.initPromise = null;
    this.isListenerRegistered = false;
  }

  async init() {
    if (this.isReady && this.client) return this.client;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const apiId = parseInt(process.env.TG_API_ID || "0", 10);
      const apiHash = (process.env.TG_API_HASH || "").trim();
      const botToken = (process.env.TG_BOT_TOKEN || "").trim();
      const sessionString = (process.env.TG_SESSION || "").trim();

      if (!apiId || !apiHash || !botToken) {
        console.warn("⚠️ [TelegramStream] Missing TG_API_ID, TG_API_HASH, or TG_BOT_TOKEN in .env");
        throw new Error("Telegram credentials not configured in .env");
      }

      const stringSession = new StringSession(sessionString);
      this.client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
        useWSS: false,
        timeout: 15000,
      });

      await this.client.start({
        botAuthToken: botToken,
      });

      this.isReady = true;
      console.log("🚀 [TelegramStream] Connected to Telegram Datacenter successfully!");

      this.setupBotListener();

      return this.client;
    })();

    try {
      return await this.initPromise;
    } catch (e) {
      this.initPromise = null;
      throw e;
    }
  }

  /**
   * Auto Bot Listener: As soon as a user sends a video or video link,
   * it instantly replies with the generated M3U8 and direct streaming URLs!
   */
  setupBotListener() {
    if (this.isListenerRegistered || !this.client) return;
    this.isListenerRegistered = true;

    this.client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message) return;

        const text = (message.text || message.message || "").trim();
        const hostUrl = (process.env.BASE_HOST_URL || "https://live.betadda.workers.dev").trimEnd("/");

        // 1. If user uploaded a video file or document
        const media = message.media?.document || message.media?.video;
        if (media) {
          const msgId = message.id;
          const directUrl = `${hostUrl}/api/tg/stream?msg=${msgId}`;
          const hlsUrl = `${hostUrl}/api/movie/proxy.m3u8?url=${encodeURIComponent(directUrl)}`;

          const replyText =
            `🎬 **Video Stream Ready!**\n\n` +
            `📡 **HLS M3U8 URL:**\n\`${hlsUrl}\`\n\n` +
            `⚡ **Direct Stream (Range 206):**\n\`${directUrl}\`\n\n` +
            `📋 **Message ID:** \`${msgId}\``;

          await message.reply({ message: replyText });
          return;
        }

        // 2. If user sent a direct URL (HubCloud / HighXHD / Google CDN / MP4 / MKV)
        if (text.startsWith("http://") || text.startsWith("https://")) {
          const hlsUrl = `${hostUrl}/api/movie/proxy.m3u8?url=${encodeURIComponent(text)}`;
          const streamUrl = `${hostUrl}/api/movie/stream?url=${encodeURIComponent(text)}`;

          const replyText =
            `🎬 **Stream Link Generated!**\n\n` +
            `📡 **HLS M3U8 Playlist:**\n\`${hlsUrl}\`\n\n` +
            `⚡ **Direct Stream (Fast Seek):**\n\`${streamUrl}\``;

          await message.reply({ message: replyText });
          return;
        }

        // 3. Simple help command
        if (text === "/start" || text === "/help") {
          await message.reply({
            message:
              `👋 **Welcome to CineFlix Stream Generator Bot!**\n\n` +
              `Send me any **Video File (.mp4 / .mkv)** or any **Direct Video Link**,\n` +
              `and I will instantly generate a ready-to-play **M3U8 HLS & Direct Stream URL** for your OTT App! 🚀`
          });
        }
      } catch (err) {
        console.error("⚠️ [Telegram Bot Event Error]:", err.message);
      }
    }, new NewMessage({}));

    console.log("🤖 [TelegramStream] Auto M3U8 Generator Bot Listener is active!");
  }

  /**
   * Resolves channel identifier (numeric ID, #-ID, or @username)
   */
  parseChannel(channelInput) {
    let raw = (channelInput || process.env.TG_CHANNEL_ID || "").trim();
    if (!raw) return "";

    if (raw.startsWith("#")) {
      raw = raw.slice(1).trim();
    }

    if (/^-?\d+$/.test(raw)) {
      if (raw.startsWith("-100")) return raw;
      if (raw.startsWith("-")) return `-100${raw.slice(1)}`;
      return `-100${raw}`;
    }

    return raw;
  }

  /**
   * High-speed Telegram Binary Video Streamer with HTTP 206 Partial Content (Range Support)
   */
  async streamMedia(req, res, messageId, channelInput = "") {
    try {
      const client = await this.init();
      const channel = this.parseChannel(channelInput);

      if (!channel) {
        return res.status(400).send("Telegram channel not specified and TG_CHANNEL_ID not set");
      }

      const msgId = parseInt(messageId, 10);
      if (!msgId || isNaN(msgId)) {
        return res.status(400).send("Invalid Telegram message ID");
      }

      const messages = await client.getMessages(channel, { ids: [msgId] });
      if (!messages || messages.length === 0 || !messages[0]) {
        return res.status(404).send(`Telegram message #${msgId} not found in channel`);
      }

      const msg = messages[0];
      const media = msg.media?.document || msg.media?.video || msg.media?.audio;
      if (!media) {
        return res.status(404).send("Message does not contain streamable media (video/document)");
      }

      const fileSize = Number(media.size || 0);
      const mimeType = media.mimeType || "video/mp4";

      let start = 0;
      let end = fileSize > 0 ? fileSize - 1 : 0;
      let statusCode = 200;

      const rangeHeader = req.headers.range;
      if (rangeHeader && fileSize > 0) {
        const parts = rangeHeader.replace(/bytes=/, "").split("-");
        start = parseInt(parts[0], 10) || 0;
        end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (start > end || start >= fileSize) {
          res.setHeader("Content-Range", `bytes */${fileSize}`);
          return res.status(416).send("Requested Range Not Satisfiable");
        }
        statusCode = 206;
      }

      const chunkSize = fileSize > 0 ? end - start + 1 : undefined;

      const headers = {
        "Content-Type": mimeType,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type",
        "Cache-Control": "public, max-age=300",
      };

      if (statusCode === 206 && fileSize > 0) {
        headers["Content-Range"] = `bytes ${start}-${end}/${fileSize}`;
        headers["Content-Length"] = chunkSize;
      } else if (fileSize > 0) {
        headers["Content-Length"] = fileSize;
      }

      res.writeHead(statusCode, headers);

      if (req.method === "HEAD") {
        return res.end();
      }

      let isAborted = false;
      req.on("close", () => {
        isAborted = true;
      });

      const iter = client.iterDownload({
        file: media,
        offset: BigInt(start),
        limit: chunkSize,
        chunkSize: 512 * 1024, // 512 KB per chunk in RAM
        requestSize: 512 * 1024,
      });

      for await (const chunk of iter) {
        if (isAborted || res.writableEnded) break;
        res.write(chunk);
      }

      if (!res.writableEnded) {
        res.end();
      }
    } catch (err) {
      console.error("⚠️ [TelegramStream Error]:", err.message);
      if (!res.headersSent) {
        return res.status(500).send(`Telegram stream error: ${err.message}`);
      }
    }
  }
}

module.exports = new TelegramStreamEngine();
