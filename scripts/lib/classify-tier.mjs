/**
 * classify-tier.mjs — pure tier classifier for the instar-dev commit gate.
 *
 * Step A of the Tiered Development Process
 * (docs/specs/tier-classifier-and-tier1-path-spec.md).
 *
 * Computes a TIER SIGNAL from a staged change. This is signal only — the gate
 * SURFACES the suggestion, but the agent (the mind) DECLARES the actual tier in
 * its trace. This module never decides the tier for the agent and never blocks.
 *
 * `classifyTier({ inScopeFiles, addedLines, deletedLines, addedDiffText })`
 *   → { suggestedTier, sizeTier, riskFloor, reasons }
 *
 *   - sizeTier: 1 when (addedLines + deletedLines) <= SIZE_LOC AND
 *     inScopeFiles.length <= SIZE_FILES, else 2.
 *   - riskFloor: starts at 1, RAISED to >= 2 by any safety-invariant proximity,
 *     irreversibility, migration/fleet-rollout, or new-capability signal (each
 *     pushes a reason).
 *   - suggestedTier = max(sizeTier, riskFloor). NEVER 3 — Tier 3 is declared
 *     (an approved project step), not auto-suggested.
 */

// ─── Tunable size thresholds ─────────────────────────────────────────────
export const SIZE_LOC = 40;
export const SIZE_FILES = 3;

// ─── Risk signal: safety-invariant proximity (path-based) ────────────────
// An in-scope path matching any of these raises the risk floor to >= 2.
const SAFETY_INVARIANT_PATTERNS = [
  { regex: /secret/i, label: 'SecretDrop / never-on-disk invariant' },
  { regex: /relay/i, label: 'relay / delivery path' },
  { regex: /Telegram.*Adapter/, label: 'Telegram adapter' },
  { regex: /\bauth\b/i, label: 'auth path' },
  { regex: /token/i, label: 'token handling' },
  { regex: /SafeFsExecutor/, label: 'SafeFsExecutor (destructive-fs funnel)' },
  { regex: /SafeGitExecutor/, label: 'SafeGitExecutor (destructive-git funnel)' },
  { regex: /SourceTreeGuard/, label: 'SourceTreeGuard (source-tree mutation guard)' },
  { regex: /Reaper/, label: 'session reaper' },
  { regex: /session.*lifecycle/i, label: 'session lifecycle' },
];

// ─── Risk signal: irreversibility (path-based) ───────────────────────────
const IRREVERSIBILITY_PATTERNS = [
  { regex: /migration/i, label: 'migration' },
  { regex: /schema/i, label: 'data-format / schema' },
  { regex: /PostUpdateMigrator/, label: 'PostUpdateMigrator' },
];

// ─── Risk signal: migration / fleet-rollout surface (path-based) ─────────
// A change here touches the machinery that rolls out to EVERY deployed agent
// (the migration family) or the fleet release/publish path. This is where the
// zombie-cleanup, lifeline-skew, and "one malformed NEXT.md jams all releases"
// (#42) regressions lived — a one-line change here is never Tier-1. Distinct
// reason string from irreversibility even though `PostUpdateMigrator` /
// `migrate*` overlap, because the fleet-rollout blast radius is the concern.
const FLEET_ROLLOUT_PATTERNS = [
  { regex: /PostUpdateMigrator/, label: 'PostUpdateMigrator (fleet migration machinery)' },
  { regex: /migrate/i, label: 'migrate*() migration family' },
  { regex: /http-hook-templates/, label: 'http-hook-templates (settings/hook migration source)' },
  { regex: /NEXT\.md/, label: 'upgrades/NEXT.md (fleet release manifest)' },
  // Release / publish scripts under scripts/ — the fleet publish path.
  { regex: /^scripts\/.*release/i, label: 'release script (fleet publish path)' },
  { regex: /^scripts\/.*publish/i, label: 'publish script (fleet publish path)' },
];

// ─── Risk signal: new capability (diff-text-based, only when provided) ───
// Net-new added lines (the diff text passed in should be ADDED lines only;
// the caller is responsible for that). Each heuristic emits a reason.
const NEW_CAPABILITY_PATTERNS = [
  {
    // A new route registration: router.get( / router.post( / app.use( etc.
    regex: /\brouter\.(get|post|put|patch|delete|use|all|options|head)\s*\(/,
    label: 'new route (router.<verb>()',
  },
  {
    regex: /\bexport\s+class\s+/,
    label: 'new exported class / subsystem',
  },
  {
    // A new config key — a quoted key followed by a colon, or an object-literal
    // identifier key, that reads like a config surface addition. Conservative:
    // require it to look like a JSON/TS config entry.
    regex: /^[+]?\s*["']?[A-Za-z_][A-Za-z0-9_]*["']?\s*:\s*.+,?\s*$/m,
    label: 'new config key',
    // The generic key pattern is noisy on its own — gate it behind a hint that
    // the diff is actually touching a config surface. See evaluation below.
    requiresConfigHint: true,
  },
];

// Heuristic hint that the added diff is touching a config SURFACE (not just any
// object literal). Without this guard the bare `key: value` pattern fires on
// almost every TS change. We only treat a `key: value` addition as a new config
// key when the diff also mentions a recognizable config anchor.
const CONFIG_SURFACE_HINT = /(ConfigDefaults|config\.json|defaultConfig|InstarConfig|\.config\b|configSchema)/;

/**
 * @param {object} input
 * @param {string[]} input.inScopeFiles    Staged in-scope file paths.
 * @param {number}   input.addedLines      Total added lines across inScopeFiles.
 * @param {number}   input.deletedLines    Total deleted lines across inScopeFiles.
 * @param {string} [input.addedDiffText]   Concatenated ADDED-line diff text. When
 *                                          absent, the new-capability check is SKIPPED
 *                                          (we never guess without the diff).
 * @returns {{ suggestedTier: 1|2, sizeTier: 1|2, riskFloor: 1|2, reasons: string[] }}
 */
export function classifyTier({ inScopeFiles, addedLines, deletedLines, addedDiffText } = {}) {
  const files = Array.isArray(inScopeFiles) ? inScopeFiles : [];
  const added = Number.isFinite(addedLines) ? addedLines : 0;
  const deleted = Number.isFinite(deletedLines) ? deletedLines : 0;

  const reasons = [];

  // ── Size tier ──
  const totalLoc = added + deleted;
  const sizeTier = totalLoc <= SIZE_LOC && files.length <= SIZE_FILES ? 1 : 2;

  // ── Risk floor ──
  let riskFloor = 1;
  const raise = (reason) => {
    riskFloor = Math.max(riskFloor, 2);
    reasons.push(reason);
  };

  // (a) safety-invariant proximity — path-based
  for (const file of files) {
    for (const { regex, label } of SAFETY_INVARIANT_PATTERNS) {
      if (regex.test(file)) {
        raise(`safety-invariant proximity: ${file} matches ${label}`);
      }
    }
  }

  // (b) irreversibility — path-based
  for (const file of files) {
    for (const { regex, label } of IRREVERSIBILITY_PATTERNS) {
      if (regex.test(file)) {
        raise(`irreversibility: ${file} touches ${label}`);
      }
    }
  }

  // (b2) migration / fleet-rollout surface — path-based
  for (const file of files) {
    for (const { regex, label } of FLEET_ROLLOUT_PATTERNS) {
      if (regex.test(file)) {
        raise(`migration / fleet-rollout surface: ${file} touches ${label}`);
      }
    }
  }

  // (c) new capability — diff-text-based, only when addedDiffText is provided.
  // If absent, SKIP entirely (don't guess).
  if (typeof addedDiffText === 'string' && addedDiffText.length > 0) {
    for (const { regex, label, requiresConfigHint } of NEW_CAPABILITY_PATTERNS) {
      if (requiresConfigHint && !CONFIG_SURFACE_HINT.test(addedDiffText)) {
        continue;
      }
      if (regex.test(addedDiffText)) {
        raise(`new capability: ${label} added`);
      }
    }
  }

  // ── Suggested tier ── NEVER 3.
  const suggestedTier = Math.max(sizeTier, riskFloor);

  return { suggestedTier, sizeTier, riskFloor, reasons };
}

/**
 * decideRequirementSet(declaredTier) — pure helper factoring the gate's
 * tier-enforcement DECISION so it is unit-testable without git/fs mocking.
 *
 * Given the agent's DECLARED tier (from the trace; `null`/`undefined` when no
 * trace or no `tier` field), return WHICH requirement set the gate enforces.
 *
 *   - null/undefined (or any non-1/2/3 value) → 'tier2-full' (back-compat default)
 *   - 1 → 'tier1-lite'
 *   - 2 or 3 → 'tier2-full' (a Tier-3 project step is just a Tier-2 spec)
 *
 * @param {number|null|undefined} declaredTier
 * @returns {{ requirementSet: 'tier1-lite'|'tier2-full', resolvedTier: 1|2 }}
 */
export function decideRequirementSet(declaredTier) {
  if (declaredTier === 1) {
    return { requirementSet: 'tier1-lite', resolvedTier: 1 };
  }
  // 2, 3, missing, or anything else → the existing full Tier-2 requirement set.
  return { requirementSet: 'tier2-full', resolvedTier: 2 };
}
