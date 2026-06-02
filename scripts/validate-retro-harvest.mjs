#!/usr/bin/env node
/**
 * validate-retro-harvest.mjs — the schema validator for Apprenticeship Step 0
 * retro-harvest artifacts (`apprenticeship-retro-harvest/v1`).
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
 *
 * CLI:  node scripts/validate-retro-harvest.mjs <artifact.md> [--prior] [--check-live]
 *   exit 0 = valid, exit 1 = invalid (errors to stderr).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';

export const SCHEMA_ID = 'apprenticeship-retro-harvest/v1';
export const INSTANCE_TYPES = ['mentorship', 'apprenticeship'];
export const SCOPE_MODES = ['full', 'incremental'];
export const COMPLETENESS = ['complete', 'partial-accepted'];
export const FIDELITY_VERDICTS = ['faithful', 'partial', 'rejected'];
export const HARVEST_DIR = 'docs/apprenticeship/retro-harvests';

/** Scrubbers Step 0 trusts. A missing/unknown/failed scrub refuses the artifact (§7). */
export const APPROVED_SCRUBBERS = ['correction-scrub', 'instar-pii-scrub'];

/** Evidence-pointer URI schemes (§6). */
export const POINTER_PATTERNS = {
  ledger: /^ledger:[0-9a-f-]{6,}$/i,            // validator-resolvable
  pr: /^pr:\d+$/,                                // validator-resolvable
  thread: /^thread:\d+#[\w.-]+$/,               // immutable msg locator; fidelity-review-only
  memory: /^memory:[a-z0-9_-]+@[0-9a-f]{6,}#[\w.-]+$/i, // slug@hash#anchor; fidelity-review-only
};

/** Secret-shaped strings the backstop rejects (§7). A LIMITED backstop, not a scrub. */
const SECRET_PATTERNS = [
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._-]{8,}/ },
  { name: 'tunnel-sig', re: /[?&]sig=[0-9a-f]{16,}/i },
  { name: 'long-hex-blob', re: /\b[0-9a-f]{40,}\b/i },
  { name: 'long-base64-blob', re: /\b[A-Za-z0-9+/]{50,}={0,2}\b/ },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
];

/**
 * Split a markdown doc into { frontmatter (parsed), body (string) }.
 * Throws if there is no `---`-delimited YAML frontmatter.
 */
export function parseArtifact(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('no YAML frontmatter (--- … ---) found');
  const frontmatter = yaml.load(m[1]) || {};
  return { frontmatter, body: m[2] || '' };
}

/** Count top-level `- ` bullet items directly under a `## <heading>` section. */
export function countSectionItems(body, heading) {
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
export function findSecret(body) {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(body)) return name;
  }
  return null;
}

/**
 * Resolve + confine an artifact path to HARVEST_DIR. Returns the safe relative
 * path or throws on traversal / bad component (§6 security).
 */
export function safeArtifactPath(from, to, instanceType) {
  for (const [k, v] of Object.entries({ from, to, instanceType })) {
    if (typeof v !== 'string' || !/^[a-z0-9-]+$/.test(v)) {
      throw new Error(`unsafe path component ${k}="${v}" (must match ^[a-z0-9-]+$)`);
    }
  }
  const rel = `${HARVEST_DIR}/${from}-to-${to}-${instanceType}.md`;
  const resolved = path.normalize(rel);
  if (resolved.includes('..') || !resolved.startsWith(HARVEST_DIR + path.sep) && !resolved.startsWith(HARVEST_DIR + '/')) {
    throw new Error(`path escapes ${HARVEST_DIR}: ${resolved}`);
  }
  return rel;
}

/**
 * PURE structural validation of a retro-harvest artifact.
 * @param {string} text - full artifact markdown
 * @param {{ priorHarvestExists?: boolean }} [opts]
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRetroHarvest(text, opts = {}) {
  const errors = [];
  const priorHarvestExists = !!opts.priorHarvestExists;

  let parsed;
  try {
    parsed = parseArtifact(text);
  } catch (e) {
    return { valid: false, errors: [`parse: ${e.message}`] };
  }
  const { frontmatter: fm, body } = parsed;

  // --- schema id
  if (fm.schema !== SCHEMA_ID) errors.push(`schema must be "${SCHEMA_ID}" (got "${fm.schema}")`);

  // --- required scalar fields
  for (const f of ['instanceType', 'from', 'to', 'framework', 'harvestedAt', 'scopeMode', 'completeness']) {
    if (fm[f] == null || fm[f] === '') errors.push(`missing required field: ${f}`);
  }
  if (fm.instanceType && !INSTANCE_TYPES.includes(fm.instanceType))
    errors.push(`instanceType must be one of ${INSTANCE_TYPES.join('|')}`);
  if (fm.scopeMode && !SCOPE_MODES.includes(fm.scopeMode))
    errors.push(`scopeMode must be one of ${SCOPE_MODES.join('|')}`);
  if (fm.completeness && !COMPLETENESS.includes(fm.completeness))
    errors.push(`completeness must be one of ${COMPLETENESS.join('|')}`);

  // --- path safety on the identity components
  if (fm.from && fm.to && fm.instanceType) {
    try { safeArtifactPath(fm.from, fm.to, fm.instanceType); }
    catch (e) { errors.push(`path: ${e.message}`); }
  }

  // --- scope rule: first harvest (no prior baseline) MUST be full (§8)
  if (fm.scopeMode === 'incremental' && !priorHarvestExists)
    errors.push('scopeMode "incremental" requires a prior harvest baseline; the first harvest must be "full"');

  // --- sourcesCovered: coverage EXTENT, not bare booleans (§8)
  const sc = fm.sourcesCovered;
  if (!sc || typeof sc !== 'object') {
    errors.push('missing sourcesCovered');
  } else {
    if (!sc.ledger || typeof sc.ledger.issueCount !== 'number')
      errors.push('sourcesCovered.ledger must carry { read, issueCount }');
    if (!sc.playbook || typeof sc.playbook.entryCount !== 'number')
      errors.push('sourcesCovered.playbook must carry { read, entryCount }');
    if (!Array.isArray(sc.threads))
      errors.push('sourcesCovered.threads must be an array of { id, messagesRead, truncated }');
    else for (const t of sc.threads) {
      if (typeof t.messagesRead !== 'number' || typeof t.truncated !== 'boolean')
        errors.push(`sourcesCovered.threads[${t && t.id}] needs numeric messagesRead + boolean truncated (coverage extent, not presence)`);
    }
  }

  // --- completeness vs truncation (§8): complete ⇒ nothing truncated
  if (fm.completeness === 'complete' && sc && Array.isArray(sc.threads)) {
    if (sc.threads.some((t) => t.truncated === true))
      errors.push('completeness "complete" is invalid when a source is truncated; use "partial-accepted" with named gaps');
  }

  // --- counts reconcile with body (§9)
  const counts = fm.counts || {};
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
  const r = fm.redaction;
  if (!r || typeof r !== 'object') {
    errors.push('missing redaction { scrubber, findingsRemoved, scrubbedAt }');
  } else {
    const scrubberName = String(r.scrubber || '').split('@')[0];
    if (!APPROVED_SCRUBBERS.includes(scrubberName))
      errors.push(`redaction.scrubber "${r.scrubber}" not in approved list (${APPROVED_SCRUBBERS.join(', ')})`);
    if (r.status === 'failed') errors.push('redaction.status is "failed" — scrub must succeed before write');
    if (typeof r.findingsRemoved !== 'number') errors.push('redaction.findingsRemoved must be a number');
  }

  // --- fidelity review: the authority's stamp (§9)
  const fr = fm.fidelityReview;
  if (!fr || typeof fr !== 'object') {
    errors.push('missing fidelityReview { reviewer, verdict, at }');
  } else {
    if (!FIDELITY_VERDICTS.includes(fr.verdict))
      errors.push(`fidelityReview.verdict must be one of ${FIDELITY_VERDICTS.join('|')}`);
    if (fr.verdict === 'rejected') errors.push('fidelityReview.verdict is "rejected" — harvest is not faithful');
    if (fr.verdict === 'partial' && !fr.gaps && !(fr.audit && fr.audit.gaps))
      errors.push('fidelityReview "partial" must name the gaps (fidelityReview.gaps)');
    if (!fr.reviewer) errors.push('fidelityReview.reviewer required (must be independent of the harvesting pass)');
  }

  // --- evidence pointers well-formed (§6). Strip trailing sentence punctuation
  // so a pointer at a clause boundary ("ledger:abc123, priority…") still validates.
  const pointerTokens = (body.match(/\b(?:ledger|pr|thread|memory):[^\s)\]]+/g) || [])
    .map((t) => t.replace(/[.,;:]+$/, ''));
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
 * @returns {Promise<{ ok: boolean, errors: string[] }>}
 */
export async function checkLiveLedger(frontmatter, fetchImpl) {
  const errors = [];
  const seeded = Array.isArray(frontmatter.seededToPlaybook) ? frontmatter.seededToPlaybook : [];
  for (const s of seeded) {
    const id = s && s.id;
    if (!id) { errors.push('seededToPlaybook entry without id'); continue; }
    try {
      const res = await fetchImpl(id);
      if (!res || !res.found) errors.push(`seeded id ${id} not found in live ledger`);
      else if (!['candidate', 'extracted'].includes(res.playbookStatus))
        errors.push(`seeded id ${id} is "${res.playbookStatus}", expected candidate+`);
    } catch (e) {
      errors.push(`live check for ${id} failed: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// --- CLI entry (guarded so importing for tests is side-effect-free)
const isMain = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); }
  catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const priorHarvestExists = args.includes('--prior');
  if (!file) {
    console.error('usage: validate-retro-harvest.mjs <artifact.md> [--prior] [--check-live]');
    process.exit(1);
  }
  const text = readFileSync(file, 'utf8');
  const { valid, errors } = validateRetroHarvest(text, { priorHarvestExists });
  if (!valid) {
    console.error(`INVALID: ${file}`);
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log(`valid: ${file}`);
  process.exit(0);
}
