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
 * Trust: this runs from a `workflow_run` workflow, which GitHub always loads from
 * the DEFAULT branch, so neither the workflow nor this script can be changed by
 * the pull request it judges, whatever its base. The pull request's title, body,
 * files and decision records are read LIVE from the REST API (as safe-merge does)
 * and treated only as data. The run is bound to its event: only pull requests whose head is the run's head
 * sha in this repository are judged, and nothing is posted if the head, base, title or body changed while
 * checking. The result is an always-success commit status `description-early-warning (#N)` per pull
 * request on that head, which is never required.
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
      ? [bodyFails ? `**${bodyFails} check(s): this pull request would be refused if merged as it stands now.**` : '', otherFails ? `**The UX Impact declaration would fail its gate.**` : '', 'Fix them before asking for a test slot.'].filter(Boolean).join(' ')
      : 'All description checks pass.',
  ].join('\n');
  return { annotations, summary };
}

function git(args) { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }

/**
 * The pull requests a workflow_run event is about, bound to that event: only entries whose head sha is
 * the run's own head sha and whose base repository is this repository. Anything else is dropped.
 */
export function prRefsFromRun(json, { runHeadSha, repo } = {}) {
  try {
    const list = JSON.parse(String(json ?? '[]'));
    if (!Array.isArray(list)) return [];
    const seen = new Set(); const out = [];
    for (const p of list) {
      const number = Number(p?.number); const headSha = String(p?.head?.sha ?? '');
      const baseRepo = String(p?.base?.repo?.name ?? ''); const baseUrl = String(p?.base?.repo?.url ?? '');
      if (!Number.isSafeInteger(number) || number <= 0 || seen.has(number)) continue;
      if (!runHeadSha || headSha !== runHeadSha) continue;
      // The base repository URL decides when present; the bare name is only a fallback when GitHub omits the URL.
      if (repo && !(baseUrl ? baseUrl.endsWith(`/repos/${repo}`) : (baseRepo && repo.endsWith(`/${baseRepo}`)))) continue;
      seen.add(number); out.push({ number, headSha });
    }
    return out;
  } catch { return []; }
}

/** Back-compatible: just the bound numbers. */
export function prNumbersFromRun(json, opts) { return prRefsFromRun(json, opts).map((r) => r.number); }

/** The commit-status payload: always `success` (never a gate), describing what would be refused now. */
export function statusFor({ failing }, targetUrl, pr) {
  const bodyFails = failing.filter((c) => SAFE_MERGE_BODY_CHECKS.includes(c.name)).map((c) => c.name);
  const ux = failing.some((c) => !SAFE_MERGE_BODY_CHECKS.includes(c.name));
  const parts = [];
  if (bodyFails.length) parts.push(`would be refused if merged as it stands now (${bodyFails.join(', ')})`);
  if (ux) parts.push('UX Impact would fail its gate');
  const description = (parts.length ? `Advisory: ${parts.join('; ')}` : 'Advisory: description checks pass').slice(0, 140);
  return { state: 'success', context: pr ? `description-early-warning (#${pr})` : 'description-early-warning', description, ...(targetUrl ? { target_url: targetUrl } : {}) };
}

async function api(path, { token, method = 'GET', body, raw = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
  return raw ? res.text() : res.json();
}

async function lintOne({ repo, pr, runHeadSha, token, runUrl, summaryPath }) {
  // Everything about the pull request is read live and treated as DATA: never executed, never put in a shell line.
  const live = await api(`/repos/${repo}/pulls/${pr}`, { token });
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const rows = await api(`/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`, { token });
    files.push(...rows.map((f) => ({ filename: String(f?.filename ?? ''), status: String(f?.status ?? '') })));
    if (rows.length < 100) break;
  }
  const head = String(live.head?.sha ?? ''); const base = String(live.base?.sha ?? '');
  if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(base)) throw new Error('unreadable head or base sha');
  // Bound to the triggering event: judge only the revision this run was started for.
  if (head !== runHeadSha) { console.log(`#${pr}: head moved from ${runHeadSha} to ${head}; the newer run reports, nothing posted.`); return; }
  const decisionRecords = [];
  for (const p of decisionRecordPaths(files)) {
    const encoded = p.split('/').map(encodeURIComponent).join('/');
    try { decisionRecords.push(JSON.parse(await api(`/repos/${repo}/contents/${encoded}?ref=${head}`, { token, raw: true }))); } catch { decisionRecords.push({}); } // same as safe-merge: an unreadable record covers nothing
  }
  // The UX lint reads a git diff; the objects are fetched as data (public repository, no credentials).
  let ux = { status: 2, stderr: '' };
  try {
    execFileSync('git', ['fetch', '--no-tags', '--quiet', 'origin', base, head], { stdio: 'ignore' });
    const here = path.dirname(fileURLToPath(import.meta.url));
    execFileSync(process.execPath, [path.join(here, 'ux-impact-lint.mjs'), '--base', base, '--head', head, '--scope', process.env.INSTAR_UX_SCOPE ?? '', '--pusher', String(live.user?.login ?? ''), '--body', String(live.body ?? '')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    ux = { status: 0, stderr: '' };
  } catch (e) { ux = { status: typeof e?.status === 'number' ? e.status : 2, stderr: String(e?.stderr ?? '') }; }
  const uxRow = uxCheckFromExit(ux.status, ux.stderr);
  const verdict = lintDescription({
    title: live.title, body: live.body, authorLogin: live.user?.login, authorType: live.user?.type,
    files, decisionRecords, uxCheck: uxRow.ok ? uxRow : { ...uxRow, detail: `${uxRow.detail}${uxApostropheHint(live.body)}` },
  });
  const { annotations, summary } = renderReport(verdict, { baseRef: live.base?.ref });
  for (const a of annotations) console.log(a);
  // The summary goes only to the job summary: it is never echoed to the log, where a line beginning `::`
  // could be read as a workflow command. Annotations above are escaped one line each.
  if (summaryPath) fs.appendFileSync(summaryPath, `### Pull request #${pr}\n\n${summary}\n\n`);
  else console.log(summary.replace(/^::/gm, ': :'));
  // Recheck after the reads: if the pull request moved meanwhile, this verdict may not describe its head.
  const again = await api(`/repos/${repo}/pulls/${pr}`, { token });
  if (String(again.head?.sha ?? '') !== runHeadSha || String(again.base?.sha ?? '') !== base || String(again.body ?? '') !== String(live.body ?? '') || String(again.title ?? '') !== String(live.title ?? '')) {
    console.log(`#${pr}: changed while being checked; the newer run reports, nothing posted.`); return;
  }
  const status = statusFor(verdict, runUrl, pr);
  if (process.env.LINT_DRY_RUN === '1') { console.log(`dry run: would post ${JSON.stringify(status)} to ${head}`); return; }
  await api(`/repos/${repo}/statuses/${head}`, { token, method: 'POST', body: status });
}

async function main() {
  const env = process.env;
  try {
    const repo = env.GITHUB_REPOSITORY; const token = env.GH_TOKEN;
    if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required');
    const runHeadSha = String(env.RUN_HEAD_SHA ?? '');
    if (!/^[0-9a-f]{40}$/.test(runHeadSha)) throw new Error('RUN_HEAD_SHA is required');
    const prs = prRefsFromRun(env.RUN_PULL_REQUESTS, { runHeadSha, repo });
    if (!prs.length) { console.log('No same-repository pull request bound to this run; nothing to check.'); return; }
    const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
    for (const { number: pr } of prs.slice(0, 5)) {
      try { await lintOne({ repo, pr, runHeadSha, token, runUrl, summaryPath: env.GITHUB_STEP_SUMMARY }); }
      catch (e) { console.log(`::warning title=Description check could not run for #${pr}::${String(e?.message ?? e).slice(0, 300)}`); }
    }
  } catch (e) {
    // Never block: an internal error is itself a warning, and the merge-time floor still decides.
    console.log(`::warning title=Description check could not run::${String(e?.message ?? e).slice(0, 300)}`);
  }
}

const isCliEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isCliEntry) main().finally(() => process.exit(0));
