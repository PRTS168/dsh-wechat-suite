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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** Convert mp3 bytes to tencent-flagged silk v3 bytes. */
export function mp3ToSilk(mp3) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-silk-'));
    const mp3Path = join(dir, 'in.mp3');
    const wavPath = join(dir, 'in.wav');
    const silkPath = join(dir, 'out.silk');
    const scriptPath = join(dir, 'enc.py');
    try {
        writeFileSync(mp3Path, Buffer.from(mp3));
        // 1) mp3 → 24 kHz mono s16 PCM wav.
        const ffmpeg = spawnSync('ffmpeg', ['-y', '-i', mp3Path, '-ar', '24000', '-ac', '1', '-sample_fmt', 's16', wavPath], { encoding: 'utf8' });
        if (ffmpeg.status !== 0 || !fileExists(wavPath)) {
            throw new Error(`ffmpeg mp3→wav failed: ${(ffmpeg.stderr ?? '').slice(-300)}`);
        }
        // 2) wav → tencent silk (pilk).
        const script = [
            'import sys',
            'from pilk import SilkEncoder',
            'enc = SilkEncoder(pcm_rate=24000, silk_rate=24000)',
            `n = enc.encode(${JSON.stringify(wavPath)}, ${JSON.stringify(silkPath)}, tencent=True)`,
            'print("frames", n)',
        ].join('\n');
        writeFileSync(scriptPath, script, 'utf8');
        const py = spawnSync('python', [scriptPath], { encoding: 'utf8' });
        if (py.status !== 0 || !fileExists(silkPath)) {
            throw new Error(`pilk encode failed: ${(py.stderr ?? '').slice(-300)}`);
        }
        return readFileSync(silkPath);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
function fileExists(p) {
    try {
        readFileSync(p);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=silk.js.map