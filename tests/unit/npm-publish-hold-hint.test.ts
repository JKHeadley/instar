import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const code = 'npm error code E403';
const suspension = 'npm error 403 403 Forbidden - PUT https://registry.npmjs.org/instar - Your account has been temporarily suspended due to a recent security-sensitive action.';
const hint = 'docs/development-releases.md#npm-account-suspension';

it('wires the opt-in hint to the existing troubleshooting guide', () => {
  const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');
  expect(workflow).toContain('run: bash scripts/publish-npm-release.sh');
  expect(workflow).toContain('INSTAR_NPM_PUBLISH_HOLD_HINT: ${{ vars.INSTAR_NPM_PUBLISH_HOLD_HINT }}');
  expect(readFileSync('docs/development-releases.md', 'utf8')).toContain('## npm account suspension');
});

it.each([
  { name: 'disabled by default', enabled: '', output: [code, suspension], status: 1, showHint: false },
  { name: 'observed suspension', enabled: 'true', output: [code, suspension], status: 1, showHint: true },
  { name: 'unrelated forbidden response', enabled: 'true', output: [code, 'npm error 403 access denied'], status: 2, showHint: false },
  { name: 'suspension text without E403', enabled: 'true', output: [suspension], status: 1, showHint: false },
  { name: 'different package', enabled: 'true', output: [code, suspension.replace('/instar ', '/another-package ')], status: 1, showHint: false },
  { name: 'successful publish', enabled: 'true', output: [code, suspension], status: 0, showHint: false },
])('publishes once and preserves npm status for $name', ({ enabled, output, status, showHint }) => {
  const bin = mkdtempSync(join(tmpdir(), 'npm-publish-hold-test-'));
  try {
    const calls = join(bin, 'calls');
    writeFileSync(join(bin, 'npm'), [
      '#!/bin/bash',
      'printf "%s\\n" "$*" >> "$FAKE_NPM_CALLS"',
      'printf "%s\\n" "$FAKE_NPM_OUTPUT" >&2',
      'exit "$FAKE_NPM_STATUS"',
    ].join('\n'), { mode: 0o700 });

    const result = spawnSync('bash', ['scripts/publish-npm-release.sh'], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        PATH: [bin, process.env.PATH].join(delimiter),
        INSTAR_NPM_PUBLISH_HOLD_HINT: enabled,
        FAKE_NPM_CALLS: calls,
        FAKE_NPM_OUTPUT: output.join('\n'),
        FAKE_NPM_STATUS: String(status),
      },
    });

    expect(result.status).toBe(status);
    expect(readFileSync(calls, 'utf8')).toBe('publish --provenance --access public\n');
    expect(result.stdout + result.stderr).toContain(output.join('\n'));
    expect(result.stderr.split(hint)).toHaveLength(showHint ? 2 : 1);
  } finally {
    SafeFsExecutor.safeRmSync(bin, { recursive: true, force: true, operation: 'npm publish hold test cleanup' });
  }
});
