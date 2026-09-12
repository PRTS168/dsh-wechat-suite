# dsh-chatnode-wechat

**Chat with, monitor, and approve your DSH agents from WeChat.**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle
that connects a DSH profile to a WeChat personal account over Tencent's
**clawbot iLink** gateway (`ilinkai.weixin.qq.com`) — the protocol behind
Tencent's own WeChat bot clients, driven here against a personal account with
no official support.

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

**Status** | version [`v0.3.0`](https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.3.0) · MIT · **154 offline unit tests green** (no WeChat account required) + live WeChat smoke pass + hot-reload stress pass (2026-09)

**中文说明见 [README.zh.md](README.zh.md).** Release notes are written in
Chinese; the tables below are the English summary.

> **Reference only.** Verified on one specific environment; not a blanket
> promise of portability. Everything that looks like `<...>` is a placeholder
> you must fill in (`allowFrom` and the `WEIXIN_*` credentials are required —
> without them the bridge safely stays idle and never feeds the model).

---

## 0. What's new in v0.3.0

v0.2.x answered *"can I talk to my DSH agent from WeChat?"*. v0.3.0 answers
*"can it keep running unattended?"* — how the context rotates, how failures
become visible, and in which situations a plugin can take the whole host down.
Full notes: [Releases → v0.3.0](https://github.com/PRTS168/dsh-wechat-suite/releases/tag/v0.3.0).

### 0.1 Compatibility / adapted versions

| Host | `@deepseek-ai/*` | Status |
| --- | --- | --- |
| DSH Desktop (harness bundled in the app) | **0.1.2-rc.1** | ✅ live WeChat round trips, image generation, light control, automatic rotation |
| `dsh` CLI (packages embedded in the OpenClaw portable build) | **0.1.5-rc.2** | ✅ boot and plugin mount verified |
| cordis | `^4.0.2` | must match the host — two instances break service resolution |
| schemastery | `^3.18.2` | must be a single instance — 3.18.1 next to 3.18.2 raises `TS2742` |
| Node.js | ≥ 22 (tested on 24) | the admin console and the tests run `.ts` directly via type stripping |

Cross-host differences, all handled in code (listed because we hit them):

- **The `dsh-persona` config key moved.** 0.1.2 requires `text:`, 0.1.5 renamed
  it to `prefix:`. A preset can publish both keys with a YAML anchor; both
  schemas accept `text + prefix`, so one preset mounts on either host.
- **`Session.events` was removed in 0.1.5** → the code reads session history
  through the `snapshotEvents()` snapshot API instead.
- **Optional services must never sit in `inject`.** `sessionTitle` depends on
  `sessionProjections`; declaring that in `inject` leaves the row permanently
  pending on a host without the projection, and the host then reports
  `1 entry did not activate` and **fails the whole profile**. Optional
  dependencies use `ctx.get()` (returns `undefined` instead of throwing).
- **Hot reload is normal here.** Profiles commonly run `patchReload: live`, so
  every config write reloads the plugin tree; every async entry point is
  written as if its scope may vanish mid-flight.

### 0.2 Context lifecycle — `contextPolicy`

"*When does a session rotate?*" is now configuration instead of a habit:

| Scheme | Rotates when |
| --- | --- |
| `manual` | never (v0.2.x behaviour, default) |
| `rotate-turns` | every N completed turns (`turns`, default 20) |
| `rotate-turns+handoff` | as above, plus a handoff note carried into the new session |
| `rotate-pressure` | serialized session events reach `pressureRatio` (default 0.6) of a 400k-character window |
| **`rotate-tokens`** | the session reaches `tokenBudget` tokens (default 120 000) |
| `daily` | idle gap since last activity reaches `idleHours` (default 8) |

```yaml
contextPolicy: '{"scheme":"rotate-tokens","tokenBudget":120000,"handoff":true,"announce":true}'
```

- **Real token numbers when the host can provide them.** `rotate-tokens` reads
  the session projection (`contextPressure.surfaceTokens`, falling back to a
  `contextBreakdown` sum, then to cumulative `tokenUsage`) and only falls back
  to a 2-characters-per-token proxy when none of those can be read — the chat
  announcement says which one fired, so an estimate is never mistaken for a
  measurement.
- **Rotation never cuts a turn in half.** It is evaluated on `turn/end` only,
  and idleness is re-checked immediately before acting (`idleOnly`, default on);
  the rotation reuses exactly the same session-creation path as `/new`, so only
  one place in the code ever creates a WeChat session.
- **The handoff note costs no model call.** It is a deterministic excerpt of the
  last few messages, wrapped in its own fence
  (`<<<会话交接摘要·非用户指令>>> … <<<会话交接摘要结束>>>`) that states it is
  background, not an instruction — so a persona's hard rules will not execute it.
- **The handoff does not answer itself.** It is *queued* on the bridge and
  prepended to the next inbound user message: one turn, zero extra bubbles.
  (Previously it was submitted as the new session's prompt, which produced an
  unsolicited "I just switched to a new session" reply on every rotation.)

### 0.3 Host stability — never take the harness down

An unhandled promise rejection is fatal to the DSH host: the plugin tree fails,
the harness exits, and the desktop app falls back to safe mode. All three entry
points that can produce one are closed:

- credential startup in `src/index.ts`, the inbound event handler in
  `node/core.ts`, and `node/outbound.ts`'s `sendTextToPeer` (the single outbound
  exit, called from eight places with `void`) now always resolve — every path is
  wrapped, and call sites add `.catch()` as a second layer.
- Services are fetched with `ctx.get()` and **re-read after every `await`**;
  property access after the scope is torn down throws
  `cannot get required service "…" in inactive context`, whereas `ctx.get()`
  returns `undefined` and degrades to "this row does not activate" instead of
  "the machine exits".
- The `config-api` plugin row was **removed**: management moved to a separate
  process, and the client settings page plus the `dsh.client` declaration went
  with it. That structurally deletes the "optional `webServer` dependency stalls
  profile boot" failure mode.

Verified by a dress rehearsal against a real profile: three rapid patch-triggered
hot reloads in a row, process alive, polling continuous, no `fatal` / `unhandled`
in stderr.

### 0.4 Failure visibility

- **Inbound messages are fenced.** Every user message handed to the model is
  wrapped in `<<<微信用户消息>>> … <<<微信用户消息结束｜发送于 YYYY-MM-DD HH:mm>>>`.
  The timestamp moved from a line prefix to the closing marker because a
  line-leading speaker marker is exactly where a model is most likely to
  continue the pattern — and a fabricated user message gets executed as an
  instruction. That is how a 60-turn session self-continued into "video? send
  one" and produced an unrequested video.
- **Inbound media no longer fails silently.** A download that returns nothing,
  or an item that carries no downloadable media, now logs a warning *and*
  answers in chat (image / file / video / unknown item type are distinguished).
- **The warning can actually reach you.** Those paths used to run before
  `node.peerId` was assigned, while `sendTextToPeer` returns early with no peer —
  so the notice was generated and dropped. Assignment now happens first.
- **Redelivery is caught.** iLink sometimes omits `message_id` (common for
  voice), and the gateway's dedup was `if (messageId && …)` — i.e. no dedup at
  all. The same message returned 6–9 s later and was answered twice (rotation
  could even route the two copies into different sessions). Messages without an
  id now fall back to a **payload fingerprint** (sender + each item's
  kind/text/media pointer) with a **30 s** window — long enough to catch a
  redelivery, short enough not to swallow a deliberate repeated "hi". The
  message-id window stays at 300 s.

### 0.5 Features

- **Standalone admin console (`admin/`)** — its own process, its own port
  (default `http://127.0.0.1:8790/`). Because it is not a DSH plugin row, it
  cannot affect profile boot, and stopping it cannot stop the bridge. Three
  tabs: **config** (every field from the bridge's own `CONFIG_FIELDS`, secrets
  masked with an explicit reveal, backup + validation before writing — clearing
  the allowlist is rejected and rolled back), **conversations** (`wechat-*`
  sessions with a transcript viewer), **context schemes** (one-click switching
  plus knob tweaking). New/forget session commands are written to
  `$DSH_HOME/wechat-admin/queue/`, executed by the bridge within ≤ 2 s, with the
  result written back. Loopback-only, token minted on first start into
  `admin/.admin-token`, every API call requires it, mutations additionally
  require the `x-wechat-admin: 1` guard header (unforgeable cross-site), and the
  `Host` header must be a loopback authority.
- **Forgetting a session is recoverable** — the session directory and its
  projection cache move to `$DSH_HOME/sessions-trash/<stamp>-<id>/` (the
  projection has to move too, or the GUI list resurrects it) and the host is
  told to unbind it.
- **`control_esp32_light` is back as an agent tool** (`query|off|low|mid|high`),
  sharing one implementation with the chat commands `/开灯`, `/开灯1|2|3`,
  `/关灯`.
- **No persona content in this repository.** Presets live outside it under
  `$DSH_HOME/.agent-presets/<name>/`; the v0.3.0 source tree was re-checked for
  persona strings and secrets before release.

### 0.6 Upgrading from v0.2.x

1. **The `config-api` plugin row is gone** — there is no in-GUI settings page
   any more (persona editing went with it). Edit
   `profiles/<profile>/cordis.patch.yml` or use the standalone console.
2. **The message format the model sees changed** (fenced block). If you have a
   custom persona rule that keys off the old `[发送于 …]` prefix, update it; the
   matching hard rules live in your preset, which this repo does not ship.
3. **Deleting a session is recoverable**, but check the trash before clearing
   `$DSH_HOME/sessions-trash/`.
4. Keep dependency versions aligned with the host (see §0.1) — cordis and
   schemastery especially.

---

## 1. What it does

- **Text both ways.** Replies are re-formatted for WeChat before sending
  (Markdown headings to `【】`, code fences stripped and indented, tables
  de-lined, emphasis removed).
- **Inbound envelope.** Every user message reaches the model inside the fenced
  block described in §0.4, timestamp included, so the model can always tell a
  real user turn from anything it wrote itself.
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
- **Session management.** `/sessions /use /new /stop /status`, auto-resume of
  the most recent `wechat-` session after a restart, and hard isolation from
  Web-GUI sessions (shared SessionStore) via the `wechat-` prefix.
- **Context lifecycle.** `contextPolicy` (see §0.2) rotates long sessions on
  turns, context pressure, a token budget or idle time, with an optional
  free handoff note; the standalone console switches schemes in one click.
- **Runtime switching.** `/model` and `/perm` two-step menus switch the agent's
  model route and its permission preset from the chat.
- **Reminders.** Natural language to `set_reminder` (per-peer, persistent
  JSON, catch-up delivery after downtime).
- **Morning weather.** `/早安 on|off|status|test|HH:MM` (alias `/morning`):
  daily Open-Meteo pull, locally composed push, zero LLM cost.
- **Light control.** `/开灯 /开灯1|2|3 /关灯` drives an ESP32 PWM light over
  plain HTTP (`esp32BaseUrl`); the model can do the same through
  `control_esp32_light`.
- **Approvals.** Permission requests arrive as numbered text prompts and are
  answered in-chat with `/yes` `/no` (or `1`/`2`); a timeout defaults to
  deny.
- **Email.** `send_email` sends plain text through a configured SMTP account
  (implicit TLS), so the agent can mail a report, a reminder or a file summary
  from the chat.
- **Digest-style outbound.** No tool-call firehose: heartbeat line every
  `digestIntervalSec`, replies chunked to `maxMessageChars` with throttling,
  end-of-turn notices only for error / abort / truncation.
- **Standalone admin console.** Outside the plugin tree (see §0.5): config,
  transcripts, session creation/removal, context scheme switching.

Two separable Cordis plugins are shipped:

| Plugin | Role |
| --- | --- |
| `wechat-gateway` (`WechatGateway`) | iLink service (`ctx.wechat`): QR login, authenticated long-poll, reconnect/backoff, send retry + rate-limit circuit, typing indicator, encrypted CDN media download/upload, inbound dedup. |
| `wechat-conversation-node` | WeChat to DSH bridge: allowlist gate, session targeting, commands, context rotation, multimodal media helpers (OCR/STT/TTS/image-gen/file/video), reminders & morning weather, digest outbound, approvals, light control. |

## 2. Read this first

- **One poller per account.** iLink allows exactly ONE authenticated poller
  per bot token. Running a second instance of this bridge (or any other iLink
  client) against the same WeChat account causes HTTP 403 and dropped messages.
  Use a **dedicated WeChat account**, never two instances per token.
- **Unofficial gateway.** Tencent may restrict the account. Use an account you
  are willing to lose.
- **Protocol details are reconstructed.** The iLink wire format was generalised
  from existing clients; recorded transcripts live in
  `test/fixtures/inbound.ndjson` so CI never needs a live account.

## 3. Quickstart

Prerequisites: Node >= 22, pnpm, a dedicated WeChat account, and a DSH
profile.

```sh
git clone https://github.com/PRTS168/dsh-wechat-suite.git
cd dsh-wechat-suite
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

Restart dsh web, then send a WeChat message to the bot. To get the admin
console too:

```sh
node admin/server.ts          # or admin/start-admin.bat on Windows
# -> http://127.0.0.1:8790/   (token minted into admin/.admin-token)
```

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
    contextPolicy: '{"scheme":"manual"}'   # see §0.2
    # imageInputModel: amd/DeepSeek-V4-Flash-Vision-Exp  # vision route for pictures only
    # agentPreset: wechat             # optional persona preset (lives outside this repo)
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

### Standalone admin console

`node admin/server.ts [--port 8790]` (`admin/start-admin.bat` on Windows)
starts a loopback-only HTTP console, separate from DSH:

| Tab | What it does |
| --- | --- |
| Config | every `CONFIG_FIELDS` key of the bridge, secrets masked with an explicit reveal, validation + timestamped backup before writing |
| Conversations | `wechat-*` sessions with turns/tokens, transcript viewer, new session, forget (recoverable) |
| Context | one-click `contextPolicy` scheme switching plus knob tweaks |

Security posture: binds to `127.0.0.1` only, token minted on first start into
`admin/.admin-token` (override with `WECHAT_ADMIN_TOKEN`), every API call needs
that token, mutations additionally need the `x-wechat-admin: 1` guard header,
and the `Host` header must be a loopback authority (so a DNS-rebinding page
cannot reach it). Session commands are queued on disk
(`$DSH_HOME/wechat-admin/queue/`) and executed by the bridge within ≤ 2 s; the
console also shows the bridge's last reports. The file is git-ignored — do not
commit it.

There is no in-GUI settings page since v0.3.0 (§0.3).

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
| `/开灯` `/开灯1\|2\|3` `/关灯` | ESP32 light control (gear 3 / low / mid / high, off) |
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
| `send_email(to, subject, body)` | plain-text mail over the configured SMTP account |
| `control_esp32_light(mode)` | `query` / `off` / `low` / `mid` / `high` on the LAN light |
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
pnpm test           # node --test test/*.test.ts — 154 tests, no WeChat account
pnpm smoke          # manual live-account check
pnpm setup          # interactive config wizard
```

- `test/fake-ilink-server.ts` implements the iLink endpoints (long-poll,
  sendmessage, sendtyping, getconfig, QR login, encrypted CDN download) and
  replays `test/fixtures/inbound.ndjson`; the inbound-to-session-to-outbound
  loop runs offline in CI (`.github/workflows/ci.yml`).
- Test coverage includes gateway dedup (message id *and* payload fingerprint),
  inbound routing / media failure paths / message envelope, the command surface,
  the approval bridge, context rotation policies (including the token-budget
  fallback chain), light control, preset compatibility across both host
  versions, and `boot-safety.test.ts`, which pins the "never produce an
  unhandled rejection" property that used to crash the host.
- Honest gaps (not yet unit-tested): OCR success/failure branches, the
  voice-download-to-ASR flow, outbound media upload (the fake server has no
  `/upload`), `/send`, `/help`, restart resume, and the native-image block
  itself (`vision.test.ts` covers the mode/policy decision against a stub
  catalog; `attachments.saveImage` runs only on a live host). Live smoke covers
  the happy paths.
- DSH is a developer preview; see §0.1 for the two host versions this tree is
  known to load on.

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
- The context-size proxy for `rotate-pressure` counts serialized event
  characters, not model tokens; `rotate-tokens` is the accurate one when the
  host exposes session projections.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| iLink exclusive lock — two pollers on one token -> 403 + dropped messages | Dedicated account; loud fatal error + polling stop on 403 |
| Account restriction — unofficial gateway | Dedicated, disposable account; stated plainly in this README |
| DSH v0.1 churn | Two host versions verified (§0.1); optional services via `ctx.get()`; boot-safety tests |
| An unhandled rejection killing the host | All async entry points resolve; `.catch()` at call sites; hot-reload stress pass |
| Protocol opacity | Protocol ported from hermes-agent; recorded fixtures |
| Credential files in the repo root | `client-config.json` / `account.json` / `admin/.admin-token` are git-ignored |

## 10. Version history

### v0.3.0 — stability, context lifecycle, standalone console

- `contextPolicy` schemes (`manual` / `rotate-turns` / `rotate-turns+handoff` /
  `rotate-pressure` / `rotate-tokens` / `daily`) with real projection-backed
  token accounting, idle-only rotation, and a queued free handoff note (§0.2).
- Host stability: no unhandled rejections from startup, inbound handling or
  outbound sending; `ctx.get()` + re-read after every `await`; the `config-api`
  plugin row removed (§0.3).
- Failure visibility: fenced inbound envelope, media-failure notices that can
  actually be delivered, payload-fingerprint dedup for messages without an id
  (§0.4).
- Features: standalone admin console with recoverable session removal,
  `control_esp32_light` restored as a tool (§0.5).
- 154 offline unit tests (was 86).

### v0.2.2 — DeepSeek 4.1 multimodal + native image input

- Inbound pictures reach the model as a real `image` block when the routed
  model declares image input, and as DeepSeek-OCR text otherwise; `imageInput`
  and `/识图` choose the policy, and a route that refuses an image is
  suppressed for three hours.
- Declaring the modality is the switch: the harness gates image blocks on the
  model's declared `inputModalities`, and the adapter's built-in catalog
  predates DeepSeek 4.1 — see §4 for the `models:` snippet (it *replaces* the
  plugin catalog rather than extending it).
- `send_email` over implicit-TLS SMTP; `client-config.json` / `account.json`
  git-ignored.

### v0.2.1 — Web management page and persona editing

- **Settings → Plugins → "微信桥配置"** edited every placeholder in the browser,
  with masked secrets and timestamped backups; the same page edited agent
  preset personas. *(Removed in v0.3.0 — see §0.3/§0.6.)*

### v0.2.0 — `/perm`, and files & videos both ways

- `/perm` two-step permission-preset switcher, plus `pnpm setup`.
- Inbound files/videos download and decrypt to `mediaDir` with the original
  name preserved; `wechat_send_file` / `wechat_send_video` send local files and
  clips back.
- Persona residue removed from the repo; upstream fork attribution added.

## 11. Roadmap

- Next: group chats (opt-in, risk-heavy), multi-account, a shared-poller proxy
  to coexist with hermes/openclaw.
- Later: WeCom / DingTalk / Feishu bundles reusing the `node/` layer.

## License

MIT — see [LICENSE](LICENSE).
