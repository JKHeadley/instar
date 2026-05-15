/**
 * Unit tests — Burn-detection Phase 2 (AttributionResolver).
 *
 * Covers the Phase 2 deliverables from docs/specs/token-burn-detection-and-self-heal.md:
 *   - resolveAttribution maps each manifest entry to a component::<fp> key
 *   - scheduled-job cwd produces user-job:<name>::<fp>
 *   - user-hook cwd produces user-hook:<name>::<fp>
 *   - unknown events fall back to unknown::<sessionPrefix>
 *   - prompt-match precedence over cwd-match (manifest first)
 */

import { describe, it, expect } from 'vitest';
import { resolveAttribution } from '../../src/monitoring/AttributionResolver.js';
import { ATTRIBUTION_MANIFEST } from '../../src/monitoring/attribution-manifest.js';

describe('AttributionResolver — manifest hits', () => {
  it('catches today\'s bleed: InputDetector "analyzing terminal output"', () => {
    const key = resolveAttribution({
      sessionId: 'sess-abc',
      prompt: 'analyzing terminal output from a Claude Code AI agent session',
    });
    expect(key).toMatch(/^InputDetector::[0-9a-f]{8}$/);
  });

  it('catches the alternate InputDetector phrasing ("is this stuck")', () => {
    const key = resolveAttribution({ sessionId: 's', prompt: 'is this stuck?' });
    expect(key).toMatch(/^InputDetector::[0-9a-f]{8}$/);
  });

  it('maps MessagingToneGate prompts', () => {
    const key = resolveAttribution({ sessionId: 's', prompt: 'Evaluate this outbound message for ELI16 compliance' });
    expect(key.startsWith('MessagingToneGate::')).toBe(true);
  });

  it('maps CommitmentSentinel prompts', () => {
    const key = resolveAttribution({ sessionId: 's', prompt: 'unfulfilled commitment detected' });
    expect(key.startsWith('CommitmentSentinel::')).toBe(true);
  });

  it('maps MessageSentinel prompts', () => {
    const key = resolveAttribution({ sessionId: 's', prompt: 'classify this inbound message' });
    expect(key.startsWith('MessageSentinel::')).toBe(true);
  });

  it('maps StallTriageNurse prompts', () => {
    const key = resolveAttribution({ sessionId: 's', prompt: 'session stall classifier' });
    expect(key.startsWith('StallTriageNurse::')).toBe(true);
  });

  it('maps CoherenceReviewer prompts', () => {
    const key = resolveAttribution({ sessionId: 's', prompt: 'agent coherence assessment' });
    expect(key.startsWith('CoherenceReviewer::')).toBe(true);
  });

  it('maps ProjectDriftChecker prompts', () => {
    const key = resolveAttribution({ sessionId: 's', prompt: 'project drift detection' });
    expect(key.startsWith('ProjectDriftChecker::')).toBe(true);
  });

  it('maps ResumeValidator prompts', () => {
    const key = resolveAttribution({ sessionId: 's', prompt: 'validate the resume payload' });
    expect(key.startsWith('ResumeValidator::')).toBe(true);
  });

  it('maps TopicLinkageHandler prompts', () => {
    const key = resolveAttribution({ sessionId: 's', prompt: 'topic linkage decision' });
    expect(key.startsWith('TopicLinkageHandler::')).toBe(true);
  });

  it('first-match wins — bleeding pattern caught before generic stall pattern', () => {
    // InputDetector listed before StallTriageNurse in manifest, so a prompt
    // that matches both should attribute to InputDetector.
    const key = resolveAttribution({
      sessionId: 's',
      prompt: 'analyzing terminal output to triage stalled session',
    });
    expect(key.startsWith('InputDetector::')).toBe(true);
  });
});

describe('AttributionResolver — cwd-based inference', () => {
  it('scheduled-job cwd produces user-job:<name>', () => {
    const key = resolveAttribution({
      sessionId: 's',
      projectPath: '/Users/x/.instar/jobs/daily-summary',
      prompt: 'any prompt that does not match a manifest entry',
    });
    expect(key.startsWith('user-job:daily-summary::')).toBe(true);
  });

  it('windows-style backslash paths also resolve', () => {
    const key = resolveAttribution({
      sessionId: 's',
      projectPath: 'C:\\Users\\x\\.instar\\jobs\\nightly-poll',
      prompt: 'something unrelated',
    });
    expect(key.startsWith('user-job:nightly-poll::')).toBe(true);
  });

  it('hook cwd under .claude/hooks/ produces user-hook:<filename>', () => {
    const key = resolveAttribution({
      sessionId: 's',
      projectPath: '/Users/x/project/.claude/hooks/SessionStart',
      prompt: 'some hook prompt',
    });
    expect(key.startsWith('user-hook:SessionStart::')).toBe(true);
  });

  it('hook cwd under .instar/hooks/ produces user-hook:<filename>', () => {
    const key = resolveAttribution({
      sessionId: 's',
      projectPath: '/Users/x/agent/.instar/hooks/foo.js',
      prompt: 'hook firing',
    });
    expect(key.startsWith('user-hook:foo.js::')).toBe(true);
  });
});

describe('AttributionResolver — fallback', () => {
  it('unknown session falls back to unknown::<sessionPrefix> (8-char prefix)', () => {
    const key = resolveAttribution({ sessionId: 'session-abc-12345', prompt: 'something nobody recognises' });
    expect(key).toBe('unknown::session-');
  });

  it('missing sessionId falls back to unknown::no-session', () => {
    const key = resolveAttribution({ sessionId: '', prompt: 'unknown' });
    expect(key).toBe('unknown::no-session');
  });

  it('no prompt + no cwd → unknown::<sessionPrefix>', () => {
    const key = resolveAttribution({ sessionId: 'xyz123abc' });
    expect(key).toBe('unknown::xyz123ab');
  });

  it('prompt that matches no manifest entry falls back to cwd / unknown', () => {
    const key = resolveAttribution({
      sessionId: 'sxxx',
      prompt: 'this is a free-form prompt that does not match anything',
    });
    expect(key).toBe('unknown::sxxx');
  });
});

describe('AttributionResolver — manifest integrity', () => {
  it('every manifest entry has a non-empty component name', () => {
    for (const entry of ATTRIBUTION_MANIFEST) {
      expect(entry.component.length).toBeGreaterThan(0);
    }
  });

  it('every manifest entry has at least one matcher (prompt, cwd, or model)', () => {
    for (const entry of ATTRIBUTION_MANIFEST) {
      const hasMatcher =
        (entry.promptPatterns && entry.promptPatterns.length > 0) ||
        (entry.cwdPatterns && entry.cwdPatterns.length > 0) ||
        (entry.modelHints && entry.modelHints.length > 0);
      expect(hasMatcher).toBe(true);
    }
  });

  it('component names are unique', () => {
    const names = ATTRIBUTION_MANIFEST.map((e) => e.component);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
