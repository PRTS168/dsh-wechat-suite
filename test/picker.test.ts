/**
 * Two-step picker (/model, /perm) unit tests. Exercises the picker state
 * machine and model/permission switching with stubbed services — no WeChat
 * account, no live llm provider.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { WechatConversationNode } from '../src/node/core.ts'
import { routePickerReply } from '../src/node/commands.ts'

/** Build a node with stub wechat/llm/permissionPresets and a readable send log. */
function buildNode(): { node: WechatConversationNode; sent: Array<{ to: string; text: string }> } {
  const ctx = new Context()
  const sent: Array<{ to: string; text: string }> = []
  const provide = (k: string, v: unknown) => (ctx as unknown as { provide: (k: string, v: unknown) => void }).provide(k, v)

  provide('wechat', {
    accountId: 'bot',
    cdnBaseUrl: '',
    async sendText(to: string, text: string) {
      sent.push({ to, text })
      return { success: true }
    },
    async sendTyping() {},
  })
  provide('sessions', {
    list: () => [],
    get: () => undefined,
  })
  provide('agents', {
    list: () => [],
    get: () => undefined,
    create: async () => { throw new Error('no create in picker tests') },
    resume: async () => { throw new Error('no resume in picker tests') },
  })
  provide('approval', {})
  provide('tools', { register: () => () => {} })
  provide('sessionTitle', {})
  provide('llm', {
    listProviders() {
      return [{ id: 'p1', name: 'Provider One' }, { id: 'p2', name: 'Provider Two' }]
    },
    async listModels(provider: string) {
      if (provider === 'p1') return [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }]
      return [{ id: 'm3', name: 'Model Three' }]
    },
    async resolveCallConfig(config: { provider?: string; model?: string }) {
      return { provider: config.provider ?? '', model: config.model ?? '' }
    },
  })
  provide('permissionPresets', {
    names: ['safe', 'danger-full-access'],
    current() {
      return 'safe'
    },
    resolve(name: string) {
      if (!['safe', 'danger-full-access'].includes(name)) throw new Error(`unknown preset ${name}`)
      return { label: name, description: '' }
    },
    set() {},
  })
  const node = new WechatConversationNode(ctx, {
    allowFrom: ['wxid_allow1'],
    digestIntervalSec: 0,
    approvalTimeoutSec: 2,
    maxMessageChars: 2000,
    sendChunkDelayMs: 1,
  })
  node.peerId = 'wxid_allow1' // outbound targets node.peerId
  return { node, sent }
}

test('model picker options enumerate providers × models', async () => {
  const { node } = buildNode()
  const options = await node.modelPickerOptions()
  assert.equal(options.length, 3)
  assert.ok(options[0]!.value.startsWith('p1/'))
})

test('beginPicker + resolvePicker(model) applies selection and confirms', async () => {
  const { node, sent } = buildNode()
  const options = await node.modelPickerOptions()
  node.beginPicker('model', options)
  assert.equal(node.hasActivePicker(), true)
  const outcome = await routePickerReply(node, '2')
  assert.equal(outcome, true)
  assert.equal(node.hasActivePicker(), false)
  assert.ok(sent.some((s) => s.text.includes('已切换')), sent.map((s) => s.text).join(' | '))
})

test('non-number while picker open is not consumed', async () => {
  const { node } = buildNode()
  const options = await node.modelPickerOptions()
  node.beginPicker('model', options)
  const outcome = await routePickerReply(node, 'hello')
  assert.equal(outcome, false)
  assert.equal(node.hasActivePicker(), true)
})

test('permission picker resolves to a preset', async () => {
  const { node, sent } = buildNode()
  const options = node.permissionPickerOptions()
  assert.ok(options.length >= 2)
  node.beginPicker('perm', options)
  const outcome = await routePickerReply(node, '1')
  assert.equal(outcome, true)
  assert.ok(sent.some((s) => s.text.includes('权限预设')), sent.map((s) => s.text).join(' | '))
})
