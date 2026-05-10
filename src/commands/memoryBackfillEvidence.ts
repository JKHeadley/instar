/**
 * `instar memory backfill-evidence` — one-shot migration that walks every
 * existing MemoryEntity, pattern-matches the legacy `source: string` field,
 * and synthesizes a `MemoryEvidence` row when (and only when) the source
 * matches a known shape that the `manual` producer is allowed to write.
 *
 * Per WikiClaim spec § Migration of Existing MemoryEntity Records (line 202)
 * and § Risks line 357 ("Backfill is idempotent and uses only the patterns
 * enumerated above. Anything that doesn't match a known pattern stays
 * `evidence: []`. No LLM in the migration path.") and line 360 ("Backfill
 * defaults `privacyTier: undefined` (inherit from entity). No automatic
 * upgrade to private or sensitive.").
 *
 * **Phase 1 narrowed `manual` producer to `external-url` only** (see
 * `PRODUCER_KIND_ALLOWLIST` in SemanticMemory.ts and the Phase 1 side-effects
 * artifact). Because of that, the only legacy `source` shape backfill can
 * cover is an `https?://` URL. Other patterns the spec lists (`session:ABC`,
 * `user:Justin`, `observation`) would need their own dedicated producer
 * bridges (e.g., `DecisionJournal` for `session`); attempting them here is
 * out-of-scope for Phase 5 — we DELIBERATELY do not widen the allowlist to
 * make migration easier.
 *
 * Idempotency: before writing, the command queries the entity's existing
 * evidence rows; if an `external-url` row with the same path already exists,
 * the entity is skipped. Two consecutive `--apply` runs produce identical
 * end state.
 */

import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { SemanticMemory } from '../memory/SemanticMemory.js';
import type { MemoryEntity, MemoryEvidence, PrivacyScopeType } from '../core/types.js';

export interface BackfillOptions {
  dir?: string;
  dryRun?: boolean;
  /** Optional override for the source-of-truth viewer scope used to read
   *  existing evidence during the dup-check. Default `'private'` reads
   *  every tier — the dup-check must see ALL existing rows to be safely
   *  idempotent. Configurable only for tests. */
  viewerScope?: PrivacyScopeType;
}

export interface BackfillSummary {
  scanned: number;
  backfilled: number;
  skipped: number;
  errors: number;
  /** Per-entity outcome lines for callers that want structured output. */
  details: Array<{
    entityId: string;
    source: string;
    outcome: 'backfilled' | 'already-has-url-evidence' | 'no-pattern-match' | 'error';
    note?: string;
  }>;
}

/**
 * URL pattern: a complete `http://` or `https://` URL as the ENTIRE source
 * string (anchored). We deliberately do NOT extract URLs embedded inside
 * other text — extracting partial URLs creates ambiguity about what the
 * "real" source was and re-runs could backfill different URLs from the same
 * source string as the matcher evolves. Anchoring keeps the migration
 * deterministic.
 *
 * Allowed: `https://example.com/path`, `http://localhost:8080/x?y=z`
 * Rejected: `session:ABC`, `user:Justin`, `observation`, `see https://...`
 */
const URL_SOURCE_PATTERN = /^https?:\/\/\S+$/;

/**
 * Public entry: runs the backfill against the SemanticMemory in the given
 * state directory. Returns a structured summary for tests / callers that
 * want to assert on outcomes; the CLI wrapper prints the same data.
 */
export async function runBackfillEvidence(
  opts: BackfillOptions,
): Promise<BackfillSummary> {
  const config = loadConfig(opts.dir);
  const memory = new SemanticMemory({
    dbPath: path.join(config.stateDir, 'semantic.db'),
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });
  await memory.open();
  try {
    return backfillAgainstMemory(memory, opts);
  } finally {
    memory.close();
  }
}

/**
 * Test-friendly seam: takes an open SemanticMemory instance directly. The
 * CLI wrapper threads loadConfig + open + close around it; tests skip the
 * config dance and pass a memory created against a tmp dir.
 */
export function backfillAgainstMemory(
  memory: SemanticMemory,
  opts: BackfillOptions,
): BackfillSummary {
  const viewerScope: PrivacyScopeType = opts.viewerScope ?? 'private';
  const dryRun = !!opts.dryRun;

  const { entities } = memory.export();

  const summary: BackfillSummary = {
    scanned: 0,
    backfilled: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  for (const entity of entities) {
    summary.scanned++;
    const source = entity.source ?? '';

    // Pattern-match URL only. Everything else is a deliberate skip per
    // spec § Risks line 357 (no LLM, only known patterns).
    if (!URL_SOURCE_PATTERN.test(source)) {
      summary.skipped++;
      summary.details.push({
        entityId: entity.id,
        source,
        outcome: 'no-pattern-match',
      });
      continue;
    }

    // Idempotency: if an existing external-url evidence row already cites
    // this URL, skip. We read at the WIDEST viewer scope (default 'private',
    // configurable for tests) so the dup-check sees every existing row —
    // a narrow read could miss a row tagged `private` on a `shared-project`
    // entity and cause a duplicate write.
    let existing: MemoryEvidence[];
    try {
      existing = memory.getEvidence(entity.id, viewerScope);
    } catch (err) {
      summary.errors++;
      summary.details.push({
        entityId: entity.id,
        source,
        outcome: 'error',
        note: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const alreadyHas = existing.some(
      (ev) =>
        ev.kind === 'external-url' &&
        (ev.path === source || ev.sourceId === source),
    );
    if (alreadyHas) {
      summary.skipped++;
      summary.details.push({
        entityId: entity.id,
        source,
        outcome: 'already-has-url-evidence',
      });
      continue;
    }

    // Synthesize the evidence row. Per spec § Risks line 360, leave
    // `privacyTier` undefined so it inherits from the entity's scope —
    // never auto-upgrade to `private` / `sensitive`.
    const synthesized: MemoryEvidence = {
      kind: 'external-url',
      // For URLs, sourceId == path == the URL itself. Spec § Producers
      // line 229 keys 'manual external-url' on the URL value as both
      // dedupe identity and display path.
      sourceId: source,
      path: source,
      // updatedAt uses entity's createdAt — preserves temporal ordering
      // and means a second run on the same row produces identical content.
      updatedAt: entity.createdAt,
      // Caller-set confidence/weight per spec § Open Questions; coarse
      // legacy provenance gets a low-confidence float matching the spec's
      // suggested 0.5 for migrated rows.
      confidence: 0.5,
      note: 'Backfilled from legacy MemoryEntity.source (Phase 5 migration)',
    };

    if (dryRun) {
      summary.backfilled++;
      summary.details.push({
        entityId: entity.id,
        source,
        outcome: 'backfilled',
        note: 'dry-run (not written)',
      });
      continue;
    }

    try {
      memory.addEvidence(entity.id, synthesized, 'manual');
      summary.backfilled++;
      summary.details.push({
        entityId: entity.id,
        source,
        outcome: 'backfilled',
      });
    } catch (err) {
      summary.errors++;
      summary.details.push({
        entityId: entity.id,
        source,
        outcome: 'error',
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

/**
 * Commander entry-point. Prints a human-readable report; structured callers
 * use `runBackfillEvidence` directly.
 */
export async function memoryBackfillEvidence(
  opts: BackfillOptions,
): Promise<void> {
  try {
    const summary = await runBackfillEvidence(opts);

    console.log(pc.bold('\n  Memory backfill-evidence\n'));
    if (opts.dryRun) {
      console.log(pc.yellow('  Dry-run: no writes performed.\n'));
    }

    console.log(`  Scanned:    ${summary.scanned}`);
    console.log(`  Backfilled: ${pc.green(String(summary.backfilled))}`);
    console.log(`  Skipped:    ${summary.skipped}`);
    if (summary.errors > 0) {
      console.log(`  Errors:     ${pc.red(String(summary.errors))}`);
    } else {
      console.log(`  Errors:     ${summary.errors}`);
    }

    // Show details only when there's something interesting to look at.
    const interesting = summary.details.filter(
      (d) => d.outcome === 'backfilled' || d.outcome === 'error',
    );
    if (interesting.length > 0) {
      console.log();
      for (const d of interesting) {
        const tag =
          d.outcome === 'backfilled'
            ? pc.green('  +')
            : pc.red('  !');
        const noteStr = d.note ? pc.dim(` — ${d.note}`) : '';
        console.log(`${tag} ${d.entityId}  ${pc.dim(d.source)}${noteStr}`);
      }
    }

    console.log();
  } catch (err) {
    if (err instanceof Error && err.message.includes('better-sqlite3')) {
      console.log(pc.yellow('Backfill requires better-sqlite3.'));
      console.log(pc.dim('Install it with: npm install better-sqlite3'));
    } else {
      console.log(
        pc.red(`Backfill failed: ${err instanceof Error ? err.message : err}`),
      );
    }
    process.exit(1);
  }
}
