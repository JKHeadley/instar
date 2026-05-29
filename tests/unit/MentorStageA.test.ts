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
  buildConversationSurface,
  parseMenteeReplies,
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

// Active task-driving: the onboarding agenda lets an idle mentee get a concrete
// next task instead of a low-signal observe-only. The agenda is the mentor's own
// plan (surface-legitimate), and an empty agenda must leave behaviour unchanged.
describe('onboardingAgenda — active task-driving in the Stage-A prompt', () => {
  it('omits the agenda block entirely when no agenda is configured (unchanged passive behaviour)', () => {
    const ctx = buildStageAContext(baseSurface);
    expect(ctx).not.toMatch(/onboarding agenda/i);
    expect(ctx).not.toMatch(/assign-next and give them the NEXT agenda item/i);
  });

  it('includes the agenda + assign-next steering when an agenda is present', () => {
    const ctx = buildStageAContext({
      ...baseSurface,
      onboardingAgenda: ['Verify the Secret Drop flow end to end', 'Exercise the Playbook add/search'],
    });
    expect(ctx).toMatch(/onboarding agenda/i);
    expect(ctx).toContain('Verify the Secret Drop flow end to end');
    expect(ctx).toContain('Exercise the Playbook add/search');
    expect(ctx).toMatch(/assign-next/);
    expect(ctx).toMatch(/Only choose observe-only if they are mid-task or the/);
  });

  it('counts agenda items as surface-legitimate (assigning one is NOT a leak)', () => {
    const surface: ConversationSurface = {
      framework: 'codex-cli',
      threadlineHistory: 'Mentee: done with the last one.',
      onboardingAgenda: ['Check the Attention queue at /attention'],
    };
    // The mentor assigns the agenda item verbatim — must not trip the leak detector.
    const transcript = 'Next up: please check the Attention queue at /attention and tell me what you see.';
    expect(detectStageALeak(transcript, surface).leaked).toBe(false);
    // surfaceText carries the agenda text.
    expect(surfaceText(surface)).toContain('Check the Attention queue at /attention');
  });
});

describe('buildConversationSurface — real surface from agenda + mentee replies', () => {
  const NOW = 1_780_000_600_000;

  it('formats mentee replies into threadlineHistory and computes time-since-last-contact', () => {
    const s = buildConversationSurface({
      framework: 'codex-cli',
      menteeReplies: [
        { ts: NOW - 600_000, message: 'Started on the parser task.' },
        { ts: NOW - 120_000, message: 'Opened PR, it is green.' },
      ],
      nowMs: NOW,
    });
    expect(s.threadlineHistory).toBe('Mentee: Started on the parser task.\nMentee: Opened PR, it is green.');
    expect(s.timeSinceLastContactMs).toBe(120_000); // newest reply
    expect(s.onboardingAgenda).toBeUndefined();
  });

  it('sets onboardingAgenda when provided and caps history to maxReplies (most recent)', () => {
    const replies = Array.from({ length: 12 }, (_, i) => ({ ts: NOW - (12 - i) * 1000, message: `r${i}` }));
    const s = buildConversationSurface({
      framework: 'codex-cli',
      onboardingAgenda: ['task A', 'task B'],
      menteeReplies: replies,
      nowMs: NOW,
      maxReplies: 3,
    });
    expect(s.onboardingAgenda).toEqual(['task A', 'task B']);
    expect(s.threadlineHistory).toBe('Mentee: r9\nMentee: r10\nMentee: r11'); // last 3, sorted by ts
  });

  it('empty replies → empty history, no timeSinceLastContact (degrades to "no prior conversation")', () => {
    const s = buildConversationSurface({ framework: 'codex-cli', menteeReplies: [], nowMs: NOW });
    expect(s.threadlineHistory).toBe('');
    expect(s.timeSinceLastContactMs).toBeUndefined();
    // buildStageAContext renders the empty history as the no-conversation sentinel.
    expect(buildStageAContext(s)).toContain('(no prior conversation)');
  });
});

describe('parseMenteeReplies — defensive JSONL parsing for the surface', () => {
  it('parses well-formed lines, coerces string ts, and drops blanks/garbage/empty-message', () => {
    const raw = [
      JSON.stringify({ ts: '1780000000000', fromAgent: 'instar-codey', message: 'hello' }),
      '   ',
      'not json at all',
      JSON.stringify({ ts: 1780000005000, fromAgent: 'instar-codey', message: '   ' }), // empty msg → dropped
      JSON.stringify({ fromAgent: 'instar-codey', message: 'no ts' }), // no ts → dropped
      JSON.stringify({ ts: 1780000010000, fromAgent: 'instar-codey', message: 'world' }),
    ].join('\n');
    const out = parseMenteeReplies(raw, 'instar-codey');
    expect(out).toEqual([
      { ts: 1780000000000, message: 'hello' },
      { ts: 1780000010000, message: 'world' },
    ]);
  });

  it('filters to the named mentee when fromAgent is present', () => {
    const raw = [
      JSON.stringify({ ts: 1, fromAgent: 'instar-codey', message: 'mine' }),
      JSON.stringify({ ts: 2, fromAgent: 'instar-other', message: 'theirs' }),
    ].join('\n');
    expect(parseMenteeReplies(raw, 'instar-codey')).toEqual([{ ts: 1, message: 'mine' }]);
  });

  it('never throws on empty input', () => {
    expect(parseMenteeReplies('')).toEqual([]);
  });
});
