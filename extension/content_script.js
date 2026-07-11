/**
 * Profile Media Downloader — Content Script
 * Continuously accumulates media items as the user scrolls, so that
 * even content that gets removed from the DOM (virtual scrolling) is captured.
 *
 * Uses MutationObserver to catch new media elements as they appear.
 * When the popup sends 'extractMedia', the accumulated list is returned.
 *
 * Also injects a page-context script to access JavaScript runtime variables
 * that content scripts cannot reach (isolated world).
 */

(function () {
  'use strict';

  let platform = null;
  let accumulatedMedia = [];
  let accumulatedSeen = new Set();
  let observer = null;
  let scanTimer = null;
  const twitterVideoCandidates = new Map();
  const tiktokVideoCandidates = new Map();
  const tiktokResolutionTasks = new Map();
  const tiktokDownloadRequests = new Map();

  function detectPlatform() {
    const host = window.location.hostname.toLowerCase();
    const isHost = (domain) => host === domain || host.endsWith('.' + domain);
    // file:// URLs — detect from page content (exported HTML)
    if (!host || window.location.protocol === 'file:') {
      const html = document.documentElement.innerHTML.toLowerCase();
      if (html.includes('twitter.com') || html.includes('x.com')) return 'twitter';
      if (html.includes('tiktok.com')) return 'tiktok';
      if (html.includes('instagram.com')) return 'instagram';
      // Check page title
      const title = document.title.toLowerCase();
      if (title.includes('x') || title.includes('twitter')) return 'twitter';
      if (title.includes('tiktok')) return 'tiktok';
      if (title.includes('instagram')) return 'instagram';
      return null;
    }
    if (isHost('twitter.com') || isHost('x.com')) return 'twitter';
    if (isHost('tiktok.com')) return 'tiktok';
    if (isHost('instagram.com')) return 'instagram';
    return null;
  }

  function extractUsername() {
    // For file:// URLs (exported pages), try to find username from page content
    if (window.location.protocol === 'file:') {
      // Try meta tags or canonical URL
      const canonical = document.querySelector('link[rel="canonical"], meta[property="og:url"]');
      if (canonical) {
        const url = canonical.href || canonical.content;
        const m = url.match(/(?:twitter|x)\.com\/([^\/\?#]+)/i);
        if (m) return m[1].replace(/^@/, '');
      }
      // Try page title: "@username on X"
      const titleMatch = document.title.match(/@(\S+)/);
      if (titleMatch) return titleMatch[1];
      return 'exported_page';
    }
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const firstSegment = path.split('/')[0] || '';
    return firstSegment.replace(/^@/, '');
  }

  function isProfilePage() {
    // file:// URLs are always treated as profile pages (exported content)
    if (window.location.protocol === 'file:') return true;
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const firstSegment = path.split('/')[0] || '';
    const excluded = ['home', 'explore', 'notifications', 'messages', 'bookmarks',
                      'settings', 'search', 'i', 'login', 'signup', 'register',
                      'about', 'privacy', 'tos', 'discover', 'foryou', 'following',
                      'reels', 'explore', 'direct', 'accounts', 'p', 'stories'];
    return firstSegment.length > 0 && !excluded.includes(firstSegment.toLowerCase());
  }

  function extractTwitterMediaId(url) {
    const match = url.match(/\/media\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : url.split('/').pop().split('?')[0];
  }

  function resolveImageUrl(img) {
    if (!img) return null;
    if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) {
      return img.src;
    }
    return img.getAttribute('data-src')
        || img.getAttribute('data-url')
        || img.getAttribute('data-original')
        || img.getAttribute('data-media-url')
        || null;
  }

  // ===== Twitter / X =====

  function normalizeTwitterVideoUrl(rawUrl) {
    if (!rawUrl) return null;
    const decoded = String(rawUrl)
      .replace(/\\u002F/gi, '/')
      .replace(/\\\//g, '/')
      .replace(/&amp;/gi, '&');

    const match = decoded.match(/https?:\/\/video\.twimg\.com\/[^\s"<>']+?\.mp4(?:\?[^\s"<>']*)?/i);
    if (!match) return null;

    try {
      const url = new URL(match[0]);
      const path = url.pathname;
      if (url.hostname !== 'video.twimg.com' || !path.endsWith('.mp4')) return null;
      if (path.includes('/aud/')) return null;
      if (/\/vid\/(?:avc1|hevc)\/\d+\/\d+\//i.test(path)) return null;
      if (/\/(?:init|segment|chunk)[^/]*\.mp4$/i.test(path)) return null;
      url.hash = '';
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function extractTwitterVideoAssetId(url) {
    if (!url) return null;
    const value = String(url).replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    const numericId = value.match(/\/(?:amplify_video|ext_tw_video)(?:_thumb)?\/(\d+)\//i);
    if (numericId) return numericId[1];

    const gifId = value.match(/\/tweet_video(?:_thumb)?\/([^/?#.]+)(?:\.(?:mp4|jpg|jpeg|png))?/i);
    return gifId ? gifId[1] : null;
  }

  function twitterVideoQuality(url) {
    const dimensions = url.match(/\/(\d{2,5})x(\d{2,5})\//);
    const pixels = dimensions ? Number(dimensions[1]) * Number(dimensions[2]) : 0;
    const bitrate = Number(new URL(url).searchParams.get('bitrate')) || 0;
    return pixels * 10000000 + bitrate;
  }

  function rememberTwitterVideo(rawUrl) {
    const url = normalizeTwitterVideoUrl(rawUrl);
    if (!url) return false;

    const assetId = extractTwitterVideoAssetId(url);
    const key = assetId || new URL(url).pathname;
    const current = twitterVideoCandidates.get(key);
    if (!current || twitterVideoQuality(url) > twitterVideoQuality(current)) {
      twitterVideoCandidates.set(key, url);
      if (assetId) {
        const existing = accumulatedMedia.find((item) => item.id === 'tw_video_' + assetId);
        if (existing) existing.url = url;
      }
      return true;
    }
    return false;
  }

  /** Collect MP4 variants and keep only the highest quality URL per X media asset. */
  function collectTwitterVideoCandidates() {
    let found = 0;
    const sources = performance.getEntriesByType('resource').map((entry) => entry.name);

    document.querySelectorAll('script').forEach((script) => {
      if (script.textContent && script.textContent.includes('video.twimg.com')) {
        sources.push(script.textContent);
      }
    });

    // Exported pages can contain escaped URLs outside script tags.
    if (window.location.protocol === 'file:') {
      sources.push(document.documentElement.innerHTML);
    }

    sources.forEach((source) => {
      const decoded = String(source)
        .replace(/\\u002F/gi, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/gi, '&');
      const matches = decoded.match(/https?:\/\/video\.twimg\.com\/[^\s"<>']+?\.mp4(?:\?[^\s"<>']*)?/gi) || [];
      matches.forEach((url) => {
        if (rememberTwitterVideo(url)) found++;
      });
    });

    return found;
  }

  /**
   * Request background to inject video extraction code into the page's main world
   * via chrome.scripting.executeScript with world: 'MAIN'.
   * This bypasses the page's CSP that blocks inline <script> injection.
   */
  function requestPageScriptInjection() {
    try {
      chrome.runtime.sendMessage({ action: 'injectVideoExtractor' });
      if (platform === 'tiktok') {
        window.postMessage({
          source: 'profile-downloader',
          type: 'tiktok-video-request',
        }, '*');
      } else if (platform === 'instagram') {
        window.postMessage({ source: 'profile-downloader', type: 'instagram-media-request' }, '*');
      }
    } catch(_) {}
  }
  function setupPageMessageListener() {
    window.addEventListener('message', function(event) {
      if (event.data && event.data.source === 'profile-downloader' && event.data.type === 'twitter-videos') {
        var urls = event.data.urls || [];
        var found = 0;
        urls.forEach(function(url) {
          if (rememberTwitterVideo(url)) found++;
        });
        if (found > 0) {
          scanTwitterDOM();
          console.log('[ProfileDownloader] Injected script found', found, 'video variant(s)');
        }
      }
      if (event.data && event.data.source === 'profile-downloader' && event.data.type === 'tiktok-videos') {
        var videos = event.data.videos || [];
        videos.forEach(function(video) {
          var url = normalizeTikTokVideoUrl(video.url);
          if (video.id && url) tiktokVideoCandidates.set(String(video.id), url);
        });
        if (videos.length > 0) {
          scanTikTokDOM();
          console.log('[ProfileDownloader] Captured', videos.length, 'TikTok video URL(s)');
        }
      }
      if (event.source === window
          && event.data?.source === 'profile-downloader'
          && event.data?.type === 'tiktok-download-result') {
        const pending = tiktokDownloadRequests.get(event.data.requestId);
        if (!pending) return;
        tiktokDownloadRequests.delete(event.data.requestId);
        if (!event.data.success || !event.data.blobUrl) {
          pending.reject(new Error(event.data.error || 'TikTok download failed'));
          return;
        }
        chrome.runtime.sendMessage({
          action: 'downloadPreparedMedia',
          item: {
            id: pending.item.id,
            url: event.data.blobUrl,
            filename: pending.item.filename,
          },
        }).then((response) => {
          if (!response?.success) throw new Error(response?.error || 'Could not start TikTok download');
          pending.resolve(response);
        }).catch((err) => {
          pending.reject(err);
        });
      }
      if (event.source === window
          && event.data?.source === 'profile-downloader'
          && event.data?.type === 'instagram-media') {
        const username = extractUsername();
        let found = 0;
        (event.data.items || []).forEach((item) => {
          if (item.ownerUsername?.toLowerCase() !== username.toLowerCase()) return;
          const postUrl = `https://www.instagram.com/${username}/${item.kind || 'p'}/${item.code}/`;
          accumulatedMedia = accumulatedMedia.filter((existing) => {
            try {
              return new URL(existing.post_url).pathname !== new URL(postUrl).pathname
                || existing.id.startsWith(`ig_${item.code}_`);
            } catch (_) {
              return true;
            }
          });
          (item.media || []).forEach((media, index) => {
            const id = `ig_${item.code}_${index}`;
            if (!media.url || accumulatedSeen.has(id)) return;
            accumulatedSeen.add(id);
            accumulatedMedia.push({ id, media_type: media.type === 'video' ? 'Video' : 'Image', url: media.url, thumbnail_url: media.thumbnail || (media.type === 'image' ? media.url : null), post_url: postUrl, platform: 'instagram', username, caption: item.caption || null, content_type: media.type === 'video' ? 'video/mp4' : 'image/jpeg' });
            found++;
          });
        });
        if (found > 0) console.log('[ProfileDownloader] Captured', found, 'Instagram media item(s)');
      }
    });
  }

  function twitterPostInfo(tweet, fallbackUsername) {
    const links = tweet.querySelectorAll('a[href*="/status/"]');
    for (const link of links) {
      try {
        const url = new URL(link.href, window.location.origin);
        const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
        if (match) {
          return { username: match[1], tweetId: match[2], postUrl: url.origin + url.pathname };
        }
      } catch (_) {}
    }
    return { username: fallbackUsername, tweetId: null, postUrl: window.location.href };
  }

  function findTwitterVideoForTweet(tweet) {
    const video = tweet.querySelector('video');
    const poster = video?.poster || video?.getAttribute('poster') || '';
    const assetId = extractTwitterVideoAssetId(poster);
    if (assetId && twitterVideoCandidates.has(assetId)) {
      return { assetId, url: twitterVideoCandidates.get(assetId), poster: poster || null };
    }

    const directUrl = normalizeTwitterVideoUrl(video?.currentSrc || video?.src);
    if (directUrl) {
      const directAssetId = extractTwitterVideoAssetId(directUrl);
      return { assetId: directAssetId, url: directUrl, poster: poster || null };
    }

    return null;
  }

  function scanTwitterMediaGrid(username) {
    let found = 0;
    const videoLinks = document.querySelectorAll(
      'a[href*="/status/"][href*="/video/"]'
    );

    videoLinks.forEach((link) => {
      const thumbnail = link.querySelector(
        'img[src*="amplify_video_thumb"], ' +
        'img[src*="ext_tw_video_thumb"], ' +
        'img[src*="tweet_video_thumb"]'
      );
      const thumbnailUrl = resolveImageUrl(thumbnail);
      const assetId = extractTwitterVideoAssetId(thumbnailUrl);
      if (!assetId || !twitterVideoCandidates.has(assetId)) return;

      const statusMatch = link.pathname.match(/^\/([^/]+)\/status\/(\d+)\/video\/\d+/i);
      const postUrl = statusMatch
        ? window.location.origin + '/' + statusMatch[1] + '/status/' + statusMatch[2]
        : link.href;
      const id = 'tw_video_' + assetId;
      const videoItem = {
        id,
        media_type: 'Video',
        url: twitterVideoCandidates.get(assetId),
        thumbnail_url: thumbnailUrl?.replace(/name=\w+/, 'name=large') || null,
        post_url: postUrl,
        platform: 'twitter',
        username,
        content_type: 'video/mp4',
      };
      const existing = accumulatedMedia.find((item) => item.id === id);

      if (existing) {
        Object.assign(existing, videoItem);
      } else {
        accumulatedMedia.push(videoItem);
        accumulatedSeen.add(id);
        found++;
      }
    });

    return found;
  }

  function scanTwitterDOM() {
    const username = extractUsername();
    let found = 0;

    // X commonly exposes blob: video elements; resolve their real MP4 via resource timing.
    collectTwitterVideoCandidates();

    // The /{username}/media route renders links and thumbnails, not tweet articles.
    found += scanTwitterMediaGrid(username);

    // Scan each tweet so videos retain the correct post URL and thumbnail.
    const tweetArticles = document.querySelectorAll('article[data-testid="tweet"]');
    tweetArticles.forEach((tweet) => {
      const post = twitterPostInfo(tweet, username);
      const postUrl = post.postUrl;

      const imgs = tweet.querySelectorAll('img[src*="pbs.twimg.com/media"], img[data-src*="pbs.twimg.com/media"]');
      imgs.forEach((img) => {
        let src = resolveImageUrl(img);
        if (!src) return;
        src = src.replace(/name=\w+/, 'name=large');
        if (!accumulatedSeen.has(src)) {
          accumulatedSeen.add(src);
          accumulatedMedia.push({
            id: 'tw_' + extractTwitterMediaId(src),
            media_type: 'Image',
            url: src,
            thumbnail_url: src,
            post_url: postUrl,
            platform: 'twitter',
            username,
            content_type: 'image/jpeg',
          });
          found++;
        }
      });

      const resolvedVideo = findTwitterVideoForTweet(tweet);
      if (resolvedVideo) {
        const mediaKey = resolvedVideo.assetId || post.tweetId;
        if (!mediaKey) return;
        const id = 'tw_video_' + mediaKey;
        const existing = accumulatedMedia.find((item) => item.id === id);
        const videoItem = {
          id,
          media_type: 'Video',
          url: resolvedVideo.url,
          thumbnail_url: resolvedVideo.poster,
          post_url: postUrl,
          platform: 'twitter',
          username,
          content_type: 'video/mp4',
        };

        if (existing) {
          Object.assign(existing, videoItem);
        } else {
          accumulatedMedia.push(videoItem);
          accumulatedSeen.add(id);
          found++;
        }
      }
    });

    // Catch images outside currently mounted tweet articles.
    const allImgs = document.querySelectorAll(
      'img[src*="pbs.twimg.com/media"], img[data-src*="pbs.twimg.com/media"]'
    );
    allImgs.forEach((img) => {
      let src = resolveImageUrl(img);
      if (!src) return;
      src = src.replace(/name=\w+/, 'name=large');
      if (!accumulatedSeen.has(src)) {
        accumulatedSeen.add(src);
        accumulatedMedia.push({
          id: 'tw_' + extractTwitterMediaId(src),
          media_type: 'Image',
          url: src,
          thumbnail_url: src,
          post_url: window.location.href,
          platform: 'twitter',
          username,
          content_type: 'image/jpeg',
        });
        found++;
      }
    });

    return found;
  }

  function getTwitterProfile(username) {
    const info = { username };
    const nameEl = document.querySelector('[data-testid="UserCell"] span, h2[role="heading"] a span');
    if (nameEl) info.display_name = nameEl.textContent.trim();
    const avatarEl = document.querySelector('img[src*="pbs.twimg.com/profile_images"]');
    if (avatarEl) info.avatar_url = avatarEl.src;
    return info;
  }

  // ===== TikTok =====

  function normalizeTikTokVideoUrl(rawUrl) {
    const candidate = Array.isArray(rawUrl) ? rawUrl[0] : rawUrl;
    if (!candidate || typeof candidate !== 'string') return null;

    const decoded = candidate
      .replace(/\\u002F/gi, '/')
      .replace(/\\\//g, '/')
      .replace(/&amp;/gi, '&');

    try {
      const url = new URL(decoded);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      if (/\/@[^/]+\/video\/\d+/.test(url.pathname)) return null;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function bestTikTokVideoUrl(candidates) {
    const urls = [];
    function add(value) {
      if (Array.isArray(value)) {
        value.forEach(add);
        return;
      }
      const url = normalizeTikTokVideoUrl(value);
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

  function collectTikTokVideoCandidates() {
    function remember(item) {
      if (!item || typeof item !== 'object') return;
      const video = item.video || item.itemStruct?.video;
      const itemId = String(item.id || item.aweme_id || item.itemStruct?.id || '');
      if (!video || !itemId) return;

      const candidates = [
        video.playAddr,
        video.downloadAddr,
        video.play_addr?.url_list,
        video.download_addr?.url_list,
        video.bitRate?.[0]?.playAddr?.UrlList,
        video.bitrateInfo?.[0]?.PlayAddr?.UrlList,
      ];
      const url = bestTikTokVideoUrl(candidates);
      if (url) {
        tiktokVideoCandidates.set(itemId, url);
      }
    }

    function walk(value, visited = new Set()) {
      if (!value || typeof value !== 'object' || visited.has(value)) return;
      visited.add(value);
      remember(value);
      Object.values(value).forEach((child) => walk(child, visited));
    }

    document.querySelectorAll('script').forEach((script) => {
      const text = script.textContent?.trim();
      if (!text || (!text.includes('playAddr') && !text.includes('play_addr'))) return;
      try {
        walk(JSON.parse(text));
      } catch (_) {}
    });

    return tiktokVideoCandidates.size;
  }

  function resolveTikTokPost(videoId, postUrl) {
    if (tiktokVideoCandidates.has(videoId)) return Promise.resolve(true);
    if (tiktokResolutionTasks.has(videoId)) return tiktokResolutionTasks.get(videoId);

    const task = (async () => {
      try {
        const endpoint = new URL('/api/item/detail/', window.location.origin);
        endpoint.searchParams.set('itemId', videoId);
        const response = await fetch(endpoint.href, {
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return false;
        const payload = await response.json();

        let matched = false;
        const visited = new Set();
        function walk(value) {
          if (!value || typeof value !== 'object' || visited.has(value) || matched) return;
          visited.add(value);
          const item = value.itemStruct || value;
          const id = String(item.id || item.aweme_id || item.awemeId || '');
          if (id === videoId && item.video) {
            const candidates = [
              item.video.playAddr,
              item.video.downloadAddr,
              item.video.play_addr?.url_list,
              item.video.download_addr?.url_list,
              item.video.bitRate?.[0]?.playAddr?.UrlList,
              item.video.bitrateInfo?.[0]?.PlayAddr?.UrlList,
            ];
            const url = bestTikTokVideoUrl(candidates);
            if (url) {
              tiktokVideoCandidates.set(videoId, url);
              matched = true;
            }
          }
          Object.values(value).forEach(walk);
        }
        walk(payload);
        return matched;
      } catch (err) {
        console.warn('[ProfileDownloader] Could not resolve TikTok post', postUrl, err);
        return false;
      }
    })().finally(() => tiktokResolutionTasks.delete(videoId));

    tiktokResolutionTasks.set(videoId, task);
    return task;
  }

  function scanTikTokDOM() {
    const username = extractUsername();
    let found = 0;

    collectTikTokVideoCandidates();

    try {
      const html = document.documentElement.innerHTML;
      const sigiMatch = html.match(/window\.SIGI_STATE\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
      if (sigiMatch) {
        const sigi = JSON.parse(sigiMatch[1]);
        const itemModule = sigi.ItemModule;
        if (itemModule) {
          Object.values(itemModule).forEach((item) => {
            const video = item.video;
            const videoUrl = bestTikTokVideoUrl([
              video?.bitRate?.[0]?.playAddr?.UrlList,
              video?.bitrateInfo?.[0]?.PlayAddr?.UrlList,
              video?.playAddr,
              video?.downloadAddr,
            ]);
            if (videoUrl && !accumulatedSeen.has(item.id)) {
              accumulatedSeen.add(item.id);
              accumulatedMedia.push({
                id: 'tt_' + item.id,
                media_type: 'Video',
                url: videoUrl,
                thumbnail_url: video.cover || video.dynamicCover || null,
                post_url: 'https://www.tiktok.com/@' + username + '/video/' + item.id,
                platform: 'tiktok',
                username,
                caption: item.desc || null,
                content_type: 'video/mp4',
              });
              found++;
            }
          });
        }
      }
    } catch (_) {}

    const videoLinks = document.querySelectorAll('a[href*="/video/"]');
    videoLinks.forEach((link) => {
      const href = link.href;
      const match = href.match(/\/video\/(\d+)/);
      if (match && !accumulatedSeen.has(match[1])) {
        const videoUrl = tiktokVideoCandidates.get(match[1]);
        // A TikTok post URL returns HTML. Only expose an item when the
        // embedded page state gives us a real CDN media URL.
        if (!videoUrl) {
          resolveTikTokPost(match[1], href).then((resolved) => {
            if (resolved) debouncedScan();
          });
          return;
        }
        accumulatedSeen.add(match[1]);
        const thumb = link.querySelector('img');
        accumulatedMedia.push({
          id: 'tt_' + match[1],
          media_type: 'Video',
          url: videoUrl,
          thumbnail_url: thumb?.src || null,
          post_url: href,
          platform: 'tiktok',
          username,
          content_type: 'video/mp4',
        });
        found++;
      }
    });

    return found;
  }

  function getTikTokProfile(username) {
    const info = { username };
    const nameEl = document.querySelector('h1[data-e2e="user-title"], h2[data-e2e="user-subtitle"]');
    if (nameEl) info.display_name = nameEl.textContent.trim();
    const avatarEl = document.querySelector('img[data-e2e="user-avatar"]');
    if (avatarEl) info.avatar_url = avatarEl.src;
    return info;
  }

  function downloadTikTokInPage(item) {
    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        tiktokDownloadRequests.delete(requestId);
        reject(new Error('TikTok video fetch timed out'));
      }, 60000);
      tiktokDownloadRequests.set(requestId, {
        item,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      window.postMessage({
        source: 'profile-downloader',
        type: 'tiktok-download-request',
        requestId,
        url: item.url,
        filename: item.filename,
      }, '*');
    });
  }

  async function downloadTikTokBatch(items) {
    const errors = [];
    let downloaded = 0;
    for (const item of items) {
      try {
        await downloadTikTokInPage(item);
        downloaded++;
      } catch (err) {
        errors.push({ id: item.id, error: err.message || 'Download failed' });
      }
    }
    return {
      success: downloaded > 0,
      queued: downloaded,
      failed: errors.length,
      errors: errors.slice(0, 10),
      error: downloaded === 0 ? (errors[0]?.error || 'No TikTok videos could be downloaded') : undefined,
    };
  }

  // ===== Instagram =====

  function isInstagramItemFromProfile(item, username) {
    const owner = item?.user?.username
      || item?.owner?.username
      || item?.owner?.user?.username;
    return !owner || owner.toLowerCase() === username.toLowerCase();
  }

  function instagramPostLinkForImage(img, username) {
    const link = img.closest('a[href]');
    if (!link) return null;
    try {
      const url = new URL(link.href, window.location.origin);
      const match = url.pathname.match(/^\/([^/]+)\/(?:p|reel)\/[^/?#]+\/?$/i);
      return match && match[1].toLowerCase() === username.toLowerCase()
        ? url.href
        : null;
    } catch (_) {
      return null;
    }
  }

  function scanInstagramDOM() {
    const username = extractUsername();
    let found = 0;

    try {
      const html = document.documentElement.innerHTML;
      const match = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/);
      if (match) {
        const data = JSON.parse(match[1]);
        const items = data?.items || data?.feed?.items || data?.profile?.items || [];
        items.forEach((item) => {
          if (!isInstagramItemFromProfile(item, username)) return;
          const id = 'ig_' + (item.code || item.id);
          if (accumulatedSeen.has(id)) return;
          accumulatedSeen.add(id);

          if (item.carousel_media) {
            item.carousel_media.forEach((cm, index) => {
              const imageUrl = cm.image_versions2?.candidates?.[0]?.url;
              const videoUrl = cm.video_versions?.[0]?.url;
              const url = videoUrl || imageUrl;
              const childId = `${id}_${index}`;
              if (!url || accumulatedSeen.has(childId)) return;
              accumulatedSeen.add(childId);
              accumulatedMedia.push({ id: childId, media_type: videoUrl ? 'Video' : 'Image', url, thumbnail_url: imageUrl || null, post_url: 'https://instagram.com/' + username + '/p/' + item.code, platform: 'instagram', username, caption: item.caption?.text || item.caption || null, content_type: videoUrl ? 'video/mp4' : 'image/jpeg' });
              found++;
            });
          } else {
            const url = item.image_versions2?.candidates?.[0]?.url || item.display_url || item.display_src;
            if (url) {
              const isVideo = !!item.video_versions;
              accumulatedMedia.push({ id, media_type: isVideo ? 'Video' : 'Image', url: isVideo ? (item.video_versions?.[0]?.url || url) : url, thumbnail_url: url, post_url: 'https://instagram.com/p/' + item.code, platform: 'instagram', username, caption: item.caption?.text || item.caption || null, content_type: isVideo ? 'video/mp4' : 'image/jpeg' });
              found++;
            }
          }
        });
      }
    } catch (_) {}

    // Profile post thumbnails are linked to /p/ or /reel/. Scanning every CDN
    // image also captures the signed-in user's avatar, comment avatars, story
    // rings, recommendations, and the profile avatar itself.
    const imgs = document.querySelectorAll(
      'a[href*="/p/"] img, a[href*="/reel/"] img'
    );
    imgs.forEach((img) => {
      const src = resolveImageUrl(img);
      const postUrl = instagramPostLinkForImage(img, username);
      if (!src || !postUrl || src.includes('profile_pic') || accumulatedSeen.has(src)) return;
      accumulatedSeen.add(src);
      accumulatedMedia.push({ id: 'ig_' + src.split('/').pop().split('?')[0], media_type: 'Image', url: src, thumbnail_url: src, post_url: postUrl, platform: 'instagram', username, content_type: 'image/jpeg' });
      found++;
    });

    return found;
  }

  function getInstagramProfile(username) {
    const info = { username };
    const nameEl = document.querySelector('section h1, header h1');
    if (nameEl) info.display_name = nameEl.textContent.trim();
    const avatarEl = document.querySelector('img[src*="profile_pic"], header img');
    if (avatarEl) info.avatar_url = avatarEl.src;
    return info;
  }

  // ===== Dispatcher =====

  function scanDOM() {
    switch (platform) {
      case 'twitter':  return scanTwitterDOM();
      case 'tiktok':   return scanTikTokDOM();
      case 'instagram': return scanInstagramDOM();
      default:         return 0;
    }
  }

  function getProfileInfo() {
    const username = extractUsername();
    switch (platform) {
      case 'twitter':  return getTwitterProfile(username);
      case 'tiktok':   return getTikTokProfile(username);
      case 'instagram': return getInstagramProfile(username);
      default:         return { username };
    }
  }

  function debouncedScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      const found = scanDOM();
      if (found > 0) {
        console.log('[ProfileDownloader] +' + found + ' new media items (total: ' + accumulatedMedia.length + ')');
      }
      scanTimer = null;
    }, 300);
  }

  // ===== MutationObserver =====

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          debouncedScan();
          break;
        }
      }
    });
    const targetNode = document.querySelector(
      'main, [data-testid="primaryColumn"], section, ' +
      'div[role="main"], div[data-pagelet], ' +
      '#content, .timeline, .feed'
    ) || document.body;
    observer.observe(targetNode, { childList: true, subtree: true });
    console.log('[ProfileDownloader] Observer watching for new media on ' + platform);
  }

  // ===== Init =====

  function init() {
    platform = detectPlatform();
    if (!platform) return;
    if (!isProfilePage()) return;

    // Set up page-context message listener (for JS runtime data)
    setupPageMessageListener();

    // Inject page script to read JS runtime variables (Twitter video URLs)
    requestPageScriptInjection();

    // Initial full scan
    const initial = scanDOM();
    console.log('[ProfileDownloader] Initial scan: ' + initial + ' items found');

    // Start watching for new content
    startObserver();
  }

  // ===== Message Handler =====

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractMedia') {
      (async () => {
        try {
        scanDOM();
        if (platform === 'tiktok' && tiktokResolutionTasks.size > 0) {
          await Promise.race([
            Promise.allSettled(Array.from(tiktokResolutionTasks.values())),
            new Promise((resolve) => setTimeout(resolve, 12000)),
          ]);
          scanDOM();
        }
        const seen = new Set();
        const deduped = accumulatedMedia.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
        accumulatedMedia = deduped;
        sendResponse({
          media: accumulatedMedia,
          username: extractUsername(),
          profileInfo: getProfileInfo(),
          totalScanned: accumulatedMedia.length,
        });
        } catch (err) {
          console.error('[ProfileDownloader] Extraction error:', err);
          sendResponse({ error: err.message || 'Extraction failed' });
        }
      })();
    } else if (request.action === 'downloadTikTokBatch') {
      downloadTikTokBatch(Array.isArray(request.items) ? request.items : [])
        .then(sendResponse)
        .catch((err) => sendResponse({ success: false, error: err.message }));
    }
    return true;
  });

  // Start
  init();
})();
