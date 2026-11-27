import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { CorrectionCaptureBacklog } from '../../src/monitoring/CorrectionCaptureBacklog.js';
import { CaptureRing, captureAndDistill, drainBacklog, buildDistillPrompt } from '../../src/monitoring/CorrectionCaptureLoop.js';

const envelope = (severity: string) => JSON.stringify({ learning: 'Keep approved setup agent-owned', kind: 'infra-gap', severity, llm_confidence: 1, scrubbed_summary: 'Agent handed setup back' });
const input = { topicId: 1, text: 'Why are you making me do your work?', fromUser: true, deterministicWeight: 3, isLearningSignal: true, sessionId: 'fixture-session' };
const ring = () => new CaptureRing({ captureContextTurns: 12, captureTopicMapMax: 3, topicTtlMs: 60000 });

describe('default failure-only capture', () => {
  it('discards ordinary corrections without retaining conversation or enrolling preferences', async () => {
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'failure-only' });
    try {
      await captureAndDistill({ ring: ring(), ledger, failuresOnly: true, distill: async () => envelope('correction') }, input);
      expect(ledger.countRecords()).toBe(0);
      await captureAndDistill({ ring: ring(), ledger, failuresOnly: true, distill: async () => envelope('failure-callout') }, input);
      expect(ledger.list()[0]).toMatchObject({ severity: 'failure-callout', failureCase: { state: 'captured' } });
      expect(ledger.list()[0].failureCase?.context.sourceRefs).toContain('session:fixture-session');
    } finally { ledger.close(); }
  });
  it('honors forensic opt-out while retaining distilled opt-in learning', async () => {
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'opt-out' });
    try {
      await captureAndDistill({ ring: ring(), ledger, captureFailureContext: false, distill: async () => envelope('failure-callout') }, input);
      expect(ledger.list()[0]).toMatchObject({ severity: 'correction' });
      expect(ledger.list()[0].failureCase).toBeUndefined();
    } finally { ledger.close(); }
  });
  it('uses identical mode rules when retrying a capacity-buffered capture', async () => {
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'drain' });
    const backlog = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
    try {
      backlog.enqueue({ topicId: 1, turns: [{ text: input.text, fromUser: true, at: Date.now() }], deterministicWeight: 3, sessionId: 'drain-session' });
      await drainBacklog({ ledger, backlog, failuresOnly: true, distill: async () => envelope('correction'), llmAvailable: () => true }, 5);
      expect(ledger.countRecords()).toBe(0);
      expect(backlog.count()).toBe(0);
    } finally { backlog.close(); ledger.close(); }
  });
  it.each(['telegram-group-handoff', 'locked-screen-false-blocker', 'false-review-wait-without-link'])('preserves %s evidence through the real capture seam', async slug => {
    const fixture = JSON.parse(fs.readFileSync(new URL(`../fixtures/failure-callouts/${slug}.json`, import.meta.url), 'utf8'));
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: slug });
    const capture = ring();
    const calloutIndex = fixture.context.turns.findLastIndex((turn: {fromUser: boolean}) => turn.fromUser);
    for (const turn of fixture.context.turns.slice(0, calloutIndex)) capture.push(fixture.topicId, turn);
    const callout = fixture.context.turns[calloutIndex];
    try {
      await captureAndDistill({ ring: capture, ledger, failuresOnly: true, distill: async prompt => {
        expect(prompt).toContain('failure-callout');
        expect(prompt).toContain('by MEANING');
        return envelope('failure-callout');
      } }, { ...input, topicId: fixture.topicId, text: callout.text });
      const evidence = ledger.list()[0].failureCase!.context;
      expect(evidence.turns.some(t => !t.fromUser)).toBe(true);
      expect(evidence.turns.at(-1)!.text).toBe(callout.text);
      expect(evidence.missing).toContain('instructions');
      expect(buildDistillPrompt(evidence.turns)).toContain('UNTRUSTED DATA');
    } finally { ledger.close(); }
  });
});
