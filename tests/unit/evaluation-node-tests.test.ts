import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The evaluation scripts keep their tests beside them as node:test files,
// which the vitest include list never picks up. Run each one here so CI and
// Local Verify fail when one of them fails.
const dir = path.resolve(__dirname, '../../scripts/evaluation');
const files = readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).sort();

describe('evaluation node:test files', () => {
  it('finds the evaluation test files', () => {
    expect(files).toContain('source_grounded_host.test.mjs');
  });

  for (const file of files) {
    it(`passes ${file}`, () => {
      const result = spawnSync(process.execPath, ['--test', path.join(dir, file)], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      });
      expect(result.error).toBeUndefined();
      expect({ status: result.status, tail: result.status === 0 ? '' : (result.stdout + result.stderr).slice(-2000) })
        .toEqual({ status: 0, tail: '' });
    }, 130_000);
  }
});
