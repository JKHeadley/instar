/**
 * Tier-1 unit tests for MentorStageA — the structural two-hats boundary
 * (FRAMEWORK-ONBOARDING-MENTOR-SPEC §4, §19.3).
 *
 * The leakage detector ships with a positive-control (a known-leaked transcript
 * MUST trip the flag) so a dead/no-op detector is distinguishable from a clean
 * run — the same anti-pattern guard the rest of the system uses.
 */
import { describe, it, expect } from 'vitest';
import {
  STAGE_A_ALLOWED_TOOLS,
  buildStageAContext,
  detectStageALeak,
  runLeakCanary,
  leakToFinding,
  surfaceText,
  type ConversationSurface,
} from '../../src/monitoring/MentorStageA.js';

const baseSurface: ConversationSurface = {
  framework: 'codex-cli',
  threadlineHistory: 'Echo: how is the task going?\nCodey: making progress, hit a snag on the parser.',
  assignedTaskStatus: 'working on the parity-rule backlog item',
  openCommitments: ['ship the X primitive'],
  timeSinceLastContactMs: 12 * 60_000,
};

describe('STAGE_A_ALLOWED_TOOLS — structural tool grant', () => {
  it('is EMPTY (conversation surface is injected, never fetched)', () => {
    expect(STAGE_A_ALLOWED_TOOLS).toEqual([]);
  });
  it('denies every internals tool by construction', () => {
    for (const forbidden of ['Bash', 'Write', 'Edit', 'Read', 'Grep', 'Glob']) {
      expect(STAGE_A_ALLOWED_TOOLS).not.toContain(forbidden);
    }
  });
});

describe('buildStageAContext — only the conversation surface', () => {
  it('includes the conversation and visible task status', () => {
    const ctx = buildStageAContext(baseSurface);
    expect(ctx).toContain('how is the task going');
    expect(ctx).toContain('parity-rule backlog');
    expect(ctx).toContain('ship the X primitive');
    expect(ctx).toContain('codex-cli');
  });
  it('carries the two-hats preamble (blind to internals, one action, untrusted input)', () => {
    const ctx = buildStageAContext(baseSurface);
    expect(ctx).toMatch(/NO access to their logs, code, rollouts/i);
    expect(ctx).toMatch(/unblock \| answer \| assign-next \| observe-only/);
    expect(ctx).toMatch(/untrusted/i);
  });
  it('handles an empty surface without throwing', () => {
    const ctx = buildStageAContext({ framework: 'cursor', threadlineHistory: '' });
    expect(ctx).toContain('no prior conversation');
    expect(ctx).toContain('no task assigned yet');
  });
});

describe('detectStageALeak — the mandatory leakage detector (§4.3)', () => {
  it('flags a transcript referencing internals not in the surface (code path)', () => {
    const r = detectStageALeak('You should fix src/messaging/Retry.ts:142 — the backoff is wrong.', baseSurface);
    expect(r.leaked).toBe(true);
    expect(r.hits.some((h) => h.includes('Retry.ts'))).toBe(true);
  });

  it('flags rollout / log / PR / SHA references', () => {
    expect(detectStageALeak('saw it in rollout-2026.jsonl', baseSurface).leaked).toBe(true);
    expect(detectStageALeak('check logs/server.log', baseSurface).leaked).toBe(true);
    expect(detectStageALeak('that regressed in PR #412', baseSurface).leaked).toBe(true);
    expect(detectStageALeak('commit a1b2c3d4e5 broke it', baseSurface).leaked).toBe(true);
  });

  it('does NOT flag clean conversational text (no false positive)', () => {
    const r = detectStageALeak('Nice progress! How is the parser snag going — still stuck, or ready for the next one?', baseSurface);
    expect(r.leaked).toBe(false);
    expect(r.hits).toHaveLength(0);
  });

  it('does NOT flag an internal reference the USER legitimately put in the surface', () => {
    const surfaceWithPR: ConversationSurface = {
      ...baseSurface,
      threadlineHistory: baseSurface.threadlineHistory + '\nCodey: I opened PR #412 for it.',
    };
    // Stage A echoing "PR #412" is fine — it came from the conversation, not a leak.
    const r = detectStageALeak('Great, I see PR #412 is up — anything blocking the merge?', surfaceWithPR);
    expect(r.leaked).toBe(false);
  });

  it('POSITIVE CONTROL: the canary trips the detector (proves it is alive)', () => {
    expect(runLeakCanary()).toBe(true);
  });
});

describe('surfaceText', () => {
  it('flattens only surface fields (no internals channel exists)', () => {
    const t = surfaceText(baseSurface);
    expect(t).toContain('codex-cli');
    expect(t).toContain('parity-rule backlog');
    expect(t).not.toContain('src/');
  });
});

describe('leakToFinding — dog-fooding a leak into the ledger (§4.3)', () => {
  it('produces a high-severity instar-integration-gap finding with opaque evidence', () => {
    const result = detectStageALeak('fix src/foo.ts:10 per PR #500', baseSurface);
    const finding = leakToFinding('codex-cli', result, 'tick-7');
    expect(finding.bucket).toBe('instar-integration-gap');
    expect(finding.severity).toBe('high');
    expect(finding.dedupKey).toBe('codex-cli::stage-a-leak');
    expect(finding.evidence).toContain('tick=tick-7');
    // Evidence carries reference SHAPES, not log/code content.
    expect(finding.evidence).not.toMatch(/backoff|content of/i);
  });
});
