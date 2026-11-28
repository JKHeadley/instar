import { execFileSync } from 'node:child_process';
import { it } from 'vitest';

it('pairs and grades the real offline development pack', () => {
  execFileSync('python3', ['-I', 'tests/context-replay/test_context_replay.py', 'IntegrationTests'], {
    cwd: process.cwd(), timeout: 15_000, stdio: 'pipe',
  });
});
