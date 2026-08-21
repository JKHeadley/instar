#!/usr/bin/env node
// safe-git-allow: CI-only gate script — single read-only `git diff --name-status`
//   against the Actions checkout; runs on ubuntu runners where the TS
//   SafeGitExecutor is not importable from a standalone .mjs.
/**
 * decision-audit-presence-check — gate-bypass detector (task #81 close-out).
 *
 * Every commit that touches in-scope files (src/, scripts/, .husky/, skills/
 * code) is supposed to pass through the local instar-dev pre-commit gate,
 * which writes + stages a decision-audit record. When the gate is silently
 * absent — the live case: a worktree created with raw `git worktree add` has
 * no husky shim, so `git commit` runs ZERO hooks — the commits arrive with no
 * audit record, and nothing notices. CI re-runs the substantive checks, but
 * the audit trail has holes and gate-block UX (tier floors, deferral
 * detection) never fired for those commits.
 *
 * Structure > Willpower: this check makes the bypass VISIBLE at the PR
 * boundary. A PR whose changes include in-scope files must also carry gate
 * evidence — a per-entry decision file (post-#827: one
 * `.instar/instar-dev-decisions/<ts>-<slug>.json` added per gate run) or, as
 * transition grace for PRs authored under the pre-#827 writer, a modification
 * to the legacy `.instar/instar-dev-decisions.jsonl`.
 *
 * Exemptions mirror the eli16 PR gate: bot authors and the automated
 * release-cut PR.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Keep in sync with inScope() in scripts/instar-dev-precommit.js — the gate
// this check detects bypasses OF. (A drift here only weakens detection, never
// blocks a legitimate PR: extra in-scope prefixes would require evidence from
// PRs the local gate also covers.)
export function isInScopeFile(file) {
  if (file.startsWith('src/')) return true;
  if (file.startsWith('scripts/')) return true;
  if (file.startsWith('.husky/')) return true;
  if (file.startsWith('skills/') && file.endsWith('SKILL.md')) return true;
  if (file.startsWith('skills/') && (file.endsWith('.sh') || file.endsWith('.mjs') || file.endsWith('.js'))) return true;
  return false;
}

function isPerEntryDecisionFile(change) {
  return /^\.instar\/instar-dev-decisions\/.+\.json$/.test(change.file);
}

function isLegacyDecisionFile(change) {
  return change.file === '.instar/instar-dev-decisions.jsonl';
}

function recordScopeFiles(record) {
  const files = record?.scope?.files;
  return Array.isArray(files) ? files.filter((file) => typeof file === 'string') : [];
}

function coverageFiles(records) {
  const covered = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    for (const file of recordScopeFiles(record)) covered.add(file);
  }
  return covered;
}

function readDecisionAuditRecords(changes) {
  const records = [];
  for (const change of changes.filter(isPerEntryDecisionFile)) {
    try {
      records.push(JSON.parse(readFileSync(change.file, 'utf8')));
    } catch {
      records.push({});
    }
  }
  return records;
}

/**
 * Pure evaluation — exported for unit tests.
 * @param {{ changes: Array<{status: string, file: string}>, records?: unknown[], title?: string, authorType?: string }} input
 * @returns {{ ok: boolean, exempt?: string, reason?: string, inScopeFiles?: string[], uncoveredFiles?: string[] }}
 */
export function evaluateDecisionAuditPresence(input) {
  const title = String(input?.title ?? '');
  if (String(input?.authorType ?? '') === 'Bot') return { ok: true, exempt: 'bot-author' };
  if (/^chore:\s*release\b/i.test(title)) return { ok: true, exempt: 'release-cut' };

  const changes = Array.isArray(input?.changes) ? input.changes : [];
  const inScopeFiles = changes.map((c) => c.file).filter(isInScopeFile);
  if (inScopeFiles.length === 0) {
    return { ok: true, reason: 'no in-scope changes — local gate not required' };
  }

  if (changes.some(isLegacyDecisionFile)) {
    return { ok: true, reason: 'legacy decision-audit evidence present', inScopeFiles };
  }

  const recordChanges = changes.filter(isPerEntryDecisionFile);
  if (recordChanges.length === 0) {
    return {
      ok: false,
      inScopeFiles,
      reason:
        `This PR changes ${inScopeFiles.length} in-scope file(s) but carries NO decision-audit record — ` +
        `the local instar-dev pre-commit gate did not run for these commits. The usual cause is a build ` +
        `worktree without the husky shim (created with raw 'git worktree add' instead of 'instar worktree ` +
        `create'). Fix: in the worktree run 'npm run prepare' (wires .husky/_), then re-commit so the gate ` +
        `evaluates the change and its audit entry (.instar/instar-dev-decisions/<ts>-<slug>.json) rides the ` +
        `commit. See tasks #81/#80 and PRs #827/#829.`,
    };
  }

  const covered = coverageFiles(input?.records);
  const uncoveredFiles = inScopeFiles.filter((file) => !covered.has(file));
  if (uncoveredFiles.length === 0) {
    return { ok: true, reason: 'decision-audit scope covers in-scope changes', inScopeFiles };
  }

  return {
    ok: false,
    inScopeFiles,
    uncoveredFiles,
    reason:
      `This PR changes ${inScopeFiles.length} in-scope file(s), but its decision-audit record scope ` +
      `does not cover ${uncoveredFiles.length} in-scope file(s). Re-run the local instar-dev ` +
      `pre-commit gate for this change so the decision-audit record declares the changed path(s).`,
  };
}

/** Parse `git diff --name-status base...head` output into change records. */
export function parseNameStatus(text) {
  const changes = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    // Format: "<STATUS>\t<path>" (renames: "R100\t<old>\t<new>" — take the new path).
    const parts = t.split('\t');
    if (parts.length < 2) continue;
    const status = parts[0];
    const file = parts[parts.length - 1];
    changes.push({ status, file });
  }
  return changes;
}

// ── CLI entrypoint (CI) ────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const baseSha = process.env.BASE_SHA;
  const headSha = process.env.HEAD_SHA;
  if (!baseSha || !headSha) {
    console.error('decision-audit gate: BASE_SHA and HEAD_SHA env vars are required.');
    process.exit(2);
  }
  let diffOut;
  try {
    diffOut = execFileSync('git', ['diff', '--name-status', `${baseSha}...${headSha}`], { encoding: 'utf8' });
  } catch (err) {
    console.error(`decision-audit gate: git diff failed — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const changes = parseNameStatus(diffOut);
  const res = evaluateDecisionAuditPresence({
    changes,
    records: readDecisionAuditRecords(changes),
    title: process.env.PR_TITLE,
    authorType: process.env.PR_AUTHOR_TYPE,
  });
  if (res.ok) {
    console.log(`decision-audit gate: OK — ${res.exempt ? `exempt (${res.exempt})` : res.reason}`);
    process.exit(0);
  }
  console.error('decision-audit gate: FAIL');
  console.error(res.reason);
  console.error('');
  console.error('In-scope files lacking decision-audit coverage:');
  for (const f of res.uncoveredFiles ?? res.inScopeFiles ?? []) console.error(`  - ${f}`);
  process.exit(1);
}
