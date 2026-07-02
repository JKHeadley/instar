/**
 * Registry high-water marker + degenerate-state classification
 * (silent-loss-refusal-conservation §2.D — "Verify the State, Not Its Symbol" +
 * "Cross-Store Coherence Is an Invariant").
 *
 * The 2026-07-01 silent-loss root cause: a machine's `users.json` was a fixture-
 * clobbered / emptied store, and sender re-validation armed against it and
 * rejected EVERYONE (including the operator). The fix (§2.D) refuses to arm
 * against a degenerate registry — but a FRESH install writes `users.json` as `[]`,
 * byte-identical to an EMPTIED-by-deletion store. A durable "this registry has
 * held a real user before" high-water marker disambiguates them:
 *
 *   - never-populated `[]` (no high-water)  → DEGENERATE → fail toward DELIVERY.
 *   - emptied-by-deletion `[]` (high-water) → POPULATED  → keep REJECTING + shout.
 *   - parse-failure / corrupt / partial     → UNKNOWN_UNSAFE → fail CLOSED (reject).
 *
 * High-water is MONOTONIC (never cleared on user removal) and machine-local — it
 * shares `users.json`'s FS trust boundary (flipping it in the dangerous direction
 * needs the same local FS access as clobbering users.json itself), so it needs no
 * separate integrity envelope (§2.D at-rest honesty).
 *
 * Pure + dependency-free (fs only): the arm decision reads the RAW file bytes so it
 * can see states the in-memory UserManager (post fixture-refusal) has already
 * dropped. Callers stat-gate the read (§2.D per-call arm decision).
 */

import fs from 'node:fs';
import path from 'node:path';

/** The durable high-water marker path (machine-local, shares users.json trust boundary). */
export function registryHighWaterPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'registry-high-water.json');
}

/** Has this machine's authoritative local registry EVER held a resolvable real user? */
export function readRegistryHighWater(stateDir: string): boolean {
  try {
    const raw = fs.readFileSync(registryHighWaterPath(stateDir), 'utf-8');
    const obj = JSON.parse(raw) as { everPopulated?: unknown };
    return obj?.everPopulated === true;
  } catch {
    // @silent-fallback-ok: a high-water read fault → treat as never-populated,
    // which classifies an empty registry as degenerate → DELIVER (fail toward
    // delivery), the safe direction for the silent-loss class this fixes.
    return false;
  }
}

/**
 * Set the high-water marker (monotonic; idempotent). Called on every path that
 * introduces a real (non-fixture) user into the authoritative local `users.json`
 * — an API/CLI register + a non-fixture initialUsers merge + the §4 boot back-fill.
 * NEVER set from WS2.6 replication-in (advisory, does not enter users.json).
 * Returns true iff it wrote (was previously unset).
 */
export function setRegistryHighWater(stateDir: string, reason: string): boolean {
  if (readRegistryHighWater(stateDir)) return false;
  const p = registryHighWaterPath(stateDir);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ everPopulated: true, setAt: new Date().toISOString(), reason }, null, 2));
    fs.renameSync(tmp, p);
    return true;
  } catch {
    // @silent-fallback-ok: best-effort marker write; a write fault just means the
    // marker isn't set yet — it is retried on the next real-user register, and an
    // unset marker fails TOWARD delivery (never a silent reject).
    return false;
  }
}

export type RegistryClass = 'degenerate' | 'populated' | 'unknown-unsafe';

export interface RegistryClassification {
  klass: RegistryClass;
  detail: string;
  /** Number of parseable user entries in the raw file (0 for empty/missing). */
  rawUserCount: number;
}

/**
 * Classify the raw on-disk registry state for the sender-re-validation arm
 * decision (§2.D taxonomy). Reads the RAW file (never the in-memory manager) so
 * it sees emptied / corrupt states the manager may have masked.
 *
 * Taxonomy (decision 5):
 *   - clean ENOENT + NO high-water            → degenerate (deliver — a fresh install).
 *   - valid `[]` + NO high-water              → degenerate (deliver).
 *   - valid `[]` + high-water                 → populated (emptied locally → keep rejecting + HIGH alert).
 *   - ENOENT/missing + high-water             → unknown-unsafe (had users, file vanished → fail closed).
 *   - valid non-empty array                   → populated (arm normally).
 *   - parse-failure / non-array / partial     → unknown-unsafe (corruption/tampering → fail closed).
 */
export function classifyRegistry(usersFilePath: string, stateDir: string): RegistryClassification {
  const highWater = readRegistryHighWater(stateDir);
  let raw: string;
  try {
    raw = fs.readFileSync(usersFilePath, 'utf-8');
  } catch (err) {
    // ENOENT (never created) → clean degenerate UNLESS high-water evidence exists.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return highWater
        ? { klass: 'unknown-unsafe', detail: 'users.json missing but high-water present (store vanished)', rawUserCount: 0 }
        : { klass: 'degenerate', detail: 'users.json absent (fresh install)', rawUserCount: 0 };
    }
    // A non-ENOENT read error (permissions, transient lock) is NOT "never
    // populated" — never silently open delivery. Fail closed.
    return { klass: 'unknown-unsafe', detail: `users.json unreadable: ${(err as Error)?.message ?? 'error'}`, rawUserCount: 0 };
  }

  // A raw-non-empty file that will not parse is corruption / a partial write /
  // tampering — NOT "never populated". Fail CLOSED (§2.D UNKNOWN_UNSAFE).
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { klass: 'unknown-unsafe', detail: 'users.json parse-failure (corrupt/partial-write)', rawUserCount: 0 };
  }
  if (!Array.isArray(parsed)) {
    return { klass: 'unknown-unsafe', detail: 'users.json is not a JSON array (schema mismatch)', rawUserCount: 0 };
  }

  if (parsed.length === 0) {
    return highWater
      ? { klass: 'populated', detail: 'users.json is [] with high-water (emptied by deletion)', rawUserCount: 0 }
      : { klass: 'degenerate', detail: 'users.json is [] with no high-water (never populated)', rawUserCount: 0 };
  }
  return { klass: 'populated', detail: `users.json has ${parsed.length} user entr${parsed.length === 1 ? 'y' : 'ies'}`, rawUserCount: parsed.length };
}
