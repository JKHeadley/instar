import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getDefaultJobs, installBuiltinSkills } from '../../src/commands/init.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/followthrough-enrollment-guidance.test.ts:cleanup',
    });
  }
  dirs.length = 0;
});

describe('follow-through enrollment guidance', () => {
  it('teaches fresh agents that commitment creation requires a real enrollment choice', () => {
    const identity = generateClaudeMd('test-project', 'TestAgent', 4042, false);

    expect(identity).toContain('"beaconEnabled":true');
    expect(identity).toContain('"nextUpdateDueAt":"<ISO deadline>"');
    expect(identity).toContain('followThroughOptOutReason');
    expect(identity).toContain('exactly one follow-through choice');
  });

  it('teaches the commit-action skill dueBy-or-reason instead of optional omission', () => {
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'followthrough-skill-'));
    dirs.push(skillsDir);
    installBuiltinSkills(skillsDir, 4042);
    const skill = fs.readFileSync(path.join(skillsDir, 'commit-action', 'SKILL.md'), 'utf8');

    expect(skill).toContain('Choose exactly one follow-through condition');
    expect(skill).toContain('followThroughOptOutReason');
    expect(skill).not.toContain('Set a due date** if applicable');
  });

  it('keeps the commitment-detection job on the accepted action schema', () => {
    const job = getDefaultJobs(4042).find(
      (candidate) => (candidate as { slug?: string }).slug === 'commitment-detection',
    ) as { execute?: { value?: string } } | undefined;
    const prompt = job?.execute?.value ?? '';

    expect(prompt).toContain('EXACTLY ONE follow-through choice');
    expect(prompt).toContain('dueBy');
    expect(prompt).toContain('followThroughOptOutReason');
    expect(prompt).not.toContain('"dueDate"');
  });
});
