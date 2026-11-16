/** Inspect media already returned to the open Kuaishou profile page. */
(function () {
  'use strict';
  if (window.__PROFILE_DOWNLOADER_KUAISHOU__) return;
  window.__PROFILE_DOWNLOADER_KUAISHOU__ = true;
  const captured = new Map();
  const profiles = new Map();
  const downloadBlobs = new Set();

  function firstUrl(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
      } catch (_) { return null; }
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const url = firstUrl(item);
        if (url) return url;
      }
      return null;
    }
    return firstUrl(value.url || value.src || value.playUrl || value.cdnUrl);
  }

  function atlasUrls(photo) {
    let ext = photo?.ext_params;
    if (typeof ext === 'string') {
      try { ext = JSON.parse(ext); } catch (_) { return []; }
    }
    const atlas = ext?.atlas || ext?.atlasInfo;
    if (!atlas) return [];
    const list = Array.isArray(atlas)
      ? atlas
      : (atlas.cdn || atlas.urls || atlas.list || atlas.imageUrls || []);
    return (Array.isArray(list) ? list : []).map(firstUrl).filter(Boolean);
  }

  function bestVideoUrl(photo) {
    const representations = [];
    for (const manifest of [photo?.manifest, photo?.manifestH265]) {
      for (const set of manifest?.adaptationSet || []) {
        for (const representation of set.representation || []) representations.push(representation);
      }
    }
    representations.sort((a, b) => (b.maxBitrate || b.avgBitrate || 0) - (a.maxBitrate || a.avgBitrate || 0));
    return representations.map((item) => firstUrl(item.url) || firstUrl(item.backupUrl)).find(Boolean)
      || (photo?.photoUrls || []).map(firstUrl).find(Boolean)
      || (photo?.photoH265Urls || []).map(firstUrl).find(Boolean)
      || firstUrl(photo?.photoUrl);
  }

  function isVideoPhoto(photo) {
    if (photo?.manifest || photo?.manifestH265 || (photo?.duration || 0) > 0) return true;
    return [...(photo?.photoUrls || []), ...(photo?.photoH265Urls || [])]
      .some((item) => /\.(mp4|m3u8)(\?|$)/i.test(firstUrl(item) || ''));
  }

  function normalizeFeed(feed) {
    const photo = feed?.photo;
    const owner = feed?.author?.id || feed?.author?.user_id;
    if (!photo || !owner || !(photo.id || photo.photoId)) return null;
    const postId = String(photo.id || photo.photoId);
    const media = [];
    const images = atlasUrls(photo);
    if (images.length > 0) {
      images.forEach((url, index) => media.push({ id: `img_${index}`, type: 'image', url, thumbnail: url }));
    } else if (isVideoPhoto(photo)) {
      const videoUrl = bestVideoUrl(photo);
      if (videoUrl) {
        media.push({ id: 'video', type: 'video', url: videoUrl, thumbnail: firstUrl(photo.coverUrl) });
      }
    } else {
      (photo.photoUrls || []).map(firstUrl).filter(Boolean).forEach((url, index) => {
        media.push({ id: `img_${index}`, type: 'image', url, thumbnail: firstUrl(photo.coverUrl) || url });
      });
    }
    if (media.length === 0) return null;
    return {
      postId,
      ownerId: String(owner),
      caption: photo.caption || null,
      timestamp: Number(photo.timestamp) || null,
      media,
    };
  }

  function normalizeProfile(value) {
    const user = value?.userProfile;
    if (!user) return;
    const profile = user.profile || user;
    const id = profile.user_id || value.user_id;
    if (!id) return;
    profiles.set(String(id), {
      profile_id: String(id),
      username: user.userDefineId || profile.userDefineId || profile.kwaiId || String(id),
      display_name: profile.user_name || profile.userName || null,
      avatar_url: firstUrl(profile.headurl || profile.headUrl),
      bio: profile.user_text || null,
      follower_count: user.ownerCount?.fan ?? null,
      following_count: user.ownerCount?.follow ?? null,
      post_count: user.ownerCount?.photo_public ?? null,
    });
  }

  function collect(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || depth > 20 || seen.has(value)) return;
    seen.add(value);
    normalizeProfile(value);
    if (Array.isArray(value.feeds)) {
      value.feeds.forEach((feed) => {
        const item = normalizeFeed(feed);
        if (item) captured.set(item.postId, item);
      });
    }
    const single = normalizeFeed(value);
    if (single) captured.set(single.postId, single);
    Object.values(value).forEach((child) => collect(child, depth + 1, seen));
  }

  function initialState() {
    try {
      if (window.INIT_STATE) {
        const state = typeof window.INIT_STATE === 'string' ? JSON.parse(window.INIT_STATE) : window.INIT_STATE;
        collect(state);
      }
    } catch (_) {}
    try {
      if (window.__INITIAL_STATE__) collect(window.__INITIAL_STATE__);
    } catch (_) {}
    try {
      for (const entry of Object.values(window.__PREFETCH__ || {})) {
        if (entry?.value && typeof entry.value.then !== 'function') collect(entry.value);
      }
    } catch (_) {}
    for (const script of document.querySelectorAll('script[type="application/json"], script#RENDER_DATA')) {
      try { collect(JSON.parse(script.textContent)); } catch (_) {
        try { collect(JSON.parse(decodeURIComponent(script.textContent))); } catch (_) {}
      }
    }
  }

  function publish() {
    const owner = window.location.pathname.match(/^\/profile\/([^/]+)\/?$/)?.[1];
    window.postMessage({
      source: 'profile-downloader',
      type: 'kuaishou-media',
      profile: owner ? profiles.get(owner) || null : null,
      items: owner ? [...captured.values()].filter((item) => item.ownerId === owner) : [],
    }, '*');
  }

  const originalFetch = window.fetch;
  if (originalFetch) window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      if ((response.headers.get('content-type') || '').includes('json')) {
        response.clone().json().then((value) => { collect(value); publish(); }).catch(() => {});
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
      const allowed = ['kwaicdn.com', 'yximgs.com', 'kwimgs.com', 'kspkg.com'];
      if (url.protocol !== 'https:' || !allowed.some((host) => url.hostname === host || url.hostname.endsWith('.' + host))) {
        throw new Error('Unsupported Kuaishou media URL');
      }
      const response = await originalFetch.call(window, url.href, {
        credentials: 'omit', redirect: 'follow',
        referrer: 'https://www.kuaishou.com/', referrerPolicy: 'strict-origin-when-cross-origin',
      });
      if (!response.ok) throw new Error('Kuaishou returned HTTP ' + response.status);
      const type = (response.headers.get('content-type') || '').toLowerCase();
      if (!type.startsWith('video/') && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
        throw new Error('Kuaishou returned invalid media (' + (type || 'unknown type') + ')');
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('Kuaishou returned empty media');
      const blobUrl = URL.createObjectURL(blob);
      downloadBlobs.add(blobUrl);
      window.postMessage({ source: 'profile-downloader', type: 'kuaishou-download-result',
        requestId: request.requestId, success: true, blobUrl, bytes: blob.size }, '*');
    } catch (err) {
      window.postMessage({ source: 'profile-downloader', type: 'kuaishou-download-result',
        requestId: request.requestId, success: false, error: err.message || 'Kuaishou media fetch failed' }, '*');
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'profile-downloader') return;
    if (event.data.type === 'kuaishou-download-request') { downloadMedia(event.data); return; }
    if (event.data.type === 'kuaishou-revoke-blob') {
      if (downloadBlobs.delete(event.data.blobUrl)) URL.revokeObjectURL(event.data.blobUrl);
      return;
    }
    if (event.data.type !== 'kuaishou-media-request') return;
    initialState();
    publish();
  });
})();
