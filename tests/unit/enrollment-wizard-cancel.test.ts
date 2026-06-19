/**
 * Unit tests for the EnrollmentWizard operator-cancel pass-throughs
 * (matrix-cell-operator-cancel): getById() (resolves terminal/expired records,
 * unlike pending()) and abandon() (delegates to the store's terminal-guarded
 * transition). Hermetic: injected clock + temp-dir store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PendingLoginStore } from '../../src/core/PendingLoginStore.js';
import { EnrollmentWizard } from '../../src/core/EnrollmentWizard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.parse('2026-06-19T00:00:00Z');

function login(id = 'fm-1') {
  return {
    id, label: 'main', provider: 'anthropic' as const, framework: 'claude-code' as const,
    kind: 'url-code-paste' as const, configHome: `/tmp/.claude-followme-${id}`,
    verificationUrl: 'https://claude.com/oauth', expectedEmail: 'approved@x.com',
  };
}

describe('EnrollmentWizard — operator-cancel pass-throughs', () => {
  let dir: string;
  let clock: number;
  let store: PendingLoginStore;
  let wizard: EnrollmentWizard;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-cancel-'));
    clock = T0;
    store = new PendingLoginStore({ stateDir: dir, now: () => clock });
    wizard = new EnrollmentWizard({ store, driveLogin: async () => ({ verificationUrl: 'x', ttlMs: 60_000 }), now: () => clock });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/enrollment-wizard-cancel.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('getById() returns a live-pending login', () => {
    store.issue(login());
    expect(wizard.getById('fm-1')?.status).toBe('pending');
  });

  it('getById() returns an EXPIRED login (which pending() excludes)', () => {
    store.issue({ ...login(), ttlMs: 60_000 });
    clock += 120_000;
    expect(wizard.pending().find((l) => l.id === 'fm-1')).toBeUndefined(); // pending() excludes expired
    expect(wizard.getById('fm-1')?.status).toBe('expired');               // getById finds it
  });

  it('getById() returns a terminal (abandoned) login', () => {
    store.issue(login());
    store.abandon('fm-1');
    expect(wizard.getById('fm-1')?.status).toBe('abandoned');
  });

  it('getById() of an unknown id → null', () => {
    expect(wizard.getById('nope')).toBeNull();
  });

  it('abandon() delegates to the store (pending → abandoned)', () => {
    store.issue(login());
    expect(wizard.abandon('fm-1')?.status).toBe('abandoned');
    expect(store.get('fm-1')?.status).toBe('abandoned');
  });

  it('abandon() does not clobber a completed login (terminal guard via the store)', () => {
    store.issue(login());
    store.complete('fm-1');
    expect(wizard.abandon('fm-1')?.status).toBe('completed');
  });

  it('abandon() of an unknown id → null', () => {
    expect(wizard.abandon('nope')).toBeNull();
  });
});
