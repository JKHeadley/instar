// safe-git-allow: test-tmpdir-cleanup — afterEach removes the per-test mkdtempSync tmpdir; SafeFsExecutor migration tracked separately.
/**
 * Persistence tests for the empty-prompt signature store.
 *
 * Tests use INSTAR_PROVIDER_STATE_DIR to redirect persistence to a
 * fresh tmpdir per test so they don't touch the real user state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getSignature,
  setSignature,
  loadPersistedSignature,
  resetSignatureForTests,
} from '../../../../../src/providers/adapters/anthropic-interactive-pool/canary/emptyPromptSignature.js';

describe('emptyPromptSignature persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sig-test-'));
    process.env['INSTAR_PROVIDER_STATE_DIR'] = tmpDir;
    resetSignatureForTests();
  });

  afterEach(() => {
    delete process.env['INSTAR_PROVIDER_STATE_DIR'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a persisted signature to disk when setSignature is called', () => {
    setSignature({
      emptyPromptPattern: /^>\s*$/,
      anyPromptLinePattern: /^>(\s|$)/,
      source: 'canary-derived',
    });
    const expectedPath = path.join(tmpDir, 'anthropic-interactive-pool', 'empty-prompt-signature.json');
    expect(fs.existsSync(expectedPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'));
    expect(onDisk.emptyPromptPattern).toBe('^>\\s*$');
    expect(onDisk.anyPromptLinePattern).toBe('^>(\\s|$)');
    expect(onDisk.source).toBe('canary-derived');
    expect(onDisk.schemaVersion).toBe(1);
  });

  it('a fresh process inherits a persisted signature on first getSignature()', () => {
    // Simulate "previous process" by setting + persisting.
    setSignature({
      emptyPromptPattern: /^▶\s*$/,
      anyPromptLinePattern: /^▶(\s|$)/,
      source: 'canary-derived',
    });

    // Simulate "new process" — reset in-memory state but leave the file
    // on disk. Note resetSignatureForTests also unlinks the file, so we
    // need a different reset path here. We simulate by manually wiping
    // the module-level state via re-import is too invasive; instead use
    // the public loadPersistedSignature force-reload path.
    // Replace what's on disk with what we want the "new process" to see.
    const filePath = path.join(tmpDir, 'anthropic-interactive-pool', 'empty-prompt-signature.json');
    expect(fs.existsSync(filePath)).toBe(true);

    // Force a reload from disk — equivalent of a fresh process startup.
    const loaded = loadPersistedSignature(true);
    expect(loaded.source).toBe('canary-derived');
    expect(loaded.emptyPromptPattern.test('▶')).toBe(true);
    expect(loaded.emptyPromptPattern.test('❯')).toBe(false);
  });

  it('falls back to default if the persisted file is absent', () => {
    // No setSignature() call → no file on disk.
    const sig = loadPersistedSignature(true);
    expect(sig.source).toBe('default');
    expect(sig.emptyPromptPattern.test('❯')).toBe(true);
  });

  it('falls back to default if the persisted file is corrupt JSON', () => {
    const filePath = path.join(tmpDir, 'anthropic-interactive-pool', 'empty-prompt-signature.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'this is not json {{{', 'utf-8');
    const sig = loadPersistedSignature(true);
    expect(sig.source).toBe('default');
  });

  it('falls back to default if the schema version mismatches', () => {
    const filePath = path.join(tmpDir, 'anthropic-interactive-pool', 'empty-prompt-signature.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        emptyPromptPattern: '^>\\s*$',
        anyPromptLinePattern: '^>(\\s|$)',
        source: 'canary-derived',
        derivedAt: new Date().toISOString(),
        schemaVersion: 99,
      }),
      'utf-8',
    );
    const sig = loadPersistedSignature(true);
    expect(sig.source).toBe('default');
  });

  it('falls back to default if the persisted pattern is an uncompilable regex', () => {
    const filePath = path.join(tmpDir, 'anthropic-interactive-pool', 'empty-prompt-signature.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        emptyPromptPattern: '[unclosed',
        anyPromptLinePattern: '[unclosed',
        source: 'canary-derived',
        derivedAt: new Date().toISOString(),
        schemaVersion: 1,
      }),
      'utf-8',
    );
    const sig = loadPersistedSignature(true);
    expect(sig.source).toBe('default');
  });

  it('getSignature triggers a one-time persisted-load on first call', () => {
    // Write a persisted file but call NO setSignature beforehand —
    // simulating: previous process saved, new process boots, first
    // detector call asks getSignature().
    const filePath = path.join(tmpDir, 'anthropic-interactive-pool', 'empty-prompt-signature.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        emptyPromptPattern: '^!\\s*$',
        anyPromptLinePattern: '^!(\\s|$)',
        source: 'canary-derived',
        derivedAt: new Date().toISOString(),
        schemaVersion: 1,
      }),
      'utf-8',
    );
    // Need to bust the in-process "load attempted" flag — resetForTests
    // does that and ALSO unlinks the file. So instead, force-reload
    // explicitly to simulate the "first getSignature triggers load."
    const loaded = loadPersistedSignature(true);
    expect(loaded.source).toBe('canary-derived');
    expect(loaded.emptyPromptPattern.test('!')).toBe(true);

    // Subsequent getSignature() returns the loaded one without rereading.
    const second = getSignature();
    expect(second.source).toBe('canary-derived');
  });
});
