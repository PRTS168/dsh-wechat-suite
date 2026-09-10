/**
 * Wrap src/client/index.js into the DSH client-module format expected by
 * lib/client.js: the bundle registers a factory on window.__ModuleLoader__,
 * which the web GUI calls with a `require` for platform seeds (react).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ID = '@dsh-cowork/chatnode-wechat'

const source = readFileSync(resolve(root, 'src/client/index.js'), 'utf8')
if (/\bexport\s+(function|const|default)\b/.test(source)) {
  // The wrapper provides CJS semantics; ESM syntax inside would silently break.
  console.error('src/client/index.js must use CJS/plain script syntax (module.exports / exports.apply)')
  process.exit(1)
}

const bundle = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  source,
  'return module.exports;',
  '} });',
  '',
].join('\n')

mkdirSync(resolve(root, 'lib'), { recursive: true })
writeFileSync(resolve(root, 'lib/client.js'), bundle)
console.log(`built lib/client.js (${Buffer.byteLength(bundle)} bytes)`)
