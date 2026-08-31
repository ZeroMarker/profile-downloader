use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;

/// Set a panic hook that logs to the browser console.
pub fn set_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        log(&format!("Panic: {}", info));
    }));
}

/// Log a message to the browser console.
#[wasm_bindgen]
pub fn log(msg: &str) {
    web_sys::console::log_2(
        &JsValue::from_str("[ProfileDownloader]"),
        &JsValue::from_str(msg),
    );
}

/// Log an error to the browser console.
#[wasm_bindgen]
pub fn log_error(msg: &str) {
    web_sys::console::error_2(
        &JsValue::from_str("[ProfileDownloader]"),
        &JsValue::from_str(msg),
    );
}

/// Generate a unique ID for a media item.
pub fn generate_media_id(platform: &str, username: &str, url: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    platform.hash(&mut hasher);
    username.hash(&mut hasher);
    url.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// Extract the username from a profile URL for a given platform.
pub fn extract_username(url: &str, _platform: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    parsed
        .path_segments()?
        .find(|segment| !segment.is_empty())
        .map(|segment| segment.trim_start_matches('@').to_string())
        .filter(|username| !username.is_empty())
}

/// Validate a media URL (basic check).
pub fn is_valid_media_url(url: &str) -> bool {
    let parsed = match url::Url::parse(url) {
        Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => parsed,
        _ => return false,
    };
    let lower_path = parsed.path().to_lowercase();
    [
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov",
    ]
    .iter()
    .any(|ext| lower_path.ends_with(ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_first_non_empty_username_segment() {
        assert_eq!(
            extract_username("https://www.tiktok.com/@creator/video/123", "tiktok"),
            Some("creator".to_string())
        );
        assert_eq!(
            extract_username("https://instagram.com/user/", "instagram"),
            Some("user".to_string())
        );
        assert_eq!(
            extract_username("https://onlyfans.com/wetkinky/videos", "onlyfans"),
            Some("wetkinky".to_string())
        );
    }

    #[test]
    fn rejects_empty_or_invalid_usernames() {
        assert_eq!(extract_username("https://x.com/", "twitter"), None);
        assert_eq!(extract_username("not a url", "twitter"), None);
    }

    #[test]
    fn validates_media_urls_by_scheme_and_path_extension() {
        assert!(is_valid_media_url(
            "https://cdn.example.com/path/photo.JPG?size=large"
        ));
        assert!(is_valid_media_url("http://cdn.example.com/video.mp4"));
        assert!(!is_valid_media_url("ftp://cdn.example.com/video.mp4"));
        assert!(!is_valid_media_url(
            "https://example.com/page?asset=photo.jpg"
        ));
    }
}
