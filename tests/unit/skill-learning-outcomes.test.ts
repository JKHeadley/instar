// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/**
 * Skill Learning Sentinel — Outcomes (Tier 1). Spec §3.6 window rules and labels, §3.9 skillUsed join
 * (telemetry row + transcript corroboration), misfire, versionUncertain, measurableRate, the late
 * correction flip with its `improve` event, and windowDays finalization. Silence is never a label.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { Ledger } from '../../src/monitoring/skillLearning/Ledger.js';
import { Outcomes, RUN_WINDOW_MS, type OutcomesDeps } from '../../src/monitoring/skillLearning/Outcomes.js';
import type { SeamEvent } from '../../src/monitoring/skillLearning/SeamFilter.js';
import type { RequestRow, RowSource } from '../../src/monitoring/skillLearning/types.js';

const T0 = Date.parse('2026-11-06T12:00:00Z');
let projectDir: string;
let stateDir: string;
let ledger: Ledger;
let now = T0;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skl-outcomes-'));
  stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  ledger = new Ledger({ stateDir, machineId: 'm_alpha', now: () => now });
  ledger.startSync();
  now = T0;
});
afterEach(() => {
  ledger.close();
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-outcomes.test.ts' });
});

function makeOutcomes(over: Partial<OutcomesDeps> = {}): Outcomes {
  const o = new Outcomes({ ledger, machineId: 'm_alpha', stateDir, projectDir, windowDays: 30, now: () => now, ...over });
  o.start();
  return o;
}

let n = 0;
function src(messageId = String(200 + ++n)): RowSource {
  return { channel: 'telegram', chatId: '7', messageId };
}
function requestRow(at: number, source = src(), over: Partial<RequestRow> = {}): RequestRow {
  const row: RequestRow = {
    kind: 'request', eventId: `ev-${source.messageId}`, source, topicId: '7', sessionName: 'echo-7', at: new Date(at).toISOString(),
    channel: 'telegram', identity: 'verified', state: 'pending', runId: `run-${source.messageId}`, machineId: 'm_alpha', ...over,
  };
  ledger.append(row);
  return row;
}
function requestEvent(row: RequestRow): SeamEvent {
  return { kind: 'request', channel: 'telegram', topicId: row.topicId, source: row.source, at: row.at, sessionName: row.sessionName, row };
}
function replyEvent(at: number, topicId = '7'): SeamEvent {
  return { kind: 'reply', channel: 'telegram', topicId, source: src(), at: new Date(at).toISOString(), sessionName: 'echo-7' };
}

describe('Outcomes — window rules (§3.6)', () => {
  it('silence closes the run as unknown at 2 h (provisional, no closedBy); nothing closes before that', async () => {
    const o = makeOutcomes();
    const row = requestRow(T0);
    o.observe(requestEvent(row));
    o.observe(replyEvent(T0 + 60_000));
    now = T0 + RUN_WINDOW_MS - 1000;
    o.tick();
    await o.settle();
    expect(ledger.latestOutcome(row.runId!)).toBeNull();
    expect(o.openRunCount()).toBe(1);
    now = T0 + RUN_WINDOW_MS;
    o.tick();
    await o.settle();
    const out = ledger.latestOutcome(row.runId!);
    expect(out).toMatchObject({ label: 'unknown', provisional: true, revision: 0, windowEnd: new Date(T0 + RUN_WINDOW_MS).toISOString() });
    expect(out?.closedBy).toBeUndefined();
    expect(out?.skillUsed).toBeUndefined(); // no telemetry row ⇒ no claim, never "not used"
    expect(o.counters().closedByTimeout).toBe(1);
  });

  it('a new request before any reply closes the previous run as unknown (closedByNewRequest), with no closedBy', async () => {
    const o = makeOutcomes();
    const first = requestRow(T0);
    o.observe(requestEvent(first));
    const second = requestRow(T0 + 30_000);
    o.observe(requestEvent(second));
    await o.settle();
    const out = ledger.latestOutcome(first.runId!);
    expect(out).toMatchObject({ label: 'unknown', windowEnd: second.at });
    expect(out?.closedBy).toBeUndefined();
    expect(o.counters()).toMatchObject({ closedByNewRequest: 1, opened: 2 });
    expect(o.openRunCount()).toBe(1);
  });

  it('the next operator message after ≥1 delivered reply closes the window INSIDE it and records closedBy for attribution', async () => {
    const o = makeOutcomes();
    const first = requestRow(T0);
    o.observe(requestEvent(first));
    o.observe(replyEvent(T0 + 60_000));
    const ack = requestRow(T0 + 120_000);
    o.observe(requestEvent(ack));
    await o.settle();
    const out = ledger.latestOutcome(first.runId!);
    expect(out).toMatchObject({ label: 'unknown', provisional: true, closedBy: ack.source, windowEnd: ack.at });
    expect(ledger.outcomeClosedBy(ack.source)?.runId).toBe(first.runId);
    expect(o.counters().closedByMessage).toBe(1);
  });

  it('a reply on another topic does not count for this run', async () => {
    const o = makeOutcomes();
    const first = requestRow(T0);
    o.observe(requestEvent(first));
    o.observe(replyEvent(T0 + 60_000, '8'));
    const second = requestRow(T0 + 120_000);
    o.observe(requestEvent(second));
    await o.settle();
    expect(ledger.latestOutcome(first.runId!)?.closedBy).toBeUndefined();
    expect(o.counters().closedByNewRequest).toBe(1);
  });

  it('the session clock\'s end closes a time-boxed run before the 2 h bound', async () => {
    const o = makeOutcomes({ sessionClockEnd: (topicId) => (topicId === '7' ? new Date(T0 + 600_000).toISOString() : null) });
    const row = requestRow(T0);
    o.observe(requestEvent(row));
    now = T0 + 601_000;
    o.tick();
    await o.settle();
    expect(ledger.latestOutcome(row.runId!)).toMatchObject({ label: 'unknown', windowEnd: new Date(T0 + 600_000).toISOString() });
    expect(o.counters().closedBySessionClock).toBe(1);
  });

  it('start() re-opens runs the ledger shows without an outcome (restart), and they close honestly as unknown', async () => {
    const row = requestRow(T0);
    const o = makeOutcomes();
    expect(o.openRunCount()).toBe(1);
    now = T0 + RUN_WINDOW_MS;
    o.tick();
    await o.settle();
    expect(ledger.latestOutcome(row.runId!)?.label).toBe('unknown');
  });
});

describe('Outcomes — classifier attribution and revisions', () => {
  async function closedByAck(o: Outcomes): Promise<{ run: RequestRow; ack: RequestRow }> {
    const run = requestRow(T0);
    o.observe(requestEvent(run));
    o.observe(replyEvent(T0 + 60_000));
    const ack = requestRow(T0 + 120_000);
    o.observe(requestEvent(ack));
    await o.settle();
    return { run, ack };
  }

  it('an acknowledgement verdict flips the closed run to accepted (revision 1, provisional)', async () => {
    const o = makeOutcomes();
    const { run, ack } = await closedByAck(o);
    expect(o.applyVerdict({ closingSource: ack.source, label: 'accepted' })).toBe('attributed');
    expect(ledger.latestOutcome(run.runId!)).toMatchObject({ label: 'accepted', revision: 1, provisional: true });
    expect(ledger.outcomesForKey('')).toHaveLength(1);
  });

  it('accepted-inferred needs the SAME key as the run it labels; a different key downgrades to weak-positive', async () => {
    const o = makeOutcomes();
    const { run, ack } = await closedByAck(o);
    o.noteClassified({ ...run, state: 'classified', procedureKey: 'ci-health-report', repeatable: true });
    expect(ledger.latestOutcome(run.runId!)?.procedureKey).toBe('ci-health-report');
    o.applyVerdict({ closingSource: ack.source, label: 'accepted-inferred', procedureKey: 'deploy-summary' });
    expect(ledger.latestOutcome(run.runId!)?.label).toBe('weak-positive');
    const o2 = makeOutcomes();
    const second = await closedByAck(o2);
    o2.noteClassified({ ...second.run, state: 'classified', procedureKey: 'ci-health-report', repeatable: true });
    o2.applyVerdict({ closingSource: second.ack.source, label: 'accepted-inferred', procedureKey: 'ci-health-report' });
    expect(ledger.latestOutcome(second.run.runId!)?.label).toBe('accepted-inferred');
  });

  it('corrected is terminal and not provisional; a verdict for a source that closed nothing is "none"', async () => {
    const o = makeOutcomes();
    const { run, ack } = await closedByAck(o);
    o.applyVerdict({ closingSource: ack.source, label: 'corrected' });
    expect(ledger.latestOutcome(run.runId!)).toMatchObject({ label: 'corrected', provisional: false });
    expect(o.applyVerdict({ closingSource: ack.source, label: 'accepted' })).toBe('none');
    expect(ledger.latestOutcome(run.runId!)?.label).toBe('corrected');
    expect(o.applyVerdict({ closingSource: src('nope'), label: 'accepted' })).toBe('none');
  });

  it('a late correction flips the latest provisional run of the key and appends an improve event; outside windowDays it does nothing', async () => {
    const o = makeOutcomes();
    const run = requestRow(T0);
    o.observe(requestEvent(run));
    o.noteClassified({ ...run, state: 'classified', procedureKey: 'ci-health-report', repeatable: true });
    now = T0 + RUN_WINDOW_MS;
    o.tick();
    await o.settle();
    expect(ledger.latestOutcome(run.runId!)).toMatchObject({ label: 'unknown', provisional: true, procedureKey: 'ci-health-report' });
    now = T0 + 2 * 86_400_000;
    expect(o.applyVerdict({ closingSource: src('late'), label: 'corrected', procedureKey: 'ci-health-report' })).toBe('late-flip');
    expect(ledger.latestOutcome(run.runId!)).toMatchObject({ label: 'corrected', provisional: false, revision: 1 });
    expect(ledger.eventsForKey('ci-health-report')).toEqual([expect.objectContaining({ event: 'improve', runId: run.runId })]);
    // Nothing provisional is left for that key ⇒ a second late correction has nothing to flip.
    expect(o.applyVerdict({ closingSource: src('late2'), label: 'corrected', procedureKey: 'ci-health-report' })).toBe('none');
    // And a run older than windowDays is never flipped.
    const stale = requestRow(T0 - 40 * 86_400_000, src('stale'));
    ledger.append({ kind: 'outcome', eventId: 'oc-stale', runId: stale.runId!, revision: 0, procedureKey: 'old-key', topicId: '7', label: 'unknown', provisional: true, windowStart: stale.at, at: stale.at, machineId: 'm_alpha' });
    expect(o.applyVerdict({ closingSource: src('late3'), label: 'corrected', procedureKey: 'old-key' })).toBe('none');
  });

  it('tick() finalizes provisional outcomes once windowDays have passed (one revision, provisional=false)', async () => {
    const o = makeOutcomes({ windowDays: 2 });
    const run = requestRow(T0);
    o.observe(requestEvent(run));
    now = T0 + RUN_WINDOW_MS;
    o.tick();
    await o.settle();
    now = T0 + 3 * 86_400_000;
    o.tick();
    o.tick();
    expect(ledger.latestOutcome(run.runId!)).toMatchObject({ label: 'unknown', provisional: false, revision: 1 });
    expect(o.counters().finalized).toBe(1);
  });
});

describe('Outcomes — §3.9 skillUsed join', () => {
  function telemetry(rows: Array<Record<string, string>>, machine = 'm_alpha'): void {
    const dir = path.join(stateDir, 'skill-telemetry');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${machine}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  function transcript(lines: Array<Record<string, unknown>>): string {
    const file = path.join(projectDir, 'transcript.jsonl');
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  }
  function skillTurn(ts: number, skill = 'ci-health-report'): Array<Record<string, unknown>> {
    return [
      { type: 'user', timestamp: new Date(ts).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[telegram:7] run it' }] } },
      { type: 'assistant', timestamp: new Date(ts + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill } }] } },
      { type: 'user', timestamp: new Date(ts + 2000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ];
  }
  function canonical(name: string, key: string): void {
    const dir = path.join(projectDir, '.instar', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "x"\nmetadata:\n  instar-learned-origin: "skill-learning-sentinel"\n  instar-learned-key: "${key}"\n---\nbody\n`);
  }

  it('a telemetry row inside the window with the run\'s session + topic, corroborated by the transcript\'s Skill call, yields skillUsed; versionUncertain reads the reconciler journal; misfire compares keys', async () => {
    const file = transcript(skillTurn(T0 + 30_000));
    telemetry([{ ts: new Date(T0 + 31_000).toISOString(), skill: 'ci-health-report', session_id: 'uuid-1', session_name: 'echo-7', topic_id: '7', machine_id: 'm_beta', content_hash: 'a'.repeat(64) }], 'm_beta');
    const journalDir = path.join(stateDir, 'skill-learning', 'journal');
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, 'm_beta.jsonl'), JSON.stringify({ ts: new Date(T0 + 10_000).toISOString(), machineId: 'm_beta', op: 'render-commit', txId: 'tx', skill: 'ci-health-report', target: 'claude-code', renderingPath: '.claude/skills/ci-health-report/SKILL.md', bodyHash: 'b' }) + '\n');
    canonical('ci-health-report', 'ci-health-report');
    const o = makeOutcomes({ findSession: (name) => (name === 'echo-7' ? { claudeSessionId: 'uuid-1', framework: 'claude-code' } : undefined), transcriptPath: () => file });
    const run = requestRow(T0);
    o.observe(requestEvent(run));
    o.noteClassified({ ...run, state: 'classified', procedureKey: 'deploy-summary', repeatable: true });
    o.observe(replyEvent(T0 + 60_000));
    const ack = requestRow(T0 + 120_000);
    o.observe(requestEvent(ack));
    await o.settle();
    const out = ledger.latestOutcome(run.runId!);
    expect(out?.skillUsed).toEqual({ skill: 'ci-health-report', contentHash: 'a'.repeat(64), corroborated: true, versionUncertain: true, stamp: 'unmatched' });
    expect(out?.misfire).toBe(true); // request keyed deploy-summary, skill keyed ci-health-report
    expect(o.counters()).toMatchObject({ joins: 1, corroborated: 1, versionUncertain: 1, misfires: 1 });
    expect(o.measurableRates()).toEqual({ 'ci-health-report': { uses: 1, corroborated: 1, rate: 1 } });
  });

  it('no misfire when the keys agree; the join resolves the session by its Claude UUID when the telemetry row lacks the tmux name', async () => {
    const file = transcript(skillTurn(T0 + 30_000));
    telemetry([{ ts: new Date(T0 + 31_000).toISOString(), skill: 'ci-health-report', session_id: 'uuid-1', session_name: '', topic_id: '7', machine_id: 'm_alpha', content_hash: 'h' }]);
    canonical('ci-health-report', 'ci-health-report');
    const o = makeOutcomes({ findSession: () => ({ claudeSessionId: 'uuid-1', framework: 'claude-code' }), transcriptPath: () => file });
    const run = requestRow(T0);
    o.observe(requestEvent(run));
    o.noteClassified({ ...run, state: 'classified', procedureKey: 'ci-health-report', repeatable: true });
    now = T0 + RUN_WINDOW_MS;
    o.tick();
    await o.settle();
    const out = ledger.latestOutcome(run.runId!);
    expect(out?.skillUsed).toMatchObject({ skill: 'ci-health-report', corroborated: true, versionUncertain: false });
    expect(out?.misfire).toBe(false);
  });

  it('a telemetry row OUTSIDE the window, or for another topic/session, is not this run\'s use; a row with no transcript evidence is uncorroborated', async () => {
    telemetry([
      { ts: new Date(T0 - 3_600_000).toISOString(), skill: 'ci-health-report', session_id: 'uuid-1', session_name: 'echo-7', topic_id: '7', machine_id: 'm_alpha', content_hash: 'h' },
      { ts: new Date(T0 + 31_000).toISOString(), skill: 'ci-health-report', session_id: 'other', session_name: 'echo-9', topic_id: '9', machine_id: 'm_alpha', content_hash: 'h' },
    ]);
    const o = makeOutcomes({ findSession: () => ({ claudeSessionId: 'uuid-1', framework: 'claude-code' }), transcriptPath: () => '' });
    const run = requestRow(T0);
    o.observe(requestEvent(run));
    now = T0 + RUN_WINDOW_MS;
    o.tick();
    await o.settle();
    expect(ledger.latestOutcome(run.runId!)?.skillUsed).toBeUndefined();
    expect(o.measurableRates()['ci-health-report']).toEqual({ uses: 2, corroborated: 0, rate: 0 });

    telemetry([{ ts: new Date(now + 5_000).toISOString(), skill: 'ci-health-report', session_id: 'uuid-1', session_name: 'echo-7', topic_id: '7', machine_id: 'm_alpha', content_hash: 'h' }]);
    const run2 = requestRow(now, src('r2'));
    o.observe(requestEvent(run2));
    now += RUN_WINDOW_MS;
    o.tick();
    await o.settle();
    expect(ledger.latestOutcome(run2.runId!)?.skillUsed).toMatchObject({ skill: 'ci-health-report', corroborated: false });
  });

  it('a Skill call in a turn OUTSIDE the window does not corroborate; a transcript with a Skill call inside does, even when a later turn exists', async () => {
    const file = transcript([...skillTurn(T0 - 7_200_000), ...skillTurn(T0 + 30_000), ...skillTurn(T0 + 9_000_000, 'other-skill')]);
    telemetry([{ ts: new Date(T0 + 31_000).toISOString(), skill: 'ci-health-report', session_id: 'uuid-1', session_name: 'echo-7', topic_id: '7', machine_id: 'm_alpha', content_hash: 'h' }]);
    const o = makeOutcomes({ findSession: () => ({ claudeSessionId: 'uuid-1', framework: 'claude-code' }), transcriptPath: () => file });
    const run = requestRow(T0);
    o.observe(requestEvent(run));
    now = T0 + RUN_WINDOW_MS;
    o.tick();
    await o.settle();
    expect(ledger.latestOutcome(run.runId!)?.skillUsed?.corroborated).toBe(true);

    const early = transcript(skillTurn(T0 - 7_200_000));
    const o2 = makeOutcomes({ findSession: () => ({ claudeSessionId: 'uuid-1', framework: 'claude-code' }), transcriptPath: () => early });
    telemetry([{ ts: new Date(now + 31_000).toISOString(), skill: 'ci-health-report', session_id: 'uuid-1', session_name: 'echo-7', topic_id: '7', machine_id: 'm_alpha', content_hash: 'h' }]);
    const run2 = requestRow(now, src('r2'));
    o2.observe(requestEvent(run2));
    now += RUN_WINDOW_MS;
    o2.tick();
    await o2.settle();
    expect(ledger.latestOutcome(run2.runId!)?.skillUsed?.corroborated).toBe(false);
  });
});

describe('Outcomes — §3.9 join hardening (slice 2): version, edges, operator edits, absent stamp', () => {
  const STAMP = 'c'.repeat(64);
  function telemetryAt(ts: number, machine: string, over: Partial<Record<string, string>> = {}): void {
    const dir = path.join(stateDir, 'skill-telemetry');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${machine}.jsonl`), JSON.stringify({ ts: new Date(ts).toISOString(), skill: 'ci-health-report', session_id: 'uuid-1', session_name: 'echo-7', topic_id: '7', machine_id: machine, content_hash: STAMP, ...over }) + '\n');
  }
  function renderCommitAt(ts: number, machine: string, skill = 'ci-health-report'): void {
    const dir = path.join(stateDir, 'skill-learning', 'journal');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${machine}.jsonl`), JSON.stringify({ ts: new Date(ts).toISOString(), machineId: machine, op: 'render-commit', txId: `tx-${ts}`, skill, target: 'claude-code', renderingPath: `.claude/skills/${skill}/SKILL.md`, bodyHash: STAMP, contentHash: 'r' }) + '\n');
  }
  function conflictShard(machine: string, rel: string, at: number): void {
    const dir = path.join(stateDir, 'skill-learning', 'rendered-baselines');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${machine}.json`), JSON.stringify({ version: 1, machineId: machine, baselines: {}, failed: {}, conflicts: { [rel]: { skill: 'ci-health-report', target: 'claude-code', reason: 'user-edit-conflict', contentHash: 'e', detail: 'edited', at: new Date(at).toISOString() } } }));
  }
  /** One run opened at T0 and closed by the 2 h timeout; returns its latest outcome. */
  async function runAndClose(o: Outcomes) {
    const run = requestRow(T0);
    o.observe(requestEvent(run));
    now = T0 + RUN_WINDOW_MS;
    o.tick();
    await o.settle();
    return ledger.latestOutcome(run.runId!)!;
  }
  const session = () => ({ claudeSessionId: 'uuid-1', framework: 'claude-code' as const });

  it('content_hash resolves to a version row through the injected lookup; no lookup ⇒ unmatched; a lookup that throws ⇒ unmatched; a stamp no row carries ⇒ unmatched', async () => {
    telemetryAt(T0 + 5_000, 'm_beta');
    const seen: Array<[string, string]> = [];
    const o = makeOutcomes({ findSession: session, transcriptPath: () => '', versionLookup: (skill, hash) => { seen.push([skill, hash]); return hash === STAMP ? { version: 3 } : null; } });
    expect((await runAndClose(o)).skillUsed).toMatchObject({ skill: 'ci-health-report', contentHash: STAMP, stamp: 'version', version: 3, versionUncertain: false });
    expect(seen).toEqual([['ci-health-report', STAMP]]);

    const none = makeOutcomes({ findSession: session, transcriptPath: () => '' });
    const out = (await runAndClose(none)).skillUsed!;
    expect(out.stamp).toBe('unmatched');
    expect(out.version).toBeUndefined();

    const throws = makeOutcomes({ findSession: session, transcriptPath: () => '', versionLookup: () => { throw new Error('store gone'); } });
    expect((await runAndClose(throws)).skillUsed?.stamp).toBe('unmatched');

    const miss = makeOutcomes({ findSession: session, transcriptPath: () => '', versionLookup: () => null });
    expect((await runAndClose(miss)).skillUsed?.stamp).toBe('unmatched');
  });

  it('an absent stamp (content_hash "unknown" or not a sha256) is stamp: unknown — no version claim, counted', async () => {
    telemetryAt(T0 + 5_000, 'm_beta', { content_hash: 'unknown' });
    const o = makeOutcomes({ findSession: session, transcriptPath: () => '', versionLookup: () => { throw new Error('must not be asked for an absent stamp'); } });
    const out = (await runAndClose(o)).skillUsed!;
    expect(out).toMatchObject({ stamp: 'unknown', contentHash: 'unknown' });
    expect(out.version).toBeUndefined();
    expect(o.counters().stampUnknown).toBe(1);
    const dir = path.join(stateDir, 'skill-telemetry');
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-outcomes.test.ts' });
    telemetryAt(T0 + 5_000, 'm_beta', { content_hash: 'abc' });
    const o2 = makeOutcomes({ findSession: session, transcriptPath: () => '' });
    expect((await runAndClose(o2)).skillUsed?.stamp).toBe('unknown');
  });

  it('version-uncertain edges ±1 ms: a render-commit in the TELEMETRY ROW\'S machine journal from the run start to the row\'s ts, both inclusive', async () => {
    const ts = T0 + 30_000;
    const cases: Array<[number, boolean]> = [[ts, true], [ts + 1, false], [T0, true], [T0 - 1, false], [T0 + 15_000, true]];
    for (const [commitAt, expected] of cases) {
      SafeFsExecutor.safeRmSync(path.join(stateDir, 'skill-learning'), { recursive: true, force: true, operation: 'tests/unit/skill-learning-outcomes.test.ts' });
      SafeFsExecutor.safeRmSync(path.join(stateDir, 'skill-telemetry'), { recursive: true, force: true, operation: 'tests/unit/skill-learning-outcomes.test.ts' });
      telemetryAt(ts, 'm_beta');
      renderCommitAt(commitAt, 'm_beta');
      const o = makeOutcomes({ findSession: session, transcriptPath: () => '' });
      expect((await runAndClose(o)).skillUsed?.versionUncertain, `render-commit at ts${commitAt - ts >= 0 ? '+' : ''}${commitAt - ts} ms`).toBe(expected);
    }
    // Inside the window but AFTER the row's ts (the session had already loaded the skill) ⇒ certain.
    SafeFsExecutor.safeRmSync(path.join(stateDir, 'skill-learning'), { recursive: true, force: true, operation: 'tests/unit/skill-learning-outcomes.test.ts' });
    renderCommitAt(ts + 60_000, 'm_beta');
    expect((await runAndClose(makeOutcomes({ findSession: session, transcriptPath: () => '' }))).skillUsed?.versionUncertain).toBe(false);
  });

  it('another machine\'s render-commit never makes this row uncertain (its renderings are not what this session loaded); a row with no machine id is never uncertain', async () => {
    telemetryAt(T0 + 30_000, 'm_beta');
    renderCommitAt(T0 + 10_000, 'm_alpha');                       // this machine rendered, but the row is m_beta's
    renderCommitAt(T0 + 10_000, 'm_beta', 'other-skill');         // same machine, another skill
    const o = makeOutcomes({ findSession: session, transcriptPath: () => '' });
    expect((await runAndClose(o)).skillUsed?.versionUncertain).toBe(false);
    expect(o.counters().versionUncertain).toBe(0);
    SafeFsExecutor.safeRmSync(path.join(stateDir, 'skill-telemetry'), { recursive: true, force: true, operation: 'tests/unit/skill-learning-outcomes.test.ts' });
    telemetryAt(T0 + 30_000, 'm_beta', { machine_id: '' });
    renderCommitAt(T0 + 10_000, 'm_beta');
    expect((await runAndClose(makeOutcomes({ findSession: session, transcriptPath: () => '' }))).skillUsed?.versionUncertain).toBe(false);
  });

  it('operator-edited: the telemetry machine\'s baseline conflict for the rendering the session\'s framework loads, recorded at or before ts ⇒ operatorEdited (counted); later, other rel, other machine ⇒ not', async () => {
    const ts = T0 + 30_000;
    const claudeRel = '.claude/skills/ci-health-report/SKILL.md';
    const agentsRel = '.agents/skills/ci-health-report/SKILL.md';
    const run = async (framework: 'claude-code' | 'codex-cli') => {
      const o = makeOutcomes({ findSession: () => ({ claudeSessionId: 'uuid-1', framework }), transcriptPath: () => '' });
      const out = await runAndClose(o);
      return { edited: out.skillUsed?.operatorEdited === true, counter: o.counters().operatorEdited };
    };
    telemetryAt(ts, 'm_beta');
    conflictShard('m_beta', claudeRel, ts);
    expect(await run('claude-code')).toEqual({ edited: true, counter: 1 });
    conflictShard('m_beta', claudeRel, ts + 1);                   // recorded after the load
    expect(await run('claude-code')).toEqual({ edited: false, counter: 0 });
    conflictShard('m_beta', agentsRel, ts - 1);                   // the other layout's rendering
    expect(await run('claude-code')).toEqual({ edited: false, counter: 0 });
    expect(await run('codex-cli')).toEqual({ edited: true, counter: 1 });   // a codex session loads .agents
    conflictShard('m_alpha', claudeRel, ts - 1);                  // another machine's shard
    SafeFsExecutor.safeRmSync(path.join(stateDir, 'skill-learning', 'rendered-baselines', 'm_beta.json'), { force: true, operation: 'tests/unit/skill-learning-outcomes.test.ts' });
    expect(await run('claude-code')).toEqual({ edited: false, counter: 0 });
    fs.writeFileSync(path.join(stateDir, 'skill-learning', 'rendered-baselines', 'm_beta.json'), '{ torn');
    expect(await run('claude-code')).toEqual({ edited: false, counter: 0 });
  });
});
