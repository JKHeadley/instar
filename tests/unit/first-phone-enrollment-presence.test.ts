import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { firstPhoneEnrollmentLine } from '../../src/core/trustJourney/firstPhoneProposal.js';
import { verifyPresenceSignature } from '../../src/server/mobileConsoleTicket.js';
import { ActionChallengeStore, permissionPresenceMessage } from '../../src/server/mobilePermissionsRoutes.js';
import { makeDevice } from '../helpers/mobileDevice.js';

const nomination = '01234567-89ab-4cde-8fab-012345678901';
const proposal = 'a'.repeat(64);
const disclosure = 'b'.repeat(64);
const deviceId = 'fixture-phone';
const host = 'paired.example';

describe('disposable phone enrollment presence envelope', () => {
  it('produces fixed bytes for a native client', () => {
    const line = firstPhoneEnrollmentLine(nomination, proposal, disclosure)!;
    expect(line).toBe(`first-phone-enrollment-v1 ${nomination} ${proposal} ${disclosure}`);
    const message = permissionPresenceMessage(deviceId, host, 'fixture-challenge', line);
    expect(createHash('sha256').update(message).digest('hex')).toBe('bbaadebd7c5c54cc2d342b7a1afa715edca3bbc17312fad47d19af0426c89427');
    expect(firstPhoneEnrollmentLine('wrong', proposal, disclosure)).toBeNull();
    expect(firstPhoneEnrollmentLine(nomination, 'wrong', disclosure)).toBeNull();
    expect(firstPhoneEnrollmentLine(nomination, proposal, 'wrong')).toBeNull();
  });

  it('keeps the exact signed enrollment separate from ordinary device acceptance', () => {
    const store = new ActionChallengeStore();
    const presence = makeDevice();
    const line = firstPhoneEnrollmentLine(nomination, proposal, disclosure)!;
    const { secret } = store.issue(deviceId, host, line);
    const message = permissionPresenceMessage(deviceId, host, secret, line);
    const signature = presence.sign(message);
    expect(verifyPresenceSignature(presence.publicKey, message, signature)).toBe(true);

    const wrongLine = `accept-device ${deviceId} 0123-4567-89AB-CDEF ${disclosure}`;
    const wrongDisclosure = firstPhoneEnrollmentLine(nomination, proposal, 'c'.repeat(64))!;
    for (const other of [
      permissionPresenceMessage(deviceId, host, secret, wrongLine),
      permissionPresenceMessage(deviceId, host, secret, wrongDisclosure),
      permissionPresenceMessage(deviceId, 'other.example', secret, line),
      permissionPresenceMessage('other-phone', host, secret, line),
    ]) {
      expect(verifyPresenceSignature(presence.publicKey, other, signature)).toBe(false);
    }
    expect(store.consume(secret, deviceId, host, line)).toBe(true);
    expect(store.consume(secret, deviceId, host, line)).toBe(false);
  });
});
