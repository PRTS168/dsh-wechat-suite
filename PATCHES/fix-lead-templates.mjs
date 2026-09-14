import { readFileSync, writeFileSync } from 'node:fs'
const F = (process.argv[2] ?? process.cwd()) + '/admin/index.html'
let s = readFileSync(F, 'utf8')
const old1 = "'先看这一行。绿灯就表示已经能用了——直接在${PL}里给它发消息即可。红灯会告诉你缺什么、去哪儿填。'"
const new1 = '`先看这一行。绿灯就表示已经能用了——直接在${PL}里给它发消息即可。红灯会告诉你缺什么、去哪儿填。`'
const old2 = "'这一页决定\"谁能让它回话\"。只有你填在这里的${PL}账号，它才会理——别人的消息它直接忽略。'"
const new2 = '`这一页决定"谁能让它回话"。只有你填在这里的${PL}账号，它才会理——别人的消息它直接忽略。`'
let n = 0
for (const [o, nu] of [[old1, new1], [old2, new2]]) {
  if (s.includes(o)) { s = s.split(o).join(nu); console.log('fixed:', nu.slice(0, 40)); n++ }
  else console.log('NOT FOUND:', o.slice(0, 40))
}
writeFileSync(F, s, 'utf8')
console.log('total fixed:', n)
