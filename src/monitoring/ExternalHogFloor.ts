/**
 * ExternalHogFloor — the deterministic, VETO-ONLY safety floor of the External-Hog
 * Zombie Auto-Kill Sentinel (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md §3-§4).
 *
 * SAFETY MODEL (signal-vs-authority): the intelligence (zombie-classify) holds the kill
 * DECISION authority (kill/leave/alert); this floor holds only VETO authority. A kill
 * executes iff `evaluateKillFloor(...).permitted === true && classifierVerdict === 'kill'`
 * — a two-key AND. The floor can ONLY ever BLOCK a kill (downgrade it to an alert); it can
 * NEVER trigger one. The model's authority is therefore purely SUBTRACTIVE: it may SPARE a
 * process inside the envelope, but can never widen the envelope the floor has proven safe.
 *
 * The floor is a PURE function over a normalized fact set (no I/O). It fails CLOSED: any
 * missing/unknowable invariant → NOT permitted (→ alert), never a kill. The process name
 * and argv are attacker-controllable text, so the floor NEVER trusts them beyond the
 * code-defined allowlist match — a cleverly-named process can at most be SPARED or land a
 * kill INSIDE the allowlist envelope (the intended action), never expand the target set.
 */

/** The code-defined allowlist: v1 seed = orphaned Electron editor extension-host WRAPPERS.
 *  NOT a config key — growing it is a reviewed source change (§3, blast-radius invariant).
 *  Each class requires BOTH a name-regex match AND an extension-host/language-server argv
 *  token (tolerant of extension-path-dominated argv — the token may appear anywhere). */
export interface AllowlistClass {
  readonly id: string;
  readonly nameRegex: RegExp;
}

export const EXTERNAL_HOG_ALLOWLIST: readonly AllowlistClass[] = [
  { id: 'vscode-exthost', nameRegex: /^Code Helper \(Plugin\)$/ },
  { id: 'cursor-exthost', nameRegex: /^Cursor Helper \(Plugin\)$/ },
  { id: 'windsurf-exthost', nameRegex: /^Windsurf Helper \(Plugin\)$/ },
  { id: 'vscodium-exthost', nameRegex: /^Code - OSS Helper \(Plugin\)$/ },
] as const;

/** The extension-host / language-server argv tokens a candidate must ALSO carry. Matched
 *  case-insensitively ANYWHERE in the full argv (incl. inside a path segment). */
const ALLOWLIST_ARGV_TOKENS: readonly RegExp[] = [
  /extension[\s._-]*host/i,
  /language[\s._-]*server/i,
  /--type=extensionHost/i,
];

/**
 * Match a candidate against the code-defined allowlist. Returns the matched class id, or
 * null. The name-regex is matched on the process `comm`/name (which the discovery layer
 * reads); the argv token is matched on the FULL argv (never the truncatable `comm`).
 */
export function matchAllowlistClass(name: string, fullArgv: string): string | null {
  if (typeof name !== 'string' || typeof fullArgv !== 'string') return null;
  const cls = EXTERNAL_HOG_ALLOWLIST.find((c) => c.nameRegex.test(name));
  if (!cls) return null;
  const hasToken = ALLOWLIST_ARGV_TOKENS.some((t) => t.test(fullArgv));
  return hasToken ? cls.id : null;
}

/**
 * The ORDERED rule-source list for a class — the SINGLE source of truth the content-hash
 * arm-scope is computed from (docs/specs §7-§8). BOTH the PIN arm route (building the marker's
 * `allowlistSnapshot`) and the funnel's `currentClassContentHash` MUST derive the hash from THIS,
 * so a class's armed hash and its re-checked hash always agree — and ANY change to the matcher
 * (a new name-regex or argv token) yields a different hash, forcing a fresh PIN re-arm before that
 * class can kill again. Returns null for an unknown class id. Ordered = [nameRegex source, then
 * the shared argv-token sources] so a reordering (which changes anchored matching) is a new hash.
 */
export function classRuleSources(classId: string): readonly string[] | null {
  const cls = EXTERNAL_HOG_ALLOWLIST.find((c) => c.id === classId);
  if (!cls) return null;
  return [cls.nameRegex.source, ...ALLOWLIST_ARGV_TOKENS.map((t) => t.source)];
}

/**
 * The deterministically-computed facts the floor evaluates. Every field is derived by the
 * discovery/sampler layer from the live OS (never from model output). Optional fields that
 * are UNKNOWN (undefined) fail the floor CLOSED — an unestablished invariant is a veto.
 */
export interface ExternalHogFacts {
  /** Process name / `comm` — attacker-controllable; only ever used for the allowlist regex. */
  readonly name: string;
  /** Full argv — attacker-controllable; only ever used for the allowlist argv-token match. */
  readonly argv: string;
  readonly pid: number;
  /** Provenance: is the SPECIFIC spawning parent (argv `--parentPid`) still alive? `true` = owner
   *  app running (or owner cannot be positively established) → floor VETO; `false` = the specific
   *  `--parentPid` is dead (start-time-verified) → kill-eligible. NOT bare ppid===1. (The invariant
   *  at evaluateKillFloor step 5 vetoes when this is `true`.) */
  readonly ownerAppRunning: boolean;
  /** Confirmed sustained CPU hog (the §1 N-window CPU-delta ≥ cpuCoreThreshold). Hard veto. */
  readonly sustainedHighCpu: boolean;
  /** The process is instar-owned (server / session / sampler / a live-session descendant). */
  readonly isInstarProcess: boolean;
  /** The owner is a system/root daemon (fseventsd, WindowServer, …) — never killable. */
  readonly ownerRootDaemon: boolean;
  /** A labeled launchd job — managed, killing invites a respawn loop → veto. */
  readonly hasLaunchctlLabel: boolean;
  /** Target real/effective uid. Must equal the sentinel's own non-root euid (same-uid floor). */
  readonly targetUid?: number;
  /** The sentinel's own effective uid (non-root). */
  readonly ownEuid?: number;
}

export type FloorVerdict =
  | { readonly permitted: true; readonly matchedClass: string }
  | { readonly permitted: false; readonly vetoReason: string };

/**
 * Evaluate the VETO-ONLY safety floor over the deterministic facts. Returns
 * `{ permitted: true }` only when EVERY hard invariant holds; otherwise
 * `{ permitted: false, vetoReason }` with the FIRST failing invariant. A `permitted:true`
 * result is a NECESSARY (never sufficient) condition for a kill — the caller must ALSO
 * have a `classifier === 'kill'` verdict. Fails CLOSED on any unknown invariant.
 */
export function evaluateKillFloor(facts: ExternalHogFacts): FloorVerdict {
  // (0) STRICT fail-closed guard — every required boolean invariant must be a genuine
  //     boolean. A missing/`undefined`/non-boolean value VETOES rather than skipping the
  //     check. This is load-bearing: `if (facts.X)` truthiness would let an `undefined`
  //     field fail OPEN, and the fail-closed property must NOT be delegated to the type
  //     system or sampler correctness — exactly the layer that degrades under the CPU/memory
  //     starvation this sentinel hunts (a sampler that times out computing `ownerAppRunning`
  //     and drops the field must never yield a permitted kill of a process whose orphanhood
  //     was never established). (round-11 — second-pass reviewer.)
  const requiredBooleans = {
    isInstarProcess: facts.isInstarProcess,
    ownerRootDaemon: facts.ownerRootDaemon,
    hasLaunchctlLabel: facts.hasLaunchctlLabel,
    ownerAppRunning: facts.ownerAppRunning,
    sustainedHighCpu: facts.sustainedHighCpu,
  };
  for (const [field, value] of Object.entries(requiredBooleans)) {
    if (typeof value !== 'boolean') return { permitted: false, vetoReason: `field-unknown:${field}` };
  }

  // (1) instar-own exclusion — never act on our own process tree (defense-in-depth; also
  //     excluded at discovery). Checked first so an own-process can never even be reasoned about.
  if (facts.isInstarProcess) return { permitted: false, vetoReason: 'instar-owned' };

  // (2) same-uid floor invariant — a hard property, not incidental EPERM. The grant's scope
  //     is the granting operator's OWN processes. Unknown uid → fail closed.
  if (facts.ownEuid === undefined || facts.targetUid === undefined) {
    return { permitted: false, vetoReason: 'uid-unknown' };
  }
  if (facts.ownEuid === 0) return { permitted: false, vetoReason: 'refuse-to-arm-as-root' };
  if (facts.targetUid !== facts.ownEuid) return { permitted: false, vetoReason: 'other-uid' };

  // (3) system/root daemon — the OS itself is never killable (defense-in-depth denylist).
  if (facts.ownerRootDaemon) return { permitted: false, vetoReason: 'system-root-daemon' };

  // (4) launchctl label — a managed launchd job; killing invites a respawn loop.
  if (facts.hasLaunchctlLabel) return { permitted: false, vetoReason: 'launchctl-labeled' };

  // (5) provenance-of-orphanhood — the specific spawning parent must be DEAD. A live owner
  //     app (an exthost whose window is still open) is never a zombie.
  if (facts.ownerAppRunning) return { permitted: false, vetoReason: 'owner-app-running' };

  // (6) sustainedHighCpu — HARD VETO. An idle orphan or a momentary spike is NEVER killed,
  //     regardless of the model's verdict — the feature stays scoped to CPU reclamation by
  //     construction, not by the model's judgment.
  if (!facts.sustainedHighCpu) return { permitted: false, vetoReason: 'not-sustained-hog' };

  // (7) code-defined allowlist class — outside the narrow envelope is a veto regardless of
  //     the model's call. Attacker-controllable name/argv can at most land INSIDE this
  //     envelope (the intended action), never expand it.
  const matchedClass = matchAllowlistClass(facts.name, facts.argv);
  if (!matchedClass) return { permitted: false, vetoReason: 'outside-allowlist' };

  return { permitted: true, matchedClass };
}
