/**
 * Unit tests — TopicProfileTransferCarrier (TOPIC-PROFILE-SPEC §5.3 / §11).
 *
 * Covers: the serve-side `topic-profile-pull` handler (present/absent
 * entries, malformed/oversized requests); acquire batching (ONE pull per
 * peer per window — never N per-topic requests); the durable (peer, batch)
 * retry with backoff incl. restart survival; protocol-unsupported parking
 * (vs unreachable backoff); the §5.3 cancel marker (a durable local
 * operator/http write cancels the pending REPLACE — including across a
 * restart and against an in-flight pull — while system writes never
 * cancel); the clock-free supersede of an older pending pull by a newer
 * one (A→B→C→B); the updatedAt backstop (local newer wins, ties favor
 * local, future-dated arriving treated as older); absent-on-previous-owner
 * clears nothing; mandatory §10.2 receiving-machine revalidation with the
 * aggregated one-summary disclosure; and the not-owner apply-time skip.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicProfileStore, type TopicProfile } from '../../src/core/TopicProfileStore.js';
import {
  TopicProfileTransferCarrier,
  createTopicProfilePullHandler,
  type SendPullOutcome,
  type TopicProfilePullEntry,
  type TopicProfileTransferCarrierDeps,
} from '../../src/core/TopicProfileTransferCarrier.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-profile-carrier-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/TopicProfileTransferCarrier.test.ts:afterEach',
  });
});

function newStore(): TopicProfileStore {
  return new TopicProfileStore({
    stateFilePath: path.join(tmpDir, 'state', 'topic-profiles.json'),
  });
}

const profile = (over: Partial<TopicProfile> = {}): TopicProfile => ({
  updatedAt: '2026-06-01T00:00:00.000Z',
  updatedBy: 'op:remote',
  framework: 'codex-cli',
  ...over,
});

const entryFor = (topicKey: string, current: TopicProfile | null): TopicProfilePullEntry => ({
  topicKey,
  present: true,
  current,
  intendedProfile: null,
});

interface Harness {
  store: TopicProfileStore;
  carrier: TopicProfileTransferCarrier;
  sent: Array<{ peer: string; topics: string[] }>;
  audits: Array<Record<string, unknown>>;
  notices: string[];
}

function newCarrier(over: Partial<TopicProfileTransferCarrierDeps> = {}, store?: TopicProfileStore): Harness {
  const s = store ?? newStore();
  const sent: Array<{ peer: string; topics: string[] }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const carrier = new TopicProfileTransferCarrier({
    stateDir: tmpDir,
    selfMachineId: 'self',
    store: s,
    effectiveFramework: () => 'claude-code',
    ownerOf: () => ({ owner: 'self' }),
    sendPull: async (peer, topics) => {
      sent.push({ peer, topics: [...topics] });
      return { kind: 'ok', entries: topics.map((t) => entryFor(t, profile())) };
    },
    audit: (e) => audits.push(e),
    notify: (t) => notices.push(t),
    batchWindowMs: 5,
    retryBackoffStartMs: 1000,
    ...over,
  });
  return { store: s, carrier, sent, audits, notices };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── serve side ───────────────────────────────────────────────────────────────

describe('createTopicProfilePullHandler (serve side)', () => {
  it('serves present entries and present:false for absent topics', async () => {
    const store = newStore();
    await store.mutate(10, { framework: 'codex-cli', updatedBy: 'op:1' });
    const handler = createTopicProfilePullHandler({ store });

    const res = handler({ type: 'topic-profile-pull', topics: ['10', '11'] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]).toMatchObject({ topicKey: '10', present: true });
    expect(res.entries[0].current?.framework).toBe('codex-cli');
    expect(res.entries[1]).toMatchObject({ topicKey: '11', present: false, current: null });
  });

  it('serves the dry-run shadow when only a shadow exists (travels verbatim)', async () => {
    const store = new TopicProfileStore({
      stateFilePath: path.join(tmpDir, 'state', 'topic-profiles.json'),
      isDryRun: () => true,
    });
    await store.setShadow(7, { thinkingMode: 'max' }, 'op:1');
    const handler = createTopicProfilePullHandler({ store });

    const res = handler({ type: 'topic-profile-pull', topics: ['7'] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries[0].present).toBe(true);
    expect(res.entries[0].intendedProfile?.fields.thinkingMode).toBe('max');
  });

  it('refuses malformed and oversized topic lists', () => {
    const handler = createTopicProfilePullHandler({ store: newStore(), maxTopicsPerPull: 3 });
    expect(handler({ type: 'topic-profile-pull', topics: 'nope' })).toEqual({ ok: false, reason: 'malformed-topics' });
    expect(handler({ type: 'topic-profile-pull', topics: [1, 2] })).toEqual({ ok: false, reason: 'malformed-topics' });
    expect(handler({ type: 'topic-profile-pull', topics: ['1', '2', '3', '4'] })).toEqual({
      ok: false,
      reason: 'too-many-topics',
    });
  });
});

// ── acquire batching (§5.3 batch bound) ──────────────────────────────────────

describe('TopicProfileTransferCarrier — pull-at-acquire batching', () => {
  it('coalesces acquires within the window into ONE pull per peer', async () => {
    const h = newCarrier();
    h.carrier.onTopicAcquired(1, 'machine-a');
    h.carrier.onTopicAcquired(2, 'machine-a');
    h.carrier.onTopicAcquired(3, 'machine-a');
    await sleep(25);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].peer).toBe('machine-a');
    expect(h.sent[0].topics.sort()).toEqual(['1', '2', '3']);
  });

  it('issues one pull per distinct previous-owner peer', async () => {
    const h = newCarrier();
    h.carrier.onTopicAcquired(1, 'machine-a');
    h.carrier.onTopicAcquired(2, 'machine-b');
    await sleep(25);
    expect(h.sent.map((s) => s.peer).sort()).toEqual(['machine-a', 'machine-b']);
  });

  it('skips self-moves and unknown previous owners', async () => {
    const h = newCarrier({ prevOwnerOf: () => null });
    h.carrier.onTopicAcquired(1, 'self');
    h.carrier.onTopicAcquired(2, null);
    h.carrier.onTopicAcquired(3); // falls to prevOwnerOf → null
    await sleep(25);
    expect(h.sent).toHaveLength(0);
    expect(h.carrier.pending()).toHaveLength(0);
  });

  it('a landed pull REPLACEs the local entry and is visible to resolve() with no restart', async () => {
    const h = newCarrier();
    h.carrier.onTopicAcquired(42, 'machine-a');
    await h.carrier.flushStaged();
    expect(h.store.resolve(42)?.framework).toBe('codex-cli');
    expect(h.store.resolve(42)?.updatedBy).toBe('op:remote'); // provenance verbatim
    expect(h.carrier.pending()).toHaveLength(0);
    expect(h.carrier.hasPendingPull(42)).toBe(false);
    // ONE aggregated summary, not per-topic chatter.
    expect(h.notices).toHaveLength(1);
  });

  it('absent on the previous owner clears NOTHING — the local entry stays', async () => {
    const h = newCarrier({
      sendPull: async (_peer, topics) => ({
        kind: 'ok',
        entries: topics.map((t) => ({ topicKey: t, present: false, current: null, intendedProfile: null })),
      }),
    });
    await h.store.mutate(5, { framework: 'gemini-cli', updatedBy: 'op:local' });
    h.carrier.onTopicAcquired(5, 'machine-a');
    await h.carrier.flushStaged();
    expect(h.store.resolve(5)?.framework).toBe('gemini-cli');
    expect(h.audits.some((a) => a.kind === 'pull-absent-on-previous-owner')).toBe(true);
    expect(h.carrier.pending()).toHaveLength(0);
  });

  it('apply-time ownership recheck: a topic this machine no longer owns is skipped', async () => {
    const h = newCarrier({ ownerOf: () => ({ owner: 'machine-c' }) });
    h.carrier.onTopicAcquired(9, 'machine-a');
    await h.carrier.flushStaged();
    expect(h.store.resolve(9)).toBeNull();
    expect(h.audits.some((a) => a.kind === 'pull-skipped-not-owner')).toBe(true);
    expect(h.carrier.pending()).toHaveLength(0); // resolved, never retried
  });
});

// ── §10.2 receiving-machine revalidation ─────────────────────────────────────

describe('TopicProfileTransferCarrier — mandatory revalidation on landing', () => {
  it('drops an off-enum field to the default and keeps valid siblings, with ONE aggregated disclosure', async () => {
    const arriving = profile({
      framework: 'codex-cli',
      thinkingMode: 'turbo' as never, // off-enum — a divergent/forged peer value
    });
    const h = newCarrier({
      sendPull: async (_peer, topics) => ({ kind: 'ok', entries: topics.map((t) => entryFor(t, arriving)) }),
    });
    h.carrier.onTopicAcquired(1, 'machine-a');
    await h.carrier.flushStaged();

    const landed = h.store.resolve(1);
    expect(landed?.framework).toBe('codex-cli'); // valid sibling kept
    expect(landed?.thinkingMode ?? null).toBeNull(); // off-enum fell to default
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('thinkingMode');
  });

  it('validates the arriving model against the ARRIVING framework (cross-framework id falls)', async () => {
    const arriving = profile({ framework: 'codex-cli', model: 'opus' }); // claude id on codex
    const h = newCarrier({
      sendPull: async (_peer, topics) => ({ kind: 'ok', entries: topics.map((t) => entryFor(t, arriving)) }),
    });
    h.carrier.onTopicAcquired(1, 'machine-a');
    await h.carrier.flushStaged();
    expect(h.store.resolve(1)?.framework).toBe('codex-cli');
    expect(h.store.resolve(1)?.model ?? null).toBeNull();
  });
});

// ── durable retry (unreachable / protocol-unsupported) ───────────────────────

describe('TopicProfileTransferCarrier — durable retry', () => {
  it('an unreachable peer files a durable record with backoff that survives a restart', async () => {
    const h = newCarrier({ sendPull: async () => ({ kind: 'unreachable' as const }) });
    h.carrier.onTopicAcquired(1, 'machine-a');
    h.carrier.onTopicAcquired(2, 'machine-a');
    await h.carrier.flushStaged();

    const pending = h.carrier.pending();
    expect(pending).toHaveLength(1); // ONE (peer, batch) record — never per-topic
    expect(pending[0].topics.sort()).toEqual(['1', '2']);
    expect(pending[0].attempts).toBe(1);
    expect(pending[0].nextRetryAt).toBeGreaterThan(Date.now());
    expect(h.carrier.hasPendingPull(1)).toBe(true);

    // "Restart": a fresh carrier over the same stateDir sees the record and
    // a due tick retries it to success.
    const ok: SendPullOutcome = { kind: 'ok', entries: [entryFor('1', profile()), entryFor('2', profile())] };
    const h2 = newCarrier(
      {
        sendPull: async () => ok,
        now: () => new Date(Date.now() + 60_000), // past the backoff
      },
      h.store,
    );
    expect(h2.carrier.pending()).toHaveLength(1);
    await h2.carrier.tick();
    expect(h2.store.resolve(1)?.framework).toBe('codex-cli');
    expect(h2.carrier.pending()).toHaveLength(0);
  });

  it('protocol-unsupported PARKS the record (no backoff spin) until the handshake reports support', async () => {
    let supports = false;
    let calls = 0;
    const h = newCarrier({
      sendPull: async (_peer, topics) => {
        calls++;
        if (!supports) return { kind: 'protocol-unsupported' as const };
        return { kind: 'ok' as const, entries: topics.map((t) => entryFor(t, profile())) };
      },
      peerSupportsPull: () => (supports ? true : undefined),
    });
    h.carrier.onTopicAcquired(1, 'machine-old');
    await h.carrier.flushStaged();
    expect(h.carrier.pending()[0]?.parkedForProtocol).toBe(true);

    await h.carrier.tick();
    await h.carrier.tick();
    expect(calls).toBe(1); // parked — no transport attempts while unsupported

    supports = true;
    await h.carrier.tick();
    expect(h.store.resolve(1)?.framework).toBe('codex-cli');
    expect(h.carrier.pending()).toHaveLength(0);
  });

  it('a known-unsupported peer parks WITHOUT burning a transport attempt', async () => {
    let calls = 0;
    const h = newCarrier({
      sendPull: async () => {
        calls++;
        return { kind: 'unreachable' as const };
      },
      peerSupportsPull: () => false,
    });
    h.carrier.onTopicAcquired(1, 'machine-old');
    await h.carrier.flushStaged();
    expect(calls).toBe(0);
    expect(h.carrier.pending()[0]?.parkedForProtocol).toBe(true);
  });

  it('onPeerOnline drains a pending pull immediately (backoff bypassed)', async () => {
    let reachable = false;
    const h = newCarrier({
      sendPull: async (_peer, topics) => {
        if (!reachable) return { kind: 'unreachable' as const };
        return { kind: 'ok' as const, entries: topics.map((t) => entryFor(t, profile())) };
      },
    });
    h.carrier.onTopicAcquired(1, 'machine-a');
    await h.carrier.flushStaged();
    expect(h.carrier.pending()).toHaveLength(1);

    reachable = true;
    await h.carrier.onPeerOnline('machine-a');
    expect(h.store.resolve(1)?.framework).toBe('codex-cli');
    expect(h.carrier.pending()).toHaveLength(0);
  });

  it('expired records drop at tick with an audit (TTL sweep)', async () => {
    const h = newCarrier({
      sendPull: async () => ({ kind: 'unreachable' as const }),
      pendingTtlMs: 1,
    });
    h.carrier.onTopicAcquired(1, 'machine-a');
    await h.carrier.flushStaged();
    await sleep(10);
    await h.carrier.tick();
    expect(h.carrier.pending()).toHaveLength(0);
    expect(h.audits.some((a) => a.kind === 'pull-expired')).toBe(true);
  });
});

// ── the §5.3 cancel marker ───────────────────────────────────────────────────

describe('TopicProfileTransferCarrier — local-write cancel marker', () => {
  it('a durable operator write cancels the pending REPLACE for that topic (audited)', async () => {
    let reachable = false;
    const h = newCarrier({
      sendPull: async (_peer, topics) => {
        if (!reachable) return { kind: 'unreachable' as const };
        return { kind: 'ok' as const, entries: topics.map((t) => entryFor(t, profile())) };
      },
    });
    h.carrier.onTopicAcquired(1, 'machine-a');
    await h.carrier.flushStaged();

    // Operator pins locally while the previous owner is offline — the write
    // surface calls onLocalWriteDurable AFTER the mutate's flush landed.
    await h.store.mutate(1, { framework: 'gemini-cli', updatedBy: 'op:local' });
    h.carrier.onLocalWriteDurable(1, 'operator');
    expect(h.carrier.hasPendingPull(1)).toBe(false);
    expect(h.audits.some((a) => a.kind === 'pull-superseded-by-local-write' && a.origin === 'operator')).toBe(true);

    // The peer returns — nothing re-fires, the local pin stands.
    reachable = true;
    await h.carrier.onPeerOnline('machine-a');
    await h.carrier.tick();
    expect(h.store.resolve(1)?.framework).toBe('gemini-cli');
  });

  it('the cancel is as durable as the pull it cancels (restart between write and landing)', async () => {
    const h = newCarrier({ sendPull: async () => ({ kind: 'unreachable' as const }) });
    h.carrier.onTopicAcquired(1, 'machine-a');
    h.carrier.onTopicAcquired(2, 'machine-a');
    await h.carrier.flushStaged();

    await h.store.mutate(1, { framework: 'gemini-cli', updatedBy: 'op:local' });
    h.carrier.onLocalWriteDurable(1, 'operator');

    // "Restart" — re-issued pull must land with the amendment intact: topic 1
    // is gone from the record; topic 2 still pulls.
    const h2 = newCarrier(
      {
        sendPull: async (_peer, topics) => ({
          kind: 'ok' as const,
          entries: topics.map((t) => entryFor(t, profile())),
        }),
        now: () => new Date(Date.now() + 60_000),
      },
      h.store,
    );
    expect(h2.carrier.pending()[0]?.topics).toEqual(['2']);
    await h2.carrier.tick();
    expect(h2.store.resolve(1)?.framework).toBe('gemini-cli'); // local pin survived
    expect(h2.store.resolve(2)?.framework).toBe('codex-cli'); // sibling still pulled
  });

  it('token-trust HTTP writes cancel too (origin recorded)', async () => {
    const h = newCarrier({ sendPull: async () => ({ kind: 'unreachable' as const }) });
    h.carrier.onTopicAcquired(1, 'machine-a');
    await h.carrier.flushStaged();
    h.carrier.onLocalWriteDurable(1, 'http');
    expect(h.carrier.hasPendingPull(1)).toBe(false);
    expect(h.audits.some((a) => a.kind === 'pull-superseded-by-local-write' && a.origin === 'http')).toBe(true);
  });

  it('system-attributed writes NEVER cancel a pending pull', async () => {
    const h = newCarrier({ sendPull: async () => ({ kind: 'unreachable' as const }) });
    h.carrier.onTopicAcquired(1, 'machine-a');
    await h.carrier.flushStaged();
    h.carrier.onLocalWriteDurable(1, 'system');
    expect(h.carrier.hasPendingPull(1)).toBe(true);
  });

  it('a write landing while the pull is IN FLIGHT cancels that topic\'s REPLACE at landing time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = newCarrier({
      sendPull: async (_peer, topics) => {
        await gate; // the pull is in flight while the local write lands
        return { kind: 'ok' as const, entries: topics.map((t) => entryFor(t, profile())) };
      },
    });
    h.carrier.onTopicAcquired(1, 'machine-a');
    h.carrier.onTopicAcquired(2, 'machine-a');
    const flushing = h.carrier.flushStaged();

    await h.store.mutate(1, { framework: 'gemini-cli', updatedBy: 'op:local' });
    h.carrier.onLocalWriteDurable(1, 'operator');
    release();
    await flushing;

    expect(h.store.resolve(1)?.framework).toBe('gemini-cli'); // REPLACE cancelled
    expect(h.store.resolve(2)?.framework).toBe('codex-cli'); // sibling applied
    expect(h.audits.some((a) => a.kind === 'pull-landing-cancelled' && a.topic === '1')).toBe(true);
  });

  it('staged (not yet filed) acquires are cancelled too', async () => {
    const h = newCarrier();
    h.carrier.onTopicAcquired(1, 'machine-a');
    h.carrier.onLocalWriteDurable(1, 'operator');
    await h.carrier.flushStaged();
    expect(h.sent).toHaveLength(0);
  });
});

// ── supersede + backstop ─────────────────────────────────────────────────────

describe('TopicProfileTransferCarrier — supersede & updatedAt backstop', () => {
  it('a newly-pending pull supersedes any older pending pull for the topic (A→B→C→B)', async () => {
    const h = newCarrier({ sendPull: async () => ({ kind: 'unreachable' as const }) });
    h.carrier.onTopicAcquired(1, 'machine-b');
    await h.carrier.flushStaged();
    expect(h.carrier.pending()[0]?.peer).toBe('machine-b');

    h.carrier.onTopicAcquired(1, 'machine-c');
    await h.carrier.flushStaged();
    const pending = h.carrier.pending();
    expect(pending).toHaveLength(1); // the b-record emptied and was dropped
    expect(pending[0].peer).toBe('machine-c');
    expect(h.audits.some((a) => a.kind === 'pull-superseded-by-newer-pull')).toBe(true);
  });

  it('backstop: a local non-system entry NEWER than the arriving one wins (ties favor local)', async () => {
    const newer = '2026-06-10T00:00:00.000Z';
    const older = '2026-06-01T00:00:00.000Z';
    const h = newCarrier({
      sendPull: async (_peer, topics) => ({
        kind: 'ok' as const,
        entries: topics.map((t) => entryFor(t, profile({ updatedAt: older, framework: 'codex-cli' }))),
      }),
    });
    // Plant a local entry with a chosen updatedAt (verbatim via replaceEntry).
    await h.store.replaceEntry(1, {
      current: { framework: 'gemini-cli', updatedAt: newer, updatedBy: 'op:local' },
    });
    h.carrier.onTopicAcquired(1, 'machine-a');
    await h.carrier.flushStaged();

    expect(h.store.resolve(1)?.framework).toBe('gemini-cli'); // local won
    expect(h.audits.some((a) => a.kind === 'pull-superseded-by-local-write' && a.origin === 'updatedAt-backstop')).toBe(true);

    // Tie favors local.
    const h2 = newCarrier(
      {
        sendPull: async (_peer, topics) => ({
          kind: 'ok' as const,
          entries: topics.map((t) => entryFor(t, profile({ updatedAt: newer, framework: 'codex-cli' }))),
        }),
      },
      h.store,
    );
    h2.carrier.onTopicAcquired(1, 'machine-a');
    await h2.carrier.flushStaged();
    expect(h2.store.resolve(1)?.framework).toBe('gemini-cli');
  });

  it('backstop: a FUTURE-dated arriving entry is treated as older than the local entry (audited)', async () => {
    const future = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
    const h = newCarrier({
      sendPull: async (_peer, topics) => ({
        kind: 'ok' as const,
        entries: topics.map((t) => entryFor(t, profile({ updatedAt: future, framework: 'codex-cli' }))),
      }),
    });
    await h.store.mutate(1, { framework: 'gemini-cli', updatedBy: 'op:local' });
    h.carrier.onTopicAcquired(1, 'machine-a');
    await h.carrier.flushStaged();

    expect(h.store.resolve(1)?.framework).toBe('gemini-cli'); // forged future date lost
    expect(h.audits.some((a) => a.kind === 'pull-updatedat-clamped')).toBe(true);
  });

  it('backstop: a SYSTEM-attributed local write never supersedes the pull (§5.3 round-6)', async () => {
    const newer = new Date().toISOString();
    const h = newCarrier({
      sendPull: async (_peer, topics) => ({
        kind: 'ok' as const,
        entries: topics.map((t) => entryFor(t, profile({ updatedAt: '2026-06-01T00:00:00.000Z' }))),
      }),
    });
    await h.store.replaceEntry(1, {
      current: { framework: 'gemini-cli', updatedAt: newer, updatedBy: 'system:circuit-breaker' },
    });
    h.carrier.onTopicAcquired(1, 'machine-a');
    await h.carrier.flushStaged();
    expect(h.store.resolve(1)?.framework).toBe('codex-cli'); // pull landed
  });

  it('a stale local entry (topic last lived here long ago) is replaced when the pull lands', async () => {
    const h = newCarrier();
    await h.store.replaceEntry(1, {
      current: { framework: 'gemini-cli', updatedAt: '2025-01-01T00:00:00.000Z', updatedBy: 'op:local' },
    });
    h.carrier.onTopicAcquired(1, 'machine-a');
    await h.carrier.flushStaged();
    expect(h.store.resolve(1)?.framework).toBe('codex-cli');
    // Undo means "back to what THIS machine had" (§5.1 round-7).
    expect(h.store.previousFor(1)?.framework).toBe('gemini-cli');
  });
});
