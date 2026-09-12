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
    '.wcw-persona select{padding:5px 8px;border:1px solid rgba(128,128,128,.35);border-radius:6px;background:transparent;color:inherit;font:inherit;min-width:220px}',
    '.wcw-persona-text{width:100%;margin:4px 0 2px;padding:8px;border:1px solid rgba(128,128,128,.35);border-radius:6px;background:transparent;color:inherit;font:inherit;line-height:1.55;resize:vertical}',
  ].join('')
  document.head.appendChild(style)
}

function ConfigPanel() {
  const [state, setState] = React.useState({ loading: true, error: '', data: null })
  const [drafts, setDrafts] = React.useState({})
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState({ kind: '', text: '' })
  const [presets, setPresets] = React.useState([])
  const [presetName, setPresetName] = React.useState('')
  const [persona, setPersona] = React.useState('')
  const [personaMeta, setPersonaMeta] = React.useState({ exists: false, file: '' })
  const [personaBusy, setPersonaBusy] = React.useState(false)
  const [personaMsg, setPersonaMsg] = React.useState({ kind: '', text: '' })

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

  const loadPersona = React.useCallback(async function (name) {
    if (!name) return
    const res = await api('/persona?name=' + encodeURIComponent(name))
    if (!res.data || res.data.ok !== true) {
      setPersonaMsg({ kind: 'err', text: '读取人设失败：' + ((res.data && res.data.error) || res.status) })
      return
    }
    setPersona(res.data.persona || '')
    setPersonaMeta({ exists: res.data.exists, file: res.data.file })
    setPersonaMsg({ kind: '', text: '' })
  }, [])

  const loadPresets = React.useCallback(async function (preferred) {
    const res = await api('/presets')
    if (!res.data || res.data.ok !== true) return
    setPresets(res.data.presets || [])
    const active = preferred || res.data.active || ''
    setPresetName(active)
    await loadPersona(active)
  }, [loadPersona])

  async function savePersona() {
    if (!presetName) return
    if (!persona.trim()) {
      setPersonaMsg({ kind: 'err', text: '人设文本不能为空。' })
      return
    }
    setPersonaBusy(true)
    setPersonaMsg({ kind: '', text: '正在保存人设…' })
    const res = await api('/persona', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, HEADERS),
      body: JSON.stringify({ name: presetName, persona: persona }),
    })
    setPersonaBusy(false)
    if (!res.data || res.data.ok !== true) {
      setPersonaMsg({ kind: 'err', text: '保存失败：' + ((res.data && res.data.error) || res.status) })
      return
    }
    setPersonaMsg({ kind: 'ok', text: '人设已保存（' + res.data.personaChars + ' 字）\n备份：' + res.data.backup + '\n重启 dsh web 后生效。' })
  }

  async function copyPresetAs() {
    const to = window.prompt('新建 preset 名（将从当前 preset 复制一份）', presetName ? presetName + '-copy' : '')
    if (!to) return
    setPersonaBusy(true)
    const res = await api('/preset/copy', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, HEADERS),
      body: JSON.stringify({ from: presetName, to: to }),
    })
    setPersonaBusy(false)
    if (!res.data || res.data.ok !== true) {
      setPersonaMsg({ kind: 'err', text: '复制失败：' + ((res.data && res.data.error) || res.status) })
      return
    }
    setPersonaMsg({ kind: 'ok', text: '已复制为 preset「' + to + '」：编辑人设后保存，再把「人设 preset 名」改成 ' + to + ' 并保存即可切换。' })
    await loadPresets(to)
  }

  React.useEffect(function () { load(); loadPresets() }, [load, loadPresets])

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

  const personaEl = React.createElement('div', { className: 'wcw-group wcw-persona' },
    React.createElement('div', { className: 'wcw-group-title' }, '人设（agent preset）'),
    React.createElement('p', { className: 'wcw-hint' }, '编辑所选 preset 的人设正文（写回该 preset 的 agent.cordis.yml，仅替换 persona 段，其余工具行不动；自动备份）。「人设 preset 名」这一项决定微信 agent 实际用哪个 preset。'),
    React.createElement('div', { className: 'wcw-field' },
      React.createElement('label', { htmlFor: 'wcw-preset' }, '预设 presets'),
      React.createElement('select', {
        id: 'wcw-preset',
        value: presetName,
        onChange: function (ev) { const v = ev.target.value; setPresetName(v); loadPersona(v) },
      }, presets.length === 0
        ? React.createElement('option', { value: '' }, '（未找到 preset 目录）')
        : presets.map(function (p) {
          return React.createElement('option', { key: p.name, value: p.name },
            p.name + (p.isActive ? '（当前启用）' : '') + (p.hasAgentFile ? '' : ' — 缺 agent.cordis.yml') + ' · ' + p.personaChars + ' 字')
        })),
      React.createElement('small', null, personaMeta.file || ''),
    ),
    React.createElement('textarea', {
      className: 'wcw-persona-text',
      rows: 12,
      value: persona,
      placeholder: '人设正文（persona 文本）',
      onChange: function (ev) { setPersona(ev.target.value) },
    }),
    React.createElement('div', { className: 'wcw-actions' },
      React.createElement('button', { className: 'primary', onClick: savePersona, disabled: personaBusy || !presetName }, personaBusy ? '处理中…' : '保存人设'),
      React.createElement('button', { onClick: copyPresetAs, disabled: personaBusy || !presetName }, '复制为新 preset'),
      React.createElement('button', { onClick: function () { loadPresets(presetName) }, disabled: personaBusy }, '重新载入'),
    ),
    personaMsg.text ? React.createElement('div', { className: 'wcw-msg ' + personaMsg.kind }, personaMsg.text) : null,
  )

  return React.createElement('div', { className: 'wcw-root' },
    React.createElement('h3', null, '微信桥配置（dsh-chatnode-wechat）'),
    React.createElement('p', { className: 'wcw-hint' }, '这里管理本插件的全部待填项：白名单、聊天模型路由、SiliconFlow 媒体模型 Key、克隆音色、路径与节流参数。保存会直接改写 profile 的 cordis.patch.yml（自动备份，保留注释与其他插件条目），并把密钥脱敏显示。'),
    React.createElement('div', { className: 'wcw-status' }, rows.map(function (r, i) {
      return [React.createElement('b', { key: 'k' + i }, r[0]), React.createElement('span', { key: 'v' + i }, r[1])]
    })),
    personaEl,
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
  injectStyles()
  // Register through `ctx.slots.inject`, not `ctx.get('slots')`.
  //
  // DSH 0.1.5: the slots registry is not yet published when a client plugin's
  // apply() runs (and `ctx.get('slots')` returned undefined here, which left
  // the page silently unregistered — "slots service unavailable" in the
  // console). `inject(key, callback)` waits for that slot to become available
  // and runs the registration then; it is the pattern every shipped client
  // plugin uses (see @deepseek-ai/dsh-client-ui-settings-plugin-inventory).
  // The callback's return value is the slot's disposer and is bound to this
  // fiber, so no extra ctx.effect wrapper is needed.
  const slots = ctx.slots
  if (slots === undefined || typeof slots.inject !== 'function') {
    console.log(TAG, 'slots registry unavailable; config page not registered')
    return
  }
  slots.inject('settings.plugins.tab', function () {
    return slots.register(
      { name: 'settings.plugins.tab', id: 'chatnode-wechat-config', order: 30, label: '微信桥配置' },
      function () { return React.createElement(ConfigPanel, null) },
    )
  })
}

module.exports = { apply }
