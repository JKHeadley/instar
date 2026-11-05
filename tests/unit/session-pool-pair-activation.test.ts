import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  POOL_ACTIVATION_KEYS, activatedAtPairing, applyPairActivationKeys, decidePairActivation,
} from '../../src/core/sessionPoolPairActivation.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { openTelegramHandover, sealTelegramHandover, TELEGRAM_HANDOVER_TTL_MS } from '../../src/core/telegramPairHandover.js';

const NOW = '2026-11-05T01:00:00.000Z';
const decide = (fileConfig: unknown, otherMachineIds: string[] = [], joinerMachineId = 'm_joiner') =>
  decidePairActivation({ fileConfig, otherMachineIds, joinerMachineId });

/** What a real agent's file holds: update writes the shipped defaults into it. */
const shipped = () => {
  const config: Record<string, unknown> = {};
  applyDefaults(config, getMigrationDefaults('claude-code' as never));
  return config;
};

describe('decidePairActivation', () => {
  it('a first pairing activates, on the config a real agent has', () => {
    expect((shipped() as any).multiMachine.sessionPool.enabled).toBe(false);
    expect(decide(shipped())).toEqual({ activate: true, reason: 'first-pairing' });
    expect(decide({})).toEqual({ activate: true, reason: 'first-pairing' });
  });
  it('a machine already known, revoked ones included, is not a first pairing', () => {
    expect(decide({}, ['m_revoked']).activate).toBe(false);
  });
  it.each([
    ['enabled', true], ['stage', 'shadow'], ['promotionModel', 'operator'], ['promotionCeiling', 'live-transfer'],
    ['autoActivate', false],
  ])('%s = %s is the owner\'s choice', (key, value) => {
    const config = shipped() as any;
    config.multiMachine.sessionPool[key] = value;
    expect(decide(config)).toEqual({ activate: false, reason: 'owner-choice' });
  });
  it('unrelated pool settings are not a choice about sharing', () => {
    expect(decide({ multiMachine: { sessionPool: { inboundQueue: { maxTotal: 9 } } } }).activate).toBe(true);
  });
  it('the money layer on declines, since sharing would stop paid routing', () => {
    expect(decide({ routingSpend: { money: { enabled: true } } })).toEqual({ activate: false, reason: 'money-layer-on' });
  });
  it('the same machine pairing again re-sends; any other machine does not', () => {
    const marked = applyPairActivationKeys({}, NOW);
    expect(decide(marked, ['m_joiner'])).toEqual({ activate: true, reason: 're-pair' });
    expect(decide(marked, ['m_joiner'], 'm_stranger').activate).toBe(false);
    expect(decide(marked, ['m_joiner', 'm_third']).activate).toBe(false);
  });
});

describe('applyPairActivationKeys', () => {
  const read = (root: unknown, dotted: string) =>
    dotted.split('.').reduce<any>((v, k) => v?.[k], root);

  it('every key lands, over the defaults already on disk', () => {
    const out = applyPairActivationKeys(shipped(), NOW);
    for (const [dotted, value] of POOL_ACTIVATION_KEYS) expect(read(out, dotted)).toEqual(value);
    expect(activatedAtPairing(out)).toBe(true);
  });
  it('every key names a setting that exists, except those shipped unset', () => {
    const unset = new Set(['multiMachine.coherenceJournal.replication.enabled',
      'multiMachine.sessionPool.duplicateReconciler.enabled', 'multiMachine.pollFollowsLease.enabled', 'multiMachine.pollFollowsLease.dryRun']);
    for (const [dotted] of POOL_ACTIVATION_KEYS) {
      if (!unset.has(dotted)) expect(read(shipped(), dotted), dotted).toBeDefined();
    }
  });
  it('sibling settings are kept', () => {
    const out = applyPairActivationKeys({ multiMachine: { sessionPool: { inboundQueue: { maxTotal: 9 } } } }, NOW) as any;
    expect(out.multiMachine.sessionPool.inboundQueue.maxTotal).toBe(9);
  });
  it('a joiner starts dark under the ceiling whatever its home held', () => {
    const out = applyPairActivationKeys(
      { multiMachine: { sessionPool: { stage: 'live-transfer', promotionCeiling: 'rebalance' } } }, NOW,
    ) as any;
    expect(out.multiMachine.sessionPool.stage).toBeUndefined();
    expect(out.multiMachine.sessionPool.promotionCeiling).toBe('shadow');
  });
  it('does not change the object it was given', () => {
    const input = {};
    applyPairActivationKeys(input, NOW);
    expect(input).toEqual({});
  });
  it('activation carries no secret sync', () => {
    expect(POOL_ACTIVATION_KEYS.some(([k]) => k.includes('secretSync'))).toBe(false);
  });
});

describe('telegram handover', () => {
  const pair = crypto.generateKeyPairSync('x25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const binding = { pairingSessionId: 'code-1', joinerMachineId: 'm_joiner' };
  const now = new Date(NOW);
  const sealed = () => sealTelegramHandover({ ...binding, botToken: 'bot:token', chatId: '-100', joinerEncryptionPublicKey: publicKey, now });

  it('round trips for the machine it was sealed to', () => {
    expect(openTelegramHandover({ sealed: sealed(), expected: binding, encryptionPrivateKeyPem: privatePem, now }))
      .toEqual({ ok: true, botToken: 'bot:token', chatId: '-100' });
  });
  it('the token is not readable in the envelope', () => {
    expect(JSON.stringify(sealed())).not.toContain('bot:token');
  });
  it('a replay to another pairing or machine is refused', () => {
    for (const expected of [{ ...binding, pairingSessionId: 'code-2' }, { ...binding, joinerMachineId: 'm_other' }]) {
      expect(openTelegramHandover({ sealed: sealed(), expected, encryptionPrivateKeyPem: privatePem, now }))
        .toEqual({ ok: false, refusal: 'binding-mismatch' });
    }
  });
  it('an old handover is refused', () => {
    const later = new Date(now.getTime() + TELEGRAM_HANDOVER_TTL_MS + 1);
    expect(openTelegramHandover({ sealed: sealed(), expected: binding, encryptionPrivateKeyPem: privatePem, now: later }))
      .toEqual({ ok: false, refusal: 'expired' });
  });
  it('another key cannot open it', () => {
    const other = crypto.generateKeyPairSync('x25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(openTelegramHandover({ sealed: sealed(), expected: binding, encryptionPrivateKeyPem: other, now }))
      .toEqual({ ok: false, refusal: 'undecryptable' });
  });
});
