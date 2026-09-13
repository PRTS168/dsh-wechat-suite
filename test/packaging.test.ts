/**
 * Packaging hygiene.
 *
 * The npm/pnpm package is what a Release asset ships, and it is built from the
 * `files` whitelist in package.json. Whitelisting a whole directory sweeps in
 * everything under it — including files .gitignore protects: adding a bare
 * `"admin"` entry put `admin/.admin-token` (the live console token) and the
 * console's own logs into the tarball. These assertions are the tripwire.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  files?: string[]
  version?: string
}
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')

/** Directories that exist in the repo and must never be swept in whole. */
const NEVER_WHOLE = ['admin']

test('the package whitelist never names a directory that holds secrets', () => {
  const files = pkg.files ?? []
  for (const dir of NEVER_WHOLE) {
    assert.ok(
      !files.includes(dir),
      `package.json 的 files 里不能出现裸目录 "${dir}"：它会把被 gitignore 保护的文件（如 .admin-token、*.log）一起打进包里。请逐个列出要发布的文件。`,
    )
  }
  // The console is a shipped feature, so its files must be listed explicitly.
  for (const file of ['admin/server.ts', 'admin/index.html', 'admin/start-admin.bat', 'admin/README.md']) {
    assert.ok(files.includes(file), `${file} 应该在 files 里（v4.0 的管理台随包发布）`)
    assert.ok(existsSync(join(root, file)), `${file} 不存在`)
  }
})

test('the files that would leak are ignored by git as well', () => {
  for (const pattern of ['admin/.admin-token', 'admin/*.log']) {
    assert.ok(
      gitignore.split('\n').map((line) => line.trim()).includes(pattern),
      `.gitignore 必须包含 ${pattern}（git 安装与本地开发都不该跟踪它）`,
    )
  }
})

test('the released version matches the release notes that document it', () => {
  const version = pkg.version ?? ''
  assert.match(version, /^\d+\.\d+\.\d+$/, `package.json 的 version 不合法：${version}`)
  const major = version.split('.')[0]
  // v4.0 ships as 4.0.0 with a tag of v4.0 (the tag drops the patch for x.0.0).
  const tag = version.endsWith('.0.0') ? `v${major}.0` : `v${version}`
  const notes = join(root, 'releases', `${tag}-release-notes.md`)
  assert.ok(existsSync(notes), `缺少发行说明：releases/${tag}-release-notes.md`)
  const body = readFileSync(notes, 'utf8')
  assert.match(body.split('\n')[0]!, new RegExp(`dsh-chatnode-wechat ${tag.replace('.', '\\.')}`), '发行说明首行要写明版本')
})
