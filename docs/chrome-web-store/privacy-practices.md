# Chrome Web Store 隐私表填写建议

以下内容必须与实际代码、商店描述和隐私政策保持一致。若提交前代码行为改变，应重新核对。

## 单一用途

扫描用户当前打开的受支持个人主页，预览其中当前账号可访问且已加载的图片与视频，并按用户选择将媒体下载到本地。

## 处理的数据类型

建议申报：

- **网站内容**：读取当前受支持页面中的个人主页信息、媒体元素、媒体 URL 和相关响应数据，以生成预览和下载任务。
- **网页浏览活动**：检测当前标签页的 URL 和受支持平台，仅用于确认扩展是否可在该页面工作。
- **用户生成的内容**：页面上可能包含用户或创作者发布的图片、视频、用户名和展示名称；仅在本地解析并显示。

当前实现不应申报为收集：

- 身份验证信息：扩展不读取、保存或传输密码、Cookie 或访问令牌。页面请求可能由网站自身携带当前登录会话，但扩展不提取凭据。
- 个人通信、财务信息、健康信息、精确位置、表单数据。

注意：“仅本地处理”仍属于 Chrome Web Store 政策中的数据处理，不能选择“本产品不处理用户数据”。

## 数据用途

只勾选与核心功能直接相关的用途：

- 提供扩展的单一用途功能
- 如后台表单存在“应用功能”或同义选项，选择该项

不要勾选广告、个性化、信用评估、数据销售或与功能无关的分析用途。

## 数据共享与销售

- 不向开发者服务器传输网页内容、媒体、浏览记录或下载记录。
- 不销售用户数据。
- 不将用户数据用于广告或个性化推荐。
- 不允许开发者或其他人员读取用户数据。

媒体下载请求会直接发往用户正在使用的平台或其 CDN；这是完成用户发起下载所必需的同源/服务提供方通信，不是向开发者传输数据。

## Limited Use 声明

勾选所有真实适用的 Limited Use 认证。可在说明栏使用：

> The use of information received from supported websites will comply with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide the extension's disclosed media preview and download functionality, is not sold or used for advertising, and is not transferred to a developer-operated server.

