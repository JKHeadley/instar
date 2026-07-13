// safe-git-allow: test file — execFileSync('git', ...) builds the fixture
//   mini-repo (init, add, commit). No production code path.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * E2E regression — the REAL 2026-07-12 incident geometry
 * (docs/specs/duplicate-build-guard.md §0 + §4 E2E tier).
 *
 * The incident: a session built ACT-562 (LLM-decision provenance wiring,
 * PR #1460) to completion and only discovered at MERGE time that PR #1458
 * ("LLM-Decision Quality Meter", ACT-1193/1194) had already merged the same
 * substrate. The round-1 correction (spec §0) is load-bearing here: at
 * ACT-562's build-start the census file did NOT exist on base main — it was
 * being CREATED INSIDE #1458's still-open PR. A "wired-on-main" check yields
 * `clear`; the defining feature is PARALLEL IN-FLIGHT BIRTHS.
 *
 * Geometry reproduced from committed fixtures (tests/fixtures/dup-build-incident/):
 *  - a mini-repo whose `main` does NOT contain src/data/provenanceCoverage.ts
 *    (pinned census artifact path);
 *  - an OPEN-PR fixture (#1458) that is ADDING that census file, its diff
 *    carrying the pinned `status: 'wired'` marker format + the census id —
 *    injected via a fixture adapter (no gh, no network);
 *  - a LIVE local-ledger sibling entry sharing the census target under a
 *    DIFFERENT tracking slug (the two-sessions-one-box incident shape).
 *
 * Expected: verdict `likely-duplicate` at BUILD-START, with strong evidence
 * from BOTH concurrency sources and NO main-state corroboration — plus a
 * control run proving the geometry (not ambient noise) is what fires.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
// @ts-expect-error: .mjs script, not typed
import {
  runDuplicateBuildCheck,
  appendLedgerMarker,
  getProcStartToken,
  readStub,
  writeStub,
  recordDisposition,
  CENSUS_FILE,
  AUDIT_REL_PATH,
} from '../../scripts/lib/duplicate-build-check.mjs';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'dup-build-incident');

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

describe('duplicate-build guard — the PR #1458 vs #1460 incident geometry (E2E)', () => {
  let worktree: string; // the ACT-562 builder's checkout
  let agentHome: string;
  let siblingWorktree: string;
  let specPath: string;
  const dirs: string[] = [];

  const openPr = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'open-pr.json'), 'utf-8')).pr;
  const prDiffAdded = fs.readFileSync(path.join(FIXTURES, 'pr-diff-added-lines.txt'), 'utf-8');

  /** The fixture adapter standing in for `gh pr list` (spec §4: no gh/network in tests). */
  const openPrSource = () => ({
    ok: true,
    rawHash: 'fixture-pr-list',
    prs: [{
      number: openPr.number,
      title: openPr.title,
      headRefName: openPr.headRefName,
      body: openPr.body,
      files: openPr.files,
    }],
  });
  const prDiffSource = () => ({ ok: true, addedText: prDiffAdded });

  beforeAll(() => {
    // ── the mini-repo: fixture `main` WITHOUT the census file ──
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-incident-repo-'));
    dirs.push(worktree);
    git(worktree, ['init', '-q']);
    git(worktree, ['config', 'user.email', 'test@example.com']);
    git(worktree, ['config', 'user.name', 'test']);
    fs.mkdirSync(path.join(worktree, 'src', 'data'), { recursive: true });
    fs.mkdirSync(path.join(worktree, 'docs', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({ name: 'instar', version: '0.0.0' }));
    fs.writeFileSync(path.join(worktree, 'src', 'data', 'llmBenchCoverage.ts'), 'export const bench = [];\n');
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-qm', 'base: main WITHOUT the provenance census (round-1 correction)']);
    git(worktree, ['branch', '-M', 'main']);
    // the builder's branch carries the ACT-562 spec
    git(worktree, ['checkout', '-qb', 'echo/act-562-provenance-wiring']);
    specPath = path.join(worktree, 'docs', 'specs', 'llm-decision-provenance-wiring.md');
    fs.copyFileSync(path.join(FIXTURES, 'spec.md'), specPath);

    // ── the agent home + the LIVE sibling ledger entry ──
    agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-incident-home-'));
    dirs.push(agentHome);
    fs.mkdirSync(path.join(agentHome, '.worktrees'), { recursive: true });
    siblingWorktree = fs.mkdtempSync(path.join(agentHome, '.worktrees', 'quality-meter-'));
    appendLedgerMarker(agentHome, {
      id: 'sibling-1458',
      agent: 'echo',
      host: os.hostname(),
      branch: 'codey/decision-quality-meter',
      specSlug: 'llm-decision-quality-meter', // a DIFFERENT tracking id — the incident's defining blindness
      targets: [CENSUS_FILE, 'messaging-tone-gate'],
      startedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      pid: process.pid, // provably live: this very process
      procStartToken: getProcStartToken(process.pid),
      worktreePath: siblingWorktree,
    });
  });

  afterAll(() => {
    for (const d of dirs.splice(0)) {
      try {
        SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/duplicate-build-guard-incident.test.ts:cleanup' });
      } catch { /* ignore */ }
    }
  });

  function runIncidentCheck(extra: Record<string, unknown> = {}) {
    return runDuplicateBuildCheck({
      specPath,
      root: worktree,
      env: {}, // NOT CI — the fixture adapter must actually be consulted
      phase: 'build-start',
      mainRef: 'main',
      agentHome,
      allowedRoots: [path.join(agentHome, '.worktrees')],
      openPrSource,
      prDiffSource,
      noCache: true,
      pid: process.pid,
      procStartToken: getProcStartToken(process.pid),
      ...extra,
    });
  }

  it('fires likely-duplicate at build-start on the incident geometry', () => {
    const r = runIncidentCheck();
    expect(r.verdict).toBe('likely-duplicate');
    expect(r.cause).toBe('concurrency');

    // Source 1: the open PR ADDING the census substrate (file overlap, stage 1)
    const prEvidence = r.evidence.filter((e: any) => e.source === 'open-pr' && e.strength === 'strong');
    expect(prEvidence.some((e: any) => e.prNumber === 1458 && e.detail.includes(CENSUS_FILE))).toBe(true);

    // Stage 2: the PR's DIFF is ADDING the census identity (pinned `wired`
    // marker format lives in the fixture diff) — the identity-level signal
    // file paths alone cannot carry.
    expect(prDiffAdded).toContain("status: 'wired'"); // pinned marker format (§4)
    expect(prEvidence.some((e: any) => /ADDING identity/.test(e.detail) && e.detail.includes('messaging-tone-gate'))).toBe(true);

    // Source 2: the live same-machine sibling under a DIFFERENT tracking id
    const sibling = r.evidence.filter((e: any) => e.source === 'local-sibling' && e.strength === 'strong');
    expect(sibling.length).toBeGreaterThanOrEqual(1);
    expect(sibling[0].detail).toContain('codey/decision-quality-meter');

    // Round-1 correction holds: NO main-state corroboration — the census does
    // NOT exist on the fixture main (a wired-on-main test would say clear).
    expect(r.evidence.filter((e: any) => e.source === 'main-state')).toHaveLength(0);
    expect(r.evidence.filter((e: any) => e.source === 'merged-commit')).toHaveLength(0);
  });

  it('CONTROL: without the in-flight sources the same spec/repo is clear (the geometry fires, not noise)', () => {
    const r = runIncidentCheck({
      openPrSource: () => ({ ok: true, prs: [], rawHash: 'empty-pr-list' }),
      livenessProbe: () => false, // the sibling build has exited
    });
    expect(r.verdict).toBe('clear');
    expect(r.degraded).toBe(false);
  });

  it('the full §3.4 loop closes: verdict → author disposition → trace-foldable stub', () => {
    const r = runIncidentCheck();
    writeStub(worktree, r);
    const refused = recordDisposition(worktree, { decision: 'proceed', reason: 'no ack given' });
    expect(refused.ok).toBe(false); // likely-duplicate proceed needs an acknowledged evidence id

    const evId = r.evidence.find((e: any) => e.source === 'open-pr').id;
    const ok = recordDisposition(worktree, {
      decision: 'proceed',
      reason: 'reviewed: fixture PR #1458 is the same substrate — in the real incident the right call was abandon; proceeding here to exercise the loop',
      acknowledgedEvidenceIds: [evId],
    });
    expect(ok.ok).toBe(true);
    const stub = readStub(worktree);
    expect(stub.disposition.decision).toBe('proceed');
    expect(stub.disposition.acknowledgedEvidenceIds).toContain(evId);

    // §3.5: the audit trail carries verdict + cause + disposition, metadata only
    const audit = fs.readFileSync(path.join(worktree, AUDIT_REL_PATH), 'utf-8').trim().split('\n');
    const last = JSON.parse(audit[audit.length - 1]);
    expect(last.verdict).toBe('likely-duplicate');
    expect(last.disposition.decision).toBe('proceed');
    expect(JSON.stringify(last)).not.toContain(openPr.body.slice(0, 40)); // never untrusted PR body text
  });
});
