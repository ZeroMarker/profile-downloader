pub mod downloader;
pub mod models;
pub mod platforms;
pub mod utils;

use models::{PlatformType, ProfileMedia};
use wasm_bindgen::prelude::*;

/// Parse a profile URL and return detected platform type.
#[wasm_bindgen]
pub fn detect_platform(url: &str) -> Option<String> {
    PlatformType::detect(url).map(|p| p.to_string())
}

/// Extract media from a profile page HTML (called from content script).
#[wasm_bindgen]
pub fn extract_media_from_html(platform: &str, html: &str, page_url: &str) -> String {
    let platform_type = match PlatformType::parse(platform) {
        Some(p) => p,
        None => return r#"{"error":"Unknown platform"}"#.to_string(),
    };

    match platform_type.extract_from_html(html, page_url) {
        Ok(media) => serde_json::to_string(&media)
            .unwrap_or_else(|e| format!(r#"{{"error":"Serialization failed: {}"}}"#, e)),
        Err(e) => format!(r#"{{"error":"{}"}}"#, e),
    }
}

/// Process a batch of media items (validate, deduplicate, sort).
#[wasm_bindgen]
pub fn process_media_batch(json_input: &str) -> String {
    let media: Vec<ProfileMedia> = match serde_json::from_str(json_input) {
        Ok(m) => m,
        Err(e) => return format!(r#"{{"error":"Invalid input: {}"}}"#, e),
    };
    let processed = models::process_batch(media);
    serde_json::to_string(&processed)
        .unwrap_or_else(|e| format!(r#"{{"error":"Serialization failed: {}"}}"#, e))
}

/// Initialize the WASM module (logging, config).
#[wasm_bindgen(start)]
pub fn start() {
    utils::set_panic_hook();
    utils::log("Profile Downloader Core WASM module initialized");
}
