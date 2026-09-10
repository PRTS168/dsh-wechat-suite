/**
 * Native-image vs OCR policy tests: which delivery mode a given routed model
 * gets, the `auto` discovery path, configured vision routes, and the observed-
 * refusal suppression. Pure resolution logic 鈥?no WeChat account, no model.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearImageRefusals,
  declaresImageInput,
  findImageCapableRoute,
  isImageRefused,
  noteImageRefusal,
  parseRoute,
  resolveImageDelivery,
} from '../src/node/vision.ts'

/** One catalog entry: a model id plus the modalities the endpoint declares. */
interface CatalogModel {
  id: string
  inputModalities?: readonly string[]
}

/** Stub `llm` service: a provider list over a fixed route table. */
interface CatalogStub {
  listProviders(): Array<{ id: string }>
  listModels(provider: string): Promise<CatalogModel[]>
}

/** Catalog stub built from a plain provider 鈫?models object. */
function catalog(routes: { [provider: string]: CatalogModel[] }): CatalogStub {
  return {
    listProviders: () => Object.keys(routes).map((id) => ({ id })),
    listModels: async (provider: string) => routes[provider] ?? [],
  }
}

const NO_LLM = undefined

test('parseRoute splits provider/model and keeps slashes in the model id', () => {
  assert.deepEqual(parseRoute('deepseek-official/deepseek-v4-1'), { provider: 'deepseek-official', model: 'deepseek-v4-1' })
  assert.deepEqual(parseRoute('siliconflow/Qwen/Qwen3-VL'), { provider: 'siliconflow', model: 'Qwen/Qwen3-VL' })
  assert.equal(parseRoute('nope'), undefined)
  assert.equal(parseRoute('/leading'), undefined)
  assert.equal(parseRoute('trailing/'), undefined)
  assert.equal(parseRoute(undefined), undefined)
})

test('declaresImageInput reads the routed model modalities', async () => {
  const llm = catalog({
    ark: [{ id: 'vision', inputModalities: ['text', 'image'] }, { id: 'plain', inputModalities: ['text'] }],
  })
  assert.equal(await declaresImageInput(llm, 'ark', 'vision'), true)
  assert.equal(await declaresImageInput(llm, 'ark', 'plain'), false)
  // Absent modalities mean unknown, not capable.
  assert.equal(await declaresImageInput(catalog({ ark: [{ id: 'unknown' }] }), 'ark', 'unknown'), false)
  // An unreachable route cannot take anything.
  assert.equal(await declaresImageInput(catalog({}), 'ghost', 'x'), false)
  assert.equal(await declaresImageInput(NO_LLM, 'ark', 'vision'), false)
})

test('ocr mode always chooses the text path, even for a vision model', async () => {
  const llm = catalog({ ark: [{ id: 'vision', inputModalities: ['text', 'image'] }] })
  const decision = await resolveImageDelivery({
    mode: 'ocr',
    llm,
    chatRoute: { provider: 'ark', model: 'vision' },
  })
  assert.equal(decision.mode, 'ocr')
})

test('auto sends a native block when the chat route declares image input', async () => {
  const llm = catalog({ 'deepseek-official': [{ id: 'deepseek-v4-1', inputModalities: ['text', 'image'] }] })
  const decision = await resolveImageDelivery({
    mode: 'auto',
    llm,
    chatRoute: { provider: 'deepseek-official', model: 'deepseek-v4-1' },
  })
  assert.equal(decision.mode, 'native')
  assert.deepEqual(decision.route, { provider: 'deepseek-official', model: 'deepseek-v4-1' })
})

test('auto falls back to OCR for a text-only chat route, then finds a vision route', async () => {
  const textOnly = catalog({ 'deepseek-official': [{ id: 'flash', inputModalities: ['text'] }] })
  const noVision = await resolveImageDelivery({
    mode: 'auto',
    llm: textOnly,
    chatRoute: { provider: 'deepseek-official', model: 'flash' },
  })
  assert.equal(noVision.mode, 'ocr')

  const withVision = catalog({
    'deepseek-official': [{ id: 'flash', inputModalities: ['text'] }],
    ark: [{ id: 'vision-exp', inputModalities: ['text', 'image'] }],
  })
  const discovered = await resolveImageDelivery({
    mode: 'auto',
    llm: withVision,
    chatRoute: { provider: 'deepseek-official', model: 'flash' },
  })
  assert.equal(discovered.mode, 'native')
  assert.deepEqual(discovered.route, { provider: 'ark', model: 'vision-exp' })
})

test('auto with no reachable route at all degrades to OCR instead of throwing', async () => {
  const decision = await resolveImageDelivery({ mode: 'auto', llm: NO_LLM })
  assert.equal(decision.mode, 'ocr')
})

test('imageInputModel overrides the chat route for pictures', async () => {
  const llm = catalog({
    chat: [{ id: 'flash', inputModalities: ['text'] }],
    amd: [{ id: 'DeepSeek-V4-Flash-Vision-Exp', inputModalities: ['text', 'image'] }],
  })
  const decision = await resolveImageDelivery({
    mode: 'auto',
    llm,
    chatRoute: { provider: 'chat', model: 'flash' },
    configuredRoute: { provider: 'amd', model: 'DeepSeek-V4-Flash-Vision-Exp' },
  })
  assert.equal(decision.mode, 'native')
  assert.deepEqual(decision.route, { provider: 'amd', model: 'DeepSeek-V4-Flash-Vision-Exp' })
})

test('native mode attempts an undeclared route once rather than refusing up front', async () => {
  const llm = catalog({ 'deepseek-official': [{ id: 'flash', inputModalities: ['text'] }] })
  const decision = await resolveImageDelivery({
    mode: 'native',
    llm,
    chatRoute: { provider: 'deepseek-official', model: 'flash' },
  })
  assert.equal(decision.mode, 'native')
  assert.match(decision.reason, /forced native/)
})

test('an observed provider refusal suppresses native for that route', async () => {
  const llm = catalog({ ark: [{ id: 'vision', inputModalities: ['text', 'image'] }] })
  const route = { provider: 'ark', model: 'vision' }

  const before = await resolveImageDelivery({ mode: 'auto', llm, chatRoute: route })
  assert.equal(before.mode, 'native')

  noteImageRefusal(route.provider, route.model)
  assert.equal(isImageRefused(route.provider, route.model), true)

  const after = await resolveImageDelivery({ mode: 'auto', llm, chatRoute: route })
  assert.equal(after.mode, 'ocr')
  assert.match(after.reason, /refused/)

  // `auto` discovery must skip the suppressed route too.
  assert.equal(await findImageCapableRoute(llm), undefined)

  clearImageRefusals()
  assert.equal(isImageRefused(route.provider, route.model), false)
  assert.equal((await resolveImageDelivery({ mode: 'auto', llm, chatRoute: route })).mode, 'native')
})

test('findImageCapableRoute prefers the first capable route in provider order', async () => {
  const llm = catalog({
    text: [{ id: 'a', inputModalities: ['text'] }],
    vision: [{ id: 'plain', inputModalities: ['text'] }, { id: 'see', inputModalities: ['text', 'image'] }],
  })
  assert.deepEqual(await findImageCapableRoute(llm), { provider: 'vision', model: 'see' })
})
