// safe-git-allow: test-helper-cleanup — resetSignatureForTests() removes a single signature file owned by the canary; migration to SafeFsExecutor tracked separately.
/**
 * Empty-prompt detector signature store with optional disk persistence.
 *
 * The completion-detector in promptRunner.ts reads from here to decide
 * what to look for in the bottom of the pane buffer when checking
 * whether Claude Code is at a ready prompt. The default pattern matches
 * Claude Code's current `❯` glyph; the canary (see {@link emptyPromptCanary})
 * can re-derive the pattern at startup if the upstream UI evolves and
 * persist the new signature so future processes inherit it.
 *
 * Per Rule 3 of the path constraints (see specs/provider-portability/
 * 05-state-detection-robustness.md): deterministic state-detection code
 * against an evolving upstream must self-heal rather than silently fail,
 * and a self-healed signature should survive process restart so the
 * recovery cost is paid once, not every boot.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** Default signature — matches Claude Code as of 2026-05-15. */
const DEFAULT_PATTERN = /^❯\s*$/;
const DEFAULT_PROMPT_LINE_PATTERN = /^❯(\s|$)/;

export type SignatureSource = 'default' | 'canary-derived';

export interface EmptyPromptSignature {
  /** Regex matching an empty (ready-state) prompt line. */
  emptyPromptPattern: RegExp;
  /** Regex matching ANY prompt line (empty or with content) — used to find the most recent prompt line. */
  anyPromptLinePattern: RegExp;
  /** Where this signature came from. */
  source: SignatureSource;
  /** When this signature was derived (ISO timestamp). */
  derivedAt: string;
}

/** On-disk persistence format. RegExps serialized as pattern source strings. */
interface PersistedSignature {
  emptyPromptPattern: string;
  anyPromptLinePattern: string;
  source: SignatureSource;
  derivedAt: string;
  /** Schema version — bump if the on-disk shape changes. */
  schemaVersion: 1;
}

const DEFAULT_SIGNATURE: EmptyPromptSignature = {
  emptyPromptPattern: DEFAULT_PATTERN,
  anyPromptLinePattern: DEFAULT_PROMPT_LINE_PATTERN,
  source: 'default',
  derivedAt: new Date(0).toISOString(),
};

let current: EmptyPromptSignature = { ...DEFAULT_SIGNATURE };
let persistedLoadAttempted = false;

/**
 * Resolve the path where this process should persist the signature.
 *
 * Order of precedence:
 *   1. `INSTAR_PROVIDER_STATE_DIR` env var (used in tests to redirect
 *      the persistence location off the real user home).
 *   2. `~/.instar/providers/anthropic-interactive-pool/`.
 */
function signaturePath(): string {
  const overrideDir = process.env['INSTAR_PROVIDER_STATE_DIR'];
  const base = overrideDir
    ? path.join(overrideDir, 'anthropic-interactive-pool')
    : path.join(os.homedir(), '.instar', 'providers', 'anthropic-interactive-pool');
  return path.join(base, 'empty-prompt-signature.json');
}

/**
 * Attempt to load a persisted signature from disk. Idempotent; only
 * runs the disk read once per process unless `force` is true. Silently
 * falls back to the default on any error (file absent, parse failure,
 * regex compile failure, schema mismatch) — persistence is an
 * optimization, not a correctness path; the canary still runs at
 * startup and will overwrite anything stale.
 */
export function loadPersistedSignature(force = false): EmptyPromptSignature {
  if (persistedLoadAttempted && !force) return current;
  persistedLoadAttempted = true;
  try {
    const raw = fs.readFileSync(signaturePath(), 'utf-8');
    const parsed = JSON.parse(raw) as PersistedSignature;
    if (parsed?.schemaVersion !== 1) return current;
    const sig: EmptyPromptSignature = {
      emptyPromptPattern: new RegExp(parsed.emptyPromptPattern),
      anyPromptLinePattern: new RegExp(parsed.anyPromptLinePattern),
      source: parsed.source,
      derivedAt: parsed.derivedAt,
    };
    current = sig;
  } catch {
    // No persisted file (or unreadable / unparseable / regex compile
    // failure) — keep the default. The canary will produce one if
    // it ends up needing to.
  }
  return current;
}

/** Read the currently-active signature. The completion detector calls this. */
export function getSignature(): EmptyPromptSignature {
  if (!persistedLoadAttempted) loadPersistedSignature();
  return current;
}

/**
 * Replace the active signature. Called by the canary when it derives a
 * new pattern from a known input/output pair. Writes the new signature
 * to disk best-effort so future processes inherit it; disk failure is
 * non-fatal (the in-process store still has the new signature, and the
 * canary re-runs at next startup).
 */
export function setSignature(sig: Omit<EmptyPromptSignature, 'derivedAt'>): void {
  current = { ...sig, derivedAt: new Date().toISOString() };
  persistedLoadAttempted = true;
  try {
    const filePath = signaturePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const onDisk: PersistedSignature = {
      emptyPromptPattern: current.emptyPromptPattern.source,
      anyPromptLinePattern: current.anyPromptLinePattern.source,
      source: current.source,
      derivedAt: current.derivedAt,
      schemaVersion: 1,
    };
    fs.writeFileSync(filePath, JSON.stringify(onDisk, null, 2), 'utf-8');
  } catch {
    // Persistence is best-effort. Failure here doesn't invalidate the
    // in-process store — the canary already validated the signature
    // against a real upstream response.
  }
}

/**
 * Test helper — reset to default AND remove any persisted file in the
 * current state directory. Tests that exercise persistence should set
 * `INSTAR_PROVIDER_STATE_DIR` to a tmpdir before invoking.
 */
export function resetSignatureForTests(): void {
  current = { ...DEFAULT_SIGNATURE };
  persistedLoadAttempted = false;
  try {
    fs.rmSync(signaturePath(), { force: true });
  } catch {
    // ignore
  }
}
