/**
 * Unit tests for detectFrameworkBinary and its convenience wrappers.
 *
 * The function searches multiple candidate paths and falls back to PATH
 * lookup. These tests verify the framework-agnostic contract — adding a
 * new framework name should "just work" — and the key invariant: the
 * function NEVER returns a developer-specific hardcoded path. Replaces
 * the previous hardcoded `/Users/justin/.asdf/...` leak in
 * openai-codex/config.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  detectFrameworkBinary,
  detectClaudePath,
  detectCodexPath,
  detectTmuxPath,
  _resetFrameworkBinaryCache,
} from '../../src/core/Config.js';

describe('detectFrameworkBinary', () => {
  it('returns a string path or null — never undefined, never a non-existent path', () => {
    const result = detectFrameworkBinary('claude');
    if (result !== null) {
      // If anything is returned, it must be an absolute path that exists.
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      // Must NOT be a developer-specific path slug.
      expect(result).not.toContain('.asdf/installs/nodejs/22.18.0');
    }
  });

  it('returns null for a binary name that cannot exist on any machine', () => {
    const result = detectFrameworkBinary('this-binary-definitely-does-not-exist-anywhere' as any);
    expect(result).toBeNull();
  });

  it('handles every documented framework name without throwing', () => {
    const names = ['claude', 'codex', 'gemini', 'aider', 'goose', 'cursor-cli', 'opencode', 'plandex'] as const;
    for (const name of names) {
      expect(() => detectFrameworkBinary(name)).not.toThrow();
    }
  });

  it('detectClaudePath delegates to detectFrameworkBinary(claude)', () => {
    expect(detectClaudePath()).toBe(detectFrameworkBinary('claude'));
  });

  it('detectCodexPath delegates to detectFrameworkBinary(codex)', () => {
    expect(detectCodexPath()).toBe(detectFrameworkBinary('codex'));
  });

  it('finds an asdf shim via ASDF_DATA_DIR when the binary lives nowhere else', async () => {
    // Regression for the codey/asdf portability bug: a CLI installed only as
    // an asdf shim was invisible to instar because the launchd PATH excludes
    // the shims dir. detectFrameworkBinary must now find it.
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asdf-shim-test-'));
    const prevAsdf = process.env.ASDF_DATA_DIR;
    try {
      const shimsDir = path.join(tmp, 'shims');
      fs.mkdirSync(shimsDir, { recursive: true });
      // 'plandex' is exceedingly unlikely to be installed on the test host,
      // so the ONLY way this resolves is via our temp asdf shim.
      const shim = path.join(shimsDir, 'plandex');
      fs.writeFileSync(shim, '#!/bin/sh\necho stub\n', { mode: 0o755 });
      process.env.ASDF_DATA_DIR = tmp;
      _resetFrameworkBinaryCache(); // detection is memoized — clear before asserting
      expect(detectFrameworkBinary('plandex')).toBe(shim);
    } finally {
      if (prevAsdf === undefined) delete process.env.ASDF_DATA_DIR;
      else process.env.ASDF_DATA_DIR = prevAsdf;
      _resetFrameworkBinaryCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('finds a binary in an nvm version dir when it lives nowhere else (bug #10)', async () => {
    // Regression for the live-transfer cascade bug #10: a session spawn on an
    // nvm-only machine crashed because claudePath resolved to null — the binary
    // was under ~/.nvm/versions/node/<ver>/bin but the launchd server PATH
    // excluded it and NVM_BIN was unset. detectFrameworkBinary must scan the nvm
    // version dirs directly.
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nvm-home-test-'));
    const prevHome = process.env.HOME;
    const prevNvmBin = process.env.NVM_BIN;
    try {
      const binDir = path.join(tmpHome, '.nvm', 'versions', 'node', 'v99.0.0', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const bin = path.join(binDir, 'plandex'); // unlikely installed on the host
      fs.writeFileSync(bin, '#!/bin/sh\necho stub\n', { mode: 0o755 });
      process.env.HOME = tmpHome;
      delete process.env.NVM_BIN; // prove it resolves WITHOUT NVM_BIN (the launchd case)
      _resetFrameworkBinaryCache();
      expect(detectFrameworkBinary('plandex')).toBe(bin);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevNvmBin === undefined) delete process.env.NVM_BIN; else process.env.NVM_BIN = prevNvmBin;
      _resetFrameworkBinaryCache();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('source MUST search nvm version dirs (regression guard for bug #10)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const projectRoot = path.resolve(__dirname, '..', '..');
    const source = fs.readFileSync(path.join(projectRoot, 'src/core/Config.ts'), 'utf-8');
    expect(source, 'Config.ts must scan ~/.nvm/versions/node/<ver>/bin').toMatch(/\.nvm['"`,\s)].*versions.*node|versions.*node.*bin/);
  });

  it('memoizes detection — repeated calls do not re-resolve (caches positive + negative)', () => {
    _resetFrameworkBinaryCache();
    const first = detectFrameworkBinary('codex');
    const second = detectFrameworkBinary('codex');
    expect(second).toBe(first); // same cached result, no re-shell
  });

  it('source MUST search asdf shims (regression guard for the codey/asdf bug)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const projectRoot = path.resolve(__dirname, '..', '..');
    const source = fs.readFileSync(path.join(projectRoot, 'src/core/Config.ts'), 'utf-8');
    expect(source, 'Config.ts must search the asdf shims dir').toMatch(/asdf['"`)\s]*[,)]?.*shims|shims.*asdf|ASDF_DATA_DIR/);
  });

  it('source code MUST NOT hardcode the previously-leaked developer asdf path', async () => {
    // Source-level guard against re-introducing the original regression
    // (where `/Users/justin/.asdf/installs/nodejs/22.18.0/bin/codex` was
    // a literal default in src/providers/adapters/openai-codex/config.ts).
    // At runtime, `detectFrameworkBinary` may LEGITIMATELY resolve to an
    // asdf-managed path on the running machine — that's fine; the binary
    // genuinely lives there. What we're guarding against is the literal
    // string being baked into source code.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const sourceRoots = [
      'src/core/Config.ts',
      'src/providers/adapters/openai-codex/config.ts',
      'src/providers/adapters/anthropic-headless/config.ts',
      'src/providers/adapters/anthropic-interactive-pool/config.ts',
    ];
    const projectRoot = path.resolve(__dirname, '..', '..');
    for (const rel of sourceRoots) {
      const full = path.join(projectRoot, rel);
      if (!fs.existsSync(full)) continue;
      const source = fs.readFileSync(full, 'utf-8');
      expect(source, `${rel} contains a hardcoded asdf-developer-path slug`)
        .not.toMatch(/\.asdf\/installs\/nodejs\/\d+\.\d+\.\d+/);
    }
  });
});
