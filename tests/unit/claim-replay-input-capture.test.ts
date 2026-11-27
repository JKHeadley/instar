/**
 * CMT-1679: exact replay input for completion-claim-verify.
 *
 * The arbiter prompt is a pure function of (scrubbed message, bounded evidence,
 * includeGeneral). With `recordReplayInput` on, the provenance context gains a
 * content-free prompt sha and the two inputs go under the machine-local
 * CONTENT_FULL_KEY; the rebuilt prompt's sha must equal the recorded one. Off, the
 * context must be byte-identical to what it was before this feature.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  assessClaimReplayEligibility,
  buildClaimArbiterPrompt,
  buildCompletionClaimDecisionContext,
  ClaimClauseArbiter,
  CLAIM_REPLAY_CAPTURE_VERSION,
  rebuildClaimArbiterPromptFromCapture,
  splitClaimClauses,
} from '../../src/monitoring/ClaimClauseArbiter.js';
import { prepareClaimObservation } from '../../src/monitoring/ClaimObservation.js';
import { buildStructuredSha256Identity, CONTENT_FULL_KEY, JudgmentProvenanceLog } from '../../src/core/JudgmentProvenanceLog.js';
import type { TurnEvidence } from '../../src/monitoring/TurnEvidence.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const RAW_MESSAGE = 'ZQ7_REPLAY_MARKER merged the fix to https://example.com/pr/1 and I will report back once CI is green.';
const RAW_EVIDENCE: TurnEvidence = {
  hadToolCalls: true, truncated: false, unavailable: false, canaryOk: true,
  toolCalls: [{ tool: 'Bash', actionKind: 'merged', ok: true, targetSummary: 'gh pr merge 42' }],
};
const REPLY = JSON.stringify({ legacy: { clauses: [
  { clauseId: 0, label: 'completed-or-in-progress-assertion', actionKind: 'merged', completionScope: 'this-turn', corroborated: true, rationale: 'x' },
] } });

function recordingProvider(framework = 'claude-code') {
  const seen: { prompt?: string; context?: Record<string, unknown> } = {};
  const provider = {
    async evaluate(prompt: string, options?: Record<string, unknown>) {
      seen.prompt = prompt;
      seen.context = (options?.provenance as { context?: Record<string, unknown> } | undefined)?.context;
      (options?.onModel as ((i: { model: string; framework?: string }) => void) | undefined)?.({ model: 'm', framework });
      return REPLY;
    },
  } as unknown as IntelligenceProvider;
  return { provider, seen };
}

const prepared = () => {
  const p = prepareClaimObservation(RAW_MESSAGE, RAW_EVIDENCE);
  if (p.policy !== 'standard-scrubbed') throw new Error('fixture must pass the scrub');
  return p;
};

describe('completion-claim replay-input capture (CMT-1679)', () => {
  for (const includeGeneral of [true, false]) {
    it(`capture on (includeGeneral=${includeGeneral}): contentFull holds the inputs and the rebuilt sha matches`, async () => {
      const { provider, seen } = recordingProvider();
      const arbiter = new ClaimClauseArbiter({ intelligence: provider, recordReplayInput: true,
        resolveFramework: () => (includeGeneral ? 'claude-code' : 'codex-cli') });
      const p = prepared();
      await arbiter.arbitrate(p.message, p.evidence);
      const ctx = seen.context!;
      expect(ctx[CONTENT_FULL_KEY]).toEqual({ message: p.message, evidence: p.evidence });
      expect(ctx.captureVersion).toBe(CLAIM_REPLAY_CAPTURE_VERSION);
      expect(ctx.scrubVersion).toBe(p.scrubVersion);
      expect(ctx.includeGeneral).toBe(includeGeneral);
      expect(ctx.incumbentLabelsRecorded).toBe(false);
      // The recorded sha is the sha of the prompt actually sent.
      expect(ctx.promptSha256).toBe(buildStructuredSha256Identity(seen.prompt!));
      const rebuilt = rebuildClaimArbiterPromptFromCapture(ctx[CONTENT_FULL_KEY] as { message: string; evidence: TurnEvidence }, includeGeneral);
      expect(rebuilt).toBe(seen.prompt);
      expect(assessClaimReplayEligibility(ctx)).toEqual({ eligible: true, prompt: seen.prompt, includeGeneral });
    });
  }

  it('the served contextRedacted never carries the message text', async () => {
    const { provider, seen } = recordingProvider();
    const arbiter = new ClaimClauseArbiter({ intelligence: provider, recordReplayInput: true });
    const p = prepared();
    await arbiter.arbitrate(p.message, p.evidence);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-replay-unit-'));
    try {
      const jpl = new JudgmentProvenanceLog({ dir, log: () => {} });
      jpl.recordDecision({ component: 'completion-claim-verify', decisionPoint: 'completion-claim-verify',
        context: seen.context!, decision: 'x' } as never);
      await jpl.flush();
      const served = JSON.stringify(await jpl.readRedacted({ limit: 10 }));
      expect(served).not.toContain('ZQ7_REPLAY_MARKER');
      expect(served).not.toContain('report back');
      expect(served).toContain('claim-replay-input-v1');
      // ...while the machine-local file row keeps the capture and still passes parity.
      const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'))!;
      const row = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n')[0]);
      expect(JSON.stringify(row.contextFull)).toContain('ZQ7_REPLAY_MARKER');
      expect(assessClaimReplayEligibility(row.contextFull, { rowTruncated: row.truncated }).eligible).toBe(true);
      await jpl.close();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/claim-replay-input-capture.test.ts' });
    }
  });

  it('capture off: the provenance context is byte-identical to the pre-feature context', async () => {
    for (const opts of [{}, { recordReplayInput: false }]) {
      const { provider, seen } = recordingProvider();
      const arbiter = new ClaimClauseArbiter({ intelligence: provider, ...opts });
      const p = prepared();
      await arbiter.arbitrate(p.message, p.evidence);
      const before = buildCompletionClaimDecisionContext({ message: p.message, clauses: splitClaimClauses(p.message), evidence: p.evidence });
      expect(JSON.stringify(seen.context)).toBe(JSON.stringify(before));
      expect(seen.context![CONTENT_FULL_KEY]).toBeUndefined();
      expect(seen.context!.promptSha256).toBeUndefined();
      // And the prompt itself is unchanged by the capture switch.
      expect(seen.prompt).toBe(buildClaimArbiterPrompt(splitClaimClauses(p.message), p.evidence, p.message, { includeGeneral: true }));
    }
  });

  it('never silently accepts a row that cannot be replayed', async () => {
    const { provider, seen } = recordingProvider();
    await new ClaimClauseArbiter({ intelligence: provider, recordReplayInput: true }).arbitrate(prepared().message, prepared().evidence);
    const ctx = seen.context!;
    const captured = ctx[CONTENT_FULL_KEY] as { message: string; evidence: TurnEvidence };
    expect(assessClaimReplayEligibility(ctx, { rowTruncated: true })).toEqual({ eligible: false, reason: 'row-truncated' });
    expect(assessClaimReplayEligibility({ truncated: true, head: '{}' })).toEqual({ eligible: false, reason: 'row-truncated' });
    expect(assessClaimReplayEligibility({ sliceHash: 'x' })).toEqual({ eligible: false, reason: 'no-capture' });
    expect(assessClaimReplayEligibility(null)).toEqual({ eligible: false, reason: 'no-capture' });
    expect(assessClaimReplayEligibility({ ...ctx, captureVersion: 'claim-replay-input-v0' })).toEqual({ eligible: false, reason: 'unknown-capture-version' });
    expect(assessClaimReplayEligibility({ ...ctx, [CONTENT_FULL_KEY]: { message: 1 } })).toEqual({ eligible: false, reason: 'malformed-capture' });
    expect(assessClaimReplayEligibility({ ...ctx, [CONTENT_FULL_KEY]: { ...captured, message: `${captured.message} edited` } }))
      .toEqual({ eligible: false, reason: 'sha-mismatch' });
    expect(assessClaimReplayEligibility({ ...ctx, includeGeneral: !ctx.includeGeneral })).toEqual({ eligible: false, reason: 'sha-mismatch' });
  });
});
