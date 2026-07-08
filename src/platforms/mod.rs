pub mod twitter;
pub mod tiktok;
pub mod instagram;

use crate::models::{PlatformType, ProfileMedia};

/// Trait that each platform scraper must implement.
pub trait PlatformScraper {
    /// Parse profile page HTML and extract media items.
    fn extract_media(html: &str, page_url: &str) -> Result<Vec<ProfileMedia>, String>;
}

impl PlatformType {
    /// Extract media from HTML for this platform.
    pub fn extract_from_html(&self, html: &str, page_url: &str) -> Result<Vec<ProfileMedia>, String> {
        match self {
            Self::Twitter => twitter::TwitterScraper::extract_media(html, page_url),
            Self::TikTok => tiktok::TikTokScraper::extract_media(html, page_url),
            Self::Instagram => instagram::InstagramScraper::extract_media(html, page_url),
        }
    }
}
