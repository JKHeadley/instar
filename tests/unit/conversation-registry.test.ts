/**
 * ConversationRegistry — durable conversation identity (spec
 * durable-conversation-identity §3, §10 Tier-1: mint idempotency, golden
 * parity, probe/displacement, the WAL crash-durability contract, torn-tail +
 * non-tail-corruption + unknown-op replay rules, rotation with a single global
 * seq, the mint-rate breaker, the recording kill-switch, workspace pinning,
 * and the adoption pass).
 *
 * "CAOTEST11" and "CB00TEST11"-style pairs below exploit the 31-multiplier
 * structure of the frozen sum-shift hash: for chars (c1,c2) vs (c1+1,c2-31)
 * with an equal surrounding context the hashes are EQUAL — a real, in-charset
 * collision pair (both match ^[CDG][A-Z0-9]+$), used to exercise the probe
 * path deterministically.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { candidateIdForRoutingKey } from '../../src/core/conversationIdentity.js';
import { slackRoutingKeySyntheticId } from '../../src/core/slackRefreshBinding.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/** Two distinct channel ids whose frozen-hash candidates COLLIDE (see header). */
const COLLIDE_A = 'CAOTEST11';
const COLLIDE_B = 'CB0TEST11';

describe('ConversationRegistry', () => {
  let dir: string;
  let attention: Array<{ key: string; title: string }>;

  const makeRegistry = (over?: Partial<ConstructorParameters<typeof ConversationRegistry>[0]>) =>
    new ConversationRegistry({
      stateDir: dir,
      machineId: () => 'm-test',
      onAttention: (key, title) => attention.push({ key, title }),
      ...over,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-registry-'));
    attention = [];
  });
  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/conversation-registry.test.ts' });
    } catch {
      /* cleanup */
    }
  });

  it('sanity: the crafted collision pair really collides at one candidate', () => {
    expect(candidateIdForRoutingKey(COLLIDE_A)).toBe(candidateIdForRoutingKey(COLLIDE_B));
  });

  describe('mint idempotency + golden parity (§3.3)', () => {
    it('same tuple → same id, and the id IS the legacy hash id (zero-loss adoption)', () => {
      const reg = makeRegistry();
      const first = reg.mintForInbound('C0BA4F4E0FP');
      const second = reg.mintForInbound('C0BA4F4E0FP');
      expect(first.id).toBe(slackRoutingKeySyntheticId('C0BA4F4E0FP'));
      expect(first.created).toBe(true);
      expect(second.id).toBe(first.id);
      expect(second.created).toBe(false);
    });

    it('thread-level keys mint their own conversation (thread-aware candidate)', () => {
      const reg = makeRegistry();
      const channel = reg.mintForInbound('C0BA4F4E0FP');
      const thread = reg.mintForInbound('C0BA4F4E0FP:1751412345.123456');
      expect(thread.id).toBe(slackRoutingKeySyntheticId('C0BA4F4E0FP:1751412345.123456'));
      expect(thread.id).not.toBe(channel.id);
    });

    it('idempotent across process restarts (re-open after snapshot flush)', async () => {
      const reg = makeRegistry();
      const id = reg.mintForInbound('C0BA4F4E0FP').id;
      await reg.close(); // flushes the snapshot
      const reopened = makeRegistry();
      const again = reopened.mintForInbound('C0BA4F4E0FP');
      expect(again.id).toBe(id);
      expect(again.created).toBe(false);
      await reopened.close();
    });

    it('malformed routing key → typed "no durable id" degradation, never a throw (§3.6)', () => {
      const reg = makeRegistry();
      expect(reg.mintForInbound('not a channel!')).toEqual({
        id: null,
        created: false,
        registered: false,
        degraded: 'unparseable-key',
      });
    });
  });

  describe('probe / displacement (§3.3 — R2-adversarial-2)', () => {
    it('two tuples colliding at one candidate receive DISTINCT ids in either mint order (no reverse-index overwrite)', () => {
      for (const order of [[COLLIDE_A, COLLIDE_B], [COLLIDE_B, COLLIDE_A]]) {
        const subDir = fs.mkdtempSync(path.join(dir, 'order-'));
        const reg = new ConversationRegistry({ stateDir: subDir, machineId: () => 'm-test' });
        const first = reg.mintForInbound(order[0]);
        const second = reg.mintForInbound(order[1]);
        expect(first.id).not.toBeNull();
        expect(second.id).not.toBeNull();
        expect(first.id).not.toBe(second.id);
        // First-minted keeps the canonical candidate; the collider probes DOWN by 1.
        expect(first.id).toBe(candidateIdForRoutingKey(order[0]));
        expect(second.id).toBe(candidateIdForRoutingKey(order[1])! - 1);
        // Both resolve to their OWN tuples — no silent shared state (§1 defect 2).
        const r1 = reg.resolve(first.id!);
        const r2 = reg.resolve(second.id!);
        expect(r1?.platform === 'slack' && r1.channelId).toBe(order[0]);
        expect(r2?.platform === 'slack' && r2.channelId).toBe(order[1]);
      }
    });

    it('a probed mint is journaled (origin minted-probed) and survives a crash WITHOUT a snapshot flush (§3.3 WAL rule)', () => {
      const reg = makeRegistry();
      reg.mintForInbound(COLLIDE_A);
      const probed = reg.mintForInbound(COLLIDE_B);
      // NO close()/flush — simulate a hard crash in the assign→snapshot window.
      const reopened = makeRegistry();
      const resolved = reopened.resolve(probed.id!);
      expect(resolved?.platform === 'slack' && resolved.channelId).toBe(COLLIDE_B);
      expect(resolved?.platform === 'slack' && resolved.origin).toBe('minted-probed');
    });

    it('a pure speculative non-probed mint performs NO synchronous journal write (rides the snapshot only)', () => {
      const reg = makeRegistry();
      reg.mintForInbound('C0BA4F4E0FP');
      const journal = path.join(dir, 'conversation-registry.jsonl');
      expect(fs.existsSync(journal)).toBe(false);
    });
  });

  describe('durable-binding mints (§3.3 WAL rule + breaker carve-out)', () => {
    it('fsyncs a journal line BEFORE returning and survives a crash without a snapshot', () => {
      const reg = makeRegistry();
      const res = reg.mintForDurableBinding('C0BA4F4E0FP:1751412345.123456');
      expect(res.ok).toBe(true);
      const journal = fs.readFileSync(path.join(dir, 'conversation-registry.jsonl'), 'utf-8');
      expect(journal).toContain('"op":"mint"');
      expect(journal).toContain('1751412345.123456');
      // Crash before any snapshot: the thread-level id must still resolve (journal replay).
      const reopened = makeRegistry();
      const id = res.ok ? res.id : 0;
      const resolved = reopened.resolve(id);
      expect(resolved?.platform === 'slack' && resolved.threadTs).toBe('1751412345.123456');
    });

    it('durable binding FORCES registration past the speculative budget, with its OWN cap yielding a typed capacity refusal (adversarial-B)', () => {
      // The budget is PER CHANNEL (§3.3) — a thread flood within one channel is
      // the reachable shape (a channel-level conversation registers only once).
      const reg = makeRegistry({ breaker: { windowMs: 600000, speculativePerWindow: 1, durableBindingPerWindow: 1 } });
      reg.mintForInbound('C0AAAA11111:1751412345.000001'); // consumes the speculative budget
      const dropped = reg.mintForInbound('C0AAAA11111:1751412345.000002');
      expect(dropped.degraded).toBe('breaker-dropped');
      expect(dropped.registered).toBe(false);
      // Durable binding still registers (separate budget)…
      const forced = reg.mintForDurableBinding('C0AAAA11111:1751412345.000003');
      expect(forced.ok).toBe(true);
      // …but its own cap is a typed refusal + attention, never a silent drop.
      const refused = reg.mintForDurableBinding('C0AAAA11111:1751412345.000004');
      expect(refused).toEqual({ ok: false, error: 'conversation-registration-capacity' });
      expect(attention.some((a) => a.key === 'conversation-registry:durable-capacity')).toBe(true);
    });

    it('a breaker-dropped speculative registration re-mints for free once the window resets (zero pending state)', () => {
      let nowMs = 1_700_000_000_000;
      const reg = makeRegistry({
        now: () => new Date(nowMs),
        breaker: { windowMs: 1000, speculativePerWindow: 1 },
      });
      reg.mintForInbound('C0AAAA11111:1751412345.000001');
      const dropped = reg.mintForInbound('C0AAAA11111:1751412345.000002');
      expect(dropped.registered).toBe(false);
      expect(attention.filter((a) => a.key === 'conversation-registry:mint-breaker')).toHaveLength(1);
      nowMs += 1500; // window resets
      const remint = reg.mintForInbound('C0AAAA11111:1751412345.000002');
      expect(remint.registered).toBe(true);
      expect(remint.id).toBe(slackRoutingKeySyntheticId('C0AAAA11111:1751412345.000002'));
    });
  });

  describe('recording kill-switch (§3.6 D1 / §9)', () => {
    it('recording off → in-memory candidate degradation for inbound mints (no durable write), typed refusal for durable binds', () => {
      let enabled = false;
      const reg = makeRegistry({ isRecordingEnabled: () => enabled });
      const res = reg.mintForInbound('C0BA4F4E0FP');
      expect(res.degraded).toBe('recording-disabled');
      expect(res.id).toBe(slackRoutingKeySyntheticId('C0BA4F4E0FP')); // behavior-identical to legacy hashing
      expect(res.registered).toBe(false);
      expect(fs.existsSync(path.join(dir, 'conversation-registry.jsonl'))).toBe(false);

      const bind = reg.mintForDurableBinding('C0BA4F4E0FP');
      expect(bind).toEqual({ ok: false, error: 'conversation-recording-disabled' });
      expect(attention.some((a) => a.key === 'conversation-registry:recording-disabled-bind')).toBe(true);

      // Re-enabling resumes durable recording (read LIVE at the chokepoint — no restart).
      enabled = true;
      const live = reg.mintForInbound('C0BA4F4E0FP');
      expect(live.registered).toBe(true);
    });
  });

  describe('workspace identity (§3.1)', () => {
    it('no local workspace → `_` placeholder key; a later concrete observation upgrades IN PLACE (same id, key rewritten)', () => {
      let ws: string | undefined;
      const reg = makeRegistry({ getLocalWorkspaceId: () => ws });
      const minted = reg.mintForInbound('C0BA4F4E0FP');
      let resolved = reg.resolve(minted.id!);
      expect(resolved?.platform === 'slack' && resolved.workspaceId).toBe('_');
      expect(resolved?.platform === 'slack' && resolved.key).toBe('slack:_:C0BA4F4E0FP');

      ws = 'T0BA1DR0U3D';
      const again = reg.mintForInbound('C0BA4F4E0FP'); // mint-hit triggers the upgrade
      expect(again.id).toBe(minted.id); // the id NEVER changes
      resolved = reg.resolve(minted.id!);
      expect(resolved?.platform === 'slack' && resolved.workspaceId).toBe('T0BA1DR0U3D');
      expect(resolved?.platform === 'slack' && resolved.key).toBe('slack:T0BA1DR0U3D:C0BA4F4E0FP');
    });

    it('per-machine multi-workspace hard-refusal: a second distinct CONCRETE workspace is a typed refusal + ONE deduped attention item', () => {
      let ws = 'T0AAAAAAAAA';
      const reg = makeRegistry({ getLocalWorkspaceId: () => ws });
      expect(reg.mintForInbound('C0AAAA11111').registered).toBe(true); // pins T0AAAAAAAAA (self-corroborated)
      ws = 'T0BBBBBBBBB';
      const refused = reg.mintForInbound('C0BBBB22222');
      expect(refused).toEqual({ id: null, created: false, registered: false, degraded: 'multi-workspace-unsupported' });
      expect(attention.some((a) => a.key === 'conversation-registry:multi-workspace')).toBe(true);
      const refusedBind = reg.mintForDurableBinding('C0BBBB22222');
      expect(refusedBind).toEqual({ ok: false, error: 'multi-workspace-unsupported' });
    });

    it('a config-declared workspacePin is authoritative (source 1)', () => {
      const reg = makeRegistry({
        getLocalWorkspaceId: () => 'T0EVIL000000',
        getConfigWorkspacePin: () => 'T0PINNED0000',
      });
      const refused = reg.mintForInbound('C0AAAA11111');
      expect(refused.degraded).toBe('multi-workspace-unsupported');
    });
  });

  describe('WAL replay contract (§3.4)', () => {
    it('a torn tail (crash mid-append) is DISCARDED; committed records replay', () => {
      const journal = path.join(dir, 'conversation-registry.jsonl');
      const good = JSON.stringify({
        seq: 1,
        op: 'mint',
        key: 'slack:_:C0BA4F4E0FP',
        tuple: ['slack', 'C0BA4F4E0FP', null],
        id: -12345,
        origin: 'minted-probed',
        ts: '2026-07-01T00:00:00.000Z',
      });
      fs.writeFileSync(journal, `${good}\n{"seq":2,"op":"mint","key":"slack:_:C0TRUNC`); // torn tail
      const reg = makeRegistry();
      const resolved = reg.resolve(-12345);
      expect(resolved?.platform === 'slack' && resolved.channelId).toBe('C0BA4F4E0FP');
      // The torn fragment was truncated so later appends can never fuse onto it.
      const content = fs.readFileSync(journal, 'utf-8');
      expect(content.endsWith(`${good}\n`)).toBe(true);
    });

    it('NON-tail corruption fails CLOSED: replay halts, the file is quarantined aside, ONE attention item + a durability incident (R7-minor-3)', () => {
      const journal = path.join(dir, 'conversation-registry.jsonl');
      const rec = (seq: number, ch: string, id: number) =>
        JSON.stringify({ seq, op: 'mint', key: `slack:_:${ch}`, tuple: ['slack', ch, null], id, origin: 'minted-probed', ts: '2026-07-01T00:00:00.000Z' });
      fs.writeFileSync(journal, `${rec(1, 'C0AAAA11111', -111)}\nTHIS IS NOT JSON\n${rec(3, 'C0BBBB22222', -222)}\n`);
      const reg = makeRegistry();
      expect(reg.resolve(-111)).not.toBeNull(); // records BEFORE the corruption applied
      expect(reg.resolve(-222)).toBeNull(); // replay HALTED at the corruption — never skip-and-continue
      expect(fs.existsSync(journal)).toBe(false); // quarantined aside, preserved
      expect(fs.readdirSync(dir).some((n) => n.startsWith('conversation-registry.jsonl.corrupt-'))).toBe(true);
      expect(attention.some((a) => a.key === 'conversation-registry:journal-corrupt')).toBe(true);
      expect((reg.health() as { quarantine: { durabilityIncidents: number } }).quarantine.durabilityIncidents).toBe(1);
    });

    it('UNKNOWN-op tolerance (R8-minor-2): skipped, PRESERVED, attention raised — and snapshot flushing SUSPENDS (R9-M1/R10-M1)', async () => {
      const journal = path.join(dir, 'conversation-registry.jsonl');
      const lines = [
        JSON.stringify({ seq: 1, op: 'mint', key: 'slack:_:C0AAAA11111', tuple: ['slack', 'C0AAAA11111', null], id: -111, origin: 'minted-probed', ts: '2026-07-01T00:00:00.000Z' }),
        JSON.stringify({ seq: 2, op: 'future-op-from-a-newer-version', payload: { x: 1 }, ts: '2026-07-01T00:00:01.000Z' }),
        JSON.stringify({ seq: 3, op: 'mint', key: 'slack:_:C0BBBB22222', tuple: ['slack', 'C0BBBB22222', null], id: -222, origin: 'minted-probed', ts: '2026-07-01T00:00:02.000Z' }),
      ];
      fs.writeFileSync(journal, `${lines.join('\n')}\n`);
      const reg = makeRegistry();
      // Replay COMPLETES (version skew is not corruption): known records on both sides applied.
      expect(reg.resolve(-111)).not.toBeNull();
      expect(reg.resolve(-222)).not.toBeNull();
      const health = reg.health() as Record<string, unknown>;
      expect(health.snapshotSuspended).toBe(true);
      expect(health.firstUnappliedUnknownSeq).toBe(2);
      expect(health.unappliedUnknownCount).toBe(1);
      expect(attention.some((a) => a.key === 'conversation-registry:unknown-op')).toBe(true);
      // NO new snapshot is flushed while the unknown op remains unapplied — the
      // on-disk snapshot stays the pre-skew one (here: absent).
      reg.mintForInbound('C0CCCC33333');
      await reg.flushSnapshot();
      expect(fs.existsSync(path.join(dir, 'state', 'conversation-registry.json'))).toBe(false);
      // The unknown-op line is preserved untouched for the re-upgrade.
      expect(fs.readFileSync(journal, 'utf-8')).toContain('future-op-from-a-newer-version');
    });

    it('replay SPANS a rotation boundary in ONE global seq order, and the boot counter resumes from the max seen (R3-M14)', () => {
      // Force rotation after every record with a tiny byte cap.
      const reg = makeRegistry({ journalRotateBytes: 10, journalRotateLines: 2 });
      reg.mintForDurableBinding('C0AAAA11111');
      reg.mintForDurableBinding('C0BBBB22222');
      reg.mintForDurableBinding('C0CCCC33333');
      const files = fs.readdirSync(dir).filter((n) => n.startsWith('conversation-registry.jsonl'));
      expect(files.length).toBeGreaterThan(1); // rotation happened

      const reopened = makeRegistry({ journalRotateBytes: 10, journalRotateLines: 2 });
      expect(reopened.resolve(slackRoutingKeySyntheticId('C0AAAA11111'))).not.toBeNull();
      expect(reopened.resolve(slackRoutingKeySyntheticId('C0BBBB22222'))).not.toBeNull();
      expect(reopened.resolve(slackRoutingKeySyntheticId('C0CCCC33333'))).not.toBeNull();
      // seq continues across rotation + restart — never resets to 0/1.
      reopened.mintForDurableBinding('C0DDDD44444');
      const all = fs
        .readdirSync(dir)
        .filter((n) => n.startsWith('conversation-registry.jsonl'))
        .flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf-8').split('\n').filter(Boolean))
        .map((l) => (JSON.parse(l) as { seq: number }).seq);
      expect(new Set(all).size).toBe(all.length); // strictly unique, monotonic global seq
      expect(Math.max(...all)).toBe(all.length);
    });

    it('replay is IDEMPOTENT: re-opening any number of times yields the same state', () => {
      const reg = makeRegistry();
      reg.mintForDurableBinding('C0AAAA11111');
      reg.mintForDurableBinding('C0BBBB22222:1751412345.123456');
      const snapshotOf = (r: ConversationRegistry) =>
        JSON.stringify([r.resolve(slackRoutingKeySyntheticId('C0AAAA11111')), r.resolve(slackRoutingKeySyntheticId('C0BBBB22222:1751412345.123456'))]);
      const first = snapshotOf(makeRegistry());
      const second = snapshotOf(makeRegistry());
      expect(first).toBe(second);
      expect(first).toBe(snapshotOf(reg));
    });

    it('snapshot completeness (R4-M2/R6-M1) + R8-M1 boot conversion: bind-pins, ambiguous-send entries, and crash-orphaned send-intents survive snapshot → journal loss → reboot (a LOGICAL intent that is the last word converts to an ambiguous-send suppressor, never lost)', async () => {
      const journal = path.join(dir, 'conversation-registry.jsonl');
      const lines = [
        JSON.stringify({ seq: 1, op: 'mint', key: 'slack:_:C0AAAA11111', tuple: ['slack', 'C0AAAA11111', null], id: -111, origin: 'minted-probed', ts: '2026-07-01T00:00:00.000Z' }),
        JSON.stringify({ seq: 2, op: 'bind-pin', id: -111, tuple: ['slack', 'C0AAAA11111', null], refcount: 1, ts: '2026-07-01T00:00:01.000Z' }),
        JSON.stringify({ seq: 3, op: 'ambiguous-send', conversationId: -111, logicalSendId: 'cmt-42:7', lane: 'logical', ts: '2026-07-01T00:00:02.000Z' }),
        JSON.stringify({ seq: 4, op: 'send-intent', conversationId: -111, logicalSendId: 'cmt-42:8', lane: 'logical', ts: '2026-07-01T00:00:03.000Z' }),
      ];
      fs.writeFileSync(journal, `${lines.join('\n')}\n`);
      // First open: replay applies the intent, then convertOrphanedSendIntents
      // (R8-M1) converts the crash-orphaned LOGICAL intent (last word for its
      // pair) into an ambiguous-send suppressor. Flush captures the converted
      // state, then the journal is pruned.
      const reg = makeRegistry();
      reg.resolve(-111); // trigger load() (replay + R8-M1 conversion + state-dir create)
      await reg.flushSnapshot();
      SafeFsExecutor.safeUnlinkSync(journal, { operation: 'tests/unit/conversation-registry.test.ts — simulate pruning every superseded journal file' });
      const reopened = makeRegistry();
      const snap = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'conversation-registry.json'), 'utf-8'));
      // Nothing lost across snapshot → journal loss → reboot.
      expect(snap.bindPins['-111']).toEqual({ tuple: ['slack', 'C0AAAA11111', null], refcount: 1 });
      expect(snap.ambiguousSends['-111|cmt-42:7']).toBeTruthy();
      // R8-M1: the orphaned logical intent became a suppressor (converted, not
      // dropped) — so a beacon re-fire of cmt-42:8 is suppressed after reboot.
      expect(snap.ambiguousSends['-111|cmt-42:8']).toBeTruthy();
      expect(snap.sendIntents['-111|cmt-42:8']).toBeUndefined();
      expect(reopened.isSendSuppressed(-111, 'cmt-42:8', 'logical')).toBe(true);
      expect(reopened.resolve(-111)).not.toBeNull();
    });
  });

  describe('aliases (§3.5 — replay + one-hop resolution; writers land with the replicated-store increment)', () => {
    it('resolve() follows an alias exactly ONE hop', () => {
      const journal = path.join(dir, 'conversation-registry.jsonl');
      const lines = [
        JSON.stringify({ seq: 1, op: 'mint', key: 'slack:_:C0AAAA11111', tuple: ['slack', 'C0AAAA11111', null], id: -111, origin: 'minted-probed', ts: '2026-07-01T00:00:00.000Z' }),
        JSON.stringify({ seq: 2, op: 'alias', id: -999999, target: -111, ts: '2026-07-01T00:00:01.000Z' }),
      ];
      fs.writeFileSync(journal, `${lines.join('\n')}\n`);
      const reg = makeRegistry();
      const viaAlias = reg.resolve(-999999);
      expect(viaAlias?.platform === 'slack' && viaAlias.id).toBe(-111);
      expect(viaAlias?.platform === 'slack' && viaAlias.aliasOf).toBe(-111);
    });

    it('the assignment-beats-alias invariant holds at BOOT fixpoints (R5-C1/R6-M3): a replayed alias shadowing a live assignment is dropped', () => {
      const canonical = slackRoutingKeySyntheticId('C0AAAA11111');
      const journal = path.join(dir, 'conversation-registry.jsonl');
      const lines = [
        // A stale alias entry keyed on the id that a canonical claimant owns…
        JSON.stringify({ seq: 1, op: 'alias', id: canonical, target: -424242, ts: '2026-07-01T00:00:00.000Z' }),
        // …and the canonical claimant itself (minted at its own candidate).
        JSON.stringify({ seq: 2, op: 'mint', key: 'slack:_:C0AAAA11111', tuple: ['slack', 'C0AAAA11111', null], id: canonical, origin: 'minted-probed', ts: '2026-07-01T00:00:01.000Z' }),
      ];
      fs.writeFileSync(journal, `${lines.join('\n')}\n`);
      const reg = makeRegistry();
      const resolved = reg.resolve(canonical);
      // resolve(C) = the OWNING tuple — the shadowing alias is ABSENT.
      expect(resolved?.platform === 'slack' && resolved.channelId).toBe('C0AAAA11111');
      expect(resolved?.platform === 'slack' && resolved.aliasOf).toBeUndefined();
      expect(reg.aliasTable()[String(canonical)]).toBeUndefined();
    });
  });

  describe('resolution surfaces (§2/§8)', () => {
    it('positive ids pass through as Telegram, unregistered, forever', () => {
      const reg = makeRegistry();
      expect(reg.resolve(12476)).toEqual({ platform: 'telegram', topicId: 12476, passThrough: true });
      expect(reg.entryCount()).toBe(0); // the registry stays SPARSE
    });

    it('unknown negative id → null (the honest 404)', () => {
      const reg = makeRegistry();
      expect(reg.resolve(-987654321)).toBeNull();
    });

    it('id 0 and non-safe-integers → null', () => {
      const reg = makeRegistry();
      expect(reg.resolve(0)).toBeNull();
      expect(reg.resolve(Number.NaN)).toBeNull();
    });

    it('resolveByKey: canonical key, raw routing key, and numeric session key — mints NOTHING', () => {
      const reg = makeRegistry();
      const minted = reg.mintForInbound('C0BA4F4E0FP');
      expect(reg.resolveByKey('slack:_:C0BA4F4E0FP')?.platform).toBe('slack');
      expect(reg.resolveByKey('C0BA4F4E0FP')?.platform).toBe('slack');
      expect(reg.resolveByKey('12476')).toEqual({ platform: 'telegram', topicId: 12476, passThrough: true });
      expect(reg.resolveByKey('C0NEVERSEEN')).toBeNull();
      expect(reg.entryCount()).toBe(1); // the read-only lookup minted nothing
      expect(minted.id).not.toBeNull();
    });

    it('idForSessionKey is GET-OR-CREATE (§6.0 #12): numeric passes through, Slack keys mint', () => {
      const reg = makeRegistry();
      expect(reg.idForSessionKey('12476')).toBe(12476);
      const id = reg.idForSessionKey('C0BA4F4E0FP:1751412345.123456');
      expect(id).toBe(slackRoutingKeySyntheticId('C0BA4F4E0FP:1751412345.123456'));
      expect(reg.idForSessionKey('C0BA4F4E0FP:1751412345.123456')).toBe(id);
    });
  });

  describe('adoption pass (§6.2)', () => {
    it('pre-registers ONLY channels with authorized-sender traffic on record (security-B8), with legacy-hash ids; idempotent', () => {
      const reg = makeRegistry();
      const channels = [
        { channelId: 'C0AAAA11111', name: '#engineering' },
        { channelId: 'C0BBBB22222', name: '#auto-joined' },
      ];
      const res = reg.runAdoptionPass(channels, (ch) => ch === 'C0AAAA11111');
      expect(res).toEqual({ adopted: 1, skippedUnauthorized: 1 });
      const resolved = reg.resolve(slackRoutingKeySyntheticId('C0AAAA11111'));
      expect(resolved?.platform === 'slack' && resolved.label).toBe('#engineering');
      expect(reg.resolve(slackRoutingKeySyntheticId('C0BBBB22222'))).toBeNull();
      // Idempotent re-run adopts nothing new.
      expect(reg.runAdoptionPass(channels, (ch) => ch === 'C0AAAA11111')).toEqual({ adopted: 0, skippedUnauthorized: 1 });
    });
  });

  describe('health (§8 — the alive surface)', () => {
    it('reports counts, origins, seq state, recording, and suspension fields', () => {
      const reg = makeRegistry();
      reg.mintForInbound('C0AAAA11111');
      reg.mintForDurableBinding('C0BBBB22222:1751412345.123456');
      const h = reg.health() as Record<string, any>;
      expect(h.entryCount).toBe(2);
      expect(h.byPlatform.slack).toBe(2);
      expect(h.recordingEnabled).toBe(true);
      expect(h.snapshotSuspended).toBe(false);
      expect(h.unappliedUnknownCount).toBe(0);
      expect(h.aliasCount).toBe(0);
      expect(h.ceiling.entryCeiling).toBe(50000);
      expect(typeof h.seq.counter).toBe('number');
    });
  });

  // ── §3.5.2 bind-pin overlay WRITERS (increment 2) ──
  describe('bind-pin overlay (§3.5.2)', () => {
    it('bindPin records the bind-time tuple + refcount; two binds hold, last release frees (M8)', () => {
      const reg = makeRegistry();
      const res = reg.mintForDurableBinding('C0BA4F4E0FP:1751412345.123456');
      expect(res.ok).toBe(true);
      const id = (res as { ok: true; id: number }).id;
      const t1 = reg.bindPin(id);
      expect(t1).toEqual({ platform: 'slack', channelId: 'C0BA4F4E0FP', threadTs: '1751412345.123456' });
      reg.bindPin(id); // second durable bind on the same id (refcount → 2)
      expect(reg.getBindPinTuple(id)).not.toBeNull();
      reg.bindRelease(id); // one close → pin holds
      expect(reg.getBindPinTuple(id)).not.toBeNull();
      reg.bindRelease(id); // last close → released
      expect(reg.getBindPinTuple(id)).toBeNull();
    });
    it('live pins are restored from the journal in seq order across a re-open (restart replay)', () => {
      const reg = makeRegistry();
      const id = (reg.mintForDurableBinding('C0BA4F4E0FP') as { ok: true; id: number }).id;
      reg.bindPin(id);
      const reopened = makeRegistry();
      expect(reopened.getBindPinTuple(id)).toEqual({ platform: 'slack', channelId: 'C0BA4F4E0FP', threadTs: null });
    });
  });

  // ── §5.1 reachability WRITER (increment 2) ──
  describe('reachability (§5.1)', () => {
    it('setReachability flips, is idempotent, and journals durably', () => {
      const reg = makeRegistry();
      const id = (reg.mintForDurableBinding('C0BA4F4E0FP') as { ok: true; id: number }).id;
      const first = reg.setReachability(id, 'unreachable');
      expect(first.changed).toBe(true);
      const again = reg.setReachability(id, 'unreachable');
      expect(again.changed).toBe(false); // idempotent — no double write
      const reopened = makeRegistry();
      const desc = reopened.resolve(id);
      expect(desc!.platform === 'slack' && desc!.reachability).toBe('unreachable');
    });
    it('flapping past the threshold within the window is reported as dampened', () => {
      const reg = makeRegistry();
      const id = (reg.mintForDurableBinding('C0BA4F4E0FP') as { ok: true; id: number }).id;
      // 4 flips > REACHABILITY_FLAP_THRESHOLD (3) within 24h → dampened.
      reg.setReachability(id, 'unreachable');
      reg.setReachability(id, 'ok');
      reg.setReachability(id, 'unreachable');
      const fourth = reg.setReachability(id, 'ok');
      expect(fourth.dampened).toBe(true);
    });
  });

  // ── §5.0(a) E1 send-guard WRITERS (increment 2) ──
  describe('E1 send-guard (§5.0(a))', () => {
    it('a recorded likely-posted entry suppresses on the logical lane; retire clears it', () => {
      const reg = makeRegistry();
      const id = (reg.mintForDurableBinding('C0BA4F4E0FP') as { ok: true; id: number }).id;
      reg.recordLikelyPosted(id, 'CMT-001:7', 'logical');
      expect(reg.isSendSuppressed(id, 'CMT-001:7', 'logical')).toBe(true);
      // A DIFFERENT logical send is not suppressed.
      expect(reg.isSendSuppressed(id, 'CMT-001:8', 'logical')).toBe(false);
      reg.retireSend(id, 'CMT-001:7');
      expect(reg.isSendSuppressed(id, 'CMT-001:7', 'logical')).toBe(false);
    });
    it('a durable suppressor survives a re-open (restart-double-post protection — R4-M2)', () => {
      const reg = makeRegistry();
      const id = (reg.mintForDurableBinding('C0BA4F4E0FP') as { ok: true; id: number }).id;
      reg.recordLikelyPosted(id, 'CMT-001:7', 'logical');
      const reopened = makeRegistry();
      expect(reopened.isSendSuppressed(id, 'CMT-001:7', 'logical')).toBe(true);
    });
    it('resolveSendIntent clears an intent WITHOUT a suppressor (clean-transient path)', () => {
      const reg = makeRegistry();
      const id = (reg.mintForDurableBinding('C0BA4F4E0FP') as { ok: true; id: number }).id;
      reg.recordSendIntent(id, 'CMT-001:7', 'logical');
      reg.resolveSendIntent(id, 'CMT-001:7');
      // No suppressor was created — the retry is not suppressed.
      expect(reg.isSendSuppressed(id, 'CMT-001:7', 'logical')).toBe(false);
    });
    it('R8-M1 boot conversion: an orphaned CONTENT-HASH intent resolves toward RETRY (no suppressor)', () => {
      const reg = makeRegistry();
      const id = (reg.mintForDurableBinding('C0BA4F4E0FP') as { ok: true; id: number }).id;
      reg.recordSendIntent(id, 'sha256:abc', 'content-hash'); // crash before outcome
      const reopened = makeRegistry();
      // Content-hash orphan → resolved toward retry, never a suppressor.
      expect(reopened.isSendSuppressed(id, 'sha256:abc', 'content-hash')).toBe(false);
    });
    it('R8-M1 boot conversion: an orphaned LOGICAL intent converts to a suppressor', () => {
      const reg = makeRegistry();
      const id = (reg.mintForDurableBinding('C0BA4F4E0FP') as { ok: true; id: number }).id;
      reg.recordSendIntent(id, 'CMT-001:7', 'logical'); // crash before outcome
      const reopened = makeRegistry();
      expect(reopened.isSendSuppressed(id, 'CMT-001:7', 'logical')).toBe(true);
    });
    it('health exposes the send-guard counters', () => {
      const reg = makeRegistry();
      const id = (reg.mintForDurableBinding('C0BA4F4E0FP') as { ok: true; id: number }).id;
      reg.recordLikelyPosted(id, 'CMT-001:7', 'logical');
      const h = reg.health() as { sendGuard: { unretiredEntries: number; bindPins: number } };
      expect(h.sendGuard.unretiredEntries).toBe(1);
    });
  });

  // ── §4 read-only comparison path (integration-nit, increment 2) ──
  describe('readIdForRoutingKey (§4 no-write)', () => {
    it('returns an existing id and does NOT register a new one (a pure comparison never mints)', () => {
      const reg = makeRegistry();
      const before = reg.entryCount();
      const id = reg.readIdForRoutingKey('C0BA4F4E0FP');
      expect(id).toBe(candidateIdForRoutingKey('C0BA4F4E0FP'));
      expect(reg.entryCount()).toBe(before); // NO write side-effect
    });
    it('an already-minted key resolves to its registered id', () => {
      const reg = makeRegistry();
      const minted = reg.mintForInbound('C0BA4F4E0FP').id;
      expect(reg.readIdForRoutingKey('C0BA4F4E0FP')).toBe(minted);
    });
  });
});
