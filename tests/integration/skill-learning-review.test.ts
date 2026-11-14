// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Skill Learning Sentinel — Tier 2, slice 3A (docs/specs/skill-learning-sentinel.md §3.7 reviewer patches,
 * versions and the bounded revert; §8 "Integration"): the REAL CommitProtocol + VersionStore +
 * LearnedSkillReconciler over a temp agent home (a granting fence), the REAL SkillLearningSentinel in live mode
 * over a fixture ledger with stub model families (no network), and the real routes module for the by-name read
 * and the confirm tap.
 *
 *  - a corrected run of a learned skill ⇒ the reviewer's cited patch is written as N+1 through the six-step
 *    protocol and RENDERED in both layouts (new `x-instar-stamp`), journaled prepare → commit as `patch`, a
 *    version row with authorFamily/reviewerFamily/citedCorrections, both bodies kept under versions/<name>/bodies;
 *  - `GET /skills/learned/:name` lists the version rows with reviewerFamily, citedCorrections and per-version scores;
 *  - one family reachable ⇒ the patch is held `pending` (`reviewerFamily: same-as-author`, unrendered: the old
 *    rendering keeps its old stamp) until the PIN-gated confirm route; uses of that body are EXCLUDED from the
 *    metric fields (`sameFamilyExcluded`);
 *  - the bounded revert writes N+2 = N's document through the real protocol, rendered with N's stamp.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LearnedSkillReconciler } from '../../src/monitoring/LearnedSkillReconciler.js';
import { CommitProtocol, fileHashOf } from '../../src/monitoring/skillLearning/CommitProtocol.js';
import { VersionStore } from '../../src/monitoring/skillLearning/VersionStore.js';
import { SkillLearningSentinel } from '../../src/monitoring/SkillLearningSentinel.js';
import { SAME_AS_AUTHOR } from '../../src/monitoring/skillLearning/Reviewer.js';
import { parseSkillDoc } from '../../src/monitoring/skillLearning/Drafter.js';
import { SKILL_LEARNING_DEFAULTS } from '../../src/config/ConfigDefaults.js';
import { skillParityRule } from '../../src/providers/parity/rules/skillParityRule.js';
import { createSkillLearningRoutes } from '../../src/server/skillLearningRoutes.js';
import type { FenceResult } from '../../src/monitoring/skillLearning/WriterFence.js';
import type { FamilyProvider } from '../../src/monitoring/skillLearning/Drafter.js';
import type { EventRow, LearnedSkillSummary, LedgerReader, LedgerRow, LedgerWriter, OutcomeRow, RequestRow, SkillLearningConfig, VerdictRow } from '../../src/monitoring/skillLearning/types.js';

const TOKEN = 'tok';
const PIN = '246810';
const NOW = Date.parse('2026-11-06T12:00:00Z');
const DAY = 86_400_000;
const NAME = 'ci-health-report';
const KEY = 'ci-health';
const TMP = process.env.TMPDIR ?? os.tmpdir();
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf-8').digest('hex');

const homes: string[] = [];
afterEach(() => {
  for (const d of homes.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/skill-learning-review.test.ts' });
});

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

const BODY1 = '# CI health report\n\n1. Read the CI health route at /ci/health.\n2. Summarise failing jobs and the slowest runs in plain language.\n';
const LINE2 = '2. Summarise failing jobs and the slowest runs in plain language.';
const PATCHED = '2. Summarise failing jobs, the slowest runs and the flaky tests in plain language.';

function canonicalDoc(body = BODY1, version = 1): string {
  return [
    '---', `name: ${NAME}`,
    'description: "Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status."',
    'metadata:', '  short-description: "CI health, weekly"', '  instar-learned-origin: "skill-learning-sentinel"', `  instar-learned-key: "${KEY}"`,
    `  instar-learned-version: "${version}"`, `  instar-learned-created: "${new Date(NOW - 20 * DAY).toISOString()}"`, '  instar-learned-locked: "false"', '  instar-learned-state: "active"',
    '---', body,
  ].join('\n');
}

function grantingFence() {
  return { acquireFence: (): FenceResult => ({ ok: true, epoch: 0, fence: 'local' }), peekEpoch: () => 0, medium: () => 'local' as const };
}

type Script = { patch: (prompt: string) => string; review?: string };
const PATCH = (hunks: Array<{ before: string; after: string; answers: string }>) => JSON.stringify({ action: 'patch', hunks, reason: 'answers the correction' });

interface Home {
  root: string; stateDir: string; machineId: string;
  reconciler: LearnedSkillReconciler; versions: VersionStore; protocol: CommitProtocol;
  ledger: FixtureLedger; sentinel: SkillLearningSentinel; calls: string[]; transcripts: Map<string, string>;
  app: express.Express;
  use: (i: number, label: OutcomeRow['label'], bodyHash: string, extra?: Partial<NonNullable<OutcomeRow['skillUsed']>>) => string;
}

function home(script: Script, opts: { families?: number } = {}): Home {
  const machineId = 'm1';
  const root = fs.mkdtempSync(path.join(TMP, 'sl-review-'));
  homes.push(root);
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'build', 'SKILL.md'), '---\nname: build\ndescription: "Rigorous build process."\n---\nbody\n');
  const reconciler = new LearnedSkillReconciler({ projectDir: root, stateDir, machineId, enabledFrameworks: () => ['claude-code', 'codex-cli'], now: () => NOW });
  const versions = new VersionStore({ stateDir, machineId, now: () => NOW });
  const protocol = new CommitProtocol({ projectDir: root, stateDir, machineId, fence: grantingFence(), versions, reconciler, now: () => NOW });
  const ledger = new FixtureLedger();
  const transcripts = new Map<string, string>();
  const calls: string[] = [];
  const answer = (family: string) => async (prompt: string): Promise<string> => {
    calls.push(family);
    if (prompt.startsWith('You are the reviewer of a LEARNED SKILL')) return script.patch(prompt);
    if (prompt.startsWith('You are the independent reviewer')) return script.review ?? '{"follows":true,"lines":{},"cost":"accept","reason":"grounded"}';
    throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
  };
  const providers: FamilyProvider[] = [{ family: 'anthropic', framework: 'claude-code' }, { family: 'openai', framework: 'codex-cli' }].slice(0, opts.families ?? 2)
    .map((f) => ({ family: f.family, framework: f.framework, evaluate: answer(f.family) }));
  const config: SkillLearningConfig = { ...(structuredClone(SKILL_LEARNING_DEFAULTS) as unknown as SkillLearningConfig), enabled: true, mode: 'live' };
  const sentinel = new SkillLearningSentinel({
    config, stateDir, projectDir: root, machineId, ledger, families: () => providers,
    transcriptPath: (run) => (run.sessionName && transcripts.get(run.sessionName)) ?? null,
    operatorMessage: (src) => `weekly CI health of the instar repo please (msg ${src.messageId})`,
    correctionMessages: () => ['No — include the flaky tests as well, not just the slowest runs.'],
    provenance: { recordDecision: () => 'jp-1', isRecordingLive: () => true },
    commitProtocol: protocol, versionStore: versions, mode: () => 'live', rungTwoProven: () => true,
    now: () => NOW,
  });
  const use: Home['use'] = (i, label, bodyHash, extra = {}) => {
    const at = NOW - (i + 1) * 3600_000; const session = `sess-${i}`;
    ledger.append({ kind: 'request', eventId: `req-${i}`, source: { channel: 'telegram', chatId: '-100', messageId: String(1180 + i) }, topicId: '42', sessionName: session, at: new Date(at).toISOString(), channel: 'telegram', identity: 'verified', state: 'classified', procedureKey: KEY, paraphrase: 'weekly CI health', repeatable: true, runId: `run-${i}`, machineId });
    const eventId = `out-${i}`;
    ledger.append({ kind: 'outcome', eventId, runId: `run-${i}`, revision: 1, procedureKey: KEY, topicId: '42', sessionName: session, label, provisional: false, windowStart: new Date(at).toISOString(), windowEnd: new Date(at + 600_000).toISOString(), at: new Date(at + 600_000).toISOString(), machineId, skillUsed: { skill: NAME, contentHash: bodyHash, corroborated: true, versionUncertain: false, ...extra } });
    const file = path.join(root, `${session}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: new Date(at + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'curl http://localhost:4040/ci/health' } }] } })}\n`);
    transcripts.set(session, file);
    return eventId;
  };
  const ctx = {
    config: { authToken: TOKEN, dashboardPin: PIN, port: 4042, monitoring: { skillLearning: { enabled: true } } },
    meshSelfId: 'm_self', machinePoolRegistry: { getCapacity: () => ({ nickname: 'Studio' }) }, resolveRouterUrl: () => null, pinAttemptStore: null,
    skillLearningSentinel: () => sentinel,
  } as never;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.status(401).json({ error: 'unauthorized' }); return; } next(); });
  app.use(createSkillLearningRoutes(ctx));
  return { root, stateDir, machineId, reconciler, versions, protocol, ledger, sentinel, calls, transcripts, app, use };
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const renderingOf = (root: string, layout: '.claude' | '.agents') => path.join(root, layout, 'skills', NAME, 'SKILL.md');
const canonicalOf = (root: string) => path.join(root, '.instar', 'skills', NAME, 'SKILL.md');
const stampOf = (file: string) => fs.readFileSync(file, 'utf-8').match(/^x-instar-stamp:\s*([a-f0-9]{64})\s*$/m)?.[1] ?? null;
const journalRows = (h: Home) => fs.readFileSync(path.join(h.stateDir, 'skill-learning', 'journal', `${h.machineId}.jsonl`), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const logRows = (h: Home) => { const p = path.join(h.stateDir, 'logs', 'skill-learning.jsonl'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []; };

describe('corrected run → reviewer patch → N+1 rendered through the real commit protocol', () => {
  it('writes the cited patch as version 2 (patch journal, version row with families + citations, both bodies kept), renders both layouts with the new stamp, parity verifies; the by-name route lists the versions', async () => {
    const h = home({ patch: () => PATCH([{ before: LINE2, after: PATCHED, answers: 'out-0' }, { before: '# CI health report', after: '# Nope', answers: 'foreign' }]) });
    const raw1 = canonicalDoc();
    const created = await h.protocol.write('create', NAME, raw1, { expectedPrevHash: null, authorFamily: 'anthropic' });
    expect(created).toMatchObject({ ok: true, version: 1 });
    expect(stampOf(renderingOf(h.root, '.claude'))).toBe(sha(BODY1));
    h.use(0, 'corrected', sha(BODY1));
    h.use(1, 'accepted', sha(BODY1));

    const s = await h.sentinel.tick();
    expect(s.phaseFailures).toEqual([]);
    expect(h.calls).toEqual(['openai', 'anthropic']);                                   // B ≠ author, validator ≠ B
    const onDisk = fs.readFileSync(canonicalOf(h.root), 'utf-8');
    const doc = parseSkillDoc(onDisk)!;
    expect(doc.body).toBe(BODY1.replace(LINE2, PATCHED));                                 // the foreign-cited hunk never applied
    expect(doc.metadata).toMatchObject({ 'instar-learned-version': '2', 'instar-learned-state': 'active', 'instar-learned-key': KEY, 'instar-learned-origin': 'skill-learning-sentinel' });
    for (const layout of ['.claude', '.agents'] as const) {
      expect(stampOf(renderingOf(h.root, layout)), layout).toBe(sha(doc.body));
      expect(fs.readFileSync(renderingOf(h.root, layout), 'utf-8'), layout).toContain(PATCHED);
    }
    const verify = await skillParityRule.verify(h.root, NAME);
    expect(verify.ok, JSON.stringify(verify.mismatches)).toBe(true);
    const rows = h.versions.rows(NAME);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ version: 1, op: 'create', authorFamily: 'anthropic', citedCorrections: [] });
    expect(rows[1]).toMatchObject({ version: 2, op: 'patch', state: 'active', fileHash: fileHashOf(onDisk), bodyHash: sha(doc.body), authorFamily: 'openai', reviewerFamily: 'anthropic', citedCorrections: ['out-0'], void: false, superseded: false });
    const patchTx = rows[1].txId;
    expect(journalRows(h).filter((r) => r.txId === patchTx).map((r) => [r.op, r.commitOp])).toEqual([['commit-prepare', 'patch'], ['commit', 'patch']]);
    expect(h.versions.readBody(NAME, rows[0].fileHash)).toBe(raw1);
    expect(h.versions.readBody(NAME, rows[1].fileHash)).toBe(onDisk);
    expect(fs.readdirSync(path.join(h.stateDir, 'skill-learning', 'versions', NAME, 'bodies')).sort()).toEqual([`${rows[0].fileHash}.md`, `${rows[1].fileHash}.md`].sort());
    expect(logRows(h).find((r) => r.kind === 'patch')).toMatchObject({ name: NAME, version: 2, state: 'active', cited: ['out-0'], hunksDropped: ['foreign-citation'], fence: 'local' });

    const res = await request(h.app).get(`/skills/learned/${NAME}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: NAME, state: 'learned', version: 2, reviewerFamily: 'anthropic', uses: 2, accepted: 1, corrected: 1 });
    expect(res.body.versions.map((v: Record<string, unknown>) => [v.version, v.op, v.authorFamily, v.reviewerFamily, v.citedCorrections, v.uses, v.score])).toEqual([
      [1, 'create', 'anthropic', undefined, [], 2, (1 + 1) / (1 + 1 + 2)],
      [2, 'patch', 'openai', 'anthropic', ['out-0'], 0, null],
    ]);
    // Idempotent per run: a second tick asks nothing and writes nothing.
    await h.sentinel.tick();
    expect(h.calls).toHaveLength(2);
    expect(h.versions.rows(NAME)).toHaveLength(2);
  });

  it('one family reachable ⇒ the patch is held pending (same-as-author), the OLD rendering stays until the PIN-gated confirm; uses of the same-family body are excluded from the metric fields', async () => {
    const h = home({ patch: () => PATCH([{ before: LINE2, after: PATCHED, answers: 'out-0' }]) }, { families: 1 });
    await h.protocol.write('create', NAME, canonicalDoc(), { expectedPrevHash: null, authorFamily: 'anthropic' });
    h.use(0, 'corrected', sha(BODY1));
    h.use(2, 'accepted', sha(BODY1));
    await h.sentinel.tick();
    expect(h.calls).toEqual([]);                                                          // below minCorrectedRunsSameFamily (2): held, no call
    h.use(1, 'corrected', sha(BODY1));
    await h.sentinel.tick();
    expect(h.calls).toEqual(['anthropic']);                                               // the reviewer; no validator exists
    const pendingDoc = parseSkillDoc(fs.readFileSync(canonicalOf(h.root), 'utf-8'))!;
    expect(pendingDoc.metadata['instar-learned-state']).toBe('pending');
    expect(pendingDoc.body).toContain(PATCHED);
    expect(stampOf(renderingOf(h.root, '.claude'))).toBe(sha(BODY1));                      // unrendered: the old rendering keeps the old stamp
    expect(h.versions.lastRow(NAME)).toMatchObject({ version: 2, op: 'patch', state: 'pending', authorFamily: 'anthropic', reviewerFamily: SAME_AS_AUTHOR, citedCorrections: ['out-0'] });
    const status = await request(h.app).get('/skills/learned').set(auth);
    expect(status.body.pending).toEqual([expect.objectContaining({ name: NAME, pendingReason: 'same-family', reviewerFamily: SAME_AS_AUTHOR, version: 2 })]);
    expect(status.body.skills).toEqual([]);

    const noPin = await request(h.app).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({});
    expect(noPin.status).toBe(403);
    const tap = await request(h.app).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({ pin: PIN });
    expect(tap.status, JSON.stringify(tap.body)).toBe(200);
    const activeDoc = parseSkillDoc(fs.readFileSync(canonicalOf(h.root), 'utf-8'))!;
    expect(activeDoc.metadata['instar-learned-state']).toBe('active');
    for (const layout of ['.claude', '.agents'] as const) expect(stampOf(renderingOf(h.root, layout)), layout).toBe(sha(activeDoc.body));
    expect(h.versions.lastRow(NAME)).toMatchObject({ version: 3, op: 'confirm', reviewerFamily: SAME_AS_AUTHOR });

    // Uses of the same-family-reviewed body: counted apart, never in score / accepted / corrected.
    h.use(5, 'accepted', sha(activeDoc.body));
    h.use(6, 'accepted', sha(activeDoc.body));
    h.use(7, 'corrected', sha(activeDoc.body));
    const read = await request(h.app).get(`/skills/learned/${NAME}`).set(auth);
    const skill = read.body as LearnedSkillSummary;
    expect(skill).toMatchObject({ state: 'learned', version: 2, reviewerFamily: SAME_AS_AUTHOR, uses: 3, accepted: 1, corrected: 2, sameFamilyExcluded: 3 });
    expect(skill.score).toBeCloseTo((1 + 1) / (1 + 2 + 2));
    expect(skill.versions!.map((v) => [v.version, v.reviewerFamily, v.uses, v.accepted, v.corrected])).toEqual([[1, undefined, 3, 1, 2], [2, SAME_AS_AUTHOR, 3, 2, 1], [3, SAME_AS_AUTHOR, 3, 2, 1]]);
  });

  it('bounded revert: N+1 at ≥3 corroborated runs / ≥2 corrected / rate above N ⇒ N+2 = N\'s document through write(revert), rendered with N\'s stamp, the row annotated', async () => {
    const h = home({ patch: () => PATCH([{ before: LINE2, after: PATCHED, answers: 'out-0' }]) });
    const raw1 = canonicalDoc();
    await h.protocol.write('create', NAME, raw1, { expectedPrevHash: null, authorFamily: 'anthropic' });
    h.use(0, 'corrected', sha(BODY1));
    h.use(1, 'accepted', sha(BODY1));
    h.use(2, 'accepted', sha(BODY1));
    await h.sentinel.tick();                                                               // → v2 (the patch)
    const v2 = h.versions.lastRow(NAME)!;
    expect(v2).toMatchObject({ version: 2, op: 'patch' });
    const body2 = sha(parseSkillDoc(fs.readFileSync(canonicalOf(h.root), 'utf-8'))!.body);
    h.use(3, 'corrected', body2);
    h.use(4, 'corrected', body2);
    h.use(5, 'accepted', body2);                                                           // N+1: 2/3 vs N: 1/3
    const s = await h.sentinel.tick();
    expect(s.phaseFailures).toEqual([]);
    const doc = parseSkillDoc(fs.readFileSync(canonicalOf(h.root), 'utf-8'))!;
    expect(doc.body).toBe(BODY1);
    expect(doc.metadata).toMatchObject({ 'instar-learned-version': '3', 'instar-learned-state': 'active' });
    for (const layout of ['.claude', '.agents'] as const) expect(stampOf(renderingOf(h.root, layout)), layout).toBe(sha(BODY1));
    const v3 = h.versions.lastRow(NAME)!;
    expect(v3).toMatchObject({ version: 3, op: 'revert', bodyHash: sha(BODY1), revertOf: v2.txId, rejectedBodyHash: v2.bodyHash, uncertainty: { nCorrected: 2, nRuns: 3, prevRate: 1 / 3 } });
    expect(journalRows(h).filter((r) => r.txId === v3.txId).map((r) => [r.op, r.commitOp])).toEqual([['commit-prepare', 'revert'], ['commit', 'revert']]);
    expect(h.versions.rejectedVersions(NAME)).toEqual([expect.objectContaining({ txId: v2.txId, bodyHash: v2.bodyHash, citedCorrections: ['out-0'] })]);
    expect(h.calls).toEqual(['openai', 'anthropic']);                                      // the revert made no LLM call; the reviewer held after it
    expect(logRows(h).find((r) => r.kind === 'review-held')).toMatchObject({ reason: 'post-revert-needs-two' });
    expect(h.ledger.rows.filter((r) => r.kind === 'event' && (r.event === 'revert-refused' || r.event === 'revert-breaker'))).toEqual([]);
  });
});
