/**
 * Email sending: a dependency-free SMTP client for the `send_email` tool.
 *
 * Ported from the retired `dsh-wechat-tools` plugin so the bridge keeps the
 * capability after that plugin was archived. Zero runtime dependencies: the
 * client speaks implicit-TLS SMTP (smtp.qq.com:465 style) over `node:tls` and
 * only supports AUTH LOGIN with a plain-text body — enough for an alert mail,
 * deliberately not a general mail library.
 *
 * @module @dsh-cowork/chatnode-wechat/node/email
 */
/** The slice of a socket the SMTP state machine actually uses. */
export interface SmtpSocket {
    setEncoding(encoding: BufferEncoding): unknown;
    on(event: 'data', listener: (chunk: string) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    write(line: string): unknown;
    end(): unknown;
    destroy(): unknown;
}
/** SMTP account settings (all required for a send to happen). */
export interface SmtpConfig {
    host: string;
    username: string;
    password: string;
    port?: number;
    /** Envelope/header sender; defaults to `username`. */
    fromEmail?: string;
    /** Display name on the From header; defaults to `username`. */
    fromName?: string;
    /** Whole-conversation deadline in ms (default 30s). */
    timeoutMs?: number;
    /**
     * Transport override. Production omits it and gets implicit-TLS
     * `tls.connect`; tests inject a fake socket to drive the protocol without a
     * certificate (a real TLS handshake is orthogonal to the command order this
     * state machine is responsible for).
     */
    connect?: (options: {
        host: string;
        port: number;
    }) => SmtpSocket;
}
/**
 * Send one plain-text mail over implicit-TLS SMTP with AUTH LOGIN.
 *
 * The exchange is a strict state machine: the socket's greeting must be read
 * before EHLO is sent (writing immediately would consume the 220 as the EHLO
 * reply), and each step advances only on its own expected reply code, so a
 * rejection surfaces as a specific error instead of a timeout.
 */
export declare function smtpSend(config: SmtpConfig, mail: {
    to: string;
    subject: string;
    body: string;
}): Promise<string>;
/** Send a mail through the configured SMTP account. */
export declare function sendEmail(config: SmtpConfig | undefined, mail: {
    to: string;
    subject: string;
    body: string;
}): Promise<string>;
//# sourceMappingURL=email.d.ts.map