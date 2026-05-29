/**
 * CrossSessionCoordinator — light, advisory cross-session coordination signal.
 *
 * A single agent home can run MULTIPLE concurrent Claude Code sessions against
 * the same `.instar/` state. They are blind to each other. The damaging failure
 * (2026-05-28): one session built a fix while a second session "hit the safety
 * brake" — flipped a config flag and mass-withdrew ~19 commitments. Both reached
 * a correct local diagnosis; neither knew the other was acting durably.
 *
 * This is the LIGHT fix Justin approved (topic 15579): a shared, append-only
 * scratchpad of recent high-impact "structural actions" + voluntary "I'm about
 * to do X" intents. Any structural action surfaces *other recent* entries to the
 * actor as an advisory warning. It NEVER blocks and it NEVER mutates the target
 * state — it only records and surfaces. Spec: docs/specs/cross-session-coordination.md.
 *
 * Storage: `<stateDir>/state/cross-session-actions.json` (atomic temp+rename,
 * reload-per-op so concurrent server-process writes don't clobber). Audit:
 * `<stateDir>/logs/cross-session-events.jsonl`.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The kinds of action the coordinator tracks. */
export type CoordinationActionKind =
  | 'intent'              // voluntary "I'm about to do X" announcement
  | 'config-flag'         // a config-flag flip (auto-recorded at PATCH /config)
  | 'commitment-withdraw' // a commitment withdrawal (auto-recorded via event)
  | 'other';              // escape hatch for callers

export interface CoordinationAction {
  /** Stable id (`<kind>-<ts>-<seq>`). */
  id: string;
  kind: CoordinationActionKind;
  /** What was acted on — e.g. `monitoring.collaborationRedrive.enabled`, a commitment id, or a free-text area for intents. */
  target?: string;
  /** Optional value (e.g. the new flag value). */
  value?: unknown;
  /** Human reason / description ("building PR 495 fix for the redrive flood"). */
  reason?: string;
  /** Best-effort actor hint (topic id, session label). Often unknown — that's fine. */
  actor?: string;
  /** epoch ms. */
  ts: number;
}

export interface RecordInput {
  kind: CoordinationActionKind;
  target?: string;
  value?: unknown;
  reason?: string;
  actor?: string;
}

export interface RecordResult {
  recorded: boolean;
  id: string | null;
  /** Recent actions (within windowMs) by a DIFFERENT or UNKNOWN actor — the "another session may be active" signal. */
  concurrent: CoordinationAction[];
  /** Advisory, human-readable warning built from `concurrent`, or null when clear. */
  warning: string | null;
}

interface Store {
  version: number;
  actions: CoordinationAction[];
}

export interface CrossSessionCoordinatorOptions {
  stateDir: string;
  /** When false the coordinator records nothing and never warns (GET still works). Default true. */
  enabled?: boolean;
  /** Concurrency window — other actions newer than this count as "concurrent". Default 10 min. */
  windowMs?: number;
  /** Ledger retention — actions older than this are pruned on write. Default 60 min. */
  retentionMs?: number;
  /** Hard cap on stored actions (newest kept). Default 200. */
  maxActions?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ACTIONS = 200;

export class CrossSessionCoordinator {
  private readonly storePath: string;
  private readonly auditPath: string;
  private readonly enabled: boolean;
  private readonly windowMs: number;
  private readonly retentionMs: number;
  private readonly maxActions: number;
  private readonly now: () => number;
  private seq = 0;

  constructor(opts: CrossSessionCoordinatorOptions) {
    const stateRoot = path.join(opts.stateDir, 'state');
    this.storePath = path.join(stateRoot, 'cross-session-actions.json');
    this.auditPath = path.join(opts.stateDir, 'logs', 'cross-session-events.jsonl');
    this.enabled = opts.enabled !== false;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxActions = opts.maxActions ?? DEFAULT_MAX_ACTIONS;
    this.now = opts.now ?? Date.now;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Record an action and compute the advisory signal. Never throws — coordination
   * is advisory, so a persistence failure must not break the calling route.
   */
  record(input: RecordInput): RecordResult {
    if (!this.enabled) {
      return { recorded: false, id: null, concurrent: [], warning: null };
    }
    const now = this.now();
    const rec: CoordinationAction = {
      id: `${input.kind}-${now}-${this.seq++}`,
      kind: input.kind,
      target: input.target,
      value: input.value,
      reason: input.reason,
      actor: input.actor,
      ts: now,
    };

    let concurrent: CoordinationAction[] = [];
    try {
      const store = this.load();
      // Prune expired before evaluating + appending.
      store.actions = store.actions.filter((a) => now - a.ts <= this.retentionMs);
      // Concurrency = other recent actions by a DIFFERENT or UNKNOWN actor, not the literal same action.
      concurrent = store.actions.filter(
        (a) =>
          now - a.ts <= this.windowMs &&
          differentOrUnknownActor(a.actor, rec.actor) &&
          !sameAction(a, rec),
      );
      store.actions.push(rec);
      if (store.actions.length > this.maxActions) {
        store.actions = store.actions.slice(-this.maxActions);
      }
      store.version = (store.version ?? 0) + 1;
      this.save(store);
      this.audit(rec, concurrent.length);
    } catch {
      // @silent-fallback-ok — coordination is ADVISORY by contract: a persistence
      // failure must never break the calling route. We still return the computed
      // signal; a dropped ledger write only weakens a future advisory, never the
      // primary action.
    }

    return {
      recorded: true,
      id: rec.id,
      concurrent,
      warning: this.buildWarning(concurrent, rec),
    };
  }

  /** Voluntary "I'm about to do X" announcement. */
  recordIntent(activity: string, opts?: { actor?: string; area?: string }): RecordResult {
    return this.record({ kind: 'intent', reason: activity, target: opts?.area, actor: opts?.actor });
  }

  /** Recent actions for the GET endpoint / explicit pre-action checks (newest first). */
  getRecent(opts?: { windowMs?: number; limit?: number }): CoordinationAction[] {
    const now = this.now();
    const window = opts?.windowMs ?? this.retentionMs;
    let actions: CoordinationAction[];
    try {
      actions = this.load().actions;
    } catch {
      // @silent-fallback-ok — read-only inspection path; if the ledger can't be
      // read there is simply nothing recent to show. Advisory, never load-bearing.
      return [];
    }
    return actions
      .filter((a) => now - a.ts <= window)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, opts?.limit ?? 100);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private load(): Store {
    try {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as Store;
      if (!parsed || !Array.isArray(parsed.actions)) return { version: 0, actions: [] };
      return parsed;
    } catch {
      // @silent-fallback-ok — a missing/corrupt ledger file is the expected
      // first-run state, not a degradation: an empty ledger is the correct read.
      return { version: 0, actions: [] };
    }
  }

  private save(store: Store): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, this.storePath);
  }

  private audit(rec: CoordinationAction, concurrentCount: number): void {
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
      fs.appendFileSync(
        this.auditPath,
        JSON.stringify({ ...rec, concurrentCount, recordedAt: new Date(rec.ts).toISOString() }) + '\n',
      );
    } catch {
      // @silent-fallback-ok — the JSONL audit trail is observability, not control
      // flow; a failed append must not affect the recorded action or the response.
    }
  }

  private buildWarning(concurrent: CoordinationAction[], rec: CoordinationAction): string | null {
    if (concurrent.length === 0) return null;
    const now = rec.ts;
    const windowMin = Math.round(this.windowMs / 60000);
    const list = concurrent
      .slice(-3)
      .reverse()
      .map((a) => {
        const agoMin = Math.max(0, Math.round((now - a.ts) / 60000));
        const who = a.actor ? `actor ${a.actor}` : 'an unattributed session';
        const what = describeAction(a);
        return `${what} by ${who} ${agoMin}m ago`;
      })
      .join('; ');
    const mine = describeAction(rec);
    return (
      `⚠ Cross-session: ${concurrent.length} recent structural action(s) by another/unknown session ` +
      `in the last ${windowMin}m, alongside your ${mine}: ${list}. ` +
      `Another session may be active — confirm this is intended before proceeding ` +
      `(GET /coordination/recent for the full ledger).`
    );
  }
}

function differentOrUnknownActor(a: string | undefined, b: string | undefined): boolean {
  // Same known actor → not concurrent (don't warn a session about its own prior actions).
  // Any unknown on either side → treat as potentially different (include).
  if (a && b) return a !== b;
  return true;
}

function sameAction(a: CoordinationAction, b: CoordinationAction): boolean {
  // Intents are events ("I'm about to do X"), not states — every announcement is
  // distinct, so they are NEVER deduped (two sessions each announcing is exactly
  // the signal we want to surface). Dedupe applies only to state-flip kinds
  // (config-flag / commitment-withdraw / other), where two sessions writing the
  // identical kind+target+value really are the same write and shouldn't double-count.
  if (a.kind === 'intent' || b.kind === 'intent') return false;
  return a.kind === b.kind && a.target === b.target && stringifyValue(a.value) === stringifyValue(b.value);
}

function stringifyValue(v: unknown): string {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return String(v);
  }
}

function describeAction(a: CoordinationAction): string {
  switch (a.kind) {
    case 'intent':
      return `intent${a.reason ? ` "${truncate(a.reason, 80)}"` : ''}`;
    case 'config-flag':
      return `config flip ${a.target ?? '(unknown key)'}${a.value !== undefined ? `=${stringifyValue(a.value)}` : ''}`;
    case 'commitment-withdraw':
      return `commitment withdrawal${a.target ? ` (${a.target})` : ''}`;
    default:
      return `action ${a.kind}${a.target ? ` on ${a.target}` : ''}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
