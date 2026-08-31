# 审核员测试说明

## Suggested English text

The extension has one purpose: previewing and downloading media already loaded and accessible on supported profile pages.

Basic test flow (no special credentials required):

1. Open a public profile page on X/Twitter, TikTok, Instagram, or Weibo.
2. Scroll until several image or video posts are visible.
3. Click the extension icon.
4. Confirm that the popup identifies the platform and displays loaded media.
5. Select one item and click “Download Selected,” or click “Download All.”
6. Confirm that Chrome saves the file under `ProfileDownloader/` in the default downloads directory.

OnlyFans support requires a valid account and only exposes content already available to that account. The extension does not bypass authentication or a paywall. A reviewer account is not required to validate the extension's main functionality because public profiles on the other supported services exercise the same scan, preview, selection, and download flow.

The extension processes page data locally. It has no developer-operated backend, analytics, advertising, or remote code. Website layouts may change; if no items appear, scroll to load media and reopen the popup.

## 提交建议

- 后台“测试说明”虽非必填，但本扩展权限较多，建议填写。
- 不要提供个人账号、Cookie、令牌或付费内容作为测试材料。
- 若审核员无法稳定访问某平台，准备一个公开、无敏感内容的测试主页 URL。

