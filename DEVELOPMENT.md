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
| `commands.ts` | 命令表（`routeCommand`）与 help 文案；审批回复先于斜杠判断处理 |
| `light.ts` | ESP32 灯控的**唯一实现**：`/开灯` 系列与 `/gear` 词表共用，`control_esp32_light` 工具亦由此派生 |
| `net.ts` | 共享网络工具：`describeError()` 展开 `error.cause`、`directRequest()` 绕过代理直连（天气/灯控用） |

**桥要接住 `approval/request`，必须 `{ prepend: true, global: true }` 注册**：该事件由
`ctx.waterfall(scopeTarget(agent, agent), 'approval/request', …)` 派发 —— ① 路由作用域过滤可能
让监听器**根本收不到**（`global: true` 表示忽略作用域过滤）；② waterfall 是**先答者胜**，
桌面客户端的应答器（GUI 的「等待审批」卡片）会先占住请求，微信**连被问到的机会都没有**
（`prepend: true` 排到它前面）。两者缺一都会表现为"桥活着、会话事件里有 `approval/asked`、
GUI 卡片悬着、微信一片安静"。

**读宿主可选服务时先确认签名**：`permissionPresets` 是**会话级**的（`current(session)`、
`set(session, name)`，标签用 `optionOf(name)`），曾经按「传事件数组」调用，异常逃出
`routeCommand` 被入站处理器吞掉 —— 表现是命令**完全没反应**。凡是命令分支里调用可选服务，
都要：(1) 按宿主签名传参，(2) 用 try/catch 把失败变成一句回执，绝不能静默。
| `vision.ts` | **图片投递策略**：原生 image 块 vs OCR，含能力探测与拒绝缓存 |
| `email.ts` | `send_email` 的 SMTP 客户端（可注入传输，便于测试） |
| `ocr.ts` / `stt.ts` / `tts.ts` / `image-gen.ts` | 硅基流动媒体模型调用 |
| `reminders.ts` / `morning.ts` | 定时提醒、早安天气 |
| `approvals.ts` | 审批桥（`/yes` `/no`） |
| `memory.ts` | **长期记忆**：`MEMORY.md` 的读写（备份 + 4000 字上限 + 审计日志）、简报注入节奏、每日整理（`consolidateNow`）、`noteCompaction()` |
| `problems.ts` | **问题台账**：被吞掉的失败 → 日志（256KB 轮转）+ 内存台账 + 限流告警 + `/problems` 文案 |
| `context-report.ts` | **`/context`**：读宿主投影缓存（`contextPressure` / `contextBreakdown`）、preset 里的压缩参数，渲染成人话 |
| `patch-config.ts` | `cordis.patch.yml` 读写（v0.3.0 起同时被独立管理台复用） |
| `labels.ts` | 会话徽标与 turn 结束原因文案 |

---

## 2. 构建与测试

```sh
pnpm install
pnpm build          # tsc -p tsconfig.json（src/ → lib/）
pnpm typecheck      # tsc --noEmit
pnpm test           # node --test "test/*.test.ts" —— 255 项，不需要微信账号
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

### ④ 配置键必须四处一致（v4.0 之前这里有一类静默失效）

宿主的加载顺序是：**先用 bundle 的 `src/index.ts` schema 校验 profile patch，再调
`apply()`**。因此一个键如果节点会读、bundle 却没声明，它在 `apply()` 之前就**被宿主丢掉了**——
用户填了、日志里没有、功能永远不生效。

v4.0 之前真实踩到的三处（都已修）：

| 症状 | 真因 |
|---|---|
| `send_email` 永远回"SMTP 未配置"，而 patch 里五项齐全、凭据也能登录成功 | `smtpHost/smtpPort/smtpUsername/smtpPassword/smtpFromName` 只声明在节点侧 |
| `imageInput` / `imageInputModel` 改了没反应 | 同上，bundle schema 里没有 |
| 12 个网关键（`longPollTimeoutMs`、`retryDelayMs`、`maxConsecutiveFailures`、`rateLimitCircuit*`、`sendChunkRetries`、`allowCdnHosts` …）配了等于没配 | `extractGatewayConfig()` 只转发 `baseUrl/cdnBaseUrl/token/accountId` 四个 |

**现在的规则**：节点面的配置键在四处必须一致 —— bundle schema（`src/index.ts`）、`apply()`
转发给节点的键、节点 schema（`src/node/index.ts`）、管理台字段（`src/node/patch-config.ts` 的
`CONFIG_FIELDS`），各 36 个；网关自己的 18 个调优键不在节点面，另外由 `GATEWAY_KEYS` 统一转发
（其中 `pollIdleDelayMs` / `qrPollIntervalMs` 此前连 schema 都没进）。
**新增任何配置键都要同时改这几处**：`test/config-surface.test.ts` 做的是单向差集校验
（节点 schema ⊆ bundle schema、节点 schema ⊆ 转发键、`GATEWAY_KEYS` ⊆ bundle schema 且 ⊆ 网关
schema），另有一份"必须能在管理台里改"的显式清单；漏一处就直接红。

要调网关参数现在直接写在 `dsh-chatnode-wechat` 段下即可（不必再挂 `WechatGateway` 自己的 config）。

### ⑤ 运行时会在仓库根写含凭据的文件

`src/index.ts` 的 `startClient()` 把 `client-config.json` 与 `account.json` 写到
**仓库根**，内含微信 `token` / `account_id` / `sync_buf` **明文**。
两者已列入 `.gitignore`（历史中从未被提交）。**不要在仓库根跑实例后执行 `git add .`。**

### ⑥ 升级到 DSH 0.1.5-rc.2 时的六个断裂点（务必先读）

从 `0.1.1-rc.2` 升到 `0.1.5-rc.2` 时踩到的真实问题。**注意**：升级前那 86 项测试
全绿是**假绿**——它们跑的是本仓库钉住的依赖副本，而线上加载的是宿主的 `0.1.5-rc.2`。

1. **`Session.events` 被移除。** 改为显式快照 API：`snapshotEvents(from?, to?)`
   返回全量不可变快照，`ownEvents()` 只给当前会话自有事件（不含 fork 继承前缀），
   `eventAt(seq)` 取单条。本仓库三处读取（`outbound.ts` 的 `digestLine`、
   `labels.ts` 的 `firstPromptLabel`、`commands.ts` 的 `/status`）都改为
   `snapshotEvents()`。
2. **`dsh-session-title` 新增了对 `sessionProjections` 的依赖**
   （`static inject = ["sessions", "sessionProjections"]`）。宿主缺该服务时它
   **静默不加载**——而它的服务名 `sessionTitle` 又曾在本插件 `inject` 里，于是
   **等待门连锁**：标题服务缺席 → 桥也整个不激活，表现为一批用例集体超时。
   现已把 `sessionTitle` 移出 `inject`，改用 `ctx.get()`，标签回退到首条用户消息。
3. **可选服务不能用属性访问。** cordis 代理对未注入服务的读取会抛
   `cannot get property "X" without inject`；`ctx.get('X')` 才返回 `undefined`。
   排查：
   ```sh
   rg "ctx\.(llm|attachments|sessionTitle|agentDefaultModel|permissionPresets)\b" src
   ```
   本仓库现在对全部可选服务统一用 `ctx.get()`。
4. **schemastery 双实例导致 `TS2742`。** pnpm 里同时存在 3.18.1（顶层直接依赖）
   与 3.18.2（传递依赖）时，`tsc` 无法命名从 `z.object()` 推出的类型，报
   "The inferred type of 'Config' cannot be named without a reference to …"。
   修法：把顶层 pin 升到 `^3.18.2` 消除双实例（不是去加类型注解）。
5. **cordis 也要跟着升。** `0.1.5-rc.2` 整批包要求 peer `^4.0.2`，顶层若还是
   `4.0.1` 会报 unmet peer。cordis 是服务注册表，双实例会破坏服务解析，必须对齐。
   对齐后 `pnpm peers check` 应输出 "No peer dependency issues found"。
6. **`dsh-persona` 的配置键改名了：`text` → `prefix`。** 0.1.5 的 schema 是
   `{ prefix: 必填, suffix, complete, includeRuntimeContext }`，**完全没有 `text` 键**。
   旧 preset（Web 页早期保存过的、以及历史插件 `dsh-wechat` 的 `writePersona()`
   生成的）里那行 `text: |-` 会让 preset 挂载失败：

   ```
   failed to apply loader entry persona (@deepseek-ai/dsh-persona): invalid config:
     $.prefix missing required value (at prefix)
   ```

   表现为微信侧「创建会话失败」，而且**新建的会话日志里只有一行 session 头、
   没有任何消息事件**——这是"preset 挂不上"的特征签名，值得记住。

   两处修法（都已落地）：
   - preset 文件那一行改成 `prefix: |-`，内容不用动；
   - 本仓库曾经的网页人设编辑器只认 `config.text`，保存会把 `prefix:` 写回 `text:`、
     再次弄坏 preset。该编辑器已在 v0.3.0 随 `config-api` 一并移除，现在改 preset
     请直接编辑 `$DSH_HOME/.agent-presets/<名>/`，并保留 `prefix:` 键名。

   排查 preset 是否合法的最快办法——拿宿主 schema 直接校验，不需要启动 dsh：

   ```js
   const { Config } = await import('<宿主>/@deepseek-ai/dsh-persona/lib/index.js')
   Config({ prefix: '你的文本' })   // 缺 prefix 时抛 "$.prefix missing required value"
   ```

**升级流程**（下次 DSH 再升级照做）：

```sh
# 1. 查宿主内嵌包的真实版本 —— 不要看 dsh wrapper 的版本号，两者不同：
#    实测 wrapper 是 0.1.5-rc.1 而内嵌包是 0.1.5-rc.2
#    <宿主>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/package.json
# 2. 把 package.json 里所有 @deepseek-ai/* 的 pin 改到该版本，并升 cordis / schemastery
pnpm install --no-frozen-lockfile
pnpm typecheck        # 这一步会暴露 API 断裂（如 Session.events）
# 3. 修完断裂点后
pnpm test && pnpm build
pnpm peers check      # 应无告警
```

**测试环境的服务面必须跟上宿主。** `test/node.test.ts` 的 `beforeEach` 要挂齐
宿主组合里被依赖的服务——0.1.5 起多了 `@deepseek-ai/dsh-session-projection`
（devDependency）。宿主组合的权威来源是
`<宿主>/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`。

### ⑦ Windows 换行

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

改写 `cordis.patch.yml` 中 `dsh-chatnode-wechat` 这一段的是独立管理台
（`admin/server.ts`，v0.3.0 起；此前是网页设置页）：**只改这一段、自动备份、
保留注释与其他插件行**。对应实现是 `src/node/patch-config.ts`，它有一组测试
（`test/patch-config.test.ts`，含「字段元数据覆盖 applyPatchConfig 能写的每个键」
这类不变量测试）—— **新增可写配置键时必须同步更新字段元数据，否则该测试会失败**。

### 发布流程

```sh
# 1. 版本号与文档（四处都要改）
#    package.json version、README.md / README.zh.md 的版本历史小节
#    （徽章指向 /releases，不必逐版改；历史小节要加当版条目）
# 2. 补 CHANGELOG.md（逐条技术变更）
# 3. 补 releases/vX.Y.Z-release-notes.md（面向使用者的发行公告），
#    并在 releases/README.md 的版本表里加一行
# 4. 验证
pnpm build && node --test --test-timeout=30000 "test/*.test.ts"
# 5. 提交（lib/ 要一起提交）→ 打 tag → 推送
git commit -am "feat: ..." && git tag -a vX.Y.Z -m "..." && git push origin main && git push origin vX.Y.Z
# 6. 建 GitHub Release：正文 = releases/vX.Y.Z-release-notes.md 原样（含首行标题），并上传包 tarball
```

> **推 tag ≠ 发布 Release。** `git push origin vX.Y.Z` 只产生 tag，Releases 页面
> 不会出现这一版。必须额外调一次 API：
>
> ```sh
> # 令牌从 GCM 取（本机已存 PRTS168 的凭据），不要写进任何文件
> TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
> jq -Rn --rawfile body releases/vX.Y.Z-release-notes.md \
>   '{tag_name:"vX.Y.Z", name:"vX.Y.Z — …", body:$body, draft:false, prerelease:false}' \
>   | curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
>       -H 'Accept: application/vnd.github+json' \
>       -d @- https://api.github.com/repos/PRTS168/dsh-wechat-suite/releases
> ```
>
>
> **别忘了上传包 tarball。** README 的"从 Release tarball 装"指向
> `…/releases/download/vX.Y.Z/<name>-<version>.tgz`；历次 Release 都**没有**上传资产，
> 所以那个地址一直是 404。上传（令牌同样只放环境变量，不落盘）：
>
> ```sh
> pnpm pack --pack-destination /tmp          # 产物名 = <name>-<version>.tgz
> REL=$(curl -sS -H "Authorization: Bearer $TOKEN" \
>   https://api.github.com/repos/PRTS168/dsh-wechat-suite/releases/tags/vX.Y.Z | jq -r .id)
> curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
>   -H 'Content-Type: application/gzip' \
>   --data-binary @/tmp/<name>-<version>.tgz \
>   "https://uploads.github.com/repos/PRTS168/dsh-wechat-suite/releases/$REL/assets?name=<name>-<version>.tgz"
> ```
>
> 上传前先确认包里**没有** `admin/.admin-token`、`*.log`（`packaging` 测试守着 `files` 白名单）。
>> 发布后核对：`GET /releases/latest` 返回新 tag，且 `draft=false`
> （列表接口可能命中缓存，用 `/releases/latest` 或加时间戳参数复验）。

**约定**：先补 `CHANGELOG.md`（技术变更），再写一份对应的 `releases/vX.Y.Z-release-notes.md`
（面向使用者的发行公告，正文原样用作 GitHub Release 内容，标题行用**仓库名**加版本，如 `## dsh-wechat-suite vX.Y.Z`
标题行），两者与代码在同一批提交里推上去。文档一律以**使用者**为读者：只写他们需要知道的
行为、配置与升级动作，不写仓库维护过程。

**注意**：个别用例含真实计时器（reminder / 心跳），所以给 `--test-timeout=30000`。
**不要**加 `--test-force-exit`：在 Windows + Node 24 上它会触发 `commands.test.ts` 的
文件级 libuv 断言（`UV_HANDLE_CLOSING`）而报假失败，去掉即全绿。


## 6. 已知盲区（改动前先看这里）

暂无单测覆盖，改动相关代码时请手动验证或补测试：

- OCR 成功/失败分支
- 语音下载 → ASR 全流程（fake 服务器无该链路）
- 媒体**上行**（`sendImage` / `sendFile` / `sendVideo`），fake 服务器无 `/upload` 路由
- `/send`、`/help`、未知命令、ESP32 灯控的**真实 HTTP 往返**（`light.test.ts`
  覆盖模式校验、设备路由与工具定义，但不发真请求）、`/早安` 命令级
- 重启 resume（单测里 `factory.resume` 直接 throw）
- **原生图片块本身**：`vision.test.ts` 用 stub 目录覆盖**模式判定**，
  但 `attachments.saveImage` 只在真机跑过

单测覆盖的分布（共 255 项）：memory 36 / node 33 / context-policy 21 / gateway 18 / light 15 /
commands 11 / vision 10 / problems 10 / approvals 9 / morning 9 / markdown 9 / outbound-guard 8 /
context-report 8 / robustness 8 / patch-config 7 / dedup 6 / inbound-media 6 / config-surface 5 /
resume 5 / user-message-envelope 5 / email 4 / picker 4 / reminders 4 / packaging 3 / boot-safety 1。

`config-surface` 是这一版新增的**结构性**测试：它读源码里的键集做子集校验，
专治"配置键加了一处忘了另一处"（见 §3 ④）。`outbound-guard` 的用例直接取自
2026-09-13 那次模型冒充主人发言的真实事故原文。

## 7. 环境约束

- **iLink 独占锁**：一个微信 token 只允许**一个**鉴权轮询者。同号跑第二个实例
  （或任何其他 iLink 客户端）会导致 HTTP 403 + 丢消息。检测到 403 时网关会给出
  致命错误并停止轮询。
- **协议细节未见于公开文档**：报文格式从既有 iLink 客户端归纳而来，仓库内有合成
  报文样本（`test/fixtures/inbound.ndjson`，无真实账号数据）。改动网关时以样本为准，
  不要凭记忆猜字段编号——`item_list` 的 type、`getuploadurl` 的 `media_type`、
  发送端的 item type 是**三套独立编号**，混用会导致 0 字节或静默失败。
- **DSH 是开发者预览版**：`@deepseek-ai/*` 钉在 `0.1.5-rc.2`（与宿主内嵌版本对齐）。升级这些依赖时
  注意 cordis 语义可能变化（尤其 `inject`）。
- **系统代理会拦掉插件自己的出网请求**：宿主进程里的 `fetch` 若走了代理 dispatcher，而该代理
  不放行 `api.open-meteo.com`，只会得到一句 `TypeError: fetch failed`（真实原因在 `error.cause`）。
  `morning.ts` 因此对天气请求做了两条兜底：`describeError()` 展开 cause 链，`directJson()`
  用 `node:https` 直连重试一次。新增任何外部 HTTP 调用时请照此处理，否则线上只会看到
  "fetch failed" 这种无法定位的报错。
