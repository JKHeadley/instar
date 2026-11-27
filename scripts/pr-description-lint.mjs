#!/usr/bin/env node
// safe-git-allow: read-only diff and object reads for the open-time description lint
/**
 * pr-description-lint — the EARLY WARNING for a pull request's description.
 *
 * Why: the ELI16, decision-audit and release-fragment gates run only on pull
 * requests whose base is `main`. A stacked pull request (any other base) gets no
 * description check until it is retargeted, and its first refusal is safe-merge's
 * merge-time `refused:body-checks`, after a full verifier run. This lint runs the
 * SAME body functions safe-merge runs at merge time (`runLocalBodyChecks`), plus
 * the UX Impact rule (its own gate, reported separately), on every pull request
 * and every base, at open time. The result is a snapshot of the event; safe-merge
 * re-reads live data at merge time.
 *
 * Signal, never authority: it writes a job summary and one warning annotation per
 * failing check and always exits 0. It is not a required context; admission stays
 * with the verifier's admission reader and the merge-time floor stays the gate.
 *
 * Inputs come from the event and git (no network): PR_TITLE, PR_BODY,
 * PR_AUTHOR_LOGIN, PR_AUTHOR_TYPE, BASE_SHA, HEAD_SHA. The workflow runs this
 * file and its imports from `main`, and treats the pull request's commits only as
 * data. The workflow file itself comes from the pull request (pull_request), so a
 * pull request can change its OWN warning; that is accepted because the warning
 * gates nothing (see the side-effects review).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalBodyChecks, decisionRecordPaths } from './safe-merge.mjs';

/** `git diff --name-status` letters → the GitHub file statuses runLocalBodyChecks reads. */
const NAME_STATUS_TO_FILE_STATUS = { A: 'added', D: 'removed', M: 'modified', R: 'renamed', C: 'copied', T: 'modified' };

/**
 * Parse `git diff --name-status -z` output into `{ filename, status }` rows.
 * A rename or copy carries two paths; the second (new) path is the one reported,
 * as GitHub's files API does.
 */
export function parseNameStatusZ(text) {
  const parts = String(text ?? '').split('\0').filter((p) => p.length > 0);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].charAt(0);
    if (code === 'R' || code === 'C') {
      out.push({ filename: parts[i + 2] ?? '', status: NAME_STATUS_TO_FILE_STATUS[code] });
      i += 2;
    } else {
      out.push({ filename: parts[i + 1] ?? '', status: NAME_STATUS_TO_FILE_STATUS[code] ?? 'modified' });
      i += 1;
    }
  }
  return out.filter((f) => f.filename);
}

/** Normalize a UX lint exit code into a check row (2 = the lint's own internal error). */
export function uxCheckFromExit(code, stderr) {
  if (code === 0) return { name: 'ux-impact', ok: true };
  if (code === 2) return { name: 'ux-impact', ok: true, unmeasured: true, detail: 'the UX lint could not run' };
  const lines = String(stderr ?? '').split('\n').map((l) => l.replace(/^::error::/, '').trim()).filter(Boolean);
  return { name: 'ux-impact', ok: false, detail: lines[0] ?? 'UX Impact declaration failed' };
}

/**
 * The UX lint reads ' as a quote mark, so an apostrophe inside a quoted phrase
 * ("A document's settings") ends the quote early and the phrase no longer matches
 * the diff. Name the character and where it is, so the author can fix it at once.
 */
export function uxApostropheHint(body) {
  const section = String(body ?? '').match(/^## UX Impact\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im)?.[1] ?? '';
  const hits = [];
  section.split('\n').forEach((line, i) => {
    const m = /[A-Za-z]'[A-Za-z]/.exec(line);
    if (m) hits.push(`line ${i + 1} of the UX Impact section: "${line.slice(Math.max(0, m.index - 20), m.index + 22).trim()}"`);
  });
  if (!hits.length) return '';
  return ` The UX lint treats an apostrophe (') as a quote mark, so a quoted phrase containing one cannot match the code. Reword without the apostrophe, or quote a shorter phrase, at ${hits.slice(0, 3).join('; ')}.`;
}

/**
 * The pure verdict: the merge-time body checks plus the UX check, as warnings.
 * Returns every check row and the failing ones; never throws on odd input.
 */
export function lintDescription({ title, body, authorLogin, authorType, files, decisionRecords, uxCheck }) {
  const checks = runLocalBodyChecks({ title: title ?? '', body: body ?? '', authorLogin: authorLogin ?? '', authorType: authorType ?? 'User', files: files ?? [], decisionRecords: decisionRecords ?? [] });
  if (uxCheck) checks.push(uxCheck);
  return { checks, failing: checks.filter((c) => !c.ok) };
}

/** Which gate a failing check belongs to, so a warning never names the wrong one. */
export const SAFE_MERGE_BODY_CHECKS = Object.freeze(['eli16', 'decision-audit', 'release-fragment']);
export function consequenceOf(name) {
  return SAFE_MERGE_BODY_CHECKS.includes(name)
    ? 'safe-merge refuses this at merge time'
    : 'the UX impact gate fails on this for user-facing paths';
}

/** One GitHub warning annotation per failing check, plus a markdown summary. */
export function renderReport({ checks, failing }, { baseRef } = {}) {
  const esc = (s) => String(s ?? '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const annotations = failing.map((c) => `::warning title=Description check: ${c.name}::${esc(`${c.detail ?? 'failed'} (${consequenceOf(c.name)} until it is fixed)`)}`);
  const row = (c) => `| ${c.name} | ${c.ok ? (c.unmeasured ? 'not measured' : 'passes') : 'fails'} | ${String(c.detail ?? '').replace(/\|/g, '\\|')} |`;
  const body = checks.filter((c) => SAFE_MERGE_BODY_CHECKS.includes(c.name));
  const other = checks.filter((c) => !SAFE_MERGE_BODY_CHECKS.includes(c.name));
  const bodyFails = failing.filter((c) => SAFE_MERGE_BODY_CHECKS.includes(c.name)).length;
  const otherFails = failing.length - bodyFails;
  const summary = [
    '## Pull-request description check (early warning)',
    '',
    `A snapshot of this pull request as of this event${baseRef ? `, against base \`${baseRef}\`` : ''}. It never blocks. safe-merge re-reads the live description and GitHub's file list at merge time, so its answer can differ if the description or files change.`,
    '',
    '**The checks safe-merge runs at merge time**',
    '',
    '| Check | Result | Detail |',
    '|---|---|---|',
    ...body.map(row),
    ...(other.length ? ['', '**UX Impact (its own gate, not a safe-merge check)**', '', '| Check | Result | Detail |', '|---|---|---|', ...other.map(row)] : []),
    '',
    failing.length
      ? [bodyFails ? `**${bodyFails} check(s) would make safe-merge refuse this pull request.**` : '', otherFails ? `**The UX Impact declaration would fail its gate.**` : '', 'Fix them before asking for a test slot.'].filter(Boolean).join(' ')
      : 'All description checks pass.',
  ].join('\n');
  return { annotations, summary };
}

function git(args) { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }

function main() {
  const env = process.env;
  const base = env.BASE_SHA; const head = env.HEAD_SHA;
  try {
    if (!base || !head) throw new Error('BASE_SHA and HEAD_SHA are required');
    const files = parseNameStatusZ(git(['diff', '--name-status', '-z', '-M', `${base}...${head}`]));
    const decisionRecords = decisionRecordPaths(files).map((p) => {
      try { return JSON.parse(git(['show', `${head}:${p}`])); } catch { return {}; } // same as safe-merge: an unreadable record covers nothing
    });
    const here = path.dirname(fileURLToPath(import.meta.url));
    let ux = { status: 2, stderr: '' };
    try {
      const out = execFileSync(process.execPath, [path.join(here, 'ux-impact-lint.mjs'), '--base', base, '--head', head, '--scope', env.INSTAR_UX_SCOPE ?? '', '--pusher', env.PR_PUSHER ?? '', '--body', env.PR_BODY ?? ''], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      ux = { status: 0, stderr: '', stdout: out };
    } catch (e) { ux = { status: typeof e?.status === 'number' ? e.status : 2, stderr: String(e?.stderr ?? '') }; }
    const verdict = lintDescription({
      title: env.PR_TITLE, body: env.PR_BODY, authorLogin: env.PR_AUTHOR_LOGIN, authorType: env.PR_AUTHOR_TYPE,
      files, decisionRecords, uxCheck: (() => { const c = uxCheckFromExit(ux.status, ux.stderr); return c.ok ? c : { ...c, detail: `${c.detail}${uxApostropheHint(env.PR_BODY)}` }; })(),
    });
    const { annotations, summary } = renderReport(verdict, { baseRef: env.BASE_REF });
    for (const a of annotations) console.log(a);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    console.log(summary);
  } catch (e) {
    // Never block: an internal error is itself a warning, and the merge-time floor still decides.
    console.log(`::warning title=Description check could not run::${String(e?.message ?? e).slice(0, 300)}`);
  }
  process.exit(0);
}

const isCliEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isCliEntry) main();
