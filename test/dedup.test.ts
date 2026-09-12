/**
 * Inbound dedup fallback.
 *
 * iLink does not always send a `message_id` — the 2026-09-12 duplicate replies
 * came from exactly that: a voice note with no id was dispatched twice, six to
 * nine seconds apart, and the second answer complained that the owner had
 * repeated themselves. The gateway used to skip dedup entirely when the id was
 * missing; it now falls back to a payload identity with a short TTL.
 *
 * These tests pin the identity's properties, not the gateway wiring: same payload
 * → same key, different payload → different key, nothing identifying → no key.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { CONTENT_DEDUP_TTL_SECONDS, MESSAGE_DEDUP_TTL_SECONDS, inboundContentKey } from '../src/gateway/types.ts'

const voiceNote = {
  from_user_id: 'wxid_owner',
  item_list: [{ type: 3, voice_item: { text: '列出现在你可以用的工具' } }],
}

test('a redelivered payload produces the same key', () => {
  const first = inboundContentKey(voiceNote as never)
  const redelivery = inboundContentKey(JSON.parse(JSON.stringify(voiceNote)) as never)
  assert.ok(first)
  assert.equal(first, redelivery)
})

test('genuinely different messages produce different keys', () => {
  const other = inboundContentKey({
    from_user_id: 'wxid_owner',
    item_list: [{ type: 3, voice_item: { text: '帮我看看灯是几档' } }],
  } as never)
  assert.notEqual(inboundContentKey(voiceNote as never), other)
})

test('the sender is part of the identity', () => {
  const fromOther = inboundContentKey({ ...voiceNote, from_user_id: 'wxid_someone' } as never)
  assert.notEqual(inboundContentKey(voiceNote as never), fromOther)
})

test('media pointers distinguish otherwise identical items', () => {
  const withMedia = (pointer: string) =>
    inboundContentKey({
      from_user_id: 'wxid_owner',
      item_list: [{ type: 2, image_item: { media: { encrypt_query_param: pointer } } }],
    } as never)
  assert.ok(withMedia('eqp-a'))
  assert.notEqual(withMedia('eqp-a'), withMedia('eqp-b'))
})

test('a payload with nothing identifying has no key (pass through, do not guess)', () => {
  assert.equal(inboundContentKey({ from_user_id: 'wxid_owner', item_list: [] } as never), undefined)
  assert.equal(inboundContentKey({ from_user_id: 'wxid_owner' } as never), undefined)
  assert.equal(
    inboundContentKey({ from_user_id: 'wxid_owner', item_list: [{ type: 1, text_item: { text: '' } }] } as never),
    undefined,
  )
})

test('the payload window is short; the id window stays long', () => {
  assert.ok(CONTENT_DEDUP_TTL_SECONDS >= 15 && CONTENT_DEDUP_TTL_SECONDS <= 60, 'long enough for a 6–9s redelivery, short enough for a real repeat')
  assert.ok(MESSAGE_DEDUP_TTL_SECONDS > CONTENT_DEDUP_TTL_SECONDS)
})
