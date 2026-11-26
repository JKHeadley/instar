/**
 * TccProtectedPathGuard — the structural guard behind the constitutional
 * standard "Avoid TCC-Protected Directories — No Agent State Under
 * ~/Documents on macOS" (docs/STANDARDS-REGISTRY.md).
 *
 * THE INCIDENT (2026-10-14 16:00:05 PDT): macOS TCC withdrew ~/Documents
 * access from the single tmux server every agent server on the operator's
 * laptop is a child of. 28,382 EPERM denials in 22 minutes. Two agents whose
 * project directories lived under ~/Documents/Projects died in the same
 * second on EPERM writing their own state files — not a crash, not memory,
 * not an update. Access returned ~14 minutes later and they self-recovered.
 * A third agent survived only because its project directory had been moved
 * out of ~/Documents the day before. Sessions under that tmux server could
 * not even read ~/Documents, so log forensics needed sudo.
 *
 * Operator mandate (Justin, 2026-10-14): "We need to make a global Instar
 * mandate that the Documents folder on Mac is AVOIDED AT ALL COSTS."
 *
 * What this module does (and deliberately does NOT do):
 *   - `classifyTccProtectedPath` — pure classification: is this path under a
 *     macOS TCC-protected user folder (Documents, Desktop, Downloads, iCloud
 *     Drive)? Resolves symlinks (the longest existing prefix) so a leftover
 *     symlink at the OLD path never counts and a symlink INTO a protected
 *     folder always does. Non-macOS platforms are never protected: this is a
 *     macOS TCC problem and the guard must not misfire on Linux.
 *   - `assertNotTccProtected` — the refusal `instar init` uses at creation.
 *     Absolute, not overridable: a brand-new agent has nothing to move, the
 *     cost of refusing is choosing another directory, and an override would
 *     recreate exactly the incident class the mandate forbids "at all costs".
 *   - `runTccProtectedPathDetection` — the boot-time detector: inspects the
 *     running agent's project + state directories and raises ONE deduped
 *     attention item (or a JSONL fallback line when Telegram is absent)
 *     pointing at the move runbook. Signal-only: it never moves, deletes or
 *     blocks anything. Existing agents inside ~/Documents keep running; they
 *     are told, loudly and once per distinct finding, every boot.
 *
 * Signal vs authority (docs/signal-vs-authority.md): the one blocking
 * decision here (refuse at creation) is a deterministic safety guard on a
 * closed, enumerable input (path containment under four fixed folders) —
 * the carve-out that permits brittle logic in the SAFE direction. Nothing
 * at runtime holds blocking authority.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GuardRuntimeStatus } from '../monitoring/GuardRegistry.js';

/** Runbook every surface points at. Kept as ONE constant so the pointer cannot drift. */
export const TCC_MOVE_RUNBOOK = 'docs/runbooks/move-agent-out-of-documents.md';

/** The /guards inventory key (see src/monitoring/guardManifest.ts). */
export const TCC_GUARD_KEY = 'monitoring.tccProtectedPathGuard';

/** Attention-item plumbing: stable category + feature-scoped source key. */
export const TCC_ATTENTION_CATEGORY = 'tcc-protected-path';
export const TCC_ATTENTION_SOURCE = 'tcc-protected-path-guard';

export type TccZone = 'Documents' | 'Desktop' | 'Downloads' | 'iCloud Drive';

export interface TccZoneRoot {
  zone: TccZone;
  /** Absolute, symlink-resolved root of the zone (or the nominal path when it does not exist). */
  root: string;
}

export interface TccClassification {
  /** The path exactly as given. */
  path: string;
  /** Symlink-resolved absolute path (longest existing prefix resolved; the rest appended). */
  realPath: string;
  platform: string;
  /** True only on macOS AND inside a protected zone. */
  protected: boolean;
  zone: TccZone | null;
  zoneRoot: string | null;
}

export interface TccClassifyOptions {
  /** Injected for tests; defaults to `process.platform`. */
  platform?: string;
  /** Injected for tests; defaults to `os.homedir()`. */
  homeDir?: string;
}

/**
 * The four macOS user folders whose access is mediated by TCC
 * (Transparency, Consent and Control). Documents, Desktop and Downloads are
 * Apple's three "protected folders" (one consent prompt class since macOS
 * 10.15); iCloud Drive (`~/Library/Mobile Documents`) carries the same
 * consent class AND can evict files to the cloud underneath a running
 * process. Removable and network volumes are also TCC-gated but are not
 * enumerated here — an agent home on a removable volume is a different
 * failure (unmount) and is out of this guard's scope by design.
 */
export function tccProtectedZones(homeDir: string = os.homedir()): TccZoneRoot[] {
  const zones: Array<[TccZone, string]> = [
    ['Documents', path.join(homeDir, 'Documents')],
    ['Desktop', path.join(homeDir, 'Desktop')],
    ['Downloads', path.join(homeDir, 'Downloads')],
    ['iCloud Drive', path.join(homeDir, 'Library', 'Mobile Documents')],
  ];
  return zones.map(([zone, nominal]) => ({ zone, root: realpathOfLongestExistingPrefix(nominal) }));
}

/**
 * Resolve symlinks on the longest existing prefix of `p` and re-append the
 * non-existent remainder. A fresh `instar init <name>` targets a directory
 * that does not exist yet; its PARENT is what decides the zone.
 */
export function realpathOfLongestExistingPrefix(p: string): string {
  const abs = path.resolve(p);
  let probe = abs;
  const tail: string[] = [];
  // Walk up until something exists (the filesystem root always does).
  for (;;) {
    try {
      // `.native` asks the kernel, which returns the ON-DISK case. The JS
      // implementation echoes the caller's case, so on the default
      // case-insensitive APFS `~/documents/x` would compare unequal to
      // `~/Documents` and slip past the guard (second-pass finding #1).
      const real = fs.realpathSync.native(probe);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return abs; // unreachable in practice: '/' exists
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

function isContained(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(prefix);
}

/** Pure classification. Never throws; never touches anything but `realpath`. */
export function classifyTccProtectedPath(p: string, opts: TccClassifyOptions = {}): TccClassification {
  const platform = opts.platform ?? process.platform;
  const realPath = realpathOfLongestExistingPrefix(p);
  const base: TccClassification = { path: p, realPath, platform, protected: false, zone: null, zoneRoot: null };
  if (platform !== 'darwin') return base;
  const homeDir = opts.homeDir ?? os.homedir();
  for (const { zone, root } of tccProtectedZones(homeDir)) {
    if (isContained(realPath, root)) {
      return { ...base, protected: true, zone, zoneRoot: root };
    }
  }
  return base;
}

/** The refusal/notice text, shared by init, doctor, the attention item and the migration. */
export function describeTccProtectedPath(c: TccClassification, what: string): string {
  const where = c.realPath === path.resolve(c.path) ? c.realPath : `${c.path} (resolves to ${c.realPath})`;
  return (
    `${what} ${where} is under ~/${c.zone} on macOS, a TCC-protected folder. ` +
    `macOS can withdraw that folder's access grant at any moment from the process tree the agent runs in, ` +
    `and every agent sharing that tree dies at once (2026-10-14: two agents died in the same second on EPERM ` +
    `writing their own state files). Instar refuses to place agent state there "at all costs" (operator mandate). ` +
    `Use a location outside ~/Documents, ~/Desktop, ~/Downloads and iCloud Drive — for example ~/.instar/agents/<name> ` +
    `(\`instar init --standalone <name>\`) or ~/Projects/<name>. To move an existing agent, follow ${TCC_MOVE_RUNBOOK}.`
  );
}

export class TccProtectedPathRefusal extends Error {
  readonly classification: TccClassification;
  constructor(classification: TccClassification, what: string) {
    super(`tcc-protected-path: refused — ${describeTccProtectedPath(classification, what)}`);
    this.name = 'TccProtectedPathRefusal';
    this.classification = classification;
  }
}

/**
 * Refuse at creation. Throws `TccProtectedPathRefusal` when `p` is under a
 * protected zone on macOS; returns the (non-protected) classification
 * otherwise. No override parameter exists on purpose — see the module header.
 */
export function assertNotTccProtected(p: string, what: string, opts: TccClassifyOptions = {}): TccClassification {
  const c = classifyTccProtectedPath(p, opts);
  if (c.protected) throw new TccProtectedPathRefusal(c, what);
  return c;
}

// ── Boot-time detection (signal-only) ────────────────────────────────────

export interface TccAttentionItemInput {
  /** `tcc-protected-path:<hash of the protected real-path set>` — AttentionQueue dedupes on id collision. */
  id: string;
  title: string;
  summary: string;
  description?: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext?: string;
}

export interface TccDetectionOptions extends TccClassifyOptions {
  /** The agent's project directory (what `instar init` created). */
  projectDir: string;
  /** The agent's `.instar` state directory — also where the JSONL fallback lands. */
  stateDir: string;
  /** Extra labelled paths to inspect (a vault, a database, a worktree root). */
  extraPaths?: Array<{ label: string; path: string }>;
  /** Attention sink; absent → JSONL fallback at `<stateDir>/audit/tcc-protected-path.jsonl`.
   *  The server passes an UPSERT (reopen-capable, hub-only) so a finding that
   *  was resolved without a move is reopened at the next boot, while an OPEN,
   *  unchanged item is never re-posted. */
  emitAttention?: (item: TccAttentionItemInput) => Promise<void>;
  /** Resolve every OPEN item of `category` when the finding set is EMPTY —
   *  the item closes itself once the agent has been moved. Returns the count. */
  resolveAttention?: (category: string) => Promise<number>;
  /** Bound on the attention sink (a hung Telegram API must not stall boot);
   *  on timeout the finding is written to the JSONL fallback instead. */
  emitTimeoutMs?: number;
  /** Override the fallback path (tests). */
  fallbackPath?: string;
  /** Clock injection (tests). */
  now?: () => number;
}

export interface TccCheckedPath {
  label: string;
  classification: TccClassification;
}

export interface TccDetectionResult {
  platform: string;
  /** False on non-macOS: nothing was classified as protected by construction. */
  applicable: boolean;
  checked: TccCheckedPath[];
  /** The protected findings — the content of the ONE aggregated item. */
  protectedPaths: Array<{ label: string; path: string; realPath: string; zone: TccZone }>;
  /** Items emitted this run (Telegram path or JSONL path) — at most 1. */
  emitted: number;
  /** Items deduped against the 24h JSONL window (fallback path only). */
  deduped: number;
  /** True when the attention sink exceeded `emitTimeoutMs`; the finding went to the JSONL fallback. */
  emitTimedOut: boolean;
  /** Set when the attention sink THREW; the finding still went to the JSONL fallback. Distinct from
   *  `error` (a failed classification): the verdict was produced, only its delivery degraded. */
  emitError?: string;
  /** OPEN items of the category resolved because the finding set is empty (0 when none / no resolver). */
  resolved: number;
  /** Epoch-ms when the check ran — the guard row's lastTickAt. */
  checkedAt: number;
  /** Set when the check itself failed; the guard row then reads verdictUnknown. */
  error?: string;
}

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const FALLBACK_BASENAME = 'tcc-protected-path.jsonl';

export function buildTccAttentionItem(
  protectedPaths: TccDetectionResult['protectedPaths'],
): TccAttentionItemInput {
  const sorted = [...protectedPaths].sort((a, b) => a.realPath.localeCompare(b.realPath));
  const setHash = crypto.createHash('sha256').update(sorted.map((p) => p.realPath).join('\n')).digest('hex').slice(0, 16);
  const zones = [...new Set(sorted.map((p) => p.zone))].join(', ');
  const listed = sorted.map((p) => `• ${p.label}: ${p.path}${p.realPath !== path.resolve(p.path) ? ` → ${p.realPath}` : ''} (~/${p.zone})`).join('\n');
  return {
    id: `${TCC_ATTENTION_CATEGORY}:${setHash}`,
    title: `This agent's files live in a macOS protected folder (${zones})`,
    summary:
      `${sorted[0].label} ${sorted[0].path} is under ~/${sorted[0].zone}` +
      (sorted.length > 1 ? ` (+${sorted.length - 1} more)` : '') +
      `. macOS can withdraw that folder's access at any moment and every agent in this process tree dies at once ` +
      `(this happened on 2026-10-14). Nothing was moved. Move it out: ${TCC_MOVE_RUNBOOK}.`,
    description:
      'Operator mandate (2026-10-14): the Documents folder on Mac is AVOIDED AT ALL COSTS. ' +
      'Documents, Desktop, Downloads and iCloud Drive are TCC-protected: the grant lives on the process tree ' +
      '(the shared tmux server), so a single withdrawal kills every agent under it in the same second. ' +
      `The move is a rename on the same disk + a symlink at the old path + a launchd plist update — see ${TCC_MOVE_RUNBOOK}. ` +
      'This guard does not move or delete anything.\n' + listed,
    category: TCC_ATTENTION_CATEGORY,
    priority: 'HIGH',
    sourceContext: TCC_ATTENTION_SOURCE,
  };
}

export async function runTccProtectedPathDetection(opts: TccDetectionOptions): Promise<TccDetectionResult> {
  const now = opts.now ?? Date.now;
  const platform = opts.platform ?? process.platform;
  const result: TccDetectionResult = {
    platform,
    applicable: platform === 'darwin',
    checked: [],
    protectedPaths: [],
    emitted: 0,
    deduped: 0,
    emitTimedOut: false,
    resolved: 0,
    checkedAt: now(),
  };
  try {
    const candidates: Array<{ label: string; path: string }> = [
      { label: 'project directory', path: opts.projectDir },
      { label: 'state directory', path: opts.stateDir },
      ...(opts.extraPaths ?? []),
    ];
    const seenReal = new Set<string>();
    for (const cand of candidates) {
      const classification = classifyTccProtectedPath(cand.path, { platform, homeDir: opts.homeDir });
      result.checked.push({ label: cand.label, classification });
      if (classification.protected && classification.zone && !seenReal.has(classification.realPath)) {
        seenReal.add(classification.realPath);
        result.protectedPaths.push({
          label: cand.label,
          path: cand.path,
          realPath: classification.realPath,
          zone: classification.zone,
        });
      }
    }
    // Bounded Notification Surface: ONE aggregated item per distinct finding
    // set, never one per path. A changed set is one new item.
    if (result.protectedPaths.length > 0) {
      await emitOrFallback(buildTccAttentionItem(result.protectedPaths), opts, result, now);
    } else if (opts.resolveAttention) {
      // The finding cleared (the agent was moved): close the item ourselves —
      // Close the Loop, and the runbook's "resolves itself" promise is code.
      result.resolved = await opts.resolveAttention(TCC_ATTENTION_CATEGORY);
    }
  } catch (err) {
    // @silent-fallback-ok — not silent: captured into result.error, which the
    //   /guards row reads as verdictUnknown and the boot line prints as
    //   "check failed"; the boot itself must never fail on this guard.
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

const DEFAULT_EMIT_TIMEOUT_MS = 10_000;

async function emitOrFallback(
  item: TccAttentionItemInput,
  opts: TccDetectionOptions,
  result: TccDetectionResult,
  now: () => number,
): Promise<void> {
  if (opts.emitAttention) {
    // The sink (an upsert on the attention store) owns dedupe / reopen. A hung
    // sink must not stall boot and a throwing sink must not lose the finding:
    // either way the JSONL fallback below records it durably for this boot.
    const timeoutMs = opts.emitTimeoutMs ?? DEFAULT_EMIT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    let outcome: 'ok' | 'timeout' | 'error' = 'ok';
    let emitError: string | undefined;
    try {
      const raced = await Promise.race([opts.emitAttention(item).then(() => 'ok' as const), timedOut]);
      if (raced === 'timeout') outcome = 'timeout';
    } catch (err) {
      // @silent-fallback-ok — not silent: recorded as result.emitError (boot line
      //   suffix) and the finding is written to the JSONL fallback below.
      outcome = 'error';
      emitError = err instanceof Error ? err.message : String(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (outcome === 'ok') {
      result.emitted++;
      return;
    }
    if (outcome === 'timeout') result.emitTimedOut = true;
    else result.emitError = emitError;
    // fall through: durable fallback so the finding is on disk regardless
  }
  const fallbackPath = opts.fallbackPath ?? path.join(opts.stateDir, 'audit', FALLBACK_BASENAME);
  if (readRecentDedupeKeys(fallbackPath, now()).has(item.id)) {
    result.deduped++;
    return;
  }
  fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
  fs.appendFileSync(
    fallbackPath,
    JSON.stringify({
      ts: new Date(now()).toISOString(),
      dedupeKey: item.id,
      category: item.category,
      priority: item.priority,
      title: item.title,
      summary: item.summary,
      description: item.description,
      sourceContext: item.sourceContext,
    }) + '\n',
    { mode: 0o600 },
  );
  result.emitted++;
}

function readRecentDedupeKeys(fallbackPath: string, nowMs: number): Set<string> {
  const keys = new Set<string>();
  let raw: string;
  try {
    raw = fs.readFileSync(fallbackPath, 'utf-8');
  } catch {
    // @silent-fallback-ok — no fallback file yet (or unreadable) means no dedupe
    //   for this run; worst case is one duplicate JSONL line, never a lost finding.
    return keys;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { ts?: string; dedupeKey?: string };
      if (!parsed.dedupeKey || !parsed.ts) continue;
      const age = nowMs - Date.parse(parsed.ts);
      if (Number.isFinite(age) && age >= 0 && age < DEDUPE_WINDOW_MS) keys.add(parsed.dedupeKey);
    } catch {
      // @silent-fallback-ok — a torn line loses only its own dedupe key.
    }
  }
  return keys;
}

/** One-line boot summary for the server log. */
export function summarizeTccDetection(result: TccDetectionResult): string {
  if (result.error) return `TCC-protected path guard: check failed (${result.error})`;
  if (!result.applicable) return `TCC-protected path guard: not applicable on ${result.platform} (macOS-only check)`;
  if (result.protectedPaths.length === 0) return 'TCC-protected path guard: clear (no agent state under Documents/Desktop/Downloads/iCloud Drive)';
  const first = result.protectedPaths[0];
  const delivery = result.emitTimedOut
    ? ' [attention sink timed out → recorded in the JSONL fallback]'
    : result.emitError
      ? ` [attention sink failed: ${result.emitError} → recorded in the JSONL fallback]`
      : '';
  return (
    `TCC-PROTECTED PATH: ${first.label} ${first.path} is under ~/${first.zone}` +
    (result.protectedPaths.length > 1 ? ` (+${result.protectedPaths.length - 1} more)` : '') +
    ` — macOS can withdraw access at any moment and every agent in this process tree dies at once. ` +
    `Nothing was moved. Runbook: ${TCC_MOVE_RUNBOOK}` + delivery
  );
}

/**
 * The /guards runtime getter. SYNCHRONOUS in-memory read (GuardRegistry
 * contract): the detection ran once at boot; the row reports that it did.
 * A failed check reads `verdictUnknown` — louder, never greener.
 */
export function tccGuardStatus(result: TccDetectionResult | null): GuardRuntimeStatus {
  if (!result) return { enabled: true, lastTickAt: 0 };
  return {
    enabled: true,
    lastTickAt: result.checkedAt,
    ...(result.error
      ? { verdictUnknown: true, verdictUnknownReason: `detection failed: ${result.error}`.slice(0, 200) }
      : {}),
  };
}
