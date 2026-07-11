use crate::models::{DownloadJob, DownloadStatus, ProfileMedia};

/// Manager for creating and tracking download jobs.
///
/// The actual file download is performed by the Chrome downloads API
/// in the background service worker (`background.js`). This module
/// handles job creation, filename generation, and state tracking on
/// the WASM side.
pub struct DownloadManager;

impl DownloadManager {
    /// Create a download job from a media item.
    pub fn create_job(media: ProfileMedia, job_id: &str) -> DownloadJob {
        DownloadJob {
            job_id: job_id.to_string(),
            media,
            status: DownloadStatus::Pending,
            progress: 0.0,
            error: None,
        }
    }

    /// Generate a safe filename for a media item.
    pub fn generate_filename(media: &ProfileMedia) -> String {
        let ext = Self::get_extension(media);
        let safe_username = media
            .username
            .replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "_");
        let safe_id = media
            .id
            .replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "_");
        // Folder per user: {platform}_{username}/{id}.{ext}
        format!("{}_{}/{}.{}", media.platform, safe_username, safe_id, ext)
    }

    /// Get the file extension for a media item.
    fn get_extension(media: &ProfileMedia) -> &'static str {
        if let Some(ct) = &media.content_type {
            if ct.contains("png") {
                return "png";
            }
            if ct.contains("gif") {
                return "gif";
            }
            if ct.contains("webp") {
                return "webp";
            }
            if ct.contains("mp4") {
                return "mp4";
            }
            if ct.contains("webm") {
                return "webm";
            }
        }
        // Fallback: infer from media type
        match media.media_type {
            crate::models::MediaType::Video => "mp4",
            _ => "jpg",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{MediaType, ProfileMedia};

    fn sample_media(media_type: MediaType, content_type: Option<&str>) -> ProfileMedia {
        ProfileMedia {
            id: "abc123".to_string(),
            media_type,
            url: "https://example.com/media.jpg".to_string(),
            thumbnail_url: None,
            post_url: "https://example.com/post".to_string(),
            platform: "twitter".to_string(),
            username: "test_user".to_string(),
            caption: None,
            timestamp: None,
            file_size: None,
            content_type: content_type.map(|s| s.to_string()),
        }
    }

    #[test]
    fn test_generate_filename_image() {
        let media = sample_media(MediaType::Image, Some("image/jpeg"));
        let name = DownloadManager::generate_filename(&media);
        // Should contain folder separator
        assert!(
            name.contains('/'),
            "Expected folder separator in filename: {}",
            name
        );
        let parts: Vec<&str> = name.split('/').collect();
        assert_eq!(parts.len(), 2, "Expected folder/file format, got: {}", name);
        assert!(
            parts[0].starts_with("twitter_test_user"),
            "Folder should start with 'twitter_test_user', got: {}",
            parts[0]
        );
        assert!(
            parts[1].ends_with(".jpg"),
            "File should end with .jpg, got: {}",
            parts[1]
        );
    }

    #[test]
    fn test_generate_filename_video() {
        let media = sample_media(MediaType::Video, Some("video/mp4"));
        let name = DownloadManager::generate_filename(&media);
        assert!(name.contains('/'), "Expected folder separator");
        assert!(name.ends_with(".mp4"), "Expected .mp4, got: {}", name);
    }

    #[test]
    fn test_generate_filename_fallback_video() {
        let media = sample_media(MediaType::Video, None);
        let name = DownloadManager::generate_filename(&media);
        assert!(name.contains('/'), "Expected folder separator");
        assert!(name.ends_with(".mp4"), "Expected .mp4, got: {}", name);
    }

    #[test]
    fn test_generate_filename_fallback_image() {
        let media = sample_media(MediaType::Image, None);
        let name = DownloadManager::generate_filename(&media);
        assert!(name.contains('/'), "Expected folder separator");
        assert!(name.ends_with(".jpg"), "Expected .jpg, got: {}", name);
    }

    #[test]
    fn test_create_job() {
        let media = sample_media(MediaType::Image, None);
        let job = DownloadManager::create_job(media, "job1");
        assert_eq!(job.job_id, "job1");
        assert_eq!(job.status, DownloadStatus::Pending);
        assert_eq!(job.progress, 0.0);
        assert!(job.error.is_none());
    }

    #[test]
    fn test_generate_filename_sanitizes_username() {
        let mut media = sample_media(MediaType::Image, Some("image/png"));
        media.username = "user@name!".to_string();
        let name = DownloadManager::generate_filename(&media);
        // Folder format: twitter_test_user/abc123.png
        let file_part = name.split('/').next_back().unwrap_or(&name);
        let folder_part = name.split('/').next().unwrap_or(&name);
        assert!(
            folder_part.contains("user_name"),
            "Folder should contain sanitized username, got: {}",
            folder_part
        );
        assert!(
            file_part.ends_with(".png"),
            "File should end with .png, got: {}",
            file_part
        );
    }
}
