/**
 * UndatedActionResurfacer — bounded reach for the evolution-action backlog.
 *
 * The existing overdue checker can only see actions with `dueBy`. This component
 * deliberately owns the complementary population: pending, high/critical actions
 * with no due date. It emits at most ONE Attention item per run and never mutates
 * the action itself.
 *
 * Durable state is an append-only event stream owned by one pool-agreed stable
 * machine. That owner may act only while it also holds the serving lease. A
 * `pending-emit` claim is written under an inter-process lock before Attention
 * delivery; overlapping
 * invocations therefore see the claim and select nothing. Delivery uses a stable
 * idempotency key, then appends `emitted`. A crash on either side is replayed,
 * bounded to three attempts, without silently losing the row.
 */
/* @self-action-controller: undated-action-resurfacer */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import lockfile from 'proper-lockfile';
import type { ActionItem } from '../core/types.js';

export interface UndatedActionAttention {
  id: string;
  title: string;
  summary: string;
  description: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext: string;
}

export interface UndatedActionResurfacerConfig {
  enabled: boolean;
  dryRun: boolean;
  runIntervalMs?: number;
  cooldownMs?: number;
  maxHighAgeMs?: number;
  maxRaises?: number;
  dispositionThreshold?: number;
  maxLedgerBytes?: number;
}

export interface UndatedActionResurfacerDeps {
  stateDir: string;
  listActions: () => ActionItem[];
  emitAttention: (item: UndatedActionAttention) => Promise<unknown>;
  holdsLease: () => boolean;
  /**
   * The cooldown ledger has one stable machine owner. On a multi-machine agent,
   * a serving-lease handoff must pause this controller unless the lease lands on
   * that owner; otherwise the new holder would start from an empty local ledger
   * and silently reset cooldown/raise-count state.
   */
  stateAuthority?: () => UndatedActionStateAuthority;
  recordMetric?: (outcome: 'fired' | 'noop' | 'error', verdictId?: string) => void;
  now?: () => number;
}

export interface UndatedActionStateAuthority {
  mode: 'single-machine' | 'stable-owner' | 'unconfigured';
  selfMachineId: string;
  ownerMachineId: string | null;
  ownsState: boolean;
  agreement?: 'single-machine' | 'pool-agreed' | 'missing' | 'disagreed';
  participantMachineIds?: string[];
  disagreeingMachineIds?: string[];
}

export interface UndatedActionOwnerAdvert {
  machineId: string;
  online: boolean;
  proposedOwnerMachineId?: string | null;
}

/**
 * A local config value is only a proposal. It becomes authority after every
 * registered pool member's latest authenticated advert carries the same value.
 * Missing or divergent adverts fail closed, which prevents two machines with
 * divergent local config from each treating their empty local ledger as canonical.
 */
export function resolveUndatedActionStateAuthority(
  selfMachineId: string,
  proposedOwnerMachineId: string | null | undefined,
  pool: UndatedActionOwnerAdvert[],
): UndatedActionStateAuthority {
  // Deliberately include offline registered peers. If each side of a partition
  // considered only its locally-online set, two divergent configs could each
  // declare a one-member "agreement." A last-known advert is safe for this
  // stable binding; a peer with no received advert keeps the feature paused.
  const participants = pool;
  const participantMachineIds = participants.map((machine) => machine.machineId).sort();
  const proposed = proposedOwnerMachineId?.trim() || null;
  const selfPresent = participants.some((machine) => machine.machineId === selfMachineId);
  const ownerKnown = proposed !== null && pool.some((machine) => machine.machineId === proposed);
  const missing = participants.filter((machine) => !machine.proposedOwnerMachineId).map((machine) => machine.machineId);
  const disagreed = proposed
    ? participants.filter((machine) => machine.proposedOwnerMachineId && machine.proposedOwnerMachineId !== proposed).map((machine) => machine.machineId)
    : [];
  if (!proposed || !selfPresent || !ownerKnown || missing.length > 0) {
    return {
      mode: 'unconfigured', selfMachineId, ownerMachineId: null, ownsState: false,
      agreement: 'missing', participantMachineIds,
      disagreeingMachineIds: [...new Set([...missing, ...(!selfPresent ? [selfMachineId] : [])])].sort(),
    };
  }
  if (disagreed.length > 0) {
    return {
      mode: 'unconfigured', selfMachineId, ownerMachineId: null, ownsState: false,
      agreement: 'disagreed', participantMachineIds, disagreeingMachineIds: disagreed.sort(),
    };
  }
  return {
    mode: 'stable-owner', selfMachineId, ownerMachineId: proposed,
    ownsState: selfMachineId === proposed,
    agreement: 'pool-agreed', participantMachineIds, disagreeingMachineIds: [],
  };
}

type ObservedAction = {
  status: ActionItem['status'];
  priority: ActionItem['priority'];
  dueBy: string | null;
  createdAt: string;
  contentSha256: string;
};

type LedgerEvent =
  | { type: 'run'; at: string; runIndex: number; dryRun: boolean; eligible: number; skippedCooldown: number; selectedActionId: string | null }
  | { type: 'pending-emit'; at: string; claimId: string; actionId: string; series: number; raiseCount: number; idempotencyKey: string; attempt: number; observed: ObservedAction }
  | { type: 'emit-attempt-failed'; at: string; claimId: string; attempt: number; error: string }
  | { type: 'emitted'; at: string; claimId: string }
  | { type: 'emit-failed'; at: string; claimId: string; attempts: number }
  | { type: 'claim-abandoned'; at: string; claimId: string; actionId: string; reason: 'missing' | 'left-pending' | 'dated' | 'priority-changed' | 'content-changed' }
  | { type: 'reset'; at: string; actionId: string; series: number; observed: ObservedAction }
  | { type: 'retired'; at: string; actionId: string; reason: 'left-pending' | 'dated' | 'missing' }
  | { type: 'disposition-set'; at: string; actionId: string }
  | { type: 'pending-disposition-alert'; at: string; claimId: string; idempotencyKey: string; count: number; attempt: number }
  | { type: 'disposition-alert-attempt-failed'; at: string; claimId: string; attempt: number; error: string }
  | { type: 'disposition-alert-emitted'; at: string; claimId: string; idempotencyKey: string; count: number }
  | { type: 'disposition-alert-failed'; at: string; claimId: string; attempts: number }
  | { type: 'outcome-observed'; at: string; actionId: string; claimId: string; statusAtRaise: ActionItem['status']; statusAt14d: ActionItem['status'] | 'missing' };

export interface UndatedActionProjection {
  actionId: string;
  series: number;
  firstRaisedAt: string | null;
  lastRaisedAt: string | null;
  lastEngagedAt: string | null;
  raiseCount: number;
  disposition: 'needs-disposition' | null;
  observed: ObservedAction | null;
  pendingClaim: Extract<LedgerEvent, { type: 'pending-emit' }> | null;
  failedClaim: boolean;
  retired: boolean;
  outcomeObservedClaims: Set<string>;
}

export interface UndatedActionRunResult {
  ran: boolean;
  reason?: 'disabled' | 'state-owner-unconfigured' | 'not-state-owner' | 'not-lease-holder' | 'authority-lost' | 'overlap' | 'cadence' | 'ledger-capacity' | 'ledger-confirm-failed' | 'no-eligible' | 'dry-run' | 'emitted' | 'emit-failed' | 'replayed' | 'disposition-alert';
  eligible: number;
  skippedCooldown: number;
  selectedActionId: string | null;
  wouldEmit?: UndatedActionAttention;
}

export interface UndatedActionResurfacerStatus {
  enabled: boolean;
  dryRun: boolean;
  operational: boolean;
  blockedReason: 'disabled' | 'state-owner-unconfigured' | 'not-state-owner' | 'not-lease-holder' | null;
  stateAuthority: UndatedActionStateAuthority;
  holdsLease: boolean;
  ledgerReadable: boolean;
  ledgerError: string | null;
  lastRunError: string | null;
  runIntervalMs: number;
  cooldownMs: number;
  totalRuns: number;
  lastRun: Extract<LedgerEvent, { type: 'run' }> | null;
  pendingClaims: number;
  failedClaims: number;
  abandonedClaims: number;
  pendingDispositionAlerts: number;
  failedDispositionAlerts: number;
  needsDisposition: number;
  raisedActions: number;
  outcomesObserved: number;
  outcomesByStatus: Record<string, number>;
  lastOutcome: Extract<LedgerEvent, { type: 'outcome-observed' }> | null;
  actionStates: Array<{
    actionId: string;
    firstRaisedAt: string | null;
    lastRaisedAt: string | null;
    ageAtFirstRaiseDays: number | null;
    raiseCount: number;
    disposition: UndatedActionProjection['disposition'];
    pendingClaim: boolean;
    failedClaim: boolean;
    retired: boolean;
    lastOutcomeStatus: ActionItem['status'] | 'missing' | null;
  }>;
  lastAttempt: { at: string; ran: boolean; reason: UndatedActionRunResult['reason'] | 'run-error' } | null;
  ledgerBytes: number;
  maxLedgerBytes: number;
  capacityExceeded: boolean;
}

const DEFAULT_INTERVAL_MS = 4 * 60 * 60_000;
const DEFAULT_COOLDOWN_MS = 14 * 24 * 60 * 60_000;
const DEFAULT_MAX_HIGH_AGE_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_RAISES = 3;
const DEFAULT_DISPOSITION_THRESHOLD = 10;
const DEFAULT_MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const LOCK_OPTIONS = { stale: 30_000, retries: { retries: 3, factor: 1, minTimeout: 20, maxTimeout: 50 } } as const;

function iso(ms: number): string { return new Date(ms).toISOString(); }

class LedgerCapacityError extends Error {
  constructor() { super('undated-action-resurfacer-ledger-capacity'); }
}

function actionContentSha(action: ActionItem): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify([action.title, action.description, action.commitTo ?? null, action.tags ?? []]))
    .digest('hex');
}

function observe(action: ActionItem): ObservedAction {
  return {
    status: action.status,
    // Runtime stores predate ActionItem's lowercase union. Preserve semantic
    // identity across legacy `urgent`/uppercase spellings instead of resetting
    // a raise series when only the representation changes.
    priority: eligiblePriority(action.priority) ?? action.priority,
    dueBy: action.dueBy ?? null,
    createdAt: action.createdAt,
    contentSha256: actionContentSha(action),
  };
}

function sameObserved(a: ObservedAction | null, b: ObservedAction): boolean {
  return !!a && a.status === b.status && a.priority === b.priority && a.dueBy === b.dueBy && a.createdAt === b.createdAt && a.contentSha256 === b.contentSha256;
}

/**
 * ActionItem's canonical type is lowercase critical/high, but durable stores
 * predate that contract and contain uppercase values plus the legacy top-tier
 * spelling `urgent`. Normalize at the runtime boundary so typed callers and
 * historical JSON rows share one eligibility rule.
 */
function eligiblePriority(priority: unknown): 'critical' | 'high' | null {
  if (typeof priority !== 'string') return null;
  const normalized = priority.trim().toLowerCase();
  if (normalized === 'urgent' || normalized === 'critical') return 'critical';
  if (normalized === 'high') return 'high';
  return null;
}

function emptyProjection(actionId: string): UndatedActionProjection {
  return {
    actionId,
    series: 1,
    firstRaisedAt: null,
    lastRaisedAt: null,
    lastEngagedAt: null,
    raiseCount: 0,
    disposition: null,
    observed: null,
    pendingClaim: null,
    failedClaim: false,
    retired: false,
    outcomeObservedClaims: new Set(),
  };
}

export function foldUndatedActionEvents(events: LedgerEvent[]): {
  runs: Array<Extract<LedgerEvent, { type: 'run' }>>;
  actions: Map<string, UndatedActionProjection>;
  lastDispositionAlertAt: string | null;
  pendingDispositionAlert: Extract<LedgerEvent, { type: 'pending-disposition-alert' }> | null;
} {
  const runs: Array<Extract<LedgerEvent, { type: 'run' }>> = [];
  const actions = new Map<string, UndatedActionProjection>();
  const claims = new Map<string, Extract<LedgerEvent, { type: 'pending-emit' }>>();
  let lastDispositionAlertAt: string | null = null;
  let pendingDispositionAlert: Extract<LedgerEvent, { type: 'pending-disposition-alert' }> | null = null;
  const get = (id: string): UndatedActionProjection => {
    const existing = actions.get(id);
    if (existing) return existing;
    const made = emptyProjection(id);
    actions.set(id, made);
    return made;
  };
  for (const event of events) {
    if (event.type === 'run') { runs.push(event); continue; }
    if (event.type === 'pending-disposition-alert') { pendingDispositionAlert = event; continue; }
    if (event.type === 'disposition-alert-emitted') {
      lastDispositionAlertAt = event.at;
      if (pendingDispositionAlert?.claimId === event.claimId) pendingDispositionAlert = null;
      continue;
    }
    if (event.type === 'disposition-alert-failed') {
      // A terminal transport failure must consume the aggregate alert's cooldown
      // just like a successful delivery. Otherwise clearing the pending claim
      // makes the same unchanged aggregate immediately eligible for a fresh
      // three-attempt claim, turning a bounded retry into an endless loop.
      lastDispositionAlertAt = event.at;
      if (pendingDispositionAlert?.claimId === event.claimId) pendingDispositionAlert = null;
      continue;
    }
    if (event.type === 'disposition-alert-attempt-failed') continue;
    if (event.type === 'pending-emit') {
      const p = get(event.actionId);
      p.pendingClaim = event;
      p.failedClaim = false;
      p.observed = event.observed;
      p.retired = false;
      claims.set(event.claimId, event);
      continue;
    }
    if (event.type === 'reset') {
      const p = get(event.actionId);
      p.series = event.series;
      p.firstRaisedAt = null;
      p.lastRaisedAt = null;
      p.lastEngagedAt = event.at;
      p.raiseCount = 0;
      p.disposition = null;
      p.observed = event.observed;
      p.pendingClaim = null;
      p.failedClaim = false;
      p.retired = false;
      continue;
    }
    if (event.type === 'retired') {
      const p = get(event.actionId);
      p.retired = true;
      p.pendingClaim = null;
      continue;
    }
    if (event.type === 'disposition-set') {
      get(event.actionId).disposition = 'needs-disposition';
      continue;
    }
    if (event.type === 'outcome-observed') {
      get(event.actionId).outcomeObservedClaims.add(event.claimId);
      continue;
    }
    if (event.type === 'claim-abandoned') {
      const p = get(event.actionId);
      if (p.pendingClaim?.claimId === event.claimId) p.pendingClaim = null;
      continue;
    }
    const claim = claims.get(event.claimId);
    if (!claim) continue;
    const p = get(claim.actionId);
    if (event.type === 'emitted') {
      p.pendingClaim = null;
      p.failedClaim = false;
      p.firstRaisedAt ??= event.at;
      p.lastRaisedAt = event.at;
      p.lastEngagedAt = event.at;
      p.raiseCount = Math.max(p.raiseCount, claim.raiseCount);
      p.observed = claim.observed;
    } else if (event.type === 'emit-failed') {
      p.pendingClaim = null;
      p.failedClaim = true;
    }
  }
  return { runs, actions, lastDispositionAlertAt, pendingDispositionAlert };
}

export function selectUndatedAction(
  actions: ActionItem[],
  projections: Map<string, UndatedActionProjection>,
  runIndex: number,
  nowMs: number,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  maxHighAgeMs = DEFAULT_MAX_HIGH_AGE_MS,
): { selected: ActionItem | null; eligible: number; skippedCooldown: number } {
  let skippedCooldown = 0;
  const eligible: ActionItem[] = [];
  for (const action of actions) {
    if (action.status !== 'pending' || action.dueBy || !eligiblePriority(action.priority)) continue;
    const p = projections.get(action.id);
    if (p?.pendingClaim || p?.failedClaim || p?.disposition === 'needs-disposition') continue;
    const anchor = p?.lastEngagedAt ? Date.parse(p.lastEngagedAt) : 0;
    if (anchor && nowMs - anchor < cooldownMs) { skippedCooldown += 1; continue; }
    eligible.push(action);
  }
  const lane = runIndex % 4 === 0 ? 'high' : 'critical';
  const isAgedHigh = (a: ActionItem) => eligiblePriority(a.priority) === 'high' && nowMs - Date.parse(a.createdAt) >= maxHighAgeMs;
  const critical = eligible.filter((a) => eligiblePriority(a.priority) === 'critical' || isAgedHigh(a));
  const high = eligible.filter((a) => eligiblePriority(a.priority) === 'high' && !isAgedHigh(a));
  const pool = lane === 'critical' ? (critical.length ? critical : high) : (high.length ? high : critical);
  pool.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  return { selected: pool[0] ?? null, eligible: eligible.length, skippedCooldown };
}

export class UndatedActionResurfacer {
  private readonly ledgerPath: string;
  private readonly lockTarget: string;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly cooldownMs: number;
  private readonly maxHighAgeMs: number;
  private readonly maxRaises: number;
  private readonly dispositionThreshold: number;
  private readonly maxLedgerBytes: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private lastLedgerError: string | null = null;
  private lastRunError: string | null = null;
  private capacityHit = false;
  private lastAttempt: UndatedActionResurfacerStatus['lastAttempt'] = null;

  constructor(private readonly config: UndatedActionResurfacerConfig, private readonly deps: UndatedActionResurfacerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.intervalMs = Math.max(60_000, config.runIntervalMs ?? DEFAULT_INTERVAL_MS);
    this.cooldownMs = Math.max(60_000, config.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.maxHighAgeMs = Math.max(60_000, config.maxHighAgeMs ?? DEFAULT_MAX_HIGH_AGE_MS);
    this.maxRaises = Math.max(1, config.maxRaises ?? DEFAULT_MAX_RAISES);
    this.dispositionThreshold = Math.max(1, config.dispositionThreshold ?? DEFAULT_DISPOSITION_THRESHOLD);
    this.maxLedgerBytes = Math.max(1_024, config.maxLedgerBytes ?? DEFAULT_MAX_LEDGER_BYTES);
    const dir = path.join(deps.stateDir, 'state');
    fs.mkdirSync(dir, { recursive: true });
    this.ledgerPath = path.join(dir, 'undated-action-resurfacer.jsonl');
    this.lockTarget = path.join(dir, 'undated-action-resurfacer.lock-target');
    if (!fs.existsSync(this.ledgerPath)) fs.writeFileSync(this.ledgerPath, '', { mode: 0o600 });
    if (!fs.existsSync(this.lockTarget)) fs.writeFileSync(this.lockTarget, '', { mode: 0o600 });
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    // @silent-fallback-ok: run() records lastRunError + error metrics before it
    // rejects; this boundary only prevents a background promise rejection.
    void this.run().catch(() => undefined);
    this.timer = setInterval(() => {
      // @silent-fallback-ok: same observable run-error boundary as startup;
      // the next bounded interval retries without crashing the server.
      void this.run().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private stateAuthority(): UndatedActionStateAuthority {
    try {
      return this.deps.stateAuthority?.() ?? {
        mode: 'single-machine',
        selfMachineId: 'single-machine',
        ownerMachineId: 'single-machine',
        ownsState: true,
      };
    } catch { // @silent-fallback-ok: authority-read uncertainty fails closed and is exposed as state-owner-unconfigured.
      return {
        mode: 'unconfigured',
        selfMachineId: 'unknown',
        ownerMachineId: null,
        ownsState: false,
      };
    }
  }

  private leaseHeld(): boolean {
    try { return this.deps.holdsLease(); } catch { return false; /* @silent-fallback-ok: lease-read uncertainty fails closed and status reports not-held. */ }
  }

  private authorityBlock(): 'state-owner-unconfigured' | 'not-state-owner' | 'not-lease-holder' | null {
    const authority = this.stateAuthority();
    if (authority.mode === 'unconfigured' || !authority.ownerMachineId) return 'state-owner-unconfigured';
    if (!authority.ownsState) return 'not-state-owner';
    if (!this.leaseHeld()) return 'not-lease-holder';
    return null;
  }

  private complete(result: UndatedActionRunResult): UndatedActionRunResult {
    this.lastRunError = null;
    this.lastAttempt = { at: iso(this.now()), ran: result.ran, reason: result.reason };
    return result;
  }

  private async withLedgerLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await lockfile.lock(this.lockTarget, LOCK_OPTIONS);
    try { return await fn(); } finally { await release(); }
  }

  private readEvents(): LedgerEvent[] {
    try {
      const text = fs.readFileSync(this.ledgerPath, 'utf8');
      const events: LedgerEvent[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        events.push(JSON.parse(line) as LedgerEvent);
      }
      this.lastLedgerError = null;
      return events;
    } catch (err) { // @silent-fallback-ok: ledger-read failure is recorded, rethrown, and exposed by the run boundary.
      this.lastLedgerError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private append(event: LedgerEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    if (fs.statSync(this.ledgerPath).size + Buffer.byteLength(line, 'utf8') > this.maxLedgerBytes) {
      this.capacityHit = true;
      throw new LedgerCapacityError();
    }
    fs.appendFileSync(this.ledgerPath, line, { encoding: 'utf8', mode: 0o600 });
  }

  private capacityAlert(): UndatedActionAttention {
    return {
      id: 'undated-actions:ledger-capacity',
      title: 'Undated-action resurfacing paused at its storage ceiling',
      summary: 'The bounded resurfacing ledger reached its byte ceiling, so the component stopped before losing or corrupting actionable state.',
      description: 'Review and compact the undated-action resurfacing ledger before resuming this cadence. No action was mutated or silently dropped.',
      category: 'evolution-action-resurfacing',
      priority: 'HIGH',
      sourceContext: 'undated-action-resurfacer',
    };
  }

  private attentionFor(action: ActionItem, series: number, raiseCount: number): UndatedActionAttention {
    const ageDays = Math.max(0, Math.floor((this.now() - Date.parse(action.createdAt)) / 86_400_000));
    return {
      id: `resurface:${action.id}:s${series}:${raiseCount}`,
      title: `Undated action needs review: ${action.id}`,
      summary: `${action.id} has remained ${action.priority} and undated for ${ageDays} day${ageDays === 1 ? '' : 's'}: ${action.title}`,
      description: `Priority: ${action.priority}\nAge: ${ageDays} days\nAction: ${action.title}\n\nThis is informational. Work it, cancel it with a reason, give it a due date, or split it if it is too large to move.`,
      category: 'evolution-action-resurfacing',
      priority: eligiblePriority(action.priority) === 'critical' ? 'URGENT' : 'HIGH',
      sourceContext: 'undated-action-resurfacer',
    };
  }

  private async emitClaim(claim: Extract<LedgerEvent, { type: 'pending-emit' }>, action: ActionItem, replayed: boolean): Promise<UndatedActionRunResult> {
    if (this.authorityBlock() !== null) {
      this.deps.recordMetric?.('noop', action.id);
      return this.complete({ ran: false, reason: 'authority-lost', eligible: 1, skippedCooldown: 0, selectedActionId: action.id });
    }
    const item = { ...this.attentionFor(action, claim.series, claim.raiseCount), id: claim.idempotencyKey };
    try {
      await this.deps.emitAttention(item);
    } catch (err) {
      const attempt = claim.attempt;
      const at = iso(this.now());
      await this.withLedgerLock(() => {
        this.append({ type: 'emit-attempt-failed', at, claimId: claim.claimId, attempt, error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) });
        if (attempt >= 3) this.append({ type: 'emit-failed', at, claimId: claim.claimId, attempts: attempt });
      });
      this.deps.recordMetric?.('error', action.id);
      return this.complete({ ran: true, reason: 'emit-failed', eligible: 1, skippedCooldown: 0, selectedActionId: action.id });
    }
    try {
      const at = iso(this.now());
      await this.withLedgerLock(() => {
        this.append({ type: 'emitted', at, claimId: claim.claimId });
        if (claim.raiseCount >= this.maxRaises) this.append({ type: 'disposition-set', at, actionId: action.id });
      });
      this.deps.recordMetric?.('fired', action.id);
      return this.complete({ ran: true, reason: replayed ? 'replayed' : 'emitted', eligible: 1, skippedCooldown: 0, selectedActionId: action.id });
    } catch (err) {
      this.lastLedgerError = err instanceof Error ? err.message : String(err);
      this.deps.recordMetric?.('error', action.id);
      return this.complete({ ran: true, reason: 'ledger-confirm-failed', eligible: 1, skippedCooldown: 0, selectedActionId: action.id });
    }
  }

  private preparePendingReplay(events: LedgerEvent[], actions: ActionItem[]): {
    claim: Extract<LedgerEvent, { type: 'pending-emit' }>;
    action: ActionItem;
  } | null {
    const folded = foldUndatedActionEvents(events);
    const nowMs = this.now();
    for (const p of folded.actions.values()) {
      const claim = p.pendingClaim;
      if (!claim || nowMs - Date.parse(claim.at) < this.intervalMs) continue;
      const action = actions.find((a) => a.id === claim.actionId);
      if (!action) {
        this.append({ type: 'claim-abandoned', at: iso(nowMs), claimId: claim.claimId, actionId: claim.actionId, reason: 'missing' });
        this.append({ type: 'retired', at: iso(nowMs), actionId: claim.actionId, reason: 'missing' });
        continue;
      }
      if (action.status !== 'pending') {
        this.append({ type: 'claim-abandoned', at: iso(nowMs), claimId: claim.claimId, actionId: claim.actionId, reason: 'left-pending' });
        this.append({ type: 'retired', at: iso(nowMs), actionId: claim.actionId, reason: 'left-pending' });
        continue;
      }
      if (action.dueBy) {
        this.append({ type: 'claim-abandoned', at: iso(nowMs), claimId: claim.claimId, actionId: claim.actionId, reason: 'dated' });
        this.append({ type: 'retired', at: iso(nowMs), actionId: claim.actionId, reason: 'dated' });
        continue;
      }
      if (!eligiblePriority(action.priority)) {
        this.append({ type: 'claim-abandoned', at: iso(nowMs), claimId: claim.claimId, actionId: claim.actionId, reason: 'priority-changed' });
        this.append({ type: 'reset', at: iso(nowMs), actionId: claim.actionId, series: p.series + 1, observed: observe(action) });
        continue;
      }
      const current = observe(action);
      if (!sameObserved(claim.observed, current)) {
        this.append({ type: 'claim-abandoned', at: iso(nowMs), claimId: claim.claimId, actionId: claim.actionId, reason: 'content-changed' });
        this.append({ type: 'reset', at: iso(nowMs), actionId: claim.actionId, series: p.series + 1, observed: current });
        continue;
      }
      const failures = events.filter((e) => e.type === 'emit-attempt-failed' && e.claimId === claim.claimId).length;
      const retry = { ...claim, at: iso(nowMs), attempt: failures + 1 };
      this.append(retry);
      return { claim: retry, action };
    }
    return null;
  }

  private async emitDispositionClaim(
    claim: Extract<LedgerEvent, { type: 'pending-disposition-alert' }>,
    replayed: boolean,
  ): Promise<UndatedActionRunResult> {
    if (this.authorityBlock() !== null) {
      this.deps.recordMetric?.('noop', 'needs-disposition');
      return this.complete({ ran: false, reason: 'authority-lost', eligible: 0, skippedCooldown: 0, selectedActionId: null });
    }
    const alert = this.dispositionAlert(claim.count, claim.idempotencyKey);
    try {
      await this.deps.emitAttention(alert);
    } catch (err) { // @silent-fallback-ok: the transport failure is durably attempted, metered, and returned as emit-failed.
      await this.withLedgerLock(() => {
        this.append({
          type: 'disposition-alert-attempt-failed', at: iso(this.now()), claimId: claim.claimId,
          attempt: claim.attempt, error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        });
        if (claim.attempt >= 3) this.append({ type: 'disposition-alert-failed', at: iso(this.now()), claimId: claim.claimId, attempts: claim.attempt });
      });
      this.deps.recordMetric?.('error', 'needs-disposition');
      return this.complete({ ran: true, reason: 'emit-failed', eligible: 0, skippedCooldown: 0, selectedActionId: null });
    }
    try {
      await this.withLedgerLock(() => this.append({
        type: 'disposition-alert-emitted', at: iso(this.now()), claimId: claim.claimId,
        idempotencyKey: claim.idempotencyKey, count: claim.count,
      }));
      this.deps.recordMetric?.('fired', 'needs-disposition');
      return this.complete({ ran: true, reason: replayed ? 'replayed' : 'disposition-alert', eligible: 0, skippedCooldown: 0, selectedActionId: null });
    } catch (err) { // @silent-fallback-ok: the failed confirmation is exposed in status, metrics, and the returned result.
      this.lastLedgerError = err instanceof Error ? err.message : String(err);
      this.deps.recordMetric?.('error', 'needs-disposition');
      return this.complete({ ran: true, reason: 'ledger-confirm-failed', eligible: 0, skippedCooldown: 0, selectedActionId: null });
    }
  }

  private prepareDispositionReplay(events: LedgerEvent[]): Extract<LedgerEvent, { type: 'pending-disposition-alert' }> | null {
    const pending = foldUndatedActionEvents(events).pendingDispositionAlert;
    if (!pending || this.now() - Date.parse(pending.at) < this.intervalMs) return null;
    const failures = events.filter((e) => e.type === 'disposition-alert-attempt-failed' && e.claimId === pending.claimId).length;
    const retry = { ...pending, at: iso(this.now()), attempt: failures + 1 };
    this.append(retry);
    return retry;
  }

  private reconcile(events: LedgerEvent[], actions: ActionItem[]): void {
    const folded = foldUndatedActionEvents(events);
    const byId = new Map(actions.map((a) => [a.id, a]));
    const nowMs = this.now();
    // Observe EACH confirmed delivery claim independently of the current action
    // projection. A later content reset is a new delivery series, but it must not
    // erase the already-scheduled outcome sample for a prior emitted claim.
    const claims = new Map<string, Extract<LedgerEvent, { type: 'pending-emit' }>>();
    for (const event of events) if (event.type === 'pending-emit') claims.set(event.claimId, event);
    const observedClaims = new Set(
      events.filter((event): event is Extract<LedgerEvent, { type: 'outcome-observed' }> => event.type === 'outcome-observed')
        .map((event) => event.claimId),
    );
    for (const event of events) {
      if (event.type !== 'emitted' || observedClaims.has(event.claimId)) continue;
      if (nowMs - Date.parse(event.at) < this.cooldownMs) continue;
      const claim = claims.get(event.claimId);
      if (!claim) continue;
      this.append({
        type: 'outcome-observed', at: iso(nowMs), actionId: claim.actionId,
        claimId: claim.claimId, statusAtRaise: claim.observed.status,
        statusAt14d: byId.get(claim.actionId)?.status ?? 'missing',
      });
      observedClaims.add(event.claimId);
    }
    for (const [id, p] of folded.actions) {
      if (p.pendingClaim) continue;
      const action = byId.get(id);
      // Retirement removes the row from resurfacing, but not from delayed
      // outcome observation. A row completed or dated before the observation
      // window must still produce statusAt+14d when that window arrives.
      if (p.retired) continue;
      if (!action) { this.append({ type: 'retired', at: iso(nowMs), actionId: id, reason: 'missing' }); continue; }
      if (action.status !== 'pending') { this.append({ type: 'retired', at: iso(nowMs), actionId: id, reason: 'left-pending' }); continue; }
      if (action.dueBy) { this.append({ type: 'retired', at: iso(nowMs), actionId: id, reason: 'dated' }); continue; }
      const current = observe(action);
      if (p.observed && !sameObserved(p.observed, current)) this.append({ type: 'reset', at: iso(nowMs), actionId: id, series: p.series + 1, observed: current });
    }
  }

  private dispositionAlert(count: number, id = `undated-actions:needs-disposition:${Math.floor(this.now() / this.cooldownMs)}`): UndatedActionAttention {
    return {
      id,
      title: 'Undated actions need disposition',
      summary: `${count} undated high-priority actions have been resurfaced three times without meaningful movement.`,
      description: 'These rows now need an explicit disposition: work, cancel with a reason, assign a due date, or split the action.',
      category: 'evolution-action-resurfacing',
      priority: 'HIGH',
      sourceContext: 'undated-action-resurfacer',
    };
  }

  async run(): Promise<UndatedActionRunResult> {
    if (!this.config.enabled) return this.complete({ ran: false, reason: 'disabled', eligible: 0, skippedCooldown: 0, selectedActionId: null });
    const blocked = this.authorityBlock();
    if (blocked) return this.complete({ ran: false, reason: blocked, eligible: 0, skippedCooldown: 0, selectedActionId: null });
    if (this.inFlight) return this.complete({ ran: false, reason: 'overlap', eligible: 0, skippedCooldown: 0, selectedActionId: null });
    this.inFlight = true;
    try {
      const actions = this.deps.listActions();
      const prepared = await this.withLedgerLock(() => {
        let events = this.readEvents();
        this.reconcile(events, actions);
        events = this.readEvents();

        const actionReplay = this.preparePendingReplay(events, actions);
        if (actionReplay) return { kind: 'action' as const, ...actionReplay, replayed: true };
        events = this.readEvents();
        const dispositionReplay = this.prepareDispositionReplay(events);
        if (dispositionReplay) return { kind: 'disposition' as const, claim: dispositionReplay, replayed: true };
        events = this.readEvents();

        const folded = foldUndatedActionEvents(events);
        const lastRunAt = folded.runs.at(-1)?.at;
        if (lastRunAt && this.now() - Date.parse(lastRunAt) < this.intervalMs) {
          this.deps.recordMetric?.('noop');
          return { kind: 'result' as const, result: this.complete({ ran: false, reason: 'cadence', eligible: 0, skippedCooldown: 0, selectedActionId: null }) };
        }
        const needsDisposition = [...folded.actions.values()].filter((p) => p.disposition === 'needs-disposition' && !p.retired).length;
        const alertDue = !folded.pendingDispositionAlert
          && needsDisposition > this.dispositionThreshold
          && (!folded.lastDispositionAlertAt || this.now() - Date.parse(folded.lastDispositionAlertAt) >= this.cooldownMs);
        if (alertDue) {
          const alert = this.dispositionAlert(needsDisposition);
          const runIndex = folded.runs.length + 1;
          this.append({ type: 'run', at: iso(this.now()), runIndex, dryRun: this.config.dryRun, eligible: 0, skippedCooldown: 0, selectedActionId: null });
          if (this.config.dryRun) {
            this.deps.recordMetric?.('noop', 'needs-disposition');
            return { kind: 'result' as const, result: this.complete({ ran: true, reason: 'dry-run', eligible: 0, skippedCooldown: 0, selectedActionId: null, wouldEmit: alert }) };
          }
          const claim: Extract<LedgerEvent, { type: 'pending-disposition-alert' }> = {
            type: 'pending-disposition-alert', at: iso(this.now()), claimId: crypto.randomUUID(),
            idempotencyKey: alert.id, count: needsDisposition, attempt: 1,
          };
          this.append(claim);
          return { kind: 'disposition' as const, claim, replayed: false };
        }
        const runIndex = folded.runs.length + 1;
        const pick = selectUndatedAction(actions, folded.actions, runIndex, this.now(), this.cooldownMs, this.maxHighAgeMs);
        const selected = pick.selected;
        const eligible = pick.eligible;
        const skippedCooldown = pick.skippedCooldown;
        this.append({ type: 'run', at: iso(this.now()), runIndex, dryRun: this.config.dryRun, eligible, skippedCooldown, selectedActionId: selected?.id ?? null });
        if (!selected) {
          this.deps.recordMetric?.('noop');
          return { kind: 'result' as const, result: this.complete({ ran: true, reason: 'no-eligible', eligible, skippedCooldown, selectedActionId: null }) };
        }
        const p = folded.actions.get(selected.id);
        const series = p?.series ?? 1;
        const raiseCount = (p?.raiseCount ?? 0) + 1;
        const wouldEmit = this.attentionFor(selected, series, raiseCount);
        if (this.config.dryRun) {
          this.deps.recordMetric?.('noop', selected.id);
          return { kind: 'result' as const, result: this.complete({ ran: true, reason: 'dry-run', eligible, skippedCooldown, selectedActionId: selected.id, wouldEmit }) };
        }
        const claim: Extract<LedgerEvent, { type: 'pending-emit' }> = {
          type: 'pending-emit',
          at: iso(this.now()),
          claimId: crypto.randomUUID(),
          actionId: selected.id,
          series,
          raiseCount,
          idempotencyKey: wouldEmit.id,
          attempt: 1,
          observed: observe(selected),
        };
        this.append(claim);
        return { kind: 'action' as const, claim, action: selected, replayed: false };
      });

      if (prepared.kind === 'result') return prepared.result;
      if (prepared.kind === 'disposition') return this.emitDispositionClaim(prepared.claim, prepared.replayed);
      return this.emitClaim(prepared.claim, prepared.action, prepared.replayed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastLedgerError = message;
      this.deps.recordMetric?.('error');
      if (err instanceof LedgerCapacityError) {
        if (this.authorityBlock() === null) {
          try { await this.deps.emitAttention(this.capacityAlert()); } catch { /* stable Attention id dedupes retries once delivery recovers */ }
        }
        return this.complete({ ran: false, reason: 'ledger-capacity', eligible: 0, skippedCooldown: 0, selectedActionId: null });
      }
      this.lastRunError = message;
      this.lastAttempt = { at: iso(this.now()), ran: false, reason: 'run-error' };
      throw err;
    } finally {
      this.inFlight = false;
    }
  }

  status(): UndatedActionResurfacerStatus {
    const stateAuthority = this.stateAuthority();
    const holdsLease = this.leaseHeld();
    const blockedReason = !this.config.enabled ? 'disabled' : this.authorityBlock();
    try {
      const events = this.readEvents();
      const folded = foldUndatedActionEvents(events);
      const ledgerBytes = fs.statSync(this.ledgerPath).size;
      const capacityExceeded = this.capacityHit || ledgerBytes >= this.maxLedgerBytes;
      const outcomes = events.filter((event): event is Extract<LedgerEvent, { type: 'outcome-observed' }> => event.type === 'outcome-observed');
      const outcomesByStatus: Record<string, number> = {};
      for (const outcome of outcomes) outcomesByStatus[outcome.statusAt14d] = (outcomesByStatus[outcome.statusAt14d] ?? 0) + 1;
      const lastOutcomeByAction = new Map<string, Extract<LedgerEvent, { type: 'outcome-observed' }>>();
      for (const outcome of outcomes) lastOutcomeByAction.set(outcome.actionId, outcome);
      const actionStates = [...folded.actions.values()]
        .map((projection) => {
          const createdAt = projection.observed?.createdAt ? Date.parse(projection.observed.createdAt) : Number.NaN;
          const firstRaisedAt = projection.firstRaisedAt ? Date.parse(projection.firstRaisedAt) : Number.NaN;
          return {
            actionId: projection.actionId,
            firstRaisedAt: projection.firstRaisedAt,
            lastRaisedAt: projection.lastRaisedAt,
            ageAtFirstRaiseDays: Number.isFinite(createdAt) && Number.isFinite(firstRaisedAt)
              ? Math.max(0, Math.floor((firstRaisedAt - createdAt) / 86_400_000))
              : null,
            raiseCount: projection.raiseCount,
            disposition: projection.disposition,
            pendingClaim: !!projection.pendingClaim,
            failedClaim: projection.failedClaim,
            retired: projection.retired,
            lastOutcomeStatus: lastOutcomeByAction.get(projection.actionId)?.statusAt14d ?? null,
          };
        })
        .sort((a, b) => a.actionId.localeCompare(b.actionId));
      return {
        enabled: this.config.enabled,
        dryRun: this.config.dryRun,
        operational: blockedReason === null && !capacityExceeded,
        blockedReason,
        stateAuthority,
        holdsLease,
        ledgerReadable: true,
        ledgerError: null,
        lastRunError: this.lastRunError,
        runIntervalMs: this.intervalMs,
        cooldownMs: this.cooldownMs,
        totalRuns: folded.runs.length,
        lastRun: folded.runs.at(-1) ?? null,
        pendingClaims: [...folded.actions.values()].filter((p) => !!p.pendingClaim).length,
        failedClaims: events.filter((event) => event.type === 'emit-failed').length,
        abandonedClaims: events.filter((event) => event.type === 'claim-abandoned').length,
        pendingDispositionAlerts: folded.pendingDispositionAlert ? 1 : 0,
        failedDispositionAlerts: events.filter((event) => event.type === 'disposition-alert-failed').length,
        needsDisposition: [...folded.actions.values()].filter((p) => p.disposition === 'needs-disposition' && !p.retired).length,
        raisedActions: [...folded.actions.values()].filter((p) => p.raiseCount > 0).length,
        outcomesObserved: outcomes.length,
        outcomesByStatus,
        lastOutcome: outcomes.at(-1) ?? null,
        actionStates,
        lastAttempt: this.lastAttempt,
        ledgerBytes,
        maxLedgerBytes: this.maxLedgerBytes,
        capacityExceeded,
      };
    } catch {
      return {
        enabled: this.config.enabled,
        dryRun: this.config.dryRun,
        operational: false,
        blockedReason,
        stateAuthority,
        holdsLease,
        ledgerReadable: false,
        ledgerError: this.lastLedgerError ?? 'ledger-unreadable',
        lastRunError: this.lastRunError,
        runIntervalMs: this.intervalMs,
        cooldownMs: this.cooldownMs,
        totalRuns: 0,
        lastRun: null,
        pendingClaims: 0,
        failedClaims: 0,
        abandonedClaims: 0,
        pendingDispositionAlerts: 0,
        failedDispositionAlerts: 0,
        needsDisposition: 0,
        raisedActions: 0,
        outcomesObserved: 0,
        outcomesByStatus: {},
        lastOutcome: null,
        actionStates: [],
        lastAttempt: this.lastAttempt,
        ledgerBytes: 0,
        maxLedgerBytes: this.maxLedgerBytes,
        capacityExceeded: this.capacityHit || this.lastLedgerError === 'undated-action-resurfacer-ledger-capacity',
      };
    }
  }
}
