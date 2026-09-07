# dsh-chatnode-wechat

**在微信里与你的 DSH agent 对话、监控、审批。**

> ⚠️ **仅供参考 —— 已在一套环境上实测，不代表开箱即用。**
> 状态（截至 2026-09-06）：**63 项离线单测全绿**（`node --test`，无需真实微信）
> **+ 一轮真机微信冒烟通过**（文字 / 图片 OCR / 语音 STT / 生图 / TTS mp3 附件 /
> 定时提醒 / 早安天气 / 灯控 / 会话命令 / 审批）。
> 下面 `§配置` 里所有 `<...>` 都是占位符，**必须由你填入**（尤其白名单与
> `WEIXIN_*` 三项：缺失时桥会「安全地不工作」——不喂模型 / 网关保持 idle）。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
bundle，通过腾讯非官方 **iLink bot 网关**（`ilinkai.weixin.qq.com`）把 DSH
profile 接到微信个人账号 —— 与 hermes-agent、OpenClaw 同机制。

```
你 (微信)  ⇄  iLink  ⇄  wechat-gateway  ⇄  wechat-conversation-node  ⇄  DSH agent 会话
```

Bundle 内含**两个可分离的 Cordis 插件**：

| 插件 | 职责 |
| --- | --- |
| `wechat-gateway`（`WechatGateway`） | iLink 服务（`ctx.wechat`）：扫码登录、鉴权长轮询、断线重连/退避、发送重试 + 限流熔断、正在输入指示、加密 CDN 媒体下载/上传。 |
| `wechat-conversation-node` | 微信 ⇄ DSH 桥：白名单闸门、会话定位、命令、多模态媒体助手（OCR/STT/TTS/生图）、提醒与早安天气、摘要式出站、审批。 |

## ⚠️ 先读这里

- **一个账号一个轮询者。** iLink 每个 bot token 只允许一个鉴权轮询者。如果
  你在同一个微信账号上还跑 **hermes-agent** 或 **OpenClaw**，其中一方会收到
  HTTP 403 并丢消息。请为 agent 使用**专用微信账号**，绝不要用同一个 token
  跑两个本 bundle 实例。
- **非官方网关。** 与 hermes/openclaw 同机制，腾讯可能限制该账号。请使用可以
  接受的专用账号。
- **非官方协议。** iLink 细节是从 hermes-agent 源码逆向的，而非腾讯文档。
  录制好的转录样本在 `test/fixtures/inbound.ndjson`，CI 不需要真实账号。

## 已实现且实测过的功能

- **双向文字**。入站文本路由到当前微信会话；回复先做微信化排版再发出
  （不裸发 Markdown：标题 →【】、代码块去围栏、表格去外框线、强调符号去除）。
- **双向图片**。入站图片自动下载解密落盘 `mediaDir`，配了 `ocrApiKey` 时自动
  走 SiliconFlow `deepseek-ai/DeepSeek-OCR` 识图——模型看到的是「文件路径 +
  OCR 文本」；出站 `/send <路径>` 可发本地图；agent 还能**生图**
  （`generate_image`，Kwai-Kolors/Kolors）并发回微信。
- **双向语音**。入站语音转写（XingChenASR，或直接用微信自带转写文本）后交给
  agent；agent 可**开口说话**（`speak`，CosyVoice2 克隆音色），mp3 以可点播的
  文件附件发回。
- **会话管理**：`/sessions /use N /new <prompt> /stop /status`，重启后自动
  resume 最近的 `wechat-` 会话。会话用 `wechat-` 前缀与网页 GUI 硬隔离
  （曾因同进程共享 SessionStore 串台，现已在每一层封死）。
- **模型两步切换**：`/model` 列出编号的 provider×model 菜单，回数字即生效并
  存为默认。
- **定时提醒**：自然语言 → `set_reminder`（按联系人隔离、JSON 持久化），到点
  推送，停机期间错过的到期提醒会在重启后补发。
- **早安天气**：`/早安 on|off|status|test|HH:MM`（别名 `/morning`），每天定时
  拉 Open-Meteo，本地拼装文案推送——零 LLM 成本。
- **灯控**：`/开灯 /开灯1|2|3 /关灯` → HTTP 直连 ESP32 PWM 灯（`esp32BaseUrl`）。
- **审批**：权限请求变成编号文本（`🔐 #N`），聊天里用 `/yes` `/no`（仅一条
  待确认时可回 `1`/`2`）回答；超时（默认 600s）自动**拒绝**。
- **摘要式出站**：不刷屏工具调用。回合中每 `digestIntervalSec` 一条
  `🔄 仍在处理中…` 心跳，回复按 `maxMessageChars` 分块限速，回合结束只在
  出错/中止/截断时给专属提示。

## 安装

```sh
git clone <本仓库地址>
cd dsh-chatnode-wechat
pnpm install && pnpm build
dsh plugin --profile <你的profile> add .
```

配对一次微信（打印二维码链接，微信扫码确认）：

```sh
pnpm login
```

这会把 `WEIXIN_ACCOUNT_ID` / `WEIXIN_BOT_TOKEN` / `WEIXIN_BASE_URL` 写入
`$DSH_HOME/.credentials.yaml`。bundle 启动时解析并自动开始轮询。
（也可改用网关 config 的 `accountId`/`token`/`baseUrl` 兜底。）

## 配置

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
    # mediaDir: <目录>   # 入站图片落盘（默认 $DSH_HOME/attachments/wechat）
    # reminderFile / morningFile: <路径，默认在 $DSH_HOME 下>
```

`allowFrom` **必填且没有宽松默认值**：接受任意微信联系人的指令等于把 prompt
注入的大门敞开。缺失 `allowFrom` 会启动失败；白名单外的消息只记日志、直接
忽略，永远不会喂给模型。

**跑通前必须由你填入的东西**（本仓库内全部真实值均已脱敏）：
1. `allowFrom` —— 你自己的微信 ID。
2. `WEIXIN_BOT_TOKEN` / `WEIXIN_ACCOUNT_ID` / `WEIXIN_BASE_URL` —— `pnpm
   login` 扫码获得（缺失时网关保持 idle）。
3. 需要媒体功能时填 SiliconFlow 的 `sk-` key（OCR/生图/STT/TTS 四个共用一把）。
4. 需要语音回复时填 `ttsVoice`（`speech:<你的克隆音色>:...`）。
5. 可选：`esp32BaseUrl`、`cwd`、`mediaDir`、`reminderFile`、`morningFile`。

上面提到的 `agentPreset: wechat`（我们测试环境的猫娘风格助手 preset，名
「云欣」）位于**本仓库之外**：`$DSH_HOME/.agent-presets/wechat/`。把
`agentPreset` 指向你已安装的任意 preset，或省略该键。

### 命令（在微信里发）

| 命令 | 作用 |
| --- | --- |
| *(普通文字 / 图片 / 语音)* | 路由到当前 agent（followup） |
| `/sessions` | 编号会话列表（仅 `wechat-`，最近优先） |
| `/use N` | 切换活动会话 |
| `/new <prompt>` | 新建 agent+会话并开工 |
| `/stop` | 取消当前任务 |
| `/status` | agent 状态 + 会话摘要 |
| `/send <路径>` | 发送一张本地图片给当前联系人 |
| `/model` | 两步切换模型（列表 → 选数字） |
| `/早安 on\|off\|status\|test\|HH:MM`（别名 `/morning`） | 早安天气摘要 |
| `/开灯` `/开灯1\|2\|3` `/关灯` | ESP32 灯控 |
| `/yes` `/no`（仅一条待确认时也可 `1`/`2`） | 回答权限请求 |
| `/help` | 命令列表 |

> `/perm`（权限预设切换）目前**机制就绪但命令未接线**：两步菜单已在
> `core.ts` 实现，但 `commands.ts` 还没有 `case 'perm'`，现在输入 `/perm`
> 会回「未知命令」。接线只需补一个 case。

## 审批

微信个人账号没有按钮。DSH 权限请求触发时，桥接层渲染成编号文本提示并等待：

```
🔐 #1 需要你的确认
工具: bash
原因: run a destructive command
回复 /yes 同意，/no 拒绝（仅一条待确认时也可回复 1/2）
10 分钟内未回复将自动拒绝。
```

`/yes`（仅一条待确认时 `1`）授予 `allowed-once`；`/no`（`2`）拒绝；超时回退
到 DSH 默认**拒绝**。桥接层只回答当前微信用户驱动的 agent 的请求，其余请求沿
answerer 链继续委托。

## 开发

```sh
pnpm install
pnpm build          # src/ → lib/（tsc）
pnpm typecheck
pnpm test           # node --test test/*.test.ts —— 63 项，无需微信
pnpm smoke          # 真机手动冒烟
```

- `test/fake-ilink-server.ts` 实现了 iLink 端点（长轮询、sendmessage、
  sendtyping、getconfig、扫码登录、加密 CDN 下载），回放
  `test/fixtures/inbound.ndjson`；完整 入站→会话→出站 循环可离线跑在 CI
  （`.github/workflows/ci.yml`）。
- 测试分布：gateway 18 / node 22 / markdown 9 / morning 6 / picker 4 /
  reminders 4 = **63**。
- **诚实标注的盲区**（暂无单测）：OCR 成功/失败分支、语音下载→ASR 全流程、
  媒体上行（fake 服务器无 /upload）、`/send`、`/help`、ESP32 灯控（真发 HTTP）、
  重启 resume。真机冒烟覆盖了上述主路径。
- 锁定 dsh-base 家族版本（本仓库 `@deepseek-ai/*` 为 `0.1.0-rc.6`）—— DSH
  是开发者预览版，上游可能有破坏性变更。

## 已知限制

- 语音输出为 **mp3 文件附件**，不是原生语音气泡（iLink 平台限制）。
  `silk.ts` 转码与 `gateway.sendVoice()` 已备但暂无调用方（silk 转码还需外部
  ffmpeg + pilk）。
- 部分命令回执仍带 emoji（✅❌🎙🧠），未按禁 Emoji 人设清理。
- 生成的图片/语音累积在 `mediaDir/generated`，暂无自动清理。
- 微信 `silk` 编码语音的 STT 待真机验证（本环境实测 m4a 正常）。
- 当前只面向**文字 / 单聊**；群消息按设计忽略（MVP）。

## 风险

| 风险 | 对策 |
| --- | --- |
| **iLink 独占锁** — 同一 token 两个轮询者 → 403 + 丢消息 | 专用账号；遇 403 大声报错并停止轮询；文档明示共存警告 |
| **账号风险** — 非官方网关 | 专用账号；本 README 明示 |
| **DSH v0.1 变更** | 锁定 `@deepseek-ai/*` 依赖；CI 针对锁定版本 |
| **协议不透明** | 协议移植自 hermes-agent；已录制样本，重构无需真实账号 |

## Roadmap

- **已完成（v0.1+）**：扫码登录、文字/图片/语音双向、入站 OCR、生图、出站
  TTS、定时提醒、早安天气、灯控、模型切换、会话隔离 + 自动恢复、审批、
  摘要式出站。
- **下一步**：接 `/perm`；群聊（高风险、需显式开启）；多账号；
  hermesclaw 式共享轮询代理（与 hermes/openclaw 共存）。
- **后续**：复用 `node/` 层的企业微信 / 钉钉 / 飞书 bundle。

## License

MIT —— 见 [LICENSE](LICENSE)。
