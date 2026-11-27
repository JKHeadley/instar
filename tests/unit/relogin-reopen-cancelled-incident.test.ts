/**
 * Reopen a cancelled incident while the account is still signed out
 * (docs/specs/relogin-reopen-cancelled-incident.md). Live case, 2026-11-25: on the Mac Mini,
 * gearfinity3d's exchange-corroborated incident was closed `cancelled` by admission bookkeeping
 * while the account stayed `needs-reauth`, and nothing ever opened a new one, so no repair could
 * start again (`no-open-incident`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SubscriptionLoginLedger } from '../../src/core/SubscriptionLoginLedger.js';
import { SubscriptionReloginStore } from '../../src/core/SubscriptionReloginStore.js';

const dirs: string[] = [];
function ledger(): SubscriptionLoginLedger {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-reopen-'));
  dirs.push(dir);
  return new SubscriptionLoginLedger({ stateDir: dir, machineId: 'm_local', writeEnabled: true });
}
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/relogin-reopen-cancelled-incident.test.ts:cleanup' });
});

const cell = (at: string, extra: Record<string, unknown> = {}) => ({ accountId: 'gearfinity3d', supported: true, disabled: false, at, ...extra });
/** An ISO time `ms` after the current incident's cancellation. */
const afterCancel = (l: SubscriptionLoginLedger, ms: number): string => new Date(Date.parse(l.listEpisodes()[0]!.closedAt!) + ms).toISOString();
function openIncident(l: SubscriptionLoginLedger): number {
  const opened = l.recordStatus({ accountId: 'gearfinity3d', status: 'needs-reauth', at: '2026-11-25T16:12:35.000Z',
    causeClass: 'exchange-failed', corroboration: 'exchange-corroborated' });
  return opened.episodeId!;
}

describe('reconcileAdmission reopens an incident cancelled only by admission bookkeeping', () => {
  it('reopens the same incident, with its original cause, corroboration and provenance', () => {
    const l = ledger();
    l.reconcileAdmission([cell('2026-11-25T16:13:00.000Z', { needsReauth: true })]);
    const id = openIncident(l);
    l.reconcileAdmission([]); // the cell drops out of one scan: the incident is cancelled
    expect(l.listEpisodes()[0]).toMatchObject({ id, outcome: 'cancelled' });
    l.reconcileAdmission([cell(afterCancel(l, 60_000), { needsReauth: true })]); // back on the next poll
    const episodes = l.listEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ id, closedAt: null, outcome: null, causeClass: 'exchange-failed',
      corroboration: 'exchange-corroborated', provenance: 'observed' });
  });

  it('is idempotent: later scans leave the reopened incident alone', () => {
    const l = ledger();
    l.reconcileAdmission([cell('2026-11-25T16:13:00.000Z', { needsReauth: true })]);
    openIncident(l);
    l.reconcileAdmission([]);
    l.reconcileAdmission([cell(afterCancel(l, 60_000), { needsReauth: true })]);
    l.reconcileAdmission([cell(new Date(Date.now() + 3_600_000).toISOString(), { needsReauth: true })]);
    expect(l.listEpisodes()).toHaveLength(1);
    expect(l.listEpisodes()[0]).toMatchObject({ closedAt: null });
  });

  it('never reopens a resolved incident, or one whose account is no longer signed out', () => {
    const resolved = ledger();
    resolved.reconcileAdmission([cell('2026-11-25T16:13:00.000Z', { needsReauth: true })]);
    openIncident(resolved);
    resolved.recordStatus({ accountId: 'gearfinity3d', status: 'active', at: '2026-11-25T17:00:00.000Z', corroboration: 'exchange-corroborated' });
    resolved.reconcileAdmission([cell('2026-11-25T18:00:00.000Z', { needsReauth: true })]);
    expect(resolved.listEpisodes()[0]).toMatchObject({ outcome: 'resolved' });

    const recovered = ledger();
    recovered.reconcileAdmission([cell('2026-11-25T16:13:00.000Z', { needsReauth: true })]);
    openIncident(recovered);
    recovered.reconcileAdmission([]);
    recovered.reconcileAdmission([cell(afterCancel(recovered, 60_000), { needsReauth: false })]);
    recovered.reconcileAdmission([cell(afterCancel(recovered, 120_000))]); // field absent ⇒ no reopen
    expect(recovered.listEpisodes()[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it('records the closure it undid on the reopen event', () => {
    const l = ledger();
    l.reconcileAdmission([cell('2026-11-25T16:13:00.000Z', { needsReauth: true })]);
    openIncident(l);
    l.reconcileAdmission([]);
    const closedAt = l.listEpisodes()[0]!.closedAt;
    l.reconcileAdmission([cell(afterCancel(l, 60_000), { needsReauth: true })]);
    const db = new Database(l.dbPath, { readonly: true });
    const ev = db.prepare("SELECT kind, repairState FROM events WHERE kind='relogin-reopened'").all() as Array<{ kind: string; repairState: string }>;
    db.close();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.repairState).toBe(`reopened-from-cancelled-at:${closedAt}`);
  });

  it('does not reopen when a clean authenticated read was recorded after the cancellation', () => {
    const l = ledger();
    l.reconcileAdmission([cell('2026-11-25T16:13:00.000Z', { needsReauth: true })]);
    openIncident(l);
    l.reconcileAdmission([]);
    const closedAt = l.listEpisodes()[0]!.closedAt!;
    l.reconcileAdmission([cell(afterCancel(l, 60_000), { needsReauth: false })]);
    l.recordObservation({ accountId: 'gearfinity3d', at: new Date(Date.parse(closedAt) + 90_000).toISOString(), outcome: { kind: 'resolved-clean' } });
    l.reconcileAdmission([cell(new Date(Date.parse(closedAt) + 120_000).toISOString(), { needsReauth: true })]);
    expect(l.listEpisodes()[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it('reopens after a long gap too, as long as the pool still marks it signed out and nothing read it clean', () => {
    const l = ledger();
    l.reconcileAdmission([cell('2026-11-25T16:13:00.000Z', { needsReauth: true })]);
    openIncident(l);
    l.reconcileAdmission([]);
    l.reconcileAdmission([cell(afterCancel(l, 6 * 60 * 60_000), { needsReauth: true })]);
    expect(l.listEpisodes()[0]).toMatchObject({ closedAt: null });
  });

  it('reopens an incumbent on a later poll once the account is still signed out (the live case)', () => {
    const l = ledger();
    l.reconcileAdmission([cell('2026-11-25T16:13:00.000Z', { needsReauth: true })]);
    openIncident(l);
    l.reconcileAdmission([]);
    l.reconcileAdmission([cell(afterCancel(l, 2_000), { needsReauth: false })]); // back 2 s later, before the fix knew
    l.reconcileAdmission([cell(new Date(Date.now() + 86_400_000).toISOString(), { needsReauth: true })]); // a day later
    expect(l.listEpisodes()[0]).toMatchObject({ closedAt: null });
  });

  it('does nothing for a cell with no incident at all', () => {
    const l = ledger();
    l.reconcileAdmission([cell('2026-11-25T16:13:00.000Z', { needsReauth: true })]);
    expect(l.listEpisodes()).toHaveLength(0);
  });
});

describe('a repair cancelled because its incident closed is re-admitted when that incident is open again', () => {
  const input = { sourceEpisodeId: 32, accountId: 'gearfinity3d', machineId: 'machine-1', mode: 'unattended' as const,
    inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'gearfinity-google', framework: 'claude-code', provider: 'anthropic' };
  function store(): SubscriptionReloginStore {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-reopen-store-'));
    dirs.push(dir);
    return new SubscriptionReloginStore({ stateDir: dir, idFactory: () => 'repair-1' });
  }

  it('re-admits a row cancelled by source-incident-closed, with unchanged inputs', () => {
    const s = store();
    const ep = s.suggest(input);
    const approved = s.approve(ep.id, { inputDigest: ep.inputDigest });
    s.transition(approved.id, { expectedVersion: approved.version, to: 'cancelled', eventClass: 'source-incident-closed',
      failureClass: 'cancelled-by-operator' });
    expect(s.get(ep.id)!.state).toBe('cancelled');
    const again = s.suggest(input); // the source incident is open again
    expect(again).toMatchObject({ id: ep.id, state: 'suggested', mode: 'unattended' });
    expect(s.listEvents(ep.id).map((e) => e.eventClass)).toContain('candidate-readmitted-source-reopened');
    // A second source-closed cancel of the same row is not re-admitted again (no restart loop).
    const approved2 = s.approve(ep.id, { inputDigest: again.inputDigest });
    s.transition(approved2.id, { expectedVersion: approved2.version, to: 'cancelled', eventClass: 'source-incident-closed',
      failureClass: 'cancelled-by-operator' });
    expect(s.suggest(input)).toMatchObject({ id: ep.id, state: 'cancelled' });
    s.close();
  });

  it('keeps an operator-cancelled row cancelled when the inputs are unchanged', () => {
    const s = store();
    const ep = s.suggest(input);
    s.cancel(ep.id);
    expect(s.suggest(input)).toMatchObject({ id: ep.id, state: 'cancelled' });
    s.close();
  });
});
