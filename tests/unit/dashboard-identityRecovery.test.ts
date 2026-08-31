import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, '../../dashboard/index.html'), 'utf8');

describe('dashboard machine identity recovery card', () => {
  it('is reachable from the Machines tab and polls the recovery status route', () => {
    expect(html).toContain('id="identityRecoveryStatus"');
    expect(html).toContain("apiFetch('/identity-recovery')");
    expect(html).toContain('await loadIdentityRecoveryStatus()');
  });

  it('PIN-gates rotation, approve, deny, and acknowledgement while first establishment stays pairing-only', () => {
    expect(html).toContain("'X-Instar-Operator-Session': operatorSessionToken");
    expect(html).toContain("'/identity-recovery/quarantines/'");
    expect(html).toContain("base + '/approval-token'");
    expect(html).toContain('approvalToken: proof.approvalToken');
    expect(html).toContain("'/identity-recovery/rotations/'");
    expect(html).not.toContain("identityRecoveryAction('/identity-recovery/establish')");
    expect(html).toContain('Run machine pairing to establish this first root at peers.');
    expect(html).toContain("identityRecoveryAction('/identity-recovery/rotate')");
  });

  it('renders peer-controlled fields through textContent and provides a mobile action layout', () => {
    expect(html).toContain("text.textContent = 'Quarantined identity claim for '");
    expect(html).toContain("'; current key '");
    expect(html).toContain("'; proposed key '");
    expect(html).toContain("'; claim '");
    expect(html).toContain('.identity-recovery-actions button');
  });
});
