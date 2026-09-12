# wechat-admin · 独立管理台

`dsh-chatnode-wechat` 的独立管理页面：自己的进程、自己的网址（默认
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

## 三个页签

| 页签 | 做什么 | 写不写盘 |
|---|---|---|
| **配置** | 桥接受的全部配置项（分组、必填/可选、secret 掩码、点「显示」才取明文） | 点保存才写：**先备份 → 再原子改写 → 再校验**；`allowFrom` 被清空会被拒绝并回滚 |
| **对话** | 本机 `wechat-*` 会话：标题 / 轮次 / 输出 tokens / 大小 / 最后活动；点开看最近 60 条消息 | **只读**，不碰会话文件 |
| **上下文方案** | 6 个预置方案一键切换，写入 `contextPolicy` | 点方案才写（同样备份 + 校验） |

## 上下文方案

| id | 说明 |
|---|---|
| `manual` | 不自动轮换（默认） |
| `rotate-turns` | 每 N 轮（默认 20）空闲时换会话并播报 |
| `rotate-turns+handoff` | 同上 + 换会话前产出要点交接，注入新会话 |
| `rotate-pressure` | 按会话事件大小（默认 40 万字符窗口的 60%）触发 |
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
- 配置值坏掉时降级为 `manual`：空值 / 非法 JSON / 未知方案一律回落到默认，
  配置永远不会让桥起不来。

## 安全边界

- 只监听回环地址；所有 `/api/*` 需要 token（`x-admin-token` 头或 `?token=`）。
- 变更类请求还需要 `x-wechat-admin: 1` 守卫头，避免被跨站表单误触；`Host` 必须是
  回环地址，DNS rebinding 页面因此够不到它。
- 每次写入都留备份（`cordis.patch.yml.bak-*`），页面上会显示本次备份文件名。
- 明文 secret 只在显式点「显示」时返回，且不进日志。
- 会话数据全为本机只读；管理台不接触 iLink、不持有微信 token。
- `admin/.admin-token` 已被 git 忽略，不要提交。

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
