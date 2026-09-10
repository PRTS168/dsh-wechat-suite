# dsh-chatnode-wechat

**Chat with, monitor, and approve your DSH agents from WeChat.**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle
that connects a DSH profile to a WeChat personal account over Tencent's
unofficial **iLink bot gateway** (`ilinkai.weixin.qq.com`) — the same
mechanism hermes-agent and OpenClaw use.

```
you (WeChat)  <=>  iLink  <=>  wechat-gateway  <=>  wechat-conversation-node  <=>  DSH agent session
```

> **Fork notice (unofficial).** This repository is a personal, unofficial
> fork and continued development of
> [Jesse-njx/dsh-chatnode-wechat](https://github.com/Jesse-njx/dsh-chatnode-wechat),
> forked from the upstream snapshot at commit `2bd4c15` (2026-08). It is NOT
> an official release of, or affiliated with, the upstream project or its
> authors. The original commit history and the credit for the earliest work
> remain intact and are attributed to the upstream authors; upstream remains
> the source of truth for the base protocol.

**Status** | version `v0.2.0` (see [Releases](https://github.com/PRTS168/dsh-chatnode-wechat/releases)) · MIT · **65 offline unit tests green** + a live WeChat smoke pass (2026-09)

> **Reference only.** Verified on one specific environment; not a blanket
> promise of portability. Everything that looks like `<...>` is a placeholder
> you must fill in (`allowFrom` and the `WEIXIN_*` credentials are required —
> without them the bridge safely stays idle and never feeds the model).

---

## 1. What it does

- **Text both ways.** Replies are re-formatted for WeChat before sending
  (Markdown headings to `【】`, code fences stripped and indented, tables
  de-lined, emphasis removed).
- **Images both ways.** Inbound images are downloaded, decrypted and stored
  under `mediaDir`; with `ocrApiKey` set they are auto-recognized
  (SiliconFlow `deepseek-ai/DeepSeek-OCR`) and handed to the model as a file
  path plus the OCR text. Outbound: `/send <path>` pushes a local image; the
  agent can also generate images (`generate_image`, Kwai-Kolors/Kolors).
- **Voice both ways.** Inbound voice notes are transcribed (`sttApiKey`,
  XingChenASR, or WeChat's own transcript when present); the agent can reply
  with `speak` (CosyVoice2 clone voice) and the mp3 arrives as a tappable
  file attachment.
- **Files & videos both ways.** Inbound documents/videos are decrypted to
  `mediaDir` and referenced to the agent as `[微信文件]` / `[微信视频]` path
  markers (original file name preserved). The agent can send local files or
  clips back with `wechat_send_file` / `wechat_send_video` (video is
  delivered as a playable mp4/mov file attachment — the iLink gateway has no
  native video bubble).
- **Send-time stamps.** Every inbound user message handed to the model is
  prefixed with `[发送于 YYYY-MM-DD HH:mm]` (server-local time), so the agent
  always knows when a message was sent.
- **Session management.** `/sessions /use /new /stop /status`, auto-resume of
  the most recent `wechat-` session after a restart, and hard isolation from
  Web-GUI sessions (shared SessionStore) via the `wechat-` prefix.
- **Runtime switching.** `/model` and `/perm` two-step menus switch the agent's
  model route and its permission preset from the chat.
- **Reminders.** Natural language to `set_reminder` (per-peer, persistent
  JSON, catch-up delivery after downtime).
- **Morning weather.** `/早安 on|off|status|test|HH:MM` (alias `/morning`):
  daily Open-Meteo pull, locally composed push, zero LLM cost.
- **Light control.** `/开灯 /开灯1|2|3 /关灯` drives an ESP32 PWM light over
  plain HTTP (`esp32BaseUrl`).
- **Approvals.** Permission requests arrive as numbered text prompts and are
  answered in-chat with `/yes` `/no` (or `1`/`2`); a timeout defaults to
  deny.
- **Digest-style outbound.** No tool-call firehose: heartbeat line every
  `digestIntervalSec`, replies chunked to `maxMessageChars` with throttling,
  end-of-turn notices only for error / abort / truncation.

Two separable Cordis plugins are shipped:

| Plugin | Role |
| --- | --- |
| `wechat-gateway` (`WechatGateway`) | iLink service (`ctx.wechat`): QR login, authenticated long-poll, reconnect/backoff, send retry + rate-limit circuit, typing indicator, encrypted CDN media download/upload. |
| `wechat-conversation-node` | WeChat to DSH bridge: allowlist gate, session targeting, commands, multimodal media helpers (OCR/STT/TTS/image-gen/file/video), reminders & morning weather, digest outbound, approvals. |

## 2. Read this first

- **One poller per account.** iLink allows exactly ONE authenticated poller
  per bot token. Running hermes-agent or OpenClaw against the same WeChat
  account causes HTTP 403 and dropped messages. Use a **dedicated WeChat
  account**, never two instances per token.
- **Unofficial gateway.** Tencent may restrict the account. Use an account you
  are willing to lose.
- **Unofficial protocol.** Details were reconstructed from hermes-agent
  source; recorded transcripts live in `test/fixtures/inbound.ndjson` so CI
  never needs a live account.

## 3. Quickstart

Prerequisites: Node >= 20, pnpm, a dedicated WeChat account, and a DSH
profile.

```sh
git clone https://github.com/PRTS168/dsh-chatnode-wechat.git
cd dsh-chatnode-wechat
pnpm install && pnpm build
dsh plugin --profile <your-profile> add .
```

Pair the WeChat account once (prints a QR URL to scan):

```sh
pnpm login            # writes WEIXIN_BOT_TOKEN / WEIXIN_ACCOUNT_ID / WEIXIN_BASE_URL
```

Fill in the remaining placeholders with the interactive wizard (patches only
the `dsh-chatnode-wechat` entry of your profile's `cordis.patch.yml` and
backs up the file first):

```sh
pnpm setup            # interactive
pnpm setup --yes --set allowFrom=<your-wechat-id>@im.wechat \
    --set siliconflowKey=sk-...        # non-interactive; siliconflowKey fills OCR/gen/STT/TTS
```

Restart dsh web, then send a WeChat message to the bot.

## 4. Configuration

```yaml
# profile patch (cordis.patch.yml)
plugins:
  dsh-chatnode-wechat:
    allowFrom: ["<your-wechat-id>@im.wechat"] # hard allowlist, REQUIRED
    digestIntervalSec: 300            # heartbeat summary while a turn runs
    approvalTimeoutSec: 600           # approval timeout -> default deny
    maxMessageChars: 2000             # WeChat bubble cap (protocol limit)
    sendChunkDelayMs: 1500            # throttle between outbound bubbles
    # agentPreset: wechat             # optional persona preset (see below)
    # agentProvider / agentModel: ... # model route for the WeChat agent
    # esp32BaseUrl: http://<esp32-ip>:80   # light control (optional)

    # ---- media helpers (all optional; each capability degrades gracefully) ----
    # ocrApiKey / ocrModel: deepseek-ai/DeepSeek-OCR / ocrBaseUrl
    # imageGenApiKey / imageGenModel: Kwai-Kolors/Kolors / imageGenDir
    # sttApiKey / sttModel: XingChenAGI/XingChenASR-V3.2-Ultra
    # ttsApiKey / ttsModel: FunAudioLLM/CosyVoice2-0.5B / ttsVoice: speech:<voice-uri>
    # mediaDir: <dir>     # inbound media (default $DSH_HOME/attachments/wechat)
    # reminderFile / morningFile: <paths, default under $DSH_HOME>
```

`allowFrom` is mandatory and has no permissive default. Missing it fails
startup; messages from non-allowlisted senders are logged and ignored —
never fed to the model.

> Note: the gateway Config schema also declares tuning keys
> (longPollTimeoutMs, retryDelayMs, rate-limit circuit, …) but only
> `baseUrl/cdnBaseUrl/token/accountId` are forwarded from the bundle config —
> tune the gateway through `WechatGateway`'s own config if you need them.

The `agentPreset: wechat` reference (a persona preset used in the test
environment) lives outside this repo under
`$DSH_HOME/.agent-presets/wechat/` — point `agentPreset` at any preset you
have installed, or omit it.

### Web management page

In a `web` profile the bundle also ships a browser page: **Settings → Plugins →
"微信桥配置 / WeChat bridge config"**. It lists every placeholder above
(whitelist, model route, SiliconFlow media keys, clone voice, paths,
throttling), shows environment status (credentials, agent preset, allowlist),
masks secrets, and saves straight into the profile's `cordis.patch.yml` — with
a timestamped backup, keeping comments and other plugin rows intact.

The host API lives under `/dsh-chatnode-wechat/api` (`GET /schema`,
`GET /config`, `POST /save`). Every request must carry the
`X-DSH-Chatnode-Wechat: 1` header (cross-site requests cannot forge it), and the
second bundle row (`dsh-chatnode-wechat/config-api`) only loads where a
`webServer` service exists — headless profiles are unaffected. Changes take
effect after restarting dsh web.

The same page also edits **personas** (`GET /presets`, `GET /persona`,
`POST /persona`, `POST /preset/copy`): pick an agent preset, edit its
`config.text` persona in a text area and save — only the persona block of that
preset's `agent.cordis.yml` is rewritten (backup first, every other tool row
untouched). "Copy as new preset" duplicates the current preset directory so a
second persona can be built without hand-writing the tool composition; the
preset named by `agentPreset` above is the one the WeChat agent actually uses.

## 5. Commands & tools

Commands (send in WeChat):

| Command | What it does |
| --- | --- |
| *(plain text / image / voice / file / video)* | routes to the active agent |
| `/sessions` | numbered session list (`wechat-` only, most recent first) |
| `/use N` | switch the active session |
| `/new <prompt>` | create a fresh agent+session and start |
| `/stop` | cancel the active turn |
| `/status` | agent status + session summary |
| `/send <path>` | send a local image to the current contact |
| `/model` | two-step model switcher (list, then pick a digit) |
| `/perm` | two-step permission-preset switcher (list, then pick a digit) |
| `/早安 on\|off\|status\|test\|HH:MM` (alias `/morning`) | morning weather digest |
| `/开灯` `/开灯1\|2\|3` `/关灯` | ESP32 light control |
| `/yes` `/no` (or `1`/`2` while one request is pending) | answer a permission request |
| `/help` | command list |

Agent tools (available to the model):

| Tool | Purpose |
| --- | --- |
| `wechat_send_image(path)` | send a local image to the peer |
| `wechat_send_file(path)` | send any local file to the peer |
| `wechat_send_video(path)` | send a local video (playable mp4/mov attachment) |
| `generate_image(prompt)` | text-to-image (Kolors), then send it |
| `speak(text)` | TTS with the cloned voice, sent as an mp3 attachment |
| `set_reminder(text, inMinutes\|atTime)` | schedule a reminder (per peer) |
| `list_reminders()` | list pending reminders |
| `cancel_reminder(id)` | cancel a reminder |

## 6. Approvals

WeChat has no buttons, so permission requests are rendered as numbered text
prompts and answered in chat:

```
#1 needs your confirmation
tool: bash
reason: run a destructive command
reply /yes to allow, /no to reject (1/2 while exactly one is pending)
no reply within 10 minutes -> automatically denied
```

`/yes` grants `allowed-once`; `/no` rejects; timeout falls back to the DSH
default deny. The bridge answers only requests for the agent it currently
drives; everything else is delegated down the answerer chain.

## 7. Development

```sh
pnpm install
pnpm build          # src/ -> lib/ (tsc)
pnpm typecheck
pnpm test           # node --test test/*.test.ts — 65 tests, no WeChat account
pnpm smoke          # manual live-account check
pnpm setup          # interactive config wizard
```

- `test/fake-ilink-server.ts` implements the iLink endpoints (long-poll,
  sendmessage, sendtyping, getconfig, QR login, encrypted CDN download) and
  replays `test/fixtures/inbound.ndjson`; the inbound-to-session-to-outbound
  loop runs offline in CI (`.github/workflows/ci.yml`).
- Test spread: gateway 18 / node 24 / markdown 9 / morning 6 / picker 4 /
  reminders 4 = **65**.
- Honest gaps (not yet unit-tested): OCR success/failure branches, the
  voice-download-to-ASR flow, outbound media upload (the fake server has no
  `/upload`), `/send`, `/help`, ESP32 light control, restart resume. Live
  smoke covers the happy paths.
- DSH is a developer preview; `@deepseek-ai/*` is pinned at `0.1.1-rc.2`.

## 8. Known limits

- Outbound voice/video are delivered as **file attachments** (mp3/mp4), not
  native bubbles (iLink limitation). `silk.ts` and `gateway.sendVoice()` exist
  as unused spares (silk needs external ffmpeg + pilk).
- Some command receipts still contain emoji that are not stripped to match an
  emoji-free persona.
- Generated images/voice accumulate under `mediaDir/generated` (no
  auto-cleanup yet).
- WeChat `silk`-encoded voice needs real-device verification (m4a verified).
- Only 1:1 text messaging is targeted; group chats are ignored by design (MVP).

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| iLink exclusive lock — two pollers on one token -> 403 + dropped messages | Dedicated account; loud fatal error + polling stop on 403 |
| Account restriction — unofficial gateway | Dedicated, disposable account; stated plainly in this README |
| DSH v0.1 churn | Pinned `@deepseek-ai/*` deps; CI against pinned versions |
| Protocol opacity | Protocol ported from hermes-agent; recorded fixtures |

## 10. Roadmap

- Next: group chats (opt-in, risk-heavy), multi-account, a shared-poller
  proxy to coexist with hermes/openclaw.
- Later: WeCom / DingTalk / Feishu bundles reusing the `node/` layer.

## License

MIT — see [LICENSE](LICENSE).
