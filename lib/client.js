window.__ModuleLoader__.load({ id: "@dsh-cowork/chatnode-wechat", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/**
 * Browser side of the WeChat bridge's config page.
 *
 * Registered into the web GUI's settings → plugins tab. Renders every
 * configurable placeholder (allowFrom, SiliconFlow keys, ttsVoice, paths,
 * intervals…) and saves through the host API under
 * `/dsh-chatnode-wechat/api` (see src/node/config-api.ts). Secrets are shown
 * masked and are only overwritten when the field is edited explicitly.
 *
 * Built by `scripts/build-client.mjs` into `lib/client.js` in the DSH client
 * module format (`window.__ModuleLoader__.load`).
 */
const TAG = '[wechat-config]'
const API = '/dsh-chatnode-wechat/api'
const HEADERS = { 'X-DSH-Chatnode-Wechat': '1' }

let React = null
try { React = require('react') } catch (e) { React = null }

async function api(path, init) {
  try {
    const res = await window.fetch(API + path, Object.assign({ headers: HEADERS }, init || {}))
    let data = null
    try { data = await res.json() } catch (e) { data = null }
    return { status: res.status, data: data }
  } catch (e) {
    return { status: 0, data: { ok: false, error: '无法连接主机接口：' + (e && e.message ? e.message : String(e)) } }
  }
}

function injectStyles() {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin="@dsh-cowork/chatnode-wechat"]')) return
  const style = document.createElement('style')
  style.setAttribute('data-plugin', '@dsh-cowork/chatnode-wechat')
  style.textContent = [
    '.wcw-root{font-size:13px;line-height:1.6;color:inherit;max-width:760px}',
    '.wcw-root h3{margin:0 0 4px;font-size:15px}',
    '.wcw-hint{opacity:.72;margin:0 0 12px}',
    '.wcw-status{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0 0 14px;padding:10px 12px;border:1px solid rgba(128,128,128,.28);border-radius:8px}',
    '.wcw-status b{font-weight:600}',
    '.wcw-group{margin:0 0 16px}',
    '.wcw-group-title{font-weight:600;margin:0 0 6px;padding-bottom:4px;border-bottom:1px solid rgba(128,128,128,.24)}',
    '.wcw-field{display:grid;grid-template-columns:190px 1fr;gap:8px;align-items:center;margin:0 0 8px}',
    '.wcw-field label{opacity:.85}',
    '.wcw-field input[type=text],.wcw-field input[type=password]{width:100%;padding:5px 8px;border:1px solid rgba(128,128,128,.35);border-radius:6px;background:transparent;color:inherit;font:inherit}',
    '.wcw-field small{grid-column:2;opacity:.62}',
    '.wcw-actions{display:flex;gap:10px;align-items:center;margin:14px 0 4px}',
    '.wcw-actions button{padding:6px 14px;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font:inherit;cursor:pointer}',
    '.wcw-actions button.primary{border-color:#4f46e5;color:#fff;background:#4f46e5}',
    '.wcw-msg{margin-top:10px;white-space:pre-wrap}',
    '.wcw-msg.err{color:#dc2626}',
    '.wcw-msg.ok{color:#16a34a}',
  ].join('')
  document.head.appendChild(style)
}

function ConfigPanel() {
  const [state, setState] = React.useState({ loading: true, error: '', data: null })
  const [drafts, setDrafts] = React.useState({})
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState({ kind: '', text: '' })

  const load = React.useCallback(async function () {
    setState({ loading: true, error: '', data: null })
    const res = await api('/config')
    if (!res.data || res.data.ok !== true) {
      setState({ loading: false, error: (res.data && res.data.error) || '读取配置失败', data: null })
      return
    }
    setState({ loading: false, error: '', data: res.data })
    setDrafts({})
  }, [])

  React.useEffect(function () { load() }, [load])

  if (state.loading) return React.createElement('div', { className: 'wcw-root' }, '正在读取配置…')
  if (state.error) return React.createElement('div', { className: 'wcw-root wcw-msg err' }, state.error)

  const data = state.data
  const fields = data.fields || []
  const groups = []
  fields.forEach(function (f) {
    let g = groups.find(function (x) { return x.name === f.group })
    if (!g) { g = { name: f.group, items: [] }; groups.push(g) }
    g.items.push(f)
  })

  function setDraft(key, value) {
    setDrafts(Object.assign({}, drafts, { [key]: value }))
  }

  async function save() {
    const updates = {}
    Object.keys(drafts).forEach(function (key) {
      const raw = drafts[key]
      // untouched (undefined) or cleared input ('') => no change; '-' => clear
      if (raw === undefined || raw === '') return
      updates[key] = raw === '-' ? null : raw
    })
    if (Object.keys(updates).length === 0) {
      setMsg({ kind: '', text: '没有改动。' })
      return
    }
    setBusy(true)
    setMsg({ kind: '', text: '正在保存…' })
    const res = await api('/save', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, HEADERS), body: JSON.stringify({ updates: updates }) })
    setBusy(false)
    if (!res.data || res.data.ok !== true) {
      setMsg({ kind: 'err', text: '保存失败：' + ((res.data && res.data.error) || res.status) })
      return
    }
    const changed = (res.data.changed || []).join(', ')
    setMsg({ kind: 'ok', text: '已保存' + (changed ? '：' + changed : '') + '\n备份：' + (res.data.backup || '（新建文件）') + '\n重启 dsh web 后生效。' })
    setState({ loading: false, error: '', data: Object.assign({}, data, res.data) })
    setDrafts({})
  }

  const status = data.status || {}
  const rows = [
    ['配置文件', data.file || ''],
    ['角色 preset', (status.preset || 'wechat') + (status.presetExists ? ' ✓ 已存在' : ' ✗ 未找到，请先创建')],
    ['WEIXIN_* 凭据', status.weixinCredentials ? '已配置（pnpm login）' : '未配置 —— 请先运行 pnpm login'],
    ['SiliconFlow Key', status.siliconflowKey ? '已配置' : '未配置（OCR/生图/STT/TTS 不可用）'],
    ['白名单', (data.allowFrom && data.allowFrom.length) ? data.allowFrom.length + ' 个' : '空 —— 桥不会把消息交给模型'],
  ]

  const groupEls = groups.map(function (g) {
    const items = g.items.map(function (f) {
      const draft = drafts[f.key]
      const current = f.kind === 'list' ? ((data.allowFrom || [])[0] || '') : (data.values[f.key] || '')
      const hasSecret = f.secret && data.has && data.has[f.key]
      const value = draft !== undefined ? draft : (f.secret ? '' : current)
      const placeholder = f.secret && hasSecret && draft === undefined
        ? '已设置（' + (data.values[f.key] || '') + '）留空=不改，输入 - 清除'
        : (f.placeholder || f.default || '')
      return React.createElement('div', { className: 'wcw-field', key: f.key },
        React.createElement('label', { htmlFor: 'wcw-' + f.key }, f.label),
        React.createElement('input', {
          id: 'wcw-' + f.key,
          type: f.secret ? 'password' : 'text',
          value: value,
          placeholder: placeholder,
          onChange: function (ev) { setDraft(f.key, ev.target.value) },
        }),
        f.hint ? React.createElement('small', null, f.hint) : null,
      )
    })
    return React.createElement('div', { className: 'wcw-group', key: g.name },
      React.createElement('div', { className: 'wcw-group-title' }, g.name),
      items,
    )
  })

  return React.createElement('div', { className: 'wcw-root' },
    React.createElement('h3', null, '微信桥配置（dsh-chatnode-wechat）'),
    React.createElement('p', { className: 'wcw-hint' }, '这里管理本插件的全部待填项：白名单、聊天模型路由、SiliconFlow 媒体模型 Key、克隆音色、路径与节流参数。保存会直接改写 profile 的 cordis.patch.yml（自动备份，保留注释与其他插件条目），并把密钥脱敏显示。'),
    React.createElement('div', { className: 'wcw-status' }, rows.map(function (r, i) {
      return [React.createElement('b', { key: 'k' + i }, r[0]), React.createElement('span', { key: 'v' + i }, r[1])]
    })),
    groupEls,
    React.createElement('div', { className: 'wcw-actions' },
      React.createElement('button', { className: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
      React.createElement('button', { onClick: load, disabled: busy }, '重新载入'),
      React.createElement('span', { className: 'wcw-hint' }, 'secret 字段：留空表示不修改；输入 - 可清除。'),
    ),
    msg.text ? React.createElement('div', { className: 'wcw-msg ' + msg.kind }, msg.text) : null,
  )
}

function apply(ctx) {
  const slots = ctx.get('slots')
  injectStyles()
  if (slots !== undefined) {
    const registration = slots.register(
      { name: 'settings.plugins.tab', id: 'chatnode-wechat-config', order: 30, label: '微信桥配置' },
      function () { return React.createElement(ConfigPanel, null) },
    )
    ctx.effect(function () {
      return function () { if (typeof registration === 'function') registration() }
    })
  } else {
    console.log(TAG, 'slots service unavailable; config page not registered')
  }
}

module.exports = { apply }

return module.exports;
} });
