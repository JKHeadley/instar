#!/usr/bin/env node
/**
 * lint-recall-surface-names-match-mechanism.mjs — a recall surface may not be
 * DESCRIBED as meaning-based unless it actually reaches the embedding path.
 *
 * Enforces the constitutional standard **"Recall Over Our Own Material Is by
 * Meaning, Not by Word-Match"** (Standards Registry, The Substrate; a tree node
 * under *Intelligence Infers, Keywords Only Guard*).
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — for every search route the capability index advertises, the
 *               route's dispatch in `src/server/routes.ts` is read, and a route
 *               that calls the LITERAL matcher is checked to carry a literal
 *               disclaimer in its capability description rather than a
 *               meaning-word.
 *   CERTIFIED — an agent reading its own capability list cannot be TOLD a
 *               surface recalls by meaning when it recalls by word-match.
 *
 * It does NOT certify that recall is good, that embeddings are present, or that
 * every recall path in the codebase is honest — only that the advertised
 * description of these routes matches the method they dispatch to.
 *
 * What input passes this check while failing the claim? A recall surface that is
 * neither advertised in the capability index nor named here — a new store with
 * its own search, described honestly nowhere. The population is the advertised
 * one; a surface nobody advertises is invisible to this check. Named, not hidden.
 *
 * ── Earned from ────────────────────────────────────────────────────────────
 * 2026-07-27 and re-measured 2026-08-05 (topic 29723). All 2,852 memory entries
 * carried embeddings at 100% coverage while the retrieval path in use ran on
 * word-matching, and the measured consequence was re-deriving a lesson that had
 * been correctly written down EIGHT DAYS EARLIER — experienced from the inside
 * not as a failed search but as an original discovery, because a keyword miss
 * and an absence are the same event from the inside.
 *
 * The 2026-08-05 re-measurement found the defect had changed shape rather than
 * closed: the meaning-based path works and is reachable at
 * `/semantic/search/hybrid`, while `/semantic/search` — the one the capability
 * index advertised as "semantic search" — is keyword-only, and identifies itself
 * as such by erroring in SQLite FTS5 syntax on a query containing an apostrophe.
 * **In one respect that is worse than the original**: then the capability was
 * merely unwired, and nobody called it; afterwards it was MISLABELLED, so an
 * agent doing the correct thing — reading its own capabilities and calling the
 * documented search — got word-matching from something named for meaning.
 *
 * The discriminator that settled it depends on nobody's report: a search over
 * meaning always has nearest neighbours, so real-but-absent words still return
 * something. **Nothing-returned is itself the signature of a word-matcher.**
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-recall-surface-names-match-mechanism.mjs
 *   node scripts/lint-recall-surface-names-match-mechanism.mjs --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const JSON_OUT = process.argv.includes('--json');

const CAPABILITY_REL = 'src/server/CapabilityIndex.ts';
const ROUTES_REL = 'src/server/routes.ts';

/**
 * The retrieval methods, classified by MECHANISM rather than by name. A method
 * whose name contains "semantic" proves nothing — that is the entire finding.
 */
const MEANING_METHODS = ['searchHybrid'];
const LITERAL_METHODS = ['search'];

/** Words that promise recall-by-meaning to a reader. */
const MEANING_WORDS = /\b(semantic|by meaning|meaning-based|vector|embedding|nearest neighbou?r)/i;
/** An explicit admission that the surface is literal-match only. */
const LITERAL_DISCLAIMER = /\b(literal|keyword[- ]only|word[- ]match|FTS5|exact[- ]match)/i;

const failures = [];
const capAbs = path.join(ROOT, CAPABILITY_REL);
const routesAbs = path.join(ROOT, ROUTES_REL);

for (const [rel, abs] of [[CAPABILITY_REL, capAbs], [ROUTES_REL, routesAbs]]) {
  if (!fs.existsSync(abs)) {
    console.error(`[recall-surface-names] ${rel} is missing — refusing to report clean over a source that is not there.`);
    process.exit(1);
  }
}

const capability = fs.readFileSync(capAbs, 'utf-8');
const routes = fs.readFileSync(routesAbs, 'utf-8');

/**
 * Read each advertised search route's DISPATCH from routes.ts: the retrieval
 * method its handler actually calls. Structural, not semantic.
 */
function dispatchOf(routePath) {
  // Delimit the handler by the NEXT route registration, not by the next `});`.
  // A lazy match to `});` terminates on the first inner object-literal call —
  // e.g. the `res.status(503).json({ … });` guard on line one of the handler —
  // yielding a body that contains no dispatch at all. That first version
  // reported "dispatches to no recognized retrieval method" for BOTH routes,
  // and every injection case then failed for that same unrelated reason while
  // still exiting non-zero. The B-cases looked like they passed.
  //
  // Recorded rather than quietly fixed: a control that cannot produce a match
  // fails identically to a control that found something, so an exit code alone
  // does not prove a check fired for its own reason. The harness now asserts the
  // REASON, not just the exit status.
  const start = routes.search(new RegExp(`router\\.get\\(\\s*['"\`]${routePath.replace(/\//g, '\\/')}['"\`]`));
  if (start < 0) return null;
  const rest = routes.slice(start + 1);
  const nextRoute = rest.search(/router\.(get|post|put|patch|delete)\s*\(/);
  const body = nextRoute < 0 ? rest : rest.slice(0, nextRoute);
  for (const meaning of MEANING_METHODS) if (new RegExp(`\\.${meaning}\\s*\\(`).test(body)) return { method: meaning, mode: 'meaning' };
  for (const literal of LITERAL_METHODS) if (new RegExp(`\\.${literal}\\s*\\(`).test(body)) return { method: literal, mode: 'literal' };
  return { method: null, mode: 'unknown' };
}

// The advertised population: capability-index lines describing a search route.
const advertised = capability
  .split('\n')
  .map((line, i) => ({ line: line.trim(), lineNo: i + 1 }))
  .filter(({ line }) => /^['"`]GET \/semantic\/search/.test(line));

if (advertised.length === 0) {
  // An empty population would otherwise read as "every advertised surface is
  // honest" — the false all-clear this standard family refuses.
  failures.push(`no advertised /semantic/search surfaces found in ${CAPABILITY_REL} — refusing to report clean over an empty set.`);
}

const checked = [];
for (const { line, lineNo } of advertised) {
  const routeMatch = line.match(/GET (\/semantic\/search(?:\/hybrid)?)/);
  if (!routeMatch) continue;
  const routePath = routeMatch[1];
  const dispatch = dispatchOf(routePath);
  if (!dispatch) {
    failures.push(`${CAPABILITY_REL}:${lineNo} advertises ${routePath}, but no handler for it was found in ${ROUTES_REL} — cannot verify the description.`);
    continue;
  }
  if (dispatch.mode === 'unknown') {
    failures.push(`${routePath} dispatches to no recognized retrieval method — classify it before advertising it.`);
    continue;
  }
  const promisesMeaning = MEANING_WORDS.test(line);
  const admitsLiteral = LITERAL_DISCLAIMER.test(line);
  if (dispatch.mode === 'literal' && promisesMeaning && !admitsLiteral) {
    failures.push(
      `${CAPABILITY_REL}:${lineNo} — ${routePath} calls the LITERAL matcher (.${dispatch.method}) but is advertised ` +
      `with meaning-words and no literal disclaimer. An agent reading its own capabilities and calling the ` +
      `documented search would get word-matching from something named for meaning — and would read zero ` +
      `results as "this does not exist".`,
    );
  }
  if (dispatch.mode === 'literal' && !admitsLiteral) {
    failures.push(
      `${CAPABILITY_REL}:${lineNo} — ${routePath} is literal-match only and its description does not say so. ` +
      `A negative from a literal matcher must be reported as no-literal-match, never as an existence claim.`,
    );
  }
  checked.push({ route: routePath, dispatch: dispatch.method, mode: dispatch.mode, promisesMeaning, admitsLiteral });
}

const report = { advertised: advertised.length, checked, failures };

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-recall-surface-names-match-mechanism: clean — ${checked.length} advertised recall surface(s); ` +
    checked.map((c) => `${c.route} → .${c.dispatch} (${c.mode})`).join(', ') + '.',
  );
}

if (failures.length > 0) {
  console.error('\n❌ lint-recall-surface-names-match-mechanism failed:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nWhy this exists: a keyword-only search returns "no literal match in the tokens I happened to try", ' +
    'and that result is READ AS "this does not exist". Those are different claims. ' +
    'See docs/proposals/standard-proposal-recall-by-meaning-not-word-match.md\n',
  );
  process.exit(1);
}
