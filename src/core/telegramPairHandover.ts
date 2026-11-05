/**
 * Carrying the bot token to a joiner inside the pairing response
 * (docs/specs/session-pool-activation-at-pairing.md, Change 3).
 *
 * `encryptForSync` authenticates only what it encrypts, so the binding lives inside the
 * sealed payload and the joiner checks it against what it sent. An outer transcript
 * could be rewritten around a replayed ciphertext.
 */
import { createPrivateKey } from 'node:crypto';
import { decryptFromSync, encryptForSync, type EncryptedSecretPayload } from './SecretStore.js';

export const TELEGRAM_HANDOVER_TTL_MS = 10 * 60_000;

export interface TelegramHandoverBinding {
  pairingSessionId: string;
  joinerMachineId: string;
}

interface SealedTelegramHandover extends TelegramHandoverBinding {
  botToken: string;
  chatId: string;
  expiresAt: string;
}

export function sealTelegramHandover(input: TelegramHandoverBinding & {
  botToken: string;
  chatId: string;
  joinerEncryptionPublicKey: string;
  now: Date;
}): EncryptedSecretPayload {
  const payload: SealedTelegramHandover = {
    botToken: input.botToken,
    chatId: input.chatId,
    pairingSessionId: input.pairingSessionId,
    joinerMachineId: input.joinerMachineId,
    expiresAt: new Date(input.now.getTime() + TELEGRAM_HANDOVER_TTL_MS).toISOString(),
  };
  return encryptForSync(payload as unknown as Parameters<typeof encryptForSync>[0], input.joinerEncryptionPublicKey);
}

export type TelegramHandoverRefusal = 'undecryptable' | 'malformed' | 'binding-mismatch' | 'expired';

export function openTelegramHandover(input: {
  sealed: EncryptedSecretPayload;
  expected: TelegramHandoverBinding;
  encryptionPrivateKeyPem: string;
  now: Date;
}): { ok: true; botToken: string; chatId: string } | { ok: false; refusal: TelegramHandoverRefusal } {
  let opened: Partial<SealedTelegramHandover>;
  try {
    opened = decryptFromSync(input.sealed, createPrivateKey(input.encryptionPrivateKeyPem)) as Partial<SealedTelegramHandover>;
  } catch {
    // @silent-fallback-ok — the caller reports the named refusal and writes no Telegram entry.
    return { ok: false, refusal: 'undecryptable' };
  }
  if (typeof opened?.botToken !== 'string' || !opened.botToken || typeof opened.chatId !== 'string' || !opened.chatId) {
    return { ok: false, refusal: 'malformed' };
  }
  if (opened.pairingSessionId !== input.expected.pairingSessionId || opened.joinerMachineId !== input.expected.joinerMachineId) {
    return { ok: false, refusal: 'binding-mismatch' };
  }
  const expiry = Date.parse(String(opened.expiresAt));
  if (!Number.isFinite(expiry) || expiry <= input.now.getTime()) return { ok: false, refusal: 'expired' };
  return { ok: true, botToken: opened.botToken, chatId: opened.chatId };
}
