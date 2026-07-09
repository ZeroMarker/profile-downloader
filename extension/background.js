/**
 * Profile Media Downloader — Background Service Worker
 * Handles download requests, storage, and cross-tab communication.
 */

// Service Worker startup log — if you see this, the SW is alive
console.log('[ProfileDownloader] Service Worker started');

// Download queue for sequential processing (avoids Chrome download limits)
let downloadQueue = [];
let activeDownloads = 0;
let MAX_CONCURRENT = 3;

// Default settings (overwritten by chrome.storage on install)
let settings = {
  downloadPath: 'ProfileDownloader',
  maxConcurrent: 3,
};

/**
 * Load settings from storage on startup.
 */
chrome.storage?.local.get(['downloadPath', 'maxConcurrent'], (result) => {
  if (result.downloadPath) settings.downloadPath = result.downloadPath;
  if (result.maxConcurrent) {
    settings.maxConcurrent = result.maxConcurrent;
    MAX_CONCURRENT = result.maxConcurrent;
  }
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
        const sources = [window.__INITIAL_STATE__, window.__NEXT_DATA__, window.__data];
        const videoUrls = [];
        const seen = new Set();
        sources.forEach(function(src) {
          if (!src) return;
          var str = JSON.stringify(src);
          var re = /https?:\/\/video\.twimg\.com\/[^\s"\)']+\.mp4/g;
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

    case 'getStorage':
      chrome.storage.local.get(request.keys, (result) => {
        sendResponse(result);
      });
      return true;

    case 'setStorage':
      chrome.storage.local.set(request.data, () => {
        if (request.data?.maxConcurrent) {
          settings.maxConcurrent = request.data.maxConcurrent;
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
  }
  if (delta.error?.current) {
    console.error(`[ProfileDownloader] Download failed (${delta.id}): ${delta.error.current}`);
  }
});
