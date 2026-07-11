# Profile Media Downloader

> 一款基于 **Rust WASM** 驱动的 Chrome 扩展，一键下载 **X/Twitter、TikTok、Instagram** 个人主页的图片和视频。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/ZeroMarker/profile-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/ZeroMarker/profile-downloader/actions/workflows/ci.yml)

---

## ✨ 特性

| 特性 | 说明 |
|------|------|
| 🚀 **Rust WASM 核心** | 高性能数据解析与处理，编译为 WebAssembly 运行 |
| 🎯 **三平台支持** | X/Twitter · TikTok · Instagram 一键切换 |
| 🔍 **智能检测** | 自动识别当前页面平台，提取个人主页媒体 |
| 🖼️ **媒体预览** | 可视化网格预览，支持多选/单选 |
| 📦 **批量下载** | 一键全部下载或仅下载选中项 |
| 🧹 **智能去重** | 基于内容哈希去重，避免重复下载 |
| ⚙️ **可配置** | 下载路径、并发数、自动选择等设置 |
| 🛡️ **隐私安全** | 纯客户端运行，不上传任何数据到服务器 |

---

## 📦 安装

### 从源码构建

```bash
# 1. 安装 wasm-pack
cargo install wasm-pack

# 2. 构建 WASM 核心库
wasm-pack build --release --target web --out-dir extension/wasm

# 3. 加载扩展
# Chrome → chrome://extensions → 开启"开发者模式" → "加载已解压的扩展" → 选择 extension/ 目录
```

### 从 Chrome 应用商店

> 即将上架

---

## 🚀 使用指南

1. 访问支持的平台个人主页：
   - `twitter.com/用户名` 或 `x.com/用户名`
   - `tiktok.com/@用户名`
   - `instagram.com/用户名`
2. 点击扩展图标 🧩 打开侧边弹窗
3. 扩展自动扫描页面中所有媒体内容
4. 选择你要下载的媒体项（或全选）
5. 点击「Download」按钮即可批量保存

---

## 🏗️ 项目结构

```
profile-downloader/
├── Cargo.toml                   # Rust 项目配置
├── src/                         # Rust WASM 核心库
│   ├── lib.rs                   # 库入口，WASM 导出
│   ├── models.rs                # 数据模型
│   ├── utils.rs                 # 工具函数
│   ├── downloader.rs            # 下载管理器
│   └── platforms/               # 各平台解析器
│       ├── mod.rs               # 平台路由
│       ├── twitter.rs           # X/Twitter 解析器
│       ├── tiktok.rs            # TikTok 解析器
│       └── instagram.rs         # Instagram 解析器
├── extension/                   # Chrome 扩展
│   ├── manifest.json            # 扩展清单 V3
│   ├── popup.html               # 弹窗 UI
│   ├── popup.js                 # 弹窗逻辑
│   ├── styles.css               # 样式
│   ├── background.js            # 后台 Service Worker
│   ├── content_script.js        # 内容注入脚本
│   └── icons/                   # 扩展图标
├── wasm/                        # WASM 构建输出
├── docs/                        # 文档
│   ├── technical-design.md      # 技术设计文档
│   └── development-plan.md      # 开发计划
└── README.md                    # 本文件
```

---

## 🧰 技术栈

| 层级 | 技术 |
|------|------|
| **核心引擎** | Rust → WASM (wasm-pack + wasm-bindgen) |
| **扩展框架** | Chrome Extension Manifest V3 |
| **前端 UI** | 原生 HTML/CSS/JS (无框架依赖) |
| **序列化** | serde / serde_json |
| **构建工具** | cargo + wasm-pack |
| **解析** | regex (Rust) + DOM API (浏览器端) |

---

## 🤝 参与贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing`)
3. 提交改动 (`git commit -am 'feat: add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing`)
5. 创建 Pull Request

### 发布版本

发布标签必须与 `extension/manifest.json` 中的版本一致：

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions 会构建 WASM、打包扩展，并在对应 Release 中上传 ZIP 和 SHA-256 校验文件。

---

## 📄 许可证

[MIT License](LICENSE) © 2026 Mark Chen
