# dsh-chatnode-wechat

**在微信里与你的 DSH agent 对话、监控、审批。**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
bundle，通过腾讯**官方 clawbot iLink 协议**（`ilinkai.weixin.qq.com`）把 DSH
profile 接到微信个人账号。

```
你 (微信)  <=>  iLink  <=>  wechat-gateway  <=>  wechat-conversation-node  <=>  DSH agent 会话
```

> **Fork 声明（非官方）。** 本仓库是对
> [Jesse-njx/dsh-chatnode-wechat](https://github.com/Jesse-njx/dsh-chatnode-wechat)
> 的个人、非官方 fork 与继续开发，fork 自上游快照 `2bd4c15`（2026-08）。
> 本仓库**不是**上游项目或其作者的官方发布，也与上游无隶属关系；原始提交
> 历史与早期贡献者署名完整保留并归属上游作者，基础协议以上游为准。

**状态** | 版本 `v0.2.2`（见 [Releases](https://github.com/PRTS168/dsh-wechat-suite/releases)）· MIT · **86 项离线单测全绿** + 一轮真机微信冒烟（2026-09）

> **仅供参考。** 已在一套特定环境实测，不代表开箱即用。所有 `<...>` 都是
> 需要你填入的占位符（`allowFrom` 与 `WEIXIN_*` 凭据必填 —— 缺失时桥会
> 「安全地不工作」，不会把任何消息喂给模型）。

---

## 1. 功能一览

- **双向文字**。回复发送前先做微信化排版（Markdown 标题 →【】、代码块去
  围栏并缩进、表格去外框线、强调符号去除）。
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
- **发送时间戳**。每条喂给模型的入站用户消息都带 `[发送于 YYYY-MM-DD
  HH:mm]` 前缀（服务器本地时间），让 AI 永远知道消息是什么时候发的。
- **会话管理**。`/sessions /use /new /stop /status`，重启后自动 resume
  最近的 `wechat-` 会话；用 `wechat-` 前缀与网页 GUI 会话硬隔离（同进程
  共享 SessionStore，曾致串台，现已逐层封死）。
- **运行时切换**。`/model` 与 `/perm` 两步菜单，聊天内直接切换模型路由与
  权限预设。
- **定时提醒**。自然语言 → `set_reminder`（按联系人隔离、JSON 持久化、
  停机后补发）。
- **早安天气**。`/早安 on|off|status|test|HH:MM`（别名 `/morning`），每天
  定时拉 Open-Meteo，本地拼装推送，零 LLM 成本。
- **灯控**。`/开灯 /开灯1|2|3 /关灯` 通过纯 HTTP 控制 ESP32 PWM 灯
  （`esp32BaseUrl`）。
- **审批**。权限请求渲染为编号文本提示，聊天内用 `/yes` `/no`（或 `1`/`2`）
  回答；超时默认拒绝。
- **邮件**。`send_email` 通过配置好的 SMTP 账号（隐式 TLS）发送纯文本邮件，
  可在聊天里直接让 agent 发报告 / 提醒 / 摘要。
- **摘要式出站**。不刷屏工具调用：每 `digestIntervalSec` 一条心跳，回复按
  `maxMessageChars` 分块限速，回合结束只在出错/中止/截断时提示。
- **Web 管理页与人设编辑**。在 `web` profile 下，**设置 → 插件 →
  「微信桥配置」**可管理下面的全部待填项（白名单、模型路由、媒体 Key、克隆
  音色、路径、节流参数 —— 密钥脱敏、保存写入 `cordis.patch.yml` 并自动备份），
  还能直接编辑各 agent preset 的人设正文。

内含**两个可分离的 Cordis 插件**：

| 插件 | 职责 |
| --- | --- |
| `wechat-gateway`（`WechatGateway`） | iLink 服务（`ctx.wechat`）：扫码登录、鉴权长轮询、断线重连/退避、发送重试 + 限流熔断、正在输入指示、加密 CDN 媒体下载/上传。 |
| `wechat-conversation-node` | 微信 ⇄ DSH 桥：白名单闸门、会话定位、命令、多模态媒体助手（OCR/STT/TTS/生图/文件/视频）、提醒与早安天气、摘要式出站、审批。 |

## 2. 先读这里

- **一个账号一个轮询者。** iLink 每个 bot token 只允许一个鉴权轮询者；同一微信账号
  跑第二个本实例（或任何其他 iLink 客户端）会互相 403 并丢消息。请为桥使用
  **专用微信账号**，绝不要用同一 token 跑两个实例。
- **协议细节逆向而来。** iLink 报文格式是从既有客户端归纳的，尚未见公开的官方
  文档；录制样本在 `test/fixtures/inbound.ndjson`，CI 无需真实账号。

## 3. 快速开始

前置：Node >= 20、pnpm、一个专用微信账号、一个 DSH profile。

```sh
git clone https://github.com/PRTS168/dsh-wechat-suite.git
cd dsh-chatnode-wechat
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

重启 dsh web，然后给机器人发一条微信消息。

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
    # agentPreset: wechat             # 可选：人设 preset（见下）
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

### Web 管理页

在 `web` profile 下，本 bundle 还带一个浏览器管理页：**设置 → 插件 →
「微信桥配置」**。它列出上面全部待填项（白名单、模型路由、SiliconFlow 媒体
Key、克隆音色、路径、节流参数），显示环境状态（凭据 / 人设 preset / 白名单），
密钥脱敏展示，保存时直接改写 profile 的 `cordis.patch.yml` —— 自动生成带
时间戳的备份，并保留注释与其他插件条目。

主机接口位于 `/dsh-chatnode-wechat/api`（`GET /schema`、`GET /config`、
`POST /save`），所有请求必须携带 `X-DSH-Chatnode-Wechat: 1` 头（跨站请求无法
伪造该头，因此被拒绝）；第二个 bundle 行 `dsh-chatnode-wechat/config-api` 只在
存在 `webServer` 服务的 profile 中加载，headless 不受影响。保存后重启 dsh web
生效。

同一页面还能编辑**人设**（`GET /presets`、`GET /persona`、`POST /persona`、
`POST /preset/copy`）：选择一个 agent preset，在文本框里编辑它的 `config.text`
人设正文并保存 —— 只会替换该 preset 的 `agent.cordis.yml` 中 persona 那一段
（自动备份，其余工具行不动）。「复制为新 preset」会整目录复制当前 preset，
便于在不手写工具组成的前提下做第二个人设；微信 agent 实际用哪个人设由上面的
「人设 preset 名」（`agentPreset`）决定。

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
| `/开灯` `/开灯1\|2\|3` `/关灯` | ESP32 灯控 |
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
pnpm test           # node --test test/*.test.ts —— 86 项，无需微信
pnpm smoke          # 真机手动冒烟
pnpm setup          # 交互式配置向导
```

- `test/fake-ilink-server.ts` 实现 iLink 端点（长轮询、sendmessage、
  sendtyping、getconfig、扫码登录、加密 CDN 下载），回放
  `test/fixtures/inbound.ndjson`；入站→会话→出站全链路可离线跑在 CI
  （`.github/workflows/ci.yml`）。
- 测试分布：gateway 18 / node 24 / markdown 9 / morning 6 / picker 4 /
  reminders 4 / patch-config 7 / vision 10 / email 4 = **86**。
- 诚实标注的盲区（暂无单测）：OCR 成功/失败分支、语音下载→ASR 全流程、
  媒体上行（fake 服务器无 /upload）、`/send`、`/help`、ESP32 灯控、
  重启 resume，以及原生图片块本身（`vision.test.ts` 用 stub 目录覆盖模式判定，
  `attachments.saveImage` 只在真机上跑）。真机冒烟覆盖主路径。
- DSH 是开发者预览版，`@deepseek-ai/*` 锁定在 `0.1.1-rc.2`。

## 8. 已知限制

- 出站语音/视频以**文件附件**（mp3/mp4）送达，不是原生气泡（iLink 限制）；
  `silk.ts` 与 `gateway.sendVoice()` 已备但暂无调用方（silk 转码还需外部
  ffmpeg + pilk）。
- 部分命令回执仍带 emoji，未按禁 Emoji 人设清理。
- 生成的图片/语音累积在 `mediaDir/generated`，暂无自动清理。
- 微信 `silk` 编码语音的 STT 待真机验证（m4a 已实测）。
- 当前只面向 1:1 文字聊天；群消息按设计忽略（MVP）。

## 9. 风险

| 风险 | 对策 |
| --- | --- |
| iLink 独占锁 —— 同一 token 两个轮询者 → 403 + 丢消息 | 专用账号；遇 403 大声报错并停止轮询 |
| DSH v0.1 变更 | 锁定 `@deepseek-ai/*` 依赖；CI 针对锁定版本 |
| 协议细节未见于公开文档 | 报文格式从既有 iLink 客户端归纳；已录制真实样本 |
| 运行时在仓库根落盘含凭据的文件 | `client-config.json` / `account.json` 已加入 `.gitignore` |

## 10. Roadmap

- 下一步：群聊（显式开启，高风险）、多账号、与 hermes/openclaw 共存的
  共享轮询代理。
- 后续：复用 `node/` 层的企业微信 / 钉钉 / 飞书 bundle。

## License

MIT —— 见 [LICENSE](LICENSE)。
