use serde::{Deserialize, Serialize};

/// Supported social media platforms.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PlatformType {
    Twitter,
    TikTok,
    Instagram,
}

impl PlatformType {
    pub fn detect(url: &str) -> Option<Self> {
        let parsed = url::Url::parse(url).ok()?;
        let host = parsed.host_str()?.trim_start_matches("www.").to_lowercase();

        if host == "twitter.com"
            || host.ends_with(".twitter.com")
            || host == "x.com"
            || host.ends_with(".x.com")
        {
            Some(Self::Twitter)
        } else if host == "tiktok.com" || host.ends_with(".tiktok.com") {
            Some(Self::TikTok)
        } else if host == "instagram.com" || host.ends_with(".instagram.com") {
            Some(Self::Instagram)
        } else {
            None
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "twitter" | "x" => Some(Self::Twitter),
            "tiktok" => Some(Self::TikTok),
            "instagram" | "ig" => Some(Self::Instagram),
            _ => None,
        }
    }
}

impl std::fmt::Display for PlatformType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Twitter => write!(f, "twitter"),
            Self::TikTok => write!(f, "tiktok"),
            Self::Instagram => write!(f, "instagram"),
        }
    }
}

/// A single media item (image or video) from a profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMedia {
    /// Unique identifier for deduplication
    pub id: String,
    /// Media type
    pub media_type: MediaType,
    /// Direct URL to the media file
    pub url: String,
    /// Preview/thumbnail URL (if available)
    pub thumbnail_url: Option<String>,
    /// Original post URL
    pub post_url: String,
    /// Platform source
    pub platform: String,
    /// Username of the profile
    pub username: String,
    /// Post caption / description
    pub caption: Option<String>,
    /// Timestamp of the post (Unix epoch ms)
    pub timestamp: Option<i64>,
    /// File size in bytes (if available)
    pub file_size: Option<u64>,
    /// Content type (e.g., "image/jpeg", "video/mp4")
    pub content_type: Option<String>,
}

/// Type of media content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum MediaType {
    Image,
    Video,
    Carousel(Vec<String>), // carousel posts with multiple image URLs
}

impl std::fmt::Display for MediaType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Image => write!(f, "image"),
            Self::Video => write!(f, "video"),
            Self::Carousel(_) => write!(f, "carousel"),
        }
    }
}

/// Profile information for a user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileInfo {
    pub platform: String,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub follower_count: Option<u64>,
    pub following_count: Option<u64>,
    pub post_count: Option<u64>,
}

/// Download job tracking.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadJob {
    pub job_id: String,
    pub media: ProfileMedia,
    pub status: DownloadStatus,
    pub progress: f32, // 0.0 - 1.0
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum DownloadStatus {
    Pending,
    Downloading,
    Completed,
    Failed,
}

/// Process a batch: deduplicate by id, sort by timestamp descending.
pub fn process_batch(media: Vec<ProfileMedia>) -> Vec<ProfileMedia> {
    let mut seen = std::collections::HashSet::new();
    let mut result: Vec<ProfileMedia> = media
        .into_iter()
        .filter(|m| seen.insert(m.id.clone()))
        .collect();
    result.sort_by(|a, b| b.timestamp.unwrap_or(0).cmp(&a.timestamp.unwrap_or(0)));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_twitter() {
        assert_eq!(
            PlatformType::detect("https://twitter.com/elonmusk"),
            Some(PlatformType::Twitter)
        );
        assert_eq!(
            PlatformType::detect("https://x.com/elonmusk"),
            Some(PlatformType::Twitter)
        );
    }

    #[test]
    fn test_detect_tiktok() {
        assert_eq!(
            PlatformType::detect("https://www.tiktok.com/@user"),
            Some(PlatformType::TikTok)
        );
    }

    #[test]
    fn test_detect_instagram() {
        assert_eq!(
            PlatformType::detect("https://instagram.com/user"),
            Some(PlatformType::Instagram)
        );
        assert_eq!(
            PlatformType::detect("https://www.instagram.com/user"),
            Some(PlatformType::Instagram)
        );
    }

    #[test]
    fn test_detect_unknown() {
        assert_eq!(PlatformType::detect("https://example.com"), None);
        assert_eq!(PlatformType::detect("https://notx.com/user"), None);
        assert_eq!(
            PlatformType::detect("https://example.com/?next=https://x.com/user"),
            None
        );
        assert_eq!(PlatformType::detect("not a url"), None);
    }

    #[test]
    fn test_from_str() {
        assert_eq!(
            PlatformType::from_str("twitter"),
            Some(PlatformType::Twitter)
        );
        assert_eq!(PlatformType::from_str("x"), Some(PlatformType::Twitter));
        assert_eq!(PlatformType::from_str("TIKTOK"), Some(PlatformType::TikTok));
        assert_eq!(PlatformType::from_str("ig"), Some(PlatformType::Instagram));
        assert_eq!(PlatformType::from_str("unknown"), None);
    }

    fn sample_media(id: &str, ts: Option<i64>) -> ProfileMedia {
        ProfileMedia {
            id: id.to_string(),
            media_type: MediaType::Image,
            url: format!("https://example.com/{}.jpg", id),
            thumbnail_url: None,
            post_url: "https://example.com".to_string(),
            platform: "twitter".to_string(),
            username: "user".to_string(),
            caption: None,
            timestamp: ts,
            file_size: None,
            content_type: None,
        }
    }

    #[test]
    fn test_process_batch_dedup() {
        let batch = vec![
            sample_media("a", Some(200)),
            sample_media("a", Some(100)), // duplicate id, should be removed
            sample_media("b", Some(150)),
        ];
        let result = process_batch(batch);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "a"); // newer timestamp first
        assert_eq!(result[1].id, "b");
    }

    #[test]
    fn test_process_batch_sort_desc() {
        let batch = vec![
            sample_media("old", Some(100)),
            sample_media("new", Some(300)),
            sample_media("mid", Some(200)),
        ];
        let result = process_batch(batch);
        assert_eq!(result[0].id, "new");
        assert_eq!(result[1].id, "mid");
        assert_eq!(result[2].id, "old");
    }

    #[test]
    fn test_process_batch_empty() {
        let result = process_batch(vec![]);
        assert!(result.is_empty());
    }
}
