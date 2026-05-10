/**
 * InitiativeTracker — persists and queries multi-phase, long-running work.
 *
 * Fills the gap between one-off AttentionItems (single actionable) and
 * scheduled Jobs (recurring cron task). An Initiative represents a
 * bounded-but-multi-week effort with phases, each advancing in order.
 *
 * Storage:
 *   - When TaskFlow is wired (`setTaskFlowRegistry`), TaskFlow is the
 *     **single source of truth** (per OPENCLAW-IMPORT-TASKFLOW-SPEC.md
 *     § Phase 4, lines 645–648). Each initiative is one TaskFlow record:
 *     `controllerId="InitiativeTracker"`, `ownerKey="initiative:<id>"`,
 *     `idempotencyKey="initiative:<id>"`. The full Initiative shape is
 *     persisted in `stateJson`. The active phase id maps to `currentStep`;
 *     `needsUser` / blockers map to `setFlowWaiting({kind:"human-review"})`.
 *   - When TaskFlow is NOT wired, behavior falls back to legacy
 *     `.instar/initiatives.json`. This keeps the disabled-feature path
 *     working for installs where `taskFlow.enabled` is false.
 *
 * Migration:
 *   - On startup, the server calls `migrateExistingToTaskFlow()` once when
 *     TaskFlow is enabled. It backfills any initiatives present in the
 *     legacy JSON file into TaskFlow. Idempotent via `findIdempotent` on
 *     `(controllerId, ownerKey, idempotencyKey)` — running twice produces
 *     no duplicates.
 *
 * API shape:
 *   - All public mutators are `async` to allow TaskFlow's promise-based
 *     write API to complete before returning. Reads are `sync` (TaskFlow's
 *     read API uses `better-sqlite3` synchronously through the in-memory
 *     cache).
 *
 * Consumers: HTTP routes (`/initiatives/*`), dashboard "Initiatives" tab,
 * daily digest job (alerts when initiatives go stale / need user input /
 * are ready to advance).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TaskFlowRegistry } from '../tasks/TaskFlowRegistry.js';
import type {
  TaskFlowPrincipal,
  TaskFlowRecord,
  WaitJson,
} from '../tasks/task-flow-types.js';
import { TaskFlowError } from '../tasks/task-flow-types.js';

export type InitiativePhaseStatus = 'pending' | 'in-progress' | 'done' | 'blocked';

export interface InitiativePhase {
  /** Stable identifier within this initiative (e.g. 'phase-a'). */
  id: string;
  /** Human-readable name (e.g. 'Phase A: Scaffolding'). */
  name: string;
  /** Short summary of what this phase delivers. */
  summary?: string;
  status: InitiativePhaseStatus;
  /** ISO timestamp when status first became 'in-progress'. */
  startedAt?: string;
  /** ISO timestamp when status first became 'done'. */
  completedAt?: string;
}

export type InitiativeStatus = 'active' | 'completed' | 'archived' | 'abandoned';

export interface InitiativeLink {
  type: 'spec' | 'pr' | 'commit' | 'topic' | 'doc' | 'other';
  label: string;
  url?: string;
  ref?: string;
}

export interface Initiative {
  /** URL-safe slug (stable identifier). */
  id: string;
  title: string;
  description: string;
  status: InitiativeStatus;
  phases: InitiativePhase[];
  /** Index into phases[] of the phase currently active (or last worked on). */
  currentPhaseIndex: number;
  /** ISO timestamp of the last phase/status update. */
  lastTouchedAt: string;
  /** Optional ISO timestamp; digest job flags if past and status === 'active'. */
  nextCheckAt?: string;
  /** True when waiting on the user (decision, approval, ratification). */
  needsUser: boolean;
  /** Short rationale when needsUser === true. */
  needsUserReason?: string;
  /** Free-text list of current blockers (not necessarily user-blocked). */
  blockers: string[];
  /** External references: spec docs, PRs, commits, Telegram topics, etc. */
  links: InitiativeLink[];
  createdAt: string;
  updatedAt: string;
}

export interface InitiativeCreateInput {
  id: string;
  title: string;
  description: string;
  phases: Array<{ id: string; name: string; summary?: string; status?: InitiativePhaseStatus }>;
  links?: InitiativeLink[];
  nextCheckAt?: string;
  needsUser?: boolean;
  needsUserReason?: string;
  blockers?: string[];
}

export interface InitiativeUpdateInput {
  title?: string;
  description?: string;
  status?: InitiativeStatus;
  nextCheckAt?: string | null;
  needsUser?: boolean;
  needsUserReason?: string | null;
  blockers?: string[];
  links?: InitiativeLink[];
}

export interface DigestItem {
  initiativeId: string;
  title: string;
  reason: 'stale' | 'needs-user' | 'next-check-due' | 'ready-to-advance';
  detail: string;
}

export interface Digest {
  generatedAt: string;
  items: DigestItem[];
}

/**
 * Staleness threshold for the digest scan (7 days without an update on an
 * active initiative triggers a 'stale' flag).
 */
export const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * TaskFlow controller identity for InitiativeTracker (Phase 4 migration).
 * Every initiative's flow is owned by this controllerId; the registry uses
 * it for OCC scope checks. Single instance per server process.
 */
export const INITIATIVE_TASKFLOW_CONTROLLER_ID = 'InitiativeTracker';

function ownerKeyForInitiative(initiativeId: string): string {
  return `initiative:${initiativeId}`;
}

function idempotencyKeyForInitiative(initiativeId: string): string {
  return `initiative:${initiativeId}`;
}

export class InitiativeTracker {
  private readonly filePath: string;
  /** In-process cache. Authoritative when TaskFlow is not wired; otherwise
   * a read-side projection of TaskFlow's stateJson. */
  private readonly initiatives = new Map<string, Initiative>();

  // ── TaskFlow Phase 4 wiring ────────────────────────────────────
  private taskFlowRegistry: TaskFlowRegistry | null = null;
  private taskFlowControllerInstanceId: string | null = null;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'initiatives.json');
    this.loadFromDisk();
  }

  /**
   * Wire a TaskFlow registry to make TaskFlow the source of truth.
   * Idempotent — safe to call multiple times. After wiring, all reads come
   * from TaskFlow and all writes go through TaskFlow APIs. The legacy JSON
   * file is no longer written.
   *
   * Callers are expected to call `migrateExistingToTaskFlow()` after this
   * to backfill any initiatives that were loaded from the legacy file.
   */
  setTaskFlowRegistry(
    registry: TaskFlowRegistry,
    controllerInstanceId: string
  ): void {
    this.taskFlowRegistry = registry;
    this.taskFlowControllerInstanceId = controllerInstanceId;
    // Layer existing TaskFlow records over legacy-loaded data without
    // clearing the cache: any legacy initiatives still need to be backfilled
    // via `migrateExistingToTaskFlow()`. TaskFlow records win on collision.
    this.layerCacheFromTaskFlow();
  }

  /** True when TaskFlow is wired and authoritative. */
  isTaskFlowEnabled(): boolean {
    return this.taskFlowRegistry !== null && this.taskFlowControllerInstanceId !== null;
  }

  private taskFlowPrincipal(): TaskFlowPrincipal | null {
    if (!this.taskFlowRegistry || !this.taskFlowControllerInstanceId) return null;
    return {
      scope: 'controller',
      controllerId: INITIATIVE_TASKFLOW_CONTROLLER_ID,
      controllerInstanceId: this.taskFlowControllerInstanceId,
    };
  }

  // ── Legacy JSON storage (used until TaskFlow is wired) ─────────

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (Array.isArray(raw?.initiatives)) {
        for (const item of raw.initiatives) {
          if (item && typeof item.id === 'string') {
            this.initiatives.set(item.id, item as Initiative);
          }
        }
      }
    } catch (err) {
      console.error(`[initiatives] Failed to load: ${err instanceof Error ? err.message : err}`);
    }
  }

  private saveToDisk(): void {
    if (this.isTaskFlowEnabled()) return; // TaskFlow's SQLite is the durable store.
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = { initiatives: Array.from(this.initiatives.values()) };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  // ── TaskFlow ↔ Initiative serialization ─────────────────────────

  private initiativeFromFlow(flow: TaskFlowRecord): Initiative | null {
    const state = flow.stateJson as { initiative?: Initiative } | undefined;
    if (!state || typeof state !== 'object' || !state.initiative) return null;
    return state.initiative;
  }

  private refreshCacheFromTaskFlow(): void {
    if (!this.taskFlowRegistry) return;
    const flows = this.taskFlowRegistry.findByControllerId(
      INITIATIVE_TASKFLOW_CONTROLLER_ID
    );
    this.initiatives.clear();
    for (const f of flows) {
      const init = this.initiativeFromFlow(f);
      // Tombstone-removed initiatives are filtered out so callers can't
      // see them via list() / get() after remove().
      if (init && !this.isTombstoned(f)) {
        this.initiatives.set(init.id, init);
      }
    }
  }

  /**
   * Layer TaskFlow data on top of the existing cache without clearing it.
   * Used during `setTaskFlowRegistry` so legacy-loaded initiatives are
   * preserved as backfill candidates while any pre-existing TaskFlow
   * records take precedence.
   */
  private layerCacheFromTaskFlow(): void {
    if (!this.taskFlowRegistry) return;
    const flows = this.taskFlowRegistry.findByControllerId(
      INITIATIVE_TASKFLOW_CONTROLLER_ID
    );
    for (const f of flows) {
      const init = this.initiativeFromFlow(f);
      if (init && !this.isTombstoned(f)) {
        this.initiatives.set(init.id, init);
      } else if (this.isTombstoned(f) && init) {
        // Tombstoned flows shadow legacy entries.
        this.initiatives.delete(init.id);
      }
    }
  }

  /**
   * A flow is "tombstoned" when remove() marked it as removed before
   * cancelling. The marker lives in stateJson._removed and is the
   * single signal that a flow's owning Initiative should be hidden from
   * list() / get(). We can't delete TaskFlow records from this layer, so
   * the marker is the durable equivalent of deletion.
   */
  private isTombstoned(flow: TaskFlowRecord): boolean {
    const state = flow.stateJson as { _removed?: boolean } | undefined;
    return state?._removed === true;
  }

  private waitJsonForInitiative(init: Initiative): WaitJson | null {
    const blocked = init.needsUser || init.blockers.length > 0;
    if (!blocked) return null;
    const reason = init.needsUser
      ? init.needsUserReason ?? 'Initiative needs user decision'
      : init.blockers.join('; ');
    const question = (reason || 'Initiative blocked').slice(0, 2000);
    return { kind: 'human-review', question };
  }

  /** Determine the desired TaskFlow status for an Initiative. */
  private desiredFlowStatus(init: Initiative):
    | { kind: 'running'; step: string }
    | { kind: 'waiting'; step: string; waitJson: WaitJson }
    | { kind: 'succeeded'; step: string }
    | { kind: 'failed'; step: string }
    | { kind: 'cancelled'; step: string } {
    const phase = init.phases[init.currentPhaseIndex];
    const step = phase ? phase.id : 'unknown';
    if (init.status === 'completed') return { kind: 'succeeded', step };
    if (init.status === 'abandoned') return { kind: 'failed', step };
    if (init.status === 'archived') return { kind: 'cancelled', step };
    const wait = this.waitJsonForInitiative(init);
    if (wait) return { kind: 'waiting', step, waitJson: wait };
    return { kind: 'running', step };
  }

  /**
   * Persist an Initiative through TaskFlow. Walks the flow state machine
   * to the desired target (running / waiting / succeeded / failed /
   * cancelled), updating `stateJson` along the way so reads see the latest
   * shape. Returns the Initiative as projected from TaskFlow after
   * transitions settle.
   */
  private async persistThroughTaskFlow(init: Initiative): Promise<Initiative> {
    const registry = this.taskFlowRegistry;
    const principal = this.taskFlowPrincipal();
    if (!registry || !principal || principal.scope !== 'controller') return init;

    const ownerKey = ownerKeyForInitiative(init.id);
    const idemKey = idempotencyKeyForInitiative(init.id);
    const desired = this.desiredFlowStatus(init);
    const stateJson = { initiative: init };

    let existing = registry.findByIdempotency(
      INITIATIVE_TASKFLOW_CONTROLLER_ID,
      ownerKey,
      idemKey
    );
    if (!existing) {
      const r = await registry.createFlow({
        controllerId: INITIATIVE_TASKFLOW_CONTROLLER_ID,
        controllerInstanceId: principal.controllerInstanceId,
        ownerKey,
        idempotencyKey: idemKey,
        goal: init.title.slice(0, 1024),
        currentStep: desired.step,
        stateJson,
      });
      existing = r.flow;
    }
    let cur = registry.getFlow(existing.flowId, { bypassCache: true }) ?? existing;

    try {
      // Already terminal? Accept and stop — terminal flows are immutable
      // per TaskFlow contract. The Initiative's local terminal state stays
      // in sync via the cache, but we never re-mutate the flow.
      if (
        cur.status === 'succeeded' ||
        cur.status === 'failed' ||
        cur.status === 'cancelled' ||
        cur.status === 'lost'
      ) {
        return this.initiativeFromFlow(cur) ?? init;
      }

      // queued → running (always; a fresh create lands in queued).
      if (cur.status === 'queued') {
        const r = await registry.startStep({
          flowId: cur.flowId,
          expectedRevision: cur.revision,
          principal,
          currentStep: desired.step,
        });
        cur = r.flow;
      }

      // waiting → running (resume), in case desired wait is different or
      // we're moving to running/terminal. resumeFlow accepts statePatch so
      // we update stateJson here too.
      if (cur.status === 'waiting') {
        if (cur.waitInstanceId) {
          const r = await registry.resumeFlow({
            flowId: cur.flowId,
            expectedRevision: cur.revision,
            principal,
            waitInstanceId: cur.waitInstanceId,
            currentStep: desired.step,
            statePatch: stateJson,
          });
          cur = r.flow;
        }
      }

      // Now cur.status === 'running'. Drive to the desired terminal state.
      if (cur.status === 'running') {
        if (desired.kind === 'running') {
          // Re-startStep when currentStep changed; this updates the step.
          if (cur.currentStep !== desired.step) {
            const r = await registry.startStep({
              flowId: cur.flowId,
              expectedRevision: cur.revision,
              principal,
              currentStep: desired.step,
            });
            cur = r.flow;
          }
          // Always patch stateJson to reflect the latest Initiative shape.
          cur = await this.patchStateJson(cur, stateJson);
        } else if (desired.kind === 'waiting') {
          const r = await registry.setFlowWaiting({
            flowId: cur.flowId,
            expectedRevision: cur.revision,
            principal,
            waitJson: desired.waitJson,
            currentStep: desired.step,
            statePatch: stateJson,
          });
          cur = r.flow;
        } else if (desired.kind === 'succeeded') {
          cur = await this.patchStateJson(cur, stateJson);
          const r = await registry.finishFlow({
            flowId: cur.flowId,
            expectedRevision: cur.revision,
            principal,
          });
          cur = r.flow;
        } else if (desired.kind === 'failed') {
          cur = await this.patchStateJson(cur, stateJson);
          const r = await registry.failFlow({
            flowId: cur.flowId,
            expectedRevision: cur.revision,
            principal,
            failureReason: 'abandoned',
          });
          cur = r.flow;
        } else if (desired.kind === 'cancelled') {
          cur = await this.patchStateJson(cur, stateJson);
          const cr = await registry.requestFlowCancel({
            flowId: cur.flowId,
            expectedRevision: cur.revision,
            requesterOrigin: { kind: 'system', id: 'InitiativeTracker' },
          });
          const r = await registry.cancelFlow({
            flowId: cur.flowId,
            expectedRevision: cr.flow.revision,
            principal,
          });
          cur = r.flow;
        }
      }
    } catch (err) {
      this.logTaskFlowError('persist', init.id, err);
    }

    const fresh = registry.getFlow(cur.flowId, { bypassCache: true }) ?? cur;
    const persisted = this.initiativeFromFlow(fresh) ?? init;
    this.initiatives.set(persisted.id, persisted);
    return persisted;
  }

  /**
   * Patch a running flow's stateJson without changing its observable
   * status. Uses a brief setFlowWaiting → resumeFlow round-trip (the only
   * atomic state-bearing transitions for `running` flows that accept
   * `statePatch`). The wait kind `'human-review'` with a sentinel question
   * is used; the wait is consumed in the same call, so no external
   * observer sees `waiting`.
   */
  private async patchStateJson(
    flow: TaskFlowRecord,
    stateJson: { initiative: Initiative }
  ): Promise<TaskFlowRecord> {
    const registry = this.taskFlowRegistry;
    const principal = this.taskFlowPrincipal();
    if (!registry || !principal || principal.scope !== 'controller') return flow;
    if (flow.status !== 'running') return flow;
    try {
      const w = await registry.setFlowWaiting({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        principal,
        waitJson: { kind: 'human-review', question: '__statePatch__' },
        statePatch: stateJson,
      });
      const r = await registry.resumeFlow({
        flowId: w.flow.flowId,
        expectedRevision: w.flow.revision,
        principal,
        waitInstanceId: w.flow.waitInstanceId!,
        statePatch: stateJson,
      });
      return r.flow;
    } catch (err) {
      this.logTaskFlowError('patchStateJson', flow.flowId, err);
      return flow;
    }
  }

  private findFlowIdForInitiative(id: string): string | null {
    const registry = this.taskFlowRegistry;
    if (!registry) return null;
    const f = registry.findByIdempotency(
      INITIATIVE_TASKFLOW_CONTROLLER_ID,
      ownerKeyForInitiative(id),
      idempotencyKeyForInitiative(id)
    );
    return f?.flowId ?? null;
  }

  private logTaskFlowError(op: string, key: string, err: unknown): void {
    if (err instanceof TaskFlowError) {
      console.warn(
        `[InitiativeTracker] taskflow ${op} for ${key} skipped: ${err.code} (${err.message})`
      );
    } else {
      console.warn(
        `[InitiativeTracker] taskflow ${op} for ${key} unexpected error:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Backfill all initiatives currently in the in-memory cache (loaded from
   * legacy JSON in the constructor) into TaskFlow. Idempotent via
   * `findIdempotent`. Safe to call multiple times.
   */
  async migrateExistingToTaskFlow(): Promise<{
    created: number;
    alreadyExisted: number;
    advanced: number;
    skipped: number;
  }> {
    const registry = this.taskFlowRegistry;
    const principal = this.taskFlowPrincipal();
    if (!registry || !principal || principal.scope !== 'controller') {
      return { created: 0, alreadyExisted: 0, advanced: 0, skipped: 0 };
    }
    let created = 0;
    let alreadyExisted = 0;
    let advanced = 0;
    let skipped = 0;
    const candidates = Array.from(this.initiatives.values());
    for (const init of candidates) {
      try {
        const ownerKey = ownerKeyForInitiative(init.id);
        const idemKey = idempotencyKeyForInitiative(init.id);
        const existing = registry.findByIdempotency(
          INITIATIVE_TASKFLOW_CONTROLLER_ID,
          ownerKey,
          idemKey
        );
        if (existing) {
          alreadyExisted++;
        } else {
          await registry.createFlow({
            controllerId: INITIATIVE_TASKFLOW_CONTROLLER_ID,
            controllerInstanceId: principal.controllerInstanceId,
            ownerKey,
            idempotencyKey: idemKey,
            goal: init.title.slice(0, 1024),
            currentStep: init.phases[init.currentPhaseIndex]?.id ?? 'start',
            stateJson: { initiative: init },
          });
          created++;
        }
        const persisted = await this.persistThroughTaskFlow(init);
        if (persisted) advanced++;
      } catch (err) {
        skipped++;
        this.logTaskFlowError('migrate', init.id, err);
      }
    }
    this.refreshCacheFromTaskFlow();
    return { created, alreadyExisted, advanced, skipped };
  }

  // ── Public API ─────────────────────────────────────────────────

  list(filter?: { status?: InitiativeStatus }): Initiative[] {
    if (this.isTaskFlowEnabled()) this.refreshCacheFromTaskFlow();
    const all = Array.from(this.initiatives.values());
    const filtered = filter?.status ? all.filter((i) => i.status === filter.status) : all;
    return filtered.sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt));
  }

  get(id: string): Initiative | undefined {
    if (this.isTaskFlowEnabled()) {
      const fid = this.findFlowIdForInitiative(id);
      if (!fid) return undefined;
      const f = this.taskFlowRegistry!.getFlow(fid, { bypassCache: true });
      if (!f) return undefined;
      if (this.isTombstoned(f)) {
        this.initiatives.delete(id);
        return undefined;
      }
      const init = this.initiativeFromFlow(f);
      if (init) this.initiatives.set(id, init);
      return init ?? undefined;
    }
    return this.initiatives.get(id);
  }

  async create(input: InitiativeCreateInput): Promise<Initiative> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.id)) {
      throw new Error('Initiative id must be lowercase kebab-case, 1–63 chars');
    }
    if (!input.phases.length) {
      throw new Error('Initiative must have at least one phase');
    }
    if (this.isTaskFlowEnabled()) {
      if (this.findFlowIdForInitiative(input.id)) {
        throw new Error(`Initiative "${input.id}" already exists`);
      }
    } else if (this.initiatives.has(input.id)) {
      throw new Error(`Initiative "${input.id}" already exists`);
    }
    const now = new Date().toISOString();
    const phases: InitiativePhase[] = input.phases.map((p) => ({
      id: p.id,
      name: p.name,
      summary: p.summary,
      status: p.status ?? 'pending',
    }));
    const firstOpen = phases.findIndex((p) => p.status !== 'done');
    const currentPhaseIndex = firstOpen === -1 ? phases.length - 1 : firstOpen;
    const allDone = phases.every((p) => p.status === 'done');
    const initiative: Initiative = {
      id: input.id,
      title: input.title,
      description: input.description,
      status: allDone ? 'completed' : 'active',
      phases,
      currentPhaseIndex,
      lastTouchedAt: now,
      nextCheckAt: input.nextCheckAt,
      needsUser: input.needsUser ?? false,
      needsUserReason: input.needsUserReason,
      blockers: input.blockers ?? [],
      links: input.links ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.initiatives.set(initiative.id, initiative);
    if (this.isTaskFlowEnabled()) {
      return await this.persistThroughTaskFlow(initiative);
    }
    this.saveToDisk();
    return initiative;
  }

  async update(id: string, input: InitiativeUpdateInput): Promise<Initiative> {
    const existing = this.get(id);
    if (!existing) throw new Error(`Initiative "${id}" not found`);
    const now = new Date().toISOString();
    const next: Initiative = { ...existing, updatedAt: now, lastTouchedAt: now };
    if (input.title !== undefined) next.title = input.title;
    if (input.description !== undefined) next.description = input.description;
    if (input.status !== undefined) next.status = input.status;
    if (input.nextCheckAt !== undefined) {
      next.nextCheckAt = input.nextCheckAt === null ? undefined : input.nextCheckAt;
    }
    if (input.needsUser !== undefined) next.needsUser = input.needsUser;
    if (input.needsUserReason !== undefined) {
      next.needsUserReason = input.needsUserReason === null ? undefined : input.needsUserReason;
    }
    if (input.blockers !== undefined) next.blockers = input.blockers;
    if (input.links !== undefined) next.links = input.links;
    this.initiatives.set(id, next);
    if (this.isTaskFlowEnabled()) {
      return await this.persistThroughTaskFlow(next);
    }
    this.saveToDisk();
    return next;
  }

  async setPhaseStatus(
    id: string,
    phaseId: string,
    status: InitiativePhaseStatus
  ): Promise<Initiative> {
    const existing = this.get(id);
    if (!existing) throw new Error(`Initiative "${id}" not found`);
    const phases = existing.phases.map((p) => ({ ...p }));
    const phase = phases.find((p) => p.id === phaseId);
    if (!phase) throw new Error(`Phase "${phaseId}" not found in "${id}"`);
    const now = new Date().toISOString();
    phase.status = status;
    if (status === 'in-progress' && !phase.startedAt) phase.startedAt = now;
    if (status === 'done' && !phase.completedAt) phase.completedAt = now;
    const firstOpen = phases.findIndex((p) => p.status !== 'done');
    const allDone = phases.every((p) => p.status === 'done');
    const next: Initiative = {
      ...existing,
      phases,
      currentPhaseIndex: firstOpen === -1 ? phases.length - 1 : firstOpen,
      status: allDone ? 'completed' : existing.status === 'completed' ? 'active' : existing.status,
      updatedAt: now,
      lastTouchedAt: now,
    };
    this.initiatives.set(id, next);
    if (this.isTaskFlowEnabled()) {
      return await this.persistThroughTaskFlow(next);
    }
    this.saveToDisk();
    return next;
  }

  async remove(id: string): Promise<boolean> {
    if (this.isTaskFlowEnabled()) {
      const fid = this.findFlowIdForInitiative(id);
      if (!fid) {
        return this.initiatives.delete(id);
      }
      const registry = this.taskFlowRegistry!;
      const principal = this.taskFlowPrincipal();
      let flow = registry.getFlow(fid, { bypassCache: true });
      if (flow && principal && principal.scope === 'controller') {
        try {
          if (flow.status === 'queued') {
            const r = await registry.startStep({
              flowId: flow.flowId,
              expectedRevision: flow.revision,
              principal,
              currentStep: flow.currentStep ?? 'remove',
            });
            flow = r.flow;
          }
          if (flow.status === 'waiting' && flow.waitInstanceId) {
            const r = await registry.resumeFlow({
              flowId: flow.flowId,
              expectedRevision: flow.revision,
              principal,
              waitInstanceId: flow.waitInstanceId,
            });
            flow = r.flow;
          }
          // Stamp the tombstone marker into stateJson so subsequent reads
          // hide the initiative. Done before cancel because terminal flows
          // are immutable.
          const init = this.initiativeFromFlow(flow);
          if (flow.status === 'running' && init) {
            const tomb = await this.patchStateJson(
              flow,
              { initiative: init, _removed: true } as { initiative: Initiative }
            );
            flow = tomb;
          }
          if (
            flow.status !== 'succeeded' &&
            flow.status !== 'failed' &&
            flow.status !== 'cancelled' &&
            flow.status !== 'lost'
          ) {
            const cr = await registry.requestFlowCancel({
              flowId: flow.flowId,
              expectedRevision: flow.revision,
              requesterOrigin: { kind: 'system', id: 'InitiativeTracker' },
            });
            await registry.cancelFlow({
              flowId: flow.flowId,
              expectedRevision: cr.flow.revision,
              principal,
            });
          }
        } catch (err) {
          this.logTaskFlowError('remove', id, err);
        }
      }
      this.initiatives.delete(id);
      return true;
    }
    const removed = this.initiatives.delete(id);
    if (removed) this.saveToDisk();
    return removed;
  }

  /**
   * Scan active initiatives for anything actionable. Empty items[] means
   * "quiet day, don't spam the user."
   */
  digest(now: Date = new Date()): Digest {
    if (this.isTaskFlowEnabled()) this.refreshCacheFromTaskFlow();
    const items: DigestItem[] = [];
    const nowMs = now.getTime();
    for (const initiative of this.initiatives.values()) {
      if (initiative.status !== 'active') continue;

      if (initiative.needsUser) {
        items.push({
          initiativeId: initiative.id,
          title: initiative.title,
          reason: 'needs-user',
          detail: initiative.needsUserReason ?? 'Needs your decision.',
        });
        continue;
      }

      if (initiative.nextCheckAt) {
        const checkMs = Date.parse(initiative.nextCheckAt);
        if (Number.isFinite(checkMs) && checkMs <= nowMs) {
          items.push({
            initiativeId: initiative.id,
            title: initiative.title,
            reason: 'next-check-due',
            detail: `Check-in scheduled for ${initiative.nextCheckAt}.`,
          });
          continue;
        }
      }

      const current = initiative.phases[initiative.currentPhaseIndex];
      const previous = initiative.currentPhaseIndex > 0
        ? initiative.phases[initiative.currentPhaseIndex - 1]
        : undefined;
      if (previous?.status === 'done' && current?.status === 'pending') {
        items.push({
          initiativeId: initiative.id,
          title: initiative.title,
          reason: 'ready-to-advance',
          detail: `Phase "${previous.name}" done → "${current.name}" can start.`,
        });
        continue;
      }

      const lastMs = Date.parse(initiative.lastTouchedAt);
      if (Number.isFinite(lastMs) && nowMs - lastMs > STALE_THRESHOLD_MS) {
        const days = Math.floor((nowMs - lastMs) / (24 * 60 * 60 * 1000));
        items.push({
          initiativeId: initiative.id,
          title: initiative.title,
          reason: 'stale',
          detail: `No movement in ${days} days.`,
        });
      }
    }
    return { generatedAt: now.toISOString(), items };
  }
}
