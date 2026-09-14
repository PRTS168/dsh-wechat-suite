/**
 * 修 YAML 标量序列化：**字符串型**的"数字形"值必须保持带引号。
 *
 * 缺陷（真实存在，曾让 QQ profile 起不来）：
 *   scalarLine 原来是 `/^-?\d+$/.test(v) ? v : yamlStr(v)`，
 *   于是 `qqAppId: "1234567890"` 这种"值是纯数字的字符串"被裸写成
 *   `qqAppId: 1234567890`（YAML **数字**），插件 schema 要求 string →
 *   `DSH entry failed: expected string but got 1234567890`。
 *
 * 修法：按字段表里的 `kind` 决定 —— `number` / `boolean` 才裸写，其余一律加引号。
 *
 * 用法：
 *   node fix-scalarline.mjs [项目根目录]           # 只修源码
 *   node fix-scalarline.mjs [项目根目录] --requote-patch <某个 cordis.patch.yml 的路径>
 *
 * 第二个参数是可选的：把**指定文件**里被裸写的数字形值加回引号。
 * 它不再写死任何机器路径，也不再认某个具体的 AppID —— 只要值本身是
 * `数字形字符串`，就把引号补上；认不出目标就明确报错退出，不猜。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const root = process.argv[2] ?? process.cwd()
const SRC = root + '/src/node/patch-config.ts'

const lines = readFileSync(SRC, 'utf8').split(/\r?\n/)
if (lines[lines.length - 1] === '') lines.pop()

const newLines = [
  `  const scalarLine = (key: string, v: string): string => {`,
  `    const field = CONFIG_FIELDS.find((f) => f.key === key)`,
  `    const bare = field?.kind === 'number' || field?.kind === 'boolean'`,
  `    return \`\${ind}\${key}: \${bare ? v : yamlStr(v)}\``,
  `  }`,
]
const idx = lines.findIndex((l) => l.includes('const scalarLine'))
if (idx < 0) {
  console.error('scalarLine 没找到（源码结构变了？）—— 什么都没改')
  process.exit(1)
}
const actual = lines[idx]
if (!actual.includes('scalarLine') || !actual.includes('yamlStr')) {
  console.error('那一行不是预期的形状，拒绝改：', actual)
  process.exit(1)
}
if (actual.trim().startsWith('const scalarLine = (key: string, v: string): string => {')) {
  console.log('scalarLine 已经是修好的形状，跳过')
} else {
  lines.splice(idx, 1, ...newLines)
  writeFileSync(SRC, lines.join('\r\n') + '\r\n', 'utf8')
  console.log('已修 scalarLine（源码第', idx + 1, '行）')
}

// ── 可选：把目标 patch 里被裸写的数字形字符串值补回引号 ────────────────────
const flagAt = process.argv.indexOf('--requote-patch')
if (flagAt < 0) {
  console.log('（未传 --requote-patch：跳过对现有 patch 文件的修补）')
  process.exit(0)
}
const target = process.argv[flagAt + 1]
if (!target) {
  console.error('--requote-patch 后面要给一个 cordis.patch.yml 的路径')
  process.exit(1)
}

const pl = readFileSync(target, 'utf8').split(/\r?\n/)
let fixed = 0
for (let i = 0; i < pl.length; i += 1) {
  // `键: 123456` —— 裸写的数字标量。改成带引号的字符串。
  const m = /^(\s*[\w.-]+:\s*)(-?\d+)\s*$/.exec(pl[i] ?? '')
  if (!m) continue
  pl[i] = `${m[1]}"${m[2]}"`
  fixed += 1
}
if (fixed === 0) {
  console.log('目标文件里没有裸写的数字标量，无需修补：', target)
  process.exit(0)
}
writeFileSync(target, pl.join('\r\n') + '\r\n', 'utf8')
console.log(`已给 ${fixed} 处裸写数字补上引号：`, target)
console.log('提示：改完请让那个 profile 重启一次，确认不再出现 expected string but got …')
