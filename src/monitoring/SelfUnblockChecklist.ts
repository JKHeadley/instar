/**
 * SelfUnblockChecklist — the deterministic, code-driven exhaustion checklist that
 * COMPLETES the constitutional standard "Self-Unblock Before Escalating"
 * (docs/specs/self-unblock-before-escalating.md).
 *
 * Foundation (§0): this does NOT fork a parallel gate. BlockerLedger's
 * `settleTrueBlocker` already MANDATES a recorded failed self-fetch/dry-run before
 * a credential/account blocker can settle as a `true-blocker`. The MISSING half
 * was a STANDARD, code-driven set of sources an agent must have probed first —
 * turning "you must record a failed attempt" into "here is the ordered list of
 * places a self-unblockable credential could live, all of which came up empty".
 *
 * What this module provides (the four genuine additions over BlockerLedger):
 *   1. A deterministic relevance matcher (`isScopeRelevant`) — a credential's
 *      declared scope tag is "relevant" to a target zone/service iff a
 *      deterministic tag/zone match (domain hierarchy + wildcard). Ambiguous,
 *      conflicting, or MISSING metadata fails CLOSED. NO LLM in this path.
 *   2. An ORDERED probe runner (`SelfUnblockChecklist.run`) — cheapest/local
 *      first, short-circuit on the first `holdsRelevantCred: true`. Each probe is
 *      independently timeout-bounded BY CLASS (local sub-second; remote 10–15s),
 *      failing toward `reachable: false` on timeout.
 *   3. A durable run STORE (`SelfUnblockRunStore`) — persists each run keyed by an
 *      immutable runId; `loadRun(runId)` is what BlockerLedger LOADS + verifies so
 *      a caller cannot mint a run the runner did not produce (closes the round-1
 *      "self-asserted/gameable list" finding mechanically).
 *   4. The ladder/rung-floor helper (`resolveRung` / `rungToAuthorityCheck`) — maps
 *      the human-requirement ladder (§3) onto BlockerLedger's existing
 *      `AuthorityCheckEvidence`; enforces the rung FLOOR (capability ≠ authority).
 *
 * Signal vs Authority: this module RECORDS and STRUCTURES. The one judgment —
 * the `true-blocker` settle — stays with BlockerLedger's injected Tier-1
 * authority. This module never blocks an outbound message.
 *
 * Ships DARK behind the existing `monitoring.blockerLedger.*` gate (dev-gate via
 * omitted `enabled`). When the run store is not injected into BlockerLedger, the
 * existing caller-supplied `failedAttempt` path is unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

/** The ordered probe sources (cheapest/local first). Closed taxonomy. */
export const SELF_UNBLOCK_PROBE_SOURCES = [
  'own-vault', // 1. own per-agent vault (secret-get)
  'owned-identities', // 1b. identities the agent itself provisioned (.instar/owned-identities.json — correction-derived-hardening)
  'org-bitwarden', // 2. org Bitwarden (durable session, §5.3)
  'cloud-vercel', // 3a. authed Vercel account
  'cloud-cloudflare', // 3b. authed Cloudflare account
  'cloud-github', // 3c. authed GitHub (gh)
  'cloud-launchd', // 3d. launchd (extensible: Netlify/Heroku)
  'mcp-tools', // 4. MCP tools
  'browser-playwright', // 5. browser/Playwright sessions
  'controlled-resource', // 6. "a resource I already control?"
] as const;

export type SelfUnblockProbeSource = (typeof SELF_UNBLOCK_PROBE_SOURCES)[number];

/** Timeout CLASS per probe — local/keychain probes are sub-second; remote 10–15s. */
export type ProbeTimeoutClass = 'local' | 'remote';

/** Default timeout budget (ms) per class. */
export const PROBE_TIMEOUT_MS: Record<ProbeTimeoutClass, number> = {
  local: 800, // sub-second keychain/vault read
  remote: 12_000, // remote CLI / network call (10–15s codebase norm)
};

/** Which class each source belongs to (drives the per-probe timeout). */
export const PROBE_SOURCE_CLASS: Record<SelfUnblockProbeSource, ProbeTimeoutClass> = {
  'own-vault': 'local',
  'owned-identities': 'local',
  'org-bitwarden': 'remote',
  'cloud-vercel': 'remote',
  'cloud-cloudflare': 'remote',
  'cloud-github': 'remote',
  'cloud-launchd': 'local',
  'mcp-tools': 'local',
  'browser-playwright': 'local',
  'controlled-resource': 'local',
};

/** A single probe's structured result (stamped, never free-form). */
export interface SelfUnblockProbeResult {
  /** Which source was probed. */
  source: SelfUnblockProbeSource;
  /** Could the source be reached at all? false on timeout/error (fails closed). */
  reachable: boolean;
  /**
   * Does this source hold a credential RELEVANT to the target? Decided
   * DETERMINISTICALLY by `isScopeRelevant` (never an LLM). Missing/ambiguous
   * scope metadata fails CLOSED → false.
   */
  holdsRelevantCred: boolean;
  /** ISO timestamp the probe ran. */
  probedAt: string;
  /**
   * Optional short note for the audit surface (untrusted free text — surfaced via
   * BlockerLedger's `<blocker-ledger-data>` envelope, never an instruction).
   */
  detail?: string;
  /** The scope tags this source advertised that were CHECKED against the target. */
  matchedScopeTags?: string[];
}

/** A complete checklist run, keyed by an immutable runId. */
export interface SelfUnblockRun {
  /** Immutable id the runner mints (the caller cannot forge one). */
  runId: string;
  /** The blocker target this run probed (a zone/service, e.g. `cloudflare:feedback.dawn-tunnel.dev`). */
  target: string;
  /** Required attempt TYPE this run produces evidence for (matches BlockerLedger's taxonomy). */
  requiredAttemptType: 'self-fetch' | 'dry-run';
  /** The ordered per-probe results (short-circuited after the first hit, if any). */
  probes: SelfUnblockProbeResult[];
  /** ISO timestamp the run finished. */
  completedAt: string;
  /**
   * True iff EVERY probe came up `holdsRelevantCred: false` — a genuine
   * exhaustion. A run with any `holdsRelevantCred: true` is NOT exhausted (the
   * agent should self-unblock with that credential, not escalate).
   */
  exhausted: boolean;
}

// ─── Relevance matcher (deterministic — NO LLM) ────────────────────────────────

/**
 * A parsed scope tag: `service:scope` (e.g. `cloudflare:dawn-tunnel.dev`,
 * `vercel:project`, `cloudflare:*.dawn-tunnel.dev`).
 */
export interface ScopeTag {
  service: string;
  scope: string;
}

/**
 * Parse a `service:scope` tag. Returns null when the shape is malformed (a tag
 * the matcher must treat as ambiguous → fail closed).
 *
 * A scope is allowed to contain ':' (rare), so only the FIRST colon splits
 * service from scope. An empty service or empty scope is malformed.
 */
export function parseScopeTag(tag: unknown): ScopeTag | null {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim();
  const idx = trimmed.indexOf(':');
  if (idx <= 0 || idx === trimmed.length - 1) return null; // no colon, leading colon, or trailing colon
  const service = trimmed.slice(0, idx).trim().toLowerCase();
  const scope = trimmed.slice(idx + 1).trim().toLowerCase();
  if (!service || !scope) return null;
  return { service, scope };
}

/**
 * Deterministic domain-hierarchy match between a credential's scope and a target
 * scope, with wildcard support:
 *   - exact:           `dawn-tunnel.dev`         matches `dawn-tunnel.dev`
 *   - parent-zone:     `dawn-tunnel.dev`         matches `feedback.dawn-tunnel.dev`
 *   - wildcard:        `*.dawn-tunnel.dev`       matches `feedback.dawn-tunnel.dev`
 *                       (but a bare wildcard label only matches a SUB-domain, not
 *                        the apex — `*.dawn-tunnel.dev` does NOT match the apex
 *                        `dawn-tunnel.dev`, matching CA/DNS wildcard semantics)
 *   - non-domain scope (e.g. `project`, `*`): exact string match only; a literal
 *     `*` matches ANYTHING for that service (a deliberate "whole-account" tag).
 *
 * NOT a match: a sub-zone credential against a parent target (a credential scoped
 * to `feedback.dawn-tunnel.dev` is NOT relevant to the parent zone
 * `dawn-tunnel.dev` — narrower authority cannot grant the broader goal).
 */
function domainScopeMatches(credScope: string, targetScope: string): boolean {
  // Whole-account wildcard tag for a non-domain service.
  if (credScope === '*') return true;

  const looksLikeDomain = (s: string) => s.includes('.') || s.startsWith('*.');

  // If neither looks like a domain, require an exact match (e.g. `project`).
  if (!looksLikeDomain(credScope) && !looksLikeDomain(targetScope)) {
    return credScope === targetScope;
  }

  // Wildcard domain: `*.dawn-tunnel.dev` matches a STRICT sub-domain of the base.
  if (credScope.startsWith('*.')) {
    const base = credScope.slice(2);
    if (!base) return false;
    // strict sub-domain: target ends with `.base` AND is longer than the base.
    return targetScope.endsWith('.' + base) && targetScope.length > base.length + 1;
  }

  // Exact zone match.
  if (credScope === targetScope) return true;

  // Parent-zone match: a credential for `dawn-tunnel.dev` is relevant to the
  // sub-zone `feedback.dawn-tunnel.dev` (broader authority covers the narrower
  // target). Require a label boundary so `evil-dawn-tunnel.dev` never matches.
  return targetScope.endsWith('.' + credScope) && targetScope.length > credScope.length + 1;
}

/**
 * Is a credential whose declared scope tag is `credTag` RELEVANT to the blocker
 * `target` (also a `service:scope` tag)? Deterministic. Fails CLOSED on any
 * malformed/missing/cross-service input.
 *
 * - Both tags must parse (`service:scope`).
 * - The SERVICE must match exactly (a Vercel cred is never relevant to a
 *   Cloudflare target).
 * - The SCOPE must match per `domainScopeMatches`.
 */
export function isScopeRelevant(credTag: unknown, target: unknown): boolean {
  const cred = parseScopeTag(credTag);
  const tgt = parseScopeTag(target);
  if (!cred || !tgt) return false; // missing/ambiguous metadata → fail closed
  if (cred.service !== tgt.service) return false; // cross-service never relevant
  return domainScopeMatches(cred.scope, tgt.scope);
}

/**
 * Given a set of scope tags a source advertises, is ANY of them relevant to the
 * target? An empty/undefined set fails CLOSED → false (under-tagged credential is
 * simply not surfaced). Returns the matching tags for the audit surface.
 */
export function relevantScopeTags(advertised: unknown, target: string): string[] {
  if (!Array.isArray(advertised)) return [];
  const out: string[] = [];
  for (const tag of advertised) {
    if (isScopeRelevant(tag, target) && typeof tag === 'string') out.push(tag);
  }
  return out;
}

// ─── Probe provider interface (injectable so unit tests never hit the network) ──

/**
 * What a probe provider returns. The provider is responsible ONLY for reaching the
 * source and listing the scope tags the source ADVERTISES; the checklist runner
 * applies the deterministic relevance match. A provider that cannot reach the
 * source returns `{ reachable: false }` (or throws/times out → the runner records
 * `reachable: false`).
 */
export interface ProbeProviderResult {
  reachable: boolean;
  /** The scope tags this source advertises (e.g. the zones a CF token can edit). */
  advertisedScopeTags?: string[];
  /** Optional short audit note. */
  detail?: string;
}

/** One source's probe implementation. MUST be self-bounded but the runner also
 *  enforces a hard per-class timeout so a hung provider degrades to unreachable. */
export type ProbeProvider = (target: string) => Promise<ProbeProviderResult>;

/** The full set of injectable providers, one per source. */
export type ProbeProviders = Partial<Record<SelfUnblockProbeSource, ProbeProvider>>;

// ─── Run store (durable; the persistence BlockerLedger verifies against) ───────

/** The read interface BlockerLedger depends on (the ONLY surface it needs). */
export interface SelfUnblockRunLoader {
  loadRun(runId: string): SelfUnblockRun | null;
}

/**
 * Durable JSONL store for checklist runs. One run per line, keyed by an immutable
 * runId. `loadRun` is skip-corrupt-lines tolerant + bounded (precedent:
 * ReapLog.read). A run is APPEND-only; the store never mutates a prior run.
 */
export class SelfUnblockRunStore implements SelfUnblockRunLoader {
  private readonly runsPath: string;
  /** Bound on how many trailing lines `loadRun` will scan (newest runs win). */
  private readonly maxScan: number;

  constructor(opts: { stateDir: string; maxScan?: number }) {
    this.runsPath = path.join(opts.stateDir, 'state', 'self-unblock-runs', 'runs.jsonl');
    this.maxScan = opts.maxScan ?? 2000;
  }

  /** The file the store reads/writes (exposed for tests). */
  get path(): string {
    return this.runsPath;
  }

  /** Append a completed run. Best-effort durable (atomic append). */
  save(run: SelfUnblockRun): void {
    fs.mkdirSync(path.dirname(this.runsPath), { recursive: true });
    fs.appendFileSync(this.runsPath, JSON.stringify(run) + '\n');
  }

  /**
   * Load a run by id, scanning the trailing `maxScan` lines newest-first so a
   * recent run is found fast and a corrupt/partial line never fails the read.
   * Returns null when the id is unknown.
   */
  loadRun(runId: string): SelfUnblockRun | null {
    if (typeof runId !== 'string' || !runId) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(this.runsPath, 'utf-8');
    } catch {
      // @silent-fallback-ok — no runs file yet means no run by that id.
      return null;
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const tail = lines.slice(-this.maxScan);
    for (let i = tail.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(tail[i]) as SelfUnblockRun;
        if (parsed && parsed.runId === runId) return parsed;
      } catch {
        // @silent-fallback-ok — skip a corrupt/partial JSONL line rather than
        // failing the whole read; a partial trailing line is a normal
        // crash-during-append artifact, not a degradation worth reporting.
      }
    }
    return null;
  }

  /** Read the most-recent `limit` runs (newest last) for the read surface. */
  list(limit = 200): SelfUnblockRun[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.runsPath, 'utf-8');
    } catch {
      // @silent-fallback-ok — no runs file yet means an empty list (first run),
      // the same expected first-run condition as loadRun's read above.
      return [];
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const tail = limit > 0 ? lines.slice(-limit) : lines;
    const out: SelfUnblockRun[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as SelfUnblockRun);
      } catch {
        // skip a corrupt/partial line
      }
    }
    return out;
  }
}

// ─── The ordered checklist runner ──────────────────────────────────────────────

export interface SelfUnblockChecklistOptions {
  /** Injectable providers. A missing provider is treated as `reachable: false`. */
  providers?: ProbeProviders;
  /** The durable run store. */
  store: SelfUnblockRunStore;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Override timeout budgets (tests). */
  timeoutMs?: Partial<Record<ProbeTimeoutClass, number>>;
  /** Inject the runId minter (tests assert it is the runner's, not the caller's). */
  mintRunId?: () => string;
}

export class SelfUnblockChecklist {
  private readonly providers: ProbeProviders;
  private readonly store: SelfUnblockRunStore;
  private readonly now: () => Date;
  private readonly timeouts: Record<ProbeTimeoutClass, number>;
  private readonly mintRunId: () => string;

  constructor(opts: SelfUnblockChecklistOptions) {
    this.providers = opts.providers ?? {};
    this.store = opts.store;
    this.now = opts.now ?? (() => new Date());
    this.timeouts = {
      local: opts.timeoutMs?.local ?? PROBE_TIMEOUT_MS.local,
      remote: opts.timeoutMs?.remote ?? PROBE_TIMEOUT_MS.remote,
    };
    this.mintRunId =
      opts.mintRunId ??
      (() => `SUN-${this.now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  }

  /**
   * Run the ORDERED checklist against `target`, short-circuiting on the first
   * `holdsRelevantCred: true`. Persists the run and returns it.
   *
   * `requiredAttemptType` matches BlockerLedger's taxonomy: `self-fetch` for the
   * credential/account-kind blockers (vault/cloud-account probes), `dry-run`
   * otherwise.
   */
  async run(input: {
    target: string;
    requiredAttemptType: 'self-fetch' | 'dry-run';
  }): Promise<SelfUnblockRun> {
    const target = input.target;
    const probes: SelfUnblockProbeResult[] = [];

    for (const source of SELF_UNBLOCK_PROBE_SOURCES) {
      const result = await this.probeOne(source, target);
      probes.push(result);
      if (result.holdsRelevantCred) {
        // Short-circuit: a self-unblock credential exists; the agent should USE it,
        // not escalate. The run is NOT exhausted.
        break;
      }
    }

    const exhausted = probes.length > 0 && probes.every((p) => !p.holdsRelevantCred);
    const run: SelfUnblockRun = {
      runId: this.mintRunId(),
      target,
      requiredAttemptType: input.requiredAttemptType,
      probes,
      completedAt: this.now().toISOString(),
      exhausted,
    };
    this.store.save(run);
    return run;
  }

  /** Probe ONE source with a hard per-class timeout. Fails toward `reachable: false`. */
  private async probeOne(
    source: SelfUnblockProbeSource,
    target: string,
  ): Promise<SelfUnblockProbeResult> {
    const probedAt = this.now().toISOString();
    const provider = this.providers[source];
    if (!provider) {
      // No provider wired for this source → unreachable (degrade gracefully).
      return { source, reachable: false, holdsRelevantCred: false, probedAt, detail: 'no provider' };
    }
    const budget = this.timeouts[PROBE_SOURCE_CLASS[source]];
    let providerResult: ProbeProviderResult;
    try {
      providerResult = await this.withTimeout(provider(target), budget);
    } catch {
      // Timeout or provider error → unreachable, fail closed.
      return {
        source,
        reachable: false,
        holdsRelevantCred: false,
        probedAt,
        detail: 'probe timed out or errored',
      };
    }

    if (!providerResult.reachable) {
      return {
        source,
        reachable: false,
        holdsRelevantCred: false,
        probedAt,
        detail: providerResult.detail,
      };
    }

    const matched = relevantScopeTags(providerResult.advertisedScopeTags, target);
    return {
      source,
      reachable: true,
      holdsRelevantCred: matched.length > 0,
      probedAt,
      detail: providerResult.detail,
      matchedScopeTags: matched.length > 0 ? matched : undefined,
    };
  }

  /** Reject after `ms`, so a hung provider can never stall the path. */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe-timeout')), ms);
      // Do not keep the event loop alive on the timer.
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
}

// ─── The human-requirement ladder + rung floor (§3) ────────────────────────────

/** The ladder rungs (§3). */
export type SelfUnblockRung = 0 | 1 | 2;

/**
 * An action CLASS that carries a rung FLOOR. The four floor-raising properties
 * (§3, capability ≠ authority): an action that is irreversible, cost-bearing
 * above a threshold, out-of-original-scope, or policy-sensitive has a MINIMUM
 * rung of 1 (approval) EVEN IF a self-unblock credential exists.
 */
export interface ActionClass {
  /** Cannot be undone (a delete, a wire, a publish). */
  irreversible?: boolean;
  /** Bears cost above the approval threshold. */
  costBearingAboveThreshold?: boolean;
  /** Outside the goal's originally-granted scope. */
  outOfScope?: boolean;
  /** Policy-sensitive (legal, PII export, etc.). */
  policySensitive?: boolean;
}

/** True iff the action class triggers the rung-1 floor. */
export function actionTriggersRungFloor(action: ActionClass | undefined): boolean {
  if (!action) return false;
  return !!(
    action.irreversible ||
    action.costBearingAboveThreshold ||
    action.outOfScope ||
    action.policySensitive
  );
}

export interface ResolveRungInput {
  /**
   * The run that probed the blocker. When `exhausted` is false (a relevant cred
   * was found), the agent can self-unblock → rung 0 UNLESS the action floor
   * raises it. When exhausted, no self-unblock cred exists → at least rung 1
   * (approval) and rung 2 if the dependency is an operator-only secret.
   */
  run: SelfUnblockRun;
  /** The action class (drives the rung floor). */
  action?: ActionClass;
  /**
   * Is the unblock dependency an operator-only secret/account (the rung-2 case)?
   * Derived from BlockerLedger's taxonomy at the caller; rung 2 is the credential
   * only an authorized employee can produce.
   */
  operatorOnlySecret?: boolean;
}

export interface RungResolution {
  /** The resolved rung. */
  rung: SelfUnblockRung;
  /** Whether the rung was RAISED by the action-class floor (vs the base resolution). */
  raisedByFloor: boolean;
  /** Human-readable reason (untrusted-safe — plain enum-derived text). */
  reason: string;
}

/**
 * Resolve the lowest legitimate rung for a blocker, ENFORCING the rung floor.
 *
 * Base resolution:
 *   - run NOT exhausted (a self-unblock cred exists) → rung 0 (nothing required)
 *   - run exhausted + operator-only secret              → rung 2 (operator-only credential)
 *   - run exhausted otherwise                           → rung 1 (an approval)
 *
 * Floor (capability ≠ authority): if the action class is irreversible /
 * cost-bearing-above-threshold / out-of-scope / policy-sensitive, the rung can
 * never be BELOW 1 — even a rung-0 self-unblock is raised to rung 1 (approval).
 */
export function resolveRung(input: ResolveRungInput): RungResolution {
  let base: SelfUnblockRung;
  let reason: string;
  if (!input.run.exhausted) {
    base = 0;
    reason = 'a self-unblock credential is available within the agent\'s own access';
  } else if (input.operatorOnlySecret) {
    base = 2;
    reason = 'exhausted self-unblock paths; the dependency is an operator-only credential';
  } else {
    base = 1;
    reason = 'exhausted self-unblock paths; an operator approval is required';
  }

  const floor = actionTriggersRungFloor(input.action);
  if (floor && base < 1) {
    return {
      rung: 1,
      raisedByFloor: true,
      reason:
        'the action is irreversible/cost-bearing/out-of-scope/policy-sensitive, so an approval ' +
        'is required even though a self-unblock credential exists (capability is not authority)',
    };
  }
  return { rung: base, raisedByFloor: false, reason };
}

/**
 * Map a resolved rung onto BlockerLedger's existing `AuthorityCheckEvidence`
 * shape (§3 — the rung is recorded there, NOT in a new field). A rung-1 grant
 * MUST resolve against a VERIFIED principal (Know Your Principal): when the rung
 * is >=1 and the grant matters, `principalVerified` must be true or the grant is
 * not honored. This function refuses to assert `userHasAuthority: true` for an
 * unverified principal.
 */
export function rungToAuthorityCheck(input: {
  resolution: RungResolution;
  /** Was the approving/granting principal VERIFIED (mandate / verified-operator surface)? */
  principalVerified: boolean;
}): { agentHasAuthority: boolean; userHasAuthority: boolean; note: string } {
  const { rung, reason, raisedByFloor } = input.resolution;
  // Rung 0: the agent has the authority itself (no human needed).
  if (rung === 0) {
    return {
      agentHasAuthority: true,
      userHasAuthority: false,
      note: `rung 0 — ${reason}`,
    };
  }
  // Rung 1/2: a human is required. The grant only counts against a VERIFIED
  // principal — an unverified principal can never be recorded as holding the
  // authority (a name seen in content is a question, not a fact).
  const userHasAuthority = input.principalVerified;
  const floorNote = raisedByFloor ? ' (rung raised by the action-class floor)' : '';
  const principalNote = input.principalVerified
    ? 'verified principal'
    : 'principal NOT verified — grant cannot be honored until resolved against a verified-operator/mandate surface';
  return {
    agentHasAuthority: false,
    userHasAuthority,
    note: `rung ${rung} — ${reason}${floorNote}; ${principalNote}`,
  };
}
