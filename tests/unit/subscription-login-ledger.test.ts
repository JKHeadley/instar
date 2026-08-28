import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SubscriptionLoginLedger, normalizeCellId } from '../../src/core/SubscriptionLoginLedger.js';

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-ledger-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true, force: true, operation: 'subscription-login-ledger.test:cleanup',
    });
  }
});

describe('SubscriptionLoginLedger', () => {
  it('normalizes stable cell ids without permitting SQL-shaped filters', () => {
    expect(normalizeCellId('Mac-Studio.LOCAL')).toBe('mac-studio');
    expect(() => normalizeCellId("x' OR 1=1 --")).toThrow('invalid-cell-id');
  });

  it('opens one incident, deduplicates repeated level observations, and closes on recovery', () => {
    const dir = temp();
    const ledger = new SubscriptionLoginLedger({ stateDir: dir, machineId: 'm_local', writeEnabled: true });
    const opened = ledger.recordStatus({
      accountId: 'acct-1', status: 'needs-reauth', at: '2026-08-27T01:00:00.000Z',
      causeClass: 'exchange-failed', corroboration: 'exchange-corroborated',
    });
    expect(opened.changed).toBe(true);
    expect(ledger.recordStatus({
      accountId: 'acct-1', status: 'needs-reauth', at: '2026-08-27T01:05:00.000Z',
      causeClass: 'exchange-failed',
    })).toEqual({ changed: false, episodeId: opened.episodeId });
    expect(ledger.listEpisodes()).toHaveLength(1);
    expect(ledger.recordStatus({
      accountId: 'acct-1', status: 'active', at: '2026-08-27T01:15:00.000Z',
      corroboration: 'exchange-corroborated',
    })).toEqual({ changed: true, episodeId: opened.episodeId });
    expect(ledger.listEpisodes()[0]).toMatchObject({
      accountId: 'acct-1', machineId: 'm_local',
      causeClass: 'exchange-failed', outcome: 'resolved',
      openedAt: '2026-08-27T01:00:00.000Z', closedAt: '2026-08-27T01:15:00.000Z',
    });
  });

  it('persists open-episode authority across restart and keeps files private', () => {
    const dir = temp();
    const first = new SubscriptionLoginLedger({ stateDir: dir, machineId: 'm_local', writeEnabled: true });
    first.recordStatus({
      accountId: 'acct-1', status: 'needs-reauth', at: '2026-08-27T01:00:00.000Z',
      provenance: 'inferred-from-level',
    });
    const restarted = new SubscriptionLoginLedger({ stateDir: dir, machineId: 'm_local', writeEnabled: true });
    expect(restarted.listEpisodes()).toHaveLength(1);
    expect(restarted.recordStatus({
      accountId: 'acct-1', status: 'needs-reauth', at: '2026-08-27T02:00:00.000Z',
    }).changed).toBe(false);
    expect(fs.statSync(restarted.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(restarted.dbPath).mode & 0o777).toBe(0o600);
    expect(restarted.getHealth()).toEqual({ state: 'ok', readonly: false });
  });

  it('writes a private lifecycle watermark and records a corroborated clean stop', () => {
    const ledger = new SubscriptionLoginLedger({ stateDir: temp(), machineId: 'm_local', writeEnabled: true });
    expect(ledger.getWatermark()).toMatchObject({
      schemaVersion: 1,
      machineId: 'm_local',
      lastLifecycle: { state: 'started' },
      writesRefused: 0,
    });
    expect(fs.statSync(ledger.watermarkPath).mode & 0o777).toBe(0o600);
    ledger.close();
    expect(JSON.parse(fs.readFileSync(ledger.watermarkPath, 'utf8'))).toMatchObject({
      lastLifecycle: { state: 'stopped' },
    });
  });

  it('keeps credential absence observational and opens only after 3 passes spanning 30 minutes', () => {
    const ledger = new SubscriptionLoginLedger({ stateDir: temp(), machineId: 'm_local', writeEnabled: true });
    const absence = (at: string) => ledger.recordObservation({
      accountId: 'acct-1', at,
      outcome: { kind: 'observation-absence', causeClass: 'credential-absent-or-unreadable' },
    });
    absence('2026-08-27T01:00:00.000Z');
    absence('2026-08-27T01:15:00.000Z');
    expect(ledger.listCredentialReadWindows()).toEqual([]);
    absence('2026-08-27T01:30:00.000Z');
    expect(ledger.listEpisodes()).toEqual([]);
    expect(ledger.listCredentialReadWindows()).toMatchObject([{
      openedAt: '2026-08-27T01:00:00.000Z', closedAt: null,
      observationClass: 'credential-absent-or-unreadable', floorPasses: 3, floorMinutes: 30,
    }]);
    ledger.recordObservation({
      accountId: 'acct-1', at: '2026-08-27T01:45:00.000Z', outcome: { kind: 'resolved-clean' },
    });
    expect(ledger.listCredentialReadWindows()[0]).toMatchObject({
      closedAt: '2026-08-27T01:45:00.000Z', outcome: 'resolved-read-window',
    });
  });

  it('coalesces clean and absence evidence in either order into mixed coverage', () => {
    const ledger = new SubscriptionLoginLedger({ stateDir: temp(), machineId: 'm_local', writeEnabled: true });
    ledger.recordObservation({ accountId: 'acct-1', at: '2026-08-27T01:01:00.000Z', outcome: { kind: 'resolved-clean' } });
    ledger.recordObservation({
      accountId: 'acct-1', at: '2026-08-27T01:02:00.000Z',
      outcome: { kind: 'observation-absence', causeClass: 'credential-token-shape-invalid' },
    });
    expect(ledger.listCoverage()).toMatchObject([{ class: 'auth-path-observed', authResult: 'mixed' }]);
  });

  it('durably caps admission at 64, retains incumbents, and cancels removed cells', () => {
    const dir = temp();
    const ledger = new SubscriptionLoginLedger({ stateDir: dir, machineId: 'm_local', writeEnabled: true });
    const at = '2026-08-27T02:00:00.000Z';
    const cells = Array.from({ length: 65 }, (_, index) => ({
      accountId: `acct-${index}`, supported: true, disabled: false, at,
    }));
    const first = ledger.reconcileAdmission(cells);
    expect(first.size).toBe(64);
    expect(first.has('acct-64')).toBe(false);
    ledger.recordStatus({ accountId: 'acct-0', status: 'needs-reauth', at });

    const restarted = new SubscriptionLoginLedger({ stateDir: dir, machineId: 'm_local', writeEnabled: true });
    const changed = cells.map((cell) => cell.accountId === 'acct-0' ? { ...cell, disabled: true } : cell);
    const second = restarted.reconcileAdmission(changed.map((cell) => ({
      ...cell, at: '2026-08-27T03:00:00.000Z',
    })));
    expect(second.size).toBe(64);
    expect(second.has('acct-0')).toBe(false);
    expect(second.has('acct-64')).toBe(true);
    expect(restarted.listEpisodes({ accountId: 'acct-0' })[0]).toMatchObject({
      outcome: 'cancelled', closedAt: '2026-08-27T03:00:00.000Z',
    });
  });
});
