/**
 * markdownToWechat tests: model-style markdown → WeChat-friendly plain text.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdownToWechat } from '../src/node/outbound.ts'

test('strips ATX headings and emphasis markers', () => {
  const out = markdownToWechat('# 标题\n正文 **加粗** 和 *斜体*')
  assert.ok(!out.includes('#'))
  assert.ok(!out.includes('**'))
  assert.ok(!out.includes('*'))
  assert.ok(out.includes('标题'))
  assert.ok(out.includes('加粗'))
  assert.ok(out.includes('斜体'))
})

test('code fence becomes an indented block without backticks', () => {
  const md = '看这段代码：\n```js\nconst x = 1\n```\n完'
  const out = markdownToWechat(md)
  assert.ok(!out.includes('```'))
  assert.ok(out.includes('const x = 1'))
  assert.ok(out.includes('js')) // language hint retained
})

test('inline code and links lose their markers', () => {
  const out = markdownToWechat('运行 `npm install`，文档见 [说明](https://example.com)')
  assert.ok(!out.includes('`'))
  assert.ok(out.includes('npm install'))
  assert.ok(out.includes('说明'))
  assert.ok(!out.includes('[说明]'))
})

test('table becomes aligned rows without pipes', () => {
  const md = '| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 梨 | 2 |'
  const out = markdownToWechat(md)
  assert.ok(out.includes('名称'))
  assert.ok(out.includes('苹果'))
  assert.ok(out.includes('梨'))
  assert.ok(!out.includes('---'))
})

test('strikethrough, blockquote, hr are cleaned', () => {
  const md = '> 引用一句\n~~旧文本~~\n---\n后文'
  const out = markdownToWechat(md)
  assert.ok(!out.includes('>'))
  assert.ok(!out.includes('~~'))
  assert.ok(out.includes('旧文本'))
  assert.ok(out.includes('后文'))
})

test('plain chat text is untouched apart from harmless stripping', () => {
  const text = '好的喵～ 我帮你查了：今天天气不错。'
  const out = markdownToWechat(text)
  assert.equal(out, text)
})

test('italic before CJK punctuation is stripped', () => {
  const out = markdownToWechat('看看 *斜体*、还有 **加粗**。')
  assert.ok(!out.includes('*'), out)
  assert.ok(out.includes('斜体'))
  assert.ok(out.includes('加粗'))
})

test('realistic table renders without outer pipes', () => {
  const md = '| 项目  |  状态  |  备注 |\n| --- | --- | --- |\n| 邮件  |  已发送  |  测试邮件成功 |\n| 灯光  |  已关闭  |  已切换至 off |'
  const out = markdownToWechat(md)
  assert.ok(out.includes('邮件 | 已发送 | 测试邮件成功'), out)
  assert.ok(!out.includes('| ---'))
  assert.ok(!out.includes('| 项目'))
  assert.ok(!out.includes('| 邮件'))
})

test('full realistic assistant message cleans up cleanly', () => {
  const md = [
    '主人想看看 **加粗**、*斜体*、~~删除线~~、链接（https://deepseek.com） 这些效果',
    '',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
  ].join('\n')
  const out = markdownToWechat(md)
  assert.ok(!out.includes('**'))
  assert.ok(!out.includes('*'))
  assert.ok(!out.includes('~~'))
  assert.ok(!out.includes('| 1 |'))
  assert.ok(out.includes('1 | 2'))
  assert.ok(out.includes('加粗'))
  assert.ok(out.includes('删除线'))
})
