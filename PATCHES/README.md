# PATCHES/ — 本目录的来历与使用须知

这些脚本是 **2026-09-15 那轮"管理台多平台化 + 序列化缺陷修复"的可复现记录**，在开发过程中编写、
由维护者复核并做了两处整理：

1. **去掉了写死的机器路径**：原来是 `const FILE = '<某台机器的绝对路径>/admin/server.ts'`，
   现在改成 `(process.argv[2] ?? process.cwd()) + '/...'`，可以这样用：
   ```bat
   cd /d <项目根目录>
   node PATCHES\patch-admin-server.mjs
   node PATCHES\fix-api-ok.mjs
   ```
2. **`fix-scalarline.mjs` 重写了**：原来它还写死了一个**具体机器上的 profile 路径**
   （形如 `<某个 home>/profiles/qq/cordis.patch.yml`）并就地改写那个文件，还把一个具体的
   AppID 当成例子写进注释。现在它只做两件事，且都不依赖机器：
   - 修 `src/node/patch-config.ts` 的 `scalarLine`（按字段 `kind` 判断，已幂等）；
   - 可选地把**你指定**的 patch 文件里裸写的数字标量补上引号：
     `node PATCHES\fix-scalarline.mjs . --requote-patch <某个 cordis.patch.yml>`

## ⚠️ 三条使用须知

1. **这些脚本都已经执行过了**，改动已经落在 `admin/` 与 `src/` 里。它们的价值是**留档与复现**，
   不是"待应用的补丁"。再跑一遍 `patch-admin-server*.mjs` 会因为匹配不到旧行而报
   `NOT FOUND` / 行不匹配 —— 这是**正确行为**，说明它已经生效过。
2. **有编码历史**：`fix-lead-templates.mjs` / `fix-api-ok.mjs` / `patch-admin-server*.mjs` 里的
   匹配载荷（中文模板串）是在一次编码事故之后写的，**可读性差**。它们当时是在 UTF-8 环境下
   按"读进来、原样比、写回去"的方式工作的，所以功能是对的，但**不要**把这些载荷当成
   权威文案 —— 要看最终文案，去看 `admin/index.html` 本身。
3. **不要**把任何 `profiles/*/cordis.patch.yml` 内容抄进脚本或文档里：那是真机配置，
   可能含 AppSecret。`fix-scalarline.mjs` 重写后已经不再碰任何具体 profile。

## 脚本清单

| 脚本 | 作用 | 现状 |
|---|---|---|
| `patch-admin-server.mjs` | `admin/server.ts` 多平台化（80 处替换：`--profiles`、按平台分路径、`/api/platforms`） | 已应用 |
| `patch-admin-server-2.mjs` | 凭据检查平台化（`health()` / `environment()` 按平台查 `WEIXIN_*` 或 `qqAppId/qqAppSecret`） | 已应用 |
| `fix-scalarline.mjs` | `scalarLine` 序列化缺陷修复（+ 可选的 patch 文件补引号） | 已应用；脚本已重写为参数化 |
| `fix-lead-templates.mjs` | 前端概览/连接页 lead 文案的模板插值修复 | 已应用 |
| `fix-api-ok.mjs` | 前端 `api()` 对业务 `ok:false` 的处理 + favicon 404 消除 | 已应用 |

## 与本目录相关的安全修复（2026-09-15 审查）

`admin/server.ts` 的 `?platform=` 曾在**未校验**的情况下进入路径拼接（`patchFor`），
可读/写 `profiles/` 之外的文件。修复内容与回归测试：

- 修复：`parseProfiles()` 白名单字符集 + `patchFor()` 路径围栏 + `platformFrom()` 收口校验
- 测试：`test/admin-platform-guard.test.ts`（未知 platform 必须 4xx、不得泄露其它 profile、
  写入穿越不得改动文件、启动参数非法则拒绝启动）
