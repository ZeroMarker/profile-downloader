/** Observe Instagram API responses; grid DOM only exposes cover images. */
(function () {
  'use strict';
  const published = new Map();
  // full_name is only exposed in Instagram's JSON payloads; the rendered DOM
  // has no reliable element for it. Keep every user node we see and let the
  // content script pick the one matching the current profile handle.
  const profiles = new Map();

  function rememberProfiles(payload) {
    const visited = new Set();
    function walk(value) {
      if (!value || typeof value !== 'object' || visited.has(value)) return;
      visited.add(value);
      if (typeof value.username === 'string' && typeof value.full_name === 'string') {
        const fullName = value.full_name.trim();
        if (fullName) {
          profiles.set(value.username.toLowerCase(), {
            username: value.username,
            full_name: fullName,
            avatar: value.profile_pic_url_hd || value.profile_pic_url || null,
          });
        }
      }
      Object.values(value).forEach(walk);
    }
    walk(payload);
  }

  function publishProfiles() {
    if (profiles.size === 0) return;
    window.postMessage({
      source: 'profile-downloader',
      type: 'instagram-profile',
      profiles: Array.from(profiles.values()),
    }, '*');
  }

  const imageUrl = (item) => item?.image_versions2?.candidates?.[0]?.url || item?.display_url || item?.display_src || null;
  const videoUrl = (item) => item?.video_versions?.[0]?.url || item?.video_url || null;
  const ownerUsername = (item) => item?.user?.username || item?.owner?.username || item?.owner?.user?.username || null;

  function childrenOf(item) {
    if (Array.isArray(item?.carousel_media)) return item.carousel_media;
    const edges = item?.edge_sidecar_to_children?.edges;
    return Array.isArray(edges) ? edges.map((edge) => edge?.node).filter(Boolean) : [];
  }

  function normalize(item) {
    const code = item?.code || item?.shortcode;
    const owner = ownerUsername(item);
    if (!code || !owner) return null;
    const children = childrenOf(item);
    const sources = children.length > 0 ? children : [item];
    const media = sources.map((source) => {
      const video = videoUrl(source);
      const image = imageUrl(source);
      if (video) return { type: 'video', url: video, thumbnail: image };
      if (image) return { type: 'image', url: image, thumbnail: image };
      return null;
    }).filter(Boolean);
    if (media.length === 0) return null;
    return {
      code: String(code),
      ownerUsername: owner,
      kind: (item?.product_type === 'clips' || item?.is_video || videoUrl(item)) ? 'reel' : 'p',
      caption: item?.caption?.text || item?.edge_media_to_caption?.edges?.[0]?.node?.text || null,
      media,
    };
  }

  function extract(payload) {
    const items = [];
    const visited = new Set();
    function walk(value) {
      if (!value || typeof value !== 'object' || visited.has(value)) return;
      visited.add(value);
      const item = normalize(value);
      if (item) {
        const key = item.code + '|' + item.media.map((media) => media.url).join('|');
        if (!published.has(key)) {
          published.set(key, item);
          items.push(item);
        }
        return;
      }
      Object.values(value).forEach(walk);
    }
    walk(payload);
    return items;
  }

  function publishBody(body) {
    try {
      const payload = typeof body === 'string' ? JSON.parse(body) : body;
      rememberProfiles(payload);
      publishProfiles();
      const items = extract(payload);
      if (items.length > 0) window.postMessage({ source: 'profile-downloader', type: 'instagram-media', items }, '*');
    } catch (_) {}
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window
        || event.data?.source !== 'profile-downloader'
        || event.data?.type !== 'instagram-media-request') return;
    const items = Array.from(published.values());
    if (items.length > 0) window.postMessage({ source: 'profile-downloader', type: 'instagram-media', items }, '*');
    publishProfiles();
  });

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        if ((response.headers.get('content-type') || '').includes('json')) response.clone().text().then(publishBody).catch(() => {});
      } catch (_) {}
      return response;
    };
  }

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        if ((this.getResponseHeader('content-type') || '').includes('json')) publishBody(this.response);
      } catch (_) {}
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();
