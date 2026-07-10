/**
 * Profile Media Downloader — Background Service Worker
 * Handles download requests, storage, and cross-tab communication.
 */

// Service Worker startup log — if you see this, the SW is alive
console.log('[ProfileDownloader] Service Worker started');

// Default settings (overwritten by chrome.storage on install)
let settings = {
  downloadPath: 'ProfileDownloader',
  maxConcurrent: 3,
};

const DOWNLOAD_QUEUE_KEY = 'downloadQueueState';
let downloadQueueState = {
  pending: [],
  active: {},
  completed: 0,
  failed: 0,
};
let queuePumpRunning = false;
const downloadQueueLoaded = loadDownloadQueueState();

/**
 * Load settings from storage on startup.
 */
chrome.storage?.local.get(['downloadPath', 'maxConcurrent'], (result) => {
  if (result.downloadPath) settings.downloadPath = result.downloadPath;
  if (result.maxConcurrent) {
    settings.maxConcurrent = result.maxConcurrent;
  }
  pumpDownloadQueue();
});

async function loadDownloadQueueState() {
  const stored = await chrome.storage.local.get(DOWNLOAD_QUEUE_KEY);
  const state = stored?.[DOWNLOAD_QUEUE_KEY];
  if (!state) return;

  downloadQueueState = {
    pending: Array.isArray(state.pending) ? state.pending : [],
    active: state.active && typeof state.active === 'object' ? state.active : {},
    completed: Number(state.completed) || 0,
    failed: Number(state.failed) || 0,
  };
}

async function persistDownloadQueue() {
  await chrome.storage.local.set({ [DOWNLOAD_QUEUE_KEY]: downloadQueueState });
}

/**
 * Inject video URL extraction code into the page's main world context.
 * Uses chrome.scripting.executeScript with world: 'MAIN' to bypass
 * page CSP that blocks inline <script> injection.
 * The injected code reads window.__INITIAL_STATE__ etc. and posts
 * results back via window.postMessage.
 */
async function injectVideoExtractor(tabId) {
  if (!tabId) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      try {
        const sources = [
          window.__INITIAL_STATE__,
          window.__NEXT_DATA__,
          window.__data,
          window.__PROFILE_DOWNLOADER_VIDEO_URLS__,
        ];
        performance.getEntriesByType('resource').forEach(function(entry) {
          sources.push(entry.name);
        });
        const videoUrls = [];
        const seen = new Set();
        sources.forEach(function(src) {
          if (!src) return;
          var str = (typeof src === 'string' ? src : JSON.stringify(src))
            .replace(/\\u002F/gi, '/')
            .replace(/\\\//g, '/');
          var re = /https?:\/\/video\.twimg\.com\/[^\s"<>']+?\.mp4(?:\?[^\s"<>']*)?/g;
          var m;
          while ((m = re.exec(str)) !== null) {
            if (!seen.has(m[0])) { seen.add(m[0]); videoUrls.push(m[0]); }
          }
        });
        if (videoUrls.length > 0) {
          window.postMessage({
            source: 'profile-downloader',
            type: 'twitter-videos',
            urls: videoUrls,
          }, '*');
        }
      } catch(e) {}
    },
  });
}

/**
 * Handle messages from popup and content scripts.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'downloadMedia':
      handleDownload(request.url, request.filename)
        .then((downloadId) => sendResponse({ success: true, downloadId }))
        .catch((err) => {
          console.error('[ProfileDownloader] Download error:', err);
          sendResponse({ success: false, error: err.message || 'Download failed' });
        });
      return true; // Keep channel open for async response

    case 'downloadBatch':
      enqueueDownloadBatch(request.items)
        .then((result) => sendResponse({ success: true, ...result }))
        .catch((err) => {
          console.error('[ProfileDownloader] Batch download error:', err);
          sendResponse({ success: false, error: err.message || 'Batch download failed' });
        });
      return true;

    case 'getDownloadQueueStatus':
      getDownloadQueueStatus().then(sendResponse);
      return true;

    case 'getStorage':
      chrome.storage.local.get(request.keys, (result) => {
        sendResponse(result);
      });
      return true;

    case 'setStorage':
      chrome.storage.local.set(request.data, () => {
        if (request.data?.maxConcurrent) {
          settings.maxConcurrent = request.data.maxConcurrent;
          pumpDownloadQueue();
        }
        sendResponse({ success: true });
      });
      return true;

    case 'getSettings':
      sendResponse(settings);
      return false;

    case 'injectVideoExtractor':
      // Inject video URL extraction code into the page's main world
      // Bypasses page CSP that blocks inline <script> injection
      injectVideoExtractor(sender.tab?.id)
        .then(() => sendResponse({ success: true }))
        .catch((err) => {
          console.warn('[ProfileDownloader] injectVideoExtractor failed:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true;
  }
});

/**
 * Download a media file using the Chrome downloads API.
 * Includes basic retry logic for transient failures.
 * The `filename` parameter may include subdirectories: "user_folder/file.ext"
 */
async function handleDownload(url, filename, retries = 1) {
  validateDownloadUrl(url);

  // Split into folder and file parts (expected format: "user_folder/file.ext")
  const parts = (filename || 'media').split('/');
  const filePart = parts.pop() || 'media';
  const folderPart = parts.join('_');

  // Sanitize folder name
  const safeFolder = folderPart.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').replace(/^_+|_+$/g, '');
  // Sanitize file name
  const safeFile = filePart.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').replace(/^_+|_+$/g, '');

  const fullPath = safeFolder
    ? `${settings.downloadPath}/${safeFolder}/${safeFile}`
    : `${settings.downloadPath}/${safeFile}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const downloadId = await chrome.downloads.download({
        url,
        filename: fullPath,
        saveAs: false,
        conflictAction: 'uniquify',
      });
      return downloadId;
    } catch (err) {
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Persist a complete batch before replying to the popup. The service worker
 * starts only maxConcurrent downloads and advances the queue on completion.
 */
async function enqueueDownloadBatch(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('No media items to download');
  }

  await downloadQueueLoaded;
  const batchId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const accepted = [];
  const errors = [];

  items.forEach((item, index) => {
    try {
      validateDownloadUrl(item.url);
      accepted.push({
        queueId: `${batchId}_${index}`,
        batchId,
        id: item.id,
        url: item.url,
        filename: item.filename,
      });
    } catch (err) {
      errors.push({ id: item.id, error: err.message || 'Invalid download' });
    }
  });

  downloadQueueState.pending.push(...accepted);
  await persistDownloadQueue();
  pumpDownloadQueue();

  return {
    batchId,
    queued: accepted.length,
    failed: errors.length,
    errors: errors.slice(0, 10),
  };
}

async function getDownloadQueueStatus() {
  await downloadQueueLoaded;
  return {
    pending: downloadQueueState.pending.length,
    active: Object.keys(downloadQueueState.active).length,
    completed: downloadQueueState.completed,
    failed: downloadQueueState.failed,
  };
}

async function pumpDownloadQueue() {
  if (queuePumpRunning) return;
  queuePumpRunning = true;

  try {
    await downloadQueueLoaded;
    const limit = Math.max(1, Math.min(10, Number(settings.maxConcurrent) || 3));

    while (
      downloadQueueState.pending.length > 0
      && Object.keys(downloadQueueState.active).length < limit
    ) {
      const item = downloadQueueState.pending.shift();
      try {
        const downloadId = await handleDownload(item.url, item.filename);
        downloadQueueState.active[String(downloadId)] = item;
      } catch (err) {
        downloadQueueState.failed++;
        console.error(`[ProfileDownloader] Could not start ${item.id}:`, err);
      }
      await persistDownloadQueue();
    }
  } finally {
    queuePumpRunning = false;
  }
}

async function settleQueuedDownload(downloadId, failed) {
  await downloadQueueLoaded;
  const key = String(downloadId);
  if (!downloadQueueState.active[key]) return;

  delete downloadQueueState.active[key];
  if (failed) downloadQueueState.failed++;
  else downloadQueueState.completed++;
  await persistDownloadQueue();
  pumpDownloadQueue();
}

async function reconcileActiveDownloads() {
  await downloadQueueLoaded;
  let changed = false;

  for (const key of Object.keys(downloadQueueState.active)) {
    const matches = await chrome.downloads.search({ id: Number(key) });
    const download = matches[0];
    if (download?.state === 'in_progress') continue;

    delete downloadQueueState.active[key];
    if (download?.state === 'complete') downloadQueueState.completed++;
    else downloadQueueState.failed++;
    changed = true;
  }

  if (changed) await persistDownloadQueue();
  pumpDownloadQueue();
}

function validateDownloadUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    throw new Error('Invalid media URL');
  }

  if (url.hostname !== 'video.twimg.com') return;
  const path = url.pathname;
  if (path.includes('/aud/') || /\/vid\/(?:avc1|hevc)\/\d+\/\d+\//i.test(path)) {
    throw new Error('Incomplete X video stream detected; refresh the page and scan again');
  }
  if (/\/(?:init|segment|chunk)[^/]*\.mp4$/i.test(path)) {
    throw new Error('Incomplete X video stream detected; refresh the page and scan again');
  }
}

/**
 * Handle extension installation / update.
 */
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.local.set({
      downloadPath: 'ProfileDownloader',
      maxConcurrent: 3,
      autoSelect: false,
    });
  }
});

/**
 * Handle downloads API events for tracking and logging.
 */
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === 'complete') {
    console.log(`[ProfileDownloader] Download complete: ${delta.id}`);
    settleQueuedDownload(delta.id, false);
  }
  if (delta.error?.current) {
    console.error(`[ProfileDownloader] Download failed (${delta.id}): ${delta.error.current}`);
    settleQueuedDownload(delta.id, true);
  }
});

downloadQueueLoaded.then(() => reconcileActiveDownloads());
