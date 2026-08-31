# 技术设计

本文描述 Profile Media Downloader 当前实现的架构、数据流和约束。项目采用 Chrome Extension Manifest V3；Rust 核心编译为 WebAssembly，浏览器 API 与 DOM 操作由 JavaScript 完成。

## 1. 设计目标

- 只处理当前浏览器会话有权访问、且页面已经加载的媒体。
- 将平台识别、媒体建模、去重和排序保留在可测试的 Rust 核心中。
- 将 DOM、网络观察和 Chrome API 留在 JavaScript 层。
- WASM 不可用时继续提供基本功能，而不是阻塞弹窗。
- 批量下载在 Service Worker 重启后仍可恢复队列状态。

## 2. 系统架构

```text
平台页面
  ├─ 主环境拦截器：观察页面请求和运行时数据
  └─ Content Script：读取 DOM、汇总候选媒体
             │ chrome.tabs.sendMessage
             ▼
Popup：识别平台、预览和选择媒体
  ├─ WASM：按 ID 去重、按时间排序
  └─ JavaScript：WASM 失败时执行同等回退处理
             │ chrome.runtime.sendMessage
             ▼
Background Service Worker
  ├─ 校验下载 URL
  ├─ 将队列保存到 chrome.storage.local
  ├─ 按并发上限调度任务
  └─ 调用 chrome.downloads API
```

### 组件职责

| 组件 | 主要职责 | 不负责 |
| --- | --- | --- |
| `popup.js` | 页面识别、媒体展示、选择操作、下载状态 | 直接读写页面 DOM |
| `content_script.js` | 汇总页面 DOM 和拦截器捕获的数据 | 写入本地文件 |
| `*_interceptor.js` | 在页面主环境观察平台运行时数据和媒体请求 | 下载调度 |
| `background.js` | 持久化队列、并发控制、调用下载 API | 解析平台页面 |
| Rust/WASM | 平台识别、数据模型、去重、排序、文件名逻辑 | Chrome API 和浏览器 DOM |

## 3. 扫描与下载流程

1. 用户在个人主页打开扩展弹窗。
2. Popup 根据活动标签页 URL 识别平台，并向 Content Script 发送 `extractMedia`。
3. Content Script 合并 DOM、页面状态和拦截器收集到的候选媒体。
4. Popup 将媒体交给 `process_media_batch`；若 WASM 未加载，则使用 JavaScript 回退逻辑。
5. 用户选择媒体后，Popup 生成文件名并提交一个下载批次。
6. Background 先持久化整个批次，再按 `maxConcurrent` 启动下载。
7. `chrome.downloads.onChanged` 更新成功或失败计数，并继续消费队列。

队列保存在 `chrome.storage.local` 的 `downloadQueueState` 中。Service Worker 再次启动时会对仍标记为活动状态的 Chrome 下载进行核对。

## 4. 核心数据模型

```rust
pub struct ProfileMedia {
    pub id: String,
    pub media_type: MediaType,
    pub url: String,
    pub thumbnail_url: Option<String>,
    pub post_url: String,
    pub platform: String,
    pub username: String,
    pub caption: Option<String>,
    pub timestamp: Option<i64>,
    pub file_size: Option<u64>,
    pub content_type: Option<String>,
}

pub enum MediaType {
    Image,
    Video,
    Carousel(Vec<String>),
}
```

`process_batch` 按 `id` 去重，并按 `timestamp` 从新到旧排序。这里的 ID 是平台、用户名和 URL 等信息生成的稳定标识，不是媒体内容的密码学哈希。

文件默认保存为：

```text
ProfileDownloader/{platform}_{username}/{media_id}.{ext}
```

Chrome 遇到同名文件时使用 `uniquify` 保留两个文件。

## 5. 平台提取策略

平台提取不是单一选择器，而是组合多个信号并回退。实际可用性取决于登录状态、地区、页面版本和媒体是否已加载。

| 平台 | 主要信号 | 典型回退 |
| --- | --- | --- |
| X / Twitter | 页面运行时资源、`video.twimg.com` 请求 | Tweet DOM 中的图片和视频元素 |
| TikTok | 页面状态和 TikTok CDN 请求 | 当前页面的视频元素与帖子链接 |
| Instagram | 页面状态、Instagram/Facebook CDN 请求 | 图片、视频与轮播 DOM |
| 微博 | 页面 JSON 与媒体请求 | 微博 DOM、Sina/Weibo CDN URL |
| OnlyFans | 当前会话返回的可访问媒体数据 | 页面中已渲染的图片和视频 |

直接媒体 URL 可能带签名并在一段时间后过期，因此扫描后应及时下载。扩展不会发起解锁、付费墙绕过或权限提升操作。

## 6. WASM 接口与回退

Rust 当前导出以下浏览器接口：

| 接口 | 作用 |
| --- | --- |
| `detect_platform(url)` | 根据 URL 主机名识别平台 |
| `extract_media_from_html(platform, html, page_url)` | 使用对应 Rust 解析器处理 HTML |
| `process_media_batch(json_input)` | 反序列化、按 ID 去重并按时间排序 |

Popup 动态加载 `extension/wasm/profile_downloader_core.js`。加载或处理失败时，JavaScript 会执行按 ID 去重和按时间排序的回退逻辑。这样开发环境缺少构建产物时仍可扫描和下载，但不会使用 Rust 处理路径。

## 7. 权限与安全边界

Manifest 当前使用的关键权限：

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 获取用户主动打开的当前标签页 |
| `downloads` | 保存媒体文件并跟踪下载状态 |
| `storage` | 保存设置和下载队列 |
| `scripting` | 在需要时向页面主环境注入提取逻辑 |
| `webRequest` | 观察媒体请求 |
| `declarativeNetRequestWithHostAccess` | 为特定媒体请求应用声明式规则 |

站点访问范围由 `host_permissions` 和 `content_scripts.matches` 明确列出。`file:///*` 用于调试本地保存的页面；Chrome 默认不会授予文件 URL 访问权限，需要用户在扩展详情页手动开启。

安全约束：

- 媒体数据在浏览器本地处理，本项目不提供数据上传服务。
- 下载前会拒绝无效 URL，以及已知的不完整 X 视频分片和非直链 TikTok 页面端点。
- 文件夹与文件名会过滤 Windows 不允许的字符。
- 页面结构和带签名 URL 都是不可信输入，解析失败必须可恢复。

## 8. 构建与验证

```bash
# 测试与静态检查
cargo fmt -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings

# 生成扩展使用的 WASM 文件
wasm-pack build --release --target web --out-dir extension/wasm --locked

# JavaScript 语法检查
node --check extension/background.js
node --check extension/content_script.js
node --check extension/popup.js
```

CI 在推送到 `main` 和 Pull Request 上运行 Rust 与 JavaScript 检查。符合 `v*.*.*` 的标签会触发发布工作流；标签版本必须与 `extension/manifest.json` 一致。

## 9. 已知约束

- 扫描范围通常限于页面已经加载的内容；扩展不会自动遍历整个账号历史。
- 平台 DOM 和内部接口变化会导致选择器或请求识别失效。
- 部分视频采用分段流或短期签名 URL，未必能得到可直接下载的完整文件。
- 私密、地区限制、年龄限制或付费内容仍受平台自身权限控制。
- 浏览器可能对短时间内大量下载弹出确认或实施限制。
