# 权限与主机访问说明

可将下列英文内容粘贴到 Chrome Web Store 后台的权限说明字段。

## `activeTab`

Used only after the user opens the extension to identify the active tab and request a fresh scan of the supported profile page currently being viewed.

## `downloads`

Required to save the images and videos explicitly selected by the user and to monitor download completion or failure.

## `storage`

Stores the download queue and local preferences in Chrome local storage so interrupted downloads can be tracked. The stored data is not sent to the developer.

## `scripting`

Injects a small, packaged script into the current supported page's MAIN world when needed to read media metadata that is available to the page but not exposed to isolated content scripts. No remote code is loaded.

## `declarativeNetRequestWithHostAccess`

Applies a packaged static rule for Weibo media requests so user-selected media can be downloaded successfully with the referer expected by the media host.

## Host permissions

Access is limited to the supported profile services and their media CDNs. It is required to detect supported pages, read media already available to the current account, show previews, and perform user-requested downloads. The extension does not run on unrelated websites.

## `file:///*`

Allows optional scanning of a profile page that the user has explicitly saved and opened as a local HTML file. Chrome requires the user to separately enable “Allow access to file URLs.”

## `webRequest`

The current JavaScript does not call the `chrome.webRequest` API. Remove this permission before submission unless a verified runtime path requires it; Chrome Web Store policy requires the narrowest permission set.

