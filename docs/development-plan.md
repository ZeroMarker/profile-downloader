# 开发计划

> Profile Media Downloader — 路线图与里程碑

---

## 总览

| 阶段 | 目标 | 预计工期 |
|------|------|----------|
| **P0** | MVP — WASM 核心 + Chrome 扩展骨架 | ✅ **已完成** |
| **P1** | 三平台完整支持 | 🔄 代码完成，待实机验证 |
| **P2** | 体验优化与发布 | ⬜ 待开始 |
| **P3** | 高级功能 | ⬜ 待开始 |

---

## P0 — MVP (已达成)

### 目标：X/Twitter 个人主页媒体下载可用 ✅

| 任务 | 状态 | 说明 |
|------|------|------|
| Rust WASM 项目脚手架 | ✅ 完成 | Cargo.toml + 核心模块结构；cargo test 14/14 通过 |
| Chrome Extension 骨架 | ✅ 完成 | Manifest V3 + 弹窗 + 内容脚本 + 图标 |
| Twitter 页面解析 | ✅ 完成 | DOM 提取 (tweet articles images/videos) + 多层策略回退 |
| WASM 编译集成 | ✅ 完成 | wasm-pack release 构建 ~1.5MB；ES module import 集成 |
| 基础 UI 弹窗 | ✅ 完成 | 暗色主题媒体网格 + 选择/全选 + 进度条 |
| 下载功能 | ✅ 完成 | chrome.downloads API + 重试 + 文件名安全处理 |
| 调试与测试 | ✅ 完成 | cargo test 14/14 通过；WASM 构建验证通过 |

**交付物** ✅ 可直接在 Chrome 中加载 `extension/` 目录使用

---

## P1 — 三平台完整支持 (大部分已完成)

### 目标：三个平台稳定可用

| 任务 | 状态 | 说明 |
|------|------|------|
| TikTok 页面解析 | ✅ 完成 | SIGI_STATE 提取 + video 解析 + DOM 回退 |
| Instagram 页面解析 | ✅ 完成 | __INITIAL_STATE__ + carousel 处理 + DOM 回退 |
| 平台路由优化 | ✅ 完成 | URL 检测 + WASM detect_platform + JS fallback |
| 媒体去重模块 | ✅ 完成 | Rust 核心 process_batch 去重+排序 + JS fallback |
| 批量下载管理 | ✅ 完成 | chrome.downloads API + 重试 + 进度展示 |
| 进度展示 | ✅ 完成 | 实时进度条 + 完成/失败汇总 |
| 回退解析器 | ✅ 完成 | 当 JS 状态不可用时的 DOM 回退 |
| **真实平台端到端测试** | ⬜ 待做 | 在各平台实际页面载入验证 |

**里程碑**：三个平台都能下载图片和视频 ✅（代码层面），待实际页面验证

---

## P2 — 体验优化与发布 (2 周)

### 目标：商店 ready

| 任务 | 状态 | 说明 |
|------|------|------|
| Video 下载优化 | ⬜ 待做 | 高质量视频源检测 |
| 设置页面 | ⬜ 待做 | 下载路径、并发数、默认行为 |
| 键盘快捷键 | ⬜ 待做 | Ctrl+Shift+P 快速打开 |
| 国际化 (i18n) | ⬜ 待做 | 中/英文界面 |
| 图标与品牌 | ⬜ 待做 | 多尺寸图标 + 应用商店素材 |
| 隐私权限说明 | ⬜ 待做 | 合规文档 |
| Chrome 商店提交 | ⬜ 待做 | 审核与上架 |

**里程碑**：Chrome 应用商店上架

---

## P3 — 高级功能 (持续迭代)

### 目标：差异化体验

| 任务 | 说明 | 优先级 |
|------|------|--------|
| 滚动加载更多媒体 | 自动检测页面滚动，抓取更多内容 | 高 |
| 视频快速预览 | 鼠标悬停播放短视频预览 | 中 |
| 压缩包批量下载 | 选中媒体打包为 ZIP 下载 | 中 |
| 按日期/类型筛选 | 媒体筛选过滤器 | 中 |
| 外部存储导出 | 导出到 Google Drive / OneDrive | 低 |
| Firefox + Edge 移植 | 使用 WebExtensions API 适配 | 低 |
| 深色/浅色主题 | 跟随系统主题 | 低 |

---

## 技术债务与风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 各平台 DOM 结构变更 | 解析器失效 | 多层回退策略 + 快速修复通道 |
| WASM 体积过大 | 扩展加载慢 | LTO 优化、特性裁剪、gzip 压缩 |
| Chrome 下载 API 限制 | 批量下载有限制 | 队列控制 + 下载间隔 |
| 平台反爬措施 | 媒体 URL 过期 | CDN URL 直接引用 + 及时下载 |
| Manifest V3 限制 | Service Worker 生命周期 | 保持唤醒策略 + IndexedDB 持久化 |

---

## 构建与发布流程

```bash
# 开发构建 (调试)
wasm-pack build --dev --target web --out-dir wasm
cp wasm/profile_downloader_core.js wasm/profile_downloader_core_bg.wasm extension/wasm/

# 生产构建 (优化体积)
wasm-pack build --release --target web --out-dir wasm
cp wasm/profile_downloader_core.js wasm/profile_downloader_core_bg.wasm extension/wasm/

# 打包扩展
cd extension && zip -r ../profile-downloader.zip . -x "*.git*" "wasm/*"
```

---

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0.0 | — | P0 MVP 完成：Rust WASM 核心 + Chrome 扩展 (X/TikTok/Instagram) |
