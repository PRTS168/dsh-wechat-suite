/**
 * Boot-safety regression tests.
 *
 * Background: `dsh-app-boot` requires EVERY loader entry to activate. A plugin
 * that declares an optional service in `inject` therefore does not merely stay
 * idle when that service is absent — it stays PENDING, and the host fails the
 * whole profile with:
 *
 *   Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
 *   @dsh-cowork/chatnode-wechat/config-api: pending (waiting for service: webServer)
 *
 * That was reproducible with `dsh --profile <headless> "task"`: installing this
 * bundle made a headless profile unbootable. These tests pin the fix so the same
 * class of bug cannot come back silently.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { inject as apiInject, apply as applyConfigApi } from '../src/node/config-api.ts'
import { inject as bundleInject } from '../src/index.ts'

test('config-api hard-requires no service (webServer is optional)', () => {
  assert.deepEqual(apiInject, [])
})

test('config-api apply() no-ops without a web server instead of throwing', () => {
  assert.doesNotThrow(() => applyConfigApi({}))
  assert.doesNotThrow(() => applyConfigApi({ get: () => undefined, logger: { info: () => {} } }))
  assert.doesNotThrow(() => applyConfigApi({ webServer: undefined, get: () => undefined }))
})

test('config-api waits for webServer through ctx.inject and registers its routes', () => {
  const registered: string[] = []
  let asked: string[] = []
  let ran = false
  applyConfigApi({
    inject: (deps: string[], callback: (child: any) => void) => {
      asked = deps
      ran = true
      callback({
        webServer: {
          register: (route: { path: string }) => {
            registered.push(route.path)
            return () => {}
          },
        },
      })
    },
  })
  assert.equal(ran, true, 'must subscribe via ctx.inject so ordering does not matter')
  assert.deepEqual(asked, ['webServer'])
  assert.deepEqual(registered, ['/dsh-chatnode-wechat/api'])
})

test('a profile without webServer is never blocked: child scope absence is tolerated', () => {
  // ctx.inject fires but the service is still missing → no throw, no registration.
  assert.doesNotThrow(() =>
    applyConfigApi({
      inject: (_deps: string[], callback: (child: any) => void) => callback({}),
    }),
  )
})

test('bundle inject lists only services that dsh-base guarantees', () => {
  assert.deepEqual(bundleInject, ['sessions', 'agents', 'approval', 'credentials'])
  assert.ok(!bundleInject.includes('sessionTitle'), 'sessionTitle is optional and must go through ctx.get()')
})
