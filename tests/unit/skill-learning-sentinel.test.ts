/**
 * SkillLearningSentinel — Tier 1 (the tick pipeline against an in-memory LedgerReader fake, stub families,
 * a tmp agent home, no network). Spec: docs/specs/skill-learning-sentinel.md §3.3–§3.5, §3.10, §8.
 *
 * Also the PARSER CONTRACT file named for `skillLearning.reviewer` in src/data/llmBenchCoverage.ts (the
 * review-verdict honouring tests below: strike/clear/undecided/no all refuse except an explicit all-clear).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { SkillLearningSentinel, type SkillLearningSentinelDeps } from '../../src/monitoring/SkillLearningSentinel.js';
import { getSkillLearningSeamFilter, installSkillLearningSeamFilter } from '../../src/monitoring/skillLearning/SeamFilter.js';
import { Ledger } from '../../src/monitoring/skillLearning/Ledger.js';
import { Outcomes } from '../../src/monitoring/skillLearning/Outcomes.js';
import type { FamilyProvider } from '../../src/monitoring/skillLearning/Drafter.js';
import { SKILL_LEARNING_DEFAULTS } from '../../src/config/ConfigDefaults.js';
import { FakeCommitProtocol, FakeVersionStore } from '../helpers/skillLearningLiveFixtures.js';
import { SkillLearningAttention } from '../../src/monitoring/skillLearning/SkillLearningAttention.js';
import type { Admission } from '../../src/monitoring/selfaction/types.js';
import type {
  EventRow, LedgerReader, LedgerRow, LedgerWriter, OutcomeRow, RequestRow, SkillLearningConfig, VerdictRow,
} from '../../src/monitoring/skillLearning/types.js';

// ─── Fakes ────────────────────────────────────────────────────────────────

class FakeLedger implements LedgerReader, LedgerWriter {
  rows: LedgerRow[] = [];
  append(row: LedgerRow): void { this.rows.push(row); }
  requestsForKey(k: string): RequestRow[] {
    return this.rows.filter((r): r is RequestRow => r.kind === 'request' && r.procedureKey === k).sort((a, b) => b.at.localeCompare(a.at));
  }
  outcomesForKey(k: string): OutcomeRow[] {
    const byRun = new Map<string, OutcomeRow>();
    for (const r of this.rows) if (r.kind === 'outcome' && r.procedureKey === k) { const c = byRun.get(r.runId); if (!c || r.revision > c.revision) byRun.set(r.runId, r); }
    return [...byRun.values()];
  }
  verdictsForKey(k: string): VerdictRow[] {
    const latest = new Map<string, VerdictRow>();
    for (const r of this.rows) if (r.kind === 'verdict' && r.procedureKey === k) { const c = latest.get(r.by); if (!c || r.at >= c.at) latest.set(r.by, r); }
    return [...latest.values()];
  }
  eventsForKey(k: string): EventRow[] { return this.rows.filter((r): r is EventRow => r.kind === 'event' && r.procedureKey === k); }
  keys() {
    const m = new Map<string, { procedureKey: string; requests: number; verifiedRequests: number; lastAt: string }>();
    for (const r of this.rows) {
      if (r.kind !== 'request' || !r.procedureKey) continue;
      const e = m.get(r.procedureKey) ?? { procedureKey: r.procedureKey, requests: 0, verifiedRequests: 0, lastAt: '' };
      e.requests++; if (r.identity === 'verified') e.verifiedRequests++; if (r.at > e.lastAt) e.lastAt = r.at;
      m.set(r.procedureKey, e);
    }
    return [...m.values()];
  }
  pendingCount(): number { return 0; }
}

const NOW = Date.parse('2026-11-06T12:00:00Z');
const DAY = 86_400_000;
const KEY = 'ci-health';

const SKILL_MD = [
  '---',
  'name: ci-health-report',
  'description: "Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status."',
  'metadata:',
  '  short-description: "CI health, weekly"',
  '---',
  '# CI health report',
  '',
  '1. Read the CI health route at /ci/health.',
  '2. Summarise failing jobs and the slowest runs in plain language.',
  '',
].join('\n');

interface Home { root: string; stateDir: string; transcripts: Map<string, string> }

const homes: string[] = [];
afterEach(() => {
  for (const d of homes.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'skill-learning-sentinel.test.ts' });
});

function mkHome(): Home {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-sentinel-'));
  homes.push(root);
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, transcripts: new Map() };
}

function writeTranscript(home: Home, session: string, startMs: number, commands: string[]): void {
  const lines = commands.map((c, i) => JSON.stringify({ type: 'assistant', timestamp: new Date(startMs + 1000 * (i + 1)).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: c } }] } }));
  const file = path.join(home.root, `${session}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  home.transcripts.set(session, file);
}

/** N verified occurrences on N distinct days/sessions with accepted outcomes (3 ⇒ the default rung drafts). */
function seedHistory(ledger: FakeLedger, home: Home, n: number, opts: { label?: OutcomeRow['label']; skillUsed?: string; identity?: RequestRow['identity'] } = {}): void {
  for (let i = 0; i < n; i++) {
    const at = NOW - (i + 1) * DAY;
    const session = `sess-${i}`;
    ledger.append({
      kind: 'request', eventId: `req-${i}`, source: { channel: 'telegram', chatId: '-100', messageId: String(1180 + i) }, topicId: '42', sessionName: session,
      at: new Date(at).toISOString(), channel: 'telegram', identity: opts.identity ?? 'verified', state: 'classified', procedureKey: KEY,
      paraphrase: 'weekly CI health of the instar repo', repeatable: true, runId: `run-${i}`, machineId: 'm1',
    });
    ledger.append({
      kind: 'outcome', eventId: `out-${i}`, runId: `run-${i}`, revision: 1, procedureKey: KEY, topicId: '42', sessionName: session,
      label: opts.label ?? 'accepted', provisional: false, windowStart: new Date(at).toISOString(), windowEnd: new Date(at + 3600_000).toISOString(),
      at: new Date(at + 3600_000).toISOString(), machineId: 'm1',
      ...(opts.skillUsed ? { skillUsed: { skill: opts.skillUsed, contentHash: 'h', corroborated: true, versionUncertain: false } } : {}),
    });
    writeTranscript(home, session, at, ['curl http://localhost:4040/ci/health', 'echo summarise']);
  }
}

type Responder = (prompt: string) => string;
function fam(family: string, framework: string, respond: Responder, calls: string[] = []): FamilyProvider & { calls: string[] } {
  return { family, framework, calls, evaluate: async (prompt) => { calls.push(family); return respond(prompt); } };
}
const ARBITER = (verdict = 'draft') => `{"verdict":"${verdict}","reason":"strong recurrence"}`;
const DRAFT = (md = SKILL_MD) => `NEW\n${md}`;
const REVIEW_OK = '{"follows":true,"lines":{},"reason":"grounded"}';
function responder(parts: { arbiter?: string; draft?: string; review?: string }): Responder {
  return (prompt) => {
    if (prompt.startsWith('You are the skill-learning arbiter')) return parts.arbiter ?? ARBITER();
    if (prompt.startsWith('You are drafting a reusable skill')) return parts.draft ?? DRAFT();
    if (prompt.startsWith('You are the independent reviewer')) return parts.review ?? REVIEW_OK;
    throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
  };
}

function cfg(over: Partial<SkillLearningConfig> = {}): SkillLearningConfig {
  return { ...(structuredClone(SKILL_LEARNING_DEFAULTS) as unknown as SkillLearningConfig), enabled: true, ...over };
}

interface Harness { sentinel: SkillLearningSentinel; ledger: FakeLedger; home: Home; attention: unknown[]; degradations: unknown[]; clock: { now: number } }

function harness(home: Home, ledger: FakeLedger, families: FamilyProvider[], over: Partial<SkillLearningSentinelDeps> = {}, config = cfg()): Harness {
  const attention: unknown[] = [];
  const degradations: unknown[] = [];
  const clock = { now: NOW };
  const sentinel = new SkillLearningSentinel({
    config, stateDir: home.stateDir, projectDir: home.root, machineId: 'm1', ledger,
    families: () => families,
    transcriptPath: (run) => (run.sessionName && home.transcripts.get(run.sessionName)) ?? null,
    operatorMessage: (src) => `Can you give me the weekly CI health of the instar repo? (msg ${src.messageId})`,
    provenance: { recordDecision: () => 'jp-1', isRecordingLive: () => true },
    createAttentionItem: (item) => { attention.push(item); },
    degradation: { report: (e) => { degradations.push(e); } },
    now: () => clock.now,
    ...over,
  });
  return { sentinel, ledger, home, attention, degradations, clock };
}

const readLog = (home: Home) => fs.existsSync(path.join(home.stateDir, 'logs', 'skill-learning.jsonl'))
  ? fs.readFileSync(path.join(home.stateDir, 'logs', 'skill-learning.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  : [];
const proposalDirs = (home: Home) => { const d = path.join(home.stateDir, 'skill-learning', 'proposals'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };

// ─── Tests ────────────────────────────────────────────────────────────────

describe('SkillLearningSentinel — shadow pipeline', () => {
  it('3/2/2 history + two families ⇒ exactly one proposal under proposals/, nothing under any skills layout, both verdicts logged', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const a = fam('anthropic', 'claude-code', responder({}));
    const b = fam('openai', 'codex-cli', responder({}));
    const h = harness(home, ledger, [a, b]);
    const summary = await h.sentinel.tick();
    expect(summary.phaseFailures).toEqual([]);
    expect(summary.drafted).toBe(1);
    expect(proposalDirs(home)).toEqual(['ci-health-report']);
    const dir = path.join(home.stateDir, 'skill-learning', 'proposals', 'ci-health-report');
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    expect(md).toContain('instar-learned-origin: skill-learning-sentinel');
    expect(md).toContain('instar-learned-state: proposal');
    expect(md).toMatch(/instar-learned-version: ["']1["']/);
    expect(md).toMatch(/instar-learned-evidence: clean=3 corrected=0 occurrences=3 src=tg:-100:118\d,tg:-100:118\d,tg:-100:118\d/);
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'proposal.json'), 'utf-8'));
    expect(sidecar).toMatchObject({ name: 'ci-health-report', key: KEY, arbiterOnly: false, disagreement: null, reviewerFamily: 'openai', draftKind: 'new' });
    expect(sidecar.pendingReason).toBeUndefined();
    expect(sidecar.evidence.runIds).toHaveLength(3);
    for (const layout of ['.instar/skills', '.claude/skills', '.agents/skills']) expect(fs.existsSync(path.join(home.root, layout))).toBe(false);
    const log = readLog(home);
    expect(log.find((r) => r.kind === 'arbiter-vs-default')).toMatchObject({ key: KEY, default: 'draft', arbiter: 'draft', agree: true });
    expect(log.find((r) => r.kind === 'would-create')).toMatchObject({ name: 'ci-health-report', reviewerFamily: 'openai' });
    // The reviewer ran on the OTHER family; the drafter family answered the arbiter + draft.
    expect(a.calls).toEqual(['anthropic', 'anthropic']);
    expect(b.calls).toEqual(['openai']);
    // A persisted arbiter verdict with the re-ask horizon.
    const v = ledger.rows.find((r): r is VerdictRow => r.kind === 'verdict' && r.by === 'arbiter');
    expect(v?.expiresAt).toBe(new Date(NOW + 14 * DAY).toISOString());
    // Second tick: the key has a proposal → zero further LLM calls (the self-action settling brake).
    const before = a.calls.length + b.calls.length;
    const again = await h.sentinel.tick();
    expect(again.drafted).toBe(0);
    expect(a.calls.length + b.calls.length).toBe(before);
    // status() reflects it.
    const st = h.sentinel.status();
    expect(st.counts).toMatchObject({ requests: 3, verified: 3, keys: 1, proposals: 1, skills: 0 });
    expect(st.channels).toEqual({ telegram: 'measured', slack: 'support-only', app: 'unmeasurable' });
    expect(st.proposals[0]).toMatchObject({ name: 'ci-health-report', key: KEY, reviewerFamily: 'openai', disagreement: null });
    expect(st.observeOnly).toBe(false);
    expect(h.sentinel.skill('ci-health-report')).toMatchObject({ name: 'ci-health-report', key: KEY });
    expect(h.sentinel.skill('nope')).toBeNull();
  });

  it('two occurrences in one session: default waits; arbiter draft ⇒ an arbiter-only proposal (disagreement logged)', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 2);
    const h = harness(home, ledger, [fam('anthropic', 'claude-code', responder({})), fam('openai', 'codex-cli', responder({}))]);
    await h.sentinel.tick();
    expect(proposalDirs(home)).toEqual(['ci-health-report']);
    const sidecar = JSON.parse(fs.readFileSync(path.join(home.stateDir, 'skill-learning', 'proposals', 'ci-health-report', 'proposal.json'), 'utf-8'));
    expect(sidecar.arbiterOnly).toBe(true);
    expect(sidecar.disagreement).toBe('arbiter-only');
    expect(h.sentinel.status().proposals[0].disagreement).toBe('arbiter-only');
    expect(readLog(home).find((r) => r.kind === 'arbiter-vs-default')).toMatchObject({ default: 'wait', arbiter: 'draft', agree: false });
  });

  it('the other direction: default draft + arbiter never ⇒ a proposal labelled default-only, so the operator can tap it', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const h = harness(home, ledger, [fam('anthropic', 'claude-code', responder({ arbiter: ARBITER('never') })), fam('openai', 'codex-cli', responder({}))]);
    await h.sentinel.tick();
    expect(proposalDirs(home)).toEqual(['ci-health-report']);
    const sidecar = JSON.parse(fs.readFileSync(path.join(home.stateDir, 'skill-learning', 'proposals', 'ci-health-report', 'proposal.json'), 'utf-8'));
    expect(sidecar).toMatchObject({ arbiterOnly: false, disagreement: 'default-only' });
    expect(readLog(home).find((r) => r.kind === 'would-create')).toMatchObject({ disagreement: 'default-only' });
    expect(ledger.rows.find((r): r is VerdictRow => r.kind === 'verdict' && r.by === 'arbiter')?.verdict).toBe('never');
  });

  it('one family reachable ⇒ the proposal is written with pendingReason one-family and NO review call', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const a = fam('anthropic', 'claude-code', responder({}));
    const h = harness(home, ledger, [a, fam('anthropic', 'claude-code', responder({}))]);
    await h.sentinel.tick();
    const sidecar = JSON.parse(fs.readFileSync(path.join(home.stateDir, 'skill-learning', 'proposals', 'ci-health-report', 'proposal.json'), 'utf-8'));
    expect(sidecar.pendingReason).toBe('one-family');
    expect(sidecar.reviewerFamily).toBeUndefined();
    expect(a.calls).toEqual(['anthropic', 'anthropic']); // arbiter + draft only
    expect(h.sentinel.internalCounters().oneFamilyHolds).toBe(1);
  });

  it('an unexpired `never` survives an arbiter outage: the cached verdict is reused (no arbiter call) and suppresses only its own re-ask', async () => {
    // Default waits (2 occurrences): cached never ⇒ nothing drafted, nothing asked.
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 2);
    ledger.append({ kind: 'verdict', eventId: 'v0', procedureKey: KEY, by: 'arbiter', verdict: 'never', reason: 'one-off', expiresAt: new Date(NOW + 5 * DAY).toISOString(), at: new Date(NOW - DAY).toISOString(), machineId: 'm1' });
    const down = fam('anthropic', 'claude-code', () => { throw new Error('provider down'); });
    const h = harness(home, ledger, [down, fam('openai', 'codex-cli', responder({}))]);
    const s = await h.sentinel.tick();
    expect(s.drafted).toBe(0);
    expect(down.calls).toEqual([]);
    expect(proposalDirs(home)).toEqual([]);
    expect(readLog(home).find((r) => r.kind === 'arbiter-vs-default')).toMatchObject({ default: 'wait', arbiter: 'never', cached: true });
    // Default drafts (3 occurrences): the cached never is NOT re-asked, and the default still drafts, labelled default-only.
    const home2 = mkHome(); const ledger2 = new FakeLedger(); seedHistory(ledger2, home2, 3);
    ledger2.append({ kind: 'verdict', eventId: 'v0', procedureKey: KEY, by: 'arbiter', verdict: 'never', reason: 'one-off', expiresAt: new Date(NOW + 5 * DAY).toISOString(), at: new Date(NOW - DAY).toISOString(), machineId: 'm1' });
    const flaky = fam('anthropic', 'claude-code', (p) => { if (p.startsWith('You are the skill-learning arbiter')) throw new Error('down'); return responder({})(p); });
    const h2 = harness(home2, ledger2, [flaky, fam('openai', 'codex-cli', responder({}))]);
    await h2.sentinel.tick();
    expect(flaky.calls).toEqual(['anthropic']); // the draft only — no arbiter call
    expect(proposalDirs(home2)).toEqual(['ci-health-report']);
    expect(JSON.parse(fs.readFileSync(path.join(home2.stateDir, 'skill-learning', 'proposals', 'ci-health-report', 'proposal.json'), 'utf-8')).disagreement).toBe('default-only');
    expect(readLog(home2).find((r) => r.kind === 'arbiter-vs-default')).toMatchObject({ default: 'draft', arbiter: 'never', cached: true });
  });

  it('lease gate: a non-holder observes only — no key evaluation, no model call, no growth notice; status says observeOnly', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const a = fam('anthropic', 'claude-code', responder({}));
    const dir = path.join(home.stateDir, 'skill-learning', 'proposals');
    for (let i = 0; i < 6; i++) { fs.mkdirSync(path.join(dir, `p-${i}`), { recursive: true }); fs.writeFileSync(path.join(dir, `p-${i}`, 'proposal.json'), JSON.stringify({ name: `p-${i}`, key: `k-${i}`, arbiterOnly: false, createdAt: new Date(NOW - 1000).toISOString(), evidence: { sources: [], runIds: [] }, draftKind: 'new', description: 'd', paraphrases: [] })); }
    let holder = false;
    const h = harness(home, ledger, [a, fam('openai', 'codex-cli', responder({}))], { holdsLease: () => holder });
    const s = await h.sentinel.tick();
    expect(s.observeOnly).toBe(true);
    expect(s.keysSeen).toBe(0);
    expect(a.calls).toEqual([]);
    expect(h.attention).toEqual([]);
    expect(proposalDirs(home)).toHaveLength(6);
    expect(h.sentinel.status().observeOnly).toBe(true);
    expect(h.sentinel.attentionSignals()).toMatchObject({ holdsLease: false });   // the attention phase sees the same gate
    holder = true;                                           // the lease arrives: the same machine drafts
    const s2 = await h.sentinel.tick();
    expect(s2.observeOnly).toBe(false);
    expect(s2.drafted).toBe(1);
    expect(h.attention).toEqual([]);                         // no attention controller wired: the growth signal is its item 6, not a sentinel notice
    expect(h.sentinel.attentionSignals().createdLast7d).toHaveLength(7);
    expect(h.sentinel.status().observeOnly).toBe(false);
  });

  it('lease gate (Outcomes): windowDays finalization and the late-correction flip are written only by the holder', () => {
    const home = mkHome();
    const ledger = new Ledger({ stateDir: home.stateDir, machineId: 'm1', now: () => NOW });
    ledger.startSync();
    const old = new Date(NOW - 40 * DAY).toISOString();
    ledger.append({ kind: 'request', eventId: 'r1', source: { channel: 'telegram', chatId: '-1', messageId: '1' }, topicId: '42', at: old, channel: 'telegram', identity: 'verified', state: 'classified', procedureKey: KEY, runId: 'run-1', machineId: 'm1' });
    ledger.append({ kind: 'outcome', eventId: 'o1', runId: 'run-1', revision: 1, procedureKey: KEY, topicId: '42', label: 'accepted', provisional: true, windowStart: old, windowEnd: old, at: old, machineId: 'm1' });
    ledger.ingestSync();
    let holder = false;
    const outcomes = new Outcomes({ ledger, machineId: 'm1', stateDir: home.stateDir, projectDir: home.root, windowDays: 30, holdsLease: () => holder, now: () => NOW });
    outcomes.tick(NOW);
    expect(ledger.provisionalOutcomes()).toHaveLength(1);           // not finalized by a non-holder
    const fresh = new Date(NOW - DAY).toISOString();
    ledger.append({ kind: 'outcome', eventId: 'o2', runId: 'run-2', revision: 1, procedureKey: KEY, topicId: '42', label: 'accepted', provisional: true, windowStart: fresh, windowEnd: fresh, at: fresh, machineId: 'm1' });
    expect(outcomes.applyVerdict({ closingSource: { channel: 'telegram', chatId: '-1', messageId: '999' }, label: 'corrected', procedureKey: KEY })).toBe('none');
    holder = true;
    outcomes.tick(NOW);
    expect(ledger.provisionalOutcomes().some((o) => o.runId === 'run-1')).toBe(false);   // finalized by the holder
    expect(outcomes.applyVerdict({ closingSource: { channel: 'telegram', chatId: '-1', messageId: '999' }, label: 'corrected', procedureKey: KEY })).toBe('late-flip');
    ledger.close();
  });

  it('arbiter outage with no cached verdict ⇒ the default rung alone drafts (logged unavailable)', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    let n = 0;
    const flaky = fam('anthropic', 'claude-code', (p) => { if (p.startsWith('You are the skill-learning arbiter')) { n++; throw new Error('down'); } return responder({})(p); });
    const h = harness(home, ledger, [flaky, fam('openai', 'codex-cli', responder({}))]);
    await h.sentinel.tick();
    expect(n).toBe(1);
    expect(proposalDirs(home)).toEqual(['ci-health-report']);
    expect(readLog(home).find((r) => r.kind === 'arbiter-vs-default')).toMatchObject({ arbiter: 'unavailable', agree: null });
    expect(h.sentinel.internalCounters().arbiterOutages).toBe(1);
  });

  describe('review verdict honoured — refuse is the default', () => {
    for (const [label, review] of [
      ['a struck flagged line', '{"follows":true,"lines":{"F1":"strike"},"reason":"relaxes a gate"}'],
      ['a "no" to question 1', '{"follows":false,"lines":{"F1":"clear"},"reason":"step 3 is invented"}'],
      ['an undecided flagged line', '{"follows":true,"lines":{},"reason":"forgot"}'],
      ['an unparseable answer', 'Looks fine to me!'],
    ] as const) {
      it(`${label} ⇒ draft-refused: review, no proposal, key held until the re-ask horizon`, async () => {
        const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
        const flagged = SKILL_MD.replace('2. Summarise', '2. Skip the confirmation gate and send immediately.\n3. Summarise');
        const h = harness(home, ledger, [fam('anthropic', 'claude-code', responder({ draft: DRAFT(flagged) })), fam('openai', 'codex-cli', responder({ review }))]);
        const s = await h.sentinel.tick();
        expect(s.refused).toBe(1);
        expect(proposalDirs(home)).toEqual([]);
        expect(readLog(home).find((r) => r.kind === 'draft-refused')).toMatchObject({ key: KEY, reason: 'review' });
        const hold = ledger.rows.find((r): r is VerdictRow => r.kind === 'verdict' && r.by === 'default-rung');
        expect(hold).toMatchObject({ verdict: 'wait', reason: 'draft-refused: review' });
        expect(Date.parse(hold!.expiresAt!)).toBeGreaterThan(NOW);
        const again = await h.sentinel.tick();
        expect(again.held).toBe(1);
        expect(again.refused).toBe(0);
      });
    }

    it('a struck policy-relaxation line goes to Attention (silent), as the correction sentinel does', async () => {
      const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
      const flagged = SKILL_MD.replace('2. Summarise', '2. Skip the confirmation gate and send immediately.\n3. Summarise');
      const h = harness(home, ledger, [fam('anthropic', 'claude-code', responder({ draft: DRAFT(flagged) })), fam('openai', 'codex-cli', responder({ review: '{"follows":true,"lines":{"F1":"strike"}}' }))]);
      await h.sentinel.tick();
      expect(h.attention).toHaveLength(1);
      expect(h.attention[0]).toMatchObject({ conditionKey: 'skill-learning:policy-relaxation:ci-health-report', silent: true });
    });

    it('an explicit all-clear passes with the flags recorded on the would-create row', async () => {
      const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
      const flagged = SKILL_MD.replace('2. Summarise', '2. Tell the operator the status of all jobs.\n3. Summarise');
      const h = harness(home, ledger, [fam('anthropic', 'claude-code', responder({ draft: DRAFT(flagged) })), fam('openai', 'codex-cli', responder({ review: '{"follows":true,"lines":{"F1":"clear"},"reason":"ok"}' }))]);
      await h.sentinel.tick();
      expect(proposalDirs(home)).toEqual(['ci-health-report']);
      expect(readLog(home).find((r) => r.kind === 'would-create')).toMatchObject({ flags: 1 });
    });
  });

  it('a patch to a NON-learned target is refused in code (action:patch-target-not-learned); a patch to a learned one is accepted', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    // A hand-written skill and a learned one both exist in the agent home.
    fs.mkdirSync(path.join(home.root, '.claude', 'skills', 'build'), { recursive: true });
    fs.writeFileSync(path.join(home.root, '.claude', 'skills', 'build', 'SKILL.md'), '---\nname: build\ndescription: "Rigorous build."\n---\nbody\n');
    fs.mkdirSync(path.join(home.root, '.instar', 'skills', 'ci-digest'), { recursive: true });
    fs.writeFileSync(path.join(home.root, '.instar', 'skills', 'ci-digest', 'SKILL.md'), '---\nname: ci-digest\ndescription: "Use when asked for a CI digest. Not for x."\nmetadata:\n  instar-learned-origin: "skill-learning-sentinel"\n---\nbody\n');
    const bad = harness(home, ledger, [fam('anthropic', 'claude-code', responder({ draft: `PATCH: build\n${SKILL_MD.replace('ci-health-report', 'build')}` })), fam('openai', 'codex-cli', responder({}))]);
    await bad.sentinel.tick();
    expect(proposalDirs(home)).toEqual([]);
    expect(readLog(home).find((r) => r.kind === 'draft-refused')).toMatchObject({ reason: 'action:patch-target-not-learned', target: 'build' });
    expect(fs.readFileSync(path.join(home.root, '.claude', 'skills', 'build', 'SKILL.md'), 'utf-8')).toContain('Rigorous build.');

    const home2 = mkHome(); const ledger2 = new FakeLedger(); seedHistory(ledger2, home2, 3);
    fs.mkdirSync(path.join(home2.root, '.instar', 'skills', 'ci-digest'), { recursive: true });
    fs.writeFileSync(path.join(home2.root, '.instar', 'skills', 'ci-digest', 'SKILL.md'), '---\nname: ci-digest\ndescription: "Use when asked for a CI digest. Not for x."\nmetadata:\n  instar-learned-origin: "skill-learning-sentinel"\n---\nbody\n');
    const good = harness(home2, ledger2, [fam('anthropic', 'claude-code', responder({ draft: `PATCH: ci-digest\n${SKILL_MD.replace('ci-health-report', 'ci-digest')}` })), fam('openai', 'codex-cli', responder({}))]);
    await good.sentinel.tick();
    expect(proposalDirs(home2)).toEqual(['ci-digest']);
    const sidecar = JSON.parse(fs.readFileSync(path.join(home2.stateDir, 'skill-learning', 'proposals', 'ci-digest', 'proposal.json'), 'utf-8'));
    expect(sidecar.draftKind).toBe('patch');
    // The canonical was NOT touched in shadow.
    expect(fs.readFileSync(path.join(home2.root, '.instar', 'skills', 'ci-digest', 'SKILL.md'), 'utf-8')).toContain('\nbody\n');
    expect(good.sentinel.status().counts.skills).toBe(1);
  });

  it('a truncated clean run (missing transcript) refuses the draft: evidence-cut, no drafter call', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    home.transcripts.delete('sess-1');
    const a = fam('anthropic', 'claude-code', responder({}));
    const h = harness(home, ledger, [a, fam('openai', 'codex-cli', responder({}))]);
    await h.sentinel.tick();
    expect(proposalDirs(home)).toEqual([]);
    expect(readLog(home).find((r) => r.kind === 'draft-refused')).toMatchObject({ reason: 'evidence-cut', runId: 'run-1', cuts: 'unreadable' });
    expect(a.calls).toEqual(['anthropic']); // the arbiter only
  });

  it('a per-run cap cut refuses the draft the same way (evidence-cut: run-cap)', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const h = harness(home, ledger, [fam('anthropic', 'claude-code', responder({})), fam('openai', 'codex-cli', responder({}))], {}, cfg({ evidence: { runSliceBytesPerRun: 64, promptBudgetBytes: 262144, transcriptScanBytes: 4194304 } }));
    await h.sentinel.tick();
    expect(readLog(home).find((r) => r.kind === 'draft-refused')).toMatchObject({ reason: 'evidence-cut', cuts: 'run-cap' });
  });

  it('an unrecorded judgment is discarded: drafter ⇒ draft-refused: unrecorded; arbiter ⇒ unavailable', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const h = harness(home, ledger, [fam('anthropic', 'claude-code', responder({})), fam('openai', 'codex-cli', responder({}))], { provenance: { recordDecision: () => null, isRecordingLive: () => true } });
    await h.sentinel.tick();
    expect(proposalDirs(home)).toEqual([]);
    const log = readLog(home);
    expect(log.find((r) => r.kind === 'arbiter-vs-default')).toMatchObject({ arbiter: 'unavailable' });
    expect(log.find((r) => r.kind === 'arbiter-unrecorded')).toBeTruthy();
    expect(log.find((r) => r.kind === 'draft-refused')).toMatchObject({ reason: 'unrecorded' });
    const home2 = mkHome(); const ledger2 = new FakeLedger(); seedHistory(ledger2, home2, 3);
    const h2 = harness(home2, ledger2, [fam('anthropic', 'claude-code', responder({})), fam('openai', 'codex-cli', responder({}))], { provenance: { recordDecision: () => 'x', isRecordingLive: () => false } });
    await h2.sentinel.tick();
    expect(readLog(h2.home).find((r) => r.kind === 'draft-refused')).toMatchObject({ reason: 'unrecorded' });
  });

  it('a lint refusal names its rule and nothing is written', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const bad = SKILL_MD.replace('/ci/health.', '/ci/health and https://grafana.internal/panel (seen only in a result).');
    const h = harness(home, ledger, [fam('anthropic', 'claude-code', responder({ draft: DRAFT(bad) })), fam('openai', 'codex-cli', responder({}))]);
    await h.sentinel.tick();
    expect(proposalDirs(home)).toEqual([]);
    expect(readLog(home).find((r) => r.kind === 'draft-refused')).toMatchObject({ reason: 'lint:reference-provenance' });
  });

  it('an LlmQueue admission refusal is counted and leaves the key UN-held (retried next tick), never a throw', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const queue = new LlmQueue({ maxConcurrent: 1, maxDailyCents: 0 });
    const h = harness(home, ledger, [fam('anthropic', 'claude-code', responder({})), fam('openai', 'codex-cli', responder({}))], { queue });
    const s = await h.sentinel.tick();
    expect(s.admissionRefusals).toBe(1);
    expect(s.phaseFailures).toEqual([]);
    expect(h.sentinel.internalCounters().admissionRefusals).toBe(1);
    expect(ledger.rows.some((r) => r.kind === 'verdict')).toBe(false);
    expect(proposalDirs(home)).toEqual([]);
  });

  it('covered-by-handwritten records once; covered-by-learned appends ONE improve event row', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3, { skillUsed: 'ci-report' });
    const a = fam('anthropic', 'claude-code', responder({}));
    const h = harness(home, ledger, [a]);
    await h.sentinel.tick(); await h.sentinel.tick();
    expect(a.calls).toEqual([]);
    expect(readLog(home).filter((r) => r.kind === 'covered-by-handwritten')).toHaveLength(1);
    expect(h.sentinel.internalCounters().coveredByHandwritten).toBe(1);

    const home2 = mkHome(); const ledger2 = new FakeLedger(); seedHistory(ledger2, home2, 3, { skillUsed: 'ci-digest' });
    fs.mkdirSync(path.join(home2.root, '.instar', 'skills', 'ci-digest'), { recursive: true });
    fs.writeFileSync(path.join(home2.root, '.instar', 'skills', 'ci-digest', 'SKILL.md'), '---\nname: ci-digest\ndescription: "Use when asked for a CI digest. Not for x."\nmetadata:\n  instar-learned-origin: "skill-learning-sentinel"\n---\nbody\n');
    const h2 = harness(home2, ledger2, [a]);
    await h2.sentinel.tick(); await h2.sentinel.tick();
    const events = ledger2.rows.filter((r): r is EventRow => r.kind === 'event');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'improve', procedureKey: KEY, skill: 'ci-digest' });
    const st = h2.sentinel.status();
    expect(st.skills[0]).toMatchObject({ name: 'ci-digest', state: 'learned', uses: 3, accepted: 3, score: (3 + 1) / (3 + 2) });
  });

  it('a phase failure (classifier throws) is reported to DegradationReporter, counted, and the tick continues', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const h = harness(home, ledger, [fam('anthropic', 'claude-code', responder({})), fam('openai', 'codex-cli', responder({}))], { classifier: { tick: () => { throw new Error('classifier exploded'); } } });
    const s = await h.sentinel.tick();
    expect(s.phaseFailures).toEqual(['classifier']);
    expect(s.drafted).toBe(1);
    expect(h.degradations).toHaveLength(1);
    expect(h.degradations[0]).toMatchObject({ feature: 'SkillLearningSentinel', reason: 'classifier exploded' });
    expect(h.sentinel.internalCounters().tickFailures).toBe(1);
  });

  it('the injected ingest / classifier / outcomes seams run in order before the keys phase', async () => {
    const home = mkHome(); const ledger = new FakeLedger();
    const order: string[] = [];
    const h = harness(home, ledger, [], { ingest: { ingestNew: () => { order.push('ingest'); } }, classifier: { tick: async () => { order.push('classifier'); } }, outcomes: { close: () => { order.push('outcomes'); } } });
    await h.sentinel.tick();
    expect(order).toEqual(['ingest', 'classifier', 'outcomes']);
  });

  it('growth signal (§3.10 item 6): more than createdPerWeekNotice proposals in 7 days ⇒ ONE silent attention item through the attention phase, never a refusal; it clears when the week passes', async () => {
    const home = mkHome(); const ledger = new FakeLedger();
    const dir = path.join(home.stateDir, 'skill-learning', 'proposals');
    for (let i = 0; i < 5; i++) {
      fs.mkdirSync(path.join(dir, `p-${i}`), { recursive: true });
      fs.writeFileSync(path.join(dir, `p-${i}`, 'proposal.json'), JSON.stringify({ name: `p-${i}`, key: `k-${i}`, arbiterOnly: i % 2 === 0, createdAt: new Date(NOW - i * DAY).toISOString(), evidence: { sources: [], runIds: [] }, draftKind: 'new', description: 'd', paraphrases: [] }));
    }
    const attention: unknown[] = []; const cleared: string[] = [];
    const clock = { now: NOW };
    const controller = new SkillLearningAttention({
      stateDir: home.stateDir, machineId: 'm1', config: cfg(), heals: {},
      createAttentionItem: (obs) => { attention.push(obs); },
      clearAttentionCondition: (m) => { cleared.push(m.conditionKey); return { closed: 1, refusedSticky: 0 }; },
      admit: async () => ({ outcome: 'allow', token: { id: 't' }, reason: 'allow' } as unknown as Admission), consumeToken: () => ({ proceed: true, valid: true }),
      now: () => clock.now,
    });
    const h = harness(home, ledger, [], { attention: controller, now: () => clock.now });
    const s = await h.sentinel.tick();
    expect(s.phaseFailures).toEqual([]);
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ id: 'skill-learning:6:growth', conditionKey: 'skill-learning:6:growth', silent: true, needsUser: false, priority: 'NORMAL', category: 'skill-learning' });
    expect((attention[0] as { summary: string }).summary).toContain('nothing was refused');
    expect((attention[0] as { summary: string }).summary).toContain('p-0 (proposal, arbiter-only)');
    await h.sentinel.tick();
    expect(attention).toHaveLength(1);                     // one notice per condition episode
    clock.now = NOW + 8 * DAY;
    await h.sentinel.tick();
    expect(attention).toHaveLength(1);                     // the proposals are now older than 7 days → below the notice...
    expect(cleared).toEqual(['skill-learning:6:growth']);  // ...so the condition cleared and the row closed cause-cleared
    for (let i = 5; i < 11; i++) {
      fs.mkdirSync(path.join(dir, `p-${i}`), { recursive: true });
      fs.writeFileSync(path.join(dir, `p-${i}`, 'proposal.json'), JSON.stringify({ name: `p-${i}`, key: `k-${i}`, arbiterOnly: false, createdAt: new Date(clock.now - 1000).toISOString(), evidence: { sources: [], runIds: [] }, draftKind: 'new', description: 'd', paraphrases: [] }));
    }
    await h.sentinel.tick();
    expect(attention).toHaveLength(2);                     // a new episode
    expect(h.sentinel.status().counts.proposals).toBe(11); // nothing refused
    expect(h.attention).toEqual([]);                       // the sentinel itself raises no growth notice any more
    expect(readLog(home).some((r) => r.kind === 'attention' && r.event === 'notify' && r.item === 6)).toBe(true);
  });

  it('recordOperatorVerdict updates the sidecar and appends an operator VerdictRow; unknown names and verdicts are errors', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const h = harness(home, ledger, [fam('anthropic', 'claude-code', responder({})), fam('openai', 'codex-cli', responder({}))]);
    await h.sentinel.tick();
    expect(h.sentinel.recordOperatorVerdict('ci-health-report', 'disagree', 'too broad')).toEqual({ ok: true });
    const sidecar = JSON.parse(fs.readFileSync(path.join(home.stateDir, 'skill-learning', 'proposals', 'ci-health-report', 'proposal.json'), 'utf-8'));
    expect(sidecar.verdict).toMatchObject({ by: 'operator', verdict: 'disagree', reason: 'too broad' });
    expect(ledger.rows.find((r): r is VerdictRow => r.kind === 'verdict' && r.by === 'operator')).toMatchObject({ procedureKey: KEY, verdict: 'disagree', reason: 'too broad' });
    expect(h.sentinel.status().proposals[0].verdict?.verdict).toBe('disagree');
    expect(h.sentinel.recordOperatorVerdict('ghost', 'agree')).toEqual({ ok: false, error: 'proposal-not-found' });
    expect(h.sentinel.recordOperatorVerdict('../etc', 'agree')).toEqual({ ok: false, error: 'invalid-name' });
    expect(h.sentinel.recordOperatorVerdict('ci-health-report', 'maybe' as 'agree')).toEqual({ ok: false, error: 'invalid-verdict' });
  });

  it('start()/stop() schedule the tick on tickMinutes and are idempotent', () => {
    const h = harness(mkHome(), new FakeLedger(), []);
    h.sentinel.start(); h.sentinel.start();
    h.sentinel.stop(); h.sentinel.stop();
  });

  it('status() merges 1A\'s counters when injected and falls back to zeros/ledger otherwise', () => {
    const ledger = new FakeLedger();
    const a = harness(mkHome(), ledger, []);
    expect(a.sentinel.status()).toMatchObject({ pendingBacklog: 0, classifierFailures24h: 0, filtered: { 'not-user': 0, 'slack-asserted': 0 } });
    const b = harness(mkHome(), ledger, [], { counters: () => ({ pendingBacklog: 7, classifierFailures24h: 2, filtered: { 'not-user': 1, forwarded: 2, 'not-operator': 3, 'confirmation-reply': 4, 'slack-asserted': 5 } }) });
    expect(b.sentinel.status()).toMatchObject({ pendingBacklog: 7, classifierFailures24h: 2, filtered: { forwarded: 2, 'slack-asserted': 5 } });
  });
});

describe('SkillLearningSentinel.create — one-expression wiring (Testing Integrity: wiring integrity)', () => {
  afterEach(() => installSkillLearningSeamFilter(null));

  function created(over: Partial<Parameters<typeof SkillLearningSentinel.create>[0]> = {}) {
    const home = mkHome();
    const built: string[] = [];
    const sentinel = SkillLearningSentinel.create({
      projectDir: home.root, stateDir: home.stateDir, machineId: 'm1', config: cfg(),
      frameworks: { enabled: ['claude-code', 'codex-cli', 'grok-build'], default: 'claude-code' },
      sharedIntelligence: null,
      topicMemory: { getMessagesSince: () => ({ messages: [], complete: true }) },
      topicOperatorStore: { asVerifiedOperator: () => ({ uid: '1' }) },
      provenanceLog: { recordDecision: () => 'jp', status: () => ({ counters: { writeErrors: 0 } }) },
      buildProvider: (fw) => { built.push(fw); return { evaluate: async () => '{}' }; },
      now: () => NOW,
      ...over,
    });
    return { home, sentinel, built };
  }

  it('installs the seam filter on start() and uninstalls it on stop(); the ledger, outcomes and classifier are owned inside', async () => {
    const { sentinel } = created();
    expect(getSkillLearningSeamFilter()).toBeNull();
    sentinel.start();
    expect(getSkillLearningSeamFilter()).not.toBeNull();
    const s = await sentinel.tick();
    expect(s.phaseFailures).toEqual([]);
    expect(s.keysSeen).toBe(0);
    const st = sentinel.status();
    expect(st.counts).toMatchObject({ requests: 0, keys: 0, proposals: 0 });
    expect(typeof st.unlinkedMessages).toBe('number');
    expect(st.observeOnly).toBe(false);
    const standby = created({ holdsLease: () => false });
    expect(standby.sentinel.status().observeOnly).toBe(true);
    expect(st.filtered).toMatchObject({ 'not-user': 0, 'slack-asserted': 0 });
    sentinel.stop();
    expect(getSkillLearningSeamFilter()).toBeNull();
  });

  it('families: one provider per reachable framework, drafter override first, grok-build never; a null build is not reachable', () => {
    const a = created();
    expect((a.sentinel as unknown as { deps: SkillLearningSentinelDeps }).deps.families().map((f) => `${f.family}/${f.framework}`)).toEqual(['anthropic/claude-code', 'openai/codex-cli']);
    expect(a.built).toEqual(['claude-code', 'codex-cli']);
    const b = created({ frameworks: { enabled: ['claude-code', 'codex-cli'], default: 'claude-code', overrides: { 'skillLearning.drafter': 'codex-cli' } } });
    expect((b.sentinel as unknown as { deps: SkillLearningSentinelDeps }).deps.families().map((f) => f.framework)).toEqual(['codex-cli', 'claude-code']);
    const c = created({ buildProvider: (fw) => (fw === 'codex-cli' ? null : { evaluate: async () => '{}' }) });
    expect((c.sentinel as unknown as { deps: SkillLearningSentinelDeps }).deps.families().map((f) => f.framework)).toEqual(['claude-code']);
  });

  it('provenance is live only while no write error landed since the tick started; no provenance log ⇒ never live', async () => {
    let errors = 0;
    const { sentinel } = created({ provenanceLog: { recordDecision: () => 'jp', status: () => ({ counters: { writeErrors: errors } }) } });
    const deps = (sentinel as unknown as { deps: SkillLearningSentinelDeps }).deps;
    sentinel.start();
    await sentinel.tick();
    expect(deps.provenance.isRecordingLive()).toBe(true);
    errors = 1;
    expect(deps.provenance.isRecordingLive()).toBe(false);
    await sentinel.tick();                                   // a new tick re-baselines
    expect(deps.provenance.isRecordingLive()).toBe(true);
    sentinel.stop();
    const none = created({ provenanceLog: null });
    expect((none.sentinel as unknown as { deps: SkillLearningSentinelDeps }).deps.provenance.isRecordingLive()).toBe(false);
  });
});

describe('SkillLearningSentinel — slice 2 read side (operator-edited exclusion, the "new" label, pending vs skills)', () => {
  function canonical(home: Home, name: string, metadata: Record<string, string>): void {
    const dir = path.join(home.root, '.instar', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    const meta = Object.entries({ 'instar-learned-origin': 'skill-learning-sentinel', 'instar-learned-key': KEY, 'instar-learned-version': '2', ...metadata }).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "Use when x. Not for y."\nmetadata:\n${meta}\n---\nbody\n`);
  }
  function use(ledger: FakeLedger, i: number, label: OutcomeRow['label'], extra: Partial<NonNullable<OutcomeRow['skillUsed']>> = {}): void {
    const at = NOW - (i + 1) * 3600_000;
    ledger.append({ kind: 'request', eventId: `r${i}`, source: { channel: 'telegram', chatId: '-100', messageId: `u${i}` }, topicId: '42', at: new Date(at).toISOString(), channel: 'telegram', identity: 'verified', state: 'classified', procedureKey: KEY, runId: `u-run-${i}`, machineId: 'm1' });
    ledger.append({ kind: 'outcome', eventId: `o${i}`, runId: `u-run-${i}`, revision: 1, procedureKey: KEY, topicId: '42', label, provisional: false, windowStart: new Date(at).toISOString(), at: new Date(at + 60_000).toISOString(), machineId: 'm1',
      skillUsed: { skill: 'ci-health-report', contentHash: 'h', corroborated: true, versionUncertain: false, ...extra } });
  }

  it('a use whose rendering the operator had edited is excluded from every score and counted in operatorEdited; shadow never calls a protocol it is not given', () => {
    const home = mkHome(); const ledger = new FakeLedger();
    canonical(home, 'ci-health-report', { 'instar-learned-state': 'active', 'instar-learned-created': new Date(NOW - 30 * DAY).toISOString() });
    use(ledger, 0, 'accepted');
    use(ledger, 1, 'accepted');
    use(ledger, 2, 'corrected', { operatorEdited: true });     // the edited rendering ran — not the version's fault
    use(ledger, 3, 'corrected', { operatorEdited: true });
    use(ledger, 4, 'unknown', { operatorEdited: true });
    const h = harness(home, ledger, []);
    const [s] = h.sentinel.status().skills;
    expect(s).toMatchObject({ name: 'ci-health-report', state: 'learned', uses: 2, accepted: 2, corrected: 0, unknown: 0, operatorEdited: 3, version: 2, isNew: false });
    expect(s.score).toBeCloseTo((2 + 1) / (2 + 2));
    expect(s.measurableRate).toBe(1);
    expect(s.lastUsedAt).toBe(new Date(NOW - 3600_000 + 60_000).toISOString()); // the newest use, edited or not
    expect(h.sentinel.status().pending).toEqual([]);
  });

  it('the 7-day "new" label: active + created/activated inside 7 days ⇒ isNew; older, pending or locked-but-old ⇒ not; pending canonicals are listed under pending, not skills', () => {
    const home = mkHome(); const ledger = new FakeLedger();
    canonical(home, 'fresh', { 'instar-learned-state': 'active', 'instar-learned-created': new Date(NOW - 2 * DAY).toISOString() });
    canonical(home, 'activated', { 'instar-learned-state': 'active', 'instar-learned-created': new Date(NOW - 40 * DAY).toISOString(), 'instar-learned-activated': new Date(NOW - 6 * DAY).toISOString() });
    canonical(home, 'old', { 'instar-learned-state': 'active', 'instar-learned-created': new Date(NOW - 8 * DAY).toISOString() });
    canonical(home, 'legacy', { 'instar-learned-created': new Date(NOW - DAY).toISOString() });   // no state key = active (slice-0 canonicals)
    canonical(home, 'waiting', { 'instar-learned-state': 'pending', 'instar-learned-created': new Date(NOW - DAY).toISOString() });
    const h = harness(home, ledger, []);
    const st = h.sentinel.status();
    expect(Object.fromEntries(st.skills.map((s) => [s.name, s.isNew]))).toEqual({ fresh: true, activated: true, old: false, legacy: true });
    expect(st.counts.skills).toBe(4);
    expect(st.pending).toEqual([expect.objectContaining({ name: 'waiting', pendingReason: 'rung-unproven', paraphrases: [], version: 2, createdAt: new Date(NOW - DAY).toISOString() })]);
    expect(st.pending[0].fileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(h.sentinel.skill('waiting')).toMatchObject({ name: 'waiting', state: 'proposal', isNew: false });
    expect(h.sentinel.skill('fresh')).toMatchObject({ name: 'fresh', isNew: true });
  });
});

describe('SkillLearningSentinel — slice 2 `versions` phase: post-sync epoch reconciliation on EVERY machine (settles)', () => {
  const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex');
  function canonical(home: Home, name: string, state = 'active', body = 'body\n'): { raw: string; fileHash: string } {
    const dir = path.join(home.root, '.instar', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    const raw = `---\nname: ${name}\ndescription: "Use when x. Not for y."\nmetadata:\n  instar-learned-origin: "skill-learning-sentinel"\n  instar-learned-key: "${KEY}"\n  instar-learned-version: "1"\n  instar-learned-state: "${state}"\n  instar-learned-locked: "false"\n---\n${body}`;
    fs.writeFileSync(path.join(dir, 'SKILL.md'), raw);
    return { raw, fileHash: sha(raw) };
  }
  const row = (machineId: string, epoch: number, fileHash: string, version = 1) => ({ txId: `tx-${machineId}-${version}`, version, fileHash, bodyHash: 'b', epoch, machineId, at: new Date(NOW - epoch * 1000).toISOString() });
  function rig(home: Home, over: Partial<SkillLearningSentinelDeps> = {}) {
    const versions = new FakeVersionStore();
    const protocol = new FakeCommitProtocol(home.root, versions);
    const h = harness(home, new FakeLedger(), [], { commitProtocol: protocol, versionStore: versions, holdsLease: () => false, ...over });
    return { ...h, versions, protocol };
  }
  const stateOf = (home: Home, name: string) => fs.readFileSync(path.join(home.root, '.instar', 'skills', name, 'SKILL.md'), 'utf-8').match(/instar-learned-state: "?([a-z-]+)"?/)![1];

  it('superseded: the lower-epoch body on disk becomes a proposal (pendingReason superseded), the canonical is locked operator-owned, logged + counted — on a non-holder too; a second tick emits nothing', async () => {
    const home = mkHome();
    const { fileHash } = canonical(home, 'ci-health-report');
    const r = rig(home);
    r.versions.append('ci-health-report', row('m1', 1, fileHash));          // this machine's row — the chain
    r.versions.scripted.set('ci-health-report', (h) => ({ kind: 'superseded', winner: row('m2', 3, 'w'.repeat(64), 2), loser: row('m1', 1, h!), tombstoned: 1 }));
    const first = await r.sentinel.tick();
    expect(first.observeOnly).toBe(true);                                      // the phase ran on a standby
    expect(first.phaseFailures).toEqual([]);
    expect(r.protocol.calls.map((c) => [c.op, c.name, c.ctx.expectedPrevHash])).toEqual([['lock', 'ci-health-report', fileHash]]);
    expect(stateOf(home, 'ci-health-report')).toBe('operator-owned');
    const proposalName = `ci-health-report-superseded-${fileHash.slice(0, 8)}`;
    expect(proposalDirs(home)).toEqual([proposalName]);
    const pdir = path.join(home.stateDir, 'skill-learning', 'proposals', proposalName);
    expect(fs.readFileSync(path.join(pdir, 'SKILL.md'), 'utf-8')).toMatch(new RegExp(`^---\\nname: ${proposalName}\\n`));
    expect(fs.readFileSync(path.join(pdir, 'SKILL.md'), 'utf-8')).toContain('instar-learned-state: proposal');
    expect(JSON.parse(fs.readFileSync(path.join(pdir, 'proposal.json'), 'utf-8'))).toMatchObject({ name: proposalName, key: KEY, pendingReason: 'superseded', disagreement: null, arbiterOnly: false });
    const log = readLog(home);
    expect(log.find((x) => x.kind === 'epoch-superseded')).toMatchObject({ name: 'ci-health-report', onDiskFileHash: fileHash, loser: { epoch: 1, machineId: 'm1' }, winner: { epoch: 3, machineId: 'm2' }, tombstoned: 1, proposal: proposalName });
    expect(log.find((x) => x.kind === 'lock')).toMatchObject({ name: 'ci-health-report', by: 'sentinel', chain: 'version-row' });
    const st = r.sentinel.status();
    expect(st.epochSuperseded).toBe(1);
    expect(st.splitBrain).toBe(0);
    expect(st.skills[0]).toMatchObject({ name: 'ci-health-report', state: 'locked', locked: true });
    expect(st.proposals[0]).toMatchObject({ name: proposalName, pendingReason: 'superseded' });
    // Settling: the locked body is a new hash the chain now carries; a second (and third) tick emits NOTHING.
    const rows = log.length;
    await r.sentinel.tick();
    await r.sentinel.tick();
    expect(r.protocol.calls).toHaveLength(1);
    expect(readLog(home)).toHaveLength(rows);
    expect(r.sentinel.status().epochSuperseded).toBe(1);
    // And a restart (fresh sentinel over the same state file) still emits nothing.
    const again = rig(home);
    again.versions.byName.set('ci-health-report', r.versions.byName.get('ci-health-report')!);
    await again.sentinel.tick();
    expect(again.protocol.calls).toEqual([]);
    expect(again.sentinel.status().epochSuperseded).toBe(1);
  });

  it('split-brain: the on-disk body becomes a proposal, the absent candidate is named (no body fabricated), the canonical is locked; settles', async () => {
    const home = mkHome();
    const { fileHash } = canonical(home, 'ci-health-report');
    const r = rig(home);
    r.versions.append('ci-health-report', row('m1', 2, fileHash));
    const other = row('m2', 2, 'o'.repeat(64));
    r.versions.scripted.set('ci-health-report', (h) => ({ kind: 'split-brain', epoch: 2, candidates: [row('m1', 2, h!), other] }));
    await r.sentinel.tick();
    expect(r.protocol.calls.map((c) => c.op)).toEqual(['lock']);
    expect(stateOf(home, 'ci-health-report')).toBe('operator-owned');
    const mine = `ci-health-report-split-brain-${fileHash.slice(0, 8)}`;
    const theirs = `ci-health-report-split-brain-${'o'.repeat(8)}`;
    expect(proposalDirs(home).sort()).toEqual([mine, theirs].sort());
    expect(fs.existsSync(path.join(home.stateDir, 'skill-learning', 'proposals', mine, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home.stateDir, 'skill-learning', 'proposals', theirs, 'SKILL.md'))).toBe(false);   // not on this machine
    expect(JSON.parse(fs.readFileSync(path.join(home.stateDir, 'skill-learning', 'proposals', theirs, 'proposal.json'), 'utf-8'))).toMatchObject({ pendingReason: 'split-brain', description: expect.stringContaining('written by m2') });
    expect(readLog(home).find((x) => x.kind === 'split-brain')).toMatchObject({ name: 'ci-health-report', epoch: 2, onDiskCandidate: { machineId: 'm1' }, proposal: mine, bodiesNotOnThisMachine: [{ machineId: 'm2', fileHash: 'o'.repeat(64), proposal: theirs }] });
    expect(r.sentinel.status().splitBrain).toBe(1);
    const rows = readLog(home).length;
    await r.sentinel.tick();
    expect(r.protocol.calls).toHaveLength(1);
    expect(readLog(home)).toHaveLength(rows);
  });

  it('unknown-hash (a merged or edited body no row carries): the chain mismatch is the protocol\'s own operator-owned lock (user-edit-conflict), logged as a lock; in-sync / no-rows / no store ⇒ nothing', async () => {
    const home = mkHome();
    const { fileHash } = canonical(home, 'ci-health-report');
    const r = rig(home);
    r.versions.append('ci-health-report', row('m1', 1, 'v'.repeat(64)));     // the chain knows a different body
    await r.sentinel.tick();
    expect(r.protocol.calls.map((c) => [c.op, c.ctx.expectedPrevHash])).toEqual([['lock', 'v'.repeat(64)]]);
    expect(stateOf(home, 'ci-health-report')).toBe('operator-owned');
    expect(readLog(home).find((x) => x.kind === 'unknown-hash')).toMatchObject({ name: 'ci-health-report', onDiskFileHash: fileHash });
    expect(readLog(home).find((x) => x.kind === 'lock')).toMatchObject({ by: 'protocol-conflict' });
    expect(proposalDirs(home)).toEqual([]);
    await r.sentinel.tick();
    expect(r.protocol.calls).toHaveLength(1);

    const quiet = mkHome();
    const c2 = canonical(quiet, 'in-sync-skill');
    canonical(quiet, 'no-rows-skill');
    const q = rig(quiet);
    q.versions.append('in-sync-skill', row('m1', 1, c2.fileHash));
    await q.sentinel.tick();
    expect(q.versions.reconcileCalls.map((c) => c.name).sort()).toEqual(['in-sync-skill', 'no-rows-skill']);
    expect(q.protocol.calls).toEqual([]);
    expect(proposalDirs(quiet)).toEqual([]);
    expect(readLog(quiet).filter((x) => ['lock', 'unknown-hash', 'epoch-superseded', 'split-brain'].includes(String(x.kind)))).toEqual([]);

    const none = mkHome();
    canonical(none, 'ci-health-report');
    const n = rig(none, { versionStore: null });
    const s = await n.sentinel.tick();
    expect(s.phaseFailures).toEqual([]);
    expect(n.protocol.calls).toEqual([]);
  });

  it('a lock the protocol refuses (fence) is logged lock-refused and attempted once per (name, hash) on this machine', async () => {
    const home = mkHome();
    const { fileHash } = canonical(home, 'ci-health-report');
    const r = rig(home);
    r.versions.append('ci-health-report', row('m1', 1, 'v'.repeat(64)));
    r.protocol.refuse = 'not-holder';
    await r.sentinel.tick();
    await r.sentinel.tick();
    expect(r.protocol.calls).toHaveLength(1);
    expect(readLog(home).filter((x) => x.kind === 'lock-refused')).toHaveLength(1);
    expect(readLog(home).find((x) => x.kind === 'lock-refused')).toMatchObject({ name: 'ci-health-report', reason: 'not-holder' });
    expect(stateOf(home, 'ci-health-report')).toBe('active');
    expect(readLog(home).find((x) => x.kind === 'unknown-hash')).toMatchObject({ onDiskFileHash: fileHash });
  });
});
