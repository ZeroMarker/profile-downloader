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
// The pending list is stored under its own key and rewritten only when items
// are added or removed out of order. Starting a download just advances
// pendingConsumed, so a 1000-item queue is not re-serialized per file.
const DOWNLOAD_PENDING_KEY = 'downloadQueuePending';
let pendingDirty = false;
let pendingConsumed = 0;
let downloadQueueState = {
  pending: [],
  active: {},
  completed: 0,
  failed: 0,
  lastError: null,
};
let queuePumpRunning = false;
// Downloads can finish (e.g. a local blob) before chrome.downloads.download()
// resolves with their ID; remember those results until the item is tracked.
const earlySettled = new Map();
const downloadQueueLoaded = loadDownloadQueueState();

// Completed downloads keyed by their saved path ("ProfileDownloader/x/alice_A/123.jpg").
// Filenames are derived from stable media IDs, so the path identifies the media.
const DOWNLOAD_HISTORY_KEY = 'downloadHistory';
const DOWNLOAD_HISTORY_LIMIT = 50000;
let downloadHistory = {};
const downloadHistoryLoaded = loadDownloadHistory();
// Serializes enqueues so concurrent batches cannot both pass the duplicate check.
let enqueueChain = Promise.resolve();

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
  const stored = await chrome.storage.local.get([DOWNLOAD_QUEUE_KEY, DOWNLOAD_PENDING_KEY]);
  const state = stored?.[DOWNLOAD_QUEUE_KEY];
  if (!state) return;

  let pending;
  if (Array.isArray(state.pending)) {
    // Older format kept the pending list inside the queue state.
    pending = state.pending;
    pendingDirty = true;
  } else {
    const snapshot = Array.isArray(stored?.[DOWNLOAD_PENDING_KEY]) ? stored[DOWNLOAD_PENDING_KEY] : [];
    pendingConsumed = Math.max(0, Number(state.pendingConsumed) || 0);
    pending = snapshot.slice(pendingConsumed);
  }
  const valid = pending.filter((item) => !isTikTokWebEndpoint(item?.url));
  if (valid.length !== pending.length) pendingDirty = true;

  downloadQueueState = {
    pending: valid,
    active: state.active && typeof state.active === 'object' ? state.active : {},
    completed: Number(state.completed) || 0,
    failed: Number(state.failed) || 0,
    lastError: state.lastError || null,
  };
}

async function loadDownloadHistory() {
  try {
    const stored = await chrome.storage.local.get(DOWNLOAD_HISTORY_KEY);
    const history = stored?.[DOWNLOAD_HISTORY_KEY];
    if (history && typeof history === 'object' && !Array.isArray(history)) downloadHistory = history;
  } catch (_) {}
}

/**
 * Coalesce storage writes: while one write is in flight, later calls only mark
 * the value dirty and share a single follow-up write of the latest state.
 * Every caller's promise resolves once a write containing its change lands.
 */
function createCoalescedWriter(getEntries) {
  let inFlight = null;
  let dirty = false;
  return function write() {
    dirty = true;
    if (!inFlight) {
      inFlight = (async () => {
        try {
          while (dirty) {
            dirty = false;
            await chrome.storage.local.set(getEntries());
          }
        } finally {
          inFlight = null;
        }
      })();
    }
    return inFlight;
  };
}

const writeDownloadHistory = createCoalescedWriter(() => ({ [DOWNLOAD_HISTORY_KEY]: downloadHistory }));
// Completions are saved in groups. Losing an unsaved group is harmless:
// Chrome's own download records still identify those files as downloaded.
const HISTORY_SAVE_EVERY = 50;
let unsavedHistory = 0;

function persistDownloadHistory() {
  unsavedHistory = 0;
  const keys = Object.keys(downloadHistory);
  if (keys.length > DOWNLOAD_HISTORY_LIMIT) {
    keys.slice(0, keys.length - DOWNLOAD_HISTORY_LIMIT).forEach((key) => delete downloadHistory[key]);
  }
  return writeDownloadHistory();
}

async function recordCompletedDownload(item, downloadId) {
  if (!item?.path) return;
  await downloadHistoryLoaded;
  delete downloadHistory[item.path];
  downloadHistory[item.path] = downloadId;
  unsavedHistory++;
  const idle = !downloadQueueState.pending.length && !Object.keys(downloadQueueState.active).length;
  if (idle || unsavedHistory >= HISTORY_SAVE_EVERY) await persistDownloadHistory();
}

function trailingSegments(filename, count) {
  const parts = String(filename || '').replace(/\\/g, '/').split('/');
  return parts.length < count ? null : parts.slice(-count).join('/');
}

/**
 * Build a duplicate checker for many paths with one chrome.downloads.search
 * call. A path counts as downloaded when history has it and Chrome does not
 * report the file as deleted, or when Chrome has a completed download saved
 * at that path (covers files downloaded before history was recorded).
 */
async function createDownloadedChecker(paths) {
  await downloadHistoryLoaded;
  const byId = new Map();
  const bySuffix = new Map();
  try {
    const records = await chrome.downloads.search({ state: 'complete', limit: 0 });
    const depths = new Set(paths.map((path) => path.split('/').length));
    for (const record of records || []) {
      byId.set(record.id, record);
      if (record.exists === false) continue;
      for (const depth of depths) {
        const suffix = trailingSegments(record.filename, depth);
        if (suffix && !bySuffix.has(suffix)) bySuffix.set(suffix, record.id);
      }
    }
  } catch (_) {
    // Without Chrome's records, fall back to trusting history alone.
  }

  let historyChanged = false;
  const isDownloaded = (path) => {
    if (Object.prototype.hasOwnProperty.call(downloadHistory, path)) {
      const record = byId.get(Number(downloadHistory[path]));
      // A missing record only means the Chrome list was cleared; keep trusting history.
      if (!record || record.exists !== false) return true;
      delete downloadHistory[path];
      historyChanged = true;
    }
    if (!bySuffix.has(path)) return false;
    downloadHistory[path] = bySuffix.get(path);
    historyChanged = true;
    return true;
  };
  const save = () => (historyChanged ? persistDownloadHistory() : Promise.resolve());
  return { isDownloaded, save };
}

function queuedPaths() {
  const paths = new Set(downloadQueueState.pending.map((item) => item.path));
  Object.values(downloadQueueState.active).forEach((item) => paths.add(item.path));
  return paths;
}

/**
 * Return the requested filenames that are already downloaded or queued.
 */
async function findDownloadedFilenames(filenames) {
  if (!Array.isArray(filenames)) return [];
  await downloadQueueLoaded;
  const paths = filenames.map(resolveDownloadPath);
  const queued = queuedPaths();
  const checker = await createDownloadedChecker(paths);
  const found = filenames.filter((filename, index) => queued.has(paths[index]) || checker.isDownloaded(paths[index]));
  await checker.save();
  return found;
}

async function clearDownloadHistory() {
  await downloadHistoryLoaded;
  downloadHistory = {};
  await persistDownloadHistory();
}

function isTikTokWebEndpoint(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname === 'www.tiktok.com' || url.hostname === 'tiktok.com';
  } catch (_) {
    return false;
  }
}

const persistDownloadQueue = createCoalescedWriter(() => {
  const { pending, ...rest } = downloadQueueState;
  const entries = { [DOWNLOAD_QUEUE_KEY]: { ...rest, pendingConsumed } };
  if (pendingDirty) {
    entries[DOWNLOAD_PENDING_KEY] = pending.slice();
    entries[DOWNLOAD_QUEUE_KEY].pendingConsumed = 0;
    pendingConsumed = 0;
    pendingDirty = false;
  }
  return entries;
});

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

    case 'downloadPreparedMedia':
      startPreparedDownload(request.item, sender.tab?.id, sender.documentId)
        .then((result) => sendResponse({ success: true, ...result }))
        .catch((err) => sendResponse({ success: false, error: err.message || 'Download failed' }));
      return true;

    case 'getDownloadedFilenames':
      findDownloadedFilenames(request.filenames)
        .then((filenames) => sendResponse({ success: true, filenames }))
        .catch((err) => sendResponse({ success: false, error: err.message, filenames: [] }));
      return true;

    case 'clearDownloadHistory':
      clearDownloadHistory()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
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
function resolveDownloadPath(filename) {
  // Preserve nested folders while sanitizing each path segment.
  const parts = String(filename || 'media').split('/');
  const filePart = parts.pop() || 'media';
  const folderParts = parts;

  // Sanitize folder name
  const safeFolder = folderParts.map(part => part.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').replace(/[. ]+$/g, '') || '_').join('/');
  // Sanitize file name
  const safeFile = filePart.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').replace(/^_+|_+$/g, '') || 'media';

  return safeFolder
    ? `${settings.downloadPath}/${safeFolder}/${safeFile}`
    : `${settings.downloadPath}/${safeFile}`;
}

async function handleDownload(url, filename, retries = 1) {
  validateDownloadUrl(url);
  const fullPath = resolveDownloadPath(filename);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const downloadId = await chrome.downloads.download({
        url,
        filename: fullPath,
        saveAs: false,
        // Same path means same media ID; never create "name (1).ext" copies.
        conflictAction: 'overwrite',
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
function enqueueDownloadBatch(items, sourceTabId, sourceDocumentId) {
  const run = enqueueChain.then(() => enqueueDownloadBatchNow(items, sourceTabId, sourceDocumentId));
  enqueueChain = run.catch(() => {});
  return run;
}

async function enqueueDownloadBatchNow(items, sourceTabId, sourceDocumentId) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('No media items to download');
  }

  await downloadQueueLoaded;
  const batchId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const accepted = [];
  const errors = [];
  const skippedIds = [];
  const seenPaths = queuedPaths();
  const paths = items.map((item) => resolveDownloadPath(item?.filename));
  const checker = await createDownloadedChecker(paths);

  for (const [index, item] of items.entries()) {
    try {
      validateDownloadUrl(item.url);
      const path = paths[index];
      if (seenPaths.has(path) || checker.isDownloaded(path)) {
        skippedIds.push(item.id);
        continue;
      }
      seenPaths.add(path);
      accepted.push({
        queueId: `${batchId}_${index}`,
        batchId,
        id: item.id,
        url: item.url,
        filename: item.filename,
        path,
        sourceTabId,
        sourceDocumentId,
      });
    } catch (err) {
      errors.push({ id: item.id, error: err.message || 'Invalid download' });
    }
  }

  if (!downloadQueueState.pending.length && !Object.keys(downloadQueueState.active).length && accepted.length) {
    downloadQueueState.lastError = null;
  }
  downloadQueueState.pending.push(...accepted);
  if (accepted.length) pendingDirty = true;
  await Promise.all([accepted.length ? persistDownloadQueue() : null, checker.save()]);
  pumpDownloadQueue();

  return {
    batchId,
    queued: accepted.length,
    skipped: skippedIds.length,
    skippedIds: skippedIds.slice(0, 50),
    failed: errors.length,
    errors: errors.slice(0, 10),
  };
}

async function startPreparedDownload(item, sourceTabId, sourceDocumentId) {
  if (!item?.url || !item?.filename) throw new Error('Invalid prepared download');
  validateDownloadUrl(item.url);
  if (item.url.startsWith('blob:') && sourceTabId == null) {
    throw new Error('Prepared video requires a source tab');
  }
  const result = await enqueueDownloadBatch([item], sourceTabId, sourceDocumentId);
  if (result.skipped) await releasePreparedBlob({ ...item, sourceTabId, sourceDocumentId });
  return result;
}

const PREPARED_SOURCE_ERROR = 'TikTok source page was closed or refreshed. Reopen the profile and retry the affected videos.';

function preparedMessageOptions(item) {
  return item.sourceDocumentId ? { documentId: item.sourceDocumentId } : {};
}

async function validatePreparedBlob(item) {
  if (!item.url.startsWith('blob:')) return;
  try {
    const response = await chrome.tabs.sendMessage(item.sourceTabId, {
      action: 'validatePreparedBlob', url: item.url,
    }, preparedMessageOptions(item));
    if (response?.valid) return;
  } catch (_) {}
  throw new Error(PREPARED_SOURCE_ERROR);
}

async function invalidatePreparedDownloads(tabId) {
  await downloadQueueLoaded;
  const stale = downloadQueueState.pending.filter((item) => item.sourceTabId === tabId && item.url.startsWith('blob:'));
  if (!stale.length) return;
  downloadQueueState.pending = downloadQueueState.pending.filter((item) => !stale.includes(item));
  pendingDirty = true;
  downloadQueueState.failed += stale.length;
  downloadQueueState.lastError = PREPARED_SOURCE_ERROR;
  await persistDownloadQueue();
  await Promise.all(stale.map(releasePreparedBlob));
  pumpDownloadQueue();
}

async function releasePreparedBlob(item) {
  if (!item?.url?.startsWith('blob:') || item.sourceTabId == null) return;
  try {
    await chrome.tabs.sendMessage(item.sourceTabId, {
      action: 'releasePreparedBlob', url: item.url,
    }, preparedMessageOptions(item));
  } catch (_) {
    // Closing the source document also releases its object URLs.
  }
}

async function getDownloadQueueStatus() {
  await downloadQueueLoaded;
  return {
    pending: downloadQueueState.pending.length,
    active: Object.keys(downloadQueueState.active).length,
    completed: downloadQueueState.completed,
    failed: downloadQueueState.failed,
    lastError: downloadQueueState.lastError,
  };
}

async function pumpDownloadQueue() {
  if (queuePumpRunning) return;
  queuePumpRunning = true;

  try {
    await downloadQueueLoaded;
    const limit = Math.max(1, Math.min(10, Number(settings.maxConcurrent) || 3));
    let started = null;

    while (
      downloadQueueState.pending.length > 0
      && Object.keys(downloadQueueState.active).length < limit
    ) {
      const item = downloadQueueState.pending.shift();
      pendingConsumed++;
      try {
        await validatePreparedBlob(item);
        const downloadId = await handleDownload(item.url, item.filename);
        downloadQueueState.active[String(downloadId)] = item;
        if (earlySettled.has(downloadId)) {
          const failed = earlySettled.get(downloadId);
          earlySettled.delete(downloadId);
          settleQueuedDownload(downloadId, failed);
        }
      } catch (err) {
        downloadQueueState.failed++;
        downloadQueueState.lastError = err.message || 'Download failed';
        await releasePreparedBlob(item);
        console.error(`[ProfileDownloader] Could not start ${item.id}:`, err);
      }
      // Coalesced: no await, so a long queue does not wait on one write per item.
      started = persistDownloadQueue();
    }
    await started;
  } finally {
    queuePumpRunning = false;
  }
}

async function settleQueuedDownload(downloadId, failed) {
  await downloadQueueLoaded;
  const key = String(downloadId);
  if (!downloadQueueState.active[key]) {
    if (queuePumpRunning) earlySettled.set(Number(downloadId), failed);
    return;
  }

  const item = downloadQueueState.active[key];
  delete downloadQueueState.active[key];
  if (failed) downloadQueueState.failed++;
  else downloadQueueState.completed++;
  await persistDownloadQueue();
  if (!failed) await recordCompletedDownload(item, downloadId);
  pumpDownloadQueue();
  await releasePreparedBlob(item);
}

async function reconcileActiveDownloads() {
  await downloadQueueLoaded;
  let changed = false;

  for (const key of Object.keys(downloadQueueState.active)) {
    const matches = await chrome.downloads.search({ id: Number(key) });
    const download = matches[0];
    if (download?.state === 'in_progress') continue;

    const item = downloadQueueState.active[key];
    delete downloadQueueState.active[key];
    if (download?.state === 'complete') {
      downloadQueueState.completed++;
      await recordCompletedDownload(item, Number(key));
    } else downloadQueueState.failed++;
    changed = true;
    await releasePreparedBlob(item);
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

  if (isTikTokWebEndpoint(url.href)) {
    throw new Error('TikTok web endpoint is not a direct CDN video URL; refresh the page and scan again');
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

chrome.tabs.onRemoved.addListener((tabId) => {
  invalidatePreparedDownloads(tabId).catch(console.error);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') invalidatePreparedDownloads(tabId).catch(console.error);
});

downloadQueueLoaded.then(() => reconcileActiveDownloads());
