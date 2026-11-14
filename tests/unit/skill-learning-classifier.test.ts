// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/**
 * Skill Learning Sentinel — Classifier (Tier 1). Spec §3.1 tick, §3.6 outcomeOfPrevRun, §4 provenance
 * precondition. A stub intelligence provider + a real LlmQueue + a provenance stub whose behaviour the
 * test controls: a cut row never yields an outcome and is re-queued alone as needs-full; provenance null
 * ⇒ the row stays pending; a writeErrors delta ⇒ the tick's verdicts are refused; an admission error or
 * provider failure is counted, reported, and retried next tick — never within one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { Ledger } from '../../src/monitoring/skillLearning/Ledger.js';
import { Outcomes, RUN_WINDOW_MS } from '../../src/monitoring/skillLearning/Outcomes.js';
import { Classifier, HEAD_CHARS, boundedHead, parseVerdicts, type ClassifierDeps, type ProvenanceLike } from '../../src/monitoring/skillLearning/Classifier.js';
import type { SeamEvent } from '../../src/monitoring/skillLearning/SeamFilter.js';
import type { RequestRow } from '../../src/monitoring/skillLearning/types.js';
import type { TopicMessage } from '../../src/memory/TopicMemory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

const T0 = Date.parse('2026-11-06T12:00:00Z');
let projectDir: string;
let stateDir: string;
let ledger: Ledger;
let now = T0;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skl-classifier-'));
  stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  ledger = new Ledger({ stateDir, machineId: 'm_alpha', now: () => now });
  ledger.startSync();
  now = T0;
});
afterEach(() => {
  ledger.close();
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-classifier.test.ts' });
});

/** A TopicMemory stand-in keyed by topic. */
class MemoryStub {
  readonly messages = new Map<number, TopicMessage[]>();
  add(topicId: number, m: Omit<TopicMessage, 'topicId'>): void {
    const list = this.messages.get(topicId) ?? [];
    list.push({ topicId, ...m });
    this.messages.set(topicId, list);
  }
  getMessagesSince(topicId: number, sinceIso: string, limit = 500): { messages: TopicMessage[]; complete: boolean } {
    const all = (this.messages.get(topicId) ?? []).filter((m) => m.timestamp >= sinceIso);
    return { messages: all.slice(0, limit), complete: all.length <= limit };
  }
}

class ProvenanceStub implements ProvenanceLike {
  rows: Array<Record<string, unknown>> = [];
  returnNull = false;
  writeErrors = 0;
  recordDecision(input: Record<string, unknown>): string | null {
    this.rows.push(input);
    return this.returnNull ? null : `jp-${this.rows.length}`;
  }
  status() { return { counters: { writeErrors: this.writeErrors, decisionsWritten: this.rows.length } }; }
}

type Reply = (rows: Array<{ id: string; text: string; existingKeys: string[] }>) => unknown;
function provider(reply: Reply, calls: Array<{ prompt: string; options?: IntelligenceOptions }> = []): IntelligenceProvider {
  return {
    async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
      calls.push({ prompt, options });
      const input = JSON.parse(prompt.slice(prompt.indexOf('INPUT:') + 6)) as Array<{ id: string; text: string; existingKeys: string[] }>;
      const out = reply(input);
      return typeof out === 'string' ? out : JSON.stringify(out);
    },
  };
}
const keyFor = (text: string): string => (/ci|health/i.test(text) ? 'ci-health-report' : /deploy/i.test(text) ? 'deploy-summary' : '');
const verdictFor = (text: string, outcome = 'none') => ({ repeatable: keyFor(text) !== '', procedureKey: keyFor(text), paraphrase: `Run the ${keyFor(text) || 'thing'}`, outcomeOfPrevRun: outcome });
const defaultReply: Reply = (rows) => rows.map((r) => ({ id: r.id, ...verdictFor(r.text) }));

let n = 0;
function pending(memory: MemoryStub, text: string, over: Partial<RequestRow> = {}, topicId = 7): RequestRow {
  n += 1;
  const at = new Date(T0 + n * 1000).toISOString();
  const row: RequestRow = {
    kind: 'request', eventId: `ev-${n}`, source: { channel: 'telegram', chatId: String(topicId), messageId: String(500 + n) }, topicId: String(topicId),
    sessionName: 'echo-7', at, channel: 'telegram', identity: 'verified', state: 'pending', runId: `run-${n}`, machineId: 'm_alpha', ...over,
  };
  memory.add(topicId, { messageId: 500 + n, text, fromUser: true, timestamp: at, sessionName: 'echo-7' });
  ledger.append(row);
  return row;
}

function build(over: Partial<ClassifierDeps> & { memory?: MemoryStub; provenance?: ProvenanceLike | null } = {}) {
  const memory = over.memory ?? new MemoryStub();
  const prov = over.provenance === undefined ? new ProvenanceStub() : over.provenance;
  const degradations: unknown[] = [];
  const outcomes = new Outcomes({ ledger, machineId: 'm_alpha', stateDir, projectDir, windowDays: 30, now: () => now });
  outcomes.start();
  const classifier = new Classifier({
    ledger, machineId: 'm_alpha', topicMemory: memory, intelligence: provider(defaultReply),
    queue: new LlmQueue({ maxConcurrent: 1, maxDailyCents: 50, now: () => now }), provenance: prov,
    degradation: { report: (e) => degradations.push(e) }, outcomes, batchSize: 20, now: () => now, ...over,
  });
  return { memory, prov: prov as ProvenanceStub | null, classifier, outcomes, degradations };
}

describe('Classifier — helpers', () => {
  it('boundedHead discloses a cut in the row text; parseVerdicts is strict about ids, booleans and the outcome vocabulary', () => {
    expect(boundedHead('abc', 10)).toEqual({ text: 'abc', cut: 0 });
    const b = boundedHead('x'.repeat(HEAD_CHARS + 5), HEAD_CHARS);
    expect(b.cut).toBe(5);
    expect(b.text.endsWith('[cut: 5 chars from the tail]')).toBe(true);
    const ids = new Set(['a', 'b']);
    expect(parseVerdicts('not json', ids)).toBeNull();
    expect(parseVerdicts('{"id":"a"}', ids)).toBeNull();
    const parsed = parseVerdicts('```json\n[{"id":"a","repeatable":true,"procedureKey":"CI-Report","paraphrase":"p","outcomeOfPrevRun":"bogus"},{"id":"zzz","repeatable":true},{"id":"b","repeatable":"yes"}]\n```', ids);
    expect(parsed).toEqual([{ id: 'a', repeatable: true, procedureKey: 'ci-report', paraphrase: 'p', outcomeOfPrevRun: 'none' }]);
  });
});

describe('Classifier — tick', () => {
  it('classifies a batch: new rows with the same source and state classified, keys folded by meaning (existing keys travel in the prompt), paraphrases scrubbed both sides, one provenance row per verdict', async () => {
    const calls: Array<{ prompt: string; options?: IntelligenceOptions }> = [];
    const { memory, classifier, prov } = build({ intelligence: provider((rows) => rows.map((r) => ({ id: r.id, ...verdictFor(r.text), paraphrase: 'Run CI report with token ghp_' + 'A'.repeat(30) })), calls) });
    pending(memory, 'please run the CI health report; token=ghp_' + 'B'.repeat(30));
    pending(memory, 'what time is it?');
    expect(await classifier.tick()).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).not.toContain('ghp_' + 'B'.repeat(30));
    expect(calls[0].options?.attribution).toMatchObject({ component: 'skillLearning.classifier', deferrable: true });
    expect(calls[0].options?.provenance?.decisionPoint).toBe('skill-learning-classify');
    expect(ledger.pendingCount()).toBe(0);
    const [k] = ledger.keys();
    expect(k).toMatchObject({ procedureKey: 'ci-health-report', requests: 1, verifiedRequests: 1 });
    const row = ledger.requestsForKey('ci-health-report')[0];
    expect(row).toMatchObject({ state: 'classified', repeatable: true, runId: 'run-1' });
    expect(row.paraphrase).not.toContain('A'.repeat(30));
    expect(row.paraphrase).toContain('REDACTED');
    expect(prov!.rows).toHaveLength(2);
    expect(prov!.rows[0]).toMatchObject({ component: 'skillLearning.classifier', decisionPoint: 'skill-learning-classify', arbiter: true });
    expect(JSON.stringify(prov!.rows)).not.toContain('CI health report');
    // Second tick: the key list for the topic now carries the folded key.
    pending(memory, 'run the ci health thing again');
    await classifier.tick();
    const input = JSON.parse(calls[1].prompt.slice(calls[1].prompt.indexOf('INPUT:') + 6)) as Array<{ existingKeys: string[] }>;
    expect(input[0].existingKeys).toEqual(['ci-health-report']);
    expect(ledger.keys()[0]).toMatchObject({ procedureKey: 'ci-health-report', requests: 2 });
    expect(classifier.counters()).toMatchObject({ ticks: 2, llmCalls: 2, classified: 3, failures: 0, classifierFailures24h: 0 });
  });

  it('a cut row never yields an outcome and is re-queued ALONE as needs-full; the next tick runs only it, under the full budget', async () => {
    const seen: number[][] = [];
    const { memory, classifier, outcomes } = build({ intelligence: provider((rows) => { seen.push(rows.map((r) => r.text.length)); return rows.map((r) => ({ id: r.id, ...verdictFor('ci'), outcomeOfPrevRun: 'acknowledged' })); }) });
    // A prior run on the topic, replied to, then closed by the long message.
    const first = pending(memory, 'run the CI health report');
    const ev: SeamEvent = { kind: 'request', channel: 'telegram', topicId: '7', source: first.source, at: first.at, row: first };
    outcomes.observe(ev);
    outcomes.observe({ kind: 'reply', channel: 'telegram', topicId: '7', source: { channel: 'telegram', chatId: '7', messageId: 'r' }, at: new Date(T0 + 1500).toISOString() });
    const long = pending(memory, 'thanks, that CI report was right. '.repeat(120));
    outcomes.observe({ kind: 'request', channel: 'telegram', topicId: '7', source: long.source, at: long.at, row: long });
    await outcomes.settle();
    expect(ledger.outcomeClosedBy(long.source)?.label).toBe('unknown');

    expect(await classifier.tick()).toBe(2);
    expect(seen[0]).toHaveLength(2);
    expect(seen[0][1]).toBeLessThanOrEqual(HEAD_CHARS + 40);
    expect(ledger.requestBySource(long.source)?.state).toBe('needs-full');
    expect(ledger.latestOutcome(first.runId!)?.label).toBe('unknown'); // cut ⇒ no attribution
    expect(classifier.counters()).toMatchObject({ needsFull: 1, outcomesAttributed: 0 });

    pending(memory, 'another deploy summary please');
    expect(await classifier.tick()).toBe(1);
    expect(seen[1]).toHaveLength(1); // alone
    expect(seen[1][0]).toBeGreaterThan(HEAD_CHARS);
    expect(ledger.requestBySource(long.source)?.state).toBe('classified');
    expect(ledger.latestOutcome(first.runId!)?.label).toBe('accepted'); // the full pass may attribute
    expect(classifier.counters().outcomesAttributed).toBe(1);
    expect(ledger.pendingCount()).toBe(1); // the other row waits for the next tick
  });

  it('provenance null ⇒ the verdict is discarded and the row stays pending; a later healthy tick classifies it', async () => {
    const { memory, classifier, prov } = build();
    pending(memory, 'run the CI health report');
    prov!.returnNull = true;
    expect(await classifier.tick()).toBe(0);
    expect(ledger.pendingCount()).toBe(1);
    expect(classifier.counters().discardedUnrecorded).toBe(1);
    prov!.returnNull = false;
    expect(await classifier.tick()).toBe(1);
    expect(ledger.pendingCount()).toBe(0);
  });

  it('a positive writeErrors delta since the last tick refuses the tick before any LLM call; the next clean tick proceeds', async () => {
    const calls: Array<{ prompt: string }> = [];
    const { memory, classifier, prov } = build({ intelligence: provider(defaultReply, calls) });
    pending(memory, 'run the CI health report');
    expect(await classifier.tick()).toBe(1);
    pending(memory, 'post the deploy summary');
    prov!.writeErrors = 1;
    expect(await classifier.tick()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(ledger.pendingCount()).toBe(1);
    expect(classifier.counters().provenanceSkippedTicks).toBe(1);
    expect(await classifier.tick()).toBe(1);
    expect(ledger.pendingCount()).toBe(0);
  });

  it('no provenance log at all ⇒ every tick is refused (no record, no action)', async () => {
    const { memory, classifier } = build({ provenance: null });
    pending(memory, 'run the CI health report');
    expect(await classifier.tick()).toBe(0);
    expect(classifier.counters().provenanceSkippedTicks).toBe(1);
    expect(ledger.pendingCount()).toBe(1);
  });

  it('an admission error (daily cap) is counted in classifierFailures24h, reported to DegradationReporter, and retried on the NEXT tick only', async () => {
    const calls: Array<{ prompt: string }> = [];
    const { memory, classifier, degradations } = build({ intelligence: provider(defaultReply, calls), queue: new LlmQueue({ maxConcurrent: 1, maxDailyCents: 0, now: () => now }) });
    pending(memory, 'run the CI health report');
    expect(await classifier.tick()).toBe(0);
    expect(calls).toHaveLength(0);
    expect(ledger.pendingCount()).toBe(1);
    expect(classifier.counters()).toMatchObject({ failures: 1, classifierFailures24h: 1 });
    expect(degradations).toEqual([expect.objectContaining({ feature: 'skill-learning-classifier', internalOnly: true })]);
    expect(await classifier.tick()).toBe(0);
    expect(classifier.counters().classifierFailures24h).toBe(2);
    now = T0 + 25 * 3_600_000;
    expect(classifier.counters().classifierFailures24h).toBe(0);
  });

  it('a provider failure and unparseable output are both failures that leave rows pending', async () => {
    const { memory, classifier } = build({ intelligence: { evaluate: async () => { throw new Error('provider down'); } } });
    pending(memory, 'run the CI health report');
    expect(await classifier.tick()).toBe(0);
    expect(classifier.counters().lastError).toContain('provider down');
    const garbage = build({ memory, intelligence: { evaluate: async () => 'I cannot help with that' } });
    expect(await garbage.classifier.tick()).toBe(0);
    expect(garbage.classifier.counters()).toMatchObject({ parseFailures: 1, failures: 1 });
    expect(ledger.pendingCount()).toBe(1);
  });

  it('a verdict with a malformed key is refused (invalidVerdicts), the row stays pending', async () => {
    const { memory, classifier } = build({ intelligence: provider((rows) => rows.map((r) => ({ id: r.id, repeatable: true, procedureKey: 'Not A Key!', paraphrase: 'p', outcomeOfPrevRun: 'none' }))) });
    pending(memory, 'run the CI health report');
    expect(await classifier.tick()).toBe(0);
    expect(classifier.counters().invalidVerdicts).toBe(1);
    expect(ledger.pendingCount()).toBe(1);
  });

  it('outcomeOfPrevRun maps to §3.6 labels through Outcomes: corrected ⇒ corrected on the closed run; routine-same-key ⇒ accepted-inferred only for the same key', async () => {
    const { memory, classifier, outcomes } = build({ intelligence: provider((rows) => rows.map((r, i) => ({ id: r.id, ...verdictFor(r.text), outcomeOfPrevRun: i === 0 ? 'none' : 'corrected' }))) });
    const first = pending(memory, 'run the CI health report');
    outcomes.observe({ kind: 'request', channel: 'telegram', topicId: '7', source: first.source, at: first.at, row: first });
    outcomes.observe({ kind: 'reply', channel: 'telegram', topicId: '7', source: { channel: 'telegram', chatId: '7', messageId: 'r' }, at: new Date(T0 + 1500).toISOString() });
    const fix = pending(memory, 'no — the CI health numbers are wrong, redo it');
    outcomes.observe({ kind: 'request', channel: 'telegram', topicId: '7', source: fix.source, at: fix.at, row: fix });
    await outcomes.settle();
    await classifier.tick();
    expect(ledger.latestOutcome(first.runId!)).toMatchObject({ label: 'corrected', provisional: false });
    expect(classifier.counters().outcomesAttributed).toBe(1);
  });

  it('text that TopicMemory cannot produce leaves the row pending for TEXT_MISS_LIMIT ticks, then the deterministic rung HOLDS it (needs-full + retryAfter) with a non-arbiter provenance row; it is retried once the hold expires', async () => {
    const { classifier, prov } = build();
    n += 1;
    ledger.append({ kind: 'request', eventId: 'ghost', source: { channel: 'telegram', chatId: '7', messageId: '999' }, topicId: '7', at: new Date(T0).toISOString(), channel: 'telegram', identity: 'verified', state: 'pending', runId: 'run-ghost', machineId: 'm_alpha' });
    expect(await classifier.tick()).toBe(0);
    expect(await classifier.tick()).toBe(0);
    expect(ledger.pendingCount()).toBe(1);
    expect(await classifier.tick()).toBe(1);
    const held = ledger.requestBySource({ channel: 'telegram', chatId: '7', messageId: '999' })!;
    expect(held).toMatchObject({ state: 'needs-full' });
    expect(held.repeatable).toBeUndefined();                                  // never a permanent verdict
    expect(held.retryAfter).toBe(new Date(T0 + 14 * 86_400_000).toISOString());
    expect(prov!.rows.at(-1)).toMatchObject({ fallbackRung: 'deterministic', decision: 'wait', arbiter: false });
    expect(classifier.counters()).toMatchObject({ textMisses: 3, unreadable: 1 });
    // Held: the classifier's pending selection skips it, so a tick makes no progress and no call.
    expect(ledger.pendingRows(10)).toEqual([]);
    expect(ledger.pendingCount()).toBe(1);                                   // still visible as backlog
    expect(await classifier.tick()).toBe(0);
    expect(classifier.counters().textMisses).toBe(3);
    // The hold expires: the row is selected again and retried (text still missing => a fresh miss count starts).
    now = T0 + 15 * 86_400_000;
    expect(ledger.pendingRows(10)).toHaveLength(1);
    expect(await classifier.tick()).toBe(0);
    expect(classifier.counters().textMisses).toBe(4);
  });

  it('with nothing pending a tick makes no call; the 2 h silence path still reaches unknown without the classifier', async () => {
    const calls: Array<{ prompt: string }> = [];
    const { classifier, outcomes, memory } = build({ intelligence: provider(defaultReply, calls) });
    expect(await classifier.tick()).toBe(0);
    expect(calls).toHaveLength(0);
    const row = pending(memory, 'run the CI health report');
    outcomes.observe({ kind: 'request', channel: 'telegram', topicId: '7', source: row.source, at: row.at, row });
    now = Date.parse(row.at) + RUN_WINDOW_MS + 5000;
    outcomes.tick();
    await outcomes.settle();
    expect(ledger.latestOutcome(row.runId!)?.label).toBe('unknown');
  });
});
