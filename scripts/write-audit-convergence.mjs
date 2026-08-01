#!/usr/bin/env node
/**
 * write-audit-convergence.mjs — stamp an audit report's frontmatter with the
 * `converged:` claim, but ONLY when the ledger earns it (audit-convergence-enforcement
 * spec §1). Mirrors skills/spec-converge/scripts/write-convergence-tag.mjs; pure
 * functions are exported for tests; `main()` is guarded.
 *
 * A converged audit report lives at docs/audits/<slug>.md with per-round ledgers.
 * This validator refuses to stamp `converged:` unless ALL hold:
 *   1. ≥2 `## Round N` sections recorded.
 *   2. The final round's `New findings this round: 0` line AND its ledger has 0 rows
 *      (the count is DERIVED from parsed rows and cross-checked against the line).
 *   3. Every ledger row across all rounds carries a valid closed disposition
 *      (`fixed:<ref>` | `accepted:<reason>` | `deferred:<ref>`, each non-empty).
 *   4. Each round records its search-angles + surface-delta.
 *   5. `standing-guard` (jailed + git-tracked) XOR `exemption` (closed enum + rationale).
 *   6. A digest-bound meta-insight names the escaped blind-spot class and the
 *      created/amended/no-change standards response, with change-local evidence
 *      whenever the response identity is new or changed.
 *
 * Parsing is line-oriented, single-pass, dependency-free, and FAIL-CLOSED: an
 * unparseable `## Round` section, ledger-like-but-unparseable content, zero
 * parseable rounds, or a duplicate managed frontmatter key REFUSES with a named,
 * shape-teaching reason. Only the FIRST frontmatter block counts.
 *
 * Repo ROOT is resolved from the AUDITED tree (cwd / `git rev-parse --show-toplevel`),
 * NOT this script's package root, so a vendored copy validates the right tree.
 *
 * Modes:
 *   (stamp)     node write-audit-convergence.mjs --audit docs/audits/<slug>.md
 *   --check     validate without stamping (the precommit / CI entry point)
 *   --content-from <path|->  validate content from a file or stdin (the STAGED blob:
 *               `git show :docs/audits/<slug>.md | … --check --content-from -`)
 *
 * Exit codes: 0 pass · 1 validation-failed · 2 internal-error (fail-closed).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanForSecrets } from './audit-secret-patterns.mjs';
import { ARTICLE_ID_RE, articleIds, parseRegistryStructure } from './standards-registry-article-core.mjs';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EXEMPTION_KEYS = ['non-ci-expressible', 'external-system', 'one-time-human-review'];
const EXEMPTION_RATIONALE_FLOOR = 12; // chars of real rationale beyond the key
const META_AUTHOR_KEYS = [
  'blind-spot-class',
  'standard-response-kind',
  'standard-response-ref',
  'standard-response-article-id',
  'standard-response-article',
  'standard-response-rationale',
];
const META_DERIVED_KEYS = ['standard-response-digest', 'meta-artifact-digest', 'meta-artifact-at'];
const MANAGED_FRONTMATTER_KEYS = [
  'audit', 'converged', 'rounds', 'standing-guard', 'exemption',
  ...META_AUTHOR_KEYS, ...META_DERIVED_KEYS,
];
const BLIND_SPOT_CLASS_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const RESPONSE_KINDS = ['created', 'amended', 'no-change'];
const SHA256_RE = /^[a-f0-9]{64}$/;

// ─── frontmatter ──────────────────────────────────────────────────────────

/**
 * Parse the FIRST YAML-ish frontmatter block only (a second `---` block in the
 * body is body content, not frontmatter). Returns { fields, raw, bodyStart } or
 * throws on a duplicate MANAGED key (a hard refusal — duplicate `converged:` is
 * the classic "first empty, second stamped" dodge).
 */
export function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') {
    const e = new Error('no frontmatter block (file must open with `---`)');
    e.code = 'no-frontmatter';
    throw e;
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) {
    const e = new Error('unterminated frontmatter block');
    e.code = 'bad-frontmatter';
    throw e;
  }
  const fields = {};
  const seen = new Set();
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (MANAGED_FRONTMATTER_KEYS.includes(key) && seen.has(key)) {
      const e = new Error(`duplicate managed frontmatter key: ${key}`);
      e.code = 'duplicate-key';
      throw e;
    }
    seen.add(key);
    // strip surrounding quotes + trailing comment
    let val = m[2].trim();
    val = val.replace(/\s+#.*$/, '');
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fields[key] = val;
  }
  return { fields, frontmatterEnd: end, lines };
}

function canonicalDigest(parts) {
  const chunks = ['audit-meta-v2'];
  for (const part of parts) {
    const value = String(part ?? '');
    chunks.push(`${Buffer.byteLength(value, 'utf8')}:${value}`);
  }
  return crypto.createHash('sha256').update(chunks.join('|'), 'utf8').digest('hex');
}

function canonicalIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value ?? '')) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function visibleBodyLines(text) {
  const lines = text.split('\n');
  const visible = [];
  let fence = null;
  let inComment = false;
  for (const raw of lines) {
    const trimmed = raw.trimStart();
    const fm = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence === null && fm) {
      fence = { marker: fm[1][0], length: fm[1].length };
      visible.push(null);
      continue;
    }
    if (fence !== null) {
      const closing = new RegExp(`^${fence.marker}{${fence.length},}\\s*$`);
      if (closing.test(trimmed)) fence = null;
      visible.push(null);
      continue;
    }
    if (/^\s*>/.test(raw)) { visible.push(null); continue; }
    let out = '';
    let cursor = 0;
    while (cursor < raw.length) {
      if (inComment) {
        const end = raw.indexOf('-->', cursor);
        if (end === -1) { cursor = raw.length; break; }
        inComment = false;
        cursor = end + 3;
        continue;
      }
      const start = raw.indexOf('<!--', cursor);
      if (start === -1) { out += raw.slice(cursor); break; }
      out += raw.slice(cursor, start);
      inComment = true;
      cursor = start + 4;
    }
    visible.push(out);
  }
  return visible;
}

export function parseMetaInsight(text) {
  const lines = visibleBodyLines(text);
  const metaHeads = [];
  const roundHeads = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === null) continue;
    if (line === '## Meta-insight') metaHeads.push(i);
    if (/^##\s+Round\s+1\b/i.test(line)) roundHeads.push(i);
  }
  if (metaHeads.length !== 1) throw Object.assign(new Error(`expected exactly one real \`## Meta-insight\` section; found ${metaHeads.length}`), { code: 'meta-insight-shape' });
  if (roundHeads.length === 0 || metaHeads[0] >= roundHeads[0]) throw Object.assign(new Error('`## Meta-insight` must appear before the first real `## Round 1`'), { code: 'meta-insight-shape' });
  const end = lines.findIndex((line, i) => i > metaHeads[0] && line !== null && /^##\s+/.test(line));
  const sectionEnd = end === -1 ? lines.length : end;
  const arose = [];
  const missed = [];
  for (let i = metaHeads[0] + 1; i < sectionEnd; i++) {
    const line = lines[i];
    if (line === null || !line.trim()) continue;
    let m = line.match(/^How it arose:\s*(.+)$/);
    if (m) { arose.push(m[1].trim()); continue; }
    m = line.match(/^Why prior controls missed it:\s*(.+)$/);
    if (m) { missed.push(m[1].trim()); continue; }
    throw Object.assign(new Error(`Meta-insight contains an unrecognized or continuation line: "${line.slice(0, 80)}"`), { code: 'meta-insight-shape' });
  }
  if (arose.length !== 1 || missed.length !== 1) throw Object.assign(new Error('Meta-insight requires exactly one `How it arose:` and one `Why prior controls missed it:` line'), { code: 'meta-insight-shape' });
  for (const [label, value] of [['How it arose', arose[0]], ['Why prior controls missed it', missed[0]]]) {
    if (value.length < 40 || value.length > 1000) throw Object.assign(new Error(`${label} must be 40-1000 characters; found ${value.length}`), { code: 'meta-insight-bounds' });
  }
  return { howItArose: arose[0], whyPriorControlsMissedIt: missed[0] };
}

export function computeResponseDigest(fields) {
  return canonicalDigest([
    'response-v1', fields['standard-response-kind'], fields['standard-response-ref'],
    fields['standard-response-article-id'], fields['standard-response-article'],
  ]);
}

export function computeMetaDigest(fields, metaInsight, timestamp) {
  return canonicalDigest([
    'meta-v1', timestamp, fields['blind-spot-class'], fields['standard-response-kind'],
    fields['standard-response-ref'], fields['standard-response-article-id'],
    fields['standard-response-article'], fields['standard-response-rationale'],
    metaInsight.howItArose, metaInsight.whyPriorControlsMissedIt,
  ]);
}

export function responseChangedFromBase(text, baseText) {
  if (!baseText) return true;
  try {
    const current = parseFrontmatter(text).fields;
    const base = parseFrontmatter(baseText).fields;
    if (!META_AUTHOR_KEYS.every((key) => typeof base[key] === 'string' && base[key].length > 0)) return true;
    return computeResponseDigest(current) !== computeResponseDigest(base);
  } catch {
    return true;
  }
}

// ─── round + ledger parsing (fail-closed) ───────────────────────────────────

/**
 * A ledger row is `location | behavior | bucket | disposition` (a markdown table
 * row or a `-`/`*` bullet with the same 4 pipe-separated fields). Returns a
 * parsed row {location, behavior, bucket, disposition} or throws `ledger-unparseable`
 * for a line that LOOKS like a ledger row (contains `|` or opens `- `/`* `) but
 * does not parse into 4 non-empty fields — never silently skipped (adversarial-R2
 * new-1: a variant-formatted real finding must REFUSE, not count as zero).
 */
function looksLikeLedgerRow(line) {
  const t = line.trim();
  if (t.startsWith('|') || (t.includes('|') && t.split('|').length >= 4)) return true;
  if (/^[-*]\s+/.test(t) && t.includes('|')) return true;
  return false;
}

export function parseLedgerRow(line) {
  let t = line.trim();
  t = t.replace(/^[-*]\s+/, ''); // strip bullet marker
  // table row: leading/trailing pipes
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  // skip a table separator (all cells empty or dashes)
  if (cells.every((c) => c === '' || /^:?-+:?$/.test(c))) return null;
  // skip the canonical table HEADER row (the column labels, not a finding)
  const HEADER_CELLS = ['location', 'behavior', 'bucket', 'disposition'];
  if (cells.length >= 4 && cells.slice(0, 4).every((c, i) => c.toLowerCase() === HEADER_CELLS[i])) return null;
  if (cells.length < 4 || cells.slice(0, 4).some((c) => c.length === 0)) {
    const e = new Error(`ledger-like line does not parse into 4 non-empty fields: "${line.trim().slice(0, 60)}"`);
    e.code = 'ledger-unparseable';
    throw e;
  }
  const [location, behavior, bucket, disposition] = cells;
  return { location, behavior, bucket, disposition };
}

const DISPOSITION_RE = /^(fixed|accepted|deferred):\s*(.+)$/;
export function validateDisposition(disposition) {
  const m = disposition.match(DISPOSITION_RE);
  if (!m) return { ok: false, reason: `disposition must be fixed:<ref> | accepted:<reason> | deferred:<ref> — got "${disposition.slice(0, 40)}"` };
  const [, kind, rest] = m;
  if (!rest.trim()) return { ok: false, reason: `${kind}: requires a non-empty ${kind === 'accepted' ? 'reason' : 'ref'}` };
  return { ok: true, kind };
}

/**
 * Parse every `## Round N` section. Returns [{ n, newFindingsLine, rows,
 * hasSearchAngles, hasSurfaceDelta }]. Throws `round-unparseable` on a malformed
 * round (missing/duplicate N, non-integer N) and propagates `ledger-unparseable`.
 */
export function parseRounds(body) {
  const headingRe = /^##\s+Round\s+(\d+)\b.*$/gim;
  const marks = [];
  let m;
  while ((m = headingRe.exec(body)) !== null) {
    marks.push({ n: parseInt(m[1], 10), start: m.index, headEnd: m.index + m[0].length });
  }
  if (marks.length === 0) {
    const e = new Error('no `## Round N` sections found');
    e.code = 'no-rounds';
    throw e;
  }
  const rounds = [];
  const seenN = new Set();
  for (let i = 0; i < marks.length; i++) {
    const { n, headEnd } = marks[i];
    if (seenN.has(n)) {
      const e = new Error(`duplicate "## Round ${n}" section`);
      e.code = 'round-unparseable';
      throw e;
    }
    seenN.add(n);
    const end = i + 1 < marks.length ? marks[i + 1].start : body.length;
    const section = body.slice(headEnd, end);
    const secLines = section.split('\n');

    // New findings count line
    const nfLine = secLines.find((l) => /New findings this round\s*:/i.test(l));
    let newFindingsLine = null;
    if (nfLine) {
      const nm = nfLine.match(/New findings this round\s*:\s*(\d+)/i);
      if (!nm) {
        const e = new Error(`Round ${n}: "New findings this round:" line is not a non-negative integer`);
        e.code = 'round-unparseable';
        throw e;
      }
      newFindingsLine = parseInt(nm[1], 10);
    }

    // ledger rows (fail-closed on ledger-like-but-unparseable)
    const rows = [];
    for (const l of secLines) {
      if (!looksLikeLedgerRow(l)) continue;
      const row = parseLedgerRow(l); // throws ledger-unparseable
      if (row) rows.push(row);
    }

    const hasSearchAngles = /search angles?\b/i.test(section) || /commands? run\b/i.test(section);
    const hasSurfaceDelta = /surface delta\b/i.test(section) || /surface (grew|growth)\b/i.test(section);

    rounds.push({ n, newFindingsLine, rows, hasSearchAngles, hasSurfaceDelta });
  }
  // contiguity: rounds must be 1..N in order
  rounds.sort((a, b) => a.n - b.n);
  for (let i = 0; i < rounds.length; i++) {
    if (rounds[i].n !== i + 1) {
      const e = new Error(`rounds must be contiguous 1..N; found gap at Round ${i + 1}`);
      e.code = 'round-unparseable';
      throw e;
    }
  }
  return rounds;
}

// ─── standing-guard jail ────────────────────────────────────────────────────

/**
 * Validate the standing-guard path: resolved + realpath'd + CONTAINED under ROOT,
 * refuse absolute/`..`-escape/symlink, AND git-tracked-or-staged (Security M3).
 * `stagedSet` (a Set of staged repo-relative paths) lets a NEW ratchet added in
 * the same commit satisfy the check.
 */
export function validateStandingGuard(guardPath, root, stagedSet) {
  if (!guardPath) return { ok: false, reason: 'standing-guard is empty' };
  if (path.isAbsolute(guardPath)) return { ok: false, reason: 'standing-guard must be repo-relative, not absolute' };
  if (guardPath.split('/').includes('..')) return { ok: false, reason: 'standing-guard must not contain `..`' };
  const resolved = path.resolve(root, guardPath);
  const rootReal = fs.realpathSync(root);
  if (!fs.existsSync(resolved)) {
    // may be a staged-but-not-yet-on-disk new file
    if (stagedSet && stagedSet.has(guardPath)) return { ok: true };
    return { ok: false, reason: `standing-guard path does not exist: ${guardPath}` };
  }
  // refuse a symlink (Security M3 — a symlinked escape)
  const lst = fs.lstatSync(resolved);
  if (lst.isSymbolicLink()) return { ok: false, reason: 'standing-guard must not be a symlink' };
  const real = fs.realpathSync(resolved);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    return { ok: false, reason: 'standing-guard resolves outside the repo root' };
  }
  // git-tracked OR staged
  const rel = path.relative(rootReal, real);
  if (stagedSet && stagedSet.has(rel)) return { ok: true };
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: rootReal, stdio: 'ignore' });
    return { ok: true };
  } catch {
    return { ok: false, reason: `standing-guard is present but not git-tracked or staged: ${rel}` };
  }
}

export function validateExemption(exemption) {
  if (!exemption) return { ok: false, reason: 'exemption is empty' };
  // form: "<key> — <rationale>" or "<key>: <rationale>"
  const m = exemption.match(/^([a-z-]+)\s*[—:-]\s*(.+)$/i) || exemption.match(/^([a-z-]+)\s+(.+)$/i);
  const key = m ? m[1].toLowerCase() : exemption.toLowerCase().trim();
  const rationale = m ? m[2].trim() : '';
  if (!EXEMPTION_KEYS.includes(key)) {
    return { ok: false, reason: `exemption key must be one of ${EXEMPTION_KEYS.join(' | ')} — got "${key}"` };
  }
  if (rationale.length < EXEMPTION_RATIONALE_FLOOR) {
    return { ok: false, reason: `exemption "${key}" needs a rationale of at least ${EXEMPTION_RATIONALE_FLOOR} chars` };
  }
  return { ok: true, key, rationale };
}

function validateStandardsRefPath(ref, root, requiredRef, evidence) {
  if (requiredRef && ref !== requiredRef) return { ok: false, reason: `standard-response-ref must be ${requiredRef} in this repository` };
  if (!ref || path.isAbsolute(ref) || ref.split('/').includes('..') || !ref.startsWith('docs/') || !ref.endsWith('.md')) {
    return { ok: false, reason: 'standard-response-ref must be a repo-relative `docs/**/*.md` path with no `..`' };
  }
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, ref);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return { ok: false, reason: 'standard-response-ref resolves outside the repo root' };
  if (evidence?.candidateText !== undefined) {
    if (evidence.candidateRegular === false) return { ok: false, reason: 'standard-response-ref candidate is not a regular file' };
    if (evidence.candidateTracked === false) return { ok: false, reason: 'standard-response-ref candidate is not tracked/staged' };
    return { ok: true };
  }
  if (!fs.existsSync(resolved)) return { ok: false, reason: `standard-response-ref does not exist: ${ref}` };
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: 'standard-response-ref must be a non-symlink regular file' };
  const rootReal = fs.realpathSync(rootResolved);
  const real = fs.realpathSync(resolved);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return { ok: false, reason: 'standard-response-ref resolves outside the repo root' };
  return { ok: true };
}

function registryArticleIndex(markdown) {
  const articles = [];
  const idOwners = new Map();
  const titleOwners = new Set();
  for (const section of parseRegistryStructure(markdown ?? '')) {
    for (const block of section.blocks) {
      const hasRule = block.visibleLines.some((line) => line !== null && /^\*\*Rule\.\*\*/.test(line));
      if (!hasRule) continue;
      const ids = articleIds(block);
      if (titleOwners.has(block.name)) return { ok: false, reason: `duplicate standards article title "${block.name}" is ambiguous` };
      titleOwners.add(block.name);
      if (ids.length > 1) return { ok: false, reason: `standards article "${block.name}" has duplicate Article ID declarations` };
      const id = ids[0] ?? null;
      if (id && !ARTICLE_ID_RE.test(id)) return { ok: false, reason: `Article ID "${id}" must match ${ARTICLE_ID_RE}` };
      if (id && idOwners.has(id)) return { ok: false, reason: `duplicate Article ID "${id}" in "${idOwners.get(id)}" and "${block.name}"` };
      if (id) idOwners.set(id, block.name);
      articles.push({ id, name: block.name, block });
    }
  }
  return { ok: true, articles };
}

function substantiveArticleText(article) {
  return article.block.visibleLines
    .filter((line) => line !== null)
    .filter((line) => !/^\*\*Article ID\.\*\*/.test(line))
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

export function validateStandardResponse(fields, opts = {}) {
  const evidence = opts.standardEvidence ?? {};
  if (!evidence.responseChanged) return { ok: true, checked: false };
  const ref = fields['standard-response-ref'];
  const pathResult = validateStandardsRefPath(ref, opts.root ?? process.cwd(), opts.requiredStandardsRef, evidence);
  if (!pathResult.ok) return pathResult;
  const candidateText = evidence.candidateText ?? fs.readFileSync(path.resolve(opts.root ?? process.cwd(), ref), 'utf8');
  const candidate = registryArticleIndex(candidateText);
  if (!candidate.ok) return candidate;
  const base = registryArticleIndex(evidence.baseText ?? '');
  if (!base.ok) return base;

  const id = fields['standard-response-article-id'];
  const title = fields['standard-response-article'];
  const candidateTarget = candidate.articles.find((a) => a.id === id && a.name === title);
  if (!candidateTarget) return { ok: false, reason: `candidate standards snapshot has no exact article id/title pair: ${id} / ${title}` };
  const baseById = base.articles.find((a) => a.id === id);
  const baseLegacy = base.articles.find((a) => a.name === title);
  const kind = fields['standard-response-kind'];
  if (evidence.baseTracked === true && evidence.baseRegular === false) {
    return { ok: false, reason: 'standard-response-ref base snapshot is not a regular file' };
  }
  if (kind !== 'created' && evidence.baseTracked === false) {
    return { ok: false, reason: `${kind} requires standard-response-ref to exist in the base snapshot` };
  }

  if (kind === 'created') {
    if (baseById || baseLegacy) return { ok: false, reason: 'created requires both the Article ID and exact legacy path/title article to be absent in the base snapshot' };
  } else if (kind === 'amended') {
    if (baseById) {
      if (substantiveArticleText(baseById) === substantiveArticleText(candidateTarget)) return { ok: false, reason: 'amended requires a substantive article-block delta (title/path/mode/ID-only changes do not count)' };
    } else if (baseLegacy?.id === null) {
      if (substantiveArticleText(baseLegacy) === substantiveArticleText(candidateTarget)) return { ok: false, reason: 'ID-less amended bootstrap must add the ID plus a substantive non-ID delta' };
    } else if (baseLegacy) {
      return { ok: false, reason: 'amended legacy bootstrap requires the base title article to be ID-less; replacing an existing Article ID is forbidden' };
    } else {
      return { ok: false, reason: 'amended requires the target article to exist in the base snapshot' };
    }
  } else if (kind === 'no-change') {
    if (!baseById && baseLegacy && baseLegacy.id !== null) {
      return { ok: false, reason: 'no-change legacy bootstrap requires the base title article to be ID-less; replacing an existing Article ID is forbidden' };
    }
    const prior = baseById ?? baseLegacy;
    if (!prior) return { ok: false, reason: 'no-change requires the target article to exist in the base snapshot' };
    if (substantiveArticleText(prior) !== substantiveArticleText(candidateTarget)) return { ok: false, reason: 'no-change forbids a substantive article-block delta (only the legacy ID bootstrap may differ)' };
  }
  return { ok: true, checked: true, kind, articleId: id, article: title };
}

// ─── the core validation ────────────────────────────────────────────────────

/**
 * Validate an audit report's content. Returns { ok: true, rounds } or
 * { ok: false, reason }. Pure — no I/O except the standing-guard git check via
 * the injected root/stagedSet. `opts.basenameSlug` is the file basename (minus
 * .md) for the basename==slug check.
 */
export function validateAuditReport(text, opts = {}) {
  const { root = process.cwd(), stagedSet = null, basenameSlug = null } = opts;
  let fm;
  try {
    fm = parseFrontmatter(text);
  } catch (e) {
    return { ok: false, reason: e.message, code: e.code };
  }
  const f = fm.fields;

  // slug charset + basename match
  const slug = f.audit || '';
  if (!SLUG_RE.test(slug)) return { ok: false, reason: `audit slug must match ${SLUG_RE} — got "${slug}"` };
  if (basenameSlug && basenameSlug !== slug) {
    return { ok: false, reason: `file basename "${basenameSlug}" must equal frontmatter audit slug "${slug}"` };
  }

  // rounds
  let rounds;
  try {
    rounds = parseRounds(text);
  } catch (e) {
    return { ok: false, reason: e.message, code: e.code || 'round-unparseable' };
  }
  if (rounds.length < 2) {
    return { ok: false, reason: `converged needs ≥2 rounds (a finding round + a confirming zero round); found ${rounds.length}` };
  }

  // per-round: search-angles + surface-delta + disposition + count cross-check
  for (const r of rounds) {
    if (!r.hasSearchAngles) return { ok: false, reason: `Round ${r.n}: missing the search-angles/commands-run record` };
    if (!r.hasSurfaceDelta) return { ok: false, reason: `Round ${r.n}: missing the surface-delta record` };
    for (const row of r.rows) {
      const d = validateDisposition(row.disposition);
      if (!d.ok) return { ok: false, reason: `Round ${r.n}: ${d.reason}` };
    }
    if (r.newFindingsLine === null) {
      return { ok: false, reason: `Round ${r.n}: missing the "New findings this round: <count>" line` };
    }
    if (r.newFindingsLine !== r.rows.length) {
      return { ok: false, reason: `Round ${r.n}: "New findings this round: ${r.newFindingsLine}" contradicts ${r.rows.length} parsed ledger row(s)` };
    }
  }

  // final round MUST be zero (line AND rows)
  const finalR = rounds[rounds.length - 1];
  if (finalR.newFindingsLine !== 0 || finalR.rows.length !== 0) {
    return { ok: false, reason: `final round (Round ${finalR.n}) must have 0 new findings; found ${finalR.rows.length} row(s) / line=${finalR.newFindingsLine}` };
  }

  // standing-guard XOR exemption
  const hasGuard = !!(f['standing-guard'] && f['standing-guard'].trim());
  const hasExemption = !!(f.exemption && f.exemption.trim());
  if (hasGuard === hasExemption) {
    return { ok: false, reason: 'exactly ONE of standing-guard / exemption must be set (XOR)' };
  }
  if (hasGuard) {
    const g = validateStandingGuard(f['standing-guard'].trim(), root, stagedSet);
    if (!g.ok) return { ok: false, reason: g.reason };
  } else {
    const x = validateExemption(f.exemption.trim());
    if (!x.ok) return { ok: false, reason: x.reason };
  }

  // Sixth condition: blind-spot class + causal meta-insight + standards response.
  if (!BLIND_SPOT_CLASS_RE.test(f['blind-spot-class'] ?? '')) {
    return { ok: false, reason: `blind-spot-class must match ${BLIND_SPOT_CLASS_RE}` };
  }
  if (!RESPONSE_KINDS.includes(f['standard-response-kind'])) {
    return { ok: false, reason: `standard-response-kind must be ${RESPONSE_KINDS.join(' | ')}` };
  }
  if (!ARTICLE_ID_RE.test(f['standard-response-article-id'] ?? '')) {
    return { ok: false, reason: `standard-response-article-id must match ${ARTICLE_ID_RE}` };
  }
  const title = f['standard-response-article'] ?? '';
  if (title.length < 4 || title.length > 240) return { ok: false, reason: `standard-response-article must be 4-240 characters; found ${title.length}` };
  const rationale = f['standard-response-rationale'] ?? '';
  if (rationale.length < 24 || rationale.length > 500) return { ok: false, reason: `standard-response-rationale must be 24-500 characters; found ${rationale.length}` };

  let metaInsight;
  try { metaInsight = parseMetaInsight(text); }
  catch (e) { return { ok: false, reason: e.message, code: e.code }; }
  const responseDigest = computeResponseDigest(f);
  const timestamp = f['meta-artifact-at'] ?? '';
  const metaDigest = canonicalIso(timestamp) ? computeMetaDigest(f, metaInsight, timestamp) : null;
  const derivedCurrent =
    f['standard-response-digest'] === responseDigest &&
    !!metaDigest && f['meta-artifact-digest'] === metaDigest;
  if (!opts.allowDerivedStale) {
    if (!SHA256_RE.test(f['standard-response-digest'] ?? '')) return { ok: false, reason: 'standard-response-digest must be a lowercase SHA-256 digest' };
    if (!canonicalIso(timestamp)) return { ok: false, reason: 'meta-artifact-at must be a canonical ISO timestamp' };
    if (!SHA256_RE.test(f['meta-artifact-digest'] ?? '')) return { ok: false, reason: 'meta-artifact-digest must be a lowercase SHA-256 digest' };
    if (f['standard-response-digest'] !== responseDigest) return { ok: false, reason: 'standard-response-digest is stale; re-run the stamp tool' };
    if (f['meta-artifact-digest'] !== metaDigest) return { ok: false, reason: 'meta-artifact-digest is stale; re-run the stamp tool' };
  }

  const standards = validateStandardResponse(f, {
    root,
    requiredStandardsRef: opts.requiredStandardsRef,
    standardEvidence: opts.standardEvidence,
  });
  if (!standards.ok) return { ok: false, reason: standards.reason };

  return {
    ok: true,
    rounds,
    responseKind: f['standard-response-kind'],
    responseDigest,
    metaDigest,
    meta: { ...metaInsight, responseDigest, metaDigest, derivedCurrent, responseKind: f['standard-response-kind'], standards },
  };
}

// ─── stamping (byte-idempotent) ─────────────────────────────────────────────

/**
 * Given validated report text, return the stamped text (converged:<ISO>,
 * rounds:<N>). If a VALID converged timestamp already exists and the report
 * still validates, the existing timestamp is PRESERVED (byte-idempotent re-run).
 * `nowIso` is injected so tests are deterministic and the module has no clock dep.
 */
export function stampConverged(text, roundsCount, nowIso) {
  const parsedBefore = parseFrontmatter(text);
  const fields = parsedBefore.fields;
  const insight = parseMetaInsight(text);
  const expectedResponse = computeResponseDigest(fields);
  const existingMetaAt = fields['meta-artifact-at'] ?? '';
  const existingMetaDigest = canonicalIso(existingMetaAt)
    ? computeMetaDigest(fields, insight, existingMetaAt)
    : null;
  const derivedCurrent =
    fields['standard-response-digest'] === expectedResponse &&
    !!existingMetaDigest && fields['meta-artifact-digest'] === existingMetaDigest;
  const metaAt = derivedCurrent ? existingMetaAt : nowIso;
  const metaDigest = computeMetaDigest(fields, insight, metaAt);
  const lines = text.split('\n');
  // operate within the first frontmatter block
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) { if (lines[i] === '---') { fmEnd = i; break; } }
  const setField = (key, value) => {
    for (let i = 1; i < fmEnd; i++) {
      if (new RegExp(`^${key}\\s*:`).test(lines[i])) { lines[i] = `${key}: "${value}"`; return; }
    }
    lines.splice(fmEnd, 0, `${key}: "${value}"`);
    fmEnd++;
  };
  // preserve an existing non-empty converged timestamp
  let existing = null;
  for (let i = 1; i < fmEnd; i++) {
    const m = lines[i].match(/^converged\s*:\s*["']?([^"'#]*)/);
    if (m && m[1].trim()) { existing = m[1].trim(); break; }
  }
  setField('converged', existing || nowIso);
  setField('rounds', String(roundsCount));
  setField('standard-response-digest', expectedResponse);
  setField('meta-artifact-at', metaAt);
  setField('meta-artifact-digest', metaDigest);
  return lines.join('\n');
}

// ─── main ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { audit: null, check: false, contentFrom: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--audit') out.audit = argv[++i];
    else if (a === '--check') out.check = true;
    else if (a === '--content-from') out.contentFrom = argv[++i];
  }
  return out;
}

function resolveRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function stagedSet(root) {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: root, encoding: 'utf8' });
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function gitShow(root, spec) {
  try { return execFileSync('git', ['show', spec], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}

function gitFileMode(root, treeish, rel) {
  try {
    const row = execFileSync('git', ['ls-tree', treeish, '--', rel], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return row ? row.split(/\s+/, 1)[0] : null;
  } catch { return null; }
}

function atomicWriteFile(filePath, content) {
  const mode = fs.statSync(filePath).mode;
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, filePath);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort cleanup */ }
  }
}

const IS_MAIN = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRoot();

  let text, basenameSlug, auditPath;
  try {
    if (args.contentFrom) {
      text = args.contentFrom === '-'
        ? fs.readFileSync(0, 'utf8')
        : fs.readFileSync(args.contentFrom, 'utf8');
      // basename slug comes from --audit when validating a staged blob
      basenameSlug = args.audit ? path.basename(args.audit, '.md') : null;
    } else {
      if (!args.audit) { console.error('usage: --audit docs/audits/<slug>.md [--check] [--content-from <path|->]'); process.exit(2); }
      auditPath = args.audit;
      text = fs.readFileSync(auditPath, 'utf8');
      basenameSlug = path.basename(auditPath, '.md');
    }
  } catch (e) {
    console.error(`[audit-convergence] cannot read input: ${e.message}`);
    process.exit(2); // fail-closed
  }

  let result, secrets;
  try {
    secrets = scanForSecrets(text);
    const auditRel = args.audit ? path.relative(root, path.resolve(args.audit)).split(path.sep).join('/') : null;
    const baseReportText = auditRel ? gitShow(root, `HEAD:${auditRel}`) : null;
    const responseChanged = auditRel ? responseChangedFromBase(text, baseReportText) : false;
    let standardEvidence = { responseChanged };
    if (responseChanged) {
      const fields = parseFrontmatter(text).fields;
      const ref = fields['standard-response-ref'];
      const candidatePath = ref ? path.resolve(root, ref) : null;
      const baseMode = ref ? gitFileMode(root, 'HEAD', ref) : null;
      standardEvidence = {
        responseChanged: true,
        candidateText: candidatePath && fs.existsSync(candidatePath) ? fs.readFileSync(candidatePath, 'utf8') : '',
        baseText: ref ? (gitShow(root, `HEAD:${ref}`) ?? '') : '',
        candidateRegular: !!candidatePath && fs.existsSync(candidatePath) && fs.lstatSync(candidatePath).isFile() && !fs.lstatSync(candidatePath).isSymbolicLink(),
        candidateTracked: !!ref && (stagedSet(root).has(ref) || gitShow(root, `HEAD:${ref}`) !== null),
        baseRegular: baseMode === '100644' || baseMode === '100755',
        baseTracked: baseMode !== null,
      };
    }
    result = validateAuditReport(text, {
      root,
      stagedSet: stagedSet(root),
      basenameSlug,
      requiredStandardsRef: 'docs/STANDARDS-REGISTRY.md',
      standardEvidence,
      allowDerivedStale: !args.check,
    });
  } catch (e) {
    // any unexpected throw is fail-CLOSED with the honest escape named
    console.error(`[audit-convergence] internal error: ${e.message}`);
    console.error('  → fail-closed. Honest escape: remove the `converged:` line and commit the audit as honestly-incomplete.');
    process.exit(2);
  }

  if (secrets.length) {
    console.error('[audit-convergence] REFUSED — audit report appears to contain credential material:');
    for (const s of secrets) console.error(`  line ${s.line}: matches ${s.name} — reference path+line, NEVER quote the secret`);
    process.exit(1);
  }

  if (!result.ok) {
    console.error(`[audit-convergence] NOT converged: ${result.reason}`);
    console.error('  → an honestly-incomplete audit is fine to commit; it just cannot carry a `converged:` stamp.');
    process.exit(1);
  }

  if (args.check) {
    console.log(`[audit-convergence] OK — ${result.rounds.length} rounds, final round clean, dispositions closed.`);
    if (result.responseKind === 'no-change') {
      console.log(`[audit-convergence] NO-CHANGE — existing standard retained; enforcement adequacy requires reviewer attention.`);
    } else {
      console.log(`[audit-convergence] STANDARD RESPONSE — ${String(result.responseKind).toUpperCase()}.`);
    }
    // surface the exemption banner if present (adversarial visibility)
    const fm = parseFrontmatter(text).fields;
    if (fm.exemption && fm.exemption.trim()) console.log(`[audit-convergence] EXEMPTION path: ${fm.exemption.trim()}`);
    process.exit(0);
  }

  // stamp mode: write the earned converged timestamp
  const nowIso = new Date().toISOString();
  const stamped = stampConverged(text, result.rounds.length, nowIso);
  // Evidence was checked above against the same author-owned response fields;
  // final-byte validation rechecks every structural field and both derived hashes.
  const finalStructural = validateAuditReport(stamped, {
    root, stagedSet: stagedSet(root), basenameSlug,
    standardEvidence: { responseChanged: false },
  });
  if (!finalStructural.ok) {
    console.error(`[audit-convergence] internal error: stamped candidate failed final validation: ${finalStructural.reason}`);
    process.exit(2);
  }
  atomicWriteFile(auditPath, stamped);
  console.log(`[audit-convergence] stamped ${auditPath}: converged (${result.rounds.length} rounds)`);
  if (result.responseKind === 'no-change') {
    console.log('[audit-convergence] NO-CHANGE — existing standard retained; enforcement adequacy requires reviewer attention.');
  } else {
    console.log(`[audit-convergence] STANDARD RESPONSE — ${String(result.responseKind).toUpperCase()}.`);
  }
  process.exit(0);
}

if (IS_MAIN) main();
