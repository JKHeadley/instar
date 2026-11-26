/**
 * SEC-164 part 1 slice 1c: the same-length JSON line mask (§3.1, §3.2) and the transcript copy scrub
 * (§3.4). Fake keys are built at run time so no key-shaped literal sits in the source.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { maskJsonLine, maskJsonlBuffer, sameLengthMask } from '../../src/core/credentialLineMask.js';
import { credentialScrubModeReader } from '../../src/core/outputCredentialScrub.js';
import { CREDENTIAL_REMOVED_MARKER } from '../../src/messaging/outbound-credential-guard.js';

const gh = 'ghp_' + 'x'.repeat(36);
const pem = '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(64) + '\n' + 'B'.repeat(64) + '\n-----END PRIVATE KEY-----';
const line = (o: unknown) => Buffer.from(JSON.stringify(o) + '\n', 'utf8');
const on = { apply: true };

describe('SEC-164 1c: maskJsonLine', () => {
  it('masks a key inside a value at the same byte length, and the line re-reads with the same keys', () => {
    const src = line({ type: 'tool_result', content: `token: ${gh} done` });
    const r = maskJsonLine(src, on);
    expect(r.masked).toBe(1);
    expect(r.line.length).toBe(src.length);
    const back = JSON.parse(r.line.toString('utf8'));
    expect(Object.keys(back)).toEqual(['type', 'content']);
    expect(back.content).toBe(`token: ${sameLengthMask(gh.length)} done`);
    expect(back.content.startsWith(`token: ${CREDENTIAL_REMOVED_MARKER}`)).toBe(true);
    expect(r.line.toString('utf8')).not.toContain(gh);
  });

  it('never changes a key name', () => {
    const src = Buffer.from(`{"${gh}":"value"}\n`);
    const r = maskJsonLine(src, on);
    expect(r.masked).toBe(0);
    expect(r.line.equals(src)).toBe(true);
  });

  it('finds a key after an escaped newline, and a PEM block written with escapes', () => {
    const a = maskJsonLine(line({ out: `first line\n${gh}` }), on);
    expect(a.masked).toBe(1);
    expect(JSON.parse(a.line.toString()).out).not.toContain(gh);
    const b = maskJsonLine(line({ out: pem }), on);
    expect(b.kinds).toContain('pem-private-key');
    const back = JSON.parse(b.line.toString()).out as string;
    expect(back).not.toContain('A'.repeat(64));
    expect(b.line.length).toBe(line({ out: pem }).length);
  });

  it('keeps byte offsets right after multibyte characters', () => {
    const src = line({ text: `héllo wörld ✓ ${gh} after` });
    const r = maskJsonLine(src, on);
    expect(r.line.length).toBe(src.length);
    const back = JSON.parse(r.line.toString('utf8')).text as string;
    expect(back.startsWith('héllo wörld ✓ ')).toBe(true);
    expect(back.endsWith(' after')).toBe(true);
    expect(back).not.toContain(gh);
  });

  it('scans a literal hidden behind a duplicate key', () => {
    const src = Buffer.from(`{"a":"${gh}","a":"later"}\n`);
    const r = maskJsonLine(src, on);
    expect(r.masked).toBe(1);
    expect(r.line.toString()).not.toContain(gh);
    expect(r.line.length).toBe(src.length);
  });

  it('leaves integrity-bound fields and media data unchanged, and reports them as unmeasured', () => {
    const thinking = line({ type: 'thinking', thinking: `I saw ${gh}`, signature: 'sig' });
    const r1 = maskJsonLine(thinking, on);
    expect(r1.line.equals(thinking)).toBe(true);
    expect(r1.unmeasured).toBe(1);
    const enc = line({ encrypted_content: `x ${gh}` });
    expect(maskJsonLine(enc, on).line.equals(enc)).toBe(true);
    const img = line({ type: 'image', source: { data: 'iVBORw0KGgo' + 'ghp_' + 'Q'.repeat(36) } });
    const r3 = maskJsonLine(img, on);
    expect(r3.line.equals(img)).toBe(true);
  });

  it('a pathologically deep line is left alone and never throws', () => {
    const deep = Buffer.from('['.repeat(20000) + JSON.stringify(gh) + ']'.repeat(20000) + '\n');
    expect(() => maskJsonLine(deep, on)).not.toThrow();
  });

  it('the dry run counts and changes nothing', () => {
    const src = line({ content: gh });
    const r = maskJsonLine(src, { apply: false });
    expect(r.masked).toBe(1);
    expect(r.line.equals(src)).toBe(true);
  });

  it('a line that is not JSON is reported unscannable and left alone', () => {
    const src = Buffer.from(`not json ${gh}\n`);
    const r = maskJsonLine(src, on);
    expect(r.unscannable).toBe(true);
    expect(r.line.equals(src)).toBe(true);
  });

  it('a short span is overwritten byte for byte with stars, never a quote or a backslash', () => {
    expect(sameLengthMask(5)).toBe('*****');
    expect(sameLengthMask(25)).toBe(CREDENTIAL_REMOVED_MARKER + '     ');
    for (const n of [1, 19, 20, 64]) expect(sameLengthMask(n)).not.toMatch(/["\\]/);
  });

  it('masks every line of a JSONL buffer and keeps its total length', () => {
    const buf = Buffer.concat([line({ a: gh }), line({ b: 'clean' }), Buffer.from('plain text\n'), line({ c: `x ${gh}` })]);
    const r = maskJsonlBuffer(buf, on);
    expect(r.buf.length).toBe(buf.length);
    expect(r.masked).toBe(2);
    expect(r.unscannable).toBe(1);
    expect(r.buf.toString()).not.toContain(gh);
    expect(r.buf.toString()).toContain('plain text\n');
  });
});

describe('SEC-164 1c: the copy scrub mode', () => {
  it('reads off, dry run and on from the settings file', async () => {
    const os = await import('node:os');
    const { SafeFsExecutor } = await import('../../src/core/SafeFsExecutor.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec164-mode-'));
    try {
      fs.mkdirSync(path.join(dir, '.instar'));
      const write = (cfg: unknown) => fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify(cfg));
      write({});
      expect(credentialScrubModeReader(dir)()).toBe('off');
      write({ developmentAgent: true });
      expect(credentialScrubModeReader(dir)()).toBe('dry-run');
      write({ developmentAgent: true, security: { credentialScrub: { inPlace: true } } });
      expect(credentialScrubModeReader(dir)()).toBe('on');
      write({ developmentAgent: true, security: { credentialScrub: { enabled: false, inPlace: true } } });
      expect(credentialScrubModeReader(dir)()).toBe('off');
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/sec164-line-mask.test.ts' }); }
  });

  it('the copy source masks rows before redaction and the receipt masks after the hash check', () => {
    const src = fs.readFileSync(path.resolve('src/core/transcriptCheckpoints.ts'), 'utf-8');
    const tick = src.indexOf("if (mode !== 'off') rows = rows.map((r) => scrubCopyRow(r, mode, 'source'));");
    expect(tick).toBeGreaterThan(0);
    expect(src.indexOf('rows = rows.map((r) => redactRow(r, secrets));', tick)).toBeGreaterThan(tick);
    const check = src.indexOf('if (body.length !== parsed.bytes || sha(body) !== parsed.sha256');
    const mask = src.indexOf("body: mode === 'off' ? body : scrubCopyBody(body, mode)");
    expect(mask).toBeGreaterThan(check);
    expect(src.indexOf('fs.writeSync(fd, done.body')).toBeGreaterThan(mask);
    expect(fs.readFileSync(path.resolve('src/commands/server.ts'), 'utf-8')).toContain('credentialScrubMode: credentialScrubModeReader(config.projectDir),');
  });
});

describe('SEC-164 1c: the app conversation notice and own-key matching are wired', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(p), 'utf-8');
  it('the app route passes the session note and calls the notice for the owner or a team member', () => {
    const src = read('src/server/mobileConversationRoutes.ts');
    expect(src).toContain('sessionNote: sessionRemovedKeyNote(credTeam && !!deps.credentialNotice)');
    expect(src).toContain('deps.credentialNotice({ conversationKey: key, messageId })');
    expect(read('src/core/appConversationPool.ts')).toContain('...(input.sessionNote ? [input.sessionNote] : [])');
    expect(read('src/server/AgentServer.ts')).toContain('credentialNotice: (input) => routeCtx.appCredentialNotice?.(input),');
  });
  it('the notice is a server-written agent message, appended once per message', () => {
    const src = read('src/server/routes.ts');
    const at = src.indexOf('ctx.appCredentialNotice = ({ conversationKey, messageId }) => {');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, at + 2500);
    expect(body).toContain("derivedEventId('ag', conversationKey, `sec164-notice:${messageId}`)");
    expect(body).toContain('if (app.store.hasEvent(conversationKey, eventId)) return;');
    expect(body).toContain('text: teamMemberNotice(link)');
  });
  it('inbound masking also matches the agent\'s own configured keys by exact value', () => {
    const src = read('src/server/routes.ts');
    expect(src).toContain('new OwnCredentialMatcher([ctx.config.authToken, liveToken, tg?.token, sl?.botToken, sl?.appToken,');
    expect(read('src/server/inboundCredentialNotice.ts')).toContain('maskInbound(text, { enabled, ownCredentials: own,');
  });
});
