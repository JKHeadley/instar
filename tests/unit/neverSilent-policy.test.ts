import { describe, it, expect } from 'vitest';
import { decideNeverSilentAction, renderNotice, type PolicyInput } from '../../src/monitoring/neverSilent/NeverSilentPolicy.js';

const base: PolicyInput = {
  silenceClass: 'engine-login',
  confidence: 0.95,
  truncated: false,
  actionsSinceMessage: 'none',
  pinned: false,
  actionsEnabled: true,
  frameworkFallbackEnabled: true,
  confidenceFloor: 0.8,
  sameEngineHealthy: false,
  fallbackEngine: 'codex-cli',
  swapTried: false,
  protectedSession: false,
  recentlyRestored: false,
};

describe('never-silent class → action table (§3.3)', () => {
  it('unpinned, no other Claude account, Codex signed in → automatic engine move', () => {
    expect(decideNeverSilentAction(base)).toMatchObject({ action: 'fallback', target: 'codex-cli' });
  });
  it('pinned conversation is asked, never moved (Frontloaded Decision 2)', () => {
    expect(decideNeverSilentAction({ ...base, pinned: true })).toMatchObject({ action: 'ask-fallback', target: 'codex-cli' });
  });
  it('another signed-in account on the same engine → swap first', () => {
    expect(decideNeverSilentAction({ ...base, sameEngineHealthy: true }).action).toBe('swap');
  });
  it('after a swap was tried, the engine move is next', () => {
    expect(decideNeverSilentAction({ ...base, sameEngineHealthy: true, swapTried: true }).action).toBe('fallback');
  });
  it('confidence at the floor acts; just below the floor only tells', () => {
    expect(decideNeverSilentAction({ ...base, confidence: 0.8 }).action).toBe('fallback');
    expect(decideNeverSilentAction({ ...base, confidence: 0.79 }).action).toBe('tell');
  });
  it('a verdict on cut screen text is capped at tell', () => {
    expect(decideNeverSilentAction({ ...base, truncated: true }).action).toBe('tell');
  });
  it('actions off ⇒ tell (the dark default)', () => {
    expect(decideNeverSilentAction({ ...base, actionsEnabled: false }).action).toBe('tell');
  });
  it('engine fallback switch off ⇒ tell', () => {
    expect(decideNeverSilentAction({ ...base, frameworkFallbackEnabled: false }).action).toBe('tell');
  });
  it('no other engine (breaker: every engine tried) ⇒ tell', () => {
    expect(decideNeverSilentAction({ ...base, fallbackEngine: null }).action).toBe('tell');
  });
  it('replay boundary: effectful or unknown history is asked, read-only/none moves', () => {
    expect(decideNeverSilentAction({ ...base, actionsSinceMessage: 'some' }).action).toBe('ask-fallback');
    expect(decideNeverSilentAction({ ...base, actionsSinceMessage: 'unknown' }).action).toBe('ask-fallback');
    expect(decideNeverSilentAction({ ...base, actionsSinceMessage: 'read-only' }).action).toBe('fallback');
    expect(decideNeverSilentAction({ ...base, sameEngineHealthy: true, actionsSinceMessage: 'some' }).action).toBe('tell');
  });
  it('working-slow waits; other non-recoverable classes tell', () => {
    expect(decideNeverSilentAction({ ...base, silenceClass: 'working-slow' }).action).toBe('wait');
    for (const c of ['startup-dialog', 'crashed', 'message-not-delivered', 'other', 'undetermined'] as const) {
      expect(decideNeverSilentAction({ ...base, silenceClass: c }).action).toBe('tell');
    }
  });
  it('protected sessions are only told; a recent move back asks', () => {
    expect(decideNeverSilentAction({ ...base, protectedSession: true }).action).toBe('tell');
    expect(decideNeverSilentAction({ ...base, recentlyRestored: true }).action).toBe('ask-fallback');
  });
  it('a usage wall follows the same path as a login failure', () => {
    expect(decideNeverSilentAction({ ...base, silenceClass: 'usage-or-subscription-wall' }).action).toBe('fallback');
  });
});

describe('never-silent notices (fixed templates)', () => {
  it('waiting notice batches several messages and names no cause', () => {
    const t = renderNotice({ kind: 'waiting', count: 3, silenceClass: 'undetermined', framework: 'claude-code', action: null, outcome: null });
    expect(t).toMatch(/^Your last 3 messages weren't answered yet/);
    expect(t).toMatch(/tell you here/);
  });
  it('status notice after an automatic move says what happened and that it moves back', () => {
    const t = renderNotice({ kind: 'status', count: 1, silenceClass: 'engine-login', framework: 'claude-code', action: 'fallback', outcome: 'succeeded', target: 'codex-cli', repairStarted: true });
    expect(t).toContain('the Claude sign-in this conversation uses ran out');
    expect(t).toContain('moved this conversation to Codex');
    expect(t).toContain('started the Claude sign-in repair');
    expect(t).toContain('goes back to Claude at its next restart');
  });
  it('the pinned ask says it was not moved, offers the tap, and the no-tap outcome', () => {
    const t = renderNotice({ kind: 'status', count: 1, silenceClass: 'engine-login', framework: 'claude-code', action: 'ask-fallback', outcome: 'started', target: 'codex-cli', askReason: 'pinned' });
    expect(t).toContain('You set this conversation to Claude');
    expect(t).toContain('Tap below to move it to Codex');
    expect(t).toContain('Otherwise it stays on Claude');
  });
  it('the replay ask gives the replay reason instead of a pin', () => {
    const t = renderNotice({ kind: 'status', count: 1, silenceClass: 'engine-login', framework: 'claude-code', action: 'ask-fallback', outcome: 'started', target: 'codex-cli', askReason: 'replay' });
    expect(t).toContain('already started acting on your message');
    expect(t).not.toContain('You set this conversation');
  });
  it('never leaks internal words', () => {
    const t = renderNotice({ kind: 'status', count: 2, silenceClass: 'usage-or-subscription-wall', framework: 'codex-cli', action: 'tell', outcome: null });
    expect(t).not.toMatch(/codex-cli|claude-code|framework|judge|incident|confidence/);
  });
});
