/**
 * StateManager ⇄ WriteAdmission store-seam delegation (standby-write
 * reconciliation §3.3) — wiring integrity + both sides of every boundary:
 *
 *  - ONE-WAY attach (pre-construction window §3.2: legacy blanket verdict
 *    before attach; a second attach fails loudly; never detached).
 *  - Dry-run: the LEGACY blanket guard keeps enforcing (§9.6) — byte-identical
 *    verdicts, including the sessionScoped carve-out.
 *  - Live: machine-local kv admits on a read-only standby; cluster-shared
 *    refuses with a WriteRefusedError carrying the typed refusal AND the
 *    LEGACY message string (§7 log-scraping continuity).
 *  - Scope threading: saveSession/removeSession pass their session scope so a
 *    custody record naming ANOTHER machine refuses not-owner end-to-end.
 *  - Admission-layer throw at the store seam ⇒ legacy verdict (§5 fail
 *    direction) + the broken guard is recorded (noteStoreSeamError).
 *  - The guardJournalWrite path jail survives the fold-in verbatim (§3.6).
 *
 * Spec: docs/specs/standby-write-reconciliation.md §3.2/§3.3/§5/§8 (Tier 1).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { WriteAdmission, WriteRefusedError } from '../../src/core/WriteAdmission.js';
import { buildWriteDomainRegistry, sessionBuildContextKeyFor } from '../../src/core/WriteDomainRegistry.js';
import type { Session } from '../../src/core/types.js';
import type { SessionOwnershipRecord, SessionOwnershipStatus } from '../../src/core/SessionOwnership.js';

const SELF = 'm_self';
const PEER = 'm_peer';

function rec(sessionKey: string, owner: string, status: SessionOwnershipStatus): SessionOwnershipRecord {
  return {
    sessionKey,
    ownerMachineId: owner,
    ownershipEpoch: 1,
    status,
    nonce: `n-${sessionKey}`,
    timestamp: 1_000_000,
    updatedAt: new Date(1_000_000).toISOString(),
  };
}

function session(id: string, tmux: string): Session {
  return {
    id,
    tmuxSession: tmux,
    type: 'main',
    status: 'running',
    startedAt: new Date().toISOString(),
  } as unknown as Session;
}

function makeAdmission(state: StateManager, opts: {
  dryRun?: boolean;
  live?: boolean;
  records?: unknown[];
  binding?: (sessionId: string) => number | string | null;
} = {}): WriteAdmission {
  return new WriteAdmission(
    {
      thisMachineId: SELF,
      isReadOnly: () => state.readOnly,
      isPoolActive: () => state.sessionPoolActive,
      registry: buildWriteDomainRegistry({ machineId: SELF }),
      dryRun: opts.dryRun ?? false,
      resolveTopicForSession: opts.binding,
      disableTimers: true,
      inventoryComplete: opts.live ?? true,
    },
    { all: () => (opts.records ?? []) as SessionOwnershipRecord[] },
  );
}

describe('StateManager ⇄ WriteAdmission store seam', () => {
  let tmpDir: string;
  let state: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-write-admission-'));
    state = new StateManager(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/state-manager-write-admission.test.ts:afterEach' });
  });

  describe('one-way attach (§3.2 pre-construction window)', () => {
    it('pre-attach the getter is null and guardWrite runs the LEGACY blanket verdict — exactly today', () => {
      expect(state.writeAdmission).toBeNull();
      state.setReadOnly(true);
      // Legacy blanket: even the machine-local per-machine kv key throws.
      expect(() => state.set(sessionBuildContextKeyFor(SELF), { a: 1 })).toThrow(
        /StateManager is read-only \(this machine is on standby\)\. Blocked: set/,
      );
      // Legacy sessionScoped carve-out: admits when the pool is active.
      state.setSessionPoolActive(true);
      expect(() => state.saveSession(session('s1', 'tmux-1'))).not.toThrow();
    });

    it('a SECOND attach fails loudly (wiring bug — never re-attach at runtime)', () => {
      const wa = makeAdmission(state);
      state.attachWriteAdmission(wa);
      expect(state.writeAdmission).toBe(wa);
      expect(() => state.attachWriteAdmission(makeAdmission(state))).toThrow(/already attached/);
      expect(state.writeAdmission).toBe(wa); // the first attach survives
    });
  });

  describe('dry-run: the LEGACY guard keeps enforcing (§9.6)', () => {
    it('read-only standby: a machine-local kv write STILL throws the legacy error (zero authority while dry)', () => {
      state.attachWriteAdmission(makeAdmission(state, { dryRun: true }));
      state.setReadOnly(true);
      expect(() => state.set(sessionBuildContextKeyFor(SELF), { a: 1 })).toThrow(
        /StateManager is read-only/,
      );
      // The divergence is COUNTED as graduation evidence (§6 would-admit).
      const ml = state.writeAdmission!.status().domains.find((d) => d.domain === 'machine-local')!;
      expect(ml.wouldAdmitChanged).toBeGreaterThanOrEqual(1);
    });

    it('the legacy sessionScoped carve-out still admits on a pool-active standby', () => {
      state.attachWriteAdmission(makeAdmission(state, { dryRun: true }));
      state.setReadOnly(true);
      state.setSessionPoolActive(true);
      expect(() => state.saveSession(session('s1', 'tmux-1'))).not.toThrow();
    });
  });

  describe('live: ownership-scoped verdicts at the store seam', () => {
    it('machine-local kv ADMITS on a read-only standby — the F9 fix (build-context write no longer blocked)', () => {
      state.attachWriteAdmission(makeAdmission(state, { live: true }));
      state.setReadOnly(true);
      const key = sessionBuildContextKeyFor(SELF);
      expect(() => state.set(key, { hello: 'world' })).not.toThrow();
      expect(state.get(key)).toEqual({ hello: 'world' });
    });

    it('cluster-shared refuses with WriteRefusedError: typed refusal + the LEGACY message preserved (§7)', () => {
      state.attachWriteAdmission(makeAdmission(state, { live: true }));
      state.setReadOnly(true);
      let caught: unknown;
      try {
        state.set('some-unclassified-key', { x: 1 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WriteRefusedError);
      const e = caught as WriteRefusedError;
      expect(e.message).toContain('StateManager is read-only (this machine is on standby). Blocked: set');
      expect(e.refusal.error).toBe('write-refused');
      expect(e.refusal.code).toBe('lease-required');
      expect(e.refusal.retryable).toBe(true);
      // I3: the refused write left ZERO durable trace.
      expect(state.get('some-unclassified-key')).toBeNull();
    });

    it('cluster-shared on the lease HOLDER admits — byte-identical authority to today (I4a)', () => {
      state.attachWriteAdmission(makeAdmission(state, { live: true }));
      state.setReadOnly(false);
      expect(() => state.set('some-unclassified-key', { x: 1 })).not.toThrow();
    });

    it('saveSession threads its session scope: a custody record naming ANOTHER machine refuses not-owner end-to-end', () => {
      state.setSessionPoolActive(true);
      state.setReadOnly(true);
      state.attachWriteAdmission(makeAdmission(state, {
        live: true,
        binding: (sessionId) => (sessionId === 'tmux-owned-elsewhere' ? 30193 : null),
        records: [rec('30193', PEER, 'active')],
      }));
      // Bound to a topic OWNED BY THE PEER ⇒ not-owner refusal (the tightening).
      let caught: unknown;
      try {
        state.saveSession(session('s1', 'tmux-owned-elsewhere'));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WriteRefusedError);
      expect((caught as WriteRefusedError).refusal.code).toBe('not-owner');
      expect((caught as WriteRefusedError).refusal.owner?.machineId).toBe(PEER);

      // UNBOUND session (binding miss) ⇒ admit — the M2 reachability guarantee.
      expect(() => state.saveSession(session('s2', 'tmux-unbound'))).not.toThrow();
      // removeSession rides the same seam (record id in hand, binding miss ⇒ admit).
      expect(state.removeSession('s2')).toBe(true);
    });
  });

  describe('admission-layer throw at the store seam (§5: fail toward TODAY)', () => {
    it('falls back to the legacy verdict on BOTH sides and records the broken guard', () => {
      const wa = makeAdmission(state, { live: true });
      state.attachWriteAdmission(wa);
      const noteSpy = vi.spyOn(wa, 'noteStoreSeamError');
      vi.spyOn(wa, 'guardStoreWrite').mockImplementation(() => {
        throw new Error('guard broke');
      });
      // Legacy read-write ⇒ the write proceeds.
      state.setReadOnly(false);
      expect(() => state.set('k1', { a: 1 })).not.toThrow();
      // Legacy read-only ⇒ the legacy throw (NOT a WriteRefusedError).
      state.setReadOnly(true);
      let caught: unknown;
      try {
        state.set('k2', { a: 1 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(WriteRefusedError);
      expect((caught as Error).message).toContain('StateManager is read-only');
      expect(noteSpy).toHaveBeenCalled(); // never log-only-invisible (§6)
    });

    it('a WriteRefusedError from the layer is NOT swallowed by the fallback (it IS the verdict)', () => {
      const wa = makeAdmission(state, { live: true });
      state.attachWriteAdmission(wa);
      state.setReadOnly(true);
      expect(() => state.set('unclassified', { a: 1 })).toThrow(WriteRefusedError);
    });
  });

  describe('the guardJournalWrite path jail survives the fold-in verbatim (§3.6)', () => {
    it('a path escaping the journal prefix throws even when NOT read-only, with admission attached and live', () => {
      state.attachWriteAdmission(makeAdmission(state, { live: true }));
      state.setReadOnly(false);
      expect(() => state.guardJournalWrite(path.join(tmpDir, 'state', 'elsewhere.json'))).toThrow(
        /escapes the coherence-journal prefix/,
      );
      // An in-prefix path stays blessed on a read-only standby (journal
      // streams are single-producer-per-machine by construction).
      state.setReadOnly(true);
      expect(() =>
        state.guardJournalWrite(path.join(tmpDir, 'state', 'coherence-journal', 'own.jsonl')),
      ).not.toThrow();
    });
  });
});
