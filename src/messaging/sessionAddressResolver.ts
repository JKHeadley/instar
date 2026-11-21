/**
 * Who holds this role now (spec docs/specs/messages-reach-renamed-sessions.md, §A).
 *
 * A same-agent message names a tmux session. Sessions come back under other names
 * after a restart or respawn (`echo-echo-<role>`, `echo-topic-N`). This pure function
 * answers which running session, if exactly one, holds the role the sender named.
 *
 * Rules, in order. The first rule with one or more candidates decides: one candidate
 * delivers, two or more is `ambiguous` (refuse, naming them). No later rule is
 * consulted after an ambiguous rule.
 *   1. exact tmux name;
 *   2. topic identity (the `<prefix>-topic-N` alias, or the topic of the target's newest
 *      record), held by the session the topic registry names, else by a running session
 *      bound to that topic;
 *   3. same stored name, for topic-less, job-less roles only;
 *   4. prefix-equivalent tmux names, only when the records claiming the normalized form
 *      all belong to one role (stored name with one leading prefix removed, plus its
 *      topic or job).
 * Candidates are running sessions that started at or before `asOf` (freshness, every
 * rule) and whose conversation is not standing down. Never crosses agents: the input is
 * this agent's own session records.
 */

import { pickSessionByTmux } from '../core/pickSessionByTmux.js';

export interface ResolverSession {
  id: string;
  name: string;
  tmuxSession: string;
  status: string;
  startedAt: string;
  jobSlug?: string;
  telegramTopicId?: number;
}

export interface ResolverContext {
  /** Every session record this agent holds (any status). */
  sessions: readonly ResolverSession[];
  /** The tmux name the topic registry binds to a topic, or null. */
  sessionNameForTopic: (topicId: number) => string | null;
  /** True when this topic's conversation is standing down on this machine. */
  isStandingDown: (topicId: number) => boolean;
  /** Placement: the machine id that holds this topic now, when it is not this machine. */
  topicHeldElsewhere?: (topicId: number) => string | null;
  /** `<projectDir basename>`, e.g. `echo`. */
  prefix: string;
  /** Freshness cut-off (ms since epoch). */
  asOf: number;
}

export type ResolveVia = 'exact' | 'topic' | 'name' | 'prefix';

export type ResolveResult =
  | { kind: 'exact' | 'redirected'; session: ResolverSession; via: ResolveVia }
  | { kind: 'ambiguous'; candidates: string[]; via: ResolveVia; reason: string }
  | { kind: 'none'; reason: NoneReason; heldOn?: string };

export type NoneReason =
  | 'no-session-holds-this-role'
  | 'role-respawned-after-message'
  | 'topic-not-held-here'
  | 'topic-held-on'
  | 'job-run-ended';

/** Collapse ONE repeated leading `<prefix>-` (`echo-echo-x` → `echo-x`). */
export function normalizeTmuxName(name: string, prefix: string): string {
  const p = `${prefix}-`;
  return name.startsWith(p + p) ? name.slice(p.length) : name;
}

function startedMs(s: ResolverSession): number {
  const t = Date.parse(s.startedAt);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

export function resolveSessionTarget(target: string, ctx: ResolverContext): ResolveResult {
  const running = ctx.sessions.filter((s) => s.status === 'running'
    && !(s.telegramTopicId !== undefined && ctx.isStandingDown(s.telegramTopicId)));
  const fresh = (s: ResolverSession) => startedMs(s) <= ctx.asOf;
  // Any running session at all, fresh or not, decides whether a refusal reads
  // "respawned after the message" rather than "nobody holds this".
  let staleHolderSeen = false;

  const decide = (via: ResolveVia, matches: ResolverSession[]): ResolveResult | null => {
    if (matches.length === 0) return null;
    const ok = matches.filter(fresh);
    if (ok.length === 0) { staleHolderSeen = true; return null; }
    if (ok.length > 1) {
      return { kind: 'ambiguous', via, candidates: ok.map((s) => s.tmuxSession).sort(), reason: `${ok.length} sessions could hold this role` };
    }
    return { kind: via === 'exact' ? 'exact' : 'redirected', session: ok[0], via };
  };
  const stale = (): ResolveResult => ({ kind: 'none', reason: 'role-respawned-after-message' });

  // 1. exact
  const exact = decide('exact', running.filter((s) => s.tmuxSession === target));
  if (exact) return exact;
  if (staleHolderSeen) return stale();

  const newest = pickSessionByTmux(ctx.sessions, target);
  const aliasMatch = target.match(new RegExp(`^${escapeRe(ctx.prefix)}-topic-(\\d+)$`));
  const topicId = aliasMatch ? Number(aliasMatch[1]) : newest?.telegramTopicId;

  // 2. topic identity
  if (topicId !== undefined && Number.isSafeInteger(topicId)) {
    const bound = ctx.sessionNameForTopic(topicId);
    let holders = bound ? running.filter((s) => s.tmuxSession === bound) : [];
    if (holders.length === 0) holders = running.filter((s) => s.telegramTopicId === topicId);
    const byTopic = decide('topic', holders);
    if (byTopic) return byTopic;
    if (staleHolderSeen) return stale();
    const elsewhere = ctx.topicHeldElsewhere?.(topicId) ?? null;
    if (elsewhere) return { kind: 'none', reason: 'topic-held-on', heldOn: elsewhere };
    return { kind: 'none', reason: 'topic-not-held-here' };
  }

  // Job runs resolve only by exact or prefix.
  const isJob = !!newest?.jobSlug;

  // 3. same name, topic-less and job-less roles only
  if (newest && !isJob) {
    const byName = decide('name', running.filter((s) => s.name === newest.name && s.telegramTopicId === undefined));
    if (byName) return byName;
    if (staleHolderSeen) return stale();
  }

  // 4. prefix-equivalent, single role across all records. The old and new records of
  // one role carry different tmux names (`echo-x`, `echo-echo-x`), so claimants are
  // counted by role (stored name, one leading prefix stripped), not by tmux name.
  const norm = normalizeTmuxName(target, ctx.prefix);
  const claimantRecords = ctx.sessions.filter((s) => normalizeTmuxName(s.tmuxSession, ctx.prefix) === norm);
  const roles = new Set(claimantRecords.map((s) => roleKey(s, ctx.prefix)));
  if (roles.size > 1) {
    const names = [...new Set(claimantRecords.map((s) => s.tmuxSession))].sort();
    return { kind: 'ambiguous', via: 'prefix', candidates: names, reason: `${roles.size} roles share names that normalize alike` };
  }
  const byPrefix = decide('prefix', running.filter((s) => normalizeTmuxName(s.tmuxSession, ctx.prefix) === norm));
  if (byPrefix) return byPrefix;
  if (staleHolderSeen) return stale();

  return { kind: 'none', reason: isJob ? 'job-run-ended' : 'no-session-holds-this-role' };
}

/** A role is its stored name with one leading `<prefix>-` removed. */
export function roleKey(s: Pick<ResolverSession, 'name' | 'jobSlug' | 'telegramTopicId'>, prefix: string): string {
  const p = `${prefix}-`;
  const n = s.name.startsWith(p) ? s.name.slice(p.length) : s.name;
  return `${s.jobSlug ? `job:${s.jobSlug}` : s.telegramTopicId !== undefined ? `topic:${s.telegramTopicId}` : 'name'}|${n}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
