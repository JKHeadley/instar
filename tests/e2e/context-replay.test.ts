import { execFileSync } from 'node:child_process';
import { it } from 'vitest';

it('runs the shipped offline command and refuses attempted effects', () => {
  execFileSync('python3', ['-I', 'tests/context-replay/test_context_replay.py', 'CommandLifecycleTests'], {
    cwd: process.cwd(), timeout: 15_000, stdio: 'pipe',
  });
});
