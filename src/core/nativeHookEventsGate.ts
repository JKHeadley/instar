/**
 * Native hook events — the ONE decision of whether a machine's
 * `.claude/settings.json` carries native HTTP reporter hooks or today's
 * command entries (docs/specs/native-hook-events.md D4).
 *
 * Shared by the server boot reconcile, the launch-time re-validation and every
 * PostUpdateMigrator construction site, so the three can never disagree.
 *
 *   - `hooks.nativeEventReporter.enabled` (default false) is the flag.
 *   - The Claude Code version sessions launch from must be >= 2.1.310 (the
 *     version HTTP hooks were verified on). The version comes from
 *     `resolveSessionClaudeVersion`, which reads the configured claude path
 *     (never PATH) and, when the binary retainer is on, the retained copy of
 *     that same build. Unreadable ⇒ command entries.
 *   - A server not listening on loopback ⇒ command entries.
 *
 * A flag that is on but not in effect reports a `notInEffect` reason; callers
 * surface it as a degradation once per boot so it is never silent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readClaudeVersion, looksLikeClaudeInstall, resolveRetainerEnabled, ClaudeBinaryRetainer, RETAINED_BINARY_NAME } from './ClaudeBinaryRetainer.js';
import { reconcileReporterHooks } from '../data/http-hook-templates.js';

export const MIN_NATIVE_HOOK_CLAUDE_VERSION = '2.1.310';

export type NotInEffectReason =
  | 'claude-version-unreadable'
  | 'claude-version-too-old'
  | 'not-listening-on-loopback';

export interface SessionClaudeVersionInput {
  /** The configured Claude Code binary path (`frameworkBinaryPaths['claude-code']` ?? `sessions.claudePath`). */
  claudePath?: string | null;
  /** `sessions.retainedClaudeBinary` */
  retainer?: { enabled?: boolean; dir?: string } | null;
  projectDir: string;
  /** Test seam / bounded `--version` probe. */
  versionProbe?: (bin: string) => string;
  env?: NodeJS.ProcessEnv;
}

export type SessionClaudeVersion =
  | { readable: true; version: string; launchPath: string; source: 'retained' | 'configured' }
  | { readable: false; reason: string };

/**
 * The version of the binary claude-code sessions launch from. Pure in the
 * sense that matters here: a function of its inputs, never PATH. A bare
 * command name is unreadable by design (resolving it would read PATH).
 *
 * With the retainer on, sessions launch from `<dir>/<version>/claude`, a
 * byte copy of the configured binary's current build — so the retained
 * copy's version IS the configured build's version. When that copy already
 * exists it is reported as the launch path.
 */
export function resolveSessionClaudeVersion(input: SessionClaudeVersionInput): SessionClaudeVersion {
  const configured = (input.claudePath ?? '').trim();
  if (!configured) return { readable: false, reason: 'no-claude-path' };
  if (!configured.includes('/')) return { readable: false, reason: 'bare-command-name' };
  let real: string;
  try {
    real = fs.realpathSync(configured);
    if (!fs.statSync(real).isFile()) return { readable: false, reason: 'not-a-file' };
  } catch {
    // @silent-fallback-ok — "unreadable" is the safe answer (command entries kept); a flag that is on reports it once per boot as the NativeHookEvents.notInEffect degradation.
    return { readable: false, reason: 'claude-path-missing' };
  }
  if (!looksLikeClaudeInstall(real)) return { readable: false, reason: 'not-claude-binary' };
  let version: string | null = null;
  // Native installer layout: ~/.local/share/claude/versions/<ver> (no package.json).
  if (path.basename(path.dirname(real)) === 'versions' && /^\d+\.\d+\.\d+/.test(path.basename(real))) {
    version = path.basename(real);
  }
  if (!version) {
    try {
      version = (input.versionProbe ? readClaudeVersion(real, input.versionProbe) : readClaudeVersion(real)).version;
    } catch {
      // @silent-fallback-ok — an unreadable version keeps the command entries and, with the flag on, raises NativeHookEvents.notInEffect once per boot.
      version = null;
    }
  }
  if (!version) return { readable: false, reason: 'version-unreadable' };
  const retainerOn = resolveRetainerEnabled(input.retainer?.enabled, input.env ?? process.env);
  if (retainerOn) {
    const dir = input.retainer?.dir || ClaudeBinaryRetainer.defaultDir(input.projectDir);
    const retained = path.join(dir, version, RETAINED_BINARY_NAME);
    if (fs.existsSync(retained)) return { readable: true, version, launchPath: retained, source: 'retained' };
  }
  return { readable: true, version, launchPath: real, source: 'configured' };
}

/** Numeric x.y.z compare (pre-release / build suffixes ignored). */
export function compareClaudeVersions(a: string, b: string): number {
  const parse = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1, 4).map((n) => Number(n));
  const pa = parse(a);
  const pb = parse(b);
  if (pa.length !== 3 || pb.length !== 3) return NaN;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ALL_INTERFACES = new Set(['0.0.0.0', '::']);

/**
 * The loopback base URL the native hooks must post to, or null when the server
 * is not listening on loopback (an explicit non-loopback, non-wildcard host).
 */
export function nativeHookBaseUrl(port: number, host?: string | null): string | null {
  const h = (host ?? '').trim();
  if (h === '::1') return `http://[::1]:${port}`;
  if (!h || LOOPBACK_HOSTS.has(h) || ALL_INTERFACES.has(h)) return `http://127.0.0.1:${port}`;
  return null;
}

export interface NativeReporterDecisionInput {
  flagEnabled: boolean;
  port: number;
  host?: string | null;
  version: SessionClaudeVersion;
}

export interface NativeReporterDecision {
  native: boolean;
  baseUrl: string | null;
  /** Set only when the flag is ON but the native entries are not in effect. */
  notInEffect?: { reason: NotInEffectReason; detail: string };
}

export function decideNativeReporter(input: NativeReporterDecisionInput): NativeReporterDecision {
  const baseUrl = nativeHookBaseUrl(input.port, input.host);
  if (!input.flagEnabled) return { native: false, baseUrl };
  if (!baseUrl) {
    return { native: false, baseUrl: null, notInEffect: { reason: 'not-listening-on-loopback', detail: `server host ${input.host}` } };
  }
  if (!input.version.readable) {
    return { native: false, baseUrl, notInEffect: { reason: 'claude-version-unreadable', detail: input.version.reason } };
  }
  const cmp = compareClaudeVersions(input.version.version, MIN_NATIVE_HOOK_CLAUDE_VERSION);
  if (!(cmp >= 0)) {
    return {
      native: false,
      baseUrl,
      notInEffect: { reason: 'claude-version-too-old', detail: `Claude Code ${input.version.version} < ${MIN_NATIVE_HOOK_CLAUDE_VERSION}` },
    };
  }
  return { native: true, baseUrl };
}

/** Raw-config shape the gate reads (works on a loaded InstarConfig or the raw file). */
export interface NativeHookConfigView {
  port?: number;
  host?: string;
  hooks?: { nativeEventReporter?: { enabled?: boolean } };
  /** `multiMachine.meshTransport.bindHost` — an explicit bind override also decides the listen address. */
  multiMachine?: { meshTransport?: { bindHost?: string } };
  sessions?: {
    claudePath?: string;
    frameworkBinaryPaths?: { 'claude-code'?: string };
    retainedClaudeBinary?: { enabled?: boolean; dir?: string };
  };
}

export function nativeReporterFlagEnabled(cfg: NativeHookConfigView | null | undefined): boolean {
  return cfg?.hooks?.nativeEventReporter?.enabled === true;
}

/** The configured claude-code binary for the gate: per-framework path first, then claudePath. */
export function configuredClaudeCodePath(cfg: NativeHookConfigView | null | undefined): string | null {
  return cfg?.sessions?.frameworkBinaryPaths?.['claude-code'] ?? cfg?.sessions?.claudePath ?? null;
}

/** Full decision from a config view. */
export function decideNativeReporterFromConfig(
  cfg: NativeHookConfigView,
  opts: { projectDir: string; port?: number; claudeCodePath?: string | null; versionProbe?: (bin: string) => string; env?: NodeJS.ProcessEnv },
): NativeReporterDecision {
  const flagEnabled = nativeReporterFlagEnabled(cfg);
  const port = opts.port ?? cfg.port ?? 4040;
  // Only probe the binary when the flag is on — flag-off agents pay nothing.
  const version: SessionClaudeVersion = flagEnabled
    ? resolveSessionClaudeVersion({
        claudePath: opts.claudeCodePath ?? configuredClaudeCodePath(cfg),
        retainer: cfg.sessions?.retainedClaudeBinary ?? null,
        projectDir: opts.projectDir,
        versionProbe: opts.versionProbe,
        env: opts.env,
      })
    : { readable: false, reason: 'flag-off' };
  return decideNativeReporter({ flagEnabled, port, host: effectiveListenHost(cfg), version });
}

/**
 * The host the server actually binds, by the same precedence AgentServer uses
 * (`resolveMeshBindHost`): an explicit non-loopback `host`, else an explicit
 * `multiMachine.meshTransport.bindHost`, else loopback or the all-interfaces
 * mesh default (both of which listen on 127.0.0.1).
 */
export function effectiveListenHost(cfg: NativeHookConfigView): string | undefined {
  const h = (cfg.host ?? '').trim();
  if (h && !LOOPBACK_HOSTS.has(h)) return h;
  const bind = (cfg.multiMachine?.meshTransport?.bindHost ?? '').trim();
  if (bind) return bind;
  return h || undefined;
}

/** Read `<stateDir>/config.json` as a gate view; null when missing/unreadable. */
export function readNativeHookConfigFile(stateDir: string): NativeHookConfigView | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8')) as NativeHookConfigView;
  } catch {
    // @silent-fallback-ok — an unreadable config resolves to "flag off", i.e. today's command entries.
    return null;
  }
}

/**
 * Reconcile one settings file to the decision. Instar-owned reporter entries
 * only; idempotent; writes only when something changed. Returns whether it
 * wrote. Throws on an unparseable file (callers report it).
 */
export function reconcileReporterSettingsFile(settingsPath: string, decision: NativeReporterDecision): boolean {
  if (!fs.existsSync(settingsPath)) return false;
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  const changed = reconcileReporterHooks(hooks as Record<string, unknown>, {
    native: decision.native,
    baseUrl: decision.baseUrl ?? undefined,
  });
  if (changed) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return changed;
}

export interface NativeReporterBootDeps {
  projectDir: string;
  decision: NativeReporterDecision;
  /** Raise the once-per-boot `NativeHookEvents.notInEffect` degradation. */
  reportNotInEffect?: (reason: NotInEffectReason, detail: string) => void;
  /** Is `.claude/settings.json` tracked by git here? (warned once: it must stay machine-local) */
  isSettingsTracked?: (settingsPath: string) => boolean;
  log?: (msg: string) => void;
}

/**
 * Server boot reconcile (D4): reconcile the settings file to this machine's
 * decision once, report a flag-on-but-not-in-effect state once, warn once if
 * the settings file is git-tracked, and return the launch-time check the
 * session launcher runs immediately before each claude-code spawn (a sync can
 * overwrite the file between boot and launch).
 */
export function bootReconcileNativeReporter(deps: NativeReporterBootDeps): { launchCheck: () => boolean; changedAtBoot: boolean } {
  const log = deps.log ?? ((m: string) => console.log(m));
  const settingsPath = path.join(deps.projectDir, '.claude', 'settings.json');
  if (deps.decision.notInEffect) {
    deps.reportNotInEffect?.(deps.decision.notInEffect.reason, deps.decision.notInEffect.detail);
  }
  let changedAtBoot = false;
  try {
    changedAtBoot = reconcileReporterSettingsFile(settingsPath, deps.decision);
    if (changedAtBoot) {
      log(`[native-hook-events] reconciled reporter hooks → ${deps.decision.native ? 'native http' : 'command'} entries`);
    }
  } catch (err) {
    log(`[native-hook-events] boot reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    if (fs.existsSync(settingsPath) && deps.isSettingsTracked?.(settingsPath)) {
      log('[native-hook-events] WARNING: .claude/settings.json is tracked by git; its reporter entries are machine-local (port + version gate) and a sync can flip them between machines. The launcher re-validates them before each claude-code spawn.');
    }
  } catch {
    // @silent-fallback-ok — the tracked-file warning is advisory only.
  }
  const launchCheck = (): boolean => {
    try {
      return reconcileReporterSettingsFile(settingsPath, deps.decision);
    } catch (err) {
      // @silent-fallback-ok — logged; a failed re-validation leaves the file as the boot reconcile wrote it and the session still launches (a reporter must never block a spawn).
      log(`[native-hook-events] launch-time reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };
  return { launchCheck, changedAtBoot };
}
