/**
 * CMT-2204: replay input for the UnjustifiedStopGate (the stop check).
 *
 * The gate's prompt is a pure function of (system template for the guard
 * setting, trusted evidence, guard-filtered untrusted content). With
 * `recordReplayInput` on, the provenance context gains content-free replay
 * identity and a credential-scrubbed capture under the machine-local
 * CONTENT_FULL_KEY; the prompt rebuilt from the capture must match
 * `replayPromptSha256`, and equals the prompt the model saw exactly when the
 * scrub changed nothing. Off, the context and prompt are byte-identical to
 * before. Either way the verdict is unchanged.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  assessStopGateReplayEligibility,
  buildStopGatePrompt,
  buildSystemPromptTemplate,
  rebuildStopGatePromptFromCapture,
  STOP_REPLAY_CAPTURE_VERSION,
  STOP_REPLAY_SCRUB_VERSION,
  UnjustifiedStopGate,
  type EvaluateInput,
  type StopGateReplayCapture,
} from '../../src/core/UnjustifiedStopGate.js';
import { buildStructuredSha256Identity, CONTENT_FULL_KEY, JudgmentProvenanceLog } from '../../src/core/JudgmentProvenanceLog.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPLY = JSON.stringify({
  decision: 'continue',
  rule: 'U2_PLAN_FILE_NEXT_STEP_EXPLICIT',
  rationale: 'plan file still has open steps',
  evidence_pointer: { plan_file: 'docs/plan.md' },
  cited_evidence: ['docs/plan.md'],
});

function recordingProvider() {
  const seen: { prompt?: string; context?: Record<string, unknown> } = {};
  const provider = {
    async evaluate(prompt: string, options?: Record<string, unknown>) {
      seen.prompt = prompt;
      seen.context = (options?.provenance as { context?: Record<string, unknown> } | undefined)?.context;
      return REPLY;
    },
  } as unknown as IntelligenceProvider;
  return { provider, seen };
}

function makeGate(provider: IntelligenceProvider, extra: Record<string, unknown> = {}) {
  return new UnjustifiedStopGate({
    intelligence: provider,
    clientTimeoutMs: 5_000,
    now: () => 1_700_000_000_000,
    ...extra,
  } as never);
}

const PLAIN_REASON = 'ZQ8_STOP_MARKER the plan is done, all steps merged';
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function input(reason = PLAIN_REASON, userTurn = 'please finish the plan'): EvaluateInput {
  return {
    evidenceMetadata: {
      artifacts: [{ path: 'docs/plan.md', createdThisSession: true, modifiedThisSession: true }],
      signals: { contextDeath: false },
      sessionStartTs: 1_699_999_000_000,
    },
    untrustedContent: {
      stopReason: reason,
      recentTurns: [
        { source: 'user', text: userTurn },
        { source: 'agent', text: 'ZQ8_TURN_MARKER finished step 3' },
      ],
    },
  };
}

describe('stop-gate replay-input capture (CMT-2204)', () => {
  for (const guard of [true, false]) {
    it(`capture on (guard=${guard}): the capture rebuilds the exact prompt the model saw`, async () => {
      const { provider, seen } = recordingProvider();
      const out = await makeGate(provider, { recordReplayInput: true, selfDeferralGuardEnabled: guard }).evaluate(input());
      expect(out.ok).toBe(true);
      const ctx = seen.context!;
      expect(ctx.captureVersion).toBe(STOP_REPLAY_CAPTURE_VERSION);
      expect(ctx.scrubVersion).toBe(STOP_REPLAY_SCRUB_VERSION);
      expect(ctx.promptSha256).toBe(buildStructuredSha256Identity(seen.prompt!));
      expect(ctx.scrubChanged).toBe(false);
      const capture = ctx[CONTENT_FULL_KEY] as StopGateReplayCapture;
      // Guard off strips user turns before the prompt; the capture is what the model saw.
      expect(capture.untrustedContent.recentTurns.some((t) => t.source === 'user')).toBe(guard);
      expect(rebuildStopGatePromptFromCapture(capture, guard)).toBe(seen.prompt);
      expect(assessStopGateReplayEligibility(ctx)).toEqual({ eligible: true, prompt: seen.prompt, exact: true, selfDeferralGuardEnabled: guard });
    });
  }

  it('a credential in the stop reason is scrubbed from the capture only — the model still sees the original', async () => {
    const { provider, seen } = recordingProvider();
    await makeGate(provider, { recordReplayInput: true, selfDeferralGuardEnabled: true })
      .evaluate(input(`stopping, token ${SECRET} rotated`, `my key is ${SECRET}`));
    expect(seen.prompt).toContain(SECRET);
    const ctx = seen.context!;
    expect(JSON.stringify(ctx)).not.toContain(SECRET);
    expect(ctx.scrubChanged).toBe(true);
    const verdict = assessStopGateReplayEligibility(ctx);
    expect(verdict.eligible).toBe(true);
    expect(verdict.eligible && verdict.exact).toBe(false);
  });

  it('removes private key blocks from both replay text fields', async () => {
    const keyBody = 'QUJDREVGRw==';
    const pem = ['-----BEGIN PRIVATE KEY-----', keyBody, '-----END PRIVATE KEY-----'].join('\n');
    const { provider, seen } = recordingProvider();
    await makeGate(provider, { recordReplayInput: true, selfDeferralGuardEnabled: true })
      .evaluate(input(pem, pem));
    const captured = JSON.stringify(seen.context);
    expect(captured).toContain('REDACTED');
    expect(captured).not.toContain(keyBody);
    expect(captured).not.toContain('BEGIN PRIVATE KEY');
  });

  it('the served contextRedacted never carries the captured text', async () => {
    const { provider, seen } = recordingProvider();
    await makeGate(provider, { recordReplayInput: true, selfDeferralGuardEnabled: true }).evaluate(input());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-replay-unit-'));
    try {
      const jpl = new JudgmentProvenanceLog({ dir, log: () => {} });
      jpl.recordDecision({ component: 'UnjustifiedStopGate', decisionPoint: 'unjustified-stop-gate',
        context: seen.context!, decision: 'x' } as never);
      await jpl.flush();
      const served = JSON.stringify(await jpl.readRedacted({ limit: 10 }));
      expect(served).not.toContain('ZQ8_STOP_MARKER');
      expect(served).not.toContain('ZQ8_TURN_MARKER');
      expect(served).toContain(STOP_REPLAY_CAPTURE_VERSION);
      const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'))!;
      const row = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n')[0]);
      expect(JSON.stringify(row.contextFull)).toContain('ZQ8_STOP_MARKER');
      expect(assessStopGateReplayEligibility(row.contextFull, { rowTruncated: row.truncated }).eligible).toBe(true);
      await jpl.close();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/stop-gate-replay-input-capture.test.ts' });
    }
  });

  it('capture off: context carries no replay fields and the prompt is unchanged', async () => {
    for (const opts of [{}, { recordReplayInput: false }]) {
      const { provider, seen } = recordingProvider();
      await makeGate(provider, { ...opts, selfDeferralGuardEnabled: true }).evaluate(input());
      const ctx = seen.context!;
      for (const k of [CONTENT_FULL_KEY, 'promptSha256', 'replayPromptSha256', 'scrubChanged', 'captureVersion', 'scrubVersion']) {
        expect(ctx[k]).toBeUndefined();
      }
      expect(Object.keys(ctx).sort()).toEqual([
        'artifactCount', 'artifactKinds', 'metaSelfReferenceHint', 'recentTurnChars', 'recentTurnCount',
        'selfDeferralGuardEnabled', 'sessionStartTs', 'signals', 'stopReasonChars', 'stopReasonSha256',
      ]);
      const i = input();
      expect(seen.prompt).toBe(buildStopGatePrompt(buildSystemPromptTemplate(true), i.evidenceMetadata, i.untrustedContent));
    }
  });

  it('the switch never changes the prompt or the verdict', async () => {
    const a = recordingProvider();
    const b = recordingProvider();
    const off = await makeGate(a.provider, { selfDeferralGuardEnabled: true }).evaluate(input());
    const on = await makeGate(b.provider, { recordReplayInput: true, selfDeferralGuardEnabled: true }).evaluate(input());
    expect(b.seen.prompt).toBe(a.seen.prompt);
    const strip = (o: typeof off) => (o.ok ? { ...o.result, latencyMs: 0 } : o);
    expect(strip(on)).toEqual(strip(off));
  });

  it('never silently accepts a row that cannot be replayed', async () => {
    const { provider, seen } = recordingProvider();
    await makeGate(provider, { recordReplayInput: true, selfDeferralGuardEnabled: true }).evaluate(input());
    const ctx = seen.context!;
    const capture = ctx[CONTENT_FULL_KEY] as StopGateReplayCapture;
    expect(assessStopGateReplayEligibility(ctx, { rowTruncated: true })).toEqual({ eligible: false, reason: 'row-truncated' });
    expect(assessStopGateReplayEligibility({ truncated: true, head: '{}' })).toEqual({ eligible: false, reason: 'row-truncated' });
    expect(assessStopGateReplayEligibility({ stopReasonSha256: 'x' })).toEqual({ eligible: false, reason: 'no-capture' });
    expect(assessStopGateReplayEligibility(null)).toEqual({ eligible: false, reason: 'no-capture' });
    expect(assessStopGateReplayEligibility({ ...ctx, captureVersion: 'capture-failed' })).toEqual({ eligible: false, reason: 'unknown-capture-version' });
    expect(assessStopGateReplayEligibility({ ...ctx, [CONTENT_FULL_KEY]: { evidenceMetadata: {} } })).toEqual({ eligible: false, reason: 'malformed-capture' });
    expect(assessStopGateReplayEligibility({ ...ctx, [CONTENT_FULL_KEY]: {
      ...capture, untrustedContent: { ...capture.untrustedContent, stopReason: `${capture.untrustedContent.stopReason} edited` },
    } })).toEqual({ eligible: false, reason: 'sha-mismatch' });
    expect(assessStopGateReplayEligibility({ ...ctx, selfDeferralGuardEnabled: false })).toEqual({ eligible: false, reason: 'sha-mismatch' });
  });
});
