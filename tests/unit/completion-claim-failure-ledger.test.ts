import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmQueue, LlmQueueAdmissionError } from '../../src/monitoring/LlmQueue.js';
import { ClaimClauseArbiter } from '../../src/monitoring/ClaimClauseArbiter.js';
import { CompletionClaimVerifier } from '../../src/monitoring/CompletionClaimVerifier.js';
import { CompletionClaimFailureLedger } from '../../src/monitoring/CompletionClaimFailureLedger.js';
import { ClaimObservationAdmissionQueue } from '../../src/monitoring/ClaimObservationAdmissionQueue.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { TurnEvidence } from '../../src/monitoring/TurnEvidence.js';

const evidence = { toolCalls: [], unavailable: false, truncated: false, canaryOk: true, hadToolCalls: false } as unknown as TurnEvidence;
const OK = JSON.stringify({ legacy: { clauses: [{ clauseId: 0, label: 'neither', actionKind: 'other', completionScope: 'none', corroborated: false }] } });
const SECRET_TEXT = 'I merged zebra-private-target';

function withDir(run: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-ledger-'));
    try { await run(dir); } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'claim-ledger-test' }); }
  };
}
function provider(reply: string | Error) {
  return { evaluate: vi.fn(async (_prompt: string, options?: Record<string, any>) => {
    options?.onModel?.({ model: 'gpt-6-luna', framework: 'codex-cli' });
    if (reply instanceof Error) throw reply;
    return reply;
  }) } as any;
}
const failureOf = (reply: string | Error) => new ClaimClauseArbiter({ intelligence: provider(reply) })
  .arbitrate('I merged it', evidence).then((result) => result.failure);

describe('ClaimClauseArbiter failure attribution', () => {
  it.each([
    ['', 'empty-output', 'parse:empty'],
    ['{bad json', 'invalid-output', 'parse:unparseable-json'],
    ['{"answer":1}', 'invalid-output', 'parse:unexpected-root-key'],
    ['[1]', 'invalid-output', 'parse:root-not-object'],
    ['{"legacy":3}', 'invalid-output', 'parse:legacy-not-object'],
    ['{"legacy":{"clauses":[],"extra":1}}', 'invalid-output', 'parse:unexpected-legacy-key'],
    ['{"legacy":{"clauses":[{},{}]}}', 'invalid-output', 'parse:too-many-clauses'],
    ['{"legacy":{"clauses":[7]}}', 'invalid-output', 'parse:clause-not-object'],
    ['{"legacy":{"clauses":[{"clauseId":0,"label":"maybe","actionKind":"other","completionScope":"none","corroborated":false}]}}', 'invalid-output', 'parse:bad-label'],
    ['{"legacy":{"clauses":[{"clauseId":0,"label":"neither","actionKind":"other","completionScope":"later","corroborated":false}]}}', 'invalid-output', 'parse:bad-completion-scope'],
    ['{"legacy":{"clauses":[{"clauseId":0,"label":"neither","actionKind":"other","completionScope":"none","corroborated":"no"}]}}', 'invalid-output', 'parse:bad-corroborated'],
    ['{"legacy":{"clauses":"x"}}', 'invalid-output', 'parse:clauses-not-array'],
    ['{"legacy":{"clauses":[{"clauseId":0,"text":"echo","label":"neither","actionKind":"other","completionScope":"none","corroborated":false}]}}', 'invalid-output', 'parse:unexpected-clause-key'],
    ['{"legacy":{"clauses":[{"clauseId":9,"label":"neither","actionKind":"other","completionScope":"none","corroborated":false}]}}', 'invalid-output', 'parse:bad-clause-id'],
    ['{"legacy":{"clauses":[{"clauseId":0,"label":"neither","actionKind":"none","completionScope":"none","corroborated":false}]}}', 'invalid-output', 'parse:bad-action-kind'],
  ])('names the branch for %s', async (reply, reason, branch) => {
    expect(await failureOf(reply)).toEqual({ reason, branch, model: 'gpt-6-luna', framework: 'codex-cli' });
  });

  it('separates a refused call from a provider error and carries no failure on success', async () => {
    expect(await failureOf(new LlmQueueAdmissionError('lane-reserve', 'x'))).toMatchObject({ reason: 'lane-reserve', branch: 'admission' });
    expect(await failureOf(new Error('zebra-private-target timed out'))).toMatchObject({ reason: 'provider-error', branch: 'provider' });
    expect(await failureOf(OK)).toBeUndefined();
  });
});

describe('CMT-1131 root cause', () => {
  // The shape of production: estimated cost charged per call against a shared cap.
  it('a shared queue refuses calls after its background share is spent, and the ledger says so', withDir(async (dir) => {
    const shared = new LlmQueue({ maxConcurrent: 3, interactiveReservePct: 0.4, maxDailyCents: 100 });
    const model = provider(OK);
    const intelligence = { evaluate: (prompt: string, options: any) => shared.enqueueMetered({ component: 'claim-verification',
      estimatedInputTokens: 10, maxOutputTokens: 10, estimatedCostCents: 0.25, hourly: { requests: 100_000 },
      daily: { requests: 100_000, inputTokens: 1e12, outputTokens: 1e12, costCents: 1e9 },
      run: () => model.evaluate(prompt, options) }) } as any;
    const verifier = new CompletionClaimVerifier({ intelligence, stateDir: dir, enabled: true, dryRun: true });
    for (let turn = 0; turn < 300; turn++) await verifier.observe(`I merged thing ${turn}`, evidence);
    expect(model.evaluate.mock.calls.length).toBe(240);
    expect(verifier.stats().invalidOutputTurns).toBe(60);
    const rows = verifier.readFailures(500);
    expect(rows).toHaveLength(60);
    expect(rows[0]).toMatchObject({ reason: 'lane-reserve', branch: 'admission' });
  }));

  it('a dedicated queue with the component budget as its bound serves all of those turns', withDir(async (dir) => {
    const own = new LlmQueue({ maxConcurrent: 4, interactiveReservePct: 0, maxDailyCents: 500 });
    const model = provider(OK);
    const intelligence = { evaluate: (prompt: string, options: any) => own.enqueueMetered({ component: 'claim-verification',
      estimatedInputTokens: 10, maxOutputTokens: 10, estimatedCostCents: 0.25, hourly: { requests: 100_000 },
      daily: { requests: 2_000, inputTokens: 1e12, outputTokens: 1e12, costCents: 500 },
      run: () => model.evaluate(prompt, options) }) } as any;
    const verifier = new CompletionClaimVerifier({ intelligence, stateDir: dir, enabled: true, dryRun: true });
    for (let turn = 0; turn < 300; turn++) await verifier.observe(`I merged thing ${turn}`, evidence);
    expect(model.evaluate.mock.calls.length).toBe(300);
    expect(verifier.stats().invalidOutputTurns).toBe(0);
  }));
});

describe('CompletionClaimFailureLedger', () => {
  const NOW = Date.UTC(2026, 9, 30, 12);
  const day = (back: number) => NOW - back * 86_400_000;
  function seed(dir: string, perDay: (back: number) => { turns: number; failed: number }) {
    let now = NOW;
    const ledger = new CompletionClaimFailureLedger({ stateDir: dir, now: () => now });
    for (let back = 7; back >= 1; back--) {
      now = day(back);
      const { turns, failed } = perDay(back);
      for (let i = 0; i < turns; i++) {
        if (i < failed) ledger.recordFailure({ reason: 'invalid-output', branch: 'parse:bad-label' }); else ledger.recordSuccess();
      }
    }
    now = NOW;
    return ledger;
  }

  it('never writes claim text', withDir(async (dir) => {
    const verifier = new CompletionClaimVerifier({ intelligence: provider('{bad json'), stateDir: dir, enabled: true, dryRun: true });
    await verifier.observe(SECRET_TEXT, evidence);
    const written = fs.readdirSync(path.join(dir, 'logs')).map((file) => fs.readFileSync(path.join(dir, 'logs', file), 'utf8')).join('');
    expect(written).toContain('parse:unparseable-json');
    expect(written).not.toContain('zebra');
  }));

  it('opens only when each of the 7 complete days is under 5%', withDir((dir) => {
    expect(seed(dir, () => ({ turns: 100, failed: 4 })).gate().met).toBe(true);
  }));
  it('holds at exactly 5%', withDir((dir) => {
    expect(seed(dir, (back) => ({ turns: 100, failed: back === 3 ? 5 : 0 })).gate().met).toBe(false);
  }));
  it('holds on a quiet day and on a missing day', withDir((dir) => {
    expect(seed(dir, (back) => ({ turns: back === 2 ? 19 : 100, failed: 0 })).gate().met).toBe(false);
    expect(new CompletionClaimFailureLedger({ stateDir: path.join(dir, 'empty'), now: () => NOW }).gate().met).toBe(false);
  }));
  it('ignores today, survives a restart, and a corrupt rollup keeps the gate closed', withDir((dir) => {
    seed(dir, () => ({ turns: 100, failed: 0 }));
    const reread = new CompletionClaimFailureLedger({ stateDir: dir, now: () => NOW });
    reread.recordFailure({ reason: 'provider-error', branch: 'provider' });
    expect(reread.gate().met).toBe(true);
    fs.writeFileSync(path.join(dir, 'logs', 'completion-claim-daily.json'), '{broken');
    expect(new CompletionClaimFailureLedger({ stateDir: dir, now: () => NOW }).gate().met).toBe(false);
  }));
});

describe('observe-only hold', () => {
  it('stays observe-only with dryRun false until the gate opens', withDir((dir) => {
    const off = new CompletionClaimVerifier({ intelligence: provider(OK), stateDir: dir, enabled: true, dryRun: false });
    expect(off.isObserveOnly()).toBe(true);
    const days: Record<string, unknown> = {};
    for (let back = 1; back <= 7; back++) days[new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10)] = { turns: 100, failed: 0, byReason: {} };
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs', 'completion-claim-daily.json'), JSON.stringify(days));
    expect(new CompletionClaimVerifier({ intelligence: provider(OK), stateDir: dir, enabled: true, dryRun: false }).isObserveOnly()).toBe(false);
    expect(new CompletionClaimVerifier({ intelligence: provider(OK), stateDir: dir, enabled: true, dryRun: true }).isObserveOnly()).toBe(true);
  }));

  it('records a turn that expired in the admission queue', withDir(async (dir) => {
    let now = 0;
    const admissionQueue = new ClaimObservationAdmissionQueue({ queueTtlMs: 10, maxConcurrent: 1, now: () => now });
    const verifier = new CompletionClaimVerifier({ intelligence: provider(OK), stateDir: dir, enabled: true, dryRun: true, admissionQueue });
    verifier.enqueue('I merged one', evidence);
    now = 100;
    await new Promise((resolve) => setImmediate(resolve));
    expect(verifier.readFailures()).toEqual([expect.objectContaining({ reason: 'queue-expired', branch: 'admission' })]);
  }));
});
