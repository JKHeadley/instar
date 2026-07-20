/**
 * WriteDomainRegistry — the single source of truth mapping every classified
 * mutating surface (StateManager op names, exact kv keys, HTTP route prefixes)
 * to its write DOMAIN + convergence story.
 *
 * Spec: docs/specs/standby-write-reconciliation.md §3.1 (taxonomy), §3.5
 * (registry + conformance ratchet), invariants I8/I9.
 *
 * Design rules enforced HERE (not by review vigilance):
 *  - I8 Registry-or-legacy, never neither: an unclassified StateManager op or
 *    kv key resolves to `cluster-shared` — exactly today's blanket guard. An
 *    unwired route resolves to null (no admission wiring, today's behavior).
 *  - I9 No machine-local without a convergence story — on BOTH axes: a
 *    machine-local entry with no logical story, or one sitting on a git-synced
 *    shared path with no file-level arm (`per-machine-path` |
 *    `git-sync-excluded`), is REFUSED the classification and downgraded to
 *    `cluster-shared` (recorded in `refusedClassifications` so the Tier-1 test
 *    and the observability surface can see it).
 *  - kv classification is EXACT-KEY (§9.12) — no prefix matching in wave 1. A
 *    key whose contents mix domains is refused classification until the store
 *    is split or re-keyed (first instance: `session-build-context` re-keyed
 *    per machine; the LEGACY key stays cluster-shared).
 *  - Topic-scoped absent-window opt-in (§3.2 table exception, §9.18) is
 *    audited under the SAME story schema (I9).
 */

export type WriteDomain = 'machine-local' | 'session-scoped' | 'topic-scoped' | 'cluster-shared';

export type LogicalConvergenceStory =
  | 'ws2x-replicated'
  | 'pool-scope-read-merge'
  | 'per-machine-path'
  | 'git-sync-excluded'
  | 'ephemeral-rebuildable';

export type FileLevelArm = 'per-machine-path' | 'git-sync-excluded';

/** The two-axis convergence story a machine-local entry must carry (§3.1). */
export interface ConvergenceStory {
  /** How the LOGICAL state converges across machines. */
  logical: LogicalConvergenceStory;
  /** Whether the backing store sits on a git-synced shared path (the round-2
   *  S1 axis: a logical story says nothing about the FILE). */
  onSharedGitSyncedPath: boolean;
  /** REQUIRED when onSharedGitSyncedPath — the file-level arm. */
  fileLevel?: FileLevelArm;
  /** Honesty note (e.g. "WS2.5 replication covers action-queue.json only and
   *  is dark on the fleet"). Human-facing, never consulted by admission. */
  note?: string;
}

export interface OpEntry {
  kind: 'op';
  /** StateManager operation name (e.g. 'saveSession'). */
  op: string;
  domain: WriteDomain;
  story?: ConvergenceStory;
}

export interface KvEntry {
  kind: 'kv';
  /** EXACT kv key (post-validateKey charset) — never a prefix (§9.12). */
  key: string;
  domain: WriteDomain;
  story?: ConvergenceStory;
  /** §3.2 table exception (§9.18): a topic-scoped entry may opt into
   *  admit-on-absent ONLY by declaring an explicit absent-window story,
   *  I9-audited on both axes. */
  absentWindowStory?: ConvergenceStory;
}

export type MutatingMethod = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RouteEntry {
  kind: 'route';
  method: MutatingMethod;
  /** Route path prefix (matched against the request path). */
  pathPrefix: string;
  domain: WriteDomain;
  story?: ConvergenceStory;
  absentWindowStory?: ConvergenceStory;
}

export type WriteDomainEntry = OpEntry | KvEntry | RouteEntry;

export interface RefusedClassification {
  entry: WriteDomainEntry;
  reason: string;
}

/**
 * Wave-2 inventory gate (§3.5 ladder gate (a), §9.14): `dryRun:false` is
 * REFUSED until the complete write-surface inventory is present in the
 * registry (TODO-classify rows permitted; absent rows are not). This constant
 * is the structural latch: WriteAdmission treats live mode as unreachable
 * while it is false, no matter what config says. Flipped by the wave-2 PR
 * that lands the reviewed inventory — never by config.
 */
export const WRITE_SURFACE_INVENTORY_COMPLETE = false;

function storyValid(story: ConvergenceStory | undefined): { ok: boolean; reason?: string } {
  if (!story) return { ok: false, reason: 'no convergence story declared (I9 first axis)' };
  if (story.onSharedGitSyncedPath && !story.fileLevel) {
    return {
      ok: false,
      reason: 'store sits on a git-synced shared path but declares no file-level arm (I9 second axis: per-machine-path | git-sync-excluded)',
    };
  }
  return { ok: true };
}

/**
 * Charset-jail a machine id for embedding in a kv key (mirrors the
 * sessionFileName jail in LocalSessionOwnershipStore, tightened to the
 * StateManager validateKey charset [A-Za-z0-9_-]).
 */
export function jailMachineIdForKey(machineId: string): string {
  return machineId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * The per-machine kv key for SessionBuildContextStore (§3.3 / §9.12).
 * `machineId` comes from the coordinator/mesh identity; installs with no mesh
 * identity use the literal 'local' (no peers ⇒ no second writer ⇒ no fork).
 */
export function sessionBuildContextKeyFor(machineId: string | null | undefined): string {
  const id = machineId && machineId.trim() ? jailMachineIdForKey(machineId) : 'local';
  return `session-build-context-${id}`;
}

export class WriteDomainRegistry {
  private readonly ops = new Map<string, OpEntry>();
  private readonly kv = new Map<string, KvEntry>();
  private readonly routes: RouteEntry[] = [];
  /** Entries that failed I9 validation and were downgraded to cluster-shared. */
  readonly refusedClassifications: RefusedClassification[] = [];

  /** Add an entry, enforcing I9. A machine-local entry failing the story
   *  validation is DOWNGRADED to cluster-shared (refused classification) —
   *  fail toward today, never silently machine-local. */
  add(entry: WriteDomainEntry): void {
    let effective = entry;
    if (entry.domain === 'machine-local') {
      const v = storyValid(entry.story);
      if (!v.ok) {
        this.refusedClassifications.push({ entry, reason: v.reason! });
        effective = { ...entry, domain: 'cluster-shared' } as WriteDomainEntry;
      }
    }
    // An absent-window opt-in on a scoped entry is audited under the same schema.
    if ((entry.kind === 'kv' || entry.kind === 'route') && entry.absentWindowStory) {
      const v = storyValid(entry.absentWindowStory);
      if (!v.ok) {
        this.refusedClassifications.push({ entry, reason: `absent-window story invalid: ${v.reason}` });
        effective = { ...effective, absentWindowStory: undefined } as WriteDomainEntry;
      }
    }
    if (effective.kind === 'op') this.ops.set(effective.op, effective);
    else if (effective.kind === 'kv') this.kv.set(effective.key, effective);
    else this.routes.push(effective);
  }

  /**
   * Resolve the domain for a StateManager op (I8: unclassified ⇒
   * cluster-shared, today's exact guard). kv ops ('set'/'delete') resolve by
   * EXACT key when one is supplied.
   */
  entryForOp(op: string, key?: string): OpEntry | KvEntry | null {
    if ((op === 'set' || op === 'delete') && key !== undefined) {
      return this.kv.get(key) ?? null;
    }
    return this.ops.get(op) ?? null;
  }

  domainForOp(op: string, key?: string): { domain: WriteDomain; entry: OpEntry | KvEntry | null } {
    const entry = this.entryForOp(op, key);
    return { domain: entry?.domain ?? 'cluster-shared', entry };
  }

  /** Resolve a mutating HTTP route. null ⇒ unwired (today's exact behavior,
   *  lint-visible — I8). */
  entryForRoute(method: string, routePath: string): RouteEntry | null {
    const m = method.toUpperCase();
    for (const r of this.routes) {
      if (r.method === m && routePath.startsWith(r.pathPrefix)) return r;
    }
    return null;
  }

  /** All route entries (conformance-ratchet + observability reads). */
  routeEntries(): readonly RouteEntry[] {
    return this.routes;
  }

  kvKeys(): string[] {
    return [...this.kv.keys()];
  }

  opNames(): string[] {
    return [...this.ops.keys()];
  }
}

/**
 * Build the WAVE-1 registry (§3.1 initial classification + §3.5 wave-1 route
 * wiring). ONE builder — the server wires THIS map and the tests assert
 * against THIS map (the PR-#334 dead-code lesson: registry↔wiring identity).
 */
export function buildWriteDomainRegistry(opts: { machineId: string | null }): WriteDomainRegistry {
  const reg = new WriteDomainRegistry();

  // ── Store seam: StateManager ops (§3.1 table) ──────────────────────────
  // Today's `sessionScoped` carve-out generalizes into the session-scoped rule.
  reg.add({ kind: 'op', op: 'saveSession', domain: 'session-scoped' });
  reg.add({ kind: 'op', op: 'removeSession', domain: 'session-scoped' });
  // Genuinely cluster-shared, single-writer = lease holder (byte-identical to today).
  reg.add({ kind: 'op', op: 'saveJobState', domain: 'cluster-shared' });
  reg.add({ kind: 'op', op: 'appendEvent', domain: 'cluster-shared' });
  // kv `set`/`delete` default cluster-shared for unclassified keys (I8) — no
  // op-level entry needed; exact-key entries below override per key.

  // ── First kv entry: SessionBuildContextStore re-keyed per machine (§3.3) ──
  // Convergence: per-machine key ⇒ single writer per file by construction;
  // git-sync carries peers' copies inertly. The LEGACY shared key
  // `session-build-context` is deliberately NOT classified — it stays
  // cluster-shared (I8) and self-drains (6h max age) + one-time lease-holder
  // cleanup.
  reg.add({
    kind: 'kv',
    key: sessionBuildContextKeyFor(opts.machineId),
    domain: 'machine-local',
    story: {
      logical: 'per-machine-path',
      onSharedGitSyncedPath: true,
      fileLevel: 'per-machine-path',
      note: 'machine id embedded in the kv key — single writer per file; peers’ copies ride git-sync inertly',
    },
  });
  // ── Route seam, wave 1: the P2-6 family (§3.5) ─────────────────────────
  // Both families are machine-local ⇒ admit everywhere — the user-visible
  // P2-6 fix. Stories per §3.1 + frontloaded decision §9.3.
  const evolutionStory: ConvergenceStory = {
    logical: 'ws2x-replicated',
    onSharedGitSyncedPath: true,
    fileLevel: 'git-sync-excluded',
    note: 'WS2.5 replication covers state/evolution/action-queue.json ONLY and is dark on the fleet (the fleet’s logical story today is honestly “none yet”); file-level arm shipped in FileClassifier sync exclusions (wave-1 build item)',
  };
  const attentionStory: ConvergenceStory = {
    logical: 'pool-scope-read-merge',
    onSharedGitSyncedPath: true,
    fileLevel: 'git-sync-excluded',
    note: 'pool-scope GET merge + WS4.1 durable remote-ack; file-level arm shipped in FileClassifier sync exclusions (wave-1 build item)',
  };
  reg.add({ kind: 'route', method: 'POST', pathPrefix: '/evolution/', domain: 'machine-local', story: evolutionStory });
  reg.add({ kind: 'route', method: 'PATCH', pathPrefix: '/evolution/', domain: 'machine-local', story: evolutionStory });
  reg.add({ kind: 'route', method: 'POST', pathPrefix: '/attention', domain: 'machine-local', story: attentionStory });
  reg.add({ kind: 'route', method: 'PATCH', pathPrefix: '/attention', domain: 'machine-local', story: attentionStory });
  reg.add({
    kind: 'route',
    method: 'POST',
    pathPrefix: '/internal/stop-gate/reset-breaker',
    domain: 'machine-local',
    story: {
      logical: 'per-machine-path',
      onSharedGitSyncedPath: true,
      fileLevel: 'git-sync-excluded',
      note: 'the breaker describes this host physical provider route and lives in the machine-local StopGateDb under the git-sync-excluded .instar state jail',
    },
  });
  reg.add({
    kind: 'route',
    method: 'POST',
    pathPrefix: '/slack/session-reply',
    domain: 'machine-local',
    story: {
      logical: 'per-machine-path',
      onSharedGitSyncedPath: false,
      note: 'the route accepts only a ConversationRegistry row whose origin is this machine, then emits through this machine\'s physical Slack adapter credentials; replicated or foreign-origin rows are refused and no git-synced store is mutated',
    },
  });
  reg.add({
    kind: 'route',
    method: 'POST',
    pathPrefix: '/continuation/',
    domain: 'machine-local',
    story: {
      logical: 'git-sync-excluded',
      onSharedGitSyncedPath: true,
      fileLevel: 'git-sync-excluded',
      note: 'continuation ledgers bind to one local Codex session and Stop hook under the project stateDir; .instar/continuation is explicitly excluded from git sync so another machine never adopts or actuates them',
    },
  });
  reg.add({
    kind: 'route',
    method: 'POST',
    pathPrefix: '/playwright-profiles/seat/acquire',
    domain: 'machine-local',
    story: {
      logical: 'per-machine-path',
      onSharedGitSyncedPath: false,
      note: 'the lease protects browser cookies/user-data physically resident on this host; ~/.instar/state is outside every agent project and git sync',
    },
  });
  reg.add({
    kind: 'route',
    method: 'POST',
    pathPrefix: '/playwright-profiles/seat/release',
    domain: 'machine-local',
    story: {
      logical: 'per-machine-path',
      onSharedGitSyncedPath: false,
      note: 'ownership-checked release mutates the same host-wide browser-seat lease outside project git sync',
    },
  });

  // Apprenticeship instance transitions mutate durable program state. Keep
  // those writes on the cluster-shared/single-writer side so two machines can
  // never fork rung or lifecycle history. Read-only POST previews currently
  // share this path family; admission remains dry-run until the wave-2 latch.
  reg.add({
    kind: 'route',
    method: 'POST',
    pathPrefix: '/apprenticeship/instances/',
    domain: 'cluster-shared',
  });

  // Pending enrollment records + raw login panes belong to the machine driving
  // the login. Pool-scope pending-logins merges the logical view across peers;
  // the backing stateDir file remains inside the git-sync-excluded .instar jail.
  const enrollmentStory: ConvergenceStory = {
    logical: 'pool-scope-read-merge',
    onSharedGitSyncedPath: true,
    fileLevel: 'git-sync-excluded',
    note: 'GET /subscription-pool/pending-logins?scope=pool merges owning-machine records; pending-logins.json and its raw tmux pane remain target-local under the .instar git-sync exclusion',
  };
  reg.add({
    kind: 'route', method: 'POST', pathPrefix: '/subscription-pool/enroll/',
    domain: 'machine-local', story: enrollmentStory,
  });

  // Credential identity repair executes staged swaps only among login homes on
  // this machine. Claude credentials cannot be relocated across machines; the
  // ledger/audit state is likewise agent-home-local and outside git sync.
  reg.add({
    kind: 'route',
    method: 'POST',
    pathPrefix: '/credentials/repair-plan/execute',
    domain: 'machine-local',
    story: {
      logical: 'git-sync-excluded',
      onSharedGitSyncedPath: false,
      note: 'executes identity-verified staged swaps between this machine’s credential homes; credential files and the location ledger/audit live under agent-home-local state and never converge across machines',
    },
  });

  // ── Routing Control Room MONEY surfaces (Increment B, §Surface 2) ────────
  // Single-writer BY DESIGN (FD-20): the whole cap lives on ONE PIN-designated
  // metered-lease machine until Increment D — the caps store + booking ledger are
  // that machine's local state files (git-sync-excluded under .instar/state/), and
  // every OTHER machine's gate fails closed by construction (`no-cap-slice` /
  // `lease-liveness-unconfirmed`), so machine-local admission IS the convergence
  // story: there is nothing to converge, one machine may ever write.
  const moneyStory: ConvergenceStory = {
    logical: 'git-sync-excluded',
    onSharedGitSyncedPath: false,
    note: 'FD-20: Increment B money is single-writer (one PIN-designated metered-lease machine); state/routing-spend-caps.json + the booking ledger are its local files; every other machine’s gate fails closed by construction. Increment D replicates cap SLICES, never these files.',
  };
  reg.add({ kind: 'route', method: 'POST', pathPrefix: '/routing-spend/plan', domain: 'machine-local', story: moneyStory });
  reg.add({ kind: 'route', method: 'POST', pathPrefix: '/routing-spend/caps/adjust', domain: 'machine-local', story: moneyStory });
  reg.add({ kind: 'route', method: 'POST', pathPrefix: '/routing-spend/go-live', domain: 'machine-local', story: moneyStory });
  reg.add({ kind: 'route', method: 'POST', pathPrefix: '/routing-spend/unfreeze', domain: 'machine-local', story: moneyStory });
  reg.add({ kind: 'route', method: 'POST', pathPrefix: '/routing-spend/freeze', domain: 'machine-local', story: moneyStory });

  // ── Interactive working-set artifact recorder (intelligent-working-set-lazy-sync §F8) ──
  // Machine-local: POST /coherence/working-set/record writes THIS machine's OWN-ORIGIN interactive
  // artifact rows to .instar/working-set/artifacts.json. Logical state converges via the WS2
  // 'working-set-artifact' replicated store (dark by default: stateSync.workingSetArtifact omitted
  // ⇒ no emit); the backing file sits under the git-sync-excluded .instar/ jail.
  const workingSetArtifactStory: ConvergenceStory = {
    logical: 'ws2x-replicated',
    onSharedGitSyncedPath: true,
    fileLevel: 'git-sync-excluded',
    note: 'WS2 working-set-artifact replication covers .instar/working-set/artifacts.json (own-origin per-topic rows) and is dark on the fleet (stateSync.workingSetArtifact omitted ⇒ no emit); file-level arm via the .instar/ git-sync exclusion',
  };
  reg.add({ kind: 'route', method: 'POST', pathPrefix: '/coherence/working-set/record', domain: 'machine-local', story: workingSetArtifactStory });

  // ── Seamless orchestrator manual soak tick (llm-seamlessness-orchestrator.md §Component3) ──
  // Machine-local by construction: POST /intelligence/seamless-orchestrator/tick drives THIS
  // machine's lease-gated orchestrator pass once. In dryRun (the shipped default) it actuates
  // NOTHING; its only durable writes are the append-only audit trail (logs/orchestrator-actions.jsonl)
  // + placement-signal log — per-machine soak EVIDENCE, never converged across machines, fully
  // rebuildable (the next tick regenerates them). The in-process oscillation-blacklist is machine-
  // local memory; its WS2 cross-machine replication is a tracked P4-live follow-up. The audit logs
  // live under the agent-home `logs/` dir (a sibling of .instar/), outside any git repo — never a
  // git-synced/shared mesh path.
  reg.add({
    kind: 'route',
    method: 'POST',
    pathPrefix: '/intelligence/seamless-orchestrator/tick',
    domain: 'machine-local',
    story: {
      logical: 'ephemeral-rebuildable',
      onSharedGitSyncedPath: false,
      note: 'the orchestrator audit + placement-signal logs are per-machine soak evidence under agent-home logs/ (outside git); the oscillation-blacklist is in-process memory (WS2 replication is a tracked P4-live follow-up); dryRun actuates nothing',
    },
  });

  // ── Review canary battery trigger (context-aware-outbound-review §D9.4b) ──
  // Machine-local by construction: the Bearer-gated soak trigger runs THIS
  // machine's review pipeline against booby-trapped fixtures. Its only writes
  // are (a) transient fixture rows in the per-machine topic-memory SQLite,
  // scoped to reserved NEGATIVE topic ids and removed in a finally (plus the
  // next run's pre-clean, R4-m4), and (b) append-only batterySummary /
  // decision rows in logs/response-review-decisions.jsonl — per-machine soak
  // EVIDENCE, never authority, never converged across machines. Re-running
  // the battery regenerates everything the route ever writes.
  reg.add({
    kind: 'route',
    method: 'POST',
    pathPrefix: '/review/canary-battery/run',
    domain: 'machine-local',
    story: {
      logical: 'ephemeral-rebuildable',
      onSharedGitSyncedPath: true,
      fileLevel: 'git-sync-excluded',
      note: 'canary fixtures are finally-cleaned rows in the per-machine topic-memory SQLite (reserved negative topic ids); the D8 decision log is per-machine soak evidence; file-level arm shipped in FileClassifier sync exclusions (.instar/topic-memory.db + logs/response-review-decisions.jsonl)',
    },
  });

  // ── Test-runner concurrency-bound recovery lever (test-runner-concurrency-bound §2.6/§2.7) ──
  // Machine-local by construction: the semaphore bounds THIS machine's CPU
  // cores, so its holders file is an OS-level rendezvous at ~/.instar/
  // host-test-runner-holders.json — outside any git repo (a lock-file peer),
  // never git-synced. POST /prune only removes dead/TTL-expired holder rows to
  // restore capacity — fully ephemeral and rebuildable (a re-run regenerates
  // everything it touches). Machine-locality is doubly enforced in the design:
  // df-local determination gates all reclaim, and a foreign-hostname holder on a
  // (mis)synced ~/.instar is DROPPED, so the count never converges across
  // machines even if the path is userspace-synced (Dropbox/iCloud). The GET
  // status route is a pure read (non-mutating) and needs no classification.
  reg.add({
    kind: 'route',
    method: 'POST',
    pathPrefix: '/test-runner-limiter/prune',
    domain: 'machine-local',
    story: {
      logical: 'ephemeral-rebuildable',
      onSharedGitSyncedPath: false,
      note: 'holders file is a machine-local OS rendezvous at ~/.instar/host-test-runner-holders.json (outside any git tree); prune reclaims only dead/expired rows (capacity bookkeeping, fully rebuildable); df-local gate + foreign-hostname-holder drop prevent cross-machine convergence even on a userspace-synced home',
    },
  });

  // ── External-hog arm/disarm (external-hog-sentinel spec, arm gate) ──
  // Machine-local BY SAFETY DESIGN, not convenience: the PIN-gated arm marker
  // (state/external-hog-arm.json) is this machine's operator consent to LIVE
  // kills of THIS machine's processes. It must NEVER converge across machines —
  // a synced marker would silently arm a peer's sentinel the operator never
  // consented to (the exact silent-re-arm class the armEpoch/disarmEpoch design
  // exists to prevent). So the logical story IS the file-level story: the
  // marker is git-sync-excluded and each machine's arm state stands alone.
  const externalHogArmStory: ConvergenceStory = {
    logical: 'git-sync-excluded',
    onSharedGitSyncedPath: true,
    fileLevel: 'git-sync-excluded',
    note: 'arm marker is per-machine PIN consent — cross-machine convergence would BE the vulnerability (silent remote arm); file-level arm shipped in FileClassifier sync exclusions (.instar/state/external-hog-arm.json)',
  };
  reg.add({ kind: 'route', method: 'POST', pathPrefix: '/external-hog/arm', domain: 'machine-local', story: externalHogArmStory });
  reg.add({ kind: 'route', method: 'POST', pathPrefix: '/external-hog/disarm', domain: 'machine-local', story: externalHogArmStory });

  // ── Decision-Quality deterministic grading pass (llm-decision-quality-meter §5.5, §Multi-machine) ──
  // Machine-local by construction: POST /decision-quality/grade-pass upserts grade
  // rows for THIS machine's decision points into the per-machine feature-metrics
  // SQLite (state/server-data/feature-metrics.db — decision_quality/decision_outcomes/
  // rollup/cursor tables). It inherits the RATIFIED machine-local feature_metrics
  // posture (spec §Multi-machine: "machine-local SQLite observability; per-machine
  // spend/activity is the semantic unit"); the grading job runs per machine over its
  // OWN local rows. Logical convergence is proxied-on-read — GET /decision-quality?scope=pool
  // merges MACHINE-TAGGED rows across peers, summed nowhere silently. The backing store
  // is a binary SQLite .db under the generated .instar/ server-data dir — git-sync-excluded
  // on both counts (FileClassifier BINARY_EXTENSIONS + the .instar/server-data generated
  // pattern), mirroring the topic-memory.db precedent above.
  reg.add({
    kind: 'route',
    method: 'POST',
    pathPrefix: '/decision-quality/grade-pass',
    domain: 'machine-local',
    story: {
      logical: 'pool-scope-read-merge',
      onSharedGitSyncedPath: true,
      fileLevel: 'git-sync-excluded',
      note: 'grades upsert into the per-machine feature-metrics SQLite (decision_quality/decision_outcomes tables); GET /decision-quality?scope=pool merges machine-tagged rows across peers (summed nowhere silently); the .db is git-sync-excluded via FileClassifier BINARY_EXTENSIONS + the .instar/server-data generated pattern',
    },
  });

  // ── Benchmark-Divergence analyze pass (benchmark-divergence-detector §FD8, §Multi-machine) ──
  // Machine-local by construction, inheriting the SAME ratified feature_metrics posture as
  // the decision-quality grade-pass above: POST /benchmark-divergence/analyze runs on the
  // SERVING-LEASE HOLDER only and upserts finding + watermark rows into the per-machine
  // feature-metrics SQLite (state/server-data/feature-metrics.db — benchmark_analysis_finding
  // /_watermark/_history + decision_quality_rollup_by_model). Findings are holder-local durable
  // state (never replicated) that idempotently rebuild from raw on the next pass; logical
  // convergence is proxied-on-read — GET /benchmark-divergence?scope=pool merges machine-tagged
  // findings across peers through the FD9 clamps (free-text never crosses), summed nowhere
  // silently. The .db is git-sync-excluded on both counts (FileClassifier BINARY_EXTENSIONS +
  // the .instar/server-data generated pattern), exactly like the grade-pass precedent.
  reg.add({
    kind: 'route',
    method: 'POST',
    pathPrefix: '/benchmark-divergence/analyze',
    domain: 'machine-local',
    story: {
      logical: 'pool-scope-read-merge',
      onSharedGitSyncedPath: true,
      fileLevel: 'git-sync-excluded',
      note: 'lease-holder-only analyze pass upserts holder-local findings/watermark/by_model-rollup rows into the per-machine feature-metrics SQLite; GET /benchmark-divergence?scope=pool merges machine-tagged findings across peers through the FD9 clamps (free-text never crosses); the .db is git-sync-excluded via FileClassifier BINARY_EXTENSIONS + the .instar/server-data generated pattern',
    },
  });

  return reg;
}
