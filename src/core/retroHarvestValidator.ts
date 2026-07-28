/**
 * retroHarvestValidator — the schema validator for Apprenticeship Step 0
 * retro-harvest artifacts (`apprenticeship-retro-harvest/v1`).
 *
 * This is the SOURCE OF TRUTH for the validator (Apprenticeship Step 1 §3.2
 * relocation). The pure logic lives here in TypeScript so it is type-checked
 * and importable in-process by `ApprenticeshipProgram`; the thin CLI
 * `scripts/validate-retro-harvest.mjs` re-exports from
 * `dist/core/retroHarvestValidator.js` (the BackfillCore precedent).
 *
 * Per APPRENTICESHIP-STEP0-RETRO-HARVEST-SPEC.md §9, this is the structural
 * SIGNAL — not the authority. It checks the artifact's SHAPE deterministically;
 * the LLM fidelity review (recorded in frontmatter) is the AUTHORITY for whether
 * the harvest is faithful. (Signal vs Authority / The Body and the Mind.)
 *
 * Two layers:
 *   - validateRetroHarvest(text, opts)  — PURE, offline, unit-tested. Structure,
 *     reconciliation, redaction backstop, path safety, completeness, scope rules.
 *   - checkLiveLedger(frontmatter, fetchImpl) — OPTIONAL live cross-check that
 *     seeded ids resolve in the running ledger. Network; run by the integration
 *     test / `--check-live`, never by the pure unit path.
 */

import path from 'node:path';
import yaml from 'js-yaml';

export const SCHEMA_ID = 'apprenticeship-retro-harvest/v1';
export const INSTANCE_TYPES = ['mentorship', 'apprenticeship'] as const;
export const SCOPE_MODES = ['full', 'incremental'] as const;
export const COMPLETENESS = ['complete', 'partial-accepted'] as const;
export const FIDELITY_VERDICTS = ['faithful', 'partial', 'rejected'] as const;
export const HARVEST_DIR = 'docs/apprenticeship/retro-harvests';

/** Scrubbers Step 0 trusts. A missing/unknown/failed scrub refuses the artifact (§7). */
export const APPROVED_SCRUBBERS = ['correction-scrub', 'instar-pii-scrub'] as const;

/** Evidence-pointer URI schemes (§6). */
export const POINTER_PATTERNS: Record<string, RegExp> = {
  ledger: /^ledger:[0-9a-f-]{6,}$/i, // validator-resolvable
  pr: /^pr:\d+$/, // validator-resolvable
  thread: /^thread:\d+#[\w.-]+$/, // immutable msg locator; fidelity-review-only
  memory: /^memory:[a-z0-9_-]+@[0-9a-f]{6,}#[\w.-]+$/i, // slug@hash#anchor; fidelity-review-only
};

/** Secret-shaped strings the backstop rejects (§7). A LIMITED backstop, not a scrub. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._-]{8,}/ },
  { name: 'tunnel-sig', re: /[?&]sig=[0-9a-f]{16,}/i },
  { name: 'long-hex-blob', re: /\b[0-9a-f]{40,}\b/i },
  { name: 'long-base64-blob', re: /\b[A-Za-z0-9+/]{50,}={0,2}\b/ },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
];

// ── Types ────────────────────────────────────────────────────────────

/** Parsed frontmatter — the harvest carries arbitrary keys, so this is open. */
export type HarvestFrontmatter = Record<string, unknown>;

export interface ParsedArtifact {
  frontmatter: HarvestFrontmatter;
  body: string;
}

export interface ValidateResult {
  valid: boolean;
  errors: string[];
}

export interface ValidateOptions {
  priorHarvestExists?: boolean;
}

/** Resolution shape for an injected live-ledger fetch (one seeded id). */
export interface LedgerResolution {
  found: boolean;
  playbookStatus?: string;
}

export type LedgerFetchImpl = (id: string) => Promise<LedgerResolution> | LedgerResolution;

export interface LiveLedgerResult {
  ok: boolean;
  errors: string[];
}

/**
 * Split a markdown doc into { frontmatter (parsed), body (string) }.
 * Throws if there is no `---`-delimited YAML frontmatter.
 */
export function parseArtifact(text: string): ParsedArtifact {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('no YAML frontmatter (--- … ---) found');
  const frontmatter = (yaml.load(m[1]) as HarvestFrontmatter) || {};
  return { frontmatter, body: m[2] || '' };
}

/** Count top-level `- ` bullet items directly under a `## <heading>` section. */
export function countSectionItems(body: string, heading: string): number {
  const lines = body.split('\n');
  let inSection = false;
  let count = 0;
  const headingRe = new RegExp('^##\\s+' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  for (const line of lines) {
    if (/^##\s+/.test(line)) inSection = headingRe.test(line);
    else if (inSection && /^-\s+\S/.test(line)) count++;
  }
  return count;
}

/** True when the body contains a secret-shaped string (returns the matched pattern name or null). */
export function findSecret(body: string): string | null {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(body)) return name;
  }
  return null;
}

/**
 * Resolve + confine an artifact path to HARVEST_DIR. Returns the safe relative
 * path or throws on traversal / bad component (§6 security).
 */
export function safeArtifactPath(from: string, to: string, instanceType: string): string {
  for (const [k, v] of Object.entries({ from, to, instanceType })) {
    if (typeof v !== 'string' || !/^[a-z0-9-]+$/.test(v)) {
      throw new Error(`unsafe path component ${k}="${v}" (must match ^[a-z0-9-]+$)`);
    }
  }
  const rel = `${HARVEST_DIR}/${from}-to-${to}-${instanceType}.md`;
  const resolved = path.normalize(rel);
  if (
    resolved.includes('..') ||
    (!resolved.startsWith(HARVEST_DIR + path.sep) && !resolved.startsWith(HARVEST_DIR + '/'))
  ) {
    throw new Error(`path escapes ${HARVEST_DIR}: ${resolved}`);
  }
  return rel;
}

/**
 * PURE structural validation of a retro-harvest artifact.
 */
export function validateRetroHarvest(text: string, opts: ValidateOptions = {}): ValidateResult {
  const errors: string[] = [];
  const priorHarvestExists = !!opts.priorHarvestExists;

  let parsed: ParsedArtifact;
  try {
    parsed = parseArtifact(text);
  } catch (e) {
    return { valid: false, errors: [`parse: ${(e as Error).message}`] };
  }
  const { frontmatter: fm, body } = parsed;

  const fmStr = (k: string): string | undefined => {
    const v = fm[k];
    return typeof v === 'string' ? v : undefined;
  };

  // --- schema id
  if (fm.schema !== SCHEMA_ID) errors.push(`schema must be "${SCHEMA_ID}" (got "${String(fm.schema)}")`);

  // --- required scalar fields
  for (const f of ['instanceType', 'from', 'to', 'framework', 'harvestedAt', 'scopeMode', 'completeness']) {
    if (fm[f] == null || fm[f] === '') errors.push(`missing required field: ${f}`);
  }
  const instanceType = fmStr('instanceType');
  const scopeMode = fmStr('scopeMode');
  const completeness = fmStr('completeness');
  if (instanceType && !(INSTANCE_TYPES as readonly string[]).includes(instanceType))
    errors.push(`instanceType must be one of ${INSTANCE_TYPES.join('|')}`);
  if (scopeMode && !(SCOPE_MODES as readonly string[]).includes(scopeMode))
    errors.push(`scopeMode must be one of ${SCOPE_MODES.join('|')}`);
  if (completeness && !(COMPLETENESS as readonly string[]).includes(completeness))
    errors.push(`completeness must be one of ${COMPLETENESS.join('|')}`);

  // --- path safety on the identity components
  const from = fmStr('from');
  const to = fmStr('to');
  if (from && to && instanceType) {
    try {
      safeArtifactPath(from, to, instanceType);
    } catch (e) {
      errors.push(`path: ${(e as Error).message}`);
    }
  }

  // --- scope rule: first harvest (no prior baseline) MUST be full (§8)
  if (scopeMode === 'incremental' && !priorHarvestExists)
    errors.push('scopeMode "incremental" requires a prior harvest baseline; the first harvest must be "full"');

  // --- sourcesCovered: coverage EXTENT, not bare booleans (§8)
  const sc = fm.sourcesCovered as
    | {
        ledger?: { issueCount?: unknown };
        playbook?: { entryCount?: unknown };
        threads?: Array<{ id?: unknown; messagesRead?: unknown; truncated?: unknown }>;
      }
    | undefined;
  if (!sc || typeof sc !== 'object') {
    errors.push('missing sourcesCovered');
  } else {
    if (!sc.ledger || typeof sc.ledger.issueCount !== 'number')
      errors.push('sourcesCovered.ledger must carry { read, issueCount }');
    if (!sc.playbook || typeof sc.playbook.entryCount !== 'number')
      errors.push('sourcesCovered.playbook must carry { read, entryCount }');
    if (!Array.isArray(sc.threads))
      errors.push('sourcesCovered.threads must be an array of { id, messagesRead, truncated }');
    else
      for (const t of sc.threads) {
        if (typeof t.messagesRead !== 'number' || typeof t.truncated !== 'boolean')
          errors.push(
            `sourcesCovered.threads[${t && t.id}] needs numeric messagesRead + boolean truncated (coverage extent, not presence)`,
          );
      }
  }

  // --- completeness vs truncation (§8): complete ⇒ nothing truncated
  if (completeness === 'complete' && sc && Array.isArray(sc.threads)) {
    if (sc.threads.some((t) => t.truncated === true))
      errors.push('completeness "complete" is invalid when a source is truncated; use "partial-accepted" with named gaps');
  }

  // --- counts reconcile with body (§9)
  const counts = (fm.counts as { lessons?: unknown; metaLessons?: unknown; processInsights?: unknown }) || {};
  const bodyLessons = countSectionItems(body, 'Lessons');
  const bodyMeta = countSectionItems(body, 'Meta-lessons');
  const bodyProc = countSectionItems(body, 'Process-insights');
  const bodyNeeds = countSectionItems(body, 'What the program needs');
  if (counts.lessons !== bodyLessons)
    errors.push(`counts.lessons=${counts.lessons} but body has ${bodyLessons} "## Lessons" items`);
  if (counts.metaLessons !== bodyMeta)
    errors.push(`counts.metaLessons=${counts.metaLessons} but body has ${bodyMeta} "## Meta-lessons" items`);
  if (counts.processInsights !== bodyProc)
    errors.push(`counts.processInsights=${counts.processInsights} but body has ${bodyProc} "## Process-insights" items`);
  if (fm.programNeeds !== bodyNeeds)
    errors.push(`programNeeds=${fm.programNeeds} but body has ${bodyNeeds} "## What the program needs" items`);

  // --- redaction: approved scrubber, not failed (§7)
  const r = fm.redaction as { scrubber?: unknown; status?: unknown; findingsRemoved?: unknown } | undefined;
  if (!r || typeof r !== 'object') {
    errors.push('missing redaction { scrubber, findingsRemoved, scrubbedAt }');
  } else {
    const scrubberName = String(r.scrubber || '').split('@')[0];
    if (!(APPROVED_SCRUBBERS as readonly string[]).includes(scrubberName))
      errors.push(`redaction.scrubber "${String(r.scrubber)}" not in approved list (${APPROVED_SCRUBBERS.join(', ')})`);
    if (r.status === 'failed') errors.push('redaction.status is "failed" — scrub must succeed before write');
    if (typeof r.findingsRemoved !== 'number') errors.push('redaction.findingsRemoved must be a number');
  }

  // --- fidelity review: the authority's stamp (§9)
  const fr = fm.fidelityReview as
    | { reviewer?: unknown; verdict?: unknown; gaps?: unknown; audit?: { gaps?: unknown } }
    | undefined;
  if (!fr || typeof fr !== 'object') {
    errors.push('missing fidelityReview { reviewer, verdict, at }');
  } else {
    if (!(FIDELITY_VERDICTS as readonly string[]).includes(String(fr.verdict)))
      errors.push(`fidelityReview.verdict must be one of ${FIDELITY_VERDICTS.join('|')}`);
    if (fr.verdict === 'rejected') errors.push('fidelityReview.verdict is "rejected" — harvest is not faithful');
    if (fr.verdict === 'partial' && !fr.gaps && !(fr.audit && fr.audit.gaps))
      errors.push('fidelityReview "partial" must name the gaps (fidelityReview.gaps)');
    if (!fr.reviewer) errors.push('fidelityReview.reviewer required (must be independent of the harvesting pass)');
  }

  // --- evidence pointers well-formed (§6). Strip trailing sentence punctuation
  // so a pointer at a clause boundary ("ledger:abc123, priority…") still validates.
  const pointerTokens = (body.match(/\b(?:ledger|pr|thread|memory):[^\s)\]]+/g) || []).map((t) =>
    t.replace(/[.,;:]+$/, ''),
  );
  for (const tok of pointerTokens) {
    const scheme = tok.split(':')[0];
    const re = POINTER_PATTERNS[scheme];
    if (re && !re.test(tok)) errors.push(`malformed evidence pointer: ${tok}`);
  }

  // --- secret backstop (§7)
  const secret = findSecret(body);
  if (secret) errors.push(`secret-shaped string in body (${secret}) — pointers-not-payloads (§7)`);

  return { valid: errors.length === 0, errors };
}

/**
 * OPTIONAL live cross-check: every seededToPlaybook id resolves at candidate+ in
 * the running ledger. Network — never part of the pure unit path. Inject fetch.
 */
export async function checkLiveLedger(
  frontmatter: HarvestFrontmatter,
  fetchImpl: LedgerFetchImpl,
): Promise<LiveLedgerResult> {
  const errors: string[] = [];
  const seededRaw = frontmatter.seededToPlaybook;
  const seeded = Array.isArray(seededRaw) ? (seededRaw as Array<{ id?: string }>) : [];
  for (const s of seeded) {
    const id = s && s.id;
    if (!id) {
      errors.push('seededToPlaybook entry without id');
      continue;
    }
    try {
      const res = await fetchImpl(id);
      if (!res || !res.found) errors.push(`seeded id ${id} not found in live ledger`);
      else if (!['candidate', 'extracted'].includes(String(res.playbookStatus)))
        errors.push(`seeded id ${id} is "${res.playbookStatus}", expected candidate+`);
    } catch (e) {
      errors.push(`live check for ${id} failed: ${(e as Error).message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
