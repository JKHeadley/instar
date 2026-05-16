/**
 * Dashboard Proposals routes — Tier-3 S-2 of the Self-Healing Remediator v2.
 *
 * Spec anchor: docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md
 *   §A10 — outstanding-proposal cap (≤ 3 visible at any time + queued behind).
 *   §A13 — Config + telemetry + dashboard taxonomy. Proposals is a sub-section
 *          of the existing Remediation tab. All four `/remediation/proposals*`
 *          routes require bearer auth + `X-Instar-Request: 1`. Redacted view
 *          by default; full `reason.full` field shown only at `collaborative`
 *          trust (matches v1's `/remediation/attempts` redaction rule).
 *   §A26 — Proposal dismiss requires `collaborative` trust + ≤ 10/hour
 *          per-principal rate-limit. Every dismiss is audit-logged with the
 *          principal identity (callers wire the audit-writer; this route
 *          emits structured events / route-level diagnostics only).
 *   §A48 — Path-limited proposal fetch shape (id-keyed JSON files under
 *          `.instar/remediation/proposals-<machineId>/<proposalId>.json`).
 *   §A57 Tier-3 — Dashboard Proposals sub-section + auth-gated routes.
 *
 * Routes:
 *   GET  /remediation/proposals             — list outstanding proposals
 *                                              (visible + queued).
 *   GET  /remediation/proposals/:id         — detail view of a proposal.
 *   POST /remediation/proposals/:id/dismiss — user dismisses (no promotion).
 *                                              Requires `collaborative` trust.
 *
 * Redaction rule: at less than `collaborative` trust, the response omits
 * `forensic.rawResponse` and any `sampleEvents[].reason.full` field. At
 * `collaborative` trust, both fields are included verbatim. The proposal
 * file on disk always carries redacted `reason.redacted` per S-1; this
 * route enforces redaction at the response boundary regardless of disk
 * shape, so a future migration adding `reason.full` does not silently
 * leak the field through.
 *
 * Reads proposals from every `proposals-<machineId>/` directory under
 * `<stateDir>/remediation/`. The store is per-machine (A14) but the
 * dashboard surfaces a fleet-wide list; merging happens here at the read
 * boundary. The `producingAgentId` field on each proposal disambiguates
 * cross-machine duplicates per §A60.
 *
 * Dismiss is implemented as a status-mutation in place (status: 'outstanding'
 * → 'dismissed'). The proposal is NOT deleted — auditability requires the
 * file to remain for post-hoc forensic review. The outstanding-3 cap
 * counts only `status === 'outstanding'` entries.
 */

import type { Express, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { TrustElevationSource } from '../../remediation/TrustElevationSource.js';

// ── Public types ─────────────────────────────────────────────────────

/**
 * Minimal proposal shape consumed by the route layer. Mirrors the persistence
 * shape S-1's NovelFailureReviewer writes (§A60 / §A26 / §A32). Additional
 * fields on disk are passed through untouched at `collaborative` trust and
 * filtered at lower trust by the redaction guard.
 */
export interface PersistedProposal {
  proposalId: string;
  clusterSignature?: string;
  occurrencesObserved?: number;
  processLifetimes?: number;
  sampleEvents?: Array<{
    subsystem?: string;
    errorCode?: string;
    reason?: { redacted?: string; full?: string };
    timestamp?: number;
  }>;
  llmSummary?: string;
  suggestedErrorCode?: string;
  hypothesis?: string;
  producingAgentId?: string;
  producingAgentSignature?: string;
  generatedAt?: number;
  status?: 'outstanding' | 'dismissed' | 'promoted';
  forensic?: {
    promptHash?: string;
    llmModel?: string;
    rawResponse?: string;
  };
  /** Set by the dashboard route when redaction is applied. */
  redactionApplied?: boolean;
  /** Source machine directory the proposal was loaded from. */
  sourceMachineDir?: string;
  [key: string]: unknown;
}

export interface RegisterRemediationProposalsRoutesOpts {
  app: Express;
  stateDir: string;
  trustSource: TrustElevationSource;
  /**
   * Optional clock override for deterministic rate-limit testing. Defaults to
   * `Date.now`.
   */
  now?: () => number;
  /**
   * Optional structured observability sink. Routes emit:
   *   - `remediation.dashboard.proposals-listed`
   *   - `remediation.dashboard.proposal-fetched`
   *   - `remediation.dashboard.proposal-dismissed`
   *   - `remediation.dashboard.dismiss-refused`
   * The sink MUST never throw; errors are swallowed by the caller.
   */
  onEvent?: (e: { event: string; payload?: Record<string, unknown> }) => void;
}

// ── Constants ────────────────────────────────────────────────────────

const PROPOSAL_DIR_PREFIX = 'proposals-';
const PROPOSAL_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const DISMISS_RATE_LIMIT_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────

function requireUserIntent(req: Request, res: Response): boolean {
  const header = String(req.header('x-instar-request') ?? '').trim();
  if (header !== '1') {
    res.status(400).json({
      error: 'X-Instar-Request: 1 header required (user-intent attestation)',
      reason: 'missing-user-intent',
    });
    return false;
  }
  return true;
}

function listProposalDirs(remediationDir: string): string[] {
  if (!fs.existsSync(remediationDir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(remediationDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (!name.startsWith(PROPOSAL_DIR_PREFIX)) continue;
    const abs = path.join(remediationDir, name);
    try {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) out.push(abs);
    } catch {
      // Skip unreadable entries.
    }
  }
  return out;
}

function readProposalsFromDir(dir: string): PersistedProposal[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: PersistedProposal[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const parsed = JSON.parse(raw) as PersistedProposal;
      if (parsed && typeof parsed === 'object' && typeof parsed.proposalId === 'string') {
        parsed.sourceMachineDir = path.basename(dir);
        out.push(parsed);
      }
    } catch {
      // Skip corrupt entries; A26 forensic copy lives in llm-raw-*.jsonl.
    }
  }
  return out;
}

function loadAllProposals(stateDir: string): PersistedProposal[] {
  const remediationDir = path.join(stateDir, 'remediation');
  const dirs = listProposalDirs(remediationDir);
  const all: PersistedProposal[] = [];
  for (const d of dirs) {
    all.push(...readProposalsFromDir(d));
  }
  // Sort oldest-first to make the visible-3 deterministic.
  all.sort((a, b) => (a.generatedAt ?? 0) - (b.generatedAt ?? 0));
  return all;
}

function findProposalById(
  stateDir: string,
  id: string,
): { proposal: PersistedProposal; filePath: string } | null {
  const remediationDir = path.join(stateDir, 'remediation');
  const dirs = listProposalDirs(remediationDir);
  for (const d of dirs) {
    const candidate = path.join(d, `${id}.json`);
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(raw) as PersistedProposal;
        if (parsed && typeof parsed === 'object' && parsed.proposalId === id) {
          parsed.sourceMachineDir = path.basename(d);
          return { proposal: parsed, filePath: candidate };
        }
      } catch {
        // Skip — treated as not-found.
      }
    }
  }
  return null;
}

/**
 * Apply the §A13 redaction rule: at less than `collaborative` trust, strip
 * `forensic.rawResponse` and any `sampleEvents[].reason.full` field. Returns
 * a defensive copy — the on-disk JSON is never mutated.
 */
function redactForViewer(
  proposal: PersistedProposal,
  hasCollaborative: boolean,
): PersistedProposal {
  if (hasCollaborative) {
    return { ...proposal, redactionApplied: false };
  }
  const copy: PersistedProposal = {
    ...proposal,
    redactionApplied: true,
  };
  if (Array.isArray(copy.sampleEvents)) {
    copy.sampleEvents = copy.sampleEvents.map((e) => {
      if (!e || !e.reason) return e;
      const { full: _omit, ...rest } = e.reason;
      return { ...e, reason: rest };
    });
  }
  if (copy.forensic && typeof copy.forensic === 'object') {
    const { rawResponse: _omit, ...rest } = copy.forensic;
    copy.forensic = rest;
  }
  return copy;
}

// ── Per-principal dismiss rate-limit ─────────────────────────────────

interface DismissBucket {
  timestamps: number[];
}

function makeDismissLimiter(now: () => number) {
  const buckets = new Map<string, DismissBucket>();
  return function check(principal: string): { allowed: boolean; retryAfterMs?: number } {
    const t = now();
    let bucket = buckets.get(principal);
    if (!bucket) {
      bucket = { timestamps: [] };
      buckets.set(principal, bucket);
    }
    // Drop expired timestamps.
    while (bucket.timestamps.length > 0 && bucket.timestamps[0] <= t - HOUR_MS) {
      bucket.timestamps.shift();
    }
    if (bucket.timestamps.length >= DISMISS_RATE_LIMIT_PER_HOUR) {
      return {
        allowed: false,
        retryAfterMs: bucket.timestamps[0] + HOUR_MS - t,
      };
    }
    bucket.timestamps.push(t);
    return { allowed: true };
  };
}

function principalKey(req: Request): string {
  // Bearer-only model: every authed call is the configured principal.
  // We still partition by IP for defence-in-depth against future
  // multi-principal expansion. `'auth'` fallback handles tests that mount
  // the routes without a real socket (supertest).
  return `${req.ip || req.socket?.remoteAddress || 'auth'}`;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Register the three Tier-3 S-2 Dashboard Proposals routes on the given
 * Express app. The routes assume bearer-auth middleware is already mounted
 * UPSTREAM of this registration — registration order is the caller's
 * responsibility.
 */
export function registerRemediationProposalsRoutes(
  opts: RegisterRemediationProposalsRoutesOpts,
): void {
  const { app, stateDir, trustSource } = opts;
  const now = opts.now ?? (() => Date.now());
  const emit = (event: string, payload?: Record<string, unknown>) => {
    try {
      opts.onEvent?.({ event, payload });
    } catch {
      // Observability MUST never throw (matches NovelFailureReviewer convention).
    }
  };
  const dismissLimiter = makeDismissLimiter(now);

  // GET /remediation/proposals — list (visible + queued).
  app.get('/remediation/proposals', (req: Request, res: Response) => {
    if (!requireUserIntent(req, res)) return;
    let proposals: PersistedProposal[] = [];
    try {
      proposals = loadAllProposals(stateDir);
    } catch (err) {
      // Missing proposals-<machineId>/ directory is handled by
      // loadAllProposals → returns []. Any other error is a 500.
      res.status(500).json({ error: (err as Error).message });
      return;
    }
    const hasCollaborative = trustSource.hasCollaborativeTrust();
    const outstanding = proposals.filter((p) => p.status === 'outstanding');
    const dismissed = proposals.filter((p) => p.status === 'dismissed');
    const promoted = proposals.filter((p) => p.status === 'promoted');
    // Visible-3 + queued behind (§A10).
    const visible = outstanding.slice(0, 3).map((p) => redactForViewer(p, hasCollaborative));
    const queued = outstanding.slice(3).map((p) => redactForViewer(p, hasCollaborative));
    emit('remediation.dashboard.proposals-listed', {
      visibleCount: visible.length,
      queuedCount: queued.length,
      dismissedCount: dismissed.length,
      promotedCount: promoted.length,
      hasCollaborativeTrust: hasCollaborative,
    });
    res.json({
      visible,
      queued,
      dismissed: dismissed.map((p) => redactForViewer(p, hasCollaborative)),
      promoted: promoted.map((p) => redactForViewer(p, hasCollaborative)),
      trust: { hasCollaborative },
    });
  });

  // GET /remediation/proposals/:id — detail.
  app.get('/remediation/proposals/:id', (req: Request, res: Response) => {
    if (!requireUserIntent(req, res)) return;
    const id = String(req.params.id ?? '');
    if (!PROPOSAL_ID_REGEX.test(id)) {
      res.status(400).json({ error: 'invalid proposalId format', reason: 'invalid-id' });
      return;
    }
    const found = findProposalById(stateDir, id);
    if (!found) {
      res.status(404).json({ error: 'proposal not found', proposalId: id });
      return;
    }
    const hasCollaborative = trustSource.hasCollaborativeTrust();
    const view = redactForViewer(found.proposal, hasCollaborative);
    emit('remediation.dashboard.proposal-fetched', {
      proposalId: id,
      hasCollaborativeTrust: hasCollaborative,
    });
    res.json({ proposal: view, trust: { hasCollaborative } });
  });

  // POST /remediation/proposals/:id/dismiss — collaborative-only (§A26).
  app.post('/remediation/proposals/:id/dismiss', (req: Request, res: Response) => {
    if (!requireUserIntent(req, res)) return;
    const id = String(req.params.id ?? '');
    if (!PROPOSAL_ID_REGEX.test(id)) {
      res.status(400).json({ error: 'invalid proposalId format', reason: 'invalid-id' });
      return;
    }
    if (!trustSource.hasCollaborativeTrust()) {
      emit('remediation.dashboard.dismiss-refused', {
        proposalId: id,
        reason: 'trust-level-below-collaborative',
      });
      res.status(403).json({
        error: 'dismiss requires collaborative trust',
        reason: 'trust-level-below-collaborative',
      });
      return;
    }
    const principal = principalKey(req);
    const rl = dismissLimiter(principal);
    if (!rl.allowed) {
      emit('remediation.dashboard.dismiss-refused', {
        proposalId: id,
        reason: 'rate-limited',
        principal,
      });
      res.status(429).json({
        error: `dismiss rate limit exceeded (max ${DISMISS_RATE_LIMIT_PER_HOUR}/hour per principal)`,
        retryAfterMs: rl.retryAfterMs,
        reason: 'rate-limited',
      });
      return;
    }
    const found = findProposalById(stateDir, id);
    if (!found) {
      res.status(404).json({ error: 'proposal not found', proposalId: id });
      return;
    }
    if (found.proposal.status === 'dismissed') {
      // Idempotent — second dismiss is a no-op, returns current state.
      res.json({ proposal: redactForViewer(found.proposal, true), dismissed: false, alreadyDismissed: true });
      return;
    }
    if (found.proposal.status === 'promoted') {
      res.status(409).json({
        error: 'cannot dismiss a promoted proposal',
        reason: 'already-promoted',
      });
      return;
    }
    const next: PersistedProposal = {
      ...found.proposal,
      status: 'dismissed',
    };
    try {
      fs.writeFileSync(found.filePath, JSON.stringify(next, null, 2), { mode: 0o600 });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
      return;
    }
    emit('remediation.dashboard.proposal-dismissed', {
      proposalId: id,
      principal,
    });
    res.json({ proposal: redactForViewer(next, true), dismissed: true });
  });
}
