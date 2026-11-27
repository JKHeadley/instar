import { execFileSync } from 'node:child_process';
import { it } from 'vitest';

it('validates and confines offline replay actions', () => {
  execFileSync('python3', ['-I', 'tests/context-replay/test_context_replay.py', 'UnitTests'], {
    cwd: process.cwd(), timeout: 15_000, stdio: 'pipe',
  });
});
