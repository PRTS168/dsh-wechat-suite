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

**Status** | version `v0.2.2` (see [Releases](https://github.com/PRTS168/dsh-chatnode-wechat/releases)) · MIT · **86 offline unit tests green** + a live WeChat smoke pass (2026-09)

> **Reference only.** Verified on one specific environment; not a blanket
> promise of portability. Everything that looks like `<...>` is a placeholder
> you must fill in (`allowFrom` and the `WEIXIN_*` credentials are required —
> without them the bridge safely stays idle and never feeds the model).

---

## 1. What it does

- **Text both ways.** Replies are re-formatted for WeChat before sending
  (Markdown headings to `【】`, code fences stripped and indented, tables
  de-lined, emphasis removed).
- **Images both ways, native or OCR.** Inbound images are downloaded, decrypted
  and stored under `mediaDir`. How the model receives them depends on the routed
  model: a multimodal route gets a **real image block** (the model sees the
  pixels), while a text-only route falls back to **DeepSeek-OCR** text
  (`deepseek-ai/DeepSeek-OCR`) plus the file path. `imageInput: auto` (default)
  decides per routed model from its declared modalities; `native` and `ocr`
  force one path, and `/识图` switches at runtime. Outbound: `/send <path>`
  pushes a local image; the agent can also generate images
  (`generate_image`, Kwai-Kolors/Kolors).
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
- **Email.** `send_email` sends plain text through a configured SMTP account
  (implicit TLS), so the agent can mail a report, a reminder or a file summary
  from the chat.
- **Digest-style outbound.** No tool-call firehose: heartbeat line every
  `digestIntervalSec`, replies chunked to `maxMessageChars` with throttling,
  end-of-turn notices only for error / abort / truncation.
- **Web management page & persona editing.** In a `web` profile, **Settings →
  Plugins → "微信桥配置"** manages every placeholder below (whitelist, model
  route, media keys, clone voice, paths, throttling — secrets masked, saves
  into `cordis.patch.yml` with a backup) and edits each agent preset's persona
  text in place.

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
    imageInput: auto                  # auto | native | ocr (see below)
    # imageInputModel: amd/DeepSeek-V4-Flash-Vision-Exp  # vision route for pictures only
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

### Native image input vs OCR

An inbound picture reaches the model one of two ways:

| Mode | What the model gets | When |
| --- | --- | --- |
| `native` | a real `image` content block (it sees the pixels) | the routed model declares `image` input |
| `ocr` | `【OCR 识别结果】` text + the file path | the routed model is text-only, or nothing declares image support |

`imageInput` picks the policy:

- **`auto`** (default) — resolve the route the agent actually chats on, ask
  `llm.listModels()` for its `inputModalities`, and send an image block when
  `image` is declared. If the chat route is text-only, `auto` looks for another
  registered route that declares image support (set `imageInputModel` to pin one
  instead), and otherwise uses OCR.
- **`native`** — always attempt the image block. A route that does not *declare*
  image support is still tried once (the endpoint may accept images without
  advertising them); when it refuses, that route is suppressed for three hours
  and later pictures take the OCR path instead of burning a turn each time.
- **`ocr`** — always the text path. Useful for documents and screenshots, where
  a dedicated OCR model is cheaper and often more accurate than a vision model.

`/识图` reports and switches the mode at runtime (`auto` / `native` / `ocr`);
the override lasts until `dsh web` restarts, after which `imageInput` applies
again. Every inbound picture keeps its `[微信图片] <path>` prefix in both modes,
so the session log stays replayable and the agent can re-read the file.

```
/识图                 # current mode + routed model
/识图 native          # force image blocks
/识图 ocr             # force OCR text
```

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
| `/识图 [auto\|native\|ocr]` | image-input mode; no argument reports the current mode and routed model |
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
pnpm build          # src/ -> lib/ (tsc) + client bundle (lib/client.js)
pnpm typecheck
pnpm test           # node --test test/*.test.ts — 72 tests, no WeChat account
pnpm smoke          # manual live-account check
pnpm setup          # interactive config wizard
```

- `test/fake-ilink-server.ts` implements the iLink endpoints (long-poll,
  sendmessage, sendtyping, getconfig, QR login, encrypted CDN download) and
  replays `test/fixtures/inbound.ndjson`; the inbound-to-session-to-outbound
  loop runs offline in CI (`.github/workflows/ci.yml`).
- Test spread: gateway 18 / node 24 / markdown 9 / morning 6 / picker 4 /
  reminders 4 / patch-config 7 / vision 10 = **82**.
- Honest gaps (not yet unit-tested): OCR success/failure branches, the
  voice-download-to-ASR flow, outbound media upload (the fake server has no
  `/upload`), `/send`, `/help`, ESP32 light control, restart resume, and the
  native-image block itself (`vision.test.ts` covers the mode/policy decision
  against a stub catalog; `attachments.saveImage` runs only on a live host).
  Live smoke covers the happy paths.
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

## 10. Version history

### v0.2.2 — DeepSeek 4.1 multimodal + native image input

The WeChat agent can now *see* pictures instead of receiving OCR text about
them, which is what DeepSeek 4.1's multimodal input makes possible.

- **Native image input, switchable against OCR.** An inbound picture reaches
  the model as a real `image` content block when the routed model declares
  image input, and as DeepSeek-OCR text plus a file path when it does not.
  `imageInput: auto` (default) decides per routed model from its declared
  modalities; `native` and `ocr` force one path, and the new `/识图` command
  switches at runtime. See §4 "Native image input vs OCR".
- **Declaring the modality is the switch.** The harness gates image blocks on
  the model's declared `inputModalities`, upstream of the wire — a text-only
  declaration means no image is ever sent. `deepseek-flash` accepts images but
  the adapter's built-in catalog predates that (it records the id as text-only
  and keeps the retired `deepseek-v4-flash-vision-exp` as its only image entry),
  so declare it in settings:

  ```yaml
  llm-deepseek:
    models:
      - id: deepseek-flash
        inputModalities: [text, image]
  ```

  This `models:` list **replaces** the plugin catalog rather than extending it,
  so list every id you route to (the WeChat profile pins the legacy alias
  `deepseek-v4-flash`; without it that route stops resolving).
- **Observed refusals are remembered.** Declaring is a claim about the
  endpoint, not a check of it, so a route that refuses an image once is
  suppressed for three hours and later pictures go straight to OCR instead of
  burning a turn each time.
- **`send_email`.** Plain-text mail over implicit-TLS SMTP, with the SMTP
  client exposed through an injectable transport so its command order is
  covered by tests rather than assumed.
- **Secrets hardening.** `client-config.json` and `account.json` — written to
  the repo root at runtime and holding the WeChat token in clear — are now
  git-ignored. Neither was ever committed.
- 86 offline unit tests (was 82; `vision.test.ts` + `email.test.ts`).

### v0.2.1 — Web management page and persona editing

- **Settings → Plugins → "微信桥配置"**: every placeholder (whitelist, model
  route, SiliconFlow media keys, clone voice, paths, throttling) edited in the
  browser, secrets masked, saved into `cordis.patch.yml` with a timestamped
  backup that preserves comments and other rows.
- **Persona editing**: pick a preset, edit its `config.text` in a text area,
  save; only the persona block is rewritten. "Copy as new preset" duplicates a
  whole preset directory.
- Host API under `/dsh-chatnode-wechat/api` (`/schema`, `/config`, `/save`,
  `/presets`, `/persona`, `/preset/copy`), each request carrying an
  `X-DSH-Chatnode-Wechat: 1` header; the second bundle row only mounts where a
  `webServer` service exists.

### v0.2.0 — `/perm`, and files & videos both ways

- `/perm` two-step permission-preset switcher wired up, plus `pnpm setup`, a
  one-command config wizard.
- Inbound files/videos download and decrypt to `mediaDir` with the original
  name preserved; `wechat_send_file` / `wechat_send_video` send local files and
  clips back (video arrives as a playable mp4 attachment).
- Inbound user messages carry `[发送于 YYYY-MM-DD HH:mm]` across text, OCR and
  STT paths.
- Persona residue removed from the repo; upstream fork attribution added.

## 11. Roadmap
- Next: group chats (opt-in, risk-heavy), multi-account, a shared-poller
  proxy to coexist with hermes/openclaw.
- Later: WeCom / DingTalk / Feishu bundles reusing the `node/` layer.

## License

MIT — see [LICENSE](LICENSE).
