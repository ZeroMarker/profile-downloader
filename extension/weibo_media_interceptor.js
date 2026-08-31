/**
 * Runs in Weibo's main world and captures media from the profile timeline API.
 * Only data already returned to the open page is inspected.
 */
(function () {
  'use strict';
  if (window.__PROFILE_DOWNLOADER_WEIBO_INTERCEPTOR__) return;
  window.__PROFILE_DOWNLOADER_WEIBO_INTERCEPTOR__ = true;

  const captured = new Map();

  function stringValue(value) {
    if (value == null) return null;
    return String(value);
  }

  function bestVideoUrl(mediaInfo) {
    if (!mediaInfo) return null;
    return mediaInfo.stream_url_hd
      || mediaInfo.stream_url
      || mediaInfo.mp4_hd_url
      || mediaInfo.mp4_sd_url
      || mediaInfo.h5_url
      || null;
  }

  function normalizeStatus(status) {
    if (!status || typeof status !== 'object') return null;
    const postId = stringValue(status.mblogid || status.idstr || status.id);
    const user = status.user || {};
    const ownerId = stringValue(user.idstr || user.id || status.user_id);
    const ownerName = user.screen_name || null;
    const media = [];
    const seen = new Set();

    const addImage = (url, id) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      media.push({ id: stringValue(id), type: 'image', url, thumbnail: url });
    };
    const picInfos = status.pic_infos || {};
    Object.entries(picInfos).forEach(([picId, info]) => {
      const url = info?.largest?.url
        || info?.original?.url
        || info?.large?.url
        || info?.bmiddle?.url
        || info?.thumbnail?.url;
      addImage(url, picId);
    });
    (status.pics || []).forEach((pic, index) => {
      addImage(
        pic?.large?.url || pic?.largest?.url || pic?.url,
        pic?.pid || pic?.id || `${postId}_pic_${index}`,
      );
    });

    const pageInfo = status.page_info || {};
    const videoUrl = bestVideoUrl(pageInfo.media_info);
    if (videoUrl) {
      const thumbnail = pageInfo.page_pic?.url || pageInfo.page_pic || null;
      media.push({ id: `${postId}_video`, type: 'video', url: videoUrl, thumbnail });
    }

    if (!postId || media.length === 0) return null;
    return {
      postId,
      ownerId,
      ownerName,
      caption: status.text_raw || status.text || null,
      timestamp: Number(status.created_at) || null,
      media,
    };
  }

  function collect(value, depth = 0) {
    if (!value || depth > 12) return;
    if (Array.isArray(value)) {
      value.forEach((child) => collect(child, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    if (value.pic_infos || value.pics || value.page_info) {
      const item = normalizeStatus(value);
      if (item) captured.set(item.postId, item);
    }
    Object.values(value).forEach((child) => collect(child, depth + 1));
  }

  function publish() {
    if (captured.size === 0) return;
    window.postMessage({
      source: 'profile-downloader',
      type: 'weibo-media',
      items: Array.from(captured.values()),
    }, '*');
  }

  async function inspectResponse(response) {
    try {
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('json')) return;
      collect(await response.clone().json());
      publish();
    } catch (_) {}
  }

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      inspectResponse(response);
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__profileDownloaderUrl = String(url || '');
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        if (!/\/ajax\/|\/api\//i.test(this.__profileDownloaderUrl || '')) return;
        const value = typeof this.response === 'object'
          ? this.response
          : JSON.parse(this.responseText);
        collect(value);
        publish();
      } catch (_) {}
    }, { once: true });
    return originalSend.apply(this, args);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window
        || event.data?.source !== 'profile-downloader'
        || event.data?.type !== 'weibo-media-request') return;
    publish();
  });
})();
