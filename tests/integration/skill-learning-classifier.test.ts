// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/**
 * Skill Learning Sentinel — classifier pipeline (Tier 2). Boots a REAL TopicMemory (SQLite), a real
 * Ledger, a real JudgmentProvenanceLog and a real LlmQueue in a temp dir; wires the SeamFilter through
 * the real hook-chain attachment onto a fake adapter slot; drives operator + agent messages through it;
 * classifies the batch with a stub `sharedIntelligence` (no network) that answers in the real contract
 * shape; and checks the ledger, the outcome attribution and the provenance rows end to end.
 *
 * This file is also the parser-contract test named for `skillLearning.classifier` in
 * src/data/llmBenchCoverage.ts: it renders the REAL prompt and parses the REAL output shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { JudgmentProvenanceLog } from '../../src/core/JudgmentProvenanceLog.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { Ledger } from '../../src/monitoring/skillLearning/Ledger.js';
import { Outcomes } from '../../src/monitoring/skillLearning/Outcomes.js';
import { Classifier, OUTCOME_OPTIONS } from '../../src/monitoring/skillLearning/Classifier.js';
import { SeamFilter, attachSkillLearningSeams, type TelegramLoggedEntry } from '../../src/monitoring/skillLearning/SeamFilter.js';
import type { IntelligenceOptions, IntelligenceProvider } from '../../src/core/types.js';

const OPERATOR = 424242;
const T0 = Date.parse('2026-11-06T12:00:00Z');
let projectDir: string;
let stateDir: string;
let topicMemory: TopicMemory;
let ledger: Ledger;
let now = T0;

beforeEach(async () => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skl-int-'));
  stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  topicMemory = new TopicMemory(stateDir);
  await topicMemory.open();
  ledger = new Ledger({ stateDir, machineId: 'm_alpha', now: () => now });
  await ledger.start();
  now = T0;
});
afterEach(() => {
  ledger.close();
  topicMemory.close();
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/skill-learning-classifier.test.ts' });
});

/** The deterministic stand-in for sharedIntelligence: reads the real prompt's INPUT and answers in the real shape. */
function stubIntelligence(calls: Array<{ prompt: string; options?: IntelligenceOptions }>): IntelligenceProvider {
  return {
    async evaluate(prompt, options) {
      calls.push({ prompt, options });
      const input = JSON.parse(prompt.slice(prompt.indexOf('INPUT:') + 6)) as Array<{ id: string; text: string; existingKeys: string[]; detectorCategory?: string }>;
      return JSON.stringify(input.map((r) => {
        const ci = /ci health/i.test(r.text);
        const thanks = /^thanks/i.test(r.text);
        const key = ci ? (r.existingKeys.includes('ci-health-report') ? 'ci-health-report' : 'ci-health-report') : '';
        const outcome: (typeof OUTCOME_OPTIONS)[number] = thanks ? 'acknowledged' : ci && r.existingKeys.includes('ci-health-report') ? 'routine-same-key' : 'none';
        return { id: r.id, repeatable: ci, procedureKey: key, paraphrase: ci ? 'Produce the weekly CI health report for the repo' : '', outcomeOfPrevRun: outcome };
      }));
    },
  };
}

describe('skill-learning classifier pipeline (real TopicMemory + ledger + provenance, stub intelligence)', () => {
  it('observes through the hook chain, classifies a batch, folds keys by meaning, attributes the acknowledgement, and records provenance for every verdict', async () => {
    // ── The real pieces ──
    const provenance = new JudgmentProvenanceLog({ dir: path.join(stateDir, 'state', 'judgment-provenance'), now: () => now });
    const queue = new LlmQueue({ maxConcurrent: 1, maxDailyCents: 50, now: () => now });
    const outcomes = new Outcomes({ ledger, machineId: 'm_alpha', stateDir, projectDir, windowDays: 30, now: () => now });
    outcomes.start();
    const filter = new SeamFilter({
      ledger, machineId: 'm_alpha',
      operatorUidForTopic: (topicId) => (String(topicId) === '7' ? String(OPERATOR) : null),
      detector: { classify: (text) => (/\bwrong\b/i.test(text) ? { category: 'factual-correction' } : null) },
      topicMemory,
      onEvent: (e) => outcomes.observe(e),
    });
    const calls: Array<{ prompt: string; options?: IntelligenceOptions }> = [];
    const classifier = new Classifier({
      ledger, machineId: 'm_alpha', topicMemory, intelligence: stubIntelligence(calls), queue, provenance, outcomes, batchSize: 20, now: () => now,
    });

    // ── A fake adapter slot with a prior link (TopicMemory dual-write, as server.ts does) ──
    const prior: number[] = [];
    const telegram = { onMessageLogged: ((e: TelegramLoggedEntry) => {
      prior.push(e.messageId);
      topicMemory.insertMessage({ messageId: e.messageId, topicId: e.topicId!, text: e.text, fromUser: e.fromUser, timestamp: e.timestamp, sessionName: e.sessionName, telegramUserId: e.telegramUserId, forwarded: e.forwarded });
    }) as ((e: TelegramLoggedEntry) => void) | null };
    const attached = attachSkillLearningSeams({ telegram, filter });
    expect(attached.telegram).toBe(true);

    const say = (messageId: number, text: string, offsetMs: number, over: Partial<TelegramLoggedEntry> = {}) => telegram.onMessageLogged!({
      messageId, topicId: 7, text, fromUser: true, timestamp: new Date(T0 + offsetMs).toISOString(), sessionName: 'echo-7', telegramUserId: OPERATOR, forwarded: false, ...over,
    });

    // ── Conversation ──
    say(1, 'please run the CI health report for the repo', 0);
    say(2, 'Here is the CI health report: 3 red jobs, 1 flaky.', 30_000, { fromUser: false, telegramUserId: undefined });
    say(3, 'thanks, that is exactly what I needed', 60_000);
    say(4, 'can you run the CI health report again for last week?', 120_000);
    say(5, 'a stranger speaks', 150_000, { telegramUserId: 1 });
    say(6, 'forwarded text', 160_000, { forwarded: true });
    await outcomes.settle();

    expect(prior).toEqual([1, 2, 3, 4, 5, 6]); // the prior link saw everything
    expect(filter.counters()).toMatchObject({ appended: 3, 'not-user': 1, 'not-operator': 1, forwarded: 1 });
    expect(ledger.pendingCount()).toBe(3);
    // Run 1 was closed by message 3 (after the reply) and run (msg 3) by message 4 (no reply in between ⇒ new-request close).
    const run1 = ledger.requestBySource({ channel: 'telegram', chatId: '7', messageId: '1' })!;
    expect(ledger.outcomeClosedBy({ channel: 'telegram', chatId: '7', messageId: '3' })?.runId).toBe(run1.runId);
    const raw = fs.readFileSync(ledger.segmentPath(0), 'utf-8');
    expect(raw).not.toContain('CI health report'); // text never stored

    // ── Tick 1 classifies the three pending rows in one call ──
    expect(await classifier.tick()).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({ model: 'fast', temperature: 0, attribution: { component: 'skillLearning.classifier', deferrable: true } });
    expect(calls[0].options?.provenance).toMatchObject({ decisionPoint: 'skill-learning-classify', promptId: 'skill-learning-classifier-v1' });
    expect(calls[0].prompt).toContain('please run the CI health report'); // text was re-read from TopicMemory by source
    expect(ledger.pendingCount()).toBe(0);
    expect(ledger.keys()).toEqual([expect.objectContaining({ procedureKey: 'ci-health-report', requests: 2, verifiedRequests: 2 })]);
    const classified = ledger.requestsForKey('ci-health-report');
    expect(classified.map((r) => r.source.messageId).sort()).toEqual(['1', '4']);
    expect(classified.every((r) => r.state === 'classified' && r.repeatable && r.paraphrase === 'Produce the weekly CI health report for the repo')).toBe(true);
    const thanks = ledger.requestBySource({ channel: 'telegram', chatId: '7', messageId: '3' })!;
    expect(thanks).toMatchObject({ state: 'classified', repeatable: false });
    expect(thanks.procedureKey).toBeUndefined();

    // ── Attribution: message 3 acknowledged run 1 ⇒ accepted (revision 1). ──
    // Revision 1 carried the key (msg 1 classified first), revision 2 the acknowledgement.
    expect(ledger.latestOutcome(run1.runId!)).toMatchObject({ label: 'accepted', revision: 2, procedureKey: 'ci-health-report', provisional: true });
    expect(ledger.outcomesForKey('ci-health-report')).toHaveLength(1);
    expect(classifier.counters()).toMatchObject({ classified: 3, outcomesAttributed: 1, failures: 0 });

    // ── Provenance: one arbiter row per verdict, none null, nothing content-bearing leaked. ──
    expect(provenance.status().counters.decisionsWritten).toBe(3);
    expect(provenance.status().counters.writeErrors).toBe(0);
    await provenance.close();
    const provDir = path.join(stateDir, 'state', 'judgment-provenance');
    const provText = fs.readdirSync(provDir).map((f) => fs.readFileSync(path.join(provDir, f), 'utf-8')).join('\n');
    expect(provText).toContain('skill-learning-classify');
    expect(provText).not.toContain('CI health report');

    // ── Restart: a new Ledger instance over the same segments reads the same state. ──
    ledger.close();
    const again = new Ledger({ stateDir, machineId: 'm_alpha', now: () => now });
    await again.start();
    expect(again.keys()[0]).toMatchObject({ procedureKey: 'ci-health-report', requests: 2 });
    expect(again.latestOutcome(run1.runId!)?.label).toBe('accepted');
    expect(again.ingestSync()).toBe(0);
    again.close();
    ledger = new Ledger({ stateDir, machineId: 'm_alpha', now: () => now }); // afterEach closes it
  });

  it('a second tick on a routine same-key recurrence after a delivered reply yields accepted-inferred, and the catch-up path admits support-only rows the seam missed', async () => {
    const provenance = new JudgmentProvenanceLog({ dir: path.join(stateDir, 'state', 'judgment-provenance'), now: () => now });
    const queue = new LlmQueue({ maxConcurrent: 1, maxDailyCents: 50, now: () => now });
    const outcomes = new Outcomes({ ledger, machineId: 'm_alpha', stateDir, projectDir, windowDays: 30, now: () => now });
    const filter = new SeamFilter({ ledger, machineId: 'm_alpha', operatorUidForTopic: () => String(OPERATOR), topicMemory, onEvent: (e) => outcomes.observe(e) });
    const calls: Array<{ prompt: string }> = [];
    const classifier = new Classifier({ ledger, machineId: 'm_alpha', topicMemory, intelligence: stubIntelligence(calls), queue, provenance, outcomes, batchSize: 20, now: () => now });
    const say = (messageId: number, text: string, offsetMs: number, fromUser = true) => {
      const e: TelegramLoggedEntry = { messageId, topicId: 7, text, fromUser, timestamp: new Date(T0 + offsetMs).toISOString(), sessionName: 'echo-7', telegramUserId: fromUser ? OPERATOR : undefined, forwarded: false };
      topicMemory.insertMessage({ messageId, topicId: 7, text, fromUser, timestamp: e.timestamp, sessionName: 'echo-7' });
      filter.observeTelegram(e);
    };
    // A message that only reached TopicMemory (seam missed it) — admitted by catch-up as support-only.
    topicMemory.insertMessage({ messageId: 90, topicId: 7, text: 'run the CI health report', fromUser: true, timestamp: new Date(T0 - 3_600_000).toISOString(), sessionName: 'echo-7', telegramUserId: OPERATOR });
    // An unbound sender in the same window is dropped by the same structural filter — its text never reaches a row.
    topicMemory.insertMessage({ messageId: 91, topicId: 7, text: 'stranger: run something else', fromUser: true, timestamp: new Date(T0 - 3_500_000).toISOString(), sessionName: 'echo-7', telegramUserId: 1 });
    expect(filter.catchUp(7, new Date(T0 - 7_200_000).toISOString())).toEqual({ admitted: 1, complete: true });
    expect(filter.counters()['not-operator']).toBe(1);
    expect(ledger.requestBySource({ channel: 'telegram', chatId: '7', messageId: '91' })).toBeNull();
    const caught = ledger.requestBySource({ channel: 'telegram', chatId: '7', messageId: '90' })!;
    expect(caught).toMatchObject({ identity: 'unverified-catchup' });
    expect(caught.runId).toBeUndefined();

    say(1, 'run the CI health report', 0);
    say(2, 'CI health report delivered.', 30_000, false);
    await outcomes.settle();
    expect(await classifier.tick()).toBe(2);
    expect(ledger.keys()[0]).toMatchObject({ procedureKey: 'ci-health-report', requests: 2, verifiedRequests: 1 }); // the catch-up row counts as support only
    say(3, 'run the CI health report', 120_000); // routine recurrence closes run 1 after a reply
    await outcomes.settle();
    expect(await classifier.tick()).toBe(1);
    const run1 = ledger.requestBySource({ channel: 'telegram', chatId: '7', messageId: '1' })!;
    expect(ledger.latestOutcome(run1.runId!)).toMatchObject({ label: 'accepted-inferred', provisional: true });
    expect(provenance.status().counters.decisionsWritten).toBe(3);
    await provenance.close();
  });
});
