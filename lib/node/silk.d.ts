/**
 * mp3 → WeChat SILK v3 conversion for outbound voice notes.
 *
 * WeChat plays bot-sent voice notes only in its own SILK v3 format (with the
 * tencent `\x02` prefix header). This module converts an mp3 buffer through
 * two external steps: ffmpeg decodes to 24 kHz mono 16-bit PCM, then the
 * `pilk` Python module (a Tencent SILK encoder binding) produces the
 * tencent-flagged silk bytes.
 *
 * Runtime deps (must exist on PATH): `ffmpeg`, `python` with `pilk`.
 *
 * @module @dsh-cowork/chatnode-wechat/node/silk
 */
/** Convert mp3 bytes to tencent-flagged silk v3 bytes. */
export declare function mp3ToSilk(mp3: Uint8Array): Buffer;
//# sourceMappingURL=silk.d.ts.map