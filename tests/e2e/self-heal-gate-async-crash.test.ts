// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the SelfHealGate extensions across a REAL process crash
 * (context-budget-layered-summaries §9.4): a pool-shared, async ladder with a
 * durable SQLite episode store in its own file.
 *
 *  1. A child process (vite-node, production modules) claims an attempt and
 *     dies with process.exit INSIDE the async remediation.
 *  2. A fresh boot on the same store: the attempt was counted (the claim is
 *     durable before remediation runs), nothing is stuck "in flight" (that
 *     guard is per process), the next attempt runs, and at maxAttempts the
 *     episode exhausts with exactly one notice.
 *  3. The per-tick prune RETAINS the exhausted episode (it can never re-open
 *     and page again); the next incident of the same cause starts fresh.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SelfHealGate, SqliteSelfHealEpisodeStore, type SelfHealSpec } from '../../src/core/SelfHealGate.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/self-heal-gate-async-crash.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SPEC_SRC = `
const group = (k) => k.slice(0, k.lastIndexOf('-'));
const spec = (remediationAsync) => ({
  id: 'cb-stage-ladder', controllerResource: 'pool-shared', episodeAuthority: 'durable-machine-local', classId: 'cb',
  severity: () => 'recoverable', dedupeKey: (c) => 'm1-' + c.topic + '-stage-' + c.incident, eligible: () => ({ eligible: true, fence: 'g1' }),
  isOwner: () => true, remediationMode: 'async', remediationAsync, maxRemediationMs: 5000,
  maxAttempts: 2, maxWallClockMs: 600000, backoffMs: () => 0, notificationLatencyCeilingMs: 600000, flap: { maxRecoveries: 10, windowMs: 60000 },
  remediationActions: { operation: 're-stage', idempotencyGuard: 'fold-record CAS', compensation: 'rollback' },
});
`;

const CHILD = `
import { SelfHealGate, SqliteSelfHealEpisodeStore } from ${JSON.stringify(path.join(ROOT, 'src/core/SelfHealGate.ts'))};
${SPEC_SRC}
const dbPath = process.argv[process.argv.length - 1];
const store = new SqliteSelfHealEpisodeStore(dbPath, { ring: { groupOf: group, perGroup: 4 } });
let n = 0;
const gate = new SelfHealGate(spec(async () => { process.exit(9); }), {
  admit: async () => ({ outcome: 'allow', token: { id: 't' + (++n) }, reason: 'admitted' }), consumeToken: () => ({ proceed: true, valid: true }),
  notify: () => {}, audit: () => {}, episodeStore: store, bootId: 'boot-child',
});
await gate.attempt({ topic: '141133', incident: 'i1' });
console.error('remediation did not run');
process.exit(3);
`;

describe('SelfHealGate extensions survive a crash mid async remediation', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  it('the attempt is durable, nothing is stuck in flight, the ladder exhausts once and stays exhausted, and the next incident starts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shg-crash-')); dirs.push(dir);
    const dbPath = path.join(dir, 'state', 'context-budget-self-heal.db');
    const childFile = path.join(dir, 'child.mts');
    fs.writeFileSync(childFile, CHILD);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vite-node/vite-node.mjs'), childFile, dbPath], { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(9); // died INSIDE the remediation

    const group = (k: string) => k.slice(0, k.lastIndexOf('-'));
    const store = new SqliteSelfHealEpisodeStore(dbPath, { ring: { groupOf: group, perGroup: 4 } });
    try {
      const key = 'cb-stage-ladder:m1-141133-stage-i1';
      expect(store.load(key)).toMatchObject({ status: 'active', attempts: 1 }); // the claim landed before the crash

      const notify = vi.fn(); let n = 0; const ran: string[] = [];
      type C = { topic: string; incident: string };
      // The same declaration the child used (kept in step with SPEC_SRC above).
      const spec = (remediationAsync: SelfHealSpec<C>['remediationAsync']): SelfHealSpec<C> => ({
        id: 'cb-stage-ladder', controllerResource: 'pool-shared', episodeAuthority: 'durable-machine-local', classId: 'cb',
        severity: () => 'recoverable', dedupeKey: (c) => `m1-${c.topic}-stage-${c.incident}`, eligible: () => ({ eligible: true, fence: 'g1' }),
        isOwner: () => true, remediationMode: 'async', remediationAsync, maxRemediationMs: 5000,
        maxAttempts: 2, maxWallClockMs: 600000, backoffMs: () => 0, notificationLatencyCeilingMs: 600000, flap: { maxRecoveries: 10, windowMs: 60000 },
        remediationActions: { operation: 're-stage', idempotencyGuard: 'fold-record CAS', compensation: 'rollback' },
      });
      const gate = new SelfHealGate(spec(async (c) => { ran.push(c.incident); return { outcome: 'not-healed', evidence: 'verification-failed' }; }), {
        admit: async () => ({ outcome: 'allow' as const, token: { id: `t${++n}` } as AdmissionToken, reason: 'admitted' as const }), consumeToken: () => ({ proceed: true, valid: true }),
        notify, audit: () => {}, episodeStore: store, bootId: 'boot-two',
      });
      expect(await gate.attempt({ topic: '141133', incident: 'i1' })).toMatchObject({ outcome: 'attempted' }); // not 'remediation-in-flight'
      expect(ran).toEqual(['i1']);
      expect(await gate.attempt({ topic: '141133', incident: 'i1' })).toMatchObject({ outcome: 'exhausted', reason: 'max-attempts' });
      expect(await gate.attempt({ topic: '141133', incident: 'i1' })).toMatchObject({ outcome: 'exhausted' });
      expect(notify).toHaveBeenCalledTimes(1);

      // The exhausted incident is RETAINED (so it can never re-open and page again); the next incident starts.
      expect(gate.pruneTerminal()).toBe(0);
      expect(store.load(key)).toMatchObject({ status: 'exhausted' });
      expect(await gate.attempt({ topic: '141133', incident: 'i1' })).toMatchObject({ outcome: 'exhausted' });
      expect(await gate.attempt({ topic: '141133', incident: 'i2' })).toMatchObject({ outcome: 'attempted' });
      expect(notify).toHaveBeenCalledTimes(1);
    } finally { store.close(); }
  });
});
