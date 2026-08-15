/**
 * Is the generated standards-registry asset STALE relative to the sources it is
 * generated from?
 *
 * WHY THIS EXISTS. Two globalSetup files decide whether to regenerate that asset,
 * and both decided on PRESENCE alone — `if (outputs.every(exists)) return`. So an
 * asset generated from an older revision of the source was never regenerated: it
 * existed, therefore it was accepted. Twelve lines above one of those checks, its
 * own sibling `ensureDistBuilt()` does it correctly, by comparing mtimes.
 *
 * MEASURED, not hypothesised (2026-08-15). In a checkout whose asset was generated
 * at 17:59 from a source that was three hours newer, three test files failed with
 * eight assertions. Regenerating the asset made all 77 tests pass. The presence
 * check could detect an absent asset and was structurally unable to detect a wrong
 * one — a guard that can only find the failure mode nobody hits.
 *
 * ONE RULE, ONE PLACE. Both call sites share this function rather than each
 * carrying a copy of the comparison, because two copies of a rule that must agree
 * is simply the next bug with a delay on it.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * What the generator actually reads, taken from the generator's own source rather
 * than guessed: the registry document, the committed article-count floor, and the
 * package version that is stamped into the emitted metadata.
 */
export const REGISTRY_ASSET_INPUTS = [
  'docs/STANDARDS-REGISTRY.md',
  'docs/standards-registry-floor.json',
  'package.json',
] as const;

/**
 * True when the asset must be regenerated.
 *
 * Fails toward the EXISTING behaviour in every uncertain case, deliberately:
 *  - an absent output is stale (what the presence check already did);
 *  - if NO input is readable there is nothing to compare against, so it is NOT
 *    reported stale — a missing source must not trigger a regeneration that would
 *    then fail on the missing source;
 *  - equal mtimes are NOT stale, so a same-second write does not cause a
 *    regeneration on every single run.
 */
export function registryAssetIsStale(root: string, outputs: readonly string[]): boolean {
  if (outputs.length === 0) return false;

  let oldestOutput = Number.POSITIVE_INFINITY;
  for (const output of outputs) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(output);
    } catch {
      return true; // absent (or unreadable) — regenerate, exactly as before
    }
    oldestOutput = Math.min(oldestOutput, stat.mtimeMs);
  }

  let newestInput = 0;
  let sawAnyInput = false;
  for (const relative of REGISTRY_ASSET_INPUTS) {
    try {
      newestInput = Math.max(newestInput, fs.statSync(path.join(root, relative)).mtimeMs);
      sawAnyInput = true;
    } catch {
      // An input we cannot read tells us nothing about freshness. Skip it rather
      // than treating "cannot read" as "changed".
    }
  }
  if (!sawAnyInput) return false;

  return newestInput > oldestOutput;
}
