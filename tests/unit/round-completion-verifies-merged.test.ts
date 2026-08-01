/**
 * A round must be able to finish — and must never claim a verdict it did not reach.
 *
 * `runRound`'s `verifyMergedItems` seam defaulted to a no-op returning an EMPTY
 * SET unconditionally, documented in place as "production callers should pass a
 * real one". No production caller ever did (`src/commands/server.ts` passes only
 * tracker/projectId/roundIndex/targetRepoPath). The consequences, all verified
 * from the code before this change:
 *
 *   - the all-items-merged stop condition could never be true, so a round whose
 *     items were ALL merged still spawned a child to redo them;
 *   - `outcome: 'complete'` was unreachable, so `RoundStatus 'complete'` was
 *     never written by the poller path;
 *   - and since the session-start digest counts only complete /
 *     complete-with-skips, a project could show "0 of 5 done" with every item
 *     merged and verified.
 *
 * The sting worth naming: a verifier that returns ∅ means "I verified nothing",
 * which is indistinguishable to its caller from "nothing is merged". That is the
 * same absence-reads-as-presence move the three-state `MergedVerificationResult`
 * exists to prevent one layer down.
 *
 * So most of what follows tests what the runner declines to conclude.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { runRound, type MergedVerificationResult } from '../../src/core/ProjectRoundExecution.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

const SRC = path.resolve(__dirname, '../../src/core/ProjectRoundExecution.ts');

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rcvm-state-'));
}
function makeGitRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rcvm-target-'));
  SafeGitExecutor.run(['init', '-q'], { cwd: d, operation: 'tests/unit/round-completion-verifies-merged.test.ts:init' });
  SafeGitExecutor.run(['config', 'user.email', 'test@test'], { cwd: d, operation: 'cfg' });
  SafeGitExecutor.run(['config', 'user.name', 'test'], { cwd: d, operation: 'cfg' });
  fs.writeFileSync(path.join(d, 'README'), 'x');
  SafeGitExecutor.run(['add', '.'], { cwd: d, operation: 'cfg' });
  SafeGitExecutor.run(['commit', '-m', 'init', '-q'], { cwd: d, operation: 'cfg' });
  return d;
}

/** Build a three-state verdict without repeating the shape at every callsite. */
const verdict = (o: {
  verified?: string[];
  regressed?: string[];
  unverifiable?: [string, string][];
}): MergedVerificationResult => ({
  verified: new Set(o.verified ?? []),
  regressed: new Set(o.regressed ?? []),
  unverifiable: new Map(o.unverifiable ?? []),
});

describe('a round whose items are all merged can actually finish', () => {
  let stateDir: string;
  let targetRepo: string;
  let tracker: InitiativeTracker;

  beforeEach(() => {
    stateDir = makeStateDir();
    targetRepo = makeGitRepo();
    tracker = new InitiativeTracker(stateDir);
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests:state' }); } catch { /* ignore */ }
    try { SafeFsExecutor.safeRmSync(targetRepo, { recursive: true, force: true, operation: 'tests:repo' }); } catch { /* ignore */ }
  });

  async function project(id: string, items: { id: string; mergeCommitOid?: string }[]) {
    await tracker.create({
      id,
      title: `Project ${id}`,
      description: 'fixture',
      phases: [{ id: 'overview', name: 'overview' }],
      kind: 'project',
      rounds: [{ name: 'r0', itemIds: items.map((i) => i.id) }],
      targetRepoPath: targetRepo,
    });
    for (const it of items) {
      await tracker.create({
        id: it.id,
        title: `Item ${it.id}`,
        description: 'item',
        phases: [{ id: 'p', name: 'p' }],
        parentProjectId: id,
        pipelineStage: it.mergeCommitOid ? 'merged' : 'outline',
        ...(it.mergeCommitOid
          ? {
              prNumber: 1814,
              mergeCommitOid: it.mergeCommitOid,
              ciCheckedAt: '2026-08-01T00:00:00.000Z',
            }
          : {}),
      });
    }
  }

  const base = (projectId: string) => ({
    tracker,
    projectId,
    roundIndex: 0,
    targetRepoPath: targetRepo,
    // Would exit non-zero and be loudly visible if it were ever spawned.
    spawnCommand: 'bash',
    spawnArgs: ['-c', 'exit 99'],
    pollIntervalMs: 50,
    sigtermGraceMs: 100,
  });

  it('THE FIX: every item verified → complete, and no child is spawned to redo it', async () => {
    // Before the change this was unreachable: the default verifier returned ∅,
    // so `every(id => verified.has(id))` was false for any non-empty round and
    // the runner spawned a child to redo already-merged work.
    await project('p-done', [{ id: 'i1', mergeCommitOid: 'a'.repeat(40) }, { id: 'i2', mergeCommitOid: 'b'.repeat(40) }]);
    let calls = 0;

    const r = await runRound(
      {
        ...base('p-done'),
        verifyMergedItems: async (ids) => { calls++; return verdict({ verified: ids }); },
      },
      { stateDir },
    );

    expect(r.outcome).toBe('complete');
    expect(r.mergedItemIds).toEqual(['i1', 'i2']);
    // Exactly one pre-spawn check, and no post-spawn check — because nothing spawned.
    expect(calls).toBe(1);

    const proj = tracker.get('p-done');
    expect(proj?.rounds?.[0].status, 'a finished round must record its verdict').toBe('complete');
  });
});

describe('REFUSAL: "I could not check" is not a verdict, in either direction', () => {
  let stateDir: string;
  let targetRepo: string;
  let tracker: InitiativeTracker;

  beforeEach(() => {
    stateDir = makeStateDir();
    targetRepo = makeGitRepo();
    tracker = new InitiativeTracker(stateDir);
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests:state' }); } catch { /* ignore */ }
    try { SafeFsExecutor.safeRmSync(targetRepo, { recursive: true, force: true, operation: 'tests:repo' }); } catch { /* ignore */ }
  });

  async function project(id: string, items: { id: string; mergeCommitOid?: string }[]) {
    await tracker.create({
      id, title: `Project ${id}`, description: 'fixture',
      phases: [{ id: 'overview', name: 'overview' }], kind: 'project',
      rounds: [{ name: 'r0', itemIds: items.map((i) => i.id) }], targetRepoPath: targetRepo,
    });
    for (const it of items) {
      await tracker.create({
        id: it.id, title: `Item ${it.id}`, description: 'item',
        phases: [{ id: 'p', name: 'p' }], parentProjectId: id,
        pipelineStage: it.mergeCommitOid ? 'merged' : 'outline',
        ...(it.mergeCommitOid
          ? {
              prNumber: 1814,
              mergeCommitOid: it.mergeCommitOid,
              ciCheckedAt: '2026-08-01T00:00:00.000Z',
            }
          : {}),
      });
    }
  }

  const base = (projectId: string, spawnScript: string) => ({
    tracker, projectId, roundIndex: 0, targetRepoPath: targetRepo,
    spawnCommand: 'bash', spawnArgs: ['-c', spawnScript],
    pollIntervalMs: 50, sigtermGraceMs: 100,
  });

  it('an item that RECORDS a merge commit but cannot be checked → no respawn, and NO round verdict', async () => {
    // THE test for this module. The work may already be done; redoing it is the
    // duplicate-work failure, and recording `failed`/`partially-complete` would
    // state a conclusion nothing established.
    await project('p-unk', [{ id: 'i1', mergeCommitOid: 'c'.repeat(40) }]);
    const marker = path.join(targetRepo, 'SPAWNED');

    const r = await runRound(
      {
        ...base('p-unk', `touch ${JSON.stringify(marker)}; exit 0`),
        verifyMergedItems: async () => verdict({ unverifiable: [['i1', 'git: bad ref']] }),
      },
      { stateDir },
    );

    expect(r.outcome).toBe('unverifiable');
    expect(fs.existsSync(marker), 'a child was spawned to redo work that may already be done').toBe(false);
    expect(r.reason).toMatch(/could not verify/i);

    // No verdict recorded — the round keeps the status it had and gets asked again.
    const proj = tracker.get('p-unk');
    expect(proj?.rounds?.[0].status ?? 'pending').toBe('pending');
  });

  it('an item with NO merge commit recorded is NOT-DONE, not unknown — the child still spawns', async () => {
    // The trap this test exists to hold shut. `verifyMergedItemsViaGit` reports
    // `unverifiable` for an item carrying no mergeCommitOid, which is the
    // ORDINARY state of a round nobody has worked yet. Treating that as "could
    // not check" would refuse to spawn and deadlock every fresh round — turning
    // a fix for redoing-finished-work into a total stall.
    //
    // The two are separated by EVIDENCE (does the item record a merge commit?),
    // never by matching the reason text — a reworded message must not be able to
    // change the control flow.
    await project('p-fresh', [{ id: 'i1' }]); // deliberately no mergeCommitOid
    const marker = path.join(targetRepo, 'SPAWNED');

    const r = await runRound(
      {
        ...base('p-fresh', `touch ${JSON.stringify(marker)}; exit 0`),
        verifyMergedItems: async () => verdict({ unverifiable: [['i1', 'no mergeCommitOid recorded on the item']] }),
      },
      { stateDir },
    );

    expect(fs.existsSync(marker), 'a fresh round must still spawn its child').toBe(true);
    expect(r.outcome).not.toBe('unverifiable');
  });

  it('a genuinely regressed item still spawns — only git exit 1 means not-merged', async () => {
    await project('p-reg', [{ id: 'i1', mergeCommitOid: 'd'.repeat(40) }]);
    const marker = path.join(targetRepo, 'SPAWNED');

    await runRound(
      {
        ...base('p-reg', `touch ${JSON.stringify(marker)}; exit 0`),
        verifyMergedItems: async () => verdict({ regressed: ['i1'] }),
      },
      { stateDir },
    );

    expect(fs.existsSync(marker)).toBe(true);
  });

  it('child exits 0 but the shortfall is entirely uncheckable → unverifiable, NOT partially-complete', async () => {
    // `partially-complete` asserts "some of this genuinely did not land". If the
    // only reason an item is missing from `verified` is that the check could not
    // run, that assertion is manufactured.
    // i2 RECORDS a merge commit — that is what makes "could not check" a real
    // gap rather than "did not land". Without the recorded commit the honest
    // reading after a clean exit is partially-complete, which the next test
    // pins.
    await project('p-post', [{ id: 'i1' }, { id: 'i2', mergeCommitOid: 'e'.repeat(40) }]);
    let call = 0;

    const r = await runRound(
      {
        ...base('p-post', 'exit 0'),
        verifyMergedItems: async () => {
          call++;
          // First (pre-spawn) call: both genuinely not landed → spawn.
          // Second (post-exit) call: i1 landed, i2 uncheckable-with-evidence.
          return call === 1
            ? verdict({ regressed: ['i1', 'i2'] })
            : verdict({ verified: ['i1'], unverifiable: [['i2', 'git: could not run']] });
        },
      },
      { stateDir },
    );

    expect(r.outcome).toBe('unverifiable');
    expect(r.mergedItemIds).toEqual(['i1']);
    expect(r.unmergedItemIds).toEqual(['i2']);
    const proj = tracker.get('p-post');
    expect(proj?.rounds?.[0].status ?? 'pending', 'no verdict was reached, so none may be recorded').toBe('pending');
  });

  it('after a clean exit, an item that recorded NO merge commit is genuinely not-landed → partially-complete', async () => {
    // The other side of the same boundary. Without this, "any unverifiable ⇒
    // no verdict" would swallow the ordinary partial result and a round that
    // really did half its work would never be recorded as such.
    await project('p-partial', [{ id: 'i1' }, { id: 'i2' }]);
    let call = 0;

    const r = await runRound(
      {
        ...base('p-partial', 'exit 0'),
        verifyMergedItems: async () => {
          call++;
          return call === 1
            ? verdict({ regressed: ['i1', 'i2'] })
            : verdict({ verified: ['i1'], unverifiable: [['i2', 'no mergeCommitOid recorded on the item']] });
        },
      },
      { stateDir },
    );

    expect(r.outcome).toBe('partially-complete');
    expect(r.mergedItemIds).toEqual(['i1']);
    expect(tracker.get('p-partial')?.rounds?.[0].status).toBe('partially-complete');
  });
});

describe('the seam cannot default to silence again', () => {
  const src = () => fs.readFileSync(SRC, 'utf-8');

  it('has no default verifier that returns an unconditional empty set', () => {
    // The removed shape was a factory returning `async () => new Set<string>()`
    // — a value indistinguishable from a real "nothing is merged" reading.
    const s = src();
    expect(
      /defaultVerifyMergedItems/.test(s),
      'the no-op default verifier must stay deleted; a caller must not be able to forget to pass a real one',
    ).toBe(false);
  });

  it('defaults the seam to the real git-backed verifier', () => {
    const s = src();
    const idx = s.indexOf('input.verifyMergedItems ??');
    expect(idx, 'the seam must have a default').toBeGreaterThan(0);
    const window = s.slice(idx, idx + 400);
    expect(
      /verifyMergedItemsViaGit\(/.test(window),
      'the default must be the real verifier, so production cannot silently run a stub',
    ).toBe(true);
  });

  it('passes a resolved canonical-main ref rather than relying on the origin/main default', () => {
    // On a fork-origin agent home origin/main does not contain the merge commit,
    // so every healthy item would read as regressed and the round would respawn.
    const s = src();
    expect(/resolveCanonicalMainRef\(/.test(s)).toBe(true);
  });

  it('records NO round status for an unverifiable outcome', () => {
    const s = src();
    const idx = s.indexOf('const map: Record<');
    expect(idx).toBeGreaterThan(0);
    const window = s.slice(Math.max(0, idx - 600), idx + 600);
    expect(
      /outcome === 'unverifiable'\)\s*return/.test(window),
      'an unverifiable round must return before writing a status — it has no verdict to record',
    ).toBe(true);
  });
});
