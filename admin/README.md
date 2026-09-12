# wechat-admin · 独立管理台

给 `dsh-chatnode-wechat` 用的**独立**管理页面：自己的进程、自己的网址（默认
`http://127.0.0.1:8790`），管理配置、查看对话、一键切换上下文管理方案。

## 为什么是独立进程，而不是插件行

插件形态的管理 API 必须作为 loader 行写进 profile 的插件树。它依赖可选的
`webServer` 服务，而一旦该服务不出现，这一行就永远 pending，`dsh-app-boot`
会因此**判整个 profile 启动失败**：

```
Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
@dsh-cowork/chatnode-wechat/config-api: pending (waiting for service: webServer)
```

这是 2026-09-12 之前线上真实发生过的事故。做成独立进程后：它与 profile 组合无关，
关掉它不影响桥，桥出问题也不影响它，宿主启动更不可能被它拖死。

## 运行

```bat
admin\start-admin.bat
```

或手动（任意 node 22+，需要能直接跑 TS 的类型擦除）：

```bash
DSH_HOME=%APPDATA%\dsh-desktop\harness node admin/server.ts --profile web --port 8790
```

启动时会打印带 token 的网址；**token 首次运行生成并写进 `admin/.admin-token`**
（也可用环境变量 `WECHAT_ADMIN_TOKEN` 覆盖）。只监听 `127.0.0.1`。

## 三个页签

| 页签 | 做什么 | 写不写盘 |
|---|---|---|
| **配置** | 桥接受的全部配置项（分组、必填/可选、secret 掩码、点「显示」才取明文） | 点保存才写：**先备份 → 再原子改写 → 再校验**；`allowFrom` 被清空会被拒绝并回滚 |
| **对话** | 本机 `wechat-*` 会话：标题 / 轮次 / 输出 tokens / 大小 / 最后活动；点开看最近 60 条消息 | **只读**，不碰会话文件 |
| **上下文方案** | 5 个预置方案一键切换，写入 `contextPolicy` | 点方案才写（同样备份 + 校验） |

## 上下文方案

| id | 说明 |
|---|---|
| `manual` | 现状：不自动轮换（长会话漂移的土壤） |
| `rotate-turns` | 每 N 轮（默认 20）空闲时换会话并播报 |
| `rotate-turns+handoff` | 同上 + 换会话前产出要点交接，注入新会话 |
| `rotate-pressure` | 按 DSH 投影的上下文占用（默认 60%）触发 |
| `daily` | 每天第一条消息开新会话（idleHours 8） |

方案以 `contextPolicy` 落入 profile patch，例如：

```yaml
contextPolicy: '{"scheme":"rotate-turns","turns":20,"idleOnly":true,"announce":true,"handoff":false}'
```

**桥侧已实现**（`src/node/context-policy.ts` + `core.ts` 的 `attachContextRotation`）：

- 只在 `session/event` 的 `turn/end` 上评估，并在动手前**再查一次**是否空闲——
  排队中的微信消息可能已经开启下一轮，此时轮换会把正在跑的回合拦腰截断；
- 轮换复用与 `/new` 完全相同的 `createSession()` 路径，因此永远只有一个地方创建
  微信会话，也不会出现两个 agent 指向同一个聊天；
- `handoff` 的交接摘要**不额外调用模型**（从会话事件里确定性摘录最近几条），
  用**独立**定界标记并写明"不是用户的新指令"，所以不会被人设硬规则当成指令；
- `announce: false` 时静默轮换（不往微信发提示）；
- 配置值坏掉时降级为 `manual`：`parseContextPolicy()` 对空/非法 JSON/未知方案
  一律回落到默认，配置永远不会让桥起不来。

## 安全边界

- 只监听回环地址；所有 `/api/*` 需要 token（`x-admin-token` 头或 `?token=`）。
- 变更类请求还需要 `x-wechat-admin: 1` 守卫头，避免被跨站表单误触。
- 每次写入都留备份（`cordis.patch.yml.bak-*`），页面上会显示本次备份文件名。
- 明文 secret 只在显式点「显示」时返回，且不进日志。
- 会话数据全为本机只读；管理台不接触 iLink、不持有微信 token。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 管理页面（需 `?token=`） |
| GET | `/api/state` | 字段定义 + 当前值（secret 掩码）+ 环境自检 + 会话摘要 + 方案列表 |
| POST | `/api/config` | `{ updates: { key: string \| null } }` |
| GET | `/api/reveal?key=` | 取单个 secret 字段明文 |
| GET | `/api/conversations` | `wechat-*` 会话列表 |
| GET | `/api/transcript?id=&limit=` | 会话转录（多帧 zstd 逐帧解压） |
| POST | `/api/scheme` | `{ scheme, overrides? }` → 写入 `contextPolicy` |
