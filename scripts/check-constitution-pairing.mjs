#!/usr/bin/env node
/**
 * Rule 119 — One Constitution, Two Books Aligned (docs/specs/constitution-alignment.md).
 *
 * Every change to either book names its counterpart in the other, or says why
 * it has none. This reads existence only: is there a line, does it name a real
 * PR in the other repository, does that PR touch a book. Whether two wordings
 * carry the same obligation, and whether a stated "none" is honest, belongs to
 * the independent review of the change — nothing here can see that.
 *
 *   node scripts/check-constitution-pairing.mjs pr --repo <owner/name> --number <N>
 *   node scripts/check-constitution-pairing.mjs daily [--since-instar <sha>] [--since-instar-2 <sha>]
 *
 * Exit: 0 clean (`pr` passes / `daily` found nothing to do), 1 refused or drift,
 * 2 unknown. A read that failed is never reported as clean.
 *
 * Single file, Node built-ins only: the daily job runs this file out of
 * `git show origin/main:...` in a temp directory, so it may import nothing relative.
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const INSTAR = 'JKHeadley/instar';
export const INSTAR_2 = 'JKHeadley/instar-2';

/** Exact paths and directory prefixes (ending in `/`) of each repository's book. */
export const BOOKS = {
  [INSTAR]: ['docs/STANDARDS-REGISTRY.md'],
  [INSTAR_2]: ['docs/00-the-purpose.md', 'docs/01-the-rules.md', 'docs/rules/'],
};

/** Each `main` as this rule was written; everything after it is audited, this landing included. */
export const BASELINES = {
  [INSTAR]: '638152bb410280e1a3e9f568b7e20bac08ad3224',
  [INSTAR_2]: '2f46478df4fd512e74d612ac494dc88441aa3bd6',
};

/** Two repositories can't merge atomically; a pair may sit half-landed this long. */
export const WINDOW_MS = 48 * 60 * 60 * 1000;

export const OTHER_REPO = { [INSTAR]: INSTAR_2, [INSTAR_2]: INSTAR };

export function touchesBook(repo, files) {
  const book = BOOKS[repo] ?? [];
  return files.some((f) => book.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
}

const LINE_RE = /^[ \t]*Constitution counterpart:[ \t]*(.*?)[ \t]*$/gim;

/** `{ kind: 'missing' | 'malformed' | 'none' | 'pair' }`; more than one line is malformed. */
export function parseDeclaration(body) {
  const lines = [...String(body ?? '').replace(/\r/g, '').matchAll(LINE_RE)].map((m) => m[1]);
  if (lines.length === 0) return { kind: 'missing' };
  if (lines.length > 1) return { kind: 'malformed', detail: 'more than one counterpart line' };
  const value = lines[0];
  const none = value.match(/^none:\s*(.*)$/i);
  if (none) {
    return none[1].trim()
      ? { kind: 'none', reason: none[1].trim() }
      : { kind: 'malformed', detail: 'none: has no reason' };
  }
  const pair = value.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (pair) return { kind: 'pair', repo: pair[1], number: Number(pair[2]) };
  return { kind: 'malformed', detail: `unreadable counterpart "${value}"` };
}

/**
 * Pure. `counterpart` is `{ state, baseRefName, files }` as read from GitHub.
 * Returns the reason it fails, or null when the pair is structurally real.
 */
export function pairProblem(repo, declaration, counterpart) {
  if (declaration.repo !== OTHER_REPO[repo]) return `names ${declaration.repo}, not ${OTHER_REPO[repo]}`;
  if (counterpart.baseRefName !== 'main') return `counterpart targets ${counterpart.baseRefName}, not main`;
  const state = String(counterpart.state).toUpperCase();
  if (state !== 'OPEN' && state !== 'MERGED') return `counterpart is ${state.toLowerCase()}`;
  if (!touchesBook(declaration.repo, counterpart.files)) return 'counterpart touches no book';
  return null;
}

/** The PR-time check. `read` throwing is `unknown`, never a pass. */
export function checkPr(repo, body, read) {
  const declaration = parseDeclaration(body);
  if (declaration.kind === 'none') return { result: 'pass', declaration };
  if (declaration.kind !== 'pair') {
    return {
      result: 'refuse',
      detail: declaration.kind === 'missing' ? 'no "Constitution counterpart:" line' : declaration.detail,
    };
  }
  if (declaration.repo !== OTHER_REPO[repo]) {
    return { result: 'refuse', detail: pairProblem(repo, declaration, {}) };
  }
  let counterpart;
  try {
    counterpart = read(declaration.repo, declaration.number);
  } catch (e) {
    return { result: 'unknown', detail: `could not read ${declaration.repo}#${declaration.number}: ${e.message}` };
  }
  const problem = pairProblem(repo, declaration, counterpart);
  return problem ? { result: 'refuse', detail: problem } : { result: 'pass', declaration };
}

/**
 * Pure. Classifies one merged PR for the daily run.
 * `counterpart` is null only when the line needed no read.
 */
export function classifyMerged({ repo, body, mergedAt, counterpart, now }) {
  const declaration = parseDeclaration(body);
  if (declaration.kind === 'none') return { class: 'declared-none', reason: declaration.reason };
  if (declaration.kind !== 'pair') return { class: 'drift', detail: declaration.detail ?? 'no counterpart line' };
  const problem = pairProblem(repo, declaration, counterpart ?? {});
  if (problem) return { class: 'drift', detail: problem };
  if (String(counterpart.state).toUpperCase() === 'MERGED') return { class: 'paired' };
  const overdue = now - new Date(mergedAt).getTime() > WINDOW_MS;
  return { class: overdue ? 'overdue' : 'waiting', counterpart: `${declaration.repo}#${declaration.number}` };
}

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(r.error.message);
  if (r.status !== 0) throw new Error((r.stderr || `gh exited ${r.status}`).trim().slice(0, 300));
  return r.stdout;
}

/** `gh api --paginate --slurp` concatenates pages exhaustively, or fails. */
function ghPages(path) {
  return JSON.parse(gh(['api', '--paginate', '--slurp', path])).flat();
}

export function readPr(repo, number, { ghPagesFn = ghPages, ghFn = gh } = {}) {
  const pr = JSON.parse(ghFn(['api', `repos/${repo}/pulls/${number}`]));
  return {
    number,
    state: pr.merged_at ? 'MERGED' : String(pr.state).toUpperCase(),
    baseRefName: pr.base?.ref,
    body: pr.body ?? '',
    mergedAt: pr.merged_at,
    files: ghPagesFn(`repos/${repo}/pulls/${number}/files?per_page=100`).map((f) => f.filename),
  };
}

/** A named PR that doesn't exist is one row of drift, not a run that can't finish. */
function readCounterpart(declaration, deps) {
  try {
    return readPr(declaration.repo, declaration.number, deps);
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return { state: 'NONEXISTENT', baseRefName: 'main', files: [] };
    throw e;
  }
}

/** The daily read. Any failed read marks the whole run incomplete. */
export function runDaily({ since = BASELINES, now = Date.now(), ghPagesFn = ghPages, ghFn = gh } = {}) {
  const rows = [];
  const noPr = [];
  for (const repo of [INSTAR, INSTAR_2]) {
    const baseDate = JSON.parse(ghFn(['api', `repos/${repo}/commits/${since[repo]}`])).commit.committer.date;
    const shas = new Set();
    for (const path of BOOKS[repo]) {
      const q = `repos/${repo}/commits?sha=main&per_page=100&since=${encodeURIComponent(baseDate)}&path=${encodeURIComponent(path.replace(/\/$/, ''))}`;
      for (const c of ghPagesFn(q)) if (c.sha !== since[repo]) shas.add(c.sha);
    }
    const prs = new Set();
    for (const sha of shas) {
      const merged = JSON.parse(ghFn(['api', `repos/${repo}/commits/${sha}/pulls`])).filter((p) => p.merged_at);
      if (merged.length === 0) noPr.push({ repo, sha });
      else prs.add(merged[0].number);
    }
    for (const number of prs) {
      const pr = readPr(repo, number, { ghPagesFn, ghFn });
      const declaration = parseDeclaration(pr.body);
      const counterpart = declaration.kind === 'pair' && declaration.repo === OTHER_REPO[repo]
        ? readCounterpart(declaration, { ghPagesFn, ghFn })
        : null;
      rows.push({ repo, pr: number, ...classifyMerged({ repo, body: pr.body, mergedAt: pr.mergedAt, counterpart, now }) });
    }
  }
  return { rows, noPr };
}

export function summarize({ rows, noPr }) {
  const counts = { paired: 0, 'declared-none': 0, waiting: 0, overdue: 0, drift: 0, 'no-pr': noPr.length };
  for (const r of rows) counts[r.class] += 1;
  return counts;
}

/**
 * safe-merge's seam: null when the PR may proceed, else its refusal. A repository
 * without a book is a no-op, and a failed read refuses rather than passes.
 */
export function pairingRefusal(repo, number, read = readPr) {
  if (!OTHER_REPO[repo]) return null;
  let pr;
  try {
    pr = read(repo, number);
  } catch (e) {
    // Not known to be a constitution change at all, so nothing to tell the author to add.
    return {
      result: 'refused:constitution-counterpart',
      state: 'unread',
      detail: e.message,
      message: `safe-merge: REFUSING — could not read this PR's file list to see whether it changes the constitution: ${e.message}. Retry; nothing about the PR needs changing.`,
    };
  }
  if (!touchesBook(repo, pr.files)) return null;
  const outcome = checkPr(repo, pr.body, read);
  if (outcome.result === 'pass') return null;
  return {
    result: 'refused:constitution-counterpart',
    state: outcome.result,
    detail: outcome.detail,
    message: `safe-merge: REFUSING — this PR changes the constitution and its counterpart is unsettled: ${outcome.detail}. ` +
      `Add one line to the PR body: "Constitution counterpart: <owner/repo>#<N>" naming the matching PR in the other repository, ` +
      `or "Constitution counterpart: none: <why>". Editing the body dismisses no approval. (Rule 119)`,
  };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const [mode] = argv;
  if (mode === 'pr') {
    const repo = arg(argv, '--repo');
    const number = Number(arg(argv, '--number'));
    if (!OTHER_REPO[repo] || !number) {
      console.error('usage: check-constitution-pairing.mjs pr --repo <owner/name> --number <N>');
      return 2;
    }
    let pr;
    try {
      pr = readPr(repo, number);
    } catch (e) {
      console.log(JSON.stringify({ result: 'unknown', detail: e.message }));
      return 2;
    }
    if (!touchesBook(repo, pr.files)) {
      console.log(JSON.stringify({ result: 'pass', detail: 'touches no book' }));
      return 0;
    }
    const outcome = checkPr(repo, pr.body, (r, n) => readPr(r, n));
    console.log(JSON.stringify(outcome));
    return outcome.result === 'pass' ? 0 : outcome.result === 'unknown' ? 2 : 1;
  }
  if (mode === 'daily') {
    const since = {
      [INSTAR]: arg(argv, '--since-instar') ?? BASELINES[INSTAR],
      [INSTAR_2]: arg(argv, '--since-instar-2') ?? BASELINES[INSTAR_2],
    };
    let report;
    try {
      report = runDaily({ since });
    } catch (e) {
      console.log(`constitution-pairing unknown: ${e.message}`);
      return 2;
    }
    const counts = summarize(report);
    const attention = report.rows.filter((r) => r.class === 'drift' || r.class === 'overdue');
    console.log(`constitution-pairing ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    for (const r of attention) console.log(JSON.stringify(r));
    for (const c of report.noPr) console.log(JSON.stringify({ class: 'no-pr', ...c }));
    return counts.drift > 0 || counts.overdue > 0 || counts['no-pr'] > 0 ? 1 : 0;
  }
  console.error('usage: check-constitution-pairing.mjs pr|daily ...');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
