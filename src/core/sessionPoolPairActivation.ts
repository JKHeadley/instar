/**
 * Turning sharing on at an agent's first pairing
 * (docs/specs/session-pool-activation-at-pairing.md).
 *
 * The decision and the key list live here so both machines write the same thing. The
 * pairing response carries only a version, never values, so a response cannot hand a
 * joiner arbitrary config.
 */
import fs from 'node:fs';
import path from 'node:path';
import { migrateSecrets } from './SecretMigrator.js';
import type { EncryptedSecretPayload } from './SecretStore.js';
import {
  openTelegramHandover, sealTelegramHandover, type TelegramHandoverBinding, type TelegramHandoverRefusal,
} from './telegramPairHandover.js';

export const PAIR_ACTIVATION_VERSION = 1;

/**
 * Update writes the shipped defaults into every agent's config, so `enabled:false` and
 * `stage:'dark'` are on disk whether or not anyone chose them. A choice is a value that
 * differs from those defaults, or the explicit `autoActivate:false` opt-out.
 */
const SHIPPED_POOL_DEFAULTS: Readonly<Record<string, unknown>> = {
  enabled: false, stage: 'dark', promotionModel: 'off', promotionCeiling: 'dark',
};

export type PairActivationDecision =
  | { activate: true; reason: 'first-pairing' | 're-pair' }
  | { activate: false; reason: 'not-first-pairing' | 'owner-choice' | 'money-layer-on' };

type Json = Record<string, unknown>;

function at(root: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Json)[k] : undefined), root);
}

/** True when this pool was started by a pairing; the newer behaviours run only then. */
export function activatedAtPairing(config: unknown): boolean {
  return typeof at(config, 'multiMachine', 'sessionPool', 'activatedAtPairing') === 'string';
}

/**
 * Decide before the joiner is stored, so `otherMachineIds` is every registry entry other
 * than this machine, revoked ones included, and does not yet hold a new joiner.
 */
export function decidePairActivation(input: {
  fileConfig: unknown;
  otherMachineIds: readonly string[];
  joinerMachineId: string;
}): PairActivationDecision {
  const { fileConfig, otherMachineIds, joinerMachineId } = input;
  // The same machine pairing again is how a failed token handover recovers. A valid
  // pairing code is still required, and any other machine counts as a third.
  if (activatedAtPairing(fileConfig)) {
    return otherMachineIds.length === 1 && otherMachineIds[0] === joinerMachineId
      ? { activate: true, reason: 're-pair' }
      : { activate: false, reason: 'not-first-pairing' };
  }
  if (otherMachineIds.length > 0) return { activate: false, reason: 'not-first-pairing' };
  const pool = at(fileConfig, 'multiMachine', 'sessionPool');
  const chose = at(pool, 'autoActivate') === false
    || Object.entries(SHIPPED_POOL_DEFAULTS).some(([k, shipped]) => at(pool, k) !== undefined && at(pool, k) !== shipped);
  if (chose) return { activate: false, reason: 'owner-choice' };
  if (at(fileConfig, 'routingSpend', 'money', 'enabled') === true) return { activate: false, reason: 'money-layer-on' };
  return { activate: true, reason: 'first-pairing' };
}

/** The only list of keys. `activatedAtPairing` is added by `applyPairActivationKeys`. */
export const POOL_ACTIVATION_KEYS: ReadonlyArray<readonly [path: string, value: unknown]> = [
  ['multiMachine.sessionPool.enabled', true],
  ['multiMachine.sessionPool.dryRun', false],
  ['multiMachine.sessionPool.promotionModel', 'auto-climb'],
  ['multiMachine.sessionPool.promotionCeiling', 'shadow'],
  ['multiMachine.sessionPool.inboundQueue.enabled', true],
  ['multiMachine.sessionPool.inboundQueue.dryRun', false],
  ['multiMachine.sessionPool.duplicateReconciler.enabled', true],
  ['multiMachine.coherenceJournal.replication.enabled', true],
  ['multiMachine.pollFollowsLease.enabled', true],
  ['multiMachine.pollFollowsLease.dryRun', false],
];

function setPath(root: Json, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let node = root;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part] as Json;
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * Same result on both machines. Values are overwritten because the defaults are already
 * on disk and the decision has ruled out a choice. `stage` is removed so a joiner starts
 * dark under the `shadow` ceiling whatever its home held.
 */
export function applyPairActivationKeys(fileConfig: Json, nowIso: string): Json {
  const next = structuredClone(fileConfig);
  for (const [dotted, value] of POOL_ACTIVATION_KEYS) setPath(next, dotted, value);
  setPath(next, 'multiMachine.sessionPool.activatedAtPairing', nowIso);
  delete ((next.multiMachine as Json).sessionPool as Json).stage;
  return next;
}

/** Temp file and rename, so a crash mid-write cannot leave a half-written config. */
export function writeConfigAtomic(configPath: string, config: Json): void {
  const temp = `${configPath}.pair-activation.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, configPath);
}

const decisionPath = (stateDir: string) => path.join(stateDir, 'state', 'pool-pair-activation.json');

/** Read by the readiness report, so a declined activation says why. */
export function readPairDecision(stateDir: string): (PairActivationDecision & { at: string }) | null {
  try {
    return JSON.parse(fs.readFileSync(decisionPath(stateDir), 'utf-8'));
  } catch {
    return null; // @silent-fallback-ok — no pairing has been decided on this machine
  }
}

function recordPairDecision(stateDir: string, decision: PairActivationDecision, nowIso: string): void {
  fs.mkdirSync(path.dirname(decisionPath(stateDir)), { recursive: true });
  fs.writeFileSync(decisionPath(stateDir), JSON.stringify({ ...decision, at: nowIso }, null, 2));
}

export type InviterPairResponse = {
  sessionPoolActivation?: { version: number };
  telegramHandover?: EncryptedSecretPayload;
};

/** Called before the joiner is stored. A fault here must never fail the pairing itself. */
export function decideInviterPairActivation(input: {
  stateDir: string;
  otherMachineIds: readonly string[];
  joinerMachineId: string;
}): PairActivationDecision | null {
  try {
    const fileConfig = JSON.parse(fs.readFileSync(path.join(input.stateDir, 'config.json'), 'utf-8'));
    return decidePairActivation({ ...input, fileConfig });
  } catch (err) {
    console.warn('[pair] sharing was not turned on; could not read this machine\'s config:', err);
    return null;
  }
}

/**
 * Called after the joiner is stored. On a first pairing it writes the keys; a re-pair only
 * sends the handover again. Returns what to add to the response and whether to restart.
 */
export function finishInviterPairActivation(input: {
  stateDir: string;
  decision: PairActivationDecision;
  telegram: { botToken: string; chatId: string } | null;
  pairingSessionId: string;
  joinerMachineId: string;
  joinerEncryptionPublicKey: string;
  now: Date;
}): { response: InviterPairResponse; restart: boolean } {
  const { stateDir, decision, telegram, now } = input;
  const nowIso = now.toISOString();
  try {
    recordPairDecision(stateDir, decision, nowIso);
    if (!decision.activate) {
      console.log(`[pair] sharing stays off: ${decision.reason}`);
      return { response: {}, restart: false };
    }
    const first = decision.reason === 'first-pairing';
    if (first) {
      const configPath = path.join(stateDir, 'config.json');
      writeConfigAtomic(configPath, applyPairActivationKeys(JSON.parse(fs.readFileSync(configPath, 'utf-8')), nowIso));
    }
    const telegramHandover = telegram ? sealTelegramHandover({
      ...telegram,
      pairingSessionId: input.pairingSessionId,
      joinerMachineId: input.joinerMachineId,
      joinerEncryptionPublicKey: input.joinerEncryptionPublicKey,
      now,
    }) : undefined;
    return {
      response: { sessionPoolActivation: { version: PAIR_ACTIVATION_VERSION }, ...(telegramHandover ? { telegramHandover } : {}) },
      restart: first,
    };
  } catch (err) {
    console.warn('[pair] sharing was not turned on:', err);
    return { response: {}, restart: false };
  }
}

/** The inviter reads activation at boot, so it restarts once the joiner has its answer. */
export function requestPairActivationRestart(stateDir: string, now: Date): void {
  const flagPath = path.join(stateDir, 'state', 'restart-requested.json');
  fs.mkdirSync(path.dirname(flagPath), { recursive: true });
  const temp = `${flagPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({
    requestedAt: now.toISOString(),
    requestedBy: 'session-pool-activation',
    reason: 'sharing turned on at the first pairing',
    plannedRestart: true,
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    pid: process.pid,
  }, null, 2));
  fs.renameSync(temp, flagPath);
}

/**
 * The joiner's half, run before its server first starts. The pool keys are written whether
 * or not the token opens: a machine without it cannot serve, hands messages back, and
 * readiness keeps the pair dark until the owner pairs it again.
 */
export function applyJoinerPairActivation(input: {
  configPath: string;
  stateDir: string;
  response: InviterPairResponse;
  binding: TelegramHandoverBinding;
  encryptionPrivateKeyPem: string | null;
  now: Date;
}): { activated: boolean; telegram: 'written' | 'not-offered' | 'kept-existing' | TelegramHandoverRefusal | 'no-key' } {
  const { configPath, stateDir, response, now } = input;
  if (response.sessionPoolActivation?.version !== PAIR_ACTIVATION_VERSION) return { activated: false, telegram: 'not-offered' };
  // Pairing again only resends the token: anything the owner changed here since stands.
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Json;
  const config = activatedAtPairing(onDisk) ? onDisk : applyPairActivationKeys(onDisk, now.toISOString());
  let telegram: 'written' | 'not-offered' | 'kept-existing' | TelegramHandoverRefusal | 'no-key' = 'not-offered';
  if (response.telegramHandover) {
    const messaging = Array.isArray(config.messaging) ? config.messaging as Json[] : [];
    if (messaging.some((m) => m?.type === 'telegram')) telegram = 'kept-existing';
    else if (!input.encryptionPrivateKeyPem) telegram = 'no-key';
    else {
      const opened = openTelegramHandover({
        sealed: response.telegramHandover,
        expected: input.binding,
        encryptionPrivateKeyPem: input.encryptionPrivateKeyPem,
        now,
      });
      if (opened.ok) {
        config.messaging = [...messaging, {
          type: 'telegram',
          enabled: true,
          config: { token: opened.botToken, chatId: opened.chatId, pollIntervalMs: 2000, stallTimeoutMinutes: 5 },
        }];
        telegram = 'written';
      } else telegram = opened.refusal;
    }
  }
  writeConfigAtomic(configPath, config);
  // Moves the literal token into the encrypted store straight away.
  if (telegram === 'written') migrateSecrets(configPath, stateDir);
  return { activated: true, telegram };
}
