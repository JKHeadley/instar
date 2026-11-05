/**
 * The pure summarizer behind GET /mobile/secrets (docs/specs/mobile-native-secrets.md): both sides of
 * every rule. A failed read says "can't tell"; a token, value or length never reaches the answer.
 */
import { describe, it, expect } from 'vitest';
import { summarizeSecrets, mergeSecrets, peerSection, resolveKeys, MAX_KEY_NAMES, MAX_WAITING_ROWS, SOON_MS, type SecretsSources } from '../../src/server/mobileSecretsRoutes.js';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const TOKEN = 'a'.repeat(64);
const req = (over: Record<string, unknown> = {}) => ({ token: TOKEN, label: 'Stripe key', topicId: 7, createdAt: NOW - 60_000, expiresAt: NOW + 600_000, expired: false, ...over });
const src = (over: Partial<SecretsSources> = {}): SecretsSources => ({
  requests: { state: 'ok', pending: [] },
  keys: { state: 'ok', names: ['authToken', 'telegram.token'] },
  sync: { state: 'off' },
  topicName: () => 'Payments',
  now: NOW,
  ...over,
});

describe('requests', () => {
  it('lists a waiting request by label and time, never by token', () => {
    const r = summarizeSecrets(src({ requests: { state: 'ok', pending: [req()] } }));
    expect(r).toMatchObject({ tone: 'attn', headline: 'Waiting for 1 password or key.' });
    const a = r.requests as { waiting: Array<Record<string, unknown>>; waitingCount: number };
    expect(a.waitingCount).toBe(1);
    expect(a.waiting[0]).toMatchObject({ label: 'Stripe key', conversation: 'Payments', soon: false });
    expect(Object.keys(a.waiting[0]!).sort()).toEqual(['conversation', 'createdAt', 'expiresAt', 'key', 'label', 'soon']);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('marks one about to expire, sorts soonest first, and counts expired apart', () => {
    const r = summarizeSecrets(src({ requests: { state: 'ok', pending: [req(), req({ token: 'b'.repeat(64), label: 'Soon', expiresAt: NOW + SOON_MS - 1 }), req({ token: 'c'.repeat(64), expired: true })] } }));
    const a = r.requests as { waiting: Array<{ label: string; soon: boolean }>; expiredCount: number };
    expect(a.waiting.map((w) => w.label)).toEqual(['Soon', 'Stripe key']);
    expect(a.waiting[0]!.soon).toBe(true);
    expect(a.waiting[1]!.soon).toBe(false);
    expect(a.expiredCount).toBe(1);
  });

  it('a past expiry counts as expired even when not flagged', () => {
    const r = summarizeSecrets(src({ requests: { state: 'ok', pending: [req({ expiresAt: NOW - 1 })] } }));
    expect(r.requests).toMatchObject({ waitingCount: 0, expiredCount: 1 });
  });

  it('keeps the true count past the row cap', () => {
    const pending = Array.from({ length: MAX_WAITING_ROWS + 2 }, (_, i) => req({ token: `t${i}` }));
    const a = summarizeSecrets(src({ requests: { state: 'ok', pending } })).requests as { waiting: unknown[]; waitingCount: number; truncated: boolean };
    expect(a.waiting).toHaveLength(MAX_WAITING_ROWS);
    expect(a.waitingCount).toBe(MAX_WAITING_ROWS + 2);
    expect(a.truncated).toBe(true);
  });

  it('a failed read or an all-malformed list is not "nothing waiting"', () => {
    for (const requests of [{ state: 'unavailable' as const }, { state: 'ok' as const, pending: 'x' }, { state: 'ok' as const, pending: [{ label: 'no token' }] }]) {
      const r = summarizeSecrets(src({ requests }));
      expect(r.requests).toMatchObject({ state: 'unavailable', waitingCount: null });
      expect(r).toMatchObject({ tone: 'unknown', headline: "Can't tell what is waiting." });
    }
  });

  it('one unreadable row beside an expired one is not an all-clear', () => {
    const r = summarizeSecrets(src({ requests: { state: 'ok', pending: [req({ expired: true }), { label: 'no token' }] } }));
    expect(r.requests).toMatchObject({ state: 'unavailable', waitingCount: null });
    expect(r.tone).toBe('unknown');
  });

  it('an expiry no date can hold is not a request, and never throws', () => {
    const r = summarizeSecrets(src({ requests: { state: 'ok', pending: [req({ expiresAt: 1e300 })] } }));
    expect(r.requests).toMatchObject({ state: 'unavailable', waitingCount: null });
    const ok = summarizeSecrets(src({ requests: { state: 'ok', pending: [req(), req({ token: 'd'.repeat(64), createdAt: 1e300 })] } }));
    expect((ok.requests as { waiting: Array<{ createdAt: unknown }> }).waiting.map((w) => w.createdAt).sort()).toContain(null);
  });

  it('a token or drop link pasted into a label or conversation name is withheld', () => {
    const r = summarizeSecrets(src({ topicName: () => `room ${TOKEN}`, requests: { state: 'ok', pending: [req({ label: `Key https://x.example/secrets/drop/${TOKEN}` })] } }));
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('a throwing conversation lookup still lists the request', () => {
    const r = summarizeSecrets(src({ requests: { state: 'ok', pending: [req()] }, topicName: () => { throw new Error('x'); } }));
    expect((r.requests as { waiting: Array<{ conversation: unknown }> }).waiting[0]!.conversation).toBeNull();
  });
});

describe('keys', () => {
  it('nothing waiting with keys read is the all-clear', () => {
    expect(summarizeSecrets(src())).toMatchObject({ tone: 'ok', headline: 'Nothing is waiting. This machine holds 2 keys.', state: 'ok' });
  });

  it('a path carrying a token becomes a count, not a name', () => {
    const k = summarizeSecrets(src({ keys: { state: 'ok', names: ['authToken', `secretDrops.${TOKEN} (+2 nested)`] } })).keys as { names: string[]; savedDrops: number; count: number };
    expect(k.names).toEqual(['authToken']);
    expect(k.savedDrops).toBe(1);
    expect(k.count).toBe(1);
  });

  it('a vault of saved submissions only does not read as empty', () => {
    const r = summarizeSecrets(src({ keys: { state: 'ok', names: [`secretDrops.${TOKEN}`] } }));
    expect(r.headline).toBe('Nothing is waiting. This machine holds 0 keys and 1 saved submission.');
  });

  it('names that shorten alike still count as separate keys', () => {
    const long = 'long.name.'.repeat(20);
    const k = summarizeSecrets(src({ keys: { state: 'ok', names: [`${long}a`, `${long}b`] } })).keys as { names: string[]; count: number; truncated: boolean };
    expect(k.count).toBe(2);
    expect(k.names).toHaveLength(1);
    expect(k.truncated).toBe(false);
  });

  it('a token that only appears once cleaning joins it is hidden too', () => {
    const k = summarizeSecrets(src({ keys: { state: 'ok', names: ['authToken', 'api.a1b2c3d4\u0001e5f60718'] } })).keys as Record<string, unknown>;
    expect(k).toMatchObject({ names: ['authToken'], count: 2, hidden: 1 });
  });

  it('a name with a hex run that is not a saved drop is hidden and still counted as a key', () => {
    const k = summarizeSecrets(src({ keys: { state: 'ok', names: ['customer.0123456789abcdef', 'authToken'] } })).keys as Record<string, unknown>;
    expect(k).toMatchObject({ names: ['authToken'], count: 2, hidden: 1, savedDrops: 0, truncated: false });
  });

  it('one unreadable name means the list is not complete', () => {
    const r = summarizeSecrets(src({ keys: { state: 'ok', names: ['authToken', 5] } }));
    expect(r.keys).toMatchObject({ state: 'unavailable', count: null });
    expect(r.tone).toBe('unknown');
  });

  it('a short hex-looking name stays a name', () => {
    const k = summarizeSecrets(src({ keys: { state: 'ok', names: ['abc123.key'] } })).keys as { names: string[]; savedDrops: number };
    expect(k.names).toEqual(['abc123.key']);
    expect(k.savedDrops).toBe(0);
  });

  it('a credential-shaped name is scrubbed', () => {
    const fake = 'ghp_' + 'Q'.repeat(36);
    const r = summarizeSecrets(src({ keys: { state: 'ok', names: [`note ${fake}`] } }));
    expect(JSON.stringify(r)).not.toContain(fake);
  });

  it('de-duplicates, sorts and caps with the true count', () => {
    const names = Array.from({ length: MAX_KEY_NAMES + 3 }, (_, i) => `k${String(i).padStart(4, '0')}`);
    const k = summarizeSecrets(src({ keys: { state: 'ok', names: [...names, names[0]!] } })).keys as { names: string[]; count: number; truncated: boolean };
    expect(k.names).toHaveLength(MAX_KEY_NAMES);
    expect(k.count).toBe(MAX_KEY_NAMES + 3);
    expect(k.truncated).toBe(true);
  });

  it('a vault that will not open leads, and shows no names', () => {
    const r = summarizeSecrets(src({ keys: { state: 'decrypt-failed' }, requests: { state: 'ok', pending: [req()] } }));
    expect(r).toMatchObject({ tone: 'bad', headline: "The saved keys on this machine can't be opened." });
    expect(r.keys).toMatchObject({ state: 'decrypt-failed', count: null, names: [] });
  });

  it('keys switched off or unreadable are not "no keys"', () => {
    for (const keys of [{ state: 'unavailable' as const }, { state: 'ok' as const, names: 'x' }, { state: 'ok' as const, names: [5] }]) {
      const r = summarizeSecrets(src({ keys }));
      expect((r.keys as { count: unknown }).count).toBeNull();
      expect(r).toMatchObject({ tone: 'unknown', headline: "Nothing is waiting, but I can't tell which keys this machine holds." });
    }
  });

  it('a switched-off list has its own words and is not "can\'t tell"', () => {
    const r = summarizeSecrets(src({ keys: { state: 'off' } }));
    expect(r).toMatchObject({ tone: 'ok', headline: 'Nothing is waiting. The list of key names is off on this agent.' });
    expect((r.keys as { count: unknown }).count).toBeNull();
  });

  it('UUIDs and long opaque runs are withheld like hex tokens', () => {
    const k = summarizeSecrets(src({ keys: { state: 'ok', names: ['a.3f2504e0-4f89-11d3-9a0c-0305e82c3301', `b.${'Z9'.repeat(20)}`, 'plain.name'] } })).keys as Record<string, unknown>;
    expect(k).toMatchObject({ names: ['plain.name'], count: 3, hidden: 2 });
  });

  it('both reads failing is unavailable', () => {
    expect(summarizeSecrets(src({ keys: { state: 'unavailable' }, requests: { state: 'unavailable' } })).state).toBe('unavailable');
  });
});

describe('sync', () => {
  it('reads on, receive-only, off and unknown apart, with a peer count only', () => {
    expect(summarizeSecrets(src({ sync: { state: 'on', pushEnabled: true, peers: [{ machineId: 'm_secret' }] } })).sync).toEqual({ state: 'on', peers: 1 });
    expect(summarizeSecrets(src({ sync: { state: 'on', pushEnabled: false, peers: [] } })).sync).toEqual({ state: 'receive-only', peers: 0 });
    expect(summarizeSecrets(src()).sync).toEqual({ state: 'off', peers: null });
    expect(summarizeSecrets(src({ sync: { state: 'unavailable' } })).sync).toEqual({ state: 'unavailable', peers: null });
    expect(summarizeSecrets(src({ sync: { state: 'on', pushEnabled: true, peers: 'x' } })).sync).toEqual({ state: 'unavailable', peers: null });
  });
});

describe('resolveKeys: which source lists the names', () => {
  const inv = (vaultState: unknown) => async () => ({ names: ['a'], vaultState });
  const sync = { enabled: true, localKeyPaths: () => ['from-sync'] };

  it('uses the inventory when it is on, mapping every vault state', async () => {
    await expect(resolveKeys({ inventoryOn: true, inventory: inv('ok'), sync })).resolves.toEqual({ state: 'ok', names: ['a'] });
    await expect(resolveKeys({ inventoryOn: true, inventory: inv('absent'), sync })).resolves.toEqual({ state: 'ok', names: ['a'] });
    await expect(resolveKeys({ inventoryOn: true, inventory: inv('decrypt-failed'), sync })).resolves.toEqual({ state: 'decrypt-failed' });
    await expect(resolveKeys({ inventoryOn: true, inventory: inv('new-state'), sync })).rejects.toThrow('unexpected vault state');
  });

  it('falls back to Secret Sync, then says off', async () => {
    await expect(resolveKeys({ inventoryOn: false, inventory: inv('ok'), sync })).resolves.toEqual({ state: 'ok', names: ['from-sync'] });
    await expect(resolveKeys({ inventoryOn: false, inventory: inv('ok'), sync: { ...sync, enabled: false } })).resolves.toEqual({ state: 'off' });
    await expect(resolveKeys({ inventoryOn: false, inventory: inv('ok'), sync: null })).resolves.toEqual({ state: 'off' });
  });
});

describe('other machines', () => {
  const nicknameOf = (id: string) => (id === 'm_a' ? 'Mac Mini' : id === 'm_b' ? 'Laptop' : null);
  const local = (over: Partial<SecretsSources> = {}) => ({ schemaVersion: 1, ...summarizeSecrets(src(over)) });
  const opts = { nicknameOf, offlineMachineIds: [] as string[], peersRead: true };

  it('a peer\'s waiting request shows, named, in the headline count', () => {
    const r = mergeSecrets(summarizeSecrets(src()), [{ machineId: 'm_a', state: 'ok', data: local({ requests: { state: 'ok', pending: [req()] } }) }], opts);
    expect(r).toMatchObject({ tone: 'attn', headline: 'Waiting for 1 password or key.' });
    expect((r.peers as Array<Record<string, unknown>>)[0]).toMatchObject({ machine: 'Mac Mini', waitingCount: 1, keyCount: 2, vaultBroken: false });
    expect(JSON.stringify(r)).not.toContain('m_a');
  });

  it('the all-clear is scoped when a machine did not answer or is offline', () => {
    const a = mergeSecrets(summarizeSecrets(src()), [{ machineId: 'm_a', state: 'unreached' }], opts);
    expect(a).toMatchObject({ tone: 'unknown', headline: 'Nothing is waiting on the machines that answered. This machine holds 2 keys.', unread: { count: 1, names: ['Mac Mini'] } });
    const b = mergeSecrets(summarizeSecrets(src()), [], { ...opts, offlineMachineIds: ['m_b'] });
    expect(b).toMatchObject({ tone: 'unknown', offline: { count: 1, names: ['Laptop'] } });
    const c = mergeSecrets(summarizeSecrets(src()), [], { ...opts, peersRead: false });
    expect(c).toMatchObject({ tone: 'unknown', peersUnknown: true });
  });

  it('all machines answering and clear is the plain all-clear', () => {
    const r = mergeSecrets(summarizeSecrets(src()), [{ machineId: 'm_a', state: 'ok', data: local() }], opts);
    expect(r).toMatchObject({ tone: 'ok', headline: 'Nothing is waiting. This machine holds 2 keys.' });
  });

  it('a peer whose vault will not open leads', () => {
    const r = mergeSecrets(summarizeSecrets(src()), [{ machineId: 'm_a', state: 'ok', data: local({ keys: { state: 'decrypt-failed' } }) }], opts);
    expect(r).toMatchObject({ tone: 'bad', headline: "The saved keys on Mac Mini can't be opened." });
  });

  it('a peer that cannot read its requests blocks the all-clear', () => {
    const r = mergeSecrets(summarizeSecrets(src()), [{ machineId: 'm_a', state: 'ok', data: local({ requests: { state: 'unavailable' } }) }], opts);
    expect(r).toMatchObject({ tone: 'unknown', headline: "Can't tell what is waiting." });
  });

  it('a peer whose keys could not be read blocks the all-clear', () => {
    const r = mergeSecrets(summarizeSecrets(src()), [{ machineId: 'm_a', state: 'ok', data: local({ keys: { state: 'unavailable' } }) }], opts);
    expect(r).toMatchObject({ tone: 'unknown', headline: "Nothing is waiting, but I can't tell how the saved keys on Mac Mini are." });
    const off = mergeSecrets(summarizeSecrets(src()), [{ machineId: 'm_a', state: 'ok', data: local({ keys: { state: 'off' } }) }], opts);
    expect(off.tone).toBe('ok');
  });

  it('a wrong-shaped peer counts as not answering', () => {
    expect(peerSection({ schemaVersion: 1, requests: { state: 'ok', waitingCount: 0, waiting: [] } }, 'x')).toBeNull();
    expect(peerSection({ schemaVersion: 1, requests: { state: 'ok', waitingCount: 0, waiting: [] }, keys: { state: 'ok', count: -1 } }, 'x')).toBeNull();
    expect(peerSection({ schemaVersion: 1, requests: { state: 'odd', waiting: [] }, keys: { state: 'ok', count: 1 } }, 'x')).toBeNull();
    expect(peerSection({ schemaVersion: 2, requests: { waiting: [] } }, 'x')).toBeNull();
    expect(peerSection({ schemaVersion: 1, requests: { state: 'ok', waitingCount: 1, waiting: [{ key: 'k', expiresAt: 'nope' }] } }, 'x')).toBeNull();
    const r = mergeSecrets(summarizeSecrets(src()), [{ machineId: 'm_a', state: 'ok', data: { schemaVersion: 9 } }], opts);
    expect(r).toMatchObject({ peers: [], unread: { count: 1 } });
  });

  it('peer text is re-cleaned and a peer token field never passes through', () => {
    const fake = 'ghp_' + 'Q'.repeat(36);
    const data = { schemaVersion: 1, requests: { state: 'ok', waitingCount: 1, waiting: [{ key: 'k', label: `x ${fake}`, token: TOKEN, expiresAt: new Date(NOW + 1000).toISOString() }] }, keys: { state: 'ok', count: 1, names: ['peer-name'] } };
    const row = peerSection(data, 'Mac Mini')!;
    const text = JSON.stringify(row);
    for (const leak of [fake, TOKEN, 'peer-name']) expect(text).not.toContain(leak);
  });
});
