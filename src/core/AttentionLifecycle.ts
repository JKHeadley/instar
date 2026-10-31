/**
 * Attention lifecycle — pure decisions for "one item per condition" and
 * "an item that nobody confirmed cleared does not stay open forever".
 *
 * Spec: docs/specs/attention-lifecycle-close-on-cause.md. The store
 * (TelegramAdapter) owns the rows; this module owns the rules so they are
 * testable without a bot and identical for every producer.
 */

import { admitItemToHub, type HubItemLike } from '../messaging/attentionHubPolicy.js';

export type AttentionLifecycleClass = 'security' | 'operator-asked' | 'automated';

export interface AttentionLifecycleConfig {
  /** Master switch. false ⇒ the store behaves exactly as before this feature. Default true. */
  enabled?: boolean;
  expiry?: {
    /** Log would-close rows, close nothing. Default false. */
    dryRun?: boolean;
    /** Untouched automated items expire after this many days. Default 14. */
    automatedDays?: number;
    /** Items the agent raised, or that ask for a decision/approval, expire after this many days. Default 30. */
    operatorAskedDays?: number;
  };
  /** How long an operator WONT_DO holds a condition closed against reopen-in-place. Default 30 days. */
  wontDoHoldDays?: number;
}

export interface ResolvedAttentionLifecycleConfig {
  enabled: boolean;
  dryRun: boolean;
  automatedDays: number;
  operatorAskedDays: number;
  wontDoHoldDays: number;
}

export const ATTENTION_LIFECYCLE_DEFAULTS: ResolvedAttentionLifecycleConfig = {
  enabled: true,
  dryRun: false,
  automatedDays: 14,
  operatorAskedDays: 30,
  wontDoHoldDays: 30,
};

function positiveDays(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

export function resolveAttentionLifecycleConfig(raw: AttentionLifecycleConfig | undefined): ResolvedAttentionLifecycleConfig {
  const d = ATTENTION_LIFECYCLE_DEFAULTS;
  return {
    enabled: raw?.enabled !== false,
    dryRun: raw?.expiry?.dryRun === true,
    automatedDays: positiveDays(raw?.expiry?.automatedDays, d.automatedDays),
    operatorAskedDays: positiveDays(raw?.expiry?.operatorAskedDays, d.operatorAskedDays),
    wontDoHoldDays: positiveDays(raw?.wontDoHoldDays, d.wontDoHoldDays),
  };
}

/** The subset of an attention item the lifecycle rules read. */
export interface AttentionLifecycleItem {
  id: string;
  title: string;
  category: string;
  priority: string;
  status: string;
  sourceContext?: string;
  needsUser?: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  conditionKey?: string;
  sticky?: boolean;
  closedBy?: 'operator' | 'cause-cleared' | 'superseded' | 'expired';
}

const OPEN_STATUSES = new Set(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS']);

export function isOpenAttentionStatus(status: string): boolean {
  return OPEN_STATUSES.has(status);
}

// Volatile tokens blanked from an id when deriving its condition key. Only
// shapes that are unambiguously per-episode: an ISO date/datetime, a 13-digit
// epoch-ms, an `ep-N`/`epN` episode counter, a UUID, a hex run of 12+ chars.
// Topic ids (5–11 digits), machine ids (`m_<hex>` is 32 hex → blanked; the
// machine is not the condition's identity across its own episodes) and slugs
// are kept.
const ISO_DATETIME = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}(?::\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
// UUIDs and long hex runs are deliberately NOT blanked: an operation id or a
// machine id can be the thing that needs action (two lost replies to one topic
// are two losses). Producers whose ids carry a per-episode UUID pass an
// explicit conditionKey instead.
const EPOCH_MS = /\b\d{13}\b/g;
// 10-digit epoch seconds in the range 2023–2033.
const EPOCH_S = /\b1[6-9]\d{8}\b/g;
const EPISODE = /\bep-?\d+\b/gi;
// Dotted attempt / retry counters (`.1`, `.1.r2.o1`, `-3.r1`). A bare trailing
// `-12345` or `:12345` is NOT stripped: it is usually a topic id or `CMT-123`,
// and collapsing those would merge distinct conditions.
const ATTEMPT_SUFFIX = /(?:[-:.]\d+)?(?:\.[a-z]\d+)+$|\.\d+$/i;

export function attentionIdSkeleton(id: string): string {
  return id
    .replace(ISO_DATETIME, '#')
    .replace(EPOCH_MS, '#')
    .replace(EPOCH_S, '#')
    .replace(EPISODE, 'ep#')
    .replace(ATTEMPT_SUFFIX, '')
    .replace(/#(?:[-_:.]#)+/g, '#');
}

/** Trim, lowercase, collapse whitespace. Digits and identifiers are KEPT — two
 *  titles that differ only by an account, port or PR number are two conditions. */
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * The identity of the CONDITION an item describes. A producer-supplied
 * `conditionKey` wins; otherwise it is derived from source, category, title
 * and the id with its per-episode tokens blanked. Two items with different
 * titles never share a derived key; two with the same title but different
 * stable id parts (a topic id, an account slug) never share one either.
 */
export function attentionConditionKeyOf(item: Pick<AttentionLifecycleItem, 'id' | 'title' | 'category' | 'sourceContext' | 'conditionKey'>): string {
  if (item.conditionKey && item.conditionKey.trim()) return `k:${item.conditionKey.trim()}`;
  return `d:${item.sourceContext ?? ''}|${item.category ?? ''}|${normalizeTitle(item.title ?? '')}|${attentionIdSkeleton(item.id)}`;
}

// Category/source/title shapes that mean "a human must judge this": the
// security category, an exposed or leaked credential, a rotate-this-secret ask
// (the secret word may sit inside a name like `github_token`, so no word
// boundary before it), or a live grant on someone else's account.
const SECURITY_RE = /security|credential-exposure|credential-leak|\bleak(?:ed|s)?\b|\bexpos(?:ed|ure)\b|rotate\b.*(?:token|key|secret|password)|\boauth\b|authori[sz]ation for someone else/i;
const OPERATOR_ASKED_RE = /decision|approval|review/i;

/**
 * security — never expires. operator-asked — the hub filter would show it to
 * the user as needing them (agent-raised, `needsUser`, a known ask-the-user
 * source, URGENT) or its category asks for a decision/approval/review.
 * automated — everything else. The hub policy is reused so "what the user was
 * asked" and "what expires slowly" are the same rule.
 */
export function classifyAttentionLifecycle(item: AttentionLifecycleItem): AttentionLifecycleClass {
  if (item.sticky === true) return 'security';
  const cat = `${item.category ?? ''} ${item.sourceContext ?? ''} ${item.title ?? ''}`;
  if (SECURITY_RE.test(cat)) return 'security';
  const priority = (['URGENT', 'HIGH', 'NORMAL', 'LOW'].includes(item.priority) ? item.priority : 'NORMAL') as HubItemLike['priority'];
  const hub = admitItemToHub({ id: item.id, priority, sourceContext: item.sourceContext, needsUser: item.needsUser }, 'signal');
  if (hub.admit || OPERATOR_ASKED_RE.test(item.category ?? '')) return 'operator-asked';
  return 'automated';
}

export interface SupersessionPlan {
  /** The row that stays open for each condition key with duplicates. */
  keep: AttentionLifecycleItem;
  /** Older open rows for the same condition, to close as `superseded`. */
  close: AttentionLifecycleItem[];
}

/**
 * Group open rows by condition key; where a key has more than one open row,
 * keep the newest (by last touch) and plan the rest as superseded. Used by the
 * sweep (and the one-time backlog cleanup) so rows created before this feature,
 * or still inside the expiry window, collapse to one per condition.
 */
export function planAttentionSupersessions(items: AttentionLifecycleItem[]): SupersessionPlan[] {
  const groups = new Map<string, AttentionLifecycleItem[]>();
  for (const item of items) {
    if (!isOpenAttentionStatus(item.status)) continue;
    const key = attentionConditionKeyOf(item);
    const g = groups.get(key);
    if (g) g.push(item); else groups.set(key, [item]);
  }
  const plans: SupersessionPlan[] = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) => (lastTouchMs(b) || 0) - (lastTouchMs(a) || 0));
    plans.push({ keep: sorted[0], close: sorted.slice(1) });
  }
  return plans;
}

export interface ExpiryDecision {
  expire: boolean;
  cls: AttentionLifecycleClass;
  ageDays: number;
  resolution?: string;
}

function lastTouchMs(item: AttentionLifecycleItem): number {
  const candidates = [item.updatedAt, item.lastSeenAt, item.createdAt]
    .map((s) => (s ? Date.parse(s) : NaN))
    .filter((n) => Number.isFinite(n));
  return candidates.length ? Math.max(...candidates) : NaN;
}

/**
 * Should the sweep expire this item now? Security never; operator-asked after
 * `operatorAskedDays`; automated after `automatedDays`. Age is measured from
 * the last time anything touched the row (an update, a re-observation).
 */
export function decideAttentionExpiry(item: AttentionLifecycleItem, cfg: ResolvedAttentionLifecycleConfig, nowMs: number, opts?: { conditionActive?: boolean }): ExpiryDecision {
  const cls = classifyAttentionLifecycle(item);
  const touched = lastTouchMs(item);
  const ageDays = Number.isFinite(touched) ? (nowMs - touched) / 86_400_000 : 0;
  // Only a plain OPEN row ages out: ACKNOWLEDGED / IN_PROGRESS means the
  // operator touched it, and silence after that is theirs to end.
  if (item.status !== 'OPEN') return { expire: false, cls, ageDays };
  if (cls === 'security') return { expire: false, cls, ageDays };
  // A producer that deliberately raises once per episode (AttentionConditionStore)
  // still has this condition active: the item is its only voice. Keep it.
  if (opts?.conditionActive) return { expire: false, cls, ageDays };
  // A row whose timestamps cannot be parsed is never expired on a guess.
  if (!Number.isFinite(touched)) return { expire: false, cls, ageDays };
  if (cls === 'operator-asked') {
    if (ageDays <= cfg.operatorAskedDays) return { expire: false, cls, ageDays };
    return {
      expire: true, cls, ageDays,
      resolution: `expired: the operator did not answer within ${cfg.operatorAskedDays} days. Raise it again if it still matters.`,
    };
  }
  if (ageDays <= cfg.automatedDays) return { expire: false, cls, ageDays };
  return {
    expire: true, cls, ageDays,
    resolution: `expired: never confirmed cleared; untouched for ${cfg.automatedDays} days.`,
  };
}

/**
 * May a closed row be reopened in place by a new observation? An operator's
 * WONT_DO holds for `wontDoHoldDays`; everything else may reopen.
 */
export function mayReopenInPlace(existing: AttentionLifecycleItem, cfg: ResolvedAttentionLifecycleConfig, nowMs: number): boolean {
  if (isOpenAttentionStatus(existing.status)) return false;
  if (existing.status === 'WONT_DO') {
    const closedAt = Date.parse(existing.updatedAt);
    if (!Number.isFinite(closedAt)) return false;
    return nowMs - closedAt > cfg.wontDoHoldDays * 86_400_000;
  }
  return true;
}
