/**
 * The catalog keeps an honest record (docs/specs/recommended-services.md, Structural checks), and
 * the console never describes a backup as stronger than its status.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_STATUSES, RECOMMENDED_SERVICE_CATALOG, isServiceAvailable, type CatalogRow } from '../../src/recommended/catalog.js';
import { RECOMMENDED_SERVICE_IDS } from '../../src/recommended/serviceIds.js';
import { buildServices } from '../../dashboard/console/services-model.js';

const root = process.cwd();
const rows: readonly CatalogRow[] = RECOMMENDED_SERVICE_CATALOG;

describe('recommended services catalog', () => {
  it('makes clear that Jev is an optional efficiency upgrade', () => {
    expect(rows.find(row => row.id === 'jev')?.benefit).toMatch(/optional.*agent runs without it/i);
  });

  it('holds the nine services the operator approved, once each', () => {
    expect([...RECOMMENDED_SERVICE_IDS].sort()).toEqual([
      'bitwarden', 'cloudflare-domain', 'email', 'github-state-backup', 'jev', 'second-ai-door', 'tailscale', 'telegram', 'voice-transcription',
    ]);
    expect(new Set(RECOMMENDED_SERVICE_IDS).size).toBe(rows.length);
  });

  it('every row states what a person needs in order to decide', () => {
    for (const row of rows) {
      for (const field of ['name', 'benefit', 'dataLeaves', 'cost', 'account'] as const) {
        expect(row[field].trim().length, `${row.id}.${field}`).toBeGreaterThan(0);
      }
      expect(BACKUP_STATUSES).toContain(row.backupStatus);
    }
  });

  it('only a gap row may have no backup', () => {
    for (const row of rows) {
      if (row.backupStatus !== 'gap') expect(row.backup, row.id).toBeTruthy();
    }
  });

  it('every gap names a spec that exists, with its plain-English overview and Echo as owner', () => {
    const gaps = rows.filter((row) => row.backupStatus === 'gap');
    expect(gaps.length).toBeGreaterThan(0);
    for (const row of gaps) {
      expect(row.gapSpec, row.id).toBeTruthy();
      const spec = path.join(root, row.gapSpec!);
      expect(fs.existsSync(spec), row.gapSpec).toBe(true);
      expect(fs.existsSync(spec.replace(/\.md$/, '.eli16.md')), `${row.gapSpec} overview`).toBe(true);
      expect(fs.readFileSync(spec, 'utf8')).toMatch(/^author: "echo"$/m);
      expect(row.gapWhen, row.id).toBeTruthy();
    }
  });

  it('an exercised status names a drill test that exists, and nothing else may claim one', () => {
    for (const row of rows) {
      if (row.backupStatus === 'exercised') {
        expect(row.drillTest, row.id).toBeTruthy();
        expect(fs.existsSync(path.join(root, row.drillTest!)), row.drillTest).toBe(true);
      } else {
        expect(row.drillTest, row.id).toBeUndefined();
      }
    }
  });

  it('a service with no proven recipe is unavailable, and none has one yet', () => {
    expect(isServiceAvailable({ ...rows[0], setupRecipe: 'tailscale-v1' })).toBe(true);
    expect(isServiceAvailable({ ...rows[0], setupRecipe: null })).toBe(false);
    // Giving a real service a recipe opens the confirm page to the public and promises setup. Before this
    // may change, rollout step 3 must ship: live proof, and the check that setup messages give the person no
    // other task (the first live run, on 2026-11-04, left real Telegram and a brand-new account still to prove);
    // a route to stop a running service; a way to store a key that keeps it out of the session;
    // the lease question for a machine that can't reach the person; for address services, the owner-only
    // button or the "an address comes first" row; and the confirm page in the CLAUDE.md section. The four
    // questions listed under step 3 bind offers rather than recipes, and are kept here so they can't be missed.
    expect(rows.filter(isServiceAvailable), 'see the comment above before giving a service a recipe').toEqual([]);
  });

  it('a row never gives the person a task', () => {
    const task = /\b(you (need to|must|should|have to)|sign up|visit|click|log in to|open the|run the|paste|download)\b/i;
    for (const row of rows) {
      for (const text of [row.benefit, row.dataLeaves, row.cost, row.account, row.backup ?? '', row.gapWhen ?? '']) {
        expect(text, row.id).not.toMatch(task);
      }
    }
  });
});

describe('outside services on the console', () => {
  const server = (over: Record<string, unknown> = {}) => ({
    service: 'x', name: 'X', benefit: 'A benefit.', dataLeaves: 'Some data.', cost: 'Free.', account: 'An account.', backup: 'Something else.', backupStatus: 'specified',
    choice: 'unset', legacyDeclined: false, available: false, ...over,
  });
  const ok = (services: unknown[]) => ({ ok: true, data: { services } });
  const row = (over: Record<string, unknown>) => buildServices(ok([server(over)])).rows![0];
  const backupLine = (over: Record<string, unknown>) => row(over).lines.find((l: { label: string }) => l.label === 'If you say no')!.text;

  it('says what each row is, from the choice and availability', () => {
    expect(row({}).end).toBe('Not available yet');
    expect(row({ available: true }).end).toBe('Not decided');
    expect(row({ choice: 'yes', available: true }).end).toBe('You said yes');
    expect(row({ choice: 'no' }).end).toBe('You said no');
    expect(row({ legacyDeclined: true }).end).toBe('You said no');
  });

  it('never states a backup as stronger than its status', () => {
    expect(backupLine({})).toContain('not yet proven');
    expect(backupLine({ backupStatus: 'exercised' })).toContain('Proven');
    expect(backupLine({ backupStatus: 'gap', gapWhen: 'Only on one machine.' })).toBe('Something else. Not complete yet. Only on one machine.');
    expect(backupLine({ backupStatus: 'gap', backup: null })).toContain('None yet.');
  });

  it('offers the page wherever this machine can still act, and only then', () => {
    expect(row({}).action).toBeNull();
    expect(row({ available: true }).action.label).toBe('Yes or no');
    expect(row({ available: true }).action.href).toBe('/dashboard/service-yes?service=x');
    // A yes given for another machine, or one a later no cancelled, still needs one here.
    expect(row({ available: true, choice: 'yes', grantedHere: false }).action.label).toBe('Yes or no');
    expect(row({ available: true, choice: 'yes', grantedHere: true }).action.label).toBe('Change my answer');
  });

  it('explains why nothing can be chosen, and drops that once something can', () => {
    expect(buildServices(ok([server()])).note).toMatch(/You don’t need to do anything/);
    expect(buildServices(ok([server({ available: true })])).note).toBeNull();
  });

  it('does not raise a warning dot over something the person has nothing to do about', () => {
    expect(row({ backupStatus: 'gap' })).not.toHaveProperty('tone');
  });

  it('a failed read says it can’t tell, and never shows an empty list', () => {
    expect(buildServices({ ok: false, reason: 'the server answered 503' })).toMatchObject({ ok: false, reason: expect.stringContaining('503') });
    expect(buildServices(undefined).ok).toBe(false);
    expect(buildServices({ ok: true, data: {} }).ok).toBe(false);
  });

  it('shows every row of the real catalog with no blank line', () => {
    const real = rows.map(({ id, setupRecipe: _r, ...text }) => ({ ...text, service: id, choice: 'unset', legacyDeclined: false, available: isServiceAvailable({ id, setupRecipe: null, ...text }) }));
    const built = buildServices(ok(real));
    expect(built.rows).toHaveLength(rows.length);
    for (const r of built.rows!) expect(r.lines).toHaveLength(5);
  });
});
