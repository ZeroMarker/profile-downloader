use crate::models::{MediaType, ProfileMedia};
use crate::platforms::PlatformScraper;
use crate::utils;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;

/// Extracts media that the signed-in browser session has already been allowed
/// to load. This parser does not unlock or request inaccessible posts.
pub struct OnlyFansScraper;

impl PlatformScraper for OnlyFansScraper {
    fn extract_media(html: &str, page_url: &str) -> Result<Vec<ProfileMedia>, String> {
        let username = utils::extract_username(page_url, "onlyfans")
            .ok_or_else(|| "Could not extract username from URL".to_string())?;
        let mut items = Vec::new();
        let mut seen = HashSet::new();

        let script_re = Regex::new(
            r#"(?is)<script[^>]*type=[\"']application/(?:ld\+)?json[\"'][^>]*>(.*?)</script>"#,
        )
        .map_err(|e| format!("Regex error: {}", e))?;
        for captures in script_re.captures_iter(html) {
            if let Ok(value) = serde_json::from_str::<Value>(&captures[1]) {
                walk_json(&value, &username, &mut items, &mut seen);
            }
        }

        if items.is_empty() {
            extract_cdn_urls(html, &username, page_url, &mut items, &mut seen)?;
        }

        if items.is_empty() {
            Err("No accessible OnlyFans media found; sign in, open a creator profile, and scroll to load posts".to_string())
        } else {
            Ok(items)
        }
    }
}

fn walk_json(
    value: &Value,
    username: &str,
    items: &mut Vec<ProfileMedia>,
    seen: &mut HashSet<String>,
) {
    match value {
        Value::Object(object) => {
            if object.get("canView").and_then(Value::as_bool) != Some(false) {
                if let Some(media) = object.get("media").and_then(Value::as_array) {
                    let owner = object
                        .get("fromUser")
                        .or_else(|| object.get("author"))
                        .or_else(|| object.get("user"))
                        .and_then(|v| v.get("username"))
                        .and_then(Value::as_str)
                        .unwrap_or(username);
                    if owner.eq_ignore_ascii_case(username) {
                        let caption = object
                            .get("text")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let timestamp = object.get("postedAtPrecise").and_then(Value::as_i64);
                        for entry in media {
                            if entry.get("canView").and_then(Value::as_bool) == Some(false) {
                                continue;
                            }
                            if let Some(item) =
                                media_from_json(entry, username, caption.clone(), timestamp)
                            {
                                if seen.insert(item.url.clone()) {
                                    items.push(item);
                                }
                            }
                        }
                    }
                }
            }
            for child in object.values() {
                walk_json(child, username, items, seen);
            }
        }
        Value::Array(values) => {
            for child in values {
                walk_json(child, username, items, seen);
            }
        }
        _ => {}
    }
}

fn string_value(value: Option<&Value>) -> Option<String> {
    value.and_then(|v| match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

fn media_from_json(
    media: &Value,
    username: &str,
    caption: Option<String>,
    timestamp: Option<i64>,
) -> Option<ProfileMedia> {
    let media_type = media.get("type").and_then(Value::as_str).unwrap_or("photo");
    if !matches!(media_type, "photo" | "image" | "gif" | "video") {
        return None;
    }
    let files = media.get("files");
    let full_url = files
        .and_then(|v| v.get("full"))
        .and_then(|v| v.get("url"))
        .and_then(Value::as_str);
    let source_url = media.get("source").and_then(|v| {
        v.get("source")
            .and_then(Value::as_str)
            .or_else(|| v.as_str())
    });
    let src_url = media.get("src").and_then(Value::as_str);
    let url = if media_type == "video" {
        source_url.or(full_url).or(src_url)?
    } else {
        full_url.or(src_url).or(source_url)?
    };
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return None;
    }
    let thumbnail = files
        .and_then(|v| v.get("thumb").or_else(|| v.get("preview")))
        .and_then(|v| v.get("url"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let id = string_value(media.get("id"))
        .map(|id| format!("of_{}", id))
        .unwrap_or_else(|| utils::generate_media_id("onlyfans", username, url));
    let is_video = media_type == "video";
    Some(ProfileMedia {
        id,
        media_type: if is_video {
            MediaType::Video
        } else {
            MediaType::Image
        },
        url: url.to_string(),
        thumbnail_url: thumbnail,
        post_url: format!("https://onlyfans.com/{}", username),
        platform: "onlyfans".to_string(),
        username: username.to_string(),
        caption,
        timestamp,
        file_size: None,
        content_type: Some(if is_video { "video/mp4" } else { "image/jpeg" }.to_string()),
    })
}

fn extract_cdn_urls(
    html: &str,
    username: &str,
    page_url: &str,
    items: &mut Vec<ProfileMedia>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let re = Regex::new(
        r#"https?://[^\s\"'<>]+(?:onlyfans\.com|onlyfans\.com\.cdn\.cloudflare\.net)[^\s\"'<>]*\.(?:jpe?g|png|webp|gif|mp4|webm)(?:\?[^\s\"'<>]*)?"#,
    )
    .map_err(|e| format!("Regex error: {}", e))?;
    for found in re.find_iter(html).take(200) {
        let url = found.as_str().replace("&amp;", "&");
        if !seen.insert(url.clone()) {
            continue;
        }
        let lower = url.to_lowercase();
        let is_video = lower.contains(".mp4") || lower.contains(".webm");
        items.push(ProfileMedia {
            id: utils::generate_media_id("onlyfans", username, &url),
            media_type: if is_video {
                MediaType::Video
            } else {
                MediaType::Image
            },
            url,
            thumbnail_url: None,
            post_url: page_url.to_string(),
            platform: "onlyfans".to_string(),
            username: username.to_string(),
            caption: None,
            timestamp: None,
            file_size: None,
            content_type: Some(if is_video { "video/mp4" } else { "image/jpeg" }.to_string()),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_accessible_api_media_and_skips_locked_posts() {
        let html = r#"<script type="application/json">{
          "posts": [
            {"id": 42, "canView": true, "author": {"username":"alice"}, "text":"hello", "media":[
              {"id":101,"type":"photo","files":{"full":{"url":"https://public.onlyfans.com/files/a.jpg"},"thumb":{"url":"https://public.onlyfans.com/files/a_thumb.jpg"}}},
              {"id":102,"type":"video","files":{"full":{"url":"https://cdn.onlyfans.com/files/b.mp4"}}}
            ]},
            {"id": 43, "canView": false, "author": {"username":"alice"}, "media":[
              {"id":103,"type":"photo","files":{"full":{"url":"https://public.onlyfans.com/files/locked.jpg"}}}
            ]}
          ]
        }</script>"#;
        let items = OnlyFansScraper::extract_media(html, "https://onlyfans.com/alice").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "of_101");
        assert_eq!(items[1].media_type, MediaType::Video);
        assert!(items.iter().all(|item| !item.url.contains("locked")));
    }

    #[test]
    fn prefers_video_source_and_accepts_from_user_owner() {
        let html = r#"<script type="application/json">{
          "id": 55,
          "canView": true,
          "fromUser": {"username":"wetkinky"},
          "media":[{
            "id":201,
            "type":"video",
            "files":{"full":{"url":"https://public.onlyfans.com/files/poster.jpg"}},
            "source":{"source":"https://cdn.onlyfans.com/files/movie.mp4"}
          }]
        }</script>"#;
        let items =
            OnlyFansScraper::extract_media(html, "https://onlyfans.com/wetkinky/videos").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].media_type, MediaType::Video);
        assert_eq!(items[0].url, "https://cdn.onlyfans.com/files/movie.mp4");
        assert_eq!(items[0].thumbnail_url.as_deref(), None);
    }
}
