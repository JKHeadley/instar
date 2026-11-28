#!/usr/bin/env node
/**
 * lint-maturation-dated-owner.mjs — a dark rung has a dated owner.
 *
 * Governed by: *Maturation Path — Test Agent → Development Agent → Fleet* (docs/STANDARDS-REGISTRY.md),
 * clauses (c), (d) and (h). It closes the countdown `STD-SUBCOUNTDOWN-maturation-bcd`.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Clause (h): "A ladder entry whose next rung has no owner or no due date must fail the build the
 * same way a missing entry does." The dated-owner half is Justin's directive (topic 139880,
 * 2026-11-06). Before this check, no entry in src/data/feature-ladders.json carried an owner or a
 * due date, so a dark rung could wait forever with nobody named to decide it.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 *   MEASURED  — every entry whose disposition is `ladder` and that is not `finished` carries
 *               `tracking.owner` (non-empty text) and `tracking.reviewDue` (a YYYY-MM-DD date).
 *               Every rung whose review date has passed is listed by name on every run.
 *   CERTIFIED — no dark rung is unowned or undated. That covers ship time too (clause (c)):
 *               tests/unit/feature-ladders-coverage.test.ts already fails a switched-off flag
 *               with no entry, and this check makes that entry carry its owner and date from day one.
 *
 * A PASSED review date does NOT fail the build, and that is a deliberate choice. The article says
 * an overdue rung "closes with evidence, is re-dated with a recorded reason, or goes to the operator
 * before its date". It never says the whole project stops. A build failure on a date is what
 * stopped every commit on 2026-11-27, when one registry countdown passed. With 231 dark rungs, a
 * date-triggered failure would recreate that stop every week. So overdue rungs are reported loudly
 * here. The READER that turns that report into action is the Feature maturation owner's daily
 * watch on this agent (Pipeline Strategy, `.instar/scripts/standards-countdown-watch.py`, 08:00). It
 * reads main's ladder file and messages each owner's session with its overdue rungs, and gives the
 * Chief of Staff the list. Overdue rungs never stop someone else's commit.
 *
 * What passes this check while failing the claim? An owner named who is not real or not working,
 * or a date set far in the future to avoid review. Neither is visible to a lint; the owner's own review and the
 * Feature maturation owner read them.
 *
 * Flags: --json (machine-readable result), --today=YYYY-MM-DD (for tests).
 * Exit codes: 0 — clean (overdue rungs only reported); 1 — a dark rung lacks an owner or a date, or
 * the registry is unreadable.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FILE = path.join(ROOT, 'src/data/feature-ladders.json');
const JSON_OUT = process.argv.includes('--json');
const todayArg = process.argv.find((a) => a.startsWith('--today='));
const TODAY = todayArg ? todayArg.slice('--today='.length) : new Date().toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date: the shape alone would accept 2026-02-30. */
function isCalendarDate(v) {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function fail(msg) {
  console.error(`lint-maturation-dated-owner: FAILED — ${msg}`);
  process.exit(1);
}

let registry;
try { registry = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { fail('src/data/feature-ladders.json is unreadable or not JSON'); }
if (!registry || !Array.isArray(registry.entries)) fail('src/data/feature-ladders.json has no "entries" list');

const dark = registry.entries.filter((e) => e && e.disposition === 'ladder' && !e.finished);
const missing = [];
const overdue = [];
for (const e of dark) {
  const t = e.tracking ?? {};
  const gaps = [];
  if (typeof t.owner !== 'string' || !t.owner.trim()) gaps.push('owner');
  if (!isCalendarDate(t.reviewDue)) gaps.push('reviewDue');
  if (gaps.length) { missing.push({ id: e.id, gaps }); continue; }
  if (t.reviewDue < TODAY) overdue.push({ id: e.id, owner: t.owner, reviewDue: t.reviewDue });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ today: TODAY, dark: dark.length, missing, overdue }, null, 1));
  process.exit(missing.length ? 1 : 0);
}
if (overdue.length) {
  console.log(`lint-maturation-dated-owner: ${overdue.length} dark rung(s) past their review date (reported, not failed). ` +
    'Each one closes with evidence, is re-dated with a recorded reason, or goes to the operator:');
  for (const o of overdue) console.log(`  - ${o.id}: due ${o.reviewDue}, owner ${o.owner}`);
}
if (missing.length) {
  console.error('lint-maturation-dated-owner: FAILED');
  for (const m of missing) {
    console.error(`  - ${m.id} is a dark rung with no ${m.gaps.join(' and no ')}. Add "tracking.owner" (the session or ` +
      'project that decides its next rung) and "tracking.reviewDue" (YYYY-MM-DD) in src/data/feature-ladders.json.');
  }
  console.error(`  ${dark.length} dark rung(s), ${missing.length} without an owner or a date.`);
  process.exit(1);
}
console.log(`lint-maturation-dated-owner: OK — ${dark.length} dark rung(s), each with an owner and a review date; ${overdue.length} past due.`);
