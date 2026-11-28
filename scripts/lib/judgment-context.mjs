// safe-git-allow: judgment-block reads only — hash-object --stdin (no -w, writes nothing), rev-parse, diff --cached.
// Governed by: Observable Intelligence — No Autonomous LLM Action Is Unauditable (its Decision Provenance & Outcome Review subsection).
/**
 * judgment-context.mjs — builds the `judgment` block (version 1) that the
 * instar-dev pre-commit gate writes into each decision record
 * (docs/specs/judgment-call-rating.md → "Change 1: the record keeps the call's
 * context").
 *
 * The block is a RECORD of the call, never a reason to refuse it: callers use
 * buildJudgmentBlockSafe(), which turns any failure into `{ version, error }`.
 * It reads only what the hook already reads, plus git reads of the index and
 * HEAD through the injected `io` (no network). All logic below is pure given
 * `io`, so tests pass a fake.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scanForSecrets } from '../audit-secret-patterns.mjs';

export const JUDGMENT_VERSION = 1;
/** Four times the longest tier reasoning among the 2,972 tracked traces (994). */
export const TIER_REASONING_MAX = 4000;
export const SIDE_EFFECTS_TEMPLATE = 'skills/instar-dev/templates/side-effects-artifact.md';

/** Conditional template headings: recorded when present, never `missing`. */
const CONDITIONAL = new Set(['6b', '6c', 'second-pass review']);

/**
 * The tier reasoning as stored: the secret scan runs on the WHOLE text first
 * (a match stores only the pattern name), then the text is bounded.
 */
export function boundTierReasoning(text) {
  if (typeof text !== 'string' || text.trim() === '') return { tierReasoning: 'missing' };
  const hits = scanForSecrets(text);
  if (hits.length) return { tierReasoning: { redacted: hits[0].name } };
  if (text.length <= TIER_REASONING_MAX) return { tierReasoning: text };
  return { tierReasoning: text.slice(0, TIER_REASONING_MAX), tierReasoningTruncated: text.length };
}

const isTrue = (v) => v === true || v === 'true';

/** The author's self-attested second-pass state, mapped from the forms real traces use. */
export function secondPassStatus(trace) {
  const sp = trace && typeof trace === 'object' ? trace.secondPass : undefined;
  if (sp === 'not-required') return 'not-required';
  if (sp === true || sp === 'true' || sp === 'required') {
    return isTrue(trace.reviewerConcurred) ? 'required-concurred' : 'required-not-concurred';
  }
  if (sp === false || sp === 'false') return 'not-done';
  return 'unknown';
}

/**
 * Matching key for a `## ` heading: a leading number with an optional letter
 * (`4b.`) and any parenthesized suffix are removed, case ignored. The number
 * is returned apart (it decides required vs conditional in the template) but
 * never used for matching: `## Over-block` matches `## 1. Over-block`.
 */
export function headingKey(raw) {
  const text = String(raw).replace(/^#+\s*/, '').trim();
  const m = /^(\d+[a-z]?)\.\s*(.*)$/i.exec(text);
  const num = m ? m[1].toLowerCase() : null;
  const title = (m ? m[2] : text).replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
  return { num, title, key: title };
}

/** `## ` sections of a markdown text: [{ key, label, body }] in order. */
function sections(text) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  let cur = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && !line.startsWith('###')) {
      if (cur) out.push(cur);
      const k = headingKey(m[1]);
      cur = { key: k.key, num: k.num, title: k.title, label: m[1].replace(/\s*\([^)]*\)\s*$/, '').trim(), bodyLines: [] };
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ key: s.key, num: s.num, title: s.title, label: s.label, body: s.bodyLines.join('\n').trim() }));
}

/**
 * Required and conditional headings of THIS template: the plain-numbered
 * questions (1–8) and any lettered judgment-point question (4b) are required;
 * 6b, 6c and Second-pass review are conditional; everything else is unscored.
 */
export function templateHeadings(templateText) {
  const required = [];
  const conditional = [];
  for (const s of sections(templateText)) {
    if (s.num === '6b' || s.num === '6c' || CONDITIONAL.has(s.title)) conditional.push(s);
    else if (s.num && (/^\d+$/.test(s.num) || s.num === '4b')) required.push(s);
  }
  return { required, conditional };
}

/** For each required heading `{ present, chars }` or `"missing"`; conditional ones only when present. */
export function artifactHeadings(artifactText, templateText) {
  const { required, conditional } = templateHeadings(templateText);
  const found = new Map();
  for (const s of sections(artifactText)) if (!found.has(s.key)) found.set(s.key, s);
  const lookup = (t) => found.get(t.key);
  const out = {};
  for (const t of required) {
    const hit = lookup(t);
    out[t.label] = hit ? { present: true, chars: hit.body.length } : 'missing';
  }
  for (const t of conditional) {
    const hit = lookup(t);
    if (hit) out[t.label] = { present: true, chars: hit.body.length };
  }
  return out;
}

/**
 * The spec's convergence report path: its frontmatter `review-report:` when
 * declared, else the path the gate itself derives from the frontmatter `slug:`
 * (docs/specs/reports/<slug>-convergence.md, as StageTransitionValidator does).
 */
export function specReportPath(specText) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(String(specText ?? ''));
  if (!fm) return null;
  const m = /^review-report:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(fm[1]);
  if (m) return m[1].trim();
  const slug = /^\s*slug\s*:\s*["']?([a-z0-9][a-z0-9-]{0,63})["']?\s*$/m.exec(fm[1]);
  return slug ? `docs/specs/reports/${slug[1]}-convergence.md` : null;
}

/**
 * Build the block. `trace` and `traceBuffer` are the exact parsed trace and the
 * bytes the hook parsed (freshestTrace); `validated` is Step 5's accepted trace
 * ({ path, buffer }) on the Tier 2+ path, or null on Tier 1. `lines` is
 * [{ path, added, deleted }] for the record's in-scope files.
 */
export function buildJudgmentBlock({ trace, tracePath, traceBuffer, validated = null, tier, lines = [], artifactBuffer = null, io }) {
  const block = { version: JUDGMENT_VERSION };
  Object.assign(block, boundTierReasoning(trace?.tierReasoning));
  block.trace = { path: tracePath, hash: io.hashObject(traceBuffer, tracePath), staged: io.isStaged(tracePath) };
  if (validated) {
    const differs = validated.path !== tracePath;
    block.traceDiffers = differs;
    if (differs) block.validatedTrace = { path: validated.path, hash: io.hashObject(validated.buffer, validated.path) };
  } else {
    block.traceDiffers = false;
  }
  const artifactPath = tier === 1 ? trace?.sideEffectsPath : trace?.artifactPath;
  let artifactText = null;
  if (typeof artifactPath === 'string' && artifactPath) {
    const buf = artifactBuffer ?? io.readFile(artifactPath);
    artifactText = buf == null ? null : String(buf);
    block.artifact = {
      path: artifactPath,
      hash: buf == null ? null : io.hashObject(buf, artifactPath),
      stagedHash: io.stagedOid(artifactPath),
    };
  } else {
    block.artifact = null;
  }
  // No spec on Tier 1, even when the trace names one (the spec's field list).
  const specPath = tier !== 1 && typeof trace?.specPath === 'string' && trace.specPath ? trace.specPath : null;
  if (specPath) {
    const buf = io.readFile(specPath);
    const staged = io.isStaged(specPath);
    const reportPath = specReportPath(buf);
    const reportOid = reportPath ? io.stagedOid(reportPath) : null;
    block.spec = {
      path: specPath,
      hash: buf == null ? null : io.hashObject(buf, specPath),
      stagedHash: staged ? io.stagedOid(specPath) : (io.headOid(specPath) ?? null),
      staged,
      convergenceReport: reportOid ? { path: reportPath, stagedHash: reportOid } : null,
    };
  } else {
    block.spec = null;
  }
  const templateBuf = io.readFile(SIDE_EFFECTS_TEMPLATE);
  block.template = templateBuf == null ? null : io.hashObject(templateBuf, SIDE_EFFECTS_TEMPLATE);
  block.headings = templateBuf == null || artifactText == null ? null : artifactHeadings(artifactText, String(templateBuf));
  block.secondPassStatus = secondPassStatus(trace);
  block.perFileLines = lines.map((l) => ({
    path: l.path,
    added: l.added,
    deleted: l.deleted,
    baseBlob: io.headOid(l.path),
    stagedBlob: io.stagedOid(l.path),
  }));
  return block;
}

/** Never throws: a failure becomes `{ version, error }` and the commit proceeds. */
export function buildJudgmentBlockSafe(args) {
  try {
    return buildJudgmentBlock(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { version: JUDGMENT_VERSION, error: msg.slice(0, 500) };
  }
}

/** HEAD's sha, or null (an unborn branch). */
export function headCommitOf(io) {
  try { return io.headCommit(); } catch { return null; }
}

/** The real io: git reads of the index and HEAD in `root`. */
export function gitIo(root) {
  const git = (args, input) => execFileSync('git', args, { cwd: root, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  const oid = (rev) => { try { return git(['rev-parse', '--verify', '--quiet', rev]) || null; } catch { return null; } };
  return {
    hashObject: (buf, p) => git(['hash-object', '--stdin', `--path=${p}`], buf),
    stagedOid: (p) => oid(`:${p}`),
    headOid: (p) => oid(`HEAD:${p}`),
    isStaged: (p) => {
      try { return git(['diff', '--cached', '--name-only', '--', p]).length > 0; } catch { return false; }
    },
    headCommit: () => git(['rev-parse', 'HEAD']),
    readFile: (p) => {
      try { return fs.readFileSync(path.join(root, p)); } catch { return null; }
    },
  };
}
