import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture } from '../fixtures/source-grounded-capture.js';

it('real offline command validates exact schemas and fails closed without echoing input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-grounded-'));
  try {
    const file = join(dir, 'capture.json');
    writeFileSync(file, JSON.stringify(capture()));
    const run = () => spawnSync(process.execPath, ['scripts/evaluation/source_grounded_validate.mjs', file], { encoding: 'utf8' });
    const ok = run(); expect(ok.status).toBe(0); expect(ok.stderr).toBe(''); expect(JSON.parse(ok.stdout).judge.state).toBe('structurally-valid');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(capture()))]);
    writeFileSync(file, bom); const withBom = run(); expect(withBom.status).toBe(0); expect(JSON.parse(withBom.stdout).captureRawHash).toBe(createHash('sha256').update(bom).digest('hex'));
    const bad = capture(); bad.answerRaw = 'PRIVATE-MALFORMED-ANSWER'; writeFileSync(file, JSON.stringify(bad));
    const failed = run(); expect(failed.status).toBe(1); expect(JSON.parse(failed.stdout).answer.state).toBe('failed-answer'); expect(failed.stdout).not.toContain('PRIVATE'); expect(failed.stderr).toBe('');
    writeFileSync(file, '{"version":1,"version":2}'); const duplicate = run(); expect(duplicate.status).toBe(2); expect(JSON.parse(duplicate.stdout).error).toBe('duplicate-key');
    const absent = spawnSync(process.execPath, ['scripts/evaluation/source_grounded_validate.mjs', join(dir, 'PRIVATE-MISSING')], { encoding: 'utf8' });
    expect(absent.status).toBe(2); expect(absent.stdout).not.toContain('PRIVATE'); expect(absent.stderr).toBe('');
    if (process.platform !== 'win32') {
      const fifo = join(dir, 'input-fifo'); const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 2000 }); expect(made.status).toBe(0);
      const refused = spawnSync(process.execPath, ['scripts/evaluation/source_grounded_validate.mjs', fifo], { encoding: 'utf8', timeout: 5000 });
      expect(refused.error).toBeUndefined(); expect(refused.status).toBe(2); expect(JSON.parse(refused.stdout).error).toBe('regular-file-required');
    }
    writeFileSync(file, Buffer.from([0xff])); expect(JSON.parse(run().stdout).error).toBe('invalid-utf8');
  } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'source-grounded-validation.test.ts:cleanup' }); }
});
