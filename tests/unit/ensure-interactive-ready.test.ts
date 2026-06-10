/**
 * Unit tests for ensureInteractiveReady (onboarding-safe config homes,
 * 2026-06-09 incident). Module in isolation with a real filesystem (temp
 * dirs). Covers both sides of every boundary: missing-file create, partial
 * merge, idempotency, oauthAccount/token preservation, tilde expansion, the
 * fail-safe lanes (empty home, unreadable, unparseable, non-object), and the
 * requireExistingHome migration gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureInteractiveReady,
  INTERACTIVE_ONBOARDING_FLAGS,
} from '../../src/core/ensureInteractiveReady.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('ensureInteractiveReady', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-ready-'));
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/ensure-interactive-ready.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  function home(name = '.claude-acct'): string {
    return path.join(dir, name);
  }
  function readConfig(h: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(h, '.claude.json'), 'utf-8'));
  }

  // ── create / merge ────────────────────────────────────────────────

  it('creates .claude.json with all three flags when the file is missing', () => {
    const h = home();
    fs.mkdirSync(h);
    const r = ensureInteractiveReady(h);
    expect(r.patched).toBe(true);
    const cfg = readConfig(h);
    for (const f of INTERACTIVE_ONBOARDING_FLAGS) expect(cfg[f]).toBe(true);
  });

  it('creates the config home directory itself when missing (enrollment ordering)', () => {
    const h = home('.claude-not-yet');
    const r = ensureInteractiveReady(h);
    expect(r.patched).toBe(true);
    for (const f of INTERACTIVE_ONBOARDING_FLAGS) expect(readConfig(h)[f]).toBe(true);
  });

  it('merges missing flags into an existing config, preserving ALL other keys', () => {
    // The justin-gmail live state at the incident: onboarded=true, bypass missing.
    const h = home();
    fs.mkdirSync(h);
    const before = {
      hasCompletedOnboarding: true,
      numStartups: 42,
      installMethod: 'native',
      oauthAccount: { accountUuid: 'uuid-1', emailAddress: 'user@example.com' },
      projects: { '/some/dir': { allowedTools: [] } },
    };
    fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify(before));
    const r = ensureInteractiveReady(h);
    expect(r.patched).toBe(true);
    expect(r.reason).toContain('bypassPermissionsModeAccepted');
    expect(r.reason).toContain('hasTrustDialogAccepted');
    expect(r.reason).not.toContain('hasCompletedOnboarding');
    const cfg = readConfig(h);
    for (const f of INTERACTIVE_ONBOARDING_FLAGS) expect(cfg[f]).toBe(true);
    // every pre-existing key survives byte-for-byte
    expect(cfg.numStartups).toBe(42);
    expect(cfg.installMethod).toBe('native');
    expect(cfg.projects).toEqual(before.projects);
  });

  it('treats a flag explicitly set to false as missing (seeds it true)', () => {
    const h = home();
    fs.mkdirSync(h);
    fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: false,
      hasTrustDialogAccepted: true,
    }));
    const r = ensureInteractiveReady(h);
    expect(r.patched).toBe(true);
    expect(readConfig(h).bypassPermissionsModeAccepted).toBe(true);
  });

  // ── NEVER touches credentials ─────────────────────────────────────

  it('NEVER touches oauthAccount or token-bearing fields', () => {
    const h = home();
    fs.mkdirSync(h);
    const oauthAccount = {
      accountUuid: 'cafe-babe',
      emailAddress: 'sagemind-justin@example.com',
      organizationUuid: 'org-1',
    };
    fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({
      oauthAccount,
      customApiKeyResponses: { approved: ['sk-redacted-hash'] },
    }));
    const r = ensureInteractiveReady(h);
    expect(r.patched).toBe(true);
    const cfg = readConfig(h);
    expect(cfg.oauthAccount).toEqual(oauthAccount);
    expect(cfg.customApiKeyResponses).toEqual({ approved: ['sk-redacted-hash'] });
  });

  // ── idempotency ───────────────────────────────────────────────────

  it('is idempotent: a second call writes nothing and reports already-ready', () => {
    const h = home();
    const first = ensureInteractiveReady(h);
    expect(first.patched).toBe(true);
    const statBefore = fs.statSync(path.join(h, '.claude.json')).mtimeMs;
    const second = ensureInteractiveReady(h);
    expect(second.patched).toBe(false);
    expect(second.reason).toBe('already interactive-ready');
    expect(fs.statSync(path.join(h, '.claude.json')).mtimeMs).toBe(statBefore);
  });

  it('reports already-ready for a fully onboarded home without rewriting it', () => {
    const h = home();
    fs.mkdirSync(h);
    const full = {
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      hasTrustDialogAccepted: true,
      oauthAccount: { accountUuid: 'u' },
    };
    const raw = JSON.stringify(full); // deliberately NOT pretty-printed
    fs.writeFileSync(path.join(h, '.claude.json'), raw);
    const r = ensureInteractiveReady(h);
    expect(r.patched).toBe(false);
    // untouched byte-for-byte (no reformat write)
    expect(fs.readFileSync(path.join(h, '.claude.json'), 'utf-8')).toBe(raw);
  });

  // ── tilde expansion ───────────────────────────────────────────────

  it('expands a ~ prefix against $HOME (pool entries are operator-entered)', () => {
    const origHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      const r = ensureInteractiveReady('~/.claude-tilde');
      expect(r.patched).toBe(true);
      expect(readConfig(path.join(dir, '.claude-tilde')).hasCompletedOnboarding).toBe(true);
    } finally {
      process.env.HOME = origHome;
    }
  });

  // ── fail-safe lanes (never throw into a launch path) ──────────────

  it('fail-safe: empty configHome returns patched:false, never throws', () => {
    expect(ensureInteractiveReady('')).toEqual({ patched: false, reason: 'empty configHome' });
    expect(ensureInteractiveReady('   ').patched).toBe(false);
  });

  it('fail-safe: refuses to rewrite an UNPARSEABLE .claude.json (may hold salvageable credentials)', () => {
    const h = home();
    fs.mkdirSync(h);
    const corrupt = '{"oauthAccount": {"accountUuid": "u", TRUNCATED';
    fs.writeFileSync(path.join(h, '.claude.json'), corrupt);
    const r = ensureInteractiveReady(h);
    expect(r.patched).toBe(false);
    expect(r.reason).toContain('refusing to rewrite');
    // the corrupt-but-maybe-salvageable bytes are preserved exactly
    expect(fs.readFileSync(path.join(h, '.claude.json'), 'utf-8')).toBe(corrupt);
  });

  it('fail-safe: refuses a .claude.json that parses to a non-object', () => {
    const h = home();
    fs.mkdirSync(h);
    fs.writeFileSync(path.join(h, '.claude.json'), '["not", "an", "object"]');
    const r = ensureInteractiveReady(h);
    expect(r.patched).toBe(false);
    expect(r.reason).toContain('not a JSON object');
    expect(JSON.parse(fs.readFileSync(path.join(h, '.claude.json'), 'utf-8'))).toEqual(['not', 'an', 'object']);
  });

  it('fail-safe: an unreadable/unwritable home returns patched:false, never throws', () => {
    // A FILE where the config home directory should be makes every fs op on
    // `<home>/.claude.json` fail — exercising the catch-all lane.
    const h = home('.claude-is-a-file');
    fs.writeFileSync(h, 'not a directory');
    const r = ensureInteractiveReady(h);
    expect(r.patched).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  // ── requireExistingHome (migration gate) ──────────────────────────

  it('requireExistingHome: leaves a nonexistent home alone (no $HOME littering)', () => {
    const h = home('.claude-stale-entry');
    const r = ensureInteractiveReady(h, { requireExistingHome: true });
    expect(r.patched).toBe(false);
    expect(r.reason).toContain('does not exist');
    expect(fs.existsSync(h)).toBe(false);
  });

  it('requireExistingHome: still patches a home that DOES exist', () => {
    const h = home();
    fs.mkdirSync(h);
    const r = ensureInteractiveReady(h, { requireExistingHome: true });
    expect(r.patched).toBe(true);
    expect(readConfig(h).hasTrustDialogAccepted).toBe(true);
  });
});
