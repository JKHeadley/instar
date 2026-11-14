// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/**
 * Reverter — Tier 1, slice 3A (docs/specs/skill-learning-sentinel.md §3.7 "Bounded auto-revert"; §8 "per-version
 * score, bounded revert, rejected-hash refusal, breaker", "a refused revert leaves N+1 pending with a notice").
 *
 * The Reverter is driven directly over the slice-2 fakes (in-memory ledger, version store, commit protocol) with a
 * canonical on a tmp agent home; one test drives it through the real sentinel tick to prove the phase order
 * (revert before review) and the lease gate.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillDoc } from '../../src/monitoring/skillLearning/Drafter.js';
import { Reverter, revertTrigger, REVERT_WINDOW_MS } from '../../src/monitoring/skillLearning/Reverter.js';
import type { LearnedCanonical, PendingSidecarInput } from '../../src/monitoring/skillLearning/Reviewer.js';
import type { VersionCounts } from '../../src/monitoring/skillLearning/VersionStore.js';
import type { EventRow, OutcomeRow } from '../../src/monitoring/skillLearning/types.js';
import { DAY, FakeCommitProtocol, FakeLedger, FakeVersionStore, KEY, NOW, SKILL_NAME, canonicalPath, cfg, cleanupHomes, fam, harness, mkHome, readLog, sha256, type Home } from '../helpers/skillLearningLiveFixtures.js';

afterEach(() => cleanupHomes());

const BODY1 = '# CI health report\n\n1. Read the CI health route at /ci/health.\n2. Summarise failing jobs and the slowest runs in plain language.\n';
const BODY2 = '# CI health report\n\n1. Read the CI health route at /ci/health.\n2. Summarise failing jobs, the slowest runs and the flaky tests in plain language.\n';

function rawOf(body: string, version: number, state = 'active', locked = false): string {
  return [
    '---', `name: ${SKILL_NAME}`,
    'description: "Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status."',
    'metadata:', '  short-description: "CI health, weekly"', '  instar-learned-origin: "skill-learning-sentinel"', `  instar-learned-key: "${KEY}"`,
    `  instar-learned-version: "${version}"`, `  instar-learned-created: "${new Date(NOW - 30 * DAY).toISOString()}"`, `  instar-learned-locked: "${locked}"`, `  instar-learned-state: "${state}"`, '---', body,
  ].join('\n');
}

function writeCanonical(home: Home, raw: string): void {
  const dir = path.join(home.root, '.instar', 'skills', SKILL_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), raw);
}

function readLearned(home: Home): LearnedCanonical[] {
  const file = canonicalPath(home);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf-8');
  const doc = parseSkillDoc(raw)!;
  return [{ name: SKILL_NAME, raw, fileHash: sha256(raw), doc, state: doc.metadata['instar-learned-state'] ?? 'active', locked: doc.metadata['instar-learned-locked'] === 'true', key: doc.metadata['instar-learned-key'] ?? '' }];
}

let seq = 0;
function uses(ledger: FakeLedger, bodyHash: string, labels: Array<OutcomeRow['label'] | [OutcomeRow['label'], Partial<NonNullable<OutcomeRow['skillUsed']>>]>, atMs = NOW - DAY): void {
  for (const l of labels) {
    const label: OutcomeRow['label'] = Array.isArray(l) ? l[0] : l;
    const extra: Partial<NonNullable<OutcomeRow['skillUsed']>> = Array.isArray(l) ? l[1] : {};
    const i = seq++;
    const at = atMs + i * 60_000;
    ledger.append({ kind: 'request', eventId: `req-${i}`, source: { channel: 'telegram', chatId: '-100', messageId: `m${i}` }, topicId: '42', at: new Date(at).toISOString(), channel: 'telegram', identity: 'verified', state: 'classified', procedureKey: KEY, runId: `run-${i}`, machineId: 'm1' });
    ledger.append({ kind: 'outcome', eventId: `out-${i}`, runId: `run-${i}`, revision: 1, procedureKey: KEY, topicId: '42', label, provisional: false, windowStart: new Date(at).toISOString(), at: new Date(at + 1000).toISOString(), machineId: 'm1', skillUsed: { skill: SKILL_NAME, contentHash: bodyHash, corroborated: true, versionUncertain: false, ...extra } });
  }
}

interface Rig { home: Home; ledger: FakeLedger; versions: FakeVersionStore; protocol: FakeCommitProtocol; reverter: Reverter; sidecars: PendingSidecarInput[]; handled: Map<string, string>; evidence: Array<{ kind: string; reason: string }>; v1: { raw: string; fileHash: string; bodyHash: string }; v2: { raw: string; fileHash: string; bodyHash: string } }

/** v1 (N) → v2 (N+1, a patch citing `c-a`) live on disk, both bodies stored (as the reviewer stores them). */
function rig(opts: { storeV1Body?: boolean; body1?: string; breaker?: number; clock?: { now: number }; archive?: (name: string) => Promise<{ archived: unknown[]; blocked: unknown[]; left: string[] }> } = {}): Rig {
  seq = 0;
  const home = mkHome(); const ledger = new FakeLedger();
  const versions = new FakeVersionStore();
  const protocol = new FakeCommitProtocol(home.root, versions);
  const v1raw = rawOf(opts.body1 ?? BODY1, 1); const v2raw = rawOf(BODY2, 2);
  const v1 = { raw: v1raw, fileHash: sha256(v1raw), bodyHash: sha256(opts.body1 ?? BODY1) };
  const v2 = { raw: v2raw, fileHash: sha256(v2raw), bodyHash: sha256(BODY2) };
  versions.append(SKILL_NAME, { txId: 'tx-v1', fileHash: v1.fileHash, bodyHash: v1.bodyHash, epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'create', state: 'active', authorFamily: 'anthropic', at: new Date(NOW - 20 * DAY).toISOString() });
  versions.append(SKILL_NAME, { txId: 'tx-v2', fileHash: v2.fileHash, bodyHash: v2.bodyHash, epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'patch', state: 'active', authorFamily: 'openai', reviewerFamily: 'anthropic', citedCorrections: ['c-a'], at: new Date(NOW - 10 * DAY).toISOString() });
  if (opts.storeV1Body !== false) versions.storeBody(SKILL_NAME, v1.fileHash, v1raw);
  versions.storeBody(SKILL_NAME, v2.fileHash, v2raw);
  writeCanonical(home, v2raw);
  const sidecars: PendingSidecarInput[] = [];
  const handled = new Map<string, string>();
  const evidence: Rig['evidence'] = [];
  const clock = opts.clock ?? { now: NOW };
  const logPath = path.join(home.stateDir, 'logs', 'skill-learning.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const reverter = new Reverter({
    cfg: cfg({ mode: 'live', review: { requireDifferentFamily: true, minCorrectedRunsSameFamily: 2, revertBreakerPer30d: opts.breaker ?? 2 } }),
    machineId: 'm1', ledger, versions, protocol,
    learnedCanonicals: () => readLearned(home),
    existingSkills: () => [{ name: SKILL_NAME, description: 'Use when x. Not for y.', learned: true, location: '.instar/skills' }],
    writePendingSidecar: (s) => { sidecars.push(s); },
    handled: { get: (k) => handled.get(k), set: (k, v) => { handled.set(k, v); } },
    ...(opts.archive ? { archiveRenderings: opts.archive } : {}),
    log: (row) => fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date(clock.now).toISOString(), ...row })}\n`),
    evidence: { record: (kind, reason) => { evidence.push({ kind, reason }); } },
    now: () => clock.now,
  });
  return { home, ledger, versions, protocol, reverter, sidecars, handled, evidence, v1, v2 };
}

const counts = (measuredCorroborated: number, correctedCorroborated: number): VersionCounts => ({ uses: measuredCorroborated, accepted: measuredCorroborated - correctedCorroborated, acceptedInferred: 0, corrected: correctedCorroborated, unknown: 0, weakPositive: 0, corroborated: measuredCorroborated, measuredCorroborated, correctedCorroborated, score: null });

describe('revertTrigger — the §3.7 boundaries (pure)', () => {
  it('3 runs / 2 corrected / rate strictly above N ⇒ trigger; equal rate, 2 runs, or 1 corrected ⇒ no; an unmeasured N reads rate 0 and is recorded null', () => {
    expect(revertTrigger(counts(3, 2), counts(3, 1))).toMatchObject({ trigger: true, curRate: 2 / 3, prevRate: 1 / 3 });
    expect(revertTrigger(counts(3, 2), counts(3, 2))).toMatchObject({ trigger: false, reason: expect.stringContaining('not strictly above') });
    expect(revertTrigger(counts(3, 2), counts(2, 2)).trigger).toBe(false);          // N at 1.0 > 2/3
    expect(revertTrigger(counts(2, 2), counts(3, 0))).toMatchObject({ trigger: false, reason: 'corroborated runs 2 < 3' });
    expect(revertTrigger(counts(3, 1), counts(3, 0))).toMatchObject({ trigger: false, reason: 'corrected runs 1 < 2' });
    expect(revertTrigger(counts(4, 2), counts(0, 0))).toMatchObject({ trigger: true, prevRate: null, curRate: 0.5 });
    expect(revertTrigger(counts(3, 3), counts(3, 2)).trigger).toBe(true);
  });
});

describe('Reverter — N+1 harmful ⇒ N+2 = body of N through write(revert), annotated, breaker-bounded', () => {
  it('reverts: write(revert) fenced on the chain, the canonical is N\'s document as version 3, the row carries revertOf / rejectedBodyHash / uncertainty, N+2\'s body is stored, and the next tick is quiet', async () => {
    const r = rig();
    uses(r.ledger, r.v1.bodyHash, ['corrected', 'accepted', 'accepted']);             // N: 1/3
    uses(r.ledger, r.v2.bodyHash, ['corrected', 'corrected', 'accepted', 'unknown']);  // N+1: 2/3 (the unknown is not measured)
    const s = await r.reverter.tick();
    expect(s).toMatchObject({ considered: 1, reverted: 1, refused: 0, breakers: 0 });
    expect(s.decisions[0]).toMatchObject({ trigger: true, current: { version: 2, runs: 3, corrected: 2, rate: 2 / 3 }, previous: { version: 1, runs: 3, corrected: 1, rate: 1 / 3 } });
    expect(r.protocol.calls.map((c) => [c.op, c.ctx.expectedPrevHash])).toEqual([['revert', r.v2.fileHash]]);
    const onDisk = fs.readFileSync(canonicalPath(r.home), 'utf-8');
    const doc = parseSkillDoc(onDisk)!;
    expect(doc.body).toBe(BODY1);
    expect(doc.metadata).toMatchObject({ 'instar-learned-version': '3', 'instar-learned-state': 'active', 'instar-learned-locked': 'false' });
    const rows = r.versions.rows(SKILL_NAME);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ version: 3, op: 'revert', state: 'active', bodyHash: r.v1.bodyHash, revertOf: 'tx-v2', rejectedBodyHash: r.v2.bodyHash, uncertainty: { nCorrected: 2, nRuns: 3, prevRate: 1 / 3 } });
    expect(r.versions.readBody(SKILL_NAME, rows[2].fileHash)).toBe(onDisk);
    expect(r.versions.rejectedVersions(SKILL_NAME)).toEqual([{ txId: 'tx-v2', bodyHash: r.v2.bodyHash, citedCorrections: ['c-a'], revertTxId: rows[2].txId, at: rows[2].at }]);
    expect(readLog(r.home).find((x) => x.kind === 'revert')).toMatchObject({ name: SKILL_NAME, version: 3, revertOf: 'tx-v2', rejectedVersion: 2, restoredVersion: 1, uncertainty: { nCorrected: 2, nRuns: 3, prevRate: 1 / 3 } });
    expect(r.evidence).toEqual([{ kind: 'fired', reason: 'revert' }]);
    expect(r.sidecars).toEqual([]);
    expect(r.ledger.rows.filter((x) => x.kind === 'event')).toEqual([]);
    // Next tick: the body before the live one is the REJECTED N+1 — never a revert target (skipped once, logged), quiet.
    const again = await r.reverter.tick();
    expect(again).toMatchObject({ considered: 0, reverted: 0, refused: 0, skipped: 1 });
    expect(readLog(r.home).find((x) => x.kind === 'revert-skipped')).toMatchObject({ name: SKILL_NAME, reason: 'rejected-body', currentVersion: 3, previousVersion: 2, previousBodyHash: r.v2.bodyHash });
    expect(r.protocol.calls).toHaveLength(1);
    expect((await r.reverter.tick()).skipped).toBe(0);                                   // decided once per body
  });

  it('counts only corroborated, measured uses: an uncorroborated corrected run, an operator-edited use and a version-uncertain use never trip the trigger', async () => {
    const r = rig();
    uses(r.ledger, r.v2.bodyHash, ['corrected', ['corrected', { corroborated: false }], 'accepted', ['corrected', { operatorEdited: true }], ['corrected', { versionUncertain: true }]]);
    const s = await r.reverter.tick();
    expect(s.decisions[0]).toMatchObject({ trigger: false, current: { runs: 2, corrected: 1 } });
    expect(r.protocol.calls).toEqual([]);
  });

  it('a refused revert (no body of N kept) leaves N+1 PENDING through the protocol, writes the pending sidecar, appends the revert-refused event (item 1), and is decided once per body', async () => {
    const r = rig({ storeV1Body: false });
    uses(r.ledger, r.v2.bodyHash, ['corrected', 'corrected', 'accepted']);
    const s = await r.reverter.tick();
    expect(s).toMatchObject({ reverted: 0, refused: 1 });
    expect(r.protocol.calls.map((c) => [c.op, c.ctx.expectedPrevHash, c.ctx.reason])).toEqual([['revert', r.v2.fileHash, expect.stringContaining('revert-refused: no-body')]]);
    const doc = parseSkillDoc(fs.readFileSync(canonicalPath(r.home), 'utf-8'))!;
    expect(doc.body).toBe(BODY2);                                                      // the harmful body is held, not replaced
    expect(doc.metadata['instar-learned-state']).toBe('pending');
    expect(r.sidecars).toEqual([expect.objectContaining({ name: SKILL_NAME, key: KEY, pendingReason: 'revert-refused', evidence: { sources: [], runIds: ['run-1'] } })]);
    const ev = r.ledger.rows.filter((x): x is EventRow => x.kind === 'event');
    expect(ev).toEqual([expect.objectContaining({ event: 'revert-refused', skill: SKILL_NAME, procedureKey: KEY, runId: 'run-1', reason: expect.stringContaining('no-body') })]);
    expect(ev[0].reason).toContain('renderings of v2 stay until archived');
    expect(readLog(r.home).find((x) => x.kind === 'revert-refused')).toMatchObject({ reason: 'no-body', rejectedVersion: 2, restoredVersion: 1, held: true, version: 3 });
    expect(r.versions.rows(SKILL_NAME)[2]).toMatchObject({ op: 'revert', state: 'pending', revertOf: 'tx-v2', rejectedBodyHash: r.v2.bodyHash });
    expect(r.evidence).toEqual([{ kind: 'held', reason: 'revert-refused: no-body' }]);
    // Decided once: the canonical is pending now (skipped), and the handled map names the body it decided for.
    expect(r.handled.get(SKILL_NAME)).toBe(r.v2.fileHash);
    await r.reverter.tick();
    expect(r.protocol.calls).toHaveLength(1);
    expect(r.ledger.rows.filter((x) => x.kind === 'event')).toHaveLength(1);
  });

  it('a refused revert whose HOLD write is also refused still emits the event and is not retried (the signal, never a loop)', async () => {
    const r = rig({ storeV1Body: false });
    uses(r.ledger, r.v2.bodyHash, ['corrected', 'corrected', 'accepted']);
    r.protocol.refuse = 'not-holder';
    await r.reverter.tick();
    expect(r.protocol.calls.map((c) => c.op)).toEqual(['revert']);
    expect(r.ledger.rows.filter((x): x is EventRow => x.kind === 'event')).toEqual([expect.objectContaining({ event: 'revert-refused', reason: expect.stringContaining('hold refused: not-holder') })]);
    expect(readLog(r.home).find((x) => x.kind === 'revert-refused')).toMatchObject({ held: false, holdRefused: 'not-holder' });
    expect(r.sidecars).toEqual([]);
    await r.reverter.tick();
    expect(r.protocol.calls).toHaveLength(1);
  });

  it('the restored body passes the structural lint (no LLM): a body of N that now fails it is a refused revert (lint:no-scripts), N+1 held pending', async () => {
    const r = rig({ body1: '# CI health\n\n1. Run scripts/ci-health.sh and report.\n' });
    uses(r.ledger, r.v2.bodyHash, ['corrected', 'corrected', 'accepted']);
    const s = await r.reverter.tick();
    expect(s).toMatchObject({ reverted: 0, refused: 1 });
    expect(readLog(r.home).find((x) => x.kind === 'revert-refused')).toMatchObject({ reason: 'lint:no-scripts' });
    expect(parseSkillDoc(fs.readFileSync(canonicalPath(r.home), 'utf-8'))!.metadata['instar-learned-state']).toBe('pending');
  });

  it('breaker: the second revert on one key inside 30 days locks the key (write(lock) + revert-breaker event); a first revert 31 days ago does not count', async () => {
    for (const [label, daysAgo, expectBreaker] of [['inside the window', 5, true], ['day 31', 31, false]] as const) {
      const r = rig();
      // History: v2 was reverted once already (v3 = N's body, `daysAgo`), then patched again to v4 (= N+1's body, live).
      const v3raw = rawOf(BODY1, 3);
      r.versions.append(SKILL_NAME, { txId: 'tx-v3', fileHash: sha256(v3raw), bodyHash: r.v1.bodyHash, epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'revert', state: 'active', revertOf: 'tx-v2', rejectedBodyHash: r.v2.bodyHash, at: new Date(NOW - daysAgo * DAY).toISOString() });
      r.versions.storeBody(SKILL_NAME, sha256(v3raw), v3raw);
      const v4raw = rawOf(BODY2, 4);
      r.versions.append(SKILL_NAME, { txId: 'tx-v4', fileHash: sha256(v4raw), bodyHash: r.v2.bodyHash, epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'patch', state: 'active', citedCorrections: ['c-b'], at: new Date(NOW - 2 * DAY).toISOString() });
      r.versions.storeBody(SKILL_NAME, sha256(v4raw), v4raw);
      writeCanonical(r.home, v4raw);
      uses(r.ledger, r.v1.bodyHash, ['accepted', 'accepted', 'accepted']);
      uses(r.ledger, r.v2.bodyHash, ['corrected', 'corrected', 'accepted']);
      const s = await r.reverter.tick();
      expect(s, label).toMatchObject({ reverted: 1, breakers: expectBreaker ? 1 : 0 });
      const ops = r.protocol.calls.map((c) => c.op);
      const events = r.ledger.rows.filter((x): x is EventRow => x.kind === 'event');
      const doc = parseSkillDoc(fs.readFileSync(canonicalPath(r.home), 'utf-8'))!;
      expect(doc.body, label).toBe(BODY1);
      if (expectBreaker) {
        expect(ops, label).toEqual(['revert', 'lock']);
        const revertRes = r.versions.rows(SKILL_NAME).find((x) => x.op === 'revert' && x.version === 5)!;
        expect(r.protocol.calls[1].ctx.expectedPrevHash, label).toBe(revertRes.fileHash);
        expect(doc.metadata, label).toMatchObject({ 'instar-learned-state': 'operator-owned', 'instar-learned-locked': 'true' });
        expect(events, label).toEqual([expect.objectContaining({ event: 'revert-breaker', skill: SKILL_NAME, procedureKey: KEY, reason: expect.stringContaining('2 reverts on this key in 30 days (limit 2)') })]);
        expect(readLog(r.home).find((x) => x.kind === 'revert-breaker'), label).toMatchObject({ reverts30d: 2, limit: 2, locked: true });
        expect(r.evidence.map((e) => e.reason), label).toEqual(['revert', 'revert-breaker']);
        // Locked: the next tick skips the key entirely.
        await r.reverter.tick();
        expect(r.protocol.calls, label).toHaveLength(2);
      } else {
        expect(ops, label).toEqual(['revert']);
        expect(doc.metadata['instar-learned-state'], label).toBe('active');
        expect(events, label).toEqual([]);
        expect(r.versions.revertsSince(SKILL_NAME, NOW - REVERT_WINDOW_MS), label).toHaveLength(1);
      }
    }
  });

  it('skips locked, pending and operator-owned canonicals, a canonical off the chain, and a skill with no earlier different body', async () => {
    const r = rig();
    uses(r.ledger, r.v2.bodyHash, ['corrected', 'corrected', 'accepted']);
    writeCanonical(r.home, rawOf(BODY2, 2, 'active', true));                         // locked (and now off the chain too)
    expect((await r.reverter.tick()).considered).toBe(0);
    writeCanonical(r.home, rawOf(BODY2, 2, 'pending'));
    expect((await r.reverter.tick()).considered).toBe(0);
    writeCanonical(r.home, rawOf(BODY2, 2) + '\nedited\n');                           // active but not the chain's last hash
    expect((await r.reverter.tick()).considered).toBe(0);
    expect(r.protocol.calls).toEqual([]);
    // Only one body ever: nothing to revert to.
    const solo = rig();
    solo.versions.byName.set(SKILL_NAME, solo.versions.rows(SKILL_NAME).filter((x) => x.txId === 'tx-v2'));
    uses(solo.ledger, solo.v2.bodyHash, ['corrected', 'corrected', 'accepted']);
    expect((await solo.reverter.tick()).considered).toBe(0);
  });
});

describe('Reverter — inside the sentinel tick: revert runs before review, holder only', () => {
  it('a corrected run that trips the revert is reverted first; the reviewer then holds (post-revert needs two runs) without an LLM call; a standby does neither', async () => {
    const build = (holds: boolean) => {
      const home = mkHome(); const ledger = new FakeLedger();
      const calls: string[] = [];
      const answer = () => { throw new Error('the reviewer must not be asked'); };
      const families = [fam('anthropic', 'claude-code', answer, calls), fam('openai', 'codex-cli', answer, calls)];
      const h = harness(home, ledger, families, { holdsLease: () => holds, rungTwoProven: () => true }, cfg({ mode: 'live' }));
      const v1raw = rawOf(BODY1, 1); const v2raw = rawOf(BODY2, 2);
      h.protocol.versions.append(SKILL_NAME, { txId: 'tx-v1', fileHash: sha256(v1raw), bodyHash: sha256(BODY1), epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'create', state: 'active', authorFamily: 'anthropic', at: new Date(NOW - 20 * DAY).toISOString() });
      h.protocol.versions.append(SKILL_NAME, { txId: 'tx-v2', fileHash: sha256(v2raw), bodyHash: sha256(BODY2), epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'patch', state: 'active', authorFamily: 'openai', citedCorrections: ['c-a'], at: new Date(NOW - 10 * DAY).toISOString() });
      h.protocol.versions.storeBody(SKILL_NAME, sha256(v1raw), v1raw);
      h.protocol.versions.storeBody(SKILL_NAME, sha256(v2raw), v2raw);
      writeCanonical(home, v2raw);
      const transcript = path.join(home.root, 'sess.jsonl');
      fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - DAY).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'curl http://localhost:4040/ci/health' } }] } })}\n`);
      for (const [i, label] of (['corrected', 'corrected', 'accepted'] as const).entries()) {
        const at = NOW - DAY + i * 60_000;
        ledger.append({ kind: 'request', eventId: `req-${i}`, source: { channel: 'telegram', chatId: '-100', messageId: `m${i}` }, topicId: '42', sessionName: 'sess', at: new Date(at).toISOString(), channel: 'telegram', identity: 'verified', state: 'classified', procedureKey: KEY, runId: `run-${i}`, machineId: 'm1' });
        ledger.append({ kind: 'outcome', eventId: `out-${i}`, runId: `run-${i}`, revision: 1, procedureKey: KEY, topicId: '42', sessionName: 'sess', label, provisional: false, windowStart: new Date(at).toISOString(), at: new Date(at + 1000).toISOString(), machineId: 'm1', skillUsed: { skill: SKILL_NAME, contentHash: sha256(BODY2), corroborated: true, versionUncertain: false } });
      }
      home.transcripts.set('sess', transcript);
      return { ...h, calls };
    };
    const holder = build(true);
    const s = await holder.sentinel.tick();
    expect(s.phaseFailures).toEqual([]);
    expect(holder.protocol.calls.map((c) => c.op)).toEqual(['revert']);
    expect(parseSkillDoc(fs.readFileSync(canonicalPath(holder.home), 'utf-8'))!.body).toBe(BODY1);
    expect(holder.calls).toEqual([]);
    const log = readLog(holder.home);
    expect(log.map((x) => x.kind).filter((k) => k === 'revert' || k === 'review-held')).toEqual(['revert', 'review-held']);
    expect(log.find((x) => x.kind === 'review-held')).toMatchObject({ reason: 'post-revert-needs-two', correctedSinceRevert: 0 });
    expect(holder.sentinel.internalCounters()).toMatchObject({ reverts: 1, reviewHolds: 1, patches: 0 });

    const standby = build(false);
    const s2 = await standby.sentinel.tick();
    expect(s2.observeOnly).toBe(true);
    expect(standby.protocol.calls).toEqual([]);
    expect(parseSkillDoc(fs.readFileSync(canonicalPath(standby.home), 'utf-8'))!.body).toBe(BODY2);
  });
});

describe('Reverter.revertOne — item 1\'s heal: one skill/version, honest terminal reasons', () => {
  it('terminal: canonical not live / no earlier version / reverted-to body already rejected / breaker tripped; retryable: version mismatch, chain mismatch', async () => {
    const r = rig();
    expect(await r.reverter.revertOne('absent-skill', 2)).toMatchObject({ healed: false, reason: 'canonical-not-live', terminal: true });
    expect(await r.reverter.revertOne(SKILL_NAME, 1)).toMatchObject({ healed: false, reason: 'version-mismatch' });
    const solo = rig();
    solo.versions.byName.set(SKILL_NAME, solo.versions.rows(SKILL_NAME).filter((x) => x.txId === 'tx-v2'));
    expect(await solo.reverter.revertOne(SKILL_NAME, 2)).toMatchObject({ healed: false, reason: 'no-earlier-version', terminal: true });
    // v1's body was rejected by an earlier revert (v3 reverted v2→v1? no: a revert that REJECTED v1's body): rejectedBodyHash = v1.bodyHash.
    const rej = rig();
    rej.versions.append(SKILL_NAME, { txId: 'tx-old-revert', fileHash: 'z'.repeat(64), bodyHash: 'y'.repeat(64), epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'revert', state: 'active', rejectedBodyHash: rej.v1.bodyHash, at: new Date(NOW - 40 * DAY).toISOString() });
    rej.versions.byName.set(SKILL_NAME, rej.versions.rows(SKILL_NAME).slice().sort((a, b) => a.at.localeCompare(b.at)));
    const v2again = rej.versions.rows(SKILL_NAME).find((x) => x.txId === 'tx-v2')!;
    rej.versions.byName.set(SKILL_NAME, [...rej.versions.rows(SKILL_NAME).filter((x) => x.txId !== 'tx-v2'), v2again]);
    expect(await rej.reverter.revertOne(SKILL_NAME, 2)).toMatchObject({ healed: false, reason: 'reverted-to-rejected', terminal: true });
    const tripped = rig({ breaker: 1 });
    tripped.versions.append(SKILL_NAME, { txId: 'tx-rv', fileHash: 'w'.repeat(64), bodyHash: 'v'.repeat(64), epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'revert', state: 'active', at: new Date(NOW - 3 * DAY).toISOString() });
    writeCanonical(tripped.home, rawOf(BODY2, 3));
    tripped.versions.append(SKILL_NAME, { txId: 'tx-v3p', fileHash: sha256(rawOf(BODY2, 3)), bodyHash: tripped.v2.bodyHash, epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'patch', state: 'active', at: new Date(NOW - 2 * DAY).toISOString() });
    expect(await tripped.reverter.revertOne(SKILL_NAME, 4)).toMatchObject({ healed: false, reason: 'revert-breaker', terminal: true });
    const edited = rig();
    writeCanonical(edited.home, rawOf(BODY2, 2) + '\nedited\n');
    expect(await edited.reverter.revertOne(SKILL_NAME, 2)).toMatchObject({ healed: false, reason: 'chain-mismatch' });
    expect(r.protocol.calls.concat(solo.protocol.calls, rej.protocol.calls, tripped.protocol.calls, edited.protocol.calls)).toEqual([]);
  });

  it('a refused revert answers healed:false WITHOUT terminal (the gate retries), holds N+1 pending, and asks the retirer (late-bound) to archive N+1\'s renderings — the event names what is still live', async () => {
    const archived: string[] = [];
    const r = rig({ storeV1Body: false, archive: async (name) => { archived.push(name); return { archived: [{ layout: 'claude-code' }], blocked: [], left: ['codex-cli'] }; } });
    uses(r.ledger, r.v2.bodyHash, ['corrected', 'corrected', 'accepted']);
    expect(await r.reverter.revertOne(SKILL_NAME, 2)).toEqual({ healed: false, reason: 'revert-refused', detail: expect.stringContaining('held pending') });
    expect(archived).toEqual([SKILL_NAME]);
    expect(parseSkillDoc(fs.readFileSync(canonicalPath(r.home), 'utf-8'))!.metadata['instar-learned-state']).toBe('pending');
    const ev = r.ledger.rows.filter((x): x is EventRow => x.kind === 'event');
    expect(ev).toHaveLength(1);
    expect(ev[0].reason).toContain('renderings of v2 still live in codex-cli');
    expect(readLog(r.home).find((x) => x.kind === 'revert-refused')).toMatchObject({ reason: 'no-body', renderings: { archived: 1, left: ['codex-cli'] } });
    // Without a retirer the event says the renderings stay; an archive that throws is named, never silent.
    const none = rig({ storeV1Body: false });
    uses(none.ledger, none.v2.bodyHash, ['corrected', 'corrected', 'accepted']);
    await none.reverter.revertOne(SKILL_NAME, 2);
    expect(none.ledger.rows.filter((x): x is EventRow => x.kind === 'event')[0].reason).toContain('renderings of v2 stay until archived');
    const boom = rig({ storeV1Body: false, archive: async () => { throw new Error('disk full'); } });
    uses(boom.ledger, boom.v2.bodyHash, ['corrected', 'corrected', 'accepted']);
    await boom.reverter.revertOne(SKILL_NAME, 2);
    expect(boom.ledger.rows.filter((x): x is EventRow => x.kind === 'event')[0].reason).toContain('rendering archive failed: disk full');
    expect(readLog(boom.home).find((x) => x.kind === 'revert-refused')).toMatchObject({ renderings: { error: 'disk full' } });
  });
});
