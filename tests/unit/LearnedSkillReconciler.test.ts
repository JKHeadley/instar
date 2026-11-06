/**
 * LearnedSkillReconciler — Tier 1 (Testing Integrity Standard).
 *
 * Spec: docs/specs/skill-learning-sentinel.md §3.2 (the "Renderings" row),
 * decisions 19 and 28. A tmp agent home holds a LEARNED canonical (frontmatter
 * `metadata.instar-learned-origin`) and a hand-written one; the reconciler
 * renders the learned skill into `.claude/skills` and `.agents/skills`, keeps a
 * per-machine baseline shard, locks on operator edits, journals every
 * transition, and performs zero writes on a steady-state tick.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LearnedSkillReconciler, isLearnedCanonical } from '../../src/monitoring/LearnedSkillReconciler.js';
import { skillParityRule } from '../../src/providers/parity/rules/skillParityRule.js';

const MACHINE = 'm_test_alpha';

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

function learnedSkillMd(body: string, name = 'ci-health-report'): string {
  return [
    '---',
    `name: ${name}`,
    'description: "Use when the operator asks for the weekly CI health of the repo."',
    'metadata:',
    '  short-description: "CI health, weekly"',
    '  instar-learned-origin: "skill-learning-sentinel"',
    `  instar-learned-key: "${name}"`,
    '---',
    body,
  ].join('\n');
}

function handWrittenSkillMd(body: string, name = 'hand-made'): string {
  return ['---', `name: ${name}`, 'description: "A skill a person wrote."', '---', body].join('\n');
}

interface Home {
  projectDir: string;
  stateDir: string;
  canonical(name: string): string;
  claudeRendering(name: string): string;
  agentsRendering(name: string): string;
  shardPath: string;
  journalPath: string;
}

function makeHome(): Home {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsr-'));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    projectDir,
    stateDir,
    canonical: (name) => path.join(projectDir, '.instar/skills', name, 'SKILL.md'),
    claudeRendering: (name) => path.join(projectDir, '.claude/skills', name, 'SKILL.md'),
    agentsRendering: (name) => path.join(projectDir, '.agents/skills', name, 'SKILL.md'),
    shardPath: path.join(stateDir, 'skill-learning/rendered-baselines', `${MACHINE}.json`),
    journalPath: path.join(stateDir, 'skill-learning/journal', `${MACHINE}.jsonl`),
  };
}

function writeCanonical(h: Home, name: string, content: string): void {
  fs.mkdirSync(path.dirname(h.canonical(name)), { recursive: true });
  fs.writeFileSync(h.canonical(name), content);
}

function makeReconciler(h: Home, opts: { enabled?: boolean; frameworks?: Array<'claude-code' | 'codex-cli' | 'gemini-cli'> } = {}): LearnedSkillReconciler {
  return new LearnedSkillReconciler({
    projectDir: h.projectDir,
    stateDir: h.stateDir,
    machineId: MACHINE,
    enabledFrameworks: () => opts.frameworks ?? ['claude-code', 'codex-cli'],
    reconcileEnabled: () => opts.enabled ?? true,
    tickMinutes: 10,
  });
}

function readShard(h: Home): { baselines: Record<string, { contentHash: string; bodyHash: string }>; conflicts: Record<string, { reason: string }>; failed: Record<string, { bodyHash: string }> } {
  return JSON.parse(fs.readFileSync(h.shardPath, 'utf-8'));
}

function journalOps(h: Home): string[] {
  if (!fs.existsSync(h.journalPath)) return [];
  return fs.readFileSync(h.journalPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l).op as string);
}

describe('LearnedSkillReconciler', () => {
  let h: Home;
  beforeEach(() => { h = makeHome(); });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(h.projectDir, { recursive: true, force: true, operation: 'tests/unit/LearnedSkillReconciler.test.ts' });
  });

  it('isLearnedCanonical keys on metadata.instar-learned-origin only', () => {
    expect(isLearnedCanonical(learnedSkillMd('# body'))).toBe(true);
    expect(isLearnedCanonical(handWrittenSkillMd('# body'))).toBe(false);
    expect(isLearnedCanonical('no frontmatter at all')).toBe(false);
  });

  it('is inert (no-op, no error, nothing created) when .instar/skills/ does not exist', async () => {
    const r = makeReconciler(h);
    const run = await r.reconcileAll('boot');
    expect(run.inert).toBe('no-canonical-dir');
    expect(run.rendered).toBe(0);
    expect(fs.existsSync(path.join(h.projectDir, '.claude/skills'))).toBe(false);
    expect(fs.existsSync(h.shardPath)).toBe(false);
    expect(fs.existsSync(h.journalPath)).toBe(false);
  });

  it('honors the live kill switch (monitoring.skillLearning.reconcile.enabled === false)', async () => {
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v1'));
    const r = makeReconciler(h, { enabled: false });
    const run = await r.reconcileAll('tick');
    expect(run.inert).toBe('disabled');
    expect(fs.existsSync(h.claudeRendering('ci-health-report'))).toBe(false);
  });

  it('renders a learned canonical into both layouts, records a baseline + a prepare→commit journal, and leaves a hand-written canonical alone', async () => {
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v1'));
    writeCanonical(h, 'hand-made', handWrittenSkillMd('# mine'));
    const r = makeReconciler(h);
    const run = await r.reconcileAll('boot');
    expect(run.learned).toBe(1);
    expect(run.rendered).toBe(2); // claude + agents layouts
    expect(run.conflicts).toBe(0);
    expect(fs.existsSync(h.claudeRendering('ci-health-report'))).toBe(true);
    expect(fs.existsSync(h.agentsRendering('ci-health-report'))).toBe(true);
    expect(fs.readFileSync(h.claudeRendering('ci-health-report'), 'utf-8')).toContain(`x-instar-stamp: ${sha256('# v1')}`);
    // Hand-written canonical: never rendered by this reconciler.
    expect(fs.existsSync(h.claudeRendering('hand-made'))).toBe(false);
    expect(fs.existsSync(h.agentsRendering('hand-made'))).toBe(false);
    const shard = readShard(h);
    expect(Object.keys(shard.baselines).sort()).toEqual([
      '.agents/skills/ci-health-report/SKILL.md',
      '.claude/skills/ci-health-report/SKILL.md',
    ]);
    expect(shard.baselines['.claude/skills/ci-health-report/SKILL.md'].contentHash)
      .toBe(sha256(fs.readFileSync(h.claudeRendering('ci-health-report'), 'utf-8')));
    const ops = journalOps(h);
    expect(ops.filter((o) => o === 'render-prepare')).toHaveLength(2);
    expect(ops.filter((o) => o === 'render-commit')).toHaveLength(2);
    expect(ops.indexOf('render-prepare')).toBeLessThan(ops.indexOf('render-commit'));
    expect(r.status().lastRun?.reason).toBe('boot');
  });

  it('steady-state tick: renders nothing and writes nothing (renderings, shard, journal all untouched)', async () => {
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v1'));
    const r = makeReconciler(h);
    await r.reconcileAll('boot');
    const before = {
      claude: fs.readFileSync(h.claudeRendering('ci-health-report'), 'utf-8'),
      shard: fs.readFileSync(h.shardPath, 'utf-8'),
      journal: fs.readFileSync(h.journalPath, 'utf-8'),
      claudeMtime: fs.statSync(h.claudeRendering('ci-health-report')).mtimeMs,
    };
    const run = await r.reconcileAll('tick');
    expect(run.rendered).toBe(0);
    expect(run.skipped).toBe(2);
    expect(run.conflicts).toBe(0);
    expect(fs.readFileSync(h.claudeRendering('ci-health-report'), 'utf-8')).toBe(before.claude);
    expect(fs.statSync(h.claudeRendering('ci-health-report')).mtimeMs).toBe(before.claudeMtime);
    expect(fs.readFileSync(h.shardPath, 'utf-8')).toBe(before.shard);
    expect(fs.readFileSync(h.journalPath, 'utf-8')).toBe(before.journal);
  });

  it('a changed canonical re-renders (new stamp, new baseline)', async () => {
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v1'));
    const r = makeReconciler(h);
    await r.reconcileAll('boot');
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v2 — pulled from another machine'));
    const run = await r.reconcileAll('pull');
    expect(run.rendered).toBe(2);
    expect(run.conflicts).toBe(0);
    const rendered = fs.readFileSync(h.claudeRendering('ci-health-report'), 'utf-8');
    expect(rendered).toContain('# v2 — pulled from another machine');
    expect(rendered).toContain(`x-instar-stamp: ${sha256('# v2 — pulled from another machine')}`);
    expect(readShard(h).baselines['.claude/skills/ci-health-report/SKILL.md'].bodyHash).toBe(sha256('# v2 — pulled from another machine'));
  });

  it('an operator-edited rendering WITH a baseline → user-edit-conflict, locked, never overwritten — even after a later canonical change', async () => {
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v1'));
    const r = makeReconciler(h);
    await r.reconcileAll('boot');
    const edited = fs.readFileSync(h.claudeRendering('ci-health-report'), 'utf-8') + '\n## Operator note: do this my way\n';
    fs.writeFileSync(h.claudeRendering('ci-health-report'), edited);

    const run1 = await r.reconcileAll('tick');
    expect(run1.conflicts).toBe(1);
    expect(run1.rendered).toBe(0);
    expect(fs.readFileSync(h.claudeRendering('ci-health-report'), 'utf-8')).toBe(edited);
    expect(readShard(h).conflicts['.claude/skills/ci-health-report/SKILL.md'].reason).toBe('user-edit-conflict');
    expect(r.status().lockedConflicts.map((c) => c.skill)).toEqual(['ci-health-report']);

    // A remote canonical update makes the stamp STALE — the concept spec's
    // stamp alone would now read the file as overwritable. The baseline says no.
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v2'));
    const run2 = await r.reconcileAll('pull');
    expect(fs.readFileSync(h.claudeRendering('ci-health-report'), 'utf-8')).toBe(edited);
    expect(run2.conflicts).toBe(1);
    // The untouched .agents layout still follows canonical.
    expect(run2.rendered).toBe(1);
    expect(fs.readFileSync(h.agentsRendering('ci-health-report'), 'utf-8')).toContain('# v2');
  });

  it('no baseline + stale stamp → conflict, never rendered (the cache-loss / first-boot case)', async () => {
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v2'));
    // A rendering from an earlier canonical (stale stamp), with no shard at all.
    const stale = ['---', 'name: ci-health-report', 'description: "old"', `x-instar-stamp: ${sha256('# v1')}`, '---', '# v1 with a local tweak'].join('\n');
    fs.mkdirSync(path.dirname(h.claudeRendering('ci-health-report')), { recursive: true });
    fs.writeFileSync(h.claudeRendering('ci-health-report'), stale);
    const r = makeReconciler(h, { frameworks: ['claude-code'] });
    const run = await r.reconcileAll('boot');
    expect(run.rendered).toBe(0);
    expect(run.conflicts).toBe(1);
    expect(fs.readFileSync(h.claudeRendering('ci-health-report'), 'utf-8')).toBe(stale);
    expect(readShard(h).conflicts['.claude/skills/ci-health-report/SKILL.md'].reason).toBe('unknown-provenance');
    expect(journalOps(h)).not.toContain('render-prepare');
  });

  it('cache/baseline deletion, then a remote canonical update with a local edit → locked, never rendered', async () => {
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v1'));
    const r = makeReconciler(h, { frameworks: ['claude-code'] });
    await r.reconcileAll('boot');
    const edited = fs.readFileSync(h.claudeRendering('ci-health-report'), 'utf-8') + '\nlocal edit\n';
    fs.writeFileSync(h.claudeRendering('ci-health-report'), edited);
    SafeFsExecutor.safeRmSync(h.shardPath, { force: true, operation: 'tests/unit/LearnedSkillReconciler.test.ts:cache-gone' }); // the cache is gone
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v2'));
    const fresh = makeReconciler(h, { frameworks: ['claude-code'] });
    const run = await fresh.reconcileAll('boot');
    expect(run.rendered).toBe(0);
    expect(run.conflicts).toBe(1);
    expect(fs.readFileSync(h.claudeRendering('ci-health-report'), 'utf-8')).toBe(edited);
  });

  it('a crash between render and baseline (dangling render-prepare) is recovered from the journal, never read as an edit', async () => {
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v1'));
    const r = makeReconciler(h, { frameworks: ['claude-code'] });
    await r.reconcileAll('boot');
    // Simulate: canonical moved to v2, the reconciler journaled a prepare and
    // rendered v2, then died before the baseline/commit were written.
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v2'));
    const rel = '.claude/skills/ci-health-report/SKILL.md';
    fs.appendFileSync(h.journalPath, JSON.stringify({
      ts: new Date().toISOString(), machineId: MACHINE, op: 'render-prepare', txId: 'deadbeef',
      skill: 'ci-health-report', target: 'claude-code', renderingPath: rel, bodyHash: sha256('# v2'),
      prevContentHash: readShard(h).baselines[rel].contentHash,
    }) + '\n');
    await skillParityRule.remediate(h.projectDir, 'ci-health-report', 'claude-code');
    // The shard still carries the v1 baseline: without recovery the v2 file
    // would read as an operator edit.
    expect(readShard(h).baselines[rel].bodyHash).toBe(sha256('# v1'));

    const fresh = makeReconciler(h, { frameworks: ['claude-code'] });
    const run = await fresh.reconcileAll('boot');
    expect(run.conflicts).toBe(0);
    expect(run.rendered).toBe(0); // already in sync after recovery
    const shard = readShard(h);
    expect(shard.baselines[rel].bodyHash).toBe(sha256('# v2'));
    expect(shard.conflicts[rel]).toBeUndefined();
    const ops = journalOps(h);
    expect(ops[ops.length - 1]).toBe('render-commit');
    // And a later canonical change still renders normally (not locked).
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v3'));
    const run2 = await fresh.reconcileAll('tick');
    expect(run2.rendered).toBe(1);
    expect(fs.readFileSync(h.claudeRendering('ci-health-report'), 'utf-8')).toContain('# v3');
  });

  it('a dangling prepare whose render never landed is voided, and the old rendering is still judged normally', async () => {
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v1'));
    const r = makeReconciler(h, { frameworks: ['claude-code'] });
    await r.reconcileAll('boot');
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v2'));
    fs.appendFileSync(h.journalPath, JSON.stringify({
      ts: new Date().toISOString(), machineId: MACHINE, op: 'render-prepare', txId: 'cafef00d',
      skill: 'ci-health-report', target: 'claude-code', renderingPath: '.claude/skills/ci-health-report/SKILL.md', bodyHash: sha256('# v2'),
    }) + '\n');
    const fresh = makeReconciler(h, { frameworks: ['claude-code'] });
    const run = await fresh.reconcileAll('boot');
    expect(journalOps(h)).toContain('render-void');
    expect(run.conflicts).toBe(0);
    expect(run.rendered).toBe(1);
    expect(fs.readFileSync(h.claudeRendering('ci-health-report'), 'utf-8')).toContain('# v2');
  });

  it('a corrupt baseline shard is treated as missing (no throw; unknown provenance locks a drifted rendering)', async () => {
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v1'));
    const r = makeReconciler(h, { frameworks: ['claude-code'] });
    await r.reconcileAll('boot');
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v2'));
    fs.writeFileSync(h.shardPath, '{ this is not json');
    const run = await makeReconciler(h, { frameworks: ['claude-code'] }).reconcileAll('boot');
    expect(run.errors).toBe(0);
    expect(run.conflicts).toBe(1);
    expect(run.rendered).toBe(0);
  });

  it('a render failure is caught, counted, locked under the canonical hash, and retried only when the canonical changes', async () => {
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v1'));
    // Make the claude rendering dir unwritable: a FILE where the skill dir goes.
    fs.mkdirSync(path.join(h.projectDir, '.claude/skills'), { recursive: true });
    fs.writeFileSync(path.join(h.projectDir, '.claude/skills/ci-health-report'), 'not a directory');
    const r = makeReconciler(h, { frameworks: ['claude-code'] });
    const run1 = await r.reconcileAll('boot');
    expect(run1.failed).toBe(1);
    expect(run1.errors).toBe(0);
    expect(journalOps(h).filter((o) => o === 'render-prepare')).toHaveLength(1);
    expect(readShard(h).failed['.claude/skills/ci-health-report/SKILL.md'].bodyHash).toBe(sha256('# v1'));
    const run2 = await r.reconcileAll('tick');
    expect(run2.failed).toBe(1);
    expect(journalOps(h).filter((o) => o === 'render-prepare')).toHaveLength(1); // not retried
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v2'));
    await r.reconcileAll('tick');
    expect(journalOps(h).filter((o) => o === 'render-prepare')).toHaveLength(2); // re-armed by the change
  });

  it('renders only the layouts of enabled frameworks (claude-code only → no .agents rendering)', async () => {
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v1'));
    const run = await makeReconciler(h, { frameworks: ['claude-code'] }).reconcileAll('boot');
    expect(run.rendered).toBe(1);
    expect(fs.existsSync(h.agentsRendering('ci-health-report'))).toBe(false);
  });

  it('never calls removeOrphans (an orphan rendering with no canonical survives every reconcile)', async () => {
    writeCanonical(h, 'ci-health-report', learnedSkillMd('# v1'));
    const orphan = path.join(h.projectDir, '.claude/skills/retired-thing/SKILL.md');
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, '---\nname: retired-thing\ndescription: "x"\n---\nkeep me');
    const r = makeReconciler(h);
    await r.reconcileAll('boot');
    await r.reconcileAll('tick');
    expect(fs.existsSync(orphan)).toBe(true);
  });

  it('start()/stop() install and clear the tick timer; status() reports the cadence', () => {
    const r = makeReconciler(h);
    expect(r.status().tickMinutes).toBe(10);
    r.start();
    r.stop();
    expect(r.status().running).toBe(false);
  });
});
