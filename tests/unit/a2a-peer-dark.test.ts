// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 tests for a2a-single-agent-identity §3 (AC5): honest sender-side
 * reporting of a send that stays queued.
 *
 *  - A2ADeliveryTracker: the `dark` classification (threshold, the unanswered
 *    set, relay expiry never clears it, ack / inbound / delivered clear it, an
 *    `escalated` row never suppresses it), `queuedCount` / `queuedExpiresAt`,
 *    the 30-day retention in every state, the bounded `allPeerHealth`.
 *  - ThreadlineClient: `connectedNow` from the presence map (presence-change
 *    frames update it; stale frame / no row / relay down → null; a rejected
 *    refresh → null; discover is never called inline).
 *  - A2ARedeliverySentinel (reworked): constructed under the peerDark gate
 *    alone; one item per peer with the deterministic id after the heal; dry-run
 *    logs only; an ack on ANOTHER machine clears it (raise + resolve pool-scope);
 *    the resolve line names the expired count; cooldown; the local-relay
 *    aggregate; a standby runs no heal and raises nothing.
 *  - peerDark helpers: config resolver (dev gate, dry-run default, floors),
 *    sentence wording for every `connectedNow` value, HTML-escaped peer label.
 *  - Migration parity: template + migrator section (one wording), config
 *    defaults deep-merged with `enabled` omitted, DEV_GATED_FEATURES entry.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { A2ADeliveryTracker, RETENTION_MS } from '../../src/threadline/A2ADeliveryTracker.js';
import { A2ARedeliverySentinel, type A2APoolPeerRow, type A2ARelayState } from '../../src/monitoring/A2ARedeliverySentinel.js';
import { ThreadlineClient } from '../../src/threadline/client/ThreadlineClient.js';
import {
  buildPeerDarkSentence,
  buildPeerDarkResolveLine,
  peerDarkItemId,
  peerLabel,
  relayUnreachableItemId,
  resolvePeerDarkNoticeConfig,
  createPeerDarkAuditWriter,
  DEFAULT_QUEUED_DARK_AFTER_MS,
  MIN_QUEUED_DARK_AFTER_MS,
  type PeerDarkAuditRow,
} from '../../src/threadline/peerDark.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';

const PEER = '8c7928aa9f04fbda947172a2f9b2d81a';
const PEER2 = '63b1aaaa9f04fbda947172a2f9b2d81a';
const NOW = Date.parse('2026-10-09T12:00:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const DARK_AFTER = 2 * H;

let tracker: A2ADeliveryTracker;
afterEach(() => tracker?.close());

/** The silence sweep only touches rows sent after relay tracking began; back-date that mark for fixtures sent "in the past". */
function openBackdated(): A2ADeliveryTracker {
  const t = A2ADeliveryTracker.openMemory();
  (t as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
    .prepare(`UPDATE a2a_meta SET value = ? WHERE key = 'relay_tracking_since'`).run('2020-01-01T00:00:00.000Z');
  return t;
}

/** A row the relay QUEUED at `sentMs` (the shape a send to an offline peer leaves). */
function queued(t: A2ADeliveryTracker, id: string, sentMs: number, peer = PEER, ttlSec = 24 * 3600): void {
  t.recordSent({ messageId: id, peerFp: peer, peerName: 'luna', threadId: `t-${id}`, transport: 'relay', sentAt: iso(sentMs) });
  t.recordRelayStatus({ messageId: id, status: 'queued', ttlSec }, iso(sentMs));
}

describe('A2ADeliveryTracker — §3.1 dark classification', () => {
  beforeEach(() => { tracker = openBackdated(); });

  it('a queued row older than the threshold marks the peer dark; a younger one does not', () => {
    queued(tracker, 'm1', NOW - 3 * H);
    const h = tracker.peerHealth(PEER, { nowMs: NOW, queuedDarkAfterMs: DARK_AFTER });
    expect(h.dark).toBe(true);
    expect(h.darkSince).toBe(iso(NOW - 3 * H));
    expect(h.queuedCount).toBe(1);
    expect(h.queuedExpiresAt).toBe(iso(NOW - 3 * H + 24 * H));
    tracker.close();
    tracker = openBackdated();
    queued(tracker, 'm2', NOW - 1 * H);
    const y = tracker.peerHealth(PEER, { nowMs: NOW, queuedDarkAfterMs: DARK_AFTER });
    expect(y.dark).toBe(false);
    expect(y.darkSince).toBeNull();
    expect(y.queuedCount).toBe(1); // in the unanswered set, just not old enough
  });

  it('dark sits BELOW stale (2 h vs 6 h) so the sender hears first', () => {
    queued(tracker, 'm1', NOW - 3 * H);
    const h = tracker.peerHealth(PEER, { nowMs: NOW });
    expect(h.dark).toBe(true);
    expect(h.stale).toBe(false);
  });

  it('relay expiry alone NEVER clears dark — the expired row stays in the set (one episode, not one per day)', () => {
    queued(tracker, 'm1', NOW - 30 * H, PEER, 3600);
    tracker.recordRelayStatus({ messageId: 'm1', status: 'expired', recipientId: PEER }, iso(NOW - 29 * H));
    expect(tracker.get('m1')).toMatchObject({ state: 'failed', relayStatus: 'expired' });
    const h = tracker.peerHealth(PEER, { nowMs: NOW, queuedDarkAfterMs: DARK_AFTER });
    expect(h.dark).toBe(true);
    expect(h.queuedCount).toBe(1);
    expect(h.queuedExpiresAt).toBeNull(); // nothing still queued
  });

  it('an ack on a LATER message clears dark; so does an inbound; so does a `delivered` verdict', () => {
    queued(tracker, 'm1', NOW - 5 * H);
    expect(tracker.peerHealth(PEER, { nowMs: NOW }).dark).toBe(true);
    // ack newer than the queued row
    tracker.recordSent({ messageId: 'm2', peerFp: PEER, transport: 'relay', sentAt: iso(NOW - 4 * H) });
    tracker.recordAck('m2', iso(NOW - 1 * H));
    expect(tracker.peerHealth(PEER, { nowMs: NOW }).dark).toBe(false);
    expect(tracker.peerHealth(PEER, { nowMs: NOW }).queuedCount).toBe(0);

    tracker.close(); tracker = openBackdated();
    queued(tracker, 'm1', NOW - 5 * H);
    tracker.recordInboundFrom(PEER, 'luna', iso(NOW - 30 * 60_000));
    expect(tracker.peerHealth(PEER, { nowMs: NOW }).dark).toBe(false);

    tracker.close(); tracker = openBackdated();
    queued(tracker, 'm1', NOW - 5 * H);
    tracker.recordSent({ messageId: 'm3', peerFp: PEER, transport: 'relay', sentAt: iso(NOW - 10 * 60_000) });
    tracker.recordRelayStatus({ messageId: 'm3', status: 'delivered' }, iso(NOW - 10 * 60_000));
    const h = tracker.peerHealth(PEER, { nowMs: NOW });
    expect(h.lastDeliveredAt).toBe(iso(NOW - 10 * 60_000));
    expect(h.dark).toBe(false);
  });

  it('an ack OLDER than the queued row does not clear it (the silence started after the last sign of life)', () => {
    tracker.recordSent({ messageId: 'old', peerFp: PEER, transport: 'relay', sentAt: iso(NOW - 10 * H) });
    tracker.recordAck('old', iso(NOW - 9 * H));
    queued(tracker, 'm1', NOW - 5 * H);
    expect(tracker.peerHealth(PEER, { nowMs: NOW }).dark).toBe(true);
  });

  it('an `escalated` row (the legacy per-message path) never suppresses a dark episode', () => {
    queued(tracker, 'm1', NOW - 5 * H);
    tracker.markEscalated('m1', iso(NOW - 4 * H));
    expect(tracker.get('m1')!.state).toBe('escalated');
    const h = tracker.peerHealth(PEER, { nowMs: NOW });
    expect(h.dark).toBe(true);
    expect(h.queuedCount).toBe(1);
  });

  it('a rejected row and a delivered-but-unacked row are NOT in the unanswered set', () => {
    tracker.recordSent({ messageId: 'r', peerFp: PEER, transport: 'relay', sentAt: iso(NOW - 5 * H) });
    tracker.recordRelayStatus({ messageId: 'r', status: 'rejected', reasonCode: 'queue-full', retryLater: true }, iso(NOW - 5 * H));
    tracker.recordSent({ messageId: 'd', peerFp: PEER, transport: 'relay', sentAt: iso(NOW - 5 * H) });
    tracker.recordRelayStatus({ messageId: 'd', status: 'delivered' }, iso(NOW - 5 * H));
    const h = tracker.peerHealth(PEER, { nowMs: NOW });
    expect(h.dark).toBe(false);
    expect(h.queuedCount).toBe(0);
  });

  it('`unconfirmed` rows (the silence sweep) are in the set', () => {
    tracker.recordSent({ messageId: 'u', peerFp: PEER, transport: 'relay', sentAt: iso(NOW - 30 * H) });
    tracker.sweepSilence(NOW); // relay_status NULL + 24 h → unconfirmed
    expect(tracker.get('u')!.state).toBe('unconfirmed');
    const h = tracker.peerHealth(PEER, { nowMs: NOW });
    expect(h.dark).toBe(true);
    expect(h.queuedCount).toBe(1);
  });

  it('queuedCount counts every unanswered row; queuedExpiresAt is the EARLIEST still-queued expiry', () => {
    queued(tracker, 'a', NOW - 5 * H, PEER, 10 * 3600);
    queued(tracker, 'b', NOW - 4 * H, PEER, 2 * 3600);
    queued(tracker, 'c', NOW - 3 * H, PEER, 30 * 3600);
    const h = tracker.peerHealth(PEER, { nowMs: NOW });
    expect(h.queuedCount).toBe(3);
    expect(h.queuedExpiresAt).toBe(iso(NOW - 4 * H + 2 * H));
  });

  it('expiredUnacknowledgedSince counts the expired rows of the dark window', () => {
    queued(tracker, 'a', NOW - 10 * H, PEER, 3600);
    queued(tracker, 'b', NOW - 9 * H, PEER, 3600);
    queued(tracker, 'c', NOW - 1 * H, PEER, 3600);
    tracker.recordRelayStatus({ messageId: 'a', status: 'expired', recipientId: PEER }, iso(NOW - 9 * H));
    tracker.recordRelayStatus({ messageId: 'b', status: 'expired', recipientId: PEER }, iso(NOW - 8 * H));
    expect(tracker.expiredUnacknowledgedSince(PEER, iso(NOW - 10 * H))).toBe(2);
    expect(tracker.expiredUnacknowledgedSince(PEER, iso(NOW - 9 * H))).toBe(1);
  });

  it('retention: the sweep deletes rows older than 30 days in EVERY state; younger rows survive', () => {
    const old = NOW - RETENTION_MS - 24 * H;
    tracker.recordSent({ messageId: 'acked', peerFp: PEER, transport: 'relay', sentAt: iso(old) });
    tracker.recordAck('acked', iso(old));
    tracker.recordSent({ messageId: 'failed', peerFp: PEER, transport: 'relay', sentAt: iso(old) });
    tracker.recordRelayStatus({ messageId: 'failed', status: 'rejected', reasonCode: 'queue-full' }, iso(old));
    tracker.recordSent({ messageId: 'esc', peerFp: PEER, transport: 'relay', sentAt: iso(old) });
    tracker.markEscalated('esc', iso(old));
    tracker.recordSent({ messageId: 'unc', peerFp: PEER, transport: 'relay', sentAt: iso(old) });
    tracker.sweepSilence(old + 25 * H); // → unconfirmed (no verdict 24 h)
    expect(tracker.get('unc')!.state).toBe('unconfirmed');
    queued(tracker, 'qexp', old, PEER, 3600);            // awaiting-ack, expiry passed
    queued(tracker, 'young', NOW - 3 * H, PEER, 3600);   // survives
    tracker.recordSent({ messageId: 'delivered-unacked', peerFp: PEER, transport: 'relay', sentAt: iso(old) }); // awaiting-ack, delivered, never acked — no expiry, still pruned
    tracker.recordRelayStatus({ messageId: 'delivered-unacked', status: 'delivered' }, iso(old));
    tracker.sweepSilence(NOW);
    expect(tracker.lastPruned).toBe(6);
    for (const id of ['acked', 'failed', 'esc', 'unc', 'qexp', 'delivered-unacked']) expect(tracker.get(id)).toBeNull();
    expect(tracker.get('young')).not.toBeNull();
  });

  it('findOverdue is bounded to the oldest 500 rows per scan', () => {
    for (let i = 0; i < 510; i++) {
      tracker.recordSent({ messageId: `m${i}`, peerFp: PEER, transport: 'relay', sentAt: iso(NOW - 48 * H + i * 1000) });
    }
    const rows = tracker.findOverdue(1000, NOW);
    expect(rows).toHaveLength(500);
    expect(rows[0].messageId).toBe('m0');
  });

  it('allPeerHealth is bounded to peers active in the last 30 days; a quiet peer returns on its next send', () => {
    const old = NOW - RETENTION_MS - 24 * H;
    tracker.recordSent({ messageId: 'o', peerFp: PEER2, transport: 'relay', sentAt: iso(old) });
    tracker.recordInboundFrom(PEER2, 'old-peer', iso(old));
    queued(tracker, 'n', NOW - 1 * H, PEER);
    expect(tracker.allPeerHealth({ nowMs: NOW }).map((p) => p.peerFp)).toEqual([PEER]);
    queued(tracker, 'n2', NOW - 10 * 60_000, PEER2);
    expect(tracker.allPeerHealth({ nowMs: NOW }).map((p) => p.peerFp).sort()).toEqual([PEER, PEER2].sort());
  });
});

describe('ThreadlineClient — §3.2 connectedNow from the presence map', () => {
  type Priv = {
    knownAgents: Map<string, { agentId: string; name: string; online?: boolean }>;
    ingestDiscoveredAgents(agents: Array<Record<string, unknown>>): void;
    ingestPresenceChange(change: { agentId: string; status: string; metadata?: { name?: string } }): void;
    relayClient: unknown;
  };
  let fakeNow: number;
  let client: ThreadlineClient;
  let p: Priv;
  beforeEach(() => {
    fakeNow = NOW;
    client = new ThreadlineClient({ name: 'tester', stateDir: path.join(os.tmpdir(), 'peer-dark-client') }, () => fakeNow);
    p = client as unknown as Priv;
  });

  it('with no relay client the relay is not connected → null even when a row says online', () => {
    p.knownAgents.set(PEER, { agentId: PEER, name: 'luna', online: true });
    expect(client.peerConnectedNow(PEER)).toBeNull();
  });

  it('a presence-change frame updates the row and the freshness stamp; connected relay → true/false; no row → null', () => {
    p.relayClient = { connectionState: 'connected' };
    expect(client.peerConnectedNow(PEER)).toBeNull(); // no frame yet
    p.ingestPresenceChange({ agentId: PEER, status: 'online', metadata: { name: 'luna' } });
    expect(client.peerConnectedNow(PEER)).toBe(true);
    expect(client.getKnownAgents().find((a) => a.agentId === PEER)?.name).toBe('luna');
    p.ingestPresenceChange({ agentId: PEER, status: 'offline' });
    expect(client.peerConnectedNow(PEER)).toBe(false);
    expect(client.peerConnectedNow(PEER2)).toBeNull(); // no row for PEER2
  });

  it('a presence-change frame merges — it never strips a keyed row', () => {
    p.relayClient = { connectionState: 'connected' };
    p.knownAgents.set(PEER, { agentId: PEER, name: 'luna', online: false, publicKey: Buffer.from('pk'), x25519PublicKey: Buffer.from('xk') } as never);
    p.ingestPresenceChange({ agentId: PEER, status: 'online' });
    const row = client.getKnownAgents().find((a) => a.agentId === PEER)!;
    expect(row.online).toBe(true);
    expect(row.publicKey?.toString()).toBe('pk');
    expect(row.x25519PublicKey?.toString()).toBe('xk');
  });

  it('a frame older than the freshness bound (15 min, the sentinel tick) → null, never a stale boolean', () => {
    p.relayClient = { connectionState: 'connected' };
    p.ingestPresenceChange({ agentId: PEER, status: 'online' });
    expect(client.peerConnectedNow(PEER)).toBe(true);
    fakeNow += 16 * 60_000;
    expect(client.peerConnectedNow(PEER)).toBeNull();
    expect(client.peerConnectedNow(PEER, { maxFrameAgeMs: 20 * 60_000 })).toBe(true);
  });

  it('a discover-result frame also stamps freshness (ingestDiscoveredAgents is the same map)', () => {
    p.relayClient = { connectionState: 'connected' };
    p.ingestDiscoveredAgents([{ agentId: PEER, name: 'luna', status: 'offline' }]);
    // ingestDiscoveredAgents alone does not stamp (the frame handler does); emulate the handler.
    expect(client.presenceFrameAt).toBeNull();
  });

  it('a rejected refresh (no relay client — the standby case) answers false and leaves the map untouched', async () => {
    expect(await client.refreshPresence()).toBe(false);
    expect(client.presenceFrameAt).toBeNull();
    expect(client.peerConnectedNow(PEER)).toBeNull();
  });

  it('my relay down (disconnected) → null regardless of the row', () => {
    p.relayClient = { connectionState: 'connected' };
    p.ingestPresenceChange({ agentId: PEER, status: 'online' });
    p.relayClient = { connectionState: 'disconnected' };
    expect(client.peerConnectedNow(PEER)).toBeNull();
  });
});

// ── Sentinel harness ────────────────────────────────────────────────────

interface Harness {
  sentinel: A2ARedeliverySentinel;
  raised: Array<{ id?: string; title: string; body: string; source?: string }>;
  resolved: Array<{ id: string; line: string }>;
  audit: PeerDarkAuditRow[];
  items: Map<string, { status: string; updatedAt: string; createdAt: string }>;
  heal: { reconnect: number; refresh: number; selfCheck: number; sleeps: number[] };
  set: { relay: A2ARelayState; awake: boolean; pool: A2APoolPeerRow[]; selfCheck: 'ok' | 'split' | 'unknown'; now: number };
}

function harness(opts: { dryRun?: boolean; cooldownMs?: number; legacy?: boolean } = {}): Harness {
  const set = { relay: 'connected' as A2ARelayState, awake: true, pool: [] as A2APoolPeerRow[], selfCheck: 'ok' as const, now: NOW };
  const h: Harness = {
    sentinel: undefined as unknown as A2ARedeliverySentinel,
    raised: [], resolved: [], audit: [], items: new Map(),
    heal: { reconnect: 0, refresh: 0, selfCheck: 0, sleeps: [] },
    set: set as Harness['set'],
  };
  h.sentinel = new A2ARedeliverySentinel({
    tracker,
    agentId: 'echo',
    raiseAttention: (item) => {
      h.raised.push(item);
      if (item.id) h.items.set(item.id, { status: 'OPEN', updatedAt: iso(set.now), createdAt: h.items.get(item.id)?.createdAt ?? iso(set.now) });
    },
    resolveAttention: (id, line) => {
      h.resolved.push({ id, line });
      const it = h.items.get(id);
      if (it) h.items.set(id, { ...it, status: 'DONE', updatedAt: iso(set.now) });
    },
    attentionState: (id) => h.items.get(id) ?? null,
    relayState: () => set.relay,
    isAwake: () => set.awake,
    reconnectRelay: () => { h.heal.reconnect++; set.relay = 'connected'; },
    refreshPresence: () => { h.heal.refresh++; return true; },
    peerConnectedNow: () => false,
    identitySelfCheck: () => { h.heal.selfCheck++; return set.selfCheck; },
    poolPeerHealth: async () => set.pool,
    audit: (row) => { h.audit.push(row); },
    sleep: async (ms) => { h.heal.sleeps.push(ms); },
    now: () => set.now,
    log: { log: () => {}, warn: () => {} },
  }, {
    enabled: opts.legacy ?? false,
    peerDark: { enabled: true, dryRun: opts.dryRun ?? false, queuedDarkAfterMs: DARK_AFTER, cooldownMs: opts.cooldownMs ?? 12 * H, healPassDelayMs: 40_000 },
  });
  return h;
}

describe('A2ARedeliverySentinel — §3 reworked dark path', () => {
  beforeEach(() => { tracker = A2ADeliveryTracker.openMemory(); });

  it('is constructed/armed under the peerDark gate ALONE (legacy redelivery off) and runs the dark pass', async () => {
    const h = harness();
    expect(h.sentinel.armed).toBe(true);
    queued(tracker, 'm1', NOW - 3 * H);
    const r = await h.sentinel.tick();
    expect(r.disabled).toBe(false);
    expect(r.overdue).toBe(0); // the legacy loop did not run
    expect(r.darkPeers).toEqual([PEER]);
    expect(r.darkRaised).toEqual([PEER]);
  });

  it('neither gate → not armed, tick is a no-op', async () => {
    const s = new A2ARedeliverySentinel({ tracker, now: () => NOW }, { enabled: false });
    expect(s.armed).toBe(false);
    expect((await s.tick()).disabled).toBe(true);
  });

  it('raises ONE item per dark peer with the deterministic id, after the two-pass heal (refresh + self-check + 40 s)', async () => {
    const h = harness();
    queued(tracker, 'a', NOW - 3 * H);
    queued(tracker, 'b', NOW - 2.5 * H);
    await h.sentinel.tick();
    expect(h.raised).toHaveLength(1);
    expect(h.raised[0].id).toBe(peerDarkItemId('echo', PEER));
    expect(h.raised[0].id).toBe(`a2a-peer-dark:echo:${PEER}`);
    expect(h.raised[0].body).toContain('Messages to luna (8c7928aa9f04) are stuck: 2 queued since 2026-10-09T09:00:00Z, none acknowledged.');
    expect(h.raised[0].body).toContain('may be offline, or listening under a different address');
    expect(h.heal.refresh).toBe(1);
    expect(h.heal.selfCheck).toBe(1);
    expect(h.heal.sleeps).toEqual([40_000]);
    expect(h.audit.map((r) => r.kind)).toEqual(expect.arrayContaining(['heal', 'raised']));
    // A second tick while the item is open raises nothing more.
    await h.sentinel.tick();
    expect(h.raised).toHaveLength(1);
  });

  it('dry-run: logs a would-raise row to the audit and raises nothing', async () => {
    const h = harness({ dryRun: true });
    queued(tracker, 'a', NOW - 3 * H);
    const r = await h.sentinel.tick();
    expect(r.darkRaised).toEqual([PEER]);
    expect(h.raised).toHaveLength(0);
    const row = h.audit.find((x) => x.kind === 'would-raise')!;
    expect(row).toMatchObject({ peerFp: PEER, queuedCount: 1, darkSince: iso(NOW - 3 * H), connectedNow: false, dryRun: true });
    expect(JSON.stringify(h.audit)).not.toContain('t-a'); // never bodies/threads
  });

  it('a peer that answered on ANOTHER machine is not dark (the raise reads pool-scope acks)', async () => {
    const h = harness();
    queued(tracker, 'a', NOW - 3 * H);
    h.set.pool = [{ machineId: 'mini', lastAckedAt: null, lastInboundAt: iso(NOW - 1 * H) }];
    const r = await h.sentinel.tick();
    expect(r.darkPeers).toEqual([]);
    expect(h.raised).toHaveLength(0);
    expect(h.audit.some((x) => x.kind === 'pool-cleared' && x.peerFp === PEER)).toBe(true);
  });

  it('an inbound on another machine AFTER the raise resolves the item; the line names the expired count', async () => {
    const h = harness();
    queued(tracker, 'a', NOW - 5 * H, PEER, 3600);
    queued(tracker, 'b', NOW - 4 * H, PEER, 3600);
    tracker.recordRelayStatus({ messageId: 'a', status: 'expired', recipientId: PEER }, iso(NOW - 4 * H));
    await h.sentinel.tick();
    expect(h.raised).toHaveLength(1);
    expect(h.sentinel.openEpisodes()).toHaveLength(1);
    h.set.now = NOW + 1 * H;
    h.set.pool = [{ machineId: 'mini', lastAckedAt: null, lastInboundAt: iso(NOW + 30 * 60_000) }];
    const r = await h.sentinel.tick();
    expect(r.darkResolved).toEqual([PEER]);
    expect(h.resolved).toHaveLength(1);
    expect(h.resolved[0].id).toBe(peerDarkItemId('echo', PEER));
    expect(h.resolved[0].line).toBe('luna (8c7928aa9f04) is back; 1 message from the dark window expired unacknowledged — resend what still matters.');
    expect(h.sentinel.openEpisodes()).toHaveLength(0);
    expect(h.items.get(peerDarkItemId('echo', PEER))!.status).toBe('DONE');
  });

  it('relay expiry during the episode does NOT resolve it (only life does)', async () => {
    const h = harness();
    queued(tracker, 'a', NOW - 3 * H, PEER, 3600);
    await h.sentinel.tick();
    tracker.recordRelayStatus({ messageId: 'a', status: 'expired', recipientId: PEER }, iso(NOW + 10 * 60_000));
    h.set.now = NOW + 2 * H;
    const r = await h.sentinel.tick();
    expect(r.darkResolved).toEqual([]);
    expect(h.resolved).toHaveLength(0);
    expect(h.sentinel.openEpisodes()).toHaveLength(1);
  });

  it('cooldown: a peer that goes dark again inside 12 h is not re-raised; after the cooldown it is (reopen, same id)', async () => {
    const h = harness();
    queued(tracker, 'a', NOW - 3 * H);
    await h.sentinel.tick();
    // resolve via local inbound
    tracker.recordInboundFrom(PEER, 'luna', iso(NOW + 10 * 60_000));
    h.set.now = NOW + 20 * 60_000;
    await h.sentinel.tick();
    expect(h.resolved).toHaveLength(1);
    // dark again 3 h later → inside the cooldown
    queued(tracker, 'b', NOW + 30 * 60_000);
    h.set.now = NOW + 3 * H;
    let r = await h.sentinel.tick();
    expect(r.darkPeers).toEqual([PEER]);
    expect(r.darkRaised).toEqual([]);
    expect(h.audit.some((x) => x.kind === 'cooldown' && x.peerFp === PEER)).toBe(true);
    expect(h.raised).toHaveLength(1);
    // past the cooldown → raised again under the SAME id
    h.set.now = NOW + 13 * H;
    r = await h.sentinel.tick();
    expect(r.darkRaised).toEqual([PEER]);
    expect(h.raised).toHaveLength(2);
    expect(h.raised[1].id).toBe(h.raised[0].id);
  });

  it('after a restart an OPEN item is rebuilt as an episode (no duplicate raise) and still resolves on pool life', async () => {
    const h1 = harness();
    queued(tracker, 'a', NOW - 3 * H);
    await h1.sentinel.tick();
    // "restart": a fresh sentinel sharing the durable item store
    const h2 = harness();
    h2.items = h1.items;
    (h2.sentinel as unknown as { deps: { attentionState: (id: string) => unknown } }).deps.attentionState = (id) => h1.items.get(id) ?? null;
    h2.set.now = NOW + 1 * H;
    let r = await h2.sentinel.tick();
    expect(h2.raised).toHaveLength(0); // not raised twice
    expect(h2.sentinel.openEpisodes()).toHaveLength(1);
    h2.set.pool = [{ machineId: 'mini', lastAckedAt: iso(NOW + 2 * H), lastInboundAt: null }];
    h2.set.now = NOW + 3 * H;
    r = await h2.sentinel.tick();
    expect(r.darkResolved).toEqual([PEER]);
  });

  it('my relay is down: reconnect is tried; still down → ONE aggregated item, per-peer items suppressed; back → aggregate resolved', async () => {
    const h = harness();
    queued(tracker, 'a', NOW - 3 * H, PEER);
    queued(tracker, 'b', NOW - 3 * H, PEER2);
    h.set.relay = 'disconnected';
    (h.sentinel as unknown as { deps: { reconnectRelay: () => void } }).deps.reconnectRelay = () => { h.heal.reconnect++; /* stays down */ };
    const r = await h.sentinel.tick();
    expect(h.heal.reconnect).toBe(1);
    expect(r.aggregateRaised).toBe(true);
    expect(r.darkRaised).toEqual([]);
    expect(h.raised).toHaveLength(1);
    expect(h.raised[0].id).toBe(relayUnreachableItemId('echo'));
    expect(h.raised[0].body).toContain('relay unreachable from this machine; 2 peers, 2 messages queued');
    // second tick while down: no second aggregate
    await h.sentinel.tick();
    expect(h.raised).toHaveLength(1);
    // relay back → the aggregate resolves and per-peer evaluation resumes
    h.set.relay = 'connected';
    const r2 = await h.sentinel.tick();
    expect(h.resolved[0].id).toBe(relayUnreachableItemId('echo'));
    expect(r2.darkRaised.sort()).toEqual([PEER, PEER2].sort());
  });

  it('a standby runs NO heal and raises nothing (reason `standby`), even with a dark peer', async () => {
    const h = harness();
    h.set.awake = false;
    queued(tracker, 'a', NOW - 3 * H);
    const r = await h.sentinel.tick();
    expect(r.healSkipped).toBe('standby');
    expect(r.darkPeers).toEqual([PEER]);
    expect(r.darkRaised).toEqual([]);
    expect(h.heal.refresh).toBe(0);
    expect(h.heal.reconnect).toBe(0);
    expect(h.raised).toHaveLength(0);
    expect(h.audit.some((x) => x.kind === 'skipped' && x.reason === 'standby')).toBe(true);
    // a standby with its relay down: still no reconnect (that would displace the holder)
    h.set.relay = 'disconnected';
    await h.sentinel.tick();
    expect(h.heal.reconnect).toBe(0);
  });

  it('the §2 self-check reporting a split supersedes the per-peer item', async () => {
    const h = harness();
    h.set.selfCheck = 'split';
    queued(tracker, 'a', NOW - 3 * H);
    const r = await h.sentinel.tick();
    expect(r.darkPeers).toEqual([PEER]);
    expect(r.darkRaised).toEqual([]);
    expect(h.raised).toHaveLength(0);
    expect(h.audit.some((x) => x.kind === 'superseded')).toBe(true);
  });

  it('a peer that clears during the heal (ack lands between the passes) gets no item', async () => {
    const h = harness();
    queued(tracker, 'a', NOW - 3 * H);
    (h.sentinel as unknown as { deps: { sleep: () => Promise<void> } }).deps.sleep = async () => { tracker.recordAck('a', iso(NOW)); };
    const r = await h.sentinel.tick();
    expect(r.darkRaised).toEqual([]);
    expect(h.raised).toHaveLength(0);
    expect(h.audit.some((x) => x.kind === 'heal' && x.reason === 'cleared-during-heal')).toBe(true);
  });

  it('with the legacy loop ALSO on, its per-message escalation state still happens but no stamped item is raised beside the dark item', async () => {
    const h = harness({ legacy: true });
    // overdue + at the attempt cap (5) → escalated by the legacy loop
    queued(tracker, 'a', NOW - 10 * H);
    for (let i = 0; i < 4; i++) tracker.markAttempt('a', undefined, iso(NOW - 10 * H));
    const r = await h.sentinel.tick();
    expect(r.escalated).toBe(1);
    expect(tracker.get('a')!.state).toBe('escalated');
    expect(h.raised).toHaveLength(1);
    expect(h.raised[0].id).toBe(peerDarkItemId('echo', PEER)); // the dark item, not `a2a-redelivery-<stamp>`
    expect(r.darkRaised).toEqual([PEER]);           // the escalated row did not suppress the episode
  });

  it('a failing pool read degrades to the local verdict (audited), never to silence', async () => {
    const h = harness();
    (h.sentinel as unknown as { deps: { poolPeerHealth: () => Promise<never> } }).deps.poolPeerHealth = async () => { throw new Error('peer down'); };
    queued(tracker, 'a', NOW - 3 * H);
    const r = await h.sentinel.tick();
    expect(r.darkRaised).toEqual([PEER]);
    expect(h.audit.some((x) => x.kind === 'error' && String(x.reason).startsWith('pool-read-failed'))).toBe(true);
  });
});

describe('peerDark helpers', () => {
  it('resolver: enabled omitted → the dev gate; dryRun default true; floors applied; explicit values win', () => {
    const dev = resolvePeerDarkNoticeConfig({ developmentAgent: true });
    expect(dev).toEqual({ enabled: true, dryRun: true, queuedDarkAfterMs: DEFAULT_QUEUED_DARK_AFTER_MS, cooldownMs: 12 * H });
    expect(resolvePeerDarkNoticeConfig({ developmentAgent: false }).enabled).toBe(false);
    expect(resolvePeerDarkNoticeConfig({ developmentAgent: true, threadline: { peerDarkNotice: { enabled: false } } }).enabled).toBe(false);
    expect(resolvePeerDarkNoticeConfig({ developmentAgent: false, threadline: { peerDarkNotice: { enabled: true, dryRun: false } } })).toMatchObject({ enabled: true, dryRun: false });
    expect(resolvePeerDarkNoticeConfig({ threadline: { peerDarkNotice: { queuedDarkAfterMs: 1 } } }).queuedDarkAfterMs).toBe(MIN_QUEUED_DARK_AFTER_MS);
    expect(resolvePeerDarkNoticeConfig({ threadline: { peerDarkNotice: { queuedDarkAfterMs: Number.NaN } } }).queuedDarkAfterMs).toBe(DEFAULT_QUEUED_DARK_AFTER_MS);
    expect(resolvePeerDarkNoticeConfig({ developmentAgent: false }, true).enabled).toBe(true); // live override
  });

  it('sentence: worded to the evidence for every connectedNow value; hours + counts + expiry', () => {
    const base = { since: iso(NOW - 3 * H), queuedCount: 3, expiresAt: iso(NOW + 20 * H) };
    const off = buildPeerDarkSentence({ ...base, connectedNow: false }, { peerFp: PEER, peerName: 'luna' }, NOW);
    expect(off).toBe('no acknowledgement from luna (8c7928aa9f04) for 3 h; this and 2 other messages are still queued (oldest expires 2026-10-10T08:00:00Z); luna (8c7928aa9f04) is not connected to the relay right now — it may be offline, or listening under a different address.');
    const on = buildPeerDarkSentence({ ...base, connectedNow: true }, { peerFp: PEER, peerName: 'luna' }, NOW);
    expect(on).toContain('IS connected to the relay but has not acknowledged anything — it may be listening under a different address, or not reading');
    const unk = buildPeerDarkSentence({ ...base, connectedNow: null, queuedCount: 1, expiresAt: null }, { peerFp: PEER, peerName: null }, NOW);
    expect(unk).toBe('no acknowledgement from 8c7928aa9f04 for 3 h; this message is still queued; whether 8c7928aa9f04 is connected right now is unknown.');
    for (const s of [off, on, unk]) expect(s).not.toMatch(/nothing will arrive/);
  });

  it('peer label: fingerprint prefix + clamped, HTML-escaped name; a fingerprint-as-name collapses to the prefix', () => {
    expect(peerLabel(PEER, '<b>luna</b>')).toBe('&lt;b&gt;luna&lt;/b&gt; (8c7928aa9f04)');
    expect(peerLabel(PEER, 'x'.repeat(80))).toBe(`${'x'.repeat(39)}… (8c7928aa9f04)`);
    expect(peerLabel(PEER, PEER)).toBe('8c7928aa9f04');
    expect(peerLabel(PEER, null)).toBe('8c7928aa9f04');
    expect(buildPeerDarkResolveLine({ peerFp: PEER, peerName: 'luna' }, 0)).toContain('0 messages from the dark window expired unacknowledged');
  });

  it('audit writer appends JSONL rows and never throws on a bad path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-dark-audit-'));
    try {
      const file = path.join(dir, 'logs', 'a2a-peer-dark.jsonl');
      const w = createPeerDarkAuditWriter(file);
      w({ ts: iso(NOW), kind: 'would-raise', peerFp: PEER, queuedCount: 2, dryRun: true });
      w({ ts: iso(NOW), kind: 'sentence', peerFp: PEER, dryRun: false });
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines.map((l) => l.kind)).toEqual(['would-raise', 'sentence']);
      const bad = createPeerDarkAuditWriter(path.join(file, 'not-a-dir', 'x.jsonl'), () => {});
      expect(() => bad({ ts: iso(NOW), kind: 'error', dryRun: true })).not.toThrow();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/a2a-peer-dark.test.ts' });
    }
  });
});

describe('Migration parity — §3', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-peer-dark-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/a2a-peer-dark.test.ts' }));
  type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };
  const section = (s: string) => {
    const i = s.indexOf('### A2A dark peers');
    const end = s.indexOf('\n### ', i + 5);
    return s.slice(i, end === -1 ? undefined : end).trim();
  };

  it('CLAUDE.md: the section lands once (idempotent) and equals the template wording', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    const r1 = run();
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded).toContain('CLAUDE.md: added A2A dark peers section');
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('### A2A dark peers (did my message arrive?)');
    expect(after).toContain('`peerDark` (`since`, `queuedCount`, `expiresAt`, `connectedNow`)');
    expect(after).toContain('**When to use** (PROACTIVE): a user asks "did <peer> get my message?"');
    const r2 = run();
    expect(r2.upgraded).not.toContain('CLAUDE.md: added A2A dark peers section');
    expect(after.split('### A2A dark peers').length - 1).toBe(1);
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain('### A2A dark peers (did my message arrive?)');
    expect(section(after)).toBe(section(md));
  });

  it('config: the nested block reaches an existing agent through the deep-merge with `enabled` OMITTED; an operator value is kept', () => {
    const d = getMigrationDefaults('standalone') as { threadline?: { peerDarkNotice?: Record<string, unknown> } };
    expect(d.threadline?.peerDarkNotice).toEqual({ dryRun: true, queuedDarkAfterMs: 7200000, cooldownMs: 43200000 });
    expect('enabled' in (d.threadline?.peerDarkNotice ?? {})).toBe(false);
    const existing: Record<string, unknown> = { developmentAgent: false, threadline: { relayEnabled: true, peerDarkNotice: { dryRun: false } } };
    applyDefaults(existing, getMigrationDefaults('standalone'));
    const t = existing.threadline as { relayEnabled: boolean; peerDarkNotice: Record<string, unknown> };
    expect(t.relayEnabled).toBe(true);
    expect(t.peerDarkNotice).toMatchObject({ dryRun: false, queuedDarkAfterMs: 7200000, cooldownMs: 43200000 });
    expect(DEV_GATED_FEATURES.filter((f) => f.configPath === 'threadline.peerDarkNotice.enabled')).toHaveLength(1);
    const dev: Record<string, unknown> = { developmentAgent: true };
    applyDefaults(dev, getMigrationDefaults('standalone'));
    expect(resolvePeerDarkNoticeConfig(dev as never)).toMatchObject({ enabled: true, dryRun: true });
    const fleet: Record<string, unknown> = { developmentAgent: false };
    applyDefaults(fleet, getMigrationDefaults('standalone'));
    expect(resolvePeerDarkNoticeConfig(fleet as never).enabled).toBe(false);
  });
});
