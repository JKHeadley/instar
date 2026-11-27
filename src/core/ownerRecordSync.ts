/**
 * Keeps the owner record in step across this agent's machines (identity-security piece 2b §3, §3a, §6).
 *
 * Two signed mesh commands: `owner-record-push` (offer entries) and `owner-record-pull` (ask for a page).
 * A peer's word grants nothing: every entry is judged here by 2a's evaluator inside OwnerRecordStore.
 * Every bound below comes from the spec's §3a table, and every hit is counted in status().
 *
 * Spec: docs/specs/identity-security-piece2b-owner-record-store.md
 */
import { ownerRecordEntryId, ownerRecordSignedText, type OwnerRecordEntry } from './ownerRecord.js';
import crypto from 'node:crypto';
import type { OwnerRecordStore, PeerView } from './ownerRecordStore.js';
import { fenceInForce, fenceStatus, type FenceInForce, type FenceStatus, type PeerBuildLedger } from './identityBuildFence.js';

export const OWNER_RECORD_PUSH_MAX_ENTRIES = 500;
export const OWNER_RECORD_PUSH_MAX_BYTES = 2 * 1024 * 1024;
export const OWNER_RECORD_PAGES_PER_CYCLE = 4;
const PER_PEER_PUSH_INTERVAL_MS = 10_000;
const EVAL_INTERVAL_MS = 5_000;
/** Above this many entries an evaluation costs more than ~35 ms, so it runs at most once a minute. */
const LARGE_INPUT = 500;
const LARGE_EVAL_INTERVAL_MS = 60_000;
const PENDING_MAX_ENTRIES = 500;
const PENDING_MAX_BYTES = 2 * 1024 * 1024;
const PENDING_TTL_MS = 60 * 60 * 1000;
const LANE_MAX_REVOCATIONS = 50;
const LANE_BAR_MS = 10 * 60 * 1000;
/** Queued entries waiting for evaluation, all peers together: one push's worth. Excess is dropped and counted. */
const QUEUE_MAX_ENTRIES = 500;
const BOOTSTRAP_FIRST_RETRY_MS = 15 * 60 * 1000;
const BOOTSTRAP_MAX_RETRY_MS = 6 * 60 * 60 * 1000;
const BOOTSTRAP_BREAKER_MS = 24 * 60 * 60 * 1000;

export type OwnerRecordPushCmd = { type: 'owner-record-push'; entries: unknown[] };
/** `build` and `guards` are the puller's own signed statement (piece 2c §2); an older build sends neither. */
export type OwnerRecordPullCmd = { type: 'owner-record-pull'; have: string[]; after: string | null; build?: string; guards?: string[]; /** Piece 3d §4: this machine's decision facts, signed with the request. */ facts?: unknown };
export interface OwnerRecordPullReply {
  entries: OwnerRecordEntry[];
  next: string | null;
  hasRecord: boolean;
  /** The replier's head (its tips), so each peer's last confirmed head is visible (§6). */
  head: string[];
  /** 2a's status for the replier's record ('none' without one). */
  status: string;
  genesis: string | null;
  everEnrolled: boolean;
  /** The replier's enrolled marker, if any: names the agent and the genesis (§4). */
  marker: { agentId: string; genesis: string } | null;
  /** The replier's build and live guards (piece 2c §2). */
  build?: string | null;
  guards?: string[];
  /** Piece 2c §4: while enrolled, a peer not confirmed at the fence gets no entries. */
  refused?: 'build-not-confirmed';
  /** Piece 3a §3: the replier runs the approver-in-record build, and how many of its active owner devices are
   *  neither kept approvers nor owner keys. A reply without it is an older build, which closes a claim. */
  approver?: { v: 1; unvouched: number; migratedAt?: string | null; retired?: string[] };
}

/** Piece 3a §3: what every other machine said when a first-approver claim was checked. */
export interface ClaimPeerCheck { silent: string[]; enrolled: string[]; olderBuild: string[]; unvouched: string[] }

export interface OwnerRecordSyncDeps {
  store: OwnerRecordStore;
  agentId: string;
  selfMachineId: () => string | null;
  /** Registered active peers (not this machine). */
  peers: () => string[];
  /** Send a mesh command to a peer; `ok: false` covers unreachable, refused and older builds alike. */
  send: (machineId: string, cmd: OwnerRecordPushCmd | OwnerRecordPullCmd) => Promise<{ ok: boolean; result?: unknown }>;
  isLeaseHolder: () => boolean;
  splitBrain: () => boolean;
  degrade: (summary: string) => void;
  now?: () => number;
  /** Piece 2c: this machine's build and live identity guards, the peers' key fingerprints, the ledger, and
   *  the owner notice. All optional: without a ledger the fence reports nothing and refuses nothing. */
  selfBuild?: () => string;
  selfGuards?: () => string[];
  peerKey?: (machineId: string) => string;
  ledger?: PeerBuildLedger;
  notify?: (summary: string) => void;
  /** A machine's plain name (its nickname), for the owner notice. */
  machineName?: (machineId: string) => string;
  /** When a machine was paired (ms), so a just-joined machine isn't reported as long-silent. */
  peerSince?: (machineId: string) => number | null;
  /** Close the owner notice once nothing is below or long-unconfirmed. */
  clearNotice?: () => void;
  /** Degradation reports about the fence itself (feature label OwnerRecord.fence). */
  degradeFence?: (summary: string) => void;
  /** Piece 3a §3: this machine's unvouched owner devices, carried in every pull reply. */
  approverFacts?: () => { unvouched: number; migratedAt?: string | null; retired?: string[] };
  /** Piece 3a §6: approval keys another machine retired (the owner removed their device). */
  onPeerRetired?: (hashes: string[]) => void;
  /** Piece 3d §4: this machine's decision facts, carried in every signed pull request. */
  signedFacts?: () => unknown;
  /** Piece 3d §4: a peer's signed facts arrived with its pull request (verified by the mesh). */
  onPeerSignedFacts?: (peer: string, facts: unknown, at: number) => void;
  /** Piece 3a §5 (mobile-approver-mark §3.6): the earliest approver migration any machine reports, and whether every machine has answered. */
  onPeerMigrations?: (earliest: string | null, allAnswered: boolean) => void;
}

interface PeerInfo {
  /** When a verified mesh envelope last came from this peer (2d §0); pull replies never set it. */
  lastVerifiedAt?: number;
  /** The build a peer's pull reply showed: display only, never evidence. */
  replyBuild?: string | null;
  answered: boolean;
  /** Piece 3a: when the peer ran the approver migration (from its pull reply), if it has. */
  approverMigratedAt?: string | null;
  hasRecord: boolean;
  head: string[];
  /** Until when this peer is barred from the revocation lane after a lane push stored nothing. */
  laneBarredUntil: number;
  status: string;
  /** Backoff for a peer that doesn't answer: 15 minutes, doubling to 6 hours (§3). */
  nextTryAt: number;
  failDelay: number;
  genesis: string | null;
  everEnrolled: boolean;
  marker: { agentId: string; genesis: string } | null;
  lastHeardAt: number | null;
  lastPushAt: number;
  ids: number;
}

export class OwnerRecordSync {
  private readonly peerInfo = new Map<string, PeerInfo>();
  private readonly queue: unknown[] = [];
  private readonly laneQueue: Array<{ entry: unknown; from: string }> = [];
  private readonly pending = new Map<string, { entry: unknown; bytes: number; at: number; from: string }>();
  private evaluating = false;
  private lastEvalAt = 0;
  private bootstrapWaitingSince: number | null = null;
  private breakerOpen = false;
  private registryFingerprint: string | null = null;
  /** Piece 3a: set by the first-approver claim, so no machine self-add lands while a claim is live. */
  claimLive?: () => boolean;
  private reportedBadFence: string | null = null;
  private noticeClosedThisBoot = false;
  private readonly counters = { pushRefusedTooLarge: 0, pushBusy: 0, queueDropped: 0, refusedEvaluations: 0, pendingDropped: 0, laneAdmitted: 0, evaluations: 0 };

  constructor(private readonly d: OwnerRecordSyncDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  private info(peer: string): PeerInfo {
    let p = this.peerInfo.get(peer);
    if (!p) { p = { answered: false, hasRecord: false, head: [], laneBarredUntil: 0, status: 'none', nextTryAt: 0, failDelay: 0, genesis: null, everEnrolled: false, marker: null, lastHeardAt: null, lastPushAt: 0, ids: 0 }; this.peerInfo.set(peer, p); }
    return p;
  }

  /** A verified mesh envelope from the peer (the dispatcher's onVerified, or one of our handlers): evidence it is
   *  alive for 2d's hold, and a re-arm of the bootstrap breaker. */
  heardVerified(peer: string): void {
    this.info(peer).lastVerifiedAt = this.now();
    this.heardFrom(peer);
  }

  /** Any signed mesh message from a peer re-arms the bootstrap breaker (§3). */
  heardFrom(peer: string): void {
    const p = this.info(peer);
    p.lastHeardAt = this.now(); p.nextTryAt = 0; p.failDelay = 0;
    if (this.breakerOpen) { this.breakerOpen = false; this.bootstrapWaitingSince = null; }
  }

  /** The machine registry changed: re-arm the breaker and re-evaluate unpinned candidates. */
  registryChanged(): void {
    this.breakerOpen = false; this.bootstrapWaitingSince = null;
    for (const p of this.peerInfo.values()) { p.nextTryAt = 0; p.failDelay = 0; }
    this.d.store.load();
  }

  // ── serving ──────────────────────────────────────────────────────

  handlePull(from: string, cmd: OwnerRecordPullCmd, at?: number): OwnerRecordPullReply {
    this.heardVerified(from);
    this.recordStatement(from, cmd.build ?? null, cmd.guards, at ?? this.now()); // recorded before judged (2c §2)
    // Piece 3d §4: the peer's decision facts arrived signed with its request.
    if (cmd.facts !== undefined) {
      try { this.d.onPeerSignedFacts?.(from, cmd.facts, this.now()); } catch { /* @silent-fallback-ok: kept from the next signed pull */ }
      const retired = (cmd.facts as { retired?: unknown } | null)?.retired;
      if (Array.isArray(retired) && retired.length) { try { this.d.onPeerRetired?.(retired.slice(0, 500).filter((h): h is string => typeof h === 'string')); } catch { /* @silent-fallback-ok: merged on the next pull */ } }
    }
    const have = new Set(Array.isArray(cmd.have) ? cmd.have.filter((x) => typeof x === 'string').slice(0, 4 * OWNER_RECORD_PUSH_MAX_ENTRIES) : []);
    const page = this.d.store.page(have, typeof cmd.after === 'string' ? cmd.after : null, OWNER_RECORD_PUSH_MAX_ENTRIES);
    const st = this.d.store.state();
    const m = this.d.store.enrolledMarker();
    const refuse = !this.peerMayHaveRecord(from);
    return {
      ...(refuse ? { entries: [], next: null, refused: 'build-not-confirmed' as const } : page),
      hasRecord: this.d.store.hasRecord(), head: st?.head ?? [], status: st?.status ?? 'none', genesis: st?.genesis ?? null, everEnrolled: !!st?.everEnrolled,
      marker: m.kind === 'ok' ? { agentId: m.marker.agentId, genesis: m.marker.genesis } : null,
      build: this.d.selfBuild?.() ?? null, guards: this.d.selfGuards?.() ?? [],
      ...(this.d.approverFacts ? { approver: { v: 1 as const, ...this.d.approverFacts() } } : {}),
    };
  }

  /** Piece 3d: registered peers whose fresh signed build statement does not name this guard (they can't take part). */
  peersMissingGuard(guard: string): string[] {
    return this.d.peers().filter((p) => !this.d.ledger || !this.d.peerKey || this.d.ledger.stateOf(p, this.d.peerKey(p), null) !== 'confirmed' || !this.d.ledger.guardsOf(p, this.d.peerKey(p)).includes(guard));
  }

  /**
   * Piece 3a §3: ask every registered machine now, each within `timeoutMs`. A machine that is silent, on an older
   * build, holds an owner key or an enrolled marker, or has an unvouched owner device is named; any name closes a claim.
   */
  async claimCheck(timeoutMs = 10_000): Promise<ClaimPeerCheck> {
    const out: ClaimPeerCheck = { silent: [], enrolled: [], olderBuild: [], unvouched: [] };
    const have = this.d.store.ids();
    await Promise.all(this.d.peers().map(async (peer) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
      const r = await Promise.race([this.d.send(peer, { type: 'owner-record-pull', have, after: null, build: this.d.selfBuild?.(), guards: this.d.selfGuards?.(), ...(this.d.signedFacts ? { facts: this.d.signedFacts() } : {}) }).catch(() => null), timeout]);
      if (timer) clearTimeout(timer);
      const reply = r && r.ok ? (r.result as Partial<OwnerRecordPullReply> | undefined) : undefined;
      if (!reply || typeof reply !== 'object') { out.silent.push(peer); return; }
      // The build check rests on the peer's own SIGNED statement (2c ledger, from its signed pulls): fresh, and naming
      // this piece's guard. The reply field alone isn't signed, so it only adds to the refusal, never satisfies it.
      const signedOk = !!this.d.ledger && !!this.d.peerKey && this.d.ledger.stateOf(peer, this.d.peerKey(peer), null) === 'confirmed' && this.d.ledger.guardsOf(peer, this.d.peerKey(peer)).includes('approver-record');
      if (!signedOk || !reply.approver || reply.approver.v !== 1) out.olderBuild.push(peer);
      if (reply.everEnrolled || (reply.marker && reply.marker.agentId === this.d.agentId)) out.enrolled.push(peer);
      if (reply.approver && reply.approver.unvouched > 0) out.unvouched.push(peer);
    }));
    return out;
  }

  /** Accept a push: bounded, deduped, rate-limited per peer except for the checked revocation lane. */
  handlePush(from: string, cmd: OwnerRecordPushCmd): { ok: boolean; reason?: string; queued?: number } {
    this.heardVerified(from);
    const entries = Array.isArray(cmd.entries) ? cmd.entries : [];
    if (entries.length > OWNER_RECORD_PUSH_MAX_ENTRIES || jsonBytes(entries) > OWNER_RECORD_PUSH_MAX_BYTES) {
      this.counters.pushRefusedTooLarge++;
      return { ok: false, reason: 'too-large' };
    }
    if (!this.peerMayGiveRecord(from)) return { ok: false, reason: 'build-not-confirmed' };
    const held = new Set(this.d.store.ids());
    const fresh = entries.filter((e) => { const id = safeId(e); return id !== null && !held.has(id); });
    if (fresh.length === 0) return { ok: true, queued: 0 };
    const info = this.info(from);
    const lane = this.now() >= info.laneBarredUntil && this.laneAdmits(fresh);
    if (!lane && this.now() - info.lastPushAt < PER_PEER_PUSH_INTERVAL_MS) { this.counters.pushBusy++; return { ok: false, reason: 'busy' }; }
    info.lastPushAt = this.now();
    if (lane) {
      // The lane has its own queue, ahead of everything else, so junk from other peers can't crowd it out.
      this.counters.laneAdmitted++;
      const revs = fresh.filter((e) => (e as OwnerRecordEntry)?.kind === 'revoke-key').slice(0, LANE_MAX_REVOCATIONS);
      const rest = fresh.filter((e) => !revs.includes(e));
      this.laneQueue.push(...revs.map((entry) => ({ entry, from })));
      const queued = this.enqueue(rest);
      void this.flush(true);
      return { ok: true, queued: revs.length + queued };
    }
    const queued = this.enqueue(fresh);
    void this.flush();
    return { ok: true, queued };
  }

  private enqueue(entries: unknown[]): number {
    const room = Math.max(0, QUEUE_MAX_ENTRIES - this.queue.length);
    if (entries.length > room) this.counters.queueDropped += entries.length - room;
    this.queue.push(...entries.slice(0, room));
    return Math.min(entries.length, room);
  }

  /** §3a's lane: an owner-key revocation whose signer and target are both keys valid now. Junk takes the normal
   *  queue; a machine key can't use the lane, because at Basic nothing is urgent and after enrolment only
   *  owner keys revoke. */
  private laneAdmits(entries: unknown[]): boolean {
    const st = this.d.store.state();
    if (!st) return false;
    const valid = new Map(st.keys.map((k) => [k.keyId, k.publicKey]));
    let checked = 0;
    for (const raw of entries) {
      const e = raw as OwnerRecordEntry;
      if (e?.kind !== 'revoke-key') continue;
      if (++checked > LANE_MAX_REVOCATIONS) break;
      if (e.signer?.type !== 'owner-key') continue;
      const pub = valid.get(e.signer?.keyId);
      const target = e.body?.keyId;
      if (!pub || typeof target !== 'string' || !valid.has(target) || typeof e.sig !== 'string') continue;
      try {
        if (crypto.verify(null, Buffer.from(ownerRecordSignedText(e)), pub, Buffer.from(e.sig, 'base64'))) return true;
      } catch { /* @silent-fallback-ok: an unparseable signature doesn't qualify for the lane; the entry still takes the normal queue */ }
    }
    return false;
  }

  /** Single-flight evaluation: at most one at a time, at most every 5 s (once a minute for large inputs). */
  async flush(urgent = false): Promise<void> {
    if (this.evaluating || (this.queue.length === 0 && this.laneQueue.length === 0)) return;
    if (this.laneQueue.length > 0) urgent = true;
    const size = this.d.store.ids().length + this.queue.length + this.pending.size;
    const wait = (size > LARGE_INPUT ? LARGE_EVAL_INTERVAL_MS : EVAL_INTERVAL_MS) - (this.now() - this.lastEvalAt);
    if (wait > 0 && !urgent) { setTimeout(() => { void this.flush(); }, wait).unref?.(); return; }
    this.evaluating = true;
    try {
      const lane = this.laneQueue.splice(0);
      const batch = [...lane.map((l) => l.entry), ...this.queue.splice(0)];
      this.prunePending();
      const pendingEntries = [...this.pending.values()].map((p) => p.entry);
      this.lastEvalAt = this.now();
      this.counters.evaluations++;
      const { added, refused } = this.d.store.ingest([...pendingEntries, ...batch]);
      if (refused) this.counters.refusedEvaluations++;
      for (const id of added) this.pending.delete(id);
      // A peer loses the lane only when its revocation was actually judged and not kept.
      const heldAfter = new Set(this.d.store.ids());
      for (const l of lane) {
        const id = safeId(l.entry);
        const parents = (l.entry as OwnerRecordEntry)?.parents;
        const judged = Array.isArray(parents) && parents.every((p) => heldAfter.has(p)); // not waiting on a parent
        if (id && judged && !heldAfter.has(id)) this.info(l.from).laneBarredUntil = this.now() + LANE_BAR_MS;
      }
      // Entries whose parent hasn't arrived wait in the bounded pending set (§2).
      const heldNow = new Set(this.d.store.ids());
      for (const raw of batch) {
        const id = safeId(raw);
        if (!id || heldNow.has(id) || this.pending.has(id)) continue;
        const parents = (raw as OwnerRecordEntry).parents;
        if (!Array.isArray(parents) || parents.every((p) => heldNow.has(p))) continue; // judged and not kept
        const bytes = jsonBytes(raw);
        if (this.pending.size >= PENDING_MAX_ENTRIES || this.pendingBytes() + bytes > PENDING_MAX_BYTES) { this.counters.pendingDropped++; continue; }
        this.pending.set(id, { entry: raw, bytes, at: this.now(), from: 'push' });
      }
      if (added.length > 0) void this.pushToPeers(added);
    } finally {
      this.evaluating = false;
    }
    if (this.queue.length > 0 || this.laneQueue.length > 0) void this.flush();
  }

  private pendingBytes(): number { let n = 0; for (const p of this.pending.values()) n += p.bytes; return n; }
  private prunePending(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [id, p] of this.pending) if (p.at < cutoff) { this.pending.delete(id); this.counters.pendingDropped++; }
  }

  // ── driving ──────────────────────────────────────────────────────

  /** After a local change, offer the new entries to every peer (bounded per message). */
  async pushToPeers(ids: string[]): Promise<void> {
    const entries = this.d.store.page(new Set(this.d.store.ids().filter((id) => !ids.includes(id))), null, OWNER_RECORD_PUSH_MAX_ENTRIES).entries;
    if (entries.length === 0) return;
    // @silent-fallback-ok: a failed push is only a speed-up; the peer's own 15-minute pull fetches the same entries.
    await Promise.all(this.d.peers().filter((peer) => this.peerMayHaveRecord(peer)).map((peer) => this.d.send(peer, { type: 'owner-record-push', entries }).catch(() => ({ ok: false })))); // @silent-fallback-ok: the peer's own pull fetches it
  }

  /** Pull from every peer (≤4 pages each), then consider bootstrap. Called at boot and every 15 minutes. */
  async tick(): Promise<void> {
    // A change in the machine list re-arms the breaker and re-judges unpinned genesis candidates (§3).
    const fp = this.d.peers().slice().sort().join(',');
    if (this.registryFingerprint !== null && fp !== this.registryFingerprint) this.registryChanged();
    else this.d.store.load(); // re-judge from disk each pass, so a rotated key in the registry is noticed too
    this.registryFingerprint = fp;
    for (const peer of this.d.peers()) {
      const info = this.info(peer);
      // A silent peer is retried with backoff, and not at all while the breaker is open (§3).
      if (!info.answered && (this.breakerOpen || this.now() < info.nextTryAt)) continue;
      let after: string | null = null;
      for (let i = 0; i < OWNER_RECORD_PAGES_PER_CYCLE; i++) {
        const pull: OwnerRecordPullCmd = { type: 'owner-record-pull', have: this.d.store.ids(), after, ...(this.d.selfBuild ? { build: this.d.selfBuild(), guards: this.d.selfGuards?.() ?? [] } : {}), ...(this.d.signedFacts ? { facts: this.d.signedFacts() } : {}) };
        const res: { ok: boolean; result?: unknown } = await this.d.send(peer, pull).catch(() => ({ ok: false }));
        const reply: OwnerRecordPullReply | null = res.ok ? parseReply(res.result) : null;
        if (!reply) { // unreachable, refused, or an older build: not an answer
          if (i === 0) {
            info.failDelay = info.failDelay === 0 ? BOOTSTRAP_FIRST_RETRY_MS : Math.min(info.failDelay * 2, BOOTSTRAP_MAX_RETRY_MS);
            info.nextTryAt = this.now() + info.failDelay;
          }
          break;
        }
        this.heardFrom(peer);
        // A reply's build is shown, never recorded: replies are unsigned HTTP bodies stamped with no sender clock.
        // Evidence comes only from the peer's own signed pulls (piece 2c §2).
        info.replyBuild = reply.build ?? null;
        if (reply.approver && reply.approver.v === 1) {
          info.approverMigratedAt = typeof reply.approver.migratedAt === 'string' ? reply.approver.migratedAt : null;
          // Piece 3d §4: retired keys come from signed facts. A reply (unsigned) still counts only from a machine whose
          // signed build statement lacks the 'approver-recovery' guard: a mixed rollout, where retiring only removes rights.
          const legacyPeer = !this.d.ledger || !this.d.peerKey || !this.d.ledger.guardsOf(peer, this.d.peerKey(peer)).includes('approver-recovery');
          if (legacyPeer && Array.isArray(reply.approver.retired) && reply.approver.retired.length) { try { this.d.onPeerRetired?.(reply.approver.retired.slice(0, 500).filter((h): h is string => typeof h === 'string')); } catch { /* @silent-fallback-ok: merged on the next pull */ } }
        }
        Object.assign(info, { answered: true, hasRecord: reply.hasRecord, head: reply.head, status: reply.status, genesis: reply.genesis, everEnrolled: reply.everEnrolled, marker: reply.marker, ids: info.ids + reply.entries.length });
        if (reply.entries.length > 0 && this.peerMayGiveRecord(peer)) { this.queue.push(...reply.entries); await this.flush(true); }
        if (!reply.next) break;
        after = reply.next;
      }
    }
    // Piece 3d §2: entries held at arrival are offered again (a wait that has now passed, a key that has settled).
    try { const again = this.d.store.retryHeld(); if (again.length) void this.pushToPeers(again); } catch { /* @silent-fallback-ok: retried next tick */ }
    this.maybeBootstrap();
    // Piece 3a §2: at Basic, each machine puts its own key in the record, and the lease holder merges forks.
    if (this.d.isLeaseHolder() && !this.d.splitBrain()) {
      const merged = this.d.store.mergeForksAtBasic();
      if (merged === 'merged') void this.pushToPeers(this.d.store.ids());
    }
    if (!this.claimLive?.() && this.d.store.ensureOwnMachineKey() === 'added') void this.pushToPeers(this.d.store.ids());
    this.maybeNotifyFence();
    this.reportPeerMigrations();
  }

  // ── piece 2c: the minimum-build fence ───────────────────────────

  private recordStatement(peer: string, build: unknown, guards: unknown, at: number): void {
    if (!this.d.ledger || !this.d.peerKey) return;
    this.d.ledger.record(peer, this.d.peerKey(peer), build, guards, at);
  }

  /** The fence in force on this machine (2c §1); none before enrolment or at Basic. */
  fence(): FenceInForce {
    if (!this.d.ledger) return { value: null, source: 'none', unusable: false, raiseDue: null, badValue: null };
    const f = fenceInForce(this.d.store.state(), this.d.ledger);
    if (f.badValue && f.badValue !== this.reportedBadFence) {
      this.reportedBadFence = f.badValue;
      (this.d.degradeFence ?? this.d.degrade)(`The owner record's minimum build "${f.badValue}" can't be used, so ${f.value ? `the last verified fence (${f.value}) stays in force` : 'risky actions are held'}. The owner should set a valid one.`);
    }
    return f;
  }

  /** 2c §4: while enrolled with a fence, only peers confirmed at it get owner-record data. With an unusable
   *  fence nothing is sent: confirmation can't be judged. */
  peerMayHaveRecord(peer: string): boolean {
    if (!this.d.ledger || !this.d.peerKey) return true;
    const f = this.fence();
    if (f.unusable) return false;
    if (!f.value) return true;
    return this.d.ledger.stateOf(peer, this.d.peerKey(peer), f.value) === 'confirmed';
  }

  /** 2c §4: entries are accepted from confirmed peers. With an unusable fence they are accepted from any peer,
   *  so the owner's corrected minimum build can still arrive (each entry is owner-signed and judged anyway). */
  peerMayGiveRecord(peer: string): boolean {
    if (this.fence().unusable) return true;
    return this.peerMayHaveRecord(peer);
  }

  /** 2d §0: a peer is below the fence in force (a signed statement under it, sticky). Nothing before enrolment. */
  isBelow(peer: string): boolean {
    const f = this.fence();
    if (!f.value || !this.d.ledger || !this.d.peerKey) return false;
    return this.d.ledger.stateOf(peer, this.d.peerKey(peer), f.value) === 'below';
  }

  /** 2d §0/§1: the machines the agent-wide hold is for: below the fence, or alive (a verified mesh envelope
   *  within 24 h) with no signed build statement in that time — uncertainty, never called below. */
  machinesHeld(): { below: string[]; unconfirmed: string[] } {
    const f = this.fence();
    if (!f.value || !this.d.ledger || !this.d.peerKey) return { below: [], unconfirmed: [] };
    const day = 24 * 60 * 60 * 1000;
    const below: string[] = []; const unconfirmed: string[] = [];
    for (const peer of this.d.peers()) {
      const state = this.d.ledger.stateOf(peer, this.d.peerKey(peer), f.value);
      if (state === 'below') { below.push(peer); continue; }
      if (state !== 'unconfirmed') continue;
      const heard = this.peerInfo.get(peer)?.lastVerifiedAt ?? null; // verified envelopes only (§0), never a reply
      const obs = this.d.ledger.observation(peer, this.d.peerKey(peer));
      if (heard !== null && this.now() - heard <= day && (!obs || this.now() - obs.at > day)) unconfirmed.push(peer);
    }
    return { below, unconfirmed };
  }

  /** 2c §3: readiness against a target build, from this machine's own first-hand observations. */
  fenceStatus(target: string): FenceStatus | null {
    if (!this.d.ledger || !this.d.peerKey) return null;
    const selfId = this.d.selfMachineId();
    const selfBuild = this.d.selfBuild?.();
    return fenceStatus(target, this.d.peers().map((machineId) => ({ machineId, key: this.d.peerKey!(machineId) })), this.d.ledger, selfId && selfBuild ? { machineId: selfId, build: selfBuild } : undefined);
  }

  /** 2c §4: one aggregated notice, from the lease holder, at most daily while the list is unchanged. */
  private maybeNotifyFence(): void {
    const f = this.fence();
    if (!this.d.ledger || !this.d.peerKey || !this.d.notify || !this.d.isLeaseHolder()) return;
    if (!f.value) { this.closeNotice(); return; } // the owner lowered the level, or no fence applies

    const st = this.fenceStatus(f.value);
    if (!st) return;
    const day = 24 * 60 * 60 * 1000;
    const stale = st.unconfirmed.filter((m) => {
      const o = this.d.ledger!.observation(m, this.d.peerKey!(m));
      // Never heard from: judged from the later of when this ledger began watching and when the peer paired.
      const since = Math.max(this.d.ledger!.watchingSince(), this.d.peerSince?.(m) ?? 0);
      return o ? this.now() - o.at > day : this.now() - since > day;
    });
    const list = [...st.below.map((m) => `below:${m}`), ...stale.map((m) => `unconfirmed:${m}`)];
    if (list.length === 0) { this.closeNotice(); return; }
    if (!this.d.ledger.noticeDue(list)) return;
    const parts: string[] = [];
    const name = (m: string): string => this.d.machineName?.(m) ?? m;
    const list2 = (ms: string[]): string => ms.map(name).join(', ');
    if (st.below.length > 0) parts.push(`${list2(st.below)} ${st.below.length === 1 ? 'runs' : 'run'} a version of Instar older than ${f.value}. Update ${st.below.length === 1 ? 'it' : 'them'}, or remove ${st.below.length === 1 ? 'it' : 'them'} from the agent.`);
    if (stale.length > 0) parts.push(`${list2(stale)} hasn't confirmed which version ${stale.length === 1 ? 'it runs' : 'they run'} for a day. Check ${stale.length === 1 ? "it's" : "they're"} on and connected.`);
    const held = this.machinesHeld();
    const holdNote = held.below.length + held.unconfirmed.length > 0 ? ' Until then, risky actions are paused on all your computers; you can still talk to the agent and look at everything.' : '';
    this.d.notify(`${parts.join(' ')} Until then, ${st.below.length + stale.length === 1 ? 'that computer' : 'those computers'} won't get your ownership record.${holdNote}`);
  }

  /** Close the owner notice: once per process even with nothing recorded here, so a new lease holder closes an
   *  item an earlier holder raised. */
  private closeNotice(): void {
    const wasOpen = this.d.ledger?.clearNoticeIfOpen() ?? false;
    if (wasOpen || !this.noticeClosedThisBoot) { this.d.clearNotice?.(); this.noticeClosedThisBoot = true; }
  }

  /** Piece 3a §5: hand the earliest peer approver migration to the server, which can only shrink the kept list. */
  private reportPeerMigrations(): void {
    if (!this.d.onPeerMigrations) return;
    const peers = this.d.peers();
    const times = peers.map((p) => this.peerInfo.get(p)?.approverMigratedAt).filter((t): t is string => typeof t === 'string');
    const allAnswered = peers.every((p) => { const i = this.peerInfo.get(p); return !!i?.answered && i.approverMigratedAt !== undefined; });
    try { this.d.onPeerMigrations(times.length ? times.sort()[0]! : null, allAnswered); } catch { /* @silent-fallback-ok: retried on the next tick; the kept list stays as it is (never widened) */ }
  }

  /** The gate's view of the peers (§4): every peer answered; any honoured peer marker. */
  peerView(): PeerView {
    const peers = this.d.peers();
    const st = this.d.store.state();
    const enrolledGeneses = new Set([...this.peerInfo.values()].filter((p) => p.everEnrolled && p.genesis).map((p) => p.genesis!));
    const honoured = peers.some((peer) => {
      const m = this.peerInfo.get(peer)?.marker;
      return !!m && m.agentId === this.d.agentId && (m.genesis === st?.genesis || enrolledGeneses.has(m.genesis));
    });
    const held = this.machinesHeld();
    return { allAnswered: peers.every((p) => this.peerInfo.get(p)?.answered), honouredPeerMarker: honoured, fenceUnusable: this.fence().unusable, machinesBelow: held.below, machinesUnconfirmed: held.unconfirmed };
  }

  /** §3: bootstrap only on the lease holder, no split-brain, every peer answered with nothing that blocks it. */
  maybeBootstrap(): 'created' | 'not-needed' | 'waiting' | 'breaker-open' | 'not-lease-holder' | 'no-identity' {
    const st = this.d.store.state();
    const needs = !this.d.store.hasRecord() || (st !== null && st.status !== 'ok' && !st.everEnrolled);
    if (!needs || this.d.store.enrolledMarker().kind !== 'absent') return 'not-needed';
    if (!this.d.selfMachineId()) return 'no-identity';
    if (!this.d.isLeaseHolder() || this.d.splitBrain()) return 'not-lease-holder';
    if (this.breakerOpen) return 'breaker-open';
    const peers = this.d.peers();
    // Blocked by a silent peer, a peer with a usable record (whose entries this tick already pulled), or any
    // peer marker naming this agent (checked before the honour filter). A peer's failing never-enrolled
    // record counts as none, because the peers usually hold the same broken record.
    const blocked = peers.some((peer) => {
      const p = this.peerInfo.get(peer);
      if (!p?.answered) return true;
      const usable = p.hasRecord && (p.everEnrolled || p.status === 'ok');
      return usable || (!!p.marker && p.marker.agentId === this.d.agentId);
    });
    if (blocked) {
      const t = this.now();
      if (this.bootstrapWaitingSince === null) this.bootstrapWaitingSince = t;
      if (t - this.bootstrapWaitingSince >= BOOTSTRAP_BREAKER_MS) {
        this.breakerOpen = true;
        const silent = peers.filter((peer) => !this.peerInfo.get(peer)?.answered);
        this.d.degrade(`Owner record: waited 24 hours to start the record; no answer from ${silent.join(', ') || 'a peer'}. Retries stop until that machine is heard from, the machine list changes, or the server restarts.`);
        return 'breaker-open';
      }
      return 'waiting';
    }
    const { id } = this.d.store.bootstrap();
    this.bootstrapWaitingSince = null;
    void this.pushToPeers([id]);
    return 'created';
  }

  status(): Record<string, unknown> {
    const st = this.d.store.state();
    const peers = this.d.peers().map((peer) => {
      const p = this.peerInfo.get(peer);
      return {
        machineId: peer, answered: !!p?.answered, head: p?.head ?? [], genesis: p?.genesis ?? null, everEnrolled: !!p?.everEnrolled,
        sameHead: !!(p?.answered && st && JSON.stringify(p.head) === JSON.stringify(st.head)),
        markerHereMissing: !!(p?.marker && p.marker.agentId === this.d.agentId && this.d.store.enrolledMarker().kind === 'absent'),
        foreignGenesis: !!(p?.genesis && st?.genesis && p.genesis !== st.genesis),
        markerUnhonoured: !!(p?.marker && (p.marker.agentId !== this.d.agentId)),
        lastHeardAt: p?.lastHeardAt ? new Date(p.lastHeardAt).toISOString() : null,
      };
    });
    const f = this.fence();
    const self = this.d.selfBuild?.() ?? null;
    return {
      fence: { inForce: f.value, source: f.source, unusable: f.unusable, raiseDue: f.raiseDue, selfBuild: self, status: self ? this.fenceStatus(f.value ?? self) : null,
        peers: this.d.ledger && this.d.peerKey ? this.d.peers().map((m) => ({ machineId: m, state: this.d.ledger!.stateOf(m, this.d.peerKey!(m), f.value), build: this.d.ledger!.observation(m, this.d.peerKey!(m))?.build ?? null })) : [] },
      peers, pending: this.pending.size, queued: this.queue.length, breakerOpen: this.breakerOpen,
      bootstrapWaitingSince: this.bootstrapWaitingSince ? new Date(this.bootstrapWaitingSince).toISOString() : null,
      counters: { ...this.counters },
    };
  }
}

function safeId(raw: unknown): string | null {
  try { return ownerRecordEntryId(raw as OwnerRecordEntry); } catch { return null; /* @silent-fallback-ok: malformed; dropped before any work */ }
}

function jsonBytes(v: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(v)); } catch { return Number.POSITIVE_INFINITY; /* @silent-fallback-ok: unserialisable input is treated as over every bound */ }
}

function parseReply(r: unknown): OwnerRecordPullReply | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (!Array.isArray(o.entries) || typeof o.hasRecord !== 'boolean') return null;
  const m = o.marker as Record<string, unknown> | null;
  return {
    entries: o.entries.slice(0, OWNER_RECORD_PUSH_MAX_ENTRIES) as OwnerRecordEntry[],
    next: typeof o.next === 'string' ? o.next : null,
    hasRecord: o.hasRecord,
    head: Array.isArray(o.head) ? o.head.filter((x): x is string => typeof x === 'string').slice(0, 64) : [],
    status: typeof o.status === 'string' ? o.status : 'none',
    genesis: typeof o.genesis === 'string' ? o.genesis : null,
    everEnrolled: o.everEnrolled === true,
    marker: m && typeof m.agentId === 'string' && typeof m.genesis === 'string' ? { agentId: m.agentId, genesis: m.genesis } : null,
    build: typeof o.build === 'string' ? o.build : null,
    guards: Array.isArray(o.guards) ? o.guards.filter((x): x is string => typeof x === 'string').slice(0, 32) : [],
    ...(o.refused === 'build-not-confirmed' ? { refused: 'build-not-confirmed' as const } : {}),
  };
}
