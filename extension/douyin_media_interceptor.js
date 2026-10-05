/** Inspect media already returned to the open Douyin page. */
(function () {
  'use strict';
  if (window.__PROFILE_DOWNLOADER_DOUYIN__) return;
  window.__PROFILE_DOWNLOADER_DOUYIN__ = true;
  const captured = new Map();
  const profiles = new Map();
  const downloadBlobs = new Set();
  function firstUrl(value) {
    const values = typeof value === 'string' ? [value] : value?.url_list || value?.urlList || [];
    return values.find(raw => {
      try { const u = new URL(raw); return ['https:', 'http:'].includes(u.protocol) && !/(^|\.)douyin\.com$/.test(u.hostname); } catch (_) { return false; }
    }) || null;
  }
  function collect(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 16) return;
    if (typeof value.sec_uid === 'string') {
      const previous = profiles.get(value.sec_uid) || {};
      profiles.set(value.sec_uid, { ...previous, sec_uid: value.sec_uid,
        username: value.unique_id || value.short_id || previous.username || null,
        display_name: value.nickname || previous.display_name || null,
        avatar_url: firstUrl(value.avatar_larger) || firstUrl(value.avatar_thumb) || previous.avatar_url || null,
        bio: value.signature ?? previous.bio ?? null,
        follower_count: value.follower_count ?? previous.follower_count ?? null,
        following_count: value.following_count ?? previous.following_count ?? null,
        post_count: value.aweme_count ?? previous.post_count ?? null });
    }
    if (value.aweme_id && value.author?.sec_uid) {
      const media = [];
      const images = value.images || value.image_post_info?.images || [];
      images.forEach((image, index) => {
        const url = firstUrl(image.display_image || image);
        if (url) media.push({ id: String(index), type: 'image', url, thumbnail: url });
      });
      if (!images.length) {
        const video = value.video || {};
        const variants = [...(video.bit_rate || [])].sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
        const url = variants.map(v => firstUrl(v.play_addr)).find(Boolean) || firstUrl(video.play_addr) || firstUrl(video.download_addr);
        if (url) media.push({ id: 'video', type: 'video', url, thumbnail: firstUrl(video.cover) });
      }
      if (media.length) captured.set(String(value.aweme_id), {
        postId: String(value.aweme_id), ownerId: value.author.sec_uid,
        caption: value.desc || null, timestamp: Number(value.create_time) * 1000 || null, media,
      });
    }
    Object.values(value).forEach(child => collect(child, depth + 1));
  }
  function publish() {
    const owner = window.location.pathname.match(/^\/user\/([^/]+)\/?$/)?.[1];
    window.postMessage({ source: 'profile-downloader', type: 'douyin-media',
      profile: profiles.get(owner) || null, items: [...captured.values()].filter(item => item.ownerId === owner) }, '*');
  }
  function initialState() {
    for (const script of document.querySelectorAll('script#RENDER_DATA, script#__NEXT_DATA__, script[type="application/json"]')) {
      try { collect(JSON.parse(script.textContent)); } catch (_) {
        try { collect(JSON.parse(decodeURIComponent(script.textContent))); } catch (_) {}
      }
    }
    collect(window.__INITIAL_STATE__);
  }
  const originalFetch = window.fetch;
  if (originalFetch) window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      if ((response.headers.get('content-type') || '').includes('json')) {
        response.clone().json().then(value => { collect(value); publish(); }).catch(() => {});
      }
    } catch (_) {}
    return response;
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try { collect(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); publish(); } catch (_) {}
    }, { once: true });
    return originalSend.apply(this, args);
  };
  async function downloadMedia(request) {
    try {
      const url = new URL(request.url);
      const allowed = ['douyinvod.com', 'douyinpic.com', 'byteimg.com'];
      if (url.protocol !== 'https:' || !allowed.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) {
        throw new Error('Unsupported Douyin media URL');
      }
      const response = await originalFetch.call(window, url.href, {
        credentials: 'omit', redirect: 'follow',
        referrer: 'https://www.douyin.com/', referrerPolicy: 'strict-origin-when-cross-origin',
      });
      if (!response.ok) throw new Error('Douyin returned HTTP ' + response.status);
      const type = (response.headers.get('content-type') || '').toLowerCase();
      if (!type.startsWith('video/') && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
        throw new Error('Douyin returned invalid media (' + (type || 'unknown type') + ')');
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('Douyin returned empty media');
      const blobUrl = URL.createObjectURL(blob);
      downloadBlobs.add(blobUrl);
      window.postMessage({ source: 'profile-downloader', type: 'douyin-download-result',
        requestId: request.requestId, success: true, blobUrl, bytes: blob.size }, '*');
    } catch (err) {
      window.postMessage({ source: 'profile-downloader', type: 'douyin-download-result',
        requestId: request.requestId, success: false, error: err.message || 'Douyin media fetch failed' }, '*');
    }
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== 'profile-downloader') return;
    if (event.data.type === 'douyin-download-request') { downloadMedia(event.data); return; }
    if (event.data.type === 'douyin-revoke-blob') {
      if (downloadBlobs.delete(event.data.blobUrl)) URL.revokeObjectURL(event.data.blobUrl);
      return;
    }
    if (event.data.type !== 'douyin-media-request') return;
    initialState(); publish();
  });
})();
