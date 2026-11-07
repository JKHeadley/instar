/**
 * TeamAccess — the one mapping from an org role to what a person may do in the app and on the server.
 *
 * Spec: docs/specs/team-roles-and-access.md §3.1, §3.5. `OrgRole` stays the only role vocabulary; a
 * tier is a projection of it. Pure and deterministic: this is an authorization boundary, so anything
 * not positively recognised gets nothing.
 */
import type { OrgRole } from './types.js';

export type Tier = 'owner' | 'admin' | 'member' | 'guest';

const TIER_RANK: Record<Tier, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

export function tierOfRole(role: OrgRole): Tier {
  if (role === 'owner') return 'owner';
  if (role === 'admin') return 'admin';
  if (role === 'guest') return 'guest';
  return 'member';
}

export function isTier(x: unknown): x is Tier {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(TIER_RANK, x);
}

export function tierAtLeast(tier: Tier, min: Tier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[min];
}

export type ConversationOp = 'read' | 'send' | 'upload' | 'rename' | 'delete' | 'purge';
export type GrantAccess = 'read' | 'use';

/** What the person holds on one conversation. */
export interface ConversationFacts {
  /** The person created it, so it is theirs. */
  own: boolean;
  /** Their grant, if any. */
  grant: GrantAccess | null;
}

/** The attention categories an admin or MSP sees once team access is on (§3.7). Anything else is the owner's. */
const MAINTENANCE_CATEGORIES: ReadonlySet<string> = new Set(['monitoring', 'degradation', 'agent-health', 'infrastructure', 'system']);

/**
 * What a non-owner sees of one attention item while team access is on, or null for nothing. Category
 * says what the problem is, not who may read its words: an item with no conversation reference shows
 * only a fixed label, and one naming a conversation this person may not read is not shown at all.
 */
export function attentionForNonOwner<T extends { category?: unknown; contextTopicIds?: unknown }>(
  item: T, mayRead: (topicId: number) => boolean,
): T | { id: unknown; category: string; title: string; summary: string; status: unknown; priority: unknown; createdAt: unknown } | null {
  const category = typeof item.category === 'string' ? item.category : '';
  if (!MAINTENANCE_CATEGORIES.has(category)) return null;
  // `contextTopicIds` are the owning conversations. An item's `topicId` is only where it was delivered.
  const refs = (Array.isArray(item.contextTopicIds) ? item.contextTopicIds : []).filter((x): x is number => typeof x === 'number');
  if (refs.length === 0) {
    const raw = item as unknown as Record<string, unknown>;
    return { id: raw.id, category, title: `A ${category} item needs attention`, summary: '', status: raw.status, priority: raw.priority, createdAt: raw.createdAt };
  }
  return refs.every(mayRead) ? item : null;
}

const ALL_OPS: ReadonlySet<ConversationOp> = new Set(['read', 'send', 'upload', 'rename', 'delete', 'purge']);
const USE_OPS: ReadonlySet<ConversationOp> = new Set(['read', 'send', 'upload']);

/** §3.5's table for a team person. The owner and `msp` phones do not come through here. */
export function mayDoAsTeam(tier: Exclude<Tier, 'owner'>, op: ConversationOp, facts: ConversationFacts): boolean {
  if (!ALL_OPS.has(op)) return false;
  if (tier === 'guest') return op === 'read' && (facts.own || facts.grant !== null);
  if (facts.own) return true;
  if (facts.grant === 'use') return USE_OPS.has(op);
  if (facts.grant === 'read') return op === 'read';
  return false;
}
