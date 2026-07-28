/**
 * CredentialProvider — cross-platform abstraction for Claude Code OAuth credential access.
 *
 * Implementations:
 * - KeychainCredentialProvider: macOS Keychain (os-encrypted, production-proven)
 * - ClaudeConfigCredentialProvider: File-based fallback (all platforms, 0600 permissions)
 *
 * Part of the Instar Quota Migration spec (Phase 1).
 */

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import {
  credentialWriteFunnel,
  type CredentialWriteFunnel,
  type FunnelResult,
} from '../core/CredentialWriteFunnel.js';
import { credentialSlotKey } from '../core/OAuthRefresher.js';

// ── Interfaces ──────────────────────────────────────────────────────

export interface ClaudeCredentials {
  accessToken: string;
  expiresAt: number;       // Unix timestamp (ms)
  refreshToken?: string;   // If available from OAuth flow
  email?: string;
}

export interface AccountInfo {
  email: string;
  name: string | null;
  hasToken: boolean;
  tokenExpired: boolean;
}

export type SecurityLevel = 'os-encrypted' | 'file-permission-only';

export interface CredentialProvider {
  /** Read the current active credentials */
  readCredentials(): Promise<ClaudeCredentials | null>;
  /** Write/update credentials */
  writeCredentials(creds: ClaudeCredentials): Promise<void>;
  /** Delete credentials for a specific account */
  deleteCredentials?(email: string): Promise<void>;
  /** List all known accounts */
  listAccounts?(): Promise<AccountInfo[]>;
  /** Platform identifier */
  platform: string;
  /** Security level of this provider's storage */
  securityLevel: SecurityLevel;
}

// ── Token Redaction ─────────────────────────────────────────────────

/**
 * Redact a token for safe logging. Shows first 4 chars only.
 * Returns "[TOKEN:abc1****]" format.
 */
export function redactToken(token: string): string {
  if (!token || token.length < 4) return '[TOKEN:****]';
  return `[TOKEN:${token.slice(0, 4)}****]`;
}

/**
 * Redact an email for safe logging.
 * Returns "[EMAIL:j***@***.com]" format.
 */
export function redactEmail(email: string): string {
  if (!email || !email.includes('@')) return '[EMAIL:****]';
  const [local, domain] = email.split('@');
  const domainParts = domain.split('.');
  const tld = domainParts[domainParts.length - 1];
  return `[EMAIL:${local[0]}***@***.${tld}]`;
}

// ── Keychain Provider (macOS) ───────────────────────────────────────

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Promisified async exec for the NON-BLOCKING keychain read. The macOS keychain read is an
 * out-of-process `security` spawn; run SYNCHRONOUSLY (`execFileSync`) it blocks the event loop for
 * the whole spawn — under multi-agent `securityd` contention that was seconds every QuotaCollector
 * poll cycle (the dashboard-flap / false-sleep residual). `readCredentials` (the polled read on the
 * collection-cycle timer) uses this so the read yields the loop instead of freezing it.
 */
const execFileAsync = promisify(execFile);

export class KeychainCredentialProvider implements CredentialProvider {
  readonly platform = 'darwin';
  readonly securityLevel: SecurityLevel = 'os-encrypted';
  private keychainAccount: string;

  constructor() {
    this.keychainAccount = os.userInfo().username;
  }

  async readCredentials(): Promise<ClaudeCredentials | null> {
    try {
      // NON-BLOCKING keychain read (promisified `execFile`) so a slow/contended `securityd` yields
      // the event loop instead of freezing it. `readCredentials` is already async (callers await it);
      // the prior `execFileSync` made the `async` a lie — it blocked the loop for the spawn duration
      // on the QuotaCollector poll timer. Same args + same 10s timeout + same null-on-error semantics.
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { encoding: 'utf-8', timeout: 10000 }
      );
      // RULE 3: EXEMPT — this parses our OWN credential store (the `Claude Code-credentials`
      // keychain entry the agent itself owns, fixed `claudeAiOauth` schema), NOT an evolving
      // upstream UI/log we detect state from. It is fail-SAFE (any parse error → the `catch`
      // returns null → caller treats it as no-creds/needs-reauth) and cross-checked downstream
      // (a stale/wrong token surfaces as a 401 → needs-reauth, never silent corruption). The
      // async conversion is behavior-preserving; the parse itself is unchanged from the prior
      // (already-merged) sync read.
      const data = JSON.parse(stdout.trim());
      const oauth = data.claudeAiOauth;
      if (!oauth?.accessToken) return null;

      return {
        accessToken: oauth.accessToken,
        expiresAt: oauth.expiresAt ?? 0,
        refreshToken: oauth.refreshToken,
        email: oauth.email,
      };
    } catch {
      // @silent-fallback-ok — Keychain may not have Claude credentials; null is expected
      return null;
    }
  }

  async writeCredentials(creds: ClaudeCredentials): Promise<void> {
    // Read existing data to preserve non-credential fields
    let existingData: Record<string, unknown> = {};
    try {
      const result = execFileSync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      existingData = JSON.parse(result.trim());
    } catch {
      // @silent-fallback-ok — no existing Keychain entry; start fresh
    }

    const newData = {
      ...existingData,
      claudeAiOauth: {
        ...(existingData.claudeAiOauth as Record<string, unknown> || {}),
        accessToken: creds.accessToken,
        expiresAt: creds.expiresAt,
        ...(creds.refreshToken ? { refreshToken: creds.refreshToken } : {}),
        ...(creds.email ? { email: creds.email } : {}),
      },
    };

    const jsonStr = JSON.stringify(newData);
    const hexStr = Buffer.from(jsonStr).toString('hex');
    execFileSync('security', ['-i'], {
      input: `add-generic-password -U -a "${this.keychainAccount}" -s "${KEYCHAIN_SERVICE}" -X "${hexStr}"\n`,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  async deleteCredentials(_email: string): Promise<void> {
    try {
      execFileSync(
        'security',
        ['delete-generic-password', '-s', KEYCHAIN_SERVICE],
        { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch {
      // @silent-fallback-ok — Keychain entry already deleted or never existed
    }
  }
}

// ── Claude Config File Provider (All Platforms) ─────────────────────

/**
 * Reads credentials from Claude Code's local config files.
 * Falls back to file-based storage with enforced 0600 permissions.
 *
 * Config path: ~/.claude/ (standard Claude Code config directory)
 */
export class ClaudeConfigCredentialProvider implements CredentialProvider {
  readonly platform = process.platform;
  readonly securityLevel: SecurityLevel = 'file-permission-only';
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || path.join(os.homedir(), '.claude');
  }

  async readCredentials(): Promise<ClaudeCredentials | null> {
    try {
      // Try the credentials file first
      const credPath = path.join(this.configDir, 'credentials.json');
      if (!fs.existsSync(credPath)) {
        // Try the legacy .credentials file
        const legacyPath = path.join(this.configDir, '.credentials');
        if (!fs.existsSync(legacyPath)) return null;
        return this.parseCredentialFile(legacyPath);
      }
      return this.parseCredentialFile(credPath);
    } catch {
      // @silent-fallback-ok — credential file may be missing or malformed; null is expected
      return null;
    }
  }

  async writeCredentials(creds: ClaudeCredentials): Promise<void> {
    // Ensure directory exists with proper permissions
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    }

    const credPath = path.join(this.configDir, 'credentials.json');
    const data = {
      accessToken: creds.accessToken,
      expiresAt: creds.expiresAt,
      ...(creds.refreshToken ? { refreshToken: creds.refreshToken } : {}),
      ...(creds.email ? { email: creds.email } : {}),
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(credPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  async deleteCredentials(_email: string): Promise<void> {
    const credPath = path.join(this.configDir, 'credentials.json');
    try {
      if (fs.existsSync(credPath)) {
        SafeFsExecutor.safeUnlinkSync(credPath, { operation: 'src/monitoring/CredentialProvider.ts:213' });
      }
    } catch {
      // @silent-fallback-ok — file already deleted or never existed
    }
  }

  private parseCredentialFile(filePath: string): ClaudeCredentials | null {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    // Handle multiple possible formats
    const token = data.accessToken || data.claudeAiOauth?.accessToken;
    if (!token) return null;

    return {
      accessToken: token,
      expiresAt: data.expiresAt || data.claudeAiOauth?.expiresAt || 0,
      refreshToken: data.refreshToken || data.claudeAiOauth?.refreshToken,
      email: data.email || data.claudeAiOauth?.email,
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create the best available credential provider for the current platform.
 *
 * Priority:
 * 1. macOS: Keychain (os-encrypted)
 * 2. All platforms: File-based (~/.claude/) with 0600 permissions
 *
 * Note: keytar support (Linux libsecret, Windows Credential Manager)
 * is planned but not yet implemented. When added, it will slot between
 * Keychain and file-based in the priority chain.
 */
export function createDefaultProvider(): CredentialProvider {
  if (process.platform === 'darwin') {
    return new KeychainCredentialProvider();
  }

  // File-based fallback — log security warning
  console.warn(
    '[CredentialProvider] Using file-based credential storage (less secure). ' +
    'Consider installing keytar for OS-native encrypted storage.'
  );
  return new ClaudeConfigCredentialProvider();
}

// ── Serialized write chokepoint (Step 4b) ───────────────────────────

/**
 * The default config-home slot a `CredentialProvider` writes to — the keychain's
 * `Claude Code-credentials` service is the `~/.claude` home. Callers that target a
 * non-default home pass that home as `slot` instead.
 */
export const DEFAULT_CREDENTIAL_SLOT = credentialSlotKey('~/.claude');

/**
 * Thrown by `writeCredentialsSerialized` when the target slot is owned by the credential
 * re-pointing ledger (census #9). A competing writer (AccountSwitcher / `/switch-account` /
 * `autoMigrate`) writing that slot would graft a Frankenstein blob over the ledger's tenant and
 * silently resurrect a stranded account (spec §2.7). This is a NAMED, NON-DESTRUCTIVE refusal —
 * nothing was written — pointing the caller at the sanctioned replacement.
 */
export class CredentialWriteRepointingOwnedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CredentialWriteRepointingOwnedError';
  }
}

/**
 * Manager-level refusal gate for the competing-writer census row (#9). Injected at the funnel
 * chokepoint so a refusal lives at the MANAGER, not only on the two known routes — any future
 * caller of `writeCredentialsSerialized` inherits it (the "every item a unique source" dodge the
 * flood-ceiling lesson warns against, applied to credential writes).
 *
 *   `shouldRefuse(slot)` → true ⇒ the write is refused (the slot is repointing-owned). It receives
 *   the canonicalized slot key so the gate matches the ledger's spelling regardless of caller
 *   input. Returns false (or the gate being absent) ⇒ the write proceeds exactly as today.
 */
export interface CredentialWriteRefusalGate {
  shouldRefuse(canonicalSlot: string): boolean;
}

/** Process-shared refusal gate; wired at server startup when re-pointing is enabled. */
let sharedWriteRefusalGate: CredentialWriteRefusalGate | undefined;

/** Install (or clear, with `undefined`) the process-shared competing-writer refusal gate. */
export function setCredentialWriteRefusalGate(gate: CredentialWriteRefusalGate | undefined): void {
  sharedWriteRefusalGate = gate;
}

/**
 * Serialize a `provider.writeCredentials` through the per-slot credential funnel (Step 4b).
 *
 * This is the ONLY sanctioned path for an external caller (e.g. AccountSwitcher) to write the
 * active account credential: it shares the per-slot lock with the QuotaPoller refresh write and
 * the swap executor (Step 5), so a switch can never interleave with a refresh on the same slot.
 * The companion lint (`lint-no-unfunneled-credential-write.js`) forbids calling
 * `provider.writeCredentials(...)` directly outside this funnel-owning module.
 *
 * Census #9 (manager-level competing-writer refusal): when the process-shared refusal gate (or an
 * explicitly-passed `refusalGate`) reports the target slot is repointing-owned, the write is
 * REFUSED here at the manager — BEFORE the funnel lock — with a `CredentialWriteRepointingOwnedError`.
 * This is the funnel: a non-route caller can't dodge it. Refusal is non-destructive (nothing was
 * written) and names the sanctioned replacement (`POST /credentials/set-default`).
 *
 * Returns the funnel result. `ran:false` means the lock was busy and the write was SKIPPED (the
 * caller decides whether to surface "busy, try again"); it is never a credential corruption.
 */
export async function writeCredentialsSerialized(
  provider: Pick<CredentialProvider, 'writeCredentials'>,
  slot: string,
  creds: ClaudeCredentials,
  funnel: CredentialWriteFunnel = credentialWriteFunnel,
  refusalGate: CredentialWriteRefusalGate | undefined = sharedWriteRefusalGate,
): Promise<FunnelResult<void>> {
  // Canonicalize the slot so a switch and a refresh on the SAME home share one lock regardless
  // of spelling (second-pass review hardening, 2026-06-13).
  const canonicalSlot = credentialSlotKey(slot);
  if (refusalGate?.shouldRefuse(canonicalSlot)) {
    throw new CredentialWriteRepointingOwnedError(
      `credential slot '${slot}' is owned by live credential re-pointing — a direct switch/migrate ` +
        `write would clobber the ledger's tenant. Use POST /credentials/set-default instead.`,
    );
  }
  return funnel.withSlotLock(canonicalSlot, () => provider.writeCredentials(creds));
}
