const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const bigInt = require("big-integer");

class TelegramStreamEngine {
  constructor() {
    this.client = null;
    this.isReady = false;
    this.initPromise = null;
    this.isListenerRegistered = false;
  }

  // ============================================================
  // TIMEOUT HELPER
  // ============================================================

  async withTimeout(promise, ms, name = "Operation") {
    let timer;

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(`${name} timeout after ${ms}ms`)
        );
      }, ms);
    });

    try {
      return await Promise.race([
        promise,
        timeoutPromise
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ============================================================
  // INIT TELEGRAM
  // ============================================================

  async init() {
    if (this.isReady && this.client) {
      return this.client;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      const apiId = parseInt(
        process.env.TG_API_ID || "0",
        10
      );

      const apiHash =
        (process.env.TG_API_HASH || "").trim();

      const botToken =
        (process.env.TG_BOT_TOKEN || "").trim();

      const sessionString =
        (process.env.TG_SESSION || "").trim();

      if (!apiId || !apiHash || !botToken) {
        console.error(
          "❌ [TelegramStream] Missing TG_API_ID / TG_API_HASH / TG_BOT_TOKEN"
        );

        throw new Error(
          "Telegram credentials not configured in .env"
        );
      }

      console.log(
        "🔌 [TelegramStream] Connecting to Telegram..."
      );

      const stringSession =
        new StringSession(sessionString);

      this.client = new TelegramClient(
        stringSession,
        apiId,
        apiHash,
        {
          connectionRetries: 3,
          useWSS: false,
          timeout: 10000
        }
      );

      await this.withTimeout(
        this.client.start({
          botAuthToken: botToken
        }),
        30000,
        "Telegram login"
      );

      this.isReady = true;

      console.log(
        "🚀 [TelegramStream] Connected to Telegram successfully!"
      );

      this.setupBotListener();

      return this.client;
    })();

    try {
      return await this.initPromise;
    } catch (err) {
      this.isReady = false;
      this.client = null;
      this.initPromise = null;

      console.error(
        "❌ [TelegramStream] Init failed:",
        err.message
      );

      throw err;
    }
  }

  // ============================================================
  // BOT LISTENER
  // ============================================================

  setupBotListener() {
    if (
      this.isListenerRegistered ||
      !this.client
    ) {
      return;
    }

    this.isListenerRegistered = true;

    this.client.addEventHandler(
      async (event) => {
        try {
          const message = event.message;

          if (!message) {
            return;
          }

          const text = (
            message.text ||
            message.message ||
            ""
          ).trim();

          const hostUrl = (
            process.env.BASE_HOST_URL ||
            "https://cineflix-ott.duckdns.org"
          ).replace(/\/+$/, "");

          // ------------------------------------------------------
          // VIDEO / DOCUMENT
          // ------------------------------------------------------

          const media =
            message.media?.document ||
            message.media?.video;

          if (media) {
            const msgId = message.id;

            const directUrl =
              `${hostUrl}/api/tg/stream?msg=${msgId}`;

            const hlsUrl =
              `${hostUrl}/api/movie/proxy.m3u8?url=` +
              encodeURIComponent(directUrl);

            const mxUrl = `${hostUrl}/play/mx?url=${encodeURIComponent(directUrl)}&title=${encodeURIComponent("Telegram Video")}`;
            const vlcUrl = `${hostUrl}/play/vlc?url=${encodeURIComponent(directUrl)}`;
            const m3uUrl = `${hostUrl}/play/playlist.m3u?url=${encodeURIComponent(directUrl)}&title=${encodeURIComponent("Telegram Video")}`;

            const replyText =
              `🎬 **Video Stream Ready!**\n\n` +
              `⚡ **Direct Stream (Fast-Forward & Seeking Supported):**\n\`${directUrl}\`\n\n` +
              `📱 **1-Click MX Player (Android):**\n${mxUrl}\n\n` +
              `🚀 **1-Click VLC Player:**\n${vlcUrl}\n\n` +
              `📥 **Download .M3U Playlist File:**\n${m3uUrl}\n\n` +
              `📡 **HLS Playlist:**\n\`${hlsUrl}\`\n\n` +
              `📋 **Message ID:** \`${msgId}\``;

            await message.reply({
              message: replyText
            });

            return;
          }

          // ------------------------------------------------------
          // DIRECT URL
          // ------------------------------------------------------

          if (
            text.startsWith("http://") ||
            text.startsWith("https://")
          ) {
            const hlsUrl =
              `${hostUrl}/api/movie/proxy.m3u8?url=` +
              encodeURIComponent(text);

            const streamUrl =
              `${hostUrl}/api/movie/stream?url=` +
              encodeURIComponent(text);

            const replyText =
              `🎬 **Stream Link Generated!**\n\n` +
              `📡 **HLS M3U8 Playlist:**\n\`${hlsUrl}\`\n\n` +
              `⚡ **Direct Stream:**\n\`${streamUrl}\``;

            await message.reply({
              message: replyText
            });

            return;
          }

          // ------------------------------------------------------
          // HELP
          // ------------------------------------------------------

          if (
            text === "/start" ||
            text === "/help"
          ) {
            await message.reply({
              message:
                `👋 **Welcome to CineFlix Stream Generator Bot!**\n\n` +
                `Send me any **Video File (.mp4 / .mkv)** ` +
                `or any **Direct Video Link**.\n\n` +
                `I will generate a ready-to-play ` +
                `**M3U8 HLS & Direct Stream URL**.`
            });
          }
        } catch (err) {
          console.error(
            "⚠️ [Telegram Bot Event Error]:",
            err.message
          );
        }
      },
      new NewMessage({})
    );

    console.log(
      "🤖 [TelegramStream] Bot listener active!"
    );
  }

  // ============================================================
  // CHANNEL PARSER
  // ============================================================

  parseChannel(channelInput) {
    let raw = (
      channelInput ||
      process.env.TG_CHANNEL_ID ||
      ""
    ).trim();

    if (!raw) {
      return "";
    }

    if (raw.startsWith("#")) {
      raw = raw.slice(1).trim();
    }

    if (/^-?\d+$/.test(raw)) {
      if (raw.startsWith("-100")) {
        return raw;
      }

      if (raw.startsWith("-")) {
        return `-100${raw.slice(1)}`;
      }

      return `-100${raw}`;
    }

    return raw;
  }

  // ============================================================
  // RESOLVE TELEGRAM CHANNEL
  // ============================================================

  async resolveChannel(client, channelInput) {
    const channel = this.parseChannel(
      channelInput
    );

    if (!channel) {
      throw new Error(
        "Telegram channel not specified and TG_CHANNEL_ID not set"
      );
    }

    console.log(
      `🔎 [TelegramStream] Resolving channel: ${channel}`
    );

    // First try direct entity resolution.
    try {
      const entity =
        await this.withTimeout(
          client.getInputEntity(channel),
          10000,
          "Telegram channel resolution"
        );

      if (entity) {
        console.log(
          `✅ [TelegramStream] Channel resolved: ${channel}`
        );

        return entity;
      }
    } catch (err) {
      console.warn(
        `⚠️ [TelegramStream] getInputEntity failed for ${channel}:`,
        err.message
      );
    }

    // Fallback: getEntity
    try {
      const entity =
        await this.withTimeout(
          client.getEntity(channel),
          10000,
          "Telegram getEntity"
        );

      if (entity) {
        console.log(
          `✅ [TelegramStream] Channel resolved through getEntity`
        );

        return entity;
      }
    } catch (err) {
      console.error(
        `❌ [TelegramStream] Channel resolution failed:`,
        err.message
      );
    }

    throw new Error(
      `Unable to resolve Telegram channel: ${channel}`
    );
  }

  // ============================================================
  // RANGE PARSER
  // ============================================================

  parseRange(rangeHeader, fileSize) {
    if (
      !rangeHeader ||
      !fileSize ||
      fileSize <= 0
    ) {
      return {
        start: 0,
        end: fileSize > 0
          ? fileSize - 1
          : 0,
        statusCode: 200
      };
    }

    const match =
      rangeHeader.match(
        /^bytes=(\d*)-(\d*)$/i
      );

    if (!match) {
      return {
        error: "Invalid Range header"
      };
    }

    const startText = match[1];
    const endText = match[2];

    let start;
    let end;

    // ----------------------------------------------------------
    // bytes=-500
    // Last 500 bytes
    // ----------------------------------------------------------

    if (!startText && endText) {
      const suffixLength =
        Number(endText);

      if (
        !Number.isFinite(suffixLength) ||
        suffixLength <= 0
      ) {
        return {
          error: "Invalid suffix range"
        };
      }

      start = Math.max(
        0,
        fileSize - suffixLength
      );

      end = fileSize - 1;
    }

    // ----------------------------------------------------------
    // bytes=500-
    // ----------------------------------------------------------

    else if (startText && !endText) {
      start = Number(startText);
      end = fileSize - 1;
    }

    // ----------------------------------------------------------
    // bytes=500-999
    // ----------------------------------------------------------

    else if (startText && endText) {
      start = Number(startText);
      end = Number(endText);
    }

    else {
      return {
        error: "Invalid Range header"
      };
    }

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end)
    ) {
      return {
        error: "Range exceeds safe integer limit"
      };
    }

    if (
      start < 0 ||
      end < 0 ||
      start >= fileSize ||
      start > end
    ) {
      return {
        error: "Requested Range Not Satisfiable"
      };
    }

    end = Math.min(
      end,
      fileSize - 1
    );

    return {
      start,
      end,
      statusCode: 206
    };
  }

  // ============================================================
  // STREAM MEDIA
  // ============================================================

  async streamMedia(
    req,
    res,
    messageId,
    channelInput = ""
  ) {
    const requestId =
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

    console.log(
      `\n📡 [TelegramStream:${requestId}] Request started`
    );

    console.log(
      `   Message: ${messageId}`
    );

    console.log(
      `   Channel: ${
        channelInput ||
        process.env.TG_CHANNEL_ID ||
        "(env missing)"
      }`
    );

    console.log(
      `   Range: ${
        req.headers.range || "none"
      }`
    );

    try {
      // ========================================================
      // TELEGRAM CLIENT
      // ========================================================

      const client =
        await this.withTimeout(
          this.init(),
          35000,
          "Telegram initialization"
        );

      // ========================================================
      // MESSAGE ID
      // ========================================================

      const msgId =
        Number.parseInt(
          messageId,
          10
        );

      if (
        !Number.isSafeInteger(msgId) ||
        msgId <= 0
      ) {
        return res
          .status(400)
          .send(
            "Invalid Telegram message ID"
          );
      }

      // ========================================================
      // CHANNEL
      // ========================================================

      const channel =
        await this.resolveChannel(
          client,
          channelInput
        );

      // ========================================================
      // GET MESSAGE
      // ========================================================

      console.log(
        `📨 [TelegramStream:${requestId}] Fetching message ${msgId}...`
      );

      const messages =
        await this.withTimeout(
          client.getMessages(
            channel,
            {
              ids: [msgId]
            }
          ),
          15000,
          `Telegram message lookup #${msgId}`
        );

      if (
        !messages ||
        !messages.length ||
        !messages[0]
      ) {
        console.error(
          `❌ [TelegramStream:${requestId}] Message ${msgId} not found`
        );

        return res
          .status(404)
          .send(
            `Telegram message #${msgId} not found in channel`
          );
      }

      const msg =
        messages[0];

      // ========================================================
      // MEDIA
      // ========================================================

      const media =
        msg.media?.document ||
        msg.media?.photo ||
        msg.media;

      if (!media) {
        return res
          .status(404)
          .send(
            "Message does not contain streamable media"
          );
      }

      // ========================================================
      // DOCUMENT
      // ========================================================

      const document =
        msg.media?.document ||
        (
          media?.className ===
          "Document"
            ? media
            : null
        );

      if (
        !document &&
        !msg.media?.photo
      ) {
        return res
          .status(404)
          .send(
            "Telegram message does not contain a document"
          );
      }

      // ========================================================
      // FILE SIZE
      // ========================================================

      let fileSize =
        Number(
          document?.size ||
          media?.size ||
          0
        );

      if (
        !Number.isFinite(fileSize) ||
        fileSize < 0
      ) {
        fileSize = 0;
      }

      // ========================================================
      // MIME
      // ========================================================

      let mimeType =
        document?.mimeType ||
        media?.mimeType ||
        "video/mp4";

      if (
        !mimeType ||
        mimeType === "application/octet-stream"
      ) {
        mimeType =
          "video/mp4";
      }

      console.log(
        `📦 [TelegramStream:${requestId}] File size: ${fileSize}`
      );

      console.log(
        `🎞️ [TelegramStream:${requestId}] MIME: ${mimeType}`
      );

      // ========================================================
      // RANGE
      // ========================================================

      const rangeResult =
        this.parseRange(
          req.headers.range,
          fileSize
        );

      if (rangeResult.error) {
        if (fileSize > 0) {
          res.setHeader(
            "Content-Range",
            `bytes */${fileSize}`
          );
        }

        return res
          .status(416)
          .send(
            rangeResult.error
          );
      }

      const start =
        rangeResult.start;

      const end =
        rangeResult.end;

      const statusCode =
        rangeResult.statusCode;

      const contentLength =
        fileSize > 0
          ? end - start + 1
          : undefined;

      // ========================================================
      // RESPONSE HEADERS
      // ========================================================

      const headers = {
        "Content-Type":
          mimeType,

        "Accept-Ranges":
          "bytes",

        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Allow-Headers":
          "*",

        "Access-Control-Allow-Methods":
          "GET, HEAD, OPTIONS",

        "Access-Control-Expose-Headers":
          "Content-Range, Accept-Ranges, Content-Length, Content-Type, ETag",

        "Cache-Control":
          "public, max-age=300",

        "X-Stream-Source":
          "telegram-channel",

        "X-Telegram-Message-Id":
          String(msgId)
      };

      if (
        statusCode === 206 &&
        fileSize > 0
      ) {
        headers[
          "Content-Range"
        ] =
          `bytes ${start}-${end}/${fileSize}`;

        headers[
          "Content-Length"
        ] =
          String(contentLength);
      } else if (
        fileSize > 0
      ) {
        headers[
          "Content-Length"
        ] =
          String(fileSize);
      }

      // ========================================================
      // ========================================================
      // HEAD REQUEST
      // ========================================================

      if (req.method === "HEAD") {
        res.writeHead(statusCode, headers);
        return res.end();
      }

      // ========================================================
      // CLIENT DISCONNECT
      // ========================================================

      let aborted = false;

      const abortHandler = () => {
        aborted = true;
        console.log(`🛑 [TelegramStream:${requestId}] Client disconnected`);
      };

      req.once("aborted", abortHandler);
      req.once("close", () => {
        if (!res.writableEnded) {
          aborted = true;
        }
      });

      // ========================================================
      // PREPARE MTPROTO FILE LOCATION & DC ID
      // ========================================================
      let fileLocation;
      let targetDcId = 5;

      if (document) {
        fileLocation = new Api.InputDocumentFileLocation({
          id: document.id,
          accessHash: document.accessHash,
          fileReference: document.fileReference,
          thumbSize: ""
        });
        targetDcId = document.dcId || 5;
      } else if (msg.media?.photo) {
        const photo = msg.media.photo;
        fileLocation = new Api.InputPhotoFileLocation({
          id: photo.id,
          accessHash: photo.accessHash,
          fileReference: photo.fileReference,
          thumbSize: ""
        });
        targetDcId = photo.dcId || 5;
      } else {
        fileLocation = msg.media;
        targetDcId = msg.media?.dcId || 5;
      }

      console.log(`🎬 [TelegramStream:${requestId}] Starting Telegram download`);
      console.log(`   Offset: ${start}`);
      console.log(`   Content-Length: ${contentLength || "full"}`);
      console.log(`   Target DC: ${targetDcId}`);

      const chunkSize = 512 * 1024;
      const downloadOptions = {
        file: fileLocation,
        offset: bigInt(start),
        chunkSize: chunkSize,
        requestSize: chunkSize,
        dcId: targetDcId
      };

      // ========================================================
      // ITER DOWNLOAD - FETCH FIRST CHUNK BEFORE WRITING HEADERS
      // ========================================================
      const iter = client.iterDownload(downloadOptions);
      const iterator = iter[Symbol.asyncIterator]();

      let firstResult;
      try {
        firstResult = await this.withTimeout(iterator.next(), 35000, "First chunk download");
      } catch (firstErr) {
        console.error(`❌ [TelegramStream:${requestId}] First chunk error:`, firstErr);
        if (!res.headersSent) {
          return res.status(500).json({
            error: "Failed to download media chunk from Telegram",
            message: firstErr.message,
            dcId: targetDcId,
            msgId: msgId
          });
        }
        throw firstErr;
      }

      if (!firstResult || firstResult.done || !firstResult.value) {
        if (!res.headersSent) {
          return res.status(404).send("Empty media stream from Telegram");
        }
        return res.end();
      }

      // ========================================================
      // SEND HEADERS & WRITE FIRST CHUNK
      // ========================================================
      res.writeHead(statusCode, headers);

      let firstChunk = firstResult.value;
      if (contentLength !== undefined && firstChunk.length > contentLength) {
        firstChunk = firstChunk.slice(0, contentLength);
      }

      let totalSent = firstChunk.length;
      let chunkCount = 1;

      const canContinueFirst = res.write(firstChunk);
      if (!canContinueFirst) {
        await new Promise((resolve) => res.once("drain", resolve));
      }

      if (contentLength !== undefined && totalSent >= contentLength) {
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
        return;
      }

      // ========================================================
      // STREAM REMAINING CHUNKS
      // ========================================================
      for await (let chunk of iter) {
        if (aborted || res.destroyed || res.writableEnded) {
          break;
        }

        if (!chunk || chunk.length === 0) {
          continue;
        }

        if (contentLength !== undefined) {
          const remaining = contentLength - totalSent;
          if (remaining <= 0) break;
          if (chunk.length > remaining) {
            chunk = chunk.slice(0, remaining);
          }
        }

        chunkCount++;
        totalSent += chunk.length;

        const canContinue = res.write(chunk);
        if (!canContinue) {
          await new Promise((resolve) => res.once("drain", resolve));
        }

        if (contentLength !== undefined && totalSent >= contentLength) {
          break;
        }
      }

      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }

      console.log(`✅ [TelegramStream:${requestId}] Stream finished`);
      console.log(`   Chunks: ${chunkCount}`);
      console.log(`   Bytes sent: ${totalSent}`);
    } catch (err) {
      console.error(
        `❌ [TelegramStream:${requestId}] Error:`,
        err.message
      );

      console.error(
        err.stack || ""
      );

      // ========================================================
      // ERROR BEFORE HEADERS
      // ========================================================

      if (!res.headersSent) {
        return res
          .status(
            err.message?.includes("timeout")
              ? 504
              : 500
          )
          .send(
            `Telegram stream error: ${err.message}`
          );
      }

      // ========================================================
      // ERROR AFTER STREAM STARTED
      // ========================================================

      if (
        !res.writableEnded &&
        !res.destroyed
      ) {
        try {
          res.end();
        } catch {}
      }
    }
  }
}

module.exports =
  new TelegramStreamEngine();
