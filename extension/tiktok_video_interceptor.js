/**
 * Runs in TikTok's main world before the application starts. It observes API
 * responses and publishes direct video CDN URLs to the isolated content script.
 */
(function () {
  'use strict';

  const published = new Map();

  function firstUrl(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.find((item) => typeof item === 'string') || null;
    return null;
  }

  function directUrl(value) {
    const raw = firstUrl(value);
    if (!raw) return null;
    try {
      const url = new URL(raw.replace(/\\u002F/gi, '/').replace(/\\\//g, '/'));
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      if (/\/@[^/]+\/video\/\d+/.test(url.pathname)) return null;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function bestVideoUrl(candidates) {
    const urls = [];
    function add(value) {
      if (Array.isArray(value)) {
        value.forEach(add);
        return;
      }
      const url = directUrl(value);
      if (url && !urls.includes(url)) urls.push(url);
    }
    candidates.forEach(add);

    function score(rawUrl) {
      const url = new URL(rawUrl);
      let value = 0;
      if (url.hostname !== 'www.tiktok.com' && url.hostname !== 'tiktok.com') value += 100;
      if (/\/(?:video\/tos|obj\/tos|tos-)/i.test(url.pathname)) value += 50;
      if (/mime_type=video|video_mp4/i.test(url.search)) value += 20;
      if (/\/aweme\/v\d+\/play|\/player\/v\d+/i.test(url.pathname)) value -= 100;
      return value;
    }

    return urls.sort((a, b) => score(b) - score(a))[0] || null;
  }

  function extractVideos(payload) {
    const found = [];
    const visited = new Set();

    function walk(value) {
      if (!value || typeof value !== 'object' || visited.has(value)) return;
      visited.add(value);

      const item = value.itemStruct || value;
      const id = String(item.id || item.aweme_id || item.awemeId || '');
      const video = item.video;
      if (id && video && typeof video === 'object') {
        const candidates = [
          video.playAddr,
          video.downloadAddr,
          video.play_addr?.url_list,
          video.download_addr?.url_list,
          video.bitRate?.[0]?.playAddr?.UrlList,
          video.bitrateInfo?.[0]?.PlayAddr?.UrlList,
        ];
        const url = bestVideoUrl(candidates);
        if (url && published.get(id) !== url) {
          published.set(id, url);
          found.push({ id, url });
        }
      }

      Object.values(value).forEach(walk);
    }

    walk(payload);
    return found;
  }

  function publishBody(body) {
    if (!body) return;
    try {
      const payload = typeof body === 'string' ? JSON.parse(body) : body;
      const videos = extractVideos(payload);
      if (videos.length > 0) {
        window.postMessage({
          source: 'profile-downloader',
          type: 'tiktok-videos',
          videos,
        }, '*');
      }
    } catch (_) {}
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'profile-downloader') return;
    if (event.data?.type === 'tiktok-video-request') {
      const videos = Array.from(published, ([id, url]) => ({ id, url }));
      if (videos.length > 0) {
        window.postMessage({
          source: 'profile-downloader',
          type: 'tiktok-videos',
          videos,
        }, '*');
      }
      return;
    }

    if (event.data?.type === 'tiktok-download-request') {
      downloadVideo(event.data);
      return;
    }

    if (event.data?.type === 'tiktok-revoke-blob' && event.data?.blobUrl) {
      URL.revokeObjectURL(event.data.blobUrl);
    }
  });

  async function downloadVideo(request) {
    try {
      const response = await fetch(request.url, {
        credentials: 'include',
        redirect: 'follow',
        headers: { accept: 'video/*,*/*;q=0.8' },
      });
      if (!response.ok) throw new Error(`TikTok returned HTTP ${response.status}`);
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html')) {
        throw new Error('TikTok returned an HTML page instead of video data');
      }
      const blob = await response.blob();
      if (blob.size === 0 || (!blob.type.startsWith('video/') && blob.size < 100000)) {
        throw new Error(`TikTok returned invalid media (${blob.type || 'unknown type'})`);
      }

      const objectUrl = URL.createObjectURL(blob);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
      window.postMessage({
        source: 'profile-downloader',
        type: 'tiktok-download-result',
        requestId: request.requestId,
        success: true,
        bytes: blob.size,
        blobUrl: objectUrl,
      }, '*');
    } catch (err) {
      window.postMessage({
        source: 'profile-downloader',
        type: 'tiktok-download-result',
        requestId: request.requestId,
        success: false,
        error: err?.message || 'TikTok video fetch failed',
      }, '*');
    }
  }

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('json')) {
          response.clone().text().then(publishBody).catch(() => {});
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
    this.addEventListener('load', function () {
      try {
        const contentType = this.getResponseHeader('content-type') || '';
        if (contentType.includes('json')) {
          publishBody(typeof this.response === 'string' ? this.response : this.responseText);
        }
      } catch (_) {}
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();
