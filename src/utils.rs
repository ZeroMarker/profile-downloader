use wasm_bindgen::prelude::*;

/// Set a panic hook that logs to the browser console.
pub fn set_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        log(&format!("Panic: {}", info));
    }));
}

/// Log a message to the browser console.
#[wasm_bindgen]
pub fn log(msg: &str) {
    js_sys::eval(&format!("console.log('[ProfileDownloader]', '{}')", msg.replace('\'', "\\'")))
        .unwrap_or_default();
}

/// Log an error to the browser console.
#[wasm_bindgen]
pub fn log_error(msg: &str) {
    js_sys::eval(&format!("console.error('[ProfileDownloader]', '{}')", msg.replace('\'', "\\'")))
        .unwrap_or_default();
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
    let segments: Vec<&str> = parsed.path_segments()?.collect();
    segments.first().map(|s| s.to_string())
}

/// Validate a media URL (basic check).
pub fn is_valid_media_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && (lower.contains(".jpg")
            || lower.contains(".jpeg")
            || lower.contains(".png")
            || lower.contains(".gif")
            || lower.contains(".webp")
            || lower.contains(".mp4")
            || lower.contains(".webm")
            || lower.contains(".mov"))
}
