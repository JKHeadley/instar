/**
 * conversationIdentity.ts — the SINGLE hash + identity surface for durable,
 * channel-agnostic conversation identity (docs/specs/durable-conversation-identity.md §4).
 *
 * This module absorbs `slackRefreshBinding`'s key helpers and is the ONE place
 * the legacy 32-bit sum-shift hash + mint-candidate formula live going forward.
 * The three legacy copies (`server.ts slackChannelToSyntheticId`, the
 * `routes.ts` build-heartbeat inline copy, `slackRefreshBinding.ts
 * slackRoutingKeySyntheticId`) consolidate onto these exports in the §4
 * foundation increment; a FOURTH copy of the mint idiom is a CI failure
 * (tests/unit/conversation-identity-mint-idiom-ratchet.test.ts).
 *
 * Spec §3.1: the PRIMARY identity of a conversation is the structured tuple
 * `(platform, channelId, threadTs?)` bound to a stable minted NEGATIVE id; the
 * canonical key string (`slack:<teamId>:<channelId>[:<threadTs>]`) is its
 * normalized LOOKUP form, and `workspaceId` is identity-adjacent metadata
 * (upgradable in place, `_` placeholder when unknown). Telegram positive ids
 * pass through unregistered, forever.
 */

/** Tuple schema version (§Glossary). v1 is SINGLE-WORKSPACE: the tuple carries
 *  no workspaceId — correct only because exactly one workspace is enforced
 *  (§3.1). Phase 7.1 introduces schema-version 2 with workspaceId in the core. */
export const TUPLE_SCHEMA_VERSION = 1;

/**
 * §3.3/§3.5 frozen constants — schema-v1, changed ONLY by a versioned
 * migration (a mixed fleet comparing different bounds/windows would pick
 * divergent accept/quarantine verdicts). Pinned by the §10 golden-parity test.
 */
export const MAX_PROBE_DISTANCE = 64;
/** Probe direction is DOWN (`id -= 1`) and FROZEN FOREVER (frontloaded decision 2). */
export const PROBE_DIRECTION = -1;
/** HLC `physical` unit: MILLISECONDS since the Unix epoch (frozen, schema-v1 — R3-M10). */
export const HLC_ABS_MIN = 1767225600000; // 2026-01-01T00:00:00Z
export const HLC_ABS_MAX = 4102444800000; // 2100-01-01T00:00:00Z — documented horizon; re-pin via versioned migration WELL before

/** §3.5 ingest shape clamps (also applied at the §6.3 mint site — security-M1c). */
export const SLACK_CHANNEL_ID_RE = /^[CDG][A-Z0-9]+$/;
export const SLACK_THREAD_TS_RE = /^\d{10}\.\d{6}$/;
export const SLACK_WORKSPACE_ID_RE = /^T[A-Z0-9]+$/;
/** The unknown-workspace placeholder (§3.1) — upgrades in place to a concrete teamId. */
export const WORKSPACE_PLACEHOLDER = '_';

/** The Phase-1 structured tuple (§3.1). `threadTs: null` = channel-level. */
export interface ConversationTuple {
  platform: 'slack';
  channelId: string;
  threadTs: string | null;
}

/**
 * The frozen 32-bit sum-shift hash over a routing key — byte-identical to the
 * three legacy copies (golden-parity pinned in §10). NEVER change this: mixed-
 * fleet convergence and zero-loss adoption both depend on it (§3.3 properties 1/2).
 */
export function sumShiftHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * The deterministic mint CANDIDATE for a routing key (§3.3):
 * `-(abs(hash) + 1)` — always negative, never 0, value-identical to
 * `slackRoutingKeySyntheticId` (thread-aware: hashes `channelId[:threadTs]`).
 * This is the mint candidate, no longer an identity authority — the registry
 * is the collision authority.
 */
export function candidateIdForRoutingKey(routingKey: string): number {
  return -(Math.abs(sumShiftHash(routingKey)) + 1);
}

/** Adapter routing-key tail for a tuple: `<channelId>[:<threadTs>]` (§3.1). */
export function routingKeyForTuple(tuple: ConversationTuple): string {
  return tuple.threadTs ? `${tuple.channelId}:${tuple.threadTs}` : tuple.channelId;
}

/**
 * Parse a Slack routing key (`C…` or `C…:<thread_ts>`) into a v1 tuple.
 * Returns null when the shape is invalid (§3.6: callers treat as "no durable
 * id" and keep legacy behavior — a typed refusal, never a throw).
 * Shape validation here is the §7 mesh-forward guard (security-M1c): a
 * forwarded/replayed inbound cannot supply a crafted key to force a target
 * candidate.
 */
export function tupleForRoutingKey(routingKey: string): ConversationTuple | null {
  const idx = routingKey.indexOf(':');
  const channelId = idx === -1 ? routingKey : routingKey.slice(0, idx);
  const threadTs = idx === -1 ? null : routingKey.slice(idx + 1);
  if (!SLACK_CHANNEL_ID_RE.test(channelId)) return null;
  if (threadTs !== null && !SLACK_THREAD_TS_RE.test(threadTs)) return null;
  return { platform: 'slack', channelId, threadTs };
}

/**
 * The §3.4 tupleKey — the IMMUTABLE byte-form used for the tuple index AND the
 * `≺` tiebreak (§3.5.1: null `threadTs` compares as the EMPTY string, so a
 * channel-level tuple deterministically precedes its own threads).
 */
export function tupleKeyFor(tuple: ConversationTuple): string {
  return `${tuple.platform}\x1f${tuple.channelId}\x1f${tuple.threadTs ?? ''}`;
}

/**
 * Canonical key (§3.1): `slack:<teamId>:<channelId>[:<threadTs>]` with `_`
 * for an unknown teamId. The normalized lookup/display string — NOT the
 * primary identity (the tuple is).
 */
export function canonicalKeyFor(tuple: ConversationTuple, workspaceId: string | undefined): string {
  const team = workspaceId && SLACK_WORKSPACE_ID_RE.test(workspaceId) ? workspaceId : WORKSPACE_PLACEHOLDER;
  const base = `${tuple.platform}:${team}:${tuple.channelId}`;
  return tuple.threadTs ? `${base}:${tuple.threadTs}` : base;
}

/** Parse a canonical key back to `{ tuple, workspaceId }`, or null when malformed. */
export function parseCanonicalKey(key: string): { tuple: ConversationTuple; workspaceId: string } | null {
  const parts = key.split(':');
  if (parts.length < 3 || parts.length > 4 || parts[0] !== 'slack') return null;
  const [, workspaceId, channelId, threadTs] = parts;
  if (workspaceId !== WORKSPACE_PLACEHOLDER && !SLACK_WORKSPACE_ID_RE.test(workspaceId)) return null;
  if (!SLACK_CHANNEL_ID_RE.test(channelId)) return null;
  if (threadTs !== undefined && !SLACK_THREAD_TS_RE.test(threadTs)) return null;
  return { tuple: { platform: 'slack', channelId, threadTs: threadTs ?? null }, workspaceId };
}

/** Result of a displacement walk (§3.3 probe / §3.5.1 step 2). */
export type DisplacementResult =
  | { ok: true; id: number; probes: number }
  | { ok: false; overflow: true };

/**
 * The ONE shared displacement implementation (§3.3 = §3.5.1 step 2 — pinned by
 * the §10 shared-implementation equivalence test; R2-adversarial-2). Walks the
 * FROZEN down-sequence `candidate, candidate-1, candidate-2, …` and returns
 * the first offset for which `collides(id)` is false, bounded by
 * `MAX_PROBE_DISTANCE` (= the ingest coherence bound, so a local mint can
 * never produce an id a peer's ingest would quarantine as a pre-squat).
 *
 * `collides` MUST be the pure §3.3 `candidateCollides` predicate — reserved
 * canonicals (a), the alias table (b), and the GLOBAL displaced-assignment set
 * (c) — each an O(1) lookup, NEVER a live-tuple scan (R2-scalability-1). A
 * walk exceeding the bound degrades to the §3.6 pending-mint path.
 */
export function walkDisplacement(candidate: number, collides: (id: number) => boolean): DisplacementResult {
  let id = candidate;
  let probes = 0;
  while (collides(id)) {
    id += PROBE_DIRECTION;
    probes++;
    if (probes > MAX_PROBE_DISTANCE) return { ok: false, overflow: true };
  }
  return { ok: true, id, probes };
}
