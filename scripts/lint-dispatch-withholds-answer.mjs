#!/usr/bin/env node
/**
 * lint-dispatch-withholds-answer.mjs — every TEMPLATED dispatch to a checker
 * carries the withhold-the-answer protocol.
 *
 * Enforces the constitutional standard **"A Dispatch Supplies the Question and
 * Withholds the Answer"** (Standards Registry, The Substrate; a tree node under
 * *Verify the State, Not Its Symbol*).
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — every reviewer-prompt template under
 *               `skills/spec-converge/templates/` carries the
 *               `dispatch-withholds-answer` protocol clause, and that clause
 *               still contains the three instructions that make it load-bearing.
 *   CERTIFIED — a reviewer dispatched through a TEMPLATE is instructed to treat
 *               a supplied expectation as untrusted, to ground its own
 *               expectations from source, and that refutation is valuable.
 *
 * It does NOT certify that no dispatch anywhere carries an expected answer.
 *
 * What input passes this check while failing the claim? **An ad-hoc dispatch —
 * a lane prompt typed straight into a shell heredoc, which is exactly how the
 * crystallizing failure happened.** That population has no chokepoint to lint,
 * so this check covers the templated half only. Naming that gap here, in the
 * check itself, is the whole point of tooth (D): a reader who trusts this lint
 * should know what it leaves uncovered before they rely on it.
 *
 * ── Why this is not a phrase-matcher ───────────────────────────────────────
 * The originating proposal nominated a cheaper guard: scan dispatch prompts for
 * expectation-shaped fragments (`expected:`, `should be`, `confirm that`).
 * **Measured against the real population, that pattern was 100% false
 * positives** — both hits were normative design criteria a reviewer is meant to
 * APPLY ("a feature affecting every session should be visible somewhere"), not
 * answers supplied about the artifact under review.
 *
 * More decisively, it would violate a ratified standard: *Intelligence Infers,
 * Keywords Only Guard* — "a keyword/phrase/regex list is NEVER the
 * decision-maker for natural-language meaning." Whether a prompt supplies an
 * expected answer IS a meaning judgment. So this lint makes no semantic
 * judgment at all: it checks that the PROTOCOL is present, and leaves detecting
 * contamination to the reviewer the protocol instructs.
 *
 * ── Earned from ────────────────────────────────────────────────────────────
 * 2026-08-05, two independent instances in one working cycle. The agent, having
 * been wrong three times that window by reasoning from a reading, dispatched a
 * lane to settle a trust-boundary question BY EXECUTION — then wrote into the
 * prompt "print the actual operations for an unknown fingerprint (expected:
 * empty)". That expectation came from a test name he had established, that same
 * hour, was false. The lane returned exactly correct values and a verdict of
 * DEFECTIVE, because it compared them against the supplied expectation. The
 * instrument built to escape his anchoring reproduced the anchor inside itself
 * and returned it wearing the authority of execution. Three hours earlier the
 * manager had bundled a wrong causal guess into a message carrying a sound
 * measurement, and it inherited that measurement's credibility.
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-dispatch-withholds-answer.mjs
 *   node scripts/lint-dispatch-withholds-answer.mjs --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const JSON_OUT = process.argv.includes('--json');

const TEMPLATE_DIR = 'skills/spec-converge/templates';
const TEMPLATE_RE = /^reviewer-.*\.md$/;
const MARKER = 'dispatch-withholds-answer';

/**
 * The clause is only load-bearing if it carries all three instructions. A marker
 * alone would be a symbol standing in for the protocol — precisely what the
 * parent standard forbids, and precisely how a "migrated" prompt can pass while
 * saying nothing.
 */
const REQUIRED_CLAUSES = [
  'untrusted context, not a finding',
  'refuting it is the more valuable result',
  'separately from any hypothesis',
];

const failures = [];
const dirAbs = path.join(ROOT, TEMPLATE_DIR);

if (!fs.existsSync(dirAbs)) {
  console.error(`[dispatch-withholds-answer] ${TEMPLATE_DIR} does not exist — refusing to report clean over a population that is not there.`);
  process.exit(1);
}

const templates = fs.readdirSync(dirAbs).filter((f) => TEMPLATE_RE.test(f)).sort();

if (templates.length === 0) {
  // An empty population would otherwise read as "every template complies".
  failures.push(`no reviewer templates found in ${TEMPLATE_DIR} — refusing to report clean over an empty set.`);
}

for (const file of templates) {
  const rel = `${TEMPLATE_DIR}/${file}`;
  const content = fs.readFileSync(path.join(dirAbs, file), 'utf-8');
  if (!content.includes(MARKER)) {
    failures.push(
      `${rel} — dispatched reviewer prompt with no \`${MARKER}\` protocol clause. A dispatch must tell ` +
      `its checker to ground its own expectations and treat a supplied answer as untrusted.`,
    );
    continue;
  }
  const missing = REQUIRED_CLAUSES.filter((c) => !content.includes(c));
  if (missing.length > 0) {
    failures.push(
      `${rel} — carries the \`${MARKER}\` marker but the protocol is incomplete; missing: ` +
      missing.map((m) => `"${m}"`).join(', ') + '. A marker without its instructions is a symbol standing in for the protocol.',
    );
  }
}

const report = { population: templates.length, templates, failures };

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-dispatch-withholds-answer: clean — ${templates.length} templated dispatch(es) carry the ` +
    `complete withhold-the-answer protocol. (Ad-hoc dispatches are out of scope; see the header.)`,
  );
}

if (failures.length > 0) {
  console.error('\n❌ lint-dispatch-withholds-answer failed:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nWhy this exists: an expectation stated as fact inside a request does not get tested by the check — ' +
    'it gets ADOPTED by it, and returned wearing the authority of whatever method the check used. ' +
    'See docs/proposals/standard-proposal-a-dispatch-withholds-the-answer.md\n',
  );
  process.exit(1);
}
