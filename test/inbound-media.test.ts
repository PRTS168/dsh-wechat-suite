/**
 * Silent-drop regression tests for inbound media.
 *
 * A media message whose download produced no bytes used to `return` without a
 * log line and without telling the sender: nothing on disk, nothing in the log,
 * nothing in WeChat. That is indistinguishable from "the message never arrived"
 * — and it is the gap a fabricated "the inbound video never landed on disk"
 * report lived in comfortably. Every drop now reports on both planes.
 *
 * A second, subtler failure these tests pin down: the failure paths used to run
 * BEFORE `node.peerId` was assigned, and `sendTextToPeer` is a no-op without a
 * peer — so the notices were written into the void even after they existed.
 *
 * The claim under test is deliberately narrow: given a media message the bridge
 * cannot fetch, it must (a) log a line naming the kind, and (b) say something to
 * the sender. Whether the media *should* have been fetchable is not asserted.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ITEM_FILE, ITEM_IMAGE, ITEM_VIDEO } from '../src/gateway/types.ts'
import { handleInbound } from '../src/node/inbound.ts'

/** printf-style substitution, matching what the host logger does with `%s`. */
function format(args: unknown[]): string {
  const [template, ...rest] = args
  let i = 0
  return String(template).replace(/%[sd]/g, () => String(rest[i++] ?? ''))
}

interface Harness {
  node: unknown
  sent: string[]
  warnings: string[]
}

/** A conversation-node stub covering exactly what the media paths touch. */
function harness(): Harness {
  const sent: string[] = []
  const warnings: string[] = []
  const wechat = {
    sendTyping: async () => {},
    sendText: async (_peer: string, text: string) => {
      sent.push(text)
      return { success: true }
    },
    // Every download returns nothing: the case that used to vanish.
    downloadAttachment: async () => null,
    downloadImage: async () => null,
  }
  const logger = { warn: (...args: unknown[]) => warnings.push(format(args)), info: () => {} }
  const node = {
    peerId: undefined as string | undefined,
    gatewayAccountId: 'bot@im.bot',
    config: { maxMessageChars: 4000, sendChunkDelayMs: 0 },
    isAllowed: () => true,
    ctx: {
      logger,
      // The outbound path reads its service with `ctx.get('wechat')` (property
      // access throws on a torn-down context), so the stub has to answer `get`.
      get: (name: string) => (name === 'wechat' ? wechat : name === 'logger' ? logger : undefined),
      wechat,
    },
  }
  return { node, sent, warnings }
}

/** A media block carrying the fields the extractors look for. */
function media(): Record<string, string> {
  return { encrypt_query_param: 'eqp-1', full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=1' }
}

// No `to_user_id` in any message below: isGroupMessage() must not classify
// these as room messages (msg_type 1 + a foreign to_user_id would).

test('an inbound video that yields no bytes is reported, not dropped', async () => {
  const { node, sent, warnings } = harness()
  await handleInbound(
    node as never,
    { from_user_id: 'wxid_ok', item_list: [{ type: ITEM_VIDEO, video_item: { media: media() } }] } as never,
  )
  assert.deepEqual(sent, ['❌ 视频下载失败，请重试。'])
  assert.ok(warnings.some((line) => line.includes('video inbound dropped')), warnings.join(' | '))
})

test('an inbound file that yields no bytes is reported, not dropped', async () => {
  const { node, sent, warnings } = harness()
  await handleInbound(
    node as never,
    { from_user_id: 'wxid_ok', item_list: [{ type: ITEM_FILE, file_item: { media: media(), file_name: 'a.txt' } }] } as never,
  )
  assert.deepEqual(sent, ['❌ 文件下载失败，请重试。'])
  assert.ok(warnings.some((line) => line.includes('file inbound dropped')), warnings.join(' | '))
})

test('an inbound image that yields no bytes is reported, not dropped', async () => {
  const { node, sent, warnings } = harness()
  await handleInbound(
    node as never,
    { from_user_id: 'wxid_ok', item_list: [{ type: ITEM_IMAGE, image_item: { media: media() } }] } as never,
  )
  assert.deepEqual(sent, ['❌ 图片下载失败，请重试。'])
  assert.ok(warnings.some((line) => line.includes('image inbound dropped')), warnings.join(' | '))
})

test('a media-only message of an unknown item type is reported, not dropped', async () => {
  const { node, sent, warnings } = harness()
  await handleInbound(
    node as never,
    { from_user_id: 'wxid_ok', item_list: [{ type: 9, unknown_item: {} }] } as never,
  )
  assert.deepEqual(sent, ['❌ 这条消息暂时无法处理（类型 9）。'])
  assert.ok(warnings.some((line) => line.includes('unsupported inbound dropped')), warnings.join(' | '))
})

test('a file item with no media payload names its item type instead of vanishing', async () => {
  const { node, sent, warnings } = harness()
  await handleInbound(
    node as never,
    { from_user_id: 'wxid_ok', item_list: [{ type: ITEM_FILE, file_item: {} }] } as never,
  )
  assert.deepEqual(sent, [`❌ 这条消息暂时无法处理（类型 ${ITEM_FILE}）。`])
  assert.ok(warnings.some((line) => line.includes('unsupported inbound dropped')), warnings.join(' | '))
})

test('a /help command still works and reports no media drop', async () => {
  const { node, sent, warnings } = harness()
  await handleInbound(
    node as never,
    { from_user_id: 'wxid_ok', item_list: [{ type: 1, text_item: { text: '/help' } }] } as never,
  )
  assert.equal(sent.length, 1, 'the /help command should answer exactly once')
  assert.ok(!warnings.some((line) => line.includes('inbound dropped')), warnings.join(' | '))
})
