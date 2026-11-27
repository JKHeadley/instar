import fs from 'node:fs';
import path from 'node:path';
import { localVerifyTempRoot, realSeams, removeScopedTree } from '../../../src/localVerify/orchestratorSeams.js';
import { describe, expect, it } from 'vitest';
import {
  BoundedUnitProcessOutput, UNIT_OUTPUT_PREFIX_BYTES, UNIT_OUTPUT_SUFFIX_BYTES,
} from '../../../src/localVerify/unitProcessOutput.js';

describe('unit diagnostic output', () => {
  it('preserves the complete stream while it fits, including split UTF-8', () => {
    const capture = new BoundedUnitProcessOutput();
    const bytes = Buffer.from('worker: é');
    capture.append(bytes.subarray(0, -1));
    capture.append(bytes.subarray(-1));
    expect(capture.snapshot()).toEqual({ prefix: 'worker: é', suffix: '', omittedBytes: 0 });
  });

  it('preserves the early error and latest output while counting omitted bytes', () => {
    const capture = new BoundedUnitProcessOutput();
    capture.append(Buffer.from('early failure\n'));
    capture.append(Buffer.alloc(UNIT_OUTPUT_PREFIX_BYTES + UNIT_OUTPUT_SUFFIX_BYTES, 'a'));
    capture.append(Buffer.from('finish\n'));
    const output = capture.snapshot();
    expect(output.prefix).toHaveLength(UNIT_OUTPUT_PREFIX_BYTES);
    expect(output.prefix.startsWith('early failure\n')).toBe(true);
    expect(output.suffix).toHaveLength(UNIT_OUTPUT_SUFFIX_BYTES);
    expect(output.suffix.endsWith('finish\n')).toBe(true);
    expect(output.omittedBytes).toBe(Buffer.byteLength('early failure\nfinish\n'));
  });
});

describe('retained unit diagnostics', () => {
  it('keeps reports outside checkouts and rotates old reports independently', async () => {
    const root = fs.mkdtempSync(path.join(localVerifyTempRoot(), 'lv-unit-output-'));
    const verifyRoot = path.join(root, '.worktrees', '.verify');
    try {
      const seams = realSeams(() => {}, verifyRoot);
      const stream = { prefix: 'early error', suffix: '', omittedBytes: 0 };
      const transcripts = [{ step: 'unit', status: 1, signal: null, stdout: stream, stderr: stream }];
      const saved: string[] = [];
      for (let index = 0; index < 9; index++) {
        saved.push(await seams.keepUnitTranscripts!({
          headSha: 'a'.repeat(40), startedAtMs: 1_795_000_000_000 + index, transcripts,
        }));
      }
      expect(saved[8]).toContain(path.join('.verify', 'unit-failure-diagnostics'));
      expect(fs.existsSync(saved[0])).toBe(false);
      expect(fs.readdirSync(path.dirname(saved[8]))).toHaveLength(8);
      expect(JSON.parse(fs.readFileSync(saved[8], 'utf8')).transcripts).toEqual(transcripts);
      if (process.platform !== 'win32') expect(fs.statSync(saved[8]).mode & 0o777).toBe(0o600);
    } finally {
      await removeScopedTree(root, verifyRoot);
    }
  });
});
