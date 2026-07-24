import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ensureFeedbackFactoryGeneratedDefaults, inspectFeedbackFactoryGeneratedDefaults } from '../../src/feedback-factory/drain/FeedbackFactoryGeneratedDefaults.js';
import { runFeedbackFactoryDefaultsSelfHeal } from '../../src/feedback-factory/drain/FeedbackFactoryDefaultsSelfHeal.js';

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

  it('classifies malformed JSON as unsafe and refuses overwrite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-defaults-')); dirs.push(dir);
    const target = path.join(dir, 'state', 'generated-feature-defaults.json'); fs.mkdirSync(path.dirname(target)); fs.writeFileSync(target, '{broken');
    expect(inspectFeedbackFactoryGeneratedDefaults(dir, true)).toEqual({ posture: 'unsafe', reason: 'malformed-json' });
    expect(() => ensureFeedbackFactoryGeneratedDefaults(dir, true)).toThrow('refused');
    expect(fs.readFileSync(target, 'utf8')).toBe('{broken');
  });

  it('refuses a symlink destination', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-defaults-')); dirs.push(dir);
    const state = path.join(dir, 'state'); fs.mkdirSync(state); const outside = path.join(dir, 'outside.json'); fs.writeFileSync(outside, 'sentinel');
    fs.symlinkSync(outside, path.join(state, 'generated-feature-defaults.json'));
    expect(inspectFeedbackFactoryGeneratedDefaults(dir, true)).toEqual({ posture: 'unsafe', reason: 'symlink-refused' });
    expect(() => ensureFeedbackFactoryGeneratedDefaults(dir, true)).toThrow('refused');
    expect(fs.readFileSync(outside, 'utf8')).toBe('sentinel');
  });

  it('emits a bounded HIGH notice when the durable store cannot be opened', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-defaults-')); dirs.push(dir);
    const state = path.join(dir, 'state'); fs.mkdirSync(state); fs.writeFileSync(path.join(state, 'self-heal-gate.db'), 'not sqlite');
    const notify = vi.fn();
    const result = await runFeedbackFactoryDefaultsSelfHeal({ stateDir: dir, developmentAgent: true, bootId: 'boot-corrupt', currentFence: () => 'owner:1', notify });
    expect(result).toEqual({ attempted: false, outcome: 'state-failure' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ reason: 'state-failure', priority: 'HIGH' }));
  });
});
