# Chrome Web Store 提交记录

本页记录实际操作与最后核对结果，不代表商店实时状态。

## 最后核对：2026-11-13

| 项目 | 记录 |
| --- | --- |
| 扩展名称 | Profile Media Downloader |
| 扩展 ID | `jpdiaigjgblmajgkjnpliddppepgacai` |
| 提交版本 | `1.0.2` |
| 商店状态 | 待审核；控制台提示“已将您的扩展程序提交送审” |
| 发布方式 | 已勾选审核通过后自动发布 |
| 商店语言 / 类别 | 英语 / 工具 |
| 是否已上架 | 尚未确认；待审核不等于审核通过或已发布 |

[开发者控制台状态页](https://chrome.google.com/webstore/devconsole/39304e79-4106-494c-9c5a-23bbcc498b6e/jpdiaigjgblmajgkjnpliddppepgacai/edit/status)（需使用有权限的账号登录）。

## 版本经过

| 版本 | 操作与结果 |
| --- | --- |
| `1.0.0` | 重新上传前，控制台中已有该版本，状态为已拒绝；本次未核实其历史拒绝原因。 |
| `1.0.1` | 从当前源码重建 WASM、清理打包并上传；随后送审，首次提交关闭了自动发布。2026-11-13 查询时已被拒绝，原因为产品说明中有过多关键词。 |
| `1.0.2` | 修改 Manifest 摘要和商店详细说明，重新上传并提交审核；本次明确开启自动发布，提交后确认状态为待审核。 |

### 1.0.1 拒绝原因与 1.0.2 整改

- 违规类型：垃圾内容和商店中的排名。
- 违规参考 ID：`Yellow Argon`。
- 审核指出产品说明中过多罗列平台名称，要求移除过多关键词后重新提交。
- 1.0.2 删除摘要和详细说明中的平台名单，保留功能、操作步骤、登录限制和本地处理方式等说明。此修改没有取消平台支持或更改下载功能。
- 新摘要共 87 个字符：

> Preview and batch-download images and videos already loaded on supported profile pages.

- 英文详细说明采用 [listing-en.md](listing-en.md) 的 Detailed description 部分，共 1,363 个字符；已在控制台保存，并刷新核对保存结果。中文文案也同步修订，但本次未新增中文商店本地化。

## 构建与验证范围

1.0.1 重新构建时完成：

- Rust 测试：24 passed；格式与 Clippy 检查通过。
- 扩展回归测试：20 passed；所有扩展 JavaScript 通过语法检查。
- `wasm-pack build --release --target web --out-dir extension/wasm --locked` 成功。
- 将最终 ZIP 解压到干净 Chromium 配置，验证 Manifest V3 Service Worker、弹窗、WASM 加载与执行。
- 测试环境补齐 `document.title`，适配已有的个人主页标题读取逻辑；未修改相关业务实现。

1.0.2 仅修改版本号和文案，复用上述 WASM 构建产物；重新运行 20 项扩展回归测试，检查 Manifest 版本、摘要长度、ZIP 完整性和必需文件，并生成 SHA-256 校验文件。

这些检查不代表六个平台都已完成当日真实账号、页面扫描和下载验收。后续完整端到端测试仍按[开发计划](../development-plan.md)推进。

## 本次上传包

- 文件：`profile-downloader-1.0.2.zip`。
- 本机保存位置：`~/downloads/profile-downloader/`，同目录有 `.zip.sha256` 文件。
- ZIP 根目录直接包含 `manifest.json`，不含 Chrome 生成的 `_metadata/`。
- SHA-256：`0601b9fe5135c8aea9bfc647527abbbea2a9ac4b2b9cc5c019393849ddaab51c`。
- 文案与版本修改已推送 `main`：`060e3a8`；此前 1.0.1 准备提交为 `94b9c5c`。
- 本次未创建 `v1.0.2` Git 标签或 GitHub Release。若重新构建，ZIP 的文件时间等可能变化，应重新生成校验值，不沿用上面的摘要。

## 后续操作

- 从控制台查看审核结果；目前开启自动发布，通过审核后会自动发布。
- 若再次被拒，记录具体版本、日期和审核原文，按明确问题修改后再提交。
- 提交前核对自动发布复选框，保持用户已明确要求的自动发布设置。
- 不把隐私政策、成熟内容、地区等尚未核实的后台设置标为已确认；核对范围见[提交清单](submission-checklist.md)。
