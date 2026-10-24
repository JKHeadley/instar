/**
 * peerHomebase — naming and binding decisions for a peer agent's homebase topic.
 *
 * Spec: docs/specs/peer-conversation-homebase-topic.md (the 80/20 version — the operator
 * stopped a 21-round draft for over-engineering; §6 there lists what is deliberately accepted).
 *
 * The two decisions a homebase needs are both small, both pure, and both easy to get
 * dangerously wrong, so they live here rather than inline at the callsite:
 *
 *  1. What is the topic called? A display name alone is not unique — two peers may choose the
 *     same one, and find-or-create keys on the name, so they would silently share one topic.
 *  2. May this conversation be bound to it? Getting this wrong in the permissive direction
 *     destroys an operator's deliberate choice, which is the one thing the feature promises
 *     not to do.
 */

/** The three transports of provenance; absent means a record predating the field. */
export type BoundTopicSource = 'operator' | 'origin-inherited' | 'peer-homebase';

export interface HomebaseBindCandidate {
  /** The topic currently bound, if any. */
  boundTopicId?: number;
  /** Who chose it. ABSENT is the legacy case and is deliberately NOT bindable. */
  boundTopicSource?: BoundTopicSource;
}

/** How much of the fingerprint goes in the name. Short enough to read, long enough to separate. */
export const HOMEBASE_FP_SUFFIX_LEN = 6;

/** The prefix the operator chose for a peer's topic ("🤝 PP"). */
export const HOMEBASE_PREFIX = '🤝';

function shortFp(peerFingerprint: string): string {
  return peerFingerprint.replace(/[^0-9a-zA-Z]/g, '').slice(0, HOMEBASE_FP_SUFFIX_LEN);
}

function displayName(peerName: string): string {
  return peerName.trim() || 'unknown peer';
}

/**
 * `"🤝 <peer>"` — the name the operator agreed to. The peer's own name is used exactly as
 * given (no casing invented).
 *
 * find-or-create keys on the NAME while the map keys by fingerprint, so two different peers
 * sharing a display name would silently share one topic. Only in that collision case does the
 * short fingerprint get appended (`"🤝 <peer> · <fp6>"`). Two peers sharing both the name and
 * the first six fingerprint characters still collide, which spec §6 accepts.
 */
export function homebaseTopicName(
  peerName: string,
  peerFingerprint: string,
  opts: { collides?: boolean } = {},
): string {
  const name = displayName(peerName);
  const fp = shortFp(peerFingerprint);
  return opts.collides && fp ? `${HOMEBASE_PREFIX} ${name} · ${fp}` : `${HOMEBASE_PREFIX} ${name}`;
}

/** The pre-rename form, `"<peer> · Threadline · <fp6>"`, kept so existing topics are found, not duplicated. */
export function legacyHomebaseTopicName(peerName: string, peerFingerprint: string): string {
  const name = displayName(peerName);
  const fp = shortFp(peerFingerprint);
  return fp ? `${name} · Threadline · ${fp}` : `${name} · Threadline`;
}

/** True when a topic name has the legacy `"… · Threadline[ · fp]"` shape. */
export function isLegacyHomebaseName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /\s·\sThreadline(\s·\s[0-9a-zA-Z]{1,12})?$/.test(name.trim());
}

/** Does another peer (different fingerprint) already use this display name? Case-insensitive. */
export function displayNameCollides(
  peerFp: string,
  peerName: string,
  peers: ReadonlyArray<{ fingerprint?: string; agent?: string }>,
): boolean {
  const want = displayName(peerName).toLowerCase();
  return peers.some((p) => !!p.fingerprint && p.fingerprint !== peerFp && displayName(p.agent ?? '').toLowerCase() === want);
}

export type BindVerdict =
  /** Nothing was chosen, or the record proves the binding was accidental. */
  | { bind: true; reason: 'no-binding' | 'origin-inherited' }
  /** A choice exists, or might exist. Left alone. */
  | { bind: false; reason: 'operator' | 'unknown-provenance' | 'already-homebase' };

/**
 * May this conversation be re-pointed at its peer's homebase?
 *
 * The load-bearing row is `unknown-provenance`. A binding with no provenance may be a
 * deliberate operator bind made before the field existed, so it is PRESERVED. An earlier draft
 * of the spec treated absent provenance as bindable, which would have overwritten exactly the
 * choices the feature promises to protect — the external reviewer caught it, and this function
 * is where that correction lives.
 *
 * `pp`'s own conversation is in that class, which is why re-homing it is the operator's explicit
 * request (already made) rather than something this code does on its own.
 */
export function decideHomebaseBind(c: HomebaseBindCandidate): BindVerdict {
  if (c.boundTopicSource === 'operator') return { bind: false, reason: 'operator' };
  if (c.boundTopicSource === 'peer-homebase') return { bind: false, reason: 'already-homebase' };
  if (typeof c.boundTopicId !== 'number') return { bind: true, reason: 'no-binding' };
  if (c.boundTopicSource === 'origin-inherited') return { bind: true, reason: 'origin-inherited' };
  return { bind: false, reason: 'unknown-provenance' };
}

/**
 * Which conversation gets bound when a homebase is created.
 *
 * Zero is the NORMAL case (pairing can precede any conversation) and many is the ambiguous one.
 * Binding none of several is deliberate: an unbound conversation already routes to the homebase,
 * and choosing between bound ones is the operator's call (§6 cuts per-conversation offers).
 */
export function selectConversationToBind<T extends HomebaseBindCandidate>(
  conversations: readonly T[],
): { conversation: T; verdict: BindVerdict } | { conversation: null; reason: 'none' | 'ambiguous' } {
  if (conversations.length === 0) return { conversation: null, reason: 'none' };
  if (conversations.length > 1) return { conversation: null, reason: 'ambiguous' };
  const only = conversations[0]!;
  return { conversation: only, verdict: decideHomebaseBind(only) };
}

// ── Creation ────────────────────────────────────────────────────────────────

export interface EnsureHomebaseDeps {
  /** Gate. Absent/false ⇒ strict no-op, so an un-flipped agent behaves exactly as before. */
  enabled: boolean;
  /**
   * Only the serving-lease holder creates. A standby that creates would mint a second topic
   * per boot — the failure that produced 41 duplicate "Updates" topics before the
   * system-topic pattern existed.
   */
  holdsLease: boolean;
  /** Idempotent on the name: an existing topic with it is reused, never duplicated. */
  findOrCreateTopic: (name: string) => Promise<{ topicId: number; reused: boolean }>;
  /**
   * Look up an existing topic by exact name WITHOUT creating one. Used to adopt a topic that
   * still carries the legacy name so a rename never mints a duplicate. Optional.
   */
  findTopicByName?: (name: string) => number | undefined;
  /** Best-effort rename (Telegram editForumTopic). Optional; failures are logged, never thrown. */
  renameTopic?: (topicId: number, name: string) => Promise<boolean>;
  /** True when another peer shares this display name — the fingerprint suffix is then appended. */
  nameCollides?: (peerFp: string, peerName: string) => boolean;
  /** The peer's already-recorded homebase, if any. */
  getRecorded: (peerFp: string) => number | undefined;
  /** Records it. Returns false if it refuses (e.g. a different id already stands). */
  record: (peerFp: string, topicId: number) => boolean;
  log?: (msg: string) => void;
}

export type EnsureHomebaseResult =
  | { created: false; reason: 'disabled' | 'not-lease-holder' | 'no-fingerprint' }
  | { created: false; reason: 'already-recorded'; topicId: number }
  | { created: false; reason: 'create-failed' | 'record-refused' }
  | { created: true; topicId: number; reused: boolean };

/**
 * Ensure a mutually-verified peer has a homebase topic.
 *
 * Called DOWNSTREAM of the trust write and never inside it: creating a Telegram topic is an
 * external side-effect, and a failure here must never fail or delay a pairing. Every failure
 * path therefore returns a reason rather than throwing, and the caller treats it as
 * best-effort — the peer simply has no homebase, which routes to existing behaviour.
 *
 * It does NOT bind any conversation. An unbound conversation already resolves to the homebase
 * at routing time, so a write would add risk for no behavioural gain, and re-pointing an
 * already-bound one is an explicit operator action (spec §2N.4).
 */
export async function ensurePeerHomebase(
  peerFp: string,
  peerName: string,
  d: EnsureHomebaseDeps,
): Promise<EnsureHomebaseResult> {
  if (!d.enabled) return { created: false, reason: 'disabled' };
  if (!peerFp) return { created: false, reason: 'no-fingerprint' };
  if (!d.holdsLease) return { created: false, reason: 'not-lease-holder' };

  const existing = d.getRecorded(peerFp);
  if (typeof existing === 'number') return { created: false, reason: 'already-recorded', topicId: existing };

  const collides = d.nameCollides?.(peerFp, peerName) ?? false;
  const name = homebaseTopicName(peerName, peerFp, { collides });
  let topicId: number;
  let reused: boolean;
  try {
    // A topic left under the legacy name (created before the rename, then not recorded) is
    // adopted and renamed rather than duplicated.
    const legacyId = d.findTopicByName?.(legacyHomebaseTopicName(peerName, peerFp));
    if (typeof legacyId === 'number') {
      topicId = legacyId;
      reused = true;
      await renameBestEffort(d, legacyId, name);
    } else {
      const r = await d.findOrCreateTopic(name);
      topicId = r.topicId;
      reused = r.reused;
    }
  } catch (err) {
    d.log?.(`[homebase] create failed for ${peerFp.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    return { created: false, reason: 'create-failed' };
  }

  if (!d.record(peerFp, topicId)) {
    // A different id already stands. The topic just created (or reused) is left alone rather
    // than deleted — it may carry messages — and the refusal is surfaced, not swallowed.
    d.log?.(`[homebase] record refused for ${peerFp.slice(0, 12)} (topic ${topicId})`);
    return { created: false, reason: 'record-refused' };
  }
  return { created: true, topicId, reused };
}

async function renameBestEffort(d: Pick<EnsureHomebaseDeps, 'renameTopic' | 'log'>, topicId: number, name: string): Promise<boolean> {
  if (!d.renameTopic) return false;
  try {
    const ok = await d.renameTopic(topicId, name);
    if (!ok) d.log?.(`[homebase] rename of topic ${topicId} to "${name}" did not apply`);
    return ok;
  } catch (err) {
    d.log?.(`[homebase] rename of topic ${topicId} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── Boot-time backfill ──────────────────────────────────────────────────────

/** The fields of a trust profile the backfill reads. */
export interface BackfillPeer {
  fingerprint?: string;
  agent?: string;
  pairingState?: string;
  homebaseTopicId?: number;
}

/** Hard cap on topics touched per boot, so a large trust store can never flood Telegram. */
export const HOMEBASE_BACKFILL_MAX = 10;

/**
 * Which peers the boot backfill acts on.
 *
 * `create`: mutual-verified, has a fingerprint, no recorded homebase — the peers paired before
 * homebases shipped (or whose creation failed). `rename`: a recorded homebase whose current
 * topic name is still the legacy `"… · Threadline · fp"` form. Both lists are bounded.
 */
export function selectHomebaseBackfill<T extends BackfillPeer>(
  peers: readonly T[],
  topicNameOf: (topicId: number) => string | null | undefined,
  max: number = HOMEBASE_BACKFILL_MAX,
): { create: T[]; rename: T[] } {
  const verified = peers.filter((p) => p.pairingState === 'mutual-verified' && !!p.fingerprint);
  const create = verified.filter((p) => typeof p.homebaseTopicId !== 'number').slice(0, max);
  const rename = verified
    .filter((p) => typeof p.homebaseTopicId === 'number' && isLegacyHomebaseName(topicNameOf(p.homebaseTopicId)))
    .slice(0, max);
  return { create, rename };
}

export interface BackfillResult {
  created: number;
  renamed: number;
  failed: number;
}

/**
 * Give every already-paired peer a homebase, and move legacy-named ones to the new name.
 * Same gate and lease rule as `ensurePeerHomebase` (it calls it). Never throws.
 */
export async function backfillPeerHomebases(
  peers: readonly BackfillPeer[],
  d: EnsureHomebaseDeps & { topicNameOf: (topicId: number) => string | null | undefined; max?: number },
): Promise<BackfillResult> {
  const out: BackfillResult = { created: 0, renamed: 0, failed: 0 };
  if (!d.enabled || !d.holdsLease) return out;
  const { create, rename } = selectHomebaseBackfill(peers, d.topicNameOf, d.max);
  for (const p of create) {
    try {
      const r = await ensurePeerHomebase(p.fingerprint!, p.agent ?? p.fingerprint!, d);
      if (r.created) out.created++;
      else if (r.reason !== 'already-recorded') out.failed++;
    } catch (err) {
      out.failed++;
      d.log?.(`[homebase] backfill failed for ${p.fingerprint!.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const p of rename) {
    const collides = d.nameCollides?.(p.fingerprint!, p.agent ?? '') ?? false;
    const ok = await renameBestEffort(d, p.homebaseTopicId!, homebaseTopicName(p.agent ?? '', p.fingerprint!, { collides }));
    if (ok) out.renamed++;
    else out.failed++;
  }
  return out;
}
