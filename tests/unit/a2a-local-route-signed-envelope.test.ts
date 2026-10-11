/**
 * A2A local-route signed envelope — unit tier
 * (docs/specs/a2a-local-route-signed-envelope.md, ACT-067).
 *
 * The module against real keys, a real registry file and an injected clock:
 * both sides of every boundary of the verdict, the first-contact probe against
 * a stub health source, the replay cache and its bounds, mode resolution, the
 * signer, the audit log, the MessageRouter refusal classification, drop pickup
 * in each mode, and migration parity.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import crypto from 'node:crypto';
import {
  FRESH_FUTURE_MS,
  FRESH_PAST_MS,
  LOCAL_ENVELOPE_REASONS,
  PROBE_CLOSED_RETRY_MS,
  PROBE_MAX_FAILURES,
  REPLAY_MAX_PER_SENDER,
  REPLAY_MAX_TOTAL,
  ReplayCache,
  appendLocalRouteSignatureAudit,
  countLocalEnvelopeVerdict,
  createAgentLocalEnvelopeSigner,
  createLocalEnvelopeSigner,
  createLocalEnvelopeVerifier,
  localEnvelopeRefusalBody,
  localEnvelopeRefusalLogLine,
  localEnvelopeSignedBytes,
  localEnvelopeSignerAvailable,
  localRouteSignatureAuditPath,
  localRouteSignatureCounters,
  requiresUnmetSignature,
  resetLocalRouteSignatureStateForTests,
  resolveLocalRouteSignatureMode,
  signLocalEnvelope,
  verifyLocalEnvelope,
  verifyLocalRouteEnvelope,
  type FirstContactDeps,
} from '../../src/threadline/localEnvelopeSignature.js';
import { IdentityManager } from '../../src/threadline/client/IdentityManager.js';
import { computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { HELD_DROP_MAX_AGE_MS, pickupDroppedMessages } from '../../src/messaging/DropPickup.js';
import { computeDropHmac, generateAgentToken } from '../../src/messaging/AgentTokenManager.js';
import type { MessageEnvelope } from '../../src/messaging/types.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import { createLocalSender, makeLocalEnvelope, registerKnownAgent, signEnvelope, type LocalSender } from '../helpers/localEnvelope.js';

const OP = 'threadline local-route-signed-envelope unit test';
const SELF = 'receiver';

/** A verifier whose probe is a stub: `health` maps a port to its answer (or throws). */
function stubVerifier(opts: {
  running?: Array<{ name: string; port: number }>;
  health?: Record<number, unknown | Error>;
  now?: () => number;
}) {
  const calls: number[] = [];
  const reports: string[] = [];
  const deps: Partial<FirstContactDeps> = {
    listRunning: () => opts.running ?? [],
    fetchHealth: async (port) => {
      calls.push(port);
      const h = opts.health?.[port];
      if (h === undefined || h instanceof Error) throw h ?? new Error('ECONNREFUSED');
      return h;
    },
    now: opts.now ?? (() => Date.now()),
    report: (reason) => { reports.push(reason); },
  };
  return { verifier: createLocalEnvelopeVerifier(deps), calls, reports };
}

const healthOf = (s: LocalSender, extra: Record<string, unknown> = {}) => ({
  protocol: 'threadline', agent: s.name, identityPub: s.publicKeyHex, fingerprint: s.fingerprint, ...extra,
});

describe('signed envelope — bytes, sign, verify', () => {
  it('sorts keys at every level, drops undefined, and covers every sender-set transport field', () => {
    const a = localEnvelopeSignedBytes({ message: { b: 1, a: { d: 2, c: undefined } }, transport: { nonce: 'n', timestamp: 't', relayChain: ['x'], originServer: 'o', originTopicId: 7 } })!;
    expect(a.toString('utf8')).toBe('instar-a2a-local-envelope-v1\n{"message":{"a":{"d":2},"b":1},"transport":{"nonce":"n","originServer":"o","originTopicId":7,"relayChain":["x"],"timestamp":"t"}}');
    // Key order on the way in does not matter.
    const b = localEnvelopeSignedBytes({ transport: { originTopicId: 7, relayChain: ['x'], timestamp: 't', originServer: 'o', nonce: 'n' }, message: { a: { d: 2 }, b: 1 } })!;
    expect(b.equals(a)).toBe(true);
  });

  it('signs what the wire will carry: a Date member is its JSON string on both ends', () => {
    const when = new Date('2026-10-10T00:00:00.000Z');
    const sender = createLocalSender('s');
    const local = { message: { when }, transport: { nonce: 'n', timestamp: 't' } };
    const sig = signLocalEnvelope(local, sender.privateKey)!;
    const overTheWire = JSON.parse(JSON.stringify({ ...local, signature: sig }));
    expect(verifyLocalEnvelope(overTheWire, sender.publicKey)).toBe(true);
  });

  it('refuses to canonicalise past either bound', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 70; i++) deep = { d: deep };
    expect(localEnvelopeSignedBytes({ message: deep, transport: {} })).toBeNull();
    let ok: unknown = 'x';
    for (let i = 0; i < 40; i++) ok = { d: ok };
    expect(localEnvelopeSignedBytes({ message: ok, transport: {} })).not.toBeNull();
    expect(localEnvelopeSignedBytes({ message: { body: 'x'.repeat(1_000_001) }, transport: {} })).toBeNull();
  });

  it('matches the fixed test vector (what a second implementation must reproduce)', () => {
    const seed = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
    const pub = Buffer.from('03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8', 'hex');
    const env = {
      schemaVersion: 1,
      message: {
        id: 'msg-0001',
        from: { agent: 'dawn', session: 'threadline', machine: 'local' },
        to: { agent: 'echo', session: 'best', machine: 'local' },
        type: 'request', priority: 'medium', subject: 'Vector — ünïcode ✓',
        body: { content: 'héllo "quoted" \n line two', n: 42, nested: { b: true, a: [1, 'two', null] } },
        threadId: 'thread-0001', createdAt: '2026-10-10T00:00:00.000Z',
      },
      transport: { relayChain: ['local'], originServer: 'http://localhost:4042', nonce: 'a3bb189e-8bf9-3888-9912-ace4e6543002:2026-10-10T00:00:00.000Z', timestamp: '2026-10-10T00:00:00.000Z' },
      delivery: { phase: 'sent', transitions: [], attempts: 0 },
    };
    const bytes = localEnvelopeSignedBytes(env)!;
    expect(bytes.toString('utf8')).toBe(
      'instar-a2a-local-envelope-v1\n{"message":{"body":{"content":"héllo \\"quoted\\" \\n line two","n":42,"nested":{"a":[1,"two",null],"b":true}},"createdAt":"2026-10-10T00:00:00.000Z","from":{"agent":"dawn","machine":"local","session":"threadline"},"id":"msg-0001","priority":"medium","subject":"Vector — ünïcode ✓","threadId":"thread-0001","to":{"agent":"echo","machine":"local","session":"best"},"type":"request"},"transport":{"nonce":"a3bb189e-8bf9-3888-9912-ace4e6543002:2026-10-10T00:00:00.000Z","originServer":"http://localhost:4042","relayChain":["local"],"timestamp":"2026-10-10T00:00:00.000Z"}}',
    );
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe('4143c2a2bfd6996706e3563cff9e39c2d019e58c99f554828a94eeb712d5e4ac');
    const sig = signLocalEnvelope(env, seed);
    expect(sig).toBe('y5GrTggtUySf9bgnNgzVf2ahZwNHuVbbdl5yTKN9OeN2ClQ0GgAn5BVQWIs+G3IahNwQozqFGaMczhWsvNvqCw==');
    expect(verifyLocalEnvelope({ ...env, signature: sig }, pub)).toBe(true);
    // `delivery` is outside the signed set: the receiver's bookkeeping may change it.
    expect(verifyLocalEnvelope({ ...env, delivery: { phase: 'received' }, signature: sig }, pub)).toBe(true);
  });
});

describe('signed envelope — the verdict (real registry file, injected clock)', () => {
  let stateDir: string;
  let alice: LocalSender;
  const NOW = Date.parse('2026-10-10T12:00:00.000Z');
  const none = () => stubVerifier({}).verifier;
  const verdict = (env: unknown, extra: Record<string, unknown> = {}) =>
    verifyLocalRouteEnvelope(env as never, { stateDir, selfName: SELF, now: NOW, verifier: none(), ...extra });
  const signed = (over: Parameters<typeof makeLocalEnvelope>[2] = {}, sender = alice) =>
    signEnvelope(makeLocalEnvelope(sender.name, SELF, { at: NOW, ...over }), sender);

  beforeEach(() => {
    resetLocalRouteSignatureStateForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lse-'));
    alice = createLocalSender('alice');
    registerKnownAgent(stateDir, alice);
  });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  it('proves a signed envelope and derives the fingerprint from the KEY, not the stored field', async () => {
    registerKnownAgent(stateDir, alice, { fingerprint: 'f'.repeat(32) }); // a stale stored fingerprint
    const v = await verdict(signed());
    expect(v).toEqual({ ok: true, fingerprint: computeFingerprint(alice.publicKey), senderName: 'alice' });
  });

  it('matches the sender name case-insensitively', async () => {
    const env = signEnvelope(makeLocalEnvelope('ALICE', SELF, { at: NOW }), alice);
    expect((await verdict(env)).ok).toBe(true);
  });

  it('unsigned / malformed', async () => {
    expect(await verdict(makeLocalEnvelope('alice', SELF, { at: NOW }))).toMatchObject({ ok: false, reason: 'unsigned' });
    const good = signed();
    expect(await verdict({ ...good, signature: 'not base64!' })).toMatchObject({ reason: 'malformed' });
    expect(await verdict({ ...good, signature: Buffer.alloc(63).toString('base64') })).toMatchObject({ reason: 'malformed' });
    expect(await verdict({ ...good, transport: { ...good.transport, nonce: '' } })).toMatchObject({ reason: 'malformed' });
    expect(await verdict({ ...good, transport: { ...good.transport, nonce: 'n'.repeat(257) } })).toMatchObject({ reason: 'malformed' });
    expect(await verdict({ ...good, transport: { ...good.transport, timestamp: 5 } })).toMatchObject({ reason: 'malformed' });
    expect(await verdict({ ...good, message: { ...good.message, from: { agent: '' } } })).toMatchObject({ reason: 'malformed' });
  });

  it('recipient: must be present and must be this agent', async () => {
    const other = signEnvelope(makeLocalEnvelope('alice', 'someone-else', { at: NOW }), alice);
    expect(await verdict(other)).toMatchObject({ reason: 'wrong-recipient' });
    const base = makeLocalEnvelope('alice', SELF, { at: NOW });
    const noTo = signEnvelope({ ...base, message: { ...base.message, to: undefined } }, alice);
    expect(await verdict(noTo)).toMatchObject({ reason: 'wrong-recipient' });
    expect((await verdict(signEnvelope(makeLocalEnvelope('alice', SELF.toUpperCase(), { at: NOW }), alice))).ok).toBe(true);
  });

  it('freshness: both sides of the past and the future bound', async () => {
    expect((await verdict(signed({ at: NOW - FRESH_PAST_MS + 1000 }))).ok).toBe(true);
    expect(await verdict(signed({ at: NOW - FRESH_PAST_MS - 1000 }))).toMatchObject({ reason: 'stale' });
    expect((await verdict(signed({ at: NOW + FRESH_FUTURE_MS - 1000 }))).ok).toBe(true);
    expect(await verdict(signed({ at: NOW + FRESH_FUTURE_MS + 1000 }))).toMatchObject({ reason: 'stale' });
    const garbage = makeLocalEnvelope('alice', SELF, { at: NOW });
    garbage.transport.timestamp = 'yesterday';
    expect(await verdict(signEnvelope(garbage, alice))).toMatchObject({ reason: 'stale' });
    // A drop is old by nature: offline skips the bound.
    expect((await verdict(signed({ at: NOW - 3 * FRESH_PAST_MS }), { offline: true })).ok).toBe(true);
  });

  it('unknown sender / ambiguous by two keys / ambiguous by one key under two names', async () => {
    const bob = createLocalSender('bob');
    expect(await verdict(signed({}, bob))).toMatchObject({ reason: 'unknown-sender' });

    // Two entries under one name with different keys.
    const twin = createLocalSender('alice');
    const file = path.join(stateDir, 'threadline', 'known-agents.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    data.agents.push({ name: 'Alice', port: 2, publicKey: twin.publicKeyHex });
    fs.writeFileSync(file, JSON.stringify(data));
    expect(await verdict(signed())).toMatchObject({ reason: 'ambiguous-sender' });

    // One key under two names (a cloned agent home).
    fs.writeFileSync(file, JSON.stringify({ agents: [
      { name: 'alice', publicKey: alice.publicKeyHex }, { name: 'clone', publicKey: alice.publicKeyHex },
    ] }));
    expect(await verdict(signed())).toMatchObject({ reason: 'ambiguous-sender' });
  });

  it('an entry without a usable key is no key; an unreadable registry is registry-unavailable', async () => {
    const file = path.join(stateDir, 'threadline', 'known-agents.json');
    fs.writeFileSync(file, JSON.stringify({ agents: [{ name: 'alice', fingerprint: alice.fingerprint }] }));
    expect(await verdict(signed())).toMatchObject({ reason: 'unknown-sender' });
    fs.writeFileSync(file, '{ not json');
    expect(await verdict(signed())).toMatchObject({ reason: 'registry-unavailable' });
    fs.writeFileSync(file, JSON.stringify({ agents: [], pad: 'x'.repeat(1_000_001) }));
    expect(await verdict(signed())).toMatchObject({ reason: 'registry-unavailable' });
  });

  it('a body fingerprint must equal the proven one in full', async () => {
    expect((await verdict(signed({ fingerprint: alice.fingerprint }))).ok).toBe(true);
    expect((await verdict(signed({ fingerprint: alice.fingerprint.toUpperCase() }))).ok).toBe(true);
    expect(await verdict(signed({ fingerprint: alice.fingerprint.slice(0, 16) }))).toMatchObject({ reason: 'fingerprint-mismatch' });
    expect(await verdict(signed({ fingerprint: 'b'.repeat(32) }))).toMatchObject({ reason: 'fingerprint-mismatch' });
  });

  it('a wrong key or any tampered signed field is signature-invalid', async () => {
    const mallory = createLocalSender('alice'); // claims alice, holds another key
    expect(await verdict(signed({}, mallory))).toMatchObject({ reason: 'signature-invalid' });
    const good = signed();
    const tampered = [
      { ...good, message: { ...good.message, body: 'changed' } },
      { ...good, message: { ...good.message, to: { ...good.message.to, session: 'other' } } },
      { ...good, transport: { ...good.transport, nonce: `${good.transport.nonce}x` } },
      { ...good, transport: { ...good.transport, relayChain: ['hop'] } },
      { ...good, transport: { ...good.transport, originServer: 'http://elsewhere' } },
      { ...good, transport: { ...good.transport, originTopicId: 9 } },
    ];
    for (const t of tampered) expect(await verdict(t)).toMatchObject({ ok: false, reason: 'signature-invalid' });
    // Unsigned fields may change freely.
    expect((await verdict({ ...good, delivery: { phase: 'received' }, threadSync: { head: 'x' }, transport: { ...good.transport, hmac: 'h', hmacBy: 'alice' } })).ok).toBe(true);
  });

  it('replay: the same (fingerprint, nonce) is refused once it verified; offline skips the cache', async () => {
    const { verifier } = stubVerifier({});
    const env = signed();
    const run = (extra = {}) => verifyLocalRouteEnvelope(env, { stateDir, selfName: SELF, now: NOW, verifier, ...extra });
    expect((await run()).ok).toBe(true);
    expect(await run()).toMatchObject({ reason: 'replay' });
    expect((await run({ offline: true })).ok).toBe(true);
    // A failed verification records nothing: the same nonce re-signed by the right key still passes.
    const { verifier: v2 } = stubVerifier({});
    const forged = signEnvelope(makeLocalEnvelope('alice', SELF, { at: NOW }), createLocalSender('alice'));
    expect(await verifyLocalRouteEnvelope(forged, { stateDir, selfName: SELF, now: NOW, verifier: v2 })).toMatchObject({ reason: 'signature-invalid' });
    const genuine = signEnvelope({ ...forged, signature: undefined }, alice);
    expect((await verifyLocalRouteEnvelope(genuine, { stateDir, selfName: SELF, now: NOW, verifier: v2 })).ok).toBe(true);
  });
});

describe('signed envelope — replay cache bounds', () => {
  it('refuses at the per-sender bound for that sender only, and never evicts a live entry', () => {
    const cache = new ReplayCache();
    for (let i = 0; i < REPLAY_MAX_PER_SENDER; i++) expect(cache.check('fpA', `n${i}`, 1000)).toBe('ok');
    expect(cache.check('fpA', 'one-more', 1000)).toBe('replay-cache-full');
    expect(cache.check('fpB', 'n0', 1000)).toBe('ok'); // another sender is unaffected
    expect(cache.check('fpA', 'n0', 1000)).toBe('replay'); // nothing was evicted
    // Entries age out after the lifetime; the sender can send again.
    expect(cache.check('fpA', 'later', 1000 + 12 * 60_000 + 1)).toBe('ok');
  });

  it('refuses everyone at the overall bound', () => {
    const cache = new ReplayCache();
    const senders = Math.ceil(REPLAY_MAX_TOTAL / REPLAY_MAX_PER_SENDER);
    for (let s = 0; s < senders; s++) for (let i = 0; i < REPLAY_MAX_PER_SENDER; i++) cache.check(`fp${s}`, `n${i}`, 0);
    expect(cache.size).toBe(REPLAY_MAX_TOTAL);
    expect(cache.check('fresh-sender', 'n', 0)).toBe('replay-cache-full');
  });
});

describe('signed envelope — first contact (stub health source)', () => {
  let stateDir: string;
  let bob: LocalSender;
  const env = (s: LocalSender) => signEnvelope(makeLocalEnvelope(s.name, SELF), s);
  const run = (verifier: ReturnType<typeof createLocalEnvelopeVerifier>, e: unknown, extra = {}) =>
    verifyLocalRouteEnvelope(e as never, { stateDir, selfName: SELF, verifier, ...extra });

  beforeEach(() => {
    resetLocalRouteSignatureStateForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lse-fc-'));
    bob = createLocalSender('bob');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  it('fetches a missing key into memory, verifies, and writes no file', async () => {
    const { verifier, calls } = stubVerifier({ running: [{ name: 'bob', port: 7001 }], health: { 7001: healthOf(bob) } });
    const v = await run(verifier, env(bob));
    expect(v).toMatchObject({ ok: true, fingerprint: bob.fingerprint });
    expect(calls).toEqual([7001]);
    expect(fs.existsSync(path.join(stateDir, 'threadline', 'known-agents.json'))).toBe(false);
    // The second envelope uses the cached key: no second probe.
    expect((await run(verifier, env(bob))).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(verifier.firstContact.size).toBe(1);
  });

  it('unsigned traffic and made-up names never probe', async () => {
    const { verifier, calls } = stubVerifier({ running: [{ name: 'bob', port: 7001 }], health: { 7001: healthOf(bob) } });
    expect(await run(verifier, makeLocalEnvelope('bob', SELF))).toMatchObject({ reason: 'unsigned' });
    const ghost = createLocalSender('ghost'); // no running entry: one registry read, no slot, no probe
    expect(await run(verifier, env(ghost))).toMatchObject({ reason: 'unknown-sender' });
    expect(calls).toEqual([]);
  });

  it('two running entries with the name are ambiguous, with no probe', async () => {
    const { verifier, calls } = stubVerifier({ running: [{ name: 'bob', port: 1 }, { name: 'Bob', port: 2 }], health: {} });
    expect(await run(verifier, env(bob))).toMatchObject({ reason: 'ambiguous-sender' });
    expect(calls).toEqual([]);
  });

  it('refuses an answer that names another agent, disagrees on the fingerprint, or is not threadline', async () => {
    for (const bad of [healthOf(bob, { agent: 'someone-else' }), healthOf(bob, { fingerprint: 'c'.repeat(32) }), healthOf(bob, { protocol: 'other' }), healthOf(bob, { identityPub: 'zz' })]) {
      const { verifier } = stubVerifier({ running: [{ name: 'bob', port: 7001 }], health: { 7001: bad } });
      expect(await run(verifier, env(bob))).toMatchObject({ reason: 'unknown-sender' });
      expect(verifier.firstContact.size).toBe(0);
    }
  });

  it('a forged envelope under a cached name is signature-invalid and the next genuine one still verifies', async () => {
    const { verifier, calls } = stubVerifier({ running: [{ name: 'bob', port: 7001 }], health: { 7001: healthOf(bob) } });
    const forger = createLocalSender('bob');
    // The forgery triggers the probe; the key the port advertises is cached; the forgery fails.
    for (let i = 0; i < PROBE_MAX_FAILURES + 2; i++) expect(await run(verifier, env(forger))).toMatchObject({ reason: 'signature-invalid' });
    expect(calls).toHaveLength(1);
    expect((await run(verifier, env(bob))).ok).toBe(true);
    expect(localRouteSignatureCounters.probeClosed).toBe(0);
  });

  it('the registry always wins over the cache, and a held key is never replaced', async () => {
    const { verifier } = stubVerifier({ running: [{ name: 'bob', port: 7001 }], health: { 7001: healthOf(bob) } });
    expect((await run(verifier, env(bob))).ok).toBe(true);
    // A discover later records a DIFFERENT key for bob: the registry key decides.
    const rotated = createLocalSender('bob');
    registerKnownAgent(stateDir, rotated);
    expect(await run(verifier, env(bob))).toMatchObject({ reason: 'signature-invalid' });
    expect((await run(verifier, env(rotated))).ok).toBe(true);
    expect(verifier.firstContact.get('bob')!.equals(bob.publicKey)).toBe(true);
  });

  it('single-flight: concurrent requests for one name share one probe', async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => { release = r; });
    let n = 0;
    const verifier = createLocalEnvelopeVerifier({
      listRunning: () => [{ name: 'bob', port: 7001 }],
      fetchHealth: async () => { n++; await gate; return healthOf(bob); },
      report: () => {},
    });
    const all = Promise.all([run(verifier, env(bob)), run(verifier, env(bob)), run(verifier, env(bob))]);
    release(null);
    expect((await all).every((v) => v.ok)).toBe(true);
    expect(n).toBe(1);
  });

  it('doubling backoff, then the name closes after five failed probes with ONE report, and reopens hourly', async () => {
    let now = 0;
    const { verifier, calls, reports } = stubVerifier({ running: [{ name: 'bob', port: 7001 }], health: {}, now: () => now });
    const attempt = async () => run(verifier, env(bob));
    await attempt();
    expect(calls).toHaveLength(1);
    now += 59_000; await attempt(); expect(calls).toHaveLength(1); // inside the 60 s backoff
    now += 2_000; await attempt(); expect(calls).toHaveLength(2);
    now += 119_000; await attempt(); expect(calls).toHaveLength(2); // 2 min backoff
    now += 2_000; await attempt(); expect(calls).toHaveLength(3);
    now += 4 * 60_000 + 1; await attempt(); expect(calls).toHaveLength(4);
    now += 8 * 60_000 + 1; await attempt(); expect(calls).toHaveLength(5);
    now += 30 * 60_000; await attempt(); await attempt();
    expect(calls).toHaveLength(5); // closed: nothing inside the hour
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('bob');
    expect(localRouteSignatureCounters.probeClosed).toBe(1);
    expect(localRouteSignatureCounters.probeFailed).toBe(5);
    // A closed name is not shut out for the process lifetime: one probe an hour, no second report.
    now += PROBE_CLOSED_RETRY_MS; await attempt(); await attempt();
    expect(calls).toHaveLength(6);
    expect(reports).toHaveLength(1);
    expect(localRouteSignatureCounters.probeClosed).toBe(1);
  });

  it('a name closed by forged envelopes while the peer was down recovers once the peer answers', async () => {
    let now = 0;
    let up = false;
    const verifier = createLocalEnvelopeVerifier({
      listRunning: () => [{ name: 'bob', port: 7001 }],
      fetchHealth: async () => { if (!up) throw new Error('ECONNREFUSED'); return healthOf(bob); },
      now: () => now,
      report: () => {},
    });
    const forger = createLocalSender('bob');
    for (let i = 0; i < PROBE_MAX_FAILURES; i++) { await run(verifier, env(forger)); now += 20 * 60_000; }
    expect(localRouteSignatureCounters.probeClosed).toBe(1);
    up = true;
    now += PROBE_CLOSED_RETRY_MS;
    expect((await run(verifier, env(bob))).ok).toBe(true);
  });

  it('two names answering with one key: the second is a failed probe and ambiguous', async () => {
    const clone: LocalSender = { ...bob, name: 'clone' };
    const { verifier } = stubVerifier({
      running: [{ name: 'bob', port: 1 }, { name: 'clone', port: 2 }],
      health: { 1: healthOf(bob), 2: healthOf(clone) },
    });
    expect((await run(verifier, env(bob))).ok).toBe(true);
    expect(await run(verifier, env(clone))).toMatchObject({ reason: 'ambiguous-sender' });
    expect(verifier.firstContact.size).toBe(1);
    expect(localRouteSignatureCounters.probeFailed).toBe(1);
  });

  it('a probed key the registry holds under another name is ambiguous', async () => {
    registerKnownAgent(stateDir, { ...bob, name: 'original' });
    const { verifier } = stubVerifier({ running: [{ name: 'bob', port: 1 }], health: { 1: healthOf(bob) } });
    expect(await run(verifier, env(bob))).toMatchObject({ reason: 'ambiguous-sender' });
  });

  it('allowProbe:false (the boot pass) uses the cache only', async () => {
    const { verifier, calls } = stubVerifier({ running: [{ name: 'bob', port: 7001 }], health: { 7001: healthOf(bob) } });
    expect(await run(verifier, env(bob), { allowProbe: false })).toMatchObject({ reason: 'unknown-sender' });
    expect(calls).toEqual([]);
  });
});

describe('signed envelope — mode, refusal body, counters, log line, audit log', () => {
  beforeEach(() => resetLocalRouteSignatureStateForTests());

  it('mode: the dev gate decides when enabled is omitted; only dryRun:false enforces', () => {
    expect(resolveLocalRouteSignatureMode({}, {})).toBe('off');
    expect(resolveLocalRouteSignatureMode({}, { developmentAgent: true })).toBe('dry-run');
    expect(resolveLocalRouteSignatureMode({}, { developmentAgent: true, threadline: { localRouteSignature: { enabled: false } } })).toBe('off');
    expect(resolveLocalRouteSignatureMode({}, { threadline: { localRouteSignature: { enabled: true } } })).toBe('dry-run');
    expect(resolveLocalRouteSignatureMode({}, { threadline: { localRouteSignature: { enabled: true, dryRun: false } } })).toBe('enforcing');
    // Live values win over the boot config; a non-false dryRun observes.
    expect(resolveLocalRouteSignatureMode({ enabled: false }, { threadline: { localRouteSignature: { enabled: true, dryRun: false } } })).toBe('off');
    expect(resolveLocalRouteSignatureMode({ dryRun: true }, { threadline: { localRouteSignature: { enabled: true, dryRun: false } } })).toBe('dry-run');
    expect(resolveLocalRouteSignatureMode({ dryRun: 'no' as never }, { developmentAgent: true })).toBe('dry-run');
  });

  it('the requirement header: any non-empty value is a requirement; unmet unless enforcing AND v1 only', () => {
    for (const mode of ['off', 'dry-run', 'enforcing'] as const) {
      expect(requiresUnmetSignature(undefined, mode)).toBe(false);
      expect(requiresUnmetSignature('', mode)).toBe(false);
      expect(requiresUnmetSignature('  ', mode)).toBe(false);
    }
    expect(requiresUnmetSignature('v1', 'off')).toBe(true);
    expect(requiresUnmetSignature('v1', 'dry-run')).toBe(true);
    expect(requiresUnmetSignature('v1', 'enforcing')).toBe(false);
    // A duplicated header arrives joined; it is still one met requirement.
    expect(requiresUnmetSignature('v1, v1', 'enforcing')).toBe(false);
    expect(requiresUnmetSignature(['v1', 'v1'], 'enforcing')).toBe(false);
    expect(requiresUnmetSignature('v1, v1', 'dry-run')).toBe(true);
    // A version this receiver does not implement is never silently ignored.
    expect(requiresUnmetSignature('v2', 'enforcing')).toBe(true);
    expect(requiresUnmetSignature('v1, v2', 'enforcing')).toBe(true);
  });

  it('refusal body: every reason carries retryable + remedy and nothing else', () => {
    expect(Object.keys(LOCAL_ENVELOPE_REASONS)).toHaveLength(12);
    expect(localEnvelopeRefusalBody('unsigned')).toEqual({ error: 'bad-signature', refused: true, retryable: false, remedy: 'sender', reason: 'unsigned' });
    expect(localEnvelopeRefusalBody('unknown-sender')).toMatchObject({ retryable: true, remedy: 'receiver' });
    expect(localEnvelopeRefusalBody('ambiguous-sender')).toMatchObject({ retryable: true, remedy: 'receiver' });
    expect(localEnvelopeRefusalBody('not-enforcing')).toMatchObject({ retryable: true, remedy: 'receiver' });
    expect(localEnvelopeRefusalBody('signature-invalid')).toMatchObject({ retryable: false, remedy: 'sender' });
  });

  it('counters: verified per sender; would-refuse vs refused by mode; not-enforcing is always a refusal', () => {
    const c = localRouteSignatureCounters;
    countLocalEnvelopeVerdict('dry-run', { ok: true, fingerprint: 'f', senderName: 'Alice' });
    countLocalEnvelopeVerdict('dry-run', { ok: false, reason: 'unsigned', senderName: 'bob' });
    countLocalEnvelopeVerdict('enforcing', { ok: false, reason: 'stale', senderName: 'bob' });
    countLocalEnvelopeVerdict('dry-run', { ok: false, reason: 'not-enforcing', senderName: 'dawn' });
    expect(c.verified).toBe(1);
    expect(c.verifiedBySender).toEqual({ alice: 1 });
    expect(c.wouldRefuse).toBe(1);
    expect(c.refused).toBe(2);
    expect(c.byReason.unsigned).toBe(1);
    expect(c.byReason.stale).toBe(1);
    expect(c.byReason['not-enforcing']).toBe(1);
  });

  it('log line: reduces the name, and is rate-limited per (name, reason)', () => {
    const line = localEnvelopeRefusalLogLine('would-refuse', 'evil\nname\u001b[31m with spaces', 'unsigned', 1000)!;
    expect(line).toBe('[relay-agent-signature] would-refuse from=evil?name?[31m?with?spaces reason=unsigned');
    expect(localEnvelopeRefusalLogLine('would-refuse', 'evil\nname\u001b[31m with spaces', 'unsigned', 30_000)).toBeNull();
    expect(localEnvelopeRefusalLogLine('refuse', 'evil\nname\u001b[31m with spaces', 'stale', 30_000)).not.toBeNull();
    expect(localEnvelopeRefusalLogLine('would-refuse', 'evil\nname\u001b[31m with spaces', 'unsigned', 62_000)).not.toBeNull();
    expect(localEnvelopeRefusalLogLine('refuse', null, 'malformed', 1)).toContain('from=unknown');
    // Bounded: past 256 distinct keys inside the window, lines share one bucket.
    resetLocalRouteSignatureStateForTests();
    for (let i = 0; i < 256; i++) expect(localEnvelopeRefusalLogLine('refuse', `n${i}`, 'unsigned', 5)).not.toBeNull();
    expect(localEnvelopeRefusalLogLine('refuse', 'overflow-1', 'unsigned', 6)).not.toBeNull();
    expect(localEnvelopeRefusalLogLine('refuse', 'overflow-2', 'unsigned', 7)).toBeNull();
  });

  it('audit log: one metadata-only row per verdict, mode 0600 kept across a rotation, a failed append counted', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lse-audit-'));
    try {
      const file = localRouteSignatureAuditPath(stateDir);
      countLocalEnvelopeVerdict('dry-run', { ok: true, fingerprint: 'f', senderName: 'alice' }, stateDir);
      countLocalEnvelopeVerdict('dry-run', { ok: false, reason: 'unsigned', senderName: 'bob\nx' }, stateDir);
      countLocalEnvelopeVerdict('enforcing', { ok: false, reason: 'stale', senderName: 'bob' }, stateDir);
      countLocalEnvelopeVerdict('off', { ok: false, reason: 'unsigned', senderName: 'bob' }); // no stateDir ⇒ no row
      const rows = fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows.map((r) => [r.source, r.mode, r.outcome, r.from, r.reason])).toEqual([
        ['route', 'dry-run', 'verified', 'alice', undefined],
        ['route', 'dry-run', 'would-refuse', 'bob?x', 'unsigned'],
        ['route', 'enforcing', 'refused', 'bob', 'stale'],
      ]);
      for (const r of rows) expect(Object.keys(r).sort()).toEqual(r.reason ? ['from', 'mode', 'outcome', 'reason', 'source', 'ts'] : ['from', 'mode', 'outcome', 'source', 'ts']);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      // Force a rotation (the helper rewrites at the default mode): 0600 is re-applied.
      fs.appendFileSync(file, `${JSON.stringify({ ts: 'x', pad: 'p'.repeat(200) })}\n`.repeat(12_000));
      appendLocalRouteSignatureAudit(stateDir, { source: 'route', mode: 'dry-run', outcome: 'verified', from: 'alice' });
      expect(fs.statSync(file).size).toBeLessThan(2 * 1024 * 1024);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      // A failed append is counted, never thrown.
      const before = localRouteSignatureCounters.auditWriteFailures;
      fs.writeFileSync(path.join(stateDir, 'blocker'), 'x');
      expect(() => appendLocalRouteSignatureAudit(path.join(stateDir, 'blocker'), { source: 'route', mode: 'dry-run', outcome: 'verified', from: 'a' })).not.toThrow();
      expect(localRouteSignatureCounters.auditWriteFailures).toBe(before + 1);
    } finally {
      SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP });
    }
  });
});

describe('signed envelope — the signer', () => {
  beforeEach(() => resetLocalRouteSignatureStateForTests());

  it('signs for its own name, never for another, and reports ONE missing identity', () => {
    const me = createLocalSender('me');
    const reports: string[] = [];
    const signer = createLocalEnvelopeSigner('Me', () => ({ privateKey: me.privateKey }), (r) => reports.push(r));
    const env = makeLocalEnvelope('me', 'you');
    const sig = signer(env)!;
    expect(verifyLocalEnvelope({ ...env, signature: sig }, me.publicKey)).toBe(true);
    expect(signer(makeLocalEnvelope('someone-else', 'you'))).toBeNull();
    expect(localRouteSignatureCounters).toMatchObject({ signed: 1, signRefusedForeignFrom: 1, signFailures: 0 });

    const none = createLocalEnvelopeSigner('me', () => null, (r) => reports.push(r));
    expect(none(env)).toBeNull();
    expect(none(env)).toBeNull();
    expect(localRouteSignatureCounters.signFailures).toBe(2);
    expect(reports).toHaveLength(1);
  });

  it('THE production signer signs with the Threadline identity, read at each sign', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lse-signer-'));
    try {
      const signer = createAgentLocalEnvelopeSigner('me', stateDir);
      const env = makeLocalEnvelope('me', 'you');
      // Built BEFORE the identity exists (as in server.ts): no identity yet.
      expect(localEnvelopeSignerAvailable(stateDir)).toBe(false);
      expect(signer(env)).toBeNull();
      const id = new IdentityManager(stateDir).getOrCreate();
      expect(localEnvelopeSignerAvailable(stateDir)).toBe(true);
      const sig = signer(env)!;
      expect(verifyLocalEnvelope({ ...env, signature: sig }, id.publicKey)).toBe(true);
      // The identity is replaced on disk: the SAME signer signs with the new one,
      // the one /threadline/health (a fresh reader per request) now advertises.
      for (const f of fs.readdirSync(stateDir, { recursive: true }) as string[]) {
        const full = path.join(stateDir, f);
        if (fs.statSync(full).isFile()) SafeFsExecutor.safeUnlinkSync(full, { operation: OP });
      }
      const next = new IdentityManager(stateDir).getOrCreate();
      expect(next.publicKey.equals(id.publicKey)).toBe(false);
      const sig2 = signer(makeLocalEnvelope('me', 'you'))!;
      const env2 = makeLocalEnvelope('me', 'you');
      expect(verifyLocalEnvelope({ ...env2, signature: signer(env2)! }, next.publicKey)).toBe(true);
      expect(sig2).toBeTruthy();
    } finally {
      SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP });
    }
  });
});

// ── MessageRouter + drop pickup: a redirected home so nothing touches ~/.instar ──

vi.mock('../../src/core/AgentRegistry.js', async (orig) => {
  const actual = await orig<typeof import('../../src/core/AgentRegistry.js')>();
  return { ...actual, listAgents: vi.fn(() => (globalThis as { __lseRunning?: unknown[] }).__lseRunning ?? []) };
});

describe('signed envelope — MessageRouter and drop pickup (redirected home)', () => {
  let home: string;
  let prevHome: string | undefined;
  let storeDir: string;
  let store: MessageStore;
  let stateDir: string;
  const TARGET = 'lse-target';
  const SENDER = 'lse-sender';
  let senderId: LocalSender;
  const dropDir = () => path.join(home, '.instar', 'messages', 'drop', TARGET);
  const dropFiles = () => (fs.existsSync(dropDir()) ? fs.readdirSync(dropDir()).filter((f) => f.endsWith('.json')) : []);

  beforeEach(async () => {
    resetLocalRouteSignatureStateForTests();
    prevHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lse-home-'));
    process.env.HOME = home;
    expect(os.homedir()).toBe(home);
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lse-store-'));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lse-state-'));
    store = new MessageStore(storeDir);
    await store.initialize();
    generateAgentToken(SENDER);
    generateAgentToken(TARGET);
    senderId = createLocalSender(SENDER);
    (globalThis as { __lseRunning?: unknown[] }).__lseRunning = [];
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await store.destroy();
    process.env.HOME = prevHome;
    for (const d of [home, storeDir, stateDir]) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  const router = () => new MessageRouter(store, { deliver: async () => ({ success: true }) } as never, {
    localAgent: SENDER,
    localMachine: 'm1',
    serverUrl: 'http://localhost:1',
    envelopeSigner: createLocalEnvelopeSigner(SENDER, () => ({ privateKey: senderId.privateKey })),
  });
  const send = (r: MessageRouter, fromAgent = SENDER) =>
    r.send({ agent: fromAgent, session: 's', machine: 'm1' }, { agent: TARGET, session: 'best', machine: 'local' }, 'info', 'medium', 'subject', 'body');
  const stubFetch = (status: number, body: unknown) => {
    const posted: MessageEnvelope[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      posted.push(JSON.parse(init.body));
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }));
    return posted;
  };
  const running = () => { (globalThis as { __lseRunning?: unknown[] }).__lseRunning = [{ name: TARGET, port: 65000, status: 'running' }]; };

  it('signs before the POST, and an accepted POST is received', async () => {
    running();
    const posted = stubFetch(200, { ok: true });
    const res = await send(router());
    expect(posted).toHaveLength(1);
    expect(verifyLocalEnvelope(posted[0], senderId.publicKey)).toBe(true);
    expect((await store.get(res.messageId))?.delivery.phase).toBe('received');
    expect(dropFiles()).toEqual([]);
  });

  it('an explicit refusal is terminal at 401, 403 and 503 — failed, reason recorded, nothing dropped', async () => {
    running();
    for (const [status, body] of [
      [401, { error: 'bad-signature', refused: true, retryable: false, remedy: 'sender', reason: 'unsigned' }],
      [403, { error: 'insufficient-trust', refused: true, retryable: false }],
      [503, { error: 'signature-check-unavailable', refused: true, retryable: true }],
    ] as const) {
      stubFetch(status, body);
      const res = await send(router());
      const stored = await store.get(res.messageId);
      expect(stored?.delivery.phase).toBe('failed');
      expect(stored?.delivery.failureReason).toContain(body.error);
      expect(dropFiles()).toEqual([]);
    }
    expect(localRouteSignatureCounters.localRefused).toBe(3);
  });

  it('the receiver\'s words are reduced before they reach our log and store', async () => {
    running();
    stubFetch(401, { error: 'bad\nsignature\u001b[31m', refused: true, reason: `line1\nline2 ${'x'.repeat(200)}` });
    const res = await send(router());
    const reason = (await store.get(res.messageId))!.delivery.failureReason!;
    expect(reason).not.toMatch(/[\n\u001b ]x/);
    expect(reason).toContain('bad?signature?[31m/line1?line2?');
    expect(reason.length).toBeLessThan(160);
  });

  it('an answered error WITHOUT the flag, a non-JSON body and a network error all drop as before', async () => {
    running();
    stubFetch(401, { error: 'Invalid or missing agent token' });
    await send(router());
    stubFetch(500, 'boom');
    await send(router());
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await send(router());
    expect(dropFiles()).toHaveLength(3);
  });

  it('a drop written with NO POST (target not registered) carries the signature', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await send(router());
    expect(fetchSpy).not.toHaveBeenCalled();
    const [file] = dropFiles();
    const dropped = JSON.parse(fs.readFileSync(path.join(dropDir(), file), 'utf-8')) as MessageEnvelope;
    expect(dropped.transport.hmac).toBeTruthy();
    // dropMessage touched only delivery + hmac/hmacBy: the signature still verifies.
    expect(verifyLocalEnvelope(dropped, senderId.publicKey)).toBe(true);
  });

  it('a foreign from is sent UNSIGNED — the signer never lends its name', async () => {
    running();
    const posted = stubFetch(200, { ok: true });
    await send(router(), 'someone-else');
    expect(posted[0].signature).toBeUndefined();
    expect(localRouteSignatureCounters.signRefusedForeignFrom).toBe(1);
  });

  // ── drop pickup ──
  function writeDrop(opts: { signedBy?: LocalSender | null; from?: string; ageMs?: number; hmac?: boolean } = {}): string {
    const env = makeLocalEnvelope(opts.from ?? SENDER, TARGET) as unknown as MessageEnvelope;
    if (opts.signedBy !== null) env.signature = signLocalEnvelope(env, (opts.signedBy ?? senderId).privateKey)!;
    if (opts.hmac !== false) {
      env.transport.hmac = computeDropHmac(generateAgentToken(SENDER), {
        message: env.message, originServer: env.transport.originServer, nonce: env.transport.nonce, timestamp: env.transport.timestamp,
      });
      env.transport.hmacBy = SENDER;
    }
    fs.mkdirSync(dropDir(), { recursive: true });
    const file = path.join(dropDir(), `${env.message.id}.json`);
    fs.writeFileSync(file, JSON.stringify(env));
    if (opts.ageMs) { const t = new Date(Date.now() - opts.ageMs); fs.utimesSync(file, t, t); }
    return env.message.id;
  }
  const pickup = (mode: 'off' | 'dry-run' | 'enforcing', pass: 'boot' | 'second', verifier = stubVerifier({}).verifier) =>
    pickupDroppedMessages(TARGET, store, { mode, stateDir, pass, verifier });

  it('off and no signature argument: exactly as before (an unsigned drop is ingested)', async () => {
    const a = writeDrop({ signedBy: null });
    expect((await pickupDroppedMessages(TARGET, store)).ingested).toBe(1);
    const b = writeDrop({ signedBy: null });
    expect((await pickup('off', 'boot')).ingested).toBe(1);
    expect(await store.exists(a)).toBe(true);
    expect(await store.exists(b)).toBe(true);
    expect(fs.existsSync(localRouteSignatureAuditPath(stateDir))).toBe(false);
  });

  it('dry-run: verifies and counts, then ingests everything as today', async () => {
    registerKnownAgent(stateDir, senderId);
    writeDrop();
    writeDrop({ signedBy: null });
    const r = await pickup('dry-run', 'boot');
    expect(r).toMatchObject({ ingested: 2, held: 0, expired: 0 });
    expect(localRouteSignatureCounters).toMatchObject({ dropsVerified: 1, wouldRefuse: 1, dropsHeld: 0 });
    expect(localRouteSignatureCounters.byReason.unsigned).toBe(1);
    const rows = fs.readFileSync(localRouteSignatureAuditPath(stateDir), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((x) => [x.source, x.outcome]).sort()).toEqual([['drop', 'verified'], ['drop', 'would-refuse']]);
  });

  it('enforcing: a proven drop is ingested; an unproven one is HELD in place, never deleted on first look', async () => {
    registerKnownAgent(stateDir, senderId);
    const good = writeDrop();
    const unsigned = writeDrop({ signedBy: null });
    const forged = writeDrop({ signedBy: createLocalSender(SENDER) });
    const r = await pickup('enforcing', 'boot');
    expect(r).toMatchObject({ ingested: 1, held: 2, expired: 0, rejected: 0 });
    expect(r.heldSenders).toEqual([SENDER]);
    expect(await store.exists(good)).toBe(true);
    expect(await store.exists(unsigned)).toBe(false);
    expect(await store.exists(forged)).toBe(false);
    expect(dropFiles().sort()).toEqual([`${unsigned}.json`, `${forged}.json`].sort());
  });

  it('the existing checks still run first and still delete (missing HMAC)', async () => {
    registerKnownAgent(stateDir, senderId);
    writeDrop({ hmac: false });
    const r = await pickup('enforcing', 'boot');
    expect(r).toMatchObject({ rejected: 1, held: 0 });
    expect(dropFiles()).toEqual([]);
  });

  it('the boot pass never probes and never expires; the second pass probes, ingests, and expires at 7 days', async () => {
    // The sender is known only through first contact (nothing in the registry).
    const fresh = writeDrop();
    const ancientUnsigned = writeDrop({ signedBy: null, ageMs: HELD_DROP_MAX_AGE_MS + 60_000 });
    const { verifier, calls } = stubVerifier({ running: [{ name: SENDER, port: 7001 }], health: { 7001: healthOf(senderId) } });

    const boot = await pickup('enforcing', 'boot', verifier);
    expect(calls).toEqual([]);
    expect(boot).toMatchObject({ ingested: 0, held: 2, expired: 0 });
    expect(dropFiles()).toHaveLength(2);

    const second = await pickup('enforcing', 'second', verifier);
    expect(calls).toEqual([7001]);
    expect(second).toMatchObject({ ingested: 1, held: 0, expired: 1 });
    expect(await store.exists(fresh)).toBe(true);
    expect(await store.exists(ancientUnsigned)).toBe(false);
    expect(dropFiles()).toEqual([]);
    expect(localRouteSignatureCounters).toMatchObject({ dropsExpired: 1, dropsHeld: 2, dropsVerified: 1 });
    const outcomes = fs.readFileSync(localRouteSignatureAuditPath(stateDir), 'utf-8').trim().split('\n').map((l) => JSON.parse(l).outcome);
    expect(outcomes.sort()).toEqual(['expired', 'held', 'held', 'verified']);
  });

  it('a second-pass unproven drop younger than 7 days stays held', async () => {
    const young = writeDrop({ signedBy: null, ageMs: HELD_DROP_MAX_AGE_MS - 60 * 60_000 });
    const r = await pickup('enforcing', 'second');
    expect(r).toMatchObject({ held: 1, expired: 0 });
    expect(dropFiles()).toEqual([`${young}.json`]);
  });

  it('a verifier error holds (enforcing) and never reaches the deleting catch', async () => {
    registerKnownAgent(stateDir, senderId);
    const id = writeDrop();
    const broken = { firstContact: { resolve: async () => { throw new Error('boom'); }, holdsKeyUnderOtherName: () => { throw new Error('boom'); } }, replay: new ReplayCache() } as never;
    const r = await pickup('enforcing', 'boot', broken);
    expect(r).toMatchObject({ held: 1, rejected: 0, ingested: 0 });
    expect(dropFiles()).toEqual([`${id}.json`]);
    expect(localRouteSignatureCounters.errors).toBe(1);
  });
});

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('signed envelope — migration parity', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-lse-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: OP }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('adds the CLAUDE.md section once and is idempotent', () => {
    const claudeMd = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n');
    const r1 = run();
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded).toContain('CLAUDE.md: added A2A local-route signed envelope section');
    const after = fs.readFileSync(claudeMd, 'utf-8');
    expect(after).toContain('### A2A local-route signed envelope');
    expect(after).toContain("{ error: 'bad-signature', refused: true, reason, remedy, retryable }");
    expect(after).toContain('logs/relay-agent-signature.jsonl');
    expect(run().upgraded).not.toContain('CLAUDE.md: added A2A local-route signed envelope section');
    expect(fs.readFileSync(claudeMd, 'utf-8').split('### A2A local-route signed envelope').length - 1).toBe(1);
  });

  it('the template carries the same section for new agents', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain('### A2A local-route signed envelope');
    expect(md).toContain('X-Instar-Require-Signature: v1');
  });

  it('no config default is added; one DEV_GATED_FEATURES entry decides', () => {
    const d = getMigrationDefaults('standalone') as { threadline?: Record<string, unknown> };
    expect(d.threadline?.localRouteSignature).toBeUndefined();
    expect(DEV_GATED_FEATURES.filter((f) => f.configPath === 'threadline.localRouteSignature.enabled')).toHaveLength(1);
    const dev: Record<string, unknown> = { developmentAgent: true };
    applyDefaults(dev, getMigrationDefaults('standalone'));
    const fleet: Record<string, unknown> = { developmentAgent: false };
    applyDefaults(fleet, getMigrationDefaults('standalone'));
    expect(resolveLocalRouteSignatureMode({}, dev as never)).toBe('dry-run');
    expect(resolveLocalRouteSignatureMode({}, fleet as never)).toBe('off');
  });
});
