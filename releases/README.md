# 版本发行说明

每个版本一份，与该版本的 tag 对应。这些文件的正文就是 GitHub Release 页面的内容。

| 版本 | 说明 | 主题 |
|---|---|---|
| [v0.2.2](./v0.2.2-release-notes.md) | 2026-09 | **适配 DeepSeek 4.1 多模态**：原生图片输入（与 OCR 可切换、`/识图` 命令）、`send_email`、凭据加固 |
| [v0.2.1](./v0.2.1-release-notes.md) | 2026-09 | Web 管理页（微信桥配置）与人设在线编辑 |
| [v0.2.0](./v0.2.0-release-notes.md) | 2026-09 | `/perm` 接线、`pnpm setup` 向导、双向文件与视频、入站时间戳 |

完整变更历史见 [`../CHANGELOG.md`](../CHANGELOG.md)；功能与用法见
[`../README.md`](../README.md)。

## 为什么同时存在 CHANGELOG 和这些文件

两者用途不同，不是重复：

- **`CHANGELOG.md`** —— 按 Keep a Changelog 组织的技术变更记录，逐条列
  Added / Changed / Fixed，给升级的人看。
- **`releases/vX.Y.Z-release-notes.md`** —— 面向使用者的发布公告，讲这个版本
  为什么值得升级、怎么升级、有什么坑，直接用作 GitHub Release 正文。

新增版本时的约定：先补 `CHANGELOG.md`，再写一份对应的 release notes，
两者在同一批提交里推上去。
