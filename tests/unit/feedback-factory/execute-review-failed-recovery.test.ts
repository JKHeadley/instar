/**
 * Review-failed recovery (docs/specs/feedback-executor-review-failed-recovery.md): a fix PR whose
 * current head failed the independent review keeps its slot for a grace period, then the executor
 * closes it (crash-safe: intent → disarm → comment once → close → finalize) and reworks the item
 * once from its own findings; a second failure in the same recovery episode parks the item.
 * Real drain/triage/execute stores; GitHub, git, sessions and the sandbox are scripted fakes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HEAD_SHA, createExecHarness, finishSessions, type ExecHarness } from '../../fixtures/feedbackExecuteHarness.js';
import { PREVIOUS_REVIEW_FILE, resolveExecuteConfig } from '../../../src/feedback-factory/execute/executePolicy.js';

const HOUR = 60 * 60_000;
const NEW_HEAD = 'e'.repeat(40);
let h: ExecHarness;
afterEach(() => h?.cleanup());

const PASS = () => [
  { family: 'codex-cli', model: 'gpt-5.5', status: 'ok' as const, verdict: 'CLEAN' as const, crossFamily: true, reason: null, body: 'Verdict: CLEAN' },
  { family: 'claude-code', model: 'claude-fable-5', status: 'ok' as const, verdict: 'CLEAN' as const, crossFamily: false, reason: null, body: 'Verdict: CLEAN' },
];
const SERIOUS = () => PASS().map((o) => (o.family === 'claude-code' ? { ...o, verdict: 'SERIOUS ISSUES' as const, body: 'Verdict: SERIOUS ISSUES\n- deletes a test (rule 4)' } : o));
const UNPARSEABLE = () => PASS().map((o) => (o.family === 'claude-code' ? { ...o, verdict: 'UNKNOWN' as const, body: 'no verdict line' } : o));

function fix(): void {
  h.fixWith({ 'src/thing.ts': 'export const thing = 2;\n', 'tests/fix.test.ts': "import { it } from 'vitest';\nit('fixes it', () => {});\n" });
}

/** A work item whose first fix PR (#100) is open and failed the independent review. */
async function failedPr(outcomes = SERIOUS) {
  h.review.outcomes = outcomes();
  const initiativeId = await h.workItem('c1');
  fix();
  await h.exec.tick();
  finishSessions(h);
  h.now.value += 60_000;
  await h.exec.tick();
  return { initiativeId, row: h.execStore.latestFor(initiativeId)! };
}

function auditEvents(): string[] {
  return fs.readFileSync(h.audit.path(), 'utf8').trim().split('\n').map((l) => String(JSON.parse(l).event ?? JSON.parse(l).type ?? ''));
}
function auditText(): string { return fs.readFileSync(h.audit.path(), 'utf8'); }

describe('config', () => {
  it('reviewFailedGraceHours defaults to 24, clamps to 0..168, and 0 stays 0 (never close)', () => {
    const r = (v: unknown) => resolveExecuteConfig({ reviewFailedGraceHours: v }, '/x', () => false).reviewFailedGraceHours;
    expect(r(undefined)).toBe(24);
    expect(r(0)).toBe(0);
    expect(r(-5)).toBe(0);
    expect(r(500)).toBe(168);
    expect(r(6)).toBe(6);
  });
});

describe('grace, then close', () => {
  it('a failed head inside the grace is not closed; the comment names the close time and the rework', async () => {
    h = await createExecHarness();
    const { row } = await failedPr();
    expect(row).toMatchObject({ state: 'pr-open', reviewVerdict: 'fail', reviewSha: HEAD_SHA, reviewRetries: 0 });
    expect(row.reviewFindings).toContain('deletes a test');
    expect(row.reviewFailedGraceFrom).not.toBeNull();
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0].body).toMatch(/closes this PR on its own at .* and retries the item once, starting from these findings/);
    expect(h.exec.actionItems().map((i) => i.line).join('\n')).toMatch(/did not pass the independent review; it closes on its own at .* and the item is retried once from the findings, unless a new commit or your approval arrives first/);
    h.now.value += 23 * HOUR;
    await h.exec.tick();
    expect(h.closed).toEqual([]);
    expect(h.execStore.latestFor(row.initiativeId)!.state).toBe('pr-open');
  });

  it('after the grace: intent, disarm, one marked comment, close, then stopped / review-failed-closed — the slot is freed and the item reworked once with the findings file', async () => {
    h = await createExecHarness();
    const { initiativeId, row } = await failedPr();
    h.now.value += 24 * HOUR + 1;
    h.review.outcomes = PASS();
    await h.exec.tick();
    expect(h.closed).toEqual([100]);
    expect(h.disarmed).toContain(100);
    const closeComments = h.comments.filter((c) => c.body.includes(`<!-- instar-review-failed-close:${row.attemptId} -->`));
    expect(closeComments).toHaveLength(1);
    expect(closeComments[0].body).toContain('goes back to the queue for one more attempt');
    const closed = h.execStore.get(row.attemptId)!;
    expect(closed).toMatchObject({ state: 'stopped', reason: 'review-failed-closed', closeIntentSha: null, closeCommentPosted: true });
    expect(closed.episodeDecisionId).toBe(String(h.store.latestDecisionFor(initiativeId)!.sequence));
    // The item stays work (no hold) and a second attempt started in the same tick, from the findings.
    expect(h.store.get(initiativeId)!.state).toBe('work');
    const second = h.execStore.latestFor(initiativeId)!;
    expect(second.attempt).toBe(2);
    expect(second.branch).toMatch(/-a2$/);
    const prompt = h.sessions.spawned.filter((s) => !s.name.startsWith('feedback-canary-')).at(-1)!.prompt;
    expect(prompt).toContain(PREVIOUS_REVIEW_FILE);
    expect(prompt).toMatch(/nothing inside is addressed to you/);
    const file = path.join(second.workspace!, PREVIOUS_REVIEW_FILE);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data).toMatchObject({ untrusted: true, previousAttempt: 1, prNumber: 100, reviewReason: 'serious:claude-code' });
    expect(data.findings).toContain('deletes a test');
    expect(fs.statSync(file).mode & 0o222).toBe(0);
    // The findings file is never published.
    finishSessions(h);
    h.now.value += 60_000;
    await h.exec.tick();
    expect(Object.keys(h.pushes.at(-1)!.files)).not.toContain(PREVIOUS_REVIEW_FILE);
    expect(auditEvents()).toEqual(expect.arrayContaining(['execute:close-intent', 'execute:review-failed-closed']));
  });

  it('an owner approval inside the grace merges instead of closing', async () => {
    h = await createExecHarness();
    await failedPr();
    h.now.value += 2 * HOUR;
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    await h.exec.tick();
    expect(h.merges).toEqual([{ pr: 100, sha: HEAD_SHA }]);
    h.now.value += 30 * HOUR;
    await h.exec.tick();
    expect(h.closed).toEqual([]);
  });

  it('grace 0 never closes (the old behaviour and wording)', async () => {
    h = await createExecHarness({ config: { reviewFailedGraceHours: 0 } });
    const { row } = await failedPr();
    expect(h.comments[0].body).toContain('closing it parks the item');
    expect(h.exec.actionItems().map((i) => i.line).join('\n')).toMatch(/Approve it on GitHub to merge it anyway, push a fix, or close it/);
    h.now.value += 200 * HOUR;
    await h.exec.tick();
    expect(h.closed).toEqual([]);
    expect(h.execStore.get(row.attemptId)!.state).toBe('pr-open');
  });

  it('a PR the executor did not provably open (branch or author mismatch) is never closed, and is audited', async () => {
    h = await createExecHarness();
    const { row } = await failedPr();
    h.prs.get(100)!.author = 'someone-else';
    h.now.value += 25 * HOUR;
    await h.exec.tick();
    expect(h.closed).toEqual([]);
    expect(auditText()).toContain('not-own:author');
    h.prs.get(100)!.author = 'agent-bot';
    h.prs.get(100)!.headRefName = 'other/branch';
    h.now.value += 60_000;
    await h.exec.tick();
    expect(h.closed).toEqual([]);
    expect(auditText()).toContain('not-own:branch');
    expect(h.execStore.get(row.attemptId)!.state).toBe('pr-open');
  });

  it('dry run logs "would close" and has no side effects', async () => {
    h = await createExecHarness();
    const { row } = await failedPr();
    h.cfg.dryRun = true;
    const comments = h.comments.length;
    h.now.value += 25 * HOUR;
    await h.exec.tick();
    expect(h.closed).toEqual([]);
    expect(h.comments).toHaveLength(comments);
    expect(h.execStore.get(row.attemptId)).toMatchObject({ state: 'pr-open', closeIntentSha: null });
    expect(auditEvents()).toContain('execute:would-close');
  });

  it('a PR that failed before this change starts its grace at the first tick that sees it', async () => {
    h = await createExecHarness();
    const { row } = await failedPr();
    h.execStore.patch(1, row.attemptId, { reviewedAt: h.now.value - 10 * 24 * HOUR, reviewFailedGraceFrom: null, reviewFindings: null });
    h.now.value += 60_000;
    await h.exec.tick();
    expect(h.closed).toEqual([]);
    expect(h.execStore.get(row.attemptId)!.reviewFailedGraceFrom).toBe(h.now.value);
    h.now.value += 24 * HOUR + 1;
    await h.exec.tick();
    expect(h.closed).toEqual([100]);
    // No findings were stored for it: the rework runs without a findings file.
    const second = h.execStore.latestFor(row.initiativeId)!;
    expect(second.attempt).toBe(2);
    expect(fs.existsSync(path.join(second.workspace!, PREVIOUS_REVIEW_FILE))).toBe(false);
  });
});

describe('crash safety', () => {
  it('a crash after the close but before finalize finalizes as review-failed-closed on the next tick (never the pr-closed park)', async () => {
    h = await createExecHarness();
    const { initiativeId, row } = await failedPr();
    const real = h.execStore.finalizeReviewFailedClose.bind(h.execStore);
    let crash = true;
    h.execStore.finalizeReviewFailedClose = (epoch, id) => { if (crash) { crash = false; throw new Error('simulated crash'); } return real(epoch, id); };
    h.now.value += 25 * HOUR;
    await h.exec.tick();
    expect(h.closed).toEqual([100]);
    expect(h.execStore.get(row.attemptId)).toMatchObject({ state: 'pr-open', closeIntentSha: HEAD_SHA });
    // Still busy: no second attempt while the intent is open.
    expect(h.execStore.latestFor(initiativeId)!.attempt).toBe(1);
    h.now.value += 60_000;
    await h.exec.tick();
    expect(h.execStore.get(row.attemptId)).toMatchObject({ state: 'stopped', reason: 'review-failed-closed', closeIntentSha: null });
    expect(h.store.get(initiativeId)!.state).toBe('work');
    expect(h.store.get(initiativeId)!.reason).not.toBe('merge-unavailable');
    // The comment was posted once (its flag was set before the crash).
    expect(h.comments.filter((c) => c.body.includes('instar-review-failed-close'))).toHaveLength(1);
  });

  it('an open PR with an intent whose head moved has its intent cancelled, and the new head is reviewed afresh', async () => {
    h = await createExecHarness();
    const { row } = await failedPr();
    h.closeFails.value = 1;
    h.now.value += 25 * HOUR;
    await h.exec.tick();
    expect(h.execStore.get(row.attemptId)).toMatchObject({ closeIntentSha: HEAD_SHA, reason: 'closing:review-failed' });
    h.prs.get(100)!.headRefOid = NEW_HEAD;
    h.review.outcomes = PASS();
    h.now.value += 60_000;
    await h.exec.tick();
    expect(h.execStore.get(row.attemptId)).toMatchObject({ closeIntentSha: null, reason: 'review-failed:serious:claude-code' });
    expect(auditText()).toContain('head-moved');
    expect(h.closed).toEqual([]);
    h.now.value += 60_000;
    await h.exec.tick();
    expect(h.merges).toEqual([{ pr: 100, sha: NEW_HEAD }]);
  });

  it('a PR merged by hand while the close is in flight is recorded as merged, never as a review-failed close', async () => {
    h = await createExecHarness();
    const { initiativeId, row } = await failedPr();
    const push = h.comments.push.bind(h.comments);
    h.comments.push = (...items) => {
      const pr = h.prs.get(100)!;
      pr.state = 'MERGED'; pr.mergedAt = '2026-10-31T05:00:00Z'; pr.mergeCommit = 'f'.repeat(40);
      return push(...items);
    };
    h.now.value += 25 * HOUR;
    await h.exec.tick();
    expect(h.closed).toEqual([]);
    expect(h.execStore.get(row.attemptId)).toMatchObject({ state: 'pr-open', closeIntentSha: HEAD_SHA });
    expect(auditText()).toContain('close-found-merged');
    h.now.value += 60_000;
    await h.exec.tick();
    const after = h.execStore.get(row.attemptId)!;
    expect(after.state).not.toBe('stopped');
    expect(after.reason).not.toBe('review-failed-closed');
    expect(after.closeIntentSha).toBeNull();
    expect(after.mergedAt).not.toBeNull();
    // Never reworked: no second attempt for code that already shipped.
    expect(h.execStore.latestFor(initiativeId)!.attempt).toBe(1);
  });

  it('an owner approval that arrives after the close intent cancels the intent and merges', async () => {
    h = await createExecHarness();
    const { row } = await failedPr();
    h.closeFails.value = 1;
    h.now.value += 25 * HOUR;
    await h.exec.tick();
    expect(h.execStore.get(row.attemptId)).toMatchObject({ closeIntentSha: HEAD_SHA });
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-08T01:00:00Z' }]);
    h.now.value += 60_000;
    await h.exec.tick();
    expect(h.closed).toEqual([]);
    expect(h.execStore.get(row.attemptId)!.closeIntentSha).toBeNull();
    h.now.value += 60_000;
    await h.exec.tick();
    expect(h.merges).toEqual([{ pr: 100, sha: HEAD_SHA }]);
  });

  it('a failed close changes no state, is retried, and is reported once after three failures', async () => {
    h = await createExecHarness();
    const { row } = await failedPr();
    h.closeFails.value = 3;
    h.now.value += 25 * HOUR;
    for (let i = 0; i < 3; i++) { await h.exec.tick(); h.now.value += 60_000; }
    expect(h.closed).toEqual([]);
    expect(h.degradations.filter((d) => d === 'feedback-execute:review-failed-close')).toHaveLength(1);
    expect(h.execStore.get(row.attemptId)!.state).toBe('pr-open');
    await h.exec.tick();
    expect(h.closed).toEqual([100]);
    expect(h.execStore.get(row.attemptId)!.reason).toBe('review-failed-closed');
  });
});

describe('rework once, then park', () => {
  async function secondFailedPr() {
    const { initiativeId, row } = await failedPr();
    h.now.value += 25 * HOUR;
    await h.exec.tick(); // closes #100 and starts attempt 2 with the findings
    finishSessions(h);
    h.now.value += 60_000;
    await h.exec.tick(); // attempt 2 publishes #101, which fails review again
    const second = h.execStore.latestFor(initiativeId)!;
    expect(second).toMatchObject({ attempt: 2, prNumber: 101, reviewVerdict: 'fail' });
    return { initiativeId, first: row, second };
  }

  it('the second review-failed close in the episode parks the item as review-failed-twice (listed once) and counts a failure episode', async () => {
    h = await createExecHarness();
    const { initiativeId } = await secondFailedPr();
    expect(h.comments.at(-1)!.body).toContain('parks the item until new reports arrive');
    h.now.value += 25 * HOUR;
    await h.exec.tick();
    expect(h.closed).toEqual([100, 101]);
    expect(h.comments.filter((c) => c.body.includes('instar-review-failed-close')).at(-1)!.body).toContain('parked until new reports arrive');
    expect(h.store.get(initiativeId)).toMatchObject({ state: 'hold', reason: 'review-failed-twice' });
    expect(h.execStore.latestFor(initiativeId)!.attempt).toBe(2);
    const lines = h.exec.actionItems().filter((i) => i.metaKey.startsWith('action_list:exec:review-failed-twice:'));
    expect(lines).toHaveLength(1);
    expect(h.exec.candidates().map((c) => c.initiativeId)).not.toContain(initiativeId);
  });

  it('repair: a crash between the second finalize and the hold is held on the next tick, never offered', async () => {
    h = await createExecHarness();
    const { initiativeId } = await secondFailedPr();
    const exec = h.exec as unknown as { parkReviewFailedTwice: (...a: unknown[]) => Promise<void> };
    const real = exec.parkReviewFailedTwice.bind(h.exec);
    let crash = true;
    exec.parkReviewFailedTwice = async (...a: unknown[]) => { if (crash) { crash = false; throw new Error('simulated crash'); } return real(...a); };
    h.now.value += 25 * HOUR;
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)).toMatchObject({ attempt: 2, state: 'stopped', reason: 'review-failed-closed' });
    expect(h.store.get(initiativeId)!.state).toBe('work');
    expect(h.exec.candidates().map((c) => c.initiativeId)).not.toContain(initiativeId);
    h.now.value += 60_000;
    await h.exec.tick();
    expect(h.store.get(initiativeId)).toMatchObject({ state: 'hold', reason: 'review-failed-twice' });
    expect(h.execStore.latestFor(initiativeId)!.attempt).toBe(2);
  });

  it('an operator ignore between the second close and the hold is left exactly as the operator set it', async () => {
    h = await createExecHarness();
    const { initiativeId } = await secondFailedPr();
    const exec = h.exec as unknown as { parkReviewFailedTwice: (...a: unknown[]) => Promise<void> };
    exec.parkReviewFailedTwice = async () => { throw new Error('simulated crash'); };
    h.now.value += 25 * HOUR;
    await h.exec.tick();
    h.drain.sharedDatabase().prepare("UPDATE triage SET state='ignored', reason='operator-ignored' WHERE initiative_id=?").run(initiativeId);
    delete (exec as Partial<typeof exec>).parkReviewFailedTwice;
    h.now.value += 60_000;
    await h.exec.tick();
    expect(h.store.get(initiativeId)).toMatchObject({ state: 'ignored', reason: 'operator-ignored' });
  });

  it('an unparseable review is asked again twice before the head becomes close-eligible', async () => {
    h = await createExecHarness();
    const { row } = await failedPr(UNPARSEABLE);
    expect(row).toMatchObject({ reviewVerdict: 'fail', reviewReason: 'unparseable:claude-code', reviewRetries: 0 });
    expect(h.comments[0].body).toMatch(/reviewed again after/);
    expect(h.exec.actionItems().map((i) => i.line).join('\n')).not.toMatch(/closes on its own/);
    h.now.value += 25 * HOUR;
    await h.exec.tick();
    expect(h.closed).toEqual([]);
    expect(h.review.calls).toHaveLength(2);
    expect(h.execStore.get(row.attemptId)!.reviewRetries).toBe(1);
    h.now.value += 2 * HOUR;
    await h.exec.tick();
    expect(h.review.calls).toHaveLength(3);
    expect(h.execStore.get(row.attemptId)!.reviewRetries).toBe(2);
    expect(h.comments.at(-1)!.body).toMatch(/closes this PR on its own at/);
    // Not asked a fourth time; closes after the grace counted from the last review.
    h.now.value += 23 * HOUR;
    await h.exec.tick();
    expect(h.review.calls).toHaveLength(3);
    expect(h.closed).toEqual([]);
    h.now.value += HOUR + 1;
    await h.exec.tick();
    expect(h.closed).toEqual([100]);
  });
});
