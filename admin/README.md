# wechat-admin · 独立管理台

微信桥（插件 id `dsh-chatnode-wechat`）的独立管理页面：自己的进程、自己的网址（默认
`http://127.0.0.1:8790`），用来管理配置、查看对话、一键切换上下文管理方案。

## 为什么是独立进程

作为插件行实现的管理 API 必须挂进 profile 的插件树，并依赖可选的 `webServer` 服务；
该服务不存在时这一行无法激活，宿主会判定**整个 profile 启动失败**。做成独立进程后，
它与 profile 组合无关：关掉它不影响桥，桥出问题也不影响它，宿主启动也不会被它拖累。

## 运行

```bat
admin\start-admin.bat
```

或手动（Node 22+，需要能直接运行 TS 的类型擦除）：

```bash
DSH_HOME=<你的 DSH_HOME> node admin/server.ts --profile <profile> --port 8790
```

启动时会打印带 token 的网址；**token 首次运行生成并写进 `admin/.admin-token`**
（也可用环境变量 `WECHAT_ADMIN_TOKEN` 覆盖）。只监听 `127.0.0.1`。

## 两个模式，七个分区

页面左上角切换**新手模式 / 高级模式**（选择记在浏览器里）：

| 模式 | 面向 | 分区 |
|---|---|---|
| **新手模式** | 不熟配置的人 | 概览（8 项体检，每项带"怎么解决"）/ 谁能跟我说话（白名单）/ 用哪个大脑（模型下拉）/ 它记不记得住（记忆 + 整理时间）/ 聊久了怎么办（两个白话选项）/ 出问题了（日志原文） |
| **高级模式** | 要全部控制的人 | 上述全部 + 连接与凭据 / 全部 36 个配置键（分组）/ 上下文方案的参数微调与原始 JSON / 对话与转录 / 诊断与备份回滚 |

写盘的只有三处，且都有备份 + 校验：

| 动作 | 写什么 | 保护 |
|---|---|---|
| 保存配置 | profile patch 的对应键（只提交**改动过**的项） | 先备份 → 原子改写 → 再校验；`allowFrom` 被清空、配置文件读不出来、数字字段非整数一律**拒绝并回滚** |
| 应用上下文方案 | `contextPolicy` | 同上；`overrides` 只接受该方案声明的键与类型 |
| 回滚备份 | 用某份 `.bak-*` 覆盖当前配置 | 回滚前先把当前配置另存一份，因此回滚本身也可回滚 |
| 新建/遗忘会话 | `$DSH_HOME/wechat-admin/queue/` 队列 | 由桥执行；遗忘 = 移入 `sessions-trash/`，可手动恢复 |

## 上下文方案

| id | 说明 |
|---|---|
| `manual` | 不自动轮换（**默认**：一个对话一直用下去） |
| `rotate-turns` | 每 N 轮（默认 20）空闲时换会话并播报 |
| `rotate-turns+handoff` | 同上 + 换会话前产出要点交接，注入新会话 |
| `rotate-pressure` | 按上下文占用（默认窗口的 60%）触发 |
| `rotate-tokens` | 按自设 token 预算触发，优先使用宿主会话投影的真实 token 数 |
| `daily` | 空闲达到 N 小时（默认 8）后开新会话 |

方案以 `contextPolicy` 落入 profile patch，例如：

```yaml
contextPolicy: '{"scheme":"rotate-turns","turns":20,"idleOnly":true,"announce":true,"handoff":false}'
```

轮换行为：

- 只在 `turn/end` 上评估，并在动手前**再查一次**是否空闲 —— 排队中的微信消息可能已经
  开启下一轮，此时轮换会把正在跑的回合拦腰截断；
- 轮换复用与 `/new` 完全相同的建会话路径，因此只有一个地方创建微信会话，也不会出现
  两个 agent 指向同一个聊天；
- `handoff` 的交接摘要**不额外调用模型**（从会话事件里确定性摘录最近几条），用**独立**
  定界标记并写明「不是用户的新指令」，所以不会被人设规则当成指令；
- `announce: false` 时静默轮换（不往微信发提示）；
- 配置值坏掉时降级为 `manual`（并记进问题台账）：空值 / 非法 JSON / 未知方案一律回落默认，
  配置永远不会让桥起不来。

> [!TIP]
> v4.0 起默认就是 `manual`，并且建议把宿主的压缩参数显式写成
> `thresholdRatio 0.65 / retainRatio 0.25` —— 详见
> [`../releases/v4.0-release-notes.md`](../releases/v4.0-release-notes.md) 第一节。

## 安全边界

- 只监听回环地址；所有 `/api/*` 需要 token（`x-admin-token` 头或 `?token=`）。
- 变更类请求还需要 `x-wechat-admin: 1` 守卫头，避免被跨站表单误触；`Host` 必须是
  回环地址，DNS rebinding 页面因此够不到它。
  （v4.0 修：这个守卫头以前写在两条 token 分支**之后**，是永远不会执行到的死代码 ——
  写操作实际上只有 token 单因子。）
- 配置文件**存在但读不出来**时显示为不可读状态并禁用保存 —— 否则一次保存会从零重写
  patch，把其它插件的条目一起带走。（v4.0 修）
- 每次写入都留备份（`cordis.patch.yml.bak-*`），页面上会显示本次备份文件名；备份按
  **修改时间**保留最近 5 份。（v4.0 修：以前按文件名字符串排序，删掉的可能反而是新的）
- 数字字段服务端二次校验：把 `25 分钟` 写进整数字段会让插件 schema 校验失败、
  整个 profile 起不来，现在这类值会被 400 拒绝。（v4.0 修）
- 明文 secret 只在显式点「显示」时返回，且不进日志；保存响应不再回显明文密钥。
- 会话数据全为本机只读；管理台不接触 iLink、不持有微信 token。
- `admin/.admin-token` 已被 git 忽略，不要提交；发布包（`package.json` 的 `files`）
  只逐个列出管理台的四个文件，避免把 token 与日志打进 tarball（`packaging` 测试守着）。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 管理页面（需 `?token=`） |
| GET | `/api/state` | 字段定义 + 当前值（secret 掩码）+ 环境自检 + 会话摘要 + 方案列表 |
| POST | `/api/config` | 写入配置：`{ updates: { key: string \| null } }` |
| GET | `/api/reveal?key=` | 取单个 secret 字段明文 |
| POST | `/api/scheme` | 切换方案：`{ scheme, overrides? }` → 写入 `contextPolicy` |
| GET | `/api/conversations` | `wechat-*` 会话列表 |
| GET | `/api/transcript?id=&limit=` | 会话转录（多帧 zstd 逐帧解压） |
| POST | `/api/session/new` | 新建微信会话（写入控制队列，由桥执行） |
| POST | `/api/session/forget` | 遗忘会话（可恢复：移入 `$DSH_HOME/sessions-trash/`） |
| GET | `/api/session/box` | 桥最近的控制执行回报 |
| GET | `/api/health` | 8 项体检：配置文件 / 白名单 / 人设 / 微信凭据 / 媒体 Key / 长期记忆 / 最近 24h 问题 / 聊天模型；每项带 `state`、说明与"怎么解决" |
| GET | `/api/problems?limit=` | 问题台账原文（`$DSH_HOME/wechat-problems.log`，含轮转标记） |
| GET | `/api/memory` | 长期记忆文件内容、事实条数、路径 |
| GET | `/api/models` | 从 `$DSH_HOME/settings.yaml` 读出真实模型列表 + 第三方中转名 + 当前选择 |
| GET | `/api/backups` | patch 备份列表（按修改时间倒序，含时间与大小） |
| POST | `/api/rollback` | 回滚到某份备份：`{ name }`；回滚前先把当前配置另存一份 |

> 所有写接口都要同时带 `x-admin-token` 与 `x-wechat-admin: 1`。
