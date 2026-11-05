/**
 * Asking for a key and cancelling a request from the phone (docs/specs/mobile-native-secrets-writes.md):
 * the action lines, every input refusal, and the two SecretDrop calls on both sides.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { actionLine, buildAction, MAX_SECRET_LABEL_CHARS, MAX_SECRET_NOTE_CHARS } from '../../src/server/mobilePermissionsRoutes.js';
import { askForSecret, cancelSecretByKey, PHONE_REQUEST_TTL_MS, type SecretDropWrites } from '../../src/server/mobileSecretsRoutes.js';
import { rowKey } from '../../src/server/mobileCapacityRoutes.js';
import { SecretDrop } from '../../src/server/SecretDrop.js';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const NOW = 1_800_000_000_000;
const TOKEN = 'a'.repeat(64);

function fake(rows: Array<{ token: string; label: string; expiresAt: number; expired: boolean }> = []) {
  const made: unknown[] = [];
  const cancelled: string[] = [];
  const drop: SecretDropWrites = {
    create: (o) => { made.push(o); return { token: TOKEN }; },
    cancel: (t) => { cancelled.push(t); return true; },
    listPending: () => rows,
  };
  return { drop, made, cancelled };
}

describe('the action lines', () => {
  it('a request names the label, note and conversation by exact value, and a change makes a different line', () => {
    const a = buildAction('request-secret', 'new', { label: 'OpenAI key', note: 'For the bot', topicId: 12 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(actionLine(a.action)).toBe(`request-secret new ${sha('OpenAI key')} ${sha('For the bot')} 12`);
    const b = buildAction('request-secret', 'new', { label: 'OpenAI key' });
    expect(b.ok && actionLine(b.action)).toBe(`request-secret new ${sha('OpenAI key')} ${sha('')} none`);
  });
  it('the vector the Swift tests also run: a non-ASCII label, no note, no conversation', () => {
    const a = buildAction('request-secret', 'new', { label: 'Clé Stripe', note: '' });
    expect(a.ok && actionLine(a.action)).toBe('request-secret new 243d7f39a74d489d862f758e9a91e497bd920dccec92b877c7bf0d089bbf1515 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 none');
  });
  it('a cancel names its key', () => {
    const a = buildAction('cancel-secret', 'abcdef0123456789', {});
    expect(a.ok && actionLine(a.action)).toBe('cancel-secret abcdef0123456789');
  });
});

describe('input refusals', () => {
  const ask = (label: unknown, extra: Record<string, unknown> = {}) => buildAction('request-secret', 'new', { label, ...extra });
  const code = (r: ReturnType<typeof ask>) => (r.ok ? 'ok' : r.error);
  it('a label is required, trimmed and bounded', () => {
    expect(code(ask(''))).toBe('label-required');
    expect(code(ask('   '))).toBe('label-required');
    expect(code(ask(undefined))).toBe('label-required');
    expect(code(ask(' padded'))).toBe('bad-label');
    expect(code(ask('key '.repeat(MAX_SECRET_LABEL_CHARS / 4 - 1) + 'key.'))).toBe('ok');
    expect(code(ask('key '.repeat(MAX_SECRET_LABEL_CHARS / 4) + 'key'))).toBe('label-too-long');
  });
  it('a note is bounded and a string', () => {
    expect(code(ask('k', { note: 'n'.repeat(MAX_SECRET_NOTE_CHARS) }))).toBe('looks-like-a-secret');
    expect(code(ask('k', { note: 'word '.repeat(MAX_SECRET_NOTE_CHARS / 5) }))).toBe('ok');
    expect(code(ask('k', { note: 'word '.repeat(MAX_SECRET_NOTE_CHARS / 5 + 1) }))).toBe('note-too-long');
    expect(code(ask('k', { note: 5 }))).toBe('note-too-long');
  });
  it('a pasted key or a control character is refused, in the label and the note', () => {
    expect(code(ask('0123456789abcdef0123'))).toBe('looks-like-a-secret');
    expect(code(ask('key ghp_' + 'Q'.repeat(36)))).toBe('looks-like-a-secret');
    expect(code(ask('ok', { note: 'it is 0123456789abcdef0123' }))).toBe('looks-like-a-secret');
    expect(code(ask('a\u0001b'))).toBe('bad-characters');
    expect(code(ask('a\nb'))).toBe('bad-characters');
    expect(code(ask('k', { note: 'a\u0001b' }))).toBe('bad-characters');
    expect(code(ask('k', { note: 'two\nlines' }))).toBe('ok');
    // Cleaning can join a token back together: fullwidth digits fold to plain ones.
    expect(code(ask('api.ａ１b2c3d4e5f60718'))).toBe('looks-like-a-secret');
    expect(code(ask('OpenAI API key'))).toBe('ok');
  });
  it('a conversation is none or a positive integer', () => {
    expect(code(ask('k', { topicId: null }))).toBe('ok');
    const digits = ask('k', { topicId: '12' });
    expect(digits.ok && actionLine(digits.action).endsWith(' 12')).toBe(true);
    for (const bad of [0, -1, 1.5, '012', 'abc', '1e3', Number.MAX_SAFE_INTEGER + 1]) expect(code(ask('k', { topicId: bad })), String(bad)).toBe('bad-topic');
  });
  it('a request has one target; a cancel takes only a row key', () => {
    expect(buildAction('request-secret', 'other', { label: 'k' })).toEqual({ ok: false, error: 'bad-target' });
    for (const bad of ['abc', 'A'.repeat(16), TOKEN, 'new']) expect(buildAction('cancel-secret', bad, {}), bad).toEqual({ ok: false, error: 'bad-target' });
  });
});

describe('askForSecret', () => {
  it('makes one request for an hour and answers its key, never the token', () => {
    const f = fake();
    const r = askForSecret(f.drop, 'OpenAI key', 'For the bot', 12, NOW);
    expect(r.status).toBe(201);
    expect(f.made).toEqual([{ label: 'OpenAI key', description: 'For the bot', topicId: 12, ttlMs: PHONE_REQUEST_TTL_MS }]);
    expect(r.body).toEqual({ ok: true, key: rowKey('secret-request', TOKEN), expiresAt: new Date(NOW + PHONE_REQUEST_TTL_MS).toISOString() });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });
  it('leaves out an empty note and no conversation', () => {
    const f = fake();
    askForSecret(f.drop, 'k', '', null, NOW);
    expect(f.made).toEqual([{ label: 'k', ttlMs: PHONE_REQUEST_TTL_MS }]);
  });
  it('refuses a second live request with the same name, ignoring case', () => {
    const f = fake([{ token: 't', label: 'OpenAI Key', expiresAt: NOW + 1000, expired: false }]);
    const r = askForSecret(f.drop, 'openai key', '', null, NOW);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'already-waiting' });
    expect(f.made).toEqual([]);
  });
  it('an ended request with the same name does not block', () => {
    const f = fake([{ token: 't', label: 'k', expiresAt: NOW - 1, expired: false }, { token: 'u', label: 'k', expiresAt: NOW + 1000, expired: true }]);
    expect(askForSecret(f.drop, 'k', '', null, NOW).status).toBe(201);
  });
  it('the pending cap reads as a fixed answer, with no raw error', () => {
    const f = fake();
    f.drop.create = () => { throw new Error('Too many pending secret requests (max 20)'); };
    const r = askForSecret(f.drop, 'k', '', null, NOW);
    expect(r.status).toBe(429);
    expect(JSON.stringify(r.body)).not.toContain('max 20');
  });
  it('any other failure is not dressed up as the cap', () => {
    const f = fake();
    f.drop.create = () => { throw new Error('disk gone'); };
    expect(() => askForSecret(f.drop, 'k', '', null, NOW)).toThrow('disk gone');
  });
  it('works on the real SecretDrop: the request waits, and the row key finds it', () => {
    const drop = new SecretDrop('t');
    try {
      const r = askForSecret(drop, 'k', 'n', null, Date.now());
      const list = drop.listPending();
      expect(list).toHaveLength(1);
      expect((r.body as { key: string }).key).toBe(rowKey('secret-request', list[0]!.token));
      expect(cancelSecretByKey(drop, (r.body as { key: string }).key).status).toBe(200);
      expect(drop.listPending()).toHaveLength(0);
    } finally { (drop as unknown as { stop?: () => void }).stop?.(); }
  });
});

describe('cancelSecretByKey', () => {
  it('cancels the request behind the key', () => {
    const f = fake([{ token: 'one', label: 'a', expiresAt: NOW + 1, expired: false }, { token: 'two', label: 'b', expiresAt: NOW + 1, expired: false }]);
    expect(cancelSecretByKey(f.drop, rowKey('secret-request', 'two'))).toEqual({ status: 200, body: { ok: true } });
    expect(f.cancelled).toEqual(['two']);
  });
  it('an unknown key is gone, and nothing is cancelled', () => {
    const f = fake([{ token: 'one', label: 'a', expiresAt: NOW + 1, expired: false }]);
    expect(cancelSecretByKey(f.drop, 'f'.repeat(16)).status).toBe(404);
    expect(f.cancelled).toEqual([]);
  });
  it('a request cancelled between the read and the cancel is gone', () => {
    const f = fake([{ token: 'one', label: 'a', expiresAt: NOW + 1, expired: false }]);
    f.drop.cancel = () => false;
    expect(cancelSecretByKey(f.drop, rowKey('secret-request', 'one')).status).toBe(404);
  });
});
