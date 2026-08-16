/**
 * Auth policy for the grok-build adapter (grok-build framework integration
 * spec §3.1, §3.1.1; external review-1 finding 3).
 *
 * THE BILLING RULE: a grok-build run must bill against the SUBSCRIPTION
 * session. The CLI's own documented precedence ("active session token first,
 * XAI_API_KEY as fallback") is not a sufficient control, because:
 *   - an EXPIRED session file still exists on disk while no session is
 *     active — exactly the state where the CLI falls back to a key;
 *   - keys can live in places the adapter cannot enumerate (config.toml,
 *     keychain), so the vendor's own `disable_api_key_auth` login policy is
 *     the PRIMARY control (§3.1.1) and this adapter-side check is the second
 *     layer.
 *
 * So the adapter refuses, BEFORE any spawn:
 *   1. any API/deployment key present in the environment — even alongside a
 *      valid session (GrokApiKeyForbiddenError);
 *   2. a missing auth file — unauthenticated (GrokSessionExpiredError);
 *   3. an auth file whose stored expiry falls within max(60s, the call's
 *      own timeout) of now (GrokSessionExpiredError) — the timeout-aware
 *      margin exists precisely so an ADMITTED call cannot expire mid-run
 *      (a mid-run expiry is a silent-metering vector, not merely a stall).
 *      Only a session invalidated SERVER-side early remains a stall-matrix
 *      class (docs/frameworks/grok-build-stall-coverage.md).
 *
 * The refusal inspects env-var NAMES and file METADATA; no secret value is
 * ever read into an error message or log.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { grokAuthPath, type GrokBuildConfig } from './config.js';
import {
  GrokApiKeyForbiddenError,
  GrokConfigCredentialForbiddenError,
  GrokSessionExpiredError,
  GrokLoginPolicyUnverifiedError,
} from './errors.js';

/**
 * Env vars whose presence means a metered billing path exists. Any of these
 * set ⇒ refuse (the no-silent-metering rule). Names only, never values.
 */
export const GROK_FORBIDDEN_ENV_VARS = ['XAI_API_KEY', 'GROK_DEPLOYMENT_KEY'] as const;

/**
 * Expiry safety margin FLOOR. The effective margin for a call is
 * max(SESSION_EXPIRY_MARGIN_MS, the call's own timeout) — a call admitted
 * with less session life than its own maximum duration can expire
 * mid-flight and land in the CLI's fallback ambiguity (adversarial review
 * round-3 finding 1: a fixed 60s margin under a 120s timeout admitted
 * exactly that window).
 */
export const SESSION_EXPIRY_MARGIN_MS = 60_000;

interface GrokAuthEntry {
  expires_at?: string;
  key?: string;
  auth_mode?: string;
  /**
   * The renewal credential. Present on the live grok 1.0.4 auth entry
   * (verified on-disk 2026-08-15, by field NAME only — never its value).
   * Read ONLY to decide whether a lapsed session is recoverable; nothing in
   * this adapter ever uses, forwards, or logs it.
   */
  refresh_token?: string;
}

/**
 * Read the auth file and return the LATEST `expires_at` across entries, or
 * null when the file is missing/unreadable/holds no parseable expiry.
 * LATEST, not soonest: the CLI uses its freshest session, and a stale
 * historical entry retained beside a newly-minted one must not wedge the
 * gate closed forever after a successful re-login (adversarial review
 * round-3 finding 7).
 *
 * Round-21 amends an earlier, now-false claim on this line ("reads ONLY the
 * expiry field"): it DOES read the token, to decode that token's own `exp`
 * and cross-check the declared expiry against it. It still never returns,
 * logs, or echoes token material — only a Date derived from it.
 */
/**
 * Decode the `exp` claim of a session access token.
 *
 * Round-21: the spec claimed the JWT `exp` was parsed and the task list
 * required it, but nothing anywhere decoded a token — the gate read the
 * sibling `expires_at` STRING and trusted it. Measured against the live
 * session those two agree to within 199 ms, so `expires_at` is a faithful
 * proxy today; nothing verified that, and a vendor change that re-pointed
 * `expires_at` at the (opaque, non-JWT) refresh token would be undetected.
 *
 * The seconds-vs-milliseconds hazard is resolved EXPLICITLY rather than
 * assumed, because both wrong readings are silent and opposite: an
 * epoch-milliseconds value read as seconds lands in the year ~58000 and never
 * expires; an epoch-seconds value read as milliseconds lands in 1970 and
 * always expires. So each interpretation is sanity-checked against a plausible
 * window, and an `exp` that fits NEITHER is reported unparseable rather than
 * guessed at.
 *
 * Never logs, returns, or echoes any part of the token.
 */
export function readJwtExp(token: string, now: Date = new Date()): Date | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  let exp: unknown;
  try {
    const payload = Buffer.from(segments[1] ?? '', 'base64url').toString('utf8');
    exp = (JSON.parse(payload) as { exp?: unknown }).exp;
  } catch {
    // @silent-fallback-ok — a token we cannot decode yields no opinion; the
    // caller keeps using `expires_at`. It must never yield a LATER expiry.
    return null;
  }
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;

  const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
  const plausible = (d: Date): boolean =>
    Math.abs(d.getTime() - now.getTime()) < TEN_YEARS_MS;

  const asSeconds = new Date(exp * 1000);
  if (plausible(asSeconds)) return asSeconds;
  const asMillis = new Date(exp);
  if (plausible(asMillis)) return asMillis;
  return null;
}

/**
 * The auth file's session state: when the newest usable session expires, and
 * whether THAT session carries a credential the CLI can renew itself with.
 *
 * ROUND-22 — why `refreshable` exists, measured live rather than reasoned.
 * The stored session expired at 17:20Z. At 17:51Z `grok models` answered "You
 * are not authenticated". A single one-shot completion then succeeded, and the
 * stored expiry jumped forward six hours with NO human involvement: the CLI holds
 * a refresh token and renews LAZILY, on the next command that actually needs auth.
 *
 * That composed into a deadlock with our own gate, which refused every call on a
 * past expiry and has no renewal path of its own: the session lapses → the gate
 * refuses → nothing invokes the CLI → the CLI never renews → the gate refuses
 * forever. The reviewer lane went dark after any ~6h idle gap and stayed dark
 * until a human ran a grok command by hand. A refusal that blocks the recovery
 * which would clear it is not caution; it converts a transient state into a
 * permanent one.
 *
 * WHY ADMITTING HERE IS NOT A BILLING HOLE — the objection this has to answer.
 * The expiry check is a LIVENESS check, not the billing control it resembled.
 * Metered spend is held out by four INDEPENDENT mechanisms, none of which reads
 * this date: the forbidden-env sweep, `buildGrokChildEnv`'s allowlist (which
 * deletes every billing var and FORCES `GROK_DISABLE_API_KEY_AUTH=1` on every
 * spawn regardless of which check passed), the config-credential refusal, and the
 * login-policy verification. A refresh that fails therefore surfaces as an auth
 * error from a child that still cannot bill — a bounded failure, not a silent
 * metered call. Believing this check carried a guarantee four other mechanisms
 * were actually carrying is what let the outage look deliberate.
 *
 * Both facts come from ONE parse. Reading the file twice — once for the expiry,
 * once for the refresh token — would be two readers of one source free to
 * disagree, which is the defect class this branch spent a day removing.
 */
export interface GrokSessionAuthState {
  /** Effective expiry of the newest usable entry; null when unreadable. */
  expiry: Date | null;
  /** True when the entry that produced `expiry` can be renewed without a human. */
  refreshable: boolean;
}

export function readSessionExpiry(authFile: string): Date | null {
  return readSessionAuthState(authFile).expiry;
}

export function readSessionAuthState(authFile: string): GrokSessionAuthState {
  const unreadable: GrokSessionAuthState = { expiry: null, refreshable: false };
  let raw: string;
  try {
    raw = fs.readFileSync(authFile, 'utf8');
  } catch {
    return unreadable;
  }
  let parsed: Record<string, GrokAuthEntry>;
  try {
    parsed = JSON.parse(raw) as Record<string, GrokAuthEntry>;
  } catch {
    return unreadable;
  }
  let latest: Date | null = null;
  let latestRefreshable = false;
  for (const entry of Object.values(parsed)) {
    if (!entry || typeof entry.expires_at !== 'string') continue;
    // auth_mode-aware (security round-5): an entry that EXPLICITLY declares
    // a key-mode credential must not green the subscription-session gate on
    // the strength of exactly the credential class the gate forbids.
    // Unknown/absent modes still count (the anti-wedge LATEST rule), and
    // the probed subscription mode is 'oidc'.
    if (typeof entry.auth_mode === 'string' && /api[_-]?key/i.test(entry.auth_mode)) continue;
    const d = new Date(entry.expires_at);
    if (Number.isNaN(d.getTime())) continue;

    // Round-21: cross-check the declared expiry against the token's OWN `exp`
    // and take the EARLIER of the two. Direction matters — min() is the only
    // safe combinator here, because the failure this guards against is a
    // declared expiry that outlives the credential it describes. A token that
    // cannot be decoded yields null and simply leaves `expires_at` standing,
    // so a non-JWT credential format cannot wedge the gate.
    const jwtExp = typeof entry.key === 'string' ? readJwtExp(entry.key) : null;
    const effective = jwtExp !== null && jwtExp.getTime() < d.getTime() ? jwtExp : d;

    if (latest === null || effective.getTime() > latest.getTime()) {
      latest = effective;
      // Tied to the WINNING entry, not to "any entry in the file": a refresh
      // token belonging to some other, older session says nothing about whether
      // THIS one can be renewed. An empty string is treated as absent — the
      // vendor writes the field either way.
      latestRefreshable = typeof entry.refresh_token === 'string'
        && entry.refresh_token.trim() !== '';
    }
  }
  return { expiry: latest, refreshable: latestRefreshable };
}

/**
 * Is the vendor's `disable_api_key_auth` login policy verifiably IN FORCE
 * for this grok home? This is the PRIMARY billing control (spec §3.1.1):
 * it closes credential locations the adapter cannot enumerate (config.toml
 * beyond this key, keychain). Reads `$GROK_HOME/config.toml` directly —
 * the same file the CLI's Login Policy loads from. Absent file, absent
 * key, or `false` ⇒ NOT verified (fail closed toward unavailable).
 * A parse this shallow is deliberate: we look for the exact TOML line, not
 * a full TOML parse — a policy we cannot POSITIVELY confirm is unverified.
 *
 * SCOPE (decision-completeness round-6): this verifier reads OPERATOR-set
 * state only — the config.toml key or an operator-exported env var in the
 * CALLING process's environment. The adapter's per-spawn forced CHILD env
 * (buildGrokChildEnv) never reaches this check by construction (it is
 * written into the child's env object, not process.env), so the forced
 * lockdown can never vacuously satisfy the deliberate-enable marker.
 */
export function isLoginPolicyVerified(
  grokHome: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // The env lockdown is sticky in the CLI (GROK_DISABLE_API_KEY_AUTH seeds
  // the merge base and is OR-ed in) — accept it as verification too.
  const envVal = env['GROK_DISABLE_API_KEY_AUTH'];
  if (envVal === '1' || envVal === 'true') return true;
  try {
    const raw = fs.readFileSync(path.join(grokHome, 'config.toml'), 'utf8');
    // TOML-section-aware scan: the key counts ONLY at top level or under the
    // [auth] table. A line inside any other table (e.g. appended after
    // [[marketplace.sources]]) is NOT the login policy — verified the hard
    // way on 2026-08-14: a naive append landed inside a marketplace table
    // and the CLI's inspect showed the policy (unset).
    let section = '';
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.startsWith('[')) {
        section = t;
        continue;
      }
      if (
        (section === '' || section === '[auth]') &&
        /^disable_api_key_auth\s*=\s*true\s*(#.*)?$/.test(t)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Credential-bearing keys the vendor honours from `config.toml`, in ANY table.
 *
 * `api_key` is a literal key; `env_key` NAMES an arbitrary environment
 * variable to read the key from — which is why a fixed forbidden-env-name
 * list can never be sufficient on its own.
 */
export const GROK_CONFIG_CREDENTIAL_KEYS = ['api_key', 'env_key'] as const;

/**
 * Locate a credential-bearing key in `$GROK_HOME/config.toml`.
 *
 * Returns a LOCATION DESCRIPTOR (TOML section + key name) or null. It never
 * reads, returns, or logs a key VALUE — the caller only needs to know that a
 * key exists and where, and a value in an error message would leak straight
 * into a transcript.
 *
 * FAIL DIRECTION (deliberate, and the opposite of `isLoginPolicyVerified`'s):
 * that verifier answers "can I POSITIVELY confirm the policy is on?" and so
 * treats an unreadable file as unverified. This one answers "can I prove no
 * credential is present?" — so an existing-but-unreadable file is a REFUSAL,
 * because absence has not been shown. Only a genuinely ABSENT file is a clean
 * pass. Both fail toward not-running, which is the safe direction for a
 * billing control.
 *
 * Unlike a full TOML parse this scan is line-based, matching the sibling
 * verifier. That is weaker than the CLI's own parser, and deliberately so in
 * this direction: a shape this scanner mis-reads produces a FALSE POSITIVE
 * (a refusal to run), never a false negative that lets a key through.
 */
export function findConfigCredentialLocation(grokHome: string): string | null {
  const file = path.join(grokHome, 'config.toml');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    return 'config.toml (unreadable — cannot prove no credential is present)';
  }

  let section = '';
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    if (t.startsWith('[')) {
      section = t;
      continue;
    }
    const key = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=/.exec(t)?.[1];
    if (key && (GROK_CONFIG_CREDENTIAL_KEYS as readonly string[]).includes(key)) {
      return `${section === '' ? '(top level)' : section} ${key}`;
    }
  }
  return null;
}

/**
 * The CLI version every probed fact in the spec's evidence base was
 * gathered against. The deny list, envelope shape, and stopReason behavior
 * are pinned to it; drift is WARNED (never blocked — the CLI self-updates
 * and a version allowlist would brick the framework on routine patches).
 */
export const PROBED_GROK_VERSION = '1.0.4';

let _versionDriftWarned = false;
let _cachedVersionLine: string | null | undefined;
/**
 * Probe-failure state (round-9 adversarial — the FOURTH inertness mode).
 * A failed/timed-out `--version` used to memoize `null`, which
 * `emitDriftWarnIfNeeded` treats as "nothing to say" — so ONE transient 5s
 * timeout under host load permanently disarmed the only real trigger for the
 * §9 re-pin duty, silently, for the life of a process that runs for weeks. And
 * a binary whose `--version` regresses is itself the STRONGEST drift signal.
 * The safe direction for a warn-only detector is noise, not silence: warn, and
 * RE-ARM for a bounded number of retries so a transient failure self-heals.
 */
let _versionProbeFailures = 0;
const MAX_VERSION_PROBE_ATTEMPTS = 3;

/**
 * Read `grok --version` (cached per process; 5s bound; never throws) and
 * WARN LOUDLY when it differs from the probed pin — the REAL trigger for
 * the stall-matrix re-pin duty (lessons round-6: a duty whose only trigger
 * is a nonexistent detector is inert).
 */
export function checkGrokVersionDrift(grokPath: string): void {
  if (_versionDriftWarned || _cachedVersionLine !== undefined) {
    emitDriftWarnIfNeeded();
    return;
  }
  _cachedVersionLine = null; // claim the probe slot (single-flight)
  // NON-BLOCKING probe (scalability round-7): detection is a generic
  // availability surface a server-side consumer may call — a synchronous
  // subprocess spawn on it would block the event loop. Fire-and-forget;
  // the warn lands when the result arrives. TOP-LEVEL ESM import, never
  // `require` (security round-7: bare require in an ESM package throws a
  // ReferenceError the try would swallow — the canary would be silently
  // inert in the built output while passing CJS-transpiled tests).
  // Minimal clean env: the probe must not inherit a metered key.
  try {
    execFile(
      grokPath,
      ['--version'],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
      },
      (err, stdout) => {
        if (err) {
          onVersionProbeFailure(String((err as Error)?.message ?? err));
          return;
        }
        const line = String(stdout).trim();
        if (!line) {
          // FIFTH inertness mode (round-10, scalability): a probe that exits 0
          // with empty stdout — e.g. a CLI that prints its version to stderr —
          // used to cache `''`. That is `!== undefined`, so the single-flight
          // guard blocked every future probe while the emitter's falsy check
          // swallowed the warn: permanently, silently inert on the SUCCESS path
          // the round-9 fix did not cover. An empty version line is an
          // UNEXTRACTABLE one, and §4.1 says format drift is drift.
          onVersionProbeFailure('empty --version output');
          return;
        }
        _cachedVersionLine = line;
        emitDriftWarnIfNeeded();
      },
    );
  } catch (err) {
    onVersionProbeFailure(String((err as Error)?.message ?? err));
  }
}

/**
 * A probe that could not produce a version line is UNVERIFIED drift, not
 * "no drift". Warn once per failure and re-arm (bounded) so a transient
 * timeout retries instead of permanently disarming the canary.
 */
function onVersionProbeFailure(reason: string): void {
  _versionProbeFailures += 1;
  const exhausted = _versionProbeFailures >= MAX_VERSION_PROBE_ATTEMPTS;
  console.warn(
    `[grok-build] VERSION PROBE FAILED (${_versionProbeFailures}/${MAX_VERSION_PROBE_ATTEMPTS}): ` +
      `could not read the installed CLI version (${reason}) — drift against the pinned ` +
      `evidence base ${PROBED_GROK_VERSION} is UNVERIFIED` +
      (exhausted
        ? ', and no further probes will run this process (grok-build spec §4.1/§9)'
        : '; a later detection will retry'),
  );
  // Exhausted ⇒ stay claimed (`null`) so we stop spawning; otherwise un-claim
  // the single-flight slot so the next detection re-probes.
  _cachedVersionLine = exhausted ? null : undefined;
}

function emitDriftWarnIfNeeded(): void {
  if (_versionDriftWarned) return;
  if (!_cachedVersionLine) return;
  // Token EQUALITY, never substring: `includes('1.0.4')` silently accepts
  // 1.0.40–1.0.49 / 1.0.4-rc.1 — exactly the routine self-update patch class
  // this canary exists to catch (round-8 security finding; third inertness
  // mode in this detector after the round-6 nonexistent probe and the
  // round-7 ESM require). An unextractable version line is ALSO drift —
  // format drift is drift.
  const m = _cachedVersionLine.match(/\b(\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.]+)?)\b/);
  if (!m || m[1] !== PROBED_GROK_VERSION) {
    _versionDriftWarned = true;
    console.warn(
      `[grok-build] VERSION DRIFT: installed CLI reports "${_cachedVersionLine}" but the ` +
        `evidence base is pinned to ${PROBED_GROK_VERSION} — re-verify the tool deny list ` +
        `and envelope shape (stall-matrix re-pin duty, grok-build spec §4.1/§9)`,
    );
  }
}

/**
 * The current version-drift advisory, or null when the canary is quiet.
 *
 * Round-10 (external): a warn-only detector whose ONLY output is a
 * `console.warn` reaches nobody — the operator reads convergence REPORTS, not
 * server logs, and this canary has already shipped four distinct inertness
 * modes. Surfacing the note in the reviewer's own finding puts the signal in
 * the artifact a human actually opens. Still SIGNAL-ONLY: it never blocks a
 * review, and the reviewer's verdict is untouched.
 */
export function getGrokVersionDriftNote(): string | null {
  if (_versionProbeFailures > 0 && !_cachedVersionLine) {
    return (
      `grok CLI version could not be read (${_versionProbeFailures} failed probe(s)) — ` +
      `drift against the pinned evidence base ${PROBED_GROK_VERSION} is UNVERIFIED`
    );
  }
  if (_versionDriftWarned && _cachedVersionLine) {
    return (
      `grok CLI reports "${_cachedVersionLine}" but this spec's evidence base is pinned to ` +
      `${PROBED_GROK_VERSION} — re-verify the tool deny list and envelope shape ` +
      `(stall-matrix re-pin duty)`
    );
  }
  return null;
}

/** Test-only: reset the version-drift memo. */
export function _resetGrokVersionDriftForTest(): void {
  _versionDriftWarned = false;
  _cachedVersionLine = undefined;
  _versionProbeFailures = 0;
}

/**
 * Assert the auth state is safe for a subscription-billed run. Throws
 * GrokApiKeyForbiddenError / GrokSessionExpiredError; returns void when safe.
 *
 * Every call-construction path (one-shot AND agentic) enforces this before
 * spawning — not just one face of the adapter.
 */
export function assertGrokAuthAllowed(
  config: GrokBuildConfig,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  /**
   * The call's WORST-CASE RUNWAY: its timeout PLUS any pre-spawn acquire
   * budget (the reference caller, oneShotCompletion, passes
   * `timeoutMs + resolveSpawnAcquireMs()`). The admission margin is
   * max(SESSION_EXPIRY_MARGIN_MS, this) so no admitted call can outlive
   * its session — a direct caller passing the bare timeout re-opens the
   * mid-call-expiry window (lessons round-7).
   */
  callTimeoutMs = 0,
): void {
  for (const name of GROK_FORBIDDEN_ENV_VARS) {
    if (env[name] !== undefined && env[name] !== '') {
      throw new GrokApiKeyForbiddenError(name);
    }
  }

  // ROUND-21: the env sweep above cannot see a key in the CLI's own config
  // file, and the vendor ranks a config-file `api_key` ABOVE the session
  // token. The login policy below is the compensating control for exactly
  // this class, but it is an undocumented flag whose scope has never been
  // measured against a config-file key — so it is not something to rest a
  // billing guarantee on alone. Refuse on presence, the same way the env
  // sweep does, rather than trusting one unverified flag to neutralise it.
  const credentialLocation = findConfigCredentialLocation(config.grokHome);
  if (credentialLocation !== null) {
    throw new GrokConfigCredentialForbiddenError(credentialLocation);
  }

  // PRIMARY-CONTROL CHECK AT THE CHOKEPOINT (adversarial round-4 finding 2):
  // the vendor login policy is re-verified on EVERY call construction — one
  // cheap file read — not only at reviewer detection. Belt-and-suspenders
  // with buildGrokChildEnv's unconditional env lockdown injection.
  if (!isLoginPolicyVerified(config.grokHome, env)) {
    throw new GrokLoginPolicyUnverifiedError(config.grokHome);
  }

  const authFile = grokAuthPath(config.grokHome);
  if (!fs.existsSync(authFile)) {
    throw new GrokSessionExpiredError('no auth file — not logged in');
  }

  const { expiry, refreshable } = readSessionAuthState(authFile);
  if (expiry === null) {
    // Unreadable/malformed/no-expiry auth: fail CLOSED. "File exists" is not
    // "session active", and an unparseable file is indistinguishable from a
    // corrupt or foreign-format one. Unchanged by round-22: a file we cannot
    // parse tells us nothing about renewability either, so there is no
    // recoverable case to admit here.
    throw new GrokSessionExpiredError('auth file present but no parseable expiry');
  }
  const effectiveMargin = Math.max(SESSION_EXPIRY_MARGIN_MS, callTimeoutMs);
  if (expiry.getTime() - effectiveMargin <= now.getTime()) {
    // ROUND-22 — the refusal is NARROWED, not removed. See readSessionAuthState
    // for the measurement and for why admitting here opens no billing hole.
    //
    // Recoverable (a renewal credential on the winning entry): admit. The CLI
    // renews on the way through, which is the only thing that ever renews it —
    // refusing here is what kept the session lapsed. If the renewal fails, the
    // child still runs with the forced api-key kill switch and a scrubbed env,
    // so the outcome is a bounded auth error rather than a metered call.
    //
    // Terminal (nothing to renew from): refuse exactly as before, and say WHY,
    // because this is the case where a human genuinely must re-authenticate.
    if (!refreshable) {
      throw new GrokSessionExpiredError(
        `session expired or expiring within ${Math.round(effectiveMargin / 1000)}s ` +
          `(expiry ${expiry.toISOString()}) and carries no renewal credential — re-login required`,
      );
    }
  }
}
