/**
 * PlaywrightProfileRegistry — the durable per-agent map of which Playwright
 * browser PROFILE holds which logged-in ACCOUNT, plus the compact boot-awareness
 * surface and the shared playwright-MCP-config resolver.
 *
 * Spec: docs/specs/playwright-profile-registry.md (converged + approved 2026-06-15).
 *
 * Three honesty disciplines are load-bearing (see spec Frontloaded Decisions):
 *   - STALENESS (D11): a login claim renders its age and is advisory, never authority.
 *   - PROVENANCE (D12/D20): every account carries an owner (agent|operator) and every
 *     write is auditable; the operator's account is flagged loud in the block.
 *   - FAIL-TOWARD-TRUTH (D15/D17): refs are re-checked on read, a dead profile dir is
 *     surfaced, a corrupt file is never silently overwritten.
 *
 * SECURITY INVARIANTS:
 *   - D3 — NO secret VALUE is ever stored, returned, injected, or resolved. Only vault
 *     secret NAMES. This module NEVER calls SecretStore.read() to obtain a value — the
 *     injected `listVaultNames` returns NAMES only.
 *   - D9 — a supplied userDataDir is path-jailed: resolved, absolute, confined under the
 *     agent home, never flag-shaped, no NUL.
 *   - D16 — every field rendered into the boot block passes through sanitizeForBlock so
 *     an envelope breakout is structurally impossible.
 *
 * NOTE: request-driven; no background loop → NO GUARD_MANIFEST entry. The state file is
 * machine-local BY DESIGN (D6) — a browser session lives in cookies on one disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// Reuse the EXACT boot-block sanitizer (control-char/ANSI strip + angle-bracket escape
// + backtick neutralize) so the two boot surfaces can never drift (D16).
import { sanitizeForBlock } from './BootSelfKnowledge.js';

// ── Types (D-model) ──────────────────────────────────────────────────────────

/** How the account is authenticated in the browser profile. */
export type PlaywrightLoginMethod =
  | 'session-cookie'
  | 'password'
  | 'password+totp'
  | 'password+phone-2fa'
  | 'oauth-token'
  | 'unknown';

/** Who owns the account — Know Your Principal (D12). Advisory self-assertion, audited. */
export type PlaywrightAccountOwner = 'agent' | 'operator';

/** One account a profile is responsible for. Credentials are referenced by vault NAME only. */
export interface PlaywrightAccount {
  /** Service the account belongs to (e.g. 'github', 'google'). Clamped 64, sanitized on render. */
  service: string;
  /** The account login/handle (e.g. 'EchoOfDawn'). Clamped 128, sanitized on render. */
  identity: string;
  /** 'agent' | 'operator' — REQUIRED, rendered loud in the block (D12). */
  owner: PlaywrightAccountOwner;
  /** Vault secret NAMES only — NEVER values (D3). */
  vaultRefs: string[];
  /** Login method enum. */
  loginMethod: PlaywrightLoginMethod;
  /** Last-KNOWN session state — advisory, NOT a guarantee (D11). */
  lastAsserted: boolean;
  /** ISO timestamp or null; the block renders its AGE, never a bare "logged-in" (D11). */
  lastVerifiedAt: string | null;
  /** Free note. Clamped 256, sanitized on render. */
  note: string;
}

/** One browser profile (a physical user-data-dir on this machine's disk). */
export interface PlaywrightProfile {
  /** ^[a-z0-9-]{1,64}$, unique. */
  id: string;
  /** null = Playwright MCP's built-in default location; else an ABSOLUTE path jailed to the agent home (D2/D9). */
  userDataDir: string | null;
  /** Clamped 256, sanitized on render. */
  description: string;
  isDefault: boolean;
  createdAt: string;
  accounts: PlaywrightAccount[];
}

interface RegistryFile {
  version: 1;
  profiles: PlaywrightProfile[];
}

/** Result of locating the canonical playwright MCP server entry. */
export interface ResolvedPlaywrightMcpConfig {
  /** Absolute path to the file the entry lives in. */
  file: string;
  /** The raw mcpServers.playwright entry object. */
  entry: Record<string, unknown>;
  /** The resolved --user-data-dir value, or null if the arg is absent (the common case — D10). */
  userDataDir: string | null;
}

/** A resolve() outcome. */
export interface PlaywrightResolveResult {
  profile: PlaywrightProfile | null;
  /** True when a service-only fallback matched more than one profile (D18). */
  ambiguous?: boolean;
  candidates?: Array<{ id: string; identities: string[] }>;
  /** Is the resolved profile's userDataDir physically present on this machine? null userDataDir → built-in present. */
  dirExists?: boolean;
}

/** A listProfiles() row — the FULL detail surface (GET-only), with dangling-ref flags (D17). */
export interface PlaywrightProfileDetail extends PlaywrightProfile {
  dirExists: boolean;
  accounts: Array<PlaywrightAccount & { danglingRefs: string[] }>;
}

/** The computed (not-yet-applied) activation mutation for a profile (D10). */
export interface PlaywrightActivationPlan {
  profileId: string;
  /** The authoritative config file the MCP loads. */
  file: string;
  /** The args array AFTER the mutation (what writeActivation would persist). */
  nextArgs: string[];
  /** Target userDataDir (null = default profile → arg removed). */
  userDataDir: string | null;
  /** Is the target dir physically present? (null userDataDir → built-in present.) */
  dirExists: boolean;
  /** True when the canonical config already carries the target (D19 already-active fast path). */
  alreadyActive: boolean;
}

/** A single audit record the CALLER appends to logs/playwright-profiles.jsonl (D20). */
export interface PlaywrightAuditRecord {
  ts: string;
  action: string;
  profileId: string;
  detail: Record<string, unknown>;
}

export interface PlaywrightProfileRegistryOptions {
  /** The agent's .instar state dir (holds the registry file under state/). */
  stateDir: string;
  /** The agent home (project dir) — the userDataDir jail root (D9). */
  projectDir: string;
  /**
   * Returns the live vault secret NAMES (never values). Throws / returns null when the
   * vault is unreadable (absent / decrypt-failed) so ref-validation can fail CLOSED (D17).
   * Injected so this module NEVER touches a secret value (D3) and tests stay hermetic.
   */
  listVaultNames: () => string[] | null;
  /** Optional override for os.hostname() in the block header (tests). */
  hostname?: string;
}

/** Thrown when the registry file exists but is unparseable — writes fail CLOSED (D15). */
export class PlaywrightRegistryCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaywrightRegistryCorruptError';
  }
}

/** Thrown for caller-input validation failures (the route maps these to 400/409/422). */
export class PlaywrightRegistryError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PlaywrightRegistryError';
    this.status = status;
  }
}

// ── Caps & charsets (D13) ──────────────────────────────────────────────────────
export const MAX_PROFILES = 25;
export const MAX_ACCOUNTS_PER_PROFILE = 25;
export const MAX_DESCRIPTION_CHARS = 256;
export const MAX_SERVICE_CHARS = 64;
export const MAX_IDENTITY_CHARS = 128;
export const MAX_NOTE_CHARS = 256;
const PROFILE_ID_RE = /^[a-z0-9-]{1,64}$/;
const MUTATE_CAS_MAX_RETRIES = 5;
export const DEFAULT_BLOCK_MAX_BYTES = 800;

const LOGIN_METHODS: readonly PlaywrightLoginMethod[] = [
  'session-cookie',
  'password',
  'password+totp',
  'password+phone-2fa',
  'oauth-token',
  'unknown',
];

export class PlaywrightProfileRegistry {
  private readonly stateDir: string;
  private readonly projectDir: string;
  private readonly listVaultNames: () => string[] | null;
  private readonly hostname: string;

  constructor(opts: PlaywrightProfileRegistryOptions) {
    this.stateDir = opts.stateDir;
    this.projectDir = path.resolve(opts.projectDir);
    this.listVaultNames = opts.listVaultNames;
    this.hostname = opts.hostname ?? os.hostname();
  }

  /** Absolute path to the registry file. */
  filePath(): string {
    return path.resolve(path.join(this.stateDir, 'state', 'playwright-profiles.json'));
  }

  // ── Shared playwright-MCP-config resolver (S1/F2) ────────────────────────────

  /**
   * Locate the canonical playwright MCP server entry, checking `.claude/settings.json`
   * `mcpServers.playwright` FIRST (authoritative — init/migrator seed it there), then
   * `.mcp.json` `mcpServers.playwright`. Returns the file + entry + resolved
   * --user-data-dir (null when absent — the common case, D10), or null when no playwright
   * server is configured anywhere. Used by BOTH seed and activate so they cannot drift.
   */
  resolvePlaywrightMcpConfig(): ResolvedPlaywrightMcpConfig | null {
    const candidates = [
      path.join(this.projectDir, '.claude', 'settings.json'),
      path.join(this.projectDir, '.mcp.json'),
    ];
    for (const file of candidates) {
      let parsed: unknown;
      try {
        if (!fs.existsSync(file)) continue;
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // @silent-fallback-ok — an unparseable config file just means "not here"; we try the next candidate.
        continue;
      }
      const mcpServers = (parsed as { mcpServers?: Record<string, unknown> })?.mcpServers;
      const entry = mcpServers?.playwright;
      if (entry && typeof entry === 'object') {
        return {
          file: path.resolve(file),
          entry: entry as Record<string, unknown>,
          userDataDir: extractUserDataDir((entry as { args?: unknown }).args),
        };
      }
    }
    return null;
  }

  // ── Load / seed ──────────────────────────────────────────────────────────────

  /**
   * Read + parse the registry file. Absent → seed exactly ONE default profile
   * (metadata-only; NEVER writes MCP config — D10 seeding). Corrupt → throw
   * PlaywrightRegistryCorruptError (the WRITE path fails CLOSED; the boot block
   * swallows it — D15).
   */
  private read(): RegistryFile {
    const file = this.filePath();
    if (!fs.existsSync(file)) {
      return this.seedSkeleton();
    }
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new PlaywrightRegistryCorruptError(`registry file unreadable: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PlaywrightRegistryCorruptError('registry file corrupt — will not overwrite');
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as RegistryFile).profiles)) {
      throw new PlaywrightRegistryCorruptError('registry file corrupt — will not overwrite');
    }
    return parsed as RegistryFile;
  }

  /** Compute the in-memory seed (ONE default profile). Does NOT persist or touch MCP config. */
  private seedSkeleton(): RegistryFile {
    const resolved = this.resolvePlaywrightMcpConfig();
    // userDataDir from the resolved --user-data-dir arg if present, ELSE null (D10).
    // NEVER assert .playwright-mcp (that is the MCP output-dir, not the browser profile).
    const userDataDir = resolved?.userDataDir ?? null;
    return {
      version: 1,
      profiles: [
        {
          id: 'default',
          userDataDir,
          description: 'Default browser profile.',
          isDefault: true,
          createdAt: new Date().toISOString(),
          accounts: [],
        },
      ],
    };
  }

  /** Ensure the file exists on disk with the seeded default (idempotent). Returns the seeded store. */
  ensureSeeded(): RegistryFile {
    const file = this.filePath();
    if (fs.existsSync(file)) {
      // Surfaces a corrupt file (caller decides) — never auto-overwrites.
      return this.read();
    }
    const seeded = this.seedSkeleton();
    this.write(seeded);
    return seeded;
  }

  private write(store: RegistryFile): void {
    const file = this.filePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }

  // ── Single-writer CAS (D14) ──────────────────────────────────────────────────

  /**
   * Read-version → apply → write-if-unchanged → retry. Mirrors CommitmentTracker.mutate's
   * optimistic CAS, but file-backed: the "version" is the on-disk file's (mtimeMs, size)
   * captured BEFORE the read; if it changed by write time, retry. A corrupt file throws
   * (PlaywrightRegistryCorruptError) — the write path NEVER auto-overwrites (D15).
   *
   * `fn` receives a deep clone of the store and returns the next store plus a result.
   */
  mutate<T>(fn: (store: RegistryFile) => { next: RegistryFile; result: T }): T {
    const file = this.filePath();
    let attempt = 0;
    while (attempt <= MUTATE_CAS_MAX_RETRIES) {
      const before = statSig(file);
      // read() seeds an in-memory skeleton when absent; corrupt throws (fail closed).
      const store = this.read();
      const clone: RegistryFile = JSON.parse(JSON.stringify(store));
      const { next, result } = fn(clone);

      const after = statSig(file);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
        // The file drifted under us between read and write-decision — retry on a fresh read.
        attempt++;
        continue;
      }
      this.write(next);
      return result;
    }
    throw new PlaywrightRegistryError(
      'playwright-profile-registry: CAS retry budget exhausted (concurrent writers)',
      503,
    );
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────

  /** The FULL detail surface (GET-only): every account, vault NAMES, dangling-ref flags (D17). */
  listProfiles(): PlaywrightProfileDetail[] {
    const store = this.ensureSeeded();
    const liveNames = this.safeVaultNames();
    return store.profiles.map((p) => ({
      ...p,
      dirExists: this.dirExists(p.userDataDir),
      accounts: p.accounts.map((a) => ({
        ...a,
        danglingRefs:
          liveNames === null
            ? [] // vault unreadable on READ → best-effort; do not assert dangling (D17 read path)
            : a.vaultRefs.filter((r) => !liveNames.includes(r)),
      })),
    }));
  }

  /**
   * The selector (D18). Precedence: exact (service,identity) → else service-only.
   * Service-only matching >1 profile → { profile:null, ambiguous:true, candidates }.
   * No match → { profile:null }. dirExists reports whether the profile's userDataDir is
   * physically present (null userDataDir → built-in present).
   */
  resolve(service: string, identity?: string): PlaywrightResolveResult {
    const store = this.ensureSeeded();
    const svc = String(service);

    if (identity !== undefined && identity !== null && identity !== '') {
      const id = String(identity);
      const exact = store.profiles.find((p) =>
        p.accounts.some((a) => a.service === svc && a.identity === id),
      );
      if (exact) return { profile: exact, dirExists: this.dirExists(exact.userDataDir) };
      // fall through to service-only
    }

    const svcMatches = store.profiles.filter((p) => p.accounts.some((a) => a.service === svc));
    if (svcMatches.length === 1) {
      return { profile: svcMatches[0], dirExists: this.dirExists(svcMatches[0].userDataDir) };
    }
    if (svcMatches.length > 1) {
      return {
        profile: null,
        ambiguous: true,
        candidates: svcMatches.map((p) => ({
          id: p.id,
          identities: p.accounts.filter((a) => a.service === svc).map((a) => a.identity),
        })),
      };
    }
    return { profile: null };
  }

  // ── CRUD (all through mutate → CAS) ─────────────────────────────────────────────

  createProfile(input: { id: string; description?: string; userDataDir?: string | null }): PlaywrightProfile {
    const id = String(input.id ?? '');
    if (!PROFILE_ID_RE.test(id)) {
      throw new PlaywrightRegistryError(`invalid profile id (must match ${PROFILE_ID_RE})`, 400);
    }
    const description = sanitizeStored(input.description ?? '', MAX_DESCRIPTION_CHARS);
    // Jail (D9) or auto-allocate.
    const userDataDir =
      input.userDataDir === undefined || input.userDataDir === null
        ? this.autoAllocateDir(id)
        : this.jailUserDataDir(input.userDataDir);

    return this.mutate<PlaywrightProfile>((store) => {
      if (store.profiles.some((p) => p.id === id)) {
        throw new PlaywrightRegistryError(`profile '${id}' already exists`, 409);
      }
      if (store.profiles.length >= MAX_PROFILES) {
        throw new PlaywrightRegistryError(`maxProfiles=${MAX_PROFILES} reached`, 422);
      }
      const profile: PlaywrightProfile = {
        id,
        userDataDir,
        description,
        isDefault: false,
        createdAt: new Date().toISOString(),
        accounts: [],
      };
      store.profiles.push(profile);
      return { next: store, result: profile };
    });
  }

  assignAccount(
    profileId: string,
    input: {
      service: string;
      identity: string;
      owner: PlaywrightAccountOwner;
      vaultRefs?: string[];
      loginMethod?: PlaywrightLoginMethod;
      note?: string;
    },
  ): PlaywrightAccount {
    const service = sanitizeStored(input.service ?? '', MAX_SERVICE_CHARS);
    const identity = sanitizeStored(input.identity ?? '', MAX_IDENTITY_CHARS);
    if (!service) throw new PlaywrightRegistryError('service is required', 400);
    if (!identity) throw new PlaywrightRegistryError('identity is required', 400);
    if (input.owner !== 'agent' && input.owner !== 'operator') {
      throw new PlaywrightRegistryError("owner is required and must be 'agent' or 'operator'", 400);
    }
    const loginMethod: PlaywrightLoginMethod = LOGIN_METHODS.includes(input.loginMethod as PlaywrightLoginMethod)
      ? (input.loginMethod as PlaywrightLoginMethod)
      : 'unknown';
    const note = sanitizeStored(input.note ?? '', MAX_NOTE_CHARS);
    const vaultRefs = Array.isArray(input.vaultRefs) ? input.vaultRefs.map((r) => String(r)) : [];

    // Ref-validation FAILS CLOSED if vault names are unreadable (D17).
    const liveNames = this.listVaultNames();
    if (liveNames === null) {
      throw new PlaywrightRegistryError(
        'vault names unreadable (absent or decrypt-failed) — refusing to assign refs',
        409,
      );
    }
    const unknown = vaultRefs.filter((r) => !liveNames.includes(r));
    if (unknown.length > 0) {
      throw new PlaywrightRegistryError(`unknown vault ref(s): ${unknown.join(', ')}`, 409);
    }

    return this.mutate<PlaywrightAccount>((store) => {
      const profile = store.profiles.find((p) => p.id === profileId);
      if (!profile) throw new PlaywrightRegistryError(`profile '${profileId}' not found`, 404);

      const existing = profile.accounts.find((a) => a.service === service && a.identity === identity);
      const account: PlaywrightAccount = {
        service,
        identity,
        owner: input.owner,
        vaultRefs,
        loginMethod,
        lastAsserted: existing?.lastAsserted ?? false,
        lastVerifiedAt: existing?.lastVerifiedAt ?? null,
        note,
      };
      if (existing) {
        // Idempotent on (service, identity) — replace in place.
        const idx = profile.accounts.indexOf(existing);
        profile.accounts[idx] = account;
      } else {
        if (profile.accounts.length >= MAX_ACCOUNTS_PER_PROFILE) {
          throw new PlaywrightRegistryError(`maxAccountsPerProfile=${MAX_ACCOUNTS_PER_PROFILE} reached`, 422);
        }
        profile.accounts.push(account);
      }
      return { next: store, result: account };
    });
  }

  patchAccount(
    profileId: string,
    service: string,
    identity: string,
    patch: { lastAsserted?: boolean; lastVerifiedAt?: string | null; note?: string },
  ): PlaywrightAccount {
    return this.mutate<PlaywrightAccount>((store) => {
      const profile = store.profiles.find((p) => p.id === profileId);
      if (!profile) throw new PlaywrightRegistryError(`profile '${profileId}' not found`, 404);
      const account = profile.accounts.find((a) => a.service === service && a.identity === identity);
      if (!account) {
        throw new PlaywrightRegistryError(`account (${service}, ${identity}) not found`, 404);
      }
      if (patch.lastAsserted !== undefined) account.lastAsserted = !!patch.lastAsserted;
      if (patch.lastVerifiedAt !== undefined) {
        account.lastVerifiedAt = patch.lastVerifiedAt === null ? null : String(patch.lastVerifiedAt);
      }
      if (patch.note !== undefined) account.note = sanitizeStored(patch.note, MAX_NOTE_CHARS);
      return { next: store, result: account };
    });
  }

  deleteProfile(profileId: string): void {
    this.mutate<void>((store) => {
      const profile = store.profiles.find((p) => p.id === profileId);
      if (!profile) throw new PlaywrightRegistryError(`profile '${profileId}' not found`, 404);
      if (profile.isDefault) throw new PlaywrightRegistryError('cannot delete the default profile', 409);
      store.profiles = store.profiles.filter((p) => p.id !== profileId);
      return { next: store, result: undefined };
    });
  }

  deleteAccount(profileId: string, service: string, identity: string): void {
    this.mutate<void>((store) => {
      const profile = store.profiles.find((p) => p.id === profileId);
      if (!profile) throw new PlaywrightRegistryError(`profile '${profileId}' not found`, 404);
      const before = profile.accounts.length;
      profile.accounts = profile.accounts.filter(
        (a) => !(a.service === service && a.identity === identity),
      );
      if (profile.accounts.length === before) {
        throw new PlaywrightRegistryError(`account (${service}, ${identity}) not found`, 404);
      }
      return { next: store, result: undefined };
    });
  }

  // ── Activation (compute + optional write) — D10 ─────────────────────────────────

  /**
   * Compute the intended .mcp.json/.settings.json args mutation WITHOUT writing.
   * INSERT `--user-data-dir <dir>` as two array elements when absent; REPLACE the value
   * (handling the joined `--user-data-dir=<x>` form) when present; for the default profile
   * (null userDataDir) REMOVE the arg. alreadyActive=true when the target is already set.
   */
  computeActivation(profileId: string): PlaywrightActivationPlan {
    const store = this.ensureSeeded();
    const profile = store.profiles.find((p) => p.id === profileId);
    if (!profile) throw new PlaywrightRegistryError(`profile '${profileId}' not found`, 404);

    const resolved = this.resolvePlaywrightMcpConfig();
    if (!resolved) {
      throw new PlaywrightRegistryError('no playwright MCP server configured', 409);
    }

    const currentArgs = Array.isArray((resolved.entry as { args?: unknown }).args)
      ? ((resolved.entry as { args: unknown[] }).args.map((x) => String(x)))
      : [];
    const target = profile.userDataDir; // null for default
    const currentValue = extractUserDataDir(currentArgs);
    const alreadyActive = currentValue === target;

    const nextArgs = applyUserDataDirArg(currentArgs, target);

    return {
      profileId,
      file: resolved.file,
      nextArgs,
      userDataDir: target,
      dirExists: this.dirExists(target),
      alreadyActive,
    };
  }

  /**
   * Persist the activation plan into the authoritative MCP config file (the CALLER gates
   * this behind dryRun + loop-guard + refresh). Writes mcpServers.playwright.args = nextArgs.
   * Returns the file written.
   */
  writeActivation(plan: PlaywrightActivationPlan): { file: string } {
    let parsed: { mcpServers?: Record<string, unknown> };
    try {
      parsed = JSON.parse(fs.readFileSync(plan.file, 'utf8')) as { mcpServers?: Record<string, unknown> };
    } catch (err) {
      throw new PlaywrightRegistryError(`activation target config unreadable: ${(err as Error).message}`, 500);
    }
    if (!parsed.mcpServers || typeof parsed.mcpServers.playwright !== 'object') {
      throw new PlaywrightRegistryError('playwright MCP entry vanished from config', 409);
    }
    (parsed.mcpServers.playwright as { args?: unknown }).args = plan.nextArgs;
    const tmp = path.join(
      path.dirname(plan.file),
      `.${path.basename(plan.file)}.${process.pid}.${Date.now()}.tmp`,
    );
    fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n');
    fs.renameSync(tmp, plan.file);
    return { file: plan.file };
  }

  // ── Boot block (D21) ────────────────────────────────────────────────────────────

  /**
   * Compact <playwright-profiles> boot pointer ≤maxBytes. ONE line per profile carrying
   * only the safety-critical signals (service/identity, owner marker, login-staleness).
   * Stable order (default first, then createdAt). Account-line truncation with a counted
   * '…(+N)' marker (marker bytes count vs budget). Every rendered field passes through
   * sanitizeForBlock (D16). NO vault values, NO vaultRefs (those are GET-only). Fail-open:
   * a corrupt/unreadable file → empty (never blocks boot — D15/D22).
   */
  buildSessionContextBlock(maxBytes: number = DEFAULT_BLOCK_MAX_BYTES, opts: { full?: boolean } = {}): {
    present: boolean;
    block: string;
  } {
    let store: RegistryFile;
    try {
      store = this.ensureSeeded();
    } catch {
      // @silent-fallback-ok — corrupt/unreadable registry must never block boot (D15/D22); inject nothing.
      return { present: false, block: '' };
    }

    if (store.profiles.length === 0) return { present: false, block: '' };

    const ordered = [...store.profiles].sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (b.isDefault && !a.isDefault) return 1;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });

    const header = [
      `<playwright-profiles src='boot' machine='${sanitizeForBlock(this.hostname, 64)}'>`,
      '## Browser profiles (background signal, not authority — verify before acting)',
      'Profiles live on THIS machine only. Login state is LAST-ASSERTED, never a guarantee —',
      're-verify in-browser before any privileged action, especially operator-owned accounts.',
      'Full detail + vault key names: GET /playwright-profiles · pick one: GET /playwright-profiles/resolve',
      '',
    ];
    const footer = [
      'To switch the browser onto a profile: POST /playwright-profiles/<id>/activate (restarts the session).',
      '</playwright-profiles>',
    ];

    const profileLines = ordered.map((p) => this.renderProfileLine(p));

    if (opts.full) {
      const block = [...header, ...profileLines, ...footer].join('\n');
      return { present: true, block };
    }

    // Byte-bound: drop whole profile lines from the END, replacing with a counted marker.
    let shown = profileLines.length;
    while (shown >= 0) {
      const hidden = profileLines.length - shown;
      const body = profileLines.slice(0, shown);
      if (hidden > 0) {
        body.push(`…(+${hidden} more — GET /playwright-profiles)`);
      }
      const assembled = [...header, ...body, ...footer].join('\n');
      if (Buffer.byteLength(assembled, 'utf8') <= maxBytes || shown === 0) {
        return { present: true, block: assembled };
      }
      shown--;
    }
    // Unreachable (shown===0 returns above), but keeps the type-checker happy.
    return { present: true, block: [...header, ...footer].join('\n') };
  }

  /** Render one profile's compact boot line. Sanitizes every field. */
  private renderProfileLine(p: PlaywrightProfile): string {
    const accountStrs = p.accounts.map((a) => {
      const svc = sanitizeForBlock(a.service, MAX_SERVICE_CHARS);
      const id = sanitizeForBlock(a.identity, MAX_IDENTITY_CHARS);
      const ownerMark = a.owner === 'operator' ? 'OPERATOR; act-as only when authorized' : 'agent';
      const staleness = renderStaleness(a.lastVerifiedAt);
      return `${svc}/${id} (${ownerMark}) [${staleness}]`;
    });
    const accountPart = accountStrs.length > 0 ? accountStrs.join(', ') : '(no accounts assigned)';
    const pid = sanitizeForBlock(p.id, 64);
    return `- ${pid} — ${accountPart}`;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────────

  /** Best-effort vault names for READ paths — swallows the unreadable case to null. */
  private safeVaultNames(): string[] | null {
    try {
      return this.listVaultNames();
    } catch {
      // @silent-fallback-ok — READ-path dangling-ref check is best-effort; null = "don't assert dangling" (D17).
      return null;
    }
  }

  /** fs.existsSync on a userDataDir; null userDataDir → built-in profile present (true). */
  private dirExists(userDataDir: string | null): boolean {
    if (userDataDir === null) return true;
    try {
      return fs.existsSync(userDataDir);
    } catch {
      // @silent-fallback-ok — an unstattable path is treated as absent.
      return false;
    }
  }

  /** Auto-allocate <projectDir>/.instar/state/playwright-profiles/<id>/ (recorded only). */
  private autoAllocateDir(id: string): string {
    return path.join(this.projectDir, '.instar', 'state', 'playwright-profiles', id);
  }

  /**
   * Path-jail a caller-supplied userDataDir (D9): path.resolve'd, absolute, confined under
   * projectDir (agent home), not flag-shaped (`-` prefix), no NUL. Else throw 400.
   */
  private jailUserDataDir(input: string): string {
    const raw = String(input);
    if (raw.includes('\u0000')) {
      throw new PlaywrightRegistryError('userDataDir contains a NUL byte', 400);
    }
    if (raw.trimStart().startsWith('-')) {
      throw new PlaywrightRegistryError('userDataDir must not begin with "-" (flag-shaped)', 400);
    }
    if (!path.isAbsolute(raw)) {
      throw new PlaywrightRegistryError('userDataDir must be an absolute path', 400);
    }
    const resolved = path.resolve(raw);
    const root = this.projectDir.endsWith(path.sep) ? this.projectDir : this.projectDir + path.sep;
    if (resolved !== this.projectDir && !resolved.startsWith(root)) {
      throw new PlaywrightRegistryError('userDataDir must be confined under the agent home', 400);
    }
    return resolved;
  }
}

// ── Module-level pure helpers ──────────────────────────────────────────────────

/** Stored-field sanitizer: strip control/ANSI, clamp length (NOT for block render — that uses sanitizeForBlock on top). */
export function sanitizeStored(input: string, maxChars: number): string {
  let s = String(input)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  if (s.length > maxChars) s = s.slice(0, maxChars);
  return s;
}

/** Render a login-staleness note from lastVerifiedAt: 'seen Nd ago' / 'seen today' / 'unverified'. */
export function renderStaleness(lastVerifiedAt: string | null): string {
  if (!lastVerifiedAt) return 'unverified';
  const t = Date.parse(lastVerifiedAt);
  if (Number.isNaN(t)) return 'unverified';
  const days = Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'seen today';
  return `seen ${days}d ago`;
}

/** Extract the --user-data-dir value from an args array (two-element form OR joined `=` form). null if absent. */
export function extractUserDataDir(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  const a = args.map((x) => String(x));
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--user-data-dir') {
      return i + 1 < a.length ? a[i + 1] : null;
    }
    if (a[i].startsWith('--user-data-dir=')) {
      return a[i].slice('--user-data-dir='.length);
    }
  }
  return null;
}

/**
 * Return a NEW args array with --user-data-dir set to `target` (two separate elements),
 * replacing any existing value/joined form. When target is null, REMOVE the arg entirely.
 */
export function applyUserDataDirArg(args: string[], target: string | null): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user-data-dir') {
      i++; // skip the following value element too
      continue;
    }
    if (args[i].startsWith('--user-data-dir=')) {
      continue;
    }
    out.push(args[i]);
  }
  if (target !== null) {
    out.push('--user-data-dir', target);
  }
  return out;
}

/** Capture a file's (mtimeMs, size) signature for the CAS, or zeros when absent. */
function statSig(file: string): { mtimeMs: number; size: number } {
  try {
    const st = fs.statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    // @silent-fallback-ok — absent file is a valid CAS baseline (a concurrent create flips the signature).
    return { mtimeMs: 0, size: 0 };
  }
}
