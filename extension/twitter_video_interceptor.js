/**
 * Runs in X's main world before the application starts. It observes timeline
 * responses and publishes complete progressive MP4 variants to the isolated
 * content script without changing the responses consumed by X.
 */
(function () {
  'use strict';

  const bufferedUrls = new Set();
  window.__PROFILE_DOWNLOADER_VIDEO_URLS__ = [];

  function isCompleteVideoUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const path = url.pathname;
      return url.hostname === 'video.twimg.com'
        && path.endsWith('.mp4')
        && !path.includes('/aud/')
        && !/\/vid\/(?:avc1|hevc)\/\d+\/\d+\//i.test(path)
        && !/\/(?:init|segment|chunk)[^/]*\.mp4$/i.test(path);
    } catch (_) {
      return false;
    }
  }

  function publishVideoUrls(text) {
    if (!text || !String(text).includes('video.twimg.com')) return;

    const decoded = String(text)
      .replace(/\\u002F/gi, '/')
      .replace(/\\\//g, '/')
      .replace(/&amp;/gi, '&');
    const matches = decoded.match(
      /https?:\/\/video\.twimg\.com\/[^\s"<>']+?\.mp4(?:\?[^\s"<>']*)?/gi
    ) || [];
    const added = [];

    matches.forEach((rawUrl) => {
      if (!isCompleteVideoUrl(rawUrl) || bufferedUrls.has(rawUrl)) return;
      bufferedUrls.add(rawUrl);
      added.push(rawUrl);
    });

    if (added.length === 0) return;
    window.__PROFILE_DOWNLOADER_VIDEO_URLS__ = Array.from(bufferedUrls);
    window.postMessage({
      source: 'profile-downloader',
      type: 'twitter-videos',
      urls: added,
    }, '*');
  }

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        if (response.url.includes('/graphql/')) {
          response.clone().text().then(publishVideoUrls).catch(() => {});
        }
      } catch (_) {}
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (...args) {
    this.__profileDownloaderUrl = String(args[1] || '');
    return originalOpen.apply(this, args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__profileDownloaderUrl.includes('/graphql/')) {
      this.addEventListener('load', function () {
        try {
          const body = typeof this.response === 'string'
            ? this.response
            : JSON.stringify(this.response);
          publishVideoUrls(body);
        } catch (_) {}
      }, { once: true });
    }
    return originalSend.apply(this, args);
  };
})();
