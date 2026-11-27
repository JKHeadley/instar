// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * CMT-2289 — an installed-but-signed-out framework is not active for automatic
 * internal routing, so the `gate` category never lands on it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { geminiOauthCredsAuthed, hasUsableInternalLogin } from '../../src/core/frameworkLoginPresence.js';
import {
  INTERNAL_FRAMEWORK_PREFERENCE,
  resolveInternalFrameworkDefault,
  selectActiveInternalFrameworks,
} from '../../src/core/internalFrameworkDefault.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
function credsFile(content: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-creds-'));
  dirs.push(dir);
  const p = path.join(dir, 'oauth_creds.json');
  if (content !== null) fs.writeFileSync(p, content);
  return p;
}
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/frameworkLoginPresence.test.ts' }); });

describe('geminiOauthCredsAuthed', () => {
  it('true with a refresh_token or access_token', () => {
    expect(geminiOauthCredsAuthed(credsFile(JSON.stringify({ refresh_token: 'r' })))).toBe(true);
    expect(geminiOauthCredsAuthed(credsFile(JSON.stringify({ access_token: 'a' })))).toBe(true);
  });
  it('false when missing, empty, malformed or token-less', () => {
    expect(geminiOauthCredsAuthed(credsFile(null))).toBe(false);
    expect(geminiOauthCredsAuthed(credsFile(''))).toBe(false);
    expect(geminiOauthCredsAuthed(credsFile('{not json'))).toBe(false);
    expect(geminiOauthCredsAuthed(credsFile(JSON.stringify({ access_token: '', refresh_token: '' })))).toBe(false);
  });
});

describe('hasUsableInternalLogin', () => {
  it('probes gemini-cli only', () => {
    expect(hasUsableInternalLogin('gemini-cli', { geminiAuthed: () => false })).toBe(false);
    expect(hasUsableInternalLogin('gemini-cli', { geminiAuthed: () => true })).toBe(true);
    for (const fw of ['claude-code', 'codex-cli', 'pi-cli'] as IntelligenceFramework[]) {
      expect(hasUsableInternalLogin(fw, { geminiAuthed: () => false })).toBe(true);
    }
  });
  it('deny-safe when the gemini probe throws', () => {
    expect(hasUsableInternalLogin('gemini-cli', { geminiAuthed: () => { throw new Error('x'); } })).toBe(false);
  });
});

describe('selectActiveInternalFrameworks (the server active-set filter)', () => {
  const builds = (installed: IntelligenceFramework[]) => (fw: IntelligenceFramework) => (installed.includes(fw) ? {} : null);

  it("Bob's shape: gemini installed but signed out → gemini is NOT active, gate goes to codex", () => {
    const active = selectActiveInternalFrameworks(
      INTERNAL_FRAMEWORK_PREFERENCE, 'claude-code',
      builds(['codex-cli', 'gemini-cli']),
      (fw) => fw !== 'gemini-cli',
    );
    expect(active).toEqual(['codex-cli', 'claude-code']);
    expect(resolveInternalFrameworkDefault(active).categories?.gate).toBe('codex-cli');
  });

  it('gemini signed in → still preferred for the gate (unchanged behavior)', () => {
    const active = selectActiveInternalFrameworks(
      INTERNAL_FRAMEWORK_PREFERENCE, 'claude-code',
      builds(['codex-cli', 'gemini-cli']),
      () => true,
    );
    expect(active).toEqual(['codex-cli', 'gemini-cli', 'claude-code']);
    expect(resolveInternalFrameworkDefault(active).categories?.gate).toBe('gemini-cli');
  });

  it('only signed-out gemini besides claude → the policy is a no-op (gate stays on the default)', () => {
    const active = selectActiveInternalFrameworks(
      INTERNAL_FRAMEWORK_PREFERENCE, 'claude-code',
      builds(['gemini-cli']),
      (fw) => fw !== 'gemini-cli',
    );
    expect(active).toEqual(['claude-code']);
    expect(resolveInternalFrameworkDefault(active).categories).toBeUndefined();
  });

  it('the default framework is always active, even without a probe', () => {
    const active = selectActiveInternalFrameworks(
      INTERNAL_FRAMEWORK_PREFERENCE, 'codex-cli', () => null, () => false,
    );
    expect(active).toEqual(['codex-cli']);
  });

  it('a throwing probe drops that framework instead of breaking boot', () => {
    const active = selectActiveInternalFrameworks(
      INTERNAL_FRAMEWORK_PREFERENCE, 'claude-code',
      (fw) => { if (fw === 'pi-cli') throw new Error('boom'); return fw === 'codex-cli' ? {} : null; },
      () => true,
    );
    expect(active).toEqual(['codex-cli', 'claude-code']);
  });
});
