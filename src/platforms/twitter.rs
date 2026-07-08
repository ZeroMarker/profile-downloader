use crate::models::{MediaType, ProfileMedia};
use crate::platforms::PlatformScraper;
use crate::utils;
use regex::Regex;

pub struct TwitterScraper;

impl PlatformScraper for TwitterScraper {
    fn extract_media(html: &str, page_url: &str) -> Result<Vec<ProfileMedia>, String> {
        let username = utils::extract_username(page_url, "twitter")
            .ok_or_else(|| "Could not extract username from URL".to_string())?;

        let mut media_items = Vec::new();

        // Try to extract from embedded JSON data (__NEXT_DATA__ or initial state)
        if let Ok(items) = extract_from_json(html, &username) {
            media_items.extend(items);
        }

        // Fallback: try regex-based extraction for tweet media
        if media_items.is_empty() {
            if let Ok(items) = extract_from_html_regex(html, &username) {
                media_items.extend(items);
            }
        }

        Ok(media_items)
    }
}

/// Extract media from embedded JSON data (Twitter's __NEXT_DATA__ script tag).
fn extract_from_json(html: &str, username: &str) -> Result<Vec<ProfileMedia>, String> {
    let re = Regex::new(r#"<script[^>]*data-app-state[^>]*>([\s\S]*?)</script>"#)
        .map_err(|e| format!("Regex error: {}", e))?;

    let mut items = Vec::new();

    for cap in re.captures_iter(html) {
        let json_str = &cap[1];
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
            if let Some(entries) = val.get("entries") {
                if let Some(tweets) = entries.as_array() {
                    for tweet in tweets {
                        if let Some(media) = extract_tweet_media(tweet, username) {
                            items.extend(media);
                        }
                    }
                }
            }
        }
    }

    if items.is_empty() {
        Err("No media found in JSON data".to_string())
    } else {
        Ok(items)
    }
}

/// Extract media from a single tweet entry.
fn extract_tweet_media(tweet: &serde_json::Value, username: &str) -> Option<Vec<ProfileMedia>> {
    let mut items = Vec::new();
    let media_entities = tweet.get("legacy")?.get("entities")?.get("media")?;
    let media_array = media_entities.as_array()?;
    let tweet_id = tweet.get("rest_id")?.as_str()?;

    for m in media_array {
        let media_url = m.get("media_url_https")?.as_str()?;
        let media_type = m.get("type")?.as_str()?;
        let id = utils::generate_media_id("twitter", username, media_url);

        let item = ProfileMedia {
            id,
            media_type: match media_type {
                "video" | "animated_gif" => MediaType::Video,
                _ => MediaType::Image,
            },
            url: media_url.to_string(),
            thumbnail_url: Some(media_url.to_string() + "?format=jpg&name=medium"),
            post_url: format!("https://twitter.com/{}/status/{}", username, tweet_id),
            platform: "twitter".to_string(),
            username: username.to_string(),
            caption: tweet
                .get("legacy")
                .and_then(|l| l.get("full_text"))
                .and_then(|t| t.as_str())
                .map(|s| s.to_string()),
            timestamp: tweet
                .get("legacy")
                .and_then(|l| l.get("created_at"))
                .and_then(|t| t.as_str())
                .and_then(|s| parse_twitter_timestamp(s)),
            file_size: None,
            content_type: Some(match media_type {
                "video" => "video/mp4".to_string(),
                _ => "image/jpeg".to_string(),
            }),
        };
        items.push(item);
    }

    if items.is_empty() {
        None
    } else {
        Some(items)
    }
}

/// Parse Twitter's date format: "Thu Mar 18 23:15:00 +0000 2021"
fn parse_twitter_timestamp(s: &str) -> Option<i64> {
    // Simple approximate parsing for WASM (chrono is heavy)
    // In production, use a proper date parser
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 6 {
        return None;
    }
    let year: i64 = parts.get(5)?.parse().ok()?;
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = months.iter().position(|&m| m == parts[1])? as i64;
    let day: i64 = parts[2].parse().ok()?;
    let time_parts: Vec<&str> = parts[3].split(':').collect();
    let hour: i64 = time_parts.first()?.parse().ok()?;
    let minute: i64 = time_parts.get(1)?.parse().ok()?;
    let second: i64 = time_parts.get(2)?.parse().ok()?;

    // Simplified timestamp calculation (ignores timezone offset)
    let days_since_epoch = (year - 1970) * 365 + month as i64 * 30 + day as i64;
    Some((days_since_epoch * 86400 + hour * 3600 + minute * 60 + second) * 1000)
}

/// Fallback: extract media URLs using regex on HTML.
fn extract_from_html_regex(html: &str, username: &str) -> Result<Vec<ProfileMedia>, String> {
    let img_re = Regex::new(r#"https?://pbs\.twimg\.com/media/[^\s"']+(?:\.(?:jpg|png|gif|webp))?"#)
        .map_err(|e| format!("Regex error: {}", e))?;
    let video_re = Regex::new(r#"https?://video\.twimg\.com/[^\s"']+(?:\.mp4)?"#)
        .map_err(|e| format!("Regex error: {}", e))?;

    let mut items = Vec::new();

    for (i, m) in img_re.find_iter(html).enumerate() {
        let url = m.as_str().to_string();
        let id = utils::generate_media_id("twitter", username, &url);
        items.push(ProfileMedia {
            id,
            media_type: MediaType::Image,
            url,
            thumbnail_url: None,
            post_url: format!("https://twitter.com/{}", username),
            platform: "twitter".to_string(),
            username: username.to_string(),
            caption: None,
            timestamp: None,
            file_size: None,
            content_type: Some("image/jpeg".to_string()),
        });
        // Limit to avoid excessive items from regex fallback
        if i >= 100 {
            break;
        }
    }

    // Extract videos
    for m in video_re.find_iter(html) {
        let url = m.as_str().to_string();
        let id = utils::generate_media_id("twitter", username, &url);
        items.push(ProfileMedia {
            id,
            media_type: MediaType::Video,
            url,
            thumbnail_url: None,
            post_url: format!("https://twitter.com/{}", username),
            platform: "twitter".to_string(),
            username: username.to_string(),
            caption: None,
            timestamp: None,
            file_size: None,
            content_type: Some("video/mp4".to_string()),
        });
    }

    if items.is_empty() {
        Err("No media found via regex".to_string())
    } else {
        Ok(items)
    }
}
