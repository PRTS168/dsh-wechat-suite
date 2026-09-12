# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的组织方式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [v0.3.1] — 2026-09-12

### Fixed

- 天气推送在系统代理下只报 `fetch failed`：新增 `describeError()` 展开 `error.cause`（含 AggregateError），
  并改用 `node:https` 直连重试一次；两次都失败时同时给出两条原因
- 裸 `1` / `2` 回答权限请求失效：审批检查位于斜杠判断之后，`resolveApproval()` 收不到数字，
  数字被喂给模型、审批只能等超时
- `/yes` `/no` 在没有待确认请求时报「未知命令」并附帮助
- 灯控词表 `/gear` `/off` `/low` `/mid` `/high` 恢复（已归档插件的设备词表）
- 灯控请求同样做直连兜底，失败信息带出真实原因

### Changed

- 新增 `src/node/net.ts`（`describeError` / `directRequest`），天气与灯控共用
- 单元测试 143 → 154 项；「设备不可达」用例改为注入直连传输，测试不再触网

## [v0.3.0] — 2026-09-12

**第三代（v3）：从"能收发"走向"能长期运行"。** 本版三件事——**上下文生命周期**、
**故障可见性**、**宿主稳定性**——都来自同一天一次真实事故的复现与修复（详见
`releases/v0.3.0-release-notes.md`）。

### 适配版本

| 宿主 | `@deepseek-ai/*` | 状态 |
|---|---|---|
| DSH Desktop（桌面应用内置 harness） | **0.1.2-rc.1** | ✅ 实测运行（真人微信往返、生图、灯控、自动轮换全部通过） |
| `dsh` CLI（OpenClaw 便携版内嵌包） | **0.1.5-rc.2** | ✅ 实测启动与装载通过 |

其余依赖必须与宿主对齐：cordis `^4.0.2`、schemastery `^3.18.2`（双实例会分别破坏
服务解析与类型推断）；Node.js ≥ 22（管理台与测试直接用类型擦除跑 `.ts`，实测 24）。

跨宿主差异与处理方式：

- **`dsh-persona` 配置键**：0.1.2 要 `text:`，0.1.5 改为 `prefix:`。preset 用 YAML
  锚点同时挂两个键名，两边 schema 均实测接受。
- `Session.events` 在 0.1.5 移除 → 一律改用 `snapshotEvents()`。
- **可选服务不得进 `inject`**：`sessionTitle` 依赖 `sessionProjections`，写进 `inject`
  会让该行永久 pending，宿主随即判整个 profile "1 entry did not activate" 启动失败。

### 新增

- **上下文管理方案 `contextPolicy`**：`manual` / `rotate-turns` /
  `rotate-turns+handoff` / `rotate-pressure` / **`rotate-tokens`（自设 token 预算，
  优先读会话投影的真实 token 数，读不到时按 2 字符/token 估算并在播报里注明）** /
  `daily`。轮换只在 `turn/end` 且空闲时发生，动手前再查一次空闲；交接摘要**不额外
  调用模型**（从会话事件确定性摘录），用独立定界标记并写明"不是用户的新指令"。
- **独立管理台 `admin/`**：自己的进程与端口（默认 `http://127.0.0.1:8790/`），
  管全部配置（复用桥自己的 `CONFIG_FIELDS`）、看会话转录、新建/删除微信会话、
  一键切换上下文方案。**它不是插件行**——旧插件内管理 API 曾因可选依赖缺席而
  拖死整个 profile 启动，独立进程从结构上排除了这一类故障。
- **会话控制通道**：管理台把 `new-session` / `switch-session` / `forget-session`
  写进 `$DSH_HOME/wechat-admin/queue/`，桥在 ≤2 秒内轮询执行并回写结果；删除是
  **可恢复**的（移入 `$DSH_HOME/sessions-trash/`），并让宿主解绑，避免消息路由进
  已不存在的会话。
- **恢复 `control_esp32_light` 工具**：`query|off|low|mid|high`，与聊天命令共用
  同一份实现（命令与工具不会再各自漂移）。

### 修复

- **入站信封改为定界块**：`<<<微信用户消息>>> … <<<微信用户消息结束｜发送于 …>>>`。
  原来的行首 `[发送于 …]` 是"说话人标记"，模型会在自己的输出里把它续写成一条
  **并不存在的用户发言**并照着执行（2026-09-12 实锤：它写出未来时间戳的假消息，
  随后造了一个没人要的视频）。时间戳移到结束标记，并补上配套的人设硬规则。
- **未处理的 Promise rejection = 宿主致命**：配置写入触发的热重载会拆掉插件 scope，
  而 `bootWithCredentials` 是 `void` 出去的异步函数、用属性访问取服务——重载后抛错，
  连 `catch` 里的日志访问也抛，于是整机 `fatal load failure` 退出、桌面应用回落到
  安全模式。现在服务一律 `ctx.get()`、每个 await 后重取、调用点强制 `.catch()`；
  出站唯一出口 `sendTextToPeer` 与入站事件处理器同样保证**永不 reject**。
- **入站媒体不再静默失败**：下载返回空、或 item 根本没有可下载媒体时，过去是零日志
  零提示（与"消息从未到达"无法区分），现在四种情形都写日志并回一句明确提示。
- **失败提示曾经发不出去**：上述路径以及原有的「❌ 图片下载失败」都跑在
  `node.peerId` 赋值之前，而 `sendTextToPeer` 没有 peer 就直接返回——已把赋值提前。
- **重复投递**：网关去重只认 `message_id`，而 iLink 有时不给 id（语音常见），
  `if (messageId && …)` 等于完全不去重：同一条消息 6–9 秒后被再投一次，导致同一句话
  被回答两遍。现在无 id 时退化为**载荷指纹**（发送者 + 每项 kind/文本/媒体指针）
  并使用更短的 30 秒窗口。
- **自动轮换不再自问自答**：交接摘要曾作为新会话的 prompt 提交，每次轮换都会多出
  一条"刚换了个新会话"的回复；现在摘要**排队**并搭在下一条用户消息上，一次回合、
  零多余气泡。
- `config-api` 行**移除**（管理台独立化），客户端设置页与 `dsh.client` 声明一并撤掉，
  从根上消除"可选 webServer 依赖导致 profile 起不来"的路径；随后把残留的网页端代码
  （`src/node/config-api.ts`、`src/client/`、`lib/client.js`、`scripts/build-client.mjs`）
  与只覆盖它的测试一并删除。

### 验证

143 项单元测试全绿（覆盖网关去重、入站路由/媒体/信封、命令面、审批桥、轮换策略、
灯控与去重指纹）；另做了一次真实组合彩排：以桌面宿主的真实 profile 起实例、连腾讯
iLink、真人微信往返并触发一次自动轮换，并在连续多次 patch 热重载下确认宿主存活。

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
[v0.3.1]: https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.3.1
[v0.3.0]: https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.3.0
[v0.2.2]: https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.2.2
[v0.2.1]: https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.2.1
[v0.2.0]: https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.2.0
[v0.1.0]: https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.1.0

各版本面向使用者的发行说明在 [`releases/`](./releases)。
