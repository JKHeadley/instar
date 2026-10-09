import { describe, expect, it } from 'vitest';
import {
  classifyProtectedWait,
  classifyTestRunnerCommand,
  classifyTestRunnerProtection,
  MAX_TEST_RUNNER_PROTECTION_MS,
} from '../../src/monitoring/SessionWatchdog.js';

describe('SessionWatchdog test-runner floor (ACT-069)', () => {
  it.each([
    'npm test',
    'npm t',
    'npm run test',
    'npm run test:integration',
    'npm run-script test:e2e',
    'npm exec vitest run tests/unit/threadline',
    'npm exec -- vitest run',
    'pnpm test',
    'pnpm run test:push',
    'pnpm test:push',
    'pnpm exec vitest run',
    'yarn test',
    'npx vitest run',
    'npx -y vitest run',
    'vitest run',
    '/repo/node_modules/.bin/vitest run',
    'node /repo/node_modules/.bin/vitest run',
    'node /repo/node_modules/vitest/vitest.mjs run --config vitest.push.config.ts',
    'node (vitest)',
    'node (vitest 1)',
    'node (vitest 12)',
  ])('matches the test-runner argv contract: %s', (command) => {
    expect(classifyTestRunnerCommand(command)).toBe('test-runner');
    expect(classifyProtectedWait(command, '', 190_000)).toEqual({ protected: true, reason: 'test-runner' });
  });

  it('protects an ancestor only while a test runner is actually running below it', () => {
    expect(classifyTestRunnerCommand('git push -u origin fix/x')).toBeNull();
    expect(classifyProtectedWait('git push origin HEAD', '', 190_000)).toEqual({ protected: false });
    expect(classifyProtectedWait('git push origin HEAD', '', 190_000, ['sh .husky/pre-push', 'node scripts/pre-push-gate.js']))
      .toEqual({ protected: false });
    expect(classifyProtectedWait('/usr/bin/git push origin HEAD', '', 190_000, ['sh .husky/pre-push', 'node (vitest)']))
      .toEqual({ protected: true, reason: 'test-runner-ancestor' });
    expect(classifyProtectedWait("/bin/zsh -lc cd /repo && npm test", '', 190_000, ['npm test', 'node (vitest)']))
      .toEqual({ protected: true, reason: 'test-runner-ancestor' });
    expect(classifyProtectedWait('/bin/zsh -lc sleep 900', '', 190_000, ['sleep 900'])).toEqual({ protected: false });
  });

  it.each([
    'echo npm test',
    'grep -r vitest src',
    'node worker.mjs --label npm test',
    "node worker.mjs --label 'vitest run'",
    'npm install',
    'npm run build',
    'npm run testing-tool',
    'npm test:push', // npm needs `run` for a named script
    'npm exec tsc',
    'npx tsc --noEmit',
    'node (vitest) extra',
    'python3 poll.py',
    'git pull',
    'sh -c npm test',
  ])('does not match a near-miss: %s', (command) => {
    expect(classifyTestRunnerCommand(command)).toBeNull();
    expect(classifyProtectedWait(command, '', 190_000)).toEqual({ protected: false });
  });

  it('is protected up to and including the bound, and not past it', () => {
    expect(classifyProtectedWait('npm test', '', MAX_TEST_RUNNER_PROTECTION_MS).protected).toBe(true);
    expect(classifyProtectedWait('npm test', '', MAX_TEST_RUNNER_PROTECTION_MS + 1)).toEqual({ protected: false });
    expect(classifyProtectedWait('git push origin x', '', MAX_TEST_RUNNER_PROTECTION_MS, ['node (vitest)']).protected).toBe(true);
    expect(classifyProtectedWait('git push origin x', '', MAX_TEST_RUNNER_PROTECTION_MS + 1, ['node (vitest)'])).toEqual({ protected: false });
  });

  it('past the bound, wait-looking output does not extend a test run to the 2h wait floor', () => {
    expect(classifyProtectedWait('npm test', 'waiting for checks (deadline 1200s)', MAX_TEST_RUNNER_PROTECTION_MS + 1))
      .toEqual({ protected: false });
  });

  it('classifyTestRunnerProtection: null for unrelated work, bounded by the selected process age', () => {
    expect(classifyTestRunnerProtection('python3 poll.py', 190_000, ['sleep 5'])).toBeNull();
    expect(classifyTestRunnerProtection('/bin/zsh -lc setup && npm test', MAX_TEST_RUNNER_PROTECTION_MS + 1, ['npm test']))
      .toEqual({ protected: false });
    expect(classifyTestRunnerProtection('/bin/zsh -lc setup && npm test', 120_000, ['npm test']))
      .toEqual({ protected: true, reason: 'test-runner-ancestor' });
  });

  it('chooses a bound shorter than the 2h external-wait floor and longer than the 30 min hard ceiling', () => {
    expect(MAX_TEST_RUNNER_PROTECTION_MS).toBe(60 * 60 * 1_000);
  });
});
