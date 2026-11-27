// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * Unit test — deferral-detector UNOWNED CROSS-BOUNDARY WORK signal
 * (topic 10000002523, 2026-11-10).
 *
 * The founding case: inside an approved "fully complete this work" run, a
 * progress message said "Opening documents from inside the app will need a
 * small button added to the app" and "app work outside this repository,
 * recorded for the app's owner" — a deferral dressed as a scope fact, with no
 * owner, no handoff and no completion-list item. None of the later / follow-up
 * patterns matched it. Renders the shipped hook and spawns it (no mocks).
 * Both sides of the boundary: the bare claim nudges; the same claim with a
 * named route (handed to the owning session, brief sent) passes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let hookPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deferral-unowned-'));
  hookPath = path.join(tmpDir, 'deferral-detector.js');
  const migrator = new PostUpdateMigrator({
    projectDir: tmpDir,
    stateDir: path.join(tmpDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'deferral-test',
  });
  const hook = (migrator as unknown as { getHookContent(n: string): string }).getHookContent('deferral-detector');
  fs.writeFileSync(hookPath, hook, { mode: 0o755 });
});

afterAll(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/deferral-detector-unowned-handoff.test.ts:cleanup' });
});

function run(message: string): string {
  const command = `cat <<'EOF' | .claude/scripts/telegram-reply.sh 141469\n${message}\nEOF`;
  const r = spawnSync('node', [hookPath], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf-8',
    timeout: 5000,
  });
  if (!r.stdout || !r.stdout.trim()) return '';
  const parsed = JSON.parse(r.stdout) as { decision?: string; additionalContext?: string };
  expect(parsed.decision).toBe('approve'); // signal only — never blocks
  return parsed.additionalContext ?? '';
}

describe('deferral-detector — unowned cross-boundary work', () => {
  it('THE FOUNDING CASE: "will need a small button added to the app" nudges', () => {
    const ctx = run('Progress: the viewer works. Opening documents from inside the app will need a small button added to the app.');
    expect(ctx).toContain('UNOWNED CROSS-BOUNDARY WORK DETECTED');
    expect(ctx).toContain('will_need_change_elsewhere');
  });

  it('"outside this repository, recorded for the app\'s owner" nudges', () => {
    const ctx = run('Open questions: app work outside this repository, recorded for the app\'s owner.');
    expect(ctx).toContain('UNOWNED CROSS-BOUNDARY WORK DETECTED');
    expect(ctx).toMatch(/outside_this_repo/);
    expect(ctx).toMatch(/recorded_for_owner/);
  });

  it('"the owner will need to" and "requires a change in the X repo" nudge', () => {
    expect(run('The app owner will need to add the share sheet.')).toContain('owner_will_need_to');
    expect(run('This requires a change in the portal repo.')).toContain('requires_change_elsewhere');
  });

  it('the same claim WITH a named route passes (handed to the owning session)', () => {
    expect(run('The app will need a small button added to the app; I handed it to echo-instar-app on the Studio and the brief went out, checking its commits at 15:00.')).toBe('');
  });

  it('the same claim backed by tracking infrastructure passes', () => {
    expect(run('The app will need a small button added to the app — /commit-action CMT-1500 tracks it.')).toBe('');
  });

  it('a route stated as "pulled the code here" passes', () => {
    expect(run('This requires a change in the app; I pulled the code to my machine and am building it now.')).toBe('');
  });

  it('plain in-repo work talk does not fire', () => {
    expect(run('Tests pass in this repo; the button is added to the viewer page.')).toBe('');
    expect(run('We will need a migration for existing agents, which is in this PR.')).toBe('');
  });

  it('non-message commands are ignored', () => {
    const r = spawnSync('node', [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo "outside this repository, recorded for the owner"' } }),
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(r.stdout.trim()).toBe('');
  });
});
