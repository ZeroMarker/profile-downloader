/**
 * Profile Media Downloader — Content Script
 * Continuously accumulates media items as the user scrolls, so that
 * even content that gets removed from the DOM (virtual scrolling) is captured.
 *
 * Uses MutationObserver to catch new media elements as they appear.
 * When the popup sends 'extractMedia', the accumulated list is returned.
 */

(function () {
  'use strict';

  let platform = null;
  let accumulatedMedia = [];
  let accumulatedSeen = new Set();
  let observer = null;
  let scanTimer = null;

  /**
   * Detect platform from URL.
   */
  function detectPlatform() {
    const host = window.location.hostname.toLowerCase();
    if (host.includes('twitter.com') || host.includes('x.com')) return 'twitter';
    if (host.includes('tiktok.com')) return 'tiktok';
    if (host.includes('instagram.com')) return 'instagram';
    return null;
  }

  /**
   * Extract username from the current profile page URL.
   */
  function extractUsername() {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const firstSegment = path.split('/')[0] || '';
    return firstSegment.replace(/^@/, '');
  }

  /**
   * Check if current page is a profile page.
   */
  function isProfilePage() {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const firstSegment = path.split('/')[0] || '';
    const excluded = ['home', 'explore', 'notifications', 'messages', 'bookmarks',
                      'settings', 'search', 'i', 'login', 'signup', 'register',
                      'about', 'privacy', 'tos', 'discover', 'foryou', 'following',
                      'reels', 'explore', 'direct', 'accounts', 'p', 'stories'];
    return firstSegment.length > 0 && !excluded.includes(firstSegment.toLowerCase());
  }

  /**
   * Extract media ID from a Twitter CDN URL.
   */
  function extractTwitterMediaId(url) {
    const match = url.match(/\/media\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : url.split('/').pop().split('?')[0];
  }

  /**
   * Try to get the real image URL, accounting for lazy loading.
   * Some platforms store the actual URL in data-src, data-url, or similar.
   */
  function resolveImageUrl(img) {
    // Try actual src first
    if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) {
      return img.src;
    }
    // Fallback to data attributes
    return img.getAttribute('data-src')
        || img.getAttribute('data-url')
        || img.getAttribute('data-original')
        || img.getAttribute('data-media-url')
        || null;
  }

  // ===== Twitter / X =====

  /**
   * Scan the current DOM for Twitter media items and add them to accumulated list.
   */
  function scanTwitterDOM() {
    const username = extractUsername();
    let found = 0;

    // Scan all tweet articles currently in the DOM
    const tweetArticles = document.querySelectorAll('article[data-testid="tweet"]');
    tweetArticles.forEach((tweet) => {
      const tweetLink = tweet.querySelector('a[href*="/status/"]');
      const postUrl = tweetLink ? tweetLink.href : window.location.href;

      // Images
      const imgs = tweet.querySelectorAll('img[src*="pbs.twimg.com/media"], img[data-src*="pbs.twimg.com/media"]');
      imgs.forEach((img) => {
        let src = resolveImageUrl(img);
        if (!src) return;
        src = src.replace(/name=\w+/, 'name=large');
        if (!accumulatedSeen.has(src)) {
          accumulatedSeen.add(src);
          accumulatedMedia.push({
            id: `tw_${extractTwitterMediaId(src)}`,
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

      // Videos (poster images)
      const videoEls = tweet.querySelectorAll('video[poster]');
      videoEls.forEach((video) => {
        const poster = video.poster;
        if (poster && !accumulatedSeen.has(poster)) {
          accumulatedSeen.add(poster);
          accumulatedMedia.push({
            id: `tw_video_${extractTwitterMediaId(poster)}`,
            media_type: 'Video',
            url: poster.replace(/name=\w+/, 'name=large'),
            thumbnail_url: poster,
            post_url: postUrl,
            platform: 'twitter',
            username,
            content_type: 'image/jpeg',
          });
          found++;
        }
      });
    });

    // Also scan ALL images on the page (catches anything outside tweet articles)
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
          id: `tw_${extractTwitterMediaId(src)}`,
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

  /**
   * Get Twitter profile info.
   */
  function getTwitterProfile(username) {
    const info = { username };
    const nameEl = document.querySelector('[data-testid="UserCell"] span, h2[role="heading"] a span');
    if (nameEl) info.display_name = nameEl.textContent.trim();
    const avatarEl = document.querySelector('img[src*="pbs.twimg.com/profile_images"]');
    if (avatarEl) info.avatar_url = avatarEl.src;
    return info;
  }

  // ===== TikTok =====

  function scanTikTokDOM() {
    const username = extractUsername();
    let found = 0;

    // Try SIGI_STATE
    try {
      const html = document.documentElement.innerHTML;
      const sigiMatch = html.match(/window\.SIGI_STATE\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
      if (sigiMatch) {
        const sigi = JSON.parse(sigiMatch[1]);
        const itemModule = sigi.ItemModule;
        if (itemModule) {
          Object.values(itemModule).forEach((item) => {
            const video = item.video;
            const videoUrl = video?.playAddr?.[0] || video?.downloadAddr?.[0];
            if (videoUrl && !accumulatedSeen.has(item.id)) {
              accumulatedSeen.add(item.id);
              accumulatedMedia.push({
                id: `tt_${item.id}`,
                media_type: 'Video',
                url: videoUrl,
                thumbnail_url: video.cover || video.dynamicCover || null,
                post_url: `https://www.tiktok.com/@${username}/video/${item.id}`,
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

    // Also scan DOM for video links
    const videoLinks = document.querySelectorAll('a[href*="/video/"]');
    videoLinks.forEach((link) => {
      const href = link.href;
      const match = href.match(/\/video\/(\d+)/);
      if (match && !accumulatedSeen.has(match[1])) {
        accumulatedSeen.add(match[1]);
        const thumb = link.querySelector('img');
        accumulatedMedia.push({
          id: `tt_${match[1]}`,
          media_type: 'Video',
          url: href,
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

  // ===== Instagram =====

  function scanInstagramDOM() {
    const username = extractUsername();
    let found = 0;

    // Try __INITIAL_STATE__
    try {
      const html = document.documentElement.innerHTML;
      const match = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/);
      if (match) {
        const data = JSON.parse(match[1]);
        const items = data?.items || data?.feed?.items || data?.profile?.items || [];
        items.forEach((item) => {
          const id = `ig_${item.code || item.id}`;
          if (accumulatedSeen.has(id)) return;
          accumulatedSeen.add(id);

          if (item.carousel_media) {
            const urls = item.carousel_media
              .map((cm) => cm.image_versions2?.candidates?.[0]?.url)
              .filter(Boolean);
            if (urls.length > 0) {
              accumulatedMedia.push({
                id, media_type: 'Image', url: urls[0],
                carousel_urls: urls, thumbnail_url: null,
                post_url: `https://instagram.com/p/${item.code}`,
                platform: 'instagram', username,
                caption: item.caption?.text || item.caption || null,
                content_type: 'image/jpeg',
              });
              found++;
            }
          } else {
            const url = item.image_versions2?.candidates?.[0]?.url
                     || item.display_url || item.display_src;
            if (url) {
              const isVideo = !!item.video_versions;
              accumulatedMedia.push({
                id, media_type: isVideo ? 'Video' : 'Image',
                url: isVideo ? (item.video_versions?.[0]?.url || url) : url,
                thumbnail_url: url,
                post_url: `https://instagram.com/p/${item.code}`,
                platform: 'instagram', username,
                caption: item.caption?.text || item.caption || null,
                content_type: isVideo ? 'video/mp4' : 'image/jpeg',
              });
              found++;
            }
          }
        });
      }
    } catch (_) {}

    // Also scan DOM images
    const imgs = document.querySelectorAll(
      'img[src*="cdninstagram.com"], img[data-src*="cdninstagram.com"], ' +
      'img[src*="fbcdn.net"], img[data-src*="fbcdn.net"], ' +
      'img[src*="scontent"], img[data-src*="scontent"]'
    );
    imgs.forEach((img) => {
      const src = resolveImageUrl(img);
      if (!src || src.includes('profile_pic') || accumulatedSeen.has(src)) return;
      accumulatedSeen.add(src);
      accumulatedMedia.push({
        id: `ig_${src.split('/').pop().split('?')[0]}`,
        media_type: 'Image', url: src, thumbnail_url: src,
        post_url: window.location.href,
        platform: 'instagram', username,
        content_type: 'image/jpeg',
      });
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

  /**
   * Run a full scan of the current DOM, accumulating any new media found.
   */
  function scanDOM() {
    switch (platform) {
      case 'twitter':  return scanTwitterDOM();
      case 'tiktok':   return scanTikTokDOM();
      case 'instagram': return scanInstagramDOM();
      default:         return 0;
    }
  }

  /**
   * Get profile info for the current platform.
   */
  function getProfileInfo() {
    const username = extractUsername();
    switch (platform) {
      case 'twitter':  return getTwitterProfile(username);
      case 'tiktok':   return getTikTokProfile(username);
      case 'instagram': return getInstagramProfile(username);
      default:         return { username };
    }
  }

  /**
   * Debounced scan — triggered by MutationObserver.
   */
  function debouncedScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      const found = scanDOM();
      if (found > 0) {
        console.log(`[ProfileDownloader] +${found} new media items (total: ${accumulatedMedia.length})`);
      }
      scanTimer = null;
    }, 300);
  }

  // ===== MutationObserver =====

  /**
   * Start observing DOM changes to catch dynamically loaded content.
   */
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

    // Watch the main content area for new nodes
    const targetNode = document.querySelector(
      'main, [data-testid="primaryColumn"], section, ' +
      'div[role="main"], div[data-pagelet], ' +
      '#content, .timeline, .feed'
    ) || document.body;

    observer.observe(targetNode, {
      childList: true,
      subtree: true,
    });

    console.log(`[ProfileDownloader] Observer watching for new media on ${platform}`);
  }

  // ===== Init =====

  /**
   * Initialize the content script.
   */
  function init() {
    platform = detectPlatform();
    if (!platform) return;

    if (!isProfilePage()) return;

    // Initial full scan of whatever is already in the DOM
    const initial = scanDOM();
    console.log(`[ProfileDownloader] Initial scan: ${initial} items found`);

    // Start watching for new content
    startObserver();
  }

  // ===== Message Handler =====

  /**
   * Listen for messages from the popup.
   */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractMedia') {
      try {
        // Do a final scan right now to catch anything just added
        scanDOM();

        // Remove duplicates (shouldn't be any, but just in case)
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
    }
    return true;
  });

  // Start
  init();
})();