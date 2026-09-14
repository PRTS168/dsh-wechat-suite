/**
 * QQ 官方机器人的扫码绑定（CLI）。
 *
 * 用法：
 *   node scripts/qq-bind.mjs                 # 建任务、打印链接、轮询到成功
 *   node scripts/qq-bind.mjs --host q.qq.com # 覆盖绑定主机（默认就是它）
 *
 * 拿到 AppID + AppSecret 后会打印出来。**不要把它贴进聊天**：写进你的 profile
 * （管理台 → 连接 → QQ 机器人 AppID / AppSecret），或等我们把它接进 DSH 凭据。
 *
 * 与微信侧的 scripts/login.mjs 同构：都是"平台给一个二维码/链接，用户确认，
 * 脚本把凭证落地"。
 */
import { createBindTask, pollBindResult, BIND_STATUS } from '../src/qq/binding.ts'

const args = process.argv.slice(2)
const host = args.includes('--host') ? args[args.indexOf('--host') + 1] : undefined

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const task = await createBindTask(host ? { host } : {})
console.log('')
console.log('  请用手机 QQ 打开下面这个链接（或扫码）并确认绑定：')
console.log('')
console.log('    ' + task.connectUrl)
console.log('')
console.log(`  task_id: ${task.taskId}（每 ${task.intervalSec} 秒查一次，最多等 5 分钟）`)
console.log('')

const deadline = Date.now() + 5 * 60_000
let lastRaw = null
while (Date.now() < deadline) {
  await sleep(task.intervalSec * 1000)
  let result
  try {
    result = await pollBindResult({ taskId: task.taskId, bindKey: task.bindKey, ...(host ? { host } : {}) })
  } catch (error) {
    // 单次轮询失败不致命：网络抖一下不该让整个绑定作废。
    console.log('  轮询失败，稍后重试：' + (error instanceof Error ? error.message : String(error)))
    continue
  }
  if (result.raw !== lastRaw) {
    lastRaw = result.raw
    console.log(`  状态：${result.raw}（${result.status === 'pending' ? '等待确认' : result.status}）`)
  }
  if (result.status === 'completed') {
    console.log('')
    console.log('  ✅ 绑定成功。把下面两行填进 profile（管理台 → 连接）：')
    console.log('')
    console.log('     平台:      qq')
    console.log('     AppID:     ' + result.appId)
    console.log('     AppSecret: ' + result.appSecret)
    console.log('')
    console.log('  ⚠️ 这段输出里有密钥，别贴到聊天里；用完请清掉终端记录。')
    process.exit(0)
  }
  if (result.status === 'expired') {
    console.error('  ❌ ' + result.message)
    process.exit(1)
  }
  if (result.status === 'error') {
    console.error('  ❌ ' + result.message)
    process.exit(1)
  }
}
console.error(`  ❌ 超时：task_id ${task.taskId}（状态停在 ${lastRaw ?? BIND_STATUS.NONE}）`)
process.exit(1)
