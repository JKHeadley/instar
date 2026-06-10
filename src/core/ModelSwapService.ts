/**
 * ModelSwapService — §5.3 of docs/specs/FABLE-MODEL-ESCALATION-SPEC.md.
 *
 * The narrow, server-side mid-session model swap (Trigger #1 only). The
 * reconciler hook only SIGNALS — this service is the single authority that
 * performs a swap, and it verifies every swap with an independent oracle.
 *
 * Contract (each clause spec-cited):
 *  - `:name` resolves by EXACT match against the live session registry —
 *    never globbed, substring-matched, or concatenated into the tmux target
 *    (round-2 Security-N1). The only string ever sent to the pane is the
 *    server-derived `/model <validated-id>`.
 *  - The model id is derived server-side via the §5.1 resolver — NEVER
 *    accepted from the caller (Sec-F5).
 *  - Refuses protected sessions (authorization boundary) and sessions that
 *    are not idle-with-empty-input (round-2 Security-F6 live-input
 *    collision window).
 *  - Honors `enabled:false` / `dryRun:true`; dryRun evaluates every gate
 *    but acquires nothing and injects nothing.
 *  - Injects via tmux `send-keys -l --` + a SEPARATE Enter (SessionManager
 *    .sendInput — the same hardened primitive the input route uses).
 *  - **Canary read-back via an oracle independent of the Session.model
 *    field this swap would write** (round-3 Integration-NEW-1): the pane's
 *    own acknowledgment of the /model command, parsed to exclude the echo
 *    of our injected input. Only on a confirmed match is Session.model
 *    updated. Unconfirmed ⇒ Session.model untouched, behaviourally default,
 *    ONE Attention item (round-1 Adversarial-H5 / Lessons-C3).
 *  - **Accounting fails toward counting** (round-2 Adversarial-NEW-2): the
 *    escalation is counted at injection, before the canary, once per
 *    (instance, transition) episode.
 *  - Server-side dwell guard: never swaps the same session twice within
 *    `minTierDwellMs` (§5.5 hysteresis backstop; suppressed flaps audited).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session } from './types.js';
import { IDLE_PROMPT_PATTERNS } from './SessionManager.js';
import {
  SWAP_CAPABILITY,
  resolveTierModel,
  type EscalationFramework,
  type EscalationTier,
  type TierEscalationConfig,
} from './ModelTierEscalation.js';
import type { AdmitResult, EscalationGovernor } from './EscalationGovernor.js';

/** The narrow SessionManager surface the swap service is allowed to touch. */
export interface SwapSessionFacade {
  listRunningSessions(): Session[];
  captureMeaningfulTail(tmuxSession: string, lines: number): string | null;
  sendInput(tmuxSession: string, input: string): boolean;
}

export interface AttentionItemLike {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
}

export interface ModelSwapServiceDeps {
  stateDir: string;
  sessions: SwapSessionFacade;
  /** Persist a mutated Session record (StateManager.saveSession). */
  saveSession: (session: Session) => void;
  protectedSessions: () => string[];
  getConfig: () => TierEscalationConfig;
  governor: Pick<EscalationGovernor, 'admitEscalation' | 'recordInjection'>;
  /** Raise an Attention item (TelegramAdapter.createAttentionItem). Optional —
   *  absence degrades to audit-only, never throws. */
  attention?: (item: AttentionItemLike) => unknown;
  /** Canary attempts/cadence — injectable for tests. */
  canaryAttempts?: number;
  canaryIntervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type SwapStatus =
  | 'swapped' // injected + canary-confirmed; Session.model updated
  | 'unconfirmed' // injected, canary did NOT confirm; Session.model untouched
  | 'dry-run' // every gate evaluated; nothing injected
  | 'noop' // nothing to do (no model configured / already on tier)
  | 'refused'; // a gate refused — session stays on its current model

export interface SwapResult {
  status: SwapStatus;
  reason?: string;
  /** The server-derived target model id (when one resolved). */
  model?: string;
  /** True only when the independent oracle confirmed the live model. */
  confirmed?: boolean;
}

/**
 * Does the pane tail show a prompt-ready idle state WITH an empty input
 * line? Fail-closed: anything ambiguous returns false and the swap is
 * refused as retryable (round-2 Security-F6).
 */
export function paneIdleWithEmptyInput(tail: string | null): boolean {
  if (!tail) return false;
  const idle = IDLE_PROMPT_PATTERNS.some(p => tail.includes(p));
  if (!idle) return false;
  // Empty input line: a prompt row with nothing typed after `>` — bare, or
  // showing only the CLI's own placeholder hint (`Try "…`).
  const lines = tail.split('\n');
  return lines.some(line => {
    const stripped = line.replace(/[│|]/g, ' ').trim();
    if (stripped === '>') return true;
    if (/^>\s*Try "/.test(stripped)) return true;
    return false;
  });
}

/**
 * Independent-oracle parse (§5.3 canary): does the pane acknowledge that
 * the model is now `modelId`, on a line that is NOT the echo of our own
 * injected `/model …` input? The CLI prints an acknowledgment of the form
 * "Set model to <id> …" — we require the acknowledgment verb AND the exact
 * id on a non-echo line. Conservative by design: an unrecognized format
 * reads as NOT confirmed (the spec's honest-degrade direction).
 */
export function paneConfirmsModel(tail: string | null, modelId: string): boolean {
  if (!tail) return false;
  const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ack = new RegExp(`set model to[^\\n]*\\b${escaped}\\b`, 'i');
  return tail.split('\n').some(line => {
    if (line.includes('/model')) return false; // echo of our injected input
    return ack.test(line);
  });
}

export class ModelSwapService {
  private readonly deps: ModelSwapServiceDeps;
  private readonly auditPath: string;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  /** In-memory per-session last-swap timestamps (dwell backstop). Reset on
   *  restart — the safe direction (a restart may swap immediately). */
  private readonly lastSwapAt = new Map<string, number>();

  constructor(deps: ModelSwapServiceDeps) {
    this.deps = deps;
    this.auditPath = path.join(deps.stateDir, 'state', 'model-tier-escalation', 'audit.jsonl');
    this.now = deps.now ?? (() => Date.now());
    this.wait = deps.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /**
   * Swap `name`'s session to `tier`. Body-validated upstream; this method
   * re-validates everything it relies on (defense in depth).
   */
  async swap(name: string, tier: EscalationTier): Promise<SwapResult> {
    const cfg = this.deps.getConfig();

    // Exact-match registry lookup — by Session.name first, then by the
    // registry's own tmuxSession value. Never partial, never globbed.
    const running = this.deps.sessions.listRunningSessions();
    const session =
      running.find(s => s.name === name) ?? running.find(s => s.tmuxSession === name);
    if (!session) {
      return this.refuse(name, tier, 'unknown-session');
    }

    const framework = (session.framework ?? 'claude-code') as EscalationFramework;
    if (SWAP_CAPABILITY[framework] !== 'mid-session') {
      // §5.6 — declared capability honored by code, not prose.
      return this.refuse(session.name, tier, 'launch-time-only-framework');
    }

    if (this.deps.protectedSessions().includes(session.tmuxSession)) {
      return this.refuse(session.name, tier, 'protected-session');
    }

    // Server-derived id — the caller can only ever name a TIER.
    const targetId = resolveTierModel(framework, tier, cfg, e =>
      this.audit({ type: 'resolve-rejected', ...e }),
    );
    if (targetId == null) {
      // Back-compat contract: no model configured ⇒ zero swaps, not an error.
      this.audit({ type: 'noop', session: session.name, tier, reason: 'no-model-configured' });
      return { status: 'noop', reason: 'no-model-configured' };
    }

    if (session.model === targetId) {
      return { status: 'noop', reason: 'already-on-tier', model: targetId, confirmed: true };
    }

    if (!cfg.enabled) {
      return this.refuse(session.name, tier, 'disabled');
    }

    // Dwell backstop (§5.5): never swap the same session twice within
    // minTierDwellMs. Suppressed flaps are audited.
    const last = this.lastSwapAt.get(session.id);
    if (last != null && this.now() - last < cfg.costGuards.minTierDwellMs) {
      this.audit({ type: 'flap-suppressed', session: session.name, tier, sinceLastSwapMs: this.now() - last });
      return { status: 'refused', reason: 'dwell' };
    }

    // Idle + empty input line (round-2 Security-F6) — fail closed.
    const tail = this.deps.sessions.captureMeaningfulTail(session.tmuxSession, 8);
    if (!paneIdleWithEmptyInput(tail)) {
      return this.refuse(session.name, tier, 'not-idle');
    }

    // §7/§8 cost gates — only escalations consume budget/lease; a swap back
    // to default is always cost-free (it REDUCES spend).
    const transition = `${session.model ?? 'default'}→${tier}`;
    let admit: AdmitResult = { allow: true };
    if (tier === 'escalated') {
      admit = this.deps.governor.admitEscalation({
        instanceId: session.id,
        accountId: session.subscriptionAccountId,
        modelId: targetId,
        transition,
        dry: cfg.dryRun,
      });
      if (!admit.allow) {
        return this.refuse(session.name, tier, `cost-guard:${admit.reason}`);
      }
    }

    if (cfg.dryRun) {
      this.audit({
        type: 'dry-run-would-swap',
        session: session.name,
        tier,
        model: targetId,
        freeWindow: admit.freeWindow,
      });
      return { status: 'dry-run', model: targetId };
    }

    // Inject: literal text + separate Enter via the hardened primitive. The
    // ONLY pane-bound string is the server-derived, enum-validated id.
    const sent = this.deps.sessions.sendInput(session.tmuxSession, `/model ${targetId}`);
    if (!sent) {
      return this.refuse(session.name, tier, 'inject-failed');
    }
    if (tier === 'escalated') {
      // Fails toward counting — recorded at injection, before the canary.
      this.deps.governor.recordInjection(session.id, transition);
    }
    this.audit({ type: 'injected', session: session.name, tier, model: targetId });

    // Canary read-back — independent oracle, N attempts.
    const attempts = this.deps.canaryAttempts ?? 5;
    const interval = this.deps.canaryIntervalMs ?? 600;
    for (let i = 0; i < attempts; i++) {
      await this.wait(interval);
      const readback = this.deps.sessions.captureMeaningfulTail(session.tmuxSession, 30);
      if (paneConfirmsModel(readback, targetId)) {
        session.model = targetId;
        try {
          this.deps.saveSession(session);
        } catch (err) {
          this.audit({ type: 'save-session-failed', session: session.name, error: (err as Error).message });
        }
        this.lastSwapAt.set(session.id, this.now());
        this.audit({ type: 'swap-confirmed', session: session.name, tier, model: targetId, attempts: i + 1 });
        return { status: 'swapped', model: targetId, confirmed: true };
      }
    }

    // NOT confirmed: do NOT mark reconciled, do NOT touch Session.model;
    // behaviourally the session is treated as default. One Attention item.
    this.lastSwapAt.set(session.id, this.now()); // still dwell — don't re-inject in a tight loop
    this.audit({ type: 'swap-unconfirmed', session: session.name, tier, model: targetId, attempts });
    try {
      this.deps.attention?.({
        id: `model-swap-unconfirmed-${session.id}-${tier}`,
        title: `Model swap unconfirmed: ${session.name}`,
        summary:
          `Injected /model ${targetId} into "${session.name}" but the independent ` +
          `read-back did not confirm within ${attempts} attempts. The session is ` +
          `treated as DEFAULT tier; the swap was still counted against the ` +
          `escalation budget (fails toward counting).`,
        category: 'model-tier-escalation',
        priority: 'NORMAL',
      });
    } catch {
      // attention surface unavailable — the audit record stands
    }
    return { status: 'unconfirmed', model: targetId, confirmed: false };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private refuse(sessionName: string, tier: EscalationTier, reason: string): SwapResult {
    this.audit({ type: 'refused', session: sessionName, tier, reason });
    return { status: 'refused', reason };
  }

  /** Structured-fields-only audit appender (Sec-F7) — same trail as the
   *  governor so one file tells the whole escalation story. */
  private audit(event: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
      fs.appendFileSync(
        this.auditPath,
        JSON.stringify({ ts: new Date(this.now()).toISOString(), source: 'model-swap', ...event }) + '\n',
      );
    } catch {
      // best-effort — never throws into the swap path
    }
  }
}
