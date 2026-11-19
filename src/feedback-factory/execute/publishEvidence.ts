/**
 * Publish evidence the trusted publisher adds to a feedback fix (docs/specs/feedback-triage-and-execution.md §4 step 9).
 *
 * The publish clone commits with hooks off on purpose (HARDENED_GIT_CONFIG: code produced from
 * untrusted feedback text must never run a repository hook next to the publish credentials). So
 * the instar-dev pre-commit gate never runs there, and two checks every PR must pass came back
 * red on every executor PR:
 *
 * - `decision-audit` (a required Actions-floor context): an in-scope change needs a per-entry
 *   record under `.instar/instar-dev-decisions/`. The executor's own gates (confinement, diff
 *   gate, secret gate, its local test gate, then the independent review at the exact head) are
 *   the gate for this path, so the publisher writes the record itself and names that gate
 *   (`gate: 'feedback-executor'`). The record is honest about what ran: no tier, no trace.
 * - `release-fragment`: a release-relevant change needs `upgrades/next/<slug>.md`. safe-merge
 *   refuses any red check, so a missing fragment stopped every merge.
 *
 * Both files are built only from trusted facts: the change set's paths (record scope only), the
 * branch and attempt ids, file counts and fixed wording. Release notes are read by every agent on
 * update, so nothing the confined session controls reaches them: not its notes, not the feedback
 * text, not even file names (a name can carry words). A release note the session wrote itself is
 * dropped from the change set before publication (`withoutSessionReleaseNotes`), so the
 * publisher's note is the only one. The reviewers judge the PR head, which carries both files.
 *
 * Pure builders plus one writer; no decision authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ChangeEntry } from './changeSet.js';

/** The decision-audit record directory (scripts/instar-dev-precommit.js DECISIONS_DIR). */
export const DECISION_RECORD_DIR = '.instar/instar-dev-decisions';
/** The release-note fragment directory (scripts/check-release-fragment.mjs). */
export const FRAGMENT_DIR = 'upgrades/next';
/** The record's scope basis. Never the pre-deletion basis decision-audit-presence-check.mjs excuses. */
export const EXECUTOR_SCOPE_BASIS = 'feedback-executor-change-set-including-deleted';

/** Mirrors isInScopeFile() in scripts/decision-audit-presence-check.mjs (the check this record answers). */
export function isDecisionAuditInScope(file: string): boolean {
  if (file.startsWith('src/') || file.startsWith('scripts/') || file.startsWith('.husky/')) return true;
  if (file.startsWith('skills/') && (file.endsWith('SKILL.md') || file.endsWith('.sh') || file.endsWith('.mjs') || file.endsWith('.js'))) return true;
  return false;
}

/**
 * True when the path ships runtime behavior and so needs a release note. Deliberately wider than
 * scripts/release-relevant-paths.mjs: everything outside tests, docs and upgrades counts. A note
 * that was not strictly needed costs one patch-release line; a missing one blocks the merge.
 */
export function needsReleaseNote(file: string): boolean {
  const p = file.toLowerCase();
  if (/\.test\.[cm]?[jt]sx?$/.test(p)) return false;
  return !(p.startsWith('tests/') || p.startsWith('docs/') || p.startsWith('upgrades/') || p.startsWith('.instar/'));
}

/** A release-note path: a fragment, the assembled NEXT.md, or anything else under upgrades/next/. */
export function isReleaseNotePath(file: string): boolean {
  const p = file.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').toLowerCase();
  return p === 'upgrades/next.md' || p === 'upgrades/next' || p.startsWith('upgrades/next/');
}

/**
 * Drop release-note entries the confined session wrote: release notes are the publisher's to
 * write (see the header). Returns the kept entries and the dropped paths (for the audit row).
 */
export function withoutSessionReleaseNotes(entries: ChangeEntry[]): { entries: ChangeEntry[]; dropped: string[] } {
  const dropped = entries.filter((e) => isReleaseNotePath(e.path)).map((e) => e.path);
  return { entries: entries.filter((e) => !isReleaseNotePath(e.path)), dropped };
}

/** The branch without its `feedback/` prefix: the per-attempt file slug. */
export function fileSlug(branch: string): string {
  const s = branch.replace(/^feedback\//, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'feedback-fix';
}

export interface PublishEvidenceInput {
  entries: ChangeEntry[];
  branch: string;
  attemptId: string;
  initiativeId: string;
  kind: 'fix' | 'spec';
  /** Clock for the record's timestamp and filename. */
  at: Date;
}

export interface EvidenceFile { relPath: string; content: string }

/** The decision-audit record, or null when the change set has no in-scope path. */
export function executorDecisionRecord(input: PublishEvidenceInput): EvidenceFile | null {
  const scopeFiles = input.entries.map((e) => e.path).filter(isDecisionAuditInScope).sort();
  if (scopeFiles.length === 0) return null;
  const ts = input.at.toISOString();
  const slug = fileSlug(input.branch);
  const record = {
    ts,
    slug,
    gate: 'feedback-executor',
    attemptId: input.attemptId,
    initiativeId: input.initiativeId,
    kind: input.kind,
    // The instar-dev tier machinery did not run; say so rather than invent a tier.
    suggestedTier: null,
    declaredTier: null,
    files: scopeFiles.length,
    scope: { basis: EXECUTOR_SCOPE_BASIS, files: scopeFiles },
    causalAutopsy: null,
    classClosure: null,
    // Written by the publisher after its local gates passed; merge still needs the independent review at the head.
    verdict: 'pass',
  };
  return { relPath: `${DECISION_RECORD_DIR}/${ts.replace(/[:.]/g, '-')}-${slug}.json`, content: JSON.stringify(record, null, 2) + '\n' };
}

/** The release-note fragment, or null when nothing in the change set needs a note. */
export function executorReleaseFragment(input: PublishEvidenceInput): EvidenceFile | null {
  const paths = input.entries.map((e) => e.path).filter((p) => !isReleaseNotePath(p));
  const relevant = paths.filter(needsReleaseNote);
  if (relevant.length === 0) return null;
  const tests = paths.filter((p) => p.startsWith('tests/')).length;
  const content = [
    '<!-- bump: patch -->',
    '## What Changed',
    '',
    `A fix for a problem reported through Instar's feedback channel, written by the feedback executor and merged only after it passed the independent review at its exact head. Feedback item: ${input.initiativeId.replace(/[^\w-]/g, '').slice(0, 80)}. It changes ${relevant.length} shipped file(s) and ${tests} test file(s); the pull request lists them.`,
    '',
    '## What to Tell Your User',
    '',
    'A problem another Instar agent reported has been fixed. Nothing changes in how you use me; tell me if you still see it.',
    '',
    '## Summary of New Capabilities',
    '',
    'None. This is a bug fix.',
    '',
    '## Evidence',
    '',
    'The executor reproduced the problem with a test that failed before the fix and passes after it, in its confined workspace, then ran its test gate; the independent reviewers then read the change at its exact head.',
    '',
  ].join('\n');
  return { relPath: `${FRAGMENT_DIR}/${fileSlug(input.branch)}.md`, content };
}

/** Write both files into the publish clone (they ride the one commit). Returns the paths written. */
export function writePublishEvidence(publishClone: string, input: PublishEvidenceInput): string[] {
  const written: string[] = [];
  for (const file of [executorDecisionRecord(input), executorReleaseFragment(input)]) {
    if (!file) continue;
    const full = path.join(publishClone, file.relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // 'wx': never overwrite a file the change set or the base already holds.
    fs.writeFileSync(full, file.content, { flag: 'wx' });
    written.push(file.relPath);
  }
  return written;
}

/**
 * The publisher's own evidence paths for this branch, exactly as executorDecisionRecord and
 * executorReleaseFragment name them. The confined session cannot write either (`.instar/` is held
 * by the diff gate; release notes it wrote are dropped before publication), so a file at one of
 * these paths in the PR was written by the publisher.
 */
export function isPublisherEvidencePath(file: string, branch: string): boolean {
  const slug = fileSlug(branch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${DECISION_RECORD_DIR.replace(/\./g, '\\.')}/\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z-${slug}\\.json$`).test(file)
    || file === `${FRAGMENT_DIR}/${fileSlug(branch)}.md`;
}

/** What the reviewer filter needs to rebuild the publisher's files for one attempt. */
export interface EvidenceOwner { branch: string; attemptId: string; initiativeId: string; kind: 'fix' | 'spec' }

/**
 * The exact bytes the publisher wrote at `file` for this attempt, rebuilt from the PR's other
 * paths and the attempt's ids (the record's timestamp comes from its own file name); null when
 * `file` is not one of this branch's evidence paths.
 */
export function expectedPublisherEvidence(file: string, prFiles: string[], owner: EvidenceOwner): string | null {
  if (!isPublisherEvidencePath(file, owner.branch)) return null;
  const entries: ChangeEntry[] = prFiles.filter((f) => !isPublisherEvidencePath(f, owner.branch)).map((p) => ({ path: p, kind: 'modified' }));
  const base = { entries, branch: owner.branch, attemptId: owner.attemptId, initiativeId: owner.initiativeId, kind: owner.kind };
  if (file.startsWith(`${FRAGMENT_DIR}/`)) {
    const frag = executorReleaseFragment({ ...base, at: new Date(0) });
    return frag && frag.relPath === file ? frag.content : null;
  }
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[^/]+\.json$/.exec(file);
  if (!m) return null;
  const at = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  if (Number.isNaN(at.getTime())) return null;
  const rec = executorDecisionRecord({ ...base, at });
  return rec && rec.relPath === file ? rec.content : null;
}

/** The full text of a diff section that ADDS a new file, or null for any other kind of section. */
export function addedFileText(section: string): string | null {
  const lines = section.split('\n');
  if (!lines.includes('new file mode 100644') || !lines.includes('--- /dev/null')) return null;
  const start = lines.findIndex((l) => l.startsWith('@@ '));
  if (start < 0) return null;
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l === '') continue;
    if (l.startsWith('\\ ')) return null; // "\ No newline at end of file": the publisher always ends with one
    if (!l.startsWith('+')) return null;
    body.push(l.slice(1));
  }
  return body.join('\n') + '\n';
}

/**
 * The review sees the change the session made, not the publisher's evidence: a decision record
 * under `.instar/` reads as a tooling edit to a reviewer (rule 2), and both files are trusted,
 * fixed-shape output. Drops those paths from the file list and their sections from the diff.
 */
export function withoutPublisherEvidence(files: string[], diff: string, owner: EvidenceOwner): { files: string[]; diff: string; omitted: string[] } {
  if (!files.some((f) => isPublisherEvidencePath(f, owner.branch))) return { files, diff, omitted: [] };
  const sections = diff.split(/(?=^diff --git )/m);
  const omitted: string[] = [];
  const kept = sections.filter((sec) => {
    const m = /^diff --git a\/(\S+) b\/(\S+)\n/.exec(sec);
    if (!m || m[1] !== m[2]) return true;
    const expected = expectedPublisherEvidence(m[2], files, owner);
    // Hidden only when it is byte for byte what the publisher wrote; anything else stays in view.
    if (expected === null || addedFileText(sec) !== expected) return true;
    omitted.push(m[2]);
    return false;
  });
  return { files: files.filter((f) => !omitted.includes(f)), diff: kept.join(''), omitted };
}
