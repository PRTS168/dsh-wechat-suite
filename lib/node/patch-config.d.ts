/**
 * Profile patch (`cordis.patch.yml`) reader/writer for the dsh-chatnode-wechat
 * bundle's configurable placeholders.
 *
 * Shared by two surfaces so behaviour cannot drift:
 *   - the CLI wizard `scripts/setup.mjs` (built to `lib/node/patch-config.js`)
 *   - the standalone admin console (`admin/server.ts`)
 *
 * Only the `- id: dsh-chatnode-wechat` entry's `config:` subtree is touched;
 * comments, unknown keys and other entries are preserved verbatim. A backup is
 * written next to the file before every modification.
 *
 * @module @dsh-cowork/chatnode-wechat/node/patch-config
 */
export declare const ENTRY_ID = "dsh-chatnode-wechat";
/** One editable placeholder. */
export interface ConfigField {
    key: string;
    label: string;
    group: string;
    /** Secrets are masked in every API/CLI response. */
    secret?: boolean;
    /** 'list' = a YAML sequence (allowFrom); 'number' = numeric scalar. */
    kind?: 'string' | 'number' | 'list';
    default?: string;
    placeholder?: string;
    hint?: string;
}
/** All placeholders the bridge accepts, in write order. */
export declare const CONFIG_FIELDS: ConfigField[];
export declare const KNOWN_KEYS: ReadonlySet<string>;
export declare function maskSecret(value: string): string;
/** Default patch path for a profile (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`). */
export declare function defaultPatchPath(profile?: string): string;
export declare function yamlStr(value: string): string;
interface ParsedPatch {
    lines: string[];
    found: boolean;
    entryStart: number;
    entryEnd: number;
    configIndent: number;
    current: Record<string, {
        indent: number;
        value?: string;
        list?: string[];
    }>;
}
/** Locate the managed entry and read its current config values. */
export declare function parsePatch(text: string): ParsedPatch;
export interface PatchValues {
    /** Scalar values by key (raw, secrets included — mask before display). */
    values: Record<string, string>;
    /** allowFrom entries. */
    allowFrom: string[];
}
export declare function extractValues(parsed: ParsedPatch): PatchValues;
/** Read the patch file; missing file is not an error. */
export declare function readPatchFile(file: string): Promise<{
    exists: boolean;
    parsed: ParsedPatch;
    patch: PatchValues;
}>;
export interface ApplyResult {
    changed: string[];
    backup?: string;
    file: string;
}
/**
 * Apply updates to the managed entry. `null` clears an optional key (or the
 * allowlist entry); `undefined`/absent leaves it untouched.
 */
export declare function applyPatchConfig(file: string, updates: Record<string, string | null | undefined>): Promise<ApplyResult>;
export {};
//# sourceMappingURL=patch-config.d.ts.map