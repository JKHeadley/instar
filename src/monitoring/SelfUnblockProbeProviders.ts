/**
 * SelfUnblockProbeProviders — the PRODUCTION probe providers that wire
 * SelfUnblockChecklist to the real world. This is the PRODUCER half of
 * "Self-Unblock Before Escalating" (docs/specs/self-unblock-before-escalating.md):
 * SelfUnblockChecklist (the runner), DurableVaultSession (the warm org-vault
 * session), and BlockerLedger (the verifier) already exist — but until this file
 * NOTHING in production instantiates the checklist with REAL providers, so a
 * credential-blocker could never be settled (the gate demands a run that could
 * not be produced). This closes that gap.
 *
 * The checklist runner owns the deterministic relevance match and the per-class
 * timeout; a provider's ONLY job is to (a) reach its source and (b) report the
 * NON-SECRET scope tags that source ADVERTISES, so the runner can match them.
 *
 * HARD SAFETY RULES (a violation is a bug — the prior incident spiked machine
 * load to ~70 from a recursive grep; never repeat that):
 *   (a) A provider NEVER returns or logs a secret VALUE. It returns ONLY
 *       `{ reachable, advertisedScopeTags?, detail? }`, where advertisedScopeTags
 *       are non-secret scope strings (zone/project/service names).
 *   (b) Each provider does AT MOST ONE bounded call — a single CLI exec with a
 *       small explicit timeout, or a single fetch. NEVER a recursive/unbounded
 *       filesystem scan or `grep -r` over a large tree. The runner's per-class
 *       timeout is the backstop; every execFile here ALSO carries its own timeout.
 *   (c) Relevance is OPERATOR-DECLARED + fail-closed. A provider NEVER infers
 *       which credential is relevant; advertised scope tags come from the
 *       `credentialScopeTags` config map (keyed by source name and/or vault key).
 *       A source with no declared tags advertises an EMPTY tag list → the runner's
 *       `relevantScopeTags` never matches it → it is never surfaced. Nothing
 *       declared ⇒ every probe non-matching ⇒ runs exhaust ⇒ behaves like today
 *       (under-self-unblock, never mis-apply — the safe direction).
 *
 * Everything external is INJECTED via `deps`, so unit tests never shell out.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type { ExecFileOptions } from 'node:child_process';
import type { DurableVaultSession } from './DurableVaultSession.js';
import type {
  ProbeProvider,
  ProbeProviders,
  ProbeProviderResult,
  SelfUnblockProbeSource,
} from './SelfUnblockChecklist.js';
import { SELF_UNBLOCK_PROBE_SOURCES } from './SelfUnblockChecklist.js';

// ─── Bounded execFile (injectable) ──────────────────────────────────────────────

/**
 * The result of a single bounded child-process call. `code` 0 = success.
 * `stdout` is the captured output (a provider parses NON-SECRET tags from it; it
 * MUST NOT return raw stdout as a tag without scrubbing).
 */
export interface BoundedExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * A single, timeout-bounded `execFile`. Always pass an explicit `timeoutMs`
 * (rule (b)) — never rely on the runner's class timeout alone. Returns a
 * non-throwing result (a non-zero exit is `{ code: !=0 }`, not an exception) so
 * a provider stays a single bounded call with no surprise rejections.
 */
export type ExecFileBounded = (
  file: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<BoundedExecResult>;

/** The default bounded execFile — one child process, hard timeout, captured output. */
export const defaultExecFileBounded: ExecFileBounded = (file, args, opts) =>
  new Promise<BoundedExecResult>((resolve) => {
    const execOpts: ExecFileOptions = {
      timeout: opts.timeoutMs,
      // Bound the captured output so a chatty CLI can never blow up memory.
      maxBuffer: 1024 * 1024,
      env: opts.env,
    };
    execFile(file, args, execOpts, (err, stdout, stderr) => {
      const e = err as
        | (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string })
        | null;
      const timedOut = !!e && (e.killed === true || e.signal === 'SIGTERM');
      // execFile's `error.code` is the EXIT code (number) on a non-signal exit.
      const code =
        e == null ? 0 : typeof e.code === 'number' ? e.code : timedOut ? null : 1;
      resolve({
        code,
        stdout: typeof stdout === 'string' ? stdout : stdout?.toString?.() ?? '',
        stderr: typeof stderr === 'string' ? stderr : stderr?.toString?.() ?? '',
        timedOut,
      });
    });
  });

// ─── Dependencies (all external access injected) ────────────────────────────────

export interface SelfUnblockProbeDeps {
  /**
   * OPERATOR-DECLARED scope tags, keyed by source name (e.g. `org-bitwarden`,
   * `cloud-vercel`) AND/OR by vault key name. A source with no entry advertises an
   * EMPTY tag list → it is never surfaced (rule (c), fail-closed). The values are
   * non-secret `service:scope` strings (e.g. `["cloudflare:dawn-tunnel.dev"]`).
   */
  credentialScopeTags?: Record<string, string[]>;
  /**
   * The flag-gated warm org-Bitwarden session (§5.3). When absent the org-vault
   * probe reports unreachable with a clear detail (never a throw-stub).
   */
  durableVaultSession?: DurableVaultSession;
  /**
   * Returns the NAMES of secrets in the agent's own vault (NEVER values). Used by
   * the own-vault probe to decide reachability + which declared tags to advertise.
   * Absent (or a thrown read) → own-vault reports unreachable, fail-closed.
   */
  getVaultKeys?: () => string[];
  /**
   * Returns the Cloudflare API token VALUE for the single bounded zones fetch, or
   * null when none is configured. The VALUE is used in-process only (an
   * Authorization header) — NEVER logged, NEVER returned. Absent/null → the
   * cloudflare probe reports unreachable.
   */
  getCloudflareToken?: () => string | null;
  /** Injectable bounded execFile (tests pass a fake; production uses the default). */
  execFileBounded?: ExecFileBounded;
  /** Injectable fetch (tests pass a fake; production uses global fetch). */
  fetchImpl?: typeof fetch;
  /**
   * Absolute path of the per-agent owned-identities registry
   * (`.instar/owned-identities.json`) — identities the agent ITSELF provisioned
   * (test users, service accounts, workspace owners), each carrying explicit
   * non-secret `scopeTags` and a credential POINTER (`credentialRef`), never a
   * value. Absent → the owned-identities probe reports unreachable, fail-closed.
   * Spec: docs/specs/correction-derived-hardening.md (the 2026-07-18 gap: an
   * exhaustion verdict that never consulted identities the agent created).
   */
  ownedIdentitiesPath?: string;
  /** Injectable file reader for the owned-identities registry (tests pass a fake). */
  readFileUtf8?: (path: string, maxBytes: number) => string;
  /**
   * Injectable existence check for owned-identities credentialRef LIVENESS
   * (a stat, never a read — no value is ever touched). Tests pass a fake;
   * production uses fs.existsSync.
   */
  fileExists?: (path: string) => boolean;
}

// ─── Tag helpers (fail-closed) ──────────────────────────────────────────────────

/**
 * The operator-declared tags for a key (source name or vault key). Returns an
 * EMPTY array when nothing is declared — the fail-closed default (rule (c)). Only
 * non-empty string tags survive (a malformed entry can never advertise a tag).
 */
function declaredTags(deps: SelfUnblockProbeDeps, key: string): string[] {
  const raw = deps.credentialScopeTags?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
}

/** Remote CLI/network probe budget for an injected exec (the runner also class-bounds). */
const REMOTE_EXEC_MS = 10_000;

// ─── The ten providers ──────────────────────────────────────────────────────────

/** 1. own-vault — the agent's own per-agent vault (names only, never values). */
function ownVaultProvider(deps: SelfUnblockProbeDeps): ProbeProvider {
  return async (): Promise<ProbeProviderResult> => {
    if (typeof deps.getVaultKeys !== 'function') {
      return { reachable: false, detail: 'own-vault key listing not wired' };
    }
    let keys: string[];
    try {
      keys = deps.getVaultKeys();
    } catch {
      // @silent-fallback-ok — a vault read failure is reported as unreachable; never a value leaks.
      return { reachable: false, detail: 'own-vault unreadable (locked or decrypt-failed)' };
    }
    if (!Array.isArray(keys)) {
      return { reachable: false, detail: 'own-vault returned no key list' };
    }
    // Advertise the operator-declared tags for the source AND for each present
    // vault key (so an operator can scope a tag to a specific key). Never a value.
    const tags = new Set<string>(declaredTags(deps, 'own-vault'));
    for (const key of keys) {
      if (typeof key === 'string') for (const t of declaredTags(deps, key)) tags.add(t);
    }
    return {
      reachable: true,
      advertisedScopeTags: [...tags],
      detail: `own-vault reachable (${keys.length} key${keys.length === 1 ? '' : 's'})`,
    };
  };
}

/**
 * 1b. owned-identities — identities the agent ITSELF provisioned, from the
 * per-agent registry `.instar/owned-identities.json` (spec:
 * correction-derived-hardening). The registry is agent/operator-AUTHORED
 * declaration data — the same trust class as `credentialScopeTags` (rule (c)):
 * advertised tags are EXACTLY the union of each valid entry's explicit
 * `scopeTags` strings. No inference from service/identity names, and NO other
 * entry field is ever read into the result — an entry carrying a stray
 * password/token-shaped field can never leak it into tags or detail. Missing,
 * unreadable, oversized, malformed, or non-array registry → unreachable
 * (fail-closed, mirrors own-vault).
 */
const OWNED_IDENTITIES_MAX_BYTES = 256 * 1024;
/** Hard bound on entries PROCESSED per probe run — rule (b): never an unbounded loop. */
const OWNED_IDENTITIES_MAX_ENTRIES = 500;
/**
 * Per-string clamp for anything read OUT of the registry (names/tags). The
 * registry is agent-authored but its strings flow into the settle authority's
 * untrusted-data envelope; clamp + control-char strip so an oversized/crafted
 * string can never ride the probe result (round-1 security finding).
 */
const OWNED_IDENTITIES_MAX_STRING = 128;

function clampRegistryString(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, OWNED_IDENTITIES_MAX_STRING);
}

interface OwnedIdentityEntry {
  identity?: unknown;
  service?: unknown;
  scopeTags?: unknown;
  credentialRef?: unknown;
}

/**
 * LIVENESS GATE (second-pass review, 2026-07-18): an entry advertises its tags
 * ONLY when its `credentialRef` pointer RESOLVES right now — `file:<path>` must
 * stat (path relative to the agent home when not absolute; any `#fragment` is
 * ignored), `vault:<key>` must be a present vault key NAME. A missing ref, an
 * unknown scheme, or a dangling pointer contributes NOTHING (fail-closed).
 * Without this, a STALE entry could advertise a phantom credential forever —
 * `holdsRelevantCred:true` → `exhausted:false` → BlockerLedger refuses the
 * true-blocker settle → the agent can never escalate: static declaration would
 * hold blocking authority over the escalation path. The stat/name-presence
 * check mirrors own-vault's live-presence gate and reads NO secret value.
 */
function credentialRefResolves(
  deps: SelfUnblockProbeDeps,
  ref: unknown,
  agentHomeDir: string,
  statCache: Map<string, boolean>,
): boolean {
  if (typeof ref !== 'string' || ref.trim().length === 0) return false;
  const exists = deps.fileExists ?? ((p: string): boolean => fs.existsSync(p));
  if (ref.startsWith('file:')) {
    const rawPath = ref.slice('file:'.length).split('#')[0].trim();
    if (rawPath.length === 0) return false;
    // JAIL (round-1 security finding): refs resolve ONLY inside the agent home —
    // an absolute path outside it, or a `..` traversal escaping it, never
    // resolves. The liveness bar is honestly WEAK (existence of the pointed-to
    // file, not credential validity); the jail keeps it from being satisfiable
    // by arbitrary host files like /etc/hosts.
    const resolved = rawPath.startsWith('/') ? rawPath : `${agentHomeDir}/${rawPath}`;
    const segments = resolved.split('/').reduce<string[]>((acc, seg) => {
      if (seg === '..') acc.pop();
      else if (seg !== '.' && seg !== '') acc.push(seg);
      return acc;
    }, []);
    const normalizedPath = `/${segments.join('/')}`;
    const home = agentHomeDir.endsWith('/') ? agentHomeDir : `${agentHomeDir}/`;
    if (!normalizedPath.startsWith(home)) return false;
    const cached = statCache.get(normalizedPath);
    if (cached !== undefined) return cached;
    let ok: boolean;
    try {
      ok = exists(normalizedPath);
    } catch {
      // @silent-fallback-ok — a stat failure means the ref does not resolve (fail-closed).
      ok = false;
    }
    statCache.set(normalizedPath, ok);
    return ok;
  }
  if (ref.startsWith('vault:')) {
    const key = ref.slice('vault:'.length).trim();
    if (key.length === 0 || typeof deps.getVaultKeys !== 'function') return false;
    try {
      return deps.getVaultKeys().includes(key);
    } catch {
      // @silent-fallback-ok — an unreadable vault cannot confirm liveness (fail-closed).
      return false;
    }
  }
  // Unknown scheme → unverifiable → never advertised (fail-closed).
  return false;
}

function ownedIdentitiesProvider(deps: SelfUnblockProbeDeps): ProbeProvider {
  return async (): Promise<ProbeProviderResult> => {
    const regPath = deps.ownedIdentitiesPath;
    if (typeof regPath !== 'string' || regPath.trim().length === 0) {
      return { reachable: false, detail: 'owned-identities registry path not wired' };
    }
    let raw: string;
    try {
      const read = deps.readFileUtf8 ?? defaultReadFileUtf8;
      raw = read(regPath, OWNED_IDENTITIES_MAX_BYTES);
    } catch {
      // @silent-fallback-ok — missing/unreadable/oversized registry → unreachable (fail-closed).
      return { reachable: false, detail: 'owned-identities registry absent or unreadable' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // PRESENT-but-unparseable is the silent-recurrence trap (round-1 adversarial
      // finding: fail-closed here re-creates the founding wrong-escalation bug with
      // no signal). Loud server-log line — bounded, no content — so the breakage is
      // visible outside the probe detail.
      console.warn('[self-unblock] owned-identities registry PRESENT but not valid JSON — probe advertising nothing (fix or remove the file)');
      return { reachable: false, detail: 'owned-identities registry PRESENT but not valid JSON — fix or remove it' };
    }
    if (!Array.isArray(parsed)) {
      console.warn('[self-unblock] owned-identities registry PRESENT but root is not an array — probe advertising nothing');
      return { reachable: false, detail: 'owned-identities registry PRESENT but root is not an array — fix or remove it' };
    }
    // The registry lives at <agentHome>/.instar/owned-identities.json → the agent
    // home (the base + jail for relative file: refs) is two levels up.
    const agentHomeDir = regPath.split('/').slice(0, -2).join('/') || '/';
    const statCache = new Map<string, boolean>();
    const tags = new Set<string>();
    const liveNames: string[] = [];
    let skipped = 0;
    let truncated = 0;
    const entries = parsed as OwnedIdentityEntry[];
    for (let i = 0; i < entries.length; i++) {
      // Rule (b): a bounded loop — beyond the cap, entries are COUNTED, not processed.
      if (i >= OWNED_IDENTITIES_MAX_ENTRIES) {
        truncated = entries.length - OWNED_IDENTITIES_MAX_ENTRIES;
        break;
      }
      const entry = entries[i];
      if (entry == null || typeof entry !== 'object') continue;
      // ONLY identity (a NAME), scopeTags, and the credentialRef POINTER (for a
      // stat/name-presence liveness check — never a value read) are consulted.
      // Every other field — note, roles, or anything password-shaped someone
      // mistakenly stored — stays in the file. Strings are clamped + control-
      // char-stripped before they can ride the result.
      const hasIdentity = typeof entry.identity === 'string' && entry.identity.trim().length > 0;
      if (!credentialRefResolves(deps, entry.credentialRef, agentHomeDir, statCache)) {
        if (hasIdentity || Array.isArray(entry.scopeTags)) skipped += 1;
        continue;
      }
      if (hasIdentity) liveNames.push(clampRegistryString(entry.identity as string));
      if (Array.isArray(entry.scopeTags)) {
        for (const t of entry.scopeTags) {
          if (typeof t === 'string' && t.trim().length > 0) tags.add(clampRegistryString(t));
        }
      }
    }
    const truncNote = truncated > 0 ? `; ${truncated} beyond the ${OWNED_IDENTITIES_MAX_ENTRIES}-entry cap not processed` : '';
    if (liveNames.length === 0 && tags.size === 0) {
      return {
        reachable: false,
        detail: `owned-identities registry has no live entries${skipped > 0 ? ` (${skipped} skipped: unverifiable credentialRef)` : ''}${truncNote}`,
      };
    }
    return {
      reachable: true,
      advertisedScopeTags: [...tags],
      detail: `owned-identities registry: ${liveNames.length} live identit${liveNames.length === 1 ? 'y' : 'ies'}${liveNames.length > 0 ? ` (${liveNames.slice(0, 5).join(', ')}${liveNames.length > 5 ? ', …' : ''})` : ''}${skipped > 0 ? `; ${skipped} skipped (unverifiable credentialRef)` : ''}${truncNote}`,
    };
  };
}

/** Default bounded UTF-8 file read for the owned-identities registry (size-capped BEFORE reading). */
function defaultReadFileUtf8(filePath: string, maxBytes: number): string {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    throw new Error(`owned-identities registry exceeds ${maxBytes} bytes`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

/** 2. org-bitwarden — the org vault via the warm DurableVaultSession (§5.3). */
function orgBitwardenProvider(deps: SelfUnblockProbeDeps): ProbeProvider {
  const exec = deps.execFileBounded ?? defaultExecFileBounded;
  return async (): Promise<ProbeProviderResult> => {
    const dvs = deps.durableVaultSession;
    if (!dvs) {
      return { reachable: false, detail: 'durable vault session not wired' };
    }
    // The session value is handed to the child via BW_SESSION env ONLY — NEVER as
    // an argv token (argv is visible in `ps`). A single bounded `bw list items`
    // proves reachability; we do NOT parse item secrets — the advertised tags come
    // from the operator-declared map.
    const result = await dvs.withSession(async (session) => {
      return exec(
        'bw',
        ['list', 'items'],
        { timeoutMs: REMOTE_EXEC_MS, env: { ...process.env, BW_SESSION: session } },
      );
    });
    if (result == null) {
      // No session could be derived (vault locked / master pw unavailable).
      return { reachable: false, detail: 'org-bitwarden vault could not be unlocked' };
    }
    if (result.code !== 0) {
      return {
        reachable: false,
        detail: result.timedOut ? 'org-bitwarden probe timed out' : 'org-bitwarden list failed',
      };
    }
    return {
      reachable: true,
      advertisedScopeTags: declaredTags(deps, 'org-bitwarden'),
      detail: 'org-bitwarden reachable (warm session)',
    };
  };
}

/** 3b. cloud-cloudflare — ONE bounded zones fetch; map zone names → tags. */
function cloudCloudflareProvider(deps: SelfUnblockProbeDeps): ProbeProvider {
  const doFetch = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  return async (): Promise<ProbeProviderResult> => {
    const token = deps.getCloudflareToken?.() ?? null;
    if (!token) {
      return { reachable: false, detail: 'no cloudflare token configured' };
    }
    if (!doFetch) {
      return { reachable: false, detail: 'fetch unavailable for cloudflare probe' };
    }
    // ONE bounded fetch. The token VALUE rides the Authorization header in-process
    // ONLY — never logged, never returned.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_EXEC_MS);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    try {
      const resp = await doFetch('https://api.cloudflare.com/client/v4/zones?per_page=50', {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      if (!resp.ok) {
        return { reachable: false, detail: `cloudflare zones returned HTTP ${resp.status}` };
      }
      const body = (await resp.json()) as { result?: Array<{ name?: unknown }> };
      const zoneTags: string[] = [];
      if (Array.isArray(body?.result)) {
        for (const z of body.result) {
          if (z && typeof z.name === 'string' && z.name.trim()) {
            zoneTags.push(`cloudflare:${z.name.trim().toLowerCase()}`);
          }
        }
      }
      // Union the live zone tags with any operator-declared cloudflare tags.
      const tags = new Set<string>([...declaredTags(deps, 'cloud-cloudflare'), ...zoneTags]);
      return {
        reachable: true,
        advertisedScopeTags: [...tags],
        detail: `cloudflare reachable (${zoneTags.length} zone${zoneTags.length === 1 ? '' : 's'})`,
      };
    } catch {
      // @silent-fallback-ok — a network/abort failure is reported as unreachable; no token leaks.
      return { reachable: false, detail: 'cloudflare probe failed or timed out' };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** A CLI-reachability probe (single bounded exec; success → declared tags). */
function cliReachabilityProvider(
  deps: SelfUnblockProbeDeps,
  source: SelfUnblockProbeSource,
  file: string,
  args: string[],
  timeoutMs: number,
  label: string,
): ProbeProvider {
  const exec = deps.execFileBounded ?? defaultExecFileBounded;
  return async (): Promise<ProbeProviderResult> => {
    let result: BoundedExecResult;
    try {
      result = await exec(file, args, { timeoutMs });
    } catch {
      // @silent-fallback-ok — exec rejection (e.g. ENOENT) → unreachable.
      return { reachable: false, detail: `${label} not available` };
    }
    if (result.code !== 0) {
      return {
        reachable: false,
        detail: result.timedOut ? `${label} probe timed out` : `${label} not authenticated`,
      };
    }
    return {
      reachable: true,
      advertisedScopeTags: declaredTags(deps, source),
      detail: `${label} reachable`,
    };
  };
}

/**
 * 3d / 4 / 5 / 6 — sources with no cheap live check beyond "are tags declared?".
 * These are HONEST presence checks (rule: real, not throw-stubs): the source is
 * "reachable" iff the operator declared at least one tag for it (an operator
 * declaring a tag IS the assertion that the credential lives there); otherwise it
 * reports unreachable with a clear, source-specific detail. No shell-out, no scan.
 */
function declaredPresenceProvider(
  deps: SelfUnblockProbeDeps,
  source: SelfUnblockProbeSource,
  notApplicableDetail: string,
): ProbeProvider {
  return async (): Promise<ProbeProviderResult> => {
    const tags = declaredTags(deps, source);
    if (tags.length === 0) {
      return { reachable: false, detail: notApplicableDetail };
    }
    return {
      reachable: true,
      advertisedScopeTags: tags,
      detail: `${source} has operator-declared scope tags`,
    };
  };
}

// ─── Org-Bitwarden session derivation (testable wiring) ─────────────────────────

/** The minimal BitwardenProvider surface the session derivation needs. */
export interface BitwardenUnlockSurface {
  unlock(masterPassword: string): boolean;
  getSessionKey(): string | null;
}

/**
 * Derive a fresh org-Bitwarden session value for `DurableVaultSession.deriveSession`,
 * TESTABLY. The AgentServer closure that wires this is otherwise untestable — which
 * is exactly how a `process.env.BW_SESSION` read (wrong: `unlock()` stores the
 * session in a PRIVATE field, never the env) slipped past the injected-fake tests.
 *
 * Reads the operator-held master password from the agent's own vault (an EXISTING
 * key — no new on-disk secret) via the injected getter, unlocks via the injected
 * BitwardenProvider surface, and returns the live session from `getSessionKey()`.
 * The password and the session are used in-process ONLY and NEVER logged or returned
 * through any other surface.
 */
export function deriveBitwardenSession(opts: {
  getMasterPassword: () => string | null;
  bw: BitwardenUnlockSurface;
}): string | null {
  let masterPw: string | null;
  try {
    masterPw = opts.getMasterPassword();
  } catch {
    // @silent-fallback-ok — no/locked vault → no master pw → no session.
    masterPw = null;
  }
  if (typeof masterPw !== 'string' || masterPw.length === 0) return null;
  if (!opts.bw.unlock(masterPw)) return null;
  const session = opts.bw.getSessionKey();
  return typeof session === 'string' && session.length > 0 ? session : null;
}

/**
 * Build the full production provider set — a REAL provider for EVERY one of the 10
 * sources in `SELF_UNBLOCK_PROBE_SOURCES`. No source is left unwired.
 */
export function buildProductionProbeProviders(deps: SelfUnblockProbeDeps): ProbeProviders {
  const providers: Required<Record<SelfUnblockProbeSource, ProbeProvider>> = {
    'own-vault': ownVaultProvider(deps),
    'owned-identities': ownedIdentitiesProvider(deps),
    'org-bitwarden': orgBitwardenProvider(deps),
    'cloud-vercel': cliReachabilityProvider(
      deps,
      'cloud-vercel',
      'vercel',
      ['whoami'],
      REMOTE_EXEC_MS,
      'vercel',
    ),
    'cloud-cloudflare': cloudCloudflareProvider(deps),
    'cloud-github': cliReachabilityProvider(
      deps,
      'cloud-github',
      'gh',
      ['auth', 'status'],
      REMOTE_EXEC_MS,
      'gh',
    ),
    'cloud-launchd': declaredPresenceProvider(
      deps,
      'cloud-launchd',
      'no launchd-managed credential declared for this target',
    ),
    'mcp-tools': declaredPresenceProvider(
      deps,
      'mcp-tools',
      'no MCP-tool credential declared for this target',
    ),
    'browser-playwright': declaredPresenceProvider(
      deps,
      'browser-playwright',
      'no browser/Playwright session credential declared for this target',
    ),
    'controlled-resource': declaredPresenceProvider(
      deps,
      'controlled-resource',
      'no already-controlled resource declared for this target',
    ),
  };

  // Defensive: assert coverage so a future taxonomy addition can never leave a
  // source silently unwired (the gap this whole file closes).
  for (const source of SELF_UNBLOCK_PROBE_SOURCES) {
    if (typeof providers[source] !== 'function') {
      throw new Error(`buildProductionProbeProviders: no provider for source '${source}'`);
    }
  }

  return providers;
}
