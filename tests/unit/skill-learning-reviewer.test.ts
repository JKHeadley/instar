// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/**
 * Reviewer — Tier 1, slice 3A (docs/specs/skill-learning-sentinel.md §3.7 "a reviewer that is not the author";
 * the §3.5 routing table row 2; §8 "a patch body fails the same lint a draft would", "different-family routing
 * and the hold", "a late flip enqueues the reviewer", "rejected-hash refusal").
 *
 * Driven through the REAL sentinel tick (the `revert` → `review` phases) over the slice-2 fakes: an in-memory
 * ledger, stub families, the in-memory commit protocol + version store. Pure helpers are tested directly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillDoc } from '../../src/monitoring/skillLearning/Drafter.js';
import { applyHunks, matchesRejected, parseReviewerPatch, patchLearnedDocument, buildReviewerPatchPrompt, SAME_AS_AUTHOR } from '../../src/monitoring/skillLearning/Reviewer.js';
import type { OutcomeRow } from '../../src/monitoring/skillLearning/types.js';
import {
  DAY, FakeLedger, KEY, NOW, SKILL_NAME, canonicalPath, cfg, cleanupHomes, fam, harness, mkHome, readLog, sha256, type Home,
} from '../helpers/skillLearningLiveFixtures.js';

afterEach(() => cleanupHomes());

const BODY = '# CI health report\n\n1. Read the CI health route at /ci/health.\n2. Summarise failing jobs and the slowest runs in plain language.\n';
const PATCHED_LINE = '2. Summarise failing jobs, the slowest runs and the flaky tests in plain language.';

/** A learned, active canonical on disk (version `version`), returned with its hashes. */
function canonical(home: Home, opts: { body?: string; state?: string; locked?: boolean; version?: number; name?: string } = {}): { raw: string; fileHash: string; bodyHash: string } {
  const name = opts.name ?? SKILL_NAME;
  const body = opts.body ?? BODY;
  const raw = [
    '---', `name: ${name}`,
    'description: "Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status."',
    'metadata:', '  short-description: "CI health, weekly"', '  instar-learned-origin: "skill-learning-sentinel"', `  instar-learned-key: "${KEY}"`,
    `  instar-learned-version: "${opts.version ?? 1}"`, `  instar-learned-created: "${new Date(NOW - 30 * DAY).toISOString()}"`,
    `  instar-learned-locked: "${opts.locked ? 'true' : 'false'}"`, `  instar-learned-state: "${opts.state ?? 'active'}"`, '---', body,
  ].join('\n');
  const dir = path.join(home.root, '.instar', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), raw);
  return { raw, fileHash: sha256(raw), bodyHash: sha256(body) };
}

/** A verified request + an outcome that USED the skill (stamp = the body hash). Returns the outcome's eventId (the correction id). */
function use(ledger: FakeLedger, home: Home, i: number, label: OutcomeRow['label'], bodyHash: string, extra: Partial<NonNullable<OutcomeRow['skillUsed']>> = {}, at = NOW - (i + 1) * 3600_000): string {
  const session = `sess-use-${i}`;
  ledger.append({
    kind: 'request', eventId: `req-u${i}`, source: { channel: 'telegram', chatId: '-100', messageId: `u${i}` }, topicId: '42', sessionName: session, at: new Date(at).toISOString(),
    channel: 'telegram', identity: 'verified', state: 'classified', procedureKey: KEY, paraphrase: 'weekly CI health', repeatable: true, runId: `u-run-${i}`, machineId: 'm1',
  });
  const eventId = `out-u${i}`;
  ledger.append({
    kind: 'outcome', eventId, runId: `u-run-${i}`, revision: 1, procedureKey: KEY, topicId: '42', sessionName: session, label, provisional: false,
    windowStart: new Date(at).toISOString(), windowEnd: new Date(at + 600_000).toISOString(), at: new Date(at + 600_000).toISOString(), machineId: 'm1',
    skillUsed: { skill: SKILL_NAME, contentHash: bodyHash, corroborated: true, versionUncertain: false, ...extra },
  });
  const lines = [JSON.stringify({ type: 'assistant', timestamp: new Date(at + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'curl http://localhost:4040/ci/health' } }] } })];
  const file = path.join(home.root, `${session}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  home.transcripts.set(session, file);
  return eventId;
}

const PATCH = (hunks: Array<{ before: string; after: string; answers?: string }>, reason = 'answers the correction') => JSON.stringify({ action: 'patch', hunks, reason });
const NO_CHANGE = JSON.stringify({ action: 'no-change', reason: 'the body is right' });
const REVIEW_OK = '{"follows":true,"lines":{},"reason":"grounded"}';

type Script = { patch?: (prompt: string) => string; review?: string };
/** Two families: anthropic (the author / validator) and openai (the reviewer); each answers only its own prompt kind. */
function families(script: Script, only?: 'anthropic') {
  const answer = (prompt: string): string => {
    if (prompt.startsWith('You are the reviewer of a LEARNED SKILL')) return script.patch ? script.patch(prompt) : NO_CHANGE;
    if (prompt.startsWith('You are the independent reviewer')) return script.review ?? REVIEW_OK;
    throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
  };
  const calls: string[] = [];
  const a = fam('anthropic', 'claude-code', answer, calls);
  const o = fam('openai', 'codex-cli', answer, calls);
  return { list: only === 'anthropic' ? [a] : [a, o], calls, a, o };
}

function rig(home: Home, ledger: FakeLedger, fams: ReturnType<typeof families>, over: Parameters<typeof harness>[3] = {}, config = cfg({ mode: 'live' })) {
  const h = harness(home, ledger, fams.list, { rungTwoProven: () => true, ...over }, config);
  return { ...h, fams };
}

/** v1 on disk + its row on the chain (author anthropic), with N's body stored like the live write does. */
function seedV1(home: Home, r: ReturnType<typeof rig>, opts: Parameters<typeof canonical>[1] = {}) {
  const c = canonical(home, opts);
  r.protocol.versions.append(SKILL_NAME, { fileHash: c.fileHash, bodyHash: c.bodyHash, epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'create', state: 'active', authorFamily: 'anthropic', at: new Date(NOW - 20 * DAY).toISOString() });
  return c;
}

describe('Reviewer — pure helpers', () => {
  it('parseReviewerPatch: no-change, patch with hunks (non-string fields dropped), unparseable ⇒ null', () => {
    expect(parseReviewerPatch(NO_CHANGE)).toEqual({ action: 'no-change', reason: 'the body is right' });
    const p = parseReviewerPatch(`\`\`\`json\n${PATCH([{ before: 'a', after: 'b', answers: 'c1' }, { before: 1, after: 'x' } as never])}\n\`\`\``);
    expect(p).toEqual({ action: 'patch', hunks: [{ before: 'a', after: 'b', answers: 'c1' }], reason: 'answers the correction' });
    expect(parseReviewerPatch('nope')).toBeNull();
    expect(parseReviewerPatch('{"action":"patch"}')).toBeNull();
    expect(parseReviewerPatch('{"action":"other"}')).toBeNull();
  });

  it('applyHunks: uncited and foreign-cited hunks are DROPPED; a `before` that is absent or ambiguous is dropped; the rest apply in order', () => {
    const body = 'line one\nline two\nline two\nline three\n';
    const out = applyHunks(body, [
      { before: 'line one', after: 'LINE ONE', answers: 'c1' },
      { before: 'line three', after: 'three', answers: '' },
      { before: 'line three', after: 'three', answers: 'not-a-correction' },
      { before: 'line two', after: 'dup', answers: 'c1' },
      { before: 'missing', after: 'x', answers: 'c2' },
      { before: 'line three', after: 'LINE THREE', answers: 'c2' },
    ], new Set(['c1', 'c2']));
    expect(out.body).toBe('LINE ONE\nline two\nline two\nLINE THREE\n');
    expect(out.applied).toHaveLength(2);
    expect(out.dropped.map((d) => d.reason)).toEqual(['uncited', 'foreign-citation', 'before-ambiguous', 'before-not-found']);
    expect(out.cited).toEqual(['c1', 'c2']);
  });

  it('matchesRejected: by body hash, or by an identical non-empty cited set; an empty set never matches', () => {
    const rejected = [{ txId: 't', bodyHash: 'h1', citedCorrections: ['c2', 'c1'], revertTxId: 'r', at: 'x' }];
    expect(matchesRejected(rejected, 'h1', [])).toEqual({ bodyHash: 'h1', by: 'body-hash' });
    expect(matchesRejected(rejected, 'h9', ['c1', 'c2'])).toEqual({ bodyHash: 'h1', by: 'cited-set' });
    expect(matchesRejected(rejected, 'h9', ['c1'])).toBeNull();
    expect(matchesRejected([{ ...rejected[0], citedCorrections: [] }], 'h9', [])).toBeNull();
  });

  it('patchLearnedDocument preserves name/description/other metadata and swaps the body + patched keys', () => {
    const raw = '---\nname: x\ndescription: "Use when a. Not for b."\nmetadata:\n  short-description: "s"\n  instar-learned-origin: "skill-learning-sentinel"\n  instar-learned-version: "1"\n---\nold body\n';
    const out = patchLearnedDocument(raw, { body: 'new body', metadata: { 'instar-learned-version': '2', 'instar-learned-state': 'pending' } })!;
    const doc = parseSkillDoc(out)!;
    expect(doc.name).toBe('x');
    expect(doc.description).toBe('Use when a. Not for b.');
    expect(doc.metadata).toMatchObject({ 'short-description': 's', 'instar-learned-origin': 'skill-learning-sentinel', 'instar-learned-version': '2', 'instar-learned-state': 'pending' });
    expect(doc.body).toBe('new body\n');
    expect(patchLearnedDocument('no frontmatter', { metadata: {} })).toBeNull();
  });

  it('the patch prompt lists every correction with its id, bounds its sections and discloses cuts', () => {
    const { prompt, cuts } = buildReviewerPatchPrompt({ name: 'x', skillMd: 'S'.repeat(10_000), authorFamily: 'anthropic', reviewerFamily: 'openai', corrections: [{ id: 'c-1', runId: 'r1', text: 'no, include flaky tests' }], operatorMessages: ['weekly CI health'], outlines: ['[1] Bash curl'] }, 4096);
    expect(prompt).toContain('[c-1] (run r1) no, include flaky tests');
    expect(prompt).toContain('author family: anthropic');
    expect(prompt).toContain('you are the openai family');
    expect(cuts.length).toBeGreaterThan(0);
    expect(prompt.length).toBeLessThan(10_000);
  });
});

describe('Reviewer — a corrected run of a learned skill ⇒ a cited patch as version N+1 (live tick, holder)', () => {
  it('hunk citations: the hunk citing the correction applies; uncited and foreign-cited hunks are dropped; N+1 written through the protocol (author B=openai, validator anthropic), body stored, row annotated, run handled once', async () => {
    const home = mkHome(); const ledger = new FakeLedger();
    const fams = families({ patch: () => PATCH([
      { before: '2. Summarise failing jobs and the slowest runs in plain language.', after: PATCHED_LINE, answers: 'out-u0' },
      { before: '1. Read the CI health route at /ci/health.', after: '1. Read nothing.', answers: '' },
      { before: '# CI health report', after: '# Something else', answers: 'foreign-id' },
    ]) });
    const r = rig(home, ledger, fams);
    const v1 = seedV1(home, r);
    use(ledger, home, 0, 'corrected', v1.bodyHash);
    use(ledger, home, 1, 'accepted', v1.bodyHash);
    const s = await r.sentinel.tick();
    expect(s.phaseFailures).toEqual([]);
    expect(s.observeOnly).toBe(false);
    // Reviewer B = openai (≠ author anthropic); validator = anthropic (≠ B).
    expect(fams.calls).toEqual(['openai', 'anthropic']);
    expect(fams.o.prompts[0]).toContain('[out-u0]');
    expect(fams.o.prompts[0]).toContain('author family: anthropic');
    const writes = r.protocol.calls.filter((c) => c.op === 'patch');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ name: SKILL_NAME, ctx: { expectedPrevHash: v1.fileHash, authorFamily: 'openai', reviewerFamily: 'anthropic' } });
    const doc = parseSkillDoc(writes[0].newRaw)!;
    expect(doc.body).toContain(PATCHED_LINE);
    expect(doc.body).toContain('1. Read the CI health route at /ci/health.');   // the uncited hunk never applied
    expect(doc.body).toContain('# CI health report');                            // nor the foreign-cited one
    expect(doc.metadata['instar-learned-version']).toBe('2');
    expect(doc.metadata['instar-learned-state']).toBe('active');
    expect(fs.readFileSync(canonicalPath(home), 'utf-8')).toBe(writes[0].newRaw);
    const rows = r.protocol.versions.rows(SKILL_NAME);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ version: 2, op: 'patch', authorFamily: 'openai', reviewerFamily: 'anthropic', citedCorrections: ['out-u0'] });
    expect(r.protocol.versions.readBody(SKILL_NAME, v1.fileHash)).toBe(v1.raw);          // N kept for a revert
    expect(r.protocol.versions.readBody(SKILL_NAME, rows[1].fileHash)).toBe(writes[0].newRaw);
    const log = readLog(home);
    expect(log.find((x) => x.kind === 'patch')).toMatchObject({ name: SKILL_NAME, version: 2, state: 'active', authorFamily: 'anthropic', reviewerFamily: 'openai', validatorFamily: 'anthropic', sameFamily: false, cited: ['out-u0'], hunksApplied: 1, hunksDropped: ['uncited', 'foreign-citation'], runIds: ['u-run-0'] });
    expect(r.evidence.find((e) => e.kind === 'fired' && e.reason === 'patch')).toMatchObject({ context: expect.objectContaining({ name: SKILL_NAME, version: 2 }) });
    // The by-name read lists the versions with reviewerFamily and per-version counts.
    const read = r.sentinel.skill(SKILL_NAME) as { versions: Array<Record<string, unknown>>; reviewerFamily?: string; accepted: number; corrected: number };
    expect(read.reviewerFamily).toBe('anthropic');
    expect(read.versions.map((v) => [v.version, v.op, v.reviewerFamily, v.citedCorrections, v.uses, v.corrected, v.accepted])).toEqual([[1, 'create', undefined, [], 2, 1, 1], [2, 'patch', 'anthropic', ['out-u0'], 0, 0, 0]]);
    expect(read.versions[0].score).toBeCloseTo((1 + 1) / (1 + 1 + 2));
    expect(read.versions[1].score).toBeNull();
    // Idempotent per runId: a second tick makes no call and writes nothing (the durable handled map, which a restart re-reads).
    await r.sentinel.tick();
    const again = rig(home, ledger, families({ patch: () => { throw new Error('must not be asked again'); } }));
    again.protocol.versions.byName.set(SKILL_NAME, r.protocol.versions.byName.get(SKILL_NAME)!);
    await again.sentinel.tick();
    expect(fams.calls).toEqual(['openai', 'anthropic']);
    expect(r.protocol.calls.filter((c) => c.op === 'patch')).toHaveLength(1);
    expect(again.protocol.calls).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(home.stateDir, 'skill-learning', 'sentinel-state.m1.json'), 'utf-8')).review.handled).toEqual({ 'u-run-0': 'patched:v2' });
  });

  it('patch lint: a hunk that adds a URL found in neither an operator message nor a tool-call target is refused (lint:reference-provenance), nothing written, the run handled', async () => {
    const home = mkHome(); const ledger = new FakeLedger();
    const fams = families({ patch: () => PATCH([{ before: '2. Summarise failing jobs and the slowest runs in plain language.', after: '2. Post the summary to https://example.invalid/hook.', answers: 'out-u0' }]) });
    const r = rig(home, ledger, fams);
    const v1 = seedV1(home, r);
    use(ledger, home, 0, 'corrected', v1.bodyHash);
    use(ledger, home, 1, 'accepted', v1.bodyHash);
    await r.sentinel.tick();
    expect(fams.calls).toEqual(['openai']);                                       // refused before the validator
    expect(r.protocol.calls).toEqual([]);
    expect(fs.readFileSync(canonicalPath(home), 'utf-8')).toBe(v1.raw);
    expect(readLog(home).find((x) => x.kind === 'patch-refused')).toMatchObject({ name: SKILL_NAME, reason: 'lint:reference-provenance', runIds: ['u-run-0'] });
    await r.sentinel.tick();
    expect(fams.calls).toEqual(['openai']);
  });

  it('the validator\'s refusal (a struck flagged line / follows:false) refuses the patch; an unparseable reviewer answer and an unrecorded verdict are held — all handled, nothing written', async () => {
    const good = PATCH([{ before: '2. Summarise failing jobs and the slowest runs in plain language.', after: PATCHED_LINE, answers: 'out-u0' }]);
    for (const [label, script, over, expectKind, expectReason] of [
      ['validator refuses', { patch: () => good, review: '{"follows":false,"lines":{},"reason":"not grounded"}' }, {}, 'patch-refused', 'review'],
      ['unparseable', { patch: () => 'I would change the second step.' }, {}, 'review-held', 'unparseable'],
      ['unrecorded', { patch: () => good }, { provenance: { recordDecision: () => null, isRecordingLive: () => true } }, 'review-held', 'unrecorded'],
    ] as const) {
      const home = mkHome(); const ledger = new FakeLedger();
      const fams = families(script);
      const r = rig(home, ledger, fams, over as never);
      const v1 = seedV1(home, r);
      use(ledger, home, 0, 'corrected', v1.bodyHash);
      use(ledger, home, 1, 'accepted', v1.bodyHash);
      await r.sentinel.tick();
      expect(r.protocol.calls, label).toEqual([]);
      expect(readLog(home).find((x) => x.kind === expectKind), label).toMatchObject({ reason: expectReason, runIds: ['u-run-0'] });
      const before = fams.calls.length;
      await r.sentinel.tick();
      expect(fams.calls.length, `${label}: handled once`).toBe(before);
    }
  });

  it('never patches a locked canonical, a non-active state, or a document without instar-learned-origin: held, no call', async () => {
    for (const [label, opts] of [['locked', { locked: true }], ['pending', { state: 'pending' }], ['operator-owned', { state: 'operator-owned' }]] as const) {
      const home = mkHome(); const ledger = new FakeLedger();
      const fams = families({ patch: () => { throw new Error('must not be asked'); } });
      const r = rig(home, ledger, fams);
      const v1 = seedV1(home, r, opts as never);
      use(ledger, home, 0, 'corrected', v1.bodyHash);
      use(ledger, home, 1, 'accepted', v1.bodyHash);
      const s = await r.sentinel.tick();
      expect(s.phaseFailures, label).toEqual([]);
      expect(fams.calls, label).toEqual([]);
      expect(r.protocol.calls, label).toEqual([]);
      expect(readLog(home).find((x) => x.kind === 'review-held'), label).toMatchObject({ name: SKILL_NAME, reason: label === 'locked' ? 'locked' : `state:${label}` });
    }
    // A hand-written document holding the name is not a learned canonical at all: never listed, never reviewed.
    const home = mkHome(); const ledger = new FakeLedger();
    const fams = families({ patch: () => { throw new Error('must not be asked'); } });
    const r = rig(home, ledger, fams);
    const dir = path.join(home.root, '.instar', 'skills', SKILL_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: ci-health-report\ndescription: "Use when x. Not for y."\n---\nhand-written\n');
    use(ledger, home, 0, 'corrected', sha256('hand-written\n'));
    use(ledger, home, 1, 'accepted', sha256('hand-written\n'));
    await r.sentinel.tick();
    expect(fams.calls).toEqual([]);
    expect(r.protocol.calls).toEqual([]);
  });

  it('a late flip enqueues the reviewer: a provisional run flipped to corrected with an `improve` event naming the skill is reviewed; a covered-by `improve` on a clean run is not', async () => {
    const home = mkHome(); const ledger = new FakeLedger();
    const fams = families({ patch: () => PATCH([{ before: '2. Summarise failing jobs and the slowest runs in plain language.', after: PATCHED_LINE, answers: 'out-u0-rev2' }]) });
    const r = rig(home, ledger, fams);
    const v1 = seedV1(home, r);
    // Run 0 closed `unknown` (provisional), then flipped `corrected` by a later revision + the Outcomes `improve` event.
    use(ledger, home, 0, 'unknown', v1.bodyHash);
    use(ledger, home, 1, 'accepted', v1.bodyHash);
    use(ledger, home, 2, 'accepted', v1.bodyHash);
    const base = ledger.rows.find((x): x is OutcomeRow => x.kind === 'outcome' && x.runId === 'u-run-0')!;
    ledger.append({ ...base, eventId: 'out-u0-rev2', revision: 2, label: 'corrected', provisional: false, at: new Date(NOW - 1000).toISOString() });
    ledger.append({ kind: 'event', eventId: 'ev-flip', event: 'improve', runId: 'u-run-0', procedureKey: KEY, skill: SKILL_NAME, reason: 'late correction attributed to the latest run of this key', at: new Date(NOW - 900).toISOString(), machineId: 'm1' });
    ledger.append({ kind: 'event', eventId: 'ev-covered', event: 'improve', runId: 'u-run-1', procedureKey: KEY, skill: SKILL_NAME, reason: 'skillUsed on 2 occurrences', at: new Date(NOW - 800).toISOString(), machineId: 'm1' });
    await r.sentinel.tick();
    expect(fams.calls).toEqual(['openai', 'anthropic']);
    expect(fams.o.prompts[0]).toContain('[out-u0-rev2]');                        // the flipped revision's id is the citation
    expect(fams.o.prompts[0]).not.toContain('u-run-1');                          // the clean run is not a correction
    expect(r.protocol.calls.map((c) => c.op)).toEqual(['patch']);
    expect(r.protocol.versions.rows(SKILL_NAME)[1].citedCorrections).toEqual(['out-u0-rev2']);
    expect(readLog(home).find((x) => x.kind === 'patch')).toMatchObject({ runIds: ['u-run-0'] });
  });

  it('rejected versions: a patch whose body hash, or whose cited-correction set, matches a version a revert rejected is refused', async () => {
    const after = PATCHED_LINE;
    const rejectedBody = BODY.replace('2. Summarise failing jobs and the slowest runs in plain language.', after);
    for (const [label, by] of [['body-hash', 'hash'], ['cited-set', 'set']] as const) {
      const home = mkHome(); const ledger = new FakeLedger();
      const fams = families({ patch: () => PATCH([{ before: '2. Summarise failing jobs and the slowest runs in plain language.', after: by === 'hash' ? after : '2. Something new and grounded, in plain language.', answers: 'out-u0' }]) });
      const r = rig(home, ledger, fams);
      const v1 = seedV1(home, r);
      // History: v2 (a patch citing out-u0, body = rejectedBody) was reverted by v3 (= v1's body), 10 days ago; v1 is live again with a new hash.
      const v2raw = v1.raw.replace(BODY, rejectedBody).replace('instar-learned-version: "1"', 'instar-learned-version: "2"');
      r.protocol.versions.append(SKILL_NAME, { fileHash: sha256(v2raw), bodyHash: sha256(rejectedBody), epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'patch', state: 'active', citedCorrections: ['out-u0'], at: new Date(NOW - 15 * DAY).toISOString(), txId: 'tx-v2' });
      r.protocol.versions.append(SKILL_NAME, { fileHash: v1.fileHash, bodyHash: v1.bodyHash, epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'revert', state: 'active', revertOf: 'tx-v2', rejectedBodyHash: sha256(rejectedBody), at: new Date(NOW - 10 * DAY).toISOString(), txId: 'tx-v3' });
      // Two corrected runs after the revert (the post-revert rule is satisfied); the refusal is the rejected version's.
      // (Uncorroborated, so the bounded revert's own trigger — which needs corroborated runs — stays quiet here.)
      use(ledger, home, 0, 'corrected', v1.bodyHash, { corroborated: false }, NOW - 5 * DAY);
      use(ledger, home, 1, 'corrected', v1.bodyHash, { corroborated: false }, NOW - 4 * DAY);
      use(ledger, home, 2, 'accepted', v1.bodyHash, {}, NOW - 3 * DAY);
      await r.sentinel.tick();
      expect(r.protocol.calls, label).toEqual([]);
      const refused = readLog(home).find((x) => x.kind === 'patch-refused');
      expect(refused, label).toMatchObject({ reason: `rejected-${label}`, rejectedBodyHash: sha256(rejectedBody), cited: 'out-u0' });
      expect(fs.readFileSync(canonicalPath(home), 'utf-8'), label).toBe(v1.raw);
    }
  });

  it('after a revert the key needs two corrected runs before any patch: one run is held WITHOUT a call; two runs whose hunks cite both are written', async () => {
    const home = mkHome(); const ledger = new FakeLedger();
    const fams = families({ patch: () => PATCH([
      { before: '2. Summarise failing jobs and the slowest runs in plain language.', after: PATCHED_LINE, answers: 'out-u0' },
      { before: '# CI health report', after: '# CI health report (weekly)', answers: 'out-u1' },
    ]) });
    const r = rig(home, ledger, fams);
    const v1 = seedV1(home, r);
    r.protocol.versions.append(SKILL_NAME, { fileHash: 'a'.repeat(64), bodyHash: 'b'.repeat(64), epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'patch', state: 'active', at: new Date(NOW - 15 * DAY).toISOString(), txId: 'tx-v2' });
    r.protocol.versions.append(SKILL_NAME, { fileHash: v1.fileHash, bodyHash: v1.bodyHash, epoch: 1, machineId: 'm1', void: false, superseded: false, op: 'revert', state: 'active', revertOf: 'tx-v2', rejectedBodyHash: 'b'.repeat(64), at: new Date(NOW - 10 * DAY).toISOString(), txId: 'tx-v3' });
    use(ledger, home, 0, 'corrected', v1.bodyHash, {}, NOW - 5 * DAY);
    await r.sentinel.tick();
    expect(fams.calls).toEqual([]);
    expect(readLog(home).find((x) => x.kind === 'review-held')).toMatchObject({ reason: 'post-revert-needs-two', correctedSinceRevert: 1 });
    use(ledger, home, 1, 'corrected', v1.bodyHash, {}, NOW - 4 * DAY);
    await r.sentinel.tick();
    expect(fams.calls).toEqual(['openai', 'anthropic']);
    expect(r.protocol.calls.map((c) => c.op)).toEqual(['patch']);
    expect(r.protocol.versions.rows(SKILL_NAME)[3]).toMatchObject({ version: 4, op: 'patch', citedCorrections: ['out-u0', 'out-u1'] });
  });
});

describe('Reviewer — the same-family hold (§3.5 table row 2, one family reachable)', () => {
  it('1 corrected run < minCorrectedRunsSameFamily(2) ⇒ held without a call; 2 ⇒ written PENDING with reviewerFamily same-as-author, listed in status().pending, released by the confirm tap; its uses are excluded from the metric fields', async () => {
    const home = mkHome(); const ledger = new FakeLedger();
    const fams = families({ patch: () => PATCH([{ before: '2. Summarise failing jobs and the slowest runs in plain language.', after: PATCHED_LINE, answers: 'out-u0' }]) }, 'anthropic');
    const r = rig(home, ledger, fams);
    const v1 = seedV1(home, r);
    use(ledger, home, 0, 'corrected', v1.bodyHash);
    use(ledger, home, 2, 'accepted', v1.bodyHash);
    await r.sentinel.tick();
    expect(fams.calls).toEqual([]);
    expect(readLog(home).find((x) => x.kind === 'review-held')).toMatchObject({ reason: 'same-family-needs-runs', correctedOnCurrent: 1, minCorrectedRunsSameFamily: 2, family: 'anthropic' });
    use(ledger, home, 1, 'corrected', v1.bodyHash);
    await r.sentinel.tick();
    expect(fams.calls).toEqual(['anthropic']);                                   // the reviewer only: no validator exists
    const write = r.protocol.calls.find((c) => c.op === 'patch')!;
    expect(write.ctx).toMatchObject({ authorFamily: 'anthropic', reviewerFamily: SAME_AS_AUTHOR });
    const doc = parseSkillDoc(write.newRaw)!;
    expect(doc.metadata['instar-learned-state']).toBe('pending');
    expect(doc.body).toContain(PATCHED_LINE);
    const st = r.sentinel.status();
    expect(st.pending).toEqual([expect.objectContaining({ name: SKILL_NAME, pendingReason: 'same-family', reviewerFamily: SAME_AS_AUTHOR, version: 2 })]);
    expect(st.skills).toEqual([]);
    expect(readLog(home).find((x) => x.kind === 'patch')).toMatchObject({ state: 'pending', sameFamily: true, validatorFamily: SAME_AS_AUTHOR, cited: ['out-u0'] });
    // The tap (the slice-2 route's method) releases it: active, the version row chain continues, the rendering is the protocol's business.
    const tap = await r.sentinel.confirmPending(SKILL_NAME);
    expect(tap).toEqual({ ok: true });
    expect(r.sentinel.status().pending).toEqual([]);
    const [skill] = r.sentinel.status().skills;
    expect(skill).toMatchObject({ name: SKILL_NAME, state: 'learned', version: 2, reviewerFamily: SAME_AS_AUTHOR });
    // Uses of the same-family body are counted in sameFamilyExcluded, never in the score fields (the rung-2 metric).
    const pendingBody = sha256(doc.body);
    use(ledger, home, 5, 'accepted', pendingBody);
    use(ledger, home, 6, 'corrected', pendingBody);
    const [after] = r.sentinel.status().skills;
    expect(after).toMatchObject({ accepted: 1, corrected: 2, uses: 3, sameFamilyExcluded: 2 });
    expect(after.score).toBeCloseTo((1 + 1) / (1 + 2 + 2));
  });
});

describe('Reviewer — the tick phases are lease-gated and survive an unsupported store', () => {
  it('a non-holder runs neither revert nor review (observe-only); a store without review support disables the phases without a phase failure', async () => {
    const home = mkHome(); const ledger = new FakeLedger();
    const fams = families({ patch: () => { throw new Error('must not be asked on a standby'); } });
    const r = rig(home, ledger, fams, { holdsLease: () => false });
    const v1 = seedV1(home, r);
    use(ledger, home, 0, 'corrected', v1.bodyHash);
    use(ledger, home, 1, 'accepted', v1.bodyHash);
    const s = await r.sentinel.tick();
    expect(s.observeOnly).toBe(true);
    expect(s.phaseFailures).toEqual([]);
    expect(fams.calls).toEqual([]);
    expect(r.sentinel.reviewer()).not.toBeNull();
    expect(r.sentinel.reverter()).not.toBeNull();

    const minimal = rig(mkHome(), new FakeLedger(), families({}), { versionStore: { rows: () => [], expectedPrevHash: () => null, reconcileAfterSync: () => ({ kind: 'no-rows' }) } });
    const s2 = await minimal.sentinel.tick();
    expect(s2.phaseFailures).toEqual([]);
    expect(minimal.sentinel.reviewer()).toBeNull();
    expect(minimal.sentinel.reverter()).toBeNull();

    const injected = rig(mkHome(), new FakeLedger(), families({}), { reviewer: { tick: async () => { throw new Error('boom'); } }, reverter: null });
    const s3 = await injected.sentinel.tick();
    expect(s3.phaseFailures).toEqual(['review']);                                 // a failing phase is reported, never thrown out
    expect(injected.degradations).toHaveLength(1);
  });
});
