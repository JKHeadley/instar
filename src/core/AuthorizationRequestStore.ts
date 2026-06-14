/**
 * AuthorizationRequestStore — the "agent proposes, operator approves" primitive.
 *
 * Spec: docs/specs/OPERATOR-AUTHORIZATION-REQUEST-SPEC.md (converged 2026-06-13).
 *
 * The agent (Bearer-auth) registers a STRUCTURED request; a pending request confers
 * ZERO authority (it is inert). The operator approves it with their dashboard PIN, and
 * ONLY then — inside the PIN-gated route — does the server execute the structured
 * proposal (issue the floor-action grant via the existing signed MandateStore path).
 *
 * Safety invariants this store upholds:
 *  - requester ≠ authorizer: the store never confers authority; `approve()` runs an
 *    INJECTED `execute` callback (the PIN-gated route wires it to MandateStore) — the
 *    store itself only manages request lifecycle + the atomic status transition.
 *  - display integrity: the store carries the STRUCTURED `proposal` (the only thing
 *    executed) + its content hash. The operator-facing text is rendered SERVER-SIDE
 *    from the proposal (see renderAuthorizationCard); agent free-text (`reason`) is
 *    carried but is never the authority headline.
 *  - TOCTOU: `proposalSha256` is fixed at create and re-verified at approve, so the
 *    proposal cannot be mutated between display and approval.
 *  - atomicity/idempotency: `approve` is serialized per-request and idempotent (a second
 *    approve of an already-approved request returns the same result, never a 2nd grant).
 *
 * File-based JSON store (no DB), mirroring MandateStore. Pure + injectable (now/genId)
 * so it unit-tests with fakes and never reaches the real clock in tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** The floor actions an agent MAY propose via this path. EXCLUDES 'grant-authority'
 *  (the meta-escalation stays manual-only — the Advanced mandate form). FD-8. */
export const PROPOSABLE_FLOOR_ACTIONS: readonly string[] = [
  'prod-deploy', 'money-movement', 'credential-access', 'destructive-data', 'external-send',
];

/** Human labels for the server-authored headline (FD / display-integrity rule). */
export const FLOOR_ACTION_LABELS: Record<string, string> = {
  'prod-deploy': 'deploy to production',
  'money-movement': 'move money',
  'credential-access': 'access credentials',
  'destructive-data': 'run a destructive data operation',
  'external-send': 'send an external message',
  'grant-authority': 'grant authority to others',
};

export const MIN_GRANT_DURATION_MS = 60_000;          // 1 minute
export const MAX_GRANT_DURATION_MS = 86_400_000;      // 24 hours (FD-7 human-supervision ceiling)
export const REQUEST_TTL_MS = 86_400_000;             // pending auto-expires after 24h (FD-7)
export const DEFAULT_PENDING_CAP_PER_AGENT = 10;      // FD-13
export const RESOLVED_RETENTION_MS = 2_592_000_000;   // prune resolved after 30d (FD-11)
export const REPROPOSE_COOLDOWN_MS = 3_600_000;       // 1h after a deny (FD-10)

export type AuthorizationRequestStatus =
  | 'pending' | 'approved' | 'denied' | 'expired' | 'withdrawn';

export interface UserFloorGrantProposal {
  floorAction: string;
  grantedToSlackUserId: string;
  durationMs: number;
}

export interface AuthorizationRequest {
  id: string;
  createdAt: string;
  createdByAgent: string;
  createdOnMachine: string;
  status: AuthorizationRequestStatus;
  kind: 'user-floor-grant';
  proposal: UserFloorGrantProposal;
  proposalSha256: string;
  reason?: string;
  requestExpiresAt: string;
  resolvedAt?: string;
  resolvedBy?: 'operator';
  resultMandateId?: string;
  denyReason?: string;
}

/** Deterministic, key-sorted serialization (matches MandateStore.stableStringify). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** Content-address a proposal (fixed at create, re-checked at approve — TOCTOU guard). */
export function hashProposal(p: UserFloorGrantProposal): string {
  return createHash('sha256').update(stableStringify(p)).digest('hex');
}

/** A plain-language duration for the server-authored headline. */
export function humanDuration(ms: number): string {
  if (ms % 3_600_000 === 0) { const h = ms / 3_600_000; return `${h} hour${h === 1 ? '' : 's'}`; }
  const m = Math.round(ms / 60_000);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/**
 * The SERVER-AUTHORED card the operator sees. Built ONLY from the structured proposal
 * + the trusted display name resolved upstream (never from agent free-text). The
 * `reason` is returned separately so the UI can render it as a clearly-secondary,
 * escaped line — never the headline. This is the display-integrity fix.
 */
export function renderAuthorizationCard(
  req: AuthorizationRequest,
  grantedToDisplay: string,
): { headline: string; reason?: string } {
  const action = FLOOR_ACTION_LABELS[req.proposal.floorAction] ?? req.proposal.floorAction;
  const who = grantedToDisplay || req.proposal.grantedToSlackUserId;
  const dur = humanDuration(req.proposal.durationMs);
  return {
    headline: `Let ${who} ${action} for ${dur}.`,
    ...(req.reason ? { reason: req.reason } : {}),
  };
}

export interface AuthorizationRequestStoreDeps {
  filePath: string;
  now?: () => number;
  genId?: () => string;
  pendingCapPerAgent?: number;
}

export interface CreateRequestInput {
  createdByAgent: string;
  createdOnMachine: string;
  proposal: UserFloorGrantProposal;
  reason?: string;
}

export type CreateResult =
  | { ok: true; request: AuthorizationRequest; deduped?: boolean }
  | { ok: false; status: number; error: string };

export type ApproveResult =
  | { ok: true; request: AuthorizationRequest; alreadyApproved?: boolean }
  | { ok: false; status: number; error: string };

export class AuthorizationRequestStore {
  private readonly d: AuthorizationRequestStoreDeps;
  private readonly cap: number;
  constructor(deps: AuthorizationRequestStoreDeps) {
    this.d = deps;
    this.cap = deps.pendingCapPerAgent ?? DEFAULT_PENDING_CAP_PER_AGENT;
  }

  private nowMs(): number { return this.d.now ? this.d.now() : Date.now(); }
  private nowIso(): string { return new Date(this.nowMs()).toISOString(); }

  private readAll(): AuthorizationRequest[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.filePath, 'utf8'));
      return Array.isArray(raw) ? (raw as AuthorizationRequest[]) : [];
    } catch { /* @silent-fallback-ok — file may not exist yet; empty store is the safe (no pending) state */ return []; }
  }

  private writeAll(list: AuthorizationRequest[]): void {
    fs.mkdirSync(path.dirname(this.d.filePath), { recursive: true });
    fs.writeFileSync(this.d.filePath, JSON.stringify(list, null, 2));
  }

  /** Lazily age out past-TTL pending requests on every read-modify path (also driven by an hourly sweep). */
  private ageExpired(list: AuthorizationRequest[]): { list: AuthorizationRequest[]; changed: boolean } {
    const now = this.nowMs();
    let changed = false;
    for (const r of list) {
      if (r.status === 'pending' && Date.parse(r.requestExpiresAt) <= now) {
        r.status = 'expired'; r.resolvedAt = new Date(now).toISOString(); changed = true;
      }
    }
    return { list, changed };
  }

  /** Validate + create a pending request. Confers no authority. Dedup + flood-capped. */
  create(input: CreateRequestInput): CreateResult {
    const p = input.proposal;
    if (!p || typeof p !== 'object') return { ok: false, status: 400, error: 'proposal is required' };
    if (!PROPOSABLE_FLOOR_ACTIONS.includes(p.floorAction)) {
      return { ok: false, status: 400, error: `floorAction must be one of: ${PROPOSABLE_FLOOR_ACTIONS.join(', ')}` };
    }
    if (typeof p.grantedToSlackUserId !== 'string' || !/^[UW][A-Z0-9]+$/.test(p.grantedToSlackUserId)) {
      return { ok: false, status: 400, error: 'grantedToSlackUserId must be a Slack user id (U… / W…)' };
    }
    if (typeof p.durationMs !== 'number' || !Number.isFinite(p.durationMs)
      || p.durationMs < MIN_GRANT_DURATION_MS || p.durationMs > MAX_GRANT_DURATION_MS) {
      return { ok: false, status: 400, error: `durationMs must be within [${MIN_GRANT_DURATION_MS}, ${MAX_GRANT_DURATION_MS}]` };
    }
    if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 280)) {
      return { ok: false, status: 400, error: 'reason must be a string ≤280 chars' };
    }
    // Strict: only the three structured proposal fields (no bounds in v1 — FD-15).
    const extra = Object.keys(p).filter((k) => !['floorAction', 'grantedToSlackUserId', 'durationMs'].includes(k));
    if (extra.length) return { ok: false, status: 400, error: `unknown proposal fields: ${extra.join(', ')}` };

    const cleanProposal: UserFloorGrantProposal = {
      floorAction: p.floorAction, grantedToSlackUserId: p.grantedToSlackUserId, durationMs: p.durationMs,
    };
    const sha = hashProposal(cleanProposal);
    const now = this.nowMs();

    const { list } = this.ageExpired(this.readAll());

    // Re-propose cooldown after a recent deny of the SAME (user, action) by the same agent (FD-10).
    const recentDeny = list.find((r) =>
      r.createdByAgent === input.createdByAgent && r.status === 'denied'
      && r.proposal.grantedToSlackUserId === cleanProposal.grantedToSlackUserId
      && r.proposal.floorAction === cleanProposal.floorAction
      && r.resolvedAt && (now - Date.parse(r.resolvedAt)) < REPROPOSE_COOLDOWN_MS);
    if (recentDeny) {
      return { ok: false, status: 429, error: 'recently-denied — wait before re-proposing this grant' };
    }

    // Dedup: an identical pending proposal from the same agent returns the existing id (FD-13).
    const dup = list.find((r) => r.status === 'pending' && r.createdByAgent === input.createdByAgent && r.proposalSha256 === sha);
    if (dup) { this.writeAll(list); return { ok: true, request: dup, deduped: true }; }

    // Per-agent pending cap (FD-13).
    const pendingForAgent = list.filter((r) => r.status === 'pending' && r.createdByAgent === input.createdByAgent).length;
    if (pendingForAgent >= this.cap) {
      this.writeAll(list);
      return { ok: false, status: 429, error: `too-many-pending (cap ${this.cap}) — resolve existing requests first` };
    }

    const id = this.d.genId ? this.d.genId() : `authreq-${Math.random().toString(36).slice(2, 10)}`;
    const request: AuthorizationRequest = {
      id,
      createdAt: new Date(now).toISOString(),
      createdByAgent: input.createdByAgent,
      createdOnMachine: input.createdOnMachine,
      status: 'pending',
      kind: 'user-floor-grant',
      proposal: cleanProposal,
      proposalSha256: sha,
      ...(input.reason ? { reason: input.reason } : {}),
      requestExpiresAt: new Date(now + REQUEST_TTL_MS).toISOString(),
    };
    list.push(request);
    this.writeAll(list);
    return { ok: true, request };
  }

  get(id: string): AuthorizationRequest | undefined {
    return this.readAll().find((r) => r.id === id);
  }

  list(status?: AuthorizationRequestStatus): AuthorizationRequest[] {
    const { list, changed } = this.ageExpired(this.readAll());
    if (changed) this.writeAll(list);
    return status ? list.filter((r) => r.status === status) : list;
  }

  /**
   * Approve a request — the ONLY authority-conferring path, and ONLY callable from the
   * PIN-gated route. `execute(proposal)` issues the carrier mandate + grant via MandateStore
   * and returns the resultMandateId; it runs AFTER the status + hash + (caller's) allowlist /
   * registry re-checks, and BEFORE the commit, so a thrown execute aborts cleanly (request
   * stays pending). Idempotent: re-approving an already-approved request returns its result.
   */
  approve(
    id: string,
    opts: { execute: (proposal: UserFloorGrantProposal) => string },
  ): ApproveResult {
    const { list } = this.ageExpired(this.readAll());
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return { ok: false, status: 404, error: 'request not found' };
    const r = list[idx];

    if (r.status === 'approved') { this.writeAll(list); return { ok: true, request: r, alreadyApproved: true }; }
    if (r.status !== 'pending') {
      this.writeAll(list);
      return { ok: false, status: 409, error: `request is ${r.status}` };
    }
    // TOCTOU: the proposal cannot have changed between display and approval.
    if (hashProposal(r.proposal) !== r.proposalSha256) {
      return { ok: false, status: 409, error: 'proposal-tampered' };
    }

    let resultMandateId: string;
    try {
      resultMandateId = opts.execute(r.proposal);
    } catch (e) {
      // execute failed (allowlist re-check / registry / carrier issue) — request stays pending.
      return { ok: false, status: 409, error: e instanceof Error ? e.message : 'approval execution failed' };
    }

    r.status = 'approved';
    r.resolvedAt = this.nowIso();
    r.resolvedBy = 'operator';
    r.resultMandateId = resultMandateId;
    list[idx] = r;
    this.writeAll(list);
    return { ok: true, request: r };
  }

  /** Operator declines — reason REQUIRED (FD-10). */
  deny(id: string, denyReason: string): ApproveResult {
    if (typeof denyReason !== 'string' || !denyReason.trim()) {
      return { ok: false, status: 400, error: 'denyReason is required' };
    }
    const { list } = this.ageExpired(this.readAll());
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return { ok: false, status: 404, error: 'request not found' };
    const r = list[idx];
    if (r.status === 'denied') { this.writeAll(list); return { ok: true, request: r }; }
    if (r.status !== 'pending') { this.writeAll(list); return { ok: false, status: 409, error: `request is ${r.status}` }; }
    r.status = 'denied'; r.resolvedAt = this.nowIso(); r.resolvedBy = 'operator'; r.denyReason = denyReason.trim();
    list[idx] = r; this.writeAll(list);
    return { ok: true, request: r };
  }

  /** The proposing agent withdraws its OWN still-pending request. Mutually exclusive with approve. */
  withdraw(id: string, byAgent: string): ApproveResult {
    const { list } = this.ageExpired(this.readAll());
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return { ok: false, status: 404, error: 'request not found' };
    const r = list[idx];
    if (r.createdByAgent !== byAgent) return { ok: false, status: 403, error: 'only the proposing agent may withdraw' };
    if (r.status === 'withdrawn') { this.writeAll(list); return { ok: true, request: r }; }
    if (r.status !== 'pending') { this.writeAll(list); return { ok: false, status: 409, error: `request is ${r.status}` }; }
    r.status = 'withdrawn'; r.resolvedAt = this.nowIso(); list[idx] = r; this.writeAll(list);
    return { ok: true, request: r };
  }

  /** Hourly sweep: age out past-TTL pending + prune resolved older than the retention window (FD-11). */
  sweep(): { expired: number; pruned: number } {
    const now = this.nowMs();
    const { list } = this.ageExpired(this.readAll());
    let expired = 0;
    for (const r of list) if (r.status === 'expired' && r.resolvedAt && Date.parse(r.resolvedAt) === now) expired++;
    const kept = list.filter((r) => {
      const resolved = r.status !== 'pending';
      if (!resolved) return true;
      const at = r.resolvedAt ? Date.parse(r.resolvedAt) : now;
      return (now - at) < RESOLVED_RETENTION_MS;
    });
    const pruned = list.length - kept.length;
    this.writeAll(kept);
    return { expired, pruned };
  }
}
