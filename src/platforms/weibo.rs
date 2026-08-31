use crate::models::{MediaType, ProfileMedia};
use crate::platforms::PlatformScraper;
use crate::utils;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;

pub struct WeiboScraper;

impl PlatformScraper for WeiboScraper {
    fn extract_media(html: &str, page_url: &str) -> Result<Vec<ProfileMedia>, String> {
        let username = extract_weibo_username(page_url)
            .ok_or_else(|| "Could not extract Weibo profile identifier from URL".to_string())?;
        let mut items = Vec::new();
        let mut seen = HashSet::new();

        extract_json_media(html, &username, &mut items, &mut seen);
        extract_cdn_urls(html, &username, &mut items, &mut seen)?;

        if items.is_empty() {
            Err("No Weibo media found".to_string())
        } else {
            Ok(items)
        }
    }
}

fn extract_weibo_username(page_url: &str) -> Option<String> {
    let parsed = url::Url::parse(page_url).ok()?;
    let parts: Vec<_> = parsed
        .path_segments()?
        .filter(|part| !part.is_empty())
        .collect();
    match parts.as_slice() {
        ["u" | "n", identifier, ..] => Some((*identifier).to_string()),
        [identifier, ..] if !matches!(*identifier, "hot" | "newlogin" | "login" | "tv") => {
            Some((*identifier).to_string())
        }
        _ => None,
    }
}

fn extract_json_media(
    html: &str,
    username: &str,
    items: &mut Vec<ProfileMedia>,
    seen: &mut HashSet<String>,
) {
    let script_re = Regex::new(r#"<script[^>]*>([\s\S]*?)</script>"#).expect("valid regex");
    for captures in script_re.captures_iter(html) {
        let source = captures
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let Some(start) = source.find('{') else {
            continue;
        };
        let Some(end) = source.rfind('}') else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&source[start..=end]) else {
            continue;
        };
        walk_json(&value, username, items, seen);
    }
}

fn walk_json(
    value: &Value,
    username: &str,
    items: &mut Vec<ProfileMedia>,
    seen: &mut HashSet<String>,
) {
    match value {
        Value::Object(map) => {
            if map.contains_key("pic_ids")
                || map.contains_key("pic_infos")
                || map.contains_key("page_info")
            {
                extract_status(value, username, items, seen);
            }
            for child in map.values() {
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

fn extract_status(
    status: &Value,
    username: &str,
    items: &mut Vec<ProfileMedia>,
    seen: &mut HashSet<String>,
) {
    let post_id = status
        .get("mblogid")
        .or_else(|| status.get("idstr"))
        .or_else(|| status.get("id"))
        .and_then(value_as_string)
        .unwrap_or_default();
    let post_url = if post_id.is_empty() {
        format!("https://weibo.com/u/{username}")
    } else {
        format!("https://weibo.com/{username}/{post_id}")
    };
    let caption = status
        .get("text_raw")
        .or_else(|| status.get("text"))
        .and_then(Value::as_str)
        .map(strip_html);
    let timestamp = status.get("created_at").and_then(Value::as_i64);

    if let Some(pic_infos) = status.get("pic_infos").and_then(Value::as_object) {
        for (pic_id, info) in pic_infos {
            let url = ["largest", "original", "large", "bmiddle", "thumbnail"]
                .iter()
                .find_map(|key| info.get(key)?.get("url")?.as_str());
            if let Some(url) = url {
                push_item(
                    items,
                    seen,
                    username,
                    pic_id,
                    url,
                    None,
                    &post_url,
                    caption.clone(),
                    timestamp,
                    false,
                );
            }
        }
    }

    let page_info = status.get("page_info");
    if let Some(video_url) = page_info
        .and_then(|info| info.get("media_info"))
        .and_then(best_video_url)
    {
        let thumbnail = page_info
            .and_then(|info| info.get("page_pic"))
            .and_then(|pic| pic.get("url").or(Some(pic)))
            .and_then(Value::as_str)
            .map(str::to_string);
        let id = if post_id.is_empty() { "video" } else { post_id };
        push_item(
            items, seen, username, id, &video_url, thumbnail, &post_url, caption, timestamp, true,
        );
    }
}

fn best_video_url(media_info: &Value) -> Option<String> {
    [
        "stream_url_hd",
        "stream_url",
        "mp4_hd_url",
        "mp4_sd_url",
        "h5_url",
    ]
    .iter()
    .find_map(|key| media_info.get(key)?.as_str().map(str::to_string))
}

fn value_as_string(value: &Value) -> Option<&str> {
    value.as_str()
}

fn strip_html(value: &str) -> String {
    let tags = Regex::new(r"<[^>]+>").expect("valid regex");
    tags.replace_all(value, "").into_owned()
}

fn extract_cdn_urls(
    html: &str,
    username: &str,
    items: &mut Vec<ProfileMedia>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let decoded = html
        .replace(r"\u002F", "/")
        .replace(r"\/", "/")
        .replace("&amp;", "&");
    let url_re = Regex::new(
        r#"https?://[^\s"'<>\\]+(?:sinaimg\.cn|weibocdn\.com|weibo\.com)[^\s"'<>\\]*(?:\.(?:jpg|jpeg|png|gif|webp|mp4))(?:\?[^\s"'<>\\]*)?"#,
    )
    .map_err(|error| format!("Regex error: {error}"))?;

    for matched in url_re.find_iter(&decoded).take(300) {
        let url = matched.as_str();
        let is_video = url.to_ascii_lowercase().contains(".mp4");
        let id = utils::generate_media_id("weibo", username, url);
        push_item(
            items,
            seen,
            username,
            &id,
            url,
            None,
            &format!("https://weibo.com/u/{username}"),
            None,
            None,
            is_video,
        );
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn push_item(
    items: &mut Vec<ProfileMedia>,
    seen: &mut HashSet<String>,
    username: &str,
    source_id: &str,
    url: &str,
    thumbnail: Option<String>,
    post_url: &str,
    caption: Option<String>,
    timestamp: Option<i64>,
    is_video: bool,
) {
    if !seen.insert(url.to_string()) {
        return;
    }
    items.push(ProfileMedia {
        id: format!("wb_{source_id}"),
        media_type: if is_video {
            MediaType::Video
        } else {
            MediaType::Image
        },
        url: url.to_string(),
        thumbnail_url: thumbnail,
        post_url: post_url.to_string(),
        platform: "weibo".to_string(),
        username: username.to_string(),
        caption,
        timestamp,
        file_size: None,
        content_type: Some(if is_video { "video/mp4" } else { "image/jpeg" }.to_string()),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_weibo_json_images_and_video() {
        let html = r#"<script type="application/json">{
          "statuses":[{
            "idstr":"5001","mblogid":"AbCd","text_raw":"hello",
            "pic_infos":{"p1":{"largest":{"url":"https://wx1.sinaimg.cn/large/p1.jpg"}}},
            "page_info":{"page_pic":{"url":"https://wx1.sinaimg.cn/large/thumb.jpg"},
              "media_info":{"stream_url_hd":"https://f.video.weibocdn.com/test.mp4"}}
          }]
        }</script>"#;
        let media = WeiboScraper::extract_media(html, "https://weibo.com/u/123").unwrap();
        assert!(media.iter().any(|item| item.url.ends_with("/p1.jpg")));
        assert!(media.iter().any(|item| item.url.ends_with("/test.mp4")));
        assert!(media.iter().all(|item| item.platform == "weibo"));
    }

    #[test]
    fn extracts_profile_identifiers() {
        assert_eq!(
            extract_weibo_username("https://weibo.com/u/123/videos"),
            Some("123".into())
        );
        assert_eq!(
            extract_weibo_username("https://weibo.com/n/example"),
            Some("example".into())
        );
        assert_eq!(extract_weibo_username("https://weibo.com/"), None);
    }
}
