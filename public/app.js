let currentType = 0;
let currentSelectedMedia = null;
let currentLanguage = "hi";
let adminToken = sessionStorage.getItem("cineflix_admin_token") || "";

// Active Theater Video Player instances & states
let activeHls = null;
let activeDash = null;
let currentPlayingSubjectId = null;
let currentPlayingSeason = 0;
let currentPlayingEpisode = 0;
let currentActiveStreamUrl = "";

document.addEventListener("DOMContentLoaded", () => {
  initApp();
});

function initApp() {
  const adminPinInput = document.getElementById("adminPinInput");
  if (adminPinInput) {
    adminPinInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") submitAdminPin();
    });
  }

  if (adminToken) {
    unlockPortalUI();
    checkApiHealth();
    setupEventListeners();
    quickSearch("Avengers");
  } else {
    lockAdminPortal();
  }
}

async function submitAdminPin() {
  const pinInput = document.getElementById("adminPinInput");
  const errElem = document.getElementById("adminPinError");
  const pin = pinInput.value.trim();

  if (!pin) {
    errElem.innerText = "Please enter the Admin PIN";
    return;
  }

  errElem.innerText = "Verifying PIN...";

  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();

    if (res.ok && data.token) {
      adminToken = data.token;
      sessionStorage.setItem("cineflix_admin_token", adminToken);
      errElem.innerText = "";
      pinInput.value = "";
      unlockPortalUI();
      checkApiHealth();
      setupEventListeners();
      quickSearch("Avengers");
    } else {
      errElem.innerText = data.error || "Invalid Admin PIN. Access Denied.";
      shakeCard();
    }
  } catch (err) {
    errElem.innerText = "Server error: " + err.message;
  }
}

function unlockPortalUI() {
  document.getElementById("adminLockOverlay").style.display = "none";
  document.getElementById("appContainer").style.display = "block";
}

function lockAdminPortal() {
  adminToken = "";
  sessionStorage.removeItem("cineflix_admin_token");
  document.getElementById("adminLockOverlay").style.display = "flex";
  document.getElementById("appContainer").style.display = "none";
  const pinInput = document.getElementById("adminPinInput");
  if (pinInput) {
    pinInput.value = "";
    pinInput.focus();
  }
}

function shakeCard() {
  const card = document.querySelector(".admin-lock-card");
  if (card) {
    card.classList.add("shake");
    setTimeout(() => card.classList.remove("shake"), 500);
  }
}

function getAuthHeaders() {
  return {
    "Content-Type": "application/json",
    "x-app-key": adminToken,
  };
}

function setupEventListeners() {
  const searchInput = document.getElementById("searchInput");
  const searchBtn = document.getElementById("searchBtn");

  searchBtn.addEventListener("click", () => {
    const q = searchInput.value.trim();
    if (q) performSearch(q);
  });

  searchInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      const q = searchInput.value.trim();
      if (q) performSearch(q);
    }
  });

  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      e.target.classList.add("active");
      currentType = parseInt(e.target.dataset.type);
      const q = searchInput.value.trim() || "Avengers";
      performSearch(q);
    });
  });
}

async function checkApiHealth() {
  const statusText = document.getElementById("statusText");
  try {
    const res = await fetch("/api/health", { headers: getAuthHeaders() });
    const data = await res.json();
    if (res.ok) {
      statusText.innerText = "Online • Secured 🛡️";
      statusText.style.color = "#10b981";
    } else {
      statusText.innerText = "API Error";
      statusText.style.color = "#ef4444";
    }
  } catch (e) {
    statusText.innerText = "Offline";
    statusText.style.color = "#ef4444";
  }
}

function quickSearch(keyword) {
  document.getElementById("searchInput").value = keyword;
  performSearch(keyword);
}

async function performSearch(query) {
  const loading = document.getElementById("loading");
  const catalogGrid = document.getElementById("catalogGrid");
  const resultsInfo = document.getElementById("resultsInfo");
  const resultsHeading = document.getElementById("resultsHeading");
  const resultsCount = document.getElementById("resultsCount");

  loading.style.display = "block";
  catalogGrid.innerHTML = "";
  resultsInfo.style.display = "none";

  try {
    const res = await fetch(
      `/api/search?q=${encodeURIComponent(query)}&type=${currentType}&page=1`,
      { headers: getAuthHeaders() }
    );
    if (res.status === 401) {
      lockAdminPortal();
      return;
    }
    const data = await res.json();

    loading.style.display = "none";
    resultsInfo.style.display = "flex";
    resultsHeading.innerText = `Results for "${query}"`;
    resultsCount.innerText = `${data.items?.length || 0} items`;

    if (!data.items || data.items.length === 0) {
      catalogGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px 0;">No results found. Try another search.</div>`;
      return;
    }

    renderCatalog(data.items);
  } catch (err) {
    loading.style.display = "none";
    catalogGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: #ef4444; padding: 40px 0;">Error fetching results: ${err.message}</div>`;
  }
}

function renderCatalog(items) {
  const catalogGrid = document.getElementById("catalogGrid");
  catalogGrid.innerHTML = "";

  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "card";
    const poster =
      item.cover ||
      "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&auto=format&fit=crop&q=60";
    const typeLabel = item.type === "series" ? "TV Series" : "Movie";
    const typeClass = item.type === "series" ? "series" : "movie";

    let hindiTag = "";
    if (item.isHindi) {
      hindiTag = `<span class="card-lang-tag hindi">Hindi 🇮🇳</span>`;
    }

    card.innerHTML = `
      <div class="card-poster-wrap">
        <img class="card-poster" src="${poster}" alt="${item.title}" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&auto=format&fit=crop&q=60'" />
        <span class="card-type-tag ${typeClass}">${typeLabel}</span>
        ${hindiTag}
        <div class="card-overlay">
          <button class="btn btn-play" title="Play Video" onclick="openDetails('${item.subjectId}')">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
        </div>
      </div>
      <div class="card-info" onclick="openDetails('${item.subjectId}')">
        <h3 class="card-title" title="${item.title}">${item.cleanTitle || item.title}</h3>
        <div class="card-meta">
          <span>${item.year || "N/A"}</span>
          <span>${item.rating ? "⭐ " + item.rating : ""}</span>
        </div>
      </div>
    `;

    catalogGrid.appendChild(card);
  });
}

async function openDetails(subjectId) {
  const modal = document.getElementById("detailsModal");
  const modalBody = document.getElementById("modalBody");
  modal.classList.add("open");

  modalBody.innerHTML = `
    <div style="text-align: center; padding: 40px 0;">
      <div class="spinner"></div>
      <p style="color: var(--text-secondary);">Loading details & audio dubs...</p>
    </div>
  `;

  try {
    const res = await fetch(`/api/details/${subjectId}`, { headers: getAuthHeaders() });
    if (res.status === 401) {
      lockAdminPortal();
      return;
    }
    const data = await res.json();
    const details = (data.title || data.id) ? data : (data.details || {});
    currentSelectedMedia = details;

    const poster =
      details.cover ||
      "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&auto=format&fit=crop&q=60";

    let effectiveSubjectId = details.id || details.subjectId || subjectId;
    let dubOptionsHtml = "";
    const dubList = details.dubs || details.dubAudioList || [];
    if (dubList && dubList.length > 0) {
      let optionsHtml = "";
      let foundSelected = false;

      dubList.forEach((dub) => {
        const langName = dub.languageName || dub.language || "Unknown";
        const langCode = dub.languageCode || dub.langCode || "en";
        const isDefault =
          dub.isHindi ||
          langName.toLowerCase().includes("hindi") ||
          langCode === "hi";

        if (isDefault && !foundSelected) {
          optionsHtml += `<option value="${dub.subjectId}" data-lang="${langCode}" selected>🇮🇳 ${langName} (Default Auto-Select)</option>`;
          effectiveSubjectId = dub.subjectId;
          foundSelected = true;
        } else {
          optionsHtml += `<option value="${dub.subjectId}" data-lang="${langCode}">${langName}</option>`;
        }
      });

      dubOptionsHtml = `
        <div class="dub-selector-wrap">
          <label>Audio Dub / Language:</label>
          <select id="dubLanguageSelect" class="select-input" onchange="onDubLanguageChange(this.value)">
            ${optionsHtml}
          </select>
        </div>
      `;
    }

    let seasonHtml = "";
    if (details.type === "series" && details.seasons && details.seasons.length > 0) {
      let seasonOptions = "";
      details.seasons.forEach((s) => {
        seasonOptions += `<option value="${s.seasonNumber}">Season ${s.seasonNumber} (${s.episodeCount} Episodes)</option>`;
      });

      let epOptions = "";
      const epCount = details.seasons[0].episodeCount || 10;
      for (let i = 1; i <= epCount; i++) {
        epOptions += `<option value="${i}">Episode ${i}</option>`;
      }

      seasonHtml = `
        <div class="season-selector-wrap">
          <label>Select Season & Episode:</label>
          <div class="season-controls">
            <select id="seasonSelect" class="select-input" onchange="onSeasonSelectChange()">${seasonOptions}</select>
            <select id="episodeSelect" class="select-input">${epOptions}</select>
          </div>
        </div>
      `;
    }

    modalBody.innerHTML = `
      <div class="details-layout">
        <div class="details-poster">
          <img src="${poster}" alt="${details.title}" />
        </div>
        <div class="details-info">
          <h1 class="details-title">${details.cleanTitle || details.title}</h1>
          <div class="details-meta-tags">
            <span class="meta-pill">${details.year || "N/A"}</span>
            <span class="meta-pill">${details.type === "series" ? "TV Series" : "Movie"}</span>
            <span class="meta-pill">⭐ ${details.rating || "N/A"}</span>
            ${details.isHindi ? `<span class="meta-pill" style="background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid #10b981;">Hindi Audio 🇮🇳</span>` : ""}
            ${(details.genres || []).map((g) => `<span class="meta-pill">${g}</span>`).join("")}
          </div>
          <p class="details-desc">${details.description || "No description available."}</p>
          ${dubOptionsHtml}
          ${seasonHtml}
          <div class="btn-actions">
            <button class="btn btn-launch-mpv" style="flex: 1;" onclick="startTheaterPlayer('${effectiveSubjectId}')">
              ▶ Watch Video in Browser (Direct Play)
            </button>
            <button class="btn btn-secondary" onclick="loadAndPlayStreams('${effectiveSubjectId}')">
              ⚙️ External Players (MX / VLC / MPV)
            </button>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    modalBody.innerHTML = `<p style="color: #ef4444;">Failed to load details: ${err.message}</p>`;
  }
}

function onSeasonSelectChange() {
  const seasonSelect = document.getElementById("seasonSelect");
  const episodeSelect = document.getElementById("episodeSelect");
  if (!seasonSelect || !episodeSelect || !currentSelectedMedia) return;

  const sNum = parseInt(seasonSelect.value) || 1;
  const sData = (currentSelectedMedia.seasons || []).find((s) => s.seasonNumber === sNum);
  const epCount = sData?.episodeCount || 10;

  let epOptions = "";
  for (let i = 1; i <= epCount; i++) {
    epOptions += `<option value="${i}">Episode ${i}</option>`;
  }
  episodeSelect.innerHTML = epOptions;
}

function onDubLanguageChange(newSubjectId) {
  const dubSelect = document.getElementById("dubLanguageSelect");
  if (!dubSelect) return;
  const selectedOption = dubSelect.options[dubSelect.selectedIndex];
  currentLanguage = selectedOption.dataset.lang || "hi";
}

function closeDetailsModal() {
  document.getElementById("detailsModal").classList.remove("open");
}

/* ==========================================================================
   🎬 Theater Video Player Engine (HLS.js + DASH.js + HTML5)
   ========================================================================== */

async function startTheaterPlayer(subjectId) {
  let targetId = subjectId;
  const dubSelect = document.getElementById("dubLanguageSelect");
  if (dubSelect) {
    targetId = dubSelect.value || subjectId;
  }

  let season = 0;
  let episode = 0;
  const seasonSelect = document.getElementById("seasonSelect");
  const episodeSelect = document.getElementById("episodeSelect");
  if (seasonSelect && episodeSelect) {
    season = parseInt(seasonSelect.value) || 1;
    episode = parseInt(episodeSelect.value) || 1;
  }

  closeDetailsModal();
  openTheaterModal(targetId, season, episode);
}

async function openTheaterModal(subjectId, season = 0, episode = 0) {
  currentPlayingSubjectId = subjectId;
  currentPlayingSeason = season;
  currentPlayingEpisode = episode;

  const modal = document.getElementById("videoModal");
  const titleElem = document.getElementById("videoPlayerTitle");
  const metaElem = document.getElementById("videoPlayerMeta");
  const overlay = document.getElementById("videoOverlayLoading");
  const overlayText = document.getElementById("videoOverlayLoadingText");
  const epControls = document.getElementById("videoEpisodeControls");
  const currentEpLabel = document.getElementById("currentEpLabel");
  const dubSelect = document.getElementById("playerDubSelect");

  modal.classList.add("open");

  const mediaTitle = currentSelectedMedia?.cleanTitle || currentSelectedMedia?.title || "Video Stream";
  titleElem.innerText = mediaTitle;

  metaElem.innerHTML = `
    ${season > 0 ? `<span class="meta-pill">Season ${season} • Episode ${episode}</span>` : `<span class="meta-pill">Movie</span>`}
    <span class="meta-pill" style="color: #10b981; border-color: #10b981;">Audio: Hindi 🇮🇳 Priority</span>
  `;

  if (season > 0) {
    epControls.style.display = "flex";
    currentEpLabel.innerText = `S${season} E${episode}`;
  } else {
    epControls.style.display = "none";
  }

  // Populate Dubs in Player if available
  const currentDubs = currentSelectedMedia?.dubs || currentSelectedMedia?.dubAudioList || [];
  if (currentDubs && currentDubs.length > 0) {
    dubSelect.style.display = "block";
    let opts = "";
    currentDubs.forEach((dub) => {
      const isSelected = dub.subjectId === subjectId;
      const langName = dub.languageName || dub.language || "Audio";
      opts += `<option value="${dub.subjectId}" ${isSelected ? "selected" : ""}>🗣️ ${langName}</option>`;
    });
    dubSelect.innerHTML = opts;
  } else {
    dubSelect.style.display = "none";
  }

  overlayText.innerText = "Decrypting stream manifest & audio tracks...";
  overlay.classList.remove("hidden");

  // Determine stream URLs
  const hostOrigin = window.location.origin;
  const isSeries = season > 0;
  const hlsUrl = isSeries
    ? `${hostOrigin}/id/${subjectId}/${season}/${episode}/index.m3u8`
    : `${hostOrigin}/id/${subjectId}/movie/index.m3u8`;
  const dashUrl = isSeries
    ? `${hostOrigin}/id/${subjectId}/${season}/${episode}/index.mpd`
    : `${hostOrigin}/id/${subjectId}/movie/index.mpd`;

  currentActiveStreamUrl = hlsUrl;

  // Setup external player buttons
  const cleanTitle = encodeURIComponent(mediaTitle);
  const cleanPath = hlsUrl.replace(/^https?:\/\//i, "");
  const scheme = window.location.protocol.replace(":", "");
  
  const mxIntent = `intent://${cleanPath}#Intent;scheme=${scheme};package=com.mxtech.videoplayer.ad;type=video/*;S.title=${cleanTitle};end`;
  const vlcIntent = `intent://${cleanPath}#Intent;scheme=${scheme};package=org.videolan.vlc;action=android.intent.action.VIEW;type=video/*;S.title=${cleanTitle};end`;
  const m3uUrl = `${hostOrigin}/play/playlist.m3u?id=${subjectId}&s=${season}&e=${episode}&title=${cleanTitle}`;

  document.getElementById("playerMxBtn").href = mxIntent;
  document.getElementById("playerVlcBtn").href = vlcIntent;
  document.getElementById("playerM3uBtn").href = m3uUrl;

  // Launch the streaming video engine
  playStreamOnVideoElement(hlsUrl, dashUrl);
}

function playStreamOnVideoElement(hlsUrl, dashUrl) {
  const video = document.getElementById("mainVideoPlayer");
  const overlay = document.getElementById("videoOverlayLoading");
  const overlayText = document.getElementById("videoOverlayLoadingText");
  const engineText = document.getElementById("videoEngineText");

  // Reset existing instances
  if (activeHls) {
    activeHls.destroy();
    activeHls = null;
  }
  if (activeDash) {
    activeDash.reset();
    activeDash = null;
  }

  overlayText.innerText = "Connecting to HLS Stream Engine...";
  overlay.classList.remove("hidden");
  engineText.innerText = "HLS Adaptive Engine";

  if (window.Hls && Hls.isSupported()) {
    activeHls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 90,
      capLevelToPlayerSize: true,
    });

    activeHls.loadSource(hlsUrl);
    activeHls.attachMedia(video);

    activeHls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      overlay.classList.add("hidden");
      video.play().catch(() => {});
    });

    activeHls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        console.warn("HLS engine error, falling back to DASH engine:", data);
        activeHls.destroy();
        activeHls = null;
        playDashFallback(dashUrl);
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Native Safari / iOS
    video.src = hlsUrl;
    video.addEventListener("loadedmetadata", () => {
      overlay.classList.add("hidden");
      video.play().catch(() => {});
    });
    video.addEventListener("error", () => {
      playDashFallback(dashUrl);
    });
  } else {
    playDashFallback(dashUrl);
  }
}

function playDashFallback(dashUrl) {
  const video = document.getElementById("mainVideoPlayer");
  const overlay = document.getElementById("videoOverlayLoading");
  const overlayText = document.getElementById("videoOverlayLoadingText");
  const engineText = document.getElementById("videoEngineText");

  overlayText.innerText = "Switching to DASH Engine...";
  engineText.innerText = "DASH Engine";

  if (window.dashjs) {
    try {
      activeDash = dashjs.MediaPlayer().create();
      activeDash.initialize(video, dashUrl, true);
      activeDash.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
        overlay.classList.add("hidden");
        video.play().catch(() => {});
      });
      activeDash.on(dashjs.MediaPlayer.events.ERROR, (e) => {
        console.error("DASH error:", e);
        overlayText.innerText = "Stream playback failed. Try external player.";
      });
    } catch (err) {
      console.error("DASH init failed:", err);
      overlayText.innerText = "Stream playback failed. Try external player.";
    }
  } else {
    video.src = dashUrl;
    overlay.classList.add("hidden");
    video.play().catch(() => {});
  }
}

function onPlayerDubChange(newSubjectId) {
  if (!newSubjectId) return;
  openTheaterModal(newSubjectId, currentPlayingSeason, currentPlayingEpisode);
}

function navigateEpisode(direction) {
  if (currentPlayingSeason <= 0) return;
  const newEp = currentPlayingEpisode + direction;
  if (newEp < 1) return;

  const seasonData = (currentSelectedMedia?.seasons || []).find((s) => s.seasonNumber === currentPlayingSeason);
  const maxEp = seasonData?.episodeCount || 999;
  if (newEp > maxEp) return;

  openTheaterModal(currentPlayingSubjectId, currentPlayingSeason, newEp);
}

function closeVideoModal() {
  const modal = document.getElementById("videoModal");
  const video = document.getElementById("mainVideoPlayer");

  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  if (activeHls) {
    activeHls.destroy();
    activeHls = null;
  }
  if (activeDash) {
    activeDash.reset();
    activeDash = null;
  }

  modal.classList.remove("open");
}

function copyActiveStreamUrl() {
  if (!currentActiveStreamUrl) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(currentActiveStreamUrl).then(() => showToast("✓ Stream Link Copied!"));
  } else {
    showToast("✓ Stream Link Ready");
  }
}

/* ==========================================================================
   ⚙️ External Stream Modal Launcher
   ========================================================================== */

async function loadAndPlayStreams(subjectId) {
  let targetId = subjectId;
  const dubSelect = document.getElementById("dubLanguageSelect");
  if (dubSelect) {
    targetId = dubSelect.value || subjectId;
  }

  let season = 0;
  let episode = 0;
  const seasonSelect = document.getElementById("seasonSelect");
  const episodeSelect = document.getElementById("episodeSelect");
  if (seasonSelect && episodeSelect) {
    season = parseInt(seasonSelect.value) || 1;
    episode = parseInt(episodeSelect.value) || 1;
  }

  closeDetailsModal();
  openStreamModal(targetId, season, episode);
}

async function openStreamModal(subjectId, season, episode) {
  const modal = document.getElementById("streamModal");
  const titleElem = document.getElementById("streamTitle");
  const metaElem = document.getElementById("streamMeta");
  const controlsElem = document.getElementById("streamControls");

  modal.classList.add("open");
  const mediaTitle = currentSelectedMedia?.cleanTitle || currentSelectedMedia?.title || "Stream";
  titleElem.innerText = mediaTitle;
  metaElem.innerHTML = `
    ${season > 0 ? `<span class="meta-pill">Season ${season} • Episode ${episode}</span>` : `<span class="meta-pill">Movie Stream</span>`}
    <span class="meta-pill" style="color: #10b981; border-color: #10b981;">Audio: Hindi 🇮🇳 Priority</span>
  `;

  controlsElem.innerHTML = `
    <div style="text-align: center; padding: 30px 0;">
      <div class="spinner"></div>
      <p style="color: var(--text-secondary);">Decrypting CloudFront Signed Cookies & DASH Manifest...</p>
    </div>
  `;

  try {
    const res = await fetch(`/api/streams/${subjectId}?season=${season}&episode=${episode}`, {
      headers: getAuthHeaders(),
    });
    if (res.status === 401) {
      lockAdminPortal();
      return;
    }
    const data = await res.json();

    if (!data.streams || data.streams.length === 0) {
      controlsElem.innerHTML = `<p style="color: #ef4444; padding: 20px 0;">No active stream source found for this title.</p>`;
      return;
    }

    renderStreamControls(data.streams, mediaTitle, subjectId, season, episode);
  } catch (err) {
    controlsElem.innerHTML = `<p style="color: #ef4444;">Stream resolution failed: ${err.message}</p>`;
  }
}

function renderStreamControls(streams, mediaTitle, subjectId, season = 0, episode = 0) {
  const controlsElem = document.getElementById("streamControls");
  controlsElem.innerHTML = "";

  const hostOrigin = window.location.origin;
  const isSeries = season > 0;
  const hlsUrl = isSeries
    ? `${hostOrigin}/id/${subjectId}/${season}/${episode}/index.m3u8`
    : `${hostOrigin}/id/${subjectId}/movie/index.m3u8`;

  streams.forEach((s, idx) => {
    const card = document.createElement("div");
    card.className = "stream-item-card";

    let subsHtml = "";
    if (s.subtitles && s.subtitles.length > 0) {
      subsHtml = `
        <div style="margin-top: 14px; font-size: 0.85rem; color: var(--text-secondary);">
          <strong>Subtitles:</strong> ${s.subtitles
            .map(
              (sub) =>
                `<span style="color: ${
                  sub.isHindi ? "#10b981" : "#38bdf8"
                }; font-weight: ${sub.isHindi ? "bold" : "normal"}; margin-right: 8px;">${
                  sub.isHindi ? "🇮🇳 " : ""
                }${sub.name}</span>`
            )
            .join("")}
        </div>
      `;
    }

    const cleanTitle = encodeURIComponent(mediaTitle);
    const cleanPath = hlsUrl.replace(/^https?:\/\//i, "");
    const scheme = window.location.protocol.replace(":", "");
    const mxIntent = `intent://${cleanPath}#Intent;scheme=${scheme};package=com.mxtech.videoplayer.ad;type=video/*;S.title=${cleanTitle};end`;
    const vlcIntent = `intent://${cleanPath}#Intent;scheme=${scheme};package=org.videolan.vlc;action=android.intent.action.VIEW;type=video/*;S.title=${cleanTitle};end`;

    card.innerHTML = `
      <div class="stream-item-header">
        <div>
          <strong style="font-size: 1.15rem; color: #fff;">Stream #${idx + 1}: ${s.format}</strong>
          <span class="meta-pill" style="margin-left: 8px;">${s.resolutionLabel}</span>
          <span class="meta-pill">${s.codec}</span>
        </div>
      </div>

      <div class="primary-launch-actions" style="margin: 16px 0; display: flex; flex-direction: column; gap: 12px;">
        <!-- 0. Play In Browser Button -->
        <button class="btn btn-launch-mpv" onclick="closeStreamModal(); openTheaterModal('${subjectId}', ${season}, ${episode});">
          ▶ Watch in Web Player (Direct Play)
        </button>

        <!-- 1. Primary MPV Player Button -->
        <button class="btn btn-primary" onclick="launchInExternalPlayer('${escapeStr(s.streamUrl)}', '${escapeStr(s.signCookie)}', 'mpv', '${escapeStr(mediaTitle)}')">
          🚀 Play in MPV Player (PC Desktop)
        </button>

        <!-- 2. VLC Launcher Button -->
        <a class="btn btn-launch-vlc" href="${vlcIntent}">
          📱 Play in VLC Player (Android / PC)
        </a>

        <!-- 3. MX Player Launcher Button -->
        <a class="btn btn-launch-mx" href="${mxIntent}">
          🎬 Play in MX Player (Android)
        </a>
      </div>
      ${subsHtml}
    `;

    controlsElem.appendChild(card);
  });
}

async function launchInExternalPlayer(streamUrl, signCookie, player, title) {
  showToast(`Launching ${player.toUpperCase()}...`);
  try {
    const res = await fetch("/api/launch-player", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({
        streamUrl,
        signCookie,
        player,
        title,
      }),
    });
    const data = await res.json();
    if (res.ok && data.success && data.launched) {
      showToast(`✓ Started ${player.toUpperCase()} for "${title}"`);
    } else {
      showToast(`ℹ️ ${data.message || "Player not installed. Playing in Browser."}`);
    }
  } catch (e) {
    showToast("⚠️ Launch error: " + e.message);
  }
}

function closeStreamModal() {
  document.getElementById("streamModal").classList.remove("open");
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.innerText = msg;
  toast.className = "toast show";
  setTimeout(() => {
    toast.className = toast.className.replace("show", "");
  }, 3500);
}

function escapeStr(str) {
  if (!str) return "";
  return String(str).replace(/'/g, "\\'");
}
