# dsh-chatnode-wechat

**Chat with, monitor, and approve your DSH agents from WeChat.**

> ⚠️ **Reference only — verified on one environment, not a blanket promise.**
> Status as of 2026-09-06: **63 offline unit tests green** (`node --test`,
> no real WeChat account needed) **+ a live WeChat smoke pass** (text / image
> OCR / voice STT / image generation / TTS mp3 attachment / reminders /
> morning weather / light control / session commands / approvals).
> Everything in `§Configuration` that looks like `<...>` is a placeholder you
> **must fill in** (the allowlist and the `WEIXIN_*` credentials are required;
> without them the bridge safely refuses to talk to anyone / stays idle).

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle
that connects a DSH profile to a WeChat personal account over Tencent's
unofficial **iLink bot gateway** (`ilinkai.weixin.qq.com`) — the same
mechanism hermes-agent and OpenClaw use.

```
you (WeChat)  ⇄  iLink  ⇄  wechat-gateway  ⇄  wechat-conversation-node  ⇄  DSH agent session
```

The bundle ships **two separable Cordis plugins**:

| Plugin | Role |
| --- | --- |
| `wechat-gateway` (`WechatGateway`) | iLink service (`ctx.wechat`): QR login, authenticated long-poll, reconnect/backoff, send retry + rate-limit circuit, typing indicator, encrypted CDN media download/upload. |
| `wechat-conversation-node` | WeChat ⇄ DSH bridge: allowlist gate, session targeting, commands, multimodal media helpers (OCR / STT / TTS / image-gen), reminders & morning weather, digest outbound, approvals. |

## ⚠️ Read this first

- **One poller per account.** iLink allows exactly ONE authenticated poller
  per bot token. If you also run **hermes-agent** or **OpenClaw** on the same
  WeChat account, one of them gets HTTP 403s and drops messages. Use a
  **dedicated WeChat account**, and never run two instances against one token.
- **Unofficial gateway.** Tencent could restrict the account. Use a dedicated
  account you are willing to lose.
- **Unofficial protocol.** iLink details were reconstructed from hermes-agent
  source, not Tencent docs. Recorded transcripts live in
  `test/fixtures/inbound.ndjson` so CI never needs a live account.

## What it does (implemented & tested)

- **Text both ways**, plain and simple. Inbound text is routed to the active
  WeChat session; replies come back formatted for WeChat (no raw Markdown:
  headings → `【】`, code fences stripped, tables de-lined, emphasis removed).
- **Images both ways.** Inbound images are downloaded & decrypted to
  `mediaDir` and, when `ocrApiKey` is set, auto-OCR'd (SiliconFlow
  `deepseek-ai/DeepSeek-OCR`) — the model sees the file path + the OCR text.
  Outbound `/send <path>` pushes a local image to the chat; the agent can also
  **generate images** (`generate_image`, Kwai-Kolors/Kolors) and send them.
- **Voice both ways.** Inbound voice is transcribed (XingChenASR via
  SiliconFlow, or the native transcript WeChat already attached) and handed to
  the agent as text; the agent can **speak** (`speak`, CosyVoice2 clone voice)
  and the mp3 comes back as a tappable file attachment.
- **Session management** in chat: `/sessions /use N /new <prompt> /stop
  /status`, plus auto-resume of the most recent `wechat-` session after a
  restart. Sessions are hard-isolated from the web GUI by the `wechat-` prefix
  (a shared SessionStore bug once caused cross-talk — now sealed at every
  layer).
- **Model switching**: `/model` shows a numbered provider×model menu; reply a
  digit to switch the running agent and save the default.
- **Reminders**: natural language → `set_reminder` (per-peer persistent JSON),
  delivered at the right time, catch-up delivery after downtime.
- **Morning weather**: `/早安 on|off|status|test|HH:MM` (alias `/morning`),
  daily Open-Meteo pull, locally composed push — zero LLM cost.
- **Light control**: `/开灯 /开灯1|2|3 /关灯` → HTTP to an ESP32 PWM light
  (`esp32BaseUrl`).
- **Approvals**: permission requests arrive as numbered text prompts
  (`🔐 #N`), answered in-chat with `/yes` `/no` (or `1`/`2` while exactly one
  is pending); timeout defaults to **deny** (600s).
- **Digest-style outbound**: no tool-call firehose. A heartbeat line
  (`🔄 仍在处理中…`) every `digestIntervalSec`, replies chunked to
  `maxMessageChars` with throttling, and clear end-of-turn notices only for
  error / abort / truncation.

## Install

```sh
git clone <this-repo-url>
cd dsh-chatnode-wechat
pnpm install && pnpm build
dsh plugin --profile <your-profile> add .
```

Pair your WeChat account once (prints a QR URL — scan it with WeChat):

```sh
pnpm login
```

This writes `WEIXIN_ACCOUNT_ID` / `WEIXIN_BOT_TOKEN` / `WEIXIN_BASE_URL` to
`$DSH_HOME/.credentials.yaml`. The bundle resolves them at boot and starts
polling. (Alternatively these can be supplied as gateway config
`accountId`/`token`/`baseUrl`.)

## Configuration

```yaml
# profile patch (cordis.patch.yml)
plugins:
  dsh-chatnode-wechat:
    allowFrom: ["<your-wechat-id>@im.wechat"] # hard allowlist, REQUIRED
    digestIntervalSec: 300            # heartbeat summary while a turn runs
    approvalTimeoutSec: 600           # approval timeout → default deny
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
    # mediaDir: <dir>     # inbound images (default $DSH_HOME/attachments/wechat)
    # reminderFile / morningFile: <paths, default under $DSH_HOME>
```

`allowFrom` is **mandatory with no permissive default**: an agent that
accepts instructions from any WeChat contact is a prompt-injection front
door. Missing `allowFrom` fails startup; messages from non-allowlisted
senders are logged and ignored — never fed to the model.

**What you must fill in before it does anything** (all values were sanitized
from this repo):
1. `allowFrom` — your own WeChat ID.
2. `WEIXIN_BOT_TOKEN` / `WEIXIN_ACCOUNT_ID` / `WEIXIN_BASE_URL` — via
   `pnpm login` (gateway stays idle without them).
3. SiliconFlow `sk-` key for OCR / image-gen / STT / TTS if you want the
   media features (all four share one key).
4. `ttsVoice` (`speech:<your-cloned-voice>:...`) if you want spoken replies.
5. Optional: `esp32BaseUrl`, `cwd`, `mediaDir`, `reminderFile`,
   `morningFile`.

Most of this is a single interactive wizard that patches your profile's
`cordis.patch.yml` (it only ever touches the `dsh-chatnode-wechat` entry and
backs up the file first):

```sh
pnpm setup            # interactive
pnpm setup --yes --set allowFrom=<your-wechat-id>@im.wechat \
    --set siliconflowKey=sk-...     # non-interactive (siliconflowKey fills OCR/gen/STT/TTS)
```

The persona preset referenced above (`agentPreset: wechat`, a catgirl-style
assistant in our test environment) lives **outside this repo** under
`$DSH_HOME/.agent-presets/wechat/` — point `agentPreset` at any preset you
have installed, or omit it.

### Commands (send in WeChat)

| Command | What it does |
| --- | --- |
| *(plain text / image / voice)* | routes to the active agent (followup) |
| `/sessions` | numbered session list (`wechat-` only, most recent first) |
| `/use N` | switch the active session |
| `/new <prompt>` | create a fresh agent+session and start |
| `/stop` | cancel the active turn |
| `/status` | agent status + session summary |
| `/send <path>` | send a local image to the current contact |
| `/model` | two-step model switcher (list → pick a digit) |
| `/perm` | two-step permission-preset switcher (list → pick a digit) |
| `/早安 on\|off\|status\|test\|HH:MM` (alias `/morning`) | morning weather digest |
| `/开灯` `/开灯1\|2\|3` `/关灯` | ESP32 light control |
| `/yes` `/no` (or `1`/`2` while one request is pending) | answer a permission request |
| `/help` | command list |

## Approvals

WeChat personal accounts have no buttons. When a DSH permission request
fires, the bridge renders a numbered text prompt and waits:

```
🔐 #1 需要你的确认
工具: bash
原因: run a destructive command
回复 /yes 同意，/no 拒绝（仅一条待确认时也可回复 1/2）
10 分钟内未回复将自动拒绝。
```

`/yes` (or `1` while exactly one request is pending) grants `allowed-once`;
`/no` (`2`) rejects; timeout falls back to DSH's default **deny**. The bridge
only answers requests for the agent it currently drives — everything else is
delegated down the answerer chain.

## Development

```sh
pnpm install
pnpm build          # src/ → lib/ (tsc)
pnpm typecheck
pnpm test           # node --test test/*.test.ts — 63 tests, no WeChat account
pnpm smoke          # manual live-account check
```

- `test/fake-ilink-server.ts` implements the iLink endpoints (long-poll,
  sendmessage, sendtyping, getconfig, QR login, encrypted CDN download) and
  replays `test/fixtures/inbound.ndjson`; the full inbound→session→outbound
  loop runs offline in CI (`.github/workflows/ci.yml`).
- Test spread: gateway 18 / node 22 / markdown 9 / morning 6 / picker 4 /
  reminders 4 = **63**.
- **Honest gaps** (not yet unit-tested): OCR success/failure branches, the
  voice-download→ASR flow, outbound media upload (the fake server has no
  `/upload`), `/send`, `/help`, ESP32 light control (real HTTP), and restart
  resume. Live smoke covers the happy paths above.
- Pin the dsh-base family (`@deepseek-ai/*` at `0.1.0-rc.6`) — DSH is a
  developer preview and upstream breaks are expected.

## Known limits

- Outbound voice is an **mp3 file attachment**, not a native voice bubble
  (iLink limitation). A `silk.ts` transcoder and `gateway.sendVoice()` exist
  as unused spares (silk.ts needs external ffmpeg + pilk).
- Some command receipts still carry emoji (✅❌🎙🧠) that were not stripped to
  match an emoji-free persona.
- Generated images/voice accumulate under `mediaDir/generated` (no auto-cleanup).
- WeChat `silk`-encoded voice needs real-device verification (m4a verified OK).
- Only **text/1:1** messaging is targeted; group chats are ignored by design (MVP).

## Risks

| Risk | Mitigation |
| --- | --- |
| **iLink exclusive lock** — two pollers on one token → 403 + dropped messages | Dedicated account; loud fatal error + polling stop on 403; documented coexistence warning |
| **Account restriction** — unofficial gateway | Dedicated account; stated plainly in this README |
| **DSH v0.1 churn** | Pinned `@deepseek-ai/*` deps; CI against the pinned versions |
| **Protocol opacity** | Protocol ported from hermes-agent; fixtures recorded so refactors need no live account |

## Roadmap

- **Done (v0.1+)**: QR login, text/images/voice both ways, OCR inbound,
  image generation, TTS outbound, reminders, morning weather, light control,
  model switcher, session isolation + auto-resume, approvals, digest outbound.
- **Next**: wire `/perm`; group chats (risk-heavy, opt-in); multi-account;
  a hermesclaw-style shared-poller proxy to coexist with hermes/openclaw.
- **Later**: WeCom / DingTalk / Feishu bundles reusing the `node/` layer.

## License

MIT — see [LICENSE](LICENSE).
