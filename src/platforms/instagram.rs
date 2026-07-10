use crate::models::{MediaType, ProfileMedia};
use crate::platforms::PlatformScraper;
use crate::utils;
use regex::Regex;

pub struct InstagramScraper;

impl PlatformScraper for InstagramScraper {
    fn extract_media(html: &str, page_url: &str) -> Result<Vec<ProfileMedia>, String> {
        let username = utils::extract_username(page_url, "instagram")
            .ok_or_else(|| "Could not extract username from URL".to_string())?;

        // Try shared data from __NEXT_DATA__ or __INITIAL_STATE__
        if let Ok(items) = extract_from_shared_data(html, &username) {
            if !items.is_empty() {
                return Ok(items);
            }
        }

        // Try extracting from JSON-LD
        if let Ok(items) = extract_from_json_ld(html, &username) {
            if !items.is_empty() {
                return Ok(items);
            }
        }

        // Fallback: regex-based
        extract_from_html_regex(html, &username)
    }
}

/// Extract from Instagram's shared data script.
fn extract_from_shared_data(html: &str, username: &str) -> Result<Vec<ProfileMedia>, String> {
    // Instagram puts data in <script type="text/javascript">window.__INITIAL_STATE__ = {...}
    let re = Regex::new(r#"window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});"#)
        .map_err(|e| format!("Regex error: {}", e))?;

    for cap in re.captures_iter(html) {
        let json_str = &cap[1];
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
            let mut items = Vec::new();

            // Navigate to profile media
            if let Some(edges) = val
                .get("items")
                .or_else(|| {
                    val.get("feed")
                        .and_then(|f| f.get("items"))
                        .or_else(|| val.get("profile").and_then(|p| p.get("items")))
                })
                .and_then(|i| i.as_array())
            {
                for edge in edges {
                    if let Some(item) = extract_instagram_item(edge, username) {
                        items.push(item);
                    }
                }
            }

            if !items.is_empty() {
                return Ok(items);
            }
        }
    }

    Err("No shared data found".to_string())
}

/// Extract from JSON-LD.
fn extract_from_json_ld(html: &str, username: &str) -> Result<Vec<ProfileMedia>, String> {
    let re = Regex::new(r#"<script[^>]*type="application/ld\+json"[^>]*>([\s\S]*?)</script>"#)
        .map_err(|e| format!("Regex error: {}", e))?;

    for cap in re.captures_iter(html) {
        let json_str = &cap[1];
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
            let mut items = Vec::new();
            if let Some(image_list) = val.get("image").and_then(|i| i.as_array()) {
                for img_url in image_list {
                    if let Some(url) = img_url.as_str() {
                        let id = utils::generate_media_id("instagram", username, url);
                        items.push(ProfileMedia {
                            id,
                            media_type: MediaType::Image,
                            url: url.to_string(),
                            thumbnail_url: None,
                            post_url: format!("https://instagram.com/{}", username),
                            platform: "instagram".to_string(),
                            username: username.to_string(),
                            caption: val
                                .get("caption")
                                .and_then(|c| c.as_str())
                                .map(|s| s.to_string()),
                            timestamp: val
                                .get("datePublished")
                                .and_then(|d| d.as_str())
                                .and_then(|s| parse_instagram_date(s)),
                            file_size: None,
                            content_type: Some("image/jpeg".to_string()),
                        });
                    }
                }
            }
            if !items.is_empty() {
                return Ok(items);
            }
        }
    }
    Err("No JSON-LD media found".to_string())
}

/// Extract a single Instagram post/item.
fn extract_instagram_item(item: &serde_json::Value, username: &str) -> Option<ProfileMedia> {
    // Check for carousel (multiple images)
    let carousel_media = item.get("carousel_media").and_then(|c| c.as_array());

    if let Some(media_list) = carousel_media {
        let mut urls = Vec::new();
        for media in media_list {
            if let Some(url) = extract_image_url(media) {
                urls.push(url);
            }
        }
        if urls.is_empty() {
            return None;
        }
        let id = urls.first()?;
        let id = utils::generate_media_id("instagram", username, id);
        let post_code = item.get("code").and_then(|c| c.as_str()).unwrap_or("");
        Some(ProfileMedia {
            id,
            media_type: MediaType::Carousel(urls.clone()),
            url: urls.first()?.clone(),
            thumbnail_url: None,
            post_url: format!("https://instagram.com/p/{}", post_code),
            platform: "instagram".to_string(),
            username: username.to_string(),
            caption: item
                .get("caption")
                .and_then(|c| c.as_str())
                .map(|s| s.to_string()),
            timestamp: item.get("taken_at").and_then(|t| t.as_i64()),
            file_size: None,
            content_type: Some("image/jpeg".to_string()),
        })
    } else if let Some(url) = extract_image_url(item) {
        let id = utils::generate_media_id("instagram", username, &url);
        let is_video = item.get("video_versions").is_some();
        let post_code = item.get("code").and_then(|c| c.as_str()).unwrap_or("");
        Some(ProfileMedia {
            id,
            media_type: if is_video {
                MediaType::Video
            } else {
                MediaType::Image
            },
            url,
            thumbnail_url: None,
            post_url: format!("https://instagram.com/p/{}", post_code),
            platform: "instagram".to_string(),
            username: username.to_string(),
            caption: item
                .get("caption")
                .and_then(|c| c.as_str())
                .map(|s| s.to_string()),
            timestamp: item.get("taken_at").and_then(|t| t.as_i64()),
            file_size: None,
            content_type: Some(if is_video { "video/mp4" } else { "image/jpeg" }.to_string()),
        })
    } else {
        None
    }
}

/// Extract image URL from an Instagram media node.
fn extract_image_url(item: &serde_json::Value) -> Option<String> {
    // Try image_versions2 (newer API)
    if let Some(versions) = item.get("image_versions2") {
        if let Some(candidates) = versions.get("candidates").and_then(|c| c.as_array()) {
            // Return the highest resolution
            let best = candidates.iter().max_by_key(|c| {
                (c.get("width").and_then(|w| w.as_i64()).unwrap_or(0))
                    * (c.get("height").and_then(|h| h.as_i64()).unwrap_or(0))
            });
            if let Some(best) = best {
                return best
                    .get("url")
                    .and_then(|u| u.as_str())
                    .map(|s| s.to_string());
            }
        }
    }
    // Fallback: direct display_src or display_url
    item.get("display_src")
        .or_else(|| item.get("display_url"))
        .or_else(|| item.get("url"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
}

/// Parse Instagram's date format (ISO 8601 or Unix timestamp).
fn parse_instagram_date(s: &str) -> Option<i64> {
    // Try Unix timestamp (as number)
    if let Ok(ts) = s.parse::<i64>() {
        return Some(ts * 1000);
    }
    // Try ISO 8601
    let re = Regex::new(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})").ok()?;
    let caps = re.captures(s)?;
    let year: i64 = caps.get(1)?.as_str().parse().ok()?;
    let month: i64 = caps.get(2)?.as_str().parse().ok()?;
    let day: i64 = caps.get(3)?.as_str().parse().ok()?;
    let hour: i64 = caps.get(4)?.as_str().parse().ok()?;
    let min: i64 = caps.get(5)?.as_str().parse().ok()?;
    let sec: i64 = caps.get(6)?.as_str().parse().ok()?;

    let days = (year - 1970) * 365 + (month - 1) * 30 + day;
    Some((days * 86400 + hour * 3600 + min * 60 + sec) * 1000)
}

/// Fallback regex extraction for Instagram.
fn extract_from_html_regex(html: &str, username: &str) -> Result<Vec<ProfileMedia>, String> {
    // Match Instagram CDN image URLs
    let re =
        Regex::new(r#"https?://[^\s"']*?cdninstagram\.com[^\s"']*?(?:\.(?:jpg|png|webp))[^\s"']*"#)
            .map_err(|e| format!("Regex error: {}", e))?;

    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for m in re.find_iter(html) {
        let url = m.as_str().to_string();
        if seen.insert(url.clone()) {
            let id = utils::generate_media_id("instagram", username, &url);
            items.push(ProfileMedia {
                id,
                media_type: MediaType::Image,
                url,
                thumbnail_url: None,
                post_url: format!("https://instagram.com/{}", username),
                platform: "instagram".to_string(),
                username: username.to_string(),
                caption: None,
                timestamp: None,
                file_size: None,
                content_type: Some("image/jpeg".to_string()),
            });
        }
        if items.len() >= 100 {
            break;
        }
    }

    if items.is_empty() {
        Err("No Instagram media found via regex".to_string())
    } else {
        Ok(items)
    }
}
