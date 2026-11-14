import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttributionIdentity } from '../../../src/core/attribution/identity.js';
import { APP_OWNER_ID, checkEligibility, samePerson } from '../../../src/core/attribution/recordEligibility.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('AttributionIdentity', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-id-')); fs.mkdirSync(path.join(dir, 'state')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/attribution/identity.test.ts:cleanup' }); });
  const setOwnerName = () => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ threadline: { ownerName: 'Justin' } }));
  const ctx = { conversation: '1' };

  it('the configured owner id maps to the owner on Telegram, and nobody else does', () => {
    setOwnerName();
    const identity = new AttributionIdentity({ stateDir: dir, configuredOwnerUid: () => 42 });
    expect(identity.map('telegram', '42', ctx)).toBe('Justin');
    expect(identity.map('telegram', '43', ctx)).toBeNull();
  });

  it('with no owner on file the owner path maps nobody', () => {
    setOwnerName();
    expect(new AttributionIdentity({ stateDir: dir }).map('telegram', '42', ctx)).toBeNull();
  });

  it('Slack maps through mobilePairing.slackOwnerUserId, else not at all', () => {
    setOwnerName();
    const identity = new AttributionIdentity({ stateDir: dir, slackOwnerUserId: () => 'U1' });
    expect(identity.map('slack', 'U1', ctx)).toBe('Justin');
    expect(identity.map('slack', 'U2', ctx)).toBeNull();
    expect(new AttributionIdentity({ stateDir: dir }).map('slack', 'U1', ctx)).toBeNull();
  });

  it('a registered user maps on their own channel', () => {
    const users = { resolveFromTelegramUserId: (id: number) => (id === 7 ? { name: 'Sam' } : null), resolveFromSlackUserId: () => null, resolveFromChannel: () => ({ name: 'Sam' }), getUser: () => ({ name: 'Sam' }), listUsers: () => [{ name: 'Sam Lee' }] };
    const identity = new AttributionIdentity({ stateDir: dir, users: () => users as never });
    expect(identity.map('telegram', '7', ctx)).toBe('Sam');
    expect(identity.map('whatsapp', '+1', ctx)).toBe('Sam');
    expect(identity.map('app', 'user-1', ctx)).toBe('Sam');
    expect(identity.knownPeople()).toContain('Sam');
  });

  it('the app owner row maps through the owner name, never by a logged name', () => {
    setOwnerName();
    const identity = new AttributionIdentity({ stateDir: dir });
    expect(identity.map('app', APP_OWNER_ID, ctx)).toBe('Justin');
    const row = { role: 'operator', senderRole: 'owner', senderName: 'Justin' };
    expect(checkEligibility({ channel: 'app', conversation: 'c', row, person: 'Justin', identity: identity.map })).toMatchObject({ eligible: true, strength: 'identity-only' });
    expect(checkEligibility({ channel: 'app', conversation: 'c', row: { role: 'operator', senderName: 'Justin' }, person: 'Justin', identity: identity.map })).toMatchObject({ eligible: false, reason: 'identity-unverified' });
  });

  it('a threadline fingerprint maps to the known agent, never a human it relays', () => {
    fs.mkdirSync(path.join(dir, 'threadline'));
    fs.writeFileSync(path.join(dir, 'threadline', 'known-agents.json'), JSON.stringify({ agents: [{ name: 'Dawn', fingerprint: 'AABB' }] }));
    const identity = new AttributionIdentity({ stateDir: dir });
    expect(identity.map('threadline', 'aabb', ctx)).toBe('Dawn');
    expect(identity.map('threadline', 'ccdd', ctx)).toBeNull();
  });

  it('compares a claim\'s name with an identity by leading words, both sides of the boundary', () => {
    expect(samePerson('Justin', 'Justin Headley')).toBe(true);
    expect(samePerson('justin', 'JUSTIN')).toBe(true);
    expect(samePerson('Headley', 'Justin Headley')).toBe(false);
    expect(samePerson('Dawn', 'Justin')).toBe(false);
    expect(samePerson('', 'Justin')).toBe(false);
  });
});
