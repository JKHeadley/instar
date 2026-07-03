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
 *    and a SILENT maturation-track audit breadcrumb — never an Attention
 *    item (TOPIC-PROFILE-SPEC §11/§14: the `maturing-feature-health-no-alerts`
 *    operator directive, 2026-06-10, superseding round-1 Adversarial-H5 /
 *    Lessons-C3's per-event item, which produced three "Model swap
 *    unconfirmed" Attention topics in one day).
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
  KNOWN_MODEL_IDS,
  MODEL_ID_RE,
  SWAP_CAPABILITY,
  escalatedModelIds,
  resolveTierModel,
  type EscalationFramework,
  type EscalationTier,
  type TierEscalationConfig,
} from './ModelTierEscalation.js';
import type { AdmitResult, EscalationGovernor } from './EscalationGovernor.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

/** The narrow SessionManager surface the swap service is allowed to touch. */
export interface SwapSessionFacade {
  listRunningSessions(): Session[];
  captureMeaningfulTail(tmuxSession: string, lines: number): string | null;
  sendInput(tmuxSession: string, input: string): boolean;
}

export interface ModelSwapServiceDeps {
  stateDir: string;
  sessions: SwapSessionFacade;
  /** Persist a mutated Session record (StateManager.saveSession). */
  saveSession: (session: Session) => void;
  protectedSessions: () => string[];
  getConfig: () => TierEscalationConfig;
  governor: Pick<EscalationGovernor, 'admitEscalation' | 'recordInjection'>;
  /**
   * TOPIC-PROFILE-SPEC §9 — the server-side pin consult. Given a session,
   * return the session's topic profile consult, or null when the session has
   * no bound topic / no pin. The consult runs on the AUTHORITY side (this
   * endpoint), never in the FABLE hook (its pure-filesystem contract holds):
   *  - `suppressEscalation`: the topic's `escalationOverride === 'suppress'`
   *    pin — an 'escalated' swap is REFUSED (the operator explicitly opted
   *    this topic out of the heavy-work ultra mandate). `inherit` pins never
   *    set this (the mandate keeps firing even on a pinned topic).
   *  - `baselineModel`: the topic's pinned BASELINE (explicit model or
   *    resolved tier pin) — a 'default' de-escalation lands HERE, never the
   *    global default (otherwise the swap-back silently drops the pin).
   *    Already clamped through the §10.2 closed enum by the resolver.
   * NOT gated by `topicProfiles.enabled` — honor-on-read covers the
   * escalation arm (§5.2(c): disabling the feature must not silently flip a
   * "never escalate this topic" into 2x-cost escalation).
   */
  topicProfileConsult?: (
    session: Session,
  ) => { suppressEscalation: boolean; baselineModel: string | null } | null;
  /**
   * swap-continuity-antithrash §4.2/Q5 — the SUBAGENT leg of the idle check.
   * A session at an idle prompt CAN carry live background subagents; the
   * pane-only check would swap under them (the F3 footer blind spot). Only
   * consulted when `getConfig().subagentIdleLeg === true` (concrete default
   * false — dark; spec §10 rung 3a). Returns the leg state:
   *  - 'active'        → live subagents ⇒ refuse (retryable, like not-idle)
   *  - 'idle'          → affirmatively no live subagents ⇒ proceed
   *  - 'absent'        → no claudeSessionId to probe (R5-M1: behaves like a
   *                      failed probe — refuse, never a blind swap)
   *  - 'indeterminate' → probe failed ⇒ refuse (fail-closed, Security-F6 shape)
   */
  subagentLegProbe?: (session: Session) => 'active' | 'idle' | 'absent' | 'indeterminate';
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
  // Empty input line: a prompt row with nothing typed after the prompt char —
  // bare, or showing only the CLI's own placeholder hint (`Try "…`). The REAL
  // CLI renders the prompt as `❯` (U+276F); synthetic/test panes and older
  // renders use ASCII `>` — accept both (live-canary finding, 2026-06-09:
  // the ASCII-only match made idle detection fail against every real
  // session, refusing all swaps as not-idle).
  const lines = tail.split('\n');
  return lines.some(line => {
    const stripped = line.replace(/[│|]/g, ' ').replace(/❯/g, '>').trim();
    if (stripped === '>') return true;
    if (/^>\s*Try "/.test(stripped)) return true;
    return false;
  });
}

/**
 * Independent-oracle parse (§5.3 canary): does the pane acknowledge that
 * the model is now `modelId`, on a line that is NOT the echo of our own
 * injected `/model …` input? Conservative by design: an unrecognized format
 * reads as NOT confirmed (the spec's honest-degrade direction).
 *
 * The REAL CLI acks with the model's DISPLAY NAME, not the id (live-canary
 * finding, 2026-06-09): `/model claude-fable-5` → "Set model to Fable 5 and
 * saved as your default for new sessions". We accept the exact id OR the
 * display form derived from the id (closed-enum ids only ever reach here,
 * so the derivation is over a known, validated vocabulary): family token
 * capitalized + up to two leading version components dot-joined —
 * claude-fable-5 → "Fable 5", claude-opus-4-8 → "Opus 4.8".
 */
export function paneConfirmsModel(tail: string | null, modelId: string): boolean {
  if (!tail) return false;
  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternatives = [escapeRe(modelId)];
  const m = modelId.match(/^(?:claude-)?([a-z]+)((?:-[0-9]+)*)/i);
  if (m) {
    const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    const version = m[2].split('-').filter(Boolean).slice(0, 2).join('.');
    alternatives.push(escapeRe(version ? `${family} ${version}` : family));
  }
  const ack = new RegExp(`set model to[^\\n]*\\b(?:${alternatives.join('|')})\\b`, 'i');
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

    // TOPIC-PROFILE-SPEC §9 — the server-side pin consult (in-memory, O(1)).
    // Fail-soft: a consult error keeps today's behavior (no pin).
    let pinConsult: { suppressEscalation: boolean; baselineModel: string | null } | null = null;
    try {
      pinConsult = this.deps.topicProfileConsult?.(session) ?? null;
    } catch (err) {
      // Fail-soft per §9 (a consult error keeps today's no-pin behavior) —
      // but NOT silent: a consult error can drop an operator 'suppress' pin.
      DegradationReporter.getInstance().report({
        feature: 'ModelSwapService.topicProfileConsult',
        primary: "Consult the topic-profile pin before a tier swap (§9 — a 'suppress' pin vetoes escalation)",
        fallback: 'Proceed as if the topic has no pin (pre-profile behavior)',
        reason: `Pin consult threw: ${err instanceof Error ? err.message : String(err)}`,
        impact: "An operator 'suppress' pin may be ignored for this swap; a pinned baseline may de-escalate to the global default instead of the pin",
      });
    }
    if (tier === 'escalated' && pinConsult?.suppressEscalation) {
      // §9: a 'suppress' pinned topic is NEVER escalated — operator authority.
      return this.refuse(session.name, tier, 'profile-suppresses-escalation');
    }

    // Server-derived id — the caller can only ever name a TIER. §9: for a
    // pinned topic, tier:'default' resolves to that topic's pinned BASELINE
    // (the de-escalation lands on the pin, never the global default).
    // Defense-in-depth: the consult's id is resolver-clamped already, but it
    // re-passes the closed enum here before it can reach send-keys (§10.2 —
    // the same fail-closed discipline as resolveTierModel).
    let baselinePin: string | null = null;
    if (tier === 'default' && pinConsult?.baselineModel) {
      const candidate = pinConsult.baselineModel;
      if (MODEL_ID_RE.test(candidate) && (KNOWN_MODEL_IDS[framework] ?? []).includes(candidate)) {
        baselinePin = candidate;
      } else {
        this.audit({ type: 'resolve-rejected', framework, tier, reason: 'id-not-in-closed-enum', rejectedId: candidate.slice(0, 80) });
      }
    }
    const targetId = baselinePin ?? resolveTierModel(framework, tier, cfg, e =>
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

    // RESCUE DE-ESCALATION (Phase-5 review finding): a `tier:'default'` swap
    // for a session CURRENTLY on an escalated id bypasses the enabled/dryRun
    // gates. Those flags are the rollback levers — if they also refused the
    // swap-back, an escalated session would be stranded on the ultra model in
    // exactly the state the operator is trying to leave (the one refusal
    // whose failure direction is MORE spend, inverting §3.5). Strictly
    // cost-reducing, mirrors the governor exemption below; idle/protected/
    // dwell/canary gates all still apply. Fleet installs stay inert: their
    // sessions are never on an escalated id, so disabled still refuses.
    const isRescueDeescalation =
      tier === 'default' && session.model != null && escalatedModelIds(cfg).has(session.model);

    if (!cfg.enabled && !isRescueDeescalation) {
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

    // SUBAGENT idle leg (swap-continuity-antithrash §4.2/Q5 — dark behind
    // `subagentIdleLeg`, concrete default false): a pane-idle session with
    // live background subagents is NOT idle; refusal is retryable exactly
    // like `not-idle`. 'absent'/'indeterminate' refuse per R5-M1 (an
    // unreadable leg is never a license to swap under live work).
    if (cfg.subagentIdleLeg && this.deps.subagentLegProbe) {
      const leg = this.deps.subagentLegProbe(session);
      if (leg !== 'idle') {
        return this.refuse(session.name, tier, `not-idle-subagents:${leg}`);
      }
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

    if (cfg.dryRun && !isRescueDeescalation) {
      this.audit({
        type: 'dry-run-would-swap',
        session: session.name,
        tier,
        model: targetId,
        freeWindow: admit.freeWindow,
      });
      return { status: 'dry-run', model: targetId };
    }
    if (isRescueDeescalation && (!cfg.enabled || cfg.dryRun)) {
      // Loud trail: a real swap performed while the feature is off/dry is
      // exactly the event an operator auditing a rollback wants to see.
      this.audit({ type: 'rescue-deescalation', session: session.name, model: targetId, enabled: cfg.enabled, dryRun: cfg.dryRun });
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
    // behaviourally the session is treated as default. The signal routes to
    // the maturation track as a silent audit breadcrumb (TOPIC-PROFILE-SPEC
    // §11/§14) — a maturing feature's health signal is never a per-event
    // Attention item; the future evidence-file sink finds these rows by
    // `maturationSignal: true`.
    this.lastSwapAt.set(session.id, this.now()); // still dwell — don't re-inject in a tight loop
    this.audit({
      type: 'swap-unconfirmed',
      session: session.name,
      tier,
      model: targetId,
      attempts,
      maturationSignal: true,
      feature: 'model-tier-escalation',
    });
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
