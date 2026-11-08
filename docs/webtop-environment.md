# Webtop 开发环境

本文记录在 linuxserver webtop 容器中调试本扩展的环境、浏览器选型和部署步骤。信息核实日期：2026-11-08。

## 1. 环境概况

| 项目 | 值 |
| --- | --- |
| 宿主机架构 | ARM64（`aarch64`），容器内相同 |
| 镜像 | `lscr.io/linuxserver/webtop:ubuntu-xfce` |
| 容器系统 | Ubuntu 26.04.1 LTS |
| 浏览器 | Chromium 156.0.8078.47（xtradeb 软件源） |
| 资源限制 | 2 CPU、8 GB 内存、1 GB 共享内存 |
| 扩展目录 | 宿主机 `~/webtop/config/extensions/profile-downloader`，容器内 `/config/extensions/profile-downloader` |
| 下载目录 | 宿主机 `~/webtop/config/Downloads`，容器内 `/config/Downloads` |
| 调试端口 | 宿主机 `127.0.0.1:9222`，转发到容器内 Chromium 的 `127.0.0.1:9229` |

## 2. 为什么用 Chromium 而不是 Chrome

**不是因为 ARM64 装不了 Chrome。** Google 已提供官方 Linux ARM64 版 Chrome（见第 3 节），选用 Chromium 的实际原因是：

1. **镜像预装**：webtop 镜像自带 Chromium。Ubuntu 官方的 chromium 是 snap 包，snap 在 Docker 中无法运行，所以镜像改用 xtradeb 软件源的普通安装包。
2. **现有启动脚本按 Chromium 编写**：
   - `custom-cont-init.d/50-chromium-cdp`：通过 `/etc/chromium.d/` 开启调试端口，供 agent 使用。
   - `custom-cont-init.d/51-chromium-policy`：把禁用浏览器登录的策略写在 `/etc/chromium/policies/managed/`。Chrome 读取的是 `/etc/opt/chrome/policies/`。
   - `custom-cont-init.d/53-geo-chromium`：按国家走不同代理的多实例启动脚本，基于 `wrapped-chromium`。
3. **便于扩展开发**：Chrome 正式版从 137 起移除了 `--load-extension` 命令行参数，Chromium 仍然保留，便于以后用脚本自动加载和测试扩展。

**对本扩展无影响**：扩展使用的 `downloads`、`storage`、`scripting`、`declarativeNetRequest` 等接口在两者中完全相同。

**已知差异**：Chromium 发行版有时不带 H.264 等专有解码器，平台网页里的视频可能无法播放。这只影响在网页中预览，不影响下载，因为扩展原样保存文件、不解码。当前 xtradeb 版本是否带解码器尚未确认。

## 3. Chrome 的 Linux ARM64 支持现状

- 2026 年 3 月，Google 宣布将在 2026 年第二季度推出 ARM64 Linux 版 Chrome。
- 实际推迟到约 2026 年 8 月初，在官方下载页悄悄上线，没有单独发布公告。这个日期目前只有 Linuxiac 一个来源。
- Google 官方 apt 软件源（`https://dl.google.com/linux/chrome/deb/dists/stable/Release`，2026-11-07 生成）列出的架构是 `amd64 arm64`。ARM64 下有：
  - `google-chrome-stable` 157.0.8103.38
  - `google-chrome-beta` 158.0.8127.18
  - `google-chrome-canary` 159.0.8149.0
- 注意：ARM64 没有 `google-chrome-stable_current_arm64.deb` 这个固定下载地址（返回 404），需要通过软件源安装，或者使用带版本号的文件名。

如果将来改用 Chrome，需要：

- 把安装步骤写进 `custom-cont-init.d`，否则容器重建后会丢失。
- 把调试端口、策略、多实例脚本改为 Chrome 的路径。
- 在 `chrome://extensions` 中手动加载已解压的扩展，Chrome 正式版不支持 `--load-extension`。

参考：

- [Bringing Chrome to ARM64 Linux Devices — Google Blog](https://blog.google/chromium/bringing-chrome-to-arm64-linux-devices/)
- [Google Chrome Quietly Arrives on ARM64 Linux — Linuxiac](https://linuxiac.com/google-chrome-quietly-arrives-on-arm64-linux/)
- [Google Chrome for ARM64 Linux devices coming Q2 2026 — 9to5Google](https://9to5google.com/2026/03/12/chrome-arm64-linux/)

## 4. 编译并部署扩展

在仓库根目录执行：

```bash
wasm-pack build --release --target web --out-dir extension/wasm --locked
rsync -a --delete --exclude _metadata --exclude .gitignore \
  extension/ ~/webtop/config/extensions/profile-downloader/
```

- `_metadata` 是 Chromium 为请求头规则生成的索引，保留即可，Chromium 会按需重建。
- 扩展是以“加载已解压的扩展”方式安装的：
  - Chromium 未运行时，下次启动会自动读取新代码。
  - Chromium 已运行时，在 `chrome://extensions` 中点击 Profile Media Downloader 的刷新按钮，然后刷新目标网页。
- 判断 Chromium 是否在运行：`curl -s http://127.0.0.1:9222/json/version` 没有返回内容，说明没在运行。
