#!/usr/bin/env node
/**
 * lint-documented-only-countdown.mjs — documented-only is a COUNTDOWN, never terminal.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * An external reviewer found on 2026-08-06 that two articles claimed enforcement
 * their own text did not substantiate (*OVERREACH — Yes*). Justin ruled on
 * 2026-08-07 that they be relabelled `documented-only`, and attached a condition
 * in his own words:
 *
 *   "the documented-only MUST force a change in the near future.
 *    It can't remain documented only."
 *
 * That condition is the whole reason this file exists. An honest gap label is an
 * improvement over a false enforcement claim, but *only* if the label expires. A
 * permanent `documented-only` is just a false claim with better manners — the
 * registry stops lying about the guard and starts quietly accepting its absence.
 *
 * So a relabelled article must carry a DEADLINE and a tracked id, and this check
 * turns that deadline into teeth: when it passes, CI goes red until someone
 * either ships the guard or the operator deliberately re-dates it. The pressure
 * is structural rather than a note in someone's queue — *Structure beats
 * Willpower* applied to the registry's own honesty.
 *
 * ── Why in-repo rather than a tracker row ──────────────────────────────────
 * The ruling said "register a tracked enforcement item on the maturation /
 * initiative track". The initiative tracker persists to `.instar/initiatives.json`
 * — per-machine RUNTIME state, invisible to CI and to a successor on another
 * machine. A declaration in the registry, enforced here, is strictly stronger on
 * every axis that matters: it is reviewed in the PR that creates it, it travels
 * with the repository, and it can actually fail a build. Recorded as a deliberate
 * substitution rather than a silent one.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — (1) every article in REQUIRE_COUNTDOWN carries a parseable
 *               `**Documented-only until.**` declaration with an ISO date and a
 *               tracked id; (2) no declared deadline is in the past; (3) an
 *               article carrying a countdown is still classified a gap by
 *               standards-coverage — i.e. it has not silently gained a guard and
 *               kept its countdown.
 *   CERTIFIED — an honestly-labelled gap cannot become a permanent resting
 *               state without a build failing.
 *
 * It does NOT certify that the countdown's stated remedy is the right one, that
 * the deadline is reasonable, or that anyone is working on it. A deliberate
 * re-dating passes — and must, because the alternative is a check that forces
 * either a rushed guard or a deleted standard. What it makes impossible is the
 * SILENT version: a gap that nobody ever looks at again.
 *
 * What input passes this check while failing the claim? A newly-relabelled
 * article that nobody adds to REQUIRE_COUNTDOWN. The required population is
 * declared, not discovered — naming that, not hiding it.
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const JSON_OUT = process.argv.includes('--json');
const REGISTRY_REL = 'docs/STANDARDS-REGISTRY.md';

/**
 * Articles that MUST carry a countdown. Grow-only by convention: relabelling a
 * further article `documented-only` under the same ruling means adding it here in
 * the same change. Declared rather than discovered so that removing an entry is a
 * visible edit in a diff instead of a silent shrink.
 */
const REQUIRE_COUNTDOWN = [
  'Session Input Is a Principal',
  'Close the Loop',
  // Added 2026-08-08 (ruling B, brief 1): the threshold-of-importance amendment
  // states an obligation with no guard yet, so it carries a countdown like the
  // relabels above. Grow-only — see the header.
  'The Body and the Mind',
];

/** `**Documented-only until.** \`2026-09-07\` — tracked as \`STD-COUNTDOWN-x\`.` */
const COUNTDOWN_RE = /\*\*Documented-only until\.\*\*\s*`?(\d{4}-\d{2}-\d{2})`?\s*—\s*tracked as\s*`([A-Za-z0-9-]+)`/;

/** Today, as a date-only UTC string, so the comparison is timezone-stable. */
const TODAY = new Date().toISOString().slice(0, 10);

const abs = path.join(ROOT, REGISTRY_REL);
if (!fs.existsSync(abs)) {
  console.error(`[documented-only-countdown] ${REGISTRY_REL} is missing — refusing to report clean.`);
  process.exit(1);
}

// Split into articles: heading → body.
const lines = fs.readFileSync(abs, 'utf-8').split('\n');
const articles = [];
let current = null;
let fence = null;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const t = line.trimStart();
  const f = t.match(/^(`{3,}|~{3,})/);
  if (fence === null && f) { fence = f[1]; if (current) current.body.push(line); continue; }
  if (fence !== null) { if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(t)) fence = null; if (current) current.body.push(line); continue; }
  const h = line.match(/^###\s+(.+?)\s*$/);
  if (h) { current = { name: h[1].trim(), lineNo: i + 1, body: [] }; articles.push(current); continue; }
  if (current) current.body.push(line);
}

if (articles.length === 0) {
  console.error('[documented-only-countdown] parsed ZERO articles — the matcher is broken; refusing to report clean.');
  process.exit(1);
}

function resolveArticle(name) {
  const exact = articles.find((a) => a.name === name);
  if (exact) return exact;
  const prefixed = articles.filter((a) => a.name.startsWith(`${name} —`) || a.name.startsWith(`${name}.`));
  return prefixed.length === 1 ? prefixed[0] : null;
}

/**
 * The gap set comes from standards-coverage, the single authority on enforcement
 * classification. Reimplementing that classification here would create a second
 * owner of one judgment — the defect ruling 2 was raised about.
 */
let gaps = null;
try {
  const out = execFileSync('node', [path.join(ROOT, 'scripts/standards-coverage.mjs'), '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  gaps = new Set(JSON.parse(out).gaps ?? []);
} catch {
  gaps = null; // Reported below as an honest degradation, never as a pass.
}

const failures = [];
const countdowns = [];

// Every article that CARRIES a countdown must have a valid, unexpired one.
for (const a of articles) {
  const m = a.body.join('\n').match(COUNTDOWN_RE);
  if (!m) continue;
  const [, deadline, trackedAs] = m;
  countdowns.push({ article: a.name, deadline, trackedAs, lineNo: a.lineNo });

  if (Number.isNaN(Date.parse(deadline))) {
    failures.push(`${REGISTRY_REL}:${a.lineNo} — "${a.name}" declares an unparseable countdown deadline "${deadline}".`);
    continue;
  }
  if (deadline < TODAY) {
    failures.push(
      `${REGISTRY_REL}:${a.lineNo} — "${a.name}" is STILL documented-only and its countdown EXPIRED on ${deadline} (today ${TODAY}). ` +
      `This is the check doing its job: documented-only is a countdown, not a resting state. Ship the guard named in the ` +
      `article's "What would close this countdown", or have the operator deliberately re-date it — but it may not simply sit.`,
    );
  }
  if (gaps && !gaps.has(a.name)) {
    failures.push(
      `${REGISTRY_REL}:${a.lineNo} — "${a.name}" carries a documented-only countdown but standards-coverage no longer ` +
      `classifies it as a gap, so it has GAINED a guard. Remove the countdown — a stale countdown on an enforced article ` +
      `understates the registry's own protection, which is the mirror of the over-claim this machinery was built for.`,
    );
  }
}

// Every REQUIRED article must carry one.
for (const name of REQUIRE_COUNTDOWN) {
  const a = resolveArticle(name);
  if (!a) {
    failures.push(
      `required article "${name}" resolves to no article. This population is declared, so a rename or removal must be ` +
      `reflected in REQUIRE_COUNTDOWN in the same change rather than silently shrinking the check.`,
    );
    continue;
  }
  if (!COUNTDOWN_RE.test(a.body.join('\n'))) {
    failures.push(
      `${REGISTRY_REL}:${a.lineNo} — "${a.name}" was relabelled documented-only by operator ruling but carries no ` +
      `"**Documented-only until.** \`YYYY-MM-DD\` — tracked as \`ID\`" declaration. An honest gap label with no expiry is ` +
      `a false claim with better manners.`,
    );
  }
}

if (gaps === null) {
  failures.push(
    'could not obtain the gap set from scripts/standards-coverage.mjs --json, so the "silently gained a guard" arm did ' +
    'not run. Failing rather than reporting a partial pass as clean.',
  );
}

const report = { articles: articles.length, today: TODAY, required: REQUIRE_COUNTDOWN, countdowns, failures };

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  const soonest = [...countdowns].sort((a, b) => a.deadline.localeCompare(b.deadline))[0];
  console.log(
    `lint-documented-only-countdown: clean — ${countdowns.length} countdown(s), all unexpired` +
    (soonest ? `; soonest ${soonest.deadline} ("${soonest.article}")` : '') + '.',
  );
}

if (failures.length > 0) {
  console.error('\n❌ lint-documented-only-countdown failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
