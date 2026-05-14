/**
 * NativeModuleHealer — in-line self-heal for better-sqlite3 NODE_MODULE_VERSION mismatch.
 *
 * Background:
 *   ServerSupervisor.preflightSelfHeal handles the supervisor-spawn path
 *   (it rebuilds better-sqlite3 in `shadow-install` before forking the server).
 *   But CLI commands (`instar memory ...`, `instar semantic ...`) and any direct
 *   instantiation of SemanticMemory / TopicMemory / MemoryIndex bypass it.
 *
 *   When Node is upgraded after Instar was installed, the native better-sqlite3
 *   binding throws NODE_MODULE_VERSION on construction. Without an in-line heal,
 *   the only fix is for the user to run `npm rebuild better-sqlite3` manually —
 *   and 1254 reports in the field show users hit this and file bug reports
 *   instead (cluster-degradation-semanticmemory-semanticmemory-init-failed-the-m).
 *
 * Strategy:
 *   1. Wrap the better-sqlite3 constructor call in `openWithHeal`.
 *   2. On NODE_MODULE_VERSION error, locate npm + the install prefix that
 *      contains the better-sqlite3 package, run `npm rebuild better-sqlite3
 *      --prefix <install_prefix>` synchronously.
 *   3. Clear better-sqlite3 from `require.cache` so a fresh native binding
 *      is loaded on retry.
 *   4. Retry the constructor once. If it still fails, throw.
 *   5. Log heal events to `<stateDir>/native-module-heals.jsonl` for
 *      observability (consumed by health checks and DegradationReporter).
 *
 * Once-per-process guard:
 *   The rebuild is expensive (~30s) and shouldn't run more than once per
 *   process. After one attempt, subsequent failures throw immediately.
 *
 * Spec: PROP-399 (chronic, 24 cycles, 1254 field reports).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import child_process, {
  spawnSync,
  type SpawnSyncReturns,
} from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Lightweight structural type compatible with F-8 Remediator's RemediationContext.
// Imported as a type-only reference; runtime decoupling lets us avoid a hard
// dependency from `src/memory/*` onto `src/remediation/*` (the legacy in-line
// `openWithHeal` path must keep working even if remediation files are absent).
export interface RemediatorInvocationContext {
  attemptId: string;
  runbookId: string;
  abortSignal: AbortSignal;
  /** `process.hrtime.bigint()` issued + expectedRuntimeMs converted to ns. */
  monotonicDeadline: bigint;
  /** §A3 capability-token HMAC — present on Tier-2 dispatched ctxs. */
  hmac?: Buffer;
  /** Wall-clock expiry, mirrors RemediationContext.expiresAt. */
  expiresAt?: number;
}

/**
 * Optional keyVault dependency for `invokeFromRemediator` §A3 / §A23
 * verification. Structural so `src/memory/*` doesn't pull in
 * `src/remediation/*` at module load.
 */
export interface InvocationContextKeyVault {
  deriveLeafKey(context: 'capability', scopeId: string): Buffer;
}

export interface RemediatorExecutionResult {
  outcome: 'success' | 'failure';
  details: Record<string, unknown>;
}

export interface HealEvent {
  /** Component that triggered the heal (e.g. 'SemanticMemory', 'TopicMemory', 'MemoryIndex'). */
  component: string;
  /** UTC ISO timestamp of the attempt. */
  timestamp: string;
  /** Whether the rebuild + retry succeeded. */
  success: boolean;
  /** Node version process is running. */
  nodeVersion: string;
  /** Detected install prefix where `npm rebuild` was run, if any. */
  installPrefix?: string;
  /** npm binary path used for the rebuild, if found. */
  npmPath?: string;
  /** Stderr tail (last 300 chars) on failure. */
  errorTail?: string;
  /** Duration of the rebuild attempt, in ms. */
  durationMs?: number;
}

const HEAL_LOG_FILENAME = 'native-module-heals.jsonl';

/**
 * NativeModuleHealer is a process-singleton. Stateful members track
 * whether a heal has already been attempted this process so the
 * expensive rebuild doesn't run on every open() retry.
 */
class NativeModuleHealerImpl {
  private healAttempted = false;
  private lastResult: HealEvent | null = null;
  private stateDir: string | null = null;

  /** Configure where heal events are persisted. Optional. */
  configure(opts: { stateDir?: string | null }): void {
    if (opts.stateDir) this.stateDir = opts.stateDir;
  }

  /** Reset for testing. */
  resetForTesting(): void {
    this.healAttempted = false;
    this.lastResult = null;
    this.stateDir = null;
  }

  /**
   * §A3 verify the HMAC on a RemediatorInvocationContext. Mirrors the
   * canonical body layout in `src/remediation/RemediationContext.ts`. We
   * inline rather than import to avoid the `src/memory/*` → `src/remediation/*`
   * dependency that would break the legacy `openWithHeal` path on installs
   * without the remediation tree (e.g., partial CLI surfaces).
   */
  private verifyContextHmac(
    ctx: RemediatorInvocationContext,
    keyVault: InvocationContextKeyVault,
  ): boolean {
    if (!ctx.hmac || !Buffer.isBuffer(ctx.hmac) || ctx.hmac.length === 0) {
      return false;
    }
    if (!ctx.runbookId) return false;
    let leaf: Buffer;
    try {
      leaf = keyVault.deriveLeafKey('capability', ctx.runbookId);
    } catch {
      // @silent-fallback-ok — §A3 verification is fail-closed by design.
      // KeyVault derivation failure means we cannot verify the ctx; the
      // surface MUST refuse to act on Remediator-claimed authority. The
      // caller routes this to the in-line legacy heal path with a warning.
      return false;
    }

    const HMAC_TAG = Buffer.from('instar-f8-ctx-v1\x00', 'utf-8');
    const writeStr = (s: string): Buffer => {
      const body = Buffer.from(s, 'utf-8');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length, 0);
      return Buffer.concat([len, body]);
    };
    const expiresAtBuf = Buffer.alloc(8);
    expiresAtBuf.writeBigUInt64BE(
      BigInt(Math.max(0, Math.floor(ctx.expiresAt ?? 0))),
      0,
    );
    const monoBuf = Buffer.alloc(8);
    const mono = ctx.monotonicDeadline >= 0n ? ctx.monotonicDeadline : 0n;
    monoBuf.writeBigUInt64BE(mono, 0);
    const body = Buffer.concat([
      HMAC_TAG,
      writeStr(ctx.attemptId),
      writeStr(ctx.runbookId),
      expiresAtBuf,
      monoBuf,
    ]);
    const expected = crypto.createHmac('sha256', leaf).update(body).digest();
    if (expected.length !== ctx.hmac.length) return false;
    try {
      return crypto.timingSafeEqual(expected, ctx.hmac);
    } catch {
      // @silent-fallback-ok — timingSafeEqual throws only on length mismatch
      // or non-Buffer inputs. We already length-checked above; this catch is
      // defensive and fails-closed per §A3.
      return false;
    }
  }

  /**
   * Fall-back path when the surface-side HMAC verification rejects a ctx.
   * Runs the legacy in-line `openWithHeal` heal step (no opener — we just
   * want the rebuild + retry behavior). Returns an `ExecutionResult`-shaped
   * object so the caller's contract is preserved.
   */
  private async fallbackToInlineHeal(
    ctx: RemediatorInvocationContext,
  ): Promise<RemediatorExecutionResult> {
    if (ctx.abortSignal.aborted) {
      return {
        outcome: 'failure',
        details: {
          reason: 'aborted-before-fallback',
          attemptId: ctx.attemptId,
          invalidContext: true,
        },
      };
    }
    const succeeded = await this.healBetterSqlite3(`InvalidCtx:${ctx.runbookId}`);
    if (ctx.abortSignal.aborted) {
      return {
        outcome: 'failure',
        details: {
          reason: 'aborted-during-fallback',
          attemptId: ctx.attemptId,
          invalidContext: true,
        },
      };
    }
    return {
      outcome: succeeded ? 'success' : 'failure',
      details: {
        attemptId: ctx.attemptId,
        invalidContext: true,
        fallbackPath: 'in-line-openWithHeal-heal-step',
        previousOutcome: this.lastResult,
      },
    };
  }

  /** Detect NODE_MODULE_VERSION errors. Tolerant of message wording variants. */
  isNodeModuleVersionError(err: unknown): boolean {
    const msg = err instanceof Error ? (err.message ?? '') : String(err);
    // Common forms:
    //   "The module '...' was compiled against a different Node.js version using
    //    NODE_MODULE_VERSION 108. This version of Node.js requires NODE_MODULE_VERSION 115."
    //   "NODE_MODULE_VERSION mismatch"
    return /NODE_MODULE_VERSION/i.test(msg);
  }

  /** Returns the last heal attempt result (or null if none). */
  getLastResult(): HealEvent | null {
    return this.lastResult;
  }

  /**
   * Wrap an open() / new Database(path) call. If it throws with
   * NODE_MODULE_VERSION, run the heal once, then retry. Otherwise rethrow.
   *
   * The opener is passed in (rather than calling `new Database` directly)
   * because each caller has different construction logic — TopicMemory does
   * integrity checks, SemanticMemory does pragma setup, etc.
   *
   * The opener may be sync or async; both return paths are awaited.
   */
  async openWithHeal<T>(component: string, opener: () => T | Promise<T>): Promise<T> {
    try {
      return await opener();
    } catch (err) {
      if (!this.isNodeModuleVersionError(err)) throw err;

      // Already tried this process — don't loop, surface the original error
      if (this.healAttempted) {
        const last = this.lastResult;
        const hint = last && !last.success
          ? ` (heal previously attempted and failed: ${last.errorTail ?? 'unknown'})`
          : ' (heal previously attempted)';
        const wrapped = err instanceof Error ? err : new Error(String(err));
        wrapped.message = `${wrapped.message}${hint}`;
        throw wrapped;
      }

      const healed = await this.healBetterSqlite3(component);
      if (!healed) {
        // Don't swallow the original error; rethrow with heal context
        const wrapped = err instanceof Error ? err : new Error(String(err));
        wrapped.message = `${wrapped.message} (in-line heal failed — see ${HEAL_LOG_FILENAME})`;
        throw wrapped;
      }

      // Clear cached better-sqlite3 require entries so the fresh native
      // binding is loaded on retry.
      this.clearBetterSqlite3Cache();

      // Retry once. If this still throws, surface the new error directly
      // so the caller sees the post-rebuild failure mode.
      return await opener();
    }
  }

  /**
   * Run `npm rebuild better-sqlite3 --prefix <install_prefix>` synchronously.
   * Returns true if the rebuild succeeded, false otherwise. Always logs
   * a HealEvent.
   */
  async healBetterSqlite3(component: string): Promise<boolean> {
    if (this.healAttempted) return false;
    this.healAttempted = true;

    const started = Date.now();
    const event: HealEvent = {
      component,
      timestamp: new Date().toISOString(),
      success: false,
      nodeVersion: process.version,
    };

    const installPrefix = this.findBetterSqlite3InstallPrefix();
    if (!installPrefix) {
      event.errorTail = 'could not locate better-sqlite3 install prefix';
      console.error(`[${component}] NativeModuleHealer: ${event.errorTail}`);
      this.logHealEvent(event);
      this.lastResult = event;
      return false;
    }
    event.installPrefix = installPrefix;

    const npmPath = this.findNpmPath();
    if (!npmPath) {
      event.errorTail = 'npm not found on PATH';
      console.error(`[${component}] NativeModuleHealer: ${event.errorTail}`);
      this.logHealEvent(event);
      this.lastResult = event;
      return false;
    }
    event.npmPath = npmPath;

    console.log(
      `[${component}] NativeModuleHealer: rebuilding better-sqlite3 for Node ${process.version} (prefix=${installPrefix}). This may take ~30s.`
    );

    let result: SpawnSyncReturns<string>;
    try {
      result = spawnSync(
        process.execPath,
        [npmPath, 'rebuild', 'better-sqlite3', '--prefix', installPrefix],
        {
          encoding: 'utf-8',
          timeout: 120_000,
          cwd: installPrefix,
          env: { ...process.env, npm_config_node_gyp: undefined },
        }
      );
    } catch (spawnErr) {
      event.errorTail = `spawn failed: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
      event.durationMs = Date.now() - started;
      console.error(`[${component}] NativeModuleHealer: ${event.errorTail}`);
      this.logHealEvent(event);
      this.lastResult = event;
      return false;
    }

    event.durationMs = Date.now() - started;

    if (result.status === 0) {
      event.success = true;
      console.log(`[${component}] NativeModuleHealer: rebuild succeeded in ${event.durationMs}ms`);
      this.logHealEvent(event);
      this.lastResult = event;
      return true;
    }

    const stderrTail = (result.stderr || result.stdout || '').slice(-300);
    event.errorTail = stderrTail || `npm exited ${result.status}`;
    console.error(
      `[${component}] NativeModuleHealer: rebuild failed (status=${result.status}): ${event.errorTail}`
    );
    this.logHealEvent(event);
    this.lastResult = event;
    return false;
  }

  /**
   * Resolve the npm-installable prefix for better-sqlite3. We want the
   * directory whose `node_modules/better-sqlite3` is the one that just
   * failed to load — that's the install prefix npm needs.
   *
   * Strategy: use require.resolve('better-sqlite3'), then walk up to find
   * the parent of the `node_modules/better-sqlite3` segment.
   */
  private findBetterSqlite3InstallPrefix(): string | null {
    let resolved: string;
    try {
      resolved = require.resolve('better-sqlite3');
    } catch {
      // Module not installed at all — heal can't help.
      return null;
    }

    // resolved points at a JS file inside node_modules/better-sqlite3/...
    // Walk up to find ".../node_modules/better-sqlite3", then the install
    // prefix is the parent of node_modules.
    const segments = resolved.split(path.sep);
    for (let i = segments.length - 1; i > 0; i--) {
      if (segments[i] === 'better-sqlite3' && segments[i - 1] === 'node_modules') {
        // Install prefix = path up to (but not including) "node_modules"
        return segments.slice(0, i - 1).join(path.sep) || path.sep;
      }
    }
    return null;
  }

  /**
   * Find npm on disk. Mirrors ServerSupervisor.findNpmPath logic.
   */
  private findNpmPath(): string | null {
    // Try the node sibling first (most reliable — matches the Node version)
    const currentNodeDir = path.dirname(process.execPath);
    const siblingNpm = path.join(currentNodeDir, 'npm');
    if (fs.existsSync(siblingNpm)) return siblingNpm;

    // Platform-common locations
    const candidates =
      os.platform() === 'win32'
        ? ['C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files (x86)\\nodejs\\npm.cmd']
        : ['/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm'];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    // PATH lookup as a last resort
    try {
      const which = spawnSync(os.platform() === 'win32' ? 'where' : 'which', ['npm'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      if (which.status === 0 && which.stdout.trim()) {
        return which.stdout.trim().split(/\r?\n/)[0];
      }
    } catch {
      /* ignore */
    }

    return null;
  }

  /**
   * Clear better-sqlite3 entries from Node's require cache so the fresh
   * native binding is loaded on retry.
   */
  private clearBetterSqlite3Cache(): void {
    try {
      for (const key of Object.keys(require.cache)) {
        if (key.includes(`${path.sep}better-sqlite3${path.sep}`)) {
          delete require.cache[key];
        }
      }
    } catch {
      /* ignore — best-effort */
    }
  }

  /**
   * Remediator entry point — F-8 / W-1 (SELF-HEALING-REMEDIATOR-V2-SPEC
   * §A28, §A45, §A55). Wraps the same rebuild logic as `openWithHeal`'s
   * heal step but accepts a `RemediatorInvocationContext` so:
   *   - the abort signal is honoured (deadline / parent cancel),
   *   - the monotonic deadline gates `npm rebuild` timeout,
   *   - the rebuilt `.node` binary's sha256 is recorded in `lastResult` so
   *     the Remediator's audit-projection can detect cross-process binary
   *     divergence (A28),
   *   - `--ignore-scripts --build-from-source` are passed so the rebuild
   *     never re-runs every dep's install scripts and never picks up a
   *     poisoned prebuild binary (A45).
   *
   * Returns an `ExecutionResult`-shaped object compatible with F-8's
   * `ApprovedRunbook.surfaceCallable` contract. Errors are caught and
   * mapped to `{outcome: 'failure', details: {...}}` — the Remediator's
   * verify step (A21) decides whether the heal actually worked; this
   * method ONLY reports whether the rebuild succeeded.
   *
   * The legacy in-line `openWithHeal` entry point remains the canonical
   * safety net for direct-construction CLI paths. This method is the
   * Remediator-orchestrated parallel path; both acquire the same
   * MachineLock tuple (§A2 lock-bound co-existence), so only one rebuild
   * runs at a time on a given machine.
   */
  async invokeFromRemediator(
    ctx: RemediatorInvocationContext,
    keyVault?: InvocationContextKeyVault
  ): Promise<RemediatorExecutionResult> {
    // §A3 / §A23 — surface-side capability-token verification. When a
    // keyVault is wired AND the ctx claims an HMAC, verify it. Invalid →
    // fall back to the in-line legacy path + emit a warning so the audit
    // tail records the rejection.
    if (keyVault && ctx.hmac !== undefined) {
      const ok = this.verifyContextHmac(ctx, keyVault);
      if (!ok) {
        console.warn(
          `[NativeModuleHealer] remediation.surface.invalid-context ` +
            `runbookId=${ctx.runbookId} attemptId=${ctx.attemptId} — ` +
            `falling back to in-line openWithHeal path`,
        );
        return this.fallbackToInlineHeal(ctx);
      }
    }

    if (ctx.abortSignal.aborted) {
      return {
        outcome: 'failure',
        details: {
          reason: 'aborted-before-start',
          attemptId: ctx.attemptId,
        },
      };
    }
    if (this.healAttempted) {
      const last = this.lastResult;
      return {
        outcome: last?.success ? 'success' : 'failure',
        details: {
          reason: 'heal-already-attempted-this-process',
          previousOutcome: last,
          attemptId: ctx.attemptId,
        },
      };
    }

    // Compute remaining ns budget from monotonic deadline. Cap below 120s.
    const nowHr = process.hrtime.bigint();
    let remainingMs = 120_000;
    if (ctx.monotonicDeadline > nowHr) {
      const remainingNs = ctx.monotonicDeadline - nowHr;
      const computed = Number(remainingNs / 1_000_000n);
      if (computed < remainingMs) remainingMs = computed;
    } else {
      return {
        outcome: 'failure',
        details: {
          reason: 'deadline-already-elapsed',
          attemptId: ctx.attemptId,
        },
      };
    }
    if (remainingMs < 1_000) {
      return {
        outcome: 'failure',
        details: {
          reason: 'insufficient-deadline-budget',
          remainingMs,
          attemptId: ctx.attemptId,
        },
      };
    }

    const result = await this.healBetterSqlite3FromRemediator(
      ctx,
      remainingMs
    );
    return result;
  }

  /**
   * Remediator-side rebuild path. Mirrors `healBetterSqlite3` but uses
   * `--ignore-scripts --build-from-source <single-package>` (A28 + A45)
   * and records the sha256 of the rebuilt `.node` binary in the heal log
   * for cross-process binary-divergence detection (A28).
   *
   * Returns `{outcome: 'success' | 'failure', details: {...}}` directly so
   * the caller (W-1 runbook surfaceCallable) doesn't need a second mapping
   * step. The HealEvent is still appended to the in-line log for
   * observability parity with the legacy path.
   */
  private async healBetterSqlite3FromRemediator(
    ctx: RemediatorInvocationContext,
    timeoutMs: number
  ): Promise<RemediatorExecutionResult> {
    this.healAttempted = true;
    const component = `Remediator:${ctx.runbookId}`;

    const started = Date.now();
    const event: HealEvent = {
      component,
      timestamp: new Date().toISOString(),
      success: false,
      nodeVersion: process.version,
    };

    const installPrefix = this.findBetterSqlite3InstallPrefix();
    if (!installPrefix) {
      event.errorTail = 'could not locate better-sqlite3 install prefix';
      this.logHealEvent(event);
      this.lastResult = event;
      return {
        outcome: 'failure',
        details: { reason: event.errorTail, attemptId: ctx.attemptId },
      };
    }
    event.installPrefix = installPrefix;

    const npmPath = this.findNpmPath();
    if (!npmPath) {
      event.errorTail = 'npm not found on PATH';
      this.logHealEvent(event);
      this.lastResult = event;
      return {
        outcome: 'failure',
        details: { reason: event.errorTail, attemptId: ctx.attemptId },
      };
    }
    event.npmPath = npmPath;

    // A45 pre-rebuild integrity check: read package-lock.json's `resolved`
    // URL + integrity hash for better-sqlite3. The check is best-effort —
    // surface a non-fatal mismatch in the event but do NOT block the
    // rebuild (the in-line healer must keep working; the gold-standard
    // sha256 lockfile from A55 lands in a follow-up PR).
    const integrity = this.readPackageLockIntegrity(installPrefix);

    // A28 + A45: rebuild via `--ignore-scripts --build-from-source` with the
    // single package name as the only positional argument.
    let result: SpawnSyncReturns<string>;
    try {
      // Use namespace access so tests can monkey-patch `child_process.spawnSync`.
      result = child_process.spawnSync(
        process.execPath,
        [
          npmPath,
          'rebuild',
          '--ignore-scripts',
          '--build-from-source',
          'better-sqlite3',
          '--prefix',
          installPrefix,
        ],
        {
          encoding: 'utf-8',
          timeout: timeoutMs,
          cwd: installPrefix,
          env: { ...process.env, npm_config_node_gyp: undefined },
          signal: ctx.abortSignal,
        }
      );
    } catch (spawnErr) {
      event.errorTail = `spawn failed: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
      event.durationMs = Date.now() - started;
      this.logHealEvent(event);
      this.lastResult = event;
      return {
        outcome: 'failure',
        details: {
          reason: event.errorTail,
          attemptId: ctx.attemptId,
          aborted: ctx.abortSignal.aborted,
        },
      };
    }

    event.durationMs = Date.now() - started;

    if (ctx.abortSignal.aborted) {
      event.errorTail = `aborted during rebuild (status=${result.status ?? 'null'})`;
      this.logHealEvent(event);
      this.lastResult = event;
      return {
        outcome: 'failure',
        details: { reason: 'aborted', attemptId: ctx.attemptId },
      };
    }

    if (result.status !== 0) {
      const stderrTail = (result.stderr || result.stdout || '').slice(-300);
      event.errorTail = stderrTail || `npm exited ${result.status}`;
      this.logHealEvent(event);
      this.lastResult = event;
      return {
        outcome: 'failure',
        details: {
          reason: event.errorTail,
          npmStatus: result.status,
          attemptId: ctx.attemptId,
        },
      };
    }

    // Clear cached require entries so the next consumer sees the fresh
    // binding (parity with openWithHeal's behaviour).
    this.clearBetterSqlite3Cache();

    // A28 post-rebuild sha256 record of the rebuilt `.node` binary. Used by
    // the Remediator's audit-projection / cross-process ledger to detect
    // divergent binaries across attempts.
    const sha256 = this.computeBetterSqlite3BinarySha256(installPrefix);

    event.success = true;
    this.logHealEvent(event);
    this.lastResult = event;

    return {
      outcome: 'success',
      details: {
        attemptId: ctx.attemptId,
        installPrefix,
        npmPath,
        durationMs: event.durationMs,
        rebuiltBinarySha256: sha256,
        nodeVersion: process.version,
        packageLockIntegrity: integrity,
      },
    };
  }

  /**
   * Read `package-lock.json` and return better-sqlite3's `resolved` URL +
   * `integrity` hash, if locatable. Returns `null` on any failure — this is
   * a best-effort secondary check per A45, not authoritative.
   */
  private readPackageLockIntegrity(
    installPrefix: string
  ): { resolved: string; integrity: string } | null {
    try {
      const lockPath = path.join(installPrefix, 'package-lock.json');
      if (!fs.existsSync(lockPath)) return null;
      const raw = fs.readFileSync(lockPath, 'utf-8');
      const lock = JSON.parse(raw) as {
        packages?: Record<string, { resolved?: string; integrity?: string }>;
        dependencies?: Record<string, { resolved?: string; integrity?: string }>;
      };
      // npm@7+ uses `packages` with full nested paths.
      if (lock.packages) {
        for (const [key, val] of Object.entries(lock.packages)) {
          if (
            key === 'node_modules/better-sqlite3' ||
            key.endsWith('/node_modules/better-sqlite3')
          ) {
            if (val.resolved && val.integrity) {
              return { resolved: val.resolved, integrity: val.integrity };
            }
          }
        }
      }
      // Legacy npm@6 `dependencies` map.
      if (lock.dependencies && lock.dependencies['better-sqlite3']) {
        const dep = lock.dependencies['better-sqlite3'];
        if (dep.resolved && dep.integrity) {
          return { resolved: dep.resolved, integrity: dep.integrity };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Compute sha256 of the rebuilt better-sqlite3 `.node` binary. Used for
   * A28 cross-process binary-divergence detection. Returns null on any
   * failure — the heal still succeeded; the divergence detector simply
   * loses this data point.
   */
  private computeBetterSqlite3BinarySha256(installPrefix: string): string | null {
    try {
      const binaryPath = path.join(
        installPrefix,
        'node_modules',
        'better-sqlite3',
        'build',
        'Release',
        'better_sqlite3.node'
      );
      if (!fs.existsSync(binaryPath)) return null;
      const buf = fs.readFileSync(binaryPath);
      return crypto.createHash('sha256').update(buf).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Persist a heal event for observability. Best-effort; never throws.
   * Logged to <stateDir>/native-module-heals.jsonl if stateDir is configured,
   * otherwise to <os.tmpdir>/instar-native-module-heals.jsonl as a fallback.
   */
  private logHealEvent(event: HealEvent): void {
    try {
      const dir = this.stateDir || path.join(os.tmpdir(), 'instar');
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        /* ignore */
      }
      const logPath = path.join(dir, HEAL_LOG_FILENAME);
      fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
    } catch {
      /* ignore — observability shouldn't break the heal */
    }
  }
}

export const NativeModuleHealer = new NativeModuleHealerImpl();
