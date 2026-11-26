import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { PasteManager } from '../../src/paste/PasteManager.js';
import { createTempProject } from './setup.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn(),
}));

/** A Claude composer driven by the actual send-keys argv, with virtual paste-commit time. */
export function claudePasteFixture({ commitMs = 0, dropFirstEnter = false, framework = 'claude-code' } = {}) {
  const project = createTempProject();
  const session = { id: 'paste-test', name: 'paste-test', tmuxSession: 'paste-test', status: 'running' as const,
    startedAt: new Date().toISOString(), claudeSessionId: 'fixture-incarnation', model: 'fixture', maxDurationMinutes: 5 };
  project.state.saveSession(session);
  const tmuxPath = path.join(project.dir, 'fixture-tmux');
  const manager = new SessionManager({ projectDir: project.dir, tmuxPath, claudePath: '/usr/bin/false',
    maxSessions: 1, protectedSessions: [], completionPatterns: [] }, project.state);
  const pasteManager = new PasteManager({ pasteDir: path.join(project.stateDir, 'paste'),
    stateDir: project.stateDir, projectDir: project.dir });
  vi.spyOn(manager, 'getCachedRunningSessions').mockReturnValue({ count: 1, sessions: [session] });
  const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => {});
  let draft = '';
  let pastedAt: number | undefined;
  let elapsed = 0;
  const sleeps: number[] = [];
  const submitted: string[] = [];
  const keys: string[] = [];
  vi.mocked(execFileSync).mockImplementation((cmd, args) => {
    if (!Array.isArray(args)) throw new Error('Expected argv');
    if (cmd === '/bin/sleep') {
      const delay = Number(args[0]) * 1000;
      sleeps.push(delay);
      elapsed += delay;
      return '';
    }
    if (cmd !== tmuxPath) throw new Error('Unexpected executable ' + cmd);
    const key = args[args.length - 1];
    switch (args[0]) {
      case 'show-environment': return 'INSTAR_FRAMEWORK=' + framework + '\n';
      case 'has-session': return '';
      case 'capture-pane': return [
        ...submitted.map(text => '❯ ' + text + '\n⏺ Answered.'),
        '────────────────────────', ('❯ ' + draft.replaceAll('\n', '\n  ')).replace(/ +$/gm, ''), '────────────────────────',
      ].join('\n');
      case 'send-keys':
        if (args.includes('-l')) draft += key;
        else if (key === '\x1b[201~') pastedAt = Date.now() + elapsed;
        else if (key === 'Enter' || key === 'C-m') {
          keys.push(key);
          const committed = pastedAt === undefined || Date.now() + elapsed - pastedAt >= commitMs;
          const dropped = dropFirstEnter && keys.length === 1;
          if (draft && committed && !dropped) {
            submitted.push(draft);
            draft = '';
          }
        }
        return '';
      default: throw new Error('Unexpected tmux operation ' + args[0]);
    }
  });
  return { project, manager, session, pasteManager, submitted, keys, sleeps, report,
    cleanup() {
      manager.stopMonitoring();
      // No tmux session was created. Only the private filesystem fixture needs cleanup.
      SafeFsExecutor.safeRmSync(project.dir, { recursive: true, force: true, operation: 'claudePasteFixture.cleanup' });
      vi.restoreAllMocks();
    } };
}
