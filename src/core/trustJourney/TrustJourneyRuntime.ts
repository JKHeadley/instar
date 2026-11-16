/**
 * Server wiring for the trust journey's account path (stage 0 part B): builds the store on the
 * right sink, the direct-chat ports, the per-change appliers (each re-checks the proof for its exact
 * change), the change-log writer and the load-time proof check. Routes reach it as
 * `ctx.trustAccountPath`.
 */
import fs from 'node:fs';
import { SafeFsExecutor } from '../SafeFsExecutor.js';
import path from 'node:path';
import type { AdaptiveTrust } from '../AdaptiveTrust.js';
import type { AutonomyProfileManager } from '../AutonomyProfileManager.js';
import type { TrustRecovery } from '../TrustRecovery.js';
import type { OperationMutability, TrustLevel } from '../ExternalOperationGate.js';
import type { AutonomyProfileLevel } from '../types.js';
import {
  boardPolicyRaises, configPatchRaises, isKnownTrustLevel, isTrustLevelRaise, mergedConfigValue, profileRaises,
  proofCovers, proposalHashOf, slackRoleRaises, type OperatorProof,
} from '../TrustRaiseGuard.js';
import { AccountPathService, proofSubject, type DirectChatPort, type ProposeResult, type ReceiptOutcome } from './AccountPathService.js';
import { LocalFileTrustSink, TrustJourneyStore, TRUST_JOURNEY_STORE_KEY, TRUST_GRANT_RECORD_KIND, type TrustChange, type TrustRecord, type TrustRecordSink } from './TrustJourneyStore.js';
import { checkTrustProfileAgainstLog, TrustChangeLogWriter, type Narrowed } from './proofCheck.js';
import { decideAdmission, type AdmissionDecision } from './admission.js';
import { TrustOutcomeLog } from './TrustOutcomeLog.js';
import { planLegacyImport, writeLegacyKindsFile } from './legacyImport.js';
import { deriveEffect, type DerivedEffect } from '../../data/effect-kinds.js';
import type { AdapterKind, Receipt } from './accountPath.js';

/** The journal-backed sink: every record goes through the replicated emitter and is awaited durable. */
export function journalSink(deps: {
  emit: (recordKey: string, build: (hlc: unknown, origin: string) => Record<string, unknown> | null) => { outcome: string; seq?: number };
  awaitDurable: (seq: number) => Promise<unknown>;
  loadUnion: () => Array<{ recordKey: string; data: Record<string, unknown> }>;
}): TrustRecordSink {
  return {
    description: `replicated store ${TRUST_JOURNEY_STORE_KEY} (${TRUST_GRANT_RECORD_KIND})`,
    async append(recordKey, rec) {
      const r = deps.emit(recordKey, (hlc, origin) => ({ ...rec, recordKey, hlc, op: 'put', origin }));
      if (r.outcome !== 'emitted' || r.seq === undefined) return false; // a no-op is a failed write
      try { await deps.awaitDurable(r.seq); return true; } catch { return false; } // @silent-fallback-ok: false refuses the action
    },
    loadAll() {
      return deps.loadUnion().map(({ recordKey, data }) => ({ ...data, recordKey }) as unknown as TrustRecord);
    },
  };
}

export interface TrustJourneyRuntimeDeps {
  stateDir: string;
  configPath: string;
  runtimeConfig: Record<string, unknown>;
  installationId: string;
  sink?: TrustRecordSink;
  /** Where outcome rows go (the `trustJourneyOutcomes` store); absent uses a local file. */
  outcomeSink?: TrustRecordSink;
  adaptiveTrust: AdaptiveTrust | null;
  autonomyManager: AutonomyProfileManager | null;
  trustRecovery: TrustRecovery | null;
  telegram: { sendOwnerDirect(text: string, replyTo?: number): Promise<{ messageId: number } | null>; getOwnerUserId(): number | undefined } | null;
  slack: { openDm(userId: string): Promise<string | null>; post(channel: string, text: string, threadTs?: string): Promise<string | null> } | null;
  slackOwnerUserId: () => string | null;
  slackRole?: (mode: 'register' | 'approve', slackUserId: string, displayName: string, role: string) => Promise<void>;
  boardPolicy?: { current(): string; set(policy: string, proof: OperatorProof): Promise<boolean> };
  /** Is this machine the serving-lease holder (single machine: always true). */
  holdsLease: () => boolean;
  /** This machine's id (legacy grants apply on the machine whose gate config they reproduce). */
  machineId?: string;
  /** Inputs to the one-time legacy import (decision 9); absent skips the import. */
  legacyImport?: { gateEnabled: boolean; gateServices: string[]; readOnlyServices: string[]; logServices: () => string[]; mcpServers: () => string[]; alreadyImported: () => boolean; markImported: () => boolean };
  notifyOwner?: (text: string) => Promise<void>;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface TrustAccountPathRuntime {
  readonly store: TrustJourneyStore;
  readonly service: AccountPathService;
  propose(change: TrustChange): Promise<ProposeResult>;
  /** A receipt from an adapter's own inbound path on this machine. */
  ingest(r: Receipt): Promise<ReceiptOutcome | 'recorded-for-holder'>;
  /** Peer-committed records (the holder consumes receipts written elsewhere). */
  onPeerRecords(records: Array<{ recordKey: string; data: Record<string, unknown> }>): Promise<void>;
  checkAtLoad(): Promise<Narrowed[]>;
  /** Admission for one MCP tool call (decision 13): runs the ask when one is needed. */
  admit(toolName: string, toolInput: unknown): Promise<{ decision: AdmissionDecision; effect: DerivedEffect | null; ask?: ProposeResult }>;
  /** The one-time legacy import plus the hook's fallback file. */
  importLegacyAndWriteFallback(): Promise<{ imported: number; fileWritten: boolean; skipped?: string }>;
}

/** An agent-supplied name, shown quoted so it can never read as the card's own words. */
const q = (v: string) => `"${v.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 120)}"`;

/**
 * The card's lines, written by the server: every widening the change causes (computed from the real
 * settings, not from the request), then the exact change. Nothing is truncated: a change too large to
 * show whole is refused before a card is sent.
 */
export function summarizeChange(change: TrustChange, raises: string[] = []): string[] {
  const widen = raises.map((r) => `This would widen: ${r}`);
  switch (change.kind) {
    case 'trust-grant': {
      const words: Record<string, string> = { blocked: 'never do it', 'approve-always': 'ask you first every time', 'approve-first': 'ask you first', log: 'do it and keep it in your record', autonomous: 'just do it' };
      return [...widen, `Change: ${change.operation} actions on ${q(change.service)}: ${words[change.level] ?? change.level}`];
    }
    case 'autonomy-profile': return [...widen, `Change: switch the autonomy profile from ${change.from} to ${change.to}`];
    case 'trust-recovery': return [...widen, `Change: restore the trust level that incident ${q(change.incidentId)} lowered`];
    case 'slack-role': return [...widen, `Change: make Slack account ${q(change.displayName)} (${q(change.slackUserId)}) ${change.role}`];
    case 'board-policy': return [...widen, `Change: work board policy ${q(change.policy)}`];
    case 'config-patch': return [...widen, `Change: replace these settings exactly (whole sections are replaced): ${JSON.stringify(change.patch)}`];
    case 'one-action': return [`Do this once: ${q(change.toolName)} (${change.effectKind}) with exactly: ${change.input}`, 'It approves this one action only; the next one asks again.'];
  }
}

/** Largest one-action input shown on a card (the card must fit whole in one message). */
export const MAX_ONE_ACTION_INPUT_CHARS = 2500;

/**
 * Card text for a tool input: JSON already escapes control characters; this also escapes the
 * characters that can reorder or hide text on screen (direction overrides, zero-width marks, line and
 * paragraph separators), so the card shows the call exactly as sent.
 */
export function escapeForCard(json: string): string {
  return json.replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Telegram allows 4096 characters; the card must fit whole. */
export const MAX_CARD_SUMMARY_CHARS = 3000;

export function createTrustJourneyRuntime(d: TrustJourneyRuntimeDeps): TrustAccountPathRuntime {
  const sink = d.sink ?? new LocalFileTrustSink(path.join(d.stateDir, 'state', 'trust-journey.jsonl'));
  const store = new TrustJourneyStore(sink);
  const outcomes = new TrustOutcomeLog(d.outcomeSink ?? TrustOutcomeLog.localSink(d.stateDir));
  const writer = new TrustChangeLogWriter(store, (key) => d.log?.('trust-change-log-write-failed', { key }));
  // Every change goes to the durable log, and the hook's fallback file is rebuilt from the records
  // (spec 6a: "rebuilt from the grant records at boot and on every grant change").
  let refreshFallback: () => void = () => {};
  d.adaptiveTrust?.setChangeObserver((event, proof) => { writer.observe(event, proof); void writer.drain().then(() => refreshFallback()); });
  // The autonomy profile's switches join the same durable log (narrowings in the background; a
  // raise's record is written by its applier and awaited).
  d.autonomyManager?.setChangeObserver((from, to, proof) => {
    if (proof || from === to) return;
    void store.write('change', { changeId: `profile:${Date.now()}`, key: 'autonomy.profile', from, to, direction: profileRaises(from, to).length ? 'raise' : 'lower', source: 'route' });
  });

  const readFileConfig = (): Record<string, unknown> => {
    try { return JSON.parse(fs.readFileSync(d.configPath, 'utf8')); } catch { return {}; } // @silent-fallback-ok: an unreadable file compares as empty, so any widening still reads as a raise
  };
  const currentProfile = (): AutonomyProfileLevel | undefined => d.autonomyManager?.getProfile();
  /** The expected revision of a config change: a hash of exactly the sections it replaces, as they are now. */
  const configRevision = (patch: Record<string, unknown>): string => {
    const file = readFileConfig();
    return proposalHashOf(Object.fromEntries(Object.keys(patch).sort().map((k) => [k, file[k] ?? null])));
  };

  const raisesOf = (c: TrustChange): string[] => {
    switch (c.kind) {
      case 'trust-grant': {
        if (!d.adaptiveTrust || !isKnownTrustLevel(c.level)) return [];
        const cur = d.adaptiveTrust.getTrustLevel(c.service, c.operation).level;
        return isTrustLevelRaise(cur, c.level as TrustLevel) ? [`${c.service} ${c.operation}: ${cur} → ${c.level}`] : [];
      }
      case 'autonomy-profile': {
        const cur = currentProfile();
        return cur && cur === c.from ? profileRaises(cur, c.to as AutonomyProfileLevel) : [];
      }
      case 'config-patch': return configPatchRaises(readFileConfig(), c.patch, currentProfile());
      case 'slack-role': return slackRoleRaises(c.role);
      case 'board-policy': return d.boardPolicy && c.policy === d.boardPolicy.current() ? [] : boardPolicyRaises(c.policy);
      case 'trust-recovery': return [`recovering trust after incident ${c.incidentId}`];
      case 'one-action': return [`doing ${c.toolName} once`];
    }
  };

  const ports: Partial<Record<AdapterKind, DirectChatPort>> = {};
  if (d.telegram) {
    const tg = d.telegram;
    ports.telegram = {
      async sendDirect(userId, text) {
        if (String(tg.getOwnerUserId() ?? '') !== userId) return null; // the only direct chat the bot sends to is the owner's
        const r = await tg.sendOwnerDirect(text);
        return r ? { chatId: userId, messageId: String(r.messageId) } : null;
      },
      async replyTo(_chatId, messageId, text) {
        const n = Number(messageId);
        if (!Number.isSafeInteger(n)) return false;
        return !!(await tg.sendOwnerDirect(text, n));
      },
    };
  }
  if (d.slack) {
    const sl = d.slack;
    ports.slack = {
      async sendDirect(userId, text) {
        const channel = await sl.openDm(userId);
        if (!channel) return null;
        // Slack would turn `<url|label>` into a hidden link: escape the card so it reads literally.
        const ts = await sl.post(channel, text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
        return ts ? { chatId: channel, messageId: ts } : null;
      },
      async replyTo(chatId, messageId, text) { return !!(await sl.post(chatId, text, messageId)); },
    };
  }

  const requireProof = (c: TrustChange, proof: OperatorProof) => {
    if (!proofCovers(proof, proposalHashOf(proofSubject(c)))) throw new Error('the proof does not cover this exact change');
  };

  const apply = async (c: TrustChange, proof: OperatorProof): Promise<{ ok: boolean; detail?: string }> => {
    requireProof(c, proof);
    switch (c.kind) {
      case 'trust-grant': {
        if (!d.adaptiveTrust) return { ok: false, detail: 'trust settings are not available on this machine' };
        const prev = d.adaptiveTrust.getTrustLevel(c.service, c.operation as OperationMutability).level;
        d.adaptiveTrust.grantTrust(c.service, c.operation as OperationMutability, c.level as TrustLevel, 'approved by the person in their direct chat', proof);
        if (await writer.drain()) return { ok: true };
        // Not durable: undo it, so what the person is told is true.
        d.adaptiveTrust.restoreFromCommittedLog(c.service, c.operation as OperationMutability, prev, 'the approved change could not be recorded');
        return { ok: false, detail: 'the change could not be recorded durably, so it was undone' };
      }
      case 'autonomy-profile': {
        if (!d.autonomyManager) return { ok: false, detail: 'autonomy settings are not available on this machine' };
        if (d.autonomyManager.getProfile() !== c.from) return { ok: false, detail: `the profile is now ${d.autonomyManager.getProfile()}, not ${c.from}` };
        d.autonomyManager.setProfile(c.to as AutonomyProfileLevel, 'approved by the person in their direct chat', proof);
        const ok = (await store.write('change', { changeId: `profile:${Date.now()}`, key: 'autonomy.profile', from: c.from, to: c.to, direction: 'raise', consumptionId: proof.receiptRef, source: 'person' })).ok;
        if (ok) return { ok: true };
        d.autonomyManager.setProfile(c.from as AutonomyProfileLevel, 'the approved change could not be recorded'); // a narrowing back
        return { ok: false, detail: 'the change could not be recorded durably, so it was undone' };
      }
      case 'trust-recovery': {
        if (!d.trustRecovery) return { ok: false, detail: 'trust recovery is not available on this machine' };
        const r = d.trustRecovery.acceptRecovery(c.incidentId, proof);
        return r ? { ok: true } : { ok: false, detail: 'no open incident with that id' };
      }
      case 'config-patch': {
        // Recheck the expected revision (spec section 5, One transaction): a card approved after the
        // settings changed would otherwise apply over a later narrowing.
        if (c.basedOn !== configRevision(c.patch)) return { ok: false, detail: 'the settings changed after this request was sent, so it was not applied; the agent can send a fresh one' };
        const original = fs.existsSync(d.configPath) ? fs.readFileSync(d.configPath, 'utf8') : null;
        // Never rewrite a config file this build cannot read: that would replace every other setting.
        if (original !== null) { try { JSON.parse(original); } catch { return { ok: false, detail: 'the settings file could not be read, so nothing was changed' }; } }
        const runtimeBefore: Record<string, unknown> = {};
        const file = readFileConfig();
        for (const [k, v] of Object.entries(c.patch)) {
          if (k !== 'externalOperations' && k !== 'evolution') return { ok: false, detail: `${k} is not an approvable setting` };
          runtimeBefore[k] = d.runtimeConfig[k];
          file[k] = mergedConfigValue(file[k], v);
          d.runtimeConfig[k] = mergedConfigValue(d.runtimeConfig[k], v);
        }
        fs.writeFileSync(d.configPath, JSON.stringify(file, null, 2) + '\n');
        const ok = (await store.write('change', { changeId: `config:${Date.now()}`, key: `config.${Object.keys(c.patch).join('+')}`, from: null, to: JSON.stringify(c.patch).slice(0, 2000), direction: 'raise', consumptionId: proof.receiptRef, source: 'person' })).ok;
        if (ok) return { ok: true, detail: 'some settings take effect at the next restart' };
        if (original !== null) fs.writeFileSync(d.configPath, original);
        else SafeFsExecutor.safeRmSync(d.configPath, { force: true, operation: 'trustJourney:undo-unrecorded-config-change' }); // there was no file before
        for (const [k, v] of Object.entries(runtimeBefore)) d.runtimeConfig[k] = v;
        return { ok: false, detail: 'the change could not be recorded durably, so it was undone' };
      }
      case 'slack-role': {
        if (!d.slackRole) return { ok: false, detail: 'Slack roles are not available on this machine' };
        await d.slackRole(c.mode, c.slackUserId, c.displayName, c.role);
        return { ok: true };
      }
      case 'board-policy': {
        if (!d.boardPolicy) return { ok: false, detail: 'the work board is not running' };
        return (await d.boardPolicy.set(c.policy, proof)) ? { ok: true } : { ok: false, detail: 'the policy could not be saved' };
      }
      case 'one-action': {
        // Recorded, not executed: the agent's retry of the identical call is admitted once (spec section 2, One use).
        // Expires like the card it answered (spec section 2, Expiry and resume): an unused approval does not live forever.
        const ttl = (() => { const v = (d.runtimeConfig.trustJourney as { cardTtlDays?: unknown } | undefined)?.cardTtlDays; return typeof v === 'number' && v > 0 && v <= 90 ? v : 7; })();
        const w = await store.write('action-approval', { approvalId: proof.receiptRef, actionIdentity: c.actionIdentity, consumptionId: proof.receiptRef, expiresAt: new Date(Date.now() + ttl * 86_400_000).toISOString() }, `tj:action-approval:${proof.receiptRef}`);
        return w.ok ? { ok: true, detail: 'the agent can now run that exact call once' } : { ok: false, detail: 'the approval could not be recorded durably' };
      }
    }
  };

  const service = new AccountPathService({
    store,
    adapters: ports,
    ownerPlatformId: (a) => (a === 'telegram' ? (d.telegram?.getOwnerUserId() !== undefined ? String(d.telegram.getOwnerUserId()) : null) : d.slackOwnerUserId()),
    installationId: d.installationId,
    raisesOf,
    summarize: (c) => summarizeChange(c, raisesOf(c)),
    apply,
    cardTtlDays: () => {
      const v = (d.runtimeConfig.trustJourney as { cardTtlDays?: unknown } | undefined)?.cardTtlDays;
      return typeof v === 'number' && v > 0 && v <= 90 ? v : 7;
    },
    log: d.log,
  });

  const runtime: TrustAccountPathRuntime = {
    store,
    service,
    propose: (c) => service.propose(c.kind === 'config-patch' ? { ...c, basedOn: configRevision(c.patch) } : c),
    async ingest(r) {
      if (!service.claims(r)) return 'not-for-us';
      if (d.holdsLease()) return service.onReceipt(r);
      // Not the holder: write the receipt; the holder consumes it from the replicated stream.
      const w = await store.write('receipt', { ...r }, `tj:receipt:${r.uniqueKey}`);
      return w.ok ? 'recorded-for-holder' : 'not-recorded';
    },
    async onPeerRecords(records) {
      store.applyCommitted(records);
      if (!d.holdsLease()) return;
      for (const { data } of records) {
        if (data.recordType !== 'receipt') continue;
        const r = data as unknown as Receipt;
        if (store.receiptConsumed(r.uniqueKey)) continue;
        // The receipt is already in the store (folded above); process it as the holder.
        await service.onReceiptFromStore(r);
      }
    },
    async admit(toolName, toolInput) {
      const effect = deriveEffect(toolName, toolInput);
      const rawInput = JSON.stringify(toolInput ?? {});
      const sentinel = !!toolInput && typeof toolInput === 'object' && ('_truncated' in (toolInput as object) || '_unserializable' in (toolInput as object));
      const uncardable = sentinel || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)
        || rawInput.length > MAX_ONE_ACTION_INPUT_CHARS || toolName.length > 120;
      const self = d.machineId ?? 'self';
      const decision = decideAdmission({
        effect,
        unchangedLegacy: (kind) => store.legacyUnchanged(kind, self),
        provenLevel: (kind) => {
          const [service, op] = [kind.slice(0, kind.lastIndexOf('.')), kind.slice(kind.lastIndexOf('.') + 1)];
          if (!d.adaptiveTrust || !['write', 'modify', 'delete'].includes(op)) return null;
          if (!store.lastChange(kind)) return null; // decision 10: no recorded grant means "Ask me first"
          return d.adaptiveTrust.getTrustLevel(service, op as OperationMutability).level;
        },
        unreadableHistory: (kind) => store.hasUnreadableHistory(kind),
        // An input the card cannot show exactly (too large, not an object, or a stand-in the hook sent)
        // can never be approved once: every such call would share one identity.
        unusedApproval: (id) => (uncardable ? null : store.unusedActionApproval(id)),
        currentLevel: (kind) => {
          const i = kind.lastIndexOf('.');
          const op = kind.slice(i + 1);
          if (!d.adaptiveTrust || !['read', 'write', 'modify', 'delete'].includes(op)) return null;
          return d.adaptiveTrust.getTrustLevel(kind.slice(0, i), op as OperationMutability).level;
        },
      });
      // Decision 13: only the serving-lease holder admits a governed effect; elsewhere it waits.
      if (decision.verdict !== 'not-gated' && decision.verdict !== 'legacy' && !d.holdsLease()) {
        return { decision: { verdict: 'ask', why: 'holder-unreachable' }, effect };
      }
      if (decision.verdict === 'proceed-once' && effect) {
        // One use: the dispatch is recorded before the call is admitted; a second identical call asks again.
        const w = await store.write('dispatch', { approvalId: decision.approvalId, actionIdentity: effect.actionIdentity }, `tj:dispatch:${decision.approvalId}`);
        if (!w.ok) return { decision: { verdict: 'ask', why: 'no-grant' }, effect };
      }
      if ((decision.verdict === 'proceed' || decision.verdict === 'proceed-once') && effect) {
        // Section 4: every governed effect the holder admits gets an outcome row, "not yet checked".
        const ok = await outcomes.admitted({ kind: effect.kind, actionIdentity: effect.actionIdentity, person: 'owner', machine: d.machineId ?? 'self', via: decision.verdict === 'proceed' ? 'grant' : 'approved-once' });
        if (!ok) d.log?.('trust-outcome-write-failed', { kind: effect.kind });
      }
      if (decision.verdict === 'ask' && effect) {
        if (uncardable) return { decision, effect, ask: { status: 'too-large', message: 'This call cannot be shown exactly on a card (too large, or not a plain set of fields), so it cannot be approved once; the person can set the kind instead.' } as ProposeResult };
        const ask = await service.propose({ kind: 'one-action', actionIdentity: effect.actionIdentity, toolName, effectKind: effect.kind, input: escapeForCard(rawInput) });
        return { decision, effect, ask };
      }
      return { decision, effect };
    },
    async importLegacyAndWriteFallback() {
      const li = d.legacyImport;
      let imported = 0;
      if (li && !li.alreadyImported()) {
        const plan = planLegacyImport({
          gateEnabled: li.gateEnabled, gateServices: li.gateServices, readOnlyServices: li.readOnlyServices,
          // A joining machine imports only kinds still unchanged-legacy somewhere (decision 9).
          logServices: li.logServices(), mcpServers: li.mcpServers(), existingKeys: store.unchangedLegacyKeys(),
          // A record from another machine means this is not the first import, even if none is unchanged now.
          othersImported: store.legacyKeys().some((k) => store.legacyGrants(k).some((g) => g.machine !== (d.machineId ?? 'self'))),
        });
        const self0 = d.machineId ?? 'self';
        for (const g of plan.grants) {
          // A record this machine already wrote (an import that stopped part-way) counts as done.
          if (store.legacyGrants(g.key).some((x) => x.machine === self0)) continue;
          const w = await store.write('legacy-grant', { key: g.key, machine: self0, behaviour: g.behaviour, afterChange: store.lastChange(g.key)?.changeId ?? null }, `tj:legacy:${self0}:${g.key}`);
          if (!w.ok) return { imported, fileWritten: false, skipped: 'a legacy grant could not be recorded; the import will run again at the next start' };
          imported++;
        }
        if (!li.markImported()) return { imported, fileWritten: false, skipped: 'the import marker could not be saved' };
      }
      const self = d.machineId ?? 'self';
      const legacyKinds = store.legacyKeys().filter((k) => store.legacyUnchanged(k, self));
      const fileWritten = writeLegacyKindsFile(d.stateDir, {
        generatedAt: new Date().toISOString(),
        legacyKinds: legacyKinds.sort(),
        readToolNames: [],
      });
      return { imported, fileWritten };
    },
    async checkAtLoad() {
      if (!d.adaptiveTrust && !d.autonomyManager) return [];
      // Corrupt state (spec 6a): the stored profile could not be read, so every setting and
      // restriction is rebuilt from the committed change log before anything is admitted. A raise
      // with no recorded approval falls back to where it came from; a key whose history this build
      // cannot read is unavailable (blocked), never merely "Ask me first".
      const rebuilt: Narrowed[] = [];
      if (d.adaptiveTrust?.corruptAtLoad) {
        const keys = new Set(store.changeLog().map((c) => c.key));
        for (const key of keys) {
          const i = key.lastIndexOf('.');
          const service = key.slice(0, i), op = key.slice(i + 1);
          if (!['read', 'write', 'modify', 'delete'].includes(op)) continue;
          const last = store.lastChange(key)!;
          const unproven = last.direction === 'raise' && !(last.consumptionId && store.consumption(last.consumptionId));
          const level = (store.hasUnreadableHistory(key) ? 'blocked' : unproven ? (last.from ?? 'approve-always') : last.to) as TrustLevel;
          d.adaptiveTrust.applyCommittedLevel(service, op as OperationMutability, level, 'rebuilt from the committed change log after the stored settings could not be read');
          rebuilt.push({ key, from: 'unreadable', to: level, why: 'the stored settings could not be read' });
        }
        d.log?.('trust-profile-rebuilt', { keys: rebuilt.length });
      }
      const narrowed = d.adaptiveTrust ? [...rebuilt, ...checkTrustProfileAgainstLog(d.adaptiveTrust, store)] : [];
      // The autonomy profile: wider than its last committed switch, or a raise with no recorded approval.
      const lp = store.lastChange('autonomy.profile');
      const cur = d.autonomyManager?.getProfile();
      if (d.autonomyManager && lp && cur) {
        const unproven = lp.direction === 'raise' && !(lp.consumptionId && store.consumption(lp.consumptionId));
        const target = (unproven ? lp.from : lp.to) as AutonomyProfileLevel | null;
        if (target && profileRaises(target, cur).length > 0) {
          d.autonomyManager.setProfile(target, 'proof check at load: restored to the last approved profile');
          narrowed.push({ key: 'autonomy.profile', from: cur, to: target, why: unproven ? 'the last raise has no recorded approval' : 'the stored profile is wider than the last committed switch' });
        }
      }
      if (narrowed.length && d.notifyOwner) {
        await d.notifyOwner(`I restored ${narrowed.length === 1 ? 'one trust setting' : `${narrowed.length} trust settings`} to the last level you approved, because the stored value did not match the record: ${narrowed.map((n) => `${n.key} (${n.from} → ${n.to})`).join(', ')}. Nothing was widened.`).catch(() => {});
      }
      return narrowed;
    },
  };
  refreshFallback = () => { void runtime.importLegacyAndWriteFallback().catch(() => {}); };
  return runtime;
}
