/**
 * Unit tests — TopicFrameworksStore.
 *
 * Covers atomic persistence, the two-layer override+default merge,
 * tolerance of corrupt state files (don't crash boot), and the clear/
 * snapshot helpers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicFrameworksStore, SUPPORTED_FRAMEWORKS } from '../../src/core/TopicFrameworksStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let stateFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-frameworks-store-'));
  stateFile = path.join(tmpDir, 'state', 'topic-frameworks.json');
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/TopicFrameworksStore.test.ts:afterEach',
  });
});

describe('TopicFrameworksStore', () => {
  it('returns null when no override or default is set', () => {
    const store = new TopicFrameworksStore({ stateFilePath: stateFile });
    expect(store.get(9984)).toBeNull();
  });

  it('returns the config default when no override is set', () => {
    const store = new TopicFrameworksStore({
      stateFilePath: stateFile,
      configDefaults: { '9984': 'codex-cli' },
    });
    expect(store.get(9984)).toBe('codex-cli');
    expect(store.get('9984')).toBe('codex-cli');
  });

  it('an override wins over the config default', () => {
    const store = new TopicFrameworksStore({
      stateFilePath: stateFile,
      configDefaults: { '9984': 'codex-cli' },
    });
    store.set(9984, 'claude-code');
    expect(store.get(9984)).toBe('claude-code');
  });

  it('persists writes atomically — a fresh store reads the override back', () => {
    const writer = new TopicFrameworksStore({ stateFilePath: stateFile });
    writer.set(9985, 'codex-cli');
    expect(fs.existsSync(stateFile)).toBe(true);

    const reader = new TopicFrameworksStore({ stateFilePath: stateFile });
    expect(reader.get(9985)).toBe('codex-cli');
  });

  it('clear() removes an override and falls back to the default', () => {
    const store = new TopicFrameworksStore({
      stateFilePath: stateFile,
      configDefaults: { '9984': 'codex-cli' },
    });
    store.set(9984, 'claude-code');
    expect(store.get(9984)).toBe('claude-code');
    store.clear(9984);
    expect(store.get(9984)).toBe('codex-cli');
  });

  it('snapshot merges defaults + overrides, with overrides winning', () => {
    const store = new TopicFrameworksStore({
      stateFilePath: stateFile,
      configDefaults: { '9984': 'claude-code', '9985': 'codex-cli' },
    });
    store.set(9985, 'claude-code');
    store.set(9986, 'codex-cli');
    expect(store.snapshot()).toEqual({
      '9984': 'claude-code', // from defaults
      '9985': 'claude-code', // overridden
      '9986': 'codex-cli',   // new override
    });
  });

  it('tolerates a corrupt state file at load time — does not crash, just logs', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{not valid json}');
    // Should not throw.
    const store = new TopicFrameworksStore({
      stateFilePath: stateFile,
      configDefaults: { '9984': 'codex-cli' },
    });
    // Config defaults still apply.
    expect(store.get(9984)).toBe('codex-cli');
    // Overrides empty — corrupt content was silently dropped.
    expect(store.get(9985)).toBeNull();
  });

  it('silently drops unsupported framework values from a hostile state file', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        topics: { '1': 'claude-code', '2': 'evil-framework', '3': 'codex-cli' },
      }),
    );
    const store = new TopicFrameworksStore({ stateFilePath: stateFile });
    expect(store.get(1)).toBe('claude-code');
    expect(store.get(2)).toBeNull(); // dropped
    expect(store.get(3)).toBe('codex-cli');
  });

  it('SUPPORTED_FRAMEWORKS exposes all supported values', () => {
    expect([...SUPPORTED_FRAMEWORKS].sort()).toEqual(['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli']);
  });
});
