/**
 * CredentialEnvTokenGate — the §0.b applicability precondition, enforced structurally
 * (Step 8 of live credential re-pointing).
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §2.10 (the env-token gate — verbatim
 * contract), §0.b (applicability gate), §2.4 (the status route the named reason surfaces on).
 *
 * ── What this is ──
 * The live credential re-pointing mechanism only works for sessions whose credential comes from
 * the per-`CLAUDE_CONFIG_DIR` STORE (a swap re-points the store; claude-code re-reads it on the
 * next 401). A session launched with an env token (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`
 * set from a non-empty `config.anthropicApiKey`) NEVER reads the store, ignores any swap, and is
 * INVISIBLE to the mechanism. If such a launch were the norm the entire feature would be inert
 * (§0.b). This gate REFUSES to run the feature — with a NAMED reason on the status route — whenever
 * an env-token condition is present, so the mechanism can never silently mis-steer a fleet it does
 * not actually control.
 *
 * ── The load-bearing safety contract (spec §2.10; build-prompt invariants 1, 2) ──
 *   1. EVALUATES BOTH the config field AND the live running fleet. A config-only check would miss
 *      the mid-life flip: an operator setting `config.anthropicApiKey` to an OAuth token mid-run
 *      leaves already-running STORE sessions steerable while new ENV spawns are silently un-steered
 *      — a genuinely mixed fleet a config-only check freezes incoherently. The fleet scan reads the
 *      durable per-session `credentialSource` flag (recorded at spawn from the IDENTICAL expression
 *      that selected the env block — single source of truth) so it can detect that mixed state.
 *   2. THE CONFIG PREDICATE IS "ANY NON-EMPTY anthropicApiKey" (round-3) — NOT only an
 *      `sk-ant-oat` OAuth token. The code's launch predicate is binary: `sk-ant-oat…` sets
 *      `CLAUDE_CODE_OAUTH_TOKEN`, ANY OTHER non-empty value sets `ANTHROPIC_API_KEY`, and BOTH make
 *      claude-code ignore the store. So the gate predicate is `(anthropicApiKey ?? '') !== ''`,
 *      matching the SessionManager `?? ''`-then-non-empty branch exactly.
 *   3. NAMED, CATEGORICAL REASON. The refusal reason is a category string (never a credential), but
 *      the host still routes it through `CredentialAuditEmit.scrub` (Step 7) before any surface,
 *      consistent with the §2.9 chokepoint.
 *
 * This module performs NO IO and NO credential reads. It is a pure evaluator over an injected
 * config-key getter + an injected session lister, so it is fully unit-testable.
 */

import type { Session } from './types.js';

/** A session lister snapshot input — the gate only reads `framework`, `status`, `credentialSource`. */
export type EnvTokenFleetSession = Pick<Session, 'framework' | 'status' | 'credentialSource'>;

export interface CredentialEnvTokenGateDeps {
  /**
   * Reads the live `config.anthropicApiKey` value EACH call (not cached) so a restartless config
   * flip is honored on the next evaluation — the same restartless posture the rest of the feature
   * uses. May return undefined/empty when no key is configured (the §0.b alive case).
   */
  getAnthropicApiKey: () => string | undefined;
  /**
   * Lists the CURRENT sessions (the live fleet). The gate filters to running claude-code sessions
   * and reads their durable `credentialSource` flag. Injected so the gate stays IO-free.
   */
  listSessions: () => EnvTokenFleetSession[];
}

/** The named refusal reason categories (a category, never a credential). */
export type EnvTokenRefusalReason =
  | 'config-anthropic-api-key-set'
  | 'env-token-session-in-fleet';

export interface EnvTokenGateVerdict {
  /** True when the feature MUST refuse to run (an env-token condition is present). */
  refused: boolean;
  /** The named, scrub-safe reason category when refused; undefined when permitted. */
  reason?: EnvTokenRefusalReason;
  /** A human-readable one-line explanation (category-level, no credential material). */
  detail?: string;
  /**
   * The names/ids absent here on purpose: the verdict carries NO session identifiers and NO key
   * material, so it is safe to surface as-is (and is scrubbed regardless by the host).
   */
  /** How many running claude-code sessions in the fleet are env-token (0 when none / config-only refusal). */
  envSessionCount: number;
}

/**
 * Evaluates the §2.10 env-token precondition over BOTH the config field AND the live fleet.
 *
 * Construct ONE per process and call `evaluate()` at enable-time AND per-pass. The CONFIG check is
 * evaluated FIRST (cheapest + the dominant case); the FLEET scan closes the mid-life-flip hole.
 */
export class CredentialEnvTokenGate {
  private readonly getAnthropicApiKey: () => string | undefined;
  private readonly listSessions: () => EnvTokenFleetSession[];

  constructor(deps: CredentialEnvTokenGateDeps) {
    this.getAnthropicApiKey = deps.getAnthropicApiKey;
    this.listSessions = deps.listSessions;
  }

  /**
   * The §2.10 verdict. Refuses when:
   *   (a) `config.anthropicApiKey` is non-empty (ANY value — OAuth or API key); OR
   *   (b) any RUNNING claude-code session's `credentialSource` is `'env'` (the live-fleet path that
   *       closes the mid-life flip). `credentialSource` undefined on a legacy/non-claude record is
   *       treated as `'store'` (the safe, non-refusing direction — only an explicit `'env'` refuses).
   * Permits (refused:false) only when the config field is empty AND every running claude-code
   * session reads the store.
   */
  evaluate(): EnvTokenGateVerdict {
    // (a) Config field — the dominant case, checked first. `?? ''`-then-non-empty mirrors the
    // SessionManager launch predicate exactly: any non-empty value (OAuth OR API key) bypasses
    // the store.
    const key = this.getAnthropicApiKey() ?? '';
    if (key !== '') {
      return {
        refused: true,
        reason: 'config-anthropic-api-key-set',
        detail:
          'credential re-pointing refused: config.anthropicApiKey is set, so sessions launch with ' +
          'an env token and bypass the per-CLAUDE_CONFIG_DIR store the mechanism steers (§0.b).',
        envSessionCount: 0,
      };
    }

    // (b) Live fleet — closes the mid-life flip. Count RUNNING claude-code sessions whose durable
    // provenance flag is explicitly 'env'. Undefined ⇒ 'store' (safe direction).
    const envSessions = this.listSessions().filter(
      (s) =>
        s.status === 'running' &&
        s.framework === 'claude-code' &&
        s.credentialSource === 'env',
    );
    if (envSessions.length > 0) {
      return {
        refused: true,
        reason: 'env-token-session-in-fleet',
        detail:
          `credential re-pointing refused: ${envSessions.length} running claude-code session(s) ` +
          'launched with an env token (store-bypassing) per the durable per-session provenance ' +
          'flag — a config field flipped mid-run would otherwise leave a mixed fleet steered ' +
          'incoherently (§2.10).',
        envSessionCount: envSessions.length,
      };
    }

    // Permitted: config empty + all-store fleet (the §0.b "alive" case for THIS deployment).
    return { refused: false, envSessionCount: 0 };
  }

  /**
   * True iff a given session should still feed `tenantOf(slot)` slot-attribution into usage records.
   * On a §2.10 refusal the balancer STOPS feeding attribution for env-token sessions so an env
   * session's usage is never mis-attributed to a slot tenant (spec §2.10 requirement 3). A session
   * with `credentialSource: 'env'` never reads the store, so its usage does not belong to any slot
   * tenant — it is attributed to its own account directly (enrollment-home behavior).
   */
  static shouldAttributeSlotTenant(session: Pick<Session, 'credentialSource'>): boolean {
    return session.credentialSource !== 'env';
  }
}
