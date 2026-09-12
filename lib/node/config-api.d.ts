/**
 * Host-side HTTP API behind the WeChat bridge's Web management page.
 *
 * Registered as a second plugin of the bundle (`dsh-chatnode-wechat/config-api`).
 * The web server is OPTIONAL (profile-dependent), so this row stays activatable
 * everywhere and simply no-ops in a profile that has none (headless / TUI).
 *
 * Routes (all under `/dsh-chatnode-wechat/api`, loopback-only, guarded by a
 * custom header so cross-site requests cannot reach them):
 *   GET  /schema  → editable placeholder metadata
 *   GET  /config  → current values (secrets masked) + environment status
 *   POST /save    → { updates: { key: value | null } } → patch, backup, reload
 *
 * @module @dsh-cowork/chatnode-wechat/node/config-api
 */
/**
 * No hard service dependency. `webServer` is optional — see `apply()` for why it
 * must never be listed here: a service that the profile never provides leaves
 * this row pending forever, and dsh-app-boot then fails the ENTIRE profile with
 * "plugin tree failed to load: 1 entry did not activate". That is exactly what
 * headless profiles did before this was fixed.
 */
export declare const inject: string[];
/** Read the persona scalar (`prefix:` in 0.1.5, `text:` in older presets). */
export declare function readPersonaText(text: string): string | null;
/**
 * Rewrite the persona scalar in a preset file, touching nothing else.
 *
 * Always emits the 0.1.5 key `prefix:` — including when rewriting a legacy
 * `text:` row, so one save from the Web page repairs a preset the upgrade made
 * unmountable. Only the scalar's key and body change; every sibling key of the
 * persona row (`suffix:`, `complete:`, `includeRuntimeContext:`) and every other
 * row is preserved. Exported for tests: `writePersona()` only adds the file
 * read, backup, and write around it.
 */
export declare function replacePersonaText(text: string, persona: string): string;
interface WebServerService {
    register: (route: {
        kind: 'prefix';
        path: string;
        handler: (req: any, res: any) => Promise<void> | void;
    }) => () => void;
}
interface ConfigApiContext {
    inject?: (deps: string[], callback: (ctx: any) => void) => unknown;
    get?: (name: string) => unknown;
    webServer?: WebServerService;
    logger?: {
        info?: (...args: any[]) => void;
    };
    effect?: (fn: () => () => void) => void;
}
/**
 * Bundle row `dsh-chatnode-wechat/config-api`.
 *
 * `webServer` is OPTIONAL, so it must never sit in `inject`: an optional service
 * that never appears would leave this row pending, and dsh-app-boot fails the
 * whole profile ("plugin tree failed to load: 1 entry did not activate").
 * Subscribing through `ctx.inject()` instead keeps the row activatable in every
 * profile and still wires the routes in any profile that does provide a web
 * server. Profiles without one (headless / TUI / rescue) simply no-op here.
 */
export declare function apply(ctx: ConfigApiContext): void;
export {};
//# sourceMappingURL=config-api.d.ts.map