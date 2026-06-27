#!/usr/bin/env node
/**
 * release-skip-annotate (Layer 2, publish-side) — when the publish pipeline is
 * about to SKIP a release (no fragment → no version), check whether
 * release-relevant work has merged since the last published tag, and if so emit
 * a LOUD, count-capped annotation + step summary instead of a silent green run.
 *
 * Spec: docs/specs/RELEASE-FRAGMENT-GATE-SPEC.md (Layer 2, D1/D7/D11).
 *
 * It is a SIGNAL: it NEVER fails the run (always exits 0) and NEVER claims to
 * raise an Attention item (a CI runner cannot reach the agent's Attention store —
 * the durable surface is the agent-side ReleaseReadinessSentinel). Commit data is
 * read NUL-delimited via execFile argv arrays — never a shell string — and never
 * echoed raw through `::`-prefixed workflow commands beyond the bounded message.
 *
 * Boundary (D11): the authoritative window start is the most recent annotated
 * `vX.Y.Z` tag (written only by the release bot, so it is NOT PR-mutable). A
 * missing/unparseable boundary surfaces ALL reachable commits with an eval-note —
 * never a silent empty range.
 *
 * Pure `classifyRange({ files })` is exported for testing; the CLI does the git I/O.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { isReleaseRelevant } from './release-relevant-paths.mjs';

/**
 * Given a list of changed file paths in the unreleased window, return the
 * release-relevant subset.
 * @param {{ files: string[] }} input
 * @returns {{ relevant: string[] }}
 */
export function classifyRange({ files }) {
  const relevant = (files || []).filter((f) => isReleaseRelevant(f));
  return { relevant };
}

function git(args) {
  // argv array — never a shell string. NUL-delimited callers split on \0.
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Most recent annotated vX.Y.Z tag reachable from HEAD, or null. */
function lastReleaseTag() {
  try {
    const out = git(['describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0']).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Changed files in <range> as an array (NUL-delimited, opaque). */
function changedFilesInRange(range) {
  // --name-only -z gives NUL-delimited filenames; we never shell-interpolate them.
  const raw = git(['diff', '--name-only', '-z', range]);
  return raw.split('\0').map((s) => s.trim()).filter(Boolean);
}

/** Distinct commit subjects in <range> (count-capped, for the summary only). */
function commitSubjects(range, cap) {
  try {
    const raw = git(['log', '--no-merges', '--format=%s%x00', range]);
    return raw.split('\0').map((s) => s.trim()).filter(Boolean).slice(0, cap);
  } catch {
    return [];
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const SUMMARY_CAP = 20;
  const emit = (line) => process.stdout.write(line + '\n');
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  const writeSummary = (text) => {
    if (summaryFile) {
      try { fs.appendFileSync(summaryFile, text + '\n'); } catch { /* best effort */ }
    }
  };

  // NEVER throw out of here — Layer 2 is signal-only; always exit 0.
  try {
    const tag = lastReleaseTag();
    const range = tag ? `${tag}..HEAD` : null;
    let files;
    let boundaryNote = '';
    if (range) {
      files = changedFilesInRange(range);
    } else {
      // Missing boundary (e.g. first publish before any vX.Y.Z tag) — surface
      // ALL reachable commits with an eval-note, never a silent empty range.
      boundaryNote = ' (no release tag found — surfacing all reachable history)';
      files = (() => { try { return git(['ls-files']).split('\n').map((s) => s.trim()).filter(Boolean); } catch { return []; } })();
    }

    const { relevant } = classifyRange({ files });
    if (relevant.length === 0) {
      emit(`::notice::release-skip-annotate: skip is clean — no release-relevant changes since ${tag ?? '(no tag)'}.`);
      process.exit(0);
    }

    const subjects = range ? commitSubjects(range, SUMMARY_CAP) : [];
    const capped = relevant.slice(0, SUMMARY_CAP);
    const oneLine =
      `release SKIPPED but ${relevant.length} release-relevant file(s) merged since ${tag ?? 'the start'}${boundaryNote} ` +
      `with NO release-note fragment — these changes are NOT being shipped. Add upgrades/next/<slug>.md and re-publish.`;
    emit(`::warning::${oneLine}`);

    const summary =
      `## ⚠ Release skipped with unreleased release-relevant work\n\n` +
      `The publish run is about to skip (no release-note fragment), but the following ` +
      `release-relevant files merged since \`${tag ?? '(no tag)'}\`${boundaryNote} and will NOT ship until a ` +
      `fragment is added:\n\n` +
      capped.map((f) => `- \`${f}\``).join('\n') +
      (relevant.length > SUMMARY_CAP ? `\n- …and ${relevant.length - SUMMARY_CAP} more` : '') +
      (subjects.length
        ? `\n\nUnreleased commit subjects:\n\n` + subjects.map((s) => `- ${s.replace(/`/g, "'")}`).join('\n')
        : '') +
      `\n\n**Fix:** add \`upgrades/next/<slug>.md\` describing the change (via /instar-dev) and re-publish. ` +
      `The durable, ack-able signal is raised by the agent-side ReleaseReadinessSentinel; this annotation is a ` +
      `best-effort CI surface.\n`;
    writeSummary(summary);
    emit(`::notice::release-skip-annotate verdict=UNRELEASED-WORK count=${relevant.length}`);
    process.exit(0);
  } catch (e) {
    // Signal-only: an internal error must NOT fail the publish run.
    emit(`::warning::release-skip-annotate: internal error (non-fatal, release-skip detection only): ${String(e?.message ?? e)}`);
    process.exit(0);
  }
}
