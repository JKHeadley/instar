/**
 * Wiring-integrity / security — the org-Bitwarden session value handed through
 * DurableVaultSession.withSession MUST NEVER leak. Specifically a sentinel session
 * string must NOT appear in:
 *   - the persisted self-unblock run JSON,
 *   - the BlockerLedger decisions log,
 *   - any argv of the bw child process (argv is visible in `ps`).
 * The session is allowed ONLY in the child's BW_SESSION env. We capture argv by
 * injecting a fake execFile that records its args, then assert the sentinel is
 * absent from args but present in the BW_SESSION env.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildProductionProbeProviders,
  type ExecFileBounded,
} from '../../src/monitoring/SelfUnblockProbeProviders.js';
import { SelfUnblockChecklist, SelfUnblockRunStore } from '../../src/monitoring/SelfUnblockChecklist.js';
import { DurableVaultSession } from '../../src/monitoring/DurableVaultSession.js';
import { BlockerLedger } from '../../src/monitoring/BlockerLedger.js';
import type { SettleAuthority } from '../../src/monitoring/BlockerLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SENTINEL = 'BW-SESSION-SENTINEL-DO-NOT-LEAK-1234567890';
const TARGET = 'cloudflare:feedback.dawn-tunnel.dev';

const allowAuthority: SettleAuthority = async () => ({
  allow: true,
  reason: 'fake allow authority (test)',
  decisionHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
});

describe('Self-Unblock — bw session value never leaks', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-leak-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/SelfUnblockSessionLeak.test.ts:afterEach',
    });
  });

  it('the bw session sentinel is in BW_SESSION env, NEVER in argv, the run JSON, or the decisions log', async () => {
    // Capture every exec call's argv + env.
    const calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const exec: ExecFileBounded = async (file, args, opts) => {
      calls.push({ file, args, env: opts.env });
      return { code: 0, stdout: '{}', stderr: '', timedOut: false };
    };

    const dvs = new DurableVaultSession({ deriveSession: () => SENTINEL });
    const store = new SelfUnblockRunStore({ stateDir });
    const providers = buildProductionProbeProviders({
      execFileBounded: exec,
      durableVaultSession: dvs,
      getVaultKeys: () => ['telegram-token'],
      getCloudflareToken: () => null,
      // No declared tags → fail-closed exhaustion (so the run can settle a blocker).
    });
    const checklist = new SelfUnblockChecklist({ providers, store });

    const run = await checklist.run({ target: TARGET, requiredAttemptType: 'self-fetch' });
    expect(run.exhausted).toBe(true);

    // (1) The bw call carried the sentinel ONLY in BW_SESSION env, NEVER in argv.
    const bwCall = calls.find((c) => c.file === 'bw');
    expect(bwCall).toBeDefined();
    expect(bwCall!.args.join(' ')).not.toContain(SENTINEL);
    expect(bwCall!.env?.BW_SESSION).toBe(SENTINEL);

    // (2) The persisted run JSON never contains the sentinel.
    const runFile = store.path;
    const runRaw = fs.readFileSync(runFile, 'utf-8');
    expect(runRaw).not.toContain(SENTINEL);

    // (3) Settle a blocker through the ledger (writes the decisions log) and assert
    //     the sentinel is absent from that audit too.
    const ledger = new BlockerLedger({
      stateDir,
      settleAuthority: allowAuthority,
      selfUnblockRunStore: store,
      confinedPlaybookRoots: [path.join(stateDir, 'playbooks')],
    });
    const entry = await ledger.open({ detectedText: 'I need the DNS credential', origin: 's1' });
    await ledger.settle(entry.id, {
      origin: 's1',
      kind: 'true-blocker',
      reasonKind: 'operator-only-secret',
      rebuttal: 'exhausted every reachable source',
      selfUnblockRunId: run.runId,
      accessRequest: {
        messageRef: 'relay-1',
        at: new Date(new Date(run.completedAt).getTime() + 60_000).toISOString(),
      },
    });

    const decisionsLog = path.join(stateDir, '..', 'logs', 'blocker-decisions.jsonl');
    expect(fs.existsSync(decisionsLog)).toBe(true);
    const decisionsRaw = fs.readFileSync(decisionsLog, 'utf-8');
    expect(decisionsRaw).not.toContain(SENTINEL);

    // (4) The persisted ledger store itself never contains the sentinel either.
    const ledgerStore = path.join(stateDir, 'state', 'blocker-ledger.json');
    expect(fs.readFileSync(ledgerStore, 'utf-8')).not.toContain(SENTINEL);
  });
});
