// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/**
 * SkillLearningSentinel — slice 2 live mode (Tier 1). Spec docs/specs/skill-learning-sentinel.md §3.4 (arbiter
 * promotion), §3.5 (pending / active, the one-tap confirm, the 7-day "new" label, the commit protocol as the
 * only writer), §3.9 (index cost handed to the models, cost strike logged + accepted), §8.
 *
 * The commit protocol is an in-memory fake (CommitProtocolLike); the sentinel never constructs 2A's classes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SkillLearningSentinel, versionLookupFromStore } from '../../src/monitoring/SkillLearningSentinel.js';
import { parseSkillDoc } from '../../src/monitoring/skillLearning/Drafter.js';
import type { VerdictRow } from '../../src/monitoring/skillLearning/types.js';
import {
  ARBITER, DAY, FakeLedger, KEY, NOW, REVIEW_OK, SKILL_MD, SKILL_NAME, canonicalPath, cfg, cleanupHomes, fam, harness, mkHome, proposalDirs,
  readLog, renderedPaths, responder, seedHistory, sha256, writeSampledProposal,
} from '../helpers/skillLearningLiveFixtures.js';

afterEach(() => cleanupHomes());

const twoFamilies = () => [fam('anthropic', 'claude-code', responder({})), fam('openai', 'codex-cli', responder({}))];
const nothingRendered = (home: ReturnType<typeof mkHome>) => { for (const p of renderedPaths(home)) expect(fs.existsSync(p)).toBe(false); };

describe('live mode — who writes', () => {
  it('shadow NEVER calls the commit protocol (spy): the draft is a proposal, no canonical, nothing rendered', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const h = harness(home, ledger, twoFamilies(), {}, cfg({ mode: 'shadow' }));
    const s = await h.sentinel.tick();
    expect(s.drafted).toBe(1);
    expect(h.protocol.calls).toEqual([]);
    expect(proposalDirs(home)).toEqual([SKILL_NAME]);
    expect(fs.existsSync(canonicalPath(home))).toBe(false);
    nothingRendered(home);
    expect(h.sentinel.status().pending).toEqual([]);
    expect(h.sentinel.status().mode).toBe('shadow');
  });

  it('live + rung 2 unproven ⇒ exactly one write(create, expectedPrevHash null) with state pending; unrendered; listed in status().pending; no proposal', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const h = harness(home, ledger, twoFamilies(), { rungTwoProven: () => false }, cfg({ mode: 'live' }));
    const s = await h.sentinel.tick();
    expect(s.phaseFailures).toEqual([]);
    expect(s.drafted).toBe(1);
    expect(h.protocol.calls).toHaveLength(1);
    const call = h.protocol.calls[0];
    expect(call).toMatchObject({ op: 'create', name: SKILL_NAME, ctx: { expectedPrevHash: null } });
    expect(call.ctx.reason).toContain('pending');
    const doc = parseSkillDoc(call.newRaw)!;
    expect(doc.metadata['instar-learned-state']).toBe('pending');
    expect(doc.metadata['instar-learned-origin']).toBe('skill-learning-sentinel');
    expect(doc.metadata['instar-learned-created']).toBe(new Date(NOW).toISOString());
    expect(fs.readFileSync(canonicalPath(home), 'utf-8')).toBe(call.newRaw);
    nothingRendered(home);
    expect(proposalDirs(home)).toEqual([]);
    const st = h.sentinel.status();
    expect(st.mode).toBe('live');
    expect(st.pending).toEqual([expect.objectContaining({
      name: SKILL_NAME, pendingReason: 'rung-unproven', reviewerFamily: 'openai', fileHash: sha256(call.newRaw), version: 1,
      createdAt: new Date(NOW).toISOString(), paraphrases: ['weekly CI health of the instar repo'],
    })]);
    expect(st.pending[0].description).toContain('Use when');
    expect(st.skills).toEqual([]);                       // pending is not a learned skill yet
    expect(st.counts.skills).toBe(0);
    expect(h.sentinel.skill(SKILL_NAME)).toMatchObject({ name: SKILL_NAME, state: 'proposal' }); // by-name read still answers
    expect(readLog(home).find((r) => r.kind === 'create')).toMatchObject({ state: 'pending', name: SKILL_NAME, key: KEY, pendingReason: 'rung-unproven', version: 1, fence: 'local' });
    expect(readLog(home).find((r) => r.kind === 'would-create')).toBeUndefined();
    expect(h.evidence.find((e) => e.kind === 'fired' && e.reason === 'pending')).toMatchObject({ context: expect.objectContaining({ name: SKILL_NAME }) });
    // The next tick does not write again: the key has a canonical (listed as learned) ⇒ covered-by-learned / no second call.
    const again = await h.sentinel.tick();
    expect(again.drafted).toBe(0);
    expect(h.protocol.calls).toHaveLength(1);
  });

  it('live + rung 2 proven ⇒ state active, instar-learned-created set, 7-day "new" label at read time (and gone after 7 days)', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const h = harness(home, ledger, twoFamilies(), { rungTwoProven: () => true }, cfg({ mode: 'live' }));
    await h.sentinel.tick();
    const call = h.protocol.calls[0];
    expect(call.op).toBe('create');
    const doc = parseSkillDoc(call.newRaw)!;
    expect(doc.metadata['instar-learned-state']).toBe('active');
    expect(doc.metadata['instar-learned-created']).toBe(new Date(NOW).toISOString());
    const st = h.sentinel.status();
    expect(st.pending).toEqual([]);
    expect(st.skills).toEqual([expect.objectContaining({ name: SKILL_NAME, state: 'learned', isNew: true, operatorEdited: 0, version: 1 })]);
    expect(readLog(home).find((r) => r.kind === 'create')).toMatchObject({ state: 'active', pendingReason: null });
    expect(h.evidence.find((e) => e.kind === 'fired' && e.reason === 'create')).toBeTruthy();
    h.clock.now = NOW + 7 * DAY - 1;
    expect(h.sentinel.status().skills[0].isNew).toBe(true);
    h.clock.now = NOW + 7 * DAY;
    expect(h.sentinel.status().skills[0].isNew).toBe(false);
  });

  it('one family reachable ⇒ pending even after rung 2 (pendingReason one-family), no review call', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const a = fam('anthropic', 'claude-code', responder({}));
    const h = harness(home, ledger, [a, fam('anthropic', 'claude-code', responder({}))], { rungTwoProven: () => true }, cfg({ mode: 'live' }));
    await h.sentinel.tick();
    expect(h.protocol.calls).toHaveLength(1);
    expect(parseSkillDoc(h.protocol.calls[0].newRaw)!.metadata['instar-learned-state']).toBe('pending');
    expect(h.protocol.calls[0].ctx.reason).toContain('one-family');
    expect(a.calls).toEqual(['anthropic', 'anthropic']);
    expect(h.sentinel.status().pending[0]).toMatchObject({ pendingReason: 'one-family' });
    expect(h.sentinel.status().pending[0].reviewerFamily).toBeUndefined();
    nothingRendered(home);
  });

  it('a refused commit holds the key (draft-refused: commit:<reason>), writes nothing, and is retried only after the re-ask horizon', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const h = harness(home, ledger, twoFamilies(), {}, cfg({ mode: 'live' }));
    h.protocol.refuse = 'aborted-unreachable';
    const s = await h.sentinel.tick();
    expect(s.refused).toBe(1);
    expect(h.protocol.calls).toHaveLength(1);
    expect(fs.existsSync(canonicalPath(home))).toBe(false);
    expect(proposalDirs(home)).toEqual([]);
    expect(readLog(home).find((r) => r.kind === 'draft-refused')).toMatchObject({ reason: 'commit:aborted-unreachable', name: SKILL_NAME });
    const hold = ledger.rows.find((r): r is VerdictRow => r.kind === 'verdict' && r.by === 'default-rung' && r.verdict === 'wait');
    expect(hold?.reason).toBe('draft-refused: commit:aborted-unreachable');
    expect(hold?.expiresAt).toBe(new Date(NOW + 14 * DAY).toISOString());
    // Inside the horizon: no second call (the hold is durable).
    await h.sentinel.tick();
    expect(h.protocol.calls).toHaveLength(1);
    expect(h.sentinel.internalCounters().commitRefusals).toBe(1);
  });

  it('live with NO commit protocol wired ⇒ a degradation is reported and the draft falls back to a shadow proposal (nothing lost, nothing written)', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const h = harness(home, ledger, twoFamilies(), { commitProtocol: null }, cfg({ mode: 'live' }));
    const s = await h.sentinel.tick();
    expect(s.drafted).toBe(1);
    expect(proposalDirs(home)).toEqual([SKILL_NAME]);
    expect(fs.existsSync(canonicalPath(home))).toBe(false);
    expect(h.degradations).toEqual([expect.objectContaining({ primary: 'mode: live (commit protocol)' })]);
    expect(readLog(home).find((r) => r.kind === 'would-create')).toMatchObject({ liveFallback: 'no-commit-protocol' });
  });

  it('an unrecorded judgment discards the draft in live mode too: draft-refused: unrecorded, zero protocol calls', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const h = harness(home, ledger, twoFamilies(), { provenance: { recordDecision: () => null, isRecordingLive: () => true } }, cfg({ mode: 'live' }));
    const s = await h.sentinel.tick();
    expect(s.drafted).toBe(0);
    expect(h.protocol.calls).toEqual([]);
    expect(fs.existsSync(canonicalPath(home))).toBe(false);
    expect(readLog(home).find((r) => r.kind === 'draft-refused')).toMatchObject({ reason: 'unrecorded' });
    // Recording off entirely ⇒ the same (fail closed).
    const home2 = mkHome(); const ledger2 = new FakeLedger(); seedHistory(ledger2, home2, 3);
    const h2 = harness(home2, ledger2, twoFamilies(), { provenance: { recordDecision: () => 'jp', isRecordingLive: () => false } }, cfg({ mode: 'live' }));
    await h2.sentinel.tick();
    expect(h2.protocol.calls).toEqual([]);
  });

  it('mode is read LIVE: a sentinel built in shadow flips to live between ticks when the reader says so', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    let mode: 'shadow' | 'live' = 'shadow';
    // Arbiter says wait so the default-rung draft is a plain draft in both modes and the key is not held by a proposal yet.
    const h = harness(home, ledger, twoFamilies(), { mode: () => mode }, cfg({ mode: 'shadow' }));
    await h.sentinel.tick();
    expect(h.protocol.calls).toEqual([]);
    expect(proposalDirs(home)).toEqual([SKILL_NAME]);
    // A second key appears; the mode flips.
    seedHistory(ledger, home, 3, { key: 'deploy-summary' });
    mode = 'live';
    const live = fam('anthropic', 'claude-code', responder({ draft: `NEW\n${SKILL_MD.replace(SKILL_NAME, 'deploy-summary').replace('CI health of the instar repo', 'deploy summary')}` }));
    const h2 = harness(home, ledger, [live, fam('openai', 'codex-cli', responder({}))], { mode: () => mode }, cfg({ mode: 'shadow' }));
    await h2.sentinel.tick();
    expect(h2.sentinel.status().mode).toBe('live');
    expect(h2.protocol.calls.map((c) => [c.op, c.name])).toEqual([['create', 'deploy-summary']]);
  });
});

describe('live mode — arbiter promotion (§3.4 shadow comparison → §3.5 who acts)', () => {
  const promotedCase = (home: ReturnType<typeof mkHome>, n: number) => {
    // n sampled disagreements, every one crediting the arbiter.
    for (let i = 0; i < n; i++) writeSampledProposal(home, `sample-${i}`, i % 2 === 0 ? 'arbiter-only' : 'default-only', i % 2 === 0 ? 'agree' : 'disagree');
  };

  it('4 sampled disagreements (min 5) ⇒ NOT promoted: an arbiter-only draft stays a shadow proposal, a default-only draft is written', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 2);   // default waits; arbiter drafts
    promotedCase(home, 4);
    const h = harness(home, ledger, twoFamilies(), {}, cfg({ mode: 'live' }));
    expect(h.sentinel.arbiterPromotion()).toEqual({ sampled: 4, arbiterRight: 4, defaultRight: 0, promoted: false });
    await h.sentinel.tick();
    expect(h.protocol.calls).toEqual([]);
    expect(proposalDirs(home)).toContain(SKILL_NAME);
    expect(readLog(home).find((r) => r.kind === 'arbiter-promotion')).toMatchObject({ sampled: 4, promoted: false, minDisagreementsSampled: 5 });
    expect(readLog(home).find((r) => r.kind === 'would-create')).toMatchObject({ disagreement: 'arbiter-only' });

    // Default drafts + arbiter never, unpromoted ⇒ the default acts: written live (labelled default-only).
    const home2 = mkHome(); const ledger2 = new FakeLedger(); seedHistory(ledger2, home2, 3);
    promotedCase(home2, 4);
    const h2 = harness(home2, ledger2, [fam('anthropic', 'claude-code', responder({ arbiter: ARBITER('never') })), fam('openai', 'codex-cli', responder({}))], {}, cfg({ mode: 'live' }));
    await h2.sentinel.tick();
    expect(h2.protocol.calls.map((c) => c.op)).toEqual(['create']);
    expect(readLog(home2).find((r) => r.kind === 'create')).toMatchObject({ disagreement: 'default-only' });
  });

  it('5 sampled disagreements beating the default ⇒ promoted: an arbiter-only draft is written live; a default-only draft is held (arbiter-governs)', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 2);
    promotedCase(home, 5);
    const h = harness(home, ledger, twoFamilies(), {}, cfg({ mode: 'live' }));
    expect(h.sentinel.arbiterPromotion()).toEqual({ sampled: 5, arbiterRight: 5, defaultRight: 0, promoted: true });
    await h.sentinel.tick();
    expect(h.protocol.calls.map((c) => [c.op, c.name])).toEqual([['create', SKILL_NAME]]);
    expect(readLog(home).find((r) => r.kind === 'create')).toMatchObject({ disagreement: 'arbiter-only', arbiterOnly: true });
    expect(proposalDirs(home)).not.toContain(SKILL_NAME);
    expect(readLog(home).find((r) => r.kind === 'arbiter-promotion')).toMatchObject({ sampled: 5, promoted: true });

    const home2 = mkHome(); const ledger2 = new FakeLedger(); seedHistory(ledger2, home2, 3);
    promotedCase(home2, 5);
    const h2 = harness(home2, ledger2, [fam('anthropic', 'claude-code', responder({ arbiter: ARBITER('never') })), fam('openai', 'codex-cli', responder({}))], {}, cfg({ mode: 'live' }));
    const s = await h2.sentinel.tick();
    expect(h2.protocol.calls).toEqual([]);
    expect(s.held).toBe(1);
    expect(readLog(home2).find((r) => r.kind === 'arbiter-governs')).toMatchObject({ key: KEY, arbiter: 'never', default: 'draft', sampled: 5 });
    expect(ledger2.rows.find((r): r is VerdictRow => r.kind === 'verdict' && r.by === 'default-rung')?.reason).toBe('arbiter-governs: never');
    expect(h2.evidence.find((e) => e.kind === 'held' && e.reason === 'arbiter-governs')).toBeTruthy();
  });

  it('5 sampled but the default was right more often ⇒ not promoted; a tie is not "beating"', () => {
    const home = mkHome();
    for (let i = 0; i < 3; i++) writeSampledProposal(home, `d-${i}`, 'arbiter-only', 'disagree');   // default right
    for (let i = 0; i < 2; i++) writeSampledProposal(home, `a-${i}`, 'default-only', 'disagree');   // arbiter right
    const h = harness(home, new FakeLedger(), twoFamilies(), {}, cfg({ mode: 'live' }));
    expect(h.sentinel.arbiterPromotion()).toEqual({ sampled: 5, arbiterRight: 2, defaultRight: 3, promoted: false });
    writeSampledProposal(home, 'a-2', 'arbiter-only', 'agree');
    expect(h.sentinel.arbiterPromotion()).toMatchObject({ sampled: 6, arbiterRight: 3, defaultRight: 3, promoted: false });
    // Agreed proposals (no disagreement label) and unjudged ones are not part of the sample.
    writeSampledProposal(home, 'z', 'arbiter-only', 'agree');
    const dir = path.join(home.stateDir, 'skill-learning', 'proposals', 'z');
    const side = JSON.parse(fs.readFileSync(path.join(dir, 'proposal.json'), 'utf-8'));
    delete side.verdict;
    fs.writeFileSync(path.join(dir, 'proposal.json'), JSON.stringify(side));
    expect(h.sentinel.arbiterPromotion().sampled).toBe(6);
  });
});

describe('live mode — confirm / reject taps', () => {
  async function pendingHome() {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const h = harness(home, ledger, twoFamilies(), {}, cfg({ mode: 'live' }));
    await h.sentinel.tick();
    expect(h.sentinel.status().pending).toHaveLength(1);
    return { home, ledger, h, pendingHash: h.sentinel.status().pending[0].fileHash };
  }

  it('confirm: write(confirm, expectedPrevHash = pending hash) flips the state to active with an activation stamp; idempotent on a second tap', async () => {
    const { home, h, pendingHash } = await pendingHome();
    h.clock.now = NOW + 3 * DAY;
    expect(await h.sentinel.confirmPending(SKILL_NAME, { forwardedFromMachine: 'standby-1' })).toEqual({ ok: true });
    expect(h.protocol.calls.map((c) => c.op)).toEqual(['create', 'confirm']);
    const confirm = h.protocol.calls[1];
    expect(confirm.ctx).toMatchObject({ expectedPrevHash: pendingHash });
    const doc = parseSkillDoc(confirm.newRaw)!;
    expect(doc.metadata['instar-learned-state']).toBe('active');
    expect(doc.metadata['instar-learned-activated']).toBe(new Date(NOW + 3 * DAY).toISOString());
    expect(doc.metadata['instar-learned-key']).toBe(KEY);                     // everything else preserved
    expect(doc.metadata['instar-learned-created']).toBe(new Date(NOW).toISOString());
    expect(doc.body).toBe(parseSkillDoc(h.protocol.calls[0].newRaw)!.body);
    const st = h.sentinel.status();
    expect(st.pending).toEqual([]);
    expect(st.skills).toEqual([expect.objectContaining({ name: SKILL_NAME, state: 'learned', isNew: true })]);
    expect(fs.existsSync(path.join(home.stateDir, 'skill-learning', 'pending', `${SKILL_NAME}.json`))).toBe(false);
    expect(readLog(home).find((r) => r.kind === 'confirm')).toMatchObject({ name: SKILL_NAME, prevFileHash: pendingHash, forwardedFromMachine: 'standby-1' });
    expect(h.evidence.find((e) => e.kind === 'fired' && e.reason === 'confirm')).toBeTruthy();
    // "new" counts from the activation, not the creation.
    h.clock.now = NOW + 3 * DAY + 7 * DAY - 1;
    expect(h.sentinel.status().skills[0].isNew).toBe(true);
    h.clock.now = NOW + 3 * DAY + 7 * DAY;
    expect(h.sentinel.status().skills[0].isNew).toBe(false);
    // Second tap: ok, no second write.
    expect(await h.sentinel.confirmPending(SKILL_NAME)).toEqual({ ok: true });
    expect(h.protocol.calls.map((c) => c.op)).toEqual(['create', 'confirm']);
    expect(h.sentinel.internalCounters().confirms).toBe(1);
  });

  it('two concurrent confirm taps ⇒ one write, both ok (serialized per name, never a stale-hash conflict)', async () => {
    const { h } = await pendingHome();
    const [a, b] = await Promise.all([h.sentinel.confirmPending(SKILL_NAME), h.sentinel.confirmPending(SKILL_NAME)]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(h.protocol.calls.map((c) => c.op)).toEqual(['create', 'confirm']);
  });

  it('reject: the body becomes a proposal with an operator disagree verdict, write(reject) removes the canonical, nothing rendered; idempotent', async () => {
    const { home, ledger, h, pendingHash } = await pendingHome();
    expect(await h.sentinel.rejectPending(SKILL_NAME)).toEqual({ ok: true });
    expect(h.protocol.calls.map((c) => c.op)).toEqual(['create', 'reject']);
    expect(h.protocol.calls[1].ctx).toMatchObject({ expectedPrevHash: pendingHash });
    expect(parseSkillDoc(h.protocol.calls[1].newRaw)!.metadata['instar-learned-state']).toBe('proposal');
    expect(fs.existsSync(canonicalPath(home))).toBe(false);
    nothingRendered(home);
    expect(proposalDirs(home)).toEqual([SKILL_NAME]);
    const dir = path.join(home.stateDir, 'skill-learning', 'proposals', SKILL_NAME);
    expect(parseSkillDoc(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8'))!.metadata['instar-learned-state']).toBe('proposal');
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'proposal.json'), 'utf-8'));
    expect(sidecar).toMatchObject({ name: SKILL_NAME, key: KEY, reviewerFamily: 'openai', draftKind: 'new', paraphrases: ['weekly CI health of the instar repo'], verdict: { by: 'operator', verdict: 'disagree', reason: 'rejected pending skill' } });
    expect(sidecar.evidence.runIds).toHaveLength(3);
    expect(ledger.rows.find((r): r is VerdictRow => r.kind === 'verdict' && r.by === 'operator')).toMatchObject({ procedureKey: KEY, verdict: 'disagree' });
    expect(h.sentinel.status().pending).toEqual([]);
    expect(h.sentinel.status().proposals[0]).toMatchObject({ name: SKILL_NAME, verdict: expect.objectContaining({ verdict: 'disagree' }) });
    expect(readLog(home).find((r) => r.kind === 'reject')).toMatchObject({ name: SKILL_NAME, key: KEY });
    expect(h.evidence.find((e) => e.kind === 'fired' && e.reason === 'reject')).toBeTruthy();
    // Second tap: nothing pending, the proposal already holds the rejection ⇒ ok, no write.
    expect(await h.sentinel.rejectPending(SKILL_NAME)).toEqual({ ok: true });
    expect(h.protocol.calls.map((c) => c.op)).toEqual(['create', 'reject']);
    // And the sample sees it: a rejected arbiter-agreed draft credits the default.
    expect(h.sentinel.arbiterPromotion().sampled).toBe(0);   // disagreement was null (both rungs agreed) ⇒ not a disagreement sample
  });

  it('hash chain (§3.5 step 3): the tap fences on the version row, not the file — a hand-edited pending canonical is refused user-edit-conflict and locked; untouched confirms', async () => {
    const { home, h, pendingHash } = await pendingHome();
    expect(h.protocol.versions.expectedPrevHash(SKILL_NAME)).toBe(pendingHash);
    // The operator hand-edits the pending canonical (the file hash moves; the chain does not).
    const file = canonicalPath(home);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('2. Summarise failing jobs', '2. Summarise failing jobs AND flaky tests'));
    const editedHash = sha256(fs.readFileSync(file, 'utf-8'));
    expect(editedHash).not.toBe(pendingHash);
    expect(await h.sentinel.confirmPending(SKILL_NAME)).toEqual({ ok: false, error: 'user-edit-conflict' });
    const call = h.protocol.calls[1];
    expect(call.op).toBe('confirm');
    expect(call.ctx.expectedPrevHash).toBe(pendingHash);                    // the chain hash, NOT the edited on-disk hash
    expect(readLog(home).find((r) => r.kind === 'confirm-refused')).toMatchObject({ name: SKILL_NAME, reason: 'user-edit-conflict', expectedPrevHash: pendingHash, chain: 'version-row', onDiskFileHash: editedHash });
    // The protocol locked it operator-owned: no longer pending, listed as a locked learned skill, sidecar gone.
    expect(h.sentinel.status().pending).toEqual([]);
    expect(h.sentinel.status().skills).toEqual([expect.objectContaining({ name: SKILL_NAME, state: 'locked', locked: true })]);
    expect(fs.existsSync(path.join(home.stateDir, 'skill-learning', 'pending', `${SKILL_NAME}.json`))).toBe(false);
    expect(await h.sentinel.confirmPending(SKILL_NAME)).toEqual({ ok: false, error: 'not-pending' });
    expect(await h.sentinel.rejectPending(SKILL_NAME)).toEqual({ ok: false, error: 'not-pending' });
    // Untouched ⇒ confirmed, fenced on the same chain hash.
    const fresh = await pendingHome();
    expect(await fresh.h.sentinel.confirmPending(SKILL_NAME)).toEqual({ ok: true });
    expect(fresh.h.protocol.calls[1].ctx.expectedPrevHash).toBe(fresh.pendingHash);
    expect(readLog(fresh.home).find((r) => r.kind === 'confirm')).toMatchObject({ chain: 'version-row', prevFileHash: fresh.pendingHash });
    // Reject on a hand-edited pending: the same refusal, the proposal copy is still written (nothing lost).
    const edited = await pendingHome();
    const f2 = canonicalPath(edited.home);
    fs.writeFileSync(f2, fs.readFileSync(f2, 'utf-8') + '\nextra line\n');
    expect(await edited.h.sentinel.rejectPending(SKILL_NAME)).toEqual({ ok: false, error: 'user-edit-conflict' });
    expect(edited.h.protocol.calls[1]).toMatchObject({ op: 'reject', ctx: { expectedPrevHash: edited.pendingHash } });
    expect(fs.existsSync(canonicalPath(edited.home))).toBe(true);
    expect(proposalDirs(edited.home)).toEqual([SKILL_NAME]);
    expect(readLog(edited.home).find((r) => r.kind === 'reject-refused')).toMatchObject({ reason: 'user-edit-conflict' });
  });

  it('with no version store wired the tap fences on the on-disk hash and says so (chain: on-disk)', async () => {
    const { home, h, pendingHash } = await pendingHome();
    (h.sentinel as unknown as { deps: { versionStore: null } }).deps.versionStore = null;
    expect(await h.sentinel.confirmPending(SKILL_NAME)).toEqual({ ok: true });
    expect(h.protocol.calls[1].ctx.expectedPrevHash).toBe(pendingHash);
    expect(readLog(home).find((r) => r.kind === 'confirm')).toMatchObject({ chain: 'on-disk' });
  });

  it('errors are named: invalid name, unknown name, an active skill (not pending), a refused commit, no protocol', async () => {
    const { h } = await pendingHome();
    expect(await h.sentinel.confirmPending('Bad Name')).toEqual({ ok: false, error: 'invalid-name' });
    expect(await h.sentinel.rejectPending('Bad Name')).toEqual({ ok: false, error: 'invalid-name' });
    expect(await h.sentinel.confirmPending('nope')).toEqual({ ok: false, error: 'pending-not-found' });
    expect(await h.sentinel.rejectPending('nope')).toEqual({ ok: false, error: 'pending-not-found' });
    h.protocol.refuse = 'not-holder';
    expect(await h.sentinel.confirmPending(SKILL_NAME)).toEqual({ ok: false, error: 'commit:not-holder (fake refusal)' });
    expect(h.sentinel.status().pending).toHaveLength(1);      // still pending, nothing changed
    h.protocol.refuse = null;
    expect(await h.sentinel.confirmPending(SKILL_NAME)).toEqual({ ok: true });
    expect(await h.sentinel.rejectPending(SKILL_NAME)).toEqual({ ok: false, error: 'not-pending' });
    const home2 = mkHome(); const ledger2 = new FakeLedger(); seedHistory(ledger2, home2, 3);
    const h2 = harness(home2, ledger2, twoFamilies(), {}, cfg({ mode: 'live' }));
    await h2.sentinel.tick();
    (h2.sentinel as unknown as { deps: { commitProtocol: null } }).deps.commitProtocol = null;
    expect(await h2.sentinel.confirmPending(SKILL_NAME)).toEqual({ ok: false, error: 'no-commit-protocol' });
  });
});

describe('live mode — §3.9 index cost', () => {
  it('the measured index line reaches the arbiter, drafter and reviewer prompts; a cost strike is logged with the measurement and ACCEPTED', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    for (const [layout, name, desc] of [['.claude/skills', 'alpha', 'Use when alpha. Not for beta.'], ['.agents/skills', 'alpha', 'Use when alpha. Not for beta.']] as const) {
      fs.mkdirSync(path.join(home.root, layout, name), { recursive: true });
      fs.writeFileSync(path.join(home.root, layout, name, 'SKILL.md'), `---\nname: ${name}\ndescription: "${desc}"\n---\nbody\n`);
    }
    const a = fam('anthropic', 'claude-code', responder({}));
    const b = fam('openai', 'codex-cli', responder({ review: '{"follows":true,"lines":{},"cost":"strike","costReason":"description longer than its value","reason":"grounded"}' }));
    const h = harness(home, ledger, [a, b], { indexCost: undefined }, cfg({ mode: 'live' }));
    const s = await h.sentinel.tick();
    expect(s.phaseFailures).toEqual([]);
    expect(s.drafted).toBe(1);                                  // accepted despite the strike
    const line = 'Measured skill index cost: .claude/skills: 1 skills, 37 bytes of descriptions (limit 15000 chars, headroom 14963); .agents/skills: 1 skills, 37 bytes of descriptions (loader limit unknown).';
    expect(a.prompts[0]).toContain('Measured skill index cost: 74 bytes');   // the arbiter sees the total
    expect(a.prompts[1]).toContain(line);                                      // the drafter sees the headroom line
    expect(b.prompts[0]).toContain(line);                                      // so does the reviewer
    expect(b.prompts[0]).toContain('Question 3 (index cost)');
    expect(readLog(home).find((r) => r.kind === 'index-cost')).toMatchObject({ name: SKILL_NAME, verdict: 'strike', accepted: true, reason: 'description longer than its value', indexBytes: 74, claudeHeadroomChars: 14963, reviewerFamily: 'openai' });
    expect(h.evidence.find((e) => e.reason === 'index-cost-strike')).toMatchObject({ context: expect.objectContaining({ accepted: true }) });
    expect(h.sentinel.internalCounters().costStrikes).toBe(1);
    expect(h.protocol.calls).toHaveLength(1);
  });

  it('an unmeasured tick says so in both prompts and never fails the tick', async () => {
    const home = mkHome(); const ledger = new FakeLedger(); seedHistory(ledger, home, 3);
    const a = fam('anthropic', 'claude-code', responder({}));
    const h = harness(home, ledger, [a, fam('openai', 'codex-cli', responder({}))], { indexCost: () => { throw new Error('disk gone'); } }, cfg({ mode: 'live' }));
    const s = await h.sentinel.tick();
    expect(s.phaseFailures).toEqual([]);
    expect(a.prompts[1]).toContain('Measured skill index cost: unmeasured this tick.');
    expect(readLog(home).find((r) => r.kind === 'index-cost')).toBeUndefined();
  });
});

describe('SkillLearningSentinel.create — slice 2 wiring', () => {
  const base = (home: ReturnType<typeof mkHome>) => ({
    projectDir: home.root, stateDir: home.stateDir, machineId: 'm1', config: cfg({ mode: 'shadow' }),
    sharedIntelligence: null, topicMemory: null, topicOperatorStore: { asVerifiedOperator: () => null }, provenanceLog: null, detector: null,
    buildProvider: () => null,
  });

  it('rungTwoProven defaults to the ladder view: fleet or ready-to-advance towards fleet ⇒ proven; anything else or no ladder ⇒ unproven', () => {
    const home = mkHome();
    const view = (rung: string, next: string | null, state: string) => ({ features: () => [{ id: 'monitoring.skillLearning', rung, next, state }] });
    expect(SkillLearningSentinel.create({ ...base(home), ladder: view('fleet', null, 'at-final') }).rungTwoProven()).toBe(true);
    expect(SkillLearningSentinel.create({ ...base(home), ladder: view('dev-agent-live', 'fleet', 'ready-to-advance') }).rungTwoProven()).toBe(true);
    expect(SkillLearningSentinel.create({ ...base(home), ladder: view('dev-agent-live', 'fleet', 'soaking') }).rungTwoProven()).toBe(false);
    expect(SkillLearningSentinel.create({ ...base(home), ladder: view('dark', 'dev-agent-live', 'not-started') }).rungTwoProven()).toBe(false);
    expect(SkillLearningSentinel.create({ ...base(home), ladder: { features: () => [] } }).rungTwoProven()).toBe(false);
    expect(SkillLearningSentinel.create({ ...base(home), ladder: null }).rungTwoProven()).toBe(false);
    expect(SkillLearningSentinel.create({ ...base(home), ladder: { features: () => { throw new Error('x'); } } }).rungTwoProven()).toBe(false);
    expect(SkillLearningSentinel.create({ ...base(home), ladder: null, rungTwoProven: () => true }).rungTwoProven()).toBe(true);
  });

  it('versionLookup derives from a wired VersionStore (newest non-void row with the stamp); none ⇒ null; create() accepts the store', () => {
    const home = mkHome();
    const rows = [
      { version: 1, bodyHash: 'a'.repeat(64), void: false, superseded: true },
      { version: 2, bodyHash: 'b'.repeat(64), void: true, superseded: false },
      { version: 3, bodyHash: 'a'.repeat(64), void: false, superseded: false },
    ];
    const store = { rows: (name: string) => (name === 'ci-health-report' ? rows : []) };
    const lookup = versionLookupFromStore(store)!;
    expect(lookup('ci-health-report', 'a'.repeat(64))).toEqual({ version: 3 });   // newest non-void wins over the superseded v1
    expect(lookup('ci-health-report', 'b'.repeat(64))).toBeNull();                 // a void row is no version
    expect(lookup('ci-health-report', 'c'.repeat(64))).toBeNull();
    expect(lookup('other', 'a'.repeat(64))).toBeNull();
    expect(versionLookupFromStore(null)).toBeNull();
    expect(versionLookupFromStore(undefined)).toBeNull();
    expect(() => SkillLearningSentinel.create({ ...base(home), versionStore: store })).not.toThrow();
  });

  it('mode defaults to the live config file: absent/unreadable keeps the construction value; the file wins once it says otherwise', () => {
    const home = mkHome();
    const s = SkillLearningSentinel.create(base(home));
    expect(s.mode()).toBe('shadow');
    fs.writeFileSync(path.join(home.stateDir, 'config.json'), JSON.stringify({ monitoring: { skillLearning: { mode: 'live' } } }));
    expect(s.mode()).toBe('live');
    fs.writeFileSync(path.join(home.stateDir, 'config.json'), '{ not json');
    expect(s.mode()).toBe('shadow');
    expect(SkillLearningSentinel.create({ ...base(home), readMode: () => 'live' }).mode()).toBe('live');
  });
});
