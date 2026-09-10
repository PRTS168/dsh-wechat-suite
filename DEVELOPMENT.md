# 开发说明（DEVELOPMENT）

面向要改这个仓库的人。用户文档见 [`README.md`](./README.md)，变更历史见
[`CHANGELOG.md`](./CHANGELOG.md)。

> **本文只记录现役实现。** 历史方案（AstrBot 中转 + `llm_proxy.py`、自制 Python
> iLink 客户端）与过时的进度备忘已移入 `..\archive\2026-09-10-development-docs\`，
> 其中标注了哪些结论**已被证伪**——如果你从别处读到与之冲突的说法，以本文为准。

---

## 1. 它是什么

一个 DSH bundle，把个人微信号接入 DSH agent 会话。**两个可分离的 Cordis 插件**：

| 插件 | 入口 | 职责 |
|---|---|---|
| `wechat-gateway` | `src/gateway/index.ts` | iLink 服务（`ctx.wechat`）：扫码登录、鉴权长轮询、重连退避、发送重试与限流熔断、typing、加密 CDN 媒体上下行 |
| `wechat-conversation-node` | `src/index.ts` → `src/node/index.ts` | 微信 ⇄ DSH 桥：白名单、会话寻址、命令、媒体能力、提醒/早安、摘要出站、审批、邮件 |

数据流：

```
微信 ⇄ iLink(ilinkai.weixin.qq.com) ⇄ WechatGateway ⇄ WechatConversationNode ⇄ DSH agent 会话
```

`src/node/` 各模块分工：

| 文件 | 内容 |
|---|---|
| `core.ts` | `WechatConversationNode`：会话选择/恢复、模型选择、权限预设、白名单闸门、`currentModelRoute()` |
| `inbound.ts` | 入站分派：文字/图片/语音/文件/视频 → DSH 用户消息 |
| `outbound.ts` | 出站：Markdown 微信化、分块限流、心跳摘要、`session/event` 订阅 |
| `commands.ts` | 命令表（`routeCommand`）与 help 文案 |
| `vision.ts` | **图片投递策略**：原生 image 块 vs OCR，含能力探测与拒绝缓存 |
| `email.ts` | `send_email` 的 SMTP 客户端（可注入传输，便于测试） |
| `ocr.ts` / `stt.ts` / `tts.ts` / `image-gen.ts` | 硅基流动媒体模型调用 |
| `reminders.ts` / `morning.ts` | 定时提醒、早安天气 |
| `approvals.ts` | 审批桥（`/yes` `/no`） |
| `config-api.ts` / `patch-config.ts` | Web 管理页的主机 API 与 `cordis.patch.yml` 改写 |
| `labels.ts` | 会话徽标与 turn 结束原因文案 |

---

## 2. 构建与测试

```sh
pnpm install
pnpm build          # tsc -p tsconfig.json && node scripts/build-client.mjs
pnpm typecheck      # tsc --noEmit
pnpm test           # node --test "test/*.test.ts" —— 86 项，不需要微信账号
pnpm smoke          # 真机手动冒烟
pnpm setup          # 交互式配置向导（只改 profile 的 dsh-chatnode-wechat 段，先备份）
pnpm login          # 扫码配对，写 WEIXIN_* 凭据
```

**改完源码后生效三步**：`pnpm build` → **重启 `dsh web`** → 在微信里发一条新消息触发。

### 两个非直觉的地方

**① `lib/` 是提交进仓库的。** profile 通过 `link:` 直接加载仓库目录，DSH 不为
bundle 提供 build 步骤，所以编译产物必须随仓库走——这也是 `git status` 里
编译产物占多数的原因。**改 `src/` 后必须 `pnpm build` 并一并提交 `lib/`**，
否则线上跑的还是旧代码。

**② 测试不被 tsc 编译。** `tsconfig.json` 的 `include` 只有 `src/**/*.ts`，
测试是靠 **Node 24 原生 TypeScript 类型擦除**直接执行的。带来一个真实的坑：

> **`node:test` 无法解析对象字面量里带连字符的裸键。**
> `catalog({ deepseek-official: [...] })` 会抛
> `ERR_INVALID_TYPESCRIPT_SYNTAX: Expected ',', got ':'`——擦除器把它当成 TS 类型注解了。
> **写成引号键即可**：`catalog({ 'deepseek-official': [...] })`。
> 报错信息不给行号，排查时用 `node --test test/xxx.test.ts` 单跑，堆栈里会带
> `file:///.../xxx.test.ts:94` 这样的行号。

另外 `test/*.test.ts` 里用 `../src/node/vision.ts` 这种**带 `.ts` 后缀**的导入，
靠 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` 支持。

### 测试基建

`test/fake-ilink-server.ts` 用 `node:http` 实现 iLink 端点（长轮询、`sendmessage`、
`sendtyping`、`getconfig`、扫码登录、加密 CDN 下载），并回放
`test/fixtures/inbound.ndjson`（真实报文录制）。CI 因此**不需要真账号**。

挂载测试环境的最小路径（见 `test/node.test.ts` 的 `beforeEach`）：

```ts
ctx = new Context()
ctx.provide('wechat', /* … */)            // 或直接 ctx.plugin(WechatGateway, {...})
ctx.plugin(WechatGateway, {
  token: 'test-token', accountId: 'wxid_bot_fake',
  baseUrl: server.url, cdnBaseUrl: server.url,
  allowCdnHosts: ['127.0.0.1'],            // ← 必须加，否则 SSRF 白名单拦掉 fake 服务器
  pollIdleTimeoutMs: 1000,
})
```

其他惯例：服务用 `ctx.provide(name, stub)` 注入（如 `agentPresets`）；
`sendEmail` 的 SMTP 传输可注入（`SmtpConfig.connect`），所以 `test/email.test.ts`
用一个假 socket 驱动完整命令顺序，不需要真 TLS 证书。

---

## 3. 必须知道的框架语义（踩过的坑）

### ① cordis 的 `inject` 是「等待门」，不是「依赖声明」

这是**最容易毁掉整个插件**的一条：

```ts
export const inject = ['wechat', 'sessions', 'agents', 'approval', 'tools', 'sessionTitle']
```

`inject` 里列出的服务若未注册，插件的 `apply()` **根本不会被调用**——不报错、
不警告，插件静默地永不激活。测试里表现为一批用例集体超时（3 秒 waitFor 失败）。

**规则**：真正必需、缺失就该不启动的才写进 `inject`；**可选**能力一律用
`ctx.get('name')` 取，自己处理 `undefined`。

本仓库遵循此规则：`llm` 与 `attachments` **刻意不在 `inject` 里**（见 `src/index.ts`
的注释）。2026-09-10 曾把这两个加进 `inject`，结果 `node.test.ts` 的 21 个用例
全线挂起；回退后恢复。

### ② 图片块只能由附件服务产出，且只允许出现在 user 消息里

```ts
const ref = await ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png' })
const block = { type: 'image', attachment: ref }     // ImageBlock
```

- `ImageAttachmentRef` 带 `attachmentId / mediaType / bytes / width / height`，
  **不能自己拼**，必须经 `saveImage`（它会校验字节并归一化）。
- `mediaType` 仅接受 `image/png | jpeg | webp | gif`。
- `dsh-llm` 明确限制：**图片只能出现在 user 消息中**，system / assistant 携带
  图片会被 provider 拒绝（`dsh-llm/lib/types/types.d.ts` 的注释）。
- `@deepseek-ai/dsh-attachment` **不是本仓库的 dependency**，它是 host 提供的
  `ctx.attachments` 服务。类型在本仓库里按需本地声明（见 `vision.ts` 顶部），
  不要为了拿类型去 `pnpm add` 它。

### ③ 图片能否发送由模型**声明**决定，闸门在请求上游

即使你构造了 image 块，`dsh-llm-deepseek` 也会在发请求前拦住：

```js
// dsh-llm-deepseek/lib/index.js:1396
if (connection.models.find(e => e.id === options.model)?.inputModalities?.includes('image') !== true)
  throw new LlmError(`DeepSeek model "..." does not support image input`)
```

而适配器内置目录**早于 DeepSeek 4.1 多模态**（把 `deepseek-v4-flash` 记为纯文本，
唯一声明 `image` 的 `deepseek-v4-flash-vision-exp` 已下线）。因此要在使用方的
`$DSH_HOME/settings.yaml` 里显式声明：

```yaml
llm-deepseek:
  models:
    - id: deepseek-flash
      inputModalities: [text, image]
```

**该 `models:` 列表整体替换内置目录、不是追加**——要把所有实际路由到的 id 都列上，
否则那些路由会解析不到模型。

反过来，这也意味着**「声明」是单向的声称、不是检验**：声明了 image 但端点实际
拒收，会在回合中途失败。本仓库的对策是 `vision.ts` 的**拒绝缓存**——某路由拒绝
一次后抑制 3 小时，后续图片直接走 OCR。

### ④ bundle 的 Config schema 里有「死键」

`src/index.ts` 的 `extractGatewayConfig()` **只向网关转发 4 个键**：
`baseUrl` / `cdnBaseUrl` / `token` / `accountId`。schema 里声明的其他网关调优键
（`longPollTimeoutMs`、`retryDelayMs`、`maxConsecutiveFailures`、
`rateLimitCircuit*`、`sendChunkRetries`、`allowCdnHosts` …）**在 profile 里配了不生效**。

要调网关参数，得直接给 `WechatGateway` 插件挂配置（在 profile 里用 `ctx.plugin`
或另开一个行），而不是写在 `dsh-chatnode-wechat` 段下。若要新增转发键，
改 `extractGatewayConfig` 并补测试。

### ⑤ 运行时会在仓库根写含凭据的文件

`src/index.ts` 的 `startClient()` 把 `client-config.json` 与 `account.json` 写到
**仓库根**，内含微信 `token` / `account_id` / `sync_buf` **明文**。
两者已列入 `.gitignore`（历史中从未被提交）。**不要在仓库根跑实例后执行 `git add .`。**

### ⑥ Windows 换行

仓库内文件是 LF，工作区是 CRLF，`git add` 会打印一堆
`LF will be replaced by CRLF` 警告——**这是正常的**，不是错误。

---

## 4. 各功能的实现位置

### 图片投递策略（`src/node/vision.ts`）

判定顺序（`resolveImageDelivery`）：

```
mode = /识图 运行时值 ?? config.imageInput ?? 'auto'
target = imageInputModel(若配) ?? currentModelRoute()

mode === 'ocr'                                  → OCR
target 在拒绝缓存里（3 小时内）                    → OCR
listModels(target) 声明了 image                  → 原生 image 块
mode === 'native'（强制）                        → 仍尝试一次原生
否则（auto）→ 扫所有路由找第一个声明 image 的      → 有则原生，无则 OCR
```

- 原生路径失败（`saveImage` 抛错）时**自动降级 OCR**，并把原因写日志。
- 两种模式都保留 `[微信图片] <路径>` 前缀：会话日志可重放，模型之后能重读该文件。
- 纯图片消息（无附带文字）会补一句引导语，否则视觉模型有图无指令。
- `/识图` 的运行时覆盖存在 `node.runtimeImageInput`，**重启即失效**（回到配置值）。

### 出站只有文本（已知限制）

`outbound.ts` 的 `assistant/message` 分支只取 `text` 块。模型若直接产出
image/file 块会被丢弃——媒体出站走工具路径（`wechat_send_image` 等）。
若要支持模型直接产出媒体块，改 `attachSessionOutbound` 的该分支。

### 命令与工具

- 加命令：`commands.ts` 的 `routeCommand` switch 加 case，并更新 `helpText()`；
  两步菜单复用 `core.ts` 的 `beginPicker` / `resolvePicker`（参考 `/model` `/perm`）。
- 加工具：`src/node/index.ts` 里 `ctx.tools.register(defineTool({...}))`，
  并用 `ctx.effect(() => () => unregister())` 登记清理。

### 会话隔离

桥只处理 `wechat-` 前缀的会话（在 `outbound.ts`、`commands.ts`、`inbound.ts`、
`core.ts` 四处校验）。原因是 web profile 同进程跑着网页 GUI，共享 SessionStore，
不加前缀会串台。

---

## 5. 改配置 / 发布

### 配置

真实生效的配置是**三部分**：profile 的 `cordis.patch.yml`（节点与网关键）+
`WEIXIN_*` 凭据（`pnpm login` 写 `$DSH_HOME/.credentials.yaml`，config 兜底）。

Web 管理页（**设置 → 插件 →「微信桥配置」**）改写的就是 `cordis.patch.yml` 中
`dsh-chatnode-wechat` 这一段：**只改这一段、自动备份、保留注释与其他插件行**。
对应实现是 `src/node/patch-config.ts`，它有一组测试（`test/patch-config.test.ts`，
含「字段元数据覆盖 applyPatchConfig 能写的每个键」这类不变量测试）——
**新增可写配置键时必须同步更新字段元数据，否则该测试会失败**。

### 发布流程

```sh
# 1. 版本号与文档（三处都要改）
#    package.json version、README.md 状态行、README.zh.md 状态行
# 2. 补 CHANGELOG.md（逐条技术变更）
# 3. 补 releases/vX.Y.Z-release-notes.md（面向使用者的发行公告）
# 4. 验证
pnpm build && node --test --test-timeout=15000 --test-force-exit "test/*.test.ts"
# 5. 提交（lib/ 要一起提交）→ 打 tag → 推送
git commit -am "feat: ..." && git tag -a vX.Y.Z -m "..." && git push origin main && git push origin vX.Y.Z
# 6. 建 GitHub Release（网页或 API），正文用 releases/vX.Y.Z-release-notes.md
```

**注意**：`test/*.test.ts` 用 `pnpm test` 跑偶发超时，加
`--test-timeout=15000 --test-force-exit` 更稳（reminder 用例含真实计时器）。

---

## 6. 已知盲区（改动前先看这里）

暂无单测覆盖，改动相关代码时请手动验证或补测试：

- OCR 成功/失败分支
- 语音下载 → ASR 全流程（fake 服务器无该链路）
- 媒体**上行**（`sendImage` / `sendFile` / `sendVideo`），fake 服务器无 `/upload` 路由
- `/send`、`/help`、未知命令、ESP32 灯控（真发 HTTP）、`/早安` 命令级
- 重启 resume（单测里 `factory.resume` 直接 throw）
- **原生图片块本身**：`vision.test.ts` 用 stub 目录覆盖**模式判定**，
  但 `attachments.saveImage` 只在真机跑过

单测覆盖的分布（共 86 项）：gateway 18 / node 24 / markdown 9 / morning 6 /
picker 4 / reminders 4 / patch-config 7 / vision 10 / email 4。

## 7. 环境约束

- **iLink 独占锁**：一个微信 token 只允许**一个**鉴权轮询者。同号跑第二个实例
  或 hermes-agent / OpenClaw 会导致 HTTP 403 + 丢消息。检测到 403 时网关会给出
  致命错误并停止轮询。
- **非官方协议**：细节逆向自 hermes-agent；有真实报文录制样本。腾讯可能限制账号。
- **DSH 是开发者预览版**：`@deepseek-ai/*` 钉在 `0.1.1-rc.2`。升级这些依赖时
  注意 cordis 语义可能变化（尤其 `inject`）。
