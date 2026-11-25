import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createConversationGraphSoloOwnership } from '../../src/server/ConversationGraphSoloOwnership.js';
import { ownedGraphInstalledRoster } from '../../src/core/OwnedGraphCustody.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

vi.mock('../../src/core/OwnedGraphCustody.js', () => ({ ownedGraphInstalledRoster: vi.fn() }));

it('reads only a durable active topic under current one-member custody', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-solo-custody-'));
  try {
    const member = { machineId: 'local', signingPublicKey: 'signing', sealingPublicKey: 'sealing' };
    const roster = vi.mocked(ownedGraphInstalledRoster);
    roster.mockReturnValue([member]);
    const holdsLease = vi.fn(() => true);
    const revalidate = vi.fn(() => true);
    const options = {
      state: { baseDir: stateDir }, runtime: { installedMembership: { members: [member] } },
      identity: { loadIdentity: () => member }, identities: {},
      instanceLock: { revalidate }, coordinator: { holdsLease, currentLease: () => ({ holder: 'local' }) },
      admission: { evaluate: () => ({ admit: true }) }, telegramChatId: 'chat',
    } as unknown as Parameters<typeof createConversationGraphSoloOwnership>[0];
    const authority = createConversationGraphSoloOwnership(options);

    expect(authority.readActive('12')).toBeUndefined();
    expect(authority.readActive('../other')).toBeUndefined();
    authority.establish([{ kind: 'conversation', platform: 'telegram', chatId: 'chat', topicId: 12 }]);
    expect(authority.readActive('12')).toEqual({
      machineId: 'local', ownerEpoch: authority.registry.read('12')?.ownershipEpoch,
    });

    holdsLease.mockReturnValue(false);
    expect(authority.readActive('12')).toBeUndefined();
    holdsLease.mockReturnValue(true);
    revalidate.mockReturnValue(false);
    expect(authority.readActive('12')).toBeUndefined();
    revalidate.mockReturnValue(true);
    roster.mockReturnValue([member, { ...member, machineId: 'peer' }]);
    expect(authority.readActive('12')).toBeUndefined();
    roster.mockReturnValue([member]);

    const recordPath = path.join(stateDir, 'ownership', 'local', '12.json');
    const current = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    fs.writeFileSync(recordPath, JSON.stringify({ ...current, ownershipEpoch: 1.5 }));
    expect(createConversationGraphSoloOwnership(options).readActive('12')).toBeUndefined();
    fs.writeFileSync(recordPath, '{}');
    expect(authority.readActive('12')).toBeUndefined();
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'solo-ownership-test' });
  }
});
