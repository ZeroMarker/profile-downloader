# 技术设计文档

> Profile Media Downloader — 技术架构与设计细节

---

## 1. 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    Chrome 浏览器                          │
│                                                         │
│  ┌──────────────┐     ┌──────────────────────────────┐  │
│  │ Popup (弹窗)  │◄───►│   Background Service Worker  │  │
│  │ popup.html   │     │   background.js              │  │
│  │ popup.js     │     │   - 下载管理                  │  │
│  └──────┬───────┘     │   - 存储管理                  │  │
│         │             └──────────┬───────────────────┘  │
│         │ chrome.runtime         │ chrome.downloads     │
│         ▼                        ▼                       │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Content Script (内容脚本)                  │   │
│  │          content_script.js                       │   │
│  │   - 注入页面环境                                   │   │
│  │   - 提取 DOM 和 JS 状态数据                         │   │
│  │   - 发送给 Popup                                   │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │          WASM 核心模块 (编译后)                     │   │
│  │          wasm/profile_downloader_core.*           │   │
│  │   - 平台检测                                       │   │
│  │   - HTML 解析提取媒体                               │   │
│  │   - 数据去重/排序                                  │   │
│  │   - 文件名生成                                     │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 组件通信流程

```
用户打开扩展弹窗
       │
       ▼
Popup 向 Content Script 发送 extractMedia 消息
       │
       ▼
Content Script 从页面提取媒体数据
  ├── 读取 DOM (图片、视频元素)
  ├── 读取 JS 全局状态 (__INITIAL_STATE__, SIGI_STATE 等)
  └── 返回结构化数据给 Popup
       │
       ▼
Popup 渲染媒体网格，等待用户操作
       │
       ▼
用户点击 Download → Popup 向 Background 发送下载请求
       │
       ▼
Background 使用 chrome.downloads API 下载文件
```

---

## 2. 数据模型

### ProfileMedia (核心数据结构)

```rust
pub struct ProfileMedia {
    pub id: String,              // 去重唯一标识
    pub media_type: MediaType,    // Image / Video / Carousel
    pub url: String,             // 媒体文件直接链接
    pub thumbnail_url: Option<String>,
    pub post_url: String,        // 原始帖子链接
    pub platform: String,        // "twitter" / "tiktok" / "instagram"
    pub username: String,
    pub caption: Option<String>,
    pub timestamp: Option<i64>,  // Unix 时间戳 (ms)
    pub file_size: Option<u64>,
    pub content_type: Option<String>,
}
```

### MediaType 枚举

```rust
pub enum MediaType {
    Image,                    // 单张图片
    Video,                    // 单个视频
    Carousel(Vec<String>),    // 多图轮播 (Instagram)
}
```

---

## 3. 各平台解析策略

### X/Twitter

| 数据源 | 优先级 | 方法 |
|--------|--------|------|
| `__NEXT_DATA__` 内联 JSON | 高 | 解析 React store 中的 tweet 实体 |
| `data-app-state` 脚本 | 中 | 提取 Twitter App 状态中的媒体 |
| DOM 元素 | 低 | 从 `article[data-testid="tweet"]` 中提取 `img[src*="twimg.com"]` |

媒体 URL 格式：
- 图片：`https://pbs.twimg.com/media/xxx.jpg`
- 视频：`https://video.twimg.com/xxx.mp4`

### TikTok

| 数据源 | 优先级 | 方法 |
|--------|--------|------|
| `SIGI_STATE` 全局变量 | 高 | 提取 `ItemModule` 中每个 video 的 `playAddr` |
| JSON-LD `<script>` | 中 | 结构化数据中的 video 列表 |
| 视频链接匹配 | 低 | 从 `<a href=".../video/...">` 提取 video ID |

媒体 URL 格式：
- 视频：`https://[sub].tiktokcdn.com/xxx.mp4`

### Instagram

| 数据源 | 优先级 | 方法 |
|--------|--------|------|
| `__INITIAL_STATE__` | 高 | 提取 profile items 中的 `image_versions2` |
| JSON-LD `<script>` | 中 | 结构化数据中的 image/video 列表 |
| CDN 图片匹配 | 低 | 从 `<img src*="cdninstagram.com">` 提取 |

媒体 URL 格式：
- 图片：`https://[sub].cdninstagram.com/xxx.jpg`
- Carousel：多条图片 URL

---

## 4. 下载管理

### 下载流程

1. Popup 收集用户选中的媒体列表
2. 遍历列表，通过 `chrome.runtime.sendMessage` 发送到 Background
3. Background 调用 `chrome.downloads.download()` API
4. 文件保存到 `ProfileDownloader/{platform}_{username}_{id}.{ext}`
5. Popup 实时更新进度条

### 文件名生成规则

```
{platform}_{username}_{media_id}.{ext}
```

示例：`twitter_elonmusk_abc123def.jpg`

### 错误处理

- 下载失败：跳过当前项，继续下一项，最终显示汇总
- 网络错误：自动重试 1 次
- 无效 URL：标记为失败并跳过

---

## 5. WASM 集成策略

### 为什么用 Rust WASM？

| 优势 | 说明 |
|------|------|
| **性能** | Rust 编译为 WASM，解析大量 HTML/JSON 时比纯 JS 快 2-5x |
| **安全性** | 类型安全、无 GC、内存安全 |
| **代码共享** | 核心逻辑可移植到 Node 后端或移动端 |
| **体积** | LTO + 优化后 WASM 二进制 < 200KB |

### WASM 职责边界

```
WASM 负责：
├── 平台 URL 检测
├── HTML/JSON 解析（接收原始字符串，返回结构化数据）
├── 媒体数据去重、排序、验证
└── 文件名生成

WASM 不负责：
├── DOM 操作（由 Content Script 处理）
├── 浏览器 API 调用（由 Background/Popup 处理）
└── UI 渲染
```

---

## 6. 安全与隐私

- **零数据上传**：所有媒体数据仅在用户本地处理
- **最小权限**：只请求 `activeTab` + `downloads` + `storage` + 必要站点权限
- **CSP 策略**：`script-src 'self' 'wasm-unsafe-eval'` 确保 WASM 安全加载
- **无第三方依赖**：纯本地运行，不加载外部 CDN 脚本
