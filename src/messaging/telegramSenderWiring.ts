/**
 * identity-security-piece1e: wire the Telegram sender rule into an adapter.
 * Spec: docs/specs/identity-security-piece1e-telegram-senders.md (section 5)
 *
 * - enforce: the dev-gated switch security.telegramSenderAuthority.enabled (development agents on)
 * - registered people: the user registry's Telegram ids, read live
 * - observe: a bounded record of would-refuse senders, and ONE owner item per agent, refreshed
 */
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import type { TelegramSenderAction, TelegramSenderStanding } from './telegramSenderAuthority.js';

export const OBSERVE_SENDERS_PER_DAY = 64;

export interface SenderWiringDeps {
  config: () => { developmentAgent?: boolean; security?: { telegramSenderAuthority?: { enabled?: boolean } } };
  registeredIds: () => ReadonlyArray<number | string>;
  /** Raise or refresh the one owner item (title, body). True once raised. */
  raiseOwnerItem: (title: string, body: string) => Promise<boolean>;
  now?: () => number;
}

export interface SenderAuthorityWiring {
  enforce: () => boolean;
  registeredIds: () => ReadonlyArray<number | string>;
  observe: (row: { userId: string; path: string; action: TelegramSenderAction; standing: TelegramSenderStanding }) => void;
  /** Called when the owner cannot be resolved, so the guard never switches off unseen. */
  ownerUnknown: () => void;
}

export function createSenderAuthorityWiring(deps: SenderWiringDeps): SenderAuthorityWiring {
  const now = deps.now ?? Date.now;
  let day = '';
  const senders = new Set<string>();
  let lastRaisedCount = -1;
  let ownerUnknownRaised = false;
  const rollDay = (): void => {
    const d = new Date(now()).toISOString().slice(0, 10);
    if (d !== day) { day = d; senders.clear(); lastRaisedCount = -1; }
  };
  return {
    enforce: () => resolveDevAgentGate(deps.config().security?.telegramSenderAuthority?.enabled, deps.config()),
    registeredIds: deps.registeredIds,
    observe: (row) => {
      rollDay();
      featureEvidence.recordAtMostEvery('security.telegramSenderAuthority', `would-refuse:${row.action}:${row.userId}`, 60_000, {
        kind: 'held', reason: `Would refuse a ${row.standing} sender (${row.action}, ${row.path})`,
        context: { userId: row.userId, path: row.path, action: row.action, standing: row.standing },
      });
      if (senders.has(row.userId)) return;
      // Past the daily cap the item already reads "64 or more"; each row still lands in the evidence log.
      if (senders.size >= OBSERVE_SENDERS_PER_DAY) return;
      senders.add(row.userId);
      if (senders.size === lastRaisedCount) return;
      lastRaisedCount = senders.size;
      const ids = [...senders].slice(0, 10).join(', ');
      const count = senders.size >= OBSERVE_SENDERS_PER_DAY ? `${OBSERVE_SENDERS_PER_DAY} or more` : String(senders.size);
      void deps.raiseOwnerItem('Some Telegram messages would be refused with sender checks on',
        `${count} Telegram account(s) wrote to your agent today, or used a control, without permission for it (ids: ${ids}${senders.size > 10 ? ', …' : ''}). With sender checks on, those messages or controls would be refused, and each person refused would get a code you could approve them with.`)
        .catch(() => { lastRaisedCount = -1; /* @silent-fallback-ok: the next would-refuse raises it again */ });
    },
    ownerUnknown: () => {
      // Only where checks enforce: in observe mode they protect nothing yet, and the would-refuse item
      // is the signal. Enforcing with no owner known is the "switched off unseen" case.
      if (ownerUnknownRaised) return;
      let enforcing = false;
      try { enforcing = resolveDevAgentGate(deps.config().security?.telegramSenderAuthority?.enabled, deps.config()); } catch { enforcing = false; /* @silent-fallback-ok: unreadable switch = observe */ }
      if (!enforcing) return;
      ownerUnknownRaised = true;
      void deps.raiseOwnerItem('Your agent can\'t tell who its owner is on Telegram',
        'Sender checks are not protecting your agent, because it cannot tell which Telegram account is yours. Pair your Telegram account as the owner, and the checks start working.')
        .catch(() => { ownerUnknownRaised = false; /* @silent-fallback-ok: retried at the next occurrence */ });
    },
  };
}

/**
 * Add a Telegram id to the legacy allowlist only when the list already has entries. An empty list
 * means "everyone" to today's check, so writing a single id would turn away everyone else.
 * Type-tolerant: config JSON may hold ids as strings. Returns whether the list changed.
 */
export function addToNonEmptyTelegramAllowList(config: { messaging?: Array<{ type: string; config?: Record<string, unknown> }> }, telegramUserId: number): boolean {
  const tg = config.messaging?.find((m) => m.type === 'telegram');
  const ids = tg?.config?.authorizedUserIds;
  if (!Array.isArray(ids) || ids.length === 0) return false;
  if (ids.some((id) => String(id) === String(telegramUserId))) return false;
  ids.push(telegramUserId);
  return true;
}
