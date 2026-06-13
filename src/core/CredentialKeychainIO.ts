/**
 * CredentialKeychainIO — async, bounded keychain read/write/delete for the credential swap
 * executor (Step 5 of live credential re-pointing, spec §2.3).
 *
 * Why a dedicated async I/O surface (NOT `defaultCredentialStore`): the swap performs several
 * keychain operations per move, and the existing `defaultCredentialStore` is `execFileSync` —
 * a synchronous `security` call can WEDGE the whole event loop on a locked keychain (an ACL
 * prompt on the default slot is a real hazard, §2.3 "Hang-safety"). Every call here is async
 * `execFile`/`spawn` with a 10s timeout, so a stuck keychain aborts the operation instead of
 * freezing the server.
 *
 * Two service namespaces flow through this module:
 *   - a config home's REAL Claude credential service (`claudeCredentialService(home)` →
 *     `Claude Code-credentials[-<8hex>]`) — the slot stores the swap reads/writes; and
 *   - the STAGING namespace (`instar-credential-swap-staging-<swapId>`) — the crash-proofing
 *     escrow copy. The staging namespace is GUARANTEED DISJOINT from every
 *     `claudeCredentialService` output (§2.3.2), so no `claude` client and no QuotaPoller ever
 *     reads a staged copy — a staged blob can never trigger the §0.d "readable from two config
 *     homes" hazard. `assertStagingDisjoint()` pins that invariant (a §5 unit test asserts it).
 *
 * The credential blob is written via the `security -i` stdin form (hex-encoded), NEVER as a
 * `-w <blob>` argv argument — so the credential never appears in the process list. Read/delete
 * carry only the service NAME in argv (never a secret).
 */

import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { claudeCredentialService } from './OAuthRefresher.js';

const SECURITY_TIMEOUT_MS = 10_000;
const STAGING_PREFIX = 'instar-credential-swap-staging-';

/** The keychain service name for a swap's staging escrow entry. Derives from NO token bytes. */
export function stagingService(swapId: string): string {
  return `${STAGING_PREFIX}${swapId}`;
}

/** True iff `service` is a swap-staging entry (the disjoint escrow namespace). */
export function isStagingService(service: string): boolean {
  return service.startsWith(STAGING_PREFIX);
}

/**
 * Pin the §2.3.2 invariant: the staging namespace can never collide with a real Claude
 * credential service. Throws if a `swapId` would produce a staging service that looks like a
 * `claudeCredentialService` output. Cheap, called at swap start; the real guarantee is the
 * fixed `Claude Code-credentials` prefix vs the `instar-credential-swap-staging-` prefix.
 */
export function assertStagingDisjoint(swapId: string): void {
  const staging = stagingService(swapId);
  // A claudeCredentialService output ALWAYS starts with 'Claude Code-credentials'. The staging
  // prefix shares no leading substring with it, so a collision is structurally impossible — but
  // we assert defensively in case either prefix is ever changed.
  if (staging.startsWith('Claude Code-credentials')) {
    throw new Error(
      `staging service '${staging}' collides with the Claude credential namespace — invariant §2.3.2 violated`,
    );
  }
}

/** Async, bounded keychain operations. Injectable so the executor's unit tests use a fake. */
export interface KeychainIO {
  /** Read a service's raw secret string, or null if absent/unreadable. */
  read(service: string): Promise<string | null>;
  /** Write (update-in-place) a service's raw secret. Returns false on failure (never throws). */
  write(service: string, raw: string): Promise<boolean>;
  /** Delete a service's entry. Best-effort; never throws. */
  delete(service: string): Promise<void>;
}

function execFileAsync(
  cmd: string,
  args: string[],
  opts: { timeout: number },
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf-8', timeout: opts.timeout }, (err, stdout) => {
      if (err) {
        const code = typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 1;
        resolve({ code, stdout: stdout ?? '' });
      } else {
        resolve({ code: 0, stdout: stdout ?? '' });
      }
    });
  });
}

/** Write `raw` to `service` via the `security -i` stdin form (hex), so the blob is never in argv. */
function securityWriteViaStdin(service: string, raw: string, account: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let child;
    try {
      child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* @silent-fallback-ok: process may already be gone */
      }
      done(false);
    }, timeout);
    child.on('error', () => {
      clearTimeout(timer);
      done(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
    const hex = Buffer.from(raw, 'utf-8').toString('hex');
    try {
      child.stdin.write(`add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`);
      child.stdin.end();
    } catch {
      clearTimeout(timer);
      done(false);
    }
  });
}

/** The real macOS keychain implementation (async, bounded). */
export class SecurityKeychainIO implements KeychainIO {
  private readonly account: string;
  private readonly timeoutMs: number;

  constructor(opts: { account?: string; timeoutMs?: number } = {}) {
    this.account = opts.account ?? os.userInfo().username;
    this.timeoutMs = opts.timeoutMs ?? SECURITY_TIMEOUT_MS;
  }

  async read(service: string): Promise<string | null> {
    const { code, stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: this.timeoutMs },
    );
    if (code !== 0) return null;
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  async write(service: string, raw: string): Promise<boolean> {
    return securityWriteViaStdin(service, raw, this.account, this.timeoutMs);
  }

  async delete(service: string): Promise<void> {
    await execFileAsync('security', ['delete-generic-password', '-s', service], {
      timeout: this.timeoutMs,
    });
  }
}

/** Resolve the real Claude credential service name for a config-home slot. */
export function slotService(configHome: string): string {
  return claudeCredentialService(configHome);
}
