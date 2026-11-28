#!/usr/bin/env node
/**
 * lint-substrate-admission-declared.mjs — a new Substrate article states how it passes admission.
 *
 * Governed by: *Documentation IS Being* (docs/STANDARDS-REGISTRY.md), which the Substrate family's
 * intro cites against a family misdescribing its own scope, and the family's ADMISSION RULE in that
 * intro. It closes the check half of `STD-SUBCOUNTDOWN-substrate-membership`.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The family's admission rule (2026-08-08) says an article belongs here only if it passes all three
 * tests: (1) a fact about the MODEL or its training, not the software; (2) invisible from outside;
 * (3) not derivable by a competent engineer reading the code. The registry admitted "nothing checks
 * membership against these three tests". Four engineering articles had been shelved here unnoticed
 * until external review found them, and the 2026-11-27 sweep found more.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 *   MEASURED  — every `### ` article inside the Substrate section that is not in the shrink-only
 *               baseline carries a `**Admission.**` line that names all three tests ("test 1",
 *               "test 2", "test 3"). An entry in the baseline must still be an article in the
 *               section, and an article that gains an Admission line must leave the baseline.
 *   CERTIFIED — no article joins the family without its author stating, where a reviewer reads it,
 *               how it passes each test.
 * It does NOT certify that the stated reasons are true. Judging whether an article is really a
 * model-level property is a semantic reading, and *Intelligence Infers, Keywords Only Guard* keeps
 * that out of a regex. The declaration makes the claim explicit and reviewable; family review and
 * the recorded sweep (docs/audits/substrate-membership-sweep-2026-11-27.md) judge it.
 *
 * Baseline: docs/substrate-admission-baseline.json, `{ "readBySweep": "<audit path>",
 * "articlesWithoutAdmissionLine": [titles] }`. These are the 27 articles the 2026-11-27 sweep read.
 * It may only shrink.
 *
 * Exit codes: 0 — clean; 1 — a violation, or an unreadable registry or baseline.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const REGISTRY = path.join(ROOT, 'docs/STANDARDS-REGISTRY.md');
const BASELINE = path.join(ROOT, 'docs/substrate-admission-baseline.json');
const SECTION = /^## The Substrate\b/;

function fail(msg) {
  console.error(`lint-substrate-admission-declared: FAILED — ${msg}`);
  process.exit(1);
}

let text;
try { text = fs.readFileSync(REGISTRY, 'utf8'); } catch { fail('docs/STANDARDS-REGISTRY.md is unreadable'); }
const lines = text.split('\n');
const start = lines.findIndex((l) => SECTION.test(l));
if (start < 0) fail('the registry has no "## The Substrate" section');
// Markdown headings: up to three spaces of indent, then the hashes, then a space or a tab.
// Lines inside a fenced code block are not headings. A level-1 or level-2 heading ends the section.
const articles = [];
let fenced = false;
for (let i = start + 1; i < lines.length; i++) {
  const line = lines[i];
  if (/^ {0,3}(```|~~~)/.test(line)) { fenced = !fenced; if (articles.length) articles[articles.length - 1].body.push(line); continue; }
  if (!fenced && /^ {0,3}#{1,2}[ \t]/.test(line)) break;
  const h = fenced ? null : /^ {0,3}###[ \t]+(.*?)[ \t#]*$/.exec(line);
  if (h) articles.push({ title: h[1].trim(), body: [] });
  else if (articles.length) articles[articles.length - 1].body.push(line);
}

let baseline;
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch { fail('docs/substrate-admission-baseline.json is missing or not JSON'); }
if (!baseline || !Array.isArray(baseline.articlesWithoutAdmissionLine)) fail('the baseline must be { "articlesWithoutAdmissionLine": [titles] }');
const grandfathered = new Set(baseline.articlesWithoutAdmissionLine);

const errors = [];
const titles = new Set(articles.map((a) => a.title));
let declared = 0;
for (const a of articles) {
  const line = a.body.find((l) => l.startsWith('**Admission.**'));
  const complete = line && /\btest 1\b/i.test(line) && /\btest 2\b/i.test(line) && /\btest 3\b/i.test(line);
  if (complete) {
    declared++;
    if (grandfathered.has(a.title)) errors.push(`*${a.title}* now carries an Admission line: remove it from the baseline (it may only shrink).`);
    continue;
  }
  if (grandfathered.has(a.title)) continue;
  errors.push(line
    ? `*${a.title}* has an Admission line that does not address all three tests (name "test 1", "test 2" and "test 3", each with its reason).`
    : `*${a.title}* is filed in The Substrate with no "**Admission.**" line. State how it passes each of the family's three admission tests (test 1: a fact about the model, not the software; test 2: invisible from outside; test 3: not derivable by reading the code), or file it in the family it belongs to.`);
}
for (const t of grandfathered) {
  if (!titles.has(t)) errors.push(`baseline entry "${t}" is no longer an article in The Substrate: remove it (the baseline may only shrink).`);
}

const summary = `${articles.length} article(s) in The Substrate: ${declared} with an Admission line, ${grandfathered.size} read by the 2026-11-27 sweep and baselined.`;
if (errors.length) {
  console.error('lint-substrate-admission-declared: FAILED');
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`  ${summary}`);
  process.exit(1);
}
console.log(`lint-substrate-admission-declared: OK — ${summary}`);
