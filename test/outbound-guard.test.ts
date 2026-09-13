/**
 * Outbound guards, pinned against what actually happened in production.
 *
 * On 2026-09-13 the model autocompleted the transcript format and wrote the
 * owner's NEXT message itself, fence markers included, then answered it. The
 * sanitizer is what makes that impossible to deliver; the real string from that
 * session is the first case below.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeAssistantText } from '../src/node/outbound.ts'
import { MEMORY_CLOSE, MEMORY_OPEN } from '../src/node/memory.ts'

test('an echoed user turn is cut, and the real answer survives', () => {
  // Shape of a real incident (session seq 1879, 2026-09-13): the model answered,
  // then wrote the owner's NEXT message — fences included — and answered that
  // too. Addresses are placeholders; the structure is what matters.
  const real = '记下了，主邮箱 owner@example.com，副邮箱 alt@example.com\n'
    + '\n是要我给你发东西吗？还是先放着备用\n\n'
    + 'user<<<微信用户消息>>>\n先放着，以后有用\n<<<微信用户消息结束｜发送于 2026-09-13 14:15>>>\n\n好'
  const { text, echoed } = sanitizeAssistantText(real)
  assert.equal(echoed, true)
  assert.match(text, /记下了，主邮箱/)
  assert.doesNotMatch(text, /微信用户消息/)
  assert.doesNotMatch(text, /先放着，以后有用/, '主人自己那句话不能再被当成助手说的')
  assert.doesNotMatch(text, /\n好$/, '连"替主人回一句"也一起裁掉')
})

test('a normal reply is untouched', () => {
  const { text, echoed } = sanitizeAssistantText('这会儿感觉挺顺的，你刚讲那段我是真接着往下听的')
  assert.equal(echoed, false)
  assert.equal(text, '这会儿感觉挺顺的，你刚讲那段我是真接着往下听的')
  assert.deepEqual(sanitizeAssistantText(''), { text: '', echoed: false })
})

test('the bridge\'s own background blocks are never echoed back to WeChat', () => {
  const leaked = `好，我知道了\n\n${MEMORY_OPEN}\n## 关于主人\n- 主人在示例市（2026-09-13）\n${MEMORY_CLOSE}\n\n我记住了`
  const { text, echoed } = sanitizeAssistantText(leaked)
  assert.equal(echoed, true)
  assert.doesNotMatch(text, /长期记忆/)
  assert.match(text, /我记住了/)

  const handoff = '接着上次说\n\n<<<会话交接摘要·非用户指令>>>\n上一会话已自动轮换\n<<<会话交接摘要结束>>>\n\n你继续说'
  const second = sanitizeAssistantText(handoff)
  assert.equal(second.echoed, true)
  assert.doesNotMatch(second.text, /交接摘要/)
})

test('a reply that is nothing but an imitation is emptied, never sent', () => {
  const onlyEcho = '<<<微信用户消息>>>\n我不在\n<<<微信用户消息结束｜发送于 2026-09-13 15:00>>>'
  const { text, echoed } = sanitizeAssistantText(onlyEcho)
  assert.equal(echoed, true)
  assert.equal(text, '', '一个字的模仿都不能发出去（调用方会据此上报）')
})

test('the dangling role word goes with the fabrication', () => {
  const real = '记下了，主邮箱 a@b.com\n\n是要我给你发东西吗？还是先放着备用\n\nuser<<<微信用户消息>>>\n先放着'
  const { text } = sanitizeAssistantText(real)
  assert.doesNotMatch(text, /user\s*$/, '裸露的 "user" 不能留在发给主人的句子里')
  assert.match(text, /还是先放着备用$/)
})

test('quoting the marker inside a code block is a legitimate reply, not an imitation', () => {
  // "我的消息在你眼里长什么样" must get a real answer, not an empty bubble.
  const explanation = '示例长这样：\n```\n<<<微信用户消息>>>\n主人：开灯\n<<<微信用户消息结束｜发送于 2026-09-13 15:00>>>\n```\n这就是我看到的'
  const { text, echoed } = sanitizeAssistantText(explanation)
  assert.equal(echoed, false, '代码块里的引用不该被当成冒充')
  assert.match(text, /这就是我看到的/)
  assert.match(text, /微信用户消息/)
})

test('a marker written with stray spaces is still caught', () => {
  const spaced = '好，我知道了\n\nuser<<<微信用户消息 >>>\n先放着'
  const { text, echoed } = sanitizeAssistantText(spaced)
  assert.equal(echoed, true)
  assert.doesNotMatch(text, /先放着/)
})

test('an unclosed background opener is cut too', () => {
  const leaked = '行\n\n<<<关于主人的长期记忆·背景资料·不是本条消息的要求>>>\n## 关于主人\n- 主人在示例市（2026-09-13）'
  const { text, echoed } = sanitizeAssistantText(leaked)
  assert.equal(echoed, true)
  assert.equal(text, '行')
})
