#!/usr/bin/env node
/**
 * lint-rollout-evidence-resolvable.js — the rollout-evidence CI ratchet.
 *
 * THE RULE: a spec that declares `rollout-disposition: active` with
 * `rollout-evidence-type: endpoint` must name a `rollout-evidence-ref` whose
 * route actually exists in src/. Otherwise the rollout's own graduation
 * criterion can never be evaluated, so the feature parks in dry-run
 * indefinitely — running, observing, unmeasurable, and looking careful while
 * doing it. Nothing errors, nothing alarms, and nobody finds out.
 *
 * EARNED FROM (2026-07-27): a sweep of all 5 rollout-active specs found 2 whose
 * evidence endpoint did not exist — 40%.
 *   - `claim-verification-sentinel` named /completion-claim-verification/stats,
 *     a prefix that never existed, while `CompletionClaimVerifier.stats()` sat
 *     implemented and called by no route. The verifier had been recording for
 *     weeks with its graduation criterion unreadable.
 *   - `mutual-ssh-autobootstrap` named /multi-machine/mutual-ssh. Its feature PR
 *     (#1539) MERGED 2026-07-21; the endpoint never landed with it.
 *
 * Both had identical effect, and neither was discoverable without going looking.
 * This makes the class un-reintroducible rather than fixed twice.
 *
 * Three assertions:
 *
 *   A. EVERY ACTIVE ENDPOINT REF RESOLVES — for each spec with
 *      rollout-disposition: active and rollout-evidence-type: endpoint, the
 *      rollout-evidence-ref path must appear as a route string somewhere in
 *      src/, unless the spec slug is in KNOWN_UNRESOLVED.
 *
 *   B. REAL REASONS — every KNOWN_UNRESOLVED entry carries a reason of >= 12
 *      non-whitespace chars, so the baseline cannot fill with placeholders
 *      (same bar as lint-guard-manifest's NOT_A_GUARD).
 *
 *   C. THE BASELINE ONLY SHRINKS — a KNOWN_UNRESOLVED entry whose ref now DOES
 *      resolve is an error. The allowlist is a ledger of accepted findings, not
 *      a parking space: once an instance is fixed, its entry must be deleted, so
 *      a converged state cannot silently un-converge and a stale entry cannot
 *      mask a regression at the same path.
 *
 * LIMITATIONS (Signal vs. Authority — this does NOT claim full closure):
 *   - Detection is a literal string match for the ref over src/, not a live
 *     probe. A route assembled dynamically (template-literal path, prefix
 *     mounted separately) is invisible to it and would need a KNOWN_UNRESOLVED
 *     entry explaining that. Deliberate: cheap, deterministic, explainable —
 *     the same pragmatism as the guard-manifest ratchet, and the reason this is
 *     a signal rather than the authority on whether a rollout is measurable.
 *   - Only `rollout-evidence-type: endpoint` is covered. `file` and `metric`
 *     evidence types are unchecked; extending to them is a separate change.
 *   - Frontmatter is parsed by regex, not YAML. A ref written as a folded or
 *     multi-line scalar is invisible and the spec is skipped rather than
 *     failed — the safe direction for a parser this crude.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECS_DIR = path.join(ROOT, 'docs', 'specs');
const SRC_DIR = path.join(ROOT, 'src');

/**
 * Accepted findings — instances known unresolvable at baseline. ONLY SHRINKS.
 * Delete an entry when its endpoint lands; assertion C fails if you don't.
 */
const KNOWN_UNRESOLVED = [
  {
    slug: 'mutual-ssh-autobootstrap',
    reason:
      'Feature PR #1539 merged 2026-07-21 without the /multi-machine/mutual-ssh ' +
      'endpoint its spec names as rollout evidence; the rollout has been active and ' +
      'unmeasurable since. Tracked as ACT-1398.',
  },
  {
    slug: 'claim-verification-sentinel',
    reason:
      'Named /completion-claim-verification/stats, a prefix that never existed, while ' +
      'CompletionClaimVerifier.stats() was called by no route. Fixed in PR #1682 — ' +
      'delete this entry once that merges; assertion C will demand it.',
  },
];

function specFiles() {
  if (!fs.existsSync(SPECS_DIR)) return [];
  return fs.readdirSync(SPECS_DIR).filter((f) => f.endsWith('.md'))
    .map((f) => path.join(SPECS_DIR, f));
}

function frontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  return end === -1 ? null : text.slice(3, end);
}

function field(fm, key) {
  const m = new RegExp(`^${key}:\\s*"?([^"\\n]+?)"?\\s*$`, 'm').exec(fm);
  return m ? m[1].trim() : null;
}

function srcContains(needle) {
  const stack = [SRC_DIR];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!/\.(ts|js|mjs)$/.test(e.name)) continue;
      let body;
      try { body = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (body.includes(needle)) return true;
    }
  }
  return false;
}

const errors = [];
const allowed = new Map(KNOWN_UNRESOLVED.map((e) => [e.slug, e]));
const seenActive = [];

for (const file of specFiles()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const fm = frontmatter(text);
  if (!fm) continue;
  if (field(fm, 'rollout-disposition') !== 'active') continue;
  if (field(fm, 'rollout-evidence-type') !== 'endpoint') continue;
  const ref = field(fm, 'rollout-evidence-ref');
  if (!ref || !ref.startsWith('/')) continue; // unparseable ⇒ skip, not fail
  const slug = field(fm, 'slug') || path.basename(file, '.md');
  const resolves = srcContains(ref);
  seenActive.push({ slug, ref, resolves });

  // A — every active endpoint ref resolves, unless explicitly accepted.
  if (!resolves && !allowed.has(slug)) {
    errors.push(
      `${path.relative(ROOT, file)}: rollout-disposition:active names ` +
      `rollout-evidence-ref "${ref}" but no route with that path exists in src/. ` +
      `The graduation criterion can never be evaluated, so this rollout is parked ` +
      `indefinitely. Build the endpoint, correct the ref, or add an explicit ` +
      `KNOWN_UNRESOLVED entry in scripts/lint-rollout-evidence-resolvable.js.`,
    );
  }

  // C — the baseline only shrinks.
  if (resolves && allowed.has(slug)) {
    errors.push(
      `${slug}: rollout-evidence-ref "${ref}" now RESOLVES, but the slug is still ` +
      `listed in KNOWN_UNRESOLVED. Delete that entry — a stale accepted-finding ` +
      `would mask a future regression at the same path.`,
    );
  }
}

// B — real reasons in the baseline.
for (const entry of KNOWN_UNRESOLVED) {
  if (!entry.reason || entry.reason.replace(/\s/g, '').length < 12) {
    errors.push(`KNOWN_UNRESOLVED["${entry.slug}"]: reason is missing or too short to be a real reason.`);
  }
}

if (errors.length) {
  console.error('[lint-rollout-evidence-resolvable] FAIL');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `lint-rollout-evidence-resolvable: clean — ${seenActive.length} rollout-active endpoint spec(s), ` +
  `${seenActive.filter((s) => s.resolves).length} resolving, ${allowed.size} accepted-unresolved.`,
);
