/**
 * Host-side HTTP API behind the WeChat bridge's Web management page.
 *
 * Registered as a second plugin of the bundle (`dsh-chatnode-wechat/config-api`)
 * so profiles without a web server (headless) simply never load it.
 *
 * Routes (all under `/dsh-chatnode-wechat/api`, loopback-only, guarded by a
 * custom header so cross-site requests cannot reach them):
 *   GET  /schema  → editable placeholder metadata
 *   GET  /config  → current values (secrets masked) + environment status
 *   POST /save    → { updates: { key: value | null } } → patch, backup, reload
 *
 * @module @dsh-cowork/chatnode-wechat/node/config-api
 */
export declare const inject: string[];
export declare function apply(ctx: {
    webServer: {
        register: (route: {
            kind: 'prefix';
            path: string;
            handler: (req: any, res: any) => Promise<void> | void;
        }) => () => void;
    };
    logger?: {
        info?: (...args: any[]) => void;
    };
    effect?: (fn: () => () => void) => void;
}): void;
//# sourceMappingURL=config-api.d.ts.map