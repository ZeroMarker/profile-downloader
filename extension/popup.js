/**
 * Profile Media Downloader — Popup Script
 * Manages the extension popup UI and orchestrates WASM-backed media processing.
 *
 * WASM is loaded dynamically — if it fails, we fall back to pure JS.
 * The popup is never blocked by WASM loading.
 */

// WASM reference (loaded dynamically)
let wasm = null;

// State
let state = {
  platform: null,
  tabId: null,
  username: null,
  mediaItems: [],
  selectedIds: new Set(),
  isDownloading: false,
  wasmReady: false,
  monitorTimer: null,
};

// DOM refs
const $ = (sel) => document.querySelector(sel);
const sections = {
  status: $('#status-section'),
  profile: $('#profile-section'),
  media: $('#media-section'),
  progress: $('#progress-section'),
  error: $('#error-section'),
};

/**
 * Initialize WASM module via dynamic import.
 * If this fails, we fall back to JS — never blocks the popup.
 */
async function initWasm() {
  try {
    const mod = await import('./wasm/profile_downloader_core.js');
    await mod.default(); // call init() from the wasm module
    wasm = mod;
    state.wasmReady = true;
    console.log('[ProfileDownloader] WASM core loaded');
  } catch (err) {
    console.warn('[ProfileDownloader] WASM load skipped, using JS fallback:', err.message);
  }
}

/**
 * Process media through WASM core (dedup, sort) with JS fallback.
 */
function processMedia(rawMedia) {
  if (state.wasmReady && wasm?.process_media_batch) {
    try {
      const jsonInput = JSON.stringify(rawMedia);
      const jsonOutput = wasm.process_media_batch(jsonInput);
      const result = JSON.parse(jsonOutput);
      if (result.error) {
        console.warn('[ProfileDownloader] WASM error:', result.error, '— using JS fallback');
        return jsFallbackProcess(rawMedia);
      }
      return result;
    } catch (err) {
      console.warn('[ProfileDownloader] WASM processing failed, using JS fallback:', err);
    }
  }
  return jsFallbackProcess(rawMedia);
}

/**
 * JS fallback: deduplicate by id, sort by timestamp descending.
 */
function jsFallbackProcess(media) {
  const seen = new Set();
  const deduped = media.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  deduped.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return deduped;
}

/**
 * Send a message to content script with a timeout.
 * chrome.tabs.sendMessage can hang if the content script is not responding.
 */
function sendMessageWithTimeout(tabId, message, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Content script did not respond (timeout)'));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message || 'Content script error'));
      } else {
        resolve(response);
      }
    });
  });
}

function isRecoverableContentScriptError(err) {
  const message = err?.message || '';
  return message.includes('Could not establish connection')
    || message.includes('Receiving end does not exist')
    || message.includes('Content script did not respond (timeout)');
}

/**
 * Initialize the popup — detect current tab and platform.
 * WASM is loaded in the background and never blocks the UI.
 */
async function init() {
  // Start loading WASM in background (non-blocking)
  initWasm();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      showError('No active tab detected.');
      return;
    }

    const url = new URL(tab.url);
    const hostname = url.hostname.toLowerCase();
    const isFileUrl = url.protocol === 'file:';
    const isHost = (domain) => hostname === domain || hostname.endsWith('.' + domain);

    // Detect platform (pure JS, always works regardless of WASM)
    let platform;
    if (isFileUrl) {
      // For local HTML exports, try to detect from filename first
      const path = decodeURIComponent(url.pathname).toLowerCase();
      if (path.includes('twitter') || path.includes('x.com')) platform = 'twitter';
      else if (path.includes('tiktok')) platform = 'tiktok';
      else if (path.includes('instagram')) platform = 'instagram';
      // If filename doesn't hint, content script will detect from page content
    } else if (isHost('twitter.com') || isHost('x.com')) {
      platform = 'twitter';
    } else if (isHost('tiktok.com')) {
      platform = 'tiktok';
    } else if (isHost('instagram.com')) {
      platform = 'instagram';
    }

    if (!platform) {
      showError('Not on a supported platform. Open X, TikTok, or Instagram.');
      return;
    }

    state.platform = platform;
    state.tabId = tab.id;

    // Show platform badge immediately
    const badges = {
      twitter: ['🐦', 'X / Twitter'],
      tiktok: ['🎵', 'TikTok'],
      instagram: ['📸', 'Instagram'],
    };
    const [icon, label] = badges[platform] || ['❓', platform];
    updatePlatformBadge(icon, label);

    // Check if we're on a profile page (not homepage/feed)
    // For file:// URLs, skip this check — content script handles it
    if (!isFileUrl) {
      const pathSegments = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
      if (pathSegments.length === 0) {
        showError('Please navigate to a user profile page first.');
        return;
      }
    }

    // Extract media from the page via content script (with timeout)
    const response = await sendMessageWithTimeout(tab.id, {
      action: 'extractMedia',
      platform: state.platform,
    }, state.platform === 'tiktok' ? 15000 : 5000);

    if (response?.error) {
      showError(response.error);
      return;
    }

    if (response?.media && response.media.length > 0) {
      // Process through WASM core if ready, else JS fallback
      state.mediaItems = processMedia(response.media);
      state.username = response.username;
      renderProfile(response.profileInfo);
      renderMediaList(state.mediaItems);
      await restoreDownloadState();
    } else {
      showError('No media found on this page. Try scrolling down to load more content.');
    }
  } catch (err) {
    if (isRecoverableContentScriptError(err)) {
      showError('Extension was updated. Refresh this page once, then open the extension again.');
    } else {
      console.error('[ProfileDownloader] Init error:', err);
      showError(err.message || 'Failed to initialize.');
    }
  }
}

async function restoreDownloadState() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'getDownloadQueueStatus' });
    if ((status?.pending || 0) + (status?.active || 0) === 0) return;
    state.isDownloading = true;
    $('#download-all-btn').disabled = true;
    $('#download-selected-btn').disabled = true;
    $('#select-all-btn').disabled = true;
    sections.progress.classList.remove('hidden');
    $('#progress-fill').style.width = '70%';
    $('#progress-text').textContent = `${status.pending || 0} queued, ${status.active || 0} downloading`;
    monitorDownloads();
  } catch (_) {}
}

function monitorDownloads() {
  if (state.monitorTimer) return;
  state.monitorTimer = setInterval(async () => {
    try {
      const status = await chrome.runtime.sendMessage({ action: 'getDownloadQueueStatus' });
      const remaining = (status?.pending || 0) + (status?.active || 0);
      if (remaining > 0) {
        $('#progress-text').textContent = `${status.pending || 0} queued, ${status.active || 0} downloading`;
        return;
      }
      clearInterval(state.monitorTimer);
      state.monitorTimer = null;
      state.isDownloading = false;
      $('#download-all-btn').disabled = false;
      $('#select-all-btn').disabled = false;
      $('#progress-fill').style.width = '100%';
      $('#progress-text').textContent = 'Downloads complete';
      updateDownloadButton();
    } catch (_) {}
  }, 1000);
}

/**
 * Update the platform badge at the top.
 */
function updatePlatformBadge(icon, text) {
  $('#platform-icon').textContent = icon;
  $('#platform-text').textContent = `Detected: ${text}`;
}

/**
 * Render profile information.
 */
function renderProfile(info) {
  if (!info) return;
  sections.profile.classList.remove('hidden');
  $('#profile-username').textContent = `@${info.username || state.username}`;
  $('#profile-display-name').textContent = info.display_name || '';
  const stats = [];
  if (info.post_count != null) stats.push(`${info.post_count} posts`);
  if (info.follower_count != null) stats.push(`${info.follower_count} followers`);
  if (info.following_count != null) stats.push(`${info.following_count} following`);
  $('#profile-stats').textContent = stats.join(' · ');
  if (info.avatar_url) {
    $('#profile-avatar').src = info.avatar_url;
  }
}

/**
 * Render the media grid.
 */
function renderMediaList(media) {
  sections.media.classList.remove('hidden');
  const grid = $('#media-list');
  const count = $('#media-count');
  const badge = state.wasmReady ? ' ⚡' : '';
  count.textContent = `${media.length} items${badge}`;

  if (media.length === 0) {
    grid.innerHTML = '<div class="loading">No media found.</div>';
    return;
  }

  grid.innerHTML = media
    .map((item, index) => {
      const isVideo = item.media_type === 'video' || item.media_type === 'Video';
      const thumb = item.thumbnail_url || item.url;
      return `
        <div class="media-item" data-index="${index}" data-id="${item.id}">
          <img src="${thumb}" alt="media" loading="lazy" class="media-thumbnail" />
          <span class="media-type-badge">${isVideo ? '🎬' : '🖼️'}</span>
          <span class="checkbox-overlay"></span>
        </div>
      `;
    })
    .join('');

  grid.querySelectorAll('.media-thumbnail').forEach((img) => {
    img.addEventListener('error', () => {
      img.style.display = 'none';
      img.parentElement?.classList.add('broken');
    }, { once: true });
  });

  // Click to toggle selection
  grid.querySelectorAll('.media-item').forEach((el) => {
    el.addEventListener('click', () => toggleSelection(el.dataset.id));
  });

  updateDownloadButton();
}

/**
 * Toggle selection of a media item.
 */
function toggleSelection(id) {
  if (state.isDownloading) return;
  if (state.selectedIds.has(id)) {
    state.selectedIds.delete(id);
  } else {
    state.selectedIds.add(id);
  }

  document.querySelectorAll('.media-item').forEach((el) => {
    el.classList.toggle('selected', state.selectedIds.has(el.dataset.id));
  });

  updateDownloadButton();
}

/**
 * Update the download button state.
 */
function updateDownloadButton() {
  const btn = $('#download-selected-btn');
  const count = state.selectedIds.size;
  btn.disabled = count === 0;
  btn.textContent = `Download Selected (${count})`;
}

/**
 * Start downloading selected or all media.
 */
async function startDownload(selectedOnly) {
  if (state.isDownloading) return;

  const items = selectedOnly
    ? state.mediaItems.filter((m) => state.selectedIds.has(m.id))
    : state.mediaItems;

  if (items.length === 0) return;
  state.isDownloading = true;

  $('#download-all-btn').disabled = true;
  $('#download-selected-btn').disabled = true;
  $('#select-all-btn').disabled = true;

  sections.progress.classList.remove('hidden');
  const fill = $('#progress-fill');
  const text = $('#progress-text');
  fill.style.width = '15%';
  text.textContent = `Adding ${items.length} files to Chrome downloads...`;

  try {
    const downloadItems = items.map((item) => ({
      id: item.id,
      url: item.url,
      filename: generateFilename(item),
    }));
    const response = state.platform === 'tiktok'
      ? await chrome.tabs.sendMessage(state.tabId, {
          action: 'downloadTikTokBatch',
          items: downloadItems,
        })
      : await chrome.runtime.sendMessage({
          action: 'downloadBatch',
          items: downloadItems,
        });
    if (!response || response.error) {
      throw new Error(response?.error || 'Could not start batch download');
    }

    fill.style.width = '100%';
    text.textContent = `${response.queued} files queued in background${
      response.failed > 0 ? ` (${response.failed} failed)` : ''
    }`;
  } catch (err) {
    console.error('[ProfileDownloader] Batch download failed:', err);
    fill.style.width = '100%';
    text.textContent = `Download failed: ${err.message || 'Unknown error'}`;
  }

  const queueStatus = await chrome.runtime.sendMessage({ action: 'getDownloadQueueStatus' });
  if ((queueStatus?.pending || 0) + (queueStatus?.active || 0) > 0) {
    state.isDownloading = true;
    text.textContent = `${queueStatus.pending || 0} queued, ${queueStatus.active || 0} downloading`;
    monitorDownloads();
  } else {
    state.isDownloading = false;
    $('#download-all-btn').disabled = false;
    $('#select-all-btn').disabled = false;
    updateDownloadButton();
  }
}

/**
 * Generate a filename with user folder: {platform}_{username}/{id}.{ext}
 * Chrome downloads API creates subdirectories automatically.
 */
function generateFilename(item) {
  const ext = getExtension(item);
  const safeUsername = (item.username || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeId = (item.id || 'media').replace(/[^a-zA-Z0-9_-]/g, '_');
  // Folder per user
  const userFolder = `${item.platform}_${safeUsername}`;
  return `${userFolder}/${safeId}.${ext}`;
}

/**
 * Get file extension from media type.
 */
function getExtension(item) {
  if (item.media_type === 'video' || item.media_type === 'Video') return 'mp4';
  if (item.content_type?.includes('png')) return 'png';
  if (item.content_type?.includes('gif')) return 'gif';
  if (item.content_type?.includes('webp')) return 'webp';
  if (item.content_type?.includes('webm')) return 'webm';
  if (item.content_type?.includes('mp4')) return 'mp4';
  return 'jpg';
}

/**
 * Show error in the UI.
 */
function showError(msg) {
  sections.error.classList.remove('hidden');
  $('#error-text').textContent = msg;
}

// ===== Event Listeners =====
document.addEventListener('DOMContentLoaded', init);

$('#select-all-btn')?.addEventListener('click', () => {
  if (state.isDownloading) return;
  const allSelected = state.mediaItems.length > 0 && state.selectedIds.size === state.mediaItems.length;
  state.selectedIds.clear();
  if (!allSelected) {
    state.mediaItems.forEach((m) => state.selectedIds.add(m.id));
  }
  document.querySelectorAll('.media-item').forEach((el) => {
    el.classList.toggle('selected', state.selectedIds.has(el.dataset.id));
  });
  updateDownloadButton();
});

$('#download-selected-btn')?.addEventListener('click', () => startDownload(true));
$('#download-all-btn')?.addEventListener('click', () => startDownload(false));

$('#retry-btn')?.addEventListener('click', () => {
  sections.error.classList.add('hidden');
  init();
});
