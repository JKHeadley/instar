/**
 * SEC-164 part 1: the one shared detection (findWallCredentialSpans) behind the outbound wall, the
 * log wrapper, the inbound mask, the copy scrub and the sweeper. Fake keys are built at run time so
 * no key-shaped literal sits in the source.
 */
import { describe, it, expect } from 'vitest';
import {
  findWallCredentialSpans, maskCredentials, OwnCredentialMatcher, CREDENTIAL_REMOVED_MARKER, detectOutboundCredential,
} from '../../src/messaging/outbound-credential-guard.js';

const botId = '123456789';
const botSecret = 'AA' + 'b'.repeat(16) + 'C' + 'd'.repeat(16); // 35 chars, mixed case
const botToken = `${botId}:${botSecret}`;
const ghToken = 'ghp_' + 'x'.repeat(36);
const pem = '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(64) + '\n' + 'B'.repeat(64) + '\n-----END PRIVATE KEY-----';

describe('SEC-164: findWallCredentialSpans', () => {
  it('finds a bot key alone, and the bot<id>:<secret> form inside a Telegram API address', () => {
    expect(findWallCredentialSpans(`token ${botToken} here`)).toHaveLength(1);
    const url = `https://api.telegram.org/bot${botToken}/getUpdates`;
    const spans = findWallCredentialSpans(url);
    expect(spans).toHaveLength(1);
    expect(url.slice(spans[0]!.start, spans[0]!.end)).toContain(botSecret);
  });

  it('does not match robot<digits>, and padding after a key cannot hide it', () => {
    expect(findWallCredentialSpans(`robot${botToken}`)).toHaveLength(0);
    const padded = `${botToken}${'z'.repeat(40)}`;
    const spans = findWallCredentialSpans(padded);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toBe(0);
    expect(detectOutboundCredential(padded).detected).toBe(true);
  });

  it('finds a key after a newline once a JSON string is decoded (the sweeper scans decoded literals), and a PEM block', () => {
    const raw = JSON.stringify({ out: `line one\n${ghToken}` });
    // Raw JSON hides the boundary behind the escape's "n"; that is why the sweeper decodes each literal.
    expect(findWallCredentialSpans((JSON.parse(raw) as { out: string }).out).length).toBeGreaterThan(0);
    expect(findWallCredentialSpans(pem).map((s) => s.kind)).toContain('pem-private-key');
  });

  it('finds a key with a zero-width character inside it, and returns its full original span', () => {
    const zw = ghToken.slice(0, 10) + '​' + ghToken.slice(10);
    const text = `x ${zw} y`;
    const spans = findWallCredentialSpans(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe(zw);
  });

  it('strips astral invisible characters (Unicode tag characters) exactly as the wall always did', () => {
    const tag = String.fromCodePoint(0xe0020);
    const smuggled = [...ghToken].join(tag);
    expect(detectOutboundCredential(smuggled).detected).toBe(true);
    const spans = findWallCredentialSpans(`x ${smuggled} y`);
    expect(spans).toHaveLength(1);
    expect(maskCredentials(`x ${smuggled} y`).text).toBe(`x ${CREDENTIAL_REMOVED_MARKER} y`);
  });

  it('the wall decides exactly when the span finder finds something, and names the same kind as before', () => {
    const both = `${botToken} then ${ghToken}`;
    expect(detectOutboundCredential(both)).toEqual({ detected: true, kind: 'github-token' }); // pattern order, as before
    for (const t of [both, 'plain text', `robot${botToken}`, `msg_${botToken}`, pem]) {
      expect(detectOutboundCredential(t).detected).toBe(findWallCredentialSpans(t).length > 0);
    }
  });

  it('only the wall kinds: label-proximity, bearer and JWT shapes are not matched', () => {
    expect(findWallCredentialSpans('disable password authentication in the sshd config')).toHaveLength(0);
    expect(findWallCredentialSpans('Authorization: Bearer YOUR_DASHBOARD_TOKEN_HERE')).toHaveLength(0);
  });
});

describe('SEC-164: own credentials by exact value', () => {
  it('matches only the listed values, never holding them, and ignores short or all-digit values', () => {
    const own = 'mY-own-api-token-' + 'q'.repeat(10);
    const m = new OwnCredentialMatcher([own, '123456', 'short', '-1001234567890']);
    expect(m.size).toBe(1); // the PIN, a short value and the signed chat id are never matched
    const spans = findWallCredentialSpans(`use ${own} now`, { ownCredentials: m });
    expect(spans.map((s) => s.kind)).toEqual(['own-credential']);
    expect(findWallCredentialSpans(`use ${own} now`)).toHaveLength(0); // never on the wall
    expect(JSON.stringify(m)).not.toContain(own);
  });
});

describe('SEC-164: maskCredentials', () => {
  it('replaces each key with the one marker and reports kinds, never values', () => {
    const r = maskCredentials(`a ${botToken} b ${ghToken} c`);
    expect(r.text).toBe(`a ${CREDENTIAL_REMOVED_MARKER} b ${CREDENTIAL_REMOVED_MARKER} c`);
    expect(r.kinds.sort()).toEqual(['github-token', 'telegram-bot-token']);
    expect(JSON.stringify(r)).not.toContain(botSecret);
  });

  it('the same text masks to identical text every time', () => {
    const t = `hi ${botToken}`;
    expect(maskCredentials(t).text).toBe(maskCredentials(t).text);
  });

  it('leaves ordinary text alone', () => {
    const t = 'pid 4242: done in 3s; hash 0123456789abcdef';
    expect(maskCredentials(t)).toEqual({ text: t, kinds: [] });
  });
});

describe('SEC-164: the switch', () => {
  it('reads security.credentialScrub.enabled, defaulting to the development-agent flag', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { credentialScrubEnabledReader } = await import('../../src/core/outputCredentialScrub.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec164-'));
    fs.mkdirSync(path.join(dir, '.instar'));
    const write = (c: object) => fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify(c));
    write({}); expect(credentialScrubEnabledReader(dir)()).toBe(false);
    write({ developmentAgent: true }); expect(credentialScrubEnabledReader(dir)()).toBe(true);
    write({ developmentAgent: true, security: { credentialScrub: { enabled: false } } }); expect(credentialScrubEnabledReader(dir)()).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('SEC-164: the Telegram request address never reaches a log line', () => {
  it('no log statement in the source formats a Telegram bot address', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../../src');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          fs.readFileSync(p, 'utf-8').split('\n').forEach((line, i) => {
            if (/console\.(log|warn|error|info)\(/.test(line) && /api\.telegram\.org\/bot\$\{/.test(line)) offenders.push(`${path.relative(root, p)}:${i + 1}`);
          });
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('SEC-164: the output wrapper', () => {
  it('scrubOutputText masks a key in a log line and passes ordinary text', async () => {
    const { scrubOutputText } = await import('../../src/core/outputCredentialScrub.js');
    expect(scrubOutputText(`error at https://api.telegram.org/bot${botToken}/getUpdates\n`)).not.toContain(botSecret);
    expect(scrubOutputText('all good\n')).toBe('all good\n');
  });

  it('is installed only by the server start and lifeline start handlers, never by an import', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = path.resolve(__dirname, '../../src');
    const callers: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('outputCredentialScrub.ts') && /installOutputScrub\(/.test(fs.readFileSync(p, 'utf-8'))) callers.push(path.relative(src, p));
      }
    };
    walk(src);
    expect(callers.sort()).toEqual(['cli.ts', 'commands/server.ts']);
    const mcp = fs.readFileSync(path.join(src, 'threadline/mcp-stdio-entry.ts'), 'utf-8');
    expect(mcp).not.toMatch(/installOutputScrub|outputCredentialScrub/);
  });

  it('wraps a stream: a key split across two writes is masked, callbacks fire, and off passes through', async () => {
    const { wrapStream } = await import('../../src/core/outputCredentialScrub.js');
    const chunks: string[] = [];
    const fake = { write: (c: unknown) => { chunks.push(Buffer.isBuffer(c) ? c.toString('utf8') : String(c)); return true; } } as unknown as NodeJS.WriteStream;
    let on = true;
    wrapStream(fake, () => on, false);
    const half = Math.floor(botToken.length / 2);
    let called = 0;
    fake.write(`a ${botToken.slice(0, half)}`);
    fake.write(`${botToken.slice(half)} b\n`, () => { called++; });
    await new Promise((r) => setTimeout(r, 5));
    expect(chunks.join('')).toBe(`a ${CREDENTIAL_REMOVED_MARKER} b\n`);
    expect(called).toBe(1);
    on = false;
    fake.write(`raw ${botToken}\n`);
    expect(chunks.at(-1)).toContain(botSecret); // off: passed straight through
    on = true;
    const euro = Buffer.from('cost \u20ac5\n');
    fake.write(euro.subarray(0, 6));
    fake.write(euro.subarray(6));
    expect(chunks.at(-1)).toBe('cost \u20ac5\n'); // a character split across two Buffer writes stays whole
    const bytes: Buffer[] = [];
    const raw = { write: (c: unknown) => { bytes.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true; } } as unknown as NodeJS.WriteStream;
    let rawOn = true;
    wrapStream(raw, () => rawOn, false);
    raw.write('caf\u00e9\n', 'latin1');
    expect(bytes.at(-1)!.toString('hex')).toBe('636166e90a'); // latin1 bytes unchanged
    raw.write(Buffer.from([0xc3]));
    rawOn = false;
    raw.write(Buffer.from([0xa9, 0x0a]));
    expect(Buffer.concat(bytes.slice(-2)).toString('hex')).toBe('c3a90a'); // a half character is not lost when switched off
    rawOn = true;
    raw.write(Buffer.from([0xff, 0xfe, 0x0a]));
    expect(bytes.at(-1)!.toString('hex')).toBe('fffe0a'); // non-UTF-8 bytes pass unchanged // a half character is not lost when switched off

  });
});
