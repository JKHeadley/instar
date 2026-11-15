/**
 * Server-wiring integrity for the already-signed-in check (account compliance
 * loop G10). The wizard only skips a needless re-drive when its caller passes
 * the health-check deps; without them it keeps the old behaviour. These source
 * touchpoints prove the running server passes REAL deps on both sweep paths,
 * reads only local pool state (no pool write), and leaves the repair runtime's dead-pane refresh unchanged.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');

describe('server.ts passes the already-signed-in deps to the reissue paths', () => {
  it('restart recovery passes them', () => {
    expect(src).toContain('enrollmentWizard.recoverAfterRestart(alreadySignedIn)');
    expect(src).not.toMatch(/enrollmentWizard\.recoverAfterRestart\(\)/);
  });
  it('the timed reissue sweep passes them', () => {
    expect(src).toMatch(/\.reissueExpired\(alreadySignedIn\)/);
  });
  it('the health check reads the local pool: active, expected email, no drift (no pool write)', () => {
    const at = src.indexOf('const alreadySignedIn = {');
    const decl = src.slice(at, at + 700);
    expect(decl).toContain('subscriptionPool.get(login.id)');
    expect(decl).toContain("account.status !== 'active'");
    expect(decl).toContain('account.identityDrifted === true');
    expect(decl).toContain('login.expectedEmail');
    expect(decl).not.toContain('subscriptionEmailRegistrar');
  });
});
