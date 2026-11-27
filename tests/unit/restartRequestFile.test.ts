import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishRestartRequestFile, publishRestartRequestFileAsync, restartRequestMarkerPath, pendingUpdateRestartTarget } from '../../src/core/restartRequestFile.js';

import { plannedRestartDeferralPath, plannedRestartRequestKey } from '../../src/core/plannedRestartDelivery.js';

describe('restart request publication order', () => {
  let directory: string;
  let flag: string;
  const older = JSON.stringify({ requestedAt: '2026-11-27T10:00:00.000Z' });
  const newer = JSON.stringify({ requestedAt: '2026-11-27T10:00:01.000Z' });

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-request-order-'));
    flag = path.join(directory, 'restart-requested.json');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'restart-request-order:cleanup' }));

  it('preserves a newer request published during the lease announcement', async () => {
    publishRestartRequestFile(flag, newer);
    expect((await publishRestartRequestFileAsync(flag, older)).published).toBe(false);
    expect(fs.readFileSync(flag, 'utf8')).toBe(newer);
  });

  it('rechecks ordering after waiting for the lock', async () => {
    const release = lockfile.lockSync(flag, { realpath: false });
    let pending: ReturnType<typeof publishRestartRequestFileAsync>;
    try {
      pending = publishRestartRequestFileAsync(flag, older);
      fs.writeFileSync(flag, newer);
    } finally {
      release();
    }
    expect((await pending).published).toBe(false);
    expect(fs.readFileSync(flag, 'utf8')).toBe(newer);
  });

  it('publishes after a cooperating writer releases the lock', async () => {
    publishRestartRequestFile(flag, older);
    const release = lockfile.lockSync(flag, { realpath: false });
    const pending = publishRestartRequestFileAsync(flag, newer);
    release();
    expect((await pending).published).toBe(true);
    expect(fs.readFileSync(flag, 'utf8')).toBe(newer);
  });

  it('leaves the existing flag intact when retry time runs out', async () => {
    publishRestartRequestFile(flag, older);
    const release = lockfile.lockSync(flag, { realpath: false });
    try {
      await expect(publishRestartRequestFileAsync(flag, newer)).rejects.toMatchObject({ code: 'ELOCKED' });
      expect(fs.readFileSync(flag, 'utf8')).toBe(older);
    } finally {
      release();
    }
  });

  it('keeps an active versioned update ahead of ordinary writers regardless of enqueue order', async () => {
    const update = JSON.stringify({ ...JSON.parse(older), targetVersion: '1.4.0', bypassHolds: true });
    publishRestartRequestFile(flag, newer);
    expect((await publishRestartRequestFileAsync(flag, update)).published).toBe(true);
    expect(publishRestartRequestFile(flag, newer)).toBe(false);
    expect((await publishRestartRequestFileAsync(flag, newer)).published).toBe(false);
    expect(fs.readFileSync(flag, 'utf8')).toBe(update);
  });

  it('preserves force for the same version in both publication orders', async () => {
    const forced = JSON.stringify({ ...JSON.parse(older), targetVersion: '1.4.0', bypassHolds: true });
    const automatic = JSON.stringify({ ...JSON.parse(newer), targetVersion: '1.4.0' });
    publishRestartRequestFile(flag, automatic);
    expect((await publishRestartRequestFileAsync(flag, forced)).published).toBe(true);
    expect((await publishRestartRequestFileAsync(flag, automatic)).published).toBe(false);
    expect(fs.readFileSync(flag, 'utf8')).toBe(forced);
  });

  it.each([false, true])('combines a forced operator request and pending update (operator first: %s)', async (operatorFirst) => {
    const update = {
      ...JSON.parse(older), requestedBy: 'auto-updater', reason: 'Activate installed update',
      targetVersion: '1.4.0', previousVersion: '1.3.0', plannedRestart: true,
    };
    const forced = { ...JSON.parse(newer), requestedBy: 'fix-command', plannedRestart: true, bypassHolds: true };
    const [first, second] = operatorFirst ? [forced, update] : [update, forced];
    expect(publishRestartRequestFile(flag, JSON.stringify(first))).toBe(true);
    expect((await publishRestartRequestFileAsync(flag, JSON.stringify(second))).published).toBe(true);
    expect(JSON.parse(fs.readFileSync(flag, 'utf8'))).toEqual({ ...update, bypassHolds: true });
  });

  it.each([false, true])('does not transfer version-specific force to a newer update (forced first: %s)', async (forcedFirst) => {
    const forced = JSON.stringify({ ...JSON.parse(older), targetVersion: '1.4.0', bypassHolds: true });
    const automatic = JSON.stringify({ ...JSON.parse(newer), targetVersion: '1.5.0' });
    const [first, second] = forcedFirst ? [forced, automatic] : [automatic, forced];
    expect(publishRestartRequestFile(flag, first)).toBe(true);
    expect(await publishRestartRequestFileAsync(flag, second)).toEqual(forcedFirst
      ? { published: true }
      : { published: false, targetVersion: '1.5.0' });
    expect(fs.readFileSync(flag, 'utf8')).toBe(automatic);
  });

  it('keeps the force request expiry when it promotes a previously deferred update past its original TTL', async () => {
    const now = Date.now();
    const update = {
      requestedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      expiresAt: new Date(now - 60 * 60_000).toISOString(),
      targetVersion: '1.4.0', requestedBy: 'auto-updater', plannedRestart: true,
    };
    const forced = {
      requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60 * 60_000).toISOString(),
      requestedBy: 'fix-command', plannedRestart: true, bypassHolds: true,
    };
    publishRestartRequestFile(flag, JSON.stringify(update));
    fs.writeFileSync(plannedRestartDeferralPath(directory), JSON.stringify({
      requestKey: plannedRestartRequestKey(update),
      deferredAt: now - 90 * 60_000,
    }));

    expect((await publishRestartRequestFileAsync(flag, JSON.stringify(forced))).published).toBe(true);
    const combined = fs.readFileSync(flag, 'utf8');
    expect(JSON.parse(combined)).toEqual({ ...update, bypassHolds: true, expiresAt: forced.expiresAt });
    expect(pendingUpdateRestartTarget(flag, combined, now)).toBe(update.targetVersion);
  });

  it('accepts an ordinary request after a newer update times out', async () => {
    const update = JSON.stringify({ ...JSON.parse(newer), targetVersion: '1.4.0' });
    publishRestartRequestFile(flag, update);
    const timeout = restartRequestMarkerPath(flag, update, 'timeout');
    fs.writeFileSync(timeout, '');
    expect((await publishRestartRequestFileAsync(flag, older)).published).toBe(true);
    expect(fs.readFileSync(flag, 'utf8')).toBe(older);
    expect(fs.existsSync(timeout)).toBe(false);
  });

  it('accepts an ordinary request after the active update expires', async () => {
    const update = JSON.stringify({ ...JSON.parse(newer), targetVersion: '1.4.0', expiresAt: new Date(1).toISOString() });
    publishRestartRequestFile(flag, update);
    expect((await publishRestartRequestFileAsync(flag, older)).published).toBe(true);
    expect(fs.readFileSync(flag, 'utf8')).toBe(older);
  });

  it('does not let a withdrawable role flag satisfy an ordinary restart', async () => {
    const role = JSON.stringify({ ...JSON.parse(newer), requestedBy: 'role-change' });
    publishRestartRequestFile(flag, role);
    expect((await publishRestartRequestFileAsync(flag, older)).published).toBe(true);
    expect((await publishRestartRequestFileAsync(flag, role)).published).toBe(false);
    expect(fs.readFileSync(flag, 'utf8')).toBe(older);
  });

  it.each([true, false])('keeps a past-expiry update only with its exact verification proof (%s)', async (exact) => {
    const now = Date.now();
    const requestedAt = now - 2 * 60 * 60_000;
    const order = {
      requestedAt: new Date(requestedAt).toISOString(),
      expiresAt: new Date(requestedAt + 60 * 60_000).toISOString(),
      targetVersion: '1.4.0',
      plannedRestart: true,
    };
    const update = JSON.stringify(order);
    publishRestartRequestFile(flag, update);
    fs.writeFileSync(plannedRestartDeferralPath(directory), JSON.stringify({
      requestKey: plannedRestartRequestKey(exact ? order : { ...order, targetVersion: '1.5.0' }),
      deferredAt: requestedAt + 10 * 60_000,
    }));
    expect(pendingUpdateRestartTarget(flag, update, now)).toBe(exact ? '1.4.0' : null);
    expect((await publishRestartRequestFileAsync(flag, newer)).published).toBe(!exact);
    expect(fs.readFileSync(flag, 'utf8')).toBe(exact ? update : newer);
  });

  it('retains the active request on identical timestamps', async () => {
    publishRestartRequestFile(flag, newer);
    const tied = JSON.stringify({ ...JSON.parse(newer), requestedBy: 'late-writer' });
    expect((await publishRestartRequestFileAsync(flag, tied)).published).toBe(false);
    expect(fs.readFileSync(flag, 'utf8')).toBe(newer);
  });

  it('publishes a newer request over an older request', async () => {
    publishRestartRequestFile(flag, older);
    expect((await publishRestartRequestFileAsync(flag, newer)).published).toBe(true);
    expect(fs.readFileSync(flag, 'utf8')).toBe(newer);
  });
});
