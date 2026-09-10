# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的组织方式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [v0.2.2] — 2026-09-10

**适配 DeepSeek 4.1 多模态：微信里的图片，模型自己看。**

### 新增

- **原生图片输入**（`src/node/vision.ts`）。入站图片在路由模型声明了图片输入时，
  以真正的 `image` 内容块投给模型；否则回落 DeepSeek-OCR 文本 + 文件路径。
- **`/识图 [auto|native|ocr]` 命令**，运行时切换图片投递模式；不带参数则报告
  当前模式与生效路由。运行时覆盖在重启后回到配置值。
- **`imageInputModel` 配置**，可为图片单独钉一条视觉路由（文字走便宜的、
  图片走视觉模型）。
- **`send_email` 工具**（`src/node/email.ts`）：隐式 TLS 的纯文本 SMTP 客户端，
  配套 `smtpHost` / `smtpPort` / `smtpUsername` / `smtpPassword` / `smtpFromName`。
- **`test/vision.test.ts`（10 项）与 `test/email.test.ts`（4 项）**，测试数 82 → 86。

### 变更

- `handleInboundImage` 由「无条件 OCR」改为「先判模态再分支」；原生路径经
  `attachments.saveImage()` 构造图片块，构造失败自动降级 OCR。
- 两种模式下都保留 `[微信图片] <路径>` 前缀：会话日志可重放，模型之后仍能重读文件。
- 纯图片消息（无附带文字）会补一句引导语，否则视觉模型看到图却没有指令。
- SMTP 客户端暴露可注入的连接点，因此命令顺序（`EHLO → AUTH LOGIN → MAIL →
  RCPT → DATA → QUIT`）由单测覆盖，而不是假设正确。

### 修复

- **凭据泄露面**：`client-config.json` 与 `account.json` 是运行时写到仓库根、
  内含微信 token 明文的文件，现已加入 `.gitignore`。这两个文件历史上从未被提交过。
- 仓库改名后的 URL 同步：`PRTS168/dsh-chatnode-wechat` →
  `PRTS168/dsh-wechat-suite`（`package.json` 的 repository/homepage/bugs 与中英 README）。

### 说明

- **「声明」才是开关**：harness 在请求上游按模型声明的 `inputModalities` 闸门拦图片。
  DeepSeek 适配器内置目录早于 4.1 多模态（把 `deepseek-v4-flash` 记为纯文本、
  唯一声明 `image` 的 `deepseek-v4-flash-vision-exp` 已下线），因此需要在
  `settings.yaml` 的 `llm-deepseek.models` 里显式声明 `inputModalities: [text, image]`。
  该列表**整体替换**内置目录，需列全你实际路由到的 id。
- **观测到的拒绝会被记住**：某路由真的拒过一次图片后抑制 3 小时，后续图片直接走
  OCR。「声明」只是对端点的声称，不是检验。

## [v0.2.1] — 2026-09

### 新增

- **Web 管理页**：**设置 → 插件 →「微信桥配置」**，管理白名单、模型路由、
  硅基流动媒体 Key、克隆音色、路径、限流等全部待填项；密钥脱敏展示，保存进
  `cordis.patch.yml` 并自动备份（保留注释与其他插件行）。
- **人设编辑**：同一页面选 preset、编辑 `config.text` 并保存，只重写人设段；
  「复制为新 preset」整目录复制，便于构建第二个人设。
- 主机 API：`/dsh-chatnode-wechat/api` 下的 `/schema`、`/config`、`/save`、
  `/presets`、`/persona`、`/preset/copy`；每个请求需带
  `X-DSH-Chatnode-Wechat: 1` 头。第二行 bundle 只在存在 `webServer` 服务的
  profile 里挂载，headless profile 不受影响。

## [v0.2.0] — 2026-09

### 新增

- **`/perm`** 两步权限预设切换接线完成（此前机制就绪但命令未接线）。
- **`pnpm setup`** 一键配置向导：只改写 profile 中 `dsh-chatnode-wechat` 那一段，
  并先备份文件。
- **双向文件与视频**：入站 file/video 解密落盘 `mediaDir`（保留原文件名），
  以 `[微信文件]` / `[微信视频]` 路径标记交给 agent；新增 `wechat_send_file` /
  `wechat_send_video` 把本地文件与视频发回（视频以可播放 mp4 附件送达）。
- **入站消息时间戳**：`[发送于 YYYY-MM-DD HH:mm]`，在文字 / OCR / 语音转写三条
  路径上统一生效。

### 变更

- 移除仓库内的人设残留（早安文案、默认地点、音色示例、测试文案中性化）。
- README 声明本仓库为上游的非官方分支，保留上游历史与署名。
- 依赖对齐 DSH `0.1.1-rc.2`。

## [v0.1.0] — 2026-08

首个可用版本：iLink 网关（扫码登录、鉴权长轮询、加密 CDN 媒体上下行）+
会话节点（白名单闸门、会话寻址与隔离、摘要式出站、审批桥、`wechat_send_image`
工具、基础命令）。此后陆续补齐：发送重试与限流熔断、typing 指示与 `ret=-14`
会话过期判据（`9445da0`）、`/model` 两步切换、定时提醒、早安天气、生图与语音
工具（`f1a78cc`）、入站 OCR 与 STT（`28f1cb2`），测试增至 63 项。

---

[未发布]: 暂无
[v0.2.2]: https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.2.2
[v0.2.1]: https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.2.1
[v0.2.0]: https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.2.0
[v0.1.0]: https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.1.0

各版本面向使用者的发行说明在 [`releases/`](./releases)。
