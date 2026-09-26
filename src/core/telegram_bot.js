const fs = require("fs");
const path = require("path");
const https = require("https");
const dns = require("dns");
const { MovieBoxClient } = require("./client");
const { MultiProvider } = require("./multi_provider");
const { workerPool } = require("./worker_pool");

const telegramHttpsAgent = new https.Agent({
  keepAlive: true,
  lookup: (hostname, options, callback) => {
    dns.lookup(hostname, { family: 4, all: false }, callback);
  },
});

class MovieBoxTelegramBot {
  constructor(customToken = null) {
    this.token = (
      customToken ||
      process.env.MOVIEBOX_BOT_TOKEN ||
      (!process.env.TG_API_ID ? process.env.TG_BOT_TOKEN : "") ||
      process.env.TG_BOT_TOKEN ||
      ""
    ).trim();
    this.client = new MovieBoxClient();
    this.offset = 0;
    this.isRunning = false;
    this.botInfo = null;
    this.abortController = null;
  }

  // ============================================================
  // URL & TELEGRAM API HELPERS
  // ============================================================

  getBaseUrl() {
    return `https://api.telegram.org/bot${this.token}`;
  }

  getHostUrl() {
    return workerPool.getBestWorker();
  }

  getMiniAppUrl(subjectId = "", season = 0, episode = 0, quality = "auto", title = "", extraMeta = {}) {
    let rawHost = (
      process.env.EXOPLAYER_URL ||
      process.env.MINIAPP_URL ||
      process.env.WEBAPP_URL ||
      process.env.BASE_HOST_URL ||
      process.env.HOST_URL ||
      this.getHostUrl()
    ).trim();

    rawHost = rawHost.replace(/^[=\s"']+/, "").replace(/[/"'\s]+$/, "");
    if (!rawHost.startsWith("http://") && !rawHost.startsWith("https://")) {
      rawHost = `https://${rawHost}`;
    }
    // Telegram Mini App strictly requires https://
    rawHost = rawHost.replace(/^http:\/\//i, "https://");

    let base = rawHost;
    if (!base.endsWith("/player") && !base.endsWith("/exoplayer") && !base.endsWith(".html")) {
      base = `${base}/player`;
    }

    const params = new URLSearchParams();
    if (subjectId) params.set("id", String(subjectId));
    if (season > 0) params.set("s", String(season));
    if (episode > 0) params.set("e", String(episode));
    if (quality && quality !== "auto") params.set("q", String(quality));
    if (title) {
      const cleanTitle = String(title).replace(/[^a-zA-Z0-9 \-_.]/g, " ").replace(/\s+/g, " ").trim().slice(0, 35);
      if (cleanTitle) params.set("title", cleanTitle);
    }
    if (extraMeta.year) params.set("year", String(extraMeta.year));
    if (extraMeta.rating) params.set("rating", String(extraMeta.rating));

    const query = params.toString();
    return query ? `${base}?${query}` : base;
  }

  async callApi(method, payload = {}) {
    const url = `${this.getBaseUrl()}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(35000),
      // @ts-ignore
      agent: telegramHttpsAgent,
    });
    const json = await res.json();
    if (!json.ok) {
      if (payload.parse_mode && (json.description?.includes("parse entities") || json.description?.includes("can't parse"))) {
        const fallbackPayload = { ...payload };
        delete fallbackPayload.parse_mode;
        if (typeof fallbackPayload.text === "string") {
          fallbackPayload.text = fallbackPayload.text.replace(/[*_`]/g, "");
        }
        if (typeof fallbackPayload.caption === "string") {
          fallbackPayload.caption = fallbackPayload.caption.replace(/[*_`]/g, "");
        }
        const retryRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fallbackPayload),
          signal: AbortSignal.timeout(35000),
          // @ts-ignore
          agent: telegramHttpsAgent,
        });
        const retryJson = await retryRes.json();
        if (retryJson.ok) return retryJson.result;
      }
      throw new Error(json.description || `Telegram API error on ${method}`);
    }
    return json.result;
  }

  // ============================================================
  // BOT LIFECYCLE & POLLING
  // ============================================================

  async start() {
    if (!this.token) {
      console.log("ℹ️ [TelegramBot] No bot token configured. Bot disabled.");
      return;
    }
    try {
      this.botInfo = await this.callApi("getMe");
      console.log(`🤖 [TelegramBot] CineFlix Interactive OTT Bot started: @${this.botInfo.username}`);
      this.isRunning = true;
      try {
        await this.callApi("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
        await this.callApi("setChatMenuButton", {
          menu_button: {
            type: "default",
          },
        }).catch(() => {});
      } catch (_) {}
      this.pollUpdates();
    } catch (err) {
      console.error("❌ [TelegramBot] Failed to start bot:", err.message);
    }
  }

  stop() {
    this.isRunning = false;
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  async pollUpdates() {
    while (this.isRunning) {
      try {
        const updates = await this.callApi("getUpdates", {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"],
        });

        for (const u of updates) {
          this.offset = u.update_id + 1;
          this.handleUpdate(u).catch((e) => {
            console.error("⚠️ [TelegramBot Update Error]:", e.message);
          });
        }
      } catch (err) {
        if (!this.isRunning) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async handleUpdate(update) {
    if (update.message) {
      await this.handleMessage(update.message);
    } else if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  // ============================================================
  // MESSAGE HANDLER (DIRECT STREAMING & SEARCH)
  // ============================================================

  async handleMessage(msg) {
    const chatId = msg.chat.id;
    const from = msg.from;
    const userId = from ? String(from.id) : String(chatId);
    const text = (msg.text || "").trim();

    if (!text) return;

    // 1. Info / Status Command: /id, /whoami, /info
    if (text === "/id" || text === "/whoami" || text === "/info") {
      const reply =
        `👤 *Telegram User Identity*\n\n` +
        `• *Telegram ID:* \`${userId}\`\n` +
        `• *Username:* @${from?.username || "N/A"}\n` +
        `• *Name:* ${from?.first_name || "N/A"}\n` +
        `• *Status:* 🟢 Ready to Stream\n\n` +
        `_Send any movie or series name to start watching!_`;

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: reply,
        parse_mode: "Markdown",
      });
      return;
    }

    // 2. Start / Help
    if (text.startsWith("/start") || text.startsWith("/help")) {
      const startArg = text.replace(/^\/(start|help)\s*/i, "").trim();
      if (startArg) {
        if (startArg.startsWith("m_") || startArg.startsWith("m:")) {
          const id = startArg.replace(/^m[_:]/, "");
          return await this.handleMovieSelect(chatId, id);
        }
        if (startArg.startsWith("s_") || startArg.startsWith("s:")) {
          const id = startArg.replace(/^s[_:]/, "");
          return await this.sendSeriesSeasonSelector(chatId, id);
        }
      }

      const welcome =
        `🎬 *Welcome to CineFlix OTT!* 🍿\n\n` +
        `🍿 *Send any Movie or Web Series name to watch:*\n` +
        `• \`Avatar\`\n` +
        `• \`Jawan\`\n` +
        `• \`Batman\`\n` +
        `• \`Money Heist\`\n` +
        `• \`Interstellar\`\n\n` +
        `_Type the title directly in this chat or send /search <title>_`;

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: welcome,
        parse_mode: "Markdown",
      });
      return;
    }

    // 3. Process Search Query
    const query = text.replace(/^\/(search|movie|find|play)\s*/i, "").trim();
    if (!query) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: "Please send a movie or series name to search, e.g. `Avatar` or `Money Heist`",
        parse_mode: "Markdown",
      });
      return;
    }

    const waitMsg = await this.callApi("sendMessage", {
      chat_id: chatId,
      text: `🔍 Searching catalog for *"${query}"*...`,
      parse_mode: "Markdown",
    });

    try {
      await this.client.ensureSession();
      const res = await this.client.search(query, 1, 8);
      const items = res.items || [];

      if (items.length === 0) {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: waitMsg.message_id,
          text: `❌ No results found for *"${query}"*. Please try another spelling.`,
          parse_mode: "Markdown",
        });
        return;
      }

      // Build inline buttons for results
      const keyboard = items.slice(0, 8).map((it) => {
        const typeIcon = it.type === "series" ? "📺 [SERIES]" : "🎬 [MOVIE]";
        const hindiBadge = it.isHindi ? " 🇮🇳" : "";
        const titleLabel = `${it.cleanTitle || it.title} (${it.year || "N/A"}) ${typeIcon}${hindiBadge}`;
        const prefix = it.type === "series" ? "s" : "m";
        return [
          {
            text: titleLabel,
            callback_data: `${prefix}:${it.id}`,
          },
        ];
      });

      keyboard.push([{ text: "« Back to Main Menu", callback_data: "menu:start" }]);

      await this.callApi("editMessageText", {
        chat_id: chatId,
        message_id: waitMsg.message_id,
        text: `🍿 *Results for "${query}":*\nSelect an item below to stream:`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: keyboard,
        },
      });
    } catch (err) {
      await this.callApi("editMessageText", {
        chat_id: chatId,
        message_id: waitMsg.message_id,
        text: `⚠️ Search failed: ${err.message}`,
      });
    }
  }

  // ============================================================
  // CALLBACK QUERY HANDLER (STEP-BY-STEP WORKFLOW WITH BACK NAVIGATION)
  // ============================================================

  async handleCallbackQuery(cb) {
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data || "";

    // Main Menu / Home: "menu:start"
    if (data === "menu:start") {
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
      const welcome =
        `🎬 *Welcome to CineFlix OTT!* 🍿\n\n` +
        `🍿 *Send any Movie or TV Series name to watch:*\n` +
        `• \`Avatar\`\n` +
        `• \`Jawan\`\n` +
        `• \`Batman\`\n` +
        `• \`Money Heist\`\n` +
        `• \`Interstellar\`\n\n` +
        `_Type the title directly in this chat or send /search <title>_`;

      await this.callApi("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: welcome,
        parse_mode: "Markdown",
      }).catch(async () => {
        await this.callApi("sendMessage", {
          chat_id: chatId,
          text: welcome,
          parse_mode: "Markdown",
        });
      });
      return;
    }

    // 1. Movie Selected: "m:<id>" -> Step 1: Language / Quality Selection
    if (data.startsWith("m:")) {
      const subjectId = data.substring(2);
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Loading movie..." }).catch(() => {});
      await this.handleMovieSelect(chatId, subjectId, msgId);
      return;
    }

    // 2. Series Selected: "s:<id>" -> Step 1a: Season Selection
    if (data.startsWith("s:")) {
      const subjectId = data.substring(2);
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Loading seasons..." }).catch(() => {});
      await this.sendSeriesSeasonSelector(chatId, subjectId, msgId);
      return;
    }

    // 3. Series Season Chosen: "se:<id>:<season>" -> Step 1b: Episode Selection
    if (data.startsWith("se:")) {
      const [, subjectId, season] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: `Loading Season ${season}...` }).catch(() => {});
      await this.sendSeriesEpisodeSelector(chatId, subjectId, parseInt(season) || 1, msgId);
      return;
    }

    // 4. Series Episode Chosen: "ep:<id>:<season>:<episode>" -> Step 2: Language Selection
    if (data.startsWith("ep:")) {
      const [, subjectId, season, episode] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: `Selected S${season}E${episode}...` }).catch(() => {});
      await this.handleSeriesEpisodeSelect(chatId, subjectId, parseInt(season) || 1, parseInt(episode) || 1, msgId);
      return;
    }

    // 5. Language Picked: "step:lang:<type>:<subjectId>:<season>:<episode>:<dubId>" -> Step 3: Quality Selection
    if (data.startsWith("step:lang:")) {
      const [, , type, subjectId, season, episode, dubId] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "✓ Audio Selected! Next: Quality" }).catch(() => {});
      await this.sendQualitySelector(chatId, type, subjectId, parseInt(season) || 0, parseInt(episode) || 0, dubId, msgId);
      return;
    }

    // 6. Quality Picked: "step:play:<type>:<subjectId>:<season>:<episode>:<dubId>:<quality>" -> Step 4: Stream Players
    if (data.startsWith("step:play:")) {
      const [, , type, subjectId, season, episode, dubId, quality] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "🎬 Generating stream & players..." }).catch(() => {});
      await this.sendFinalStreamPlayerCard(chatId, type, subjectId, parseInt(season) || 0, parseInt(episode) || 0, dubId, quality, msgId);
      return;
    }

    // Navigation Back to Seasons: "step:back:season:<subjectId>"
    if (data.startsWith("step:back:season:")) {
      const [, , , subjectId] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "« Back to Seasons" }).catch(() => {});
      await this.sendSeriesSeasonSelector(chatId, subjectId, msgId);
      return;
    }

    // Navigation Back to Episodes: "step:back:ep:<subjectId>:<season>"
    if (data.startsWith("step:back:ep:")) {
      const [, , , subjectId, season] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "« Back to Episodes" }).catch(() => {});
      await this.sendSeriesEpisodeSelector(chatId, subjectId, parseInt(season) || 1, msgId);
      return;
    }

    // Navigation Back to Language: "step:back:lang:<type>:<subjectId>:<season>:<episode>"
    if (data.startsWith("step:back:lang:")) {
      const [, , , type, subjectId, season, episode] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "« Back to Language" }).catch(() => {});
      if (type === "s") {
        await this.handleSeriesEpisodeSelect(chatId, subjectId, parseInt(season) || 1, parseInt(episode) || 1, msgId);
      } else {
        await this.handleMovieSelect(chatId, subjectId, msgId);
      }
      return;
    }

    // Navigation Back to Quality: "step:back:qual:<type>:<subjectId>:<season>:<episode>:<dubId>"
    if (data.startsWith("step:back:qual:")) {
      const [, , , type, subjectId, season, episode, dubId] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "« Back to Quality" }).catch(() => {});
      await this.sendQualitySelector(chatId, type, subjectId, parseInt(season) || 0, parseInt(episode) || 0, dubId, msgId);
      return;
    }
  }

  // ============================================================
  // STEP 2: MOVIE / SERIES LANGUAGE SELECTOR
  // ============================================================

  async handleMovieSelect(chatId, subjectId, origMsgId = null) {
    try {
      await this.client.ensureSession();
      const details = await this.client.getDetails(subjectId);
      const title = details.cleanTitle || details.title;

      if (details.type === "series" || (Array.isArray(details.seasons) && details.seasons.length > 0)) {
        return await this.sendSeriesSeasonSelector(chatId, subjectId, origMsgId);
      }

      // If multiple audio dubs exist, show Language Selection step
      if (Array.isArray(details.dubs) && details.dubs.length > 1) {
        const keyboard = [];
        let row = [];
        const defaultHindiIdx = details.dubs.findIndex((d) => d.isHindi);
        const preselectDubId = defaultHindiIdx !== -1 ? details.dubs[defaultHindiIdx].subjectId : details.dubs[0].subjectId;

        details.dubs.forEach((d) => {
          const isDef = d.subjectId === preselectDubId;
          const flag = d.isHindi ? "🇮🇳 " : "";
          const shortName = d.languageName.replace(/ dub$/i, "");
          row.push({
            text: `${isDef ? "⭐ " : ""}${flag}${shortName}${isDef ? " (Default)" : ""}`,
            callback_data: `step:lang:m:${subjectId}:0:0:${d.subjectId}`,
          });
          if (row.length === 2) {
            keyboard.push(row);
            row = [];
          }
        });
        if (row.length > 0) keyboard.push(row);
        keyboard.push([{ text: "« Back to Main Menu", callback_data: "menu:start" }]);

        const promptText =
          `🎬 *${title}* (${details.year || "N/A"})\n` +
          `⭐ *Rating:* ${details.rating || "N/A"} | 📝 *Genres:* ${(details.genres || []).join(", ") || "General"}\n\n` +
          `🔊 *Step 1/2: Select Audio Language / Dub:*`;

        if (origMsgId) {
          try {
            await this.callApi("editMessageText", {
              chat_id: chatId,
              message_id: origMsgId,
              text: promptText,
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: keyboard },
            });
            return;
          } catch (_) {}
        }

        await this.callApi("sendMessage", {
          chat_id: chatId,
          text: promptText,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: keyboard },
        });
        return;
      }

      // Only 1 dub available -> proceed directly to Quality selection
      const targetDubId = (Array.isArray(details.dubs) && details.dubs[0]?.subjectId) || subjectId;
      await this.sendQualitySelector(chatId, "m", subjectId, 0, 0, targetDubId, origMsgId);
    } catch (err) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Error fetching movie details: ${err.message}`,
      });
    }
  }

  async handleSeriesEpisodeSelect(chatId, subjectId, season, episode, origMsgId = null) {
    try {
      await this.client.ensureSession();
      const details = await this.client.getDetails(subjectId);
      const title = details.cleanTitle || details.title;

      // If multiple audio dubs exist, show Language Selection step
      if (Array.isArray(details.dubs) && details.dubs.length > 1) {
        const keyboard = [];
        let row = [];
        const defaultHindiIdx = details.dubs.findIndex((d) => d.isHindi);
        const preselectDubId = defaultHindiIdx !== -1 ? details.dubs[defaultHindiIdx].subjectId : details.dubs[0].subjectId;

        details.dubs.forEach((d) => {
          const isDef = d.subjectId === preselectDubId;
          const flag = d.isHindi ? "🇮🇳 " : "";
          const shortName = d.languageName.replace(/ dub$/i, "");
          row.push({
            text: `${isDef ? "⭐ " : ""}${flag}${shortName}${isDef ? " (Default)" : ""}`,
            callback_data: `step:lang:s:${subjectId}:${season}:${episode}:${d.subjectId}`,
          });
          if (row.length === 2) {
            keyboard.push(row);
            row = [];
          }
        });
        if (row.length > 0) keyboard.push(row);
        keyboard.push([{ text: "« Back to Episodes", callback_data: `step:back:ep:${subjectId}:${season}` }]);

        const promptText =
          `📺 *${title}* — *Season ${season} Episode ${episode}*\n\n` +
          `🔊 *Step 1/2: Select Audio Language / Dub:*`;

        if (origMsgId) {
          try {
            await this.callApi("editMessageText", {
              chat_id: chatId,
              message_id: origMsgId,
              text: promptText,
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: keyboard },
            });
            return;
          } catch (_) {}
        }

        await this.callApi("sendMessage", {
          chat_id: chatId,
          text: promptText,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: keyboard },
        });
        return;
      }

      // Only 1 dub available -> proceed directly to Quality selection
      const targetDubId = (Array.isArray(details.dubs) && details.dubs[0]?.subjectId) || subjectId;
      await this.sendQualitySelector(chatId, "s", subjectId, season, episode, targetDubId, origMsgId);
    } catch (err) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Error fetching series episode: ${err.message}`,
      });
    }
  }

  // ============================================================
  // STEP 3: QUALITY (HEVC) SELECTOR
  // ============================================================

  async sendQualitySelector(chatId, type, subjectId, season, episode, dubId, origMsgId = null) {
    try {
      await this.client.ensureSession();
      const details = await this.client.getDetails(subjectId);
      const title = details.cleanTitle || details.title;

      let chosenDubName = "Original / Hindi Audio";
      if (Array.isArray(details.dubs) && details.dubs.length > 0) {
        const found = details.dubs.find((d) => d.subjectId === dubId);
        if (found) {
          chosenDubName = `${found.isHindi ? "🇮🇳 " : ""}${found.languageName}`;
        }
      }

      const keyboard = [
        [
          {
            text: "⚡ Auto / Adaptive HEVC (Recommended)",
            callback_data: `step:play:${type}:${subjectId}:${season}:${episode}:${dubId}:auto`,
          },
        ],
        [
          {
            text: "✨ 1080p [FHD HEVC H.265]",
            callback_data: `step:play:${type}:${subjectId}:${season}:${episode}:${dubId}:0`,
          },
          {
            text: "🎬 720p [HD HEVC H.265]",
            callback_data: `step:play:${type}:${subjectId}:${season}:${episode}:${dubId}:1`,
          },
        ],
        [
          {
            text: "📱 480p [SD Data Saver]",
            callback_data: `step:play:${type}:${subjectId}:${season}:${episode}:${dubId}:2`,
          },
        ],
      ];

      // Back navigation button
      if (Array.isArray(details.dubs) && details.dubs.length > 1) {
        keyboard.push([
          {
            text: "« Back to Audio Language",
            callback_data: `step:back:lang:${type}:${subjectId}:${season}:${episode}`,
          },
        ]);
      } else if (type === "s") {
        keyboard.push([
          {
            text: "« Back to Episodes",
            callback_data: `step:back:ep:${subjectId}:${season}`,
          },
        ]);
      } else {
        keyboard.push([
          {
            text: "« Back to Main Menu",
            callback_data: "menu:start",
          },
        ]);
      }

      const headerTitle = type === "s"
        ? `📺 *${title}* — *Season ${season} Episode ${episode}*`
        : `🎬 *${title}* (${details.year || "N/A"})`;

      const promptText =
        `${headerTitle}\n` +
        `🔊 *Selected Audio:* ${chosenDubName}\n\n` +
        `⚙️ *Step 2/2: Select Video Quality (HEVC / H.265):*`;

      if (origMsgId) {
        try {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: origMsgId,
            text: promptText,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
          return;
        } catch (_) {}
      }

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: promptText,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Error: ${err.message}`,
      });
    }
  }

  // ============================================================
  // STEP 4: FINAL STREAM CARD & PLAYER LAUNCH BUTTONS
  // ============================================================

  async sendFinalStreamPlayerCard(chatId, type, subjectId, season, episode, dubId, quality = "auto", origMsgId = null) {
    try {
      await this.client.ensureSession();
      const details = await this.client.getDetails(subjectId);
      const title = details.cleanTitle || details.title;
      const isSeries = type === "s" || season > 0;

      let targetSubjectId = dubId || subjectId;
      let dubInfo = "Original / Hindi Audio";

      if (Array.isArray(details.dubs) && details.dubs.length > 0) {
        const found = details.dubs.find((d) => d.subjectId === targetSubjectId);
        if (found) {
          dubInfo = `${found.isHindi ? "🇮🇳 " : ""}${found.languageName}`;
        }
      }

      let streamInfo = await this.client.getStreams(targetSubjectId, season, episode);
      let streamUrl = "";

      if (streamInfo && streamInfo.streams && streamInfo.streams.length > 0) {
        const s = streamInfo.streams[0];
        streamUrl = s.streamUrl;
      } else if (targetSubjectId !== subjectId) {
        const origStream = await this.client.getStreams(subjectId, season, episode);
        if (origStream && origStream.streams && origStream.streams.length > 0) {
          const s = origStream.streams[0];
          streamUrl = s.streamUrl;
          dubInfo = "Original Audio";
          targetSubjectId = subjectId;
        }
      }

      if (!streamUrl) {
        const fallback = await MultiProvider.resolveAny(title, season, episode);
        if (fallback && fallback.streamUrl) {
          streamUrl = fallback.streamUrl;
        }
      }

      if (!streamUrl) {
        await this.callApi("sendMessage", {
          chat_id: chatId,
          text: `❌ Stream not available for *${title}*.`,
          parse_mode: "Markdown",
        });
        return;
      }

      let qualityLabel = "Auto (Adaptive Multi-Bitrate HEVC)";
      let qQuery = "";

      if (quality === "0") {
        qualityLabel = "1080p FHD HEVC (H.265)";
        qQuery = "?q=0";
      } else if (quality === "1") {
        qualityLabel = "720p HD HEVC (H.265)";
        qQuery = "?q=1";
      } else if (quality === "2") {
        qualityLabel = "480p SD HEVC (Data Saver)";
        qQuery = "?q=2";
      }

      const label = isSeries ? `${title} S${season}E${episode}` : title;
      const miniAppUrl = this.getMiniAppUrl(targetSubjectId, season, episode, quality, label, {
        year: details.year,
        rating: details.rating,
      });

      const headerText = isSeries
        ? `📺 *${title}* — *Season ${season} Episode ${episode}*`
        : `🎬 *${title}* (${details.year || "N/A"})`;

      const text =
        `${headerText}\n\n` +
        `⭐ *Rating:* ${details.rating || "N/A"} | 🎞️ *Codec:* HEVC (H.265 / hev1)\n` +
        `🔊 *Audio:* ${dubInfo}\n` +
        `⚙️ *Quality:* ${qualityLabel}\n` +
        `📝 *Genres:* ${(details.genres || []).join(", ") || "General"}\n\n` +
        `⚡ *Tap below to watch in CineFlix OTT:*`;

      const keyboard = [
        [
          { text: "▶️ Watch in CineFlix OTT", web_app: { url: miniAppUrl } },
        ],
      ];

      const navRow = [
        { text: "⚙️ Change Quality", callback_data: `step:back:qual:${type}:${subjectId}:${season}:${episode}:${targetSubjectId}` },
      ];

      if (Array.isArray(details.dubs) && details.dubs.length > 1) {
        navRow.push({
          text: "🔊 Change Audio",
          callback_data: `step:back:lang:${type}:${subjectId}:${season}:${episode}`,
        });
      }

      keyboard.push(navRow);
      keyboard.push([{ text: "« Back to Main Menu", callback_data: "menu:start" }]);

      const fullMessage = text;

      if (origMsgId) {
        await this.callApi("deleteMessage", {
          chat_id: chatId,
          message_id: origMsgId,
        }).catch(() => {});
      }

      const sendWithFallback = async (usePhoto = true) => {
        try {
          if (usePhoto && details.cover) {
            await this.callApi("sendPhoto", {
              chat_id: chatId,
              photo: details.cover,
              caption: fullMessage,
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: keyboard },
            });
          } else {
            await this.callApi("sendMessage", {
              chat_id: chatId,
              text: fullMessage,
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: keyboard },
            });
          }
        } catch (sendErr) {
          // If Telegram WebApp button was rejected (e.g. strict host rule), retry with normal url button
          const fallbackKeyboard = keyboard.map((row) =>
            row.map((btn) => (btn.web_app ? { text: btn.text, url: btn.web_app.url } : btn))
          );
          await this.callApi("sendMessage", {
            chat_id: chatId,
            text: fullMessage,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: fallbackKeyboard },
          });
        }
      };

      await sendWithFallback(Boolean(details.cover));
    } catch (err) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Stream extraction error: ${err.message}`,
      });
    }
  }

  async sendSeriesSeasonSelector(chatId, subjectId, origMsgId = null) {
    try {
      await this.client.ensureSession();
      const details = await this.client.getDetails(subjectId);
      const title = details.cleanTitle || details.title;
      const seasons = details.seasons || [];

      if (seasons.length === 0) {
        await this.sendSeriesEpisodeSelector(chatId, subjectId, 1, origMsgId);
        return;
      }

      const keyboard = [];
      let row = [];
      seasons.forEach((s) => {
        row.push({
          text: `Season ${s.se}`,
          callback_data: `se:${subjectId}:${s.se}`,
        });
        if (row.length === 3) {
          keyboard.push(row);
          row = [];
        }
      });
      if (row.length > 0) keyboard.push(row);
      keyboard.push([{ text: "« Back to Main Menu", callback_data: "menu:start" }]);

      const promptText = `📺 *${title}*\nSelect a Season:`;

      if (origMsgId) {
        try {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: origMsgId,
            text: promptText,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
          return;
        } catch (_) {}
      }

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: promptText,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Error: ${err.message}`,
      });
    }
  }

  async sendSeriesEpisodeSelector(chatId, subjectId, season, origMsgId = null) {
    try {
      await this.client.ensureSession();
      const details = await this.client.getDetails(subjectId);
      const title = details.cleanTitle || details.title;
      const foundSeason = (details.seasons || []).find((s) => s.se === season);
      const totalEpisodes = foundSeason?.maxEp || 24;

      const keyboard = [];
      let row = [];
      for (let ep = 1; ep <= Math.min(totalEpisodes, 50); ep++) {
        row.push({
          text: `Ep ${ep}`,
          callback_data: `ep:${subjectId}:${season}:${ep}`,
        });
        if (row.length === 4) {
          keyboard.push(row);
          row = [];
        }
      }
      if (row.length > 0) keyboard.push(row);
      keyboard.push([{ text: "« Back to Seasons", callback_data: `step:back:season:${subjectId}` }]);

      const promptText = `📺 *${title}* — Season ${season}\nSelect an Episode:`;

      if (origMsgId) {
        try {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: origMsgId,
            text: promptText,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
          return;
        } catch (_) {}
      }

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: promptText,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Error: ${err.message}`,
      });
    }
  }
}

const botInstance = new MovieBoxTelegramBot();

module.exports = {
  MovieBoxTelegramBot,
  botInstance,
};
