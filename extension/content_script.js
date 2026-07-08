/**
 * Profile Media Downloader — Content Script
 * Injected into supported platform pages to extract media data from the DOM.
 *
 * The heavy HTML/JSON parsing is done by the Rust WASM core (called from popup.js).
 * This content script focuses on DOM-level extraction since it has direct page access.
 */

(function () {
  'use strict';

  let platform = null;

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
   * Handles: twitter.com/username, tiktok.com/@username, instagram.com/username
   */
  function extractUsername() {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const firstSegment = path.split('/')[0] || '';
    return firstSegment.replace(/^@/, '');
  }

  /**
   * Check if current page is a profile page (not home/feed/explore).
   */
  function isProfilePage() {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const firstSegment = path.split('/')[0] || '';
    // Exclude non-profile pages
    const excluded = ['home', 'explore', 'notifications', 'messages', 'bookmarks',
                      'settings', 'search', 'i', 'login', 'signup', 'register',
                      'about', 'privacy', 'tos', 'discover', 'foryou', 'following',
                      'reels', 'explore', 'direct', 'accounts', 'p', 'stories'];
    return firstSegment.length > 0 && !excluded.includes(firstSegment.toLowerCase());
  }

  // ===== Twitter / X Extractors =====

  function extractTwitterMedia() {
    const media = [];
    const seenUrls = new Set();
    const username = extractUsername();

    // Strategy 1: Extract from tweet articles in the timeline
    const tweetArticles = document.querySelectorAll('article[data-testid="tweet"]');
    tweetArticles.forEach((tweet) => {
      const tweetLink = tweet.querySelector('a[href*="/status/"]');
      const postUrl = tweetLink ? tweetLink.href : window.location.href;

      // Images — Twitter serves via pbs.twimg.com
      const imgs = tweet.querySelectorAll('img[src*="pbs.twimg.com/media"]');
      imgs.forEach((img) => {
        let src = img.src;
        // Upgrade to highest quality
        src = src.replace(/name=\w+/, 'name=large');
        if (src && !seenUrls.has(src)) {
          seenUrls.add(src);
          media.push({
            id: `tw_${extractTwitterMediaId(src)}`,
            media_type: 'Image',
            url: src,
            thumbnail_url: img.src,
            post_url: postUrl,
            platform: 'twitter',
            username,
            content_type: 'image/jpeg',
          });
        }
      });

      // Videos — Twitter uses <video> with blob: URLs, but poster images are accessible
      const videoEls = tweet.querySelectorAll('video');
      videoEls.forEach((video) => {
        const poster = video.poster;
        if (poster && !seenUrls.has(poster)) {
          seenUrls.add(poster);
          // The poster is a thumbnail; actual video URL is in blob: (not directly accessible)
          // We record it as a video with the poster as thumbnail
          media.push({
            id: `tw_video_${extractTwitterMediaId(poster)}`,
            media_type: 'Video',
            url: poster.replace(/name=\w+/, 'name=large'), // best available direct URL
            thumbnail_url: poster,
            post_url: postUrl,
            platform: 'twitter',
            username,
            content_type: 'image/jpeg',
            note: 'Video preview — direct video URL requires API access',
          });
        }
      });

      // GIFs
      const gifs = tweet.querySelectorAll('video[src*="twimg.com/tweet_video"]');
      gifs.forEach((gif) => {
        const src = gif.src;
        if (src && !seenUrls.has(src)) {
          seenUrls.add(src);
          media.push({
            id: `tw_gif_${extractTwitterMediaId(src)}`,
            media_type: 'Video',
            url: src,
            thumbnail_url: gif.poster || null,
            post_url: postUrl,
            platform: 'twitter',
            username,
            content_type: 'video/mp4',
          });
        }
      });
    });

    // Strategy 2: Fallback — scan all images on the page
    if (media.length === 0) {
      const allImgs = document.querySelectorAll('img[src*="pbs.twimg.com/media"]');
      allImgs.forEach((img) => {
        let src = img.src.replace(/name=\w+/, 'name=large');
        if (src && !seenUrls.has(src)) {
          seenUrls.add(src);
          media.push({
            id: `tw_${extractTwitterMediaId(src)}`,
            media_type: 'Image',
            url: src,
            thumbnail_url: img.src,
            post_url: window.location.href,
            platform: 'twitter',
            username,
            content_type: 'image/jpeg',
          });
        }
      });
    }

    // Extract profile info
    const profileInfo = extractTwitterProfile(username);

    return { media, username, profileInfo };
  }

  /**
   * Extract media ID from a Twitter CDN URL.
   * e.g., https://pbs.twimg.com/media/AbCdEfGhIjK.jpg -> AbCdEfGhIjK
   */
  function extractTwitterMediaId(url) {
    const match = url.match(/\/media\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : url.split('/').pop().split('?')[0];
  }

  /**
   * Extract Twitter profile information from the DOM.
   */
  function extractTwitterProfile(username) {
    const profileInfo = { username };
    // Display name
    const nameEl = document.querySelector('[data-testid="UserCell"] span, h2[role="heading"] a span');
    if (nameEl) profileInfo.display_name = nameEl.textContent.trim();
    // Avatar
    const avatarEl = document.querySelector('img[src*="pbs.twimg.com/profile_images"]');
    if (avatarEl) profileInfo.avatar_url = avatarEl.src;
    return profileInfo;
  }

  // ===== TikTok Extractors =====

  function extractTikTokMedia() {
    const media = [];
    const seenIds = new Set();
    const username = extractUsername();

    // Strategy 1: Try SIGI_STATE (embedded JSON state)
    try {
      const html = document.documentElement.innerHTML;
      const sigiMatch = html.match(/window\.SIGI_STATE\s*=\s*(\{[\s\S]*\})\s*;?\s*<\/script>/);
      if (sigiMatch) {
        const sigi = JSON.parse(sigiMatch[1]);
        const itemModule = sigi.ItemModule;
        if (itemModule) {
          Object.values(itemModule).forEach((item) => {
            const video = item.video;
            const videoUrl = video?.playAddr?.[0] || video?.downloadAddr?.[0];
            if (videoUrl && !seenIds.has(item.id)) {
              seenIds.add(item.id);
              media.push({
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
            }
          });
        }
      }
    } catch (err) {
      console.warn('[ProfileDownloader] TikTok SIGI_STATE parse failed:', err);
    }

    // Strategy 2: Fallback — extract video links from DOM
    if (media.length === 0) {
      const videoLinks = document.querySelectorAll('a[href*="/video/"]');
      videoLinks.forEach((link) => {
        const href = link.href;
        const videoIdMatch = href.match(/\/video\/(\d+)/);
        if (videoIdMatch && !seenIds.has(videoIdMatch[1])) {
          seenIds.add(videoIdMatch[1]);
          const thumbImg = link.querySelector('img');
          media.push({
            id: `tt_${videoIdMatch[1]}`,
            media_type: 'Video',
            url: href,
            thumbnail_url: thumbImg?.src || null,
            post_url: href,
            platform: 'tiktok',
            username,
            content_type: 'video/mp4',
          });
        }
      });
    }

    // Extract profile info
    const profileInfo = extractTikTokProfile(username);

    return { media, username, profileInfo };
  }

  /**
   * Extract TikTok profile information.
   */
  function extractTikTokProfile(username) {
    const profileInfo = { username };
    const nameEl = document.querySelector('h1[data-e2e="user-title"], h2[data-e2e="user-subtitle"]');
    if (nameEl) profileInfo.display_name = nameEl.textContent.trim();
    const avatarEl = document.querySelector('img[data-e2e="user-avatar"]');
    if (avatarEl) profileInfo.avatar_url = avatarEl.src;
    // Stats
    const followersEl = document.querySelector('[data-e2e="followers-count"]');
    if (followersEl) profileInfo.follower_count = parseCount(followersEl.textContent);
    const followingEl = document.querySelector('[data-e2e="following-count"]');
    if (followingEl) profileInfo.following_count = parseCount(followingEl.textContent);
    const likesEl = document.querySelector('[data-e2e="likes-count"]');
    if (likesEl) profileInfo.post_count = parseCount(likesEl.textContent);
    return profileInfo;
  }

  // ===== Instagram Extractors =====

  function extractInstagramMedia() {
    const media = [];
    const seenUrls = new Set();
    const username = extractUsername();

    // Strategy 1: Try __INITIAL_STATE__ (embedded JSON)
    try {
      const html = document.documentElement.innerHTML;
      const match = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/);
      if (match) {
        const data = JSON.parse(match[1]);
        const items = data?.items || data?.feed?.items || data?.profile?.items || [];

        items.forEach((item) => {
          if (item.carousel_media) {
            // Carousel post — multiple images
            const urls = item.carousel_media
              .map((cm) => cm.image_versions2?.candidates?.[0]?.url)
              .filter(Boolean);
            if (urls.length > 0 && !seenUrls.has(urls[0])) {
              seenUrls.add(urls[0]);
              media.push({
                id: `ig_${item.code || item.id}`,
                media_type: 'Image',
                url: urls[0],
                carousel_urls: urls,
                thumbnail_url: null,
                post_url: `https://instagram.com/p/${item.code}`,
                platform: 'instagram',
                username,
                caption: item.caption?.text || item.caption || null,
                content_type: 'image/jpeg',
              });
            }
          } else {
            // Single image or video
            const url = item.image_versions2?.candidates?.[0]?.url ||
                        item.display_url || item.display_src;
            if (url && !seenUrls.has(url)) {
              seenUrls.add(url);
              const isVideo = !!item.video_versions;
              media.push({
                id: `ig_${item.code || item.id}`,
                media_type: isVideo ? 'Video' : 'Image',
                url: isVideo ? (item.video_versions?.[0]?.url || url) : url,
                thumbnail_url: url,
                post_url: `https://instagram.com/p/${item.code}`,
                platform: 'instagram',
                username,
                caption: item.caption?.text || item.caption || null,
                content_type: isVideo ? 'video/mp4' : 'image/jpeg',
              });
            }
          }
        });
      }
    } catch (err) {
      console.warn('[ProfileDownloader] Instagram __INITIAL_STATE__ parse failed:', err);
    }

    // Strategy 2: Fallback — extract from DOM images
    if (media.length === 0) {
      const imgs = document.querySelectorAll(
        'img[src*="cdninstagram.com"], img[src*="fbcdn.net"], img[src*="scontent"]'
      );
      imgs.forEach((img) => {
        const src = img.src;
        if (src && !seenUrls.has(src) && !src.includes('profile_pic')) {
          seenUrls.add(src);
          media.push({
            id: `ig_${src.split('/').pop().split('?')[0]}`,
            media_type: 'Image',
            url: src,
            thumbnail_url: src,
            post_url: window.location.href,
            platform: 'instagram',
            username,
            content_type: 'image/jpeg',
          });
        }
      });
    }

    // Extract profile info
    const profileInfo = extractInstagramProfile(username);

    return { media, username, profileInfo };
  }

  /**
   * Extract Instagram profile information.
   */
  function extractInstagramProfile(username) {
    const profileInfo = { username };
    const nameEl = document.querySelector('section h1, header h1');
    if (nameEl) profileInfo.display_name = nameEl.textContent.trim();
    const avatarEl = document.querySelector('img[src*="profile_pic"], header img');
    if (avatarEl) profileInfo.avatar_url = avatarEl.src;
    return profileInfo;
  }

  // ===== Utilities =====

  /**
   * Parse a count string like "1.2K" or "3.5M" into a number.
   */
  function parseCount(str) {
    if (!str) return null;
    const cleaned = str.trim().toLowerCase().replace(/,/g, '');
    const match = cleaned.match(/^([\d.]+)\s*([km]?)$/);
    if (!match) return parseInt(cleaned) || null;
    const num = parseFloat(match[1]);
    const mult = match[2] === 'k' ? 1000 : match[2] === 'm' ? 1000000 : 1;
    return Math.round(num * mult);
  }

  /**
   * Main extraction dispatcher.
   */
  function extractMedia() {
    platform = detectPlatform();
    if (!platform) return { error: 'Unsupported platform' };

    if (!isProfilePage()) {
      return { error: 'Please navigate to a user profile page.' };
    }

    switch (platform) {
      case 'twitter':
        return extractTwitterMedia();
      case 'tiktok':
        return extractTikTokMedia();
      case 'instagram':
        return extractInstagramMedia();
      default:
        return { error: 'Unknown platform' };
    }
  }

  /**
   * Listen for messages from the popup.
   */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractMedia') {
      try {
        const result = extractMedia();
        sendResponse(result);
      } catch (err) {
        console.error('[ProfileDownloader] Extraction error:', err);
        sendResponse({ error: err.message || 'Extraction failed' });
      }
    }
    return true; // Keep message channel open for async
  });

  console.log('[ProfileDownloader] Content script loaded on', detectPlatform());
})();
