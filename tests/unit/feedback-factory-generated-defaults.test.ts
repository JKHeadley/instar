import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ensureFeedbackFactoryGeneratedDefaults } from '../../src/feedback-factory/drain/FeedbackFactoryGeneratedDefaults.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-factory-generated-defaults.test.ts' }); });

describe('Feedback Factory generated defaults self-heal', () => {
  it('writes only the schema and two machine-owned booleans on a development agent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-defaults-')); dirs.push(dir);
    const result = ensureFeedbackFactoryGeneratedDefaults(dir, true);
    expect(result).toMatchObject({ posture: 'repaired', changed: true });
    expect(JSON.parse(fs.readFileSync(result.path, 'utf8'))).toEqual({
      schemaVersion: 1, feedbackFactory: { processing: { enabled: true }, drain: { enabled: true } },
    });
    expect(ensureFeedbackFactoryGeneratedDefaults(dir, true)).toMatchObject({ posture: 'healthy', changed: false, diff: {} });
  });

  it('never writes generated live defaults on fleet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-defaults-')); dirs.push(dir);
    const result = ensureFeedbackFactoryGeneratedDefaults(dir, false);
    expect(result).toMatchObject({ posture: 'fleet-dark', changed: false });
    expect(fs.existsSync(result.path)).toBe(false);
  });
});
