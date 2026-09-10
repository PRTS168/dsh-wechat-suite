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
import tls from 'node:tls';
/**
 * Send one plain-text mail over implicit-TLS SMTP with AUTH LOGIN.
 *
 * The exchange is a strict state machine: the socket's greeting must be read
 * before EHLO is sent (writing immediately would consume the 220 as the EHLO
 * reply), and each step advances only on its own expected reply code, so a
 * rejection surfaces as a specific error instead of a timeout.
 */
export function smtpSend(config, mail) {
    return new Promise((resolve, reject) => {
        const port = config.port ?? 465;
        const fromEmail = config.fromEmail ?? config.username;
        const fromName = config.fromName ?? config.username;
        let buf = '';
        let stage = 0;
        const timer = setTimeout(() => fail(`SMTP timeout after ${config.timeoutMs ?? 30_000}ms`), config.timeoutMs ?? 30_000);
        const connect = config.connect ?? ((options) => tls.connect({ host: options.host, port: options.port, servername: options.host }, () => { }));
        const socket = connect({ host: config.host, port });
        function send(line) {
            socket.write(line + '\r\n');
        }
        function fail(msg) {
            clearTimeout(timer);
            socket.destroy();
            reject(new Error(msg));
        }
        function finish() {
            clearTimeout(timer);
            socket.end();
            resolve('sent');
        }
        socket.setEncoding('utf8');
        socket.on('error', (error) => fail('smtp error: ' + error.message));
        socket.on('data', (chunk) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).replace(/\r$/, '');
                buf = buf.slice(idx + 1);
                if (line.length < 3 || line[3] === '-')
                    continue; // multi-line continuation
                const code = parseInt(line.slice(0, 3), 10);
                switch (stage) {
                    case 0: // server greeting (220) — consume it, then EHLO
                        if (code === 220) {
                            stage = 1;
                            send('EHLO dsh.local');
                        }
                        else
                            fail('unexpected greeting: ' + line);
                        break;
                    case 1: // EHLO (250)
                        if (code === 250) {
                            stage = 2;
                            send('AUTH LOGIN');
                        }
                        else
                            fail('EHLO failed: ' + line);
                        break;
                    case 2: // AUTH LOGIN (334)
                        if (code === 334) {
                            stage = 3;
                            send(Buffer.from(config.username, 'utf8').toString('base64'));
                        }
                        else
                            fail('AUTH LOGIN unsupported: ' + line);
                        break;
                    case 3: // username (334)
                        if (code === 334) {
                            stage = 4;
                            send(Buffer.from(config.password, 'utf8').toString('base64'));
                        }
                        else
                            fail('username rejected: ' + line);
                        break;
                    case 4: // password (235)
                        if (code === 235) {
                            stage = 5;
                            send(`MAIL FROM:<${fromEmail}>`);
                        }
                        else
                            fail('authentication failed: ' + line);
                        break;
                    case 5: // MAIL FROM (250)
                        if (code === 250) {
                            stage = 6;
                            send(`RCPT TO:<${mail.to}>`);
                        }
                        else
                            fail('MAIL FROM rejected: ' + line);
                        break;
                    case 6: // RCPT TO (250/251)
                        if (code === 250 || code === 251) {
                            stage = 7;
                            send('DATA');
                        }
                        else
                            fail('recipient rejected: ' + line);
                        break;
                    case 7: // DATA (354)
                        if (code === 354) {
                            stage = 8;
                            const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
                            const wrapped = b64(mail.body).replace(/(.{76})/g, '$1\r\n');
                            // RFC 2047 encoded-words keep a CJK subject/name intact.
                            const header = 'From: =?UTF-8?B?' + b64(fromName) + '?= <' + fromEmail + '>\r\n' +
                                'To: <' + mail.to + '>\r\n' +
                                'Subject: =?UTF-8?B?' + b64(mail.subject) + '?=\r\n' +
                                'MIME-Version: 1.0\r\n' +
                                'Content-Type: text/plain; charset=UTF-8\r\n' +
                                'Content-Transfer-Encoding: base64\r\n\r\n';
                            send(header + wrapped + '\r\n.');
                        }
                        else
                            fail('DATA rejected: ' + line);
                        break;
                    case 8: // final (250)
                        if (code === 250) {
                            send('QUIT');
                            finish();
                        }
                        else
                            fail('message rejected: ' + line);
                        break;
                    default:
                        break;
                }
            }
        });
    });
}
/** Send a mail through the configured SMTP account. */
export async function sendEmail(config, mail) {
    if (!config?.host || !config.username || !config.password) {
        throw new Error('SMTP 未配置：请在 profile 的 dsh-chatnode-wechat 配置里填 smtpHost / smtpUsername / smtpPassword');
    }
    if (!mail.to || !mail.subject)
        throw new Error('send_email: 收件人与主题都是必填');
    await smtpSend(config, mail);
    return `邮件已发送至 ${mail.to}`;
}
//# sourceMappingURL=email.js.map