/**
 * WriteAdmission — ONE synchronous, in-memory decision point that classifies
 * every write into a domain (machine-local / session-scoped / topic-scoped /
 * cluster-shared) and admits or TYPED-refuses it, replacing the blanket
 * lease-boolean standby guard with ownership-scoped write admission.
 *
 * Spec: docs/specs/standby-write-reconciliation.md (§3.2 decision table,
 * §3.4 typed-refusal contract, §5 fail directions, §6 observability).
 *
 * Hard properties (invariant I2): the admission path is synchronous and
 * in-memory ONLY — no fs, no network, no LLM, no await. It reads (a) the
 * lease view the coordinator already maintains in memory (via injected
 * `isReadOnly`), (b) the ownership index (boot-warmed + onCommit-updated,
 * never `registry.read()`), (c) the domain registry. Refusal log rows are
 * BUFFERED in memory and flushed off the admission path (a timer), so even
 * observability never puts fs on the decision path.
 *
 * Authority ladder (§7): the layer only gains refusal authority at
 * `dryRun:false` AND after the wave-2 write-surface inventory is complete
 * (WRITE_SURFACE_INVENTORY_COMPLETE — the §9.14 ladder gate). Until then it
 * evaluates + logs would-verdicts while the LEGACY blanket guard keeps
 * enforcing (§9.6).
 */

import path from 'node:path';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { JsonlStore } from './storage/JsonlStore.js';
import type { SessionOwnershipRecord, SessionOwnershipStatus } from './SessionOwnership.js';
import {
  WRITE_SURFACE_INVENTORY_COMPLETE,
  type KvEntry,
  type OpEntry,
  type RouteEntry,
  type WriteDomain,
  type WriteDomainRegistry,
} from './WriteDomainRegistry.js';

export type WriteRefusalCode =
  | 'not-owner'
  | 'lease-required'
  | 'ownership-unresolved'
  | 'read-only-standby'
  | 'admission-error';

/** §3.4 — a refusal is TYPED: distinguishable from success, a crash, and garbage. */
export interface TypedWriteRefusal {
  error: 'write-refused';
  code: WriteRefusalCode;
  domain: WriteDomain;
  scope?: WriteScope;
  thisMachine: { machineId: string | null; nickname: string | null };
  owner: { machineId: string; nickname: string | null } | null;
  leaseHolder: string | null;
  asOf: string;
  retryable: boolean;
  /** Advisory prose for a HUMAN reader — never an instruction, never a
   *  runnable command (§3.4: moving a topic is consent-gated). */
  hint: string;
}

export interface WriteScope {
  topicId?: number | string;
  sessionId?: string;
}

export type AdmitVerdict = { admit: true } | { admit: false; refusal: TypedWriteRefusal };

/** Legacy message preserved for log-scraping continuity (§7 migration parity). */
export function legacyReadOnlyMessage(operation: string): string {
  return `StateManager is read-only (this machine is on standby). Blocked: ${operation}`;
}

/** Thrown at the store seam for a refused write. Callers that today
 *  catch-and-log the string keep working — the legacy message is preserved. */
export class WriteRefusedError extends Error {
  readonly refusal: TypedWriteRefusal;
  constructor(refusal: TypedWriteRefusal, operation: string) {
    super(`${legacyReadOnlyMessage(operation)} [write-refused:${refusal.code}]`);
    this.name = 'WriteRefusedError';
    this.refusal = refusal;
  }
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set<SessionOwnershipStatus>([
  'placing', 'active', 'transferring', 'released',
]);

type IndexLookup =
  | { state: 'unwarmed' }
  | { state: 'none' }
  | { state: 'malformed' }
  | { state: 'record'; owner: string; status: SessionOwnershipStatus };

/**
 * The ownership index (§3.2, decided — was OQ1): owned by WriteAdmission,
 * warmed by ONE synchronous `store.all()` scan at construction, updated via
 * the `onCommit` hook at each substrate's own commit point. `admitWrite`
 * NEVER calls `registry.read()` — negative answers come from memory.
 */
export class OwnershipIndex {
  private readonly entries = new Map<string, { owner: string; status: SessionOwnershipStatus } | 'malformed'>();
  private warmed = false;
  private _lastCasTransitionAt: string | null = null;

  /** Ingest validation (round-2 L1): `ownerMachineId` must be a string and
   *  `status` a known FSM status — REGARDLESS of which store path surfaced the
   *  record (the warm-scan `all()` validates weaker than `loadOne`). A record
   *  failing ingest classifies malformed ⇒ fail-closed `ownership-unresolved`
   *  for that scope — never `not-owner` with `owner: null`. */
  ingest(record: unknown, opts?: { fromCommit?: boolean }): void {
    if (!record || typeof record !== 'object') return; // unkeyable — nothing to poison
    const r = record as Partial<SessionOwnershipRecord>;
    if (typeof r.sessionKey !== 'string' || !r.sessionKey) return; // unkeyable
    if (typeof r.ownerMachineId !== 'string' || !KNOWN_STATUSES.has(String(r.status))) {
      this.entries.set(r.sessionKey, 'malformed');
    } else {
      this.entries.set(r.sessionKey, { owner: r.ownerMachineId, status: r.status as SessionOwnershipStatus });
    }
    if (opts?.fromCommit) this._lastCasTransitionAt = new Date().toISOString();
  }

  /** Boot warm — ONE synchronous scan result, off the request path. */
  warmFrom(records: unknown[]): void {
    for (const r of records) this.ingest(r);
    this.warmed = true;
  }

  lookup(sessionKey: string): IndexLookup {
    if (!this.warmed) return { state: 'unwarmed' };
    const e = this.entries.get(sessionKey);
    if (e === undefined) return { state: 'none' };
    if (e === 'malformed') return { state: 'malformed' };
    return { state: 'record', owner: e.owner, status: e.status };
  }

  get isWarmed(): boolean {
    return this.warmed;
  }

  stats(): { entries: number; lastCasTransitionAt: string | null } {
    return { entries: this.entries.size, lastCasTransitionAt: this._lastCasTransitionAt };
  }

  /** Test-parity helper: the full keyed view (never on the admission path). */
  snapshot(): Map<string, { owner: string; status: SessionOwnershipStatus } | 'malformed'> {
    return new Map(this.entries);
  }
}

export interface WriteAdmissionDeps {
  /** Coordinator/mesh identity machine id (null on identity-less installs). */
  thisMachineId: string | null;
  /** The lease view the coordinator maintains in memory (StateManager._readOnly). */
  isReadOnly: () => boolean;
  /** Whether the active-active session pool is live (§3.2 pool-inactive clause). */
  isPoolActive: () => boolean;
  /** Domain registry (§3.5) — the SAME map the server wires and tests read. */
  registry: WriteDomainRegistry;
  /** dryRun (§7): true ⇒ the layer logs would-verdicts, legacy guard enforces. */
  dryRun: boolean;
  /** In-memory session→topic binding (TelegramAdapter.getTopicForSession —
   *  the in-memory map ONLY; the disk fallback is forbidden on the admission
   *  path, I2). Sync + in-memory by contract. */
  resolveTopicForSession?: (sessionId: string) => number | string | null;
  /** Local lease-holder knowledge for refusal bodies (I7 — in-memory only). */
  leaseHolder?: () => string | null;
  /** Nickname decoration for refusal bodies (in-memory only). */
  nicknameOf?: (machineId: string) => string | null;
  selfNickname?: () => string | null;
  /** One deduped aggregate attention item per (route/op, code) window (§6). */
  raiseAttention?: (item: { id: string; title: string; body: string }) => void;
  /** ≥N refusals of one (surface, code) within the window ⇒ ONE aggregate item. */
  refusalAggregateThreshold?: number;
  /** Where logs/write-admission.jsonl lives (dir). Omit ⇒ no file logging. */
  logDir?: string;
  now?: () => number;
  /** Test seam: event-loop histogram + flush timer control. */
  disableTimers?: boolean;
  /**
   * TEST SEAM ONLY — overrides the wave-2 inventory latch
   * (WRITE_SURFACE_INVENTORY_COMPLETE, §9.14) so the LIVE refusal machinery is
   * provable by tests before wave 2 flips the real constant. Production wiring
   * NEVER passes this: the compiled constant governs, so `dryRun:false` in
   * config cannot grant refusal authority until the reviewed inventory lands.
   */
  inventoryComplete?: boolean;
}

interface DomainCounters {
  admitted: number;
  refused: number;
  wouldRefuse: number;
  wouldAdmitChanged: number;
}

const DOMAINS: WriteDomain[] = ['machine-local', 'session-scoped', 'topic-scoped', 'cluster-shared'];
const AGGREGATE_WINDOW_MS = 10 * 60 * 1000;
const LOG_BUFFER_MAX = 1000;
const RECENT_REFUSALS_MAX = 50;
const STARVED_WINDOW_THRESHOLD_MS = 1000;

/** The ownership store surface WriteAdmission consumes (§3.2): the one-time
 *  boot-warm scan + the interface-level onCommit hook (round-2 S4). */
export interface AdmissionOwnershipStore {
  all?(): SessionOwnershipRecord[];
  onCommit?: (record: SessionOwnershipRecord) => void;
}

export class WriteAdmission {
  private readonly d: WriteAdmissionDeps;
  readonly index: OwnershipIndex;
  private readonly counters = new Map<WriteDomain, DomainCounters>();
  private readonly recentRefusals: Array<Omit<TypedWriteRefusal, 'hint'> & { seam: string; surface: string }> = [];
  private readonly aggregate = new Map<string, { count: number; windowStart: number; raised: boolean }>();
  private readonly logBuffer: string[] = [];
  private logStore: JsonlStore | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private histogram: IntervalHistogram | null = null;
  private gaugeTimer: NodeJS.Timeout | null = null;
  private starvedWindows: number[] = [];
  private lastGauge: { p50: number; p99: number; max: number } = { p50: 0, p99: 0, max: 0 };

  constructor(deps: WriteAdmissionDeps, ownershipStore?: AdmissionOwnershipStore | null) {
    this.d = deps;
    for (const dom of DOMAINS) this.counters.set(dom, { admitted: 0, refused: 0, wouldRefuse: 0, wouldAdmitChanged: 0 });
    if (deps.logDir) {
      this.logStore = new JsonlStore(path.join(deps.logDir, 'write-admission.jsonl'), {
        maxBytes: 8 * 1024 * 1024, // bounded + rotated (§6)
        keepSegments: 2,
      });
    }
    this.index = new OwnershipIndex();
    // Hook-then-warm (§3.2.2 ordering): register the interface-level onCommit
    // hook BEFORE the warm scan. The constructor is synchronous, so no commit
    // can interleave between hook registration and the scan — the index can
    // never miss a transition the local store saw.
    if (ownershipStore) {
      ownershipStore.onCommit = (rec) => this.onOwnershipCommit(rec);
    }
    // Boot warm: ONE synchronous store.all() scan AT CONSTRUCTION (§3.2.1) —
    // deliberately off the request path. A store without all() (or none at
    // all, e.g. pool-dark installs) warms empty: no peers' custody ⇒ scoped
    // verdicts collapse via the pool-inactive clause anyway.
    let records: SessionOwnershipRecord[] = [];
    try {
      records = ownershipStore?.all?.() ?? [];
    } catch (err) {
      // Loud, never silent: an unreadable warm scan leaves the index warmed-
      // empty (fail toward today's verdicts via the decision table's
      // absent arms) and the failure is visible on the status surface.
      this.log({ seam: 'boot', event: 'warm-scan-failed', error: err instanceof Error ? err.message : String(err) });
    }
    this.index.warmFrom(records);

    // §6 event-loop-lag gauge (~zero cost) — the P2-6 attribution instrument.
    if (!deps.disableTimers) {
      this.histogram = monitorEventLoopDelay({ resolution: 20 });
      this.histogram.enable();
      this.gaugeTimer = setInterval(() => this.sampleGauge(), 5000);
      this.gaugeTimer.unref?.();
      this.flushTimer = setInterval(() => this.flushLog(), 2000);
      this.flushTimer.unref?.();
    }
  }

  /** The onCommit hook target (§3.2.2) — wire on BOTH shipped substrates. */
  onOwnershipCommit(record: SessionOwnershipRecord): void {
    this.index.ingest(record, { fromCommit: true });
  }

  /** legacy = layer constructed but... never (construction implies enabled);
   *  dry-run = evaluating + logging, legacy guard enforcing;
   *  live = refusal authority (dryRun:false AND inventory complete — §9.14). */
  mode(): 'dry-run' | 'live' {
    const inventoryComplete = this.d.inventoryComplete ?? WRITE_SURFACE_INVENTORY_COMPLETE;
    return !this.d.dryRun && inventoryComplete ? 'live' : 'dry-run';
  }

  get isLive(): boolean {
    return this.mode() === 'live';
  }

  get dryRun(): boolean {
    return this.d.dryRun;
  }

  // ── The §3.2 decision table ────────────────────────────────────────────

  /**
   * Pure, synchronous, in-memory verdict (I2). Reads only the injected
   * in-memory lease view, the ownership index, and the registry entry.
   */
  evaluate(domain: WriteDomain, scope?: WriteScope, entry?: OpEntry | KvEntry | RouteEntry | null): AdmitVerdict {
    switch (domain) {
      case 'machine-local':
        return { admit: true };
      case 'cluster-shared':
        return this.d.isReadOnly()
          ? { admit: false, refusal: this.refusal('lease-required', domain, scope, null) }
          : { admit: true };
      case 'session-scoped':
      case 'topic-scoped': {
        // Pool INACTIVE (§3.2, was S5): scoped domains collapse to the legacy
        // lease boolean — byte-identical to today's standby behavior.
        if (!this.d.isPoolActive()) {
          return this.d.isReadOnly()
            ? { admit: false, refusal: this.refusal('read-only-standby', domain, scope, null) }
            : { admit: true };
        }
        // Keying (§3.1): one index, two key derivations.
        let topicKey: string | null = null;
        if (scope?.topicId !== undefined && scope.topicId !== null) {
          topicKey = String(scope.topicId);
        } else if (domain === 'session-scoped' && scope?.sessionId) {
          let bound: number | string | null = null;
          // The binding resolver is an in-memory map read by contract; treat a
          // resolver throw as a binding miss (fail toward delivery — §5).
          try {
            bound = this.d.resolveTopicForSession?.(scope.sessionId) ?? null;
          } catch {
            /* @silent-fallback-ok — §5 "binding unresolved" row: a resolver failure IS the
               in-memory-map miss case and fails toward DELIVERY (unbound ⇒ admit,
               machine-local-by-construction); refusing here would gate serving an inbound
               message on a standby — the exact M2 regression the table forbids. */
            bound = null;
          }
          topicKey = bound === null || bound === undefined ? null : String(bound);
        }
        if (topicKey === null) {
          if (domain === 'session-scoped') {
            // UNBOUND arm: machine-local-by-construction ⇒ ADMIT (M2).
            return { admit: true };
          }
          // topic-scoped writes carry their topic id by definition (§3.2 n/a
          // arm); a missing id resolves like the absent arm: legacy boolean.
          return this.legacyBooleanVerdict(domain, scope);
        }
        const lk = this.index.lookup(topicKey);
        if (lk.state === 'unwarmed' || lk.state === 'malformed') {
          // Fail closed on GENUINE ambiguity only (I5).
          return { admit: false, refusal: this.refusal('ownership-unresolved', domain, scope, null) };
        }
        if (lk.state === 'none' || lk.status === 'released') {
          if (domain === 'session-scoped') return { admit: true }; // today-equivalent (the carve-out)
          // topic-scoped absent/released ⇒ legacy lease boolean (§9.18) unless
          // the entry declares an I9-audited absent-window story.
          if ((entry?.kind === 'kv' || entry?.kind === 'route') && entry.absentWindowStory) {
            return { admit: true };
          }
          return this.legacyBooleanVerdict(domain, scope);
        }
        // Record in placing / active / transferring: admit iff the FSM's
        // single named owner is this machine (§9.11 — ownerOf semantics).
        if (this.d.thisMachineId !== null && lk.owner === this.d.thisMachineId) {
          return { admit: true };
        }
        return { admit: false, refusal: this.refusal('not-owner', domain, scope, lk.owner) };
      }
    }
  }

  private legacyBooleanVerdict(domain: WriteDomain, scope?: WriteScope): AdmitVerdict {
    return this.d.isReadOnly()
      ? { admit: false, refusal: this.refusal('read-only-standby', domain, scope, null) }
      : { admit: true };
  }

  private refusal(code: WriteRefusalCode, domain: WriteDomain, scope: WriteScope | undefined, ownerId: string | null): TypedWriteRefusal {
    const now = this.d.now?.() ?? Date.now();
    const ownerNick = ownerId ? this.d.nicknameOf?.(ownerId) ?? null : null;
    let hint: string;
    switch (code) {
      case 'not-owner':
        hint = `This write belongs to ${ownerNick ? `'${ownerNick}'` : `machine ${ownerId}`} — re-send it there. (Advisory only: moving the topic is a consent-gated operator decision, not a step to auto-follow.)`;
        break;
      case 'lease-required':
        hint = 'This is cluster-shared state; only the serving-lease holder writes it. Re-send to the lease holder.';
        break;
      case 'ownership-unresolved':
        hint = 'Ownership for this scope could not be resolved right now — retry shortly.';
        break;
      case 'read-only-standby':
        hint = 'This machine is on standby for this write; the serving machine handles it.';
        break;
      case 'admission-error':
        hint = 'The write-admission layer failed while evaluating this write; refused fail-closed. Retry shortly.';
        break;
    }
    let leaseHolder: string | null = null;
    try {
      leaseHolder = this.d.leaseHolder?.() ?? null;
    } catch {
      /* @silent-fallback-ok — I7: the refusal body's lease-holder decoration is best-effort
         LOCAL knowledge; a reader failure only omits the advisory field, never changes the
         verdict, and the refusal must never hang or throw on decoration. */
      leaseHolder = null;
    }
    return {
      error: 'write-refused',
      code,
      domain,
      ...(scope ? { scope } : {}),
      thisMachine: { machineId: this.d.thisMachineId, nickname: this.d.selfNickname?.() ?? null },
      owner: ownerId ? { machineId: ownerId, nickname: ownerNick } : null,
      leaseHolder,
      asOf: new Date(now).toISOString(),
      retryable: true,
      hint,
    };
  }

  // ── Store seam (§3.3) ──────────────────────────────────────────────────

  /**
   * Verdict for StateManager.guardWrite. Returns:
   *  - 'admit'  — pass (live authority admitted the write)
   *  - 'refuse' — throw the carried WriteRefusedError (live authority refused)
   *  - 'legacy' — dry-run/ladder-gated: caller runs today's legacy verdict
   * A throw ANYWHERE inside is caught by the caller ⇒ legacy verdict (§5).
   */
  guardStoreWrite(op: string, opts?: { key?: string; scope?: WriteScope; legacySessionScoped?: boolean }):
    | { enforce: 'admit' }
    | { enforce: 'refuse'; refusal: TypedWriteRefusal }
    | { enforce: 'legacy' } {
    const { domain, entry } = this.d.registry.domainForOp(op, opts?.key);
    const verdict = this.evaluate(domain, opts?.scope, entry);
    const surface = opts?.key ? `${op}:${opts.key}` : op;
    if (this.isLive) {
      this.record('store', surface, domain, verdict, opts?.scope);
      if (verdict.admit) return { enforce: 'admit' };
      return { enforce: 'refuse', refusal: verdict.refusal };
    }
    // Dry-run: compute today's LEGACY verdict and log divergences — the
    // graduation evidence (§6): wouldRefuse-but-today-succeeds = false
    // positive to fix; wouldAdmit-but-today-throws = the fix landing.
    const legacyThrows = this.d.isReadOnly() && !(opts?.legacySessionScoped && this.d.isPoolActive());
    this.recordDryRun('store', surface, domain, verdict, legacyThrows, opts?.scope);
    return { enforce: 'legacy' };
  }

  // ── Route seam (§3.4/§3.5) ─────────────────────────────────────────────

  /**
   * Verdict for a mutating HTTP route. Returns:
   *  - 'proceed' — route continues into today's exact flow
   *  - 'refuse'  — respond 409 + Retry-After with the typed body
   * An unwired route (no registry entry) always proceeds (I8). An admission-
   * layer throw splits by domain (§9.16): machine-local PROCEEDS (fail toward
   * delivery), scoped/cluster-shared REFUSE typed `admission-error` (fail
   * closed). Both directions are logged + join the §6 aggregate.
   */
  guardRouteWrite(method: string, routePath: string, scope?: WriteScope):
    | { action: 'proceed' }
    | { action: 'refuse'; refusal: TypedWriteRefusal; status: 409; retryAfterSeconds: number } {
    let entry: RouteEntry | null = null;
    try {
      entry = this.d.registry.entryForRoute(method, routePath);
      if (!entry) return { action: 'proceed' };
      const verdict = this.evaluate(entry.domain, scope, entry);
      const surface = `${method.toUpperCase()} ${entry.pathPrefix}`;
      if (this.isLive) {
        this.record('route', surface, entry.domain, verdict, scope);
        if (verdict.admit) return { action: 'proceed' };
        return { action: 'refuse', refusal: verdict.refusal, status: 409, retryAfterSeconds: 5 };
      }
      const legacyThrows = false; // routes never consulted the legacy guard (§1.2)
      this.recordDryRun('route', surface, entry.domain, verdict, legacyThrows, scope);
      return { action: 'proceed' };
    } catch (err) {
      const domain = entry?.domain ?? 'cluster-shared';
      const surface = `${method.toUpperCase()} ${entry?.pathPrefix ?? routePath}`;
      const direction = domain === 'machine-local' ? 'fail-open-proceed' : 'fail-closed-refuse';
      this.log({
        seam: 'route', surface, domain, verdict: 'admission-error', direction,
        error: err instanceof Error ? err.message : String(err),
      });
      this.bumpAggregate(surface, 'admission-error', direction);
      if (domain === 'machine-local' || !this.isLive) return { action: 'proceed' };
      return {
        action: 'refuse',
        refusal: this.refusal('admission-error', domain, scope, null),
        status: 409,
        retryAfterSeconds: 5,
      };
    }
  }

  // ── Observability (§6) ─────────────────────────────────────────────────

  private record(seam: 'store' | 'route', surface: string, domain: WriteDomain, verdict: AdmitVerdict, scope?: WriteScope): void {
    const c = this.counters.get(domain)!;
    if (verdict.admit) {
      c.admitted++;
      return;
    }
    c.refused++;
    const { hint: _hint, ...bodyMinusHint } = verdict.refusal;
    this.recentRefusals.push({ ...bodyMinusHint, seam, surface });
    if (this.recentRefusals.length > RECENT_REFUSALS_MAX) this.recentRefusals.shift();
    this.log({ seam, surface, domain, scope, verdict: 'refused', code: verdict.refusal.code, owner: verdict.refusal.owner?.machineId ?? null, leaseHolder: verdict.refusal.leaseHolder });
    this.bumpAggregate(surface, verdict.refusal.code, 'refused');
  }

  private recordDryRun(seam: 'store' | 'route', surface: string, domain: WriteDomain, verdict: AdmitVerdict, legacyThrows: boolean, scope?: WriteScope): void {
    const c = this.counters.get(domain)!;
    if (!verdict.admit && !legacyThrows) {
      c.wouldRefuse++;
      this.log({ seam, surface, domain, scope, verdict: 'would-refuse', code: verdict.refusal.code, owner: verdict.refusal.owner?.machineId ?? null });
    } else if (verdict.admit && legacyThrows) {
      c.wouldAdmitChanged++;
      this.log({ seam, surface, domain, scope, verdict: 'would-admit' });
    } else if (verdict.admit) {
      c.admitted++; // agreement rows are counted, not logged (bounded log)
    } else {
      c.refused++; // both refuse — today's behavior, count only
    }
  }

  private bumpAggregate(surface: string, code: string, direction: string): void {
    const key = `${surface}|${code}|${direction}`;
    const now = this.d.now?.() ?? Date.now();
    let a = this.aggregate.get(key);
    if (!a || now - a.windowStart > AGGREGATE_WINDOW_MS) {
      a = { count: 0, windowStart: now, raised: false };
      this.aggregate.set(key, a);
    }
    a.count++;
    const threshold = this.d.refusalAggregateThreshold ?? 5;
    if (a.count >= threshold && !a.raised) {
      a.raised = true; // ONE deduped item per window — never per-event (§6)
      try {
        this.d.raiseAttention?.({
          id: `agent:write-admission-${key.replace(/[^A-Za-z0-9:_-]+/g, '-').toLowerCase()}`,
          title: `Write-admission: ${a.count}+ ${code} on ${surface}`,
          body: `${a.count} ${code} verdicts (${direction}) for ${surface} within ${Math.round(AGGREGATE_WINDOW_MS / 60000)} min. A caller may be looping on refusals, or a guard may be broken — see GET /write-admission and logs/write-admission.jsonl.`,
        });
      } catch {
        /* @silent-fallback-ok — the aggregate alert is observability; a failing attention
           surface must never break (or recurse into) the admission path. The refusal rows
           remain in the JSONL log, so the evidence is not lost. */
      }
    }
  }

  /** Admission-layer throw at the STORE seam (§5): the caller fell back to the
   *  legacy verdict; record it so a broken guard is never log-only-invisible. */
  noteStoreSeamError(op: string, err: unknown): void {
    this.log({ seam: 'store', surface: op, verdict: 'admission-error', direction: 'fail-legacy', error: err instanceof Error ? err.message : String(err) });
    this.bumpAggregate(op, 'admission-error', 'fail-legacy');
  }

  private log(row: Record<string, unknown>): void {
    if (!this.logStore) return;
    if (this.logBuffer.length >= LOG_BUFFER_MAX) this.logBuffer.shift();
    this.logBuffer.push(JSON.stringify({ ts: new Date(this.d.now?.() ?? Date.now()).toISOString(), ...row }));
    if (this.d.disableTimers) this.flushLog(); // test seam: synchronous visibility
  }

  /** Flush buffered rows to logs/write-admission.jsonl — OFF the admission
   *  path (I2: even observability never puts fs on the decision path).
   *  Routed through JsonlStore (Bounded Accumulation: bounded + rotated). */
  flushLog(): void {
    if (!this.logStore || this.logBuffer.length === 0) return;
    const rows = this.logBuffer.splice(0, this.logBuffer.length);
    try {
      for (const r of rows) this.logStore.append(r);
    } catch (err) {
      // Loud once per flush failure: observability loss must not be silent,
      // but must also never throw into the admission path.
      console.warn(`[write-admission] log flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sampleGauge(): void {
    if (!this.histogram) return;
    const h = this.histogram;
    // monitorEventLoopDelay reports nanoseconds.
    this.lastGauge = {
      p50: Math.round(h.percentile(50) / 1e6),
      p99: Math.round(h.percentile(99) / 1e6),
      max: Math.round(h.max / 1e6),
    };
    if (this.lastGauge.max >= STARVED_WINDOW_THRESHOLD_MS) {
      this.starvedWindows.push(this.d.now?.() ?? Date.now());
    }
    const dayAgo = (this.d.now?.() ?? Date.now()) - 24 * 60 * 60 * 1000;
    this.starvedWindows = this.starvedWindows.filter((t) => t >= dayAgo);
    h.reset();
  }

  eventLoopStats(): { p50: number; p99: number; max: number; starvedWindows24h: number } {
    return { ...this.lastGauge, starvedWindows24h: this.starvedWindows.length };
  }

  /** The GET /write-admission body (§6). */
  status(): {
    enabled: true;
    dryRun: boolean;
    mode: 'dry-run' | 'live';
    inventoryComplete: boolean;
    domains: Array<{ domain: WriteDomain } & DomainCounters>;
    recentRefusals: Array<Omit<TypedWriteRefusal, 'hint'> & { seam: string; surface: string }>;
    refusedClassifications: Array<{ reason: string }>;
    ownershipIndex: { entries: number; lastCasTransitionAt: string | null };
    eventLoop: { p50: number; p99: number; max: number; starvedWindows24h: number };
  } {
    return {
      enabled: true,
      dryRun: this.d.dryRun,
      mode: this.mode(),
      inventoryComplete: this.d.inventoryComplete ?? WRITE_SURFACE_INVENTORY_COMPLETE,
      domains: DOMAINS.map((domain) => ({ domain, ...this.counters.get(domain)! })),
      recentRefusals: [...this.recentRefusals],
      refusedClassifications: this.d.registry.refusedClassifications.map((r) => ({ reason: r.reason })),
      ownershipIndex: this.index.stats(),
      eventLoop: this.eventLoopStats(),
    };
  }

  /** Tear down timers/histogram (tests + shutdown). */
  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    this.flushTimer = null;
    this.gaugeTimer = null;
    this.flushLog();
    this.histogram?.disable();
    this.histogram = null;
  }
}
