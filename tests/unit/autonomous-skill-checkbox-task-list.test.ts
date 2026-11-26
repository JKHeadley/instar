// safe-git-allow: reads one immutable historical skill blob to prove the marker migration.
// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * The autonomous skill's example task list must use `- [ ]` checkboxes: the
 * server's parseContinuationTasks reads only dash-bullet lines, so a run that
 * copied the old numbered `1. [ ]` example had zero tasks, could never mint a
 * work receipt, and was never admitted. Existing agents get the fixed skill
 * through the CHECKBOX_TASK_LIST marker bump.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { parseContinuationTasks } from '../../src/core/CodexTaskContinuationStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const SKILL_REL = path.join('.claude', 'skills', 'autonomous', 'SKILL.md');
// Last commit before CHECKBOX_TASK_LIST: carries W32_PREPARING_LIVENESS and the numbered example.
const PRIOR_COMMIT = '3f7ef04228b0b7814b8d8b51e9aa1a6c17080491';
const LABEL = 'skills/autonomous/SKILL.md (dash-bullet task checkboxes)';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'autonomous-skill-checkbox-test.cleanup' });
});

function run(projectDir: string): Result {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4040, hasTelegram: false, projectName: 'test' });
  const result: Result = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateAutonomousStopHookTopicKeyed(r: Result): void }).migrateAutonomousStopHookTopicKeyed(result);
  return result;
}

function deploy(content: string): { dir: string; dst: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-checkbox-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  const dst = path.join(dir, SKILL_REL);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, content);
  return { dir, dst };
}

describe('autonomous SKILL.md task-list format', () => {
  const bundled = fs.readFileSync(path.resolve(SKILL_REL), 'utf8');

  it('the bundled example uses dash-bullet checkboxes the server parser reads', () => {
    expect(bundled).not.toMatch(/^\s*\d+\. \[ \]/m);
    const exampleLines = bundled.split('\n').filter(line => /^- \[ \] \(\d\)/.test(line));
    expect(exampleLines).toHaveLength(5);
    expect(parseContinuationTasks(exampleLines.join('\n')).filter(task => task.open)).toHaveLength(5);
    // The old numbered form is invisible to the parser — the bug this fixes.
    expect(parseContinuationTasks('1. [ ] a\n2. [ ] b')).toHaveLength(0);
  });

  it('re-deploys the prior stock skill to existing agents, idempotently', () => {
    const prior = execFileSync('git', ['show', `${PRIOR_COMMIT}:.claude/skills/autonomous/SKILL.md`]).toString();
    expect(prior).toContain('W32_PREPARING_LIVENESS');
    expect(prior).toMatch(/^1\. \[ \]/m);
    const { dir, dst } = deploy(prior);
    const first = run(dir);
    expect(first.errors).toEqual([]);
    expect(first.upgraded).toContain(LABEL);
    const upgraded = fs.readFileSync(dst, 'utf8');
    expect(upgraded).toContain('CHECKBOX_TASK_LIST');
    expect(upgraded).not.toMatch(/^\d+\. \[ \]/m);
    const second = run(dir);
    expect(second.upgraded).not.toContain(LABEL);
    expect(fs.readFileSync(dst, 'utf8')).toBe(upgraded);
  });

  it('leaves a customized skill untouched', () => {
    const custom = '# my own autonomous skill\n1. [ ] custom\n';
    const { dir, dst } = deploy(custom);
    run(dir);
    expect(fs.readFileSync(dst, 'utf8')).toBe(custom);
  });
});
