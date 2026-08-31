# Profile Media Downloader

一个由 Rust + WebAssembly 驱动的 Chrome 扩展，用于预览并批量下载个人主页中**当前账号可访问、且已加载到页面中的**图片和视频。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/ZeroMarker/profile-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/ZeroMarker/profile-downloader/actions/workflows/ci.yml)

## 支持的平台

| 平台 | 主页示例 | 说明 |
| --- | --- | --- |
| X / Twitter | `x.com/username` | 支持页面图片和可识别的视频源 |
| TikTok | `tiktok.com/@username` | 支持当前页面已加载的视频 |
| Instagram | `instagram.com/username` | 支持图片、视频和轮播内容 |
| 微博 | `weibo.com/u/用户ID` | 支持当前页面已加载的图片和视频 |
| OnlyFans | `onlyfans.com/username` | 需要登录；只处理当前账号有权访问的内容 |

平台页面和媒体接口会持续变化。如果扫描结果不完整，请先向下滚动以加载更多内容，再重新打开扩展。

## 功能

- 自动识别当前平台并扫描媒体
- 网格预览、单选、全选和批量下载
- 按媒体 ID 去重，并按时间倒序排列
- 持久化下载队列；默认最多同时下载 3 个文件
- WASM 加载失败时自动使用 JavaScript 回退逻辑
- 全程在浏览器本地处理，不向本项目的服务器上传数据

## 安装

### 使用发布包

1. 从 GitHub Releases 下载 ZIP 并解压。
2. 打开 `chrome://extensions/`。
3. 开启右上角的「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择解压后的目录。

> Chrome 应用商店版本尚未发布。

### 从源码构建

需要安装 [Rust](https://www.rust-lang.org/tools/install)、`wasm-pack` 和 Chrome：

```bash
cargo install wasm-pack --version 0.15.0 --locked
wasm-pack build --release --target web --out-dir extension/wasm --locked
```

构建完成后，在 `chrome://extensions/` 中加载仓库里的 `extension/` 目录。

## 使用方法

1. 登录目标平台，并进入用户个人主页。
2. 向下滚动，让需要下载的内容加载到页面中。
3. 点击浏览器工具栏中的扩展图标。
4. 在预览网格中选择媒体，或直接下载全部媒体。
5. 文件会保存到 Chrome 默认下载目录下的 `ProfileDownloader/` 文件夹。

OnlyFans 支持不会解锁内容、绕过付费墙，或获取当前账号无权访问的媒体。使用本扩展时，请遵守平台条款、创作者权利和所在地法律。

## 开发

```bash
# 运行 Rust 测试
cargo test --locked

# 检查格式和常见问题
cargo fmt -- --check
cargo clippy --locked --all-targets -- -D warnings

# 检查扩展脚本语法
node --check extension/background.js
node --check extension/content_script.js
node --check extension/popup.js
```

核心目录：

```text
profile-downloader/
├── src/                         # Rust/WASM 核心
│   ├── lib.rs                   # WASM 导出接口
│   ├── models.rs                # 平台、媒体和下载数据模型
│   ├── downloader.rs            # 文件名与下载任务模型
│   └── platforms/               # 五个平台的解析器
├── extension/                   # Chrome Manifest V3 扩展
│   ├── background.js            # 下载队列与 Service Worker
│   ├── content_script.js        # 页面媒体提取
│   ├── *_interceptor.js         # 页面主环境中的媒体请求捕获
│   ├── popup.html / popup.js    # 扩展弹窗
│   └── wasm/                    # wasm-pack 构建输出
├── docs/
│   ├── technical-design.md      # 架构、数据流与安全边界
│   └── development-plan.md      # 当前状态与后续计划
└── .github/workflows/           # CI 与发布流程
```

更详细的实现说明见[技术设计文档](docs/technical-design.md)，项目状态见[开发计划](docs/development-plan.md)。

## 发布

发布标签必须与 `extension/manifest.json` 中的版本一致：

```bash
git tag v1.0.0
git push origin v1.0.0
```

Release 工作流会执行质量检查、构建 WASM、打包扩展，并上传 ZIP 与 SHA-256 校验文件。

## 贡献

欢迎提交 Issue 和 Pull Request。修复平台解析问题时，建议同时提供：

- 出现问题的平台和页面类型
- 可复现步骤及浏览器版本
- 已脱敏的控制台日志或页面结构样本

请勿在 Issue 中提交 Cookie、访问令牌、付费内容或其他敏感数据。

## 许可证

[MIT License](LICENSE) © 2026 Mark Chen
