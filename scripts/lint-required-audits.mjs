#!/usr/bin/env node
// safe-git-allow: read-only git (merge-base, show) to compare the register with main's copy; nothing in the checkout is changed.
/**
 * lint-required-audits.mjs — audits that must recur are listed, and a missed one is named.
 *
 * Governed by: *Iterative Audit to Convergence*. Closes the countdown
 * `STD-SUBCOUNTDOWN-audit-never-started` ("nothing makes an audit RUN — a sweep that is simply never
 * started satisfies no check") once the registry PR for the 21 Dec cliff records it.
 * Spec: docs/specs/audit-never-started.md.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 *   MEASURED  — docs/audits/required-audits.json is well formed: every row has an id, owner, scope,
 *               whole-number cadenceDays and a real calendar firstDueBy; no duplicate ids; no unknown
 *               keys. Against main's copy of the register (read from git, as the back-reference
 *               baseline is): a row may not disappear unless it is listed in `retired` with a
 *               reason, and a row may not move its firstDueBy later or lengthen its cadenceDays
 *               without a NEW dueReason. Each row's state against the reports in docs/audits/:
 *               ok | not-yet-due | never-started | overdue. A row matches a report whose frontmatter
 *               `audit:` id, or whose file name, is the row id or one of its `reports` ids, either
 *               exactly or with a -YYYY-MM-DD suffix. Only a report carrying a `converged:` stamp
 *               (earned by write-audit-convergence.mjs) counts as a completed run; an unstamped
 *               match is listed as "ran, not converged".
 *   CERTIFIED — every listed audit either has a recent converged run, is not yet due, or is named,
 *               on every run of this check, as never started or overdue; and no row is quietly
 *               snoozed or removed.
 *
 * A LAPSED AUDIT DOES NOT FAIL THE COMMIT, deliberately: on 2026-11-27 one passed countdown date
 * stopped every commit in the project for two hours. The commit check fails only on the register's
 * shape and on an unexplained snooze. Lapses reach owners through the weekly nonblocking workflow
 * (.github/workflows/required-audits-cadence.yml, one marker-owned issue) and the Feature maturation
 * owner's daily watch. `--fail-on-lapsed` exits 1 on any lapse for anyone who wants a hard exit;
 * neither the commit chain nor the workflow passes it.
 *
 * What passes this check while failing the claim? A shallow audit that still converged (the
 * validator's job), and an audit that should recur but was never listed (a review call).
 *
 * Flags: --json, --today=YYYY-MM-DD, --fail-on-lapsed, --root=<dir>, --main-register=<file>|none
 * (tests). Exit: 0 clean or lapses only reported; 1 register malformed, unexplained snooze, a bad
 * flag, or a lapse with --fail-on-lapsed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GRACE_DAYS = 14;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROW_KEYS = new Set(['id', 'scope', 'owner', 'cadenceDays', 'firstDueBy', 'dueReason', 'reports']);
const TOP_KEYS = new Set(['about', 'status', 'contentTriggered', 'audits', 'retired']);

/** A real calendar date: the shape alone would accept 2026-02-30. */
export function isCalendarDate(v) {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** Frontmatter `audit:` and `converged:` of one report (LF or CRLF), plus its file-name slug. */
export function readReport(file, text) {
  const norm = String(text).replace(/\r\n?/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(norm)?.[1] ?? '';
  const field = (k) => {
    const m = new RegExp(`^${k}:[ \\t]*(.*)$`, 'm').exec(fm);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  };
  const converged = field('converged');
  return {
    file,
    slug: path.basename(file, '.md'),
    audit: field('audit') || null,
    converged: converged && isCalendarDate(converged.slice(0, 10)) ? converged.slice(0, 10) : null,
  };
}

/** `name` is `id` exactly, or `id` followed by a -YYYY-MM-DD suffix. */
function sameAudit(name, id) {
  if (!name) return false;
  if (name === id) return true;
  const m = /^(.*)-(\d{4}-\d{2}-\d{2})$/.exec(name);
  return Boolean(m && m[1] === id);
}

/** Does this report belong to the row? Its frontmatter id or file name names the row id or a `reports` id. */
export function matches(report, row) {
  const ids = [row.id, ...(Array.isArray(row.reports) ? row.reports : [])];
  // A report that declares an audit id is judged by that id alone; otherwise by its file name.
  return ids.some((id) => (report.audit ? sameAudit(report.audit, id) : sameAudit(report.slug, id)));
}

/** Shape problems in the register (these fail the commit). */
export function shapeProblems(register) {
  const problems = [];
  if (!register || typeof register !== 'object' || !Array.isArray(register.audits)) return ['the register has no "audits" list'];
  for (const k of Object.keys(register)) if (!TOP_KEYS.has(k)) problems.push(`unknown top-level key "${k}"`);
  const seen = new Set();
  for (const [i, row] of register.audits.entries()) {
    const where = `row ${i + 1}${row && typeof row.id === 'string' ? ` (${row.id})` : ''}`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) { problems.push(`${where} is not an object`); continue; }
    for (const k of Object.keys(row)) if (!ROW_KEYS.has(k)) problems.push(`${where} has an unknown key "${k}"`);
    for (const k of ['id', 'owner', 'scope']) {
      if (typeof row[k] !== 'string' || !row[k].trim()) problems.push(`${where} has no ${k}`);
    }
    if (!Number.isInteger(row.cadenceDays) || row.cadenceDays < 1) problems.push(`${where} has no whole-number cadenceDays`);
    if (!isCalendarDate(row.firstDueBy)) problems.push(`${where} has no real calendar firstDueBy`);
    if (row.dueReason !== undefined && (typeof row.dueReason !== 'string' || !row.dueReason.trim())) problems.push(`${where} has an empty dueReason`);
    if (row.reports !== undefined && (!Array.isArray(row.reports) || row.reports.some((r) => typeof r !== 'string' || !r.trim()))) {
      problems.push(`${where} has a "reports" value that is not a list of ids`);
    }
    if (typeof row.id === 'string') {
      if (seen.has(row.id)) problems.push(`${where} repeats an id`);
      seen.add(row.id);
    }
  }
  if (register.retired !== undefined) {
    if (!Array.isArray(register.retired)) problems.push('"retired" is not a list');
    else for (const r of register.retired) {
      if (!r || typeof r.id !== 'string' || typeof r.reason !== 'string' || !r.reason.trim()) problems.push('a "retired" entry needs an id and a reason');
    }
  }
  return problems;
}

/** Snooze problems against main's copy (these fail the commit). `mainRegister` null = not compared. */
export function snoozeProblems(register, mainRegister) {
  if (!mainRegister || !Array.isArray(mainRegister.audits)) return [];
  const problems = [];
  const now = new Map(register.audits.map((r) => [r.id, r]));
  const retired = new Set(Array.isArray(register.retired) ? register.retired.map((r) => r && r.id) : []);
  for (const old of mainRegister.audits) {
    if (!old || typeof old.id !== 'string') continue;
    const cur = now.get(old.id);
    if (!cur) {
      if (!retired.has(old.id)) problems.push(`${old.id} was removed without a "retired" entry and reason`);
      continue;
    }
    const later = isCalendarDate(cur.firstDueBy) && isCalendarDate(old.firstDueBy) && cur.firstDueBy > old.firstDueBy;
    const longer = Number.isInteger(cur.cadenceDays) && Number.isInteger(old.cadenceDays) && cur.cadenceDays > old.cadenceDays;
    const oldReports = new Set(Array.isArray(old.reports) ? old.reports : []);
    const newAlias = Array.isArray(cur.reports) && cur.reports.some((r) => !oldReports.has(r));
    const reason = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
    const newReason = reason(cur.dueReason) !== '' && reason(cur.dueReason) !== reason(old.dueReason);
    const what = later ? 'moved its firstDueBy later' : longer ? 'lengthened its cadenceDays' : 'added a reports alias';
    if ((later || longer || newAlias) && !newReason) problems.push(`${old.id} ${what} without a new dueReason`);
  }
  return problems;
}

/** One row's state against the reports. */
export function rowState(row, reports, today) {
  const mine = reports.filter((r) => matches(r, row));
  const last = mine.filter((r) => r.converged).map((r) => r.converged).sort().at(-1) ?? null;
  const unstamped = mine.filter((r) => !r.converged).map((r) => r.slug).sort();
  let state;
  if (last) state = days(last, today) > row.cadenceDays + GRACE_DAYS ? 'overdue' : 'ok';
  else state = today > row.firstDueBy ? 'never-started' : 'not-yet-due';
  return { id: row.id, owner: row.owner, state, lastConverged: last, unstampedReports: unstamped };
}

/** main's copy of the register, read from git at the merge base with the first main ref that exists
 * (origin/main in a CI checkout, JKHeadley/main in an agent worktree, then a local main). */
function mainRegisterFromGit(root) {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const found = [];
  for (const ref of ['origin/main', 'JKHeadley/main', 'main']) {
    let base;
    try { base = git('merge-base', 'HEAD', ref); } catch { continue; }
    found.push(ref);
    // A ref without the register falls through: in an agent worktree origin/main may be a stale or
    // different remote while JKHeadley/main already carries the register.
    try { return { register: JSON.parse(git('show', `${base}:docs/audits/required-audits.json`)), note: null, ref }; } catch { /* next ref */ }
  }
  if (found.length) {
    return { register: null, note: `NOTE: no main ref (${found.join(', ')}) has docs/audits/required-audits.json at the merge base (first introduction), so removed or snoozed rows were not compared.` };
  }
  return { register: null, note: 'NOTE: no main ref (origin/main, JKHeadley/main or main) was found, so removed or snoozed rows were not compared (a shallow clone or a detached checkout).' };
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const root = flag('root') ?? process.cwd();
  const today = flag('today') ?? new Date().toISOString().slice(0, 10);
  const json = argv.includes('--json');
  const failOnLapsed = argv.includes('--fail-on-lapsed');
  const emit = (out, code) => { if (json) console.log(JSON.stringify(out, null, 1)); process.exit(code); };
  if (!isCalendarDate(today)) {
    if (!json) console.error(`lint-required-audits: FAILED — --today must be a real YYYY-MM-DD date (got "${today}")`);
    emit({ today, problems: ['bad --today'], rows: [] }, 1);
  }
  const audits = path.join(root, 'docs/audits');
  let register;
  try { register = JSON.parse(fs.readFileSync(path.join(audits, 'required-audits.json'), 'utf8')); } catch {
    if (!json) console.error('lint-required-audits: FAILED — docs/audits/required-audits.json is missing or not JSON');
    emit({ today, problems: ['register missing or not JSON'], rows: [] }, 1);
  }
  const mainFlag = flag('main-register');
  let mainCopy;
  if (mainFlag === 'none') mainCopy = { register: null, note: null };
  else if (mainFlag) mainCopy = { register: JSON.parse(fs.readFileSync(mainFlag, 'utf8')), note: null };
  else mainCopy = mainRegisterFromGit(root);
  const problems = shapeProblems(register);
  if (!problems.length) problems.push(...snoozeProblems(register, mainCopy.register));
  const reports = fs.readdirSync(audits).filter((f) => f.endsWith('.md')).map((f) => readReport(f, fs.readFileSync(path.join(audits, f), 'utf8')));
  const rows = problems.length ? [] : register.audits.map((row) => rowState(row, reports, today));
  const lapsed = rows.filter((r) => r.state === 'never-started' || r.state === 'overdue');
  if (!json) {
    if (mainCopy.note) console.log(`lint-required-audits: ${mainCopy.note}`);
    for (const r of lapsed) {
      const ran = r.unstampedReports.length ? `; ran but not converged: ${r.unstampedReports.join(', ')}` : '';
      console.log(`lint-required-audits: ${r.state} — ${r.id} (owner ${r.owner}; last converged ${r.lastConverged ?? 'never'}${ran})`);
    }
    if (problems.length) {
      console.error('lint-required-audits: FAILED');
      for (const p of problems) console.error(`  - ${p}`);
    } else {
      console.log(`lint-required-audits: OK — ${rows.length} required audit(s); ${lapsed.length} lapsed (reported, not failed${failOnLapsed ? ', but --fail-on-lapsed is set' : ''}).`);
    }
  }
  emit({ today, problems, note: mainCopy.note, rows }, problems.length || (failOnLapsed && lapsed.length) ? 1 : 0);
}

// Run as a script, also through a symlinked path or one containing spaces (/var -> /private/var on macOS).
const invoked = process.argv[1] ? (() => { try { return fs.realpathSync(process.argv[1]); } catch { return null; } })() : null;
if (invoked && fileURLToPath(import.meta.url) === invoked) main();
