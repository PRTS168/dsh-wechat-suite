# dsh-chatnode-wechat

**把微信变成你 DSH agent 的遥控器。**

在微信里跟你的 DeepSeek Harness agent 对话、看图、收推送、批权限——不用开电脑，
不用打开网页 GUI。

```
你（微信） ⇄ iLink ⇄ wechat-gateway ⇄ wechat-conversation-node ⇄ DSH agent 会话
```

这是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle，
经由腾讯**官方 clawbot iLink 协议**（`ilinkai.weixin.qq.com`）连接个人微信号。

**版本** `v0.3.0` · MIT · **154 项离线单测全绿**（无需微信账号）· 真机冒烟 + 热重载压迫测试通过（2026-09）

---

## 30 秒上手

```sh
git clone https://github.com/PRTS168/dsh-wechat-suite.git
cd dsh-wechat-suite
pnpm install && pnpm build
dsh plugin --profile <你的profile> add .

pnpm login      # 扫码配对微信号，写入 WEIXIN_* 凭据
pnpm setup      # 交互式向导，填完白名单等占位项（自动备份 cordis.patch.yml）
```

然后**重启 `dsh web`**，在微信里给 bot 发一条消息。

> **要填的两样东西**（缺了桥会安全地保持空闲，绝不把消息喂给模型）：
> ① `allowFrom` 白名单；② `WEIXIN_BOT_TOKEN` / `WEIXIN_ACCOUNT_ID` / `WEIXIN_BASE_URL`。
> 首屏只想跑通文字的话，OCR / 生图 / 语音 / 邮件都可以先不配。

---

## 它解决什么问题

| 场景 | 在微信里怎么做 |
|---|---|
| 出门在外想让 agent 干活 | 直接发消息，就是聊天；回复会做微信化排版（标题转`【】`、代码块缩进、表格去线） |
| 发张图让 agent 看 | 直接发图。**多模态模型自己看图**；纯文本模型自动回落 OCR |
| 想说不想打 | 发语音，自动转写后交给 agent；也能让它用克隆音色回你语音 |
| 长任务不想一直盯着 | 回合中每 `digestIntervalSec` 一条心跳摘要，出结果才推正文 |
| 权限请求在电脑上弹窗 | 微信里收到编号提示，回 `/yes` / `/no`；超时默认拒绝 |
| 想让它主动提醒你 | 自然语言设提醒（按联系人隔离、重启补发）、每日早安天气 |
| 想看/收文件 | 文档、视频双向收发；`/send <路径>` 推本地图 |

---

## 功能一览

### 消息

| 能力 | 说明 |
|---|---|
| 双向文字 | 出站自动微信化排版；入站包在 `<<<微信用户消息>>> … <<<微信用户消息结束｜发送于 YYYY-MM-DD HH:mm>>>` 定界块里（时间戳在结束标记，避免模型把 `[发送于 …]` 行首标记续写成假用户发言） |
| **双向图片（v0.2.2）** | **原生 `image` 块或 OCR 文本，按路由模型声明的模态自动切换**；`/识图` 可运行时强制 |
| 双向语音 | 入站自动转写（XingChenASR，或直接用微信自带转写）；出站 `speak` 用克隆音色，mp3 附件送达 |
| 双向文件与视频 | 入站解密落盘并保留原文件名；`wechat_send_file` / `wechat_send_video` 发回 |
| 摘要式出站 | 不刷屏工具调用：心跳摘要 + 按 `maxMessageChars` 分块限速 |

### 控制

| 命令 | 作用 |
|---|---|
| `/sessions` `/use N` `/new` `/stop` `/status` | 会话管理：列表、切换、新建、停止、状态 |
| `/model` | 两步菜单切换模型路由 |
| `/perm` | 两步菜单切换权限预设 |
| `/识图 [auto\|native\|ocr]` | 图片识别模式；不带参数则报告当前模式与路由模型 |
| `/早安 on\|off\|status\|test\|HH:MM` | 每日天气推送开关 |
| `/开灯` `/开灯1\|2\|3` `/关灯` | 通过 HTTP 控制 ESP32 PWM 灯 |
| `/yes` `/no`（`1`/`2`） | 回应权限请求 |

### 上下文生命周期（v0.3.0）

`contextPolicy` 决定会话何时**自动轮换**，切换方式见 `admin/` 管理台：

| 方案 | 触发条件 |
|---|---|
| `manual` | 不自动轮换（旧行为） |
| `rotate-turns` | 每 N 轮（默认 20） |
| `rotate-turns+handoff` | 同上，且换会话时生成要点交接，搭在下一条用户消息上 |
| `rotate-pressure` | 上下文达到窗口占比阈值（默认 60%） |
| **`rotate-tokens`** | **上下文达到自设 token 预算**（优先读会话投影的真实 token 数） |
| `daily` | 距上次活跃超过 N 小时（按自然日分桶） |

轮换只在 `turn/end` 且空闲时发生（绝不打断进行中的回合），并且复用与 `/new` 相同的
建会话路径。交接摘要不额外调用模型、用独立定界标记、明确标注"不是用户的新指令"。

### 管理台（v0.3.0）

`admin/` 是**独立进程**（自己的端口，默认 `http://127.0.0.1:8790/`）：管全部配置、
看会话转录、**新建 / 删除微信会话**、一键切换上下文方案。它**不是 DSH 插件行**，
所以不可能像插件内管理 API 那样拖累 profile 启动；删除会话是**可恢复**的
（移入 `$DSH_HOME/sessions-trash/`）。

### 工具（给模型用）

`generate_image` 文生图 · `speak` 语音回复 · `send_email` 纯文本邮件 ·
`wechat_send_image` / `wechat_send_file` / `wechat_send_video` 推送本地媒体 ·
`set_reminder` / `list_reminders` / `cancel_reminder` 定时提醒

### 运维

- **Web 管理页**：**设置 → 插件 →「微信桥配置」** —— 白名单、模型路由、媒体 Key、
  克隆音色、路径、限流全在浏览器里改；密钥脱敏，保存进 `cordis.patch.yml` 并自动备份。
- **人设编辑**：同一个页面里选 preset、改人设正文并保存；「复制为新 preset」可整目录复制。
- **会话隔离**：桥只认 `wechat-` 前缀会话，与网页 GUI 共用 SessionStore 也不会串台；
  重启后自动 resume 最近会话。

---

## 适配 DeepSeek 4.1 多模态（v0.2.2 重点）

图片有两种送达方式，**由路由模型自己声明的模态决定**：

| 模式 | 模型拿到什么 | 何时使用 |
|---|---|---|
| `native` | 真正的 `image` 内容块，模型自己看图 | 路由模型声明了图片输入 |
| `ocr` | `【OCR 识别结果】` 文本 + 文件路径 | 路由模型是纯文本 |

- `imageInput: auto`（默认）读 `llm.listModels()` 的 `inputModalities` 自动决定；
  `native` / `ocr` 可强制。若聊天路由是纯文本，`auto` 还会在其他路由里找视觉模型。
- `imageInputModel` 可以把「只用于图片」的路由钉到另一个模型——文字走便宜的、
  图片走视觉模型。

### ⚠️ 声明才是开关

harness 在**请求上游**就按模型声明的 `inputModalities` 闸门拦图片——声明成纯文本，
图片根本不会被发送。而 DeepSeek 适配器内置的模型目录**早于 4.1 多模态**：它把
`deepseek-v4-flash` 记为纯文本，唯一声明了 `image` 的
`deepseek-v4-flash-vision-exp` 又已下线。所以要显式声明：

```yaml
llm-deepseek:
  models:
    - id: deepseek-flash
      inputModalities: [text, image]
```

这个 `models:` 列表是**整体替换**插件内置目录、不是追加——要把你实际路由到的
每个 id 都列上（本项目 profile 钉的是旧别名 `deepseek-v4-flash`，漏掉它那条路由
就不再解析）。

**观测到的拒绝会被记住**：某个路由真的拒过一次图片后会被抑制 3 小时，后续图片
直接走 OCR，不再每张图都烧掉一个回合——因为「声明」只是对端点的声称，不是检验。

---

## 先读这里

- **一个账号一个轮询者。** iLink 每个 bot token 只允许**一个**鉴权轮询者。同一微信
  账号同时跑第二个本实例（或其他 iLink 客户端），会导致 HTTP 403 与消息丢失。
  请为桥准备一个**专用微信号**。
- **协议细节逆向而来。** iLink 报文格式是从既有客户端归纳的，尚未见公开的官方
  文档；录制样本在 `test/fixtures/inbound.ndjson`，CI 不需要真账号。
- **仅供参考。** 已在一套特定环境实测通过，不代表开箱即用。所有 `<...>` 都是
  需要你填入的占位符。

### 不适合你的情况

- 你需要**群聊**——本桥按设计只做一对一私聊。
- 你需要**原生语音气泡 / 视频气泡**——iLink 不支持，语音与视频都以文件附件送达。
- 你想**多账号 / 多实例共用一个 token**——会被 403 锁。

---

## 架构

两个可分离的 Cordis 插件：

| 插件 | 职责 |
|---|---|
| `wechat-gateway`（`WechatGateway`） | iLink 服务（`ctx.wechat`）：扫码登录、鉴权长轮询、重连退避、发送重试与限流熔断、typing 指示、加密 CDN 媒体上下行 |
| `wechat-conversation-node` | 微信 ⇄ DSH 桥：白名单闸门、会话寻址、命令、多模态媒体（原生图/OCR/STT/TTS/生图/文件/视频）、提醒与早安、摘要出站、审批、邮件 |

---

## 安装与配置

前置：Node >= 20、pnpm、一个专用微信号、一个 DSH profile。

```sh
pnpm login     # 扫码配对，写入 WEIXIN_BOT_TOKEN / WEIXIN_ACCOUNT_ID / WEIXIN_BASE_URL
pnpm setup     # 交互式；只改写 profile 的 dsh-chatnode-wechat 段，先备份
```

非交互式也可以用：

```sh
pnpm setup --yes --set allowFrom=<你的微信id>@im.wechat --set siliconflowKey=sk-...
```

`allowFrom` **必填且没有宽松默认值**：缺失时启动即失败；不在白名单的发送者只记日志、
绝不喂给模型。

主要配置项（完整见 profile 的 `cordis.patch.yml`）：

```yaml
dsh-chatnode-wechat:
  allowFrom: ["<你的微信id>@im.wechat"]   # 硬白名单，必填
  agentPreset: wechat                     # 人设 preset（仓库外自建，可选）
  agentProvider / agentModel              # 模型路由
  imageInput: auto                        # auto | native | ocr
  # imageInputModel: <provider>/<model>   # 图片专用路由（可选）
  digestIntervalSec: 300                  # 回合中心跳间隔（0=关）
  approvalTimeoutSec: 600                 # 审批超时 → 默认拒绝
  maxMessageChars: 2000                   # 微信单条上限，超出分块
  sendChunkDelayMs: 1500                  # 出站分块间隔
  # 媒体能力（都可选，不配则该能力降级）
  ocrApiKey / ocrModel: deepseek-ai/DeepSeek-OCR / ocrBaseUrl
  imageGenApiKey / imageGenModel: Kwai-Kolors/Kolors / imageGenDir
  sttApiKey / sttModel: XingChenAGI/XingChenASR-V3.2-Ultra
  ttsApiKey / ttsModel: FunAudioLLM/CosyVoice2-0.5B / ttsVoice: speech:<音色uri>
  # send_email
  smtpHost / smtpPort: 465 / smtpUsername / smtpPassword / smtpFromName
  # 路径（都有默认值，见下）
  mediaDir / reminderFile / morningFile / esp32BaseUrl / cwd
```

> **网关调优键的坑**：bundle 的 Config schema 声明了 `longPollTimeoutMs`、
> `retryDelayMs`、`rateLimitCircuit*` 等网关参数，但只有
> `baseUrl/cdnBaseUrl/token/accountId` 四个键会被转发给网关——在 profile 里配其它键
> **不会生效**。要调网关请直接给 `WechatGateway` 挂配置。

---

## 审批

微信没有按钮，所以权限请求渲染成编号文本提示，在聊天里回答：

```
#1 needs your confirmation
tool: bash
reason: run a destructive command
reply /yes to allow, /no to reject (1/2 while exactly one is pending)
no reply within 10 minutes -> automatically denied
```

`/yes` 授予 `allowed-once`；`/no` 拒绝；超时走 DSH 默认的拒绝。桥只回答它当前
驱动的那个 agent 的请求，其余沿 answerer 链下传。

---

## 开发

```sh
pnpm install
pnpm build          # src/ → lib/（tsc）+ 客户端 bundle（lib/client.js）
pnpm typecheck
pnpm test           # node --test test/*.test.ts —— 86 项，无需微信账号
pnpm smoke          # 真机手动冒烟
```

- `test/fake-ilink-server.ts` 实现 iLink 端点（长轮询、sendmessage、sendtyping、
  getconfig、扫码登录、加密 CDN 下载），回放 `test/fixtures/inbound.ndjson`；
  入站→会话→出站全链路可离线跑（`.github/workflows/ci.yml`）。
- 测试分布：gateway 18 / node 24 / markdown 9 / morning 6 / picker 4 /
  reminders 4 / patch-config 7 / vision 10 / email 4 = **86**。
- 诚实标注的盲区（暂无单测）：OCR 成功/失败分支、语音下载→ASR 全流程、媒体上行
  （fake 服务器无 `/upload`）、`/send`、`/help`、ESP32 灯控、重启 resume，以及
  **原生图片块本身**——`vision.test.ts` 用 stub 目录覆盖模式判定，
  `attachments.saveImage` 只在真机上跑。真机冒烟覆盖主路径。
- DSH 是开发者预览版，`@deepseek-ai/*` 依赖钉在 `0.1.5-rc.2`。

**改动生效三步**：`pnpm build` → 重启 `dsh web` → 微信里发条新消息触发。

---

## 已知限制

- 出站语音/视频是**文件附件**（mp3/mp4），不是原生气泡——iLink 限制；
  `silk.ts` 与 `gateway.sendVoice()` 作为未启用的备用保留（silk 需外部
  ffmpeg + pilk，不在依赖里）。
- 部分命令回执仍含 emoji，未与人设的禁 emoji 规则统一。
- `mediaDir/generated` 下生成的图片与语音暂无自动清理。
- 微信 `silk` 编码语音的 STT 待真机验证（m4a 已验证）。
- 只面向一对一私聊；群聊按设计忽略。

## 风险

| 风险 | 缓解 |
|---|---|
| iLink 独占锁——同一 token 两个轮询者 → 403 且丢消息 | 专用账号；检测到 403 时给出醒目致命错误并停止轮询 |
| DSH v0.1 变动频繁 | 钉住 `@deepseek-ai/*` 版本；CI 按钉住版本跑 |
| 协议细节未见于公开文档 | 报文格式从既有 iLink 客户端归纳；有真实报文录制样本（`test/fixtures/inbound.ndjson`） |
| 运行时会在仓库根落盘含凭据的文件 | `client-config.json` / `account.json` 已加入 `.gitignore` |

---

## 版本历史

见 [Releases](https://github.com/PRTS168/dsh-wechat-suite/releases)、
[`CHANGELOG.md`](./CHANGELOG.md)（逐条技术变更）与
[`releases/`](./releases)（各版本发行说明）。近期：

- **[v0.2.2](./releases/v0.2.2-release-notes.md)** — 适配 DeepSeek 4.1 多模态：原生图片
  输入（与 OCR 可切换、`/识图` 命令）、`send_email`、凭据加固；86 项测试
- **[v0.2.1](./releases/v0.2.1-release-notes.md)** — Web 管理页与人设编辑
- **[v0.2.0](./releases/v0.2.0-release-notes.md)** — `/perm` 接线、`pnpm setup` 向导、
  双向文件与视频、入站时间戳

## Roadmap

- 近期：群聊（可选、风险较高）、多账号、与 hermes/openclaw 共存的共享轮询代理
- 远期：复用 `node/` 层的企业微信 / 钉钉 / 飞书 bundle

## 致谢与来源

本仓库是 [Jesse-njx/dsh-chatnode-wechat](https://github.com/Jesse-njx/dsh-chatnode-wechat)
的**非官方个人分支**，从上游快照 `2bd4c15`（2026-08）分出。它不是上游项目的官方
发布，也与上游作者无隶属关系。原始提交历史与早期贡献的署名完整保留并归属上游作者；
基础协议以上游为准。

## License

MIT — 见 [LICENSE](./LICENSE)。
