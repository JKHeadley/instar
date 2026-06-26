/**
 * ColdStartFallbackReply (G1 — "The Agent Is Always Reachable", corollary 2:
 * no silent resource rejection). Unit-tests the pure message builder both sides
 * of every decision boundary: the three failure classifications, the three
 * Lifeline states (other-topic / same-topic / unconfigured), spawn vs restart
 * wording, and the no-dev-jargon-leak guarantee.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyColdStartFailure,
  buildColdStartDebugMessage,
  buildColdStartFallbackReply,
} from '../../src/messaging/ColdStartFallbackReply.js';

describe('classifyColdStartFailure', () => {
  it('classifies session-limit errors', () => {
    expect(classifyColdStartFailure(new Error('Max sessions (5) reached. Close one first.'))).toBe('session-limit');
    expect(classifyColdStartFailure('session limit reached')).toBe('session-limit');
  });

  it('classifies resource-pressure errors', () => {
    expect(classifyColdStartFailure(new Error('host memory pressure too high'))).toBe('resource-pressure');
    expect(classifyColdStartFailure(new Error('account is rate-limited'))).toBe('resource-pressure');
    expect(classifyColdStartFailure(new Error('out of memory (OOM)'))).toBe('resource-pressure');
  });

  it('classifies anything else as a generic start-failure', () => {
    expect(classifyColdStartFailure(new Error('tmux: command not found'))).toBe('start-failure');
    expect(classifyColdStartFailure(undefined)).toBe('start-failure');
    expect(classifyColdStartFailure(null)).toBe('start-failure');
  });
});

describe('buildColdStartDebugMessage', () => {
  it('names the topic, machine, and reason in plain English', () => {
    const msg = buildColdStartDebugMessage({
      error: new Error('Max sessions (5) reached'),
      topicId: 28130,
      topicName: 'session paused bug',
      machineLabel: 'the studio',
      kind: 'spawn',
    });
    expect(msg).toContain('"session paused bug" (#28130)');
    expect(msg).toContain('on the studio');
    expect(msg).toContain('session limit');
    expect(msg).toContain('start'); // spawn → "start"
  });

  it('falls back to "#id" when the topic name is unknown and omits machine when absent', () => {
    const msg = buildColdStartDebugMessage({
      error: new Error('resource pressure'),
      topicId: 999,
      kind: 'restart',
    });
    expect(msg).toContain('#999');
    expect(msg).not.toContain(' on ');
    expect(msg).toContain('restart'); // restart → "restart"
  });
});

describe('buildColdStartFallbackReply', () => {
  const baseErr = new Error('Max sessions (5) reached');

  it('points to the Lifeline and embeds the copy-paste block when a DIFFERENT lifeline is configured', () => {
    const r = buildColdStartFallbackReply({
      error: baseErr,
      topicId: 28130,
      topicName: 'session paused bug',
      lifelineTopicId: 100,
      kind: 'spawn',
    });
    expect(r.reason).toBe('session-limit');
    expect(r.lifelineTopicId).toBe(100);
    expect(r.userMessage).toContain('Lifeline');
    expect(r.userMessage).toContain('paste');
    expect(r.userMessage).toContain(r.debugMessage);
    // why is stated
    expect(r.userMessage.toLowerCase()).toContain('maximum number of sessions');
  });

  it('does NOT send the user elsewhere when the failing topic IS the lifeline', () => {
    const r = buildColdStartFallbackReply({
      error: new Error('host memory pressure'),
      topicId: 100,
      lifelineTopicId: 100,
      kind: 'spawn',
    });
    expect(r.reason).toBe('resource-pressure');
    expect(r.userMessage).toContain("you're in the right place");
    expect(r.userMessage).not.toContain('head there'); // not "go elsewhere"
    expect(r.userMessage).toContain(r.debugMessage); // still offers the flag-it block
  });

  it('still states why + gives honest retry guidance when NO lifeline is configured', () => {
    const r = buildColdStartFallbackReply({
      error: new Error('tmux failed'),
      topicId: 28130,
      lifelineTopicId: null,
      kind: 'restart',
    });
    expect(r.reason).toBe('start-failure');
    expect(r.lifelineTopicId).toBeNull();
    expect(r.userMessage).toContain("isn't lost");
    expect(r.userMessage).not.toContain('Lifeline');
  });

  it('NEVER leaks dev jargon, config keys, file paths, or endpoints to the user', () => {
    for (const kind of ['spawn', 'restart'] as const) {
      for (const lifelineTopicId of [100, 28130, null]) {
        const r = buildColdStartFallbackReply({
          error: new Error('Max sessions (5) reached'),
          topicId: 28130,
          topicName: 'x',
          lifelineTopicId,
          kind,
        });
        const m = r.userMessage;
        expect(m).not.toMatch(/maxSessions|config\.json|\.instar\/|localhost:|http:\/\/|Bearer|tmux/);
      }
    }
  });
});
