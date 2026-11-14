/**
 * Skill Learning Sentinel — Tier 2 (the whole slice-1 pipeline over a fixture ledger and a tmp agent home;
 * stub model families, no network). Spec: docs/specs/skill-learning-sentinel.md §8 "shadow writes only to
 * proposals"; the test-agent replay yields exactly one proposal in shadow.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SkillLearningSentinel } from '../../src/monitoring/SkillLearningSentinel.js';
import { SKILL_LEARNING_DEFAULTS } from '../../src/config/ConfigDefaults.js';
import type { FamilyProvider } from '../../src/monitoring/skillLearning/Drafter.js';
import type { EventRow, LedgerReader, LedgerRow, LedgerWriter, OutcomeRow, RequestRow, SkillLearningConfig, VerdictRow } from '../../src/monitoring/skillLearning/types.js';

class FixtureLedger implements LedgerReader, LedgerWriter {
  rows: LedgerRow[] = [];
  append(row: LedgerRow): void { this.rows.push(row); }
  requestsForKey(k: string): RequestRow[] { return this.rows.filter((r): r is RequestRow => r.kind === 'request' && r.procedureKey === k).sort((a, b) => b.at.localeCompare(a.at)); }
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
      e.requests++; if (r.identity === 'verified') e.verifiedRequests++; if (r.at > e.lastAt) e.lastAt = r.at; m.set(r.procedureKey, e);
    }
    return [...m.values()];
  }
  pendingCount(): number { return 0; }
}

const NOW = Date.parse('2026-11-06T12:00:00Z');
const DAY = 86_400_000;
const homes: string[] = [];
afterEach(() => { for (const d of homes.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'skill-learning-proposal.test.ts' }); });

const SKILL_MD = [
  '---', 'name: ci-health-report',
  'description: "Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status."',
  'metadata:', '  short-description: "CI health, weekly"', '---',
  '# CI health report', '', '1. Read the CI health route at /ci/health.', '2. Summarise failing jobs and the slowest runs in plain language.', '',
].join('\n');

/**
 * A fixture home with `n` verified occurrences on distinct days + sessions (the 3/2/2 history when n = 3),
 * each with an accepted outcome and a transcript holding the agent's own tool calls.
 */
function fixture(n: number, families: Array<{ family: string; framework: string; arbiter: string }>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-integration-'));
  homes.push(root);
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'build', 'SKILL.md'), '---\nname: build\ndescription: "Rigorous build process."\n---\nbody\n');
  const ledger = new FixtureLedger();
  const transcripts = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    const at = NOW - (i + 1) * DAY; const session = `sess-${i}`;
    ledger.append({ kind: 'request', eventId: `req-${i}`, source: { channel: 'telegram', chatId: '-100', messageId: String(1180 + i) }, topicId: '42', sessionName: session, at: new Date(at).toISOString(), channel: 'telegram', identity: 'verified', state: 'classified', procedureKey: 'ci-health', paraphrase: 'weekly CI health', repeatable: true, runId: `run-${i}`, machineId: 'm1' });
    ledger.append({ kind: 'outcome', eventId: `out-${i}`, runId: `run-${i}`, revision: 1, procedureKey: 'ci-health', topicId: '42', sessionName: session, label: 'accepted', provisional: false, windowStart: new Date(at).toISOString(), windowEnd: new Date(at + 3600_000).toISOString(), at: new Date(at + 3600_000).toISOString(), machineId: 'm1' });
    const file = path.join(root, `${session}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: new Date(at + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'curl http://localhost:4040/ci/health' } }] } })}\n`);
    transcripts.set(session, file);
  }
  const calls: string[] = [];
  const providers: FamilyProvider[] = families.map((f) => ({
    family: f.family, framework: f.framework,
    evaluate: async (prompt) => {
      calls.push(f.family);
      if (prompt.startsWith('You are the skill-learning arbiter')) return `{"verdict":"${f.arbiter}","reason":"fixture"}`;
      if (prompt.startsWith('You are drafting a reusable skill')) return `NEW\n${SKILL_MD}`;
      if (prompt.startsWith('You are the independent reviewer')) return '{"follows":true,"lines":{},"reason":"grounded"}';
      throw new Error('unexpected prompt');
    },
  }));
  const config = { ...(structuredClone(SKILL_LEARNING_DEFAULTS) as unknown as SkillLearningConfig), enabled: true };
  const sentinel = new SkillLearningSentinel({
    config, stateDir, projectDir: root, machineId: 'm1', ledger, families: () => providers,
    transcriptPath: (run) => (run.sessionName && transcripts.get(run.sessionName)) ?? null,
    operatorMessage: (src) => `weekly CI health of the instar repo please (msg ${src.messageId})`,
    provenance: { recordDecision: () => 'jp-1', isRecordingLive: () => true },
    now: () => NOW,
  });
  return { root, stateDir, ledger, sentinel, calls };
}

const proposalsOf = (stateDir: string) => { const d = path.join(stateDir, 'skill-learning', 'proposals'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
const treeOf = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : [];

describe('skill-learning proposal pipeline (integration, no network)', () => {
  it('a 3/2/2 history with two stub families yields EXACTLY one proposal, and only under proposals/', async () => {
    const f = fixture(3, [{ family: 'anthropic', framework: 'claude-code', arbiter: 'draft' }, { family: 'openai', framework: 'codex-cli', arbiter: 'draft' }]);
    const before = treeOf(path.join(f.root, '.claude'));
    const s1 = await f.sentinel.tick();
    const s2 = await f.sentinel.tick();
    expect(s1.drafted + s2.drafted).toBe(1);
    expect(proposalsOf(f.stateDir)).toEqual(['ci-health-report']);
    const dir = path.join(f.stateDir, 'skill-learning', 'proposals', 'ci-health-report');
    expect(fs.readdirSync(dir).sort()).toEqual(['SKILL.md', 'proposal.json']);
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8')).toContain('instar-learned-state: proposal');
    // Shadow writes ONLY to proposals: no canonical, no rendering, the hand-written skill untouched.
    expect(fs.existsSync(path.join(f.root, '.instar', 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(f.root, '.agents'))).toBe(false);
    expect(treeOf(path.join(f.root, '.claude'))).toEqual(before);
    // The content-free index log carries the shadow pair and the would-create row.
    const log = fs.readFileSync(path.join(f.stateDir, 'logs', 'skill-learning.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.filter((r) => r.kind === 'arbiter-vs-default')).toHaveLength(1);
    expect(log.filter((r) => r.kind === 'would-create')).toHaveLength(1);
    expect(log.some((r) => JSON.stringify(r).includes('weekly CI health of the instar repo please'))).toBe(false); // no message text in the index
    // Three model calls total: arbiter + draft on family A, review on family B; the second tick made none.
    expect(f.calls).toEqual(['anthropic', 'anthropic', 'openai']);
    const status = f.sentinel.status();
    expect(status.counts.proposals).toBe(1);
    expect(status.proposals[0]).toMatchObject({ name: 'ci-health-report', arbiterOnly: false, reviewerFamily: 'openai' });
    expect(status.lastTickAt).toBe(new Date(NOW).toISOString());
  });

  it('two occurrences yield NO proposal when the arbiter waits (the default rung waits below 3/2/2)', async () => {
    const f = fixture(2, [{ family: 'anthropic', framework: 'claude-code', arbiter: 'wait' }, { family: 'openai', framework: 'codex-cli', arbiter: 'wait' }]);
    await f.sentinel.tick();
    await f.sentinel.tick();
    expect(proposalsOf(f.stateDir)).toEqual([]);
    expect(f.calls).toEqual(['anthropic']); // one arbiter ask; the persisted `wait` holds the key on the second tick
    expect(f.sentinel.status().counts.proposals).toBe(0);
  });

  it('one occurrence never reaches a model (below the floor)', async () => {
    const f = fixture(1, [{ family: 'anthropic', framework: 'claude-code', arbiter: 'draft' }]);
    await f.sentinel.tick();
    expect(f.calls).toEqual([]);
    expect(proposalsOf(f.stateDir)).toEqual([]);
  });
});
