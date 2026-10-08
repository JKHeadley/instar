/**
 * Unit tests — A2A inbound message-id ledger (docs/specs/a2a-inbound-id-ledger.md).
 *
 * Tier 1: the ledger in isolation with a real better-sqlite3 database. Covers the
 * transition table and outcome allowlist (as data AND as behaviour), the commit
 * point, attempt ownership, the namespace rules, the unverified caps, the relay-
 * socket wait, the DB-error fail direction, retention, live flips, the gate
 * integration, the shared relay-chain-loop predicate, the notice, the peer
 * annotator, the backup exclusion and the boot ordering.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  InboundIdLedger,
  InboundIdLedgerController,
  OUTCOME_ALLOWLIST,
  HANDOFF_PATHS,
  ROUTER_HANDOFF_PATHS,
  TRANSITION_TABLE,
  INBOUND_DISPOSITIONS,
  classifyExistingRow,
  outcomeFromRouterResult,
  isTerminalRow,
  isValidMessageId,
  buildResentNotice,
  RESENT_COPY_NOTICE,
  PEER_HANDOFF_NOTICE,
  resolveInboundIdLedgerEnabled,
  clampRetentionDays,
  UNVERIFIED_PER_SENDER_CAP,
  WAIT_PER_SENDER_CAP,
  COOLDOWN_START_MS,
  resolveInboundIdLedgerPath,
} from '../../src/threadline/InboundIdLedger.js';
import {
  admitRelayInbound,
  createPeerHandoffAnnotator,
  projectInboundRow,
  recordDuplicateAck,
} from '../../src/threadline/inboundIdLedgerWiring.js';
import { A2ADeliveryTracker } from '../../src/threadline/A2ADeliveryTracker.js';
import { InboundMessageGate } from '../../src/threadline/InboundMessageGate.js';
import { isRelayChainLoop } from '../../src/messaging/MessageRouter.js';
import { withServerNotice } from '../../src/threadline/ThreadlineRouter.js';
import { sqliteRegistrySize } from '../../src/core/SqliteRegistry.js';
import { BackupManager } from '../../src/core/BackupManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const FP = 'a'.repeat(32);
const FP2 = 'b'.repeat(32);

function admitted(l: InboundIdLedger, senderKey: string, id: string, extra: Partial<Parameters<InboundIdLedger['admit']>[0]> = {}) {
  const r = l.admit({ senderKey, messageId: id, ingress: 'relay', threadId: 'thread-abc', ...extra });
  if (r.kind !== 'admitted') throw new Error(`expected admitted, got ${r.kind}`);
  return r;
}

describe('normative data', () => {
  it('lists five dispositions and eight hand-off paths, none durable today', () => {
    expect([...INBOUND_DISPOSITIONS].sort()).toEqual(['admitted', 'handed-off', 'handoff-failed', 'no-reply', 'refused']);
    expect([...HANDOFF_PATHS].sort()).toEqual(['approval', 'cold', 'listener', 'live', 'pipe', 'store', 'topic', 'warm']);
    for (const p of HANDOFF_PATHS) expect(OUTCOME_ALLOWLIST[p].durable).toBe(false);
    expect([...ROUTER_HANDOFF_PATHS].sort()).toEqual(['approval', 'cold', 'live', 'topic', 'warm']);
  });

  it('only no-reply (and a durable hand-off) is terminal', () => {
    for (const d of INBOUND_DISPOSITIONS) {
      for (const p of [null, ...HANDOFF_PATHS]) {
        const terminal = isTerminalRow({ disposition: d, path: p });
        expect(terminal).toBe(d === 'no-reply');
      }
    }
  });

  it('the transition table is the closed set the classifier implements', () => {
    const epoch = 'live';
    const re = TRANSITION_TABLE.filter((t) => t.to === 'admitted' && t.from !== 'none').map((t) => t.from).sort();
    expect(re).toEqual(['admitted', 'handed-off', 'handoff-failed', 'refused']);
    // Every disposition × epoch × in-flight × namespace combination maps to the table.
    for (const d of INBOUND_DISPOSITIONS) {
      for (const liveEpoch of [true, false]) {
        for (const inFlight of [true, false]) {
          for (const localNamespace of [true, false]) {
            const cls = classifyExistingRow(
              { disposition: d, path: d === 'handed-off' ? 'live' : null, process_epoch: liveEpoch ? epoch : 'dead' },
              { liveEpoch: epoch, inFlight, localNamespace },
            );
            if (d === 'admitted' && liveEpoch && inFlight) expect(cls).toBe('in-flight');
            else if (localNamespace) expect(cls).toBe('local-readmit');
            else if (d === 'no-reply') expect(cls).toBe('terminal');
            else if (d === 'handed-off') expect(cls).toBe('weak-readmit');
            else {
              expect(cls).toBe('readmit');
              expect(re).toContain(d);
            }
          }
        }
      }
    }
  });
});

describe('outcome allowlist applied to router results', () => {
  it('maps every router path to handed-off', () => {
    for (const p of ROUTER_HANDOFF_PATHS) {
      expect(outcomeFromRouterResult({ handled: true, path: p })).toEqual({ kind: 'handed-off', path: p });
    }
  });
  it('maps an autonomy block to refused', () => {
    expect(outcomeFromRouterResult({ handled: false, gateDecision: 'block' })).toEqual({ kind: 'refused', code: 'autonomy-block' });
  });
  it('maps everything else to handoff-failed', () => {
    const others: unknown[] = [
      null, undefined, 'x', {},
      { handled: true, accepted: true, queued: true, injected: false, resumed: false }, // failure-visible
      { handled: true, accepted: true, queued: true, resumed: true }, // resume-pending
      { handled: false, accepted: true, queued: true, error: 'Spawn denied' }, // SpawnRequestManager denial
      { handled: false, accepted: false },
      { handled: true, spawned: true }, // a shape with no path
      { handled: true, path: 'pipe' }, // pipe/listener are recorded by the consumer, never the router
      { handled: true, path: 'bogus' },
    ];
    for (const r of others) expect(outcomeFromRouterResult(r)).toEqual({ kind: 'handoff-failed' });
  });
});

describe('InboundIdLedger — commit point and attempts', () => {
  let l: InboundIdLedger;
  beforeEach(() => { l = InboundIdLedger.openMemory(); });
  afterEach(() => l.close());

  it('admits a new id and answers a second arrival as in-flight', () => {
    admitted(l, FP, 'm1');
    const r2 = l.admit({ senderKey: FP, messageId: 'm1', ingress: 'relay' });
    expect(r2.kind).toBe('in-flight');
  });

  it('a no-reply row is terminal; a duplicate is answered from it', () => {
    const r = admitted(l, FP, 'm1');
    r.ticket.recordNoReply();
    r.ticket.finish();
    const d = l.admit({ senderKey: FP, messageId: 'm1', ingress: 'relay' });
    expect(d.kind).toBe('duplicate');
    if (d.kind === 'duplicate') expect(d.row.disposition).toBe('no-reply');
    expect(l.lookup(FP, 'm1')).toBe('terminal');
  });

  it('every non-durable hand-off re-admits with readmissions>0 and counts weakPathRedelivered', () => {
    for (const p of HANDOFF_PATHS) {
      const id = `m-${p}`;
      const r = admitted(l, FP, id);
      r.ticket.recordHandoff(p);
      r.ticket.finish();
      expect(l.lookup(FP, id)).toBe('retryable');
      const again = admitted(l, FP, id);
      expect(again.readmitted).toBe(true);
      expect(again.ticket.readmissions).toBe(1);
      again.ticket.finish();
    }
    expect(l.counters().weakPathRedelivered).toBe(HANDOFF_PATHS.length);
  });

  it('a synchronous exit with no outcome records handoff-failed and clears the in-flight entry', () => {
    const r = admitted(l, FP, 'm1');
    expect(l.isInFlight(FP, 'm1')).toBe(true);
    r.ticket.finish();
    expect(l.isInFlight(FP, 'm1')).toBe(false);
    expect(l.getRow(FP, 'm1')!.disposition).toBe('handoff-failed');
    expect(l.counters().handoffFailed).toBe(1);
  });

  it('re-admits handoff-failed, refused, dead-epoch admitted and live not-in-flight admitted — no cap', () => {
    const a = admitted(l, FP, 'hf'); a.ticket.finish();
    const b = admitted(l, FP, 'rf'); b.ticket.recordRefused('autonomy-block'); b.ticket.finish();
    expect(l.getRow(FP, 'rf')!.disposition).toBe('refused');
    for (let i = 0; i < 25; i++) {
      const x = admitted(l, FP, 'hf');
      x.ticket.finish();
    }
    expect(l.getRow(FP, 'hf')!.readmissions).toBe(25);
    const c = l.admit({ senderKey: FP, messageId: 'rf', ingress: 'relay' });
    expect(c.kind).toBe('admitted'); // a refusal is never a duplicate
  });

  it('a refused row is re-evaluated, never answered as a duplicate', () => {
    const r = admitted(l, FP, 'm1');
    r.ticket.recordRefused('autonomy-block');
    r.ticket.finish();
    expect(l.lookup(FP, 'm1')).toBe('retryable');
  });

  it('writes are conditional on the attempt: a superseded attempt changes nothing and is counted', () => {
    const first = admitted(l, FP, 'm1');
    const forced = l.admit({ senderKey: FP, messageId: 'm1', ingress: 'relay', force: true });
    expect(forced.kind).toBe('admitted');
    first.ticket.recordHandoff('live');
    first.ticket.finish(); // must not clear the forced attempt's entry
    expect(l.counters().staleAttemptWrite).toBe(1);
    expect(l.getRow(FP, 'm1')!.disposition).toBe('admitted');
    expect(l.isInFlight(FP, 'm1')).toBe(true);
    if (forced.kind === 'admitted') forced.ticket.finish();
    expect(l.isInFlight(FP, 'm1')).toBe(false);
  });

  it('records the outcome once (first recorded wins)', () => {
    const r = admitted(l, FP, 'm1');
    r.ticket.recordHandoff('pipe');
    r.ticket.recordHandoff('listener');
    r.ticket.finish();
    expect(l.getRow(FP, 'm1')!.path).toBe('pipe');
  });

  it('an unkeyed or out-of-bounds id is admitted with no row and counted', () => {
    for (const id of [null, undefined, '', 'x'.repeat(129), 'bad\nid']) {
      const r = l.admit({ senderKey: FP, messageId: id as string | null, ingress: 'relay' });
      expect(r.kind).toBe('unrecorded');
    }
    expect(l.counters().unkeyedInbound).toBe(5);
    expect(isValidMessageId('a'.repeat(128))).toBe(true);
  });

  it('a content.messageId-only message is keyed through the shared extractor', () => {
    const id = InboundMessageGate.extractMessageId({ from: FP, content: { messageId: 'inner-1' } } as never);
    expect(id).toBe('inner-1');
  });
});

describe('namespaces (Know Your Principal)', () => {
  let l: InboundIdLedger;
  beforeEach(() => { l = InboundIdLedger.openMemory(); });
  afterEach(() => l.close());

  it('relay original then same-id local retry dedups bare (registry key consults the verified row)', () => {
    const r = admitted(l, FP, 'm1');
    r.ticket.recordNoReply(); r.ticket.finish();
    const local = l.admit({ senderKey: `registry:${FP}`, messageId: 'm1', ingress: 'relay-agent', verifiedKeyToConsult: FP });
    expect(local.kind).toBe('duplicate');
    if (local.kind === 'duplicate') expect(local.bare).toBe(true);
  });

  it('an asserted fingerprint never gets the verified answer', () => {
    const r = admitted(l, FP, 'm1');
    r.ticket.recordNoReply(); r.ticket.finish();
    const local = l.admit({ senderKey: `asserted:${FP}`, messageId: 'm1', ingress: 'relay-agent', verifiedKeyToConsult: FP });
    expect(local.kind).toBe('admitted');
  });

  it('a non-terminal verified row is ignored by the local route, which never touches it', () => {
    const r = admitted(l, FP, 'm1');
    r.ticket.recordHandoff('live'); r.ticket.finish();
    const local = l.admit({ senderKey: `registry:${FP}`, messageId: 'm1', ingress: 'relay-agent', verifiedKeyToConsult: FP });
    expect(local.kind).toBe('admitted');
    if (local.kind === 'admitted') local.ticket.finish();
    expect(l.getRow(FP, 'm1')!.readmissions).toBe(0);
    expect(l.getRow(FP, 'm1')!.disposition).toBe('handed-off');
  });

  it('local then relay delivers twice (verified paths ignore local rows)', () => {
    const local = l.admit({ senderKey: `registry:${FP}`, messageId: 'm1', ingress: 'relay-agent', verifiedKeyToConsult: FP });
    if (local.kind === 'admitted') { local.ticket.recordNoReply(); local.ticket.finish(); }
    const relay = l.admit({ senderKey: FP, messageId: 'm1', ingress: 'relay' });
    expect(relay.kind).toBe('admitted');
  });

  it('a same-id local repeat over ANY local row (even terminal) is delivered again, counted localRedelivered', () => {
    for (const key of [`registry:${FP}`, `asserted:${FP}`, 'local:relay-agent:codey']) {
      const a = l.admit({ senderKey: key, messageId: 'm1', ingress: 'relay-agent' });
      if (a.kind === 'admitted') { a.ticket.recordNoReply(); a.ticket.finish(); }
      const b = l.admit({ senderKey: key, messageId: 'm1', ingress: 'relay-agent' });
      expect(b.kind).toBe('admitted');
      if (b.kind === 'admitted') b.ticket.finish();
    }
    expect(l.counters().localRedelivered).toBe(3);
  });

  it('a token holder pre-registering a peer id on the local route cannot suppress the relay message', () => {
    const pre = l.admit({ senderKey: `registry:${FP}`, messageId: 'victim', ingress: 'relay-agent' });
    if (pre.kind === 'admitted') { pre.ticket.recordNoReply(); pre.ticket.finish(); }
    expect(l.lookup(FP, 'victim')).toBe('retryable');
    expect(l.admit({ senderKey: FP, messageId: 'victim', ingress: 'relay' }).kind).toBe('admitted');
  });

  it('an in-flight local row answers in-flight (the 409 case)', () => {
    l.admit({ senderKey: 'local:relay-agent:codey', messageId: 'm1', ingress: 'relay-agent' });
    expect(l.admit({ senderKey: 'local:relay-agent:codey', messageId: 'm1', ingress: 'relay-agent' }).kind).toBe('in-flight');
  });
});

describe('unverified namespace', () => {
  let l: InboundIdLedger;
  let logDir: string;
  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-ledger-logs-'));
    l = InboundIdLedger.openMemory({ logDir });
  });
  afterEach(() => {
    l.close();
    SafeFsExecutor.safeRmSync(logDir, { recursive: true, force: true, operation: 'tests/unit/a2a-inbound-id-ledger.test.ts' });
  });

  it('a post-commit refusal removes the row and traces it with a fixed code', () => {
    const key = `unverified:${FP}`;
    const r = admitted(l, key, 'm1', { ingress: 'relay-unknown-sender' });
    r.ticket.recordRefused('autonomy-block');
    r.ticket.finish();
    expect(l.getRow(key, 'm1')).toBeNull();
    const lines = fs.readFileSync(path.join(logDir, 'a2a-inbound-refusals.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]);
    expect(row.reason).toBe('autonomy-block');
    expect(JSON.parse(row.sender_key)).toBe(key);
    expect(JSON.parse(row.message_id)).toBe('m1');
    expect(Object.keys(row).sort()).toEqual(['at', 'message_id', 'reason', 'sender_key']);
    expect(l.counters().unverifiedRefusedLogged).toBe(1);
  });

  it('rotates the refusal log by size and keeps two files', () => {
    const p = path.join(logDir, 'a2a-inbound-refusals.jsonl');
    fs.writeFileSync(p, 'x'.repeat(5 * 1024 * 1024));
    const key = `unverified:${FP}`;
    const r = admitted(l, key, 'm1', { ingress: 'relay-unknown-sender' });
    r.ticket.recordRefused('autonomy-block'); r.ticket.finish();
    expect(fs.existsSync(`${p}.1`)).toBe(true);
    expect(fs.readFileSync(p, 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('age-prunes the refusal log files at retentionDays', () => {
    const p = path.join(logDir, 'a2a-inbound-refusals.jsonl');
    fs.writeFileSync(p, '{}\n');
    fs.writeFileSync(`${p}.1`, '{}\n');
    const old = new Date(Date.now() - 20 * 24 * 60 * 60_000);
    fs.utimesSync(`${p}.1`, old, old);
    l.pruneOnce();
    expect(fs.existsSync(`${p}.1`)).toBe(false);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('caps 50 per sender with eviction order handoff-failed → admitted not in flight → oldest terminal', () => {
    const key = `unverified:${FP}`;
    const tickets = [];
    for (let i = 0; i < UNVERIFIED_PER_SENDER_CAP; i++) {
      tickets.push(admitted(l, key, `m${i}`, { ingress: 'relay-unknown-sender' }).ticket);
    }
    tickets[10].recordNoReply(); tickets[10].finish();
    tickets[20].finish(); // handoff-failed
    const next = admitted(l, key, 'new-1', { ingress: 'relay-unknown-sender' });
    expect(l.getRow(key, 'm20')).toBeNull(); // handoff-failed went first
    expect(l.getRow(key, 'm10')).not.toBeNull();
    next.ticket.recordNoReply(); next.ticket.finish();
    const next2 = admitted(l, key, 'new-2', { ingress: 'relay-unknown-sender' });
    expect(l.getRow(key, 'm10')).toBeNull(); // oldest terminal (no admitted-not-in-flight rows left)
    next2.ticket.finish();
    expect(l.counters().unverifiedEvicted).toBe(2);
  });

  it('delivers with no row when every row is in flight', () => {
    const key = `unverified:${FP}`;
    for (let i = 0; i < UNVERIFIED_PER_SENDER_CAP; i++) admitted(l, key, `m${i}`, { ingress: 'relay-unknown-sender' });
    const r = l.admit({ senderKey: key, messageId: 'over', ingress: 'relay-unknown-sender' });
    expect(r.kind).toBe('unrecorded');
    if (r.kind === 'unrecorded') expect(r.reason).toBe('unverified-full');
    expect(l.counters().unverifiedUnrecorded).toBe(1);
  });
});

describe('relay-socket in-flight wait (admitRelayInbound)', () => {
  let l: InboundIdLedger;
  beforeEach(() => { l = InboundIdLedger.openMemory(); });
  afterEach(() => l.close());

  it('a duplicate waits for the original; a non-durable hand-off re-admits with the notice', async () => {
    const first = await admitRelayInbound(l, { senderKey: FP, messageId: 'm1', ingress: 'relay' }, () => {});
    expect(first.action).toBe('deliver');
    const secondP = admitRelayInbound(l, { senderKey: FP, messageId: 'm1', ingress: 'relay' }, () => {});
    // A third while one waits is dropped (the waiter covers the loss case).
    const third = await admitRelayInbound(l, { senderKey: FP, messageId: 'm1', ingress: 'relay' }, () => {});
    expect(third).toEqual({ action: 'drop', reason: 'wait-dropped' });
    if (first.action === 'deliver') { first.ticket.recordHandoff('live'); first.ticket.finish(); }
    const second = await secondP;
    expect(second.action).toBe('deliver');
    if (second.action === 'deliver') {
      expect(second.notice).toBe(RESENT_COPY_NOTICE);
      second.ticket.finish();
    }
    expect(l.counters().waitDropped).toBe(1);
  });

  it('a settle to no-reply drops the waiting duplicate and runs the duplicate handler', async () => {
    const first = await admitRelayInbound(l, { senderKey: FP, messageId: 'm1', ingress: 'relay' }, () => {});
    const dup = vi.fn();
    const secondP = admitRelayInbound(l, { senderKey: FP, messageId: 'm1', ingress: 'relay' }, dup);
    if (first.action === 'deliver') { first.ticket.recordNoReply(); first.ticket.finish(); }
    expect(await secondP).toEqual({ action: 'drop', reason: 'duplicate' });
    expect(dup).toHaveBeenCalledTimes(1);
    expect(l.counters().dedupById).toBe(1);
  });

  it('a refused original re-runs admission for the waiter (re-admitted, never a duplicate)', async () => {
    const first = await admitRelayInbound(l, { senderKey: FP, messageId: 'm1', ingress: 'relay' }, () => {});
    const secondP = admitRelayInbound(l, { senderKey: FP, messageId: 'm1', ingress: 'relay' }, () => {});
    if (first.action === 'deliver') { first.ticket.recordRefused('autonomy-block'); first.ticket.finish(); }
    const second = await secondP;
    expect(second.action).toBe('deliver');
  });

  it('the 30 s bound re-admits under a new attempt; the original\'s late write is stale', async () => {
    vi.useFakeTimers();
    try {
      const first = await admitRelayInbound(l, { senderKey: FP, messageId: 'm1', ingress: 'relay' }, () => {});
      const secondP = admitRelayInbound(l, { senderKey: FP, messageId: 'm1', ingress: 'relay' }, () => {});
      await vi.advanceTimersByTimeAsync(30_001);
      const second = await secondP;
      expect(second.action).toBe('deliver');
      if (first.action === 'deliver') { first.ticket.recordHandoff('cold'); first.ticket.finish(); }
      expect(l.counters().staleAttemptWrite).toBe(1);
      expect(l.isInFlight(FP, 'm1')).toBe(true); // still owned by the second attempt
      if (second.action === 'deliver') second.ticket.finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it('above 8 waiters per sender the duplicate is re-admitted at once (waitCeilingReadmit)', async () => {
    const pending: Array<Promise<unknown>> = [];
    for (let i = 0; i < WAIT_PER_SENDER_CAP + 1; i++) {
      await admitRelayInbound(l, { senderKey: FP, messageId: `m${i}`, ingress: 'relay' }, () => {});
    }
    for (let i = 0; i < WAIT_PER_SENDER_CAP; i++) {
      pending.push(admitRelayInbound(l, { senderKey: FP, messageId: `m${i}`, ingress: 'relay' }, () => {}));
    }
    const over = await admitRelayInbound(l, { senderKey: FP, messageId: `m${WAIT_PER_SENDER_CAP}`, ingress: 'relay' }, () => {});
    expect(over.action).toBe('deliver');
    expect(l.counters().waitCeilingReadmit).toBe(1);
    expect(l.counters().waiters).toBe(WAIT_PER_SENDER_CAP);
    // Release: the in-flight entries are now owned by fresh attempts; finish via force-admits.
    for (let i = 0; i < WAIT_PER_SENDER_CAP; i++) {
      const r = l.admit({ senderKey: FP, messageId: `m${i}`, ingress: 'relay', force: true });
      if (r.kind === 'admitted') r.ticket.finish();
    }
    void pending;
  });

  it('a waiting duplicate never blocks a different message (no head-of-line blocking)', async () => {
    await admitRelayInbound(l, { senderKey: FP, messageId: 'slow', ingress: 'relay' }, () => {});
    void admitRelayInbound(l, { senderKey: FP, messageId: 'slow', ingress: 'relay' }, () => {});
    const other = await admitRelayInbound(l, { senderKey: FP, messageId: 'other', ingress: 'relay' }, () => {});
    expect(other.action).toBe('deliver');
  });

  it('a marked resend with no local row on a verified key asks for peer annotation', async () => {
    const r = await admitRelayInbound(l, { senderKey: FP, messageId: 'r1', ingress: 'relay', resend: true }, () => {});
    expect(r.action === 'deliver' && r.needsPeerAnnotation).toBe(true);
    const u = await admitRelayInbound(l, { senderKey: `unverified:${FP}`, messageId: 'r2', ingress: 'relay-unknown-sender', resend: true }, () => {});
    expect(u.action === 'deliver' && u.needsPeerAnnotation).toBe(false);
  });

  it('with the ledger dark it delivers (fail-open)', async () => {
    const r = await admitRelayInbound(null, { senderKey: FP, messageId: 'm1', ingress: 'relay' }, () => {});
    expect(r.action).toBe('deliver');
  });
});

describe('DB error fail direction', () => {
  it('first failure → error (HTTP 503 once); then cooldown fail-open; probe backs off; breaker after 10', () => {
    let now = 1_000_000;
    const degradations: unknown[] = [];
    const l = InboundIdLedger.openMemory({ now: () => now, reportDegradation: (d) => degradations.push(d) });
    l._testBreakDb();
    expect(l.admit({ senderKey: FP, messageId: 'm1', ingress: 'threadline-http' }).kind).toBe('error');
    expect(l.isOperational()).toBe(false);
    const during = l.admit({ senderKey: FP, messageId: 'm2', ingress: 'threadline-http' });
    expect(during.kind).toBe('unrecorded'); // every ingress fails open during the cooldown
    expect(l.lookup(FP, 'm2')).toBe('unavailable');
    let wait = COOLDOWN_START_MS;
    for (let i = 0; i < 10; i++) {
      now += wait + 1;
      const probe = l.admit({ senderKey: FP, messageId: `p${i}`, ingress: 'relay' });
      expect(probe.kind).toBe('unrecorded'); // a failed probe never answers 503
      wait = Math.min(wait * 2, 30 * 60_000);
    }
    expect(l.counters().breaker).toBe(true);
    expect(degradations).toHaveLength(1);
    expect(l.counters().ledgerError).toBe(11);
    l.close();
  });

  it('a failed outcome write is counted in memory (postAcceptWriteFailed)', () => {
    const l = InboundIdLedger.openMemory();
    const r = admitted(l, FP, 'm1');
    l._testBreakDb();
    r.ticket.recordHandoff('live');
    expect(l.counters().postAcceptWriteFailed).toBe(1);
    l.close();
  });
});

describe('retention prune', () => {
  it('prunes by admitted_at in batches until a short batch, at most 20 per tick', () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const l = InboundIdLedger.openMemory({ now: () => now, retentionDays: 14 });
    for (let i = 0; i < 10_600; i++) {
      const r = l.admit({ senderKey: FP, messageId: `m${i}`, ingress: 'relay' });
      if (r.kind === 'admitted') r.ticket.recordNoReply();
    }
    now += 15 * 24 * 60 * 60_000;
    expect(l.pruneOnce()).toBe(10_000);
    expect(l.pruneOnce()).toBe(600);
    expect(l.lookup(FP, 'm1')).toBe('retryable'); // after the prune an id is unknown again
    l.close();
  });

  it('backs off on a throwing tick and breaks after 10', () => {
    const degradations: unknown[] = [];
    const l = InboundIdLedger.openMemory({ reportDegradation: (d) => degradations.push(d) });
    l._testBreakDb();
    for (let i = 0; i < 10; i++) expect(l.runPruneTick()).toBe(-1);
    expect(l.pruneState.broken).toBe(true);
    expect(l.pruneState.backoffMs).toBe(24 * 60 * 60_000);
    expect(degradations).toHaveLength(1);
    l.close();
  });

  it('retention has a floor of 2 days and defaults to 14', () => {
    expect(clampRetentionDays(undefined)).toBe(14);
    expect(clampRetentionDays(1)).toBe(2);
    expect(clampRetentionDays(30)).toBe(30);
  });
});

describe('file, handle registration, controller and config', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-ledger-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/a2a-inbound-id-ledger.test.ts' }));

  it('opens its own file with WAL + 1 s busy_timeout and registers/unregisters the handle', () => {
    const before = sqliteRegistrySize();
    const l = InboundIdLedger.open('echo', stateDir, { startTimers: false });
    expect(l.path).toBe(resolveInboundIdLedgerPath(stateDir, 'echo'));
    expect(path.basename(l.path)).toBe('a2a-inbound-ids.echo.sqlite');
    expect(sqliteRegistrySize()).toBe(before + 1);
    l.close();
    expect(sqliteRegistrySize()).toBe(before);
  });

  it('counts rows left admitted by a dead process at open and persists counters', () => {
    const a = InboundIdLedger.open('echo', stateDir, { startTimers: false });
    a.admit({ senderKey: FP, messageId: 'orphan', ingress: 'threadline-http' });
    a.bump('dedupById', 3);
    a.close();
    const b = InboundIdLedger.open('echo', stateDir, { startTimers: false });
    expect(b.deadEpochAdmittedAtBoot).toBe(1);
    expect(b.counters().dedupById).toBe(3);
    // A dead-epoch admitted row is re-admitted (never in flight in the new process).
    expect(b.admit({ senderKey: FP, messageId: 'orphan', ingress: 'threadline-http' }).kind).toBe('admitted');
    b.close();
  });

  it('live flips open lazily and close cleanly; an unopenable file leaves it dark with one degradation', () => {
    let enabled = false;
    const degradations: unknown[] = [];
    let openCalls = 0;
    const c = new InboundIdLedgerController({
      isEnabled: () => enabled,
      open: () => { openCalls++; return InboundIdLedger.openMemory(); },
      reportDegradation: (d) => degradations.push(d),
    });
    expect(c.current()).toBeNull();
    enabled = true;
    const l = c.current();
    expect(l).not.toBeNull();
    expect(c.current()).toBe(l);
    enabled = false;
    expect(c.current()).toBeNull();
    expect(l!.isOpen).toBe(false);
    expect(openCalls).toBe(1);

    const broken = new InboundIdLedgerController({
      isEnabled: () => true,
      open: () => { throw new Error('disk full'); },
      reportDegradation: (d) => degradations.push(d),
    });
    expect(broken.current()).toBeNull();
    expect(broken.current()).toBeNull();
    expect(degradations).toHaveLength(1);
  });

  it('enabled omitted ⇒ the development-agent gate', () => {
    expect(resolveInboundIdLedgerEnabled(undefined, true)).toBe(true);
    expect(resolveInboundIdLedgerEnabled(undefined, false)).toBe(false);
    expect(resolveInboundIdLedgerEnabled({ enabled: false }, true)).toBe(false);
    expect(resolveInboundIdLedgerEnabled({ enabled: true }, false)).toBe(true);
  });

  it('a backup snapshot never copies the ledger file', () => {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'a2a-inbound-ids.echo.sqlite'), 'db');
    fs.writeFileSync(path.join(stateDir, 'state', 'keep.json'), '{}');
    const bm = new BackupManager(stateDir, { includeFiles: ['state/'] });
    const snap = bm.createSnapshot('manual');
    expect(snap.files.some((f) => f.includes('a2a-inbound-ids.'))).toBe(false);
  });
});

describe('gate integration (setLedgerLookup)', () => {
  function makeGate(allowed: string[] = ['message'], trust: 'verified' | 'trusted' = 'verified') {
    const trustManager = {
      getTrustLevelByFingerprint: () => trust,
      getAllowedOperationsByFingerprint: () => allowed,
      recordMessageReceivedByFingerprint: () => {},
      isCredentialShareAllowedByFingerprint: () => false,
    };
    return new InboundMessageGate(trustManager as never, null);
  }
  const msg = (id: string) => ({ from: FP, messageId: id, content: { content: 'hi', type: 'message' }, threadId: 't', timestamp: '' }) as never;

  it('drops a terminal-row replay BEFORE the rate limiter counts it', async () => {
    const gate = makeGate();
    const onDup = vi.fn();
    gate.setLedgerLookup((_fp, id) => (id.startsWith('old') ? 'terminal' : 'retryable'), onDup);
    // verified: 10 messages/hour. A burst of 20 replays must not rate-limit the next new message.
    for (let i = 0; i < 20; i++) {
      const d = await gate.evaluate(msg(`old-${i}`));
      expect(d.reason).toBe('duplicate_id');
    }
    expect(onDup).toHaveBeenCalledTimes(20);
    expect((await gate.evaluate(msg('new-1'))).action).toBe('pass');
    gate.shutdown();
  });

  it('a revoked sender is refused (insufficient_trust), never answered as a duplicate', async () => {
    const gate = makeGate([]);
    gate.setLedgerLookup(() => 'terminal');
    expect((await gate.evaluate(msg('old-1'))).reason).toBe('insufficient_trust');
    gate.shutdown();
  });

  it('retryable rows skip the seenMessageIds check; unavailable falls back to it', async () => {
    const gate = makeGate();
    let verdict: 'retryable' | 'unavailable' = 'retryable';
    gate.setLedgerLookup(() => verdict);
    expect((await gate.evaluate(msg('same'))).action).toBe('pass');
    expect((await gate.evaluate(msg('same'))).action).toBe('pass'); // retry of a failed dispatch passes
    verdict = 'unavailable';
    expect((await gate.evaluate(msg('same'))).reason).toBe('replay_detected');
    gate.shutdown();
  });

  it('dark (no lookup) keeps today\'s replay behaviour', async () => {
    const gate = makeGate();
    expect((await gate.evaluate(msg('x'))).action).toBe('pass');
    expect((await gate.evaluate(msg('x'))).reason).toBe('replay_detected');
    gate.shutdown();
  });
});

describe('shared helpers', () => {
  it('isRelayChainLoop is the one predicate', () => {
    expect(isRelayChainLoop({ transport: { relayChain: ['m1', 'local'] } } as never, 'm1')).toBe(true);
    expect(isRelayChainLoop({ transport: { relayChain: ['m2'] } } as never, 'm1')).toBe(false);
    expect(isRelayChainLoop({ transport: {} } as never, 'm1')).toBe(false);
  });

  it('the notice is a server constant placed before (outside) the untrusted framing', () => {
    const framed = 'HEADER\n\npeer text\n\nFOOTER';
    const out = withServerNotice(framed, buildResentNotice(false));
    expect(out.startsWith(`[server notice: ${RESENT_COPY_NOTICE}]`)).toBe(true);
    expect(out.indexOf('HEADER')).toBeGreaterThan(out.indexOf(RESENT_COPY_NOTICE));
    expect(buildResentNotice(true)).toContain(PEER_HANDOFF_NOTICE);
    expect(withServerNotice(framed, null)).toBe(framed);
  });

  it('read-route projection marks local and unverified ingress as unverified senders', () => {
    const base = { sender_key: FP, message_id: 'm', admitted_at: 'x', attempt: 'a', process_epoch: 'e', thread_id: 't', disposition: 'admitted' as const, path: null, readmissions: 0 };
    expect(projectInboundRow({ ...base, ingress: 'relay' }).senderVerified).toBe(true);
    expect(projectInboundRow({ ...base, ingress: 'threadline-http' }).senderVerified).toBe(true);
    expect(projectInboundRow({ ...base, ingress: 'relay-agent' }).senderVerified).toBe(false);
    expect(projectInboundRow({ ...base, ingress: 'relay-unknown-sender' }).senderVerified).toBe(false);
  });

  it('the duplicate ack uses the admitted row\'s thread, bounded by admitted_at, with no liveness bump', () => {
    const t = A2ADeliveryTracker.openMemory();
    t.recordSent({ messageId: 'early', peerFp: FP, peerName: null, threadId: 'thread-1', subject: null, transport: 'relay', sentAt: '2026-01-01T00:00:00.000Z' } as never);
    t.recordSent({ messageId: 'late', peerFp: FP, peerName: null, threadId: 'thread-1', subject: null, transport: 'relay', sentAt: '2026-01-03T00:00:00.000Z' } as never);
    // The late message is the only one pending once early is acked; a duplicate admitted on 01-02 must not ack it.
    t.recordAck('early');
    recordDuplicateAck(t, { thread_id: 'thread-1', admitted_at: '2026-01-02T00:00:00.000Z' } as never);
    expect(t.peerHealth(FP).pendingCount).toBe(1);
    expect(t.peerHealth(FP).lastInboundAt).toBeNull();
    t.close();
  });
});

describe('annotatePeerHandoff (annotate only)', () => {
  const okRes = (rows: unknown[]) => ({ ok: true, status: 200, json: async () => ({ rows }) }) as unknown as Response;

  it('only verified keys; a peer handed-off answer only returns true', async () => {
    const fetchImpl = vi.fn(async () => okRes([{ disposition: 'handed-off' }]));
    const annotate = createPeerHandoffAnnotator({
      peers: () => [{ machineId: 'p1', url: 'https://p1.example' }],
      isUrlAllowed: () => true, authToken: 't', agentId: 'echo', fetchImpl: fetchImpl as never,
    });
    expect(await annotate(FP, 'm1')).toBe(true);
    for (const k of [`unverified:${FP}`, `registry:${FP}`, `asserted:${FP}`, 'local:relay-agent:x']) {
      expect(await annotate(k, 'm1')).toBe(false);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/a2a/inbound-ids?sender=');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
  });

  it('asks at most 8 peers, skips disallowed URLs, treats a 404 as unknown, and breaks after 3 failures', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('p404')) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      throw new Error('down');
    });
    const peers = Array.from({ length: 12 }, (_, i) => ({ machineId: `p${i}`, url: `https://p${i}.example`, routerReceivedAt: i }));
    peers.push({ machineId: 'p404', url: 'https://p404.example', routerReceivedAt: 999 });
    const unavailable: string[] = [];
    const annotate = createPeerHandoffAnnotator({
      peers: () => peers,
      isUrlAllowed: (u) => !u.includes('p11'),
      authToken: 't', agentId: 'echo', fetchImpl: fetchImpl as never,
      counters: { annotated: () => {}, unavailable: (r) => unavailable.push(r) },
    });
    expect(await annotate(FP, 'm1')).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(8);
    expect(calls.some((c) => c.includes('p11'))).toBe(false);
    expect(unavailable).toContain('no-answer');
    calls.length = 0;
    await annotate(FP, 'm2');
    await annotate(FP, 'm3');
    calls.length = 0;
    await annotate(FP, 'm4'); // failing peers are now behind their breaker
    expect(calls.every((c) => c.includes('p404'))).toBe(true);
  });
});

describe('boot ordering (source ordinal)', () => {
  it('the ledger is opened at the inbound-queue sweep site, before recoverPendingInjects', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'server.ts'), 'utf-8');
    const open = src.indexOf('_inboundIdLedger = buildInboundIdLedgerController(');
    const sweep = src.indexOf('// ── Durable Inbound Message Queue: unconditional boot sweep');
    const recover = src.indexOf('void sessionManager.recoverPendingInjects()');
    expect(open).toBeGreaterThan(0);
    expect(open).toBeLessThan(sweep);
    expect(open).toBeLessThan(recover);
  });
});
