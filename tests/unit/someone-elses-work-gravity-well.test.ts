// safe-git-allow: reads one immutable historical skill blob to prove the marker migration.
// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * "Someone Else's Work" gravity well (topic 10000002523, 2026-11-10).
 *
 * A deferral dressed as a scope fact ("will need a small button added to the
 * app", "outside this repository, recorded for the app's owner") slipped past
 * every later/follow-up check. This covers the awareness + skill half of the
 * fix and its Migration Parity paths:
 *  - the CLAUDE.md template carries the trap, and patchClaudeMdContent adds it
 *    to an existing legacy CLAUDE.md exactly once (after "Ask Permission");
 *  - the autonomous SKILL lists the shape and the CROSS_BOUNDARY_OWNER marker
 *    chain re-deploys the prior stock skill;
 *  - the unowned-handoff signal adds the B17 sub-clause to the gate prompt only
 *    when it fires (the pinned static template is unchanged), and the
 *    decision-completeness reviewer carries the check.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd, SOMEONE_ELSES_WORK_TRAP, SOMEONE_ELSES_WORK_TRAP_MARKER } from '../../src/scaffold/templates.js';
import { TONE_GATE_PROMPT_TEMPLATE, MessagingToneGate, B17_UNOWNED_HANDOFF_SUBCLAUSE } from '../../src/core/MessagingToneGate.js';
import { detectUnownedHandoff } from '../../src/core/unowned-handoff.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const AUTONOMOUS = path.join(repoRoot, '.claude', 'skills', 'autonomous', 'SKILL.md');
// origin/main before this change: carries FRACTAL_8020_TRIAGE, not CROSS_BOUNDARY_OWNER.
const PRIOR_COMMIT = 'f4caf6c03012e9aa9aaaf47827541a5f2909a02d';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/someone-elses-work-gravity-well.test.ts' }); });

function migrator() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'someone-elses-work-')); dirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4040, hasTelegram: false, projectName: 'test' });
  return { projectDir, m: m as unknown as {
    patchClaudeMdContent(c: string, r: object): { content: string; patched: boolean };
    migrateAutonomousStopHookTopicKeyed(r: object): void;
  } };
}
const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });

describe('CLAUDE.md: the "Someone Else\'s Work" gravity well', () => {
  it('a new agent\'s CLAUDE.md carries it, inside Gravity Wells, once', () => {
    const md = generateClaudeMd('t', 't', 4040, false);
    expect(md.split(SOMEONE_ELSES_WORK_TRAP_MARKER)).toHaveLength(2);
    expect(md).toContain(SOMEONE_ELSES_WORK_TRAP);
    expect(md.indexOf('### Gravity Wells')).toBeLessThan(md.indexOf(SOMEONE_ELSES_WORK_TRAP_MARKER));
    expect(md.indexOf(SOMEONE_ELSES_WORK_TRAP_MARKER)).toBeLessThan(md.indexOf('### Evidence Hierarchy'));
  });

  it('an existing legacy CLAUDE.md gets it after "Ask Permission", idempotently', () => {
    const { m } = migrator();
    const old = '### Gravity Wells\n\n**"Ask Permission" Trap** — ask less.\n\n**"Inherited Claims" Trap** — verify.\n';
    const r1 = result();
    const once = m.patchClaudeMdContent(old, r1).content;
    expect(r1.upgraded).toContain('CLAUDE.md: added the "Someone Else\'s Work" gravity well');
    expect(once.indexOf('"Ask Permission" Trap')).toBeLessThan(once.indexOf(SOMEONE_ELSES_WORK_TRAP_MARKER));
    expect(once.indexOf(SOMEONE_ELSES_WORK_TRAP_MARKER)).toBeLessThan(once.indexOf('"Inherited Claims" Trap'));
    const r2 = result();
    const twice = m.patchClaudeMdContent(once, r2).content;
    expect(twice).toBe(once);
    expect(r2.upgraded).not.toContain('CLAUDE.md: added the "Someone Else\'s Work" gravity well');
  });

  it('a CLAUDE.md without the anchor gets it appended', () => {
    const { m } = migrator();
    const out = m.patchClaudeMdContent('# my agent\n', result()).content;
    expect(out).toContain(SOMEONE_ELSES_WORK_TRAP);
  });
});

describe('autonomous SKILL: the cross-boundary form', () => {
  it('the bundled skill lists the shape and requires a route + completion item', () => {
    const skill = fs.readFileSync(AUTONOMOUS, 'utf8');
    expect(skill).toContain('CROSS_BOUNDARY_OWNER');
    expect(skill).toContain('outside this repository');
    expect(skill).toMatch(/A place on your completion bar/);
  });

  it('re-deploys the prior stock autonomous skill, idempotently', () => {
    const prior = execFileSync('git', ['show', `${PRIOR_COMMIT}:.claude/skills/autonomous/SKILL.md`], { cwd: repoRoot }).toString();
    expect(prior).toContain('FRACTAL_8020_TRIAGE');
    expect(prior).not.toContain('CROSS_BOUNDARY_OWNER');
    const { projectDir, m } = migrator();
    const dst = path.join(projectDir, '.claude', 'skills', 'autonomous', 'SKILL.md');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, prior);
    const label = 'skills/autonomous/SKILL.md (cross-boundary work needs an owner and a completion item)';
    const first = result(); m.migrateAutonomousStopHookTopicKeyed(first);
    expect(first.errors).toEqual([]);
    expect(first.upgraded).toContain(label);
    expect(fs.readFileSync(dst, 'utf8')).toBe(fs.readFileSync(AUTONOMOUS, 'utf8'));
    const second = result(); m.migrateAutonomousStopHookTopicKeyed(second);
    expect(second.upgraded).not.toContain(label);
  });
});

const FOUNDING = 'Progress: the viewer works. Opening documents from inside the app will need a small button added to the app. Open questions: app work outside this repository, recorded for the app\'s owner.';

function capture() {
  let last = '';
  const provider: IntelligenceProvider = {
    evaluate: vi.fn(async (prompt: string) => { last = prompt; return JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' }); }),
  };
  return { provider, prompt: () => last };
}

describe('unowned-handoff detector (signal only)', () => {
  it('flags the founding sentences', () => {
    expect(detectUnownedHandoff('Opening documents will need a small button added to the app.').flagged).toBe(true);
    expect(detectUnownedHandoff('app work outside this repository, recorded for the app\u2019s owner').flagged).toBe(true);
    expect(detectUnownedHandoff('The app owner will need to add the share sheet.').flagged).toBe(true);
    expect(detectUnownedHandoff('This requires a change in the portal repo.').flagged).toBe(true);
  });
  it('stays quiet on in-repo work talk and bad input', () => {
    expect(detectUnownedHandoff('Tests pass; the button is added to the viewer page.').flagged).toBe(false);
    expect(detectUnownedHandoff('').flagged).toBe(false);
    expect(detectUnownedHandoff(undefined as unknown as string).flagged).toBe(false);
  });
});

describe('MessagingToneGate — B17 UNOWNED-HANDOFF sub-clause (signal-gated)', () => {
  it('the pinned static template is unchanged: it does not carry the sub-clause', () => {
    expect(TONE_GATE_PROMPT_TEMPLATE).not.toContain('UNOWNED-HANDOFF');
  });

  it('the sub-clause has both sides of the boundary and the under-fire bias', () => {
    expect(B17_UNOWNED_HANDOFF_SUBCLAUSE).toContain('cite B17_FALSE_BLOCKER when it fires');
    expect(B17_UNOWNED_HANDOFF_SUBCLAUSE).toContain('will need a small button added to the app');
    expect(B17_UNOWNED_HANDOFF_SUBCLAUSE).toMatch(/PASS \(do not fire\) when: a route is named/);
    expect(B17_UNOWNED_HANDOFF_SUBCLAUSE).toContain('you will need to sign in to the app first');
    expect(B17_UNOWNED_HANDOFF_SUBCLAUSE).toContain('when unsure whether the outside work is needed for the goal or whether a route is named, do NOT fire');
  });

  it('the prompt carries the sub-clause and the signal line when the signal fired', async () => {
    const { provider, prompt } = capture();
    await new MessagingToneGate(provider).review(FOUNDING, {
      channel: 'telegram',
      signals: { unownedHandoff: { flagged: true, phrase: 'will need a small button added to the app' } },
    });
    expect(prompt()).toContain(B17_UNOWNED_HANDOFF_SUBCLAUSE);
    expect(prompt()).toContain('unowned-handoff detector (signal-only');
  });

  it('without the signal the prompt has no sub-clause (byte-identical path)', async () => {
    const { provider, prompt } = capture();
    await new MessagingToneGate(provider).review(FOUNDING, { channel: 'telegram' });
    expect(prompt()).not.toContain('UNOWNED-HANDOFF');
  });
});

describe('spec review carries the check', () => {
  it('the decision-completeness reviewer treats an unrouted cross-boundary claim as a DESIGN finding', () => {
    const t = fs.readFileSync(path.join(repoRoot, 'skills', 'spec-converge', 'templates', 'reviewer-decision-completeness.md'), 'utf8');
    expect(t).toContain('CROSS_BOUNDARY_OWNER');
    expect(t).toMatch(/Cross-boundary work with no route/);
    expect(t).toMatch(/DESIGN finding that blocks convergence/);
  });
});
