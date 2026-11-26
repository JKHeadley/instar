import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { provisionVerifiedWorktreeDependencies } from '../../src/core/VerifiedWorktreeDependencies.js';

describe('verified worktree dependency dispatch', () => {
  let home: string;
  let checkout: string;
  let config: string;
  let helper: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verified-worktree-')));
    checkout = path.join(home, 'checkout');
    config = path.join(home, '.instar', 'config.json');
    helper = path.join(home, '.instar', 'state', 'studio-worktree-dependencies', 'bin', 'verified-worktree-dependencies');
    fs.mkdirSync(checkout);
    fs.mkdirSync(path.dirname(helper), { recursive: true });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'Dispose verified dependency test fixture' }));

  function enable(script?: string) {
    if (script) fs.writeFileSync(helper, '#!/bin/sh\n' + script + '\n', { mode: 0o700 });
    const digest = script ? createHash('sha256').update(fs.readFileSync(helper)).digest('hex') : undefined;
    fs.writeFileSync(config, JSON.stringify({
      worktree: { verifiedDependencyStore: true, verifiedDependencyHelperSha256: digest },
    }));
  }

  it('keeps the legacy path with no flag and when sharing is explicitly off', () => {
    expect(provisionVerifiedWorktreeDependencies(home, checkout, true)).toBe('disabled');
    enable('exit 99');
    expect(provisionVerifiedWorktreeDependencies(home, checkout, false)).toBe('disabled');
  });

  it('chooses a private install when the helper is unavailable', () => {
    enable();
    expect(provisionVerifiedWorktreeDependencies(home, checkout, true)).toBe('private-install');
  });

  it.skipIf(process.platform !== 'darwin')('uses the pinned helper and accepts a private directory', () => {
    enable('mkdir "$1/node_modules"');
    expect(provisionVerifiedWorktreeDependencies(home, checkout, true)).toBe('verified-clone');
  });

  it.skipIf(process.platform !== 'darwin')('accepts a clean miss and refuses a contaminated miss', () => {
    enable('exit 3');
    expect(provisionVerifiedWorktreeDependencies(home, checkout, true)).toBe('private-install');
    enable('mkdir "$1/node_modules"; exit 3');
    expect(() => provisionVerifiedWorktreeDependencies(home, checkout, true)).toThrow(/provisioning failed/);
  });

  it('leaves a pre-existing destination alone', () => {
    enable();
    const destination = path.join(checkout, 'node_modules');
    fs.mkdirSync(destination);
    expect(() => provisionVerifiedWorktreeDependencies(home, checkout, true)).toThrow(/absent/);
    expect(fs.statSync(destination).isDirectory()).toBe(true);
  });
});
