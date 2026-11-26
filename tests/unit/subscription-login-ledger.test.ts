import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SUBSCRIPTION_LOGIN_CAUSE_CLASSES, SubscriptionLoginLedger, normalizeCellId } from '../../src/core/SubscriptionLoginLedger.js';

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

  it('closes an open read window as ESCALATED (not resolved) when the absence is corroborated into needs-reauth', () => {
    const ledger = new SubscriptionLoginLedger({ stateDir: temp(), machineId: 'm_local', writeEnabled: true });
    for (const at of ['2026-10-22T11:10:00.000Z', '2026-10-22T11:25:00.000Z', '2026-10-22T11:40:00.000Z']) {
      ledger.recordObservation({ accountId: 'acct-1', at,
        outcome: { kind: 'observation-absence', causeClass: 'credential-token-shape-invalid' } });
    }
    expect(ledger.listCredentialReadWindows()).toMatchObject([{ closedAt: null }]);
    ledger.recordObservation({ accountId: 'acct-1', at: '2026-10-22T12:00:00.000Z',
      outcome: { kind: 'transition-to-needs-reauth', causeClass: 'cli-login-expired-observed', corroboration: 'exchange-corroborated' } });
    expect(ledger.listCredentialReadWindows()[0]).toMatchObject({
      closedAt: '2026-10-22T12:00:00.000Z', outcome: 'escalated-to-needs-reauth',
    });
    expect(ledger.listEpisodes()).toMatchObject([{
      closedAt: null, causeClass: 'cli-login-expired-observed', corroboration: 'exchange-corroborated', provenance: 'observed',
    }]);
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

describe('SubscriptionLoginLedger.supersedeCause (codex-device-limit-tripwire §5)', () => {
  function events(ledger: SubscriptionLoginLedger): Array<{ kind: string; causeClass: string | null; fromCauseClass: string | null; episodeId: number | null; ts: string }> {
    const db = new Database(ledger.dbPath, { readonly: true });
    try {
      return db.prepare('SELECT kind,causeClass,fromCauseClass,episodeId,ts FROM events ORDER BY id').all() as never;
    } finally { db.close(); }
  }

  it('accepts codex-device-limit as a cause class in recordStatus', () => {
    expect(SUBSCRIPTION_LOGIN_CAUSE_CLASSES).toContain('codex-device-limit');
    const ledger = new SubscriptionLoginLedger({ stateDir: temp(), machineId: 'm_local', writeEnabled: true });
    const opened = ledger.recordStatus({
      accountId: 'codex-1', status: 'needs-reauth', at: '2026-10-31T20:00:00.000Z',
      causeClass: 'codex-device-limit', corroboration: 'exchange-corroborated',
    });
    expect(opened.changed).toBe(true);
    expect(ledger.listEpisodes()[0]).toMatchObject({ causeClass: 'codex-device-limit', closedAt: null });
    ledger.close();
  });

  it('re-labels the open episode in place, appends cause-superseded {from,to,at}, and is not a re-login', () => {
    const ledger = new SubscriptionLoginLedger({ stateDir: temp(), machineId: 'm_local', writeEnabled: true });
    const opened = ledger.recordStatus({
      accountId: 'codex-1', status: 'needs-reauth', at: '2026-10-31T20:00:00.000Z',
      causeClass: 'cli-signed-out-auth-refused', corroboration: 'exchange-corroborated',
    });
    expect(ledger.supersedeCause('codex-1', 'codex-device-limit', '2026-10-31T20:06:00.000Z')).toBe('superseded');
    const episodes = ledger.listEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      id: opened.episodeId, causeClass: 'codex-device-limit', closedAt: null, outcome: null,
      openedAt: '2026-10-31T20:00:00.000Z',
    });
    const rows = events(ledger);
    expect(rows.map((row) => row.kind)).toEqual(['relogin-required', 'cause-superseded']);
    expect(rows[1]).toMatchObject({
      causeClass: 'codex-device-limit', fromCauseClass: 'cli-signed-out-auth-refused',
      episodeId: opened.episodeId, ts: '2026-10-31T20:06:00.000Z',
    });
    expect(rows.some((row) => row.kind === 'relogin-resolved')).toBe(false);
    // Login history counts episodes: still one, open, none resolved.
    expect(episodes.filter((row) => row.outcome === 'resolved')).toHaveLength(0);
    ledger.close();
  });

  it('is unchanged when the open episode already carries that cause', () => {
    const ledger = new SubscriptionLoginLedger({ stateDir: temp(), machineId: 'm_local', writeEnabled: true });
    ledger.recordStatus({
      accountId: 'codex-1', status: 'needs-reauth', at: '2026-10-31T20:00:00.000Z', causeClass: 'codex-device-limit',
    });
    expect(ledger.supersedeCause('codex-1', 'codex-device-limit')).toBe('unchanged');
    expect(events(ledger).map((row) => row.kind)).toEqual(['relogin-required']);
    ledger.close();
  });

  it('is a no-op without an open episode (none, or only a closed one)', () => {
    const ledger = new SubscriptionLoginLedger({ stateDir: temp(), machineId: 'm_local', writeEnabled: true });
    expect(ledger.supersedeCause('codex-1', 'codex-device-limit')).toBe('no-open-episode');
    ledger.recordStatus({ accountId: 'codex-1', status: 'needs-reauth', at: '2026-10-31T20:00:00.000Z', causeClass: 'exchange-failed' });
    ledger.recordStatus({ accountId: 'codex-1', status: 'active', at: '2026-10-31T20:10:00.000Z' });
    expect(ledger.supersedeCause('codex-1', 'codex-device-limit')).toBe('no-open-episode');
    expect(ledger.listEpisodes()[0]).toMatchObject({ causeClass: 'exchange-failed', outcome: 'resolved' });
    expect(events(ledger).some((row) => row.kind === 'cause-superseded')).toBe(false);
    ledger.close();
  });

  it('refuses to write on a read-only ledger and rejects an unknown cause', () => {
    const dir = temp();
    const writer = new SubscriptionLoginLedger({ stateDir: dir, machineId: 'm_local', writeEnabled: true });
    expect(() => writer.supersedeCause('codex-1', 'not-a-cause' as never)).toThrow('invalid-cause-class');
    writer.close();
    const reader = new SubscriptionLoginLedger({ stateDir: dir, machineId: 'm_local', writeEnabled: false });
    expect(() => reader.supersedeCause('codex-1', 'codex-device-limit')).toThrow('subscription-login-ledger-readonly');
    reader.close();
  });

  it('adds the fromCauseClass column to a ledger created before it existed', () => {
    const dir = temp();
    const first = new SubscriptionLoginLedger({ stateDir: dir, machineId: 'm_local', writeEnabled: true });
    first.recordStatus({ accountId: 'codex-1', status: 'needs-reauth', at: '2026-10-31T20:00:00.000Z', causeClass: 'exchange-failed' });
    first.close();
    const raw = new Database(first.dbPath);
    raw.exec('ALTER TABLE events DROP COLUMN fromCauseClass');
    raw.close();
    const reopened = new SubscriptionLoginLedger({ stateDir: dir, machineId: 'm_local', writeEnabled: true });
    expect(reopened.supersedeCause('codex-1', 'codex-device-limit')).toBe('superseded');
    expect(events(reopened)[1]).toMatchObject({ fromCauseClass: 'exchange-failed' });
    reopened.close();
  });
});
