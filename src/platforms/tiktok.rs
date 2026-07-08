use crate::models::{MediaType, ProfileMedia};
use crate::platforms::PlatformScraper;
use crate::utils;
use regex::Regex;

pub struct TikTokScraper;

impl PlatformScraper for TikTokScraper {
    fn extract_media(html: &str, page_url: &str) -> Result<Vec<ProfileMedia>, String> {
        let username = utils::extract_username(page_url, "tiktok")
            .ok_or_else(|| "Could not extract username from URL".to_string())?;

        // Try JSON-LD data first
        if let Ok(items) = extract_from_json_ld(html, &username) {
            if !items.is_empty() {
                return Ok(items);
            }
        }

        // Try SIGI_STATE (TikTok's embedded state)
        if let Ok(items) = extract_from_sigi_state(html, &username) {
            if !items.is_empty() {
                return Ok(items);
            }
        }

        // Fallback: regex-based extraction
        extract_from_html_regex(html, &username)
    }
}

/// Extract from JSON-LD structured data.
fn extract_from_json_ld(html: &str, username: &str) -> Result<Vec<ProfileMedia>, String> {
    let re = Regex::new(r#"<script[^>]*type="application/ld\+json"[^>]*>([\s\S]*?)</script>"#)
        .map_err(|e| format!("Regex error: {}", e))?;

    for cap in re.captures_iter(html) {
        let json_str = &cap[1];
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
            if let Some(video_list) = val.get("video") {
                if let Some(videos) = video_list.as_array() {
                    let mut items = Vec::new();
                    for (i, video) in videos.iter().enumerate() {
                        if let Some(url) = video.get("contentUrl").and_then(|u| u.as_str()) {
                            let id = utils::generate_media_id("tiktok", username, url);
                            items.push(ProfileMedia {
                                id,
                                media_type: MediaType::Video,
                                url: url.to_string(),
                                thumbnail_url: video
                                    .get("thumbnailUrl")
                                    .and_then(|t| t.as_array())
                                    .and_then(|a| a.first())
                                    .and_then(|t| t.as_str())
                                    .map(|s| s.to_string()),
                                post_url: url.to_string(),
                                platform: "tiktok".to_string(),
                                username: username.to_string(),
                                caption: video.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()),
                                timestamp: video
                                    .get("uploadDate")
                                    .and_then(|d| d.as_str())
                                    .and_then(|s| parse_tiktok_date(s)),
                                file_size: None,
                                content_type: Some("video/mp4".to_string()),
                            });
                        }
                        // Limit to reasonable batch
                        if i >= 50 {
                            break;
                        }
                    }
                    if !items.is_empty() {
                        return Ok(items);
                    }
                }
            }
        }
    }
    Err("No JSON-LD media found".to_string())
}

/// Extract from TikTok's SIGI_STATE global variable.
fn extract_from_sigi_state(html: &str, username: &str) -> Result<Vec<ProfileMedia>, String> {
    let re = Regex::new(r#"window\.SIGI_STATE\s*=\s*(\{[\s\S]*?\});"#)
        .map_err(|e| format!("Regex error: {}", e))?;

    for cap in re.captures_iter(html) {
        let json_str = &cap[1];
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
            let mut items = Vec::new();

            // Navigate to ItemModule
            if let Some(item_module) = val.get("ItemModule") {
                if let Some(obj) = item_module.as_object() {
                    for (_key, item) in obj.iter() {
                        if let Some(video) = item.get("video") {
                            if let Some(url) = video
                                .get("playAddr")
                                .or_else(|| video.get("downloadAddr"))
                                .and_then(|a| a.as_array())
                                .and_then(|a| a.first())
                                .and_then(|u| u.as_str())
                            {
                                let id = item
                                    .get("id")
                                    .and_then(|i| i.as_str())
                                    .unwrap_or(url);
                                let id = utils::generate_media_id("tiktok", username, id);
                                items.push(ProfileMedia {
                                    id,
                                    media_type: MediaType::Video,
                                    url: url.to_string(),
                                    thumbnail_url: video
                                        .get("cover")
                                        .and_then(|c| c.as_str())
                                        .map(|s| s.to_string()),
                                    post_url: format!("https://www.tiktok.com/@{}/video/{}", username,
                                        item.get("id").and_then(|i| i.as_str()).unwrap_or("")),
                                    platform: "tiktok".to_string(),
                                    username: username.to_string(),
                                    caption: item.get("desc").and_then(|d| d.as_str()).map(|s| s.to_string()),
                                    timestamp: item
                                        .get("createTime")
                                        .and_then(|t| t.as_str())
                                        .and_then(|s| s.parse::<i64>().ok())
                                        .map(|t| t * 1000),
                                    file_size: None,
                                    content_type: Some("video/mp4".to_string()),
                                });
                            }
                        }
                    }
                }
            }
            if !items.is_empty() {
                return Ok(items);
            }
        }
    }
    Err("No SIGI_STATE media found".to_string())
}

/// Parse ISO 8601 date string to Unix epoch ms.
fn parse_tiktok_date(s: &str) -> Option<i64> {
    // Simple ISO 8601 parsing: "2024-01-15T10:30:00.000Z"
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

/// Fallback regex extraction for TikTok.
fn extract_from_html_regex(html: &str, username: &str) -> Result<Vec<ProfileMedia>, String> {
    let re = Regex::new(r#"(?:https?://[^\s"']*?tiktok\.com[^\s"']*?video/(\d+)[^\s"']*)"#)
        .map_err(|e| format!("Regex error: {}", e))?;

    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for cap in re.captures_iter(html) {
        let video_id = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        if seen.insert(video_id.to_string()) {
            let id = utils::generate_media_id("tiktok", username, video_id);
            items.push(ProfileMedia {
                id,
                media_type: MediaType::Video,
                url: format!("https://www.tiktok.com/@{}/video/{}", username, video_id),
                thumbnail_url: None,
                post_url: format!("https://www.tiktok.com/@{}/video/{}", username, video_id),
                platform: "tiktok".to_string(),
                username: username.to_string(),
                caption: None,
                timestamp: None,
                file_size: None,
                content_type: Some("video/mp4".to_string()),
            });
        }
        if items.len() >= 50 {
            break;
        }
    }

    if items.is_empty() {
        Err("No TikTok media found via regex".to_string())
    } else {
        Ok(items)
    }
}
