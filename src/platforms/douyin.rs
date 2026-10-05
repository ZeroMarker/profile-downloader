use crate::models::{MediaType, ProfileMedia};
use crate::platforms::PlatformScraper;
use crate::utils;
use serde_json::Value;

pub struct DouyinScraper;

fn first_url(value: &Value) -> Option<&str> {
    let valid = |raw: &&str| {
        url::Url::parse(raw).is_ok_and(|u| {
            matches!(u.scheme(), "http" | "https")
                && u.host_str()
                    .is_some_and(|h| h != "douyin.com" && !h.ends_with(".douyin.com"))
        })
    };
    if let Some(raw) = value.as_str() {
        return Some(raw).filter(valid);
    }
    value
        .get("url_list")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .find(valid)
}

fn collect(value: &Value, username: &str, items: &mut Vec<ProfileMedia>) {
    if value["author"]["sec_uid"].as_str() == Some(username) {
        if let Some(post) = value["aweme_id"].as_str() {
            let images = value["images"]
                .as_array()
                .or_else(|| value["image_post_info"]["images"].as_array());
            let mut media = Vec::new();
            if let Some(images) = images.filter(|a| !a.is_empty()) {
                for (i, image) in images.iter().enumerate() {
                    if let Some(url) = first_url(image.get("display_image").unwrap_or(image)) {
                        media.push((i.to_string(), MediaType::Image, url, Some(url)));
                    }
                }
            } else if let Some(url) = first_url(&value["video"]["play_addr"])
                .or_else(|| first_url(&value["video"]["download_addr"]))
            {
                media.push((
                    "video".into(),
                    MediaType::Video,
                    url,
                    first_url(&value["video"]["cover"]),
                ));
            }
            for (id, media_type, url, thumbnail) in media {
                let kind = if media_type == MediaType::Video {
                    "video"
                } else {
                    "note"
                };
                items.push(ProfileMedia {
                    id: format!("dy_{post}_{id}"),
                    media_type,
                    url: url.into(),
                    thumbnail_url: thumbnail.map(str::to_string),
                    post_url: format!("https://www.douyin.com/{kind}/{post}"),
                    platform: "douyin".into(),
                    username: username.into(),
                    caption: value["desc"].as_str().map(str::to_string),
                    timestamp: value["create_time"]
                        .as_i64()
                        .and_then(|t| t.checked_mul(1000)),
                    file_size: None,
                    content_type: (kind == "video").then(|| "video/mp4".into()),
                });
            }
        }
    }
    match value {
        Value::Array(values) => values.iter().for_each(|v| collect(v, username, items)),
        Value::Object(values) => values.values().for_each(|v| collect(v, username, items)),
        _ => {}
    }
}

impl PlatformScraper for DouyinScraper {
    fn extract_media(html: &str, page_url: &str) -> Result<Vec<ProfileMedia>, String> {
        let username =
            utils::extract_username(page_url, "douyin").ok_or("Open a Douyin user profile")?;
        let re =
            regex::Regex::new(r"(?is)<script\b[^>]*>(.*?)</script>").map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for cap in re.captures_iter(html) {
            let decoded = js_sys_decode(&cap[1]);
            if let Ok(value) = serde_json::from_str::<Value>(&decoded) {
                collect(&value, &username, &mut items);
            }
        }
        Ok(crate::models::process_batch(items))
    }
}

fn js_sys_decode(raw: &str) -> String {
    // RENDER_DATA uses percent-encoded JSON, with literal plus characters.
    let mut bytes = Vec::new();
    let mut chars = raw.trim().as_bytes().iter().copied();
    while let Some(c) = chars.next() {
        if c == b'%' {
            if let (Some(a), Some(b)) = (chars.next(), chars.next()) {
                if let (Some(a), Some(b)) = ((a as char).to_digit(16), (b as char).to_digit(16)) {
                    bytes.push((a * 16 + b) as u8);
                    continue;
                }
            }
            return raw.to_string();
        }
        bytes.push(c);
    }
    String::from_utf8(bytes).unwrap_or_else(|_| raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_authors_and_rejects_page_urls() {
        let html = r#"<script id="RENDER_DATA">{"aweme_list":[{"aweme_id":"1","author":{"sec_uid":"alice"},"video":{"play_addr":{"url_list":["https://www.douyin.com/video/1","https://cdn.example.com/v.mp4"]}}},{"aweme_id":"2","author":{"sec_uid":"bob"},"images":[{"url_list":["https://cdn.example.com/i.jpg"]}]}]}</script>"#;
        let media =
            DouyinScraper::extract_media(html, "https://www.douyin.com/user/alice").unwrap();
        assert_eq!(media.len(), 1);
        assert_eq!(media[0].id, "dy_1_video");
        assert_eq!(media[0].url, "https://cdn.example.com/v.mp4");
        assert_eq!(
            crate::models::PlatformType::detect("https://www.douyin.com/user/alice"),
            Some(crate::models::PlatformType::Douyin)
        );
    }
}
