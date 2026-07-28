/**
 * Unit tests for the ONE BlockerLedger modification under "Self-Unblock Before
 * Escalating" (docs/specs/self-unblock-before-escalating.md §0/§5.1): when a
 * SelfUnblock run store is injected, settleTrueBlocker DERIVES the failed attempt
 * from a VERIFIED persisted run instead of accepting a caller-embedded one.
 *
 * The existing caller-supplied path (no store injected) is covered by
 * tests/unit/BlockerLedger.test.ts and must stay green — these tests assert the
 * NEW (store-injected) behavior + the anti-gaming closure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BlockerLedger, type SettleAuthority } from '../../src/monitoring/BlockerLedger.js';
import { SelfUnblockRunStore, type SelfUnblockRun } from '../../src/monitoring/SelfUnblockChecklist.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;

const allowAuthority: SettleAuthority = async () => ({ allow: true, reason: 'ok', decisionHash: 'hash-allow' });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-self-unblock-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/BlockerLedgerSelfUnblock.test.ts:afterEach',
  });
});

function exhaustedRun(overrides: Partial<SelfUnblockRun> = {}): SelfUnblockRun {
  return {
    runId: 'SUN-1',
    target: 'cloudflare:feedback.dawn-tunnel.dev',
    requiredAttemptType: 'self-fetch',
    probes: [
      { source: 'own-vault', reachable: true, holdsRelevantCred: false, probedAt: '2026-06-14T00:00:00.000Z' },
      { source: 'org-bitwarden', reachable: true, holdsRelevantCred: false, probedAt: '2026-06-14T00:00:01.000Z' },
    ],
    completedAt: '2026-06-14T00:00:02.000Z',
    exhausted: true,
    ...overrides,
  };
}

function ledgerWithStore(store: SelfUnblockRunStore): BlockerLedger {
  return new BlockerLedger({
    stateDir: tmpDir,
    settleAuthority: allowAuthority,
    selfUnblockRunStore: store,
    confinedPlaybookRoots: [path.join(tmpDir, 'playbooks')],
  });
}

describe('BlockerLedger + SelfUnblock run store — derives the attempt from a verified run', () => {
  it('settles a true-blocker by referencing a VERIFIED exhausted run (attempt derived from it)', async () => {
    const store = new SelfUnblockRunStore({ stateDir: tmpDir });
    store.save(exhaustedRun());
    const ledger = ledgerWithStore(store);

    const { id } = await ledger.open({ detectedText: 'I need the Namecheap DNS credential', origin: 's' });
    const settled = await ledger.settle(id, {
      origin: 's',
      kind: 'true-blocker',
      reasonKind: 'operator-only-secret',
      rebuttal: 'exhausted every reachable source; none holds this credential',
      selfUnblockRunId: 'SUN-1',
      accessRequest: { messageRef: 'relay-1', at: '2026-06-14T00:10:00.000Z' },
    });

    expect(settled.state).toBe('true-blocker');
    expect(settled.terminal?.kind).toBe('true-blocker');
    if (settled.terminal?.kind === 'true-blocker') {
      // attempt derived from the run: type matches, detail summarizes the probes,
      // `at` is the run's completedAt.
      expect(settled.terminal.failedAttempt.type).toBe('self-fetch');
      expect(settled.terminal.failedAttempt.at).toBe('2026-06-14T00:00:02.000Z');
      expect(settled.terminal.failedAttempt.detail).toContain('SUN-1');
      expect(settled.terminal.failedAttempt.detail).toContain('own-vault');
    }
  });

  // ── THE REQUIRED NEGATIVE ANTI-GAMING TEST ──
  it('HARD-rejects a settle that embeds a caller failedAttempt but references NO persisted run (the old path is CLOSED when enabled)', async () => {
    const store = new SelfUnblockRunStore({ stateDir: tmpDir });
    // intentionally save NOTHING — there is no persisted run
    const ledger = ledgerWithStore(store);
    const { id } = await ledger.open({ detectedText: 'I need a secret', origin: 's' });

    await expect(
      ledger.settle(id, {
        origin: 's',
        kind: 'true-blocker',
        reasonKind: 'operator-only-secret',
        rebuttal: 'only the user has it',
        // a hand-crafted attempt — exactly the gameable list the run-id closes
        failedAttempt: { type: 'self-fetch', detail: 'I totally checked, promise', at: '2026-06-14T00:00:00.000Z' },
        accessRequest: { messageRef: 'relay-1', at: '2026-06-14T00:10:00.000Z' },
      }),
    ).rejects.toMatchObject({ code: 'missing_failed_attempt' });
  });

  it('HARD-rejects a settle whose referenced run is UNKNOWN to the store', async () => {
    const store = new SelfUnblockRunStore({ stateDir: tmpDir });
    store.save(exhaustedRun({ runId: 'SUN-real' }));
    const ledger = ledgerWithStore(store);
    const { id } = await ledger.open({ detectedText: 'need secret', origin: 's' });

    await expect(
      ledger.settle(id, {
        origin: 's',
        kind: 'true-blocker',
        reasonKind: 'operator-only-secret',
        rebuttal: 'x',
        selfUnblockRunId: 'SUN-does-not-exist',
        accessRequest: { messageRef: 'relay-1', at: '2026-06-14T00:10:00.000Z' },
      }),
    ).rejects.toMatchObject({ code: 'missing_failed_attempt' });
  });

  it('HARD-rejects a run that is NOT a genuine exhaustion (a probe found a relevant cred)', async () => {
    const store = new SelfUnblockRunStore({ stateDir: tmpDir });
    store.save(
      exhaustedRun({
        runId: 'SUN-notdone',
        exhausted: false,
        probes: [{ source: 'own-vault', reachable: true, holdsRelevantCred: true, probedAt: 't' }],
      }),
    );
    const ledger = ledgerWithStore(store);
    const { id } = await ledger.open({ detectedText: 'need secret', origin: 's' });

    await expect(
      ledger.settle(id, {
        origin: 's',
        kind: 'true-blocker',
        reasonKind: 'operator-only-secret',
        rebuttal: 'x',
        selfUnblockRunId: 'SUN-notdone',
        accessRequest: { messageRef: 'relay-1', at: '2026-06-14T00:10:00.000Z' },
      }),
    ).rejects.toMatchObject({ code: 'missing_failed_attempt' });
  });

  it('HARD-rejects a run whose attempt TYPE does not match the blocker kind', async () => {
    const store = new SelfUnblockRunStore({ stateDir: tmpDir });
    // a dry-run run cannot satisfy a secret-kind blocker (needs self-fetch)
    store.save(exhaustedRun({ runId: 'SUN-dry', requiredAttemptType: 'dry-run' }));
    const ledger = ledgerWithStore(store);
    const { id } = await ledger.open({ detectedText: 'need secret', origin: 's' });

    await expect(
      ledger.settle(id, {
        origin: 's',
        kind: 'true-blocker',
        reasonKind: 'operator-only-secret',
        rebuttal: 'x',
        selfUnblockRunId: 'SUN-dry',
        accessRequest: { messageRef: 'relay-1', at: '2026-06-14T00:10:00.000Z' },
      }),
    ).rejects.toMatchObject({ code: 'missing_failed_attempt' });
  });

  it('still enforces the temporal proof (access-request AFTER the derived attempt)', async () => {
    const store = new SelfUnblockRunStore({ stateDir: tmpDir });
    store.save(exhaustedRun({ completedAt: '2026-06-14T20:00:00.000Z' }));
    const ledger = ledgerWithStore(store);
    const { id } = await ledger.open({ detectedText: 'need secret', origin: 's' });

    await expect(
      ledger.settle(id, {
        origin: 's',
        kind: 'true-blocker',
        reasonKind: 'operator-only-secret',
        rebuttal: 'x',
        selfUnblockRunId: 'SUN-1',
        // access-request BEFORE the run completed → asking before trying
        accessRequest: { messageRef: 'relay-1', at: '2026-06-14T19:00:00.000Z' },
      }),
    ).rejects.toMatchObject({ code: 'access_request_before_attempt' });
  });

  it('settles a dry-run-kind blocker (legal-billing) from a verified dry-run run', async () => {
    const store = new SelfUnblockRunStore({ stateDir: tmpDir });
    store.save(
      exhaustedRun({
        runId: 'SUN-dry',
        requiredAttemptType: 'dry-run',
        target: 'spend:authorization',
      }),
    );
    const ledger = ledgerWithStore(store);
    const { id } = await ledger.open({ detectedText: 'I cannot authorize spend', origin: 's' });

    const settled = await ledger.settle(id, {
      origin: 's',
      kind: 'true-blocker',
      reasonKind: 'legal-billing-authorization',
      rebuttal: 'spend approval is the operator’s',
      selfUnblockRunId: 'SUN-dry',
      accessRequest: { messageRef: 'relay-9', at: '2026-06-14T01:00:00.000Z' },
    });
    expect(settled.state).toBe('true-blocker');
  });
});
