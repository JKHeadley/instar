/**
 * AgentIdentityCoherence — loud cross-machine identity mismatch: one formula, one episode,
 * one item.
 *
 * Spec: docs/specs/a2a-single-agent-identity.md §2.1 (one comparison value — the routing
 * fingerprint), §2.2 (the detector, fixed and continuous).
 * Constitution: "Verify the State, Not Its Symbol"; "No Silent Degradation";
 * "Bounded Notification Surface".
 *
 * WHY. The parent's boot-time detector compared two different fingerprint formulas and so
 * fired identically on healthy and broken fleets (`SPLIT: 63b1… vs ff2e…` on a fully repaired
 * agent) — a detector that always cries wolf is ignored, which is how the 2026-10-05→09 loss
 * went unreported. It also ran once, 90 s after boot.
 *
 * WHAT CHANGES. The ONLY value compared is `computeFingerprint(pub)` (raw public-key prefix).
 * SELF contributes TWO values: the on-disk file (single reader) AND the fingerprint the running
 * relay client is connected as (`connectedAs`) — a file repaired while the process still
 * speaks under the old key must never read as healthy. It runs every 5 min with an in-flight
 * guard. A peer whose presence reads OFFLINE is `unobserved` (not fetched, not counted); an
 * ONLINE peer that does not answer is `cannot-tell` for that peer. States:
 *   - `disagree`      whenever ANY two observed values differ;
 *   - `agree`         only when every ACTIVE sibling has been observed (since the last repair)
 *                     and all match;
 *   - `partial-agree` ≥2 observed, all match, some active sibling unobserved;
 *   - `cannot-tell`   fewer than two values observed.
 * Item `agent-identity-split:<agent>:<sorted fp set>` (high) is RAISED AND RESOLVED by the
 * serving-lease holder ONLY (attention items are a per-machine store; a raise elsewhere would
 * strand a copy) — after 2 consecutive `disagree` reads, and resolved after 2 consecutive
 * rounds in which every split member that is still ACTIVE (or revoked but still online) was
 * re-observed and the round holds exactly ONE value (a sleeping non-member never blocks; a
 * revoked AND offline member drops out). A non-holder's `disagree` is a health state.
 * `cannot-tell` is counted per peer ONLY while that peer is online; 10 consecutive such
 * rounds, after a presence re-pull, produce one degradation row and ONE medium item.
 *
 * @self-action-controller: agent-identity-coherence-detector
 */

import type { AgentIdentityAudit } from './AgentIdentityAudit.js';

export type IdentityCoherenceState = 'agree' | 'partial-agree' | 'disagree' | 'cannot-tell';

export type CoherenceObservationStatus = 'observed' | 'unobserved' | 'cannot-tell';

export interface CoherenceObservation {
  /** `self` for this machine's two readings; otherwise the sibling's machine id. */
  machineId: string;
  nickname: string;
  /** Which reading this is. */
  source: 'self-disk' | 'self-connected' | 'peer';
  fingerprint: string | null;
  status: CoherenceObservationStatus;
  reason?: string;
}

export interface CoherenceVerdict {
  state: IdentityCoherenceState;
  /** Distinct fingerprints observed this round, sorted. */
  values: string[];
  /** Observed machines (nicknames) grouped by the value they publish. */
  byValue: Record<string, string[]>;
  /** Machine ids that contributed an OBSERVED value this round (self counts once). */
  observedMachineIds: string[];
  unobserved: string[];
  cannotTell: string[];
  /** The item id a `disagree` maps to. */
  episodeKey: string | null;
  /** Display label → machine id for peer labels (self labels carry a (disk)/(relay) suffix). */
  labelToMachineId?: Record<string, string>;
}

/**
 * Pure verdict over one round's observations. `activeSiblingIds` is the registry's ACTIVE
 * sibling set; `observedSinceRepair` is the detector's memory of which siblings have been
 * observed at least once since the last repair (so `agree` stays strict across rounds).
 */
export function evaluateIdentityCoherence(input: {
  agentName: string;
  observations: CoherenceObservation[];
  activeSiblingIds: string[];
  observedSinceRepair?: Set<string>;
}): CoherenceVerdict {
  const byValue: Record<string, string[]> = {};
  const observedMachineIds = new Set<string>();
  const unobserved: string[] = [];
  const cannotTell: string[] = [];
  const labelToMachineId: Record<string, string> = {};
  for (const o of input.observations) {
    if (o.status === 'observed' && o.fingerprint) {
      const label = o.source === 'self-disk' ? `${o.nickname} (disk)` : o.source === 'self-connected' ? `${o.nickname} (relay)` : o.nickname;
      (byValue[o.fingerprint] ??= []).push(label);
      if (o.source === 'peer') labelToMachineId[label] = o.machineId;
      observedMachineIds.add(o.machineId);
    } else if (o.status === 'unobserved') unobserved.push(o.machineId);
    else if (o.status === 'cannot-tell') cannotTell.push(o.machineId);
  }
  const values = Object.keys(byValue).sort();
  const observedValueCount = input.observations.filter((o) => o.status === 'observed' && o.fingerprint).length;
  const episodeKey = values.length > 1 ? `agent-identity-split:${input.agentName}:${values.join('+')}` : null;

  if (values.length > 1) {
    return { state: 'disagree', values, byValue, observedMachineIds: [...observedMachineIds], unobserved, cannotTell, episodeKey, labelToMachineId };
  }
  if (observedValueCount < 2) {
    return { state: 'cannot-tell', values, byValue, observedMachineIds: [...observedMachineIds], unobserved, cannotTell, episodeKey: null, labelToMachineId };
  }
  const seen = new Set<string>([...observedMachineIds, ...(input.observedSinceRepair ?? [])]);
  const everyActiveSeen = input.activeSiblingIds.every((id) => seen.has(id));
  return {
    state: everyActiveSeen ? 'agree' : 'partial-agree',
    values,
    byValue,
    observedMachineIds: [...observedMachineIds],
    unobserved,
    cannotTell,
    episodeKey: null,
    labelToMachineId,
  };
}

// ── The detector ───────────────────────────────────────────────────────────

export interface CoherenceSibling {
  machineId: string;
  nickname: string;
}

export interface CoherenceAttentionItem {
  id: string;
  title: string;
  body: string;
  priority: 'high' | 'medium';
  /** `contributors {machineId: fp}` on a split item — the required re-observe set (§2.2). */
  metadata?: Record<string, unknown>;
}

/** Peer/machine names render clamped + HTML-escaped: registry text never reaches an item raw. */
export function safeName(name: unknown, fallback = 'a machine'): string {
  const raw = typeof name === 'string' ? name.trim() : '';
  if (!raw) return fallback;
  return raw.slice(0, 48).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export interface IdentityCoherenceDetectorDeps {
  agentName: string;
  selfMachineId: string;
  selfNickname: string;
  /** This machine's on-disk routing fingerprint via the single reader (null = none). */
  readSelfDisk: () => string | null;
  /**
   * The fingerprint the running relay client is CONNECTED as, or null when there is no live
   * relay connection in this process (standby / daemon-handled / disconnected) — null is
   * "no second self reading", never a disagreement.
   */
  connectedAs: () => string | null;
  /** Registered ACTIVE siblings (never self). */
  listActiveSiblings: () => CoherenceSibling[];
  /** Registered REVOKED siblings — fetched ONLY when they are split members still online. */
  listRevokedSiblings?: () => CoherenceSibling[];
  /** Is a sibling still ACTIVE in the registry (a revoked AND offline split member drops out)? */
  isMachineActive: (machineId: string) => boolean;
  /** Presence: true online, false offline, null unknown (unknown is fetched). */
  isOnline: (machineId: string) => boolean | null;
  /** Fetch a sibling's published routing fingerprint (`/provenance`), null on any failure. */
  fetchPeerFingerprint: (sibling: CoherenceSibling) => Promise<string | null>;
  /** Optional self-heal before escalating a chronic cannot-tell: re-pull that peer's presence. */
  refreshPresence?: (machineId: string) => Promise<void> | void;
  holdsLease: () => boolean;
  raiseItem: (item: CoherenceAttentionItem) => void;
  resolveItem: (id: string) => void;
  /**
   * Base ids of items still OPEN in this machine's attention store under `prefix`. The
   * detector holds its open split episodes and its escalated cannot-tell peers in memory;
   * after a restart it re-adopts these so an item raised before the restart is still resolved
   * once its condition clears (it would otherwise stay open forever).
   */
  openItemIds?: (prefix: string) => string[];
  reportDegradation?: (row: { feature: string; primary: string; fallback: string; reason: string; impact: string }) => void;
  audit?: AgentIdentityAudit;
  now?: () => number;
  intervalMs?: number; // default 5 min
  raiseAfterConsecutive?: number; // default 2
  resolveAfterConsecutive?: number; // default 2
  cannotTellEscalateAfter?: number; // default 10
}

export interface IdentityCoherenceHealth {
  state: IdentityCoherenceState | 'not-run';
  connectedAs: string | null;
  selfDisk: string | null;
  siblingsPublish: Record<string, { nickname: string; fingerprint: string | null; status: CoherenceObservationStatus; reason?: string }>;
  cannotTellRounds: Record<string, number>;
  lastCheckedAt: string | null;
  /** The most recently raised split item this machine still holds open, or null. */
  openEpisode: { itemId: string; values: string[]; members: string[]; raisedAt: string; cleanRounds: number } | null;
  /** How many split items this machine raised and still holds open (a third value opens a second). */
  openEpisodeCount: number;
  consecutiveDisagree: number;
}

interface Episode {
  itemId: string;
  values: string[];
  /** Machine ids that contributed a differing value when the item was raised. */
  members: string[];
  raisedAt: number;
  /** Consecutive clean rounds (every still-active member re-observed, one value). */
  cleanRounds: number;
}

export class IdentityCoherenceDetector {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private lastVerdict: CoherenceVerdict | null = null;
  private lastSiblings: Record<string, IdentityCoherenceHealth['siblingsPublish'][string]> = {};
  private lastSelfDisk: string | null = null;
  private lastConnectedAs: string | null = null;
  private lastCheckedAt: number | null = null;
  private consecutiveDisagree = 0;
  private pendingEpisodeValues: string | null = null;
  /** Every split item THIS machine raised and has not yet resolved (a third value opens a second one). */
  private episodes: Episode[] = [];
  private readonly cannotTellRounds = new Map<string, number>();
  private readonly cannotTellEscalated = new Set<string>();
  private readonly observedSinceRepair = new Set<string>();
  private lastState: IdentityCoherenceState | null = null;

  constructor(private readonly d: IdentityCoherenceDetectorDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  start(initialDelayMs = 0): void {
    if (this.timer) return;
    const every = this.d.intervalMs ?? 5 * 60_000;
    const tick = () => {
      void this.runOnce().finally(() => {
        if (!this.timer) return;
        this.timer = setTimeout(tick, every);
        this.timer.unref?.();
      });
    };
    this.timer = setTimeout(tick, initialDelayMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Call after a local repair (adoption / CLI / reload) so `agree` is re-earned. */
  noteLocalRepair(): void {
    this.observedSinceRepair.clear();
  }

  health(): IdentityCoherenceHealth {
    const cannotTellRounds: Record<string, number> = {};
    for (const [k, v] of this.cannotTellRounds) cannotTellRounds[k] = v;
    const latest = this.episodes.at(-1) ?? null;
    return {
      state: this.lastVerdict?.state ?? 'not-run',
      connectedAs: this.lastConnectedAs,
      selfDisk: this.lastSelfDisk,
      siblingsPublish: { ...this.lastSiblings },
      cannotTellRounds,
      lastCheckedAt: this.lastCheckedAt === null ? null : new Date(this.lastCheckedAt).toISOString(),
      openEpisode: latest
        ? { itemId: latest.itemId, values: latest.values, members: latest.members, raisedAt: new Date(latest.raisedAt).toISOString(), cleanRounds: latest.cleanRounds }
        : null,
      openEpisodeCount: this.episodes.length,
      consecutiveDisagree: this.consecutiveDisagree,
    };
  }

  /** One round. In-flight guarded; safe to call directly in tests. */
  async runOnce(): Promise<CoherenceVerdict | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      return await this.round();
    } catch (err) {
      // @silent-fallback-ok: a detector that can take the server down is worse than the split
      // it detects. Logged so a broken detector is visible rather than quietly inert.
      console.warn('[identity-coherence] round failed (non-fatal):', err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      this.inFlight = false;
    }
  }

  private async round(): Promise<CoherenceVerdict> {
    const active = this.d.listActiveSiblings().map((s) => ({ ...s, nickname: safeName(s.nickname, s.machineId) }));
    // A revoked split member that is still ONLINE must be re-observed before the item can
    // resolve; only revoked AND offline drops out. Fetch such members alongside the active set.
    // Re-adopt split items this machine raised before a restart. Their contributor set was not
    // persisted, so the required re-observe set is the conservative one: self plus every
    // sibling active now (a sleeping one blocks resolution until it is seen — the safe side).
    for (const itemId of this.d.openItemIds?.(`agent-identity-split:${this.d.agentName}:`) ?? []) {
      if (this.episodes.some((e) => e.itemId === itemId)) continue;
      const values = itemId.slice(itemId.lastIndexOf(':') + 1).split('+');
      this.episodes.push({ itemId, values, members: [this.d.selfMachineId, ...active.map((s) => s.machineId)], raisedAt: this.now(), cleanRounds: 0 });
      this.d.audit?.append('coherence-item-readopted', { machineId: this.d.selfMachineId, itemId });
    }
    const episodeMembers = new Set(this.episodes.flatMap((e) => e.members));
    const revokedMembers = episodeMembers.size
      ? (this.d.listRevokedSiblings?.() ?? [])
          .filter((s) => episodeMembers.has(s.machineId) && this.d.isOnline(s.machineId) === true)
          .map((s) => ({ ...s, nickname: safeName(s.nickname, s.machineId) }))
      : [];
    const siblings = [...active, ...revokedMembers.filter((r) => !active.some((a) => a.machineId === r.machineId))];
    const selfDisk = this.d.readSelfDisk();
    const connectedAs = this.d.connectedAs();
    this.lastSelfDisk = selfDisk;
    this.lastConnectedAs = connectedAs;
    const observations: CoherenceObservation[] = [
      {
        machineId: this.d.selfMachineId,
        nickname: this.d.selfNickname,
        source: 'self-disk',
        fingerprint: selfDisk,
        status: selfDisk ? 'observed' : 'cannot-tell',
        ...(selfDisk ? {} : { reason: 'no-local-identity' }),
      },
    ];
    if (connectedAs) {
      observations.push({ machineId: this.d.selfMachineId, nickname: this.d.selfNickname, source: 'self-connected', fingerprint: connectedAs, status: 'observed' });
    }
    const peerRows = await Promise.all(
      siblings.map(async (s): Promise<CoherenceObservation> => {
        const online = this.d.isOnline(s.machineId);
        if (online === false) {
          return { machineId: s.machineId, nickname: s.nickname, source: 'peer', fingerprint: null, status: 'unobserved', reason: 'offline-by-presence' };
        }
        let fp: string | null = null;
        try {
          fp = await this.d.fetchPeerFingerprint(s);
        } catch {
          // @silent-fallback-ok — a peer that throws on /provenance is `cannot-tell` for the round (never `agree`), counted per peer and escalated after 10 online rounds.
          fp = null;
        }
        if (fp && /^[0-9a-f]{32}$/.test(fp)) {
          return { machineId: s.machineId, nickname: s.nickname, source: 'peer', fingerprint: fp, status: 'observed' };
        }
        return { machineId: s.machineId, nickname: s.nickname, source: 'peer', fingerprint: null, status: 'cannot-tell', reason: online === null ? 'unreachable' : 'online-but-no-answer' };
      }),
    );
    observations.push(...peerRows);

    const verdict = evaluateIdentityCoherence({
      agentName: this.d.agentName,
      observations,
      activeSiblingIds: active.map((s) => s.machineId),
      observedSinceRepair: this.observedSinceRepair,
    });
    // "Observed since the last repair": a disagree round is not a repaired state, so the
    // memory restarts there; only rounds whose observed values all match accumulate.
    if (verdict.state === 'disagree') this.observedSinceRepair.clear();
    else for (const id of verdict.observedMachineIds) this.observedSinceRepair.add(id);
    this.lastCheckedAt = this.now();
    this.lastVerdict = verdict;
    this.lastSiblings = {};
    for (const o of peerRows) this.lastSiblings[o.machineId] = { nickname: o.nickname, fingerprint: o.fingerprint, status: o.status, ...(o.reason ? { reason: o.reason } : {}) };

    if (verdict.state !== this.lastState) {
      this.lastState = verdict.state;
      this.d.audit?.append('coherence-verdict', { machineId: this.d.selfMachineId, state: verdict.state, values: verdict.values, unobserved: verdict.unobserved, cannotTell: verdict.cannotTell });
    }

    this.trackCannotTell(peerRows);
    await this.driveEpisode(verdict, siblings);
    return verdict;
  }

  private async driveEpisode(verdict: CoherenceVerdict, siblings: CoherenceSibling[]): Promise<void> {
    if (verdict.state === 'disagree' && verdict.episodeKey) {
      const key = verdict.values.join('+');
      this.consecutiveDisagree = this.pendingEpisodeValues === key ? this.consecutiveDisagree + 1 : 1;
      this.pendingEpisodeValues = key;
      for (const e of this.episodes) e.cleanRounds = 0;
      if (this.consecutiveDisagree >= (this.d.raiseAfterConsecutive ?? 2) && !this.episodes.some((e) => e.itemId === verdict.episodeKey)) {
        // RAISED by the serving-lease holder ONLY: attention items are a per-machine store, so a
        // raise elsewhere would strand a copy and post N hub messages. A non-holder's
        // `disagree` stays a health state (visible on /threadline/health) until the holder's
        // own detector confirms it — every machine runs the same check.
        if (!this.d.holdsLease()) return;
        // A different sorted set is a NEW episode (a third value, or a changed split) — the old
        // item stays open (still tracked in `episodes`) until its own resolve rule clears it; the
        // new one is raised beside it.
        // The required re-observe set is the CONTRIBUTORS (machines whose value differs from the
        // majority — or every observed machine when there is no majority), never every machine
        // that merely answered: a non-member that goes to sleep must not block resolution.
        const contributors = contributorsOf(verdict, this.d.selfMachineId, this.lastSelfDisk, this.lastConnectedAs);
        const members = Object.keys(contributors);
        this.episodes.push({ itemId: verdict.episodeKey, values: verdict.values, members, raisedAt: this.now(), cleanRounds: 0 });
        const notice = splitNotice({ agentName: this.d.agentName, byValue: verdict.byValue, selfNickname: this.d.selfNickname, connectedAs: this.lastConnectedAs, siblings, selfDisk: this.lastSelfDisk, relayHolder: this.lastConnectedAs ? this.d.selfNickname : null });
        this.d.raiseItem({ id: verdict.episodeKey, title: notice.title, body: notice.body, priority: 'high', metadata: { contributors, values: verdict.values } });
        this.d.audit?.append('coherence-item-raised', { machineId: this.d.selfMachineId, itemId: verdict.episodeKey, values: verdict.values, members, contributors });
      }
      return;
    }
    this.consecutiveDisagree = 0;
    this.pendingEpisodeValues = null;
    if (this.episodes.length === 0) return;
    // Resolve: after N consecutive rounds re-observing every split member that is still ACTIVE
    // (or revoked but still online — `instar machines remove` on an OFFLINE decommissioned
    // member is what drops it out) with exactly ONE value in the round. The item lives ONLY in
    // the store of the machine that raised it, so the RAISER resolves its own copy whether or
    // not it still holds the lease: a holder that raised the item and then lost the lease
    // would otherwise keep a `high` item open forever. Resolving a local item posts nothing
    // new, so it cannot double-post.
    for (const ep of [...this.episodes]) {
      if (verdict.values.length !== 1) {
        ep.cleanRounds = 0;
        continue;
      }
      const required = ep.members.filter((id) => id === this.d.selfMachineId || this.d.isMachineActive(id) || this.d.isOnline(id) === true);
      if (!required.every((id) => verdict.observedMachineIds.includes(id))) {
        ep.cleanRounds = 0;
        continue;
      }
      ep.cleanRounds += 1;
      if (ep.cleanRounds < (this.d.resolveAfterConsecutive ?? 2)) continue;
      this.d.resolveItem(ep.itemId);
      this.d.audit?.append('coherence-item-resolved', { machineId: this.d.selfMachineId, itemId: ep.itemId, value: verdict.values[0], reobserved: required });
      this.episodes = this.episodes.filter((e) => e !== ep);
    }
  }

  private trackCannotTell(peerRows: CoherenceObservation[]): void {
    const limit = this.d.cannotTellEscalateAfter ?? 10;
    const prefix = `agent-identity-cannot-tell:${this.d.agentName}:`;
    // Re-adopt cannot-tell items raised before a restart, so they are resolved below.
    for (const id of this.d.openItemIds?.(prefix) ?? []) this.cannotTellEscalated.add(id.slice(prefix.length));
    // An escalated peer that is no longer in the round at all (removed from the registry) or
    // that presence now reports OFFLINE is no longer "online but not answering": the item's
    // claim has stopped being true, so it is closed rather than left open forever.
    for (const machineId of [...this.cannotTellEscalated]) {
      const row = peerRows.find((o) => o.machineId === machineId);
      if (!row || row.status === 'unobserved') {
        this.cannotTellEscalated.delete(machineId);
        this.cannotTellRounds.delete(machineId);
        this.d.resolveItem(`${prefix}${machineId}`);
      }
    }
    for (const o of peerRows) {
      if (o.status === 'cannot-tell' && o.reason !== 'offline-by-presence' && this.d.isOnline(o.machineId) === true) {
        const n = (this.cannotTellRounds.get(o.machineId) ?? 0) + 1;
        this.cannotTellRounds.set(o.machineId, n);
        // Raised by the lease holder ONLY (one wedged peer on an N-machine fleet must be one
        // item, not N-1). `>=` so a machine that becomes the holder after round 10 still raises.
        if (n >= limit && !this.cannotTellEscalated.has(o.machineId) && this.d.holdsLease()) {
          // Self-heal first: re-pull that peer's presence; the escalation lands regardless of
          // the pull's outcome because the chronic condition is already ten rounds old.
          void Promise.resolve(this.d.refreshPresence?.(o.machineId)).catch(() => {
            // @silent-fallback-ok — the presence re-pull is a best-effort self-heal before the chronic cannot-tell item; its failure changes nothing about the escalation that follows.
            return undefined;
          });
          this.cannotTellEscalated.add(o.machineId);
          const id = `agent-identity-cannot-tell:${this.d.agentName}:${o.machineId}`;
          this.d.reportDegradation?.({
            feature: 'AgentIdentity.coherence',
            primary: `compare this machine's agent identity with ${o.nickname}`,
            fallback: 'the identity check cannot run against that machine; the fleet verdict stays partial or cannot-tell',
            reason: `${o.nickname} reads online but has not answered /provenance for ${n} consecutive rounds`,
            impact: 'a split involving that machine would not be detected until it answers',
          });
          this.d.raiseItem({
            id,
            title: `Identity check cannot run against ${safeName(o.nickname)}`,
            priority: 'medium',
            body: `${o.nickname} looks online but has not answered my identity check for ${n} rounds in a row (about ${Math.round((n * (this.d.intervalMs ?? 5 * 60_000)) / 60_000)} min). A split involving it would go unnoticed until it answers. I re-pulled its presence; if it is really up, its server may be wedged.`,
          });
          this.d.audit?.append('coherence-cannot-tell-escalated', { machineId: this.d.selfMachineId, peer: o.machineId, rounds: n });
        }
      } else if (o.status === 'observed') {
        this.cannotTellRounds.delete(o.machineId);
        if (this.cannotTellEscalated.delete(o.machineId)) {
          this.d.resolveItem(`agent-identity-cannot-tell:${this.d.agentName}:${o.machineId}`);
        }
      }
    }
  }
}

/**
 * `metadata.contributors {machineId: fp}` for a split item: machines whose LAST OBSERVED value
 * is not the round's (strict-majority) value — the set that must be re-observed repaired.
 * With no strict majority EVERY observed machine is a contributor. Self contributes its disk
 * value (the on-disk key is what a repair changes).
 */
export function contributorsOf(verdict: CoherenceVerdict, selfMachineId: string, selfDisk: string | null, connectedAs: string | null): Record<string, string> {
  const perMachine = machineValues(verdict, selfMachineId, selfDisk, connectedAs);
  const majority = strictMajority(perMachine);
  const out: Record<string, string> = {};
  for (const [id, fp] of Object.entries(perMachine)) if (majority === null || fp !== majority) out[id] = fp;
  return out;
}

/** One value per MACHINE (self counted once, by its on-disk value; a self disk≠relay split is noted separately). */
function machineValues(verdict: CoherenceVerdict, selfMachineId: string, selfDisk: string | null, connectedAs: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (selfDisk) out[selfMachineId] = selfDisk;
  else if (connectedAs) out[selfMachineId] = connectedAs;
  for (const [fp, labels] of Object.entries(verdict.byValue)) {
    for (const label of labels) {
      if (/ \((disk|relay)\)$/.test(label)) continue; // self, handled above
      const id = verdict.labelToMachineId?.[label] ?? label;
      out[id] = fp;
    }
  }
  return out;
}

/** The value published by a STRICT majority of machines, or null (1-vs-1, 2-vs-2, three-way…). */
export function strictMajority(perMachine: Record<string, string>): string | null {
  const counts = new Map<string, number>();
  for (const fp of Object.values(perMachine)) counts.set(fp, (counts.get(fp) ?? 0) + 1);
  const total = Object.keys(perMachine).length;
  for (const [fp, n] of counts) if (n * 2 > total) return fp;
  return null;
}

/**
 * Operator-facing text for a split (§2.2 body). Plain language first; hex as support. The
 * proposed TARGET is each machine publishing a minority value and the SOURCE any machine on
 * the strict majority; with no strict majority NO direction is proposed — the item lists each
 * value with its machines and the relay holder and asks which address peers have pinned.
 */
export function splitNotice(input: {
  agentName: string;
  byValue: Record<string, string[]>;
  selfNickname: string;
  selfDisk: string | null;
  connectedAs: string | null;
  siblings: CoherenceSibling[];
  /** Nickname of the machine holding the relay connection right now, when known. */
  relayHolder?: string | null;
}): { title: string; body: string } {
  const strip = (m: string) => m.replace(/ \((disk|relay)\)$/, '');
  // Per-machine votes (self once) for the majority rule; labels keep the (disk)/(relay) hint for display.
  const perMachine: Record<string, string> = {};
  for (const [fp, labels] of Object.entries(input.byValue)) {
    for (const label of labels) {
      const name = strip(label);
      if (name === input.selfNickname) {
        if (!perMachine[name] || label.endsWith('(disk)')) perMachine[name] = fp;
      } else perMachine[name] = fp;
    }
  }
  const majority = strictMajority(perMachine);
  const groups = Object.entries(input.byValue).sort((a, b) => b[1].length - a[1].length);
  const listing = groups.map(([fp, m]) => `${m.join(', ')} publish${m.length === 1 ? 'es' : ''} ${fp.slice(0, 8)}…`).join('; ');
  const selfSplit = input.selfDisk && input.connectedAs && input.selfDisk !== input.connectedAs;
  const selfLine = selfSplit
    ? ` On ${input.selfNickname} the file on disk (${input.selfDisk!.slice(0, 8)}…) and the live relay connection (${input.connectedAs!.slice(0, 8)}…) disagree — the process is still speaking under the old key; reloading it fixes that.`
    : '';
  const holderLine = input.relayHolder ? ` ${input.relayHolder} holds the relay connection right now.` : '';
  let proposal: string;
  if (majority !== null) {
    const sources = Object.entries(perMachine).filter(([, fp]) => fp === majority).map(([n]) => n);
    const targets = Object.entries(perMachine).filter(([, fp]) => fp !== majority).map(([n]) => n);
    const sibling = sources[0] ?? 'a sibling';
    proposal =
      `I can fix this: say yes and I will adopt the identity ${sibling} publishes (${majority.slice(0, 8)}…) onto ${targets.join(' and ') || 'the odd machine'} ` +
      `(I move the conversation there and run \`instar identity adopt --from ${sibling}\`).`;
  } else {
    proposal =
      'There is no majority, so I will not guess a direction: which of these addresses have your peers pinned? ' +
      'Name the machine that is right and I will adopt its identity onto the others with `instar identity adopt --from <that machine>`.';
  }
  return {
    title: `${input.agentName}'s machines are not the same agent on the network`,
    body:
      `My machines are not the same me on the agent network — ${listing}.${holderLine} ` +
      `Messages addressed to the other value are lost while a machine holds the relay under the wrong one.${selfLine} ` +
      `${proposal} A decommissioned machine is removed with \`instar machines remove\` instead. This clears itself once every machine publishes one value.`,
  };
}
