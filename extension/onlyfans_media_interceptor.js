/**
 * Observe OnlyFans API responses in the page's main world. Only media URLs
 * already returned to the signed-in page are exposed to the extension.
 */
(function () {
  'use strict';

  const published = new Map();

  function asId(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
  }

  function fileUrl(media, kind) {
    const file = media?.files?.[kind];
    if (typeof file === 'string') return file;
    return file?.url || null;
  }

  function normalize(post) {
    if (!post || post.canView === false || !Array.isArray(post.media)) return null;
    const postId = asId(post.id);
    const ownerUsername = post.fromUser?.username
      || post.author?.username
      || post.user?.username
      || null;
    if (!postId || !ownerUsername) return null;

    const media = post.media.map((item) => {
      if (!item || item.canView === false) return null;
      const type = String(item.type || '').toLowerCase();
      if (!['photo', 'image', 'gif', 'video'].includes(type)) return null;
      // OnlyFans video entries commonly expose the playable MP4 under
      // source.source while files.full can be a JPEG poster.
      const sourceUrl = typeof item.source === 'string' ? item.source : item.source?.source;
      const url = type === 'video'
        ? (sourceUrl || fileUrl(item, 'full') || item.src)
        : (fileUrl(item, 'full') || item.src || sourceUrl);
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
      const thumbnail = fileUrl(item, 'thumb') || fileUrl(item, 'preview') || null;
      return {
        id: asId(item.id) || `${postId}_${post.media.indexOf(item)}`,
        type: type === 'video' ? 'video' : 'image',
        url,
        thumbnail,
      };
    }).filter(Boolean);

    if (media.length === 0) return null;
    return {
      postId,
      ownerUsername,
      postUrl: typeof post.url === 'string' && /^https?:\/\//i.test(post.url) ? post.url : null,
      caption: typeof post.text === 'string' ? post.text : null,
      timestamp: Number(post.postedAtPrecise || post.postedAt || 0) || null,
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
        const key = `${item.postId}|${item.media.map((entry) => entry.url).join('|')}`;
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
      const items = extract(payload);
      if (items.length > 0) {
        window.postMessage({ source: 'profile-downloader', type: 'onlyfans-media', items }, '*');
      }
    } catch (_) {}
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window
        || event.data?.source !== 'profile-downloader'
        || event.data?.type !== 'onlyfans-media-request') return;
    const items = Array.from(published.values());
    if (items.length > 0) {
      window.postMessage({ source: 'profile-downloader', type: 'onlyfans-media', items }, '*');
    }
  });

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        if ((response.headers.get('content-type') || '').includes('json')) {
          response.clone().text().then(publishBody).catch(() => {});
        }
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
