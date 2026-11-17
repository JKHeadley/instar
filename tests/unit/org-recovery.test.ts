/** The organization recovery copy (docs/specs/org-members-and-keepers.md §E, Acceptance 3). */
import { describe, it, expect } from 'vitest';
import { makeRecoveryCopy, newRecoveryPhrase, normalizePhrase, openRecoveryCopy, RECOVERY_WORDS } from '../../src/core/OrgRecovery.js';

const header = { orgId: 'org_AAAAAAAAAAAAAAAAAAAA', orgName: 'Monroe Institute', fingerprint: 'A1B2-C3D4-E5F6-0718-293A' };
const contents = { privateKeyPem: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n', bundle: { record: { version: 7 } }, registries: { members: { k: { agentName: 'Wren' } } }, selfMemberKey: 'self-key' };

describe('recovery copy', () => {
  it('a phrase is six list words; spacing and case are ignored on the way back', () => {
    const p = newRecoveryPhrase();
    expect(p.split(' ')).toHaveLength(RECOVERY_WORDS);
    expect(normalizePhrase(`  ${p.toUpperCase().replace(/ /g, '   ')} `)).toBe(p);
  });

  it('round-trips with the phrase and refuses any other', () => {
    const phrase = newRecoveryPhrase();
    const file = makeRecoveryCopy(header, contents, phrase);
    expect(JSON.stringify(file)).not.toContain('PRIVATE KEY');
    const back = openRecoveryCopy(JSON.parse(JSON.stringify(file)), phrase.toUpperCase());
    expect(back).toEqual({ ok: true, contents });
    expect(openRecoveryCopy(file, newRecoveryPhrase())).toEqual({ ok: false, error: 'wrong-phrase' });
  }, 30000);

  it('a changed header or cost setting is refused', () => {
    const phrase = newRecoveryPhrase();
    const file = makeRecoveryCopy(header, contents, phrase);
    expect(openRecoveryCopy({ ...file, orgName: 'Someone Else' }, phrase)).toEqual({ ok: false, error: 'wrong-phrase' });
    expect(openRecoveryCopy({ ...file, kdf: { ...file.kdf, N: 2 ** 30 } }, phrase)).toEqual({ ok: false, error: 'malformed' });
    expect(openRecoveryCopy({ v: 2 }, phrase)).toEqual({ ok: false, error: 'malformed' });
    expect(openRecoveryCopy({ ...file, nonce: Buffer.alloc(8).toString('base64') }, phrase)).toEqual({ ok: false, error: 'malformed' });
    const noSelf = makeRecoveryCopy(header, { privateKeyPem: contents.privateKeyPem, bundle: null, registries: {} } as never, phrase);
    expect(openRecoveryCopy(noSelf, phrase)).toEqual({ ok: false, error: 'malformed' });
  }, 30000);

  it('a copy with registries at their limits (multi-byte names) round-trips', () => {
    const phrase = newRecoveryPhrase();
    const removed: Record<string, object> = {};
    for (let i = 0; i < 15_500; i++) removed[`key-${i}-${'x'.repeat(60)}`] = { agentName: 'é'.repeat(120), personName: '名'.repeat(120), appliedVersion: 3, state: 'removed', firstSeen: 1, lastSeen: 2, lastAt: 3, checkins: 9, removal: { id: '0123456789abcdef', at: 4 } };
    const big = { ...contents, registries: { members: removed } };
    const back = openRecoveryCopy(makeRecoveryCopy(header, big, phrase), phrase);
    expect(back.ok).toBe(true);
  }, 30000);
});
