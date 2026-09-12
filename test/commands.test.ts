/**
 * Command-surface tests for the WeChat chat vocabulary.
 *
 * Three regressions motivated them, all of the "silently stops working" kind:
 *
 *  - the documented shorthand for answering a permission request is a BARE
 *    `1` / `2`, but the approval check sat *after* the leading-slash guard, so
 *    digits never reached `resolveApproval()` — they went to the picker and then
 *    to the model, and the approval just timed out;
 *  - `/yes` and `/no` with nothing pending fell through to the default branch and
 *    answered "❓ 未知命令 /yes" plus the help dump;
 *  - the device vocabulary of the retired `dsh-wechat-tools` plugin
 *    (`/gear /off /low /mid /high`) stopped being recognised.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { routeCommand } from '../src/node/commands.ts'

type CmdNode = Parameters<typeof routeCommand>[0]

interface Stub {
  node: CmdNode
  sent: string[]
  approvals: string[]
}

/** Minimal stand-in for the conversation node: only what commands touch. */
function stub(baseUrl = 'http://127.0.0.1:1', approvalAnswers = false): Stub {
  const sent: string[] = []
  const approvals: string[] = []
  const node = {
    ctx: {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      get: (name: string) =>
        name === 'wechat'
          ? {
              sendText: async (_to: string, text: string) => {
                sent.push(text)
                return { success: true }
              },
              sendTyping: async () => {},
              sendImage: async () => ({ success: true }),
            }
          : undefined,
    },
    peerId: 'peer@im.wechat',
    config: { esp32BaseUrl: baseUrl },
    activeAgent: () => undefined,
    activeSession: () => undefined,
    resolveApproval: (text: string) => {
      approvals.push(text)
      return approvalAnswers
    },
  }
  return { node: node as unknown as CmdNode, sent, approvals }
}

test('a bare 1 reaches the approval bridge before anything else', async () => {
  const s = stub('http://127.0.0.1:1', true)
  assert.equal(await routeCommand(s.node, '1'), true)
  assert.deepEqual(s.approvals, ['1'])
  assert.deepEqual(s.sent, [], 'answering must not produce extra chatter')
})

test('a bare 1 with nothing pending stays available to the picker and the model', async () => {
  const s = stub('http://127.0.0.1:1', false)
  assert.equal(await routeCommand(s.node, '1'), false)
  assert.deepEqual(s.approvals, ['1'])
  assert.deepEqual(s.sent, [])
})

test('/yes with nothing pending says so instead of "unknown command"', async () => {
  const s = stub()
  assert.equal(await routeCommand(s.node, '/yes'), true)
  const reply = s.sent.join('\n')
  assert.match(reply, /没有待确认的请求/)
  assert.doesNotMatch(reply, /未知命令/)
})

test('/no with a pending request is consumed silently', async () => {
  const s = stub('http://127.0.0.1:1', true)
  assert.equal(await routeCommand(s.node, '/no'), true)
  assert.deepEqual(s.approvals, ['/no'])
  assert.deepEqual(s.sent, [])
})

test('the retired device vocabulary still drives the light', async () => {
  const paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(request.url ?? '')
    response.end(request.url === '/gear' ? '2' : 'ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    const s = stub(`http://127.0.0.1:${port}`)
    assert.equal(await routeCommand(s.node, '/gear'), true)
    assert.match(s.sent.join('\n'), /当前灯光档位：2/)
    for (const command of ['/off', '/low', '/mid', '/high']) {
      s.sent.length = 0
      assert.equal(await routeCommand(s.node, command), true)
      assert.match(s.sent.join('\n'), /^✅ /)
    }
    assert.deepEqual(paths, ['/gear', '/off', '/low', '/mid', '/high'])
  } finally {
    server.close()
  }
})

test('the Chinese light vocabulary keeps its own mapping', async () => {
  const paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(request.url ?? '')
    response.end('3')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    const s = stub(`http://127.0.0.1:${port}`)
    for (const command of ['/开灯', '/开灯1', '/开灯2', '/开灯3', '/关灯']) {
      assert.equal(await routeCommand(s.node, command), true)
    }
    assert.deepEqual(paths, ['/high', '/low', '/mid', '/high', '/off'])
  } finally {
    server.close()
  }
})

test('an unknown command still says so, and /help lists the aliases', async () => {
  const s = stub()
  assert.equal(await routeCommand(s.node, '/bogus'), true)
  assert.match(s.sent.join('\n'), /未知命令 \/bogus/)
  s.sent.length = 0
  assert.equal(await routeCommand(s.node, '/help'), true)
  const help = s.sent.join('\n')
  assert.match(help, /\/gear \/off \/low \/mid \/high/)
  assert.match(help, /\/开灯 \/关灯 \/开灯1~3/)
})
