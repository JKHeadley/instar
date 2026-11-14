// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/**
 * `mode: shadow` stops every slice-3 write (docs/specs/skill-learning-sentinel.md §9 rollback; second-pass review
 * finding 1): a shadow tick over a retirable, a revertable and a patchable canonical runs the same judgment
 * (the reviewer calls are measured) but makes ZERO `write`/`move` calls on the protocol and logs the three
 * `would-retire` / `would-revert` / `would-patch` rows; the write-heals answer `shadow`; the attention signals
 * carry `live: false`. Flipping to live acts on each judgment once (the would-* marks do not hold a live tick).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillDoc } from '../../src/monitoring/skillLearning/Drafter.js';
import { Retirer } from '../../src/monitoring/skillLearning/Retirer.js';
import type { SkillLearningSignals } from '../../src/monitoring/skillLearning/types.js';
import { DAY, FakeLedger, NOW, SKILL_NAME, cfg, cleanupHomes, fam, harness, mkHome, readLog, sha256, type Home } from '../helpers/skillLearningLiveFixtures.js';

afterEach(() => cleanupHomes());

const BODY1 = '# CI health report\n\n1. Read the CI health route at /ci/health.\n2. Summarise failing jobs and the slowest runs in plain language.\n';
const BODY2 = '# CI health report\n\n1. Read the CI health route at /ci/health.\n2. Summarise failing jobs, the slowest runs and the flaky tests in plain language.\n';
const LINE2 = '2. Summarise failing jobs and the slowest runs in plain language.';
const RETIRABLE = 'stale-deploy-note';
const REVERTABLE = 'release-digest';

const rawOf = (name: string, key: string, body: string, version: number) => [
  '---', `name: ${name}`, `description: "Use when the operator asks for ${name.replace(/-/g, ' ')}. Not for anything else."`,
  'metadata:', '  instar-learned-origin: "skill-learning-sentinel"', `  instar-learned-key: "${key}"`, `  instar-learned-version: "${version}"`,
  `  instar-learned-created: "${new Date(NOW - 40 * DAY).toISOString()}"`, '  instar-learned-locked: "false"', '  instar-learned-state: "active"', '---', body,
].join('\n');

function writeCanonical(home: Home, name: string, raw: string): void {
  const dir = path.join(home.root, '.instar', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), raw);
}

let seq = 0;
function use(ledger: FakeLedger, home: Home, key: string, skill: string, bodyHash: string, label: 'corrected' | 'accepted', at: number): void {
  const i = seq++;
  const session = `sess-${i}`;
  ledger.append({ kind: 'request', eventId: `req-${i}`, source: { channel: 'telegram', chatId: '-100', messageId: `m${i}` }, topicId: '42', sessionName: session, at: new Date(at).toISOString(), channel: 'telegram', identity: 'verified', state: 'classified', procedureKey: key, runId: `run-${i}`, machineId: 'm1' });
  ledger.append({ kind: 'outcome', eventId: `out-${i}`, runId: `run-${i}`, revision: 1, procedureKey: key, topicId: '42', sessionName: session, label, provisional: false, windowStart: new Date(at).toISOString(), windowEnd: new Date(at + 600_000).toISOString(), at: new Date(at + 600_000).toISOString(), machineId: 'm1', skillUsed: { skill, contentHash: bodyHash, corroborated: true, versionUncertain: false } });
  const file = path.join(home.root, `${session}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: new Date(at + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'curl http://localhost:4040/ci/health' } }] } })}\n`);
  home.transcripts.set(session, file);
}

/** Three live canonicals: retirable (3 corrected corroborated runs, reviewer says retire), revertable (v2 harmful vs v1), patchable (one corrected run). */
function rig(mode: 'shadow' | 'live') {
  seq = 0;
  const home = mkHome(); const ledger = new FakeLedger();
  const calls: string[] = [];
  const answer = (prompt: string): string => {
    if (prompt.startsWith('You are the skill-learning reviewer judging whether a LEARNED skill should be retired')) {
      return prompt.includes(`Skill: ${RETIRABLE} `) ? '{"verdict":"retire","harm":true,"reason":"every run was corrected"}' : '{"verdict":"keep","harm":false,"reason":"fine"}';
    }
    if (prompt.startsWith('You are the reviewer of a LEARNED SKILL')) {
      return prompt.includes(`"${SKILL_NAME}"`) ? JSON.stringify({ action: 'patch', hunks: [{ before: LINE2, after: '2. Summarise failing jobs, the slowest runs and the flaky tests in plain language.', answers: 'out-6' }], reason: 'answers it' }) : '{"action":"no-change","reason":"the body is right"}';
    }
    if (prompt.startsWith('You are the independent reviewer')) return '{"follows":true,"lines":{},"reason":"grounded"}';
    throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
  };
  const families = [fam('anthropic', 'claude-code', answer, calls), fam('openai', 'codex-cli', answer, calls)];
  const current = { mode };
  const signals: SkillLearningSignals[] = [];
  const h = harness(home, ledger, families, {
    mode: () => current.mode, rungTwoProven: () => true,
    attention: { tick: async (s: SkillLearningSignals) => { signals.push(s); } },
  }, cfg({ mode }));
  const versions = h.protocol.versions;
  const retirer = new Retirer({
    projectDir: home.root, stateDir: home.stateDir, machineId: 'm1', config: cfg(), commitProtocol: h.protocol, versions,
    reviewer: null, restoreReviewer: null, existingSkills: () => [], appendLog: (row) => (h.sentinel as unknown as { appendLog(r: Record<string, unknown>): void }).appendLog(row), now: () => NOW,
  });
  // The sentinel binds the retirer's reviewer fns in its constructor; bind the late one the same way the harness-less path does.
  (h.sentinel as unknown as { deps: { retirer: Retirer | null } }).deps.retirer = retirer;
  retirer.bind({
    reviewer: (input) => (h.sentinel as unknown as { retireReview(i: unknown): Promise<unknown> }).retireReview(input) as never,
    restoreReviewer: (input) => (h.sentinel as unknown as { restoreReview(i: unknown): Promise<unknown> }).restoreReview(input) as never,
    existingSkills: () => h.sentinel.loadExistingSkills().map((e) => ({ name: e.name, description: e.description, learned: e.learned })),
    appendLog: (row) => (h.sentinel as unknown as { appendLog(r: Record<string, unknown>): void }).appendLog(row),
  });

  // Retirable: v1, three corroborated corrected runs (score 0.2 < 0.4 at the floor of 3).
  const rRaw = rawOf(RETIRABLE, 'k-retire', '# Deploy note\n\n1. Read the deploy note at /deploy/notes.\n', 1);
  writeCanonical(home, RETIRABLE, rRaw);
  versions.append(RETIRABLE, { txId: 'tx-r1', fileHash: sha256(rRaw), bodyHash: sha256('# Deploy note\n\n1. Read the deploy note at /deploy/notes.\n'), epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'create', state: 'active', authorFamily: 'anthropic', at: new Date(NOW - 30 * DAY).toISOString() });
  for (let i = 0; i < 3; i++) use(ledger, home, 'k-retire', RETIRABLE, sha256('# Deploy note\n\n1. Read the deploy note at /deploy/notes.\n'), 'corrected', NOW - (10 - i) * DAY);
  // Revertable: v1 (1/3 corrected) → v2 (2/3 corrected), both bodies kept.
  const v1 = rawOf(REVERTABLE, 'k-revert', BODY1, 1); const v2 = rawOf(REVERTABLE, 'k-revert', BODY2, 2);
  versions.append(REVERTABLE, { txId: 'tx-v1', fileHash: sha256(v1), bodyHash: sha256(BODY1), epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'create', state: 'active', authorFamily: 'anthropic', at: new Date(NOW - 30 * DAY).toISOString() });
  versions.append(REVERTABLE, { txId: 'tx-v2', fileHash: sha256(v2), bodyHash: sha256(BODY2), epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'patch', state: 'active', authorFamily: 'openai', reviewerFamily: 'anthropic', citedCorrections: ['c-a'], at: new Date(NOW - 20 * DAY).toISOString() });
  versions.storeBody(REVERTABLE, sha256(v1), v1); versions.storeBody(REVERTABLE, sha256(v2), v2);
  writeCanonical(home, REVERTABLE, v2);
  use(ledger, home, 'k-revert', REVERTABLE, sha256(BODY1), 'corrected', NOW - 9 * DAY); use(ledger, home, 'k-revert', REVERTABLE, sha256(BODY1), 'accepted', NOW - 8 * DAY); use(ledger, home, 'k-revert', REVERTABLE, sha256(BODY1), 'accepted', NOW - 7 * DAY);
  // v2 (the live body): 2 corrected + 1 accepted — but only one corrected run for the reviewer to see after a would-revert.
  // Patchable: v1 with one corrected + one accepted run (run-6 is the corrected one).
  const pRaw = rawOf(SKILL_NAME, 'ci-health', BODY1, 1);
  writeCanonical(home, SKILL_NAME, pRaw);
  versions.append(SKILL_NAME, { txId: 'tx-p1', fileHash: sha256(pRaw), bodyHash: sha256(BODY1), epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'create', state: 'active', authorFamily: 'anthropic', at: new Date(NOW - 30 * DAY).toISOString() });
  use(ledger, home, 'ci-health', SKILL_NAME, sha256(BODY1), 'corrected', NOW - 3 * DAY);
  use(ledger, home, 'ci-health', SKILL_NAME, sha256(BODY1), 'accepted', NOW - 2 * DAY);
  use(ledger, home, 'k-revert', REVERTABLE, sha256(BODY2), 'corrected', NOW - 6 * DAY); use(ledger, home, 'k-revert', REVERTABLE, sha256(BODY2), 'corrected', NOW - 5 * DAY); use(ledger, home, 'k-revert', REVERTABLE, sha256(BODY2), 'accepted', NOW - 4 * DAY);
  return { ...h, current, signals, calls, retirer };
}

const stateOf = (home: Home, name: string) => parseSkillDoc(fs.readFileSync(path.join(home.root, '.instar', 'skills', name, 'SKILL.md'), 'utf-8'))!.metadata['instar-learned-state'];

describe('mode: shadow stops every slice-3 write', () => {
  it('a shadow tick over a retirable + revertable + patchable canonical makes ZERO write/move calls, logs would-retire / would-revert / would-patch, signals live:false, and the write-heals answer shadow', async () => {
    const r = rig('shadow');
    const s = await r.sentinel.tick();
    expect(s.phaseFailures).toEqual([]);
    expect(s.observeOnly).toBe(false);
    expect(r.protocol.calls).toEqual([]);
    expect(r.protocol.moves).toEqual([]);
    const log = readLog(r.home);
    expect(log.find((x) => x.kind === 'would-retire')).toMatchObject({ name: RETIRABLE, version: 1, retireKind: 'score', harm: true, by: 'reviewer', mode: 'shadow' });
    expect(log.find((x) => x.kind === 'would-revert')).toMatchObject({ name: REVERTABLE, rejectedVersion: 2, restoredVersion: 1, version: 3, mode: 'shadow', uncertainty: { nCorrected: 2, nRuns: 3, prevRate: 1 / 3 } });
    expect(log.find((x) => x.kind === 'would-patch')).toMatchObject({ name: SKILL_NAME, state: 'active', version: 2, cited: ['out-6'], hunksApplied: 1, mode: 'shadow' });
    expect(log.filter((x) => ['retire', 'revert', 'patch', 'lock', 'revert-refused', 'revert-breaker'].includes(String(x.kind)))).toEqual([]);
    for (const name of [RETIRABLE, REVERTABLE, SKILL_NAME]) expect(stateOf(r.home, name), name).toBe('active');
    expect(fs.existsSync(path.join(r.home.stateDir, 'skill-learning', 'retired'))).toBe(false);
    expect(r.sentinel.internalCounters()).toMatchObject({ wouldRetire: 1, wouldRevert: 1, wouldPatch: 1, patches: 0, reverts: 0, retires: 0 });
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]).toMatchObject({ live: false, holdsLease: true });
    expect(r.ledger.rows.filter((x) => x.kind === 'event' && (x.event === 'revert-refused' || x.event === 'revert-breaker'))).toEqual([]);
    expect(await r.sentinel.healRevertFirst({ skill: REVERTABLE, version: 2 })).toMatchObject({ healed: false, reason: 'shadow' });
    expect(await r.sentinel.healRetireLowestUnused({ key: 'k', indexBytes: null, claudeHeadroomChars: null })).toMatchObject({ healed: false, reason: 'shadow' });
    expect(r.protocol.calls).toEqual([]);
    // Shadow is idempotent: the next shadow tick repeats no judgment (the would-* marks hold shadow ticks).
    const callsAfterFirst = r.calls.length;
    await r.sentinel.tick();
    expect(r.calls).toHaveLength(callsAfterFirst);
    expect(readLog(r.home).filter((x) => String(x.kind).startsWith('would-'))).toHaveLength(3);
  });

  it('flipping to live acts on each shadow judgment ONCE: the same canonicals are retired, reverted and patched through the protocol', async () => {
    const r = rig('shadow');
    await r.sentinel.tick();
    expect(r.protocol.calls).toEqual([]);
    r.current.mode = 'live';
    const s = await r.sentinel.tick();
    expect(s.phaseFailures).toEqual([]);
    expect(r.signals[1]).toMatchObject({ live: true });
    expect(r.protocol.moves.map((m) => [m.op, m.name])).toEqual([['retire', RETIRABLE]]);
    expect(r.protocol.calls.map((c) => [c.op, c.name])).toEqual([['revert', REVERTABLE], ['patch', SKILL_NAME]]);
    expect(parseSkillDoc(fs.readFileSync(path.join(r.home.root, '.instar', 'skills', REVERTABLE, 'SKILL.md'), 'utf-8'))!.body).toBe(BODY1);
    expect(parseSkillDoc(fs.readFileSync(path.join(r.home.root, '.instar', 'skills', SKILL_NAME, 'SKILL.md'), 'utf-8'))!.body).toContain('flaky tests');
    const log = readLog(r.home);
    expect(log.filter((x) => x.kind === 'revert')).toHaveLength(1);
    expect(log.filter((x) => x.kind === 'patch')).toHaveLength(1);
  });
});
