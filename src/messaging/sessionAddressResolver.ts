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
 * rule) and whose conversation is not standing down. A relay maps sender-measured
 * message age to the receiving clock without an artificial ten-minute subtraction.
 * Never crosses agents: the input is this agent's own session records.
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
  /** The message's reference time (ms since epoch): when it was written, on one clock. */
  asOf: number;

}

export type ResolveVia = 'exact' | 'topic' | 'name' | 'prefix';

export type ResolveResult =
  | { kind: 'exact' | 'redirected'; session: ResolverSession; via: ResolveVia }
  | { kind: 'ambiguous'; candidates: string[]; via: ResolveVia; reason: string }
  | {
      kind: 'none';
      reason: NoneReason;
      heldOn?: string;
      /**
       * relay-asof-holder-skew: the store knows this role (a record under this name, a
       * normalized twin, or a record bound to the named topic) although nobody runs it
       * now. A known role may come back; an unknown name never will.
       */
      known?: boolean;
      /** `role-respawned-after-message`: when the holder that was too new started (ISO). */
      holderStartedAt?: string;
      expectedSessionId?: string;
    };

export type NoneReason =
  | 'no-session-holds-this-role'
  | 'role-respawned-after-message'
  | 'target-session-generation-changed'
  | 'target-session-generation-unavailable'
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
  let staleHolder: ResolverSession | null = null;

  const decide = (via: ResolveVia, matches: ResolverSession[]): ResolveResult | null => {
    if (matches.length === 0) return null;
    const ok = matches.filter(fresh);
    if (ok.length === 0) {
      // Remember the earliest-started too-new holder: the one the message missed by least.
      staleHolder = matches.reduce((a, b) => (startedMs(b) < startedMs(a) ? b : a));
      return null;
    }
    if (ok.length > 1) {
      return { kind: 'ambiguous', via, candidates: ok.map((s) => s.tmuxSession).sort(), reason: `${ok.length} sessions could hold this role` };
    }
    return { kind: via === 'exact' ? 'exact' : 'redirected', session: ok[0], via };
  };
  const staleHolderSeen = () => staleHolder !== null;
  const stale = (): ResolveResult => ({
    kind: 'none', reason: 'role-respawned-after-message', known: true,
    ...(staleHolder ? { holderStartedAt: (staleHolder as ResolverSession).startedAt } : {}),
  });

  // 1. exact
  const exact = decide('exact', running.filter((s) => s.tmuxSession === target));
  if (exact) return exact;
  if (staleHolderSeen()) return stale();

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
    if (staleHolderSeen()) return stale();
    const elsewhere = ctx.topicHeldElsewhere?.(topicId) ?? null;
    if (elsewhere) return { kind: 'none', reason: 'topic-held-on', heldOn: elsewhere };
    // Known here when some record of this machine (any status) carried the topic.
    const knownTopic = ctx.sessions.some((s) => s.telegramTopicId === topicId);
    return { kind: 'none', reason: 'topic-not-held-here', known: knownTopic };
  }

  // Job runs resolve only by exact or prefix.
  const isJob = !!newest?.jobSlug;

  // 3. same name, topic-less and job-less roles only
  if (newest && !isJob) {
    const byName = decide('name', running.filter((s) => s.name === newest.name && s.telegramTopicId === undefined));
    if (byName) return byName;
    if (staleHolderSeen()) return stale();
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
  if (staleHolderSeen()) return stale();

  if (isJob) return { kind: 'none', reason: 'job-run-ended' };
  // Known when any record (any status) carries this name or a prefix-equivalent of it.
  return { kind: 'none', reason: 'no-session-holds-this-role', known: !!newest || claimantRecords.length > 0 };
}

/**
 * relay-asof-holder-skew: is this refusal one the holder may yet settle? True for a
 * role the store knows but nobody runs yet, and for a holder that started too late:
 * the message waits in the retry lane (re-resolved each pass) instead of failing at
 * once, and the sender is told plainly when the lane is exhausted.
 */
export function isHolderPendingRefusal(res: ResolveResult): boolean {
  if (res.kind !== 'none') return false;
  if (res.reason === 'role-respawned-after-message') return true;
  return (res.reason === 'no-session-holds-this-role' || res.reason === 'topic-not-held-here') && res.known === true;
}

/**
 * A plain-words account of a holder refusal, for the sender's notice and the
 * delivery transition. Times are quoted as the receiver read them.
 */
export function describeHolderRefusal(res: ResolveResult, target: string, asOf: number): string {
  if (res.kind !== 'none') return res.kind === 'ambiguous' ? res.reason : 'delivered';
  const ref = Number.isFinite(asOf) ? new Date(asOf).toISOString() : 'an unknown time';
  switch (res.reason) {
    case 'target-session-generation-unavailable':
      return `the sending machine could not verify which session held "${target}" before creating this message; delivery cannot safely choose a generation`;
    case 'target-session-generation-changed':
      return `the session holding "${target}" is no longer the generation selected before this message was sent (${res.expectedSessionId ?? 'unknown'}); no replacement may receive it`;
    case 'role-respawned-after-message':
      return `the session holding "${target}" started at ${res.holderStartedAt ?? 'an unknown time'}, after this message was written at ${ref}; delivery to that replacement is not allowed`;
    case 'no-session-holds-this-role':
      return res.known
        ? `"${target}" is known here but no session holds it right now`
        : `no session holds "${target}"`;
    case 'topic-not-held-here':
      return res.known
        ? `the conversation "${target}" names is known here but no session holds it right now`
        : `the conversation "${target}" names is not held on this machine`;
    case 'topic-held-on':
      return `the conversation "${target}" names is held on ${res.heldOn ?? 'another machine'}`;
    case 'job-run-ended':
      return `the job run "${target}" has ended`;
  }
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
