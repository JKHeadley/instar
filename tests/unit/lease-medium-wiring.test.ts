import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync('src/commands/server.ts', 'utf8');

describe('lease medium server wiring', () => {
  it('selects once before debouncer wiring and leaves the backup git instance intact', () => {
    const select = source.indexOf('leaseMedium = selectLeaseMedium({');
    const debounce = source.indexOf('registrySyncDebouncer = new RegistrySyncDebouncer', select);
    expect(select).toBeGreaterThan(-1);
    expect(debounce).toBeGreaterThan(select);
    expect(source).toContain("if (leaseMedium.medium !== 'local')");
    expect(source).toContain("const leaseGitRef = leaseMedium.medium === 'local' ? undefined : gitSyncRef");
    expect(source).not.toContain("gitSync = undefined");
  });

  it('uses leaseGitRef for the store and both durable-authority consumers', () => {
    expect(source).toContain('if (leaseGitRef) {\n          const gs = leaseGitRef;');
    expect(source).toContain('_hasDurableLeaseAuthority = () => !!leaseGitRef');
    expect(source).toContain('if (leaseGitRef) {\n              const read = leaseStore.read()');
  });

  it('reads both live rollback switches through LiveConfig and isolates medium reporting failures', () => {
    expect(source).toContain('createLeaseFlapSwitchGetter(');
    expect(source).toContain("leaseFlapSwitch('unconfirmedWriteAlert')");
    expect(source).toContain('reporting cannot discard an established git substrate');
  });
});
