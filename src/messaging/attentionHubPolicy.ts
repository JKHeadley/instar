/**
 * Attention hub admission policy — which posts may reach the user's
 * "🔔 Attention" Telegram topic.
 *
 * The hub is the agent's direct line to the user. Its job is to carry ONLY
 * things the user needs to see: something to decide or tap, a real loss of
 * their messages, a security event, or anything the agent itself chose to
 * raise. Before this policy every automated monitor posted its routine
 * status there (passkey health 264×/week, worktree scans, machine-sync
 * "healed"/"back" lines), and the topic grew to 52k messages nobody could read
 * (operator report, 2026-10-23).
 *
 * The policy is SIGNAL-ONLY with respect to the item itself: a held post is
 * still recorded in the attention store (dashboard, GET /attention) and is
 * appended to `logs/attention-hub-held.jsonl`. Nothing is dropped; only the
 * Telegram post is withheld.
 *
 * Rollback: `messaging[].config.attentionHubFilter: "all"` restores the old
 * post-everything behavior.
 */

import fs from 'node:fs';
import path from 'node:path';

export type AttentionHubFilterMode = 'signal' | 'all';

export interface HubItemLike {
  id: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext?: string;
  /** Set by a caller whose item asks the user to decide or act. */
  needsUser?: boolean;
}

export interface HubDecision {
  admit: boolean;
  reason: string;
}

/**
 * Automated sources whose items ask the user for something they alone can do.
 * Matched on `sourceContext` prefix; `idPrefix` / `minPriority` narrow a source
 * that also raises plain status items under the same name.
 */
const NEEDS_USER_SOURCES: ReadonlyArray<{ source: string; idPrefix?: string; minPriority?: HubItemLike['priority'] }> = [
  // "Open Subscriptions and tap Repair sign-in" (HIGH); the NORMAL follow-up says "nothing to do".
  { source: 'assisted-subscription-relogin', minPriority: 'HIGH' },
  { source: 'account-follow-me-email-gate' },
  // "Duplicate conversation needs your call" — the escalation, not the breaker/convergence status lines.
  { source: 'duplicate-reconciler', idPrefix: 'dup-reconciler-escalate:' },
  { source: 'feedback-triage:action-list' },
  // A login moved under a slot — needs a re-login only the operator can do.
  { source: 'quota-poll-identity-oracle' },
  // Something other than the lifeline called the Telegram intake: a security event.
  { source: 'telegram-ingress-lifeline-secret' },
  // A passkey revoke the operator ordered has not landed on a machine for 30 days.
  { source: 'passkey-revoke-outbox' },
];

const PRIORITY_RANK: Record<HubItemLike['priority'], number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 };

export function attentionPriorityRank(priority: HubItemLike['priority']): number {
  return PRIORITY_RANK[priority] ?? 1;
}

/** Decide whether an attention item's hub post reaches the user. */
export function admitItemToHub(item: HubItemLike, mode: AttentionHubFilterMode): HubDecision {
  if (mode === 'all') return { admit: true, reason: 'filter-off' };
  if (item.priority === 'URGENT') return { admit: true, reason: 'urgent' };
  if (item.needsUser === true) return { admit: true, reason: 'needs-user' };
  const source = item.sourceContext ?? '';
  // Raised by the agent itself (POST /attention): the agent judged it worth the user's eyes.
  if (source === 'agent') return { admit: true, reason: 'agent-raised' };
  for (const rule of NEEDS_USER_SOURCES) {
    if (!source.startsWith(rule.source)) continue;
    if (rule.idPrefix && !item.id.startsWith(rule.idPrefix)) continue;
    if (rule.minPriority && PRIORITY_RANK[item.priority] < PRIORITY_RANK[rule.minPriority]) continue;
    return { admit: true, reason: 'needs-user-source' };
  }
  return { admit: false, reason: 'automated-status' };
}

/**
 * Notification categories (server.ts `notify()`) allowed into the hub when the
 * hub is the destination. Everything else is routine automation status.
 */
const HUB_NOTICE_CATEGORIES: ReadonlyMap<string, 'any' | 'immediate'> = new Map([
  ['inbound-loss', 'any'], // the user's messages may be lost — resend
  ['stuck-recovery', 'any'], // "I didn't get to N of your messages"
  ['sender-rejection', 'any'], // a message was refused as an unknown sender
  ['commitment', 'any'], // a setting the user asked for reverted
  ['session-reap', 'any'], // a session doing the user's work was shut down (reap fallback for unbound sessions)
  ['mutual-ssh-host-key-change', 'any'], // security
  ['quota', 'immediate'], // only exhausted / critical
  ['inbound-queue', 'immediate'], // suspected loss / queue not started; flapping summaries are status
]);

export function admitNoticeToHub(category: string, tier: string, mode: AttentionHubFilterMode): HubDecision {
  if (mode === 'all') return { admit: true, reason: 'filter-off' };
  const rule = HUB_NOTICE_CATEGORIES.get(category);
  if (rule === 'any') return { admit: true, reason: 'user-impact' };
  if (rule === 'immediate' && tier === 'IMMEDIATE') return { admit: true, reason: 'user-impact' };
  return { admit: false, reason: 'automated-status' };
}

/** Parse the config value; anything but an explicit "all" is the filtered default. */
export function resolveHubFilterMode(raw: unknown): AttentionHubFilterMode {
  return raw === 'all' ? 'all' : 'signal';
}

export interface HeldHubPost {
  kind: 'item' | 'notice' | 'followup';
  reason: string;
  id?: string;
  category?: string;
  priority?: string;
  tier?: string;
  title: string;
}

/** Append one held post to `<logsDir>/attention-hub-held.jsonl`. Never throws. */
export function recordHeldHubPost(logsDir: string | undefined, entry: HeldHubPost): void {
  if (!logsDir) return;
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry, title: entry.title.slice(0, 200) });
    fs.appendFileSync(path.join(logsDir, 'attention-hub-held.jsonl'), line + '\n');
  } catch {
    // @silent-fallback-ok — the audit line is best-effort; the item itself is in the attention store.
  }
}
