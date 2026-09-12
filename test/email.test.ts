/**
 * SMTP client tests: the staging order (greeting → EHLO → AUTH LOGIN →
 * MAIL/RCPT → DATA → QUIT) is what silently breaks on a careless port, so it
 * is asserted against a fake socket rather than assumed.
 *
 * The transport is injected instead of standing up a TLS server: Node cannot
 * self-sign a certificate from `generateKeyPairSync`, and a real handshake is
 * orthogonal to the command order being tested here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { smtpSend, sendEmail, type SmtpSocket, type SmtpConfig } from '../src/node/email.ts'

interface FakeServer {
  /** Every line the client sent, in order. */
  commands: string[]
  /** Decoded DATA payload once the terminating dot arrives. */
  body: string
  /** Raw DATA header block (before the blank line). */
  rawHeaders: string
}

/**
 * A fake implicit-TLS SMTP server. Replies with the codes a real server sends
 * and records the client's command order; `failAuth` rejects at the password
 * step to exercise the error path.
 */
function fakeServer(options: { failAuth?: boolean } = {}): { server: FakeServer; connect: SmtpConfig['connect'] } {
  const server: FakeServer = { commands: [], body: '', rawHeaders: '' }
  const connect = (): SmtpSocket => {
    let stage = 0
    let dataMode = false
    let raw = ''
    const listeners = { data: [] as Array<(c: string) => void>, error: [] as Array<(e: Error) => void> }
    const reply = (text: string) => queueMicrotask(() => listeners.data.forEach((fn) => fn(text)))
    const socket: SmtpSocket = {
      setEncoding: () => socket,
      on(event: 'data' | 'error', listener: (arg: never) => void) {
        if (event === 'data') listeners.data.push(listener as (c: string) => void)
        else listeners.error.push(listener as (e: Error) => void)
        return socket
      },
      write(line: string) {
        const trimmed = line.replace(/\r?\n$/, '')
        if (dataMode) {
          // DATA is terminated by a lone dot on its own line, not by the
          // chunk boundary — the base64 body itself contains newlines.
          raw += line
          const end = raw.indexOf('\r\n.\r\n')
          if (end < 0) return socket
          const payload = raw.slice(0, end)
          dataMode = false
          // Drop the header block; the test asserts the decoded body.
          const split = payload.indexOf('\r\n\r\n')
          const encoded = (split >= 0 ? payload.slice(split + 4) : payload).replace(/\r\n/g, '')
          server.body = encoded
          server.rawHeaders = split >= 0 ? payload.slice(0, split) : ''
          reply('250 OK queued\r\n')
          return socket
        }
        server.commands.push(trimmed)
        switch (stage) {
          case 0: stage = 1; reply('250-test.local\r\n250 AUTH LOGIN\r\n'); break
          case 1: stage = 2; reply('334 VXNlcm5hbWU6\r\n'); break
          case 2: stage = 3; reply('334 UGFzc3dvcmQ6\r\n'); break
          case 3:
            if (options.failAuth) { reply('535 auth failed\r\n'); return socket }
            stage = 4; reply('235 authenticated\r\n'); break
          case 4: stage = 5; reply('250 sender ok\r\n'); break
          case 5: stage = 6; reply('250 recipient ok\r\n'); break
          case 6: stage = 7; dataMode = true; raw = ''; reply('354 go ahead\r\n'); break
          case 7: reply('221 bye\r\n'); break
          default: break
        }
        return socket
      },
      end: () => socket,
      destroy: () => socket,
    }
    // The greeting arrives only after the client has attached its listeners.
    reply('220 test.local ESMTP\r\n')
    return socket
  }
  return { server, connect }
}

function configFor(connect: SmtpConfig['connect']): SmtpConfig {
  return { host: '127.0.0.1', port: 465, username: 'user@example.com', password: 'secret', fromName: 'dsh-bridge', connect }
}

test('smtpSend walks greeting → EHLO → AUTH → MAIL/RCPT → DATA → QUIT in order', async () => {
  const { server, connect } = fakeServer()
  const result = await smtpSend(configFor(connect), {
    to: 'someone@example.com',
    subject: '测试主题',
    body: 'hello from the bridge',
  })
  assert.equal(result, 'sent')

  // EHLO must come first: sending it before consuming the 220 greeting would
  // read the greeting as the EHLO reply.
  assert.equal(server.commands[0], 'EHLO dsh.local')
  assert.equal(server.commands[1], 'AUTH LOGIN')
  assert.equal(server.commands[2], Buffer.from('user@example.com').toString('base64'))
  assert.equal(server.commands[3], Buffer.from('secret').toString('base64'))
  assert.equal(server.commands[4], 'MAIL FROM:<user@example.com>')
  assert.equal(server.commands[5], 'RCPT TO:<someone@example.com>')
  assert.equal(server.commands[6], 'DATA')
  assert.equal(server.commands.at(-1), 'QUIT')

  // The body goes out base64-encoded, so a CJK subject/body survives.
  assert.equal(Buffer.from(server.body, 'base64').toString('utf8'), 'hello from the bridge')
})

test('smtpSend surfaces an authentication rejection instead of timing out', async () => {
  const { connect } = fakeServer({ failAuth: true })
  await assert.rejects(
    () => smtpSend(configFor(connect), { to: 'a@b.c', subject: 's', body: 'b' }),
    /authentication failed/,
  )
})

test('sendEmail refuses to send without SMTP credentials', async () => {
  await assert.rejects(() => sendEmail(undefined, { to: 'a@b.c', subject: 's', body: 'b' }), /SMTP 未配置/)
  await assert.rejects(
    () => sendEmail({ host: 'smtp.example.com', username: '', password: '' }, { to: 'a@b.c', subject: 's', body: 'b' }),
    /SMTP 未配置/,
  )
})

test('sendEmail requires a recipient and a subject', async () => {
  const config: SmtpConfig = { host: '127.0.0.1', port: 465, username: 'u', password: 'p' }
  await assert.rejects(() => sendEmail(config, { to: '', subject: 's', body: 'b' }), /收件人与主题/)
  await assert.rejects(() => sendEmail(config, { to: 'a@b.c', subject: '', body: 'b' }), /收件人与主题/)
})
