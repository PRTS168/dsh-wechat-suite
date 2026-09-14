import { readFileSync, writeFileSync } from 'node:fs'
const F = (process.argv[2] ?? process.cwd()) + '/admin/index.html'
let s = readFileSync(F, 'utf8')
let n = 0

// 1) api(): 业务 ok:false 不再是错误（health 的 ok 字段就是业务态）；仅 HTTP 失败或带 error 的业务失败才抛
const old1 = `  const r = await fetch(url, { headers: H, ...opts });
  const j = await r.json().catch(() => ({ ok: false, error: 'bad json' }));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;`
const new1 = `  const r = await fetch(url, { headers: H, ...opts });
  const j = await r.json().catch(() => ({ ok: false, error: 'bad json' }));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  if (j.ok === false && j.error) throw new Error(j.error);
  return j;`
if (s.includes(old1)) { s = s.split(old1).join(new1); console.log('fixed api()'); n++ }
else console.log('NOT FOUND api()')

// 2) favicon：内联 data: URI，避免 404 红字
const old2 = '<title>桥管理台</title>'
const new2 = '<title>桥管理台</title>\n<link rel="icon" href="data:,">'
if (s.includes(old2)) { s = s.split(old2).join(new2); console.log('fixed favicon'); n++ }
else console.log('NOT FOUND favicon')

writeFileSync(F, s, 'utf8')
console.log('total:', n)
