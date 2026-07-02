/**
 * silent-loss-refusal-conservation §4 — the PostUpdateMigrator boot remediation.
 * Quarantines already-on-disk fixture rows (backup + audit), SKIPS a row with a
 * verifying signed allow-marker, BACK-FILLS the high-water marker when ≥1 real
 * user survives, and is idempotent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { signAllowTestIdentity, loadTestIdentityKey } from '../../src/users/testIdentityMarkers.js';
import { readRegistryHighWater } from '../../src/core/registryHighWater.js';

const dirs: string[] = [];
function tmpState(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'slrc-mig-'));
  dirs.push(base);
  const stateDir = path.join(base, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}
afterEach(() => { for (const d of dirs.splice(0)) try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* ok */ } });

function run(stateDir: string) {
  const migrator = new PostUpdateMigrator({ port: 4042, stateDir, projectDir: path.dirname(stateDir), hasTelegram: false, projectName: 'test' } as any);
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (migrator as any).migrateFixtureIdentityQuarantine(result);
  return result;
}
function usersFile(stateDir: string) { return path.join(stateDir, 'users.json'); }
function readUsers(stateDir: string) { return JSON.parse(fs.readFileSync(usersFile(stateDir), 'utf-8')); }

describe('§4 fixture-identity quarantine migration', () => {
  it('quarantines fixture rows, keeps real users, backs up + audits, and back-fills high-water', () => {
    const stateDir = tmpState();
    fs.writeFileSync(usersFile(stateDir), JSON.stringify([
      { id: 'u-olivia', name: 'x', channels: [], permissions: ['admin'] },
      { id: 'tg-500', name: 'Real', channels: [], permissions: ['user'] },
      { id: 'g3test-abc', name: 'y', channels: [], permissions: ['user'] },
    ]));
    const result = run(stateDir);
    const surviving = readUsers(stateDir);
    expect(surviving.map((u: any) => u.id)).toEqual(['tg-500']);
    // A backup file exists.
    const backups = fs.readdirSync(stateDir).filter((f) => f.includes('fixture-quarantine'));
    expect(backups.length).toBe(1);
    // Audit + back-fill recorded.
    expect(result.upgraded.some((u) => u.includes('quarantined'))).toBe(true);
    expect(readRegistryHighWater(stateDir)).toBe(true);
  });

  it('is idempotent — a re-run over a clean store is a no-op (no new backup)', () => {
    const stateDir = tmpState();
    fs.writeFileSync(usersFile(stateDir), JSON.stringify([{ id: 'u-olivia', name: 'x', channels: [], permissions: [] }, { id: 'tg-1', name: 'r', channels: [], permissions: [] }]));
    run(stateDir);
    const backupsAfter1 = fs.readdirSync(stateDir).filter((f) => f.includes('fixture-quarantine')).length;
    run(stateDir); // second pass — nothing left to quarantine
    const backupsAfter2 = fs.readdirSync(stateDir).filter((f) => f.includes('fixture-quarantine')).length;
    expect(backupsAfter1).toBe(1);
    expect(backupsAfter2).toBe(1); // no new backup
  });

  it('SKIPS a fixture row that carries a VERIFYING signed allow-marker (legitimate collision)', () => {
    const stateDir = tmpState();
    // Provide a machine signing key so loadTestIdentityKey resolves.
    fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'machine', 'signing-key.pem'), 'FAKE-PEM-FOR-TEST\n');
    const key = loadTestIdentityKey(stateDir)!;
    const sig = signAllowTestIdentity(key, 'u-mia', 'u-mia');
    fs.writeFileSync(usersFile(stateDir), JSON.stringify([
      { id: 'u-mia', name: 'Real Mia', channels: [], permissions: ['user'], allowTestIdentity: { marker: 'u-mia', sig } },
      { id: 'u-adam', name: 'x', channels: [], permissions: [] }, // bogus/no marker → quarantined
    ]));
    run(stateDir);
    const surviving = readUsers(stateDir).map((u: any) => u.id);
    expect(surviving).toContain('u-mia');   // legit override kept
    expect(surviving).not.toContain('u-adam'); // fixture quarantined
  });

  it('does NOT back up when there are no fixtures (no-op, no false quarantine)', () => {
    const stateDir = tmpState();
    fs.writeFileSync(usersFile(stateDir), JSON.stringify([{ id: 'tg-9', name: 'r', channels: [], permissions: [] }]));
    run(stateDir);
    const backups = fs.readdirSync(stateDir).filter((f) => f.includes('fixture-quarantine'));
    expect(backups.length).toBe(0);
    // But high-water is still back-filled for the installed base.
    expect(readRegistryHighWater(stateDir)).toBe(true);
  });

  it('leaves a corrupt/unparseable users.json untouched (not this migration\'s job)', () => {
    const stateDir = tmpState();
    fs.writeFileSync(usersFile(stateDir), '{corrupt');
    const result = run(stateDir);
    expect(fs.readFileSync(usersFile(stateDir), 'utf-8')).toBe('{corrupt');
    expect(result.skipped.some((s) => s.includes('parse-failure'))).toBe(true);
  });
});
