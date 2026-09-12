/**
 * Boot-safety regression test.
 *
 * Background: `dsh-app-boot` requires EVERY loader entry to activate. A plugin
 * row that declares an optional service in `inject` therefore does not merely
 * stay idle when that service is absent — it stays PENDING, and the host fails
 * the whole profile with `plugin tree failed to load: 1 entry did not activate`.
 *
 * This test pins the rule for the bundle's own `inject` list so the same class
 * of bug cannot come back silently.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { inject as bundleInject } from '../src/index.ts'

test('bundle inject lists only services that dsh-base guarantees', () => {
  assert.deepEqual(bundleInject, ['sessions', 'agents', 'approval', 'credentials'])
  assert.ok(!bundleInject.includes('sessionTitle'), 'sessionTitle is optional and must go through ctx.get()')
})
