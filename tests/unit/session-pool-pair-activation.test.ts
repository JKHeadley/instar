import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  POOL_ACTIVATION_KEYS, activatedAtPairing, applyPairActivationKeys, decidePairActivation, finishInviterPairActivation,
} from '../../src/core/sessionPoolPairActivation.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
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
    const marked = applyPairActivationKeys({}, NOW, 'inviter', 'm_joiner');
    expect(decide(marked, ['m_joiner'])).toEqual({ activate: true, reason: 're-pair' });
    expect(decide(marked, ['m_joiner'], 'm_stranger').activate).toBe(false);
    expect(decide(marked, ['m_joiner', 'm_third']).activate).toBe(false);
  });
});

describe('applyPairActivationKeys', () => {
  const read = (root: unknown, dotted: string) =>
    dotted.split('.').reduce<any>((v, k) => v?.[k], root);

  it('every key lands, over the defaults already on disk', () => {
    const out = applyPairActivationKeys(shipped(), NOW, 'inviter', 'm_joiner');
    for (const [dotted, value] of POOL_ACTIVATION_KEYS) expect(read(out, dotted)).toEqual(value);
    expect(activatedAtPairing(out)).toBe(true);
  });
  it('every key names a setting that exists, except those shipped unset', () => {
    const unset = new Set(['multiMachine.coherenceJournal.replication.enabled',
      'multiMachine.sessionPool.duplicateReconciler.enabled', 'multiMachine.pollFollowsLease.enabled', 'multiMachine.pollFollowsLease.dryRun', 'multiMachine.leaseSelfHeal.soloCaptainHold.requireLastingLink']);
    for (const [dotted] of POOL_ACTIVATION_KEYS) {
      if (!unset.has(dotted)) expect(read(shipped(), dotted), dotted).toBeDefined();
    }
  });
  it('a first pairing turns the takeover switch on, and shipped config has it off', () => {
    expect(read(shipped(), 'multiMachine.leaseSelfHeal.soloCaptainHold.enabled')).toBe(false);
    expect(read(applyPairActivationKeys(shipped(), NOW, 'inviter', 'm_joiner'), 'multiMachine.leaseSelfHeal.soloCaptainHold.enabled')).toBe(true);
  });
  it('a first pairing requires a lasting link and names each side, and shipped config has neither', () => {
    const key = 'multiMachine.leaseSelfHeal.soloCaptainHold';
    expect(read(shipped(), `${key}.requireLastingLink`)).toBeUndefined();
    expect(read(shipped(), `${key}.pairRole`)).toBeUndefined();
    expect(read(shipped(), `${key}.pairedWith`)).toBeUndefined();
    expect(read(applyPairActivationKeys(shipped(), NOW, 'inviter', 'm_joiner'), `${key}.requireLastingLink`)).toBe(true);
    expect(read(applyPairActivationKeys(shipped(), NOW, 'inviter', 'm_joiner'), `${key}.pairRole`)).toBe('inviter');
    expect(read(applyPairActivationKeys(shipped(), NOW, 'joiner', 'm_inviter'), `${key}.pairRole`)).toBe('joiner');
    expect(read(applyPairActivationKeys(shipped(), NOW, 'joiner', 'm_inviter'), `${key}.pairedWith`)).toBe('m_inviter');
  });
  it('sibling settings are kept', () => {
    const out = applyPairActivationKeys({ multiMachine: { sessionPool: { inboundQueue: { maxTotal: 9 } } } }, NOW, 'inviter', 'm_joiner') as any;
    expect(out.multiMachine.sessionPool.inboundQueue.maxTotal).toBe(9);
  });
  it('a joiner starts dark under the ceiling whatever its home held', () => {
    const out = applyPairActivationKeys(
      { multiMachine: { sessionPool: { stage: 'live-transfer', promotionCeiling: 'rebalance' } } }, NOW, 'inviter',
    ) as any;
    expect(out.multiMachine.sessionPool.stage).toBeUndefined();
    expect(out.multiMachine.sessionPool.promotionCeiling).toBe('shadow');
  });
  it('does not change the object it was given', () => {
    const input = {};
    applyPairActivationKeys(input, NOW, 'inviter', 'm_joiner');
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
  it('carries who the bot answers, and a machine with no list stays without one', () => {
    const withPeople = sealTelegramHandover({ ...binding, botToken: 'bot:token', chatId: '-100', authorizedUserIds: [123, '456'], ownerUserId: 123, joinerEncryptionPublicKey: publicKey, now });
    expect(openTelegramHandover({ sealed: withPeople, expected: binding, encryptionPrivateKeyPem: privatePem, now }))
      .toEqual({ ok: true, botToken: 'bot:token', chatId: '-100', authorizedUserIds: [123, '456'], ownerUserId: 123 });
    const emptyList = sealTelegramHandover({ ...binding, botToken: 'bot:token', chatId: '-100', authorizedUserIds: [], joinerEncryptionPublicKey: publicKey, now });
    expect(openTelegramHandover({ sealed: emptyList, expected: binding, encryptionPrivateKeyPem: privatePem, now }))
      .toEqual({ ok: true, botToken: 'bot:token', chatId: '-100' });
  });
  it.each([
    ['a list that is not a list', { authorizedUserIds: '123' }],
    ['a list holding something other than ids', { authorizedUserIds: [123, 'everyone'] }],
    ['an owner that is not an id', { ownerUserId: { id: 1 } }],
  ])('%s is refused, because no list means everyone', (_label, bad) => {
    const forged = sealTelegramHandover({ ...binding, botToken: 'bot:token', chatId: '-100', ...(bad as object), joinerEncryptionPublicKey: publicKey, now });
    expect(openTelegramHandover({ sealed: forged, expected: binding, encryptionPrivateKeyPem: privatePem, now }))
      .toEqual({ ok: false, refusal: 'malformed' });
  });
  it('an unset owner written as null is treated as unset, as the adapter treats it', () => {
    const sealedNull = sealTelegramHandover({ ...binding, botToken: 'bot:token', chatId: '-100', ownerUserId: null, joinerEncryptionPublicKey: publicKey, now });
    expect(openTelegramHandover({ sealed: sealedNull, expected: binding, encryptionPrivateKeyPem: privatePem, now }))
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

describe('a pairing whose activation fails', () => {
  it('still completes, and reports that sharing did not turn on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-act-'));
    const stateDir = path.join(dir, 'a-file');
    fs.writeFileSync(stateDir, 'not a directory');
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = finishInviterPairActivation({
        stateDir, decision: { activate: true, reason: 'first-pairing' } as never, telegram: null,
        pairingSessionId: 'code-1', joinerMachineId: 'm_joiner', joinerEncryptionPublicKey: 'k', now: new Date(NOW),
      });
      expect(out).toEqual({ response: {}, restart: false });
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ feature: 'sessionPool.pairActivation' }));
    } finally {
      vi.restoreAllMocks();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/session-pool-pair-activation.test.ts:cleanup' });
    }
  });
});

describe('the reply script on a joined machine', () => {
  it('lands in both script folders, runnable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-relay-'));
    try {
      const { installTelegramRelayForJoinedMachine } = await import('../../src/commands/init.js');
      installTelegramRelayForJoinedMachine(dir, path.join(dir, '.instar'), 4567);
      for (const p of ['.claude/scripts/telegram-reply.sh', '.instar/scripts/telegram-reply.sh']) {
        const full = path.join(dir, p);
        expect(fs.statSync(full).mode & 0o111).not.toBe(0);
        expect(fs.readFileSync(full, 'utf-8').startsWith('#!')).toBe(true);
      }
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/session-pool-pair-activation.test.ts:relay' });
    }
  });
});
