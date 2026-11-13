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

Applies packaged static rules to supported media hosts so user-selected media requests carry the referer expected by those hosts. The current rule files cover Weibo and Douyin media downloads.

## Host permissions

Access is limited to the supported profile services and their media CDNs. It is required to detect supported pages, read media already available to the current account, show previews, and perform user-requested downloads. The extension does not run on unrelated websites.

## `file:///*`

Allows optional scanning of a profile page that the user has explicitly saved and opened as a local HTML file. Chrome requires the user to separately enable “Allow access to file URLs.”

## 已移除的 `webRequest`

1.0.2 的 Manifest 未声明 `webRequest`，代码也不调用该 API。不要将旧版本文档中的此项复制到当前权限说明。当前权限以 `extension/manifest.json` 为准。

