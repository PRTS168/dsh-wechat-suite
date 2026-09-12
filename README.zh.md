# dsh-chatnode-wechat

**在微信里与你的 DSH agent 对话、监控、审批。**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
bundle，通过腾讯 **clawbot iLink** 网关（`ilinkai.weixin.qq.com`，即腾讯自家
微信机器人客户端所用的协议）把 DSH profile 接到微信个人账号 —— 这条用法不受
官方支持。

```
你 (微信)  <=>  iLink  <=>  wechat-gateway  <=>  wechat-conversation-node  <=>  DSH agent 会话
```

> **Fork 声明（非官方）。** 本仓库是对
> [Jesse-njx/dsh-chatnode-wechat](https://github.com/Jesse-njx/dsh-chatnode-wechat)
> 的个人、非官方 fork 与继续开发，fork 自上游快照 `2bd4c15`（2026-08）。
> 本仓库**不是**上游项目或其作者的官方发布，也与上游无隶属关系；原始提交
> 历史与早期贡献者署名完整保留并归属上游作者，基础协议以上游为准。

**状态** | 版本 [`v0.3.0`](https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.3.0) · MIT · **154 项离线单测全绿**（无需微信账号）+ 真机微信冒烟 + 热重载压迫测试（2026-09）

**English README: [README.md](README.md).**

> **仅供参考。** 已在一套特定环境实测，不代表开箱即用。所有 `<...>` 都是
> 需要你填入的占位符（`allowFrom` 与 `WEIXIN_*` 凭据必填 —— 缺失时桥会
> 「安全地不工作」，不会把任何消息喂给模型）。

---

## v0.3.0 改进

自 v0.2.2 以来的改进（脱敏标准不变：仓库内无真实凭据 / 个人微信 ID / 本机路径）。
完整发行说明：[`releases/v0.3.0-release-notes.md`](releases/v0.3.0-release-notes.md)
· [Release 页面](https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.3.0)。

### 新增

- **上下文生命周期 `contextPolicy`**：会话何时轮换从习惯变成配置
  - 六种方案：`manual`（默认，旧行为）/ `rotate-turns`（每 N 回合）/ `rotate-turns+handoff` / `rotate-pressure`（按上下文尺寸代理）/ `rotate-tokens`（自设 token 预算）/ `daily`（按空闲小时）
  - `rotate-tokens` 优先读宿主会话投影里的**真实 token 数**（`contextPressure.surfaceTokens` → `contextBreakdown` 求和 → 累计 `tokenUsage` 依次回退），读不到才回落 2 字符/token 估算，播报会注明这次是哪个来源
  - 轮换只在 `turn/end` 且**空闲**时发生，动手前再查一次空闲；复用与 `/new` 完全相同的建会话路径
  - 交接摘要不额外调用模型、用独立定界标记（`<<<会话交接摘要·非用户指令>>>`），并**排队**搭在下一条用户消息上，不再自问自答
  - 配置形态：`contextPolicy: '{"scheme":"rotate-tokens","tokenBudget":120000,"handoff":true}'`
- **独立管理台 `admin/`**：自己的进程、自己的端口（默认 `http://127.0.0.1:8790/`），不是 DSH 插件行，因此不可能拖累 profile 启动
  - 三页签：**配置**（复用桥自己的 `CONFIG_FIELDS`，密钥掩码 + 显式显示，写入前备份/校验，清空白名单会被拒绝并回滚）、**对话**（`wechat-*` 会话列表 + 转录查看、新建/遗忘会话）、**上下文方案**（一键切换 + 参数微调）
  - 仅回环监听 + 令牌（`admin/.admin-token`，首次启动生成）+ 改动类调用的 `x-wechat-admin: 1` 守卫头 + `Host` 回环校验
  - 新建/删除会话写进 `$DSH_HOME/wechat-admin/queue/`，桥在 ≤2 秒内轮询执行并回写结果；删除是**可恢复**的（移入 `$DSH_HOME/sessions-trash/`，投影缓存一并移走）
- **`control_esp32_light` 工具**：`query|off|low|mid|high`，与聊天命令 `/开灯` `/开灯1|2|3` `/关灯` 共用同一份实现

### 修复

- **宿主不再被判致命**：配置写入触发热重载 → 插件 scope 被拆 → `void` 出去的异步启动函数用属性访问取服务而抛错（连 `catch` 里的日志访问也抛）→ 未处理的 rejection → 宿主 `fatal load failure` 退出、桌面应用回落到安全模式
  - 三个入口（`src/index.ts` 的凭据启动、`node/core.ts` 的入站处理器、`node/outbound.ts` 的 `sendTextToPeer`）全部保证不 reject，调用点再加 `.catch()`
  - 服务访问一律 `ctx.get()`，并在每个 `await` 之后**重新取**
  - `config-api` 插件行**移除**，管理能力搬到独立进程，从结构上删除「可选 `webServer` 依赖拖死 profile 启动」这条路径
- **长会话自我续写**：单会话累积到 60 轮 / 3083 事件后，模型在自己输出里续写出一条带未来时间戳的假用户消息（`[发送于 …] 视频呢？发个`）并照着执行，造了个没人要的视频
  - 入站信封改为定界块 `<<<微信用户消息>>> … <<<微信用户消息结束｜发送于 …>>>`，时间戳从行首说话人标记移到**结束标记**
- **静默失败**：入站媒体下载返回空时零日志零提示；而「响亮失败」的提示本身又因 `peerId` 未赋值而发不出去
  - 四种情形（图片 / 文件 / 视频 / 未知 item 类型）现在都写 warn 日志**并**回一句明确提示；`peerId` 赋值提前到失败路径之前
- **重复投递**：iLink 有时不给 `message_id`（语音常见），而网关去重原本是 `if (messageId && …)`，等于完全不去重——同一条消息 6–9 秒后被再投一次、被回答两遍
  - 无 id 时退化为**载荷指纹**（发送者 + 每项 kind/文本/媒体指针），窗口 30 秒；带 id 的窗口保持 300 秒

### 其它

- 依赖对齐 DSH **0.1.2-rc.1**（桌面应用内置 harness）与 **0.1.5-rc.2**（`dsh` CLI 内嵌包），两套宿主都实测加载运行
  - `cordis ^4.0.2` 需与宿主对齐（双实例会破坏服务解析）；`schemastery ^3.18.2` 需单实例（与 3.18.1 并存会致 `TS2742`）；Node ≥ 22（实测 24）
  - 跨宿主差异（都已在代码里处理）：`dsh-persona` 的配置键 `text:`（0.1.2）→ `prefix:`（0.1.5）；`Session.events` 在 0.1.5 移除 → 全库改用 `snapshotEvents()`；可选服务不得写进 `inject`（缺投影时 `1 entry did not activate` 会让**整个 profile 启动失败**）→ 一律 `ctx.get()`
- 单元测试 **86 → 154 项**（新增 `context-policy` 21、`light` 13、`persona` 7、`dedup` 6、`inbound-media` 6、`boot-safety` 5、`resume` 5、`user-message-envelope` 5 等）
- 验证：真机微信往返（文字 / 图片 / 文件 / 生图）→ 触发一次自动轮换并确认新会话可用；对运行实例连续 3 次 patch 热重载压迫，进程存活、轮询不断、stderr 无 `fatal` / `unhandled`
- README 首页**恢复英文**（v0.3.0 期间被误写为中文，等于丢了英文版），中英首页同步补上本版改进与适配说明；`DEVELOPMENT.md` 按实测重算测试分布

### 注意

- **配置面变化**：`config-api` 插件行被移除，微信桥配置不再有网页 GUI 设置入口（人设在线编辑一并撤掉）；配置改在 `profiles/<profile>/cordis.patch.yml` 或独立管理台里改
- **模型看到的消息格式变了**（定界块）。依赖旧 `[发送于 …]` 行首前缀的自定义提示词或人设规则请同步更新；配套硬规则在你的 preset 里，仓库不含人设内容
- **删除会话是可恢复的**，但清理 `$DSH_HOME/sessions-trash/` 前请先确认回收站内容
- 依赖版本请与宿主对齐（见上）：`cordis` / `schemastery` 尤其重要
---

## 1. 功能一览

- **双向文字**。回复发送前先做微信化排版（Markdown 标题 →【】、代码块去围栏
  并缩进、表格去外框线、强调符号去除）。
- **入站信封**。每条用户消息都带时间戳、包在上面「修复」一节的定界块里，模型因此永远
  能分清「真实用户回合」和「它自己写过的东西」。
- **双向图片，原生识图或 OCR 可切换（适配 DeepSeek 4.1 多模态）**。入站图片
  自动下载解密并落盘 `mediaDir`。图片怎么送到模型取决于路由模型：声明了图片
  输入的多模态模型会收到**真正的 image 内容块**（模型自己看图），纯文本模型
  则回落到 **DeepSeek-OCR** 文本 + 文件路径。`imageInput: auto`（默认）按路由
  模型声明的模态自动决定，`native` / `ocr` 可强制，聊天内用 `/识图` 运行时切换。
  出站：`/send <路径>` 发本地图；agent 还能**生图**（`generate_image`，
  Kwai-Kolors/Kolors）。
- **双向语音**。入站语音自动转写（`sttApiKey`，XingChenASR；或直接用微信
  自带转写）；agent 可用 `speak` 开口说话（CosyVoice2 克隆音色），mp3 以
  可点播的文件附件送达。
- **双向文件与视频**。入站文档/视频自动解密落盘 `mediaDir`，以
  `[微信文件]` / `[微信视频]` 路径标记交给 agent（保留原始文件名）；agent
  可用 `wechat_send_file` / `wechat_send_video` 发送本地文件或视频（视频以
  可播放的 mp4/mov 附件送达 —— iLink 无原生视频气泡）。
- **会话管理**。`/sessions /use /new /stop /status`，重启后自动 resume
  最近的 `wechat-` 会话；用 `wechat-` 前缀与网页 GUI 会话硬隔离（同进程
  共享 SessionStore，曾致串台，现已逐层封死）。
- **上下文生命周期**。`contextPolicy`（见上面「新增」一节）按轮数、上下文压力、token 预算
  或空闲时长自动轮换长会话，可附带免费交接摘要；管理台一键切换方案。
- **运行时切换**。`/model` 与 `/perm` 两步菜单，聊天内直接切换模型路由与
  权限预设。
- **定时提醒**。自然语言 → `set_reminder`（按联系人隔离、JSON 持久化、
  停机后补发）。
- **早安天气**。`/早安 on|off|status|test|HH:MM`（别名 `/morning`），每天
  定时拉 Open-Meteo，本地拼装推送，零 LLM 成本。
- **灯控**。`/开灯 /开灯1|2|3 /关灯` 通过纯 HTTP 控制 ESP32 PWM 灯
  （`esp32BaseUrl`）；模型也能用 `control_esp32_light` 做同样的事。
- **审批**。权限请求渲染为编号文本提示，聊天内用 `/yes` `/no`（或 `1`/`2`）
  回答；超时默认拒绝。
- **邮件**。`send_email` 通过配置好的 SMTP 账号（隐式 TLS）发送纯文本邮件，
  可在聊天里直接让 agent 发报告 / 提醒 / 摘要。
- **摘要式出站**。不刷屏工具调用：每 `digestIntervalSec` 一条心跳，回复按
  `maxMessageChars` 分块限速，回合结束只在出错/中止/截断时提示。
- **独立管理台**。在插件树之外（见上面「新增」一节）：配置、转录、新建/删除会话、
  上下文方案切换。

内含**两个可分离的 Cordis 插件**：

| 插件 | 职责 |
| --- | --- |
| `wechat-gateway`（`WechatGateway`） | iLink 服务（`ctx.wechat`）：扫码登录、鉴权长轮询、断线重连/退避、发送重试 + 限流熔断、正在输入指示、加密 CDN 媒体下载/上传、入站去重。 |
| `wechat-conversation-node` | 微信 ⇄ DSH 桥：白名单闸门、会话定位、命令、上下文轮换、多模态媒体助手（OCR/STT/TTS/生图/文件/视频）、提醒与早安天气、摘要式出站、审批、灯控。 |

## 2. 先读这里

- **一个账号一个轮询者。** iLink 每个 bot token 只允许一个鉴权轮询者；同一微信
  账号跑第二个本实例（或任何其他 iLink 客户端）会互相 403 并丢消息。请为桥使用
  **专用微信账号**，绝不要用同一 token 跑两个实例。
- **非官方网关。** 腾讯可能限制账号，请使用你愿意失去的账号。
- **协议细节逆向而来。** iLink 报文格式是从既有客户端归纳的，尚未见公开的官方
  文档；录制样本在 `test/fixtures/inbound.ndjson`，CI 无需真实账号。

## 3. 快速开始

前置：Node >= 22、pnpm、一个专用微信账号、一个 DSH profile。

```sh
git clone https://github.com/PRTS168/dsh-wechat-suite.git
cd dsh-wechat-suite
pnpm install && pnpm build
dsh plugin --profile <你的profile> add .
```

配对微信（打印二维码链接，微信扫码确认）：

```sh
pnpm login            # 写入 WEIXIN_BOT_TOKEN / WEIXIN_ACCOUNT_ID / WEIXIN_BASE_URL
```

其余占位项用交互向导一键填写（只改 profile `cordis.patch.yml` 里
`dsh-chatnode-wechat` 那一块，改前自动备份）：

```sh
pnpm setup            # 交互
pnpm setup --yes --set allowFrom=<你的微信ID>@im.wechat \
    --set siliconflowKey=sk-...        # 非交互；siliconflowKey 一次填充 OCR/生图/STT/TTS
```

重启 dsh web，然后给机器人发一条微信消息。想同时开管理台：

```sh
node admin/server.ts          # Windows 上也可用 admin/start-admin.bat
# -> http://127.0.0.1:8790/   （令牌写入 admin/.admin-token）
```

## 4. 配置

```yaml
# profile patch（cordis.patch.yml）
plugins:
  dsh-chatnode-wechat:
    allowFrom: ["<你的微信ID>@im.wechat"] # 硬白名单，必填，无默认值
    digestIntervalSec: 300            # 回合中每 N 秒一条进度摘要
    approvalTimeoutSec: 600           # 审批超时 → 默认拒绝
    maxMessageChars: 2000             # 微信单条气泡上限（协议限制）
    sendChunkDelayMs: 1500            # 出站气泡间隔限速
    imageInput: auto                  # auto | native | ocr（见下）
    contextPolicy: '{"scheme":"manual"}'   # 见 v0.3.0 改进 → 新增
    # imageInputModel: amd/DeepSeek-V4-Flash-Vision-Exp  # 图片专用视觉路由
    # agentPreset: wechat             # 可选：人设 preset（在仓库之外）
    # agentProvider / agentModel: ... # 微信 agent 的模型路由
    # esp32BaseUrl: http://<esp32-ip>:80   # 灯控（可选）

    # ---- 媒体助手（全部可选；未配时对应能力优雅降级）----
    # ocrApiKey / ocrModel: deepseek-ai/DeepSeek-OCR / ocrBaseUrl
    # imageGenApiKey / imageGenModel: Kwai-Kolors/Kolors / imageGenDir
    # sttApiKey / sttModel: XingChenAGI/XingChenASR-V3.2-Ultra
    # ttsApiKey / ttsModel: FunAudioLLM/CosyVoice2-0.5B / ttsVoice: speech:<音色uri>
    # mediaDir: <目录>   # 入站媒体落盘（默认 $DSH_HOME/attachments/wechat）
    # reminderFile / morningFile: <路径，默认在 $DSH_HOME 下>
```

`allowFrom` 必填且没有宽松默认值。缺失会启动失败；白名单外的消息只记日志、
直接忽略，永远不会喂给模型。

> 注意：网关 Config schema 里还声明了一批调优键（longPollTimeoutMs、
> retryDelayMs、限流熔断等），但 bundle 只转发 `baseUrl/cdnBaseUrl/token/
> accountId` 四键 —— 需要调网关参数请直接配置 `WechatGateway` 自身。

上面提到的 `agentPreset: wechat`（测试环境用的一个人设 preset）位于本仓库
之外：`$DSH_HOME/.agent-presets/wechat/`。把 `agentPreset` 指向你已安装的
任意 preset，或省略该键。

### 原生识图 vs OCR

一张入站图片有两条送达路径：

| 模式 | 模型拿到什么 | 何时使用 |
| --- | --- | --- |
| `native` | 真正的 `image` 内容块（模型自己看图） | 路由模型声明了 `image` 输入 |
| `ocr` | `【OCR 识别结果】` 文本 + 文件路径 | 路由模型是纯文本，或没有任何路由声明支持图片 |

`imageInput` 决定策略：

- **`auto`**（默认）—— 先解析 agent 实际聊天用的路由，向 `llm.listModels()`
  询问它的 `inputModalities`，声明了 `image` 就发图片块。若聊天路由是纯文本，
  `auto` 会在其他已注册路由里找声明支持图片的（也可以用 `imageInputModel`
  钉死一个），否则走 OCR。
- **`native`** —— 总是尝试发图片块。未**声明**支持图片的路由仍会被试一次
  （端点可能实际接受图片却没广告出来）；一旦被拒，该路由会被抑制 3 小时，
  后续图片直接走 OCR，不再每张图烧掉一个回合。
- **`ocr`** —— 总是走文本路径。文档、截图这类场景，专用 OCR 模型更便宜，
  往往也比视觉模型更准。

`/识图` 可查看并运行时切换模式（`auto` / `native` / `ocr`）；覆盖状态持续到
`dsh web` 重启，之后重新按 `imageInput` 生效。两种模式下入站图片都保留
`[微信图片] <路径>` 前缀，会话记录可回放、agent 可重新读取文件。

```
/识图                 # 当前模式 + 路由模型
/识图 native          # 强制图片块
/识图 ocr             # 强制 OCR 文本
```

### 独立管理台

`node admin/server.ts [--port 8790]`（Windows 上可用 `admin/start-admin.bat`）
启动一个**仅回环**的 HTTP 管理台，与 DSH 完全分离：

| 页签 | 作用 |
| --- | --- |
| 配置 | 桥的全部 `CONFIG_FIELDS` 配置项，密钥掩码 + 显式显示，写入前校验 + 带时间戳备份 |
| 对话 | `wechat-*` 会话列表（轮数/token）、转录查看、新建会话、遗忘会话（可恢复） |
| 上下文 | 一键切换 `contextPolicy` 方案 + 参数微调 |

安全姿态：只绑定 `127.0.0.1`，令牌在首次启动时写入 `admin/.admin-token`
（可用 `WECHAT_ADMIN_TOKEN` 覆盖），每次 API 调用都要带它，改动类调用还要带
`x-wechat-admin: 1` 守卫头，且 `Host` 必须是回环地址（DNS rebinding 页面因此
够不到它）。会话命令落在磁盘队列
（`$DSH_HOME/wechat-admin/queue/`），由桥在 ≤2 秒内执行；管理台还能看到桥最近的
执行回报。令牌文件已被 git 忽略 —— 不要提交它。

v0.3.0 起**不再有网页 GUI 内的设置页**（见上面「修复」一节）。

## 5. 命令与工具

命令（微信里发送）：

| 命令 | 作用 |
| --- | --- |
| *(普通文字 / 图片 / 语音 / 文件 / 视频)* | 路由到当前 agent |
| `/sessions` | 编号会话列表（仅 `wechat-`，最近优先） |
| `/use N` | 切换活动会话 |
| `/new <prompt>` | 新建 agent+会话并开工 |
| `/stop` | 取消当前任务 |
| `/status` | agent 状态 + 会话摘要 |
| `/send <路径>` | 发送一张本地图片给当前联系人 |
| `/model` | 两步切换模型（列表 → 选数字） |
| `/perm` | 两步切换权限预设（列表 → 选数字） |
| `/识图 [auto\|native\|ocr]` | 图片识别模式；不带参数则报告当前模式与路由模型 |
| `/早安 on\|off\|status\|test\|HH:MM`（别名 `/morning`） | 早安天气摘要 |
| `/开灯` `/开灯1\|2\|3` `/关灯` | ESP32 灯控（3 档高 / 1·2 档低中 / 关） |
| `/yes` `/no`（仅一条待确认时也可 `1`/`2`） | 回答权限请求 |
| `/help` | 命令列表 |

Agent 工具（供模型调用）：

| 工具 | 用途 |
| --- | --- |
| `wechat_send_image(path)` | 发送本地图片给联系人 |
| `wechat_send_file(path)` | 发送任意本地文件给联系人 |
| `wechat_send_video(path)` | 发送本地视频（可播放的 mp4/mov 附件） |
| `generate_image(prompt)` | 文生图（Kolors）并发送 |
| `speak(text)` | 克隆音色 TTS，以 mp3 附件发送 |
| `send_email(to, subject, body)` | 通过已配置 SMTP 账号发纯文本邮件 |
| `control_esp32_light(mode)` | 局域网灯的 `query` / `off` / `low` / `mid` / `high` |
| `set_reminder(text, inMinutes\|atTime)` | 定时提醒（按联系人） |
| `list_reminders()` | 查看待办提醒 |
| `cancel_reminder(id)` | 取消提醒 |

## 6. 审批

微信没有按钮，权限请求渲染为编号文本提示、聊天内回答：

```
#1 需要你的确认
工具: bash
原因: run a destructive command
回复 /yes 同意，/no 拒绝（仅一条待确认时也可回复 1/2）
10 分钟内未回复将自动拒绝
```

`/yes` 授予 `allowed-once`；`/no` 拒绝；超时回退到 DSH 默认拒绝。桥只回答
当前由微信驱动的 agent 的请求，其余沿 answerer 链继续委托。

## 7. 开发

```sh
pnpm install
pnpm build          # src/ → lib/（tsc）+ 客户端 bundle（lib/client.js）
pnpm typecheck
pnpm test           # node --test test/*.test.ts —— 154 项，无需微信
pnpm smoke          # 真机手动冒烟
pnpm setup          # 交互式配置向导
```

- `test/fake-ilink-server.ts` 实现 iLink 端点（长轮询、sendmessage、
  sendtyping、getconfig、扫码登录、加密 CDN 下载），回放
  `test/fixtures/inbound.ndjson`；入站→会话→出站全链路可离线跑在 CI
  （`.github/workflows/ci.yml`）。
- 覆盖范围包括：网关去重（message id **与**载荷指纹）、入站路由/媒体失败路径/
  消息信封、命令面、审批桥、上下文轮换策略（含 token 预算的多级回退链）、
  灯控、两个宿主版本下的 preset 兼容，以及 `boot-safety.test.ts` —— 它把
  「绝不产生未处理 rejection」这条曾导致宿主崩溃的性质钉死在测试里。
- 诚实标注的盲区（暂无单测）：OCR 成功/失败分支、语音下载→ASR 全流程、
  媒体上行（fake 服务器无 /upload）、`/send`、`/help`、重启 resume，以及原生
  图片块本身（`vision.test.ts` 用 stub 目录覆盖模式判定，`attachments.saveImage`
  只在真机上跑）。真机冒烟覆盖主路径。
- DSH 是开发者预览版；本树已知可加载的两个宿主版本见上面「其它」一节。

## 8. 已知限制

- 出站语音/视频以**文件附件**（mp3/mp4）送达，不是原生气泡（iLink 限制）；
  `silk.ts` 与 `gateway.sendVoice()` 已备但暂无调用方（silk 转码还需外部
  ffmpeg + pilk）。
- 部分命令回执仍带 emoji，未按禁 Emoji 人设清理。
- 生成的图片/语音累积在 `mediaDir/generated`，暂无自动清理。
- 微信 `silk` 编码语音的 STT 待真机验证（m4a 已实测）。
- 当前只面向 1:1 文字聊天；群消息按设计忽略（MVP）。
- `rotate-pressure` 的上下文尺寸是「事件序列化字符数」这一代理值，不是模型
  token 数；要精确计数请用 `rotate-tokens`（依赖宿主暴露会话投影）。

## 9. 风险

| 风险 | 对策 |
| --- | --- |
| iLink 独占锁 —— 同一 token 两个轮询者 → 403 + 丢消息 | 专用账号；遇 403 大声报错并停止轮询 |
| 非官方网关可能限制账号 | 使用可弃置的专用账号；README 明说 |
| DSH v0.1 变更 | 已验证两个宿主版本（见「其它」）；可选项用 `ctx.get()`；boot 安全测试 |
| 未处理的 rejection 杀死宿主 | 全部异步入口保证 resolve；调用点 `.catch()`；热重载压迫测试 |
| 协议细节未见于公开文档 | 报文格式从既有 iLink 客户端归纳；已录制真实样本 |
| 运行时在仓库根落盘含凭据的文件 | `client-config.json` / `account.json` / `admin/.admin-token` 均已 git 忽略 |

## 10. 版本历史

### v0.3.0 —— 稳定性、上下文生命周期、独立管理台

上下文轮换方案、宿主稳定性加固、故障可见性与独立管理台 —— 详见
[「v0.3.0 改进」](#v030-改进) 与
[`releases/v0.3.0-release-notes.md`](releases/v0.3.0-release-notes.md)。

- 离线单测 154 项（原 86 项）。

### v0.2.2 —— 适配 DeepSeek 4.1 多模态与原生图片输入

- 路由模型声明图片输入时，入站图片以真正的 `image` 块送达；否则回落
  DeepSeek-OCR 文本。`imageInput` 与 `/识图` 选择策略；被拒过的路由抑制 3 小时。
- 「声明才是开关」：harness 在请求上游按模型声明的 `inputModalities` 闸门拦图片，
  而适配器内置目录早于 DeepSeek 4.1 —— 见第 4 节的 `models:` 片段（它是**整体
  替换**插件目录，不是追加）。
- `send_email`（隐式 TLS SMTP）；`client-config.json` / `account.json` 加入
  `.gitignore`。

### v0.2.1 —— 网页管理页与人设编辑

- **设置 → 插件 →「微信桥配置」**：浏览器内管理全部占位项，密钥脱敏、带时间戳
  备份；同一页面还能编辑各 agent preset 的人设正文。*（v0.3.0 已移除，见「修复」/「注意」。）*

### v0.2.0 —— `/perm`、双向文件与视频

- `/perm` 两步权限预设切换器，以及 `pnpm setup` 配置向导。
- 入站文件/视频解密落盘 `mediaDir` 并保留原文件名；`wechat_send_file` /
  `wechat_send_video` 发回本地文件与视频。
- 仓库内人设残留清除；补上上游 fork 归属声明。

## 11. Roadmap

- 下一步：群聊（显式开启，高风险）、多账号、与 hermes/openclaw 共存的
  共享轮询代理。
- 后续：复用 `node/` 层的企业微信 / 钉钉 / 飞书 bundle。

## License

MIT —— 见 [LICENSE](LICENSE)。
