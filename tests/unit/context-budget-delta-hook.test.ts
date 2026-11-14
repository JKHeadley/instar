// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Unit — the per-prompt delta hook's server side in shadow
 * (context-budget-layered-summaries §7.7, §9.5, §17; Phase 1 S15).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SeedFetchLog, DeltaShadowLog, fitDeltaForDelivery, PromptCursorStore, computePromptDelta, foldSuppression, messageKey,
  reductionVerdict, renderPromptContextText, resolveContextEpoch, stableBriefingHash, summarizeShadow, unansweredOf,
  boundBriefing, MAX_BRIEFING_CHARS, type PromptMessage, type ShadowPromptRow,
} from '../../src/monitoring/contextLayers/promptContext.js';
import { writeFoldMarker } from '../../src/monitoring/foldMarker.js';
import { FoldRecordStore, type FoldRecord } from '../../src/monitoring/FoldCoordinator.js';
import type { CanaryReport, CanaryGroup } from '../../src/monitoring/compactionCanary.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/context-budget-delta-hook.test.ts';
const T = 4242;
const SID = 'sess-abc_1';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-delta-')); dirs.push(d); return d; }

function msg(id: number, at: number, fromUser: boolean, text = `message ${id}`): PromptMessage {
  return { messageId: id, fromUser, timestamp: new Date(at).toISOString(), text };
}
function seed(stateDir: string, sid: string, seededAt: number, extra: Record<string, unknown> = {}): void {
  const dir = path.join(stateDir, 'state', 'context-layers', '_seeded');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ sessionId: sid, epoch: '', source: 'compact', seededAt, ...extra }));
}
const BRIEFING = '=== TOPIC 4242 INTENT BRIEFING (auto-injected) ===\n  CURRENT WORK\n    goal: ship S15\n    as of 2026-11-10T00:00:00.000Z, 3 messages behind\n=== END TOPIC INTENT BRIEFING ===';
function group(state: CanaryGroup['state'], engine = 'claude-code'): CanaryGroup {
  return { machine: 'm1', engine, version: '2.1', state, detected: 3, complete: 3, pending: 0, synthetic: 1 };
}
function report(groups: CanaryGroup[], runningVersion = '2.1'): CanaryReport {
  const recent = [{ machine: 'm1', engine: 'claude-code', version: runningVersion, topicKey: '1', sessionId: 's', boundaryUuid: 'b', at: 5, trigger: 'auto', recoveryBlock: true, postCompact: true, synthetic: false }];
  return { epochStartedAt: 0, switchOn: true, groups, recent, ledgerResetAt: null, unreadableTranscripts: 0 };
}

describe('the context epoch', () => {
  it('no seeded marker (Codex, never seeded, no id) reads unseeded', () => {
    const sd = tmp();
    expect(resolveContextEpoch(sd, SID).kind).toBe('unseeded');
    expect(resolveContextEpoch(sd, null).kind).toBe('unseeded');
    expect(resolveContextEpoch(sd, '../evil').kind).toBe('unseeded');
  });
  it('a compact or clear seed marker names a seeded epoch; a torn or foreign marker does not', () => {
    const sd = tmp();
    seed(sd, SID, 1000);
    const e = resolveContextEpoch(sd, SID);
    expect(e.kind).toBe('seeded');
    if (e.kind === 'seeded') { expect(e.seededAt).toBe(1000); expect(e.source).toBe('compact'); }
    seed(sd, 'other', 2000, { source: 'clear', epoch: 'fold1' });
    const c = resolveContextEpoch(sd, 'other');
    expect(c.kind === 'seeded' && c.source === 'clear' && c.key.includes('fold1')).toBe(true);
    seed(sd, 'foreign', 3000, { sessionId: 'someone-else' });
    expect(resolveContextEpoch(sd, 'foreign').kind).toBe('unseeded');
    fs.writeFileSync(path.join(sd, 'state', 'context-layers', '_seeded', 'torn.json'), '{not json');
    expect(resolveContextEpoch(sd, 'torn').kind).toBe('unseeded');
  });
});

describe('the delta against the epoch', () => {
  const base = 1_800_000_000_000;
  const msgs = [msg(1, base - 3000, true), msg(2, base - 2000, false), msg(3, base + 1000, true), msg(4, base + 2000, true)];

  it('an epoch with no seed marker gets the full output: delta == full, nothing omitted, no cursor', () => {
    const d = computePromptDelta({ topicId: T, sessionId: SID, epoch: { kind: 'unseeded', key: 'unseeded' }, cursor: null, briefing: BRIEFING, messages: msgs, seedBriefing: { found: false, hash: null }, now: base });
    expect(d.basis).toBe('unseeded-full');
    expect(d.messages).toHaveLength(4);
    expect(d.briefingIncluded).toBe(true);
    expect(d.omitted).toEqual([]);
    expect(d.nextCursor).toBeNull();
  });

  it('an epoch with a marker gets the delta from the seed: messages after seededAt, briefing omitted only when the seed served the same one', () => {
    const epoch = { kind: 'seeded' as const, key: 'compact:x:1', seededAt: base, source: 'compact' as const };
    const same = computePromptDelta({ topicId: T, sessionId: SID, epoch, cursor: null, briefing: BRIEFING, messages: msgs, seedBriefing: { found: true, hash: stableBriefingHash(BRIEFING) }, seedHistory: { found: true }, now: base + 5000 });
    expect(same.basis).toBe('seed');
    expect(same.messages.map((m) => m.messageId)).toEqual([3, 4]);
    expect(same.briefingIncluded).toBe(false);
    expect(same.omitted.map((o) => o.k)).toEqual(['m', 'm', 'b']);
    // The first prompt after a compaction never receives the packet AND the briefing both.
    const unknownSeed = computePromptDelta({ topicId: T, sessionId: SID, epoch, cursor: null, briefing: BRIEFING, messages: msgs, seedBriefing: { found: false, hash: null }, now: base + 5000 });
    expect(unknownSeed.briefingIncluded).toBe(true); // the seed's fetch was not seen: send it (larger, never smaller)
    expect(unknownSeed.messages).toHaveLength(4); // no evidence the seed fetched history: no message counts as delivered
  });

  it('the next prompt is measured from the last one; a changed briefing is sent; the freshness count alone is not a change', () => {
    const epoch = { kind: 'seeded' as const, key: 'compact:x:1', seededAt: base, source: 'compact' as const };
    const first = computePromptDelta({ topicId: T, sessionId: SID, epoch, cursor: null, briefing: BRIEFING, messages: msgs, seedBriefing: { found: true, hash: stableBriefingHash(BRIEFING) }, seedHistory: { found: true }, now: base + 5000 });
    const later = [...msgs.slice(1), msg(5, base + 9000, true)];
    const restamped = BRIEFING.replace('3 messages behind', '9 messages behind');
    const second = computePromptDelta({ topicId: T, sessionId: SID, epoch, cursor: first.nextCursor, briefing: restamped, messages: later, seedBriefing: { found: false, hash: null }, now: base + 9500 });
    expect(second.basis).toBe('last-prompt');
    expect(second.messages.map((m) => m.messageId)).toEqual([5]);
    expect(second.briefingIncluded).toBe(false);
    const changed = BRIEFING.replace('ship S15', 'ship S16');
    const third = computePromptDelta({ topicId: T, sessionId: SID, epoch, cursor: second.nextCursor, briefing: changed, messages: later, seedBriefing: { found: false, hash: null }, now: base + 9900 });
    expect(third.briefingIncluded).toBe(true);
    expect(third.messages).toEqual([]);
  });

  it('a new epoch (a later compaction) resets to the seed basis', () => {
    const e1 = { kind: 'seeded' as const, key: 'compact:x:1', seededAt: base, source: 'compact' as const };
    const first = computePromptDelta({ topicId: T, sessionId: SID, epoch: e1, cursor: null, briefing: '', messages: msgs, seedBriefing: { found: false, hash: null }, now: base });
    const e2 = { kind: 'seeded' as const, key: 'compact:x:2', seededAt: base + 1500, source: 'compact' as const };
    const d = computePromptDelta({ topicId: T, sessionId: SID, epoch: e2, cursor: first.nextCursor, briefing: '', messages: msgs, seedBriefing: { found: false, hash: null }, seedHistory: { found: true }, now: base + 3000 });
    expect(d.basis).toBe('seed');
    expect(d.messages.map((m) => m.messageId)).toEqual([4]);
  });

  it('the cursor store round-trips, refuses unsafe ids, and is 0600', () => {
    const sd = tmp();
    const store = new PromptCursorStore(sd);
    const c = { schema: 'prompt-cursor/1' as const, topicId: T, sessionId: SID, epoch: 'e', seenKeys: ['in:1'], briefingHash: null, updatedAt: 1 };
    expect(store.put(c)).toBe(true);
    expect(store.get(T, SID)?.seenKeys).toEqual(['in:1']);
    expect(store.put({ ...c, sessionId: '../x' })).toBe(false);
    const f = path.join(sd, 'state', 'context-layers', '_prompt-cursors', `${T}--${SID}.json`);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it('message keys are ids, never text', () => {
    expect(messageKey(msg(7, 0, true, 'secret words'))).toBe('in:7');
    expect(messageKey({ eventId: 'ev1', timestamp: '', text: 'x' })).toBe('e:ev1');
    expect(messageKey({ timestamp: 't', text: 'secret words' })).not.toContain('secret');
  });

  it('a seed fetch is recognised only within 30 s before the seed, and by kind', () => {
    const now = 10_000_000;
    const log = new SeedFetchLog(() => now);
    log.noteBriefing(T, BRIEFING);
    expect(log.servedNear(T, now + 20_000, 'briefing').found).toBe(true);
    expect(log.servedNear(T, now + 2 * 60_000, 'briefing').found).toBe(false); // a pre-compaction fetch minutes earlier is not the seed's
    expect(log.servedNear(T, now - 60_000, 'briefing').found).toBe(false);
    expect(log.servedNear(T, now + 1_000, 'history').found).toBe(false);
    log.noteHistory(T);
    expect(log.servedNear(T, now + 1_000, 'history').found).toBe(true);
    expect(log.servedNear(999, now).found).toBe(false);
  });

  it('a stale marker (a later compaction with no new seed) reads unseeded: the full output', () => {
    const sd = tmp();
    seed(sd, SID, 1_000_000);
    expect(resolveContextEpoch(sd, SID, T).kind).toBe('seeded');
    const pc = path.join(sd, 'state', 'context-layers', String(T), 'post-compact');
    fs.mkdirSync(pc, { recursive: true });
    fs.writeFileSync(path.join(pc, `${1_000_000 + 30_000}-${SID}.json`), '{}'); // within tolerance: this seed's own compaction
    expect(resolveContextEpoch(sd, SID, T).kind).toBe('seeded');
    fs.writeFileSync(path.join(pc, `${1_000_000 + 10 * 60_000}-${SID}.json`), '{}'); // a later compaction
    expect(resolveContextEpoch(sd, SID, T).kind).toBe('unseeded');
    fs.writeFileSync(path.join(pc, `${1_000_000 + 10 * 60_000}-other.json`), '{}');
    expect(resolveContextEpoch(sd, 'other', T).kind).toBe('unseeded'); // no marker for "other"
  });

  it('delivery: a delta that fits is sent whole; one over budget is never trimmed (that prompt gets the full output)', () => {
    const epoch = { kind: 'seeded' as const, key: 'compact:x:1', seededAt: base, source: 'compact' as const };
    const prev = { schema: 'prompt-cursor/1' as const, topicId: T, sessionId: SID, epoch: epoch.key, seenKeys: [], briefingHash: 'old', updatedAt: base };
    const small = computePromptDelta({ topicId: T, sessionId: SID, epoch, cursor: prev, briefing: BRIEFING, messages: msgs.slice(0, 2), seedBriefing: { found: false, hash: null }, now: base + 9000 });
    const ok = fitDeltaForDelivery(T, small, BRIEFING, []);
    expect(ok.fits).toBe(true);
    if (ok.fits) { expect(ok.briefingIncluded).toBe(true); expect(ok.messages).toHaveLength(2); }
    expect(ok.cursor).toEqual(small.nextCursor);
    // A changed briefing that alone exceeds the budget: never dropped or starved — the prompt goes full.
    const huge = `${BRIEFING}\n${'w'.repeat(9000)}`;
    const big = computePromptDelta({ topicId: T, sessionId: SID, epoch, cursor: prev, briefing: huge, messages: msgs, seedBriefing: { found: false, hash: null }, now: base + 9000 });
    const over = fitDeltaForDelivery(T, big, huge, []);
    expect(over.fits).toBe(false);
    expect(over.cursor!.briefingHash).toBe(stableBriefingHash(huge)); // the full output delivered it
  });
});

describe('rendering mirrors the hook formatter', () => {
  it('full output: briefing, history header, 300-char cap, unanswered block', () => {
    const long = 'x'.repeat(400);
    const t = renderPromptContextText(T, BRIEFING, [msg(1, 0, false, 'reply'), msg(2, 1, true, long)]);
    expect(t.startsWith(BRIEFING)).toBe(true);
    expect(t).toContain(`TOPIC ${T} RECENT HISTORY (auto-injected):`);
    expect(t).toContain(`${'x'.repeat(297)}...`);
    expect(t).toContain('*** UNANSWERED MESSAGE(S) FROM USER ***');
    expect(unansweredOf([msg(1, 0, true), msg(2, 1, false)])).toEqual([]);
  });
  it('no messages and no briefing renders nothing in full mode, and a one-line note in delta mode', () => {
    expect(renderPromptContextText(T, '', [])).toBe('');
    expect(renderPromptContextText(T, '', [], { mode: 'delta' })).toContain('no new messages since your last prompt');
  });
  it('the briefing is bounded in-band', () => {
    const b = boundBriefing('y'.repeat(MAX_BRIEFING_CHARS + 50));
    expect(b).toContain('[briefing truncated: 50 more characters]');
    const pair = boundBriefing(`${'y'.repeat(MAX_BRIEFING_CHARS - 1)}😀tail`);
    expect(/[\uD800-\uDBFF]\n/.test(pair)).toBe(false); // never a lone high surrogate
  });
});

describe('fold suppression', () => {
  it('a held fold marker suppresses; an open fold record suppresses; a terminal one does not', () => {
    const sd = tmp();
    const now = Date.now();
    expect(foldSuppression(sd, T, 'iid-1')).toEqual({ suppress: false });
    writeFoldMarker(sd, { instarSessionId: 'iid-1', foldId: 'f1', topicKey: String(T), expiresAt: now + 60_000 });
    expect(foldSuppression(sd, T, 'iid-1')).toEqual({ suppress: true, reason: 'fold-marker' });
    expect(foldSuppression(sd, T, 'iid-1', 'codex-cli')).toEqual({ suppress: false }); // folds are Claude Code only
    expect(foldSuppression(sd, T, 'iid-2')).toEqual({ suppress: false });
    const store = new FoldRecordStore(sd);
    const rec: FoldRecord = { schema: 'fold-record/1', foldId: 'f2', topicKey: String(T), machineId: 'm', state: 'locked', seq: 1, ownerEpoch: null, generation: 1, role: 'coordinator', counts: {}, createdAt: now, updatedAt: now };
    store.put(rec);
    expect(foldSuppression(sd, T, null, 'claude-code', now)).toEqual({ suppress: true, reason: 'fold-open' });
    store.put({ ...rec, state: 'committed' });
    expect(foldSuppression(sd, T, null, 'claude-code', now)).toEqual({ suppress: false });
  });

  it('bounded: a stuck open record past the lock ceiling, or a torn record, never mutes the topic', () => {
    const sd = tmp();
    const now = Date.now();
    const store = new FoldRecordStore(sd);
    const rec: FoldRecord = { schema: 'fold-record/1', foldId: 'f3', topicKey: String(T), machineId: 'm', state: 'probing', seq: 1, ownerEpoch: null, generation: 1, role: 'coordinator', counts: {}, createdAt: 1, updatedAt: now - 31 * 60_000 };
    store.put(rec);
    expect(foldSuppression(sd, T, null, 'claude-code', now)).toEqual({ suppress: false, note: 'fold-stale' });
    const sd2 = tmp();
    const dir = new FoldRecordStore(sd2).dirFor(String(T));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'torn1.json'), '{nope');
    expect(foldSuppression(sd2, T, null, 'claude-code', now)).toEqual({ suppress: false, note: 'fold-torn' });
  });
});

describe('reduction is refused unless the canary is healthy', () => {
  it('each refusal names its reason', () => {
    expect(reductionVerdict(false, report([group('healthy')]), true)).toEqual({ allowed: false, reason: 'switch-off' });
    expect(reductionVerdict(true, null, false)).toEqual({ allowed: false, reason: 'sentinel-off' });
    expect(reductionVerdict(true, null, true)).toEqual({ allowed: false, reason: 'canary-not-wired' });
    expect(reductionVerdict(true, report([group('healthy', 'codex')]), true).reason).toBe('canary-no-claude-code-group');
    expect(reductionVerdict(true, report([group('accruing')]), true).reason).toBe('canary-accruing');
    expect(reductionVerdict(true, report([group('uninitialized')]), true).reason).toBe('canary-uninitialized');
    expect(reductionVerdict(true, report([group('healthy'), group('diverged')]), true).reason).toBe('canary-diverged');
  });
  it('allowed only when on and the RUNNING version\'s claude-code group reads healthy', () => {
    expect(reductionVerdict(true, report([group('healthy')]), true)).toEqual({ allowed: true, reason: 'canary-healthy' });
    const oldHealthy = { ...group('healthy'), version: '2.0' };
    expect(reductionVerdict(true, report([oldHealthy, group('accruing')], '2.1'), true).reason).toBe('canary-accruing');
    expect(reductionVerdict(true, report([oldHealthy], '2.1'), true).reason).toBe('canary-running-version-unseen');
    expect(reductionVerdict(true, { ...report([group('healthy')]), recent: [] }, true).reason).toBe('canary-no-recent-detection');
  });
});

describe('the shadow log', () => {
  function row(i: number, omitted = 0): ShadowPromptRow {
    return {
      t: 'prompt', at: i, topicId: T, session: SID, framework: 'claude-code', epoch: 'e', basis: omitted ? 'last-prompt' : 'unseeded-full',
      returned: 'full', fullChars: 1000 + i, deltaChars: omitted ? 100 : 1000 + i, briefingIncluded: !omitted, omittedCount: omitted,
      omitted: Array.from({ length: omitted }, (_, k) => ({ k: 'm' as const, id: `in:${k}` })), reduction: { switchOn: false, allowed: false, reason: 'switch-off' },
    };
  }
  it('rotates at its bound, keeps one rotated segment, and files are 0600', () => {
    const sd = tmp();
    const log = new DeltaShadowLog(sd, 2_000);
    for (let i = 0; i < 40; i++) expect(log.append(row(i))).toBe(true);
    expect(fs.statSync(log.file()).size).toBeLessThanOrEqual(2_000);
    expect(fs.statSync(log.rotated()).size).toBeLessThanOrEqual(2_000);
    expect(fs.readdirSync(path.dirname(log.file())).sort()).toEqual(['prompts.jsonl', 'prompts.jsonl.1']);
    expect(fs.statSync(log.file()).mode & 0o777).toBe(0o600);
    expect(log.rows().length).toBeGreaterThan(0);
  });
  it('never holds message or briefing text', () => {
    const sd = tmp();
    const log = new DeltaShadowLog(sd);
    const secret = 'TOP-SECRET-USER-WORDS';
    const epoch = { kind: 'seeded' as const, key: 'compact:x:1', seededAt: 5, source: 'compact' as const };
    const msgs = [msg(1, 1, true, secret), msg(2, 9, true, `${secret} again`)];
    const d = computePromptDelta({ topicId: T, sessionId: SID, epoch, cursor: null, briefing: `${BRIEFING}\n${secret}`, messages: msgs, seedBriefing: { found: true, hash: stableBriefingHash(`${BRIEFING}\n${secret}`) }, now: 10 });
    log.append({ ...row(1, 0), basis: d.basis, omittedCount: d.omitted.length, omitted: d.omitted });
    expect(fs.readFileSync(log.file(), 'utf-8')).not.toContain(secret);
    expect(fs.readFileSync(log.file(), 'utf-8')).not.toContain('ship S15');
  });
  it('the summary: medians and p95, and re-fetches are unknown (never zero) once anything was omitted', () => {
    const sd = tmp();
    const log = new DeltaShadowLog(sd);
    for (let i = 1; i <= 20; i++) log.append(row(i));
    let s = summarizeShadow(log);
    expect(s.prompts).toBe(20);
    expect(s.fullChars.median).toBe(1010);
    expect(s.fullChars.p95).toBe(1019);
    expect(s.refetched).toEqual({ status: 'nothing-omitted', count: 0 });
    log.append(row(21, 3));
    log.append({ t: 'history-read', at: 22, topicId: T, route: 'topic-context', sinceOmissionMs: 1, omittedAtPrompt: 3 });
    s = summarizeShadow(log);
    expect(s.omittedItems).toBe(3);
    expect(s.refetched.status).toBe('unknown');
    if (s.refetched.status === 'unknown') { expect(s.refetched.historyReadsAfterOmission).toBe(1); expect(s.refetched.reason.length).toBeGreaterThan(20); }
    expect(s.reworkBaseline.status).toBe('unknown');
  });
});
