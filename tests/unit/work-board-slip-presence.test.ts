import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { permissionPresenceMessage } from '../../src/server/mobilePermissionsRoutes.js';

import { workBoardSlipApprovalLine } from '../../src/core/workBoardSlipPresence.js';

const slipId = '11111111-2222-4333-8444-555555555555';
const disclosureDigest = 'a'.repeat(64);
const actionBindingDigest = 'b'.repeat(64);

describe('Work Board slip presence bytes', () => {
  it('matches the shared iPhone fixture using the existing presence encoder', () => {
    const line = workBoardSlipApprovalLine(slipId, disclosureDigest, actionBindingDigest);
    expect(line).toBe(`work-board-slip-approve:v1 ${slipId} ${disclosureDigest} ${actionBindingDigest}`);
    const bytes = permissionPresenceMessage('device-fixture-1', 'AGENT.TEST', 'fixture-challenge', line!);
    expect(createHash('sha256').update(bytes, 'utf8').digest('hex'))
      .toBe('1590148d1acead0863d7555c4331ad6effcb4334dc54c3308af45cf40d1296a1');
  });

  it.each([
    [`${slipId}\n`, disclosureDigest, actionBindingDigest],
    [slipId, `${disclosureDigest.slice(1)}\n`, actionBindingDigest],
    [slipId, disclosureDigest, actionBindingDigest.toUpperCase()],
    [slipId, disclosureDigest, null],
    [slipId, disclosureDigest, ` ${actionBindingDigest}`],
  ])('rejects ambiguous or noncanonical inputs', (id, disclosure, binding) => {
    expect(workBoardSlipApprovalLine(id, disclosure, binding)).toBeNull();
  });
});
