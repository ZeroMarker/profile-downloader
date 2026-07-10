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

  function detectPlatform() {
    const host = window.location.hostname.toLowerCase();
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
    if (host.includes('twitter.com') || host.includes('x.com')) return 'twitter';
    if (host.includes('tiktok.com')) return 'tiktok';
    if (host.includes('instagram.com')) return 'instagram';
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

  /**
   * Extract video URLs from ALL script tags and raw HTML.
   * Searches for video.twimg.com .mp4 URLs using regex.
   */
  function extractTwitterVideosFromHtml(username) {
    let found = 0;
    const videoUrlRe = /https?:\/\/video\.twimg\.com\/[^\s"<>']+\.mp4/g;

    // Collect all script tag contents + raw HTML
    const sources = [];
    document.querySelectorAll('script').forEach((s) => {
      if (s.textContent && s.textContent.length > 500) {
        sources.push(s.textContent);
      }
    });
    sources.push(document.documentElement.innerHTML);

    sources.forEach((text) => {
      videoUrlRe.lastIndex = 0;
      let m;
      while ((m = videoUrlRe.exec(text)) !== null) {
        const url = m[0];
        if (!accumulatedSeen.has(url)) {
          accumulatedSeen.add(url);
          accumulatedMedia.push({
            id: 'tw_vid_' + url.split('/').pop().split('?')[0],
            media_type: 'Video',
            url,
            thumbnail_url: null,
            post_url: window.location.href,
            platform: 'twitter',
            username,
            content_type: 'video/mp4',
          });
          found++;
        }
      }
    });
    return found;
  }

  /**
   * Inject a <script> into the page context to read JS runtime variables.
   * Content scripts run in an isolated world and cannot access page JS vars.
   * The injected script reads window.__INITIAL_STATE__ etc., finds video URLs,
   * and posts them back via window.postMessage.
   */
    /**
   * Request background to inject video extraction code into the page's main world
   * via chrome.scripting.executeScript with world: 'MAIN'.
   * This bypasses the page's CSP that blocks inline <script> injection.
   */
  function requestPageScriptInjection() {
    try {
      chrome.runtime.sendMessage({ action: 'injectVideoExtractor' });
    } catch(_) {}
  }
  function setupPageMessageListener(username) {
    window.addEventListener('message', function(event) {
      if (event.data && event.data.source === 'profile-downloader' && event.data.type === 'twitter-videos') {
        var urls = event.data.urls || [];
        var found = 0;
        urls.forEach(function(url) {
          if (!accumulatedSeen.has(url)) {
            accumulatedSeen.add(url);
            accumulatedMedia.push({
              id: 'tw_vid_inj_' + url.split('/').pop().split('?')[0],
              media_type: 'Video',
              url: url,
              thumbnail_url: null,
              post_url: window.location.href,
              platform: 'twitter',
              username: username,
              content_type: 'video/mp4',
            });
            found++;
          }
        });
        if (found > 0) {
          console.log('[ProfileDownloader] Injected script found', found, 'video(s)');
        }
      }
    });
  }

  function scanTwitterDOM() {
    const username = extractUsername();
    let found = 0;

    // Priority 1: Extract videos from script tags + HTML (regex search for video.twimg.com)
    found += extractTwitterVideosFromHtml(username);

    // Priority 2: Scan all tweet articles for images
    const tweetArticles = document.querySelectorAll('article[data-testid="tweet"]');
    tweetArticles.forEach((tweet) => {
      const tweetLink = tweet.querySelector('a[href*="/status/"]');
      const postUrl = tweetLink ? tweetLink.href : window.location.href;

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

      // Video poster — only if we don't have a real video URL for this tweet
      const videoEls = tweet.querySelectorAll('video[poster]');
      videoEls.forEach((video) => {
        const poster = video.poster;
        const alreadyHasVideo = accumulatedMedia.some(
          (m) => m.media_type === 'Video' && m.post_url === postUrl
        );
        if (poster && !alreadyHasVideo && !accumulatedSeen.has(poster)) {
          accumulatedSeen.add(poster);
          accumulatedMedia.push({
            id: 'tw_video_' + extractTwitterMediaId(poster),
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

    // Priority 3: DOM-level video source detection
    const videoSources = document.querySelectorAll(
      'video[src*="video.twimg.com"], source[src*="video.twimg.com"], ' +
      'video[src*="tweet_video"], source[src*="tweet_video"]'
    );
    videoSources.forEach((el) => {
      const src = el.src || el.getAttribute('src');
      if (src && !accumulatedSeen.has(src)) {
        accumulatedSeen.add(src);
        accumulatedMedia.push({
          id: 'tw_dom_' + src.split('/').pop().split('?')[0],
          media_type: 'Video',
          url: src,
          thumbnail_url: null,
          post_url: window.location.href,
          platform: 'twitter',
          username,
          content_type: 'video/mp4',
        });
        found++;
      }
    });

    // Priority 4: All images on the page
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

  function scanTikTokDOM() {
    const username = extractUsername();
    let found = 0;

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
        accumulatedSeen.add(match[1]);
        const thumb = link.querySelector('img');
        accumulatedMedia.push({
          id: 'tt_' + match[1],
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

    try {
      const html = document.documentElement.innerHTML;
      const match = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/);
      if (match) {
        const data = JSON.parse(match[1]);
        const items = data?.items || data?.feed?.items || data?.profile?.items || [];
        items.forEach((item) => {
          const id = 'ig_' + (item.code || item.id);
          if (accumulatedSeen.has(id)) return;
          accumulatedSeen.add(id);

          if (item.carousel_media) {
            const urls = item.carousel_media
              .map((cm) => cm.image_versions2?.candidates?.[0]?.url)
              .filter(Boolean);
            if (urls.length > 0) {
              accumulatedMedia.push({ id, media_type: 'Image', url: urls[0], carousel_urls: urls, thumbnail_url: null, post_url: 'https://instagram.com/p/' + item.code, platform: 'instagram', username, caption: item.caption?.text || item.caption || null, content_type: 'image/jpeg' });
              found++;
            }
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

    const imgs = document.querySelectorAll(
      'img[src*="cdninstagram.com"], img[data-src*="cdninstagram.com"], ' +
      'img[src*="fbcdn.net"], img[data-src*="fbcdn.net"], ' +
      'img[src*="scontent"], img[data-src*="scontent"]'
    );
    imgs.forEach((img) => {
      const src = resolveImageUrl(img);
      if (!src || src.includes('profile_pic') || accumulatedSeen.has(src)) return;
      accumulatedSeen.add(src);
      accumulatedMedia.push({ id: 'ig_' + src.split('/').pop().split('?')[0], media_type: 'Image', url: src, thumbnail_url: src, post_url: window.location.href, platform: 'instagram', username, content_type: 'image/jpeg' });
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
    setupPageMessageListener(extractUsername());

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
      try {
        scanDOM();
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